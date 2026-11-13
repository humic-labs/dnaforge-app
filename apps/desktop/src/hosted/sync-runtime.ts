import {
  mergeWorkspaceSessionFiles,
  type WorkspaceSessionAdapter,
  type WorkspaceSessionIndex,
  type WorkspaceSessionSnapshot,
  type WorkspaceSessionWorkspace,
  type WorkspaceSessionFileWrite,
} from '@waypoint/domain-services';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { HostedWorkspaceApiError, sha256Hex } from './api';
import {
  HostedSyncStore,
  type HostedPendingOperation,
  type HostedRetryReason,
  type HostedSyncRecord,
} from './sync-store';
import {
  reconcileWorkspaceSessionSnapshots,
  type WorkspaceSessionReconcileInput,
} from './sync-reconcile';

export type HostedSyncPhase = 'saved-locally' | 'pending' | 'accepted' | 'conflict' | 'blocked';
export interface HostedSyncStatus {
  readonly workspaceId: string;
  readonly state: HostedSyncPhase;
  readonly remoteAvailability: 'available' | HostedRetryReason;
  readonly pendingCount: number;
  readonly message: string;
  readonly recovery?: HostedPendingOperation['recovery'];
  readonly unbackedCount: number;
}

interface SyncRuntimeOptions {
  readonly store?: HostedSyncStore;
  readonly lock?: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
  readonly retryDelayMs?: number;
  readonly canApplyRemote?: () => boolean;
  readonly prepareWrites?: (input: {
    workspaceId: string;
    snapshot: WorkspaceSessionSnapshot;
    writes: readonly WorkspaceSessionFileWrite[];
    removePaths?: readonly string[];
    expectedAccountId: string;
  }) => Promise<void>;
}

export function projectHostedWorkingSnapshot(record: HostedSyncRecord): WorkspaceSessionSnapshot {
  let files = [...record.accepted.files];
  for (const operation of record.operations) {
    files = mergeWorkspaceSessionFiles(
      files,
      operation.writes.map((write) => ({
        ...write,
        contentRevision: `sha256:${write.contentSha256}`,
        sizeBytes: write.bytes.byteLength,
      })),
      { removePaths: operation.removePaths }
    );
  }
  const localRevisionId = record.operations[record.operations.length - 1]?.id;
  return { ...record.accepted, files, ...(localRevisionId ? { localRevisionId } : {}) };
}

