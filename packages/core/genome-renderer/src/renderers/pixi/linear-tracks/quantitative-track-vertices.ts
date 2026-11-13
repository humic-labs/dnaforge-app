import {
  MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS,
  type PeakRecord,
  type QuantitativeBin,
} from '@waypoint/genome-data';

import { writePackedBpCoordinate } from '../overview/bp-coordinate-packing';

const TRIANGLE_CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
  [1, 1],
  [0, 1],
] as const;

export type QuantitativeRenderMode = 'signal' | 'peak';
export type QuantitativeRenderableRecord = QuantitativeBin | PeakRecord;

export interface QuantitativeTrackVertices {
  readonly bpStartChunk: Float32Array;
  readonly bpStartDelta: Float32Array;
  readonly bpEndChunk: Float32Array;
  readonly bpEndDelta: Float32Array;
  readonly value: Float32Array;
  readonly xSide: Float32Array;
  readonly ySide: Float32Array;
  readonly color: Float32Array;
  readonly minValue: number;
  readonly maxValue: number;
  readonly barCount: number;
  readonly presentedValues: ReadonlyArray<number>;
  readonly presentedIntervals: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly value: number;
  }>;
}

export function buildQuantitativeTrackVertices(input: {
  readonly records: ReadonlyArray<QuantitativeRenderableRecord>;
  readonly mode: QuantitativeRenderMode;
  readonly defaultColor: number;
  readonly smoothingSigmaBins?: number;
}): QuantitativeTrackVertices {
  const smoothingSigmaBins = input.smoothingSigmaBins ?? 0;
  if (
    !Number.isFinite(smoothingSigmaBins) ||
    smoothingSigmaBins < 0 ||
    smoothingSigmaBins > MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS
  ) {
    throw new Error(
      `Quantitative smoothing must be between 0 and ${MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS} source bins.`
    );
  }
  const presentedRecords =
    input.mode === 'signal' && smoothingSigmaBins > 0
      ? gaussianSmoothContiguousSignal(input.records, smoothingSigmaBins)
      : input.records;
  const bars = presentedRecords.flatMap((record) => {
    const value = recordValue(record, input.mode);
    if (!Number.isFinite(value) || record.end <= record.start) return [];
    const color =
      'color' in record && record.color !== undefined ? record.color : input.defaultColor;
    const main = { start: record.start, end: record.end, value, color };
    if (input.mode !== 'peak' || !('summit' in record) || record.summit === undefined) {
      return [main];
    }
    return [
      main,
      {
        start: record.summit,
        end: record.summit + 1,
        value,
        color,
      },
    ];
  });
  let observedMin = 0;
  let observedMax = bars.length > 0 ? 0 : 1;
  for (const bar of bars) {
    observedMin = Math.min(observedMin, bar.value);
    observedMax = Math.max(observedMax, bar.value);
  }
  const minValue = Math.min(0, observedMin);
  const maxValue = Math.max(0, observedMax, minValue + Number.EPSILON);
  const vertexCount = bars.length * TRIANGLE_CORNERS.length;
  const bpStartChunk = new Float32Array(vertexCount);
  const bpStartDelta = new Float32Array(vertexCount);
  const bpEndChunk = new Float32Array(vertexCount);
  const bpEndDelta = new Float32Array(vertexCount);
  const value = new Float32Array(vertexCount);
  const xSide = new Float32Array(vertexCount);
  const ySide = new Float32Array(vertexCount);
  const color = new Float32Array(vertexCount * 4);

  let vertex = 0;
  for (const bar of bars) {
    const red = ((bar.color >> 16) & 0xff) / 255;
    const green = ((bar.color >> 8) & 0xff) / 255;
    const blue = (bar.color & 0xff) / 255;
    for (const [x, y] of TRIANGLE_CORNERS) {
      writePackedBpCoordinate(bar.start, bpStartChunk, bpStartDelta, vertex);
      writePackedBpCoordinate(bar.end, bpEndChunk, bpEndDelta, vertex);
      value[vertex] = bar.value;
      xSide[vertex] = x;
      ySide[vertex] = y;
      const colorOffset = vertex * 4;
      color[colorOffset] = red;
      color[colorOffset + 1] = green;
      color[colorOffset + 2] = blue;
      color[colorOffset + 3] = 0.9;
      vertex += 1;
    }
  }
  const presentedIntervals = presentedRecords.flatMap((record) => {
    const presentedValue = recordValue(record, input.mode);
    return Number.isFinite(presentedValue) && record.end > record.start
      ? [{ start: record.start, end: record.end, value: presentedValue }]
      : [];
  });
  return {
    bpStartChunk,
    bpStartDelta,
    bpEndChunk,
    bpEndDelta,
    value,
    xSide,
    ySide,
    color,
    minValue,
    maxValue,
    barCount: bars.length,
    presentedValues: presentedIntervals.map((record) => record.value),
    presentedIntervals,
  };
}

