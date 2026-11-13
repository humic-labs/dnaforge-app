import type { TextIntervalRecord } from './text-interval-track';

export interface TextIntervalQueryRegion {
  readonly refName: string;
  readonly start: number;
  readonly end: number;
}

export interface TextIntervalDensityBin {
  readonly start: number;
  readonly end: number;
  readonly count: number;
}

export type TextIntervalRegionQueryResult =
  | {
      readonly kind: 'records';
      readonly records: ReadonlyArray<TextIntervalRecord>;
      readonly totalRecords: number;
    }
  | {
      readonly kind: 'density';
      readonly bins: ReadonlyArray<TextIntervalDensityBin>;
      readonly totalRecords: number;
    };

export interface TextIntervalQueryOptions {
  readonly maxRecords: number;
  readonly maxOverlap: number;
  readonly densityBinCount: number;
}

interface ReferenceIntervalIndex {
  readonly records: ReadonlyArray<TextIntervalRecord>;
  readonly starts: ReadonlyArray<number>;
  readonly prefixMaxEnds: ReadonlyArray<number>;
}

export interface TextIntervalQueryIndex {
  readonly byReference: ReadonlyMap<string, ReferenceIntervalIndex>;
  readonly recordCount: number;
}

export function buildTextIntervalQueryIndex(
  records: ReadonlyArray<TextIntervalRecord>
): TextIntervalQueryIndex {
  const grouped = new Map<string, TextIntervalRecord[]>();
  for (const record of records) {
    const current = grouped.get(record.chrom);
    if (current) current.push(record);
    else grouped.set(record.chrom, [record]);
  }

  const byReference = new Map<string, ReferenceIntervalIndex>();
  for (const [reference, referenceRecords] of grouped) {
    referenceRecords.sort((left, right) => left.start - right.start || left.end - right.end);
    const starts = new Array<number>(referenceRecords.length);
    const prefixMaxEnds = new Array<number>(referenceRecords.length);
    let maxEnd = Number.NEGATIVE_INFINITY;
    for (let recordIndex = 0; recordIndex < referenceRecords.length; recordIndex += 1) {
      const record = referenceRecords[recordIndex];
      starts[recordIndex] = record.start;
      maxEnd = Math.max(maxEnd, record.end);
      prefixMaxEnds[recordIndex] = maxEnd;
    }
    byReference.set(reference, { records: referenceRecords, starts, prefixMaxEnds });
  }
  return { byReference, recordCount: records.length };
}

export function queryTextIntervalRegions(
  index: TextIntervalQueryIndex,
  regions: ReadonlyArray<TextIntervalQueryRegion>,
  options: TextIntervalQueryOptions
): ReadonlyArray<TextIntervalRegionQueryResult> {
  assertOptions(options);
  return regions.map((region) => queryRegion(index, assertRegion(region), options));
}

function queryRegion(
  index: TextIntervalQueryIndex,
  region: TextIntervalQueryRegion,
  options: TextIntervalQueryOptions
): TextIntervalRegionQueryResult {
  const reference = index.byReference.get(region.refName);
  if (!reference) return { kind: 'records', records: [], totalRecords: 0 };

  const to = lowerBound(reference.starts, region.end);
  const from = firstGreaterThan(reference.prefixMaxEnds, region.start, to);
  const matches: TextIntervalRecord[] = [];
  for (let recordIndex = from; recordIndex < to; recordIndex += 1) {
    const record = reference.records[recordIndex];
    if (record.end > region.start) matches.push(record);
  }
  if (matches.length <= options.maxRecords && !maximumOverlapExceeds(matches, options.maxOverlap)) {
    return { kind: 'records', records: matches, totalRecords: matches.length };
  }
  return {
    kind: 'density',
    bins: densityBins(matches, region, options.densityBinCount),
    totalRecords: matches.length,
  };
}

function densityBins(
  records: ReadonlyArray<TextIntervalRecord>,
  region: TextIntervalQueryRegion,
  requestedBinCount: number
): ReadonlyArray<TextIntervalDensityBin> {
  const span = region.end - region.start;
  const binCount = Math.max(1, Math.min(requestedBinCount, span));
  const counts = new Uint32Array(binCount);

  for (const record of records) {
    const clippedStart = Math.max(region.start, record.start);
    const clippedEnd = Math.min(region.end, record.end);
    if (clippedEnd <= clippedStart) continue;
    const first = Math.min(
      binCount - 1,
      Math.floor(((clippedStart - region.start) * binCount) / span)
    );
    const last = Math.min(
      binCount - 1,
      Math.floor(((clippedEnd - 1 - region.start) * binCount) / span)
    );
    for (let binIndex = first; binIndex <= last; binIndex += 1) counts[binIndex] += 1;
  }

  return Array.from(counts, (count, binIndex) => ({
    start: region.start + Math.floor((binIndex * span) / binCount),
    end: region.start + Math.floor(((binIndex + 1) * span) / binCount),
    count,
  }));
}

function lowerBound(values: ReadonlyArray<number>, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstGreaterThan(
  values: ReadonlyArray<number>,
  target: number,
  upperBound: number
): number {
  let low = 0;
  let high = upperBound;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function assertOptions(options: TextIntervalQueryOptions): void {
  if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
    throw new Error('Text interval maxRecords must be a positive integer.');
  }
  if (!Number.isInteger(options.maxOverlap) || options.maxOverlap < 1) {
    throw new Error('Text interval maxOverlap must be a positive integer.');
  }
  if (
    !Number.isInteger(options.densityBinCount) ||
    options.densityBinCount < 1 ||
    options.densityBinCount > 4_096
  ) {
    throw new Error('Text interval densityBinCount must be an integer from 1 to 4096.');
  }
}

function maximumOverlapExceeds(
  records: ReadonlyArray<TextIntervalRecord>,
  maxOverlap: number
): boolean {
  const activeEnds: number[] = [];
  for (const record of records) {
    let expired = 0;
    while (expired < activeEnds.length && activeEnds[expired] <= record.start) expired += 1;
    if (expired > 0) activeEnds.splice(0, expired);
    let insertion = activeEnds.length;
    while (insertion > 0 && activeEnds[insertion - 1] > record.end) insertion -= 1;
    activeEnds.splice(insertion, 0, record.end);
    if (activeEnds.length > maxOverlap) return true;
  }
  return false;
}

function assertRegion(region: TextIntervalQueryRegion): TextIntervalQueryRegion {
  if (
    !region.refName ||
    !Number.isInteger(region.start) ||
    !Number.isInteger(region.end) ||
    region.start < 0 ||
    region.end <= region.start
  ) {
    throw new Error('Text interval query regions require a reference and valid half-open bounds.');
  }
  return region;
}
