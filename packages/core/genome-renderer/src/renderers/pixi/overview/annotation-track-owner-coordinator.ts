export const ANNOTATION_TRACK_RESIDENT_OWNER_V1 = 'annotation-track-resident-owner.v1' as const;
export const ANNOTATION_TRACK_PREPARED_OWNER_RECEIPT_V1 =
  'annotation-track-prepared-owner-receipt.v1' as const;
export const ANNOTATION_TRACK_LAYOUT_SNAPSHOT_V1 = 'annotation-track-layout-snapshot.v1' as const;
export const ANNOTATION_TRACK_PRESENTATION_SNAPSHOT_V1 =
  'annotation-track-presentation-snapshot.v1' as const;

export interface AnnotationTrackRuntimePolicyV1 {
  readonly visible: boolean;
  readonly isoformMode: 'canonical' | 'expanded';
  readonly laneLimit: number | null;
}

export interface AnnotationTrackOrdinaryPresentationOwnerV1 {
  readonly ownerId: string;
  readonly ownerKind: 'broad' | 'detail';
}

export interface ResidentAnnotationTrackOwnerV1 {
  readonly contract: typeof ANNOTATION_TRACK_RESIDENT_OWNER_V1;
  readonly trackId: string;
  readonly artifactKey: string;
  readonly artifactFingerprint: string;
  readonly policy: AnnotationTrackRuntimePolicyV1;
  readonly broadOwnerId: string;
  readonly detailOwnerId: string;
  readonly interactionOwnerId: string;
  readonly ordinaryPresentationOwners: readonly AnnotationTrackOrdinaryPresentationOwnerV1[];
}

export interface AnnotationTrackOwnerRequestV1 {
  readonly trackId: string;
  readonly generation: number;
  readonly requestFingerprint: string;
  readonly artifactKey: string;
  readonly artifactFingerprint: string;
  readonly policy: AnnotationTrackRuntimePolicyV1;
}

export interface PreparedAnnotationTrackOwnerReceiptV1 {
  readonly contract: typeof ANNOTATION_TRACK_PREPARED_OWNER_RECEIPT_V1;
  readonly trackId: string;
  readonly generation: number;
  readonly requestFingerprint: string;
  readonly artifactKey: string;
  readonly artifactFingerprint: string;
  readonly policy: AnnotationTrackRuntimePolicyV1;
  readonly owner: ResidentAnnotationTrackOwnerV1;
}

export interface AnnotationTrackLayoutSnapshotV1 {
  readonly contract: typeof ANNOTATION_TRACK_LAYOUT_SNAPSHOT_V1;
  readonly layoutFingerprint: string;
  readonly orderedVisibleTrackIds: readonly string[];
}

export interface AnnotationTrackPresentationSnapshotV1 {
  readonly contract: typeof ANNOTATION_TRACK_PRESENTATION_SNAPSHOT_V1;
  readonly commitEpoch: number;
  readonly layout: AnnotationTrackLayoutSnapshotV1;
  readonly orderedVisibleOwners: readonly ResidentAnnotationTrackOwnerV1[];
}

interface PendingStateV1 {
  readonly trackId: string;
  readonly request: AnnotationTrackOwnerRequestV1;
  readonly lastGoodOwner: ResidentAnnotationTrackOwnerV1 | null;
}

export type AnnotationTrackOwnerStateV1 =
  | Readonly<{ kind: 'absent'; trackId: string }>
  | (Readonly<{ kind: 'requested' }> & PendingStateV1)
  | (Readonly<{ kind: 'preparing' }> & PendingStateV1)
  | (Readonly<{
      kind: 'prepared';
      receipt: PreparedAnnotationTrackOwnerReceiptV1;
    }> &
      PendingStateV1)
  | (Readonly<{
      kind: 'failed';
      failureKind: 'failed' | 'timeout';
      failureMessage: string;
    }> &
      PendingStateV1)
  | Readonly<{
      kind: 'committed';
      trackId: string;
      request: AnnotationTrackOwnerRequestV1;
      owner: ResidentAnnotationTrackOwnerV1;
    }>;

