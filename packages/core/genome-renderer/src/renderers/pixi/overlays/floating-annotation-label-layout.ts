export interface FloatingLabelPoint {
  readonly x: number;
  readonly y: number;
}

export interface FloatingLabelBounds {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

export interface FloatingAnnotationLabelPlacementOption {
  readonly tangentStep: number;
  readonly layoutCenterBp: number;
  readonly layoutCenterMinBp?: number;
  readonly layoutCenterMaxBp?: number;
  readonly outwardClearance: number;
  readonly outwardRail: number;
}

export interface FloatingAnnotationLabelDescriptor {
  readonly featureId: number;
  readonly text: string;
  readonly stableOrder: readonly [sequenceStart: number, featureId: number];
  readonly sequenceCenterBp: number;
  readonly outwardSide: -1 | 1;
  readonly textWidth: number;
  readonly textHeight: number;
  readonly placementOptions: readonly FloatingAnnotationLabelPlacementOption[];
}

export interface FloatingAnnotationLabelCandidate extends FloatingAnnotationLabelDescriptor {
  readonly anchor: FloatingLabelPoint;
  readonly outward: FloatingLabelPoint;
  readonly bodyBounds: FloatingLabelBounds;
  readonly normalScale: number;
}

export interface FloatingAnnotationLabelSlot {
  readonly outwardRow: number;
  readonly tangentStep: number;
  readonly outwardClearance: number;
}

export interface FloatingAnnotationLabelAssignmentPlan {
  readonly assignments: ReadonlyMap<number, FloatingAnnotationLabelSlot>;
  readonly candidateCount: number;
  readonly assignedCount: number;
  readonly searchStepCount: number;
  readonly searchBudgetExhaustionCount: number;
  readonly fingerprint: string;
}

export interface FloatingAnnotationLabelObstacle extends FloatingLabelBounds {
  readonly owner: string;
  readonly pts?: readonly number[];
  readonly featureId?: number;
}

export type FloatingAnnotationLabelOutlineLookup = (
  obstacle: FloatingAnnotationLabelObstacle
) => readonly (readonly number[])[] | null;

export interface FloatingAnnotationLabelViewport {
  readonly width: number;
  readonly height: number;
  readonly preloadMargin: number;
}

export interface FloatingAnnotationLabelLeader {
  readonly attachment: 'left' | 'right' | 'top' | 'bottom';
  readonly start: FloatingLabelPoint;
  readonly elbow: FloatingLabelPoint;
  readonly end: FloatingLabelPoint;
  readonly length: number;
}

export interface FloatingAnnotationLabelLeaderSegment {
  readonly featureId: number;
  readonly start: FloatingLabelPoint;
  readonly end: FloatingLabelPoint;
}

export interface FloatingAnnotationLabelPlacedDecision {
  readonly featureId: number;
  readonly text: string;
  readonly anchor: FloatingLabelPoint;
  readonly bodyBounds: FloatingLabelBounds;
  readonly status: 'placed';
  readonly x: number;
  readonly y: number;
  readonly bounds: FloatingLabelBounds;
  readonly leader: FloatingAnnotationLabelLeader;
  readonly slot: FloatingAnnotationLabelSlot;
  readonly testedSlotCount: number;
  readonly assignmentOptions: readonly FloatingAnnotationLabelPlacementOption[];
}

export interface FloatingAnnotationLabelRejectedDecision {
  readonly featureId: number;
  readonly text: string;
  readonly anchor: FloatingLabelPoint;
  readonly bodyBounds: FloatingLabelBounds;
  readonly status: 'rejected';
  readonly reason:
    | 'invalid-geometry'
    | 'outside-runway'
    | 'no-assignment'
    | 'blocked-fixed-slot'
    | 'column-capacity';
  readonly slot: FloatingAnnotationLabelSlot | null;
  readonly plannedPlacement?: {
    readonly x: number;
    readonly y: number;
    readonly bounds: FloatingLabelBounds;
    readonly leader: FloatingAnnotationLabelLeader;
  };
  readonly testedSlotCount: number;
  readonly blockers: readonly string[];
  readonly assignmentOptions?: readonly FloatingAnnotationLabelPlacementOption[];
}

export type FloatingAnnotationLabelDecision =
  | FloatingAnnotationLabelPlacedDecision
  | FloatingAnnotationLabelRejectedDecision;

export interface FloatingAnnotationLabelPlan {
  readonly decisions: readonly FloatingAnnotationLabelDecision[];
  readonly fingerprint: string;
}

const LABEL_ASSIGNMENT_GAP_PX = 3;
const LABEL_BODY_GAP_PX = 12;
const OUTWARD_ROW_STEP_PX = 18;
const OUTWARD_ROW_COUNT = 4;
const REPAIR_OUTWARD_ROW_COUNT = 8;
export const FLOATING_LABEL_TOP_RESERVE_PX = 72;
const RADIAL_OCCUPANCY_BUCKET_PX = 4;
const MAX_DISPLACEMENT_SEARCH_STEPS = 2_048;
const MAX_TOTAL_DISPLACEMENT_SEARCH_STEPS = 49_152;
export const FLOATING_LABEL_TANGENT_STEP_PX = 18;
export const FLOATING_LABEL_TANGENT_STEPS = [0, -1, 1, -2, 2, -3, 3, -4, 4] as const;
export const FLOATING_LABEL_TERMINAL_TICK_PX = 8;
export const FLOATING_LABEL_TEXT_GAP_PX = 3;
export const FLOATING_LABEL_LINE_MASK_PADDING_PX = 1;
export const FLOATING_LABEL_TICK_EDGE_INSET_PX = 4;
let leaderMaskCapacity = 0;
let leaderMaskXMin = new Float64Array(0);
let leaderMaskXMax = new Float64Array(0);
let leaderMaskYMin = new Float64Array(0);
let leaderMaskYMax = new Float64Array(0);
const leaderMaskScratch = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
const OUTWARD_EDGE_PROJECTION_EPSILON_PX = 0.01;
const CIRCULAR_LEADER_ORIENTATION_SAMPLES = Array.from({ length: 32 }, (_, sample) => {
  const angle = (sample / 32) * Math.PI * 2;
  const outwardX = Math.cos(angle);
  const outwardY = Math.sin(angle);
  return {
    outwardX,
    outwardY,
    tangentX: -outwardY,
    tangentY: outwardX,
    absoluteOutwardX: Math.abs(outwardX),
    absoluteOutwardY: Math.abs(outwardY),
  };
});
const LINEAR_LEADER_ORIENTATION_SAMPLES = [
  {
    outwardX: 0,
    outwardY: -1,
    tangentX: 1,
    tangentY: 0,
    absoluteOutwardX: 0,
    absoluteOutwardY: 1,
  },
] as const;
export const FLOATING_LABEL_MAX_LEADER_PX = 112;

const FLOATING_LABEL_MIN_DENSITY_TARGET = 8;
const FLOATING_LABEL_DENSITY_PITCH_PX = 56;
const FLOATING_LABEL_DENSITY_LANE_COUNT = 4;

export interface FloatingAnnotationLabelPriorityInput {
  readonly featureId: number;
  readonly sequenceCenterBp: number;
}

export function rankFloatingAnnotationLabelFeatureIds(
  inputs: readonly FloatingAnnotationLabelPriorityInput[],
  genomeLength: number
): number[] {
  const byId = new Map<number, FloatingAnnotationLabelPriorityInput>();
  for (const input of inputs) {
    if (!Number.isInteger(input.featureId) || !finite(input.sequenceCenterBp)) continue;
    const previous = byId.get(input.featureId);
    if (!previous || input.sequenceCenterBp < previous.sequenceCenterBp) {
      byId.set(input.featureId, input);
    }
  }
  const ordered = [...byId.values()].sort(
    (left, right) =>
      left.sequenceCenterBp - right.sequenceCenterBp || left.featureId - right.featureId
  );
  if (ordered.length === 0) return [];

  type Segment = {
    readonly lo: number;
    readonly hi: number;
    readonly startBp: number;
    readonly endBp: number;
  };
  const sequenceEnd =
    finite(genomeLength) && genomeLength > 0
      ? genomeLength
      : Math.max(1, ordered[ordered.length - 1].sequenceCenterBp);
  const queue: Segment[] = [{ lo: 0, hi: ordered.length, startBp: 0, endBp: sequenceEnd }];
  const ranked: number[] = [];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const segment = queue[queueIndex];
    if (segment.lo >= segment.hi) continue;
    const target = (segment.startBp + segment.endBp) / 2;
    let low = segment.lo;
    let high = segment.hi;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ordered[middle].sequenceCenterBp < target) low = middle + 1;
      else high = middle;
    }
    const right = Math.min(segment.hi - 1, low);
    const left = Math.max(segment.lo, right - 1);
    const leftDistance = Math.abs(ordered[left].sequenceCenterBp - target);
    const rightDistance = Math.abs(ordered[right].sequenceCenterBp - target);
    const selected =
      leftDistance < rightDistance ||
      (leftDistance === rightDistance && ordered[left].featureId < ordered[right].featureId)
        ? left
        : right;
    const selectedFeature = ordered[selected];
    ranked.push(selectedFeature.featureId);
    if (segment.lo < selected) {
      queue.push({
        lo: segment.lo,
        hi: selected,
        startBp: segment.startBp,
        endBp: selectedFeature.sequenceCenterBp,
      });
    }
    if (selected + 1 < segment.hi) {
      queue.push({
        lo: selected + 1,
        hi: segment.hi,
        startBp: selectedFeature.sequenceCenterBp,
        endBp: segment.endBp,
      });
    }
  }
  return ranked;
}

