import {
  recordSpan,
  type CatalogRecord,
  type Strand,
} from '@waypoint/genome-data/annotation-catalog';

export interface RecordHoverIndex {
  readonly records: readonly CatalogRecord[];
  readonly starts: Float64Array;
  readonly ends: Float64Array;
  readonly maxEndThrough: Float64Array;
}

export type StrandHoverIndexes = Readonly<Record<Strand, RecordHoverIndex>>;

export function sortRecordsBySpanStart(records: readonly CatalogRecord[]): CatalogRecord[] {
  return records
    .map((record) => ({ record, span: recordSpan(record) }))
    .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end)
    .map(({ record }) => record);
}

export function buildRecordHoverIndex(sorted: readonly CatalogRecord[]): RecordHoverIndex {
  const starts = new Float64Array(sorted.length);
  const ends = new Float64Array(sorted.length);
  const maxEndThrough = new Float64Array(sorted.length);
  let runningMax = -Infinity;
  sorted.forEach((record, i) => {
    const span = recordSpan(record);
    starts[i] = span.start;
    ends[i] = span.end;
    runningMax = Math.max(runningMax, span.end);
    maxEndThrough[i] = runningMax;
  });
  return { records: sorted, starts, ends, maxEndThrough };
}

export function buildStrandHoverIndexes(sorted: readonly CatalogRecord[]): StrandHoverIndexes {
  return {
    '+': buildRecordHoverIndex(sorted.filter((record) => record.strand === '+')),
    '-': buildRecordHoverIndex(sorted.filter((record) => record.strand === '-')),
  };
}

export function nearestRecordAt(
  index: RecordHoverIndex,
  bp: number,
  toleranceBp: number
): CatalogRecord | null {
  const lo = bp - toleranceBp;
  const hi = bp + toleranceBp;
  let upper = 0;
  let high = index.starts.length;
  while (upper < high) {
    const mid = (upper + high) >>> 1;
    if (index.starts[mid] <= hi) upper = mid + 1;
    else high = mid;
  }
  let best: CatalogRecord | null = null;
  let bestDistance = Infinity;
  let bestLength = Infinity;
  for (let i = upper - 1; i >= 0 && index.maxEndThrough[i] > lo; i -= 1) {
    const start = index.starts[i];
    const end = index.ends[i];
    if (end <= lo) continue;
    const distance = bp < start ? start - bp : bp >= end ? bp - end : 0;
    if (distance > toleranceBp) continue;
    const length = end - start;
    if (distance < bestDistance || (distance === bestDistance && length < bestLength)) {
      best = index.records[i];
      bestDistance = distance;
      bestLength = length;
    }
  }
  return best;
}