type RejectedTransitionResult = Readonly<{
  status: 'rejected';
  reason: string;
  trackId?: string;
}>;

type TransitionResult = Readonly<{ status: 'accepted' }> | RejectedTransitionResult;

export function createResidentAnnotationTrackOwnerV1(input: {
  trackId: string;
  artifactKey: string;
  artifactFingerprint: string;
  policy: AnnotationTrackRuntimePolicyV1;
  broadOwnerId: string;
  detailOwnerId: string;
  interactionOwnerId: string;
  ordinaryPresentationOwners: readonly AnnotationTrackOrdinaryPresentationOwnerV1[];
}): ResidentAnnotationTrackOwnerV1 {
  const owner = {
    contract: ANNOTATION_TRACK_RESIDENT_OWNER_V1,
    trackId: token(input.trackId, 'trackId'),
    artifactKey: token(input.artifactKey, 'artifactKey'),
    artifactFingerprint: sha256(input.artifactFingerprint, 'artifactFingerprint'),
    policy: policy(input.policy),
    broadOwnerId: token(input.broadOwnerId, 'broadOwnerId'),
    detailOwnerId: token(input.detailOwnerId, 'detailOwnerId'),
    interactionOwnerId: token(input.interactionOwnerId, 'interactionOwnerId'),
    ordinaryPresentationOwners: Object.freeze(
      input.ordinaryPresentationOwners.map((entry) =>
        Object.freeze({
          ownerId: token(entry.ownerId, 'ordinary ownerId'),
          ownerKind: ownerKind(entry.ownerKind),
        })
      )
    ),
  } satisfies ResidentAnnotationTrackOwnerV1;
  const failure = residentOwnerFailure(owner);
  if (failure) throw new Error(failure);
  return Object.freeze(owner);
}

export function createPreparedAnnotationTrackOwnerReceiptV1(input: {
  trackId: string;
  generation: number;
  requestFingerprint: string;
  artifactKey: string;
  artifactFingerprint: string;
  policy: AnnotationTrackRuntimePolicyV1;
  owner: ResidentAnnotationTrackOwnerV1;
}): PreparedAnnotationTrackOwnerReceiptV1 {
  const owner = createResidentAnnotationTrackOwnerV1({
    trackId: input.owner.trackId,
    artifactKey: input.owner.artifactKey,
    artifactFingerprint: input.owner.artifactFingerprint,
    policy: input.owner.policy,
    broadOwnerId: input.owner.broadOwnerId,
    detailOwnerId: input.owner.detailOwnerId,
    interactionOwnerId: input.owner.interactionOwnerId,
    ordinaryPresentationOwners: input.owner.ordinaryPresentationOwners,
  });
  const receipt = {
    contract: ANNOTATION_TRACK_PREPARED_OWNER_RECEIPT_V1,
    trackId: token(input.trackId, 'trackId'),
    generation: positiveSafeInteger(input.generation, 'generation'),
    requestFingerprint: token(input.requestFingerprint, 'requestFingerprint'),
    artifactKey: token(input.artifactKey, 'artifactKey'),
    artifactFingerprint: sha256(input.artifactFingerprint, 'artifactFingerprint'),
    policy: policy(input.policy),
    owner,
  } satisfies PreparedAnnotationTrackOwnerReceiptV1;
  const failure = preparedReceiptFailure(receipt);
  if (failure) throw new Error(failure);
  return Object.freeze(receipt);
}

