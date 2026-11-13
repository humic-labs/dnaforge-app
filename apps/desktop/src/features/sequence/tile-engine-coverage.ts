import type { CoverageSignal } from '@waypoint/genome-data';
import {
  binBp,
  tileGlobalEnd,
  tileGlobalStart,
  type TileEntry,
  type Viewport,
} from '@waypoint/genome-renderer';

export interface CoverageTilePayload {
  chrom?: string;
  bins?: number[];
  binSize?: number;
  maxDepth?: number;
  start?: number;
  end?: number;
  provenance?: {
    exact?: boolean;
    method?: string;
  };
}

interface CoverageAssemblySegmentPayload extends CoverageTilePayload {
  globalStart?: number;
  globalEnd?: number;
}

interface CoverageAssemblyTilePayload {
  segments?: CoverageAssemblySegmentPayload[];
  maxDepth?: number;
  provenance?: {
    exact?: boolean;
    method?: string;
  };
}

export type ReadyCoverageSlice = {
  globalStart: number;
  globalEnd: number;
  binSize: number;
  payload: CoverageTilePayload;
};

export type CoverageCompositionStatus = {
  level: number;
  viewStartBp: number;
  viewEndBp: number;
  visibleCoreTileCount: number;
  exactReadyCoreTileCount: number;
  readyNonExactCoreTileCount: number;
  pendingCoreTileCount: number;
  errorCoreTileCount: number;
  absentCoreTileCount: number;
  visibleCoreTiles: Array<{
    level: number;
    index: number;
    state: 'exact-ready' | 'raw-ready-no-exact-slice' | 'pending' | 'error' | 'absent';
    globalStartBp: number;
    globalEndBp: number;
    priority: {
      purpose?: string;
      epoch?: number;
      core?: boolean;
      marginDistanceTiles?: number;
    } | null;
  }>;
  readySliceCount: number;
  readyNonzeroBinCount: number;
  readyMaxDepth: number;
  pendingTileCount: number;
  errorTileCount: number;
  coveredFraction: number;
  coversViewport: boolean;
  composedNonzeroBinCount: number;
  composedMaxDepth: number;
  minBinSize: number | null;
  maxBinSize: number | null;
  intervals: Array<{ startBp: number; endBp: number; binSize: number }>;
  gaps: Array<{ startBp: number; endBp: number }>;
};

type CoverageSliceComponent = {
  globalStart: number;
  globalEnd: number;
  slices: ReadyCoverageSlice[];
};

type CoverageChromSource = {
  globalStartBp: number;
};

export function coverageSlicesForEntry(
  entry: TileEntry,
  chromSources: ReadonlyMap<string, CoverageChromSource>
): ReadyCoverageSlice[] {
  if (entry.key.sourceId.startsWith('covasm:')) {
    const payload = entry.data?.payload as CoverageAssemblyTilePayload | undefined;
    if (payload?.provenance?.exact !== true || !Array.isArray(payload.segments)) return [];
    const out: ReadyCoverageSlice[] = [];
    for (const segment of payload.segments) {
      if (!segment?.bins || !Array.isArray(segment.bins)) continue;
      if (segment.provenance?.exact !== true) continue;
      const binSize =
        typeof segment.binSize === 'number' && segment.binSize > 0
          ? segment.binSize
          : binBp(entry.key.level);
      if (typeof segment.globalStart !== 'number' || typeof segment.globalEnd !== 'number') {
        continue;
      }
      const segmentGlobalStart = segment.globalStart;
      const segmentGlobalEnd = segment.globalEnd;
      const globalStart = Math.min(segmentGlobalStart, segmentGlobalEnd);
      const globalEnd = Math.max(segmentGlobalStart, segmentGlobalEnd);
      if (!(globalEnd > globalStart)) continue;
      out.push({
        globalStart,
        globalEnd,
        binSize,
        payload: segment,
      });
    }
    return out;
  }

  if (!entry.key.sourceId.startsWith('cov:')) return [];
  const payload = entry.data?.payload as CoverageTilePayload | undefined;
  if (!payload?.bins || !Array.isArray(payload.bins)) return [];
  if (payload.provenance?.exact !== true) return [];
  const chrom = chromFromSourceId(entry.key.sourceId);
  const chromSrc = chrom ? chromSources.get(chrom) : undefined;
  const payloadBinSize =
    typeof payload.binSize === 'number' && payload.binSize > 0
      ? payload.binSize
      : binBp(entry.key.level);
  const payloadStart =
    typeof payload.start === 'number' && chromSrc
      ? chromSrc.globalStartBp + payload.start
      : tileGlobalStart(entry.key.index, entry.key.level);
  const payloadEnd =
    typeof payload.end === 'number' && chromSrc
      ? chromSrc.globalStartBp + payload.end
      : tileGlobalEnd(entry.key.index, entry.key.level);
  const globalStart = Math.min(payloadStart, payloadEnd);
  const globalEnd = Math.max(payloadStart, payloadEnd);
  if (!(globalEnd > globalStart)) return [];
  return [
    {
      globalStart,
      globalEnd,
      binSize: payloadBinSize,
      payload,
    },
  ];
}

