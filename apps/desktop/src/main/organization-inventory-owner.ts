import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { InventoryOrganizationTarget } from '@waypoint/domain-services';
import { getActiveStoredSession, type StoredSession } from './auth/session-store';
import {
  createDesktopSyncClient,
  DesktopSyncClientError,
  type DesktopSyncClient,
} from './desktop-sync-client';
import {
  createOrganizationInventoryClient,
  type OrganizationInventoryHttpClient,
} from './organization-inventory-client';
import {
  createOrganizationInventorySubmission,
  organizationInventoryConfirmedFactsCurrent,
} from './organization-inventory-submission';
import {
  readOrganizationInventoryProjection,
  removeOrganizationInventoryProjection,
  writeOrganizationInventoryProjection,
} from './organization-inventory-cache';
import {
  inventoryOrganizationDirectoryRequestSchema,
  inventoryOrganizationSnapshotRequestSchema,
  inventoryOrganizationPreviewRequestSchema,
  inventoryOrganizationSessionIdentitySchema,
  type InventoryOrganizationBinding,
  type InventoryOrganizationDirectoryRequest,
  type InventoryOrganizationDirectoryRead,
  type InventoryOrganizationSnapshotRequest,
  type InventoryOrganizationSnapshotRead,
  type InventoryOrganizationPreviewRequest,
  type InventoryOrganizationPreviewRead,
  type InventoryOrganizationSessionIdentity,
  type InventoryOrganizationUnavailable,
  type InventoryOrganizationSubmitRequest,
  type InventoryOrganizationCancelPreviewRequest,
  type InventoryOrganizationAttemptRequest,
  type InventoryOrganizationRecoverRequest,
} from '../shared/inventory-organization-client';
import {
  beginInventoryOrganizationDirectory,
  beginInventoryOrganizationSnapshot,
  beginInventoryOrganizationPreview,
  createInventoryOrganizationSession,
  invalidateInventoryOrganizationSession,
  publishInventoryOrganizationDirectory,
  publishInventoryOrganizationSnapshot,
  publishInventoryOrganizationPreview,
  selectInventoryOrganizationSession,
  inventoryOrganizationSameSession,
  type InventoryOrganizationSessionState,
} from '../shared/inventory-organization-session';

export interface OrganizationInventoryOwnerDeps {
  db: Database.Database;
  client?: OrganizationInventoryHttpClient;
  getActiveSession?: () => Promise<StoredSession | null>;
  refreshSession?: (expectedAccountId: string) => Promise<void>;
  nowMs?: () => number;
  monotonicMs?: () => number;
  createBindingEpoch?: () => string;
}

function unavailable(
  code: string,
  message: string,
  retryable = false
): InventoryOrganizationUnavailable {
  return { kind: 'unavailable', code, message, retryable };
}

function failure(error: unknown): InventoryOrganizationUnavailable {
  if (error instanceof DesktopSyncClientError)
    return unavailable(error.code, error.message, error.retryable);
  return unavailable(
    'INVALID_INVENTORY_RESPONSE',
    'The organization inventory could not be validated.'
  );
}

function denied(value: InventoryOrganizationUnavailable): boolean {
  return [
    'ACCESS_UNAVAILABLE',
    'FORBIDDEN',
    'NOT_FOUND',
    'SIGNED_OUT',
    'SESSION_REVOKED',
    'SESSION_CHANGED',
    'ACCOUNT_CHANGED',
  ].includes(value.code);
}

