import type Database from 'better-sqlite3';
import { DesktopSyncClientError } from './desktop-sync-client';
import {
  assertOrgRegistryRecordMutationMaySend,
  isOrgRegistryRecordMutationHeld,
  markOrgRegistryRecordMutationQueuedInTx,
  readReadyOrgRegistryRecordMutations,
} from './org-registry-record-sync';
import {
  acknowledgeOrgRegistryMutation,
  enqueueOrgRegistryMutation,
  applyOrgRegistryEventPage,
  failOrgRegistryMutation,
  markOrgRegistryMutationConflict,
  markOrgRegistryMutationSending,
  readOrgRegistrySyncState,
  readPendingOrgRegistryMutations,
  recoverOrgRegistrySendingMutations,
  invalidateOrgRegistryAccess,
  requireOrgRegistryAccessGeneration,
  retryOrgRegistryMutation,
  revokeOrgRegistryCache,
  setOrgRegistrySyncStatus,
  type OrgRegistryEventPayload,
  type OrgRegistryOperation,
  type OrgRegistryAccessReset,
  type OrgRegistryRemoteMutationReceipt,
} from './org-registry-sync-cache';
import {
  readRegistrySnapshotTransfer,
  beginRegistrySnapshotTransfer,
  stageRegistrySnapshotPage,
  promoteRegistrySnapshot,
  REGISTRY_SNAPSHOT_PAGE_RECORDS,
  type OrganizationRegistrySnapshotPage,
} from './org-registry-snapshot-cache';

export interface OrganizationRegistryRemoteEventPage {
  accessGeneration: string;
  events: OrgRegistryEventPayload[];
  nextCursor: number;
  currentCursor: number;
  hasMore: boolean;
}
export interface OrganizationRegistrySnapshotAcknowledgement {
  status: 'acknowledged';
  snapshotId: string;
  cursor: number;
  accessGeneration: string;
}
export interface OrganizationRegistryRemoteClient {
  getSnapshotPage(input: {
    orgId: string;
    accountId: string;
    clientId: string;
    snapshotId: string;
    after: number;
    limit: number;
    accessGeneration: string | null;
  }): Promise<OrganizationRegistrySnapshotPage | OrgRegistryAccessReset>;
  acknowledgeSnapshot(input: {
    orgId: string;
    accountId: string;
    clientId: string;
    snapshotId: string;
    cursor: number;
    accessGeneration: string;
  }): Promise<OrganizationRegistrySnapshotAcknowledgement | OrgRegistryAccessReset>;
  getEvents(input: {
    orgId: string;
    accountId: string;
    clientId: string;
    after: number;
    limit: number;
    accessGeneration: string;
  }): Promise<OrganizationRegistryRemoteEventPage | OrgRegistryAccessReset>;
  applyMutation(input: {
    orgId: string;
    accountId: string;
    clientId: string;
    mutationId: string;
    operation: OrgRegistryOperation;
    payload: Record<string, unknown>;
    accessGeneration: string;
  }): Promise<OrgRegistryRemoteMutationReceipt | OrgRegistryAccessReset>;
}

export interface OrganizationRegistrySyncResult {
  status: 'ready' | 'error' | 'access_revoked' | 'not_configured';
  cursor: number;
  pendingCount: number;
  conflictCount: number;
  errorCode?: string;
  errorMessage?: string;
}

const EVENT_PAGE_LIMIT = 500;
const MAX_EVENT_PAGES = 100;

class RegistryAccessChanged extends Error {}

export async function syncOrganizationRegistry(
  db: Database.Database,
  input: Parameters<typeof synchronize>[1]
): Promise<OrganizationRegistrySyncResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await synchronize(db, input);
    } catch (error) {
      if (!(error instanceof RegistryAccessChanged)) throw error;
      if (attempt < 2) continue;
      const now = (input.now ?? Date.now)();
      recoverOrgRegistrySendingMutations(db, { ...input, now });
      setOrgRegistrySyncStatus(db, {
        ...input,
        status: 'error',
        errorCode: 'ACCESS_CHANGED',
        errorMessage: error.message,
        now,
      });
      return {
        ...resultFromDb(db, input, 'error'),
        errorCode: 'ACCESS_CHANGED',
        errorMessage: error.message,
      };
    }
  }
  throw new Error('Registry synchronization did not complete.');
}

function acceptScope<T extends object>(
  db: Database.Database,
  input: { orgId: string; accountId: string; clientId: string },
  value: T | OrgRegistryAccessReset,
  now: number
): T {
  if ('status' in value && value.status === 'reset_required') {
    invalidateOrgRegistryAccess(db, { ...input, now });
    throw new RegistryAccessChanged(
      'Registry project access changed. A fresh scoped snapshot is required.'
    );
  }
  return value as T;
}

