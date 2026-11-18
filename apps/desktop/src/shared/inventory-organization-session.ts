import {
  ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
  assertOrganizationInventoryResponse,
  organizationInventoryCanonicalJson,
  type InventoryOrganizationTarget,
} from '@waypoint/domain-services';
import {
  inventoryOrganizationDirectoryRequestSchema,
  inventoryOrganizationSnapshotRequestSchema,
  inventoryOrganizationPreviewRequestSchema,
  inventoryOrganizationDirectoryReadSchema,
  inventoryOrganizationSnapshotReadSchema,
  inventoryOrganizationPreviewReadSchema,
  inventoryOrganizationSessionIdentitySchema,
  type InventoryOrganizationSessionIdentity,
  type InventoryOrganizationBinding,
  type InventoryOrganizationDirectoryRequest,
  type InventoryOrganizationSnapshotRequest,
  type InventoryOrganizationPreviewRequest,
  type InventoryOrganizationDirectoryRead,
  type InventoryOrganizationSnapshotRead,
  type InventoryOrganizationPreviewRead,
  type InventoryOrganizationUnavailable,
} from './inventory-organization-client';

export interface InventoryOrganizationClock {
  readonly wallTime: number;
  readonly monotonicTime: number;
}
type Directory = Extract<InventoryOrganizationDirectoryRead, { kind: 'ready' }>;
type Snapshot = Exclude<InventoryOrganizationSnapshotRead, { kind: 'unavailable' }>;
type Preview =
  | Exclude<InventoryOrganizationPreviewRead, { kind: 'unavailable' }>
  | { readonly kind: 'expired' };
interface TicketBase {
  readonly generation: number;
  readonly session: InventoryOrganizationSessionIdentity;
  readonly startedMonotonicAt: number;
}
export type InventoryOrganizationReadTicket = TicketBase &
  (
    | { readonly kind: 'directory'; readonly request: InventoryOrganizationDirectoryRequest }
    | { readonly kind: 'snapshot'; readonly request: InventoryOrganizationSnapshotRequest }
    | { readonly kind: 'preview'; readonly request: InventoryOrganizationPreviewRequest }
  );
export interface InventoryOrganizationSessionState {
  readonly generation: number;
  readonly session: InventoryOrganizationSessionIdentity | null;
  readonly target: InventoryOrganizationTarget | null;
  readonly directory: Directory | null;
  readonly snapshot: Snapshot | null;
  readonly preview: Preview | null;
  readonly previewExpiresAtMonotonic: number | null;
  readonly pending: InventoryOrganizationReadTicket | null;
  readonly failure: InventoryOrganizationUnavailable | null;
  readonly accessDenied: boolean;
}
export type InventoryOrganizationSessionView =
  | { readonly kind: 'hidden'; readonly reason: 'session' | 'target' | 'access-denied' }
  | {
      readonly kind: 'visible';
      readonly directory: Directory | null;
      readonly snapshot: Snapshot | null;
      readonly preview: Preview | null;
      readonly pending: InventoryOrganizationReadTicket['kind'] | null;
      readonly failure: InventoryOrganizationUnavailable | null;
      readonly canPreview: boolean;
    };
const equal = (a: unknown, b: unknown) =>
  organizationInventoryCanonicalJson(a) === organizationInventoryCanonicalJson(b);
