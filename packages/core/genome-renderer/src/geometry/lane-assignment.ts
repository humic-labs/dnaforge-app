export function featuresOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
  _seqLength: number
): boolean {
  const aStart = a.start + 1;
  const aEnd = a.end;
  const bStart = b.start + 1;
  const bEnd = b.end;

  const aWraps = aEnd < aStart;
  const bWraps = bEnd < bStart;

  if (!aWraps && !bWraps) {
    return aStart <= bEnd && bStart <= aEnd;
  } else if (aWraps && !bWraps) {
    return bStart <= aEnd || bEnd >= aStart;
  } else if (!aWraps && bWraps) {
    return aStart <= bEnd || aEnd >= bStart;
  } else {
    return true;
  }
}

export interface AssignFeatureLanesOptions {
  maxLanes?: number;
}

export function assignFeatureLanes(
  features: Array<{ start: number; end: number }>,
  seqLength: number,
  options: AssignFeatureLanesOptions = {}
): { laneAssignments: Map<number, number>; numLanes: number; droppedCount: number } {
  if (canUseSortedLinearFastPath(features)) {
    return assignFeatureLanesSortedLinear(features, options);
  }

  const laneAssignments = new Map<number, number>();
  const lanes: Array<Array<{ start: number; end: number }>> = [];
  const maxLanes = Math.max(0, Math.trunc(options.maxLanes ?? Number.POSITIVE_INFINITY));
  let droppedCount = 0;

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    let assignedLane = -1;

    for (let lane = 0; lane < lanes.length; lane++) {
      const hasOverlap = lanes[lane].some((existing) =>
        featuresOverlap(feature, existing, seqLength)
      );
      if (!hasOverlap) {
        assignedLane = lane;
        break;
      }
    }

    if (assignedLane === -1) {
      if (lanes.length >= maxLanes) {
        droppedCount += 1;
        continue;
      }
      assignedLane = lanes.length;
      lanes.push([]);
    }

    lanes[assignedLane].push(feature);
    laneAssignments.set(i, assignedLane);
  }

  return { laneAssignments, numLanes: lanes.length, droppedCount };
}

function canUseSortedLinearFastPath(features: Array<{ start: number; end: number }>): boolean {
  let previousStart = -Number.POSITIVE_INFINITY;
  for (const feature of features) {
    if (feature.end < feature.start + 1) return false;
    if (feature.start < previousStart) return false;
    previousStart = feature.start;
  }
  return true;
}

function assignFeatureLanesSortedLinear(
  features: Array<{ start: number; end: number }>,
  options: AssignFeatureLanesOptions
): { laneAssignments: Map<number, number>; numLanes: number; droppedCount: number } {
  const laneAssignments = new Map<number, number>();
  const laneEndBp: number[] = [];
  const maxLanes = Math.max(0, Math.trunc(options.maxLanes ?? Number.POSITIVE_INFINITY));
  let droppedCount = 0;

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const startInclusiveOneBased = feature.start + 1;
    let assignedLane = -1;

    for (let lane = 0; lane < laneEndBp.length; lane++) {
      if (startInclusiveOneBased > laneEndBp[lane]) {
        assignedLane = lane;
        break;
      }
    }

    if (assignedLane === -1) {
      if (laneEndBp.length >= maxLanes) {
        droppedCount += 1;
        continue;
      }
      assignedLane = laneEndBp.length;
      laneEndBp.push(0);
    }

    laneEndBp[assignedLane] = feature.end;
    laneAssignments.set(i, assignedLane);
  }

  return { laneAssignments, numLanes: laneEndBp.length, droppedCount };
}

export interface AssignFeatureLanesByTypeOptions extends AssignFeatureLanesOptions {
  typeOrder?: ReadonlyArray<string>;
  bandTypes?: ReadonlyArray<string>;
  fixedBandCapacity?: number;
  spacerLanes?: number;
}

export interface AssignFeatureLanesByTypeResult {
  laneAssignments: Map<number, number>;
  localLaneAssignments: Map<number, number>;
  numLanes: number;
  droppedCount: number;
  byType: Array<{
    type: string;
    laneStart: number;
    laneCount: number;
    laneCapacity: number;
    droppedCount: number;
  }>;
}

export function assignFeatureLanesByType(
  features: ReadonlyArray<{ start: number; end: number; type: string }>,
  seqLength: number,
  options: AssignFeatureLanesByTypeOptions = {}
): AssignFeatureLanesByTypeResult {
  const spacer = Math.max(0, Math.trunc(options.spacerLanes ?? 1));
  const maxLanes = options.maxLanes;
  const fixedBandCapacity =
    options.fixedBandCapacity === undefined
      ? null
      : Math.max(0, Math.trunc(options.fixedBandCapacity));

  const indicesByType = new Map<string, number[]>();
  for (let i = 0; i < features.length; i++) {
    const t = features[i].type;
    const list = indicesByType.get(t);
    if (list) list.push(i);
    else indicesByType.set(t, [i]);
  }

  const candidateTypes = new Set<string>(indicesByType.keys());
  for (const type of options.bandTypes ?? []) {
    if (type) candidateTypes.add(type);
  }
  const requestedOrder = options.typeOrder ?? [];
  const seen = new Set<string>();
  const stackOrder: string[] = [];
  for (const t of requestedOrder) {
    if (candidateTypes.has(t) && !seen.has(t)) {
      stackOrder.push(t);
      seen.add(t);
    }
  }
  const remaining = [...candidateTypes]
    .filter((t) => !seen.has(t))
    .sort((a, b) => a.localeCompare(b));
  for (const t of remaining) stackOrder.push(t);

  const laneAssignments = new Map<number, number>();
  const localLaneAssignments = new Map<number, number>();
  const byType: AssignFeatureLanesByTypeResult['byType'] = [];
  let laneCursor = 0;
  let totalDropped = 0;

  for (let bandIndex = 0; bandIndex < stackOrder.length; bandIndex += 1) {
    const type = stackOrder[bandIndex];
    const indices = indicesByType.get(type) ?? [];
    const groupFeatures = indices.map((i) => ({
      start: features[i].start,
      end: features[i].end,
    }));
    const result = assignFeatureLanes(groupFeatures, seqLength, { maxLanes });
    const laneStart = laneCursor;
    const laneCapacity = fixedBandCapacity ?? result.numLanes;
    for (const [localIdx, localLane] of result.laneAssignments) {
      laneAssignments.set(indices[localIdx], laneStart + localLane);
      localLaneAssignments.set(indices[localIdx], localLane);
    }
    byType.push({
      type,
      laneStart,
      laneCount: result.numLanes,
      laneCapacity,
      droppedCount: result.droppedCount,
    });
    totalDropped += result.droppedCount;
    laneCursor += laneCapacity;
    if (laneCapacity > 0 && bandIndex < stackOrder.length - 1) laneCursor += spacer;
  }

  const numLanes = laneCursor;

  return { laneAssignments, localLaneAssignments, numLanes, droppedCount: totalDropped, byType };
}

export const LANE_OFFSET_BASE = -14;
export const LANE_OFFSET_STEP = 16;

export function laneOffset(lane: number): number {
  return LANE_OFFSET_BASE - lane * LANE_OFFSET_STEP;
}
