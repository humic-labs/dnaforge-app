import type { PileupRecord } from '@waypoint/genome-data';
import { binBp, type Viewport } from '@waypoint/genome-renderer';
import type { ReadyCoverageSlice } from './tile-engine-coverage';

export type CoverageSupportRange = {
  globalStart: number;
  globalEnd: number;
};

export type CoverageSupportSource = {
  resolution: number;
  ranges: CoverageSupportRange[];
};

export type ResidentCoverageLayerLike = {
  globalStart: number;
  globalEnd?: number;
  binSize: number;
  bins: ArrayLike<number> & { length: number };
};

export type CoverageContributor =
  | { kind: 'exact'; resolution: number; slices: ReadyCoverageSlice[] }
  | {
      kind: 'resident';
      resolution: number;
      layers: Map<string, ResidentCoverageLayerLike>;
    };

export function resolveForcedCoverageLevel(
  requestedForcedLevel: number | null,
  maxLevel: number
): number | undefined {
  if (requestedForcedLevel === null) return undefined;
  return Math.max(0, Math.min(maxLevel, requestedForcedLevel));
}

export function hasAnyCoverageComposeSource(
  perLevelCount: number,
  useReads: boolean,
  useResident: boolean
): boolean {
  return perLevelCount > 0 || useReads || useResident;
}

export function coverageOutputBinTooWideForPresentation(
  forcedLevel: number | undefined,
  outBin: number,
  presentationPx: number,
  span: number
): boolean {
  return forcedLevel == null && outBin > 1 && (outBin * Math.max(1, presentationPx)) / span > 1.001;
}

export function completeDestinationMask(
  ranges: ReadonlyArray<CoverageSupportRange>,
  signalStart: number,
  signalBin: number,
  totalBins: number,
  requiredStart: number,
  requiredEnd: number
): Uint8Array {
  const mask = new Uint8Array(totalBins);
  const sorted = ranges
    .filter(
      (range) =>
        Number.isFinite(range.globalStart) &&
        Number.isFinite(range.globalEnd) &&
        range.globalEnd > range.globalStart
    )
    .sort((a, b) => a.globalStart - b.globalStart || b.globalEnd - a.globalEnd);
  let componentStart: number | null = null;
  let componentEnd = 0;
  const markComponent = () => {
    if (componentStart == null || componentEnd <= componentStart) return;
    const firstCandidate = Math.max(0, Math.floor((componentStart - signalStart) / signalBin) - 1);
    const endCandidate = Math.min(
      totalBins,
      Math.ceil((componentEnd - signalStart) / signalBin) + 1
    );
    for (let destination = firstCandidate; destination < endCandidate; destination++) {
      const binStart = signalStart + destination * signalBin;
      const binEnd = binStart + signalBin;
      const neededStart = Math.max(binStart, requiredStart);
      const neededEnd = Math.min(binEnd, requiredEnd);
      if (neededEnd > neededStart && componentStart <= neededStart && componentEnd >= neededEnd) {
        mask[destination] = 1;
      }
    }
  };
  for (const range of sorted) {
    if (componentStart == null) {
      componentStart = range.globalStart;
      componentEnd = range.globalEnd;
      continue;
    }
    if (range.globalStart <= componentEnd) {
      componentEnd = Math.max(componentEnd, range.globalEnd);
      continue;
    }
    markComponent();
    componentStart = range.globalStart;
    componentEnd = range.globalEnd;
  }
  markComponent();
  return mask;
}

export function rangesCoverViewport(
  ranges: ReadonlyArray<CoverageSupportRange>,
  view: Viewport
): boolean {
  const sorted = ranges
    .filter(
      (range) =>
        Number.isFinite(range.globalStart) &&
        Number.isFinite(range.globalEnd) &&
        range.globalEnd > range.globalStart &&
        range.globalEnd > view.globalStart &&
        range.globalStart < view.globalEnd
    )
    .sort((a, b) => a.globalStart - b.globalStart || b.globalEnd - a.globalEnd);
  let coveredEnd = view.globalStart;
  for (const range of sorted) {
    if (range.globalStart > coveredEnd) return false;
    coveredEnd = Math.max(coveredEnd, range.globalEnd);
    if (coveredEnd >= view.globalEnd) return true;
  }
  return false;
}