export function floatingAnnotationLabelDensityTarget(options: {
  readonly genomeLength: number;
  readonly bandMinPixelsPerBp: number;
  readonly maxCandidates: number;
}): number {
  const maxCandidates = Math.max(0, Math.floor(options.maxCandidates));
  if (maxCandidates === 0) return 0;
  const pathPixels = Math.max(0, options.genomeLength) * Math.max(0, options.bandMinPixelsPerBp);
  const spatialCapacity =
    Math.ceil(pathPixels / FLOATING_LABEL_DENSITY_PITCH_PX) * FLOATING_LABEL_DENSITY_LANE_COUNT;
  return Math.min(maxCandidates, Math.max(FLOATING_LABEL_MIN_DENSITY_TARGET, spatialCapacity));
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function normalized(vector: FloatingLabelPoint): FloatingLabelPoint | null {
  const length = Math.hypot(vector.x, vector.y);
  if (!finite(length) || length <= 1e-9) return null;
  return { x: vector.x / length, y: vector.y / length };
}

export function floatingLabelOutwardAnchor(
  center: FloatingLabelPoint,
  outwardVector: FloatingLabelPoint,
  points: readonly number[]
): FloatingLabelPoint {
  const outward = normalized(outwardVector);
  if (!outward || points.length < 2) return center;

  let bestProjection = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 1 < points.length; index += 2) {
    const x = points[index];
    const y = points[index + 1];
    if (!finite(x) || !finite(y)) continue;
    const projection = (x - center.x) * outward.x + (y - center.y) * outward.y;
    bestProjection = Math.max(bestProjection, projection);
  }
  if (!finite(bestProjection)) return center;

  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let index = 0; index + 1 < points.length; index += 2) {
    const x = points[index];
    const y = points[index + 1];
    if (!finite(x) || !finite(y)) continue;
    const projection = (x - center.x) * outward.x + (y - center.y) * outward.y;
    if (bestProjection - projection > OUTWARD_EDGE_PROJECTION_EPSILON_PX) continue;
    sumX += x;
    sumY += y;
    count += 1;
  }
  if (count === 0) return center;
  return { x: sumX / count, y: sumY / count };
}

const OBSTACLE_BUCKET_PX = 64;
const MAX_REPAIR_ANCHOR_DISTANCE_PX =
  FLOATING_LABEL_MAX_LEADER_PX + FLOATING_LABEL_TEXT_GAP_PX + FLOATING_LABEL_TERMINAL_TICK_PX;

function bucketObstaclesByX(
  obstacles: readonly FloatingAnnotationLabelObstacle[]
): Map<number, FloatingAnnotationLabelObstacle[]> {
  const buckets = new Map<number, FloatingAnnotationLabelObstacle[]>();
  for (const obstacle of obstacles) {
    if (!finite(obstacle.xMin) || !finite(obstacle.xMax)) continue;
    const first = Math.floor(obstacle.xMin / OBSTACLE_BUCKET_PX);
    const last = Math.floor(obstacle.xMax / OBSTACLE_BUCKET_PX);
    for (let bucket = first; bucket <= last; bucket += 1) {
      let members = buckets.get(bucket);
      if (!members) {
        members = [];
        buckets.set(bucket, members);
      }
      members.push(obstacle);
    }
  }
  return buckets;
}

function overlaps(left: FloatingLabelBounds, right: FloatingLabelBounds): boolean {
  return (
    left.xMin < right.xMax &&
    left.xMax > right.xMin &&
    left.yMin < right.yMax &&
    left.yMax > right.yMin
  );
}

function segmentCrossesBounds(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bounds: FloatingLabelBounds
): boolean {
  let entry = 0;
  let exit = 1;
  const clip = (start: number, delta: number, min: number, max: number): boolean => {
    if (Math.abs(delta) <= 1e-12) return start > min && start < max;
    const first = (min - start) / delta;
    const second = (max - start) / delta;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    return entry < exit;
  };
  return clip(ax, bx - ax, bounds.xMin, bounds.xMax) && clip(ay, by - ay, bounds.yMin, bounds.yMax);
}