export function createOrganizationInventoryOwner(deps: OrganizationInventoryOwnerDeps) {
  let transport: DesktopSyncClient | undefined;
  const defaultTransport = () => (transport ??= createDesktopSyncClient());
  const client = deps.client ?? createOrganizationInventoryClient(defaultTransport());
  const activeSession = deps.getActiveSession ?? getActiveStoredSession;
  const refreshSession =
    deps.refreshSession ??
    (async (accountId: string) => {
      await defaultTransport().assertAccount?.(accountId);
    });
  const nowMs = deps.nowMs ?? Date.now;
  const monotonicMs = deps.monotonicMs ?? (() => performance.now());
  const createBindingEpoch = deps.createBindingEpoch ?? randomUUID;
  let callerStates = new WeakMap<object, Map<string, InventoryOrganizationSessionState>>();
  const sharedPublications = new Map<string, object>();
  const statesFor = (callerKey: object) => {
    let states = callerStates.get(callerKey);
    if (!states) {
      states = new Map();
      callerStates.set(callerKey, states);
    }
    return states;
  };
  const defaultCaller = {};
  let disposed = false;
  const clock = () => ({ wallTime: nowMs(), monotonicTime: monotonicMs() });
  const keyFor = (
    accountId: string,
    orgId: string,
    inventoryId: string | null,
    desktopSessionId: string
  ) => JSON.stringify([accountId, desktopSessionId, orgId, inventoryId]);
  const beginPublication = (
    session: InventoryOrganizationSessionIdentity,
    target: InventoryOrganizationTarget
  ) => {
    const key = JSON.stringify([session.accountId, target.orgId, target.inventoryId]);
    const ticket = {};
    sharedPublications.set(key, ticket);
    return () => !disposed && sharedPublications.get(key) === ticket;
  };
  const assertOwner = (assertCurrent: () => void) => {
    assertCurrent();
    if (disposed) throw new Error('The inventory owner changed.');
  };
  const identity = async (
    accountId: string,
    desktopSessionId: string,
    assertCurrent: () => void,
    allowRefresh: boolean
  ): Promise<InventoryOrganizationSessionIdentity> => {
    assertOwner(assertCurrent);
    let session = await activeSession();
    assertOwner(assertCurrent);
    const matches = () =>
      session?.accountId === accountId && session.desktopSessionId === desktopSessionId;
    if (!matches())
      throw new DesktopSyncClientError(
        'SESSION_CHANGED',
        'The signed-in session changed. Open this inventory under the current session.',
        { retryable: true, terminal: false, authPaused: true }
      );
    if (
      allowRefresh &&
      (!Number.isFinite(Date.parse(session!.accessTokenExpiresAt)) ||
        Date.parse(session!.accessTokenExpiresAt) <= nowMs())
    ) {
      await refreshSession(accountId);
      assertOwner(assertCurrent);
      session = await activeSession();
      assertOwner(assertCurrent);
      if (!matches())
        throw new DesktopSyncClientError(
          'SESSION_CHANGED',
          'The signed-in session changed while authentication refreshed.',
          { retryable: true, terminal: false, authPaused: true }
        );
    }
    const value = inventoryOrganizationSessionIdentitySchema.parse({
      accountId,
      desktopSessionId,
      knownAccessTokenExpiresAt: Date.parse(session!.accessTokenExpiresAt),
    });
    if (value.knownAccessTokenExpiresAt <= nowMs())
      throw new DesktopSyncClientError(
        'BAD_RESPONSE',
        'Authentication did not provide a current access token.',
        { retryable: false, terminal: false, authPaused: true }
      );
    return value;
  };
  const select = (
    states: Map<string, InventoryOrganizationSessionState>,
    key: string,
    session: InventoryOrganizationSessionIdentity,
    target: InventoryOrganizationTarget | null
  ) => {
    const state = selectInventoryOrganizationSession(
      states.get(key) ?? createInventoryOrganizationSession(),
      session,
      target
    );
    states.set(key, state);
    return state;
  };
  const superseded = () =>
    unavailable('SUPERSEDED', 'The inventory view changed before this read completed.', true);
  const invalidate = (
    states: Map<string, InventoryOrganizationSessionState>,
    key: string,
    value: InventoryOrganizationUnavailable,
    expectedDesktopSessionId: string,
    accountId?: string,
    target?: InventoryOrganizationTarget,
    generation?: number,
    assertCurrent: () => void = () => {},
    publicationCurrent?: () => boolean
  ) => {
    try {
      assertOwner(assertCurrent);
    } catch {
      return superseded();
    }
    const state = states.get(key);
    if (
      disposed ||
      (state &&
        (state.session?.desktopSessionId !== expectedDesktopSessionId ||
          (generation !== undefined && state.generation !== generation)))
    )
      return superseded();
    if (publicationCurrent && !publicationCurrent()) {
      if (state) states.set(key, invalidateInventoryOrganizationSession(state, 'binding-change'));
      return superseded();
    }
    if (state)
      states.set(
        key,
        invalidateInventoryOrganizationSession(
          state,
          denied(value) ? 'access-denied' : 'binding-change'
        )
      );
    if (publicationCurrent?.() && value.code !== 'NETWORK' && accountId && target)
      removeOrganizationInventoryProjection(deps.db, accountId, target, expectedDesktopSessionId);
    return value;
  };

  const submission = createOrganizationInventorySubmission({
    db: deps.db,
    client,
    nowMs,
    monotonicMs,
    assertStorage: () => {
      if (disposed) throw new Error('The inventory storage owner changed.');
    },
    assertOwner,
    identity,
    state: (accountId, target, callerKey, desktopSessionId) =>
      statesFor(callerKey).get(
        keyFor(accountId, target.orgId, target.inventoryId, desktopSessionId)
      ),
    snapshot: (request, assertCurrent, callerKey): Promise<InventoryOrganizationSnapshotRead> =>
      owner.organizationSnapshot(request, assertCurrent, callerKey),
    beginPublication,
    observeFailure: (
      value,
      session,
      target,
      generation,
      assertCurrent,
      callerKey,
      publicationCurrent
    ) => {
      invalidate(
        statesFor(callerKey),
        keyFor(session.accountId, target.orgId, target.inventoryId, session.desktopSessionId),
        value,
        session.desktopSessionId,
        session.accountId,
        target,
        generation,
        assertCurrent,
        publicationCurrent
      );
    },
  });

  const owner = {
    async organizationDirectory(
      input: InventoryOrganizationDirectoryRequest,
      assertCurrent: () => void = () => {},
      callerKey: object = defaultCaller
    ): Promise<InventoryOrganizationDirectoryRead> {
      const request = inventoryOrganizationDirectoryRequestSchema.parse(input);
      const states = statesFor(callerKey);
      const key = keyFor(
        request.expectedAccountId,
        request.orgId,
        null,
        request.expectedDesktopSessionId
      );
      let generation: number | undefined;
      try {
        const session = await identity(
          request.expectedAccountId,
          request.expectedDesktopSessionId,
          assertCurrent,
          true
        );
        const started = beginInventoryOrganizationDirectory(
          select(states, key, session, null),
          request,
          clock()
        );
        generation = started.ticket.generation;
        states.set(key, started.state);
        const directory = await client.listDirectory({
          accountId: session.accountId,
          desktopSessionId: session.desktopSessionId,
          orgId: request.orgId,
        });
        const active = await identity(
          session.accountId,
          session.desktopSessionId,
          assertCurrent,
          false
        );
        const current = states.get(key)!;
        const read: InventoryOrganizationDirectoryRead =
          directory.kind === 'unavailable'
            ? directory
            : { kind: 'ready', session: active, directory };
        const next = publishInventoryOrganizationDirectory(
          current,
          started.ticket,
          read,
          active,
          clock()
        );
        if (next === current) return superseded();
        states.set(key, next);
        return read;
      } catch (error) {
        return invalidate(
          states,
          key,
          failure(error),
          request.expectedDesktopSessionId,
          undefined,
          undefined,
          generation,
          assertCurrent
        );
      }
    },

    async organizationSnapshot(
      input: InventoryOrganizationSnapshotRequest,
      assertCurrent: () => void = () => {},
      callerKey: object = defaultCaller
    ): Promise<InventoryOrganizationSnapshotRead> {
      const request = inventoryOrganizationSnapshotRequestSchema.parse(input);
      const states = statesFor(callerKey);
      let publicationCurrent: (() => boolean) | undefined;
      const key = keyFor(
        request.expectedAccountId,
        request.target.orgId,
        request.target.inventoryId,
        request.expectedDesktopSessionId
      );
      let ticket: ReturnType<typeof beginInventoryOrganizationSnapshot>['ticket'] | undefined;
      try {
        const session = await identity(
          request.expectedAccountId,
          request.expectedDesktopSessionId,
          assertCurrent,
          true
        );
        const started = beginInventoryOrganizationSnapshot(
          select(states, key, session, request.target),
          request,
          clock()
        );
        ticket = started.ticket;
        states.set(key, started.state);
        publicationCurrent = beginPublication(session, request.target);
        const snapshot = await client.readSnapshot({
          accountId: session.accountId,
          desktopSessionId: session.desktopSessionId,
          target: request.target,
        });
        const active = await identity(
          session.accountId,
          session.desktopSessionId,
          assertCurrent,
          false
        );
        if (!publicationCurrent())
          return invalidate(
            states,
            key,
            superseded(),
            request.expectedDesktopSessionId,
            undefined,
            undefined,
            ticket.generation,
            assertCurrent,
            publicationCurrent
          );
        if (snapshot.kind === 'unavailable')
          return invalidate(
            states,
            key,
            snapshot,
            request.expectedDesktopSessionId,
            active.accountId,
            request.target,
            ticket.generation,
            assertCurrent,
            publicationCurrent
          );
        const binding: InventoryOrganizationBinding = {
          ...active,
          target: snapshot.header.target,
          accessGeneration: snapshot.header.accessGeneration,
          bindingEpoch: createBindingEpoch(),
        };
        const read: InventoryOrganizationSnapshotRead = { kind: 'current', binding, snapshot };
        const current = states.get(key)!;
        const next = publishInventoryOrganizationSnapshot(current, ticket, read, active, clock());
        if (next === current) return superseded();
        assertOwner(assertCurrent);
        writeOrganizationInventoryProjection(deps.db, active, snapshot);
        states.set(key, next);
        return read;
      } catch (error) {
        const value = failure(error);
        if (publicationCurrent && !publicationCurrent())
          return invalidate(
            states,
            key,
            superseded(),
            request.expectedDesktopSessionId,
            undefined,
            undefined,
            ticket?.generation,
            assertCurrent,
            publicationCurrent
          );
        if (value.code === 'NETWORK' && ticket) {
          try {
            const active = await identity(
              request.expectedAccountId,
              request.expectedDesktopSessionId,
              assertCurrent,
              false
            );
            if (publicationCurrent && !publicationCurrent())
              return invalidate(
                states,
                key,
                superseded(),
                request.expectedDesktopSessionId,
                undefined,
                undefined,
                ticket.generation,
                assertCurrent,
                publicationCurrent
              );
            const projection = readOrganizationInventoryProjection(
              deps.db,
              active.accountId,
              request.target
            );
            if (
              projection &&
              inventoryOrganizationSameSession(projection.session, active) &&
              Math.min(
                projection.session.knownAccessTokenExpiresAt,
                active.knownAccessTokenExpiresAt
              ) > nowMs()
            ) {
              const binding: InventoryOrganizationBinding = {
                ...projection.session,
                target: request.target,
                accessGeneration: projection.snapshot.header.accessGeneration,
                bindingEpoch: createBindingEpoch(),
              };
              const read: InventoryOrganizationSnapshotRead = {
                kind: 'cached-offline',
                binding,
                snapshot: projection.snapshot,
                failure: value,
              };
              const current = states.get(key)!;
              const next = publishInventoryOrganizationSnapshot(
                current,
                ticket,
                read,
                active,
                clock()
              );
              if (next === current) return superseded();
              states.set(key, next);
              return read;
            }
          } catch {
            return invalidate(
              states,
              key,
              value,
              request.expectedDesktopSessionId,
              request.expectedAccountId,
              request.target,
              ticket.generation,
              assertCurrent,
              publicationCurrent
            );
          }
        }
        return invalidate(
          states,
          key,
          value,
          request.expectedDesktopSessionId,
          request.expectedAccountId,
          request.target,
          ticket?.generation,
          assertCurrent,
          publicationCurrent
        );
      }
    },

    async organizationPreview(
      input: InventoryOrganizationPreviewRequest,
      assertCurrent: () => void = () => {},
      callerKey: object = defaultCaller
    ): Promise<InventoryOrganizationPreviewRead> {
      const request = inventoryOrganizationPreviewRequestSchema.parse(input);
      const binding = request.binding;
      const states = statesFor(callerKey);
      let publicationCurrent: (() => boolean) | undefined;
      const key = keyFor(
        binding.accountId,
        binding.target.orgId,
        binding.target.inventoryId,
        binding.desktopSessionId
      );
      let generation: number | undefined;
      try {
        const session = await identity(
          binding.accountId,
          binding.desktopSessionId,
          assertCurrent,
          true
        );
        const state = states.get(key);
        if (!state)
          return unavailable('REFRESH_REQUIRED', 'Load the current inventory before previewing.');
        if (
          state.snapshot?.kind !== 'current' ||
          !organizationInventoryConfirmedFactsCurrent(deps.db, session, state.snapshot, nowMs())
        )
          return invalidate(
            states,
            key,
            unavailable('REFRESH_REQUIRED', 'Refresh the inventory before previewing.'),
            binding.desktopSessionId,
            undefined,
            undefined,
            undefined,
            assertCurrent
          );
        submission.invalidatePreviews(binding.accountId, binding.target, callerKey);
        const started = beginInventoryOrganizationPreview(
          select(states, key, session, binding.target),
          request,
          clock()
        );
        generation = started.ticket.generation;
        states.set(key, started.state);
        publicationCurrent = beginPublication(session, binding.target);
        const preview = await client.preview({
          accountId: session.accountId,
          desktopSessionId: session.desktopSessionId,
          request: request.request,
        });
        const active = await identity(
          session.accountId,
          session.desktopSessionId,
          assertCurrent,
          false
        );
        if (!publicationCurrent())
          return invalidate(
            states,
            key,
            superseded(),
            binding.desktopSessionId,
            undefined,
            undefined,
            generation,
            assertCurrent,
            publicationCurrent
          );
        if (preview.kind === 'unavailable')
          return invalidate(
            states,
            key,
            preview,
            binding.desktopSessionId,
            active.accountId,
            binding.target,
            generation,
            assertCurrent,
            publicationCurrent
          );
        if (preview.header.accessGeneration !== binding.accessGeneration)
          return invalidate(
            states,
            key,
            unavailable('ACCESS_CHANGED', 'Inventory access changed. Refresh before previewing.'),
            binding.desktopSessionId,
            active.accountId,
            binding.target,
            generation,
            assertCurrent,
            publicationCurrent
          );
        const read: InventoryOrganizationPreviewRead =
          preview.kind === 'ready'
            ? { kind: 'ready', binding, preview, previewHandleId: randomUUID() }
            : { kind: 'blocked', binding, preview };
        const current = states.get(key)!;
        const next = publishInventoryOrganizationPreview(
          current,
          started.ticket,
          read,
          active,
          clock()
        );
        if (next === current) return superseded();
        if (next.failure?.code === 'SNAPSHOT_CHANGED')
          removeOrganizationInventoryProjection(
            deps.db,
            active.accountId,
            binding.target,
            active.desktopSessionId
          );
        states.set(key, next);
        if (
          read.kind === 'ready' &&
          next.preview?.kind === 'ready' &&
          next.previewExpiresAtMonotonic !== null
        )
          submission.issuePreview(
            request,
            read,
            assertCurrent,
            callerKey,
            next.previewExpiresAtMonotonic
          );
        return next.preview?.kind === 'expired'
          ? unavailable(
              'PREVIEW_EXPIRED',
              'The preview expired. Refresh and review it again.',
              true
            )
          : read;
      } catch (error) {
        return invalidate(
          states,
          key,
          failure(error),
          binding.desktopSessionId,
          binding.accountId,
          binding.target,
          generation,
          assertCurrent,
          publicationCurrent
        );
      }
    },

    organizationSubmit(
      input: InventoryOrganizationSubmitRequest,
      assertCurrent: () => void = () => {},
      callerKey: object = defaultCaller
    ) {
      return submission.organizationSubmit(input, assertCurrent, callerKey);
    },

    organizationCancelPreview(
      input: InventoryOrganizationCancelPreviewRequest,
      assertCurrent: () => void = () => {},
      callerKey: object = defaultCaller
    ) {
      return submission.organizationCancelPreview(input, assertCurrent, callerKey);
    },

    organizationAttempt(
      input: InventoryOrganizationAttemptRequest,
      assertCurrent: () => void = () => {},
      callerKey: object = defaultCaller
    ) {
      return submission.organizationAttempt(input, assertCurrent, callerKey);
    },

    organizationRecover(
      input: InventoryOrganizationRecoverRequest,
      assertCurrent: () => void = () => {},
      callerKey: object = defaultCaller
    ) {
      return submission.organizationRecover(input, assertCurrent, callerKey);
    },

    dispose(): void {
      disposed = true;
      submission.dispose();
      callerStates = new WeakMap();
      sharedPublications.clear();
    },
  };
  return owner;
}

export type OrganizationInventoryOwner = ReturnType<typeof createOrganizationInventoryOwner>;
