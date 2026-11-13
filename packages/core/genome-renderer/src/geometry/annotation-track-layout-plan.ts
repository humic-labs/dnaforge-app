export interface AnnotationTrackLayoutDescriptor {
  readonly trackId: string;
  readonly laneCapacity: number;
}

export interface AnnotationTrackLayoutPlanInput {
  readonly tracks: ReadonlyArray<AnnotationTrackLayoutDescriptor>;
  readonly laneStepPx: number;
  readonly barHeightPx: number;
  readonly trackGapPx: number;
}

export interface AnnotationTrackHitBand {
  readonly innerBoundPx: number;
  readonly outerBoundPx: number;
}

export interface AnnotationTrackLayoutEntry {
  readonly trackId: string;
  readonly order: number;
  readonly laneCapacity: number;
  readonly laneCenterOffsetsPx: ReadonlyArray<number>;
  readonly baseOffsetPx: number;
  readonly slotHeightPx: number;
  readonly slotInnerBoundPx: number;
  readonly slotOuterBoundPx: number;
  readonly hitBand: AnnotationTrackHitBand;
}

export interface AnnotationTrackLayoutPlan {
  readonly tracks: ReadonlyArray<AnnotationTrackLayoutEntry>;
  readonly laneStepPx: number;
  readonly barHeightPx: number;
  readonly trackGapPx: number;
  readonly totalHeightPx: number;
  readonly innerBoundPx: 0;
  readonly outerBoundPx: number;
  readonly getTrack: (trackId: string) => AnnotationTrackLayoutEntry | undefined;
  readonly trackAtOffsetPx: (offsetPx: number) => AnnotationTrackLayoutEntry | undefined;
}

export type AnnotationTrackLayoutInputErrorCode =
  | 'invalid-input'
  | 'empty-tracks'
  | 'invalid-track'
  | 'duplicate-track-id'
  | 'invalid-lane-capacity'
  | 'invalid-geometry'
  | 'geometry-overflow';

export class AnnotationTrackLayoutInputError extends Error {
  readonly code: AnnotationTrackLayoutInputErrorCode;

  constructor(message: string, code: AnnotationTrackLayoutInputErrorCode) {
    super(message);
    this.name = 'AnnotationTrackLayoutInputError';
    this.code = code;
  }
}

const TRACK_DESCRIPTOR_KEYS = new Set<PropertyKey>(['trackId', 'laneCapacity']);