function pointInPolygon(x: number, y: number, pts: readonly number[]): boolean {
  let inside = false;
  const count = pts.length >> 1;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    const xi = pts[index * 2];
    const yi = pts[index * 2 + 1];
    const xj = pts[previous * 2];
    const yj = pts[previous * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function boundsHitPolygon(bounds: FloatingLabelBounds, pts: readonly number[]): boolean {
  const count = pts.length >> 1;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    if (
      segmentCrossesBounds(
        pts[previous * 2],
        pts[previous * 2 + 1],
        pts[index * 2],
        pts[index * 2 + 1],
        bounds
      )
    ) {
      return true;
    }
  }
  return pointInPolygon((bounds.xMin + bounds.xMax) / 2, (bounds.yMin + bounds.yMax) / 2, pts);
}

export function floatingLabelBoundsHitObstacle(
  bounds: FloatingLabelBounds,
  obstacle: FloatingAnnotationLabelObstacle,
  outlineLookup?: FloatingAnnotationLabelOutlineLookup
): boolean {
  if (!overlaps(bounds, obstacle)) return false;
  const polygons = outlineLookup?.(obstacle) ?? (obstacle.pts ? [obstacle.pts] : null);
  if (!polygons || polygons.length === 0 || polygons.some((pts) => pts.length < 6)) return true;
  return polygons.some((pts) => boundsHitPolygon(bounds, pts));
}

export function verticalTickX(anchorX: number, bounds: FloatingLabelBounds): number {
  const inset = Math.min(FLOATING_LABEL_TICK_EDGE_INSET_PX, (bounds.xMax - bounds.xMin) / 2);
  return Math.min(bounds.xMax - inset, Math.max(bounds.xMin + inset, anchorX));
}

function calloutLeader(
  anchor: FloatingLabelPoint,
  labelCenter: FloatingLabelPoint,
  bounds: FloatingLabelBounds
): FloatingAnnotationLabelLeader {
  const labelIsRightOfAnchor = labelCenter.x >= anchor.x;
  const horizontalEndX = labelIsRightOfAnchor
    ? bounds.xMin - FLOATING_LABEL_TEXT_GAP_PX
    : bounds.xMax + FLOATING_LABEL_TEXT_GAP_PX;
  const horizontalElbowX =
    horizontalEndX + (labelIsRightOfAnchor ? -1 : 1) * FLOATING_LABEL_TERMINAL_TICK_PX;
  const horizontalLength =
    Math.hypot(horizontalElbowX - anchor.x, labelCenter.y - anchor.y) +
    FLOATING_LABEL_TERMINAL_TICK_PX;
  const labelIsBelowAnchor = labelCenter.y >= anchor.y;
  const verticalEndY = labelIsBelowAnchor
    ? bounds.yMin - FLOATING_LABEL_TEXT_GAP_PX
    : bounds.yMax + FLOATING_LABEL_TEXT_GAP_PX;
  const verticalElbowY =
    verticalEndY + (labelIsBelowAnchor ? -1 : 1) * FLOATING_LABEL_TERMINAL_TICK_PX;
  const centeredVerticalLength =
    Math.hypot(labelCenter.x - anchor.x, verticalElbowY - anchor.y) +
    FLOATING_LABEL_TERMINAL_TICK_PX;
  if (centeredVerticalLength < horizontalLength) {
    const x = verticalTickX(anchor.x, bounds);
    return {
      attachment: labelIsBelowAnchor ? 'top' : 'bottom',
      start: anchor,
      elbow: { x, y: verticalElbowY },
      end: { x, y: verticalEndY },
      length: Math.hypot(x - anchor.x, verticalElbowY - anchor.y) + FLOATING_LABEL_TERMINAL_TICK_PX,
    };
  }
  return {
    attachment: labelIsRightOfAnchor ? 'left' : 'right',
    start: anchor,
    elbow: { x: horizontalElbowX, y: labelCenter.y },
    end: { x: horizontalEndX, y: labelCenter.y },
    length: horizontalLength,
  };
}

function insidePane(
  bounds: FloatingLabelBounds,
  viewport: FloatingAnnotationLabelViewport
): boolean {
  return (
    bounds.xMin >= 0 &&
    bounds.xMax <= viewport.width &&
    bounds.yMin >= 0 &&
    bounds.yMax <= viewport.height
  );
}

function insideRunway(
  bounds: FloatingLabelBounds,
  viewport: FloatingAnnotationLabelViewport
): boolean {
  const margin = Math.max(0, viewport.preloadMargin);
  return (
    bounds.xMin >= -margin &&
    bounds.xMax <= viewport.width + margin &&
    bounds.yMin >= -margin &&
    bounds.yMax <= viewport.height + margin
  );
}

function canonicalNumber(value: number): string {
  if (!finite(value)) return 'invalid';
  return (Math.round(value * 1_000_000) / 1_000_000).toString();
}

function decisionFingerprint(decision: FloatingAnnotationLabelDecision): string {
  if (decision.status === 'rejected') {
    return [
      decision.featureId,
      'rejected',
      decision.reason,
      decision.slot?.outwardRow ?? 'unassigned',
      decision.slot?.tangentStep ?? 'unassigned',
      decision.testedSlotCount,
      canonicalNumber(decision.anchor.x),
      canonicalNumber(decision.anchor.y),
      canonicalNumber(decision.bodyBounds.xMin),
      canonicalNumber(decision.bodyBounds.xMax),
      canonicalNumber(decision.bodyBounds.yMin),
      canonicalNumber(decision.bodyBounds.yMax),
      canonicalNumber(decision.plannedPlacement?.x ?? Number.NaN),
      canonicalNumber(decision.plannedPlacement?.y ?? Number.NaN),
      ...decision.blockers,
    ].join(':');
  }
  return [
    decision.featureId,
    'placed',
    canonicalNumber(decision.x),
    canonicalNumber(decision.y),
    canonicalNumber(decision.bounds.xMin),
    canonicalNumber(decision.bounds.xMax),
    canonicalNumber(decision.bounds.yMin),
    canonicalNumber(decision.bounds.yMax),
    canonicalNumber(decision.leader.start.x),
    canonicalNumber(decision.leader.start.y),
    canonicalNumber(decision.leader.elbow.x),
    canonicalNumber(decision.leader.elbow.y),
    canonicalNumber(decision.leader.end.x),
    canonicalNumber(decision.leader.end.y),
    decision.leader.attachment,
    canonicalNumber(decision.bodyBounds.xMin),
    canonicalNumber(decision.bodyBounds.xMax),
    canonicalNumber(decision.bodyBounds.yMin),
    canonicalNumber(decision.bodyBounds.yMax),
    decision.slot.outwardRow,
    decision.slot.tangentStep,
  ].join(':');
}

function compareStableOrder(
  left: Pick<FloatingAnnotationLabelDescriptor, 'featureId' | 'text' | 'stableOrder'>,
  right: Pick<FloatingAnnotationLabelDescriptor, 'featureId' | 'text' | 'stableOrder'>
): number {
  const primary = left.stableOrder[0] - right.stableOrder[0];
  if (primary !== 0) return primary;
  const secondary = left.stableOrder[1] - right.stableOrder[1];
  if (secondary !== 0) return secondary;
  const id = left.featureId - right.featureId;
  if (id !== 0) return id;
  return left.text.localeCompare(right.text);
}

interface SequenceRange {
  readonly start: number;
  readonly end: number;
}

interface OccupiedSequenceRange extends SequenceRange {
  readonly featureId: number;
}

interface PreparedPlacement {
  readonly featureId: number;
  readonly slot: FloatingAnnotationLabelSlot;
  readonly occupancyKeys: readonly number[];
  readonly ranges: readonly SequenceRange[];
}

interface PreparedPlacementOption {
  readonly option: FloatingAnnotationLabelPlacementOption;
  ranges?: readonly SequenceRange[] | null;
}

interface PreparedPlacementChoices {
  readonly descriptor: FloatingAnnotationLabelDescriptor;
  readonly options: readonly PreparedPlacementOption[];
  readonly cache: Array<PreparedPlacement | null | undefined>;
}

function modulo(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function descriptorRanges(
  descriptor: FloatingAnnotationLabelDescriptor,
  option: FloatingAnnotationLabelPlacementOption,
  pixelsPerBp: number,
  genomeLength: number,
  circular: boolean
): readonly SequenceRange[] {
  const halfSpanBp =
    (descriptor.textWidth / 2 + LABEL_ASSIGNMENT_GAP_PX / 2) / Math.max(pixelsPerBp, 1e-9);
  if (!finite(halfSpanBp) || halfSpanBp < 0) return [];

  const centerMin = Math.min(
    option.layoutCenterMinBp ?? option.layoutCenterBp,
    option.layoutCenterMaxBp ?? option.layoutCenterBp
  );
  const centerMax = Math.max(
    option.layoutCenterMinBp ?? option.layoutCenterBp,
    option.layoutCenterMaxBp ?? option.layoutCenterBp
  );

  if (!circular || genomeLength <= 0) {
    return [
      {
        start: centerMin - halfSpanBp,
        end: centerMax + halfSpanBp,
      },
    ];
  }

  const totalSpan = centerMax - centerMin + halfSpanBp * 2;
  if (totalSpan >= genomeLength) return [{ start: 0, end: genomeLength }];
  const start = modulo(centerMin - halfSpanBp, genomeLength);
  const end = start + totalSpan;
  if (end <= genomeLength) return [{ start, end }];
  return [
    { start: 0, end: end - genomeLength },
    { start, end: genomeLength },
  ];
}

function insertionIndex(ranges: readonly SequenceRange[], start: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].start < start) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insertRange<T extends SequenceRange>(ranges: T[], candidate: T): void {
  ranges.splice(insertionIndex(ranges, candidate.start), 0, candidate);
}

function conflictingFeatures(
  occupied: readonly OccupiedSequenceRange[],
  candidates: readonly SequenceRange[]
): number[] {
  const conflicts: number[] = [];
  const addConflict = (featureId: number): void => {
    if (!conflicts.includes(featureId)) conflicts.push(featureId);
  };
  for (const candidate of candidates) {
    const index = insertionIndex(occupied, candidate.start);
    const previous = occupied[index - 1];
    if (previous && previous.end > candidate.start) addConflict(previous.featureId);
    for (
      let cursor = index;
      cursor < occupied.length && occupied[cursor].start < candidate.end;
      cursor += 1
    ) {
      addConflict(occupied[cursor].featureId);
    }
  }
  return conflicts;
}

function radialOccupancyKeys(
  outwardSide: -1 | 1,
  radialStart: number,
  radialEnd: number
): readonly number[] {
  const first = Math.floor(radialStart / RADIAL_OCCUPANCY_BUCKET_PX);
  const last = Math.floor((radialEnd - 1e-9) / RADIAL_OCCUPANCY_BUCKET_PX);
  const keys: number[] = [];
  for (let bucket = first; bucket <= last; bucket += 1) {
    keys.push(bucket * 2 + (outwardSide > 0 ? 1 : 0));
  }
  return keys;
}

function maximumProjectedLeaderLength(
  descriptor: FloatingAnnotationLabelDescriptor,
  option: FloatingAnnotationLabelPlacementOption,
  outwardRow: number,
  circular: boolean
): number {
  const baseOutwardDistance =
    LABEL_BODY_GAP_PX + option.outwardClearance + outwardRow * OUTWARD_ROW_STEP_PX;
  const tangentDistance = option.tangentStep * FLOATING_LABEL_TANGENT_STEP_PX;
  const orientationSamples = circular
    ? CIRCULAR_LEADER_ORIENTATION_SAMPLES
    : LINEAR_LEADER_ORIENTATION_SAMPLES;
  let maximumLength = 0;
  for (const orientation of orientationSamples) {
    const labelNormalHalfExtent =
      orientation.absoluteOutwardX * (descriptor.textWidth / 2) +
      orientation.absoluteOutwardY * (descriptor.textHeight / 2);
    const outwardDistance = baseOutwardDistance + labelNormalHalfExtent;
    const centerX = orientation.outwardX * outwardDistance + orientation.tangentX * tangentDistance;
    const centerY = orientation.outwardY * outwardDistance + orientation.tangentY * tangentDistance;
    const horizontalElbowX =
      centerX -
      (centerX >= 0 ? 1 : -1) *
        (descriptor.textWidth / 2 + FLOATING_LABEL_TEXT_GAP_PX + FLOATING_LABEL_TERMINAL_TICK_PX);
    const horizontalLength =
      Math.hypot(horizontalElbowX, centerY) + FLOATING_LABEL_TERMINAL_TICK_PX;
    const verticalElbowY =
      centerY -
      (centerY >= 0 ? 1 : -1) *
        (descriptor.textHeight / 2 + FLOATING_LABEL_TEXT_GAP_PX + FLOATING_LABEL_TERMINAL_TICK_PX);
    const verticalLength = Math.hypot(centerX, verticalElbowY) + FLOATING_LABEL_TERMINAL_TICK_PX;
    maximumLength = Math.max(maximumLength, Math.min(horizontalLength, verticalLength));
  }
  return maximumLength + (circular ? 0.5 : 0);
}

export function precomputeFloatingAnnotationLabelAssignments(
  descriptors: readonly FloatingAnnotationLabelDescriptor[],
  options: {
    readonly pixelsPerBp: number;
    readonly genomeLength: number;
    readonly circular: boolean;
  }
): FloatingAnnotationLabelAssignmentPlan {
  const ordered = [...descriptors].sort(compareStableOrder);
  const choicesByFeatureId = new Map<number, PreparedPlacementChoices>();
  for (const descriptor of ordered) {
    choicesByFeatureId.set(descriptor.featureId, {
      descriptor,
      options: descriptor.placementOptions.map((option) => ({ option })),
      cache: [],
    });
  }

  const placementChoiceCount = (choices: PreparedPlacementChoices): number =>
    choices.options.length * OUTWARD_ROW_COUNT;
  const placementChoiceAt = (
    choices: PreparedPlacementChoices,
    index: number
  ): PreparedPlacement | null => {
    if (index in choices.cache) return choices.cache[index] ?? null;
    const optionCount = choices.options.length;
    if (optionCount === 0) return null;
    const outwardRow = index % OUTWARD_ROW_COUNT;
    const prepared = choices.options[Math.floor(index / OUTWARD_ROW_COUNT)];
    if (!prepared) return null;
    if (prepared.ranges === undefined) {
      const ranges = descriptorRanges(
        choices.descriptor,
        prepared.option,
        options.pixelsPerBp,
        options.genomeLength,
        options.circular
      );
      prepared.ranges =
        ranges.length > 0 && ranges.every((range) => finite(range.start) && finite(range.end))
          ? ranges
          : null;
    }
    if (!prepared.ranges) {
      choices.cache[index] = null;
      return null;
    }
    if (
      maximumProjectedLeaderLength(
        choices.descriptor,
        prepared.option,
        outwardRow,
        options.circular
      ) > FLOATING_LABEL_MAX_LEADER_PX
    ) {
      choices.cache[index] = null;
      return null;
    }
    const radialStart =
      choices.descriptor.outwardSide * prepared.option.outwardRail +
      LABEL_BODY_GAP_PX +
      outwardRow * OUTWARD_ROW_STEP_PX;
    const placement: PreparedPlacement = {
      featureId: choices.descriptor.featureId,
      slot: {
        outwardRow,
        tangentStep: prepared.option.tangentStep,
        outwardClearance: prepared.option.outwardClearance,
      },
      occupancyKeys: radialOccupancyKeys(
        choices.descriptor.outwardSide,
        radialStart,
        radialStart + choices.descriptor.textHeight
      ),
      ranges: prepared.ranges,
    };
    choices.cache[index] = placement;
    return placement;
  };

  const occupancy = new Map<number, OccupiedSequenceRange[]>();
  const placements = new Map<number, PreparedPlacement>();

  const rawInsert = (placement: PreparedPlacement): void => {
    for (const occupancyKey of placement.occupancyKeys) {
      let row = occupancy.get(occupancyKey);
      if (!row) {
        row = [];
        occupancy.set(occupancyKey, row);
      }
      for (const range of placement.ranges) {
        insertRange(row, { ...range, featureId: placement.featureId });
      }
    }
    placements.set(placement.featureId, placement);
  };
  const rawRemove = (placement: PreparedPlacement): void => {
    for (const occupancyKey of placement.occupancyKeys) {
      const row = occupancy.get(occupancyKey);
      if (row) {
        for (const range of placement.ranges) {
          const firstMatchingStart = insertionIndex(row, range.start);
          for (
            let index = firstMatchingStart;
            index < row.length && row[index].start === range.start;
            index += 1
          ) {
            const occupiedRange = row[index];
            if (
              occupiedRange.featureId === placement.featureId &&
              occupiedRange.end === range.end
            ) {
              row.splice(index, 1);
              break;
            }
          }
        }
        if (row.length === 0) occupancy.delete(occupancyKey);
      }
    }
    placements.delete(placement.featureId);
  };
  type Undo = {
    readonly action: 'insert' | 'remove';
    readonly placement: PreparedPlacement;
  };
  type SearchBudget = { remaining: number };
  let searchStepCount = 0;
  let searchBudgetExhaustionCount = 0;
  const insert = (placement: PreparedPlacement, undo: Undo[]): void => {
    rawInsert(placement);
    undo.push({ action: 'remove', placement });
  };
  const remove = (placement: PreparedPlacement, undo: Undo[]): void => {
    rawRemove(placement);
    undo.push({ action: 'insert', placement });
  };
  const rollback = (undo: Undo[], checkpoint: number): void => {
    while (undo.length > checkpoint) {
      const operation = undo.pop();
      if (!operation) continue;
      if (operation.action === 'insert') rawInsert(operation.placement);
      else rawRemove(operation.placement);
    }
  };
  const placementConflicts = (placement: PreparedPlacement): number[] => {
    const conflicts: number[] = [];
    for (const occupancyKey of placement.occupancyKeys) {
      for (const featureId of conflictingFeatures(
        occupancy.get(occupancyKey) ?? [],
        placement.ranges
      )) {
        if (!conflicts.includes(featureId)) conflicts.push(featureId);
      }
    }
    return conflicts;
  };

  const tryAssign = (
    featureId: number,
    displacementDepth: number,
    protectedFeatures: ReadonlySet<number>,
    undo: Undo[],
    budget: SearchBudget
  ): boolean => {
    const choices = choicesByFeatureId.get(featureId);
    if (!choices) return false;
    for (let choiceIndex = 0; choiceIndex < placementChoiceCount(choices); choiceIndex += 1) {
      const choice = placementChoiceAt(choices, choiceIndex);
      if (!choice) continue;
      if (budget.remaining <= 0) return false;
      budget.remaining -= 1;
      searchStepCount += 1;
      const conflicts = placementConflicts(choice);
      if (conflicts.some((conflict) => protectedFeatures.has(conflict))) continue;
      if (conflicts.length === 0) {
        insert(choice, undo);
        return true;
      }
      if (displacementDepth <= 0) continue;

      const checkpoint = undo.length;
      const displaced = conflicts
        .map((conflict) => placements.get(conflict))
        .filter((placement): placement is PreparedPlacement => placement !== undefined)
        .sort((left, right) => left.featureId - right.featureId);
      for (const placement of displaced) remove(placement, undo);
      insert(choice, undo);

      const protectedNext = new Set(protectedFeatures);
      protectedNext.add(featureId);
      let reassignedAll = true;
      for (const placement of displaced) {
        if (!tryAssign(placement.featureId, displacementDepth - 1, protectedNext, undo, budget)) {
          reassignedAll = false;
          break;
        }
        protectedNext.add(placement.featureId);
      }
      if (reassignedAll) return true;
      rollback(undo, checkpoint);
    }
    return false;
  };

  const unassigned: number[] = [];
  for (const descriptor of ordered) {
    const undo: Undo[] = [];
    const budget = { remaining: MAX_DISPLACEMENT_SEARCH_STEPS };
    if (!tryAssign(descriptor.featureId, 0, new Set(), undo, budget)) {
      unassigned.push(descriptor.featureId);
    }
  }
  let retry = unassigned;
  const displacementBudget = { remaining: MAX_TOTAL_DISPLACEMENT_SEARCH_STEPS };
  let displacementBudgetExhausted = false;
  for (let pass = 0; pass < 4 && retry.length > 0; pass += 1) {
    const stillUnassigned: number[] = [];
    for (let retryIndex = 0; retryIndex < retry.length; retryIndex += 1) {
      const featureId = retry[retryIndex];
      if (displacementBudget.remaining <= 0) {
        stillUnassigned.push(...retry.slice(retryIndex));
        displacementBudgetExhausted = true;
        break;
      }
      const undo: Undo[] = [];
      const featureBudget = {
        remaining: Math.min(MAX_DISPLACEMENT_SEARCH_STEPS, displacementBudget.remaining),
      };
      if (!tryAssign(featureId, 4, new Set(), undo, featureBudget)) {
        rollback(undo, 0);
        if (featureBudget.remaining <= 0) searchBudgetExhaustionCount += 1;
        stillUnassigned.push(featureId);
      }
      displacementBudget.remaining -=
        Math.min(MAX_DISPLACEMENT_SEARCH_STEPS, displacementBudget.remaining) -
        featureBudget.remaining;
    }
    if (displacementBudgetExhausted) break;
    if (stillUnassigned.length === retry.length) break;
    retry = stillUnassigned;
  }
  if (displacementBudgetExhausted && searchBudgetExhaustionCount === 0) {
    searchBudgetExhaustionCount = 1;
  }

  const assignments = new Map<number, FloatingAnnotationLabelSlot>();
  for (const descriptor of ordered) {
    const placement = placements.get(descriptor.featureId);
    if (placement) assignments.set(descriptor.featureId, placement.slot);
  }

  const fingerprint = ordered
    .map((descriptor) => {
      const slot = assignments.get(descriptor.featureId);
      return `${descriptor.featureId}:${slot?.outwardRow ?? 'hidden'}:${slot?.tangentStep ?? 'hidden'}:${slot ? canonicalNumber(slot.outwardClearance) : 'hidden'}`;
    })
    .join('|');
  return {
    assignments,
    candidateCount: ordered.length,
    assignedCount: assignments.size,
    searchStepCount,
    searchBudgetExhaustionCount,
    fingerprint,
  };
}

function validCandidate(candidate: FloatingAnnotationLabelCandidate): boolean {
  return (
    Number.isInteger(candidate.featureId) &&
    candidate.text.length > 0 &&
    finite(candidate.anchor.x) &&
    finite(candidate.anchor.y) &&
    finite(candidate.outward.x) &&
    finite(candidate.outward.y) &&
    finite(candidate.textWidth) &&
    candidate.textWidth > 0 &&
    finite(candidate.textHeight) &&
    candidate.textHeight > 0 &&
    finite(candidate.bodyBounds.xMin) &&
    finite(candidate.bodyBounds.xMax) &&
    finite(candidate.bodyBounds.yMin) &&
    finite(candidate.bodyBounds.yMax)
  );
}

function pointAlongSegment(
  start: FloatingLabelPoint,
  end: FloatingLabelPoint,
  t: number
): FloatingLabelPoint {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
  };
}

