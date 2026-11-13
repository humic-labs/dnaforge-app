export const ANNOTATION_BODY_PRESENTATION_AUTHORITY_V1 =
  'annotation-body-presentation-authority.v1' as const;

export const ANNOTATION_BODY_PRESENTER_PRIORITY = Object.freeze([
  'compiled-broad',
  'prepacked-vector',
  'tile-pyramid',
  'prebuilt-raster',
  'retained-immediate',
] as const);

export type AnnotationBodyPresenterKind = (typeof ANNOTATION_BODY_PRESENTER_PRIORITY)[number];

export type AnnotationBodyFrameOwnerKind = AnnotationBodyPresenterKind | 'none';

export type AnnotationBodyReplacementReadiness = 'absent' | 'pending' | 'complete';

export type AnnotationBodyPresenterEligibility = Readonly<
  Record<AnnotationBodyPresenterKind, boolean>
>;

export interface AnnotationBodyPresentationGenerationV1 {
  readonly contract: typeof ANNOTATION_BODY_PRESENTATION_AUTHORITY_V1;
  readonly commitEpoch: number;
  readonly generationId: string;
  readonly productKind: AnnotationBodyFrameOwnerKind;
  readonly orderedVisibleTrackIds: readonly string[];
  readonly policy: Readonly<{
    isoformMode: 'canonical' | 'expanded';
    laneLimit: number | null;
  }>;
  readonly sourceFingerprint: string | null;
  readonly placementFingerprint: string | null;
  readonly productFingerprints: readonly string[];
}

export interface AnnotationBodyFrameAuthoritySnapshotV1 {
  readonly contract: typeof ANNOTATION_BODY_PRESENTATION_AUTHORITY_V1;
  readonly commitEpoch: number;
  readonly frameOwner: AnnotationBodyFrameOwnerKind;
  readonly eligibility: AnnotationBodyPresenterEligibility;
  readonly generation: AnnotationBodyPresentationGenerationV1 | null;
}

export function emptyAnnotationBodyPresenterEligibility(): AnnotationBodyPresenterEligibility {
  return Object.freeze({
    'compiled-broad': false,
    'prepacked-vector': false,
    'tile-pyramid': false,
    'prebuilt-raster': false,
    'retained-immediate': false,
  });
}

export function selectAnnotationBodyPresenter(
  eligibility: AnnotationBodyPresenterEligibility
): AnnotationBodyFrameOwnerKind {
  for (const kind of ANNOTATION_BODY_PRESENTER_PRIORITY) {
    if (eligibility[kind] === true) return kind;
  }
  return 'none';
}

export function buildAnnotationBodyGenerationIdV1(input: {
  productKind: AnnotationBodyFrameOwnerKind;
  orderedVisibleTrackIds: readonly string[];
  policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
  sourceFingerprint: string | null;
  placementFingerprint: string | null;
  productFingerprints: readonly string[];
}): string {
  return [
    'annotation-body-generation.v1',
    input.productKind,
    ...input.orderedVisibleTrackIds,
    input.policy.isoformMode,
    input.policy.laneLimit ?? 'all',
    input.sourceFingerprint ?? 'no-source',
    input.placementFingerprint ?? 'no-placement',
    ...input.productFingerprints,
  ].join('\u0000');
}

export function createAnnotationBodyPresentationGenerationV1(input: {
  commitEpoch: number;
  orderedVisibleTrackIds: readonly string[];
  policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
  sourceFingerprint?: string | null;
  placementFingerprint?: string | null;
  productKind?: AnnotationBodyFrameOwnerKind | null;
  productFingerprints?: readonly string[];
}): AnnotationBodyPresentationGenerationV1 {
  if (!Number.isSafeInteger(input.commitEpoch) || input.commitEpoch < 0) {
    throw new Error('annotation body presentation commitEpoch must be a non-negative safe integer');
  }
  if (!Array.isArray(input.orderedVisibleTrackIds)) {
    throw new Error('annotation body presentation orderedVisibleTrackIds is required');
  }
  const isoformMode = input.policy?.isoformMode;
  if (isoformMode !== 'canonical' && isoformMode !== 'expanded') {
    throw new Error('annotation body presentation policy.isoformMode is invalid');
  }
  const laneLimit = input.policy.laneLimit;
  if (laneLimit !== null && (!Number.isSafeInteger(laneLimit) || laneLimit < 1)) {
    throw new Error('annotation body presentation policy.laneLimit is invalid');
  }
  const seen = new Set<string>();
  const orderedVisibleTrackIds = Object.freeze(
    input.orderedVisibleTrackIds.map((trackId) => {
      if (typeof trackId !== 'string' || trackId.trim().length === 0) {
        throw new Error('annotation body presentation track id is invalid');
      }
      if (seen.has(trackId)) {
        throw new Error(`annotation body presentation track id is duplicated: ${trackId}`);
      }
      seen.add(trackId);
      return trackId;
    })
  );
  const productKind = input.productKind ?? 'none';
  const productFingerprints = Object.freeze(
    (input.productFingerprints ?? []).map((value) => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('annotation body presentation product fingerprint is invalid');
      }
      return value;
    })
  );
  const sourceFingerprint = input.sourceFingerprint ?? null;
  const placementFingerprint = input.placementFingerprint ?? null;
  const generationId = buildAnnotationBodyGenerationIdV1({
    productKind,
    orderedVisibleTrackIds,
    policy: { isoformMode, laneLimit },
    sourceFingerprint,
    placementFingerprint,
    productFingerprints,
  });
  return Object.freeze({
    contract: ANNOTATION_BODY_PRESENTATION_AUTHORITY_V1,
    commitEpoch: input.commitEpoch,
    generationId,
    productKind,
    orderedVisibleTrackIds,
    policy: Object.freeze({
      isoformMode,
      laneLimit,
    }),
    sourceFingerprint,
    placementFingerprint,
    productFingerprints,
  });
}