async function synchronize(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    clientId: string;
    client: OrganizationRegistryRemoteClient;
    now?: () => number;
  }
): Promise<OrganizationRegistrySyncResult> {
  const now = input.now ?? Date.now;
  const original = readOrgRegistrySyncState(db, input);
  recoverOrgRegistrySendingMutations(db, { ...input, now: now() });
  setOrgRegistrySyncStatus(db, { ...input, status: 'syncing', now: now() });

  try {
    const transfer = readRegistrySnapshotTransfer(db, input);
    if (
      original.status === 'idle' ||
      original.status === 'access_revoked' ||
      !original.accessGeneration ||
      !transfer?.bootstrapComplete ||
      Boolean(transfer.snapshotId)
    ) {
      await bootstrap(db, input, now);
      await pullUntilCurrent(db, input, now);
    } else {
      await pullUntilCurrent(db, input, now);
    }

    let pushed = false;

    const attempted = new Set<string>();
    for (let count = 0; count < 100; count++) {
      db.transaction(() => {
        for (const ready of readReadyOrgRegistryRecordMutations(db, {
          ...input,
          now: now(),
        })) {
          enqueueOrgRegistryMutation(db, { ...input, ...ready, now: now() });
          markOrgRegistryRecordMutationQueuedInTx(db, {
            mutationId: ready.mutationId,
            now: now(),
          });
        }
      })();
      const mutation = readPendingOrgRegistryMutations(db, {
        orgId: input.orgId,
        accountId: input.accountId,
        now: now(),
      }).find(
        (entry) => !attempted.has(entry.mutationId) && !isOrgRegistryRecordMutationHeld(db, entry)
      );
      if (!mutation) break;
      attempted.add(mutation.mutationId);
      markOrgRegistryMutationSending(db, {
        mutationId: mutation.mutationId,
        now: now(),
      });
      try {
        assertOrgRegistryRecordMutationMaySend(db, mutation);
        const result = acceptScope(
          db,
          input,
          await input.client.applyMutation({
            orgId: input.orgId,
            accountId: input.accountId,
            clientId: mutation.clientId,
            mutationId: mutation.mutationId,
            operation: mutation.operation,
            payload: mutation.payload,
            accessGeneration: requireOrgRegistryAccessGeneration(
              readOrgRegistrySyncState(db, input).accessGeneration
            ),
          }),
          now()
        );
        acknowledgeOrgRegistryMutation(db, {
          mutationId: mutation.mutationId,
          orgId: input.orgId,
          accountId: input.accountId,
          clientId: mutation.clientId,
          receipt: result,
          now: now(),
        });
        pushed = true;
      } catch (error) {
        if (error instanceof RegistryAccessChanged) throw error;

        if (
          error instanceof DesktopSyncClientError &&
          (error.code === 'CONFLICT' || error.code === 'IDEMPOTENCY_CONFLICT')
        ) {
          markOrgRegistryMutationConflict(db, {
            mutationId: mutation.mutationId,
            code: error.code,
            message: error.message,
            details: error.details,
            now: now(),
          });
          continue;
        }
        if (error instanceof DesktopSyncClientError && error.retryable) {
          retryOrgRegistryMutation(db, {
            mutationId: mutation.mutationId,
            code: error.code,
            message: error.message,
            nextAttemptAt: now() + retryDelayMs(mutation.attemptCount + 1),
            now: now(),
          });
          break;
        }
        failOrgRegistryMutation(db, {
          mutationId: mutation.mutationId,
          code: error instanceof DesktopSyncClientError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : 'Registry mutation failed.',
          now: now(),
        });
      }
    }

    if (pushed) await pullUntilCurrent(db, input, now);
    setOrgRegistrySyncStatus(db, { ...input, status: 'ready', now: now() });
    return resultFromDb(db, input, 'ready');
  } catch (error) {
    if (error instanceof RegistryAccessChanged) throw error;
    if (isAccessRevoked(error)) {
      revokeOrgRegistryCache(db, { ...input, now: now() });
      return resultFromDb(db, input, 'access_revoked');
    }
    if (error instanceof DesktopSyncClientError && error.code === 'NOT_CONFIGURED') {
      setOrgRegistrySyncStatus(db, {
        ...input,
        status: 'error',
        errorCode: error.code,
        errorMessage: error.message,
        now: now(),
      });
      return {
        ...resultFromDb(db, input, 'not_configured'),
        errorCode: error.code,
        errorMessage: error.message,
      };
    }
    const code = error instanceof DesktopSyncClientError ? error.code : 'UNKNOWN';
    const message = error instanceof Error ? error.message : 'Registry synchronization failed.';
    setOrgRegistrySyncStatus(db, {
      ...input,
      status: 'error',
      errorCode: code,
      errorMessage: message,
      now: now(),
    });
    return {
      ...resultFromDb(db, input, 'error'),
      errorCode: code,
      errorMessage: message,
    };
  }
}