function segmentMaskInterval(
  segment: Pick<FloatingAnnotationLabelLeaderSegment, 'start' | 'end'>,
  bounds: FloatingLabelBounds
): readonly [number, number] | null {
  let entry = 0;
  let exit = 1;
  const clipAxis = (start: number, delta: number, min: number, max: number): boolean => {
    if (Math.abs(delta) <= 1e-9) return start >= min && start <= max;
    const first = (min - start) / delta;
    const second = (max - start) / delta;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    return entry <= exit;
  };
  if (!clipAxis(segment.start.x, segment.end.x - segment.start.x, bounds.xMin, bounds.xMax)) {
    return null;
  }
  if (!clipAxis(segment.start.y, segment.end.y - segment.start.y, bounds.yMin, bounds.yMax)) {
    return null;
  }
  if (exit < 0 || entry > 1) return null;
  const clippedEntry = Math.max(0, entry);
  const clippedExit = Math.min(1, exit);
  return clippedExit - clippedEntry > 1e-9 ? [clippedEntry, clippedExit] : null;
}

function subtractTextMask(
  segment: FloatingAnnotationLabelLeaderSegment,
  bounds: FloatingLabelBounds
): FloatingAnnotationLabelLeaderSegment[] | null {
  const interval = segmentMaskInterval(segment, bounds);
  if (!interval) return null;
  const [entry, exit] = interval;
  const visible: FloatingAnnotationLabelLeaderSegment[] = [];
  if (entry > 1e-9) {
    visible.push({
      featureId: segment.featureId,
      start: segment.start,
      end: pointAlongSegment(segment.start, segment.end, entry),
    });
  }
  if (exit < 1 - 1e-9) {
    visible.push({
      featureId: segment.featureId,
      start: pointAlongSegment(segment.start, segment.end, exit),
      end: segment.end,
    });
  }
  return visible;
}