function gaussianSmoothContiguousSignal(
  records: ReadonlyArray<QuantitativeRenderableRecord>,
  sigmaBins: number
): ReadonlyArray<QuantitativeRenderableRecord> {
  if (sigmaBins <= 2) return exactGaussianSmoothContiguousSignal(records, sigmaBins);
  const smoothed = [...records];
  const boxWidths = gaussianBoxWidths(sigmaBins);
  let segmentStart = 0;
  while (segmentStart < records.length) {
    const first = records[segmentStart];
    if (!isFiniteSignalRecord(first)) {
      segmentStart += 1;
      continue;
    }
    let segmentEnd = segmentStart + 1;
    while (
      segmentEnd < records.length &&
      isContiguousSignalNeighbor(records[segmentEnd], records[segmentEnd - 1], 'after')
    ) {
      segmentEnd += 1;
    }
    let values = Float64Array.from(
      { length: segmentEnd - segmentStart },
      (_, offset) => (records[segmentStart + offset] as QuantitativeBin).value
    );
    for (const width of boxWidths) values = normalizedBoxBlur(values, width);
    for (let offset = 0; offset < values.length; offset += 1) {
      const record = records[segmentStart + offset] as QuantitativeBin;
      smoothed[segmentStart + offset] = { ...record, value: values[offset] };
    }
    segmentStart = segmentEnd;
  }
  return smoothed;
}

function exactGaussianSmoothContiguousSignal(
  records: ReadonlyArray<QuantitativeRenderableRecord>,
  sigmaBins: number
): ReadonlyArray<QuantitativeRenderableRecord> {
  const radius = Math.max(1, Math.ceil(sigmaBins * 3));
  const weights = Float64Array.from({ length: radius + 1 }, (_, distance) =>
    Math.exp(-(distance * distance) / (2 * sigmaBins * sigmaBins))
  );
  return records.map((record, index) => {
    if (!isFiniteSignalRecord(record)) return record;
    let weightedValue = record.value;
    let totalWeight = 1;
    for (const direction of [-1, 1] as const) {
      let adjacent: QuantitativeRenderableRecord = record;
      for (let distance = 1; distance <= radius; distance += 1) {
        const candidate = records[index + direction * distance];
        const side = direction === -1 ? 'before' : 'after';
        if (!isContiguousSignalNeighbor(candidate, adjacent, side)) break;
        const weight = weights[distance];
        weightedValue += candidate.value * weight;
        totalWeight += weight;
        adjacent = candidate;
      }
    }
    return { ...record, value: weightedValue / totalWeight };
  });
}

function gaussianBoxWidths(sigmaBins: number): ReadonlyArray<number> {
  const passCount = 3;
  const idealWidth = Math.sqrt((12 * sigmaBins * sigmaBins) / passCount + 1);
  let lowerWidth = Math.floor(idealWidth);
  if (lowerWidth % 2 === 0) lowerWidth -= 1;
  lowerWidth = Math.max(1, lowerWidth);
  const upperWidth = lowerWidth + 2;
  const lowerPasses = Math.max(
    0,
    Math.min(
      passCount,
      Math.round(
        (12 * sigmaBins * sigmaBins -
          passCount * lowerWidth * lowerWidth -
          4 * passCount * lowerWidth -
          3 * passCount) /
          (-4 * lowerWidth - 4)
      )
    )
  );
  return Array.from({ length: passCount }, (_, index) =>
    index < lowerPasses ? lowerWidth : upperWidth
  );
}

function normalizedBoxBlur(values: Float64Array, width: number): Float64Array {
  if (width <= 1 || values.length <= 1) return values.slice();
  const radius = Math.floor(width / 2);
  const blurred = new Float64Array(values.length);
  let windowStart = 0;
  let windowEnd = -1;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const nextStart = Math.max(0, index - radius);
    const nextEnd = Math.min(values.length - 1, index + radius);
    while (windowEnd < nextEnd) {
      windowEnd += 1;
      sum += values[windowEnd];
    }
    while (windowStart < nextStart) {
      sum -= values[windowStart];
      windowStart += 1;
    }
    blurred[index] = sum / (windowEnd - windowStart + 1);
  }
  return blurred;
}

function isFiniteSignalRecord(
  record: QuantitativeRenderableRecord | undefined
): record is QuantitativeBin {
  return record !== undefined && 'value' in record && Number.isFinite(record.value);
}

function isContiguousSignalNeighbor(
  candidate: QuantitativeRenderableRecord | undefined,
  record: QuantitativeRenderableRecord,
  side: 'before' | 'after'
): candidate is QuantitativeBin {
  return (
    isFiniteSignalRecord(candidate) &&
    candidate.chrom === record.chrom &&
    (side === 'before' ? candidate.end === record.start : candidate.start === record.end)
  );
}

function recordValue(record: QuantitativeRenderableRecord, mode: QuantitativeRenderMode): number {
  if (mode === 'signal') return 'value' in record ? record.value : Number.NaN;
  if (!('signalValue' in record)) return Number.NaN;
  return record.signalValue ?? record.score ?? 1;
}
