import { describe, expect, it } from 'vitest';
import {
  baseLevelForBpPerPx,
  binBp,
  buildAssembly,
  maxLevelForAssembly,
  tileIndex,
  tileSpanBp,
  type Assembly,
  type TileTransport,
} from '@waypoint/genome-renderer';
import { TileEngineDriver, type TileEngineFeed } from './tile-engine-driver';

function humanScaleAssembly(): Assembly {
  return buildAssembly('human-scale', 'human scale', [
    { id: 'chr1', displayName: 'chr1', length: 248_956_422, cytobands: [] },
    { id: 'chr2', displayName: 'chr2', length: 242_193_529, cytobands: [] },
    { id: 'chr3', displayName: 'chr3', length: 198_295_559, cytobands: [] },
    { id: 'chr4', displayName: 'chr4', length: 190_214_555, cytobands: [] },
    { id: 'chr5', displayName: 'chr5', length: 181_538_259, cytobands: [] },
    { id: 'chr6', displayName: 'chr6', length: 170_805_979, cytobands: [] },
    { id: 'chr7', displayName: 'chr7', length: 159_345_973, cytobands: [] },
    { id: 'chr8', displayName: 'chr8', length: 145_138_636, cytobands: [] },
    { id: 'chr9', displayName: 'chr9', length: 138_394_717, cytobands: [] },
    { id: 'chr10', displayName: 'chr10', length: 133_797_422, cytobands: [] },
    { id: 'chr11', displayName: 'chr11', length: 135_086_622, cytobands: [] },
    { id: 'chr12', displayName: 'chr12', length: 133_275_309, cytobands: [] },
    { id: 'chr13', displayName: 'chr13', length: 114_364_328, cytobands: [] },
    { id: 'chr14', displayName: 'chr14', length: 107_043_718, cytobands: [] },
    { id: 'chr15', displayName: 'chr15', length: 101_991_189, cytobands: [] },
    { id: 'chr16', displayName: 'chr16', length: 90_338_345, cytobands: [] },
    { id: 'chr17', displayName: 'chr17', length: 83_257_441, cytobands: [] },
    { id: 'chr18', displayName: 'chr18', length: 80_373_285, cytobands: [] },
    { id: 'chr19', displayName: 'chr19', length: 58_617_616, cytobands: [] },
    { id: 'chr20', displayName: 'chr20', length: 64_444_167, cytobands: [] },
    { id: 'chr21', displayName: 'chr21', length: 46_709_983, cytobands: [] },
    { id: 'chr22', displayName: 'chr22', length: 50_818_468, cytobands: [] },
    { id: 'chrX', displayName: 'chrX', length: 156_040_895, cytobands: [] },
    { id: 'chrY', displayName: 'chrY', length: 57_227_415, cytobands: [] },
  ] as never);
}

function isCoverageRequestKind(kind: Parameters<TileTransport>[0]['kind']): boolean {
  return kind === 'coverage' || kind === 'coverage-assembly';
}

function assemblySegmentBinCount(start: number, end: number, binSize: number): number {
  return Math.max(0, Math.ceil((end - start) / binSize));
}