export function floatingAnnotationVisibleLeaderSegments(
  decisions: readonly FloatingAnnotationLabelDecision[],
  maskPadding = FLOATING_LABEL_LINE_MASK_PADDING_PX,
  onlyFeatureId?: number
): readonly FloatingAnnotationLabelLeaderSegment[] {
  let placedCount = 0;
  for (const decision of decisions) if (decision.status === 'placed') placedCount += 1;
  if (leaderMaskCapacity < placedCount) {
    leaderMaskCapacity = Math.max(placedCount, leaderMaskCapacity * 2, 64);
    leaderMaskXMin = new Float64Array(leaderMaskCapacity);
    leaderMaskXMax = new Float64Array(leaderMaskCapacity);
    leaderMaskYMin = new Float64Array(leaderMaskCapacity);
    leaderMaskYMax = new Float64Array(leaderMaskCapacity);
  }
  const maskXMin = leaderMaskXMin;
  const maskXMax = leaderMaskXMax;
  const maskYMin = leaderMaskYMin;
  const maskYMax = leaderMaskYMax;
  let maskIndex = 0;
  for (const decision of decisions) {
    if (decision.status !== 'placed') continue;
    maskXMin[maskIndex] = decision.bounds.xMin - maskPadding;
    maskXMax[maskIndex] = decision.bounds.xMax + maskPadding;
    maskYMin[maskIndex] = decision.bounds.yMin - maskPadding;
    maskYMax[maskIndex] = decision.bounds.yMax + maskPadding;
    maskIndex += 1;
  }
  const mask = leaderMaskScratch;
  const visible: FloatingAnnotationLabelLeaderSegment[] = [];
  for (const decision of decisions) {
    if (decision.status !== 'placed') continue;
    if (onlyFeatureId !== undefined && decision.featureId !== onlyFeatureId) continue;
    for (let half = 0; half < 2; half += 1) {
      const rawSegment: FloatingAnnotationLabelLeaderSegment =
        half === 0
          ? {
              featureId: decision.featureId,
              start: decision.leader.start,
              end: decision.leader.elbow,
            }
          : {
              featureId: decision.featureId,
              start: decision.leader.elbow,
              end: decision.leader.end,
            };
      const segmentXMin = Math.min(rawSegment.start.x, rawSegment.end.x);
      const segmentXMax = Math.max(rawSegment.start.x, rawSegment.end.x);
      const segmentYMin = Math.min(rawSegment.start.y, rawSegment.end.y);
      const segmentYMax = Math.max(rawSegment.start.y, rawSegment.end.y);
      let fragments: FloatingAnnotationLabelLeaderSegment[] | null = null;
      for (let m = 0; m < placedCount; m += 1) {
        if (
          segmentXMax <= maskXMin[m] ||
          segmentXMin >= maskXMax[m] ||
          segmentYMax <= maskYMin[m] ||
          segmentYMin >= maskYMax[m]
        ) {
          continue;
        }
        mask.xMin = maskXMin[m];
        mask.xMax = maskXMax[m];
        mask.yMin = maskYMin[m];
        mask.yMax = maskYMax[m];
        if (!fragments) {
          fragments = subtractTextMask(rawSegment, mask);
          if (fragments?.length === 0) break;
          continue;
        }
        let next: FloatingAnnotationLabelLeaderSegment[] | null = null;
        for (let index = 0; index < fragments.length; index += 1) {
          const fragment = fragments[index];
          const pieces = subtractTextMask(fragment, mask);
          if (!pieces) {
            next?.push(fragment);
            continue;
          }
          next ??= fragments.slice(0, index);
          next.push(...pieces);
        }
        if (next) fragments = next;
        if (fragments.length === 0) break;
      }
      if (fragments) visible.push(...fragments);
      else visible.push(rawSegment);
    }
  }
  return visible;
}