export function overlayCoverageSlices(
  slices: ReadyCoverageSlice[],
  signalStart: number,
  signalBin: number,
  bins: number[]
): number {
  let maxDepth = 0;
  for (const slice of slices) {
    const src = slice.payload.bins;
    if (!Array.isArray(src)) continue;
    for (let i = 0; i < src.length; i++) {
      const v = src[i] ?? 0;
      if (v <= 0) continue;
      const binStart = slice.globalStart + i * slice.binSize;
      const binEnd = Math.min(slice.globalEnd, binStart + slice.binSize);
      let dst0 = Math.floor((binStart - signalStart) / signalBin);
      let dst1 = Math.ceil((binEnd - signalStart) / signalBin) - 1;
      if (dst0 < 0) dst0 = 0;
      if (dst1 >= bins.length) dst1 = bins.length - 1;
      if (dst1 < dst0) continue;
      for (let dst = dst0; dst <= dst1; dst++) {
        if (v > bins[dst]) bins[dst] = v;
      }
      if (v > maxDepth) maxDepth = v;
    }
  }
  return maxDepth;
}

export function overwriteCoverageSlices(
  slices: ReadyCoverageSlice[],
  signalStart: number,
  signalBin: number,
  bins: number[]
): number {
  let maxDepth = 0;
  for (const slice of slices) {
    const src = slice.payload.bins;
    if (!Array.isArray(src)) continue;
    for (let i = 0; i < src.length; i++) {
      const v = src[i] ?? 0;
      const binStart = slice.globalStart + i * slice.binSize;
      const binEnd = Math.min(slice.globalEnd, binStart + slice.binSize);
      let dst0 = Math.floor((binStart - signalStart) / signalBin);
      let dst1 = Math.ceil((binEnd - signalStart) / signalBin) - 1;
      if (dst0 < 0) dst0 = 0;
      if (dst1 >= bins.length) dst1 = bins.length - 1;
      if (dst1 < dst0) continue;
      for (let dst = dst0; dst <= dst1; dst++) {
        bins[dst] = v;
      }
      if (v > maxDepth) maxDepth = v;
    }
  }
  return maxDepth;
}

export function maxCoverageValue(coverage: CoverageSignal, startBp: number, endBp: number): number {
  const coverageStart = coverage.startBp ?? 0;
  const coverageEnd = coverageStart + coverage.bins.length * coverage.binSize;
  const start = Math.max(startBp, coverageStart);
  const end = Math.min(endBp, coverageEnd);
  if (!(end > start) || coverage.binSize <= 0) return 0;
  let i0 = Math.floor((start - coverageStart) / coverage.binSize);
  let i1 = Math.ceil((end - coverageStart) / coverage.binSize) - 1;
  if (i0 < 0) i0 = 0;
  if (i1 >= coverage.bins.length) i1 = coverage.bins.length - 1;
  let max = 0;
  for (let i = i0; i <= i1; i++) {
    const v = coverage.bins[i] ?? 0;
    if (v > max) max = v;
  }
  return max;
}

