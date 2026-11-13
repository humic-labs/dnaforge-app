export const PILEUP_COVERAGE_SMOOTH_KERNEL = [0.06, 0.24, 0.4, 0.24, 0.06] as const;
export const PILEUP_COVERAGE_ALPHA = 1;

export function sampleBinnedDepthColumn(
  bins: ArrayLike<number>,
  binSize: number,
  signalStartBp: number,
  colStartBp: number,
  colEndBp: number,
  useMean: boolean
): number {
  const maxBin = bins.length - 1;
  if (maxBin < 0 || binSize <= 0) return 0;
  const signalEndBp = signalStartBp + bins.length * binSize;
  if (colEndBp <= signalStartBp || colStartBp >= signalEndBp) return 0;

  const clampedStart = Math.max(colStartBp, signalStartBp);
  const clampedEnd = Math.min(colEndBp, signalEndBp);
  let firstBin = Math.floor((clampedStart - signalStartBp) / binSize);
  let lastBin = Math.floor((clampedEnd - 1e-6 - signalStartBp) / binSize);
  if (firstBin < 0) firstBin = 0;
  if (lastBin > maxBin) lastBin = maxBin;
  if (lastBin < firstBin) lastBin = firstBin;

  if (lastBin > firstBin) {
    let d = 0;
    let acc = 0;
    let cnt = 0;
    for (let b = firstBin; b <= lastBin; b++) {
      const v = bins[b];
      if (v > d) d = v;
      acc += v;
      cnt++;
    }
    return useMean && cnt > 0 ? acc / cnt : d;
  }

  const centerBp = (colStartBp + colEndBp) * 0.5;
  const pos = (centerBp - signalStartBp) / binSize - 0.5;
  let b0 = Math.floor(pos);
  let frac = pos - b0;
  if (b0 < 0) {
    b0 = 0;
    frac = 0;
  } else if (b0 >= maxBin) {
    b0 = maxBin;
    frac = 0;
  }
  const b1 = b0 + 1 <= maxBin ? b0 + 1 : maxBin;
  const v0 = bins[b0];
  const v1 = bins[b1];
  return v0 + (v1 - v0) * frac;
}

export function sampleBinnedDepthColumnNearest(
  bins: ArrayLike<number>,
  binSize: number,
  signalStartBp: number,
  colStartBp: number,
  colEndBp: number
): number {
  if (bins.length === 0 || binSize <= 0) return 0;
  const signalEndBp = signalStartBp + bins.length * binSize;
  if (colEndBp <= signalStartBp || colStartBp >= signalEndBp) return 0;
  const centerBp = (colStartBp + colEndBp) * 0.5;
  const index = Math.max(
    0,
    Math.min(bins.length - 1, Math.floor((centerBp - signalStartBp) / binSize))
  );
  return bins[index] ?? 0;
}

export function resampleCoverageColumns(params: {
  bins: ArrayLike<number>;
  binSize: number;
  signalStartBp: number;
  viewStart: number;
  columnBp: number;
  columnCount: number;
  useMean: boolean;
  out: Float32Array;
}): void {
  const { bins, binSize, signalStartBp, viewStart, columnBp, columnCount, useMean, out } = params;
  for (let c = 0; c < columnCount; c++) {
    const colStartBp = viewStart + c * columnBp;
    const colEndBp = colStartBp + columnBp;
    out[c] = sampleBinnedDepthColumn(bins, binSize, signalStartBp, colStartBp, colEndBp, useMean);
  }
}

export function smoothCoverageColumnsInPlace(depths: Float32Array, scratch: Float32Array): void {
  const kernel = PILEUP_COVERAGE_SMOOTH_KERNEL;
  if (depths.length <= kernel.length) return;
  if (scratch.length < depths.length) {
    throw new Error('coverage smoothing scratch is smaller than the presented column field');
  }
  const source = scratch.subarray(0, depths.length);
  source.set(depths);

  const [w0, w1, w2, w3, w4] = kernel;
  const firstWeight = w2 + w3 + w4;
  const secondWeight = w1 + w2 + w3 + w4;
  const penultimateWeight = w0 + w1 + w2 + w3;
  const lastWeight = w0 + w1 + w2;
  const last = depths.length - 1;
  depths[0] = (source[0]! * w2 + source[1]! * w3 + source[2]! * w4) / firstWeight;
  depths[1] =
    (source[0]! * w1 + source[1]! * w2 + source[2]! * w3 + source[3]! * w4) / secondWeight;
  for (let column = 2; column < last - 1; column += 1) {
    depths[column] =
      source[column - 2]! * w0 +
      source[column - 1]! * w1 +
      source[column]! * w2 +
      source[column + 1]! * w3 +
      source[column + 2]! * w4;
  }
  depths[last - 1] =
    (source[last - 3]! * w0 +
      source[last - 2]! * w1 +
      source[last - 1]! * w2 +
      source[last]! * w3) /
    penultimateWeight;
  depths[last] =
    (source[last - 2]! * w0 + source[last - 1]! * w1 + source[last]! * w2) / lastWeight;
}