interface RepairSlotCache {
  readonly clearances: Map<number, number>;
  readonly slots: FloatingAnnotationLabelSlot[];
}

const repairSlotsByOptions = new WeakMap<
  readonly FloatingAnnotationLabelPlacementOption[],
  RepairSlotCache
>();
const MAX_REPAIR_ATTEMPTS_PER_FRAME = 512;

const REPAIR_SLOT_ORDER = FLOATING_LABEL_TANGENT_STEPS.flatMap((tangentStep) =>
  Array.from({ length: REPAIR_OUTWARD_ROW_COUNT }, (_, outwardRow) => ({
    outwardRow,
    tangentStep,
    outwardClearance: 0,
  }))
).sort(
  (left, right) =>
    Math.abs(left.tangentStep) +
      left.outwardRow -
      (Math.abs(right.tangentStep) + right.outwardRow) ||
    left.outwardRow - right.outwardRow ||
    left.tangentStep - right.tangentStep
);

function repairSlots(candidate: FloatingAnnotationLabelCandidate): RepairSlotCache {
  const cached = repairSlotsByOptions.get(candidate.placementOptions);
  if (cached) return cached;
  const clearances = new Map<number, number>();
  for (const option of candidate.placementOptions) {
    clearances.set(option.tangentStep, option.outwardClearance);
  }
  const cache = { clearances, slots: [] };
  repairSlotsByOptions.set(candidate.placementOptions, cache);
  return cache;
}