async function bootstrap(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    clientId: string;
    client: OrganizationRegistryRemoteClient;
  },
  now: () => number,
  forceNew = false
): Promise<void> {
  const getPage = input.client.getSnapshotPage;
  const acknowledge = input.client.acknowledgeSnapshot;
  let transfer = readRegistrySnapshotTransfer(db, input);
  if (
    forceNew ||
    !transfer?.snapshotId ||
    transfer.clientId !== input.clientId ||
    (transfer.accessGeneration === null && (transfer.nextAfter > 0 || transfer.downloadComplete)) ||
    (transfer.expiresAt !== null && transfer.expiresAt <= now())
  )
    transfer = beginRegistrySnapshotTransfer(db, { ...input, now: now() });
  let expiredRetry = false;

  for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
    const snapshotId = transfer.snapshotId;
    if (!snapshotId) throw new Error('Registry bootstrap lost its snapshot identity.');
    try {
      if (transfer.downloadComplete && transfer.cursor !== null) {
        const accessGeneration = requireOrgRegistryAccessGeneration(transfer.accessGeneration);
        const receipt = acceptScope(
          db,
          input,
          await acknowledge.call(input.client, {
            ...input,
            snapshotId,
            cursor: transfer.cursor,
            accessGeneration,
          }),
          now()
        );
        if (
          receipt.status !== 'acknowledged' ||
          receipt.snapshotId !== snapshotId ||
          receipt.cursor !== transfer.cursor ||
          receipt.accessGeneration !== accessGeneration
        )
          throw new Error('Registry snapshot acknowledgement mismatch.');
        promoteRegistrySnapshot(db, {
          ...input,
          snapshotId,
          accessGeneration,
          now: now(),
        });
        return;
      }
      const page = acceptScope(
        db,
        input,
        await getPage.call(input.client, {
          ...input,
          snapshotId,
          after: transfer.nextAfter,
          limit: REGISTRY_SNAPSHOT_PAGE_RECORDS,
          accessGeneration: transfer.accessGeneration,
        }),
        now()
      );
      stageRegistrySnapshotPage(db, { ...input, page, now: now() });
      transfer = readRegistrySnapshotTransfer(db, input)!;
    } catch (error) {
      if (!expiredRetry && error instanceof DesktopSyncClientError && error.status === 410) {
        expiredRetry = true;
        transfer = beginRegistrySnapshotTransfer(db, { ...input, now: now() });
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    'Registry snapshot needs another synchronization pass; saved progress is retained.'
  );
}

async function pullUntilCurrent(
  db: Database.Database,
  input: {
    orgId: string;
    accountId: string;
    clientId: string;
    client: OrganizationRegistryRemoteClient;
  },
  now: () => number
): Promise<void> {
  for (let pageNumber = 0; pageNumber < MAX_EVENT_PAGES; pageNumber += 1) {
    const state = readOrgRegistrySyncState(db, input);
    const cursor = state.cursor;
    const accessGeneration = requireOrgRegistryAccessGeneration(state.accessGeneration);
    const page = acceptScope(
      db,
      input,
      await input.client.getEvents({
        ...input,
        accessGeneration,
        after: cursor,
        limit: EVENT_PAGE_LIMIT,
      }),
      now()
    );
    if (page.accessGeneration !== accessGeneration)
      throw new Error('Registry event access generation mismatch.');
    if (
      page.events.some(
        (event) =>
          event.eventType === 'namespace.configured' || event.eventType === 'registry.configured'
      )
    ) {
      await bootstrap(db, input, now, true);
      continue;
    }
    applyOrgRegistryEventPage(db, {
      ...input,
      accessGeneration: page.accessGeneration,
      nextCursor: page.nextCursor,
      events: page.events,
      now: now(),
    });
    if (!page.hasMore) {
      if (page.nextCursor !== page.currentCursor) {
        throw new Error('Registry event stream ended before its current cursor.');
      }

      if (page.events.length === 0) return;
    }
    if (page.nextCursor <= cursor) throw new Error('Registry event stream made no progress.');
  }
  throw new Error('Registry event stream exceeded the bounded page limit.');
}

function resultFromDb(
  db: Database.Database,
  input: { orgId: string; accountId: string },
  status: OrganizationRegistrySyncResult['status']
): OrganizationRegistrySyncResult {
  const state = readOrgRegistrySyncState(db, input);
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS count FROM org_registry_outbox
       WHERE org_id = ? AND account_id = ? AND status IN ('pending', 'sending', 'retry_wait')`
    )
    .get(input.orgId, input.accountId) as { count: number };
  const conflicts = db
    .prepare(
      `SELECT COUNT(*) AS count FROM org_registry_conflicts
       WHERE org_id = ? AND account_id = ? AND status = 'open'`
    )
    .get(input.orgId, input.accountId) as { count: number };
  return {
    status,
    cursor: state.cursor,
    pendingCount: pending.count,
    conflictCount: conflicts.count,
  };
}

function isAccessRevoked(error: unknown): boolean {
  return (
    error instanceof DesktopSyncClientError &&
    (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
  );
}

function retryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8));
}
