import type { AnnotationRecord } from '@waypoint/genome-data';

import { assignFeatureLanes } from '../../../geometry/lane-assignment';
import { featureLaneY, featureRowHeight } from './annotation-track-coords';

export type BpToX = (bp: number) => number;

export interface AnnotationDrawOp {
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
  recordIndex: number;
}

export interface AnnotationLaneAssignment {
  lanes: Int16Array;
  numLanes: number;
  droppedCount: number;
}

export function assignAnnotationLanes(
  records: ReadonlyArray<AnnotationRecord>,
  chromosomeLength: number,
  maxLanes: number
): AnnotationLaneAssignment {
  if (records.length === 0) {
    return { lanes: new Int16Array(0), numLanes: 0, droppedCount: 0 };
  }
  const { laneAssignments, numLanes, droppedCount } = assignFeatureLanes(
    records.map((r) => ({ start: r.start, end: r.end })),
    chromosomeLength,
    { maxLanes }
  );
  const lanes = new Int16Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const lane = laneAssignments.get(i);
    lanes[i] = lane === undefined ? -1 : lane;
  }
  return { lanes, numLanes, droppedCount };
}

export interface ComputeAnnotationDrawOpsArgs {
  records: ReadonlyArray<AnnotationRecord>;
  assignment: AnnotationLaneAssignment;
  viewportBpRange: { start: number; end: number };
  bpToX: BpToX;
  trackHeightPx: number;
  laneHeightPx: number;
  defaultColor: number;
}

export function computeAnnotationDrawOps(args: ComputeAnnotationDrawOpsArgs): AnnotationDrawOp[] {
  const { records, assignment, viewportBpRange, bpToX, trackHeightPx, laneHeightPx, defaultColor } =
    args;

  if (records.length === 0) return [];

  const ops: AnnotationDrawOp[] = [];
  const vStart = viewportBpRange.start;
  const vEnd = viewportBpRange.end;
  if (vEnd <= vStart) return ops;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.start >= vEnd || r.end <= vStart) continue;
    const lane = assignment.lanes[i];
    if (lane < 0) continue;

    const x0 = bpToX(r.start);
    const x1 = bpToX(r.end);
    const w = Math.max(1, x1 - x0);
    const y = featureLaneY(lane, laneHeightPx, trackHeightPx);
    const h = featureRowHeight(y, laneHeightPx, trackHeightPx);
    if (h <= 0) continue;
    ops.push({
      x: x0,
      y,
      width: w,
      height: h,
      color: r.color ?? defaultColor,
      recordIndex: i,
    });
  }
  return ops;
}
