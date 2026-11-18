import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
  organizationInventoryCanonicalJson,
  type InventoryOrganizationTarget,
} from '@waypoint/domain-services';
import { DesktopSyncClientError } from './desktop-sync-client';
import type { OrganizationInventoryHttpClient } from './organization-inventory-client';
import {
  confirmOrganizationInventoryAttemptProjection,
  markOrganizationInventoryAttemptMayHaveSent,
  readBlockingOrganizationInventoryAttempt,
  readOrganizationInventoryAttempt,
  readOrganizationInventoryAttemptForHandle,
  recordOrganizationInventoryAttemptDisposition,
  retainOrganizationInventoryAttempt,
  type OrganizationInventoryStoredAttempt,
} from './organization-inventory-attempts';
import { readOrCreateWorkspaceSyncDeviceId } from './workspace-sync-device';
import { readOrganizationInventoryProjection } from './organization-inventory-cache';
import {
  inventoryOrganizationAttemptRequestSchema,
  inventoryOrganizationCancelPreviewRequestSchema,
  inventoryOrganizationRecoverRequestSchema,
  inventoryOrganizationSubmitRequestSchema,
  type InventoryOrganizationActionAttempt,
  type InventoryOrganizationActionAttemptRead,
  type InventoryOrganizationAttemptRead,
  type InventoryOrganizationAttemptRequest,
  type InventoryOrganizationCancelPreviewRead,
  type InventoryOrganizationCancelPreviewRequest,
  type InventoryOrganizationPreviewRead,
  type InventoryOrganizationPreviewRequest,
  type InventoryOrganizationRecoverRequest,
  type InventoryOrganizationSessionIdentity,
  type InventoryOrganizationSnapshotRead,
  type InventoryOrganizationSnapshotRequest,
  type InventoryOrganizationSubmitRequest,
  type InventoryOrganizationUnavailable,
} from '../shared/inventory-organization-client';
import {
  inventoryOrganizationSameBinding,
  inventoryOrganizationSameSession,
  type InventoryOrganizationSessionState,
} from '../shared/inventory-organization-session';

interface SubmissionDependencies {
  db: Database.Database;
  client: OrganizationInventoryHttpClient;
  nowMs(): number;
  monotonicMs(): number;
  assertStorage(): void;
  assertOwner(assertCurrent: () => void): void;
  identity(
    accountId: string,
    desktopSessionId: string,
    assertCurrent: () => void,
    allowRefresh: boolean
  ): Promise<InventoryOrganizationSessionIdentity>;
  state(
    accountId: string,
    target: InventoryOrganizationTarget,
    callerKey: object,
    desktopSessionId: string
  ): InventoryOrganizationSessionState | undefined;
  snapshot(
    request: InventoryOrganizationSnapshotRequest,
    assertCurrent: () => void,
    callerKey: object
  ): Promise<InventoryOrganizationSnapshotRead>;
  observeFailure(
    value: InventoryOrganizationUnavailable,
    session: InventoryOrganizationSessionIdentity,
    target: InventoryOrganizationTarget,
    generation: number | undefined,
    assertCurrent: () => void,
    callerKey: object,
    publicationCurrent: () => boolean
  ): void;
  beginPublication(
    session: InventoryOrganizationSessionIdentity,
    target: InventoryOrganizationTarget
  ): () => boolean;
  createOperationId?(): string;
  getDeviceId?(): string;
}

interface LivePreview {
  request: InventoryOrganizationPreviewRequest;
  read: Extract<InventoryOrganizationPreviewRead, { kind: 'ready' }>;
  callerKey: object;
  assertCurrent(): void;
  deadline: number;
}

const same = (a: unknown, b: unknown) =>
  organizationInventoryCanonicalJson(a) === organizationInventoryCanonicalJson(b);
const unavailable = (
  code: string,
  message: string,
  retryable = true
): InventoryOrganizationUnavailable => ({ kind: 'unavailable', code, message, retryable });
const failure = (error: unknown): InventoryOrganizationUnavailable =>
  error instanceof DesktopSyncClientError
    ? unavailable(error.code, error.message, error.retryable)
    : unavailable(
        'INVENTORY_CONFIRMATION_UNAVAILABLE',
        'The retained inventory operation could not be confirmed. Recover this same operation before trying another.'
      );