export function createAnnotationTrackLayoutSnapshotV1(input: {
  layoutFingerprint: string;
  orderedVisibleTrackIds: readonly string[];
}): AnnotationTrackLayoutSnapshotV1 {
  const layoutFingerprint = token(input.layoutFingerprint, 'layoutFingerprint');
  if (!Array.isArray(input.orderedVisibleTrackIds)) {
    throw new Error('annotation track owner orderedVisibleTrackIds is required');
  }
  const seen = new Set<string>();
  const orderedVisibleTrackIds = Object.freeze(
    input.orderedVisibleTrackIds.map((value) => {
      const trackId = token(value, 'ordered visible trackId');
      if (seen.has(trackId)) {
        throw new Error(`annotation track owner ordered visible track is duplicated: ${trackId}`);
      }
      seen.add(trackId);
      return trackId;
    })
  );
  return Object.freeze({
    contract: ANNOTATION_TRACK_LAYOUT_SNAPSHOT_V1,
    layoutFingerprint,
    orderedVisibleTrackIds,
  });
}

export class AnnotationTrackOwnerCoordinatorV1 {
  readonly #states = new Map<string, AnnotationTrackOwnerStateV1>();
  readonly #generationByTrack = new Map<string, number>();
  #commitEpoch = 0;
  #presentationSnapshot: AnnotationTrackPresentationSnapshotV1 | null = null;

  request(input: {
    trackId: string;
    artifactKey: string;
    artifactFingerprint: string;
    policy: AnnotationTrackRuntimePolicyV1;
  }): AnnotationTrackOwnerRequestV1 {
    const trackId = token(input.trackId, 'trackId');
    const generation = (this.#generationByTrack.get(trackId) ?? 0) + 1;
    this.#generationByTrack.set(trackId, generation);
    const artifactKey = token(input.artifactKey, 'artifactKey');
    const artifactFingerprint = sha256(input.artifactFingerprint, 'artifactFingerprint');
    const runtimePolicy = policy(input.policy);
    const request: AnnotationTrackOwnerRequestV1 = Object.freeze({
      trackId,
      generation,
      artifactKey,
      artifactFingerprint,
      policy: runtimePolicy,
      requestFingerprint: requestFingerprint({
        trackId,
        generation,
        artifactKey,
        artifactFingerprint,
        policy: runtimePolicy,
      }),
    });
    const lastGoodOwner = this.residentOwnerFor(trackId);
    this.#states.set(
      trackId,
      Object.freeze({ kind: 'requested', trackId, request, lastGoodOwner })
    );
    return request;
  }

