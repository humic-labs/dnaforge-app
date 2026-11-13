import { lowerBound, type CatalogDerivedData } from './catalog-derived-data';

export interface CatalogDensity {
  readonly binPx: number;
  readonly firstBin: number;
  readonly binCount: number;
  readonly forward: Uint32Array;
  readonly reverse: Uint32Array;
  readonly maxCount: number;
}

export interface CatalogDensityScratch {
  forward: Uint32Array;
  reverse: Uint32Array;
}

export function createCatalogDensityScratch(): CatalogDensityScratch {
  return { forward: new Uint32Array(0), reverse: new Uint32Array(0) };
}

export function computeCatalogDensity(input: {
  readonly derived: CatalogDerivedData;
  readonly viewStartBp: number;
  readonly viewEndBp: number;
  readonly pixelsPerBp: number;
  readonly binPx: number;
  readonly scratch: CatalogDensityScratch;
}): CatalogDensity {
  const { derived, viewStartBp, viewEndBp, pixelsPerBp, binPx, scratch } = input;
  const binBp = binPx / pixelsPerBp;
  const firstBin = Math.floor(viewStartBp / binBp);
  const lastBin = Math.max(firstBin, Math.ceil(viewEndBp / binBp) - 1);
  const binCount = lastBin - firstBin + 1;
  if (scratch.forward.length < binCount) {
    scratch.forward = new Uint32Array(binCount);
    scratch.reverse = new Uint32Array(binCount);
  } else {
    scratch.forward.fill(0, 0, binCount);
    scratch.reverse.fill(0, 0, binCount);
  }
  const { forward, reverse } = scratch;

  const from = lowerBound(derived.anchorsSorted, firstBin * binBp);
  const to = lowerBound(derived.anchorsSorted, (lastBin + 1) * binBp);
  for (let k = from; k < to; k++) {
    const bin = Math.min(
      binCount - 1,
      Math.max(0, Math.floor(derived.anchorsSorted[k] / binBp) - firstBin)
    );
    if (derived.forward[derived.anchorOrder[k]] === 1) forward[bin] += 1;
    else reverse[bin] += 1;
  }

  let maxCount = 0;
  for (let bin = 0; bin < binCount; bin++) {
    if (forward[bin] > maxCount) maxCount = forward[bin];
    if (reverse[bin] > maxCount) maxCount = reverse[bin];
  }
  return { binPx, firstBin, binCount, forward, reverse, maxCount };
}