function fakeTransport(): TileTransport {
  return async (req) => {
    if (req.kind === 'coverage-assembly') {
      const segments = Array.isArray((req.body as { segments?: unknown }).segments)
        ? ((req.body as { segments: Array<Record<string, unknown>> }).segments ?? [])
        : [];
      const binSize = binBp(req.level);
      return {
        ok: true,
        status: 200,
        body: {
          segments: segments.map((segment) => {
            const start = Number(segment.start ?? 0);
            const end = Number(segment.end ?? start + 1024 * binSize);
            const chromGlobalStart = Number(segment.chromGlobalStart ?? 0);
            const binCount = assemblySegmentBinCount(start, end, binSize);
            return {
              chrom: String(segment.chrom ?? 'chrA'),
              start,
              end,
              globalStart: chromGlobalStart + start,
              globalEnd: chromGlobalStart + end,
              bins: new Array(binCount).fill(10),
              binSize,
              maxDepth: 10,
              provenance: { exact: true, method: 'pyramid-maxpool' },
            };
          }),
          maxDepth: 10,
          provenance: { exact: true, method: 'pyramid-maxpool' },
        },
      };
    }
    if (req.kind === 'coverage') {
      return {
        ok: true,
        status: 200,
        body: {
          bins: new Array(1024).fill(10),
          binSize: binBp(req.level),
          maxDepth: 10,
          provenance: { exact: true, method: 'pyramid-maxpool' },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      body: { reads: [], count: 0, start: 0, end: 0 },
    };
  };
}

function emptyCoveragePayloadTransport(): {
  transport: TileTransport;
  setEmptyCoverage: (empty: boolean) => void;
  emptyCoverageAttempts: () => number;
} {
  let emptyCoverage = false;
  let attempts = 0;
  return {
    transport: async (req, signal) => {
      if (isCoverageRequestKind(req.kind) && emptyCoverage) {
        attempts += 1;
        return {
          ok: true,
          status: 200,
          body:
            req.kind === 'coverage-assembly'
              ? {
                  segments: [],
                  maxDepth: 0,
                  provenance: { exact: true, method: 'empty-test' },
                }
              : {
                  bins: [],
                  binSize: binBp(req.level),
                  maxDepth: 0,
                  provenance: { exact: true, method: 'empty-test' },
                },
        };
      }
      return fakeTransport()(req, signal);
    },
    setEmptyCoverage: (empty) => {
      emptyCoverage = empty;
    },
    emptyCoverageAttempts: () => attempts,
  };
}

async function feedFor(
  driver: TileEngineDriver,
  feeds: TileEngineFeed[],
  range: { start: number; end: number },
  px: number
): Promise<TileEngineFeed | undefined> {
  feeds.length = 0;
  driver.setViewport(range, px);
  await flushFeedCycle();
  return feeds.at(-1);
}

async function flushFeedCycle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function manualFrameScheduler(): {
  frameScheduler: {
    request: (callback: FrameRequestCallback) => number;
    cancel: (handle: number) => void;
  };
  flushFrame: () => void;
  pendingCount: () => number;
  canceledCount: () => number;
} {
  let nextHandle = 1;
  let canceled = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    frameScheduler: {
      request: (callback) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancel: (handle) => {
        if (callbacks.delete(handle)) canceled += 1;
      },
    },
    flushFrame: () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(performance.now());
    },
    pendingCount: () => callbacks.size,
    canceledCount: () => canceled,
  };
}

function manualPostPaintScheduler(): {
  settlementScheduler: {
    requestPostPaint: (callback: () => void) => number;
    cancel: (handle: number) => void;
  };
  flushPostPaint: () => void;
  pendingCount: () => number;
} {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  return {
    settlementScheduler: {
      requestPostPaint: (callback) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancel: (handle) => {
        callbacks.delete(handle);
      },
    },
    flushPostPaint: () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback();
    },
    pendingCount: () => callbacks.size,
  };
}

const FULL_AXIS_PRESENTATION_PX = 1338;
const FULL_AXIS_FETCH_PX = FULL_AXIS_PRESENTATION_PX * 2;
const NARRATED_FULL_AXIS_SPANS = [
  3_088_269_832, 2_200_000_000, 1_300_000_000, 500_000_000, 177_000_000, 27_000_000, 200_000,
] as const;

type ExactCoverageInternals = {
  exactCoverageGeneration: number;
  scheduleFeed: () => void;
  exactCoverageTiles: Map<
    string,
    {
      key: { sourceId: string; level: number; index: number };
      slices: Array<{
        globalStart: number;
        globalEnd: number;
        binSize: number;
        payload: {
          bins: number[];
          binSize: number;
          provenance: { exact: true; method: string };
        };
      }>;
      order: number;
    }
  >;
};

function installExactCoverageSurface(
  driver: TileEngineDriver,
  surface: {
    id: string;
    level: number;
    globalStart: number;
    globalEnd: number;
    depth: number;
  }
): void {
  const internals = driver as unknown as ExactCoverageInternals;
  const binSize = binBp(surface.level);
  const binCount = Math.ceil((surface.globalEnd - surface.globalStart) / binSize);
  internals.exactCoverageTiles.set(surface.id, {
    key: { sourceId: 'covasm:/fake.bam', level: surface.level, index: 0 },
    slices: [
      {
        globalStart: surface.globalStart,
        globalEnd: surface.globalEnd,
        binSize,
        payload: {
          bins: new Array(binCount).fill(surface.depth),
          binSize,
          provenance: { exact: true, method: 'full-axis-publication-regression' },
        },
      },
    ],
    order: internals.exactCoverageTiles.size + 1,
  });
  internals.exactCoverageGeneration += 1;
}

function centeredRange(totalLengthBp: number, span: number): { start: number; end: number } {
  const boundedSpan = Math.min(totalLengthBp, span);
  const start = Math.floor((totalLengthBp - boundedSpan) / 2);
  return { start, end: start + boundedSpan };
}

function coverageSignalRange(feed: TileEngineFeed): { start: number; end: number } | null {
  const coverage = feed.coverage;
  if (!coverage || coverage.binSize <= 0 || coverage.bins.length === 0) return null;
  const start = coverage.startBp ?? 0;
  return { start, end: start + coverage.bins.length * coverage.binSize };
}