  beginPreparation(request: AnnotationTrackOwnerRequestV1): TransitionResult {
    const current = this.#states.get(request.trackId);
    if (current?.kind !== 'requested' || !sameRequest(current.request, request)) {
      return rejected('request-state-mismatch', request.trackId);
    }
    this.#states.set(
      request.trackId,
      Object.freeze({
        kind: 'preparing',
        trackId: request.trackId,
        request: current.request,
        lastGoodOwner: current.lastGoodOwner,
      })
    );
    return ACCEPTED;
  }

  failPreparation(
    request: AnnotationTrackOwnerRequestV1,
    failureKind: 'failed' | 'timeout',
    failureMessage: string
  ): TransitionResult {
    const current = this.#states.get(request.trackId);
    if (
      (current?.kind !== 'preparing' && current?.kind !== 'prepared') ||
      !sameRequest(current.request, request)
    ) {
      return rejected('preparation-failure-state-mismatch', request.trackId);
    }
    this.#states.set(
      request.trackId,
      Object.freeze({
        kind: 'failed',
        trackId: request.trackId,
        request: current.request,
        lastGoodOwner: current.lastGoodOwner,
        failureKind,
        failureMessage: token(failureMessage, 'preparation failureMessage'),
      })
    );
    return ACCEPTED;
  }

  acceptPrepared(value: unknown): TransitionResult {
    const receipt = value as Partial<PreparedAnnotationTrackOwnerReceiptV1>;
    const trackId = typeof receipt?.trackId === 'string' ? receipt.trackId : '';
    const current = this.#states.get(trackId);
    if (!current || !('request' in current)) return rejected('track-not-requested', trackId);
    if (
      Number.isSafeInteger(receipt.generation) &&
      (receipt.generation as number) < current.request.generation
    ) {
      return rejected('stale-generation', trackId);
    }
    if (current.kind !== 'preparing') return rejected('track-not-preparing', trackId);
    if (receipt.generation !== current.request.generation) {
      return rejected('generation-mismatch', trackId);
    }
    if (receipt.requestFingerprint !== current.request.requestFingerprint) {
      return rejected('request-fingerprint-mismatch', trackId);
    }
    if (
      receipt.artifactKey !== current.request.artifactKey ||
      receipt.artifactFingerprint !== current.request.artifactFingerprint
    ) {
      return rejected('artifact-fingerprint-mismatch', trackId);
    }
    if (!samePolicy(receipt.policy, current.request.policy)) {
      return rejected('policy-mismatch', trackId);
    }
    const cardinality = receipt.owner?.ordinaryPresentationOwners?.length;
    if (cardinality !== 1) {
      return rejected('ordinary-owner-cardinality-invalid', trackId);
    }
    const failure = preparedReceiptFailure(receipt);
    if (failure) return rejected('owner-receipt-invalid', trackId);
    let immutableReceipt: PreparedAnnotationTrackOwnerReceiptV1;
    try {
      immutableReceipt = createPreparedAnnotationTrackOwnerReceiptV1(
        receipt as PreparedAnnotationTrackOwnerReceiptV1
      );
    } catch {
      return rejected('owner-receipt-invalid', trackId);
    }
    this.#states.set(
      trackId,
      Object.freeze({
        kind: 'prepared',
        trackId,
        request: current.request,
        lastGoodOwner: current.lastGoodOwner,
        receipt: immutableReceipt,
      })
    );
    return ACCEPTED;
  }

  commitPreparedSet(input: {
    requests: readonly AnnotationTrackOwnerRequestV1[];
    layout: AnnotationTrackLayoutSnapshotV1;
  }):
    | Readonly<{
        status: 'committed';
        trackIds: readonly string[];
        commitEpoch: number;
      }>
    | RejectedTransitionResult {
    const requests = input?.requests;
    if (!Array.isArray(requests) || requests.length === 0) {
      return rejected('prepared-set-empty');
    }
    let layout: AnnotationTrackLayoutSnapshotV1;
    try {
      if (input.layout?.contract !== ANNOTATION_TRACK_LAYOUT_SNAPSHOT_V1) {
        return rejected('layout-snapshot-invalid');
      }
      layout = createAnnotationTrackLayoutSnapshotV1(input.layout);
    } catch {
      return rejected('layout-snapshot-invalid');
    }
    const prepared: Array<Extract<AnnotationTrackOwnerStateV1, { kind: 'prepared' }>> = [];
    const seen = new Set<string>();
    for (const request of requests) {
      if (seen.has(request.trackId)) return rejected('prepared-track-duplicate', request.trackId);
      seen.add(request.trackId);
      const current = this.#states.get(request.trackId);
      if (current?.kind !== 'prepared' || !sameRequest(current.request, request)) {
        return rejected('prepared-request-mismatch', request.trackId);
      }
      prepared.push(current);
    }
    const candidateOwners = new Map<string, ResidentAnnotationTrackOwnerV1>();
    for (const trackId of this.#states.keys()) {
      const owner = this.residentOwnerFor(trackId);
      if (owner) candidateOwners.set(trackId, owner);
    }
    for (const current of prepared) {
      candidateOwners.set(current.trackId, current.receipt.owner);
    }
    const candidateVisibleTrackIds = [...candidateOwners.values()]
      .filter((owner) => owner.policy.visible)
      .map((owner) => owner.trackId);
    if (!sameSetAndCardinality(layout.orderedVisibleTrackIds, candidateVisibleTrackIds)) {
      return rejected('layout-visible-owner-set-mismatch');
    }
    const orderedVisibleOwners = Object.freeze(
      layout.orderedVisibleTrackIds.map((trackId) => {
        const owner = candidateOwners.get(trackId);
        if (!owner?.policy.visible) {
          throw new Error('validated visible owner disappeared');
        }
        return owner;
      })
    );
    const commitEpoch = this.#commitEpoch + 1;
    const presentationSnapshot: AnnotationTrackPresentationSnapshotV1 = Object.freeze({
      contract: ANNOTATION_TRACK_PRESENTATION_SNAPSHOT_V1,
      commitEpoch,
      layout,
      orderedVisibleOwners,
    });
    for (const current of prepared) {
      this.#states.set(
        current.trackId,
        Object.freeze({
          kind: 'committed',
          trackId: current.trackId,
          request: current.request,
          owner: current.receipt.owner,
        })
      );
    }
    this.#commitEpoch = commitEpoch;
    this.#presentationSnapshot = presentationSnapshot;
    return Object.freeze({
      status: 'committed',
      trackIds: Object.freeze(prepared.map((state) => state.trackId)),
      commitEpoch,
    });
  }

  stateFor(trackId: string): AnnotationTrackOwnerStateV1 {
    return (
      this.#states.get(trackId) ??
      Object.freeze({ kind: 'absent', trackId: token(trackId, 'trackId') })
    );
  }

  presentingOwnerFor(trackId: string): ResidentAnnotationTrackOwnerV1 | null {
    const owner = this.residentOwnerFor(trackId);
    return owner?.policy.visible ? owner : null;
  }

  residentOwnerFor(trackId: string): ResidentAnnotationTrackOwnerV1 | null {
    const current = this.#states.get(trackId);
    if (!current || current.kind === 'absent') return null;
    if (current.kind === 'committed') return current.owner;
    return current.lastGoodOwner;
  }

  presentationSnapshot(): AnnotationTrackPresentationSnapshotV1 | null {
    return this.#presentationSnapshot;
  }
}