export function coverageSliceDepthStats(
  slices: ReadyCoverageSlice[],
  view?: Viewport
): {
  nonzeroBinCount: number;
  maxDepth: number;
} {
  let nonzeroBinCount = 0;
  let maxDepth = 0;
  for (const slice of slices) {
    const bins = slice.payload.bins;
    if (!Array.isArray(bins)) continue;
    for (let i = 0; i < bins.length; i++) {
      const binStart = slice.globalStart + i * slice.binSize;
      const binEnd = Math.min(slice.globalEnd, binStart + slice.binSize);
      if (view && (binEnd <= view.globalStart || binStart >= view.globalEnd)) continue;
      const v = bins[i] ?? 0;
      if (!(v > 0)) continue;
      nonzeroBinCount += 1;
      if (v > maxDepth) maxDepth = v;
    }
  }
  return { nonzeroBinCount, maxDepth };
}

export function coverageSignalDepthStats(
  coverage: CoverageSignal,
  view?: Viewport
): {
  nonzeroBinCount: number;
  maxDepth: number;
} {
  let nonzeroBinCount = 0;
  let maxDepth = 0;
  const startBp = coverage.startBp ?? 0;
  for (let i = 0; i < coverage.bins.length; i++) {
    const binStart = startBp + i * coverage.binSize;
    const binEnd = binStart + coverage.binSize;
    if (view && (binEnd <= view.globalStart || binStart >= view.globalEnd)) continue;
    const v = coverage.bins[i] ?? 0;
    if (!(v > 0)) continue;
    nonzeroBinCount += 1;
    if (v > maxDepth) maxDepth = v;
  }
  return { nonzeroBinCount, maxDepth };
}

export function withViewportMaxDepth(coverage: CoverageSignal, view: Viewport): CoverageSignal {
  const percentiles = coverage.depthPercentiles;
  if (percentiles && Number.isFinite(percentiles.p99) && percentiles.p99 > 0) return coverage;

  const startBp = coverage.startBp ?? 0;
  const vals: number[] = [];
  for (let i = 0; i < coverage.bins.length; i++) {
    const binStart = startBp + i * coverage.binSize;
    if (binStart + coverage.binSize <= view.globalStart || binStart >= view.globalEnd) continue;
    const v = coverage.bins[i] ?? 0;
    if (v > 0) vals.push(v);
  }
  if (vals.length === 0) {
    return coverage.maxDepth === 0 ? coverage : { ...coverage, maxDepth: 0 };
  }
  vals.sort((a, b) => a - b);
  const maxDepth = Math.max(1, vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))]);
  if (coverage.maxDepth === maxDepth) return coverage;
  return { ...coverage, maxDepth };
}

export function coverageSliceComponents(slices: ReadyCoverageSlice[]): CoverageSliceComponent[] {
  const sorted = [...slices]
    .filter((slice) => slice.globalEnd > slice.globalStart)
    .sort((a, b) => a.globalStart - b.globalStart || b.globalEnd - a.globalEnd);
  const components: CoverageSliceComponent[] = [];
  for (const slice of sorted) {
    const current = components[components.length - 1];
    if (!current || slice.globalStart > current.globalEnd + 1) {
      components.push({
        globalStart: slice.globalStart,
        globalEnd: slice.globalEnd,
        slices: [slice],
      });
      continue;
    }
    current.globalStart = Math.min(current.globalStart, slice.globalStart);
    current.globalEnd = Math.max(current.globalEnd, slice.globalEnd);
    current.slices.push(slice);
  }
  return components;
}