function visiblePositiveCoverageFraction(
  feed: TileEngineFeed,
  range: { start: number; end: number }
): number {
  const coverage = feed.coverage;
  if (!coverage || coverage.binSize <= 0 || coverage.bins.length === 0) return 0;
  const signalStart = coverage.startBp ?? 0;
  const first = Math.max(0, Math.floor((range.start - signalStart) / coverage.binSize));
  const last = Math.min(
    coverage.bins.length,
    Math.ceil((range.end - signalStart) / coverage.binSize)
  );
  if (last <= first) return 0;
  let positive = 0;
  for (let index = first; index < last; index += 1) {
    if ((coverage.bins[index] ?? 0) > 0) positive += 1;
  }
  return positive / (last - first);
}

function expectDrawableExactFrame(
  feed: TileEngineFeed | undefined,
  range: { start: number; end: number },
  label: string
): void {
  expect(feed?.coverage, `${label}: coverage data exists`).toBeTruthy();
  const signalRange = feed ? coverageSignalRange(feed) : null;
  expect(signalRange, `${label}: coverage has a finite drawable range`).toBeTruthy();
  expect(
    signalRange!.start,
    `${label}: coverage reaches the left viewport edge`
  ).toBeLessThanOrEqual(range.start);
  expect(
    signalRange!.end,
    `${label}: coverage reaches the right viewport edge`
  ).toBeGreaterThanOrEqual(range.end);
  expect(
    visiblePositiveCoverageFraction(feed!, range),
    `${label}: populated synthetic HG002 coverage cannot disappear to zero-height pixels`
  ).toBeGreaterThan(0.99);
  expect(
    feed!.coverage!.provenance?.exact,
    `${label}: the renderer rejects non-exact tile-engine coverage and clears its density mesh`
  ).toBe(true);
  expect(
    feed!.coverageLod,
    `${label}: the signal carries renderer-verifiable LOD metadata`
  ).toMatchObject({
    role: 'current-lod',
    binSize: feed!.coverage!.binSize,
  });
}

function staggeredCoverageTransport(): {
  transport: TileTransport;
  started: Array<{ level: number; index: number }>;
  completed: Array<{ level: number; index: number }>;
} {
  const started: Array<{ level: number; index: number }> = [];
  const completed: Array<{ level: number; index: number }> = [];
  const transport: TileTransport = async (req, signal) => {
    if (!isCoverageRequestKind(req.kind)) return fakeTransport()(req, signal);
    started.push({ level: req.level, index: req.tileIndex });
    const delayMs = 1 + (Math.abs(req.level * 31 + req.tileIndex * 17) % 7);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true }
      );
    });
    const response = await fakeTransport()(req, signal);
    completed.push({ level: req.level, index: req.tileIndex });
    return response;
  };
  return { transport, started, completed };
}

async function settleStaggeredCoverage(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await flushFeedCycle();
}

