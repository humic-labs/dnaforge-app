import { AnnotationRecordIntervalTree, type IntervalLike } from './annotation-record-interval-tree';
import type { AnnotationLaneAssignment } from './annotation-track-draw-ops';
import type { TrackHitResult, TrackHoverArgs } from './types';

const TREES = new WeakMap<ReadonlyArray<IntervalLike>, AnnotationRecordIntervalTree>();

function treeFor(records: ReadonlyArray<IntervalLike>): AnnotationRecordIntervalTree {
  const existing = TREES.get(records);
  if (existing) return existing;
  const tree = new AnnotationRecordIntervalTree(records);
  TREES.set(records, tree);
  return tree;
}

function isDensityBin(record: IntervalLike): boolean {
  const extra = (record as { extra?: { dnaforgeDensity?: unknown } }).extra;
  return Boolean(extra?.dnaforgeDensity);
}

export interface IntervalHitTestArgs<TRecord extends IntervalLike> {
  readonly pointer: TrackHoverArgs;
  readonly records: ReadonlyArray<TRecord>;
  readonly assignment: AnnotationLaneAssignment;
  readonly rowHeightPx: number;
  readonly nameOf?: (record: TRecord) => string | undefined;
}

export function hitTestIntervalTrack<TRecord extends IntervalLike>({
  pointer,
  records,
  assignment,
  rowHeightPx,
  nameOf,
}: IntervalHitTestArgs<TRecord>): TrackHitResult | null {
  if (records.length === 0 || rowHeightPx <= 0) return null;
  const { localX, localY, viewportWidthPx, pathMapper, viewportBpRange } = pointer;
  if (localX < 0 || localX > viewportWidthPx) return null;
  if (localY < 0 || localY > pointer.layoutEntry.height) return null;

  const lane = Math.floor(localY / rowHeightPx);
  if (lane < 0 || lane >= assignment.numLanes) return null;

  const pixelsPerBp = pathMapper.pixelsPerBp;
  if (!(pixelsPerBp > 0)) return null;
  const viewStartBp = viewportBpRange.start;
  const bp = viewStartBp + (localX - pathMapper.bpLeftX(viewStartBp)) / pixelsPerBp;

  const hits = treeFor(records)
    .queryAtBpLane(bp, lane, assignment.lanes)
    .filter((index) => !isDensityBin(records[index]!));
  if (hits.length === 0) return null;

  let best = hits[0]!;
  for (const index of hits) {
    const candidate = records[index]!;
    const incumbent = records[best]!;
    if (candidate.end - candidate.start < incumbent.end - incumbent.start) best = index;
  }

  const record = records[best]!;
  const name = nameOf?.(record);
  return {
    kind: 'select-bp-range',
    startBp: record.start,
    endBp: record.end,
    chromosomeId: pointer.chromosome.id,
    ...(name ? { name } : {}),
  };
}