export function coverageSlicesViewportStatus(
  slices: ReadyCoverageSlice[],
  view: Viewport
): {
  coveredFraction: number;
  coversViewport: boolean;
  intervals: Array<{ startBp: number; endBp: number; binSize: number }>;
  gaps: Array<{ startBp: number; endBp: number }>;
} {
  const required = Math.max(0, view.globalEnd - view.globalStart);
  if (required === 0) {
    return { coveredFraction: 0, coversViewport: false, intervals: [], gaps: [] };
  }
  const intervals = slices
    .map((slice) => ({
      startBp: Math.max(view.globalStart, slice.globalStart),
      endBp: Math.min(view.globalEnd, slice.globalEnd),
      binSize: slice.binSize,
    }))
    .filter((interval) => interval.endBp > interval.startBp)
    .sort((a, b) => a.startBp - b.startBp || a.endBp - b.endBp);

  let covered = 0;
  let cursorStart: number | null = null;
  let cursorEnd = 0;
  const gaps: Array<{ startBp: number; endBp: number }> = [];
  for (const interval of intervals) {
    if (cursorStart === null) {
      if (interval.startBp > view.globalStart) {
        gaps.push({ startBp: view.globalStart, endBp: interval.startBp });
      }
      cursorStart = interval.startBp;
      cursorEnd = interval.endBp;
      continue;
    }
    if (interval.startBp <= cursorEnd) {
      cursorEnd = Math.max(cursorEnd, interval.endBp);
      continue;
    }
    covered += cursorEnd - cursorStart;
    gaps.push({ startBp: cursorEnd, endBp: interval.startBp });
    cursorStart = interval.startBp;
    cursorEnd = interval.endBp;
  }
  if (cursorStart !== null) covered += cursorEnd - cursorStart;
  if (cursorStart === null) {
    gaps.push({ startBp: view.globalStart, endBp: view.globalEnd });
  } else if (cursorEnd < view.globalEnd) {
    gaps.push({ startBp: cursorEnd, endBp: view.globalEnd });
  }
  const coveredFraction = covered / required;
  return {
    coveredFraction,
    coversViewport: coveredFraction >= 0.999,
    intervals,
    gaps,
  };
}

export function rangesViewportStatus(
  ranges: Array<{ globalStart: number; globalEnd: number }>,
  view: Viewport
): {
  coveredFraction: number;
  coversViewport: boolean;
  intervals: Array<{ startBp: number; endBp: number }>;
  gaps: Array<{ startBp: number; endBp: number }>;
} {
  const required = Math.max(0, view.globalEnd - view.globalStart);
  if (required === 0) {
    return { coveredFraction: 0, coversViewport: false, intervals: [], gaps: [] };
  }
  const intervals = ranges
    .map((range) => ({
      startBp: Math.max(view.globalStart, range.globalStart),
      endBp: Math.min(view.globalEnd, range.globalEnd),
    }))
    .filter((interval) => interval.endBp > interval.startBp)
    .sort((a, b) => a.startBp - b.startBp || a.endBp - b.endBp);

  let covered = 0;
  let cursorStart: number | null = null;
  let cursorEnd = 0;
  const gaps: Array<{ startBp: number; endBp: number }> = [];
  for (const interval of intervals) {
    if (cursorStart === null) {
      if (interval.startBp > view.globalStart) {
        gaps.push({ startBp: view.globalStart, endBp: interval.startBp });
      }
      cursorStart = interval.startBp;
      cursorEnd = interval.endBp;
      continue;
    }
    if (interval.startBp <= cursorEnd) {
      cursorEnd = Math.max(cursorEnd, interval.endBp);
      continue;
    }
    covered += cursorEnd - cursorStart;
    gaps.push({ startBp: cursorEnd, endBp: interval.startBp });
    cursorStart = interval.startBp;
    cursorEnd = interval.endBp;
  }
  if (cursorStart !== null) covered += cursorEnd - cursorStart;
  if (cursorStart === null) {
    gaps.push({ startBp: view.globalStart, endBp: view.globalEnd });
  } else if (cursorEnd < view.globalEnd) {
    gaps.push({ startBp: cursorEnd, endBp: view.globalEnd });
  }
  const coveredFraction = covered / required;
  return {
    coveredFraction,
    coversViewport: coveredFraction >= 0.999,
    intervals,
    gaps,
  };
}

export function coverageSignalCoversViewport(
  coverage: CoverageSignal,
  view: Viewport | null
): boolean {
  if (!view) return false;
  return rangeContains(coverageRange(coverage), {
    start: view.globalStart,
    end: view.globalEnd,
  });
}

export function coverageRange(coverage: CoverageSignal): { start: number; end: number } {
  const start = coverage.startBp ?? 0;
  return {
    start,
    end: start + coverage.bins.length * coverage.binSize,
  };
}

export function coverageSpan(coverage: CoverageSignal): number {
  const range = coverageRange(coverage);
  return Math.max(0, range.end - range.start);
}

export function rangeContains(
  outer: { start: number; end: number },
  inner: { start: number; end: number }
): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function chromFromSourceId(sourceId: string): string | null {
  const index = sourceId.indexOf(':');
  if (index < 0) return null;
  return sourceId.slice(index + 1) || null;
}