export function createDurableHostedRuntime(
  authority: WorkspaceSessionAdapter,
  options: SyncRuntimeOptions = {}
) {
  const store = options.store ?? new HostedSyncStore();
  const listeners = new Set<() => void>();
  const statuses = new Map<string, HostedSyncStatus>();
  const statusSignatures = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const preparedWrites = new Map<string, Promise<void>>();
  let accountId: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let accountEpoch = 0;
  let revision = 0;
  const lock =
    options.lock ??
    (<T>(name: string, operation: () => Promise<T>) => {
      if (!globalThis.navigator?.locks)
        return Promise.reject(
          new Error(
            'This browser cannot safely coordinate sync between tabs. Your changes remain saved on this device.'
          )
        );
      return navigator.locks.request(name, operation);
    });

  function notify(
    record: HostedSyncRecord,
    transient?: string,
    remoteAvailability?: HostedSyncStatus['remoteAvailability']
  ) {
    if (record.accountId !== accountId || stopped) return;
    const first = record.operations[0];
    const state: HostedSyncPhase =
      first?.state === 'conflict' || first?.state === 'blocked'
        ? first.state
        : record.operations.length === 0
          ? 'accepted'
          : transient || first?.error
            ? 'saved-locally'
            : 'pending';
    const status: HostedSyncStatus = {
      workspaceId: record.workspaceId,
      state,
      remoteAvailability: remoteAvailability ?? first?.retryReason ?? 'available',
      pendingCount: record.operations.length,
      recovery: first?.recovery,
      unbackedCount: record.operations.filter(
        (operation) => !operation.recovery || Date.parse(operation.recovery.expiresAt) <= Date.now()
      ).length,
      message:
        first?.error ??
        transient ??
        (state === 'accepted'
          ? `Synced — server accepted revision ${record.accepted.revisionNumber}.`
          : 'Saved on this device. Syncing to your account…'),
    };
    const signature = JSON.stringify([
      status,
      record.accepted.revisionId,
      record.operations[record.operations.length - 1]?.id,
    ]);
    if (statusSignatures.get(record.workspaceId) === signature) return;
    statusSignatures.set(record.workspaceId, signature);
    statuses.set(record.workspaceId, status);
    revision += 1;
    for (const listener of listeners) listener();
  }

  function actor(): string {
    if (!accountId) throw new Error('Sign in before saving a hosted project.');
    return accountId;
  }

  function mutationOwner(expectedAccountId?: string): string {
    const owner = actor();
    if (expectedAccountId !== undefined && expectedAccountId !== owner)
      throw new HostedWorkspaceApiError(
        409,
        'account_changed',
        'The signed-in account changed. Reload before changing this project.'
      );
    return owner;
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flushAll();
    }, options.retryDelayMs ?? 2_000);
  }

  function prepareQueuedWrites(record: HostedSyncRecord): void {
    if (!options.prepareWrites || stopped || record.accountId !== accountId) return;
    const prefix = `${record.accountId}:${record.workspaceId}:`;
    const retained = new Set(record.operations.map((operation) => prefix + operation.id));
    for (const key of preparedWrites.keys()) {
      if (key.startsWith(prefix) && !retained.has(key)) preparedWrites.delete(key);
    }
    if (record.operations[0]?.state === 'blocked' || record.operations[0]?.state === 'conflict')
      return;
    for (const operation of record.operations.slice(0, 4)) {
      const key = prefix + operation.id;
      if (preparedWrites.has(key) || operation.writes.length === 0) continue;
      const pending = Promise.resolve()
        .then(() =>
          options.prepareWrites!({
            workspaceId: record.workspaceId,
            snapshot: operation.base,
            writes: operation.writes,
            removePaths: operation.removePaths,
            expectedAccountId: record.accountId,
          })
        )
        .catch(() => {
          if (preparedWrites.get(key) === pending) preparedWrites.delete(key);
        });
      preparedWrites.set(key, pending);
    }
  }

  async function liveIndex(): Promise<WorkspaceSessionIndex> {
    const epoch = accountEpoch;
    const index = await authority.listWorkspaces();
    if (stopped || epoch !== accountEpoch)
      throw new HostedWorkspaceApiError(
        401,
        'account_changed',
        'The sign-in session changed while this request was running.'
      );
    if (!index.principal) throw new Error('Hosted account identity is missing.');
    await store.saveIndex(index, () => !stopped && epoch === accountEpoch);
    return index;
  }

  async function refreshRecord(workspace: WorkspaceSessionWorkspace): Promise<HostedSyncRecord> {
    const owner = actor();
    const current = await store.load(owner, workspace.workspaceId);
    if (current && (current.operations.length || options.canApplyRemote?.() === false)) {
      notify(current);
      return current;
    }
    try {
      const index = await liveIndex();
      if (index.principal?.id !== owner)
        throw new HostedWorkspaceApiError(
          409,
          'account_changed',
          'The signed-in account changed. Reload to continue with that account.'
        );
      const latestWorkspace = index.workspaces.find(
        (candidate) => candidate.workspaceId === workspace.workspaceId
      );
      if (!latestWorkspace)
        throw new HostedWorkspaceApiError(403, 'ACCESS_REVOKED', 'Project access is unavailable.');
      const snapshot = await authority.loadWorkspace(latestWorkspace);
      const record = await store.update(owner, workspace.workspaceId, (latest) => ({
        ...latest,
        accountId: owner,
        workspaceId: workspace.workspaceId,
        accepted:
          latest &&
          (latest.operations.length ||
            options.canApplyRemote?.() === false ||
            latest.accepted.revisionNumber > snapshot.revisionNumber)
            ? latest.accepted
            : snapshot,
        operations: latest?.operations ?? [],
      }));
      notify(record);
      return record;
    } catch (error) {
      if (!isRetryable(error) || !current) throw error;
      notify(current, userMessage('service.unavailable'), retryReason(error));
      return current;
    }
  }

  async function updateOperation(
    owner: string,
    workspaceId: string,
    operationId: string,
    patch: Partial<HostedPendingOperation>
  ) {
    return store.update(owner, workspaceId, (record) => {
      if (!record) throw new Error('Saved sync operation is missing.');
      return {
        ...record,
        operations: record.operations.map((operation) =>
          operation.id === operationId ? { ...operation, ...patch } : operation
        ),
      };
    });
  }

  async function drain(owner: string, workspaceId: string): Promise<void> {
    await lock(`dnaforge-sync:${owner}:${workspaceId}`, async () => {
      let automaticRebases = 0;
      while (!stopped && accountId === owner) {
        let record = await store.load(owner, workspaceId);
        const operation = record?.operations[0];
        if (
          !record ||
          !operation ||
          operation.state === 'conflict' ||
          operation.state === 'blocked'
        )
          return;
        try {
          const index = await liveIndex();
          if (index.principal?.id !== owner)
            throw new HostedWorkspaceApiError(
              409,
              'account_changed',
              'The signed-in account changed. Sign back into the original account to sync this saved draft.'
            );
          if (!index.workspaces.some((workspace) => workspace.workspaceId === workspaceId))
            throw new HostedWorkspaceApiError(
              403,
              'ACCESS_REVOKED',
              'Project access is unavailable. This draft is still saved on this device.'
            );
          if (operation.base.localRevisionId)
            throw new Error('A preceding saved operation has not been acknowledged.');
          prepareQueuedWrites(record);
          record = await updateOperation(owner, workspaceId, operation.id, {
            state: 'sending',
            error: undefined,
            retryReason: undefined,
          });
          notify(record);
          if (
            authority.retainRecoveryCandidate &&
            (!operation.recovery || Date.parse(operation.recovery.expiresAt) <= Date.now())
          ) {
            const recoveryIntentId = operation.recovery
              ? crypto.randomUUID()
              : (operation.recoveryIntentId ?? operation.id);
            record = await updateOperation(owner, workspaceId, operation.id, {
              recoveryIntentId,
              recovery: undefined,
            });
            const recovery = await authority.retainRecoveryCandidate({
              snapshot: operation.base,
              writes: operation.writes,
              removePaths: operation.removePaths,
              operationId: recoveryIntentId,
              expectedAccountId: owner,
            });
            if (Date.parse(recovery.expiresAt) <= Date.now())
              throw new Error(
                'The recovery copy expired before this save could sync. Retry to retain a fresh copy.'
              );
            record = await updateOperation(owner, workspaceId, operation.id, { recovery });
            notify(record);
          }
          const accepted = await authority.commit({
            snapshot: operation.base,
            writes: operation.writes,
            removePaths: operation.removePaths,
            operationId: operation.id,
            expectedAccountId: owner,
          });
          for (const write of operation.writes)
            await store.saveBytes(
              owner,
              workspaceId,
              `sha256:${write.contentSha256}`,
              write.path,
              write.bytes
            );
          record = await store.update(owner, workspaceId, (latest) => {
            if (!latest || latest.operations[0]?.id !== operation.id)
              throw new Error('Sync operation ownership changed before acknowledgement.');
            return {
              ...latest,
              accepted,
              acknowledgements: { ...latest.acknowledgements, [operation.id]: accepted },
              operations: latest.operations
                .slice(1)
                .map((next) =>
                  next.base.localRevisionId === operation.id ? { ...next, base: accepted } : next
                ),
            };
          });
          notify(record);
          prepareQueuedWrites(record);
        } catch (error) {
          if (
            error instanceof HostedWorkspaceApiError &&
            error.code === 'RECOVERY_CANDIDATE_EXPIRED'
          ) {
            record = await updateOperation(owner, workspaceId, operation.id, {
              recoveryIntentId: crypto.randomUUID(),
              recovery: undefined,
              state: 'queued',
              error: 'Saved on this device. Renewing expired recovery retention.',
            });
            notify(record);
            scheduleRetry();
            return;
          }
          if (
            automaticRebases < 3 &&
            error instanceof HostedWorkspaceApiError &&
            error.code === 'SYNC_CONFLICT'
          ) {
            const review = await inspectConflict(workspaceId, false).catch(() => null);
            if (review?.result.kind === 'merged') {
              await replaceReviewedQueue(review);
              automaticRebases += 1;
              continue;
            }
          }
          const state =
            error instanceof HostedWorkspaceApiError && error.code === 'SYNC_CONFLICT'
              ? 'conflict'
              : isRetryable(error)
                ? 'queued'
                : 'blocked';
          const message =
            state === 'conflict'
              ? 'This project changed elsewhere. Your draft is saved on this device; review both versions before syncing.'
              : state === 'queued'
                ? userMessage('service.unavailable')
                : errorMessage(error);
          record = await updateOperation(owner, workspaceId, operation.id, {
            state,
            error: message,
            retryReason: state === 'queued' ? retryReason(error) : undefined,
          });
          notify(record);
          if (state === 'queued') scheduleRetry();
          return;
        }
      }
    });
  }

  function flush(workspaceId: string): Promise<void> {
    if (!accountId || stopped) return Promise.resolve();
    const owner = accountId;
    const key = `${owner}:${workspaceId}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = drain(owner, workspaceId)
      .catch(async (error) => {
        const record = await store.load(owner, workspaceId);
        if (record) notify(record, errorMessage(error), retryReason(error));
        scheduleRetry();
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  async function flushAll(): Promise<void> {
    if (!accountId || stopped) return;
    try {
      const records = await store.listPending(accountId);
      await Promise.all(records.map((record) => flush(record.workspaceId)));
    } catch {
      scheduleRetry();
    }
  }

  const runtime: WorkspaceSessionAdapter = {
    ...authority,
    async listWorkspaces() {
      const epoch = ++accountEpoch;
      stopped = false;
      let index: WorkspaceSessionIndex;
      try {
        index = await liveIndex();
      } catch (error) {
        if (epoch !== accountEpoch || stopped) throw error;
        if (!isRetryable(error)) {
          accountId = null;
          preparedWrites.clear();
          await store.clearAccount();
          throw error;
        }
        const cached = await store.loadIndex();
        if (!cached?.principal) throw error;
        index = cached;
      }
      if (epoch !== accountEpoch || stopped)
        throw new HostedWorkspaceApiError(401, 'account_changed', 'The sign-in session changed.');
      if (accountId !== index.principal!.id) {
        statuses.clear();
        statusSignatures.clear();
        preparedWrites.clear();
      }
      accountId = index.principal!.id;
      stopped = false;
      scheduleRetry();
      return index;
    },
    async loadWorkspace(workspace) {
      return projectHostedWorkingSnapshot(await refreshRecord(workspace));
    },
    async createWorkspace(displayName, expectedAccountId) {
      const owner = mutationOwner(expectedAccountId);
      const index = await liveIndex();
      if (index.principal?.id !== owner)
        throw new HostedWorkspaceApiError(409, 'account_changed', 'The signed-in account changed.');
      return authority.createWorkspace(displayName, owner);
    },
    async readFile({ snapshot, file }) {
      const owner = actor();
      const record = await store.load(owner, snapshot.workspaceId);
      for (const operation of [...(record?.operations ?? [])].reverse()) {
        const write = operation.writes.find(
          (candidate) =>
            candidate.path === file.path &&
            `sha256:${candidate.contentSha256}` === file.contentRevision
        );
        if (write) return write.bytes.slice();
      }
      const cached = await store.readBytes(
        owner,
        snapshot.workspaceId,
        file.contentRevision,
        file.path
      );
      if (cached) return cached;
      const bytes = await authority.readFile({ snapshot, file });
      await store.saveBytes(owner, snapshot.workspaceId, file.contentRevision, file.path, bytes);
      return bytes;
    },
    async commit({
      snapshot,
      writes,
      removePaths = [],
      expectedAccountId,
      publicationCondition,
      onProgress,
    }) {
      const owner = mutationOwner(expectedAccountId);
      const immutableWrites = await Promise.all(
        writes.map(async (write) => {
          const bytes = write.bytes.slice();
          const existingId = snapshot.files.find((file) => file.path === write.path)?.resourceId;
          const resourceId =
            write.resourceId === null
              ? crypto.randomUUID()
              : (write.resourceId ?? existingId ?? crypto.randomUUID());
          return { ...write, resourceId, bytes, contentSha256: await sha256Hex(bytes) };
        })
      );
      if (publicationCondition) {
        return lock(`dnaforge-sync:${owner}:${snapshot.workspaceId}`, async () => {
          mutationOwner(owner);
          const record = await store.load(owner, snapshot.workspaceId);
          if (record?.operations.length || snapshot.localRevisionId) {
            throw new Error(
              'Sync your saved edits before attaching this result. The job result is retained.'
            );
          }
          if (
            publicationCondition.baseRevisionId !== snapshot.revisionId ||
            record?.accepted.revisionId !== snapshot.revisionId
          ) {
            throw new HostedWorkspaceApiError(
              409,
              'SYNC_CONFLICT',
              'The project changed before result attachment. The job result is retained.'
            );
          }
          const index = await liveIndex();
          if (index.principal?.id !== owner) {
            throw new HostedWorkspaceApiError(
              409,
              'account_changed',
              'The signed-in account changed.'
            );
          }
          if (
            !index.workspaces.some((workspace) => workspace.workspaceId === snapshot.workspaceId)
          ) {
            throw new HostedWorkspaceApiError(
              403,
              'ACCESS_REVOKED',
              'Project access is unavailable.'
            );
          }
          const accepted = await authority.commit({
            snapshot,
            writes: immutableWrites,
            removePaths,
            onProgress,
            expectedAccountId: owner,
            publicationCondition,
            operationId: `result:${(await sha256Hex(new TextEncoder().encode(JSON.stringify(publicationCondition)))).slice(0, 32)}`,
          });
          for (const write of immutableWrites) {
            const file = accepted.files.find((candidate) => candidate.path === write.path);
            if (file)
              await store.saveBytes(
                owner,
                snapshot.workspaceId,
                file.contentRevision,
                file.path,
                write.bytes
              );
          }
          const updated = await store.update(owner, snapshot.workspaceId, (current) => ({
            ...current,
            accountId: owner,
            workspaceId: snapshot.workspaceId,
            accepted,
            operations: current?.operations ?? [],
          }));
          notify(updated);
          mutationOwner(owner);
          return projectHostedWorkingSnapshot(updated);
        });
      }
      const operation: HostedPendingOperation = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        base: structuredClone(snapshot),
        writes: immutableWrites,
        removePaths: [...removePaths],
        state: 'queued',
      };
      const record = await store.update(owner, snapshot.workspaceId, (current) => {
        const queued = { ...operation, base: acknowledgedBase(current, operation.base) };
        const updated = {
          ...current,
          accountId: owner,
          workspaceId: snapshot.workspaceId,
          accepted: current?.accepted ?? snapshot,
          operations: [...(current?.operations ?? []), queued],
        };
        projectHostedWorkingSnapshot(updated);
        return updated;
      });
      notify(record);
      prepareQueuedWrites(record);
      scheduleRetry();
      void flush(snapshot.workspaceId);
      return projectHostedWorkingSnapshot(record);
    },
    async restoreRevision(input) {
      const owner = mutationOwner(input.expectedAccountId);
      return lock(`dnaforge-sync:${owner}:${input.workspace.workspaceId}`, async () => {
        const record = await store.load(owner, input.workspace.workspaceId);
        if (record?.operations.length)
          throw new Error('Sync or resolve your saved local changes before restoring history.');
        if (!authority.restoreRevision) throw new Error('Revision restore is unavailable.');
        const index = await liveIndex();
        if (index.principal?.id !== owner)
          throw new HostedWorkspaceApiError(
            409,
            'account_changed',
            'The signed-in account changed.'
          );
        const accepted = await authority.restoreRevision({ ...input, expectedAccountId: owner });
        const updated = await store.update(owner, input.workspace.workspaceId, (current) => ({
          ...current,
          accountId: owner,
          workspaceId: input.workspace.workspaceId,
          accepted,
          operations: current?.operations ?? [],
        }));
        notify(updated);
        return projectHostedWorkingSnapshot(updated);
      });
    },
  };

  async function inspectConflict(
    workspaceId: string,
    wholeQueue = true,
    choices?: WorkspaceSessionReconcileInput['choices']
  ) {
    const owner = actor();
    const record = await store.load(owner, workspaceId);
    if (!record?.operations.length) throw new Error('No pending draft is available.');
    const index = await liveIndex();
    if (index.principal?.id !== owner)
      throw new HostedWorkspaceApiError(
        409,
        'account_changed',
        'Sign back into the original account to review this draft.'
      );
    const workspace = index.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    if (!workspace)
      throw new HostedWorkspaceApiError(403, 'ACCESS_REVOKED', 'Project access is unavailable.');
    const remote = await authority.loadWorkspace(workspace);
    const operations = wholeQueue ? record.operations : record.operations.slice(0, 1);
    const base = operations[0].base;
    const local = projectHostedWorkingSnapshot({ ...record, accepted: base, operations });
    const result = await reconcileWorkspaceSessionSnapshots({
      base,
      local,
      remote,
      choices,
      readBytes: (snapshot, file) => runtime.readFile({ snapshot, file }),
    });
    return {
      accountId: owner,
      workspaceId,
      wholeQueue,
      operationIds: operations.map((operation) => operation.id),
      base,
      local,
      remote,
      result,
    };
  }

  async function replaceReviewedQueue(review: Awaited<ReturnType<typeof inspectConflict>>) {
    if (review.result.kind !== 'merged') throw new Error('Review still has unresolved conflicts.');
    const writes = await Promise.all(
      review.result.writes.map(async (write) => ({
        ...write,
        bytes: write.bytes.slice(),
        contentSha256: await sha256Hex(write.bytes),
      }))
    );
    const replacement: HostedPendingOperation = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      base: review.remote,
      writes,
      removePaths: [...review.result.removePaths],
      state: 'queued',
    };
    const record = await store.update(review.accountId, review.workspaceId, (current) => {
      if (
        !current ||
        (review.wholeQueue && current.operations.length !== review.operationIds.length) ||
        review.operationIds.some((id, index) => current.operations[index]?.id !== id)
      )
        throw new Error('Saved changes changed during review. Review the current draft again.');
      const supersessions = { ...current.supersessions };
      if (replacement.writes.length === 0 && replacement.removePaths.length === 0) {
        const acknowledgements = { ...current.acknowledgements };
        for (const id of review.operationIds) acknowledgements[id] = review.remote;
        return {
          ...current,
          accepted: review.remote,
          acknowledgements,
          operations: current.operations
            .slice(review.operationIds.length)
            .map((operation) =>
              review.operationIds.includes(operation.base.localRevisionId ?? '')
                ? { ...operation, base: review.remote }
                : operation
            ),
        };
      }
      for (const id of review.operationIds) supersessions[id] = replacement.id;
      return {
        ...current,
        accepted: review.remote,
        supersessions,
        operations: [
          replacement,
          ...current.operations
            .slice(review.operationIds.length)
            .map((operation) =>
              review.operationIds.includes(operation.base.localRevisionId ?? '')
                ? { ...operation, base: { ...operation.base, localRevisionId: replacement.id } }
                : operation
            ),
        ],
      };
    });
    notify(record);
  }

  return {
    runtime,
    store,
    flush,
    flushAll,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getRevision: () => revision,
    getStatus: (workspaceId: string) => statuses.get(workspaceId),
    inspectConflict: (workspaceId: string) => inspectConflict(workspaceId),
    async resolveConflict(workspaceId: string, choices: WorkspaceSessionReconcileInput['choices']) {
      const owner = actor();
      const review = await lock(`dnaforge-sync:${owner}:${workspaceId}`, async () => {
        const reviewed = await inspectConflict(workspaceId, true, choices);
        if (reviewed.result.kind !== 'merged') return reviewed;
        if (authority.retainRecoveryCandidate) {
          const writes = await Promise.all(
            reviewed.local.files.map(async (file) => ({
              path: file.path,
              resourceId: file.resourceId,
              contentType: file.contentType,
              bytes: await runtime.readFile({ snapshot: reviewed.local, file }),
            }))
          );
          const recovery = await authority.retainRecoveryCandidate({
            snapshot: reviewed.base,
            writes,
            removePaths: reviewed.base.files
              .filter((file) => !reviewed.local.files.some((local) => local.path === file.path))
              .map((file) => file.path),
            operationId: `review-${crypto.randomUUID()}`,
            expectedAccountId: owner,
          });
          if (Date.parse(recovery.expiresAt) <= Date.now())
            throw new Error(
              'The recovery copy expired. Review again to retain a fresh copy before replacing your draft.'
            );
        }
        await replaceReviewedQueue(reviewed);
        return reviewed;
      });
      if (review.result.kind === 'merged') {
        scheduleRetry();
        void flush(workspaceId);
      }
      return review;
    },
    async retry(workspaceId: string) {
      const owner = actor();
      const record = await store.update(owner, workspaceId, (current) => {
        if (!current) throw new Error('No saved draft is available.');
        return {
          ...current,
          operations: current.operations.map((operation) =>
            operation.state === 'blocked'
              ? { ...operation, state: 'queued', error: undefined, retryReason: undefined }
              : operation
          ),
        };
      });
      notify(record);
      await flush(workspaceId);
    },
    async signOut() {
      accountEpoch += 1;
      stopped = true;
      accountId = null;
      statuses.clear();
      statusSignatures.clear();
      preparedWrites.clear();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      await store.clearAccount();
    },
    dispose() {
      accountEpoch += 1;
      stopped = true;
      preparedWrites.clear();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      listeners.clear();
    },
  };
}

function acknowledgedBase(
  record: HostedSyncRecord | undefined,
  base: WorkspaceSessionSnapshot
): WorkspaceSessionSnapshot {
  let id = base.localRevisionId;
  const seen = new Set<string>();
  while (id && record?.supersessions?.[id]) {
    if (seen.has(id)) throw new Error('Saved operation dependencies are inconsistent.');
    seen.add(id);
    id = record.supersessions[id];
  }
  return id && record?.acknowledgements?.[id]
    ? record.acknowledgements[id]
    : id !== base.localRevisionId
      ? { ...base, localRevisionId: id }
      : base;
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    (error instanceof HostedWorkspaceApiError &&
      (error.status >= 500 || error.status === 408 || error.status === 429))
  );
}

function retryReason(error: unknown): HostedRetryReason | undefined {
  if (!isRetryable(error)) return undefined;
  if (error instanceof HostedWorkspaceApiError) return 'server-retrying';
  return globalThis.navigator?.onLine === false ? 'offline' : 'connection-unavailable';
}

function errorMessage(error: unknown): string {
  return toUserMessage(error, 'document.saveFailed');
}