export function collectExactSupportRanges(
  perLevel: ReadonlyArray<{ slices: ReadonlyArray<ReadyCoverageSlice> }>
): CoverageSupportSource[] {
  const exactRangesByBin = new Map<number, CoverageSupportRange[]>();
  for (const { slices } of perLevel) {
    for (const slice of slices) {
      if (!(slice.binSize > 0)) continue;
      const supportedEnd = Math.min(
        slice.globalEnd,
        slice.globalStart + (slice.payload.bins?.length ?? 0) * slice.binSize
      );
      if (!(supportedEnd > slice.globalStart)) continue;
      const ranges = exactRangesByBin.get(slice.binSize) ?? [];
      ranges.push({ globalStart: slice.globalStart, globalEnd: supportedEnd });
      exactRangesByBin.set(slice.binSize, ranges);
    }
  }
  const supportRanges: CoverageSupportSource[] = [];
  for (const [resolution, ranges] of exactRangesByBin) {
    supportRanges.push({ resolution, ranges });
  }
  return supportRanges;
}

export function collectResidentSupportRanges(
  pyramid: ReadonlyArray<Map<string, ResidentCoverageLayerLike>>
): CoverageSupportSource[] {
  const supportRanges: CoverageSupportSource[] = [];
  for (const level of pyramid) {
    const layers = [...level.values()];
    const bins = new Set(layers.map((layer) => layer.binSize).filter((bin) => bin > 0));
    if (bins.size !== 1) continue;
    const resolution = [...bins][0];
    if (resolution == null) continue;
    const ranges = layers.map((layer) => ({
      globalStart: layer.globalStart,
      globalEnd: Math.min(
        layer.globalEnd ?? Number.POSITIVE_INFINITY,
        layer.globalStart + layer.bins.length * layer.binSize
      ),
    }));
    supportRanges.push({ resolution, ranges });
  }
  return supportRanges;
}

export function selectCompleteSupportOutputLevel(args: {
  forcedLevel: number | undefined;
  capLevel: number;
  maxLevel: number;
  supportRanges: ReadonlyArray<CoverageSupportSource>;
  view: Viewport;
}): number | undefined {
  if (args.forcedLevel != null) return args.forcedLevel;
  for (let candidateLevel = args.capLevel; candidateLevel <= args.maxLevel; candidateLevel += 1) {
    const candidateBin = binBp(candidateLevel);
    const eligibleRanges = args.supportRanges
      .filter((source) => source.resolution <= candidateBin)
      .flatMap((source) => source.ranges);
    if (rangesCoverViewport(eligibleRanges, args.view)) {
      return candidateLevel;
    }
  }
  return undefined;
}