const accessHidden = (
  value: InventoryOrganizationUnavailable | null
): value is InventoryOrganizationUnavailable =>
  value !== null &&
  [
    'ACCESS_UNAVAILABLE',
    'FORBIDDEN',
    'NOT_FOUND',
    'SIGNED_OUT',
    'SESSION_REVOKED',
    'SESSION_CHANGED',
    'ACCOUNT_CHANGED',
  ].includes(value.code);
const descriptor = (
  row: OrganizationInventoryStoredAttempt
): InventoryOrganizationActionAttempt => ({
  target: row.key.target,
  operationId: row.key.operationId,
  requestSha256: row.requestSha256,
  originalDesktopSessionId: row.originalDesktopSessionId,
  createdAt: row.createdAt,
  request: row.request,
});

export function organizationInventoryConfirmedFactsCurrent(
  db: Database.Database,
  session: InventoryOrganizationSessionIdentity,
  expected: Extract<InventoryOrganizationSnapshotRead, { kind: 'current' }>,
  now: number
): boolean {
  const projection = readOrganizationInventoryProjection(
    db,
    session.accountId,
    expected.binding.target
  );
  if (!projection || !inventoryOrganizationSameSession(projection.session, session)) return false;
  const actual = projection.snapshot.header,
    header = expected.snapshot.header;
  return (
    Math.min(
      projection.session.knownAccessTokenExpiresAt,
      expected.binding.knownAccessTokenExpiresAt,
      session.knownAccessTokenExpiresAt
    ) > now &&
    actual.revision === header.revision &&
    actual.stateSha256 === header.stateSha256 &&
    actual.accessGeneration === header.accessGeneration &&
    actual.permission === header.permission
  );
}

