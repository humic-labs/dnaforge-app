import type { Feature } from '../../../types';

type ClearanceInterval = {
  start: number;
  end: number;
  side: -1 | 1;
  outwardMagnitude: number;
};

class ClearanceRanges {
  private readonly starts: number[] = [];
  private readonly afterCoordinate: boolean[] = [];
  private readonly maxima: number[][] = [[]];

  constructor(tree: Float64Array, leafBase: number, coordinates: readonly number[]) {
    for (let node = 1; node < leafBase; node++) {
      const value = tree[node];
      tree[2 * node] = Math.max(tree[2 * node], value);
      tree[2 * node + 1] = Math.max(tree[2 * node + 1], value);
    }
    const values = this.maxima[0];
    for (let leaf = 0; leaf < coordinates.length * 2 - 1; leaf++) {
      const value = tree[leafBase + leaf];
      if (values.length && values[values.length - 1] === value) continue;
      this.starts.push(coordinates[leaf >>> 1]);
      this.afterCoordinate.push((leaf & 1) === 1);
      values.push(value);
    }
    for (let width = 2; width <= values.length; width *= 2) {
      const previous = this.maxima[this.maxima.length - 1];
      const level = new Array<number>(values.length - width + 1);
      for (let i = 0; i < level.length; i++) {
        level[i] = Math.max(previous[i], previous[i + width / 2]);
      }
      this.maxima.push(level);
    }
  }

  private rangeAt(position: number, low: number): number {
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const boundary = this.starts[middle];
      if (boundary < position || (boundary === position && !this.afterCoordinate[middle])) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low - 1;
  }

  max(start: number, end: number): number | null {
    const first = this.rangeAt(start, 0);
    const last = this.rangeAt(end, first + 1);
    const level = 31 - Math.clz32(last - first + 1);
    const maxima = this.maxima[level];
    const value = Math.max(maxima[first], maxima[last + 1 - (1 << level)]);
    return Number.isFinite(value) ? value : null;
  }
}

export class FloatingAnnotationClearanceIndex {
  private readonly negative: ClearanceRanges;
  private readonly positive: ClearanceRanges;

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

    const ordered = [...new Set(coordinates)].sort((a, b) => a - b);
    const coordinateIndex = new Map(ordered.map((position, index) => [position, index * 2]));
    const leafBase = 2 ** Math.ceil(Math.log2(ordered.length * 2 - 1));
    const negative = new Float64Array(leafBase * 2).fill(-Infinity);
    const positive = new Float64Array(leafBase * 2).fill(-Infinity);
    for (const interval of intervals) {
      const tree = interval.side < 0 ? negative : positive;
      let first = leafBase + coordinateIndex.get(interval.start)!;
      let last = leafBase + coordinateIndex.get(interval.end)!;
      while (first <= last) {
        if (first & 1) {
          tree[first] = Math.max(tree[first], interval.outwardMagnitude);
          first++;
        }
        if (!(last & 1)) {
          tree[last] = Math.max(tree[last], interval.outwardMagnitude);
          last--;
        }
        first >>>= 1;
        last >>>= 1;
      }
    }
    this.negative = new ClearanceRanges(negative, leafBase, ordered);
    this.positive = new ClearanceRanges(positive, leafBase, ordered);
  }

  maxOutwardMagnitude(side: -1 | 1, start: number, end: number): number | null {
    if (end < start || end < 0 || start > this.genomeLength) return null;
    return (side < 0 ? this.negative : this.positive).max(
      Math.max(0, start),
      Math.min(this.genomeLength, end)
    );
  }
}
