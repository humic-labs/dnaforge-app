export interface RetainedHitBin {
  readonly startBp: number;
  readonly endBp: number;
}

interface HitIndex {
  readonly order: Int32Array;
  readonly starts: Float64Array;
  readonly maxLengthBp: number;
}

const indexByBins = new WeakMap<readonly RetainedHitBin[], HitIndex>();

function hitIndexFor(bins: readonly RetainedHitBin[]): HitIndex {
  const cached = indexByBins.get(bins);
  if (cached) return cached;
  const order = Int32Array.from(bins.keys());
  order.sort((left, right) => bins[left].startBp - bins[right].startBp);
  const starts = new Float64Array(order.length);
  let maxLengthBp = 0;
  for (let position = 0; position < order.length; position += 1) {
    const bin = bins[order[position]];
    starts[position] = bin.startBp;
    maxLengthBp = Math.max(maxLengthBp, bin.endBp - bin.startBp);
  }
  const index = { order, starts, maxLengthBp };
  indexByBins.set(bins, index);
  return index;
}

const HIT_TOLERANCE_PX = 8;

export interface RetainedHitPath {
  readonly pixelsPerBp: number;
  nearestBpAt?(screenX: number, screenY: number): number;
}

export function retainedOverviewHitCandidates(
  bins: readonly RetainedHitBin[],
  path: RetainedHitPath,
  screenX: number,
  screenY: number,
  genomeLength: number
): number[] | null {
  if (typeof path.nearestBpAt !== 'function' || bins.length === 0) return null;
  const bp = path.nearestBpAt(screenX, screenY);
  if (!Number.isFinite(bp)) return null;
  const toleranceBp = HIT_TOLERANCE_PX / Math.max(path.pixelsPerBp, 1e-9);
  const { order, starts, maxLengthBp } = hitIndexFor(bins);
  const found = new Set<number>();
  const collect = (queryBp: number) => {
    const high = queryBp + toleranceBp;
    const low = queryBp - toleranceBp;
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= high) lo = mid + 1;
      else hi = mid;
    }
    for (let position = lo - 1; position >= 0; position -= 1) {
      if (starts[position] < low - maxLengthBp) break;
      const index = order[position];
      if (bins[index].endBp >= low) found.add(index);
    }
  };
  collect(bp);
  if (genomeLength > 0) {
    if (bp - toleranceBp < 0) collect(bp + genomeLength);
    if (bp + toleranceBp > genomeLength) collect(bp - genomeLength);
  }
  return [...found].sort((left, right) => right - left);
}