export function computeAnnotationTrackLayoutPlan(
  input: AnnotationTrackLayoutPlanInput
): AnnotationTrackLayoutPlan {
  validateInputObject(input);
  const { tracks, laneStepPx, barHeightPx, trackGapPx } = input;

  validatePositiveFinite(laneStepPx, 'laneStepPx');
  validatePositiveFinite(barHeightPx, 'barHeightPx');
  if (barHeightPx > laneStepPx) {
    throw new AnnotationTrackLayoutInputError(
      `barHeightPx (${barHeightPx}) must be less than or equal to laneStepPx (${laneStepPx}).`,
      'invalid-geometry'
    );
  }
  if (!Number.isFinite(trackGapPx) || trackGapPx < 0) {
    throw new AnnotationTrackLayoutInputError(
      `trackGapPx must be finite and nonnegative; received ${String(trackGapPx)}.`,
      'invalid-geometry'
    );
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new AnnotationTrackLayoutInputError(
      'At least one annotation track descriptor is required.',
      'empty-tracks'
    );
  }

  const seenTrackIds = new Set<string>();
  const entries: AnnotationTrackLayoutEntry[] = [];
  let consumedHeightPx = 0;

  for (let order = 0; order < tracks.length; order += 1) {
    const descriptor = tracks[order];
    validateDescriptor(descriptor, order);

    if (seenTrackIds.has(descriptor.trackId)) {
      throw new AnnotationTrackLayoutInputError(
        `Duplicate annotation track id "${descriptor.trackId}".`,
        'duplicate-track-id'
      );
    }
    seenTrackIds.add(descriptor.trackId);

    const slotHeightPx = descriptor.laneCapacity * laneStepPx;
    if (!Number.isFinite(slotHeightPx)) {
      throw new AnnotationTrackLayoutInputError(
        `Track "${descriptor.trackId}" produces a non-finite slot height.`,
        'geometry-overflow'
      );
    }

    const baseOffsetPx = consumedHeightPx === 0 ? 0 : -consumedHeightPx;
    const slotInnerBoundPx = baseOffsetPx;
    const slotOuterBoundPx = baseOffsetPx - slotHeightPx;
    if (!Number.isFinite(slotOuterBoundPx)) {
      throw new AnnotationTrackLayoutInputError(
        `Track "${descriptor.trackId}" overflows the finite composition coordinate range.`,
        'geometry-overflow'
      );
    }

    const laneCenterOffsetsPx = Object.freeze(
      Array.from(
        { length: descriptor.laneCapacity },
        (_, lane) => -barHeightPx / 2 - lane * laneStepPx
      )
    );
    const hitBand = Object.freeze<AnnotationTrackHitBand>({
      innerBoundPx: slotInnerBoundPx,
      outerBoundPx: slotOuterBoundPx,
    });
    entries.push(
      Object.freeze<AnnotationTrackLayoutEntry>({
        trackId: descriptor.trackId,
        order,
        laneCapacity: descriptor.laneCapacity,
        laneCenterOffsetsPx,
        baseOffsetPx,
        slotHeightPx,
        slotInnerBoundPx,
        slotOuterBoundPx,
        hitBand,
      })
    );

    consumedHeightPx += slotHeightPx;
    if (order < tracks.length - 1) consumedHeightPx += trackGapPx;
    if (!Number.isFinite(consumedHeightPx)) {
      throw new AnnotationTrackLayoutInputError(
        'Annotation track stack overflows the finite composition coordinate range.',
        'geometry-overflow'
      );
    }
  }

  const frozenEntries = Object.freeze(entries);
  const byTrackId = new Map(frozenEntries.map((entry) => [entry.trackId, entry] as const));
  const getTrack = (trackId: string): AnnotationTrackLayoutEntry | undefined =>
    byTrackId.get(trackId);
  const trackAtOffsetPx = (offsetPx: number): AnnotationTrackLayoutEntry | undefined => {
    if (!Number.isFinite(offsetPx)) return undefined;
    for (let index = 0; index < frozenEntries.length; index += 1) {
      const entry = frozenEntries[index];
      const includesOutermostEdge = index === frozenEntries.length - 1;
      if (
        offsetPx <= entry.hitBand.innerBoundPx &&
        (offsetPx > entry.hitBand.outerBoundPx ||
          (includesOutermostEdge && offsetPx === entry.hitBand.outerBoundPx))
      ) {
        return entry;
      }
    }
    return undefined;
  };

  return Object.freeze<AnnotationTrackLayoutPlan>({
    tracks: frozenEntries,
    laneStepPx,
    barHeightPx,
    trackGapPx,
    totalHeightPx: consumedHeightPx,
    innerBoundPx: 0,
    outerBoundPx: -consumedHeightPx,
    getTrack,
    trackAtOffsetPx,
  });
}

function validateInputObject(input: AnnotationTrackLayoutPlanInput): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AnnotationTrackLayoutInputError(
      'Annotation track layout input must be an object.',
      'invalid-input'
    );
  }
}

function validateDescriptor(descriptor: AnnotationTrackLayoutDescriptor, index: number): void {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new AnnotationTrackLayoutInputError(
      `Annotation track descriptor at index ${index} must be an object.`,
      'invalid-track'
    );
  }
  const unexpectedKeys = Reflect.ownKeys(descriptor).filter(
    (key) => !TRACK_DESCRIPTOR_KEYS.has(key)
  );
  if (unexpectedKeys.length > 0) {
    throw new AnnotationTrackLayoutInputError(
      `Annotation track descriptor at index ${index} contains unsupported layout input: ${unexpectedKeys
        .map(String)
        .join(', ')}.`,
      'invalid-track'
    );
  }
  if (typeof descriptor.trackId !== 'string' || descriptor.trackId.trim().length === 0) {
    throw new AnnotationTrackLayoutInputError(
      `Annotation track descriptor at index ${index} requires a nonempty trackId.`,
      'invalid-track'
    );
  }
  if (!Number.isSafeInteger(descriptor.laneCapacity) || descriptor.laneCapacity <= 0) {
    throw new AnnotationTrackLayoutInputError(
      `Track "${descriptor.trackId}" laneCapacity must be a positive safe integer; received ${String(
        descriptor.laneCapacity
      )}.`,
      'invalid-lane-capacity'
    );
  }
}

function validatePositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AnnotationTrackLayoutInputError(
      `${field} must be finite and positive; received ${String(value)}.`,
      'invalid-geometry'
    );
  }
}