export function inventoryOrganizationSameSession(
  a: InventoryOrganizationSessionIdentity | null,
  b: InventoryOrganizationSessionIdentity | null
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.accountId === b.accountId &&
    a.desktopSessionId === b.desktopSessionId
  );
}
export function inventoryOrganizationSameBinding(
  a: InventoryOrganizationBinding,
  b: InventoryOrganizationBinding
): boolean {
  return equal(a, b);
}
function clock(value: InventoryOrganizationClock): void {
  if (
    !Number.isSafeInteger(value.wallTime) ||
    value.wallTime < 0 ||
    !Number.isFinite(value.monotonicTime) ||
    value.monotonicTime < 0
  )
    throw new TypeError('A valid wall and monotonic clock is required.');
}
function live(session: InventoryOrganizationSessionIdentity | null, now: number): boolean {
  return session !== null && session.knownAccessTokenExpiresAt > now;
}
function generation(state: InventoryOrganizationSessionState): number {
  if (state.generation === Number.MAX_SAFE_INTEGER)
    throw new TypeError('Organization read generation exhausted.');
  return state.generation + 1;
}
export function createInventoryOrganizationSession(): InventoryOrganizationSessionState {
  return {
    generation: 0,
    session: null,
    target: null,
    directory: null,
    snapshot: null,
    preview: null,
    previewExpiresAtMonotonic: null,
    pending: null,
    failure: null,
    accessDenied: false,
  };
}
export function selectInventoryOrganizationSession(
  state: InventoryOrganizationSessionState,
  session: InventoryOrganizationSessionIdentity | null,
  target: InventoryOrganizationTarget | null
): InventoryOrganizationSessionState {
  if (session) inventoryOrganizationSessionIdentitySchema.parse(session);
  if (inventoryOrganizationSameSession(state.session, session) && equal(state.target, target))
    return { ...state, session };
  const directory =
    inventoryOrganizationSameSession(state.session, session) &&
    (!target || state.directory?.directory.orgId === target.orgId)
      ? state.directory
      : null;
  return {
    ...createInventoryOrganizationSession(),
    generation: generation(state),
    session,
    target,
    directory,
  };
}
export function invalidateInventoryOrganizationSession(
  state: InventoryOrganizationSessionState,
  reason: 'edit' | 'close-preview' | 'access-denied' | 'binding-change'
): InventoryOrganizationSessionState {
  return {
    ...state,
    generation: generation(state),
    pending: null,
    preview: null,
    previewExpiresAtMonotonic: null,
    ...(reason === 'access-denied' || reason === 'binding-change'
      ? { snapshot: null, directory: null, accessDenied: reason === 'access-denied' }
      : {}),
  };
}
function start(
  state: InventoryOrganizationSessionState,
  ticket: Omit<TicketBase, 'generation' | 'session'> &
    (
      | { kind: 'directory'; request: InventoryOrganizationDirectoryRequest }
      | { kind: 'snapshot'; request: InventoryOrganizationSnapshotRequest }
      | { kind: 'preview'; request: InventoryOrganizationPreviewRequest }
    ),
  now: InventoryOrganizationClock
) {
  clock(now);
  if (!live(state.session, now.wallTime) || !state.session)
    throw new TypeError('A current Native account/session is required.');
  const next = {
    ...ticket,
    generation: generation(state),
    session: state.session,
  } as InventoryOrganizationReadTicket;
  return {
    state: {
      ...state,
      generation: next.generation,
      pending: next,
      preview: null,
      previewExpiresAtMonotonic: null,
      failure: null,
      accessDenied: false,
    },
    ticket: next,
  };
}
function requestSession(
  state: InventoryOrganizationSessionState,
  request: { expectedAccountId: string; expectedDesktopSessionId: string }
): void {
  if (
    !state.session ||
    state.session.accountId !== request.expectedAccountId ||
    state.session.desktopSessionId !== request.expectedDesktopSessionId
  )
    throw new TypeError('Read request does not match the selected Native session.');
}
export function beginInventoryOrganizationDirectory(
  state: InventoryOrganizationSessionState,
  input: InventoryOrganizationDirectoryRequest,
  now: InventoryOrganizationClock
) {
  const request = inventoryOrganizationDirectoryRequestSchema.parse(input);
  requestSession(state, request);
  return start(state, { kind: 'directory', request, startedMonotonicAt: now.monotonicTime }, now);
}
export function beginInventoryOrganizationSnapshot(
  state: InventoryOrganizationSessionState,
  input: InventoryOrganizationSnapshotRequest,
  now: InventoryOrganizationClock
) {
  const request = inventoryOrganizationSnapshotRequestSchema.parse(input);
  requestSession(state, request);
  if (!equal(state.target, request.target))
    throw new TypeError('Snapshot request does not match the selected target.');
  return start(state, { kind: 'snapshot', request, startedMonotonicAt: now.monotonicTime }, now);
}
export function beginInventoryOrganizationPreview(
  state: InventoryOrganizationSessionState,
  input: InventoryOrganizationPreviewRequest,
  now: InventoryOrganizationClock
) {
  const request = inventoryOrganizationPreviewRequestSchema.parse(input),
    snapshot = state.snapshot;
  if (
    state.accessDenied ||
    !snapshot ||
    snapshot.kind !== 'current' ||
    !equal(state.target, request.binding.target) ||
    !inventoryOrganizationSameBinding(snapshot.binding, request.binding) ||
    snapshot.snapshot.header.permission === 'read' ||
    !live(snapshot.binding, now.wallTime)
  )
    throw new TypeError('Preview requires the current issued online inventory binding.');
  if (request.request.expectedRevision !== snapshot.snapshot.header.revision)
    throw new TypeError('Preview must use the displayed confirmed base revision.');
  return start(state, { kind: 'preview', request, startedMonotonicAt: now.monotonicTime }, now);
}
function matches(
  state: InventoryOrganizationSessionState,
  ticket: InventoryOrganizationReadTicket,
  kind: InventoryOrganizationReadTicket['kind'],
  active: InventoryOrganizationSessionIdentity | null,
  now: InventoryOrganizationClock
): boolean {
  clock(now);
  return (
    ticket.kind === kind &&
    ticket.generation === state.generation &&
    equal(ticket, state.pending) &&
    inventoryOrganizationSameSession(state.session, active) &&
    inventoryOrganizationSameSession(ticket.session, active) &&
    live(active, now.wallTime)
  );
}
function failure(
  state: InventoryOrganizationSessionState,
  value: InventoryOrganizationUnavailable
): InventoryOrganizationSessionState {
  return {
    ...state,
    pending: null,
    snapshot: null,
    directory: null,
    preview: null,
    previewExpiresAtMonotonic: null,
    failure: value,
  };
}
function sessionLive(
  binding: InventoryOrganizationSessionIdentity,
  active: InventoryOrganizationSessionIdentity | null,
  now: number
): boolean {
  return (
    inventoryOrganizationSameSession(binding, active) &&
    live(binding, now) &&
    live(active, now) &&
    active !== null &&
    binding.knownAccessTokenExpiresAt <= active.knownAccessTokenExpiresAt
  );
}
export function publishInventoryOrganizationDirectory(
  state: InventoryOrganizationSessionState,
  ticket: InventoryOrganizationReadTicket,
  value: unknown,
  active: InventoryOrganizationSessionIdentity | null,
  now: InventoryOrganizationClock
): InventoryOrganizationSessionState {
  if (!matches(state, ticket, 'directory', active, now) || ticket.kind !== 'directory')
    return state;
  const read = inventoryOrganizationDirectoryReadSchema.parse(value);
  if (read.kind === 'unavailable') return failure(state, read);
  if (
    !inventoryOrganizationSameSession(read.session, active) ||
    !sessionLive(read.session, active, now.wallTime) ||
    read.directory.orgId !== ticket.request.orgId
  )
    throw new TypeError('Directory publication scope changed.');
  return {
    ...state,
    session: active,
    pending: null,
    directory: read,
    failure: null,
    accessDenied: false,
  };
}
export function publishInventoryOrganizationSnapshot(
  state: InventoryOrganizationSessionState,
  ticket: InventoryOrganizationReadTicket,
  value: unknown,
  active: InventoryOrganizationSessionIdentity | null,
  now: InventoryOrganizationClock
): InventoryOrganizationSessionState {
  if (!matches(state, ticket, 'snapshot', active, now) || ticket.kind !== 'snapshot') return state;
  const read = inventoryOrganizationSnapshotReadSchema.parse(value);
  if (read.kind === 'unavailable') return failure(state, read);
  if (
    !equal(read.binding.target, ticket.request.target) ||
    !equal(state.target, read.binding.target) ||
    !sessionLive(read.binding, active, now.wallTime)
  )
    throw new TypeError('Snapshot publication scope or known token bound changed.');
  return {
    ...state,
    session: active,
    pending: null,
    snapshot: read,
    preview: null,
    previewExpiresAtMonotonic: null,
    failure: read.kind === 'cached-offline' ? read.failure : null,
    accessDenied: false,
  };
}
export function publishInventoryOrganizationPreview(
  state: InventoryOrganizationSessionState,
  ticket: InventoryOrganizationReadTicket,
  value: unknown,
  active: InventoryOrganizationSessionIdentity | null,
  now: InventoryOrganizationClock
): InventoryOrganizationSessionState {
  if (!matches(state, ticket, 'preview', active, now) || ticket.kind !== 'preview') return state;
  const read = inventoryOrganizationPreviewReadSchema.parse(value);
  if (read.kind === 'unavailable') return failure(state, read);
  if (
    !inventoryOrganizationSameBinding(read.binding, ticket.request.binding) ||
    !sessionLive(read.binding, active, now.wallTime) ||
    !state.snapshot ||
    state.snapshot.kind !== 'current' ||
    !inventoryOrganizationSameBinding(state.snapshot.binding, read.binding)
  )
    throw new TypeError('Preview publication binding changed.');
  const envelope = {
    schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA as typeof ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
    purpose: 'preview' as const,
    body: ticket.request.request,
  };
  assertOrganizationInventoryResponse(envelope, {
    schema: 'dnaforge.organization-inventory-response.v1',
    purpose: 'preview',
    result: read.preview,
  });
  if (
    read.preview.header.revision !== state.snapshot.snapshot.header.revision ||
    read.preview.header.stateSha256 !== state.snapshot.snapshot.header.stateSha256
  )
    return {
      ...state,
      pending: null,
      snapshot: null,
      preview: read.kind === 'blocked' ? read : null,
      previewExpiresAtMonotonic: null,
      failure: {
        kind: 'unavailable',
        code: 'SNAPSHOT_CHANGED',
        message: 'Refresh the inventory before previewing another action.',
        retryable: true,
      },
    };
  if (read.kind === 'blocked')
    return { ...state, pending: null, preview: read, previewExpiresAtMonotonic: null };
  const deadline =
    ticket.startedMonotonicAt + (read.preview.readyUntilExclusive - read.preview.evaluatedAt);
  const expired = now.monotonicTime < ticket.startedMonotonicAt || now.monotonicTime >= deadline;
  return {
    ...state,
    pending: null,
    preview: expired ? { kind: 'expired' } : read,
    previewExpiresAtMonotonic: deadline,
  };
}
export function inventoryOrganizationSessionView(
  state: InventoryOrganizationSessionState,
  active: InventoryOrganizationSessionIdentity | null,
  target: InventoryOrganizationTarget | null,
  now: InventoryOrganizationClock
): InventoryOrganizationSessionView {
  clock(now);
  if (!inventoryOrganizationSameSession(state.session, active) || !live(active, now.wallTime))
    return { kind: 'hidden', reason: 'session' };
  if (!equal(state.target, target)) return { kind: 'hidden', reason: 'target' };
  if (state.accessDenied) return { kind: 'hidden', reason: 'access-denied' };
  const directory =
    state.directory &&
    inventoryOrganizationSameSession(state.directory.session, active) &&
    live(state.directory.session, now.wallTime)
      ? state.directory
      : null;
  const snapshot =
    state.snapshot &&
    equal(state.snapshot.binding.target, target) &&
    sessionLive(state.snapshot.binding, active, now.wallTime)
      ? state.snapshot
      : null;
  const preview =
    state.preview?.kind === 'blocked' &&
    equal(state.preview.binding.target, target) &&
    sessionLive(state.preview.binding, active, now.wallTime)
      ? state.preview
      : state.preview && snapshot
        ? state.preview.kind === 'ready' &&
          (state.previewExpiresAtMonotonic === null ||
            now.monotonicTime >= state.previewExpiresAtMonotonic)
          ? { kind: 'expired' as const }
          : state.preview
        : null;
  return {
    kind: 'visible',
    directory,
    snapshot,
    preview,
    pending: state.pending?.kind ?? null,
    failure: state.failure,
    canPreview:
      snapshot?.kind === 'current' &&
      snapshot.snapshot.header.permission !== 'read' &&
      !state.pending,
  };
}