function fullAxisPanStarts(totalLengthBp: number, span: number, targetTileSpan: number): number[] {
  const maxStart = Math.max(0, totalLengthBp - span);
  if (maxStart === 0) return [0];
  if (maxStart < targetTileSpan * 2) return [0, maxStart];
  const centeredStart = Math.floor(maxStart / 2);
  const start = Math.max(0, Math.min(centeredStart, maxStart - targetTileSpan * 3.25));
  return [
    start,
    Math.min(maxStart, Math.floor(start + targetTileSpan * 1.05)),
    Math.min(maxStart, Math.floor(start + targetTileSpan * 2.1)),
    Math.min(maxStart, Math.floor(start + targetTileSpan * 3.15)),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

function publicationDefects(
  feed: TileEngineFeed,
  range: { start: number; end: number },
  label: string
): string[] {
  const defects: string[] = [];
  const signalRange = coverageSignalRange(feed);
  if (!feed.coverage || !signalRange) return [`${label}:blank-or-missing-coverage`];
  if (signalRange.start > range.start || signalRange.end < range.end) {
    defects.push(
      `${label}:partial-signal(${signalRange.start}-${signalRange.end})-for-view(${range.start}-${range.end})`
    );
  }
  const positive = visiblePositiveCoverageFraction(feed, range);
  if (positive < 0.99) defects.push(`${label}:positive-fraction=${positive.toFixed(4)}`);
  if (feed.coverage.provenance?.exact !== true) {
    defects.push(
      `${label}:renderer-rejected-provenance=${JSON.stringify(feed.coverage.provenance ?? null)}`
    );
  }
  if (
    feed.coverageLod?.role !== 'current-lod' ||
    feed.coverageLod.binSize !== feed.coverage.binSize ||
    feed.coverageLod.level !== feed.coverageLod.targetLevel
  ) {
    defects.push(`${label}:unverifiable-lod=${JSON.stringify(feed.coverageLod ?? null)}`);
  }
  const binWidthPx =
    (feed.coverage.binSize * FULL_AXIS_PRESENTATION_PX) / (range.end - range.start);
  if (binWidthPx > 1.001) {
    defects.push(
      `${label}:late-or-wrong-lod(bin=${feed.coverage.binSize},width=${binWidthPx.toFixed(3)}px)`
    );
  }
  return defects;
}

describe('TileEngineDriver pileup publication invariant', () => {
  it('reuses a bp-anchored broad coverage band across pan and zoom without scanning, materializing, or publishing', () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const postPaint = manualPostPaintScheduler();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
      settlementScheduler: postPaint.settlementScheduler,
    } as never);
    installExactCoverageSurface(driver, {
      id: 'broad-L15',
      level: 15,
      globalStart: 0,
      globalEnd: assembly.totalLengthBp,
      depth: 10,
    });
    const first = centeredRange(assembly.totalLengthBp, 500_000_000);
    expect(driver.presentViewport(first, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX)).toBe(true);
    const initialFeed = feeds.at(-1);
    const before = driver.debugSnapshot().coverageMemo;

    const gestures = [
      { start: first.start + 20_000_000, end: first.end + 20_000_000 },
      { start: first.start + 45_000_000, end: first.end - 5_000_000 },
      { start: first.start + 70_000_000, end: first.end - 30_000_000 },
    ];
    for (const range of gestures) {
      expect(
        driver.presentViewport(range, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX),
        'every camera lies inside the resident bp band'
      ).toBe(true);
      const binWidthPx =
        (initialFeed!.coverage!.binSize * FULL_AXIS_PRESENTATION_PX) / (range.end - range.start);
      expect(binWidthPx, 'reused band remains subpixel at every camera').toBeLessThanOrEqual(1);
    }

    const after = driver.debugSnapshot().coverageMemo;
    expect(after.exactCoverageRecordScanCount).toBe(before.exactCoverageRecordScanCount);
    expect(after.materializeCount).toBe(before.materializeCount);
    expect(after.revisionChangeCount).toBe(before.revisionChangeCount);
    expect(feeds, 'camera-only motion reuses renderer-resident data').toHaveLength(1);

    const activeRange = gestures.at(-1)!;
    installExactCoverageSurface(driver, {
      id: 'incomplete-L14',
      level: 14,
      globalStart: activeRange.start,
      globalEnd: activeRange.start + 10_000_000,
      depth: 31,
    });
    (driver as unknown as ExactCoverageInternals).scheduleFeed();
    postPaint.flushPostPaint();

    const afterPatch = driver.debugSnapshot().coverageMemo;
    expect(afterPatch.materializeCount).toBe(after.materializeCount);
    expect(afterPatch.revisionChangeCount).toBe(after.revisionChangeCount);
    expect(
      feeds,
      'an overlapping finer patch remains invisible until that authority covers the viewport'
    ).toHaveLength(1);

    (driver as unknown as ExactCoverageInternals).exactCoverageTiles.delete('incomplete-L14');
    installExactCoverageSurface(driver, {
      id: 'complete-L14',
      level: 14,
      globalStart: activeRange.start,
      globalEnd: activeRange.end,
      depth: 47,
    });
    (driver as unknown as ExactCoverageInternals).scheduleFeed();
    postPaint.flushPostPaint();

    const afterComplete = driver.debugSnapshot().coverageMemo;
    expect(afterComplete.materializeCount).toBe(after.materializeCount + 1);
    expect(afterComplete.revisionChangeCount).toBe(after.revisionChangeCount + 1);
    expect(feeds, 'the complete finer authority publishes as one atomic replacement').toHaveLength(
      2
    );
    expect(
      (feeds.at(-1)!.coverage!.binSize * FULL_AXIS_PRESENTATION_PX) /
        (activeRange.end - activeRange.start)
    ).toBeLessThanOrEqual(1);
    driver.dispose();
  });

  it('reuses a bp-anchored coverage band during ordinary histogram-LOD side-pan', () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const first = centeredRange(assembly.totalLengthBp, 5_000_000);
    installExactCoverageSurface(driver, {
      id: 'ordinary-L10',
      level: 10,
      globalStart: first.start - 40_000_000,
      globalEnd: first.end + 40_000_000,
      depth: 10,
    });

    expect(driver.presentViewport(first, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX)).toBe(true);
    const initialFeed = feeds.at(-1);
    expectDrawableExactFrame(initialFeed, first, 'initial 5 Mb histogram frame');
    const initialSignalRange = coverageSignalRange(initialFeed!);
    expect(
      initialSignalRange!.end - initialSignalRange!.start,
      'ordinary histogram coverage is retained beyond the live camera'
    ).toBeGreaterThan(first.end - first.start);
    const before = driver.debugSnapshot().coverageMemo;

    const gestures = [250_000, 500_000, 750_000].map((delta) => ({
      start: first.start + delta,
      end: first.end + delta,
    }));
    for (const range of gestures) {
      expect(driver.presentViewport(range, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX)).toBe(
        true
      );
      expect(
        coverageSignalRange(initialFeed!)!.start,
        'the retained signal reaches every panned viewport left edge'
      ).toBeLessThanOrEqual(range.start);
      expect(
        coverageSignalRange(initialFeed!)!.end,
        'the retained signal reaches every panned viewport right edge'
      ).toBeGreaterThanOrEqual(range.end);
    }

    const after = driver.debugSnapshot().coverageMemo;
    expect(after.exactCoverageGeneration).toBe(before.exactCoverageGeneration);
    expect(after.exactCoverageRecordScanCount).toBe(before.exactCoverageRecordScanCount);
    expect(after.materializeCount).toBe(before.materializeCount);
    expect(after.revisionChangeCount).toBe(before.revisionChangeCount);
    expect(after.lastRevision).toBe(before.lastRevision);
    expect(feeds, 'camera-only 5 Mb motion reuses one immutable renderer publication').toHaveLength(
      1
    );
    driver.dispose();
  });

  it('queues exact-tile settlement work strictly on the injected post-paint boundary', () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const postPaint = manualPostPaintScheduler();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
      settlementScheduler: postPaint.settlementScheduler,
    } as never);
    const range = centeredRange(assembly.totalLengthBp, 500_000_000);
    installExactCoverageSurface(driver, {
      id: 'visible-L15',
      level: 15,
      globalStart: range.start,
      globalEnd: range.end,
      depth: 10,
    });
    driver.presentViewport(range, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);
    const before = driver.debugSnapshot().coverageMemo;

    installExactCoverageSurface(driver, {
      id: 'visible-L15',
      level: 15,
      globalStart: range.start,
      globalEnd: range.end,
      depth: 31,
    });
    (driver as unknown as ExactCoverageInternals).scheduleFeed();

    expect(postPaint.pendingCount()).toBe(1);
    expect(
      driver.debugSnapshot().coverageMemo.materializeCount,
      'input and rAF pre-paint work remain untouched while settlement is queued'
    ).toBe(before.materializeCount);
    expect(feeds).toHaveLength(1);

    postPaint.flushPostPaint();
    expect(driver.debugSnapshot().coverageMemo.materializeCount).toBe(before.materializeCount + 1);
    expect(feeds).toHaveLength(2);
    driver.dispose();
  });

  it('coalesces settlements from separate tasks into one animation-frame publication and cancels disposal work', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const frames = manualFrameScheduler();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
      frameScheduler: frames.frameScheduler,
    } as never);
    const range = centeredRange(assembly.totalLengthBp, 27_000_000);
    installExactCoverageSurface(driver, {
      id: 'visible-L14',
      level: 14,
      globalStart: range.start,
      globalEnd: range.end,
      depth: 10,
    });
    driver.presentViewport(range, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);
    const before = driver.debugSnapshot().coverageMemo;
    const publishedBefore = feeds.length;
    const internals = driver as unknown as ExactCoverageInternals;

    installExactCoverageSurface(driver, {
      id: 'visible-L14',
      level: 14,
      globalStart: range.start,
      globalEnd: range.end,
      depth: 23,
    });
    internals.scheduleFeed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    installExactCoverageSurface(driver, {
      id: 'visible-L14',
      level: 14,
      globalStart: range.start,
      globalEnd: range.end,
      depth: 47,
    });
    internals.scheduleFeed();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frames.pendingCount(), 'both settlement tasks share one pending frame').toBe(1);
    expect(driver.debugSnapshot().coverageMemo.materializeCount).toBe(before.materializeCount);
    expect(feeds.length).toBe(publishedBefore);

    frames.flushFrame();
    const afterFrame = driver.debugSnapshot().coverageMemo;
    expect(afterFrame.materializeCount).toBe(before.materializeCount + 1);
    expect(afterFrame.revisionChangeCount).toBe(before.revisionChangeCount + 1);
    expect(feeds.length, 'the frame publishes only the latest settled union').toBe(
      publishedBefore + 1
    );
    expect(feeds.at(-1)?.coverage?.bins.every((value) => value === 47)).toBe(true);

    installExactCoverageSurface(driver, {
      id: 'visible-L14',
      level: 14,
      globalStart: range.start,
      globalEnd: range.end,
      depth: 91,
    });
    internals.scheduleFeed();
    expect(frames.pendingCount()).toBe(1);
    driver.dispose();
    expect(frames.pendingCount(), 'dispose removes the pending frame callback').toBe(0);
    expect(frames.canceledCount()).toBe(1);
    frames.flushFrame();
    expect(feeds.length, 'disposed drivers cannot publish a queued settlement').toBe(
      publishedBefore + 1
    );
  });

  it('does not rematerialize, revise, or publish the visible histogram when an off-viewport exact tile arrives', () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const frames = manualFrameScheduler();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
      frameScheduler: frames.frameScheduler,
    } as never);
    const range = centeredRange(assembly.totalLengthBp, 27_000_000);
    installExactCoverageSurface(driver, {
      id: 'visible-L14',
      level: 14,
      globalStart: range.start,
      globalEnd: range.end,
      depth: 10,
    });
    driver.presentViewport(range, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);

    const before = driver.debugSnapshot().coverageMemo;
    const publishedBefore = feeds.length;
    const visibleBefore = feeds.at(-1)?.coverage;
    expect(visibleBefore, 'sanity: the fixed viewport has a drawable exact histogram').toBeTruthy();

    installExactCoverageSurface(driver, {
      id: 'offscreen-L14',
      level: 14,
      globalStart: 0,
      globalEnd: tileSpanBp(14),
      depth: 99,
    });
    const internals = driver as unknown as ExactCoverageInternals;
    internals.scheduleFeed();
    frames.flushFrame();

    const after = driver.debugSnapshot().coverageMemo;
    expect(
      after.exactCoverageGeneration,
      'sanity: an exact payload really did settle into the driver store'
    ).toBe(before.exactCoverageGeneration + 1);
    expect(after.materializeCount).toBe(before.materializeCount);
    expect(after.revisionChangeCount).toBe(before.revisionChangeCount);
    expect(after.lastRevision).toBe(before.lastRevision);
    expect(
      feeds.length,
      'an offscreen cache settlement has no visible authority and must not republish the histogram'
    ).toBe(publishedBefore);
    expect(feeds.at(-1)?.coverage).toBe(visibleBefore);

    installExactCoverageSurface(driver, {
      id: 'visible-L14',
      level: 14,
      globalStart: range.start,
      globalEnd: range.end,
      depth: 37,
    });
    internals.scheduleFeed();
    frames.flushFrame();

    const afterVisibleArrival = driver.debugSnapshot().coverageMemo;
    expect(
      afterVisibleArrival.materializeCount,
      'control: replacing an overlapping payload must still materialize the visible histogram'
    ).toBe(after.materializeCount + 1);
    expect(afterVisibleArrival.revisionChangeCount).toBe(after.revisionChangeCount + 1);
    expect(afterVisibleArrival.lastRevision).not.toBe(after.lastRevision);
    expect(feeds.length, 'control: a visible settlement still publishes').toBe(publishedBefore + 1);
    expect(feeds.at(-1)?.coverage?.bins.every((value) => value === 37)).toBe(true);
    driver.dispose();
  });

  it('does not publish an empty histogram feed when target coverage completes without a drawable surface', async () => {
    const feeds: TileEngineFeed[] = [];
    const empty = emptyCoveragePayloadTransport();
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: empty.transport,
    } as never);

    const fullGenome = await feedFor(
      driver,
      feeds,
      { start: 0, end: assembly.totalLengthBp },
      2676
    );
    expect(fullGenome?.coverage, 'sanity: an existing drawable histogram is resident').toBeTruthy();

    feeds.length = 0;
    empty.setEmptyCoverage(true);
    driver.setViewport(centeredRange(assembly.totalLengthBp, 27_000_000), 2676);
    await flushFeedCycle();

    expect(
      empty.emptyCoverageAttempts(),
      'sanity: the target coverage request completed with a non-drawable payload'
    ).toBeGreaterThan(0);
    expect(
      feeds.some((feed) => !feed.coverage && feed.records.length === 0),
      'a non-drawable target payload is not authority to clear the current pileup surface'
    ).toBe(false);

    driver.dispose();
  });

  it.each([
    { span: 27_000_000, partialLevel: 13 },
    { span: 200_000, partialLevel: 6 },
  ])(
    'never publishes the renderer-rejected mixed surface that makes populated full-axis coverage pop out at $span bp',
    ({ span, partialLevel }) => {
      const feeds: TileEngineFeed[] = [];
      const assembly = humanScaleAssembly();
      const driver = new TileEngineDriver({
        assembly,
        source: { bamPath: '/fake.bam' },
        baseUrl: 'http://sidecar',
        onFeed: (feed) => feeds.push(feed),
        transport: fakeTransport(),
      } as never);
      const range = centeredRange(assembly.totalLengthBp, span);

      installExactCoverageSurface(driver, {
        id: 'complete-presentation-floor',
        level: partialLevel + 1,
        globalStart: range.start,
        globalEnd: range.end,
        depth: 10,
      });
      driver.presentViewport(range, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);
      expectDrawableExactFrame(
        feeds.at(-1),
        range,
        `${span.toLocaleString()}bp complete presentation floor`
      );
      const fineTileSpan = tileSpanBp(partialLevel);
      const fineTileStart = tileIndex((range.start + range.end) / 2, partialLevel) * fineTileSpan;
      installExactCoverageSurface(driver, {
        id: `partial-fine-L${partialLevel}`,
        level: partialLevel,
        globalStart: fineTileStart,
        globalEnd: Math.min(assembly.totalLengthBp, fineTileStart + fineTileSpan),
        depth: 37,
      });

      driver.presentViewport(range, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);
      const published = feeds.at(-1);

      expectDrawableExactFrame(
        published,
        range,
        `${span.toLocaleString()}bp partial-fine-tile publication`
      );
      driver.dispose();
    }
  );

  it('keeps the prior exact frame when no complete <=1px source grid exists yet', () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    installExactCoverageSurface(driver, {
      id: 'whole-genome-exact',
      level: 21,
      globalStart: 0,
      globalEnd: assembly.totalLengthBp,
      depth: 10,
    });
    const wholeGenome = { start: 0, end: assembly.totalLengthBp };
    driver.presentViewport(wholeGenome, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);
    expectDrawableExactFrame(feeds.at(-1), wholeGenome, 'prior whole-genome frame');

    const range = centeredRange(assembly.totalLengthBp, 27_000_000);
    const partialLevel = 14;
    const partialStart =
      tileIndex((range.start + range.end) / 2, partialLevel) * tileSpanBp(partialLevel);
    installExactCoverageSurface(driver, {
      id: 'partial-finer-only',
      level: partialLevel,
      globalStart: partialStart,
      globalEnd: partialStart + tileSpanBp(partialLevel),
      depth: 37,
    });
    feeds.length = 0;
    driver.presentViewport(range, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);

    expect(
      feeds,
      'a partial fine tile plus a >1px broad fallback has no authority to replace the prior exact frame'
    ).toEqual([]);
    driver.dispose();
  });

  it('replays the exact narrated full-axis ladder and multi-tile side-scrolls without one blank, renderer-rejected, or >1px LOD frame', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const tracked = staggeredCoverageTransport();
    let activeRange = { start: 0, end: assembly.totalLengthBp };
    const feedEvents: Array<{ feed: TileEngineFeed; range: { start: number; end: number } }> = [];
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => {
        feeds.push(feed);
        feedEvents.push({ feed, range: { ...activeRange } });
      },
      transport: tracked.transport,
    } as never);

    driver.setViewport(activeRange, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);
    await settleStaggeredCoverage(140);
    expectDrawableExactFrame(feeds.at(-1), activeRange, '3,088,269,832bp settled start');

    const defects: string[] = [];
    const tileTraversal: Array<{
      span: number;
      level: number;
      tileSpan: number;
      panStarts: number[];
      requestedIndexes: number[];
      completedIndexes: number[];
      broadTraversalLimitation: string | null;
    }> = [];

    for (const span of NARRATED_FULL_AXIS_SPANS.slice(1)) {
      const targetLevel = baseLevelForBpPerPx(
        span / FULL_AXIS_FETCH_PX,
        maxLevelForAssembly(assembly)
      );
      const targetTileSpan = tileSpanBp(targetLevel);
      const panStarts = fullAxisPanStarts(assembly.totalLengthBp, span, targetTileSpan);
      const phaseEventStart = feedEvents.length;
      const requestStart = tracked.started.length;
      const completionStart = tracked.completed.length;

      const previousSpan = activeRange.end - activeRange.start;
      for (let frame = 1; frame <= 12; frame += 1) {
        const t = frame / 12;
        const interpolatedSpan = Math.round(
          Math.exp(Math.log(previousSpan) + (Math.log(span) - Math.log(previousSpan)) * t)
        );
        activeRange = centeredRange(assembly.totalLengthBp, interpolatedSpan);
        driver.presentViewport(activeRange, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);
      }

      for (const start of panStarts) {
        activeRange = { start, end: start + span };
        driver.setViewport(activeRange, FULL_AXIS_FETCH_PX, FULL_AXIS_PRESENTATION_PX);
        await settleStaggeredCoverage();
      }

      for (const event of feedEvents.slice(phaseEventStart)) {
        defects.push(
          ...publicationDefects(
            event.feed,
            event.range,
            `${span.toLocaleString()}bp feed#${feedEvents.indexOf(event) + 1}`
          )
        );
      }

      const requestedIndexes = [
        ...new Set(
          tracked.started
            .slice(requestStart)
            .filter((event) => event.level === targetLevel)
            .map((event) => event.index)
        ),
      ].sort((a, b) => a - b);
      const completedIndexes = [
        ...new Set(
          tracked.completed
            .slice(completionStart)
            .filter((event) => event.level === targetLevel)
            .map((event) => event.index)
        ),
      ].sort((a, b) => a - b);
      const availablePanBp = assembly.totalLengthBp - span;
      const broadTraversalLimitation =
        availablePanBp < targetTileSpan * 2
          ? `assembly permits only ${(availablePanBp / targetTileSpan).toFixed(3)} target-tile spans of pan`
          : null;
      tileTraversal.push({
        span,
        level: targetLevel,
        tileSpan: targetTileSpan,
        panStarts,
        requestedIndexes,
        completedIndexes,
        broadTraversalLimitation,
      });
    }

    driver.dispose();
    expect(
      defects,
      `every publication from the narrated full-axis zoom/pan schedule must remain drawable and at the correct LOD; tile traversal=${JSON.stringify(
        tileTraversal
      )}`
    ).toEqual([]);
  }, 30_000);

  it.each(NARRATED_FULL_AXIS_SPANS.slice(1))(
    'qualifies the side-scroll schedule against real target-tile requests at %s bp',
    async (span) => {
      const assembly = humanScaleAssembly();
      const targetLevel = baseLevelForBpPerPx(
        span / FULL_AXIS_FETCH_PX,
        maxLevelForAssembly(assembly)
      );
      const targetTileSpan = tileSpanBp(targetLevel);
      const availablePanBp = assembly.totalLengthBp - span;
      const panStarts = fullAxisPanStarts(assembly.totalLengthBp, span, targetTileSpan);
      const spatialSets = panStarts.map((start) => {
        const first = tileIndex(start, targetLevel);
        const last = tileIndex(start + span - 1, targetLevel);
        return new Set(Array.from({ length: last - first + 1 }, (_, offset) => first + offset));
      });
      const initial = spatialSets[0] ?? new Set<number>();
      const entered = new Set<number>();
      for (const current of spatialSets.slice(1)) {
        for (const index of current) if (!initial.has(index)) entered.add(index);
      }

      if (availablePanBp < targetTileSpan * 2) {
        expect(
          availablePanBp / targetTileSpan,
          'the broad-view exception must be derived from finite assembly geometry'
        ).toBeLessThan(2);
        expect(entered.size, 'the receipt must not invent unseen target tiles').toBeLessThan(2);
        return;
      }

      expect(
        entered.size,
        `the pan path must enter at least two new L${targetLevel} identities; starts=${JSON.stringify(
          panStarts
        )}`
      ).toBeGreaterThanOrEqual(2);

      const tracked = staggeredCoverageTransport();
      const driver = new TileEngineDriver({
        assembly,
        source: { bamPath: '/fake.bam' },
        baseUrl: 'http://sidecar',
        onFeed: () => {},
        transport: tracked.transport,
      } as never);
      try {
        driver.setViewport(
          { start: panStarts[0], end: panStarts[0] + span },
          FULL_AXIS_FETCH_PX,
          FULL_AXIS_PRESENTATION_PX
        );
        await settleStaggeredCoverage();
        const completionBoundary = tracked.completed.length;

        for (const start of panStarts.slice(1)) {
          driver.setViewport(
            { start, end: start + span },
            FULL_AXIS_FETCH_PX,
            FULL_AXIS_PRESENTATION_PX
          );
          await settleStaggeredCoverage();
        }

        const phaseCompletions = new Set(
          tracked.completed
            .filter((event) => event.level === targetLevel)
            .map((event) => event.index)
        );
        expect(
          phaseCompletions.size,
          `a fresh driver must complete multiple exact L${targetLevel} payloads for this spatial schedule`
        ).toBeGreaterThanOrEqual(2);

        if (targetLevel < 15) {
          const panCompletions = new Set(
            tracked.completed
              .slice(completionBoundary)
              .filter((event) => event.level === targetLevel)
              .map((event) => event.index)
          );
          expect(
            panCompletions.size,
            `fine L${targetLevel} side-scroll must complete at least two new target tiles after the initial viewport`
          ).toBeGreaterThanOrEqual(2);
        }
      } finally {
        driver.dispose();
      }
    },
    30_000
  );
});
