import type { Feature } from '../../../types';

type ClearanceInterval = {
  start: number;
  end: number;
  side: -1 | 1;
  outwardMagnitude: number;
};

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export class FloatingAnnotationClearanceIndex {
  private readonly coordinates: number[];
  private readonly leafCount: number;
  private readonly negativeLazy: Float64Array;
  private readonly negativeMax: Float64Array;
  private readonly positiveLazy: Float64Array;
  private readonly positiveMax: Float64Array;

  constructor(
    features: readonly Feature[],
    private readonly genomeLength: number,
    circular: boolean,
    getOffset: (feature: Feature) => number,
    barHeight: number
  ) {
    const intervals: ClearanceInterval[] = [];
    const coordinates = [0, genomeLength];
    const addInterval = (start: number, end: number, side: -1 | 1, outwardMagnitude: number) => {
      const clippedStart = Math.max(0, Math.min(genomeLength, start));
      const clippedEnd = Math.max(0, Math.min(genomeLength, end));
      if (clippedEnd < clippedStart) return;
      intervals.push({ start: clippedStart, end: clippedEnd, side, outwardMagnitude });
      coordinates.push(clippedStart, clippedEnd);
    };

    for (const feature of features) {
      if (!Number.isFinite(feature.start) || !Number.isFinite(feature.end)) continue;
      const offset = getOffset(feature);
      if (!Number.isFinite(offset)) continue;
      const side: -1 | 1 = offset <= 0 ? -1 : 1;
      const outwardMagnitude = side * (offset + (side * barHeight) / 2);
      if (feature.end > feature.start) {
        addInterval(feature.start, feature.end, side, outwardMagnitude);
      } else if (circular) {
        addInterval(feature.start, genomeLength, side, outwardMagnitude);
        addInterval(0, feature.end, side, outwardMagnitude);
      }
    }

    this.coordinates = [...new Set(coordinates)].sort((a, b) => a - b);
    this.leafCount = this.coordinates.length * 2 - 1;
    const size = this.leafCount * 4 + 4;
    this.negativeLazy = new Float64Array(size).fill(Number.NEGATIVE_INFINITY);
    this.negativeMax = new Float64Array(size).fill(Number.NEGATIVE_INFINITY);
    this.positiveLazy = new Float64Array(size).fill(Number.NEGATIVE_INFINITY);
    this.positiveMax = new Float64Array(size).fill(Number.NEGATIVE_INFINITY);

    const coordinateIndex = new Map(this.coordinates.map((position, index) => [position, index]));
    for (const interval of intervals) {
      const first = coordinateIndex.get(interval.start)! * 2;
      const last = coordinateIndex.get(interval.end)! * 2;
      const lazy = interval.side < 0 ? this.negativeLazy : this.positiveLazy;
      const maxima = interval.side < 0 ? this.negativeMax : this.positiveMax;
      this.update(lazy, maxima, 1, 0, this.leafCount - 1, first, last, interval.outwardMagnitude);
    }
  }

  maxOutwardMagnitude(side: -1 | 1, start: number, end: number): number | null {
    if (end < start || end < 0 || start > this.genomeLength) return null;
    const first = this.leafFor(Math.max(0, start));
    const last = this.leafFor(Math.min(this.genomeLength, end));
    const lazy = side < 0 ? this.negativeLazy : this.positiveLazy;
    const maxima = side < 0 ? this.negativeMax : this.positiveMax;
    const value = this.query(lazy, maxima, 1, 0, this.leafCount - 1, first, last, -Infinity);
    return Number.isFinite(value) ? value : null;
  }

  private leafFor(position: number): number {
    const index = lowerBound(this.coordinates, position);
    return this.coordinates[index] === position ? index * 2 : index * 2 - 1;
  }

  private update(
    lazy: Float64Array,
    maxima: Float64Array,
    node: number,
    left: number,
    right: number,
    first: number,
    last: number,
    value: number
  ): void {
    if (first <= left && right <= last) {
      lazy[node] = Math.max(lazy[node], value);
      maxima[node] = Math.max(maxima[node], value);
      return;
    }
    const middle = (left + right) >>> 1;
    if (first <= middle) this.update(lazy, maxima, node * 2, left, middle, first, last, value);
    if (last > middle)
      this.update(lazy, maxima, node * 2 + 1, middle + 1, right, first, last, value);
    maxima[node] = Math.max(lazy[node], maxima[node * 2], maxima[node * 2 + 1]);
  }

  private query(
    lazy: Float64Array,
    maxima: Float64Array,
    node: number,
    left: number,
    right: number,
    first: number,
    last: number,
    inherited: number
  ): number {
    const value = Math.max(inherited, lazy[node]);
    if (first <= left && right <= last) return Math.max(value, maxima[node]);
    const middle = (left + right) >>> 1;
    let result = value;
    if (first <= middle) {
      result = Math.max(
        result,
        this.query(lazy, maxima, node * 2, left, middle, first, last, value)
      );
    }
    if (last > middle) {
      result = Math.max(
        result,
        this.query(lazy, maxima, node * 2 + 1, middle + 1, right, first, last, value)
      );
    }
    return result;
  }
}