export function createOrganizationInventorySubmission(deps: SubmissionDependencies) {
  const previews = new Map<string, LivePreview>();
  const flights = new Set<string>();
  const scopeKey = (accountId: string, target: InventoryOrganizationTarget) =>
    JSON.stringify([accountId, target.orgId, target.inventoryId]);
  const current = (
    session: InventoryOrganizationSessionIdentity,
    target: InventoryOrganizationTarget,
    callerKey: object
  ) => {
    const state = deps.state(session.accountId, target, callerKey, session.desktopSessionId);
    if (state?.accessDenied && inventoryOrganizationSameSession(state.session, session))
      throw new DesktopSyncClientError('FORBIDDEN', 'Inventory access is unavailable.', {
        retryable: false,
        terminal: false,
      });
    return state;
  };
  const view = (
    callerKey: object,
    row: OrganizationInventoryStoredAttempt,
    session: InventoryOrganizationSessionIdentity,
    assertCurrent: () => void,
    reason: InventoryOrganizationUnavailable | null = null
  ): InventoryOrganizationActionAttemptRead => {
    deps.assertOwner(assertCurrent);
    const state = current(session, row.key.target, callerKey);
    const attempt = descriptor(row);
    if (row.disposition?.kind === 'action-refused')
      return { kind: 'refused', session, attempt, disposition: row.disposition };
    if (row.disposition?.kind === 'action-accepted') {
      const snapshot = state?.snapshot;
      const ready =
        snapshot?.kind === 'current' &&
        inventoryOrganizationSameSession(snapshot.binding, session) &&
        snapshot.binding.knownAccessTokenExpiresAt > deps.nowMs() &&
        organizationInventoryConfirmedFactsCurrent(deps.db, session, snapshot, deps.nowMs()) &&
        snapshot.snapshot.header.revision >= row.disposition.revision &&
        (snapshot.snapshot.header.revision !== row.disposition.revision ||
          snapshot.snapshot.header.stateSha256 === row.disposition.stateSha256);
      return {
        kind: 'accepted',
        session,
        attempt,
        disposition: row.disposition,
        delivery:
          ready && row.projectionConfirmedRevision !== null
            ? { kind: 'current', confirmedRevision: snapshot.snapshot.header.revision }
            : { kind: 'pending', failure: reason },
      };
    }
    return {
      kind: row.sendState === 'never-sent' ? 'never-sent' : 'sent-unknown',
      session,
      attempt,
      failure: reason,
    };
  };
  const live = (
    id: string,
    session: InventoryOrganizationSessionIdentity,
    target: InventoryOrganizationTarget,
    callerKey: object
  ): LivePreview | null => {
    const handle = previews.get(id);
    if (
      !handle ||
      handle.callerKey !== callerKey ||
      !same(handle.read.binding.target, target) ||
      !inventoryOrganizationSameSession(handle.read.binding, session)
    )
      return null;
    deps.assertOwner(handle.assertCurrent);
    const state = current(session, target, callerKey);
    const snapshot = state?.snapshot;
    if (
      deps.monotonicMs() >= handle.deadline ||
      handle.read.binding.knownAccessTokenExpiresAt <= deps.nowMs() ||
      state?.pending ||
      snapshot?.kind !== 'current' ||
      !inventoryOrganizationSameBinding(snapshot.binding, handle.read.binding) ||
      !organizationInventoryConfirmedFactsCurrent(deps.db, session, snapshot, deps.nowMs()) ||
      state?.preview?.kind !== 'ready' ||
      state.preview.previewHandleId !== id
    ) {
      previews.delete(id);
      return null;
    }
    return handle;
  };
  const deliver = async (
    callerKey: object,
    original: OrganizationInventoryStoredAttempt,
    session: InventoryOrganizationSessionIdentity,
    assertCurrent: () => void,
    reason: InventoryOrganizationUnavailable | null = null
  ): Promise<InventoryOrganizationActionAttemptRead> => {
    let row = original;
    if (row.disposition?.kind === 'action-accepted') {
      const snapshot = await deps.snapshot(
        {
          expectedAccountId: session.accountId,
          expectedDesktopSessionId: session.desktopSessionId,
          target: row.key.target,
        },
        assertCurrent,
        callerKey
      );
      session = await deps.identity(
        session.accountId,
        session.desktopSessionId,
        assertCurrent,
        false
      );
      if (snapshot.kind === 'current') {
        deps.assertOwner(assertCurrent);
        row = confirmOrganizationInventoryAttemptProjection(deps.db, row.key).attempt;
      } else {
        reason = snapshot.kind === 'unavailable' ? snapshot : snapshot.failure;
      }
    }
    return view(callerKey, row, session, assertCurrent, reason);
  };
  const send = async (
    callerKey: object,
    row: OrganizationInventoryStoredAttempt,
    session: InventoryOrganizationSessionIdentity,
    assertCurrent: () => void
  ): Promise<InventoryOrganizationActionAttemptRead> => {
    const generation = deps.state(
      session.accountId,
      row.key.target,
      callerKey,
      session.desktopSessionId
    )?.generation;
    let reason: InventoryOrganizationUnavailable | null = null;
    const publicationCurrent = deps.beginPublication(session, row.key.target);
    try {
      const response = await deps.client.applyAction({
        accountId: session.accountId,
        desktopSessionId: session.desktopSessionId,
        request: row.request,
      });
      deps.assertStorage();
      if (response.kind === 'decided')
        row = recordOrganizationInventoryAttemptDisposition(deps.db, row.key, response.disposition);
      else reason = response;
    } catch (error) {
      deps.assertStorage();
      reason = failure(error);
    }
    session = await deps.identity(
      session.accountId,
      session.desktopSessionId,
      assertCurrent,
      false
    );
    if (accessHidden(reason)) {
      deps.observeFailure(
        reason,
        session,
        row.key.target,
        generation,
        assertCurrent,
        callerKey,
        publicationCurrent
      );
      return reason;
    }
    row = readOrganizationInventoryAttempt(deps.db, row.key)!;
    if (!row) throw new TypeError('The retained inventory operation is missing.');
    return deliver(callerKey, row, session, assertCurrent, reason);
  };
  return {
    invalidatePreviews(
      accountId: string,
      target: InventoryOrganizationTarget,
      callerKey: object
    ): void {
      for (const [id, handle] of previews) {
        if (
          deps.monotonicMs() >= handle.deadline ||
          (handle.callerKey === callerKey &&
            handle.read.binding.accountId === accountId &&
            same(handle.read.binding.target, target))
        )
          previews.delete(id);
      }
    },
    issuePreview(
      request: InventoryOrganizationPreviewRequest,
      read: Extract<InventoryOrganizationPreviewRead, { kind: 'ready' }>,
      assertCurrent: () => void,
      callerKey: object,
      deadline: number
    ): void {
      deps.assertOwner(assertCurrent);
      previews.set(read.previewHandleId, { request, read, assertCurrent, callerKey, deadline });
    },
    async organizationCancelPreview(
      input: InventoryOrganizationCancelPreviewRequest,
      assertCurrent: () => void,
      callerKey: object
    ): Promise<InventoryOrganizationCancelPreviewRead> {
      const request = inventoryOrganizationCancelPreviewRequestSchema.parse(input);
      try {
        deps.assertOwner(assertCurrent);
        const handle = previews.get(request.previewHandleId);
        let cancelled = false;
        if (
          handle &&
          handle.callerKey === callerKey &&
          handle.read.binding.accountId === request.expectedAccountId &&
          handle.read.binding.desktopSessionId === request.expectedDesktopSessionId &&
          same(handle.read.binding.target, request.target)
        ) {
          deps.assertOwner(handle.assertCurrent);
          previews.delete(request.previewHandleId);
          cancelled = true;
        }
        const session = await deps.identity(
          request.expectedAccountId,
          request.expectedDesktopSessionId,
          assertCurrent,
          false
        );
        const row = readOrganizationInventoryAttemptForHandle(deps.db, {
          accountId: session.accountId,
          target: request.target,
          previewHandleId: request.previewHandleId,
        });
        if (row) return { kind: 'retained', session, attempt: descriptor(row) };
        return {
          kind: cancelled ? 'cancelled' : 'not-live',
          session,
          target: request.target,
          previewHandleId: request.previewHandleId,
        };
      } catch (error) {
        return failure(error);
      }
    },
    async organizationSubmit(
      input: InventoryOrganizationSubmitRequest,
      assertCurrent: () => void,
      callerKey: object
    ): Promise<InventoryOrganizationActionAttemptRead> {
      const request = inventoryOrganizationSubmitRequestSchema.parse(input);
      try {
        const session = await deps.identity(
          request.expectedAccountId,
          request.expectedDesktopSessionId,
          assertCurrent,
          true
        );
        const scope = { accountId: session.accountId, target: request.target };
        const retained = readOrganizationInventoryAttemptForHandle(deps.db, {
          ...scope,
          previewHandleId: request.previewHandleId,
        });
        if (retained) return view(callerKey, retained, session, assertCurrent);
        const handle = live(request.previewHandleId, session, request.target, callerKey);
        if (!handle)
          return unavailable(
            'PREVIEW_NOT_LIVE',
            'Preview this use again before submitting.',
            false
          );
        const blocking = readBlockingOrganizationInventoryAttempt(deps.db, scope);
        if (blocking)
          return view(
            callerKey,
            blocking,
            session,
            assertCurrent,
            unavailable(
              'PENDING_OPERATION',
              'Recover the retained operation before submitting another.'
            )
          );
        const flight = scopeKey(session.accountId, request.target);
        if (flights.has(flight))
          return unavailable(
            'OPERATION_IN_FLIGHT',
            'An inventory operation is already being confirmed.'
          );
        deps.assertOwner(assertCurrent);
        deps.assertOwner(handle.assertCurrent);
        const retainedAttempt = retainOrganizationInventoryAttempt(deps.db, {
          accountId: session.accountId,
          originalDesktopSessionId: session.desktopSessionId,
          previewHandleId: request.previewHandleId,
          at: deps.nowMs(),
          request: {
            schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
            purpose: 'action',
            body: {
              ...handle.request.request,
              operationId: (deps.createOperationId ?? randomUUID)(),
              clientId: deps.getDeviceId?.() ?? readOrCreateWorkspaceSyncDeviceId(deps.db),
              expectedPlanDigest: handle.read.preview.planDigest,
            },
          },
        });
        if (!live(request.previewHandleId, session, request.target, callerKey))
          return view(
            callerKey,
            retainedAttempt,
            session,
            assertCurrent,
            unavailable(
              'EXPLICIT_CONFIRMATION_REQUIRED',
              'The saved request was not sent before its preview expired. Review the retained request before confirming it.',
              false
            )
          );
        const row = markOrganizationInventoryAttemptMayHaveSent(
          deps.db,
          retainedAttempt.key
        ).attempt;
        previews.delete(request.previewHandleId);
        flights.add(flight);
        try {
          return await send(callerKey, row, session, assertCurrent);
        } finally {
          flights.delete(flight);
        }
      } catch (error) {
        return failure(error);
      }
    },
    async organizationAttempt(
      input: InventoryOrganizationAttemptRequest,
      assertCurrent: () => void,
      callerKey: object
    ): Promise<InventoryOrganizationAttemptRead> {
      const request = inventoryOrganizationAttemptRequestSchema.parse(input);
      try {
        const session = await deps.identity(
          request.expectedAccountId,
          request.expectedDesktopSessionId,
          assertCurrent,
          false
        );
        current(session, request.target, callerKey);
        const scope = { accountId: session.accountId, target: request.target };
        const row =
          request.query.kind === 'pending'
            ? readBlockingOrganizationInventoryAttempt(deps.db, scope)
            : readOrganizationInventoryAttempt(deps.db, {
                ...scope,
                operationId: request.query.operationId,
                requestSha256: request.query.requestSha256,
              });
        return row
          ? view(callerKey, row, session, assertCurrent)
          : { kind: 'none', session, target: request.target };
      } catch (error) {
        return failure(error);
      }
    },
    async organizationRecover(
      input: InventoryOrganizationRecoverRequest,
      assertCurrent: () => void,
      callerKey: object
    ): Promise<InventoryOrganizationActionAttemptRead> {
      const request = inventoryOrganizationRecoverRequestSchema.parse(input);
      try {
        let session = await deps.identity(
          request.expectedAccountId,
          request.expectedDesktopSessionId,
          assertCurrent,
          true
        );
        let row = readOrganizationInventoryAttempt(deps.db, {
          accountId: session.accountId,
          target: request.target,
          operationId: request.operationId,
          requestSha256: request.requestSha256,
        });
        if (!row)
          return unavailable(
            'LOCAL_ATTEMPT_NOT_FOUND',
            'This device has no retained request for that operation.',
            false
          );
        const flight = scopeKey(session.accountId, request.target);
        if (flights.has(flight))
          return view(
            callerKey,
            row,
            session,
            assertCurrent,
            unavailable(
              'OPERATION_IN_FLIGHT',
              'This retained operation is already being confirmed.'
            )
          );
        if (request.mode === 'retry-exact' && row.sendState === 'never-sent' && !row.disposition)
          return view(
            callerKey,
            row,
            session,
            assertCurrent,
            unavailable(
              'EXPLICIT_CONFIRMATION_REQUIRED',
              'Confirm the saved unsent request before sending it.',
              false
            )
          );
        if (request.mode === 'confirm-unsent' && row.sendState !== 'never-sent' && !row.disposition)
          return view(
            callerKey,
            row,
            session,
            assertCurrent,
            unavailable(
              'EXACT_RECOVERY_REQUIRED',
              'This operation may have reached the server. Inspect it or retry the exact request.',
              false
            )
          );
        flights.add(flight);
        try {
          if (request.mode === 'inspect') {
            const generation = deps.state(
              session.accountId,
              request.target,
              callerKey,
              session.desktopSessionId
            )?.generation;
            let reason: InventoryOrganizationUnavailable | null = null;
            const publicationCurrent = deps.beginPublication(session, request.target);
            try {
              const response = await deps.client.readOperation({
                accountId: session.accountId,
                desktopSessionId: session.desktopSessionId,
                request: {
                  target: request.target,
                  operationId: row.key.operationId,
                  requestSha256: row.requestSha256,
                },
              });
              deps.assertStorage();
              if (response.kind === 'known') {
                if (
                  response.disposition.kind !== 'action-accepted' &&
                  response.disposition.kind !== 'action-refused'
                )
                  throw new TypeError(
                    'An action operation cannot be replaced by another disposition family.'
                  );
                row = recordOrganizationInventoryAttemptDisposition(
                  deps.db,
                  row.key,
                  response.disposition
                );
              } else if (response.kind === 'unavailable') reason = response;
            } catch (error) {
              deps.assertStorage();
              reason = failure(error);
            }
            session = await deps.identity(
              session.accountId,
              session.desktopSessionId,
              assertCurrent,
              false
            );
            if (accessHidden(reason)) {
              deps.observeFailure(
                reason,
                session,
                request.target,
                generation,
                assertCurrent,
                callerKey,
                publicationCurrent
              );
              return reason;
            }
            return deliver(callerKey, row, session, assertCurrent, reason);
          }
          if (row.disposition) return deliver(callerKey, row, session, assertCurrent);
          deps.assertOwner(assertCurrent);
          const claimed = markOrganizationInventoryAttemptMayHaveSent(deps.db, row.key);
          row = claimed.attempt;
          if (claimed.kind === 'terminal') return deliver(callerKey, row, session, assertCurrent);
          if (request.mode === 'confirm-unsent' && claimed.kind !== 'claimed')
            return view(
              callerKey,
              row,
              session,
              assertCurrent,
              unavailable(
                'EXACT_RECOVERY_REQUIRED',
                'This operation may have reached the server. Inspect it or retry the exact request.',
                false
              )
            );
          return await send(callerKey, row, session, assertCurrent);
        } finally {
          flights.delete(flight);
        }
      } catch (error) {
        return failure(error);
      }
    },
    dispose(): void {
      previews.clear();
      flights.clear();
    },
  };
}