function repairSlotAt(cache: RepairSlotCache, index: number): FloatingAnnotationLabelSlot {
  const cached = cache.slots[index];
  if (cached) return cached;
  const slot = REPAIR_SLOT_ORDER[index];
  const outwardClearance = cache.clearances.get(slot.tangentStep) ?? 0;
  const resolved = Object.is(outwardClearance, 0) ? slot : { ...slot, outwardClearance };
  cache.slots[index] = resolved;
  return resolved;
}

interface SlotAttempt {
  readonly slot: FloatingAnnotationLabelSlot;
  readonly x: number;
  readonly y: number;
  readonly bounds: FloatingLabelBounds;
  readonly leader: FloatingAnnotationLabelLeader;
  readonly outsideRunway: boolean;
  readonly blockers: ReadonlySet<string> | null;
}

export function planFloatingAnnotationLabels(
  candidates: readonly FloatingAnnotationLabelCandidate[],
  assignments: ReadonlyMap<number, FloatingAnnotationLabelSlot>,
  viewport: FloatingAnnotationLabelViewport,
  obstacles: readonly FloatingAnnotationLabelObstacle[] = [],
  outlineLookup?: FloatingAnnotationLabelOutlineLookup
): FloatingAnnotationLabelPlan {
  const ordered = [...candidates].sort(compareStableOrder);
  const obstacleBuckets = bucketObstaclesByX(obstacles);
  const placedBuckets = new Map<number, FloatingAnnotationLabelObstacle[]>();
  const decisionByIndex: Array<FloatingAnnotationLabelDecision | null> = ordered.map(() => null);

  const attempt = (
    candidate: FloatingAnnotationLabelCandidate,
    outward: FloatingLabelPoint,
    slot: FloatingAnnotationLabelSlot,
    assigned: boolean
  ): SlotAttempt | null => {
    const tangentX = -outward.y;
    const tangentY = outward.x;
    const labelNormalHalfExtent =
      Math.abs(outward.x) * (candidate.textWidth / 2) +
      Math.abs(outward.y) * (candidate.textHeight / 2);
    const outwardDistance =
      LABEL_BODY_GAP_PX +
      slot.outwardClearance * candidate.normalScale +
      labelNormalHalfExtent +
      slot.outwardRow * OUTWARD_ROW_STEP_PX;
    const tangentDistance = slot.tangentStep * FLOATING_LABEL_TANGENT_STEP_PX;
    const x = candidate.anchor.x + outward.x * outwardDistance + tangentX * tangentDistance;
    const y = candidate.anchor.y + outward.y * outwardDistance + tangentY * tangentDistance;
    const bounds: FloatingLabelBounds = {
      xMin: x - candidate.textWidth / 2,
      xMax: x + candidate.textWidth / 2,
      yMin: y - candidate.textHeight / 2,
      yMax: y + candidate.textHeight / 2,
    };
    const outsideRunway = !insideRunway(bounds, viewport);
    if (
      !assigned &&
      (outsideRunway || (slot.outwardRow >= OUTWARD_ROW_COUNT && !insidePane(bounds, viewport)))
    ) {
      return null;
    }
    if (!assigned) {
      const dx = Math.max(0, bounds.xMin - candidate.anchor.x, candidate.anchor.x - bounds.xMax);
      const dy = Math.max(0, bounds.yMin - candidate.anchor.y, candidate.anchor.y - bounds.yMax);
      if (dx * dx + dy * dy > MAX_REPAIR_ANCHOR_DISTANCE_PX ** 2) return null;
    }
    const firstBucket = Math.floor(bounds.xMin / OBSTACLE_BUCKET_PX);
    const lastBucket = Math.floor(bounds.xMax / OBSTACLE_BUCKET_PX);
    let blockers: Set<string> | null = null;
    if (!outsideRunway) {
      for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
        const placed = placedBuckets.get(bucket);
        if (!placed) continue;
        for (const obstacle of placed) {
          if (bucket !== firstBucket && obstacle.xMin < bucket * OBSTACLE_BUCKET_PX) continue;
          if (!overlaps(bounds, obstacle)) continue;
          if (!assigned) return null;
          (blockers ??= new Set()).add(obstacle.owner);
        }
      }
    }
    const leader = calloutLeader(candidate.anchor, { x, y }, bounds);
    if (!assigned && leader.length > FLOATING_LABEL_MAX_LEADER_PX) return null;
    if (outsideRunway) return { slot, x, y, bounds, leader, outsideRunway, blockers };
    const ownBodyOwner = `body:${candidate.featureId}`;
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      const members = obstacleBuckets.get(bucket);
      if (!members) continue;
      for (const obstacle of members) {
        if (bucket !== firstBucket && obstacle.xMin < bucket * OBSTACLE_BUCKET_PX) continue;
        if (obstacle.owner === ownBodyOwner) continue;
        if (!floatingLabelBoundsHitObstacle(bounds, obstacle, outlineLookup)) continue;
        if (!assigned) return null;
        (blockers ??= new Set()).add(obstacle.owner);
      }
    }
    return { slot, x, y, bounds, leader, outsideRunway, blockers };
  };
  const place = (
    index: number,
    candidate: FloatingAnnotationLabelCandidate,
    chosen: SlotAttempt,
    testedSlotCount: number
  ): void => {
    decisionByIndex[index] = {
      featureId: candidate.featureId,
      text: candidate.text,
      anchor: candidate.anchor,
      bodyBounds: candidate.bodyBounds,
      status: 'placed',
      x: chosen.x,
      y: chosen.y,
      bounds: chosen.bounds,
      leader: chosen.leader,
      slot: chosen.slot,
      testedSlotCount,
      assignmentOptions: candidate.placementOptions,
    };
    const obstacle = { ...chosen.bounds, owner: `label:${candidate.featureId}` };
    const firstBucket = Math.floor(obstacle.xMin / OBSTACLE_BUCKET_PX);
    const lastBucket = Math.floor(obstacle.xMax / OBSTACLE_BUCKET_PX);
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      let members = placedBuckets.get(bucket);
      if (!members) {
        members = [];
        placedBuckets.set(bucket, members);
      }
      members.push(obstacle);
    }
  };

  const pending: Array<{
    readonly index: number;
    readonly candidate: FloatingAnnotationLabelCandidate;
    readonly outward: FloatingLabelPoint;
    readonly first: SlotAttempt | null;
  }> = [];
  ordered.forEach((candidate, index) => {
    const outward = normalized(candidate.outward);
    if (!validCandidate(candidate) || !outward) {
      decisionByIndex[index] = {
        featureId: candidate.featureId,
        text: candidate.text,
        anchor: candidate.anchor,
        bodyBounds: candidate.bodyBounds,
        status: 'rejected',
        reason: 'invalid-geometry',
        slot: null,
        testedSlotCount: 0,
        blockers: [],
      };
      return;
    }
    const assignedSlot = assignments.get(candidate.featureId);
    const first = assignedSlot ? attempt(candidate, outward, assignedSlot, true) : null;
    if (
      first &&
      !first.outsideRunway &&
      first.blockers === null &&
      first.leader.length <= FLOATING_LABEL_MAX_LEADER_PX
    ) {
      place(index, candidate, first, 1);
      return;
    }
    pending.push({ index, candidate, outward, first });
  });

  let repairAttemptsRemaining = MAX_REPAIR_ATTEMPTS_PER_FRAME;
  for (const { index, candidate, outward, first } of pending) {
    let testedSlotCount = first ? 1 : 0;
    const anchorOnScreen =
      candidate.anchor.x >= 0 &&
      candidate.anchor.x <= viewport.width &&
      candidate.anchor.y >= 0 &&
      candidate.anchor.y <= viewport.height;
    if (anchorOnScreen && !first?.outsideRunway && repairAttemptsRemaining > 0) {
      let repaired: SlotAttempt | null = null;
      const repairs = repairSlots(candidate);
      for (let slotIndex = 0; slotIndex < REPAIR_SLOT_ORDER.length; slotIndex++) {
        const slot = repairSlotAt(repairs, slotIndex);
        if (
          first &&
          slot.outwardRow === first.slot.outwardRow &&
          slot.tangentStep === first.slot.tangentStep &&
          slot.outwardClearance === first.slot.outwardClearance
        ) {
          continue;
        }
        if (repairAttemptsRemaining <= 0) break;
        repairAttemptsRemaining -= 1;
        testedSlotCount += 1;
        const result = attempt(candidate, outward, slot, false);
        if (!result) continue;
        repaired = result;
        break;
      }
      if (repaired) {
        place(index, candidate, repaired, testedSlotCount);
        continue;
      }
    }
    decisionByIndex[index] = first
      ? {
          featureId: candidate.featureId,
          text: candidate.text,
          anchor: candidate.anchor,
          bodyBounds: candidate.bodyBounds,
          status: 'rejected',
          reason: first.outsideRunway ? 'outside-runway' : 'blocked-fixed-slot',
          slot: first.slot,
          plannedPlacement: { x: first.x, y: first.y, bounds: first.bounds, leader: first.leader },
          testedSlotCount,
          blockers: first.blockers ? [...first.blockers].sort() : [],
        }
      : {
          featureId: candidate.featureId,
          text: candidate.text,
          anchor: candidate.anchor,
          bodyBounds: candidate.bodyBounds,
          status: 'rejected',
          reason: 'no-assignment',
          slot: null,
          testedSlotCount,
          blockers: [],
          assignmentOptions: candidate.placementOptions,
        };
  }

  return floatingAnnotationLabelPlanFromDecisions(
    decisionByIndex.filter(
      (decision): decision is FloatingAnnotationLabelDecision => decision !== null
    )
  );
}

export function floatingAnnotationLabelPlanFromDecisions(
  decisions: FloatingAnnotationLabelDecision[]
): FloatingAnnotationLabelPlan {
  let fingerprint: string | null = null;
  return {
    decisions,
    get fingerprint(): string {
      fingerprint ??= decisions.map(decisionFingerprint).join('|');
      return fingerprint;
    },
  };
}