export function createAnnotationBodyFrameAuthoritySnapshotV1(input: {
  commitEpoch: number;
  eligibility: AnnotationBodyPresenterEligibility;
  generation: AnnotationBodyPresentationGenerationV1 | null;
  frameOwner?: AnnotationBodyFrameOwnerKind;
}): AnnotationBodyFrameAuthoritySnapshotV1 {
  const frameOwner = selectAnnotationBodyPresenter(input.eligibility);
  if (input.frameOwner !== undefined && input.frameOwner !== frameOwner) {
    throw new Error(
      `annotation body frame owner mismatch: claimed ${input.frameOwner}, selected ${frameOwner}`
    );
  }
  void (
    input.generation &&
    input.generation.commitEpoch !== input.commitEpoch &&
    input.commitEpoch !== 0
  );
  return Object.freeze({
    contract: ANNOTATION_BODY_PRESENTATION_AUTHORITY_V1,
    commitEpoch: input.commitEpoch,
    frameOwner,
    eligibility: Object.freeze({ ...input.eligibility }),
    generation: input.generation,
  });
}

export function shouldHoldCommittedAnnotationBodyGeneration(input: {
  hasCommittedGeneration: boolean;
  replacementReadiness: AnnotationBodyReplacementReadiness;
}): boolean {
  return input.hasCommittedGeneration && input.replacementReadiness === 'pending';
}

export function isAnnotationBodyProductInGeneration(
  generation: AnnotationBodyPresentationGenerationV1 | null,
  productFingerprint: string
): boolean {
  if (generation === null) return true;
  if (generation.productFingerprints.length === 0) return true;
  if (typeof productFingerprint !== 'string' || productFingerprint.trim().length === 0) {
    return false;
  }
  return generation.productFingerprints.includes(productFingerprint);
}

export function runExclusiveAnnotationBodyPresenter<TResult extends boolean>(
  handlers: Readonly<Partial<Record<AnnotationBodyPresenterKind, () => TResult>>>
): { owner: AnnotationBodyFrameOwnerKind; presented: boolean } {
  for (const kind of ANNOTATION_BODY_PRESENTER_PRIORITY) {
    const handler = handlers[kind];
    if (typeof handler !== 'function') continue;
    if (handler()) {
      return { owner: kind, presented: true };
    }
  }
  return { owner: 'none', presented: false };
}

export function runSelectedAnnotationBodyPresenter<TResult extends boolean>(input: {
  eligibility: AnnotationBodyPresenterEligibility;
  handlers: Readonly<Partial<Record<AnnotationBodyPresenterKind, () => TResult>>>;
}): {
  selected: AnnotationBodyFrameOwnerKind;
  owner: AnnotationBodyFrameOwnerKind;
  presented: boolean;
} {
  const selected = selectAnnotationBodyPresenter(input.eligibility);
  if (selected === 'none') {
    return { selected: 'none', owner: 'none', presented: false };
  }
  const handler = input.handlers[selected];
  if (typeof handler !== 'function') {
    return { selected, owner: 'none', presented: false };
  }
  if (handler()) {
    return { selected, owner: selected, presented: true };
  }
  return { selected, owner: 'none', presented: false };
}

export function runExclusiveEligibleAnnotationBodyPresenter<TResult extends boolean>(input: {
  eligibility: AnnotationBodyPresenterEligibility;
  handlers: Readonly<Partial<Record<AnnotationBodyPresenterKind, () => TResult>>>;
}): { owner: AnnotationBodyFrameOwnerKind; presented: boolean } {
  for (const kind of ANNOTATION_BODY_PRESENTER_PRIORITY) {
    if (input.eligibility[kind] !== true) continue;
    const handler = input.handlers[kind];
    if (typeof handler !== 'function') continue;
    if (handler()) {
      return { owner: kind, presented: true };
    }
  }
  return { owner: 'none', presented: false };
}