export function collectValidExactSlicesByResolution(
  perLevel: ReadonlyArray<{ slices: ReadonlyArray<ReadyCoverageSlice> }>
): Map<number, ReadyCoverageSlice[]> {
  const exactSlicesByResolution = new Map<number, ReadyCoverageSlice[]>();
  for (const { slices } of perLevel) {
    for (const slice of slices) {
      const sourceBins = slice.payload.bins;
      if (!(slice.binSize > 0) || !Array.isArray(sourceBins) || sourceBins.length === 0) continue;
      if (
        sourceBins.some(
          (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0
        )
      ) {
        continue;
      }
      const supportedEnd = Math.min(
        slice.globalEnd,
        slice.globalStart + sourceBins.length * slice.binSize
      );
      if (!(supportedEnd > slice.globalStart)) continue;
      const atResolution = exactSlicesByResolution.get(slice.binSize) ?? [];
      atResolution.push({ ...slice, globalEnd: supportedEnd });
      exactSlicesByResolution.set(slice.binSize, atResolution);
    }
  }
  return exactSlicesByResolution;
}

export function groupResidentLayersByResolution(
  chosenResidentLevel: Iterable<readonly [string, ResidentCoverageLayerLike]> | null | undefined
): Map<number, Map<string, ResidentCoverageLayerLike>> {
  const residentLayersByResolution = new Map<number, Map<string, ResidentCoverageLayerLike>>();
  for (const [chromosome, layer] of chosenResidentLevel ?? []) {
    if (!(layer.binSize > 0)) continue;
    const atResolution = residentLayersByResolution.get(layer.binSize) ?? new Map();
    atResolution.set(chromosome, layer);
    residentLayersByResolution.set(layer.binSize, atResolution);
  }
  return residentLayersByResolution;
}

export function rankCoverageContributors(
  exactSlicesByResolution: Map<number, ReadyCoverageSlice[]>,
  residentLayersByResolution: Map<number, Map<string, ResidentCoverageLayerLike>>
): CoverageContributor[] {
  return [
    ...[...exactSlicesByResolution.entries()].map(([resolution, slices]) => ({
      kind: 'exact' as const,
      resolution,
      slices,
    })),
    ...[...residentLayersByResolution.entries()].map(([resolution, layers]) => ({
      kind: 'resident' as const,
      resolution,
      layers,
    })),
  ].sort(
    (a, b) => a.resolution - b.resolution || (a.kind === b.kind ? 0 : a.kind === 'exact' ? -1 : 1)
  );
}

export function applyReadsDerivedCoverage(args: {
  records: ReadonlyArray<Pick<PileupRecord, 'start' | 'end'>>;
  signalStart: number;
  outBin: number;
  totalBins: number;
  windowStartBp?: number;
  windowEndBp?: number;
  bins: number[];
  covered: Uint8Array;
}): void {
  const { records, signalStart, outBin, totalBins, windowStartBp, windowEndBp, bins, covered } =
    args;
  const delta = new Int32Array(totalBins + 1);
  for (const rec of records) {
    let d0 = Math.floor((rec.start - signalStart) / outBin);
    let d1 = Math.floor((rec.end - signalStart) / outBin);
    if (d0 < 0) d0 = 0;
    if (d0 >= totalBins) continue;
    if (d1 < d0) d1 = d0;
    if (d1 > totalBins) d1 = totalBins;
    delta[d0] += 1;
    delta[d1] -= 1;
  }
  let ws = windowStartBp != null ? Math.floor((windowStartBp - signalStart) / outBin) : 0;
  let we = windowEndBp != null ? Math.ceil((windowEndBp - signalStart) / outBin) : totalBins;
  if (ws < 0) ws = 0;
  if (we > totalBins) we = totalBins;
  let acc = 0;
  for (let d = 0; d < totalBins; d++) {
    acc += delta[d];
    if (acc > 0 && d >= ws && d < we) {
      covered[d] = 1;
      bins[d] = acc;
    }
  }
}

export function applyExactContributorToCoverageBins(args: {
  slices: ReadonlyArray<ReadyCoverageSlice>;
  signalStart: number;
  outBin: number;
  totalBins: number;
  view: Viewport;
  bins: number[];
  covered: Uint8Array;
}): void {
  const { slices, signalStart, outBin, totalBins, view, bins, covered } = args;
  const complete = completeDestinationMask(
    slices.map((slice) => ({
      globalStart: slice.globalStart,
      globalEnd: slice.globalEnd,
    })),
    signalStart,
    outBin,
    totalBins,
    view.globalStart,
    view.globalEnd
  );
  const exactWeight = new Float64Array(totalBins);
  const exactSum = new Float64Array(totalBins);
  for (const slice of slices) {
    const src = slice.payload.bins;
    if (!Array.isArray(src)) continue;
    for (let i = 0; i < src.length; i++) {
      const rawValue = src[i] ?? 0;
      const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
      const binStart = slice.globalStart + i * slice.binSize;
      const binEnd = Math.min(slice.globalEnd, binStart + slice.binSize);
      let d0 = Math.floor((binStart - signalStart) / outBin);
      let d1 = Math.ceil((binEnd - signalStart) / outBin) - 1;
      if (d0 < 0) d0 = 0;
      if (d1 >= totalBins) d1 = totalBins - 1;
      for (let d = d0; d <= d1; d++) {
        if (covered[d]) continue;
        const destinationStart = signalStart + d * outBin;
        const destinationEnd = destinationStart + outBin;
        const overlapBp = Math.max(
          0,
          Math.min(binEnd, destinationEnd) - Math.max(binStart, destinationStart)
        );
        if (overlapBp <= 0) continue;
        exactSum[d] += value * overlapBp;
        exactWeight[d] += overlapBp;
      }
    }
  }
  for (const slice of slices) {
    let s0 = Math.floor((slice.globalStart - signalStart) / outBin);
    let s1 = Math.ceil((slice.globalEnd - signalStart) / outBin) - 1;
    if (s0 < 0) s0 = 0;
    if (s1 >= totalBins) s1 = totalBins - 1;
    for (let d = s0; d <= s1; d++) {
      if (!complete[d] || covered[d] || exactWeight[d] <= 0) continue;
      bins[d] = exactSum[d] / exactWeight[d];
      covered[d] = 1;
    }
  }
}

export function applyResidentContributorToCoverageBins(args: {
  layers: Map<string, ResidentCoverageLayerLike>;
  signalStart: number;
  signalEnd: number;
  outBin: number;
  totalBins: number;
  view: Viewport;
  bins: number[];
  covered: Uint8Array;
  useMeanPool: boolean;
}): void {
  const { layers, signalStart, signalEnd, outBin, totalBins, view, bins, covered, useMeanPool } =
    args;
  const residentRanges = [...layers.values()].map((layer) => ({
    globalStart: layer.globalStart,
    globalEnd: Math.min(
      layer.globalEnd ?? Number.POSITIVE_INFINITY,
      layer.globalStart + layer.bins.length * layer.binSize
    ),
  }));
  const complete = completeDestinationMask(
    residentRanges,
    signalStart,
    outBin,
    totalBins,
    view.globalStart,
    view.globalEnd
  );
  const residentTouched = new Uint8Array(totalBins);
  const residentWeight = useMeanPool ? new Float64Array(totalBins) : null;
  for (const layer of layers.values()) {
    const layerBin = layer.binSize;
    const layerEnd = Math.min(
      layer.globalEnd ?? Number.POSITIVE_INFINITY,
      layer.globalStart + layer.bins.length * layerBin
    );
    const overlapStart = Math.max(signalStart, layer.globalStart);
    const overlapEnd = Math.min(signalEnd, layerEnd);
    if (overlapEnd <= overlapStart) continue;
    const sourceStart = Math.max(0, Math.floor((overlapStart - layer.globalStart) / layerBin));
    const sourceEnd = Math.min(
      layer.bins.length,
      Math.ceil((overlapEnd - layer.globalStart) / layerBin)
    );
    for (let sourceIndex = sourceStart; sourceIndex < sourceEnd; sourceIndex++) {
      const rawValue = layer.bins[sourceIndex] ?? 0;
      const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
      const binStart = layer.globalStart + sourceIndex * layerBin;
      const binEnd = Math.min(layerEnd, binStart + layerBin);
      let d0 = Math.floor((binStart - signalStart) / outBin);
      let d1 = Math.ceil((binEnd - signalStart) / outBin) - 1;
      if (d0 < 0) d0 = 0;
      if (d1 >= totalBins) d1 = totalBins - 1;
      for (let d = d0; d <= d1; d++) {
        if (covered[d] || !complete[d]) continue;
        const destinationStart = signalStart + d * outBin;
        const destinationEnd = destinationStart + outBin;
        const overlapBp = Math.max(
          0,
          Math.min(binEnd, destinationEnd) - Math.max(binStart, destinationStart)
        );
        if (overlapBp <= 0) continue;
        residentTouched[d] = 1;
        if (residentWeight) {
          bins[d] += value * overlapBp;
          residentWeight[d] += overlapBp;
        } else if (value > bins[d]) {
          bins[d] = value;
        }
      }
    }
  }
  for (let d = 0; d < totalBins; d++) {
    if (!residentTouched[d] || covered[d]) continue;
    if (residentWeight && residentWeight[d] > 0) {
      bins[d] /= residentWeight[d];
    }
    covered[d] = 1;
  }
}

export function applyRankedCoverageContributors(args: {
  contributors: ReadonlyArray<CoverageContributor>;
  outBin: number;
  signalStart: number;
  signalEnd: number;
  totalBins: number;
  view: Viewport;
  bins: number[];
  covered: Uint8Array;
  useMeanPool: boolean;
}): void {
  for (const contributor of args.contributors) {
    if (contributor.resolution > args.outBin) continue;
    if (contributor.kind === 'exact') {
      applyExactContributorToCoverageBins({
        slices: contributor.slices,
        signalStart: args.signalStart,
        outBin: args.outBin,
        totalBins: args.totalBins,
        view: args.view,
        bins: args.bins,
        covered: args.covered,
      });
      continue;
    }
    applyResidentContributorToCoverageBins({
      layers: contributor.layers,
      signalStart: args.signalStart,
      signalEnd: args.signalEnd,
      outBin: args.outBin,
      totalBins: args.totalBins,
      view: args.view,
      bins: args.bins,
      covered: args.covered,
      useMeanPool: args.useMeanPool,
    });
  }
}
