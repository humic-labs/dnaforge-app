import {
  recordAnchorBp,
  recordSpan,
  type CatalogRecord,
} from '@waypoint/genome-data/annotation-catalog';

import type { AnnotationCatalogTrackData } from './types';

export interface CatalogScoreScale {
  readonly low: number;
  readonly high: number;
}

export interface CatalogDerivedData {
  readonly count: number;
  readonly starts: Float64Array;
  readonly ends: Float64Array;
  readonly anchorEdges: Float64Array;
  readonly forward: Uint8Array;
  readonly anchorOrder: Uint32Array;
  readonly anchorsSorted: Float64Array;
  readonly startOrder: Uint32Array;
  readonly maxSpanBp: number;
  readonly medianSpanBp: number;
  readonly hasForward: boolean;
  readonly hasReverse: boolean;
  readonly scoreScale: CatalogScoreScale | null;
}

export function recordAnchorEdgeBp(record: CatalogRecord): number {
  const base = recordAnchorBp(record);
  const forward = record.strand === '+';
  const isEnd = record.kind === 'terminator';
  return forward === isEnd ? base + 1 : base;
}

export function deriveCatalogTrackData(data: AnnotationCatalogTrackData): CatalogDerivedData {
  const records = data.records;
  const count = records.length;
  const starts = new Float64Array(count);
  const ends = new Float64Array(count);
  const anchorEdges = new Float64Array(count);
  const forward = new Uint8Array(count);
  const spans = new Float64Array(count);
  const signedLogScores: number[] = [];
  let maxSpanBp = 0;
  let hasForward = false;
  let hasReverse = false;

  for (let i = 0; i < count; i++) {
    const record = records[i];
    const span = recordSpan(record);
    starts[i] = span.start;
    ends[i] = span.end;
    anchorEdges[i] = recordAnchorEdgeBp(record);
    const isForward = record.strand === '+';
    forward[i] = isForward ? 1 : 0;
    if (isForward) hasForward = true;
    else hasReverse = true;
    const length = span.end - span.start;
    spans[i] = length;
    if (length > maxSpanBp) maxSpanBp = length;
    if (record.score !== null && Number.isFinite(record.score)) {
      signedLogScores.push(signedLog(record.score));
    }
  }

  const anchorOrder = sortedOrder(anchorEdges);
  const anchorsSorted = new Float64Array(count);
  for (let k = 0; k < count; k++) anchorsSorted[k] = anchorEdges[anchorOrder[k]];

  return {
    count,
    starts,
    ends,
    anchorEdges,
    forward,
    anchorOrder,
    anchorsSorted,
    startOrder: sortedOrder(starts),
    maxSpanBp,
    medianSpanBp: median(spans),
    hasForward,
    hasReverse,
    scoreScale: scoreScaleFor(signedLogScores),
  };
}

export function sortedOrder(values: Float64Array): Uint32Array {
  const order = new Uint32Array(values.length);
  let sorted = true;
  for (let i = 0; i < values.length; i++) {
    order[i] = i;
    if (i > 0 && values[i] < values[i - 1]) sorted = false;
  }
  if (!sorted) order.sort((a, b) => values[a] - values[b] || a - b);
  return order;
}

export function lowerBound(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function signedLog(value: number): number {
  return Math.sign(value) * Math.log1p(Math.abs(value));
}

export function scoreFraction(scale: CatalogScoreScale, score: number | null): number {
  if (score === null || !Number.isFinite(score)) return 0;
  const range = scale.high - scale.low;
  if (range <= 0) return 1;
  return Math.min(1, Math.max(0, (signedLog(score) - scale.low) / range));
}

function scoreScaleFor(values: number[]): CatalogScoreScale | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const at = (fraction: number) => values[Math.round(fraction * (values.length - 1))];
  return { low: at(0.05), high: at(0.95) };
}

function median(values: Float64Array): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort();
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