const ACCEPTED = Object.freeze({ status: 'accepted' as const });

function rejected(reason: string, trackId?: string): RejectedTransitionResult {
  return Object.freeze(
    trackId ? { status: 'rejected', reason, trackId } : { status: 'rejected', reason }
  );
}

function preparedReceiptFailure(
  value: Partial<PreparedAnnotationTrackOwnerReceiptV1>
): string | null {
  if (value?.contract !== ANNOTATION_TRACK_PREPARED_OWNER_RECEIPT_V1) {
    return 'prepared-owner-contract-invalid';
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) {
    return 'prepared-owner-generation-invalid';
  }
  if (
    !validToken(value.trackId) ||
    !validToken(value.requestFingerprint) ||
    !validToken(value.artifactKey) ||
    !validSha256(value.artifactFingerprint) ||
    !validPolicy(value.policy)
  ) {
    return 'prepared-owner-envelope-invalid';
  }
  const ownerFailure = residentOwnerFailure(value.owner);
  if (ownerFailure) return ownerFailure;
  if (
    value.owner?.trackId !== value.trackId ||
    value.owner?.artifactKey !== value.artifactKey ||
    value.owner?.artifactFingerprint !== value.artifactFingerprint ||
    !samePolicy(value.owner?.policy, value.policy)
  ) {
    return 'prepared-owner-binding-invalid';
  }
  return null;
}

function residentOwnerFailure(
  value: Partial<ResidentAnnotationTrackOwnerV1> | undefined
): string | null {
  if (value?.contract !== ANNOTATION_TRACK_RESIDENT_OWNER_V1) {
    return 'resident-owner-contract-invalid';
  }
  if (
    !validToken(value.trackId) ||
    !validToken(value.artifactKey) ||
    !validSha256(value.artifactFingerprint) ||
    !validPolicy(value.policy) ||
    !validToken(value.broadOwnerId) ||
    !validToken(value.detailOwnerId) ||
    !validToken(value.interactionOwnerId)
  ) {
    return 'resident-owner-envelope-invalid';
  }
  if (value.ordinaryPresentationOwners?.length !== 1) {
    return 'ordinary-owner-cardinality-invalid';
  }
  const ordinary = value.ordinaryPresentationOwners[0];
  const expectedOwnerId =
    ordinary?.ownerKind === 'broad' ? value.broadOwnerId : value.detailOwnerId;
  if (
    !ordinary ||
    !validToken(ordinary.ownerId) ||
    (ordinary.ownerKind !== 'broad' && ordinary.ownerKind !== 'detail') ||
    ordinary.ownerId !== expectedOwnerId
  ) {
    return 'ordinary-owner-binding-invalid';
  }
  return null;
}

function requestFingerprint(input: {
  trackId: string;
  generation: number;
  artifactKey: string;
  artifactFingerprint: string;
  policy: AnnotationTrackRuntimePolicyV1;
}): string {
  return `annotation-track-owner-request.v1:${frame([
    input.trackId,
    String(input.generation),
    input.artifactKey,
    input.artifactFingerprint,
    input.policy.visible ? 'visible' : 'hidden',
    input.policy.isoformMode,
    input.policy.laneLimit === null ? 'uncapped' : String(input.policy.laneLimit),
  ])}`;
}

function sameRequest(
  left: AnnotationTrackOwnerRequestV1,
  right: AnnotationTrackOwnerRequestV1
): boolean {
  return (
    left.trackId === right.trackId &&
    left.generation === right.generation &&
    left.requestFingerprint === right.requestFingerprint &&
    left.artifactKey === right.artifactKey &&
    left.artifactFingerprint === right.artifactFingerprint &&
    samePolicy(left.policy, right.policy)
  );
}

function policy(value: AnnotationTrackRuntimePolicyV1): AnnotationTrackRuntimePolicyV1 {
  if (
    typeof value?.visible !== 'boolean' ||
    (value.isoformMode !== 'canonical' && value.isoformMode !== 'expanded') ||
    (value.laneLimit !== null && (!Number.isSafeInteger(value.laneLimit) || value.laneLimit <= 0))
  ) {
    throw new Error('annotation track runtime policy is invalid');
  }
  return Object.freeze({
    visible: value.visible,
    isoformMode: value.isoformMode,
    laneLimit: value.laneLimit,
  });
}

function samePolicy(
  left: Partial<AnnotationTrackRuntimePolicyV1> | undefined,
  right: AnnotationTrackRuntimePolicyV1
): boolean {
  return (
    left?.visible === right.visible &&
    left?.isoformMode === right.isoformMode &&
    left?.laneLimit === right.laneLimit
  );
}

function sameSetAndCardinality(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((value) => rightSet.has(value));
}

function validPolicy(
  value: Partial<AnnotationTrackRuntimePolicyV1> | undefined
): value is AnnotationTrackRuntimePolicyV1 {
  return (
    typeof value?.visible === 'boolean' &&
    (value.isoformMode === 'canonical' || value.isoformMode === 'expanded') &&
    (value.laneLimit === null ||
      (Number.isSafeInteger(value.laneLimit) && (value.laneLimit as number) > 0))
  );
}

function ownerKind(value: unknown): 'broad' | 'detail' {
  if (value !== 'broad' && value !== 'detail') {
    throw new Error('ordinary owner kind is invalid');
  }
  return value;
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`annotation track owner ${label} is required`);
  }
  return value.trim();
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validSha256(value: unknown): value is string {
  return validToken(value) && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: unknown, label: string): string {
  const normalized = token(value, label);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`annotation track owner ${label} must be a lowercase SHA-256`);
  }
  return normalized;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`annotation track owner ${label} must be a positive safe integer`);
  }
  return value as number;
}

function frame(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
