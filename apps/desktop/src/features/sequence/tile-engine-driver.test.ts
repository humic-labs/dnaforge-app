import { describe, expect, it, vi } from 'vitest';
import {
  buildAssembly,
  binBp,
  maxBoundedForegroundCoverageLevel,
  maxLevelForAssembly,
  TileCache,
  tileIndex,
  tileSpanBp,
  type Assembly,
  type TileData,
  type TileEntry,
  type TileKey,
  type TileTransport,
} from '@waypoint/genome-renderer';
import {
  TileEngineDriver,
  limitConcurrency,
  readForcedCoverageLevelForTestBridge,
  type TileEngineFeed,
} from './tile-engine-driver';

function twoChromAssembly(): Assembly {
  return buildAssembly('chrA+chrB', 'chrA, chrB', [
    { id: 'chrA', displayName: 'chrA', length: 5_000_000, cytobands: [] },
    { id: 'chrB', displayName: 'chrB', length: 5_000_000, cytobands: [] },
  ] as never);
}

function lateChromAssembly(): Assembly {
  return buildAssembly('late-chrom', 'late chrom', [
    { id: 'chr1', displayName: 'chr1', length: 1_500_000_000, cytobands: [] },
    { id: 'chrTail', displayName: 'chrTail', length: 5_000_000, cytobands: [] },
  ] as never);
}

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
          level: req.level,
          tileIndex: req.tileIndex,
        },
      };
    }
    if (req.kind === 'coverage') {
      const bins = new Array(1024).fill(10);
      return {
        ok: true,
        status: 200,
        body: {
          bins,
          binSize: binBp(req.level),
          maxDepth: 10,
          provenance: { exact: true, method: 'pyramid-maxpool' },
          level: req.level,
          tileIndex: req.tileIndex,
        },
      };
    }
    if (req.kind === 'alignment') {
      const chromGlobalStart = Number(
        (req.body as { chromGlobalStart?: number } | undefined)?.chromGlobalStart ?? 0
      );
      const localTileStart = req.tileIndex * tileSpanBp(req.level) - chromGlobalStart;
      const reads = [
        {
          start: localTileStart + 100,
          end: localTileStart + 250,
          strand: '+' as const,
          mapq: 60,
          readId: `r${req.tileIndex}`,
        },
      ];
      return {
        ok: true,
        status: 200,
        body: { reads, count: 1, level: req.level, tileIndex: req.tileIndex },
      };
    }
    return { ok: true, status: 200, body: {} };
  };
}

function alternateColumnTransport(): TileTransport {
  const base = fakeTransport();
  return async (req, signal) => {
    const response = await base(req, signal);
    if (req.kind !== 'alignment') return response;
    const chromGlobalStart = Number(
      (req.body as { chromGlobalStart?: number } | undefined)?.chromGlobalStart ?? 0
    );
    const localTileStart = req.tileIndex * tileSpanBp(req.level) - chromGlobalStart;
    return {
      ...response,
      body: {
        ...(response.body as Record<string, unknown>),
        alternateColumns: [
          {
            pos: localTileStart + 37,
            kind: 'sub',
            length: 1,
            refBase: 'C',
            readBase: 'T',
            coveringReadCount: 42,
            supportingReadCount: 17,
            weightedDepth: 1_220,
            weightedSupport: 510,
            weightedFraction: 510 / 1_220,
          },
        ],
      },
    };
  };
}

function truncatedReadTransport(): TileTransport {
  const base = fakeTransport();
  return async (req) => {
    const response = await base(req);
    if (req.kind !== 'alignment') return response;
    return {
      ...response,
      body: {
        ...(response.body as Record<string, unknown>),
        truncated: true,
      },
    };
  };
}

function seamDuplicateTransport(): TileTransport {
  const base = fakeTransport();
  return async (req) => {
    if (req.kind !== 'alignment') return base(req);
    const span = 1024 * binBp(req.level);
    const chromGlobalStart = Number(
      (req.body as { chromGlobalStart?: number } | undefined)?.chromGlobalStart ?? 0
    );
    const localTileStart = req.tileIndex * span - chromGlobalStart;
    const reads = [
      {
        start: localTileStart - 75,
        end: localTileStart + 75,
        strand: '+' as const,
        mapq: 60,
        readId: `seam-${req.tileIndex - 1}`,
      },
      {
        start: localTileStart + 100,
        end: localTileStart + 250,
        strand: '+' as const,
        mapq: 60,
        readId: `owned-${req.tileIndex}`,
      },
      {
        start: localTileStart + span - 75,
        end: localTileStart + span + 75,
        strand: '+' as const,
        mapq: 60,
        readId: `seam-${req.tileIndex}`,
      },
    ];
    return {
      ok: true,
      status: 200,
      body: { reads, count: reads.length, level: req.level, tileIndex: req.tileIndex },
    };
  };
}

function positionAwareFakeTransport(): TileTransport {
  return async (req) => {
    if (req.kind === 'coverage-assembly') {
      const binSize = binBp(req.level);
      const segments = Array.isArray((req.body as { segments?: unknown }).segments)
        ? ((req.body as { segments: Array<Record<string, unknown>> }).segments ?? [])
        : [];
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
              bins: Array.from({ length: binCount }, (_, i) => (i % 17) + 1),
              binSize,
              maxDepth: 17,
              provenance: { exact: true, method: 'pyramid-maxpool' },
            };
          }),
          maxDepth: 17,
          provenance: { exact: true, method: 'pyramid-maxpool' },
          level: req.level,
          tileIndex: req.tileIndex,
        },
      };
    }
    if (req.kind === 'coverage') {
      const binSize = binBp(req.level);
      const span = 1024 * binSize;
      const chromGlobalStart = Number(req.body.chromGlobalStart ?? 0);
      const localStart = Math.max(0, req.tileIndex * span - chromGlobalStart);
      const bins = Array.from({ length: 1024 }, (_, i) => (i % 17) + 1);
      return {
        ok: true,
        status: 200,
        body: {
          bins,
          binSize,
          maxDepth: 17,
          provenance: { exact: true, method: 'pyramid-maxpool' },
          level: req.level,
          tileIndex: req.tileIndex,
          start: localStart,
          end: localStart + span,
        },
      };
    }
    return fakeTransport()(req, new AbortController().signal);
  };
}

function zeroInFirstHalfCoverageTransport(): TileTransport {
  return async (req) => {
    if (req.kind === 'coverage-assembly') {
      const binSize = binBp(req.level);
      const segments = Array.isArray((req.body as { segments?: unknown }).segments)
        ? ((req.body as { segments: Array<Record<string, unknown>> }).segments ?? [])
        : [];
      return {
        ok: true,
        status: 200,
        body: {
          segments: segments.map((segment) => {
            const start = Number(segment.start ?? 0);
            const end = Number(segment.end ?? start + 1024 * binSize);
            const chromGlobalStart = Number(segment.chromGlobalStart ?? 0);
            const binCount = assemblySegmentBinCount(start, end, binSize);
            const bins = Array.from({ length: binCount }, (_, i) =>
              i < Math.ceil(binCount / 2) ? 0 : 11
            );
            return {
              chrom: String(segment.chrom ?? 'chrA'),
              start,
              end,
              globalStart: chromGlobalStart + start,
              globalEnd: chromGlobalStart + end,
              bins,
              binSize,
              maxDepth: 11,
              provenance: { exact: true, method: 'pyramid-maxpool' },
            };
          }),
          maxDepth: 11,
          provenance: { exact: true, method: 'pyramid-maxpool' },
          level: req.level,
          tileIndex: req.tileIndex,
        },
      };
    }
    return fakeTransport()(req, new AbortController().signal);
  };
}

function offscreenPeakCoverageTransport(peak: { start: number; end: number }): TileTransport {
  const valueForGlobalRange = (start: number, end: number): number =>
    end > peak.start && start < peak.end ? 1000 : 10;
  return async (req, signal) => {
    if (req.kind === 'coverage-assembly') {
      const binSize = binBp(req.level);
      const segments = Array.isArray((req.body as { segments?: unknown }).segments)
        ? ((req.body as { segments: Array<Record<string, unknown>> }).segments ?? [])
        : [];
      return {
        ok: true,
        status: 200,
        body: {
          segments: segments.map((segment) => {
            const start = Number(segment.start ?? 0);
            const end = Number(segment.end ?? start + 1024 * binSize);
            const chromGlobalStart = Number(segment.chromGlobalStart ?? 0);
            const binCount = assemblySegmentBinCount(start, end, binSize);
            const bins = Array.from({ length: binCount }, (_, i) => {
              const binStart = chromGlobalStart + start + i * binSize;
              return valueForGlobalRange(binStart, binStart + binSize);
            });
            return {
              chrom: String(segment.chrom ?? 'chrA'),
              start,
              end,
              globalStart: chromGlobalStart + start,
              globalEnd: chromGlobalStart + end,
              bins,
              binSize,
              maxDepth: Math.max(...bins),
              provenance: { exact: true, method: 'pyramid-maxpool' },
            };
          }),
          maxDepth: 1000,
          provenance: { exact: true, method: 'pyramid-maxpool' },
          level: req.level,
          tileIndex: req.tileIndex,
        },
      };
    }
    if (req.kind === 'coverage') {
      const binSize = binBp(req.level);
      const chromGlobalStart = Number(req.body.chromGlobalStart ?? 0);
      const tileStart = req.tileIndex * 1024 * binSize;
      const localStart = Math.max(0, tileStart - chromGlobalStart);
      const bins = Array.from({ length: 1024 }, (_, i) => {
        const binStart = tileStart + i * binSize;
        return valueForGlobalRange(binStart, binStart + binSize);
      });
      return {
        ok: true,
        status: 200,
        body: {
          bins,
          binSize,
          maxDepth: Math.max(...bins),
          provenance: { exact: true, method: 'pyramid-maxpool' },
          level: req.level,
          tileIndex: req.tileIndex,
          start: localStart,
          end: localStart + 1024 * binSize,
        },
      };
    }
    return fakeTransport()(req, signal);
  };
}

function recordingTransport(requests: Array<Parameters<TileTransport>[0]>): TileTransport {
  return async (req) => {
    requests.push(req);
    return fakeTransport()(req, new AbortController().signal);
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function coverageRequest(
  tileIndex: number,
  level = 10,
  priority?: Parameters<TileTransport>[0]['priority']
): Parameters<TileTransport>[0] {
  return {
    kind: 'coverage',
    sourceId: 'aln:/fake.bam:chrA',
    level,
    tileIndex,
    body: {
      chrom: 'chrA',
      start: tileIndex * 1024,
      end: (tileIndex + 1) * 1024,
      chromGlobalStart: 0,
    },
    priority,
  } as Parameters<TileTransport>[0];
}

function alignmentRequest(
  tileIndex: number,
  level = 0,
  priority?: Parameters<TileTransport>[0]['priority']
): Parameters<TileTransport>[0] {
  return {
    kind: 'alignment',
    sourceId: 'aln:/fake.bam:chrA',
    level,
    tileIndex,
    body: {
      bamPath: '/fake.bam',
      chrom: 'chrA',
      chromGlobalStart: 0,
    },
    priority,
  } as Parameters<TileTransport>[0];
}

function holdCoverageTransport(): {
  transport: TileTransport;
  holdCoverage: (hold: boolean) => void;
  pendingCoverageCount: () => number;
  releaseCoverage: () => void;
} {
  let hold = false;
  const pending: Array<{
    req: Parameters<TileTransport>[0];
    signal: AbortSignal;
    resolve: (value: Awaited<ReturnType<TileTransport>>) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  return {
    transport: (req, signal) => {
      if (!isCoverageRequestKind(req.kind) || !hold) {
        return fakeTransport()(req, signal);
      }
      return new Promise((resolve, reject) => {
        const item = { req, signal, resolve, reject };
        pending.push(item);
        signal.addEventListener(
          'abort',
          () => {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          },
          { once: true }
        );
      });
    },
    holdCoverage: (next) => {
      hold = next;
    },
    pendingCoverageCount: () => pending.length,
    releaseCoverage: () => {
      hold = false;
      const items = pending.splice(0, pending.length);
      for (const item of items) {
        if (item.signal.aborted) continue;
        void fakeTransport()(item.req, item.signal).then(item.resolve, item.reject);
      }
    },
  };
}

function holdCoverageLevelsAtOrBelowTransport(maxHeldLevel: number): {
  transport: TileTransport;
  holdCoverage: (hold: boolean) => void;
  pendingCoverageCount: () => number;
  pendingCoverageLevels: () => number[];
  releaseCoverage: () => void;
} {
  let hold = false;
  const pending: Array<{
    req: Parameters<TileTransport>[0];
    signal: AbortSignal;
    resolve: (value: Awaited<ReturnType<TileTransport>>) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  return {
    transport: (req, signal) => {
      if (!isCoverageRequestKind(req.kind) || !hold || req.level > maxHeldLevel) {
        return fakeTransport()(req, signal);
      }
      return new Promise((resolve, reject) => {
        const item = { req, signal, resolve, reject };
        pending.push(item);
        signal.addEventListener(
          'abort',
          () => {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          },
          { once: true }
        );
      });
    },
    holdCoverage: (next) => {
      hold = next;
    },
    pendingCoverageCount: () => pending.length,
    pendingCoverageLevels: () =>
      [...new Set(pending.map((item) => item.req.level))].sort((a, b) => a - b),
    releaseCoverage: () => {
      hold = false;
      const items = pending.splice(0, pending.length);
      for (const item of items) {
        if (item.signal.aborted) continue;
        void fakeTransport()(item.req, item.signal).then(item.resolve, item.reject);
      }
    },
  };
}

function holdAlignmentTransport(): {
  transport: TileTransport;
  pendingAlignmentCount: () => number;
  abortedAlignmentCount: () => number;
  pendingAlignmentKeys: () => string[];
  releaseAlignment: () => void;
} {
  let aborted = 0;
  const pending: Array<{
    req: Parameters<TileTransport>[0];
    signal: AbortSignal;
    resolve: (value: Awaited<ReturnType<TileTransport>>) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  return {
    transport: (req, signal) => {
      if (req.kind !== 'alignment') {
        return fakeTransport()(req, signal);
      }
      return new Promise((resolve, reject) => {
        const item = { req, signal, resolve, reject };
        pending.push(item);
        signal.addEventListener(
          'abort',
          () => {
            aborted += 1;
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          },
          { once: true }
        );
      });
    },
    pendingAlignmentCount: () => pending.length,
    abortedAlignmentCount: () => aborted,
    pendingAlignmentKeys: () =>
      pending.map((item) => `${item.req.level}:${item.req.tileIndex}`).sort(),
    releaseAlignment: () => {
      const items = pending.splice(0, pending.length);
      for (const item of items) {
        if (item.signal.aborted) continue;
        void fakeTransport()(item.req, item.signal).then(item.resolve, item.reject);
      }
    },
  };
}

function holdAlternateColumnAlignmentTransport(): {
  transport: TileTransport;
  pendingAlignmentCount: () => number;
  releaseAlignment: () => void;
} {
  const pending: Array<{
    req: Parameters<TileTransport>[0];
    signal: AbortSignal;
    resolve: (value: Awaited<ReturnType<TileTransport>>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  const releasedTransport = alternateColumnTransport();

  return {
    transport: (req, signal) => {
      if (req.kind !== 'alignment') return fakeTransport()(req, signal);
      return new Promise((resolve, reject) => {
        const item = { req, signal, resolve, reject };
        pending.push(item);
        signal.addEventListener(
          'abort',
          () => {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      });
    },
    pendingAlignmentCount: () => pending.length,
    releaseAlignment: () => {
      const items = pending.splice(0, pending.length);
      for (const item of items) {
        if (item.signal.aborted) continue;
        void releasedTransport(item.req, item.signal).then(item.resolve, item.reject);
      }
    },
  };
}

function holdCalledAlternateColumnTileTransport(
  targetGlobalBp: number,
  targetLevel: number
): {
  transport: TileTransport;
  pendingCalledTileCount: () => number;
  releaseCalledTile: () => void;
} {
  const pending: Array<{
    req: Parameters<TileTransport>[0];
    signal: AbortSignal;
    resolve: (value: Awaited<ReturnType<TileTransport>>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  const emptyTransport = fakeTransport();
  const calledTransport = alternateColumnTransport();

  return {
    transport: (req, signal) => {
      const isCalledTile =
        req.kind === 'alignment' &&
        req.level === targetLevel &&
        req.tileIndex === tileIndex(targetGlobalBp, req.level);
      if (!isCalledTile) return emptyTransport(req, signal);
      return new Promise((resolve, reject) => {
        const item = { req, signal, resolve, reject };
        pending.push(item);
        signal.addEventListener(
          'abort',
          () => {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      });
    },
    pendingCalledTileCount: () => pending.length,
    releaseCalledTile: () => {
      const items = pending.splice(0, pending.length);
      for (const item of items) {
        if (item.signal.aborted) continue;
        void calledTransport(item.req, item.signal).then(item.resolve, item.reject);
      }
    },
  };
}

function holdCoverageTileAtBpTransport(targetGlobalBp: number): {
  transport: TileTransport;
  holdCoverage: (hold: boolean) => void;
  pendingCoverageCount: () => number;
  pendingCoverageLevels: () => number[];
  pendingCoveragePriorities: () => Array<{
    level: number;
    priority: Parameters<TileTransport>[0]['priority'];
  }>;
  releaseCoverage: () => void;
} {
  let hold = true;
  const pending: Array<{
    req: Parameters<TileTransport>[0];
    signal: AbortSignal;
    resolve: (value: Awaited<ReturnType<TileTransport>>) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  return {
    transport: (req, signal) => {
      const targetIndex = tileIndex(targetGlobalBp, req.level);
      if (!isCoverageRequestKind(req.kind) || !hold || req.tileIndex !== targetIndex) {
        return fakeTransport()(req, signal);
      }
      return new Promise((resolve, reject) => {
        const item = { req, signal, resolve, reject };
        pending.push(item);
        signal.addEventListener(
          'abort',
          () => {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          },
          { once: true }
        );
      });
    },
    holdCoverage: (next) => {
      hold = next;
    },
    pendingCoverageCount: () => pending.length,
    pendingCoverageLevels: () =>
      [...new Set(pending.map((item) => item.req.level))].sort((a, b) => a - b),
    pendingCoveragePriorities: () =>
      pending.map((item) => ({ level: item.req.level, priority: item.req.priority })),
    releaseCoverage: () => {
      hold = false;
      const items = pending.splice(0, pending.length);
      for (const item of items) {
        if (item.signal.aborted) continue;
        void fakeTransport()(item.req, item.signal).then(item.resolve, item.reject);
      }
    },
  };
}

function holdCoverageTilesInRangeTransport(
  targetLevel: number,
  targetRange: { start: number; end: number }
): {
  transport: TileTransport;
  pendingCoverageCount: () => number;
  pendingCoverageLevels: () => number[];
  releaseCoverage: () => void;
} {
  let hold = true;
  const pending: Array<{
    req: Parameters<TileTransport>[0];
    signal: AbortSignal;
    resolve: (value: Awaited<ReturnType<TileTransport>>) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  return {
    transport: (req, signal) => {
      const span = tileSpanBp(req.level);
      const tileStart = req.tileIndex * span;
      const tileEnd = tileStart + span;
      const overlapsTarget =
        req.level === targetLevel && tileEnd > targetRange.start && tileStart < targetRange.end;
      if (!isCoverageRequestKind(req.kind) || !hold || !overlapsTarget) {
        return fakeTransport()(req, signal);
      }
      return new Promise((resolve, reject) => {
        const item = { req, signal, resolve, reject };
        pending.push(item);
        signal.addEventListener(
          'abort',
          () => {
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          },
          { once: true }
        );
      });
    },
    pendingCoverageCount: () => pending.length,
    pendingCoverageLevels: () =>
      [...new Set(pending.map((item) => item.req.level))].sort((a, b) => a - b),
    releaseCoverage: () => {
      hold = false;
      const items = pending.splice(0, pending.length);
      for (const item of items) {
        if (item.signal.aborted) continue;
        void fakeTransport()(item.req, item.signal).then(item.resolve, item.reject);
      }
    },
  };
}

function emptyCoverageTilesInRangeTransport(
  targetLevel: number,
  targetRange: { start: number; end: number }
): {
  transport: TileTransport;
  emptyCoverageHits: () => number;
} {
  let emptyHits = 0;
  return {
    transport: async (req, signal) => {
      const span = tileSpanBp(req.level);
      const tileStart = req.tileIndex * span;
      const tileEnd = tileStart + span;
      const overlapsTarget =
        req.level === targetLevel && tileEnd > targetRange.start && tileStart < targetRange.end;
      if (!isCoverageRequestKind(req.kind) || !overlapsTarget) {
        return fakeTransport()(req, signal);
      }
      emptyHits += 1;
      if (req.kind === 'coverage-assembly') {
        return {
          ok: true,
          status: 200,
          body: {
            segments: [],
            maxDepth: 0,
            provenance: { exact: true, method: 'empty-test-target-gap' },
            level: req.level,
            tileIndex: req.tileIndex,
          },
        };
      }
      return {
        ok: true,
        status: 200,
        body: {
          bins: [],
          binSize: binBp(req.level),
          maxDepth: 0,
          provenance: { exact: true, method: 'empty-test-target-gap' },
          level: req.level,
          tileIndex: req.tileIndex,
        },
      };
    },
    emptyCoverageHits: () => emptyHits,
  };
}

function failCoverageTransport(): {
  transport: TileTransport;
  setCoverageFailure: (fail: boolean) => void;
} {
  let fail = false;
  return {
    transport: (req, signal) => {
      if (isCoverageRequestKind(req.kind) && fail) {
        return Promise.resolve({
          ok: false,
          status: 503,
          body: { detail: 'coverage unavailable' },
        });
      }
      return fakeTransport()(req, signal);
    },
    setCoverageFailure: (next) => {
      fail = next;
    },
  };
}

function coverageNotReadyOnceTransport(): {
  transport: TileTransport;
  coverageAttempts: () => number;
} {
  let coverageAttempts = 0;
  return {
    transport: async (req, signal) => {
      if (isCoverageRequestKind(req.kind)) {
        coverageAttempts += 1;
        if (coverageAttempts === 1) {
          return {
            ok: false,
            status: 425,
            body: { detail: 'coverage pyramid is not ready yet' },
          };
        }
      }
      return fakeTransport()(req, signal);
    },
    coverageAttempts: () => coverageAttempts,
  };
}

async function feedFor(
  driver: TileEngineDriver,
  feeds: TileEngineFeed[],
  range: { start: number; end: number },
  px: number,
  presentationPx = px
): Promise<TileEngineFeed | undefined> {
  feeds.length = 0;
  driver.setViewport(range, px, presentationPx);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await waitForFeedFrame();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return feeds.at(-1);
}

async function flushFeedCycle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await waitForFeedFrame();
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function waitForFeedFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function coverageCoversRange(
  coverage: NonNullable<TileEngineFeed['coverage']>,
  range: { start: number; end: number }
): boolean {
  const start = coverage.startBp ?? 0;
  const end = start + coverage.bins.length * coverage.binSize;
  return start <= range.start && end >= range.end;
}

function expectCoverageClearingFeed(feeds: TileEngineFeed[], message: string): void {
  expect(
    feeds.some((feed) => !feed.coverage && !feed.coverageLod && feed.records.length === 0),
    message
  ).toBe(true);
}

function expectNoCoverageClearingFeed(feeds: TileEngineFeed[], message: string): void {
  expect(
    feeds.some((feed) => !feed.coverage && !feed.coverageLod && feed.records.length === 0),
    message
  ).toBe(false);
}

function coverageMaxInRange(
  coverage: NonNullable<TileEngineFeed['coverage']>,
  range: { start: number; end: number }
): number {
  const start = coverage.startBp ?? 0;
  let max = 0;
  for (let i = 0; i < coverage.bins.length; i += 1) {
    const binStart = start + i * coverage.binSize;
    const binEnd = binStart + coverage.binSize;
    if (binEnd <= range.start || binStart >= range.end) continue;
    max = Math.max(max, coverage.bins[i] ?? 0);
  }
  return max;
}

describe('TileEngineDriver  P5 engine-as-data-source)', () => {
  it('enables the coverage fault control in sealed test builds but never production', () => {
    const scope = { __dna708ForceCoverageLevel: 16.4 };
    expect(readForcedCoverageLevelForTestBridge({ DEV: true }, scope)).toBe(16);
    expect(readForcedCoverageLevelForTestBridge({ DEV: false, MODE: 'test' }, scope)).toBe(16);
    expect(
      readForcedCoverageLevelForTestBridge({ DEV: false, MODE: 'production' }, scope)
    ).toBeNull();
  });

  it('reports a current-owner tile failure and retries that unchanged viewport directly', async () => {
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const errors: Array<{ reason: string; sourceId: string }> = [];
    let failFirstCoreAlignment = true;
    const transport: TileTransport = async (request, signal) => {
      requests.push(request);
      if (request.kind === 'alignment' && request.priority?.core && failFirstCoreAlignment) {
        failFirstCoreAlignment = false;
        return { ok: false, status: 429, body: { detail: 'busy' } };
      }
      return fakeTransport()(request, signal);
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/reads.bam', indexPath: '/reads.bam.bai' },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      onTileError: ({ key, reason }) => errors.push({ reason, sourceId: key.sourceId }),
      transport,
    });
    const range = { start: 1_000, end: 2_000 };

    driver.setViewport(range, 1_024);
    await flushFeedCycle();
    expect(errors).toEqual([
      expect.objectContaining({ reason: 'queue-full', sourceId: expect.stringMatching(/^aln:/) }),
    ]);
    const firstAlignmentRequestCount = requests.filter(
      (request) => request.kind === 'alignment'
    ).length;

    driver.setViewport({ start: 1_001, end: 2_001 }, 1_024);
    await flushFeedCycle();
    expect(
      requests.filter((request) => request.kind === 'alignment').length,
      'ordinary camera commits must not bypass the lifecycle retry gate'
    ).toBe(firstAlignmentRequestCount);

    expect(driver.retryCurrentViewport()).toBe(true);
    await flushFeedCycle();
    expect(requests.filter((request) => request.kind === 'alignment').length).toBeGreaterThan(
      firstAlignmentRequestCount
    );
    driver.dispose();
    expect(driver.retryCurrentViewport()).toBe(false);
  });

  it.each(['left', 'right'] as const)(
    'reports a required remote %s collar failure and recovers the complete stationary read band',
    async (side) => {
      const range = { start: 10 * 1024 + 256, end: 12 * 1024 + 256 };
      const failedIndex = side === 'left' ? 9 : 13;
      const requests: Array<Parameters<TileTransport>[0]> = [];
      const errors: Array<{ key: TileKey; reason: string }> = [];
      const feeds: TileEngineFeed[] = [];
      let failCollar = true;
      const transport: TileTransport = async (request, signal) => {
        requests.push(request);
        if (
          request.kind === 'alignment' &&
          request.level === 0 &&
          request.tileIndex === failedIndex &&
          failCollar
        ) {
          expect(request.priority?.core).toBe(false);
          expect(request.priority?.marginDistanceTiles).toBe(1);
          return { ok: false, status: 429, body: { detail: 'controlled collar failure' } };
        }
        return fakeTransport()(request, signal);
      };
      const driver = new TileEngineDriver({
        assembly: twoChromAssembly(),
        source: {
          bamPath: 'http://127.0.0.1:61234/remote/band/alignment.bam',
          remote: {
            locator: {
              contract: 'remote-alignment-locator.v1',
              endpointId: 'band',
              target: 'band',
              alignmentPath: '/reads.bam',
              signalPath: '/signal.bw',
            },
          },
        },
        baseUrl: 'http://sidecar',
        onFeed: (feed: TileEngineFeed) => feeds.push(feed),
        onTileError: (failure: { key: TileKey; reason: string }) => errors.push(failure),
        transport,
      } as never);
      try {
        driver.setViewport(range, 4096);
        await flushFeedCycle();
        expect(driver.debugSnapshot().readComposition).toMatchObject({
          visibleTileCount: 3,
          readyTileCount: 3,
          errorTileCount: 0,
          readyBandTileCount: 4,
          expectedBandTileCount: 5,
          stableBandReady: false,
        });
        expect(feeds.at(-1)?.ownerPresentation?.kind).toBe('reads');
        expect(feeds.at(-1)?.requiredReadBandReady).toBe(false);
        expect(
          errors,
          'the required collar must reach the existing bounded lifecycle recovery'
        ).toEqual([
          {
            key: { sourceId: expect.stringMatching(/^aln:/), level: 0, index: failedIndex },
            reason: 'queue-full',
          },
        ]);
        expect(driver.debugSnapshot().cache.errors).toEqual([
          expect.objectContaining({
            level: 0,
            index: failedIndex,
            reason: 'queue-full',
            requiredByCurrentPlan: true,
            sourceIndex: 0,
          }),
        ]);
        const attempts = requests.filter(
          (r) => r.kind === 'alignment' && r.level === 0 && r.tileIndex === failedIndex
        ).length;
        driver.setViewport(range, 4096);
        await flushFeedCycle();
        expect(
          requests.filter(
            (r) => r.kind === 'alignment' && r.level === 0 && r.tileIndex === failedIndex
          )
        ).toHaveLength(attempts);
        failCollar = false;
        expect(driver.retryCurrentViewport()).toBe(true);
        await flushFeedCycle();
        expect(driver.debugSnapshot().readComposition).toMatchObject({
          readyBandTileCount: 5,
          expectedBandTileCount: 5,
          stableBandReady: true,
        });
        expect(feeds.at(-1)?.requiredReadBandReady).toBe(true);
        expect(driver.debugSnapshot().cache.errors).toHaveLength(0);
        expect(errors).toHaveLength(1);
      } finally {
        driver.dispose();
      }
    }
  );

  it('rejects an unowned same-coordinate error at the real coordinator-to-driver boundary', async () => {
    const errors = vi.fn();
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/current.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      onTileError: errors,
      transport: fakeTransport(),
    });
    try {
      driver.setViewport({ start: 1000, end: 2000 }, 1024);
      await flushFeedCycle();
      const internal = driver as unknown as {
        cache: { set: (entry: TileEntry) => void };
        coordinator: {
          epoch: number;
          onResolve: (
            key: TileKey,
            epoch: number,
            controller: AbortController,
            data: TileData
          ) => void;
        };
      };
      const key = { sourceId: 'aln:/different-generation.bam:chrA', level: 0, index: 1 };
      const controller = new AbortController();
      const epoch = internal.coordinator.epoch;
      internal.cache.set({ key, state: 'pending', epoch, byteSize: 0, abort: controller });
      internal.coordinator.onResolve(key, epoch, controller, {
        key,
        state: 'error',
        count: 0,
        byteSize: 0,
        errorReason: 'queue-full',
      });
      expect(
        errors,
        'a matching coordinate cannot grant a different source ownership of recovery'
      ).not.toHaveBeenCalled();
      expect(driver.debugSnapshot().cache.errors).toEqual([
        expect.objectContaining({
          level: 0,
          index: 1,
          sourceIndex: null,
          reason: 'queue-full',
          requiredByCurrentPlan: false,
        }),
      ]);
    } finally {
      driver.dispose();
    }
  });

  it('reports a still-required collar error from its older pending request epoch', async () => {
    const collar = deferred<Awaited<ReturnType<TileTransport>>>();
    const errors = vi.fn();
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/current.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      onTileError: errors,
      transport: (request, signal) =>
        request.kind === 'alignment' && request.level === 0 && request.tileIndex === 9
          ? collar.promise
          : fakeTransport()(request, signal),
    });
    try {
      const range = { start: 10 * 1024 + 256, end: 12 * 1024 + 256 };
      driver.setViewport(range, 4096);
      await flushMicrotasks();
      const internal = driver as unknown as {
        cache: { entries: () => TileEntry[] };
        coordinator: { epoch: number };
      };
      const pending = internal.cache.entries().find((e) => e.key.level === 0 && e.key.index === 9)!;
      expect(pending.state).toBe('pending');
      driver.setViewport({ start: range.start + 1, end: range.end + 1 }, 4096);
      expect(pending.epoch).toBeLessThan(internal.coordinator.epoch);
      collar.resolve({ ok: false, status: 429, body: {} });
      await flushFeedCycle();
      expect(errors).toHaveBeenCalledExactlyOnceWith({ key: pending.key, reason: 'queue-full' });
    } finally {
      driver.dispose();
    }
  });

  it('does not recover a late old collar or optional coarser tile after a camera-plan replacement', async () => {
    const oldCollar = deferred<Awaited<ReturnType<TileTransport>>>();
    const errors = vi.fn();
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/current.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      onTileError: errors,
      transport: (request, signal) => {
        if (request.kind === 'alignment' && request.level === 0 && request.tileIndex === 9)
          return oldCollar.promise;
        if (request.kind === 'alignment' && request.level === 1)
          return Promise.resolve({ ok: false, status: 429, body: {} });
        return fakeTransport()(request, signal);
      },
    });
    try {
      driver.setViewport({ start: 10 * 1024 + 256, end: 12 * 1024 + 256 }, 4096);
      await flushMicrotasks();
      driver.setViewport({ start: 700_000, end: 702_000 }, 4096);
      await flushMicrotasks();
      oldCollar.resolve({ ok: false, status: 429, body: {} });
      await flushFeedCycle();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      driver.dispose();
    }
  });

  it('dispatches all five required remote HTTP reads on a jump whose pan lead overlaps the current collar', async () => {
    const started: Array<{
      level: number;
      index: number;
      result: ReturnType<typeof deferred<Response>>;
    }> = [];
    let holdDense = false;
    const response = (level: number, index: number): Response =>
      new Response(
        JSON.stringify({
          reads: [],
          alternateColumns: [],
          count: 0,
          sourceCount: 0,
          level,
          tileIndex: index,
        }),
        { status: 200 }
      );
    const fetchImpl: typeof fetch = async (url, init) => {
      const match = /\/tiles\/alignment\/(\d+)\/(\d+)$/.exec(String(url));
      if (!match) throw new Error('BigWig-backed remote reads must not scan BAM coverage.');
      expect(init?.method).toBe('POST');
      const level = Number(match[1]),
        index = Number(match[2]);
      if (!holdDense) return response(level, index);
      const result = deferred<Response>();
      started.push({ level, index, result });
      return result.promise;
    };
    const driver = new TileEngineDriver({
      assembly: humanScaleAssembly(),
      source: {
        bamPath: 'http://127.0.0.1:61234/v1/00000000-0000-4000-8000-000000001342/alignment.bam',
        indexPath: '/cached/alignment.bai',
        remote: {
          sessionId: 'pan-overlap-native-session',
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/alignment.bam',
            indexPath: '/data/alignment.bai',
            signalPath: '/data/alignment.bigWig',
          },
        },
      },
      baseUrl: 'http://sidecar',
      fetchImpl,
      onFeed: () => undefined,
    });
    const dense = { start: 1_950_303_672, end: 1_950_305_672 };
    try {
      driver.setViewport({ start: 32_400_000, end: 32_404_000 }, 2204);
      await flushFeedCycle();
      expect(driver.debugSnapshot().level).toBe(1);
      holdDense = true;
      driver.setViewport(dense, 2204);
      await flushMicrotasks();
      expect(driver.debugSnapshot().level).toBe(0);
      expect(
        started.map(({ level, index }) => [level, index]).sort((a, b) => a[1]! - b[1]!)
      ).toEqual([1_904_592, 1_904_593, 1_904_594, 1_904_595, 1_904_596].map((index) => [0, index]));
      const queue = driver.debugSnapshot().transportQueue;
      expect(queue?.active).toHaveLength(5);
      expect(queue?.active.every((entry) => entry.purpose === 'current')).toBe(true);
      expect(queue?.queued.some((entry) => entry.purpose === 'pan-lead')).toBe(true);
      expect(queue?.queued.some((entry) => entry.level > 0)).toBe(true);
      for (const item of started.filter(({ index }) => index !== 1_904_596))
        item.result.resolve(response(item.level, item.index));
      await flushFeedCycle();
      expect(started).toHaveLength(5);
      started.find(({ index }) => index === 1_904_596)!.result.resolve(response(0, 1_904_596));
      await flushFeedCycle();
      expect(
        driver.debugSnapshot({ ...dense, viewportPx: 2204 }).readComposition?.stableBandReady
      ).toBe(true);
      expect(started.some(({ index }) => index > 1_904_596)).toBe(true);
    } finally {
      holdDense = false;
      for (const item of started) item.result.resolve(response(item.level, item.index));
      driver.dispose();
      await flushMicrotasks();
    }
  });

  it('holds coarse HTTP alignment until the current native remote read band has settled', async () => {
    const started: Array<{
      level: number;
      index: number;
      body: Record<string, unknown>;
      result: ReturnType<typeof deferred<Response>>;
    }> = [];
    const feeds: TileEngineFeed[] = [];
    let releaseAll = false;
    const response = (level: number, index: number): Response =>
      new Response(
        JSON.stringify({
          reads: [],
          alternateColumns: [],
          count: 0,
          sourceCount: 0,
          level,
          tileIndex: index,
        }),
        { status: 200 }
      );
    const fetchImpl: typeof fetch = async (url, init) => {
      const match = /\/tiles\/alignment\/(\d+)\/(\d+)$/.exec(String(url));
      if (!match) throw new Error('BigWig-backed remote reads must not scan BAM coverage.');
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const level = Number(match[1]),
        index = Number(match[2]);
      const result = deferred<Response>();
      started.push({ level, index, body: JSON.parse(String(init?.body)), result });
      if (releaseAll) result.resolve(response(level, index));
      return result.promise;
    };
    const bamPath = 'http://127.0.0.1:61234/v1/00000000-0000-4000-8000-000000001342/alignment.bam';
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: {
        bamPath,
        indexPath: '/cached/alignment.bai',
        remote: {
          sessionId: 'required-native-read-band',
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/alignment.bam',
            indexPath: '/data/alignment.bai',
            signalPath: '/data/alignment.bigWig',
          },
        },
      },
      baseUrl: 'http://sidecar',
      fetchImpl,
      onFeed: (feed) => feeds.push(feed),
    });
    const view = { start: 50_000, end: 52_000 };
    try {
      driver.setViewport(view, 2204);
      await flushMicrotasks();
      expect(driver.debugSnapshot().level).toBe(0);
      expect(
        started.map(({ level, index }) => [level, index]).sort((a, b) => a[1]! - b[1]!)
      ).toEqual([47, 48, 49, 50, 51].map((index) => [0, index]));
      expect(started.every(({ body }) => body.bamPath === bamPath && body.chrom === 'chrA')).toBe(
        true
      );
      started.find(({ index }) => index === 48)!.result.resolve(response(0, 48));
      await flushFeedCycle();
      expect(started).toHaveLength(5);
      for (const item of started) item.result.resolve(response(item.level, item.index));
      await flushFeedCycle();
      expect(started.some(({ level }) => level > 0)).toBe(true);
      expect(
        driver.debugSnapshot({ ...view, viewportPx: 2204 }).readComposition?.stableBandReady
      ).toBe(true);
      expect(feeds.at(-1)?.ownerPresentation?.kind).toBe('empty');
    } finally {
      releaseAll = true;
      for (const item of started) item.result.resolve(response(item.level, item.index));
      driver.dispose();
      await flushMicrotasks();
    }
  });

  it('cancels active remote alignment HTTP work when its viewport moves away', async () => {
    const alignmentSignals: AbortSignal[] = [];
    const coverageSignals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('The real HTTP adapter must provide a signal.');
      if (String(url).includes('/tiles/alignment/')) {
        alignmentSignals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          const aborted = (): void =>
            reject(new DOMException('Cancelled native job', 'AbortError'));
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        });
      }
      coverageSignals.push(signal);
      return new Response(JSON.stringify({ bins: [0], binSize: 1024, maxDepth: 0 }), {
        status: 200,
      });
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: {
        bamPath: 'http://127.0.0.1:61234/v1/00000000-0000-4000-8000-000000001342/alignment.bam',
        indexPath: '/cached/alignment.bai',
        remote: {
          sessionId: 'viewport-cancellation-session',
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/alignment.bam',
            indexPath: '/data/alignment.bai',
          },
        },
      },
      baseUrl: 'http://sidecar',
      fetchImpl,
      onFeed: () => undefined,
    } as never);
    try {
      driver.setViewport({ start: 1000, end: 3000 }, 2000);
      await flushMicrotasks();
      const previous = [...alignmentSignals];
      expect(previous.length).toBeGreaterThan(0);
      driver.setViewport({ start: 16000, end: 18000 }, 2000);
      await flushMicrotasks();
      expect(previous.every((signal) => signal.aborted)).toBe(true);
      expect(coverageSignals.every((signal) => !signal.aborted)).toBe(true);
    } finally {
      driver.dispose();
      await flushMicrotasks();
    }
  });

  it('replays a stationary remote viewport after the old transport generation settles late', async () => {
    const feeds: TileEngineFeed[] = [];
    const base = fakeTransport();
    const firstGeneration: Array<ReturnType<typeof deferred<Awaited<ReturnType<TileTransport>>>>> =
      [];
    const rawRequests: Array<Parameters<TileTransport>[0]> = [];
    let replacementGenerationReady = false;
    const transport: TileTransport = (request, signal) => {
      rawRequests.push(request);
      if (request.kind === 'alignment' && !replacementGenerationReady) {
        const pending = deferred<Awaited<ReturnType<TileTransport>>>();
        firstGeneration.push(pending);
        return pending.promise;
      }
      return base(request, signal);
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: {
        bamPath: 'http://127.0.0.1:61234/v1/stable-source/alignment.bam',
        indexPath: '/cached/alignment.bam.bai',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/alignment.bam',
            indexPath: '/data/alignment.bam.bai',
            signalPath: '/data/alignment.bigWig',
          },
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport,
    } as never);
    const range = { start: 1_000, end: 3_000 };

    driver.setViewport(range, 2_000);
    await flushMicrotasks();
    const firstRawRequestCount = rawRequests.length;
    expect(firstGeneration.length).toBeGreaterThan(0);
    expect(driver.debugSnapshot().inFlight).toBeGreaterThan(0);

    replacementGenerationReady = true;
    expect(driver.retryCurrentViewport({ restartPending: true })).toBe(true);
    expect(
      driver.debugSnapshot().inFlight,
      'the replacement viewport owns fresh controllers before old raw requests settle'
    ).toBeGreaterThan(0);

    for (const pending of firstGeneration) {
      pending.reject(new Error('old transport generation closed'));
    }
    await flushFeedCycle();
    await flushFeedCycle();

    expect(rawRequests.length).toBeGreaterThan(firstRawRequestCount);
    expect(driver.debugSnapshot().inFlight).toBe(0);
    expect(driver.debugSnapshot().readComposition).toMatchObject({
      stableBandReady: true,
      composedRecordCount: expect.any(Number),
    });
    expect(driver.debugSnapshot().readComposition?.composedRecordCount ?? 0).toBeGreaterThan(0);
    expect(feeds.at(-1)?.records.length ?? 0).toBeGreaterThan(0);
    expect(feeds.at(-1)?.ownerPresentation).toEqual({ kind: 'reads' });
    driver.dispose();
  });

  it('does not carry a failed-plan retry gate into a different camera plan', async () => {
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const errors: string[] = [];
    let failFirstCoreAlignment = true;
    const transport: TileTransport = async (request, signal) => {
      requests.push(request);
      if (request.kind === 'alignment' && request.priority?.core && failFirstCoreAlignment) {
        failFirstCoreAlignment = false;
        return { ok: false, status: 429, body: { detail: 'busy' } };
      }
      return fakeTransport()(request, signal);
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/reads.bam', indexPath: '/reads.bam.bai' },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      onTileError: ({ reason }) => errors.push(reason),
      transport,
    });

    driver.setViewport({ start: 1_000, end: 2_000 }, 1_024);
    await flushFeedCycle();
    expect(errors).toEqual(['queue-full']);
    const failedPlanRequestCount = requests.filter(
      (request) => request.kind === 'alignment'
    ).length;

    driver.setViewport({ start: 700_000, end: 701_000 }, 1_024);
    await flushFeedCycle();

    expect(requests.filter((request) => request.kind === 'alignment').length).toBeGreaterThan(
      failedPlanRequestCount
    );
    expect(driver.debugSnapshot().inFlight).toBe(0);
    driver.dispose();
  });

  it('does not report a late tile failure after disposal', async () => {
    const lateCoreAlignment = deferred<Awaited<ReturnType<TileTransport>>>();
    const errors = vi.fn();
    const transport: TileTransport = (request, signal) => {
      if (request.kind === 'alignment' && request.priority?.core) {
        return lateCoreAlignment.promise;
      }
      return fakeTransport()(request, signal);
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/reads.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      onTileError: errors,
      transport,
    });

    driver.setViewport({ start: 1_000, end: 2_000 }, 1_024);
    await flushMicrotasks();
    driver.dispose();
    lateCoreAlignment.resolve({ ok: false, status: 429, body: { detail: 'late' } });
    await flushFeedCycle();

    expect(errors).not.toHaveBeenCalled();
  });

  it('distinguishes a fully settled empty read band from pending zero records', async () => {
    const feeds: TileEngineFeed[] = [];
    const base = fakeTransport();
    const transport: TileTransport = async (request, signal) => {
      if (request.kind === 'alignment') {
        return {
          ok: true,
          status: 200,
          body: { reads: [], alternateColumns: [], truncated: false, count: 0 },
        };
      }
      return base(request, signal);
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/empty.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport,
    });

    const feed = await feedFor(driver, feeds, { start: 1_000, end: 2_000 }, 1_024);

    expect(feed?.records).toEqual([]);
    expect(feed?.ownerPresentation).toEqual({ kind: 'empty' });
    expect(feed?.referenceIntervals?.some((interval) => interval.state === 'empty')).toBe(true);
    driver.dispose();
  });

  it('settles an empty chromosome without waiting for an offscreen neighboring fragment', async () => {
    const assembly = buildAssembly('empty-near-seam', 'empty near seam', [
      { id: 'chrA', displayName: 'chrA', length: 1_500, cytobands: [] },
      { id: 'chrB', displayName: 'chrB', length: 1_500, cytobands: [] },
    ] as never);
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const base = fakeTransport();
    const transport: TileTransport = async (request, signal) => {
      requests.push(request);
      if (request.kind === 'alignment') {
        return {
          ok: true,
          status: 200,
          body: { reads: [], alternateColumns: [], truncated: false, count: 0 },
        };
      }
      const response = await base(request, signal);
      const body = response.body as {
        bins?: number[];
        maxDepth?: number;
        segments?: Array<{ bins: number[]; maxDepth: number }>;
      };
      body.bins?.fill(0);
      body.maxDepth = 0;
      for (const segment of body.segments ?? []) {
        segment.bins.fill(0);
        segment.maxDepth = 0;
      }
      return response;
    };
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/empty.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport,
    });
    const view = { start: 100, end: 300 };

    try {
      await feedFor(driver, feeds, view, 1024);
      await flushFeedCycle();
      const snapshot = driver.debugSnapshot();
      expect(snapshot.inFlight).toBe(0);
      expect(snapshot.aln.pending).toBe(0);
      expect(snapshot.aln.error).toBe(0);
      expect(snapshot.transportQueue.active).toEqual([]);
      expect(snapshot.transportQueue.queued).toEqual([]);
      expect(
        requests.some((request) => request.kind === 'alignment' && request.body.chrom === 'chrB')
      ).toBe(false);
      expect(snapshot.readComposition?.stableBandReady).toBe(true);
      expect(snapshot.readComposition?.readyCoversViewport).toBe(true);
      expect(feeds.at(-1)?.records).toEqual([]);
      expect(feeds.at(-1)?.ownerPresentation).toEqual({ kind: 'empty' });
      expect(
        feeds
          .at(-1)
          ?.referenceIntervals?.some(
            (interval) =>
              interval.state === 'empty' &&
              interval.startBp <= view.start &&
              interval.endBp >= view.end
          )
      ).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it('presents an empty viewport even when the resident halo still contains reads', async () => {
    const feeds: TileEngineFeed[] = [];
    const base = fakeTransport();
    const transport: TileTransport = async (request, signal) => {
      if (request.kind !== 'alignment') return base(request, signal);
      return {
        ok: true,
        status: 200,
        body: {
          reads:
            request.tileIndex === 0
              ? [{ start: 100, end: 250, strand: '+', mapq: 60, readId: 'left-read' }]
              : [],
          alternateColumns: [],
          truncated: false,
        },
      };
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/halo.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport,
    });

    const withRead = await feedFor(driver, feeds, { start: 100, end: 500 }, 1_024);
    expect(withRead?.ownerPresentation).toEqual({ kind: 'reads' });

    const moving = await feedFor(driver, feeds, { start: 1_800, end: 2_200 }, 1_024);
    expect(moving?.ownerPresentation?.kind).not.toBe('empty');
    await vi.waitFor(() => {
      expect(feeds.at(-1)?.ownerPresentation).toEqual({ kind: 'empty' });
    });
    const emptyViewport = feeds.at(-1);
    expect(emptyViewport?.records.some((record) => record.readId === 'left-read')).toBe(true);
    expect(emptyViewport?.ownerPresentation).toEqual({ kind: 'empty' });
    expect(emptyViewport?.coverage?.startBp).toBeLessThanOrEqual(1_800);
    expect(
      (emptyViewport?.coverage?.startBp ?? 0) +
        (emptyViewport?.coverage?.bins.length ?? 0) * (emptyViewport?.coverage?.binSize ?? 0)
    ).toBeGreaterThanOrEqual(2_200);
    driver.dispose();
  });

  it('sends each alignment tile the prepared FASTA for its chromosome', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/reads.bam', indexPath: '/reads.bam.bai' },
      referencePathsByChrom: new Map([
        ['chrA', '/prepared/chrA/chrA.fa'],
        ['chrB', '/prepared/chrB/chrB.fa'],
      ]),
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: recordingTransport(requests),
    });

    await feedFor(driver, feeds, { start: 1_000, end: 2_000 }, 1024);
    await feedFor(driver, feeds, { start: 5_001_000, end: 5_002_000 }, 1024);

    const alignmentBodies = requests
      .filter((request) => request.kind === 'alignment')
      .map((request) => request.body);
    expect(alignmentBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chrom: 'chrA',
          referencePath: '/prepared/chrA/chrA.fa',
        }),
        expect.objectContaining({
          chrom: 'chrB',
          referencePath: '/prepared/chrB/chrB.fa',
        }),
      ])
    );
    driver.dispose();
  });

  it('keeps the admitted CRAM reference for every chromosome over the prepared FASTA', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: {
        bamPath: '/lab/reads.cram',
        indexPath: '/lab/reads.cram.crai',
        referencePath: '/lab/genome.fa',
      },
      referencePathsByChrom: new Map([
        ['chrA', '/prepared/chrA/chrA.fa'],
        ['chrB', '/prepared/chrB/chrB.fa'],
      ]),
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: recordingTransport(requests),
    });

    await feedFor(driver, feeds, { start: 1_000, end: 2_000 }, 1024);
    await feedFor(driver, feeds, { start: 5_001_000, end: 5_002_000 }, 1024);

    const alignmentBodies = requests
      .filter((request) => request.kind === 'alignment')
      .map((request) => request.body);
    expect(alignmentBodies.length).toBeGreaterThan(0);
    for (const body of alignmentBodies) {
      expect(body).toMatchObject({ referencePath: '/lab/genome.fa' });
    }
    expect(alignmentBodies.map((body) => (body as { chrom: string }).chrom)).toEqual(
      expect.arrayContaining(['chrA', 'chrB'])
    );
    driver.dispose();
  });

  it('uses each prepared chromosome FASTA instead of a stale remote CRAM fallback', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: {
        bamPath: 'http://127.0.0.1:43119/v1/session_123/alignment.cram',
        indexPath: '/tmp/session_123/alignment.cram.crai',
        referencePath: '/prepared/chrA/chrA.fa',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'lab-hpc',
            target: 'lab-hpc',
            alignmentPath: '/runs/sample.cram',
            indexPath: '/runs/sample.cram.crai',
          },
          sessionId: 'session_123',
        },
      },
      referencePathsByChrom: new Map([
        ['chrA', '/prepared/chrA/chrA.fa'],
        ['chrB', '/prepared/chrB/chrB.fa'],
      ]),
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: recordingTransport(requests),
    });

    await feedFor(driver, feeds, { start: 1_000, end: 2_000 }, 1024);
    await feedFor(driver, feeds, { start: 5_001_000, end: 5_002_000 }, 1024);

    const alignmentBodies = requests
      .filter((request) => request.kind === 'alignment')
      .map((request) => request.body);
    expect(alignmentBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chrom: 'chrA', referencePath: '/prepared/chrA/chrA.fa' }),
        expect.objectContaining({ chrom: 'chrB', referencePath: '/prepared/chrB/chrB.fa' }),
      ])
    );
    driver.dispose();
  });

  it('publishes finer exact coverage over conflicting resident base-layer values', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      residentBaseLayer: Map<string, { globalStart: number; binSize: number; bins: Float32Array }>;
      residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error';
      residentBaseLayerVerified: boolean;
      residentPyramid: Array<
        Map<string, { globalStart: number; binSize: number; bins: Float32Array }>
      >;
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

    internals.residentBaseLayer.set('chrA', {
      globalStart: 0,
      binSize: 64,
      bins: new Float32Array([3, 3]),
    });
    internals.residentBaseLayerState = 'ready';
    internals.residentBaseLayerVerified = true;
    internals.residentPyramid.push(internals.residentBaseLayer);
    internals.exactCoverageTiles.set('covasm:test:0:0', {
      key: { sourceId: 'covasm:test', level: 0, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: 128,
          binSize: 1,
          payload: {
            bins: Array.from({ length: 128 }, (_, index) => (index === 64 ? 97 : 3)),
            binSize: 1,
            provenance: { exact: true, method: 'deterministic-test' },
          },
        },
      ],
      order: 1,
    });

    driver.presentViewport({ start: 0, end: 128 }, 128);

    const published = feeds.at(-1)?.coverage;
    driver.dispose();
    expect(published, 'the public feed should contain composed coverage').toBeTruthy();
    expect(
      published?.binSize,
      'the exact level-0 tile should select the one-base output grid'
    ).toBe(1);
    expect(
      coverageMaxInRange(published!, { start: 64, end: 65 }),
      'the finer exact value must refine the resident 64bp value at the same locus'
    ).toBe(97);
  });

  it('does not let a globally-ready resident set claim a viewport whose chromosome is absent', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      residentBaseLayer: Map<string, { globalStart: number; binSize: number; bins: Float32Array }>;
      residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error';
      residentBaseLayerVerified: boolean;
      residentPyramid: Array<
        Map<string, { globalStart: number; binSize: number; bins: Float32Array }>
      >;
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

    internals.residentBaseLayer.set('chrB', {
      globalStart: 5_000_000,
      binSize: 64,
      bins: new Float32Array([11, 11, 11, 11, 11, 11, 11, 11]),
    });
    internals.residentBaseLayerState = 'ready';
    internals.residentBaseLayerVerified = true;
    internals.residentPyramid.push(internals.residentBaseLayer);
    internals.exactCoverageTiles.set('covasm:test:9:0', {
      key: { sourceId: 'covasm:test', level: 9, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: 512,
          binSize: 512,
          payload: {
            bins: [73],
            binSize: 512,
            provenance: { exact: true, method: 'deterministic-test' },
          },
        },
      ],
      order: 1,
    });

    driver.presentViewport({ start: 0, end: 512 }, 1);

    const published = feeds.at(-1)?.coverage;
    driver.dispose();
    expect(published, 'the exact current-chromosome tile must remain publishable').toBeTruthy();
    expect(published?.binSize, 'an absent resident chromosome must not force a 64bp grid').toBe(
      512
    );
    expect(coverageMaxInRange(published!, { start: 0, end: 512 })).toBe(73);
  });

  it('keeps a finer resident value over a conflicting coarser exact tile', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      residentBaseLayer: Map<string, { globalStart: number; binSize: number; bins: Float32Array }>;
      residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error';
      residentBaseLayerVerified: boolean;
      residentPyramid: Array<
        Map<string, { globalStart: number; binSize: number; bins: Float32Array }>
      >;
      exactCoverageTiles: Map<string, { key: never; slices: never[]; order: number }>;
    };
    internals.residentBaseLayer.set('chrA', {
      globalStart: 0,
      binSize: 64,
      bins: new Float32Array([3, 3, 3, 3, 3, 3, 3, 3]),
    });
    internals.residentBaseLayerState = 'ready';
    internals.residentBaseLayerVerified = true;
    internals.residentPyramid.push(internals.residentBaseLayer);
    internals.exactCoverageTiles.set('covasm:test:9:0', {
      key: { sourceId: 'covasm:test', level: 9, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: 512,
          binSize: 512,
          payload: {
            bins: [97],
            binSize: 512,
            provenance: { exact: true, method: 'deterministic-test' },
          },
        },
      ],
      order: 1,
    } as never);

    driver.presentViewport({ start: 0, end: 512 }, 8);

    const published = feeds.at(-1)?.coverage;
    driver.dispose();
    expect(published).toBeTruthy();
    expect(published?.binSize).toBe(64);
    expect(coverageMaxInRange(published!, { start: 0, end: 512 })).toBe(3);
  });

  it('treats an exact zero as data when it is finer than resident coverage', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      residentBaseLayer: Map<string, { globalStart: number; binSize: number; bins: Float32Array }>;
      residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error';
      residentBaseLayerVerified: boolean;
      residentPyramid: Array<
        Map<string, { globalStart: number; binSize: number; bins: Float32Array }>
      >;
      exactCoverageTiles: Map<string, { key: never; slices: never[]; order: number }>;
    };
    internals.residentBaseLayer.set('chrA', {
      globalStart: 0,
      binSize: 64,
      bins: new Float32Array([3, 3]),
    });
    internals.residentBaseLayerState = 'ready';
    internals.residentBaseLayerVerified = true;
    internals.residentPyramid.push(internals.residentBaseLayer);
    internals.exactCoverageTiles.set('covasm:test:0:0', {
      key: { sourceId: 'covasm:test', level: 0, index: 0 },
      slices: [
        {
          globalStart: 64,
          globalEnd: 65,
          binSize: 1,
          payload: {
            bins: [0],
            binSize: 1,
            provenance: { exact: true, method: 'deterministic-test' },
          },
        },
      ],
      order: 1,
    } as never);

    driver.presentViewport({ start: 64, end: 65 }, 1);

    const published = feeds.at(-1)?.coverage;
    driver.dispose();
    expect(published).toBeTruthy();
    expect(published?.binSize).toBe(1);
    expect(published?.bins).toEqual([0]);
  });

  it('quarantines anonymous resident coverage even when it is physically finer', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/active.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      residentBaseLayer: Map<string, { globalStart: number; binSize: number; bins: Float32Array }>;
      residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error';
      residentBaseLayerVerified: boolean;
      residentPyramid: Array<
        Map<string, { globalStart: number; binSize: number; bins: Float32Array }>
      >;
      exactCoverageTiles: Map<string, { key: never; slices: never[]; order: number }>;
    };
    internals.residentBaseLayer.set('chrA', {
      globalStart: 0,
      binSize: 64,
      bins: new Float32Array(8),
    });
    internals.residentBaseLayerState = 'ready';
    internals.residentBaseLayerVerified = false;
    internals.residentPyramid.push(internals.residentBaseLayer);
    internals.exactCoverageTiles.set('covasm:active:9:0', {
      key: { sourceId: 'covasm:/active.bam', level: 9, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: 512,
          binSize: 512,
          payload: {
            bins: [73],
            binSize: 512,
            provenance: { exact: true, method: 'deterministic-test' },
          },
        },
      ],
      order: 1,
    } as never);

    driver.presentViewport({ start: 0, end: 512 }, 1);

    const published = feeds.at(-1)?.coverage;
    driver.dispose();
    expect(published?.binSize).toBe(512);
    expect(published?.bins).toEqual([73]);
  });

  it('keeps verified resident zero over a coarser exact value', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/active.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      residentBaseLayer: Map<string, { globalStart: number; binSize: number; bins: Float32Array }>;
      residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error';
      residentBaseLayerVerified: boolean;
      residentPyramid: Array<
        Map<string, { globalStart: number; binSize: number; bins: Float32Array }>
      >;
      exactCoverageTiles: Map<string, { key: never; slices: never[]; order: number }>;
    };
    internals.residentBaseLayer.set('chrA', {
      globalStart: 0,
      binSize: 64,
      bins: new Float32Array(8),
    });
    internals.residentBaseLayerState = 'ready';
    internals.residentBaseLayerVerified = true;
    internals.residentPyramid.push(internals.residentBaseLayer);
    internals.exactCoverageTiles.set('covasm:active:9:0', {
      key: { sourceId: 'covasm:/active.bam', level: 9, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: 512,
          binSize: 512,
          payload: {
            bins: [97],
            binSize: 512,
            provenance: { exact: true, method: 'deterministic-test' },
          },
        },
      ],
      order: 1,
    } as never);

    driver.presentViewport({ start: 0, end: 512 }, 8);

    const published = feeds.at(-1)?.coverage;
    driver.dispose();
    expect(published?.binSize).toBe(64);
    expect(published?.bins).toEqual(new Array(8).fill(0));
  });

  it('does not let a partial one-base source claim a whole coarse destination bin', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/active.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      residentBaseLayer: Map<string, { globalStart: number; binSize: number; bins: Float32Array }>;
      residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error';
      residentBaseLayerVerified: boolean;
      residentPyramid: Array<
        Map<string, { globalStart: number; binSize: number; bins: Float32Array }>
      >;
      exactCoverageTiles: Map<string, { key: never; slices: never[]; order: number }>;
    };
    internals.residentBaseLayer.set('chrA', {
      globalStart: 0,
      binSize: 64,
      bins: new Float32Array(256).fill(3),
    });
    internals.residentBaseLayerState = 'ready';
    internals.residentBaseLayerVerified = true;
    internals.residentPyramid.push(internals.residentBaseLayer);
    internals.exactCoverageTiles.set('covasm:active:0:0', {
      key: { sourceId: 'covasm:/active.bam', level: 0, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: 1,
          binSize: 1,
          payload: {
            bins: [0],
            binSize: 1,
            provenance: { exact: true, method: 'deterministic-test' },
          },
        },
      ],
      order: 1,
    } as never);

    driver.presentViewport({ start: 0, end: 16_384 }, 1);

    const published = feeds.at(-1)?.coverage;
    driver.dispose();
    expect(
      published?.binSize,
      'a one-base partial source cannot select a 2bp grid; the complete 64bp source remains authoritative'
    ).toBe(64);
    expect(published?.bins[0]).toBe(3);
  });

  it('unions complementary verified resident and exact spans without a false gap', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/active.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      residentBaseLayer: Map<string, { globalStart: number; binSize: number; bins: Float32Array }>;
      residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error';
      residentBaseLayerVerified: boolean;
      residentPyramid: Array<
        Map<string, { globalStart: number; binSize: number; bins: Float32Array }>
      >;
      exactCoverageTiles: Map<string, { key: never; slices: never[]; order: number }>;
    };
    internals.residentBaseLayer.set('left', {
      globalStart: 0,
      binSize: 64,
      bins: new Float32Array([3]),
    });
    internals.residentBaseLayerState = 'ready';
    internals.residentBaseLayerVerified = true;
    internals.residentPyramid.push(internals.residentBaseLayer);
    internals.exactCoverageTiles.set('covasm:active:6:0', {
      key: { sourceId: 'covasm:/active.bam', level: 6, index: 0 },
      slices: [
        {
          globalStart: 64,
          globalEnd: 128,
          binSize: 64,
          payload: {
            bins: [9],
            binSize: 64,
            provenance: { exact: true, method: 'deterministic-test' },
          },
        },
      ],
      order: 1,
    } as never);

    driver.presentViewport({ start: 0, end: 128 }, 2);

    const published = feeds.at(-1)?.coverage;
    driver.dispose();
    expect(published?.binSize).toBe(64);
    expect(published?.bins).toEqual([3, 9]);
  });

  it('rejects a queued aborted tile request before the active slot drains', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const startedTileIndexes: number[] = [];
    const limited = limitConcurrency((req) => {
      startedTileIndexes.push(req.tileIndex);
      return active.promise;
    }, 1);

    const activeRequest = limited(coverageRequest(1), new AbortController().signal);
    await Promise.resolve();
    const queuedAbort = new AbortController();
    const queuedRequest = limited(coverageRequest(2), queuedAbort.signal);
    const queuedOutcome = queuedRequest.then(
      () => ({ status: 'resolved' as const }),
      (error) => ({ status: 'rejected' as const, error })
    );

    queuedAbort.abort();
    const immediate = await Promise.race([
      queuedOutcome,
      new Promise<{ status: 'pending' }>((resolve) =>
        setTimeout(() => resolve({ status: 'pending' }), 0)
      ),
    ]);

    try {
      expect(immediate).toMatchObject({ status: 'rejected', error: { name: 'AbortError' } });
      expect(
        startedTileIndexes,
        'queued stale request must not consume the transport slot'
      ).toEqual([1]);
    } finally {
      active.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(10),
          maxDepth: 1,
        },
      });
      await activeRequest;
      await queuedOutcome;
    }
  });

  it('does not free an active transport slot until an aborted sidecar tile settles', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const second = deferred<Awaited<ReturnType<TileTransport>>>();
    const startedTileIndexes: number[] = [];
    const rawAbortedTileIndexes: number[] = [];
    const limited = limitConcurrency((req, signal) => {
      startedTileIndexes.push(req.tileIndex);
      signal.addEventListener('abort', () => rawAbortedTileIndexes.push(req.tileIndex));
      return req.tileIndex === 1 ? active.promise : second.promise;
    }, 1);

    const activeAbort = new AbortController();
    const activeRequest = limited(coverageRequest(1), activeAbort.signal).then(
      () => ({ status: 'resolved' as const }),
      (error) => ({ status: 'rejected' as const, error })
    );
    await Promise.resolve();
    const queuedRequest = limited(coverageRequest(2), new AbortController().signal);

    activeAbort.abort();
    const immediate = await Promise.race([
      activeRequest,
      new Promise<{ status: 'pending' }>((resolve) =>
        setTimeout(() => resolve({ status: 'pending' }), 0)
      ),
    ]);

    expect(immediate).toEqual({ status: 'pending' });
    expect(
      startedTileIndexes,
      'aborting an active fetch must not release the client slot while sidecar work is still running'
    ).toEqual([1]);
    expect(rawAbortedTileIndexes, 'active raw sidecar request should not be aborted').toEqual([]);

    active.resolve({
      ok: true,
      status: 200,
      body: {
        bins: [1],
        binSize: binBp(10),
        maxDepth: 1,
      },
    });
    const abortedOutcome = await activeRequest;
    expect(abortedOutcome).toMatchObject({ status: 'rejected', error: { name: 'AbortError' } });
    await Promise.resolve();
    expect(startedTileIndexes).toEqual([1, 2]);

    second.resolve({
      ok: true,
      status: 200,
      body: {
        bins: [1],
        binSize: binBp(10),
        maxDepth: 1,
      },
    });
    await queuedRequest;
  });

  it('prioritizes newer current-core coverage over older queued margin/speculative work', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const second = deferred<Awaited<ReturnType<TileTransport>>>();
    const third = deferred<Awaited<ReturnType<TileTransport>>>();
    const fourth = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{ level: number; tileIndex: number }> = [];
    const limited = limitConcurrency((req) => {
      started.push({ level: req.level, tileIndex: req.tileIndex });
      if (started.length === 1) return active.promise;
      if (started.length === 2) return second.promise;
      if (started.length === 3) return third.promise;
      return fourth.promise;
    }, 1);

    const first = limited(
      coverageRequest(1, 9, {
        purpose: 'current',
        epoch: 1,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    await Promise.resolve();
    const olderMargin = limited(
      coverageRequest(2, 9, {
        purpose: 'current',
        epoch: 1,
        core: false,
        marginDistanceTiles: 5,
      }),
      new AbortController().signal
    );
    const olderSpeculativeFiner = limited(
      coverageRequest(3, 8, {
        purpose: 'adjacent-finer',
        epoch: 1,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    const newerCurrentCore = limited(
      coverageRequest(4, 9, {
        purpose: 'current',
        epoch: 2,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );

    expect(started).toEqual([{ level: 9, tileIndex: 1 }]);
    active.resolve({
      ok: true,
      status: 200,
      body: {
        bins: [1],
        binSize: binBp(9),
        maxDepth: 1,
      },
    });
    await first;
    await Promise.resolve();

    const startedBeforeCleanup = started.slice();
    try {
      expect(startedBeforeCleanup).toEqual([
        { level: 9, tileIndex: 1 },
        { level: 9, tileIndex: 4 },
      ]);
    } finally {
      second.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(9),
          maxDepth: 1,
        },
      });
      third.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(19),
          maxDepth: 1,
        },
      });
      fourth.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(9),
          maxDepth: 1,
        },
      });
      await olderSpeculativeFiner;
      await olderMargin;
      await newerCurrentCore;
    }
  });

  it('does not let stale critical handoff coverage outrank newer visible current coverage', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const second = deferred<Awaited<ReturnType<TileTransport>>>();
    const third = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{ level: number; tileIndex: number }> = [];
    const limited = limitConcurrency((req) => {
      started.push({ level: req.level, tileIndex: req.tileIndex });
      if (started.length === 1) return active.promise;
      if (started.length === 2) return second.promise;
      return third.promise;
    }, 1);

    const first = limited(
      coverageRequest(1, 9, {
        purpose: 'current',
        epoch: 1,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    await Promise.resolve();
    const staleCritical = limited(
      coverageRequest(2, 9, {
        purpose: 'critical-handoff',
        epoch: 1,
        core: false,
        marginDistanceTiles: 8,
      }),
      new AbortController().signal
    );
    const newerVisibleCurrent = limited(
      coverageRequest(3, 9, {
        purpose: 'current',
        epoch: 2,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );

    expect(started).toEqual([{ level: 9, tileIndex: 1 }]);
    active.resolve({
      ok: true,
      status: 200,
      body: {
        bins: [1],
        binSize: binBp(9),
        maxDepth: 1,
      },
    });
    await first;
    await Promise.resolve();

    const startedBeforeCleanup = started.slice();
    try {
      expect(startedBeforeCleanup).toEqual([
        { level: 9, tileIndex: 1 },
        { level: 9, tileIndex: 3 },
      ]);
    } finally {
      second.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(9),
          maxDepth: 1,
        },
      });
      third.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(9),
          maxDepth: 1,
        },
      });
      await staleCritical;
      await newerVisibleCurrent;
    }
  });

  it('prioritizes same-epoch current pan coverage before critical handoff warmup', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const second = deferred<Awaited<ReturnType<TileTransport>>>();
    const third = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{ level: number; tileIndex: number }> = [];
    const limited = limitConcurrency((req) => {
      started.push({ level: req.level, tileIndex: req.tileIndex });
      if (started.length === 1) return active.promise;
      if (started.length === 2) return second.promise;
      return third.promise;
    }, 1);

    const visibleCoverage = limited(
      coverageRequest(1, 18, {
        purpose: 'current',
        epoch: 7,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    await Promise.resolve();
    const currentPanMargin = limited(
      coverageRequest(2, 18, {
        purpose: 'current',
        epoch: 7,
        core: false,
        marginDistanceTiles: 1,
      }),
      new AbortController().signal
    );
    const criticalWarmup = limited(
      coverageRequest(3, 17, {
        purpose: 'critical-handoff',
        epoch: 7,
        core: false,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );

    expect(started).toEqual([{ level: 18, tileIndex: 1 }]);
    active.resolve({
      ok: true,
      status: 200,
      body: {
        bins: [1],
        binSize: binBp(18),
        maxDepth: 1,
      },
    });
    await visibleCoverage;
    await Promise.resolve();

    const startedBeforeCleanup = started.slice();
    try {
      expect(startedBeforeCleanup).toEqual([
        { level: 18, tileIndex: 1 },
        { level: 18, tileIndex: 2 },
      ]);
    } finally {
      second.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(18),
          maxDepth: 1,
        },
      });
      third.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(17),
          maxDepth: 1,
        },
      });
      await currentPanMargin;
      await criticalWarmup;
    }
  });

  it('prioritizes adjacent LOD descent before deep critical handoff warmup', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const second = deferred<Awaited<ReturnType<TileTransport>>>();
    const third = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{ level: number; tileIndex: number }> = [];
    const limited = limitConcurrency((req) => {
      started.push({ level: req.level, tileIndex: req.tileIndex });
      if (started.length === 1) return active.promise;
      if (started.length === 2) return second.promise;
      return third.promise;
    }, 1);

    const visibleCoverage = limited(
      coverageRequest(1, 21, {
        purpose: 'current',
        epoch: 9,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    await Promise.resolve();
    const adjacentDescent = limited(
      coverageRequest(2, 20, {
        purpose: 'adjacent-finer',
        epoch: 9,
        core: false,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    const criticalWarmup = limited(
      coverageRequest(3, 17, {
        purpose: 'critical-handoff',
        epoch: 9,
        core: false,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );

    expect(started).toEqual([{ level: 21, tileIndex: 1 }]);
    active.resolve({
      ok: true,
      status: 200,
      body: {
        bins: [1],
        binSize: binBp(21),
        maxDepth: 1,
      },
    });
    await visibleCoverage;
    await Promise.resolve();

    const startedBeforeCleanup = started.slice();
    try {
      expect(startedBeforeCleanup).toEqual([
        { level: 21, tileIndex: 1 },
        { level: 20, tileIndex: 2 },
      ]);
    } finally {
      second.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(20),
          maxDepth: 1,
        },
      });
      third.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(17),
          maxDepth: 1,
        },
      });
      await adjacentDescent;
      await criticalWarmup;
    }
  });

  it('reserves active transport capacity for current work while critical warmups are queued', async () => {
    const criticalActive = deferred<Awaited<ReturnType<TileTransport>>>();
    const currentActive = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{ level: number; tileIndex: number; purpose: string | undefined }> = [];
    const limited = limitConcurrency((req) => {
      started.push({
        level: req.level,
        tileIndex: req.tileIndex,
        purpose: req.priority?.purpose,
      });
      if (req.priority?.purpose === 'current') return currentActive.promise;
      return criticalActive.promise;
    }, 4);

    const criticalControllers = Array.from({ length: 6 }, () => new AbortController());
    const criticalRequests = criticalControllers.map((controller, i) =>
      limited(
        coverageRequest(i + 1, 17 - i, {
          purpose: 'critical-handoff',
          epoch: 3,
          core: false,
          marginDistanceTiles: i,
        }),
        controller.signal
      )
    );

    await Promise.resolve();
    expect(
      started,
      'speculative handoff warmups must not saturate the whole 4-slot transport pool'
    ).toEqual([{ level: 17, tileIndex: 1, purpose: 'critical-handoff' }]);

    const currentRequest = limited(
      coverageRequest(99, 11, {
        purpose: 'current',
        epoch: 4,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    await Promise.resolve();

    expect(started).toEqual([
      { level: 17, tileIndex: 1, purpose: 'critical-handoff' },
      { level: 11, tileIndex: 99, purpose: 'current' },
    ]);

    for (let i = 1; i < criticalControllers.length; i += 1) criticalControllers[i]!.abort();
    criticalActive.resolve({
      ok: true,
      status: 200,
      body: { bins: [1], binSize: binBp(17), maxDepth: 1 },
    });
    currentActive.resolve({
      ok: true,
      status: 200,
      body: { bins: [1], binSize: binBp(11), maxDepth: 1 },
    });
    await currentRequest;
    await Promise.allSettled(criticalRequests);
  });

  it('does not starve visible exact-read alignment behind queued coverage margin work', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const second = deferred<Awaited<ReturnType<TileTransport>>>();
    const third = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{ kind: string; level: number; tileIndex: number }> = [];
    const limited = limitConcurrency((req) => {
      started.push({ kind: req.kind, level: req.level, tileIndex: req.tileIndex });
      if (started.length === 1) return active.promise;
      if (started.length === 2) return second.promise;
      return third.promise;
    }, 1);

    const visibleCoverage = limited(
      coverageRequest(1, 0, {
        purpose: 'current',
        epoch: 2,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    await Promise.resolve();
    const queuedCoverageMargin = limited(
      coverageRequest(2, 0, {
        purpose: 'current',
        epoch: 2,
        core: false,
        marginDistanceTiles: 12,
      }),
      new AbortController().signal
    );
    const visibleAlignment = limited(
      alignmentRequest(3, 0, {
        purpose: 'current',
        epoch: 2,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );

    expect(started).toEqual([{ kind: 'coverage', level: 0, tileIndex: 1 }]);
    active.resolve({
      ok: true,
      status: 200,
      body: {
        bins: [1],
        binSize: binBp(0),
        maxDepth: 1,
      },
    });
    await visibleCoverage;
    await Promise.resolve();

    const startedBeforeCleanup = started.slice();
    try {
      expect(startedBeforeCleanup).toEqual([
        { kind: 'coverage', level: 0, tileIndex: 1 },
        { kind: 'alignment', level: 0, tileIndex: 3 },
      ]);
    } finally {
      second.resolve({
        ok: true,
        status: 200,
        body: {
          reads: [],
          truncated: false,
        },
      });
      third.resolve({
        ok: true,
        status: 200,
        body: {
          bins: [1],
          binSize: binBp(0),
          maxDepth: 1,
        },
      });
      await visibleAlignment;
      await queuedCoverageMargin;
    }
  });

  it('does not delay the first production coverage fetch behind a settle timer', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    const fullGenome = await feedFor(
      driver,
      feeds,
      { start: 0, end: assembly.totalLengthBp },
      2676
    );

    expect(
      requests.some((req) => isCoverageRequestKind(req.kind)),
      'production defaults must issue coverage requests immediately'
    ).toBe(true);
    expect(
      fullGenome?.coverage,
      'coverage should be available without a hidden settle delay'
    ).toBeTruthy();
    driver.dispose();
  });

  it('reuses a camera-independent coverage band for same-plan pans without transport or publication', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    const firstRange = { start: 2_250_000_000, end: 2_270_000_000 };
    const initial = await feedFor(driver, feeds, firstRange, 2676);
    expect(initial?.coverage, 'initial tile request should produce coverage').toBeTruthy();
    const requestCountAfterFetch = requests.length;

    const samePlanPan = { start: 2_250_001_000, end: 2_270_001_000 };
    feeds.length = 0;
    expect(driver.presentViewport(samePlanPan, 2676)).toBe(true);
    await flushFeedCycle();

    expect(
      requests.length,
      'presentation-only viewport updates must not enqueue sidecar tile requests'
    ).toBe(requestCountAfterFetch);
    expect(
      feeds,
      'camera-only motion must reuse the renderer-owned coverage band without republishing it'
    ).toHaveLength(0);
    expect(coverageCoversRange(initial!.coverage!, samePlanPan)).toBe(true);
    driver.dispose();
  });

  it('reports cache-only presentation failure when no covering surface exists', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: humanScaleAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);

    expect(driver.presentViewport({ start: 2_250_000_000, end: 2_270_000_000 }, 2676)).toBe(false);
    expect(feeds).toHaveLength(0);
    driver.dispose();
  });

  it('acknowledges an unchanged readable band without another feed or fetch', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const reused = vi.fn();
    const driver = new TileEngineDriver({
      assembly: humanScaleAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      onReadPresentationReuse: reused,
      transport: recordingTransport(requests),
    } as never);
    const firstRange = { start: 100_000, end: 126_612 };
    const initial = await feedFor(driver, feeds, firstRange, 1_768, 884);
    expect(initial?.ownerPresentation?.kind).toBe('reads');
    const requestCount = requests.length;
    const publicationCount = feeds.length;
    const moved = { start: 100_010, end: 126_622 };

    expect(driver.presentViewport(moved, 1_768, 884)).toBe(true);

    expect(reused).toHaveBeenCalledOnce();
    expect(reused.mock.lastCall?.[0].feed).toBe(initial);
    expect(reused.mock.lastCall?.[0].viewRange).toEqual(moved);
    expect(reused.mock.lastCall?.[0].requiredReadBandReady).toBe(true);
    expect(reused.mock.lastCall?.[0].feed.records).toBe(initial?.records);
    expect(feeds).toHaveLength(publicationCount);
    expect(requests).toHaveLength(requestCount);
    reused.mockClear();
    expect(driver.presentViewport({ start: 800_000, end: 826_612 }, 1_768, 884)).toBe(false);
    expect(reused).not.toHaveBeenCalled();
    driver.dispose();
  });

  it('memoizes an identical fixed-view coverage generation without rematerializing or republishing it', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const range = { start: 2_000_000, end: 4_000_000 };
    const first = await feedFor(driver, feeds, range, 1024);
    const before = driver.debugSnapshot().coverageMemo;

    feeds.length = 0;
    expect(driver.presentViewport(range, 1024)).toBe(true);
    await flushFeedCycle();

    const after = driver.debugSnapshot().coverageMemo;
    expect(first?.coverage).toBeTruthy();
    expect(feeds, 'an identical camera must keep the existing renderer publication').toHaveLength(
      0
    );
    expect(after.lastRevision).toBe(first?.coverage?.coverageRevision);
    expect(after.materializeCount).toBe(before.materializeCount);
    expect(after.hitCount).toBe(before.hitCount + 1);
    driver.dispose();
  });

  it('keeps read-detail coverage resident without republishing inside the same loaded read window', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: seamDuplicateTransport(),
    } as never);
    const firstRange = { start: 0, end: 512 };
    const viewportPx = 400;

    await feedFor(driver, feeds, firstRange, viewportPx);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const composition = driver.debugSnapshot({
        ...firstRange,
        viewportPx,
      }).readComposition;
      if (
        composition?.readCoversViewport === true &&
        (composition.composedRecordCount ?? 0) > 0 &&
        driver.debugSnapshot().coverageMemo.lastRevision
      ) {
        break;
      }
      await flushFeedCycle();
    }
    const before = driver.debugSnapshot().coverageMemo;
    expect(
      driver.debugSnapshot({ ...firstRange, viewportPx }).readComposition?.readCoversViewport
    ).toBe(true);
    expect(before.lastRevision).not.toBeNull();

    feeds.length = 0;
    const shiftedRange = { start: firstRange.start + 8, end: firstRange.end + 8 };
    expect(driver.presentViewport(shiftedRange, viewportPx)).toBe(true);
    await flushFeedCycle();

    const after = driver.debugSnapshot().coverageMemo;
    expect(
      feeds,
      'camera-only movement inside the resident exact-read band must not republish identical scientific data'
    ).toHaveLength(0);
    expect(after.materializeCount).toBe(before.materializeCount);
    expect(after.revisionChangeCount).toBe(before.revisionChangeCount);
    expect(after.lastRevision).toBe(before.lastRevision);
    driver.dispose();
  });

  it('computes soft retention once per committed viewport', () => {
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: fakeTransport(),
    } as never);
    const cache = (driver as unknown as { cache: { setRetained: (keys: unknown[]) => void } })
      .cache;
    const setRetained = vi.spyOn(cache, 'setRetained');

    driver.setViewport({ start: 2_499_000, end: 2_501_000 }, 1024);

    expect(
      setRetained,
      'one wheel commit must not rebuild the same allocation-heavy retention set twice'
    ).toHaveBeenCalledTimes(1);
    driver.dispose();
  });

  it('mean-pools a complete nonuniform exact child hierarchy identically to its exact parent', () => {
    const compose = (level: number, binSize: number, bins: number[]) => {
      const feeds: TileEngineFeed[] = [];
      const driver = new TileEngineDriver({
        assembly: twoChromAssembly(),
        source: { bamPath: '/fake.bam' },
        baseUrl: 'http://sidecar',
        onFeed: (feed) => feeds.push(feed),
        transport: fakeTransport(),
      } as never);
      const internals = driver as unknown as {
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
      internals.exactCoverageTiles.set(`covasm:mean:${level}:0`, {
        key: { sourceId: 'covasm:mean', level, index: 0 },
        slices: [
          {
            globalStart: 0,
            globalEnd: 32_768,
            binSize,
            payload: {
              bins,
              binSize,
              provenance: { exact: true, method: 'mean-authority-test' },
            },
          },
        ],
        order: 1,
      });

      driver.presentViewport({ start: 0, end: 32_768 }, 8_192);
      const coverage = feeds.at(-1)?.coverage;
      driver.dispose();
      return coverage;
    };

    const childBins = Array.from({ length: 32_768 }, (_, index) => {
      const withinParent = index % 4;
      const parentIndex = Math.floor(index / 4);
      if (withinParent % 2 === 0) return 0;
      return parentIndex % 2 === 0 ? 8 : 12;
    });
    const parentBins = Array.from({ length: 8_192 }, (_, index) => (index % 2 === 0 ? 4 : 6));
    const fromChildren = compose(0, 1, childBins);
    const fromParent = compose(2, 4, parentBins);

    expect(fromChildren?.binSize).toBe(4);
    expect(fromChildren?.bins).toEqual(parentBins);
    expect(fromChildren?.bins).toEqual(fromParent?.bins);
    expect(fromChildren?.maxDepth).toBe(fromParent?.maxDepth);
  });

  it('does not publish or rematerialize when an incomplete finer exact arrival cannot replace a complete parent authority', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      exactCoverageGeneration: number;
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
      scheduleFeed: () => void;
    };
    internals.exactCoverageTiles.set('covasm:mean:2:0', {
      key: { sourceId: 'covasm:mean', level: 2, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: 8,
          binSize: 4,
          payload: {
            bins: [4, 6],
            binSize: 4,
            provenance: { exact: true, method: 'mean-authority-test' },
          },
        },
      ],
      order: 1,
    });
    internals.exactCoverageGeneration += 1;
    driver.presentViewport({ start: 0, end: 8 }, 2);
    const parent = feeds.at(-1)?.coverage;
    const before = driver.debugSnapshot().coverageMemo;

    feeds.length = 0;
    internals.exactCoverageTiles.set('covasm:mean:0:0', {
      key: { sourceId: 'covasm:mean', level: 0, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: 2,
          binSize: 1,
          payload: {
            bins: [0, 8],
            binSize: 1,
            provenance: { exact: true, method: 'mean-authority-test' },
          },
        },
      ],
      order: 2,
    });
    internals.exactCoverageGeneration += 1;
    internals.scheduleFeed();
    await flushFeedCycle();

    const after = driver.debugSnapshot().coverageMemo;
    expect(parent?.bins).toEqual([4, 6]);
    expect(after.materializeCount).toBe(before.materializeCount);
    expect(after.revisionChangeCount).toBe(before.revisionChangeCount);
    expect(after.lastRevision).toBe(before.lastRevision);
    expect(feeds, 'a redundant incomplete child arrival must not emit renderer work').toHaveLength(
      0
    );

    internals.exactCoverageTiles.set('covasm:mean:0:1', {
      key: { sourceId: 'covasm:mean', level: 0, index: 1 },
      slices: [
        {
          globalStart: 2,
          globalEnd: 8,
          binSize: 1,
          payload: {
            bins: [0, 8, 0, 12, 0, 12],
            binSize: 1,
            provenance: { exact: true, method: 'mean-authority-test' },
          },
        },
      ],
      order: 3,
    });
    internals.exactCoverageGeneration += 1;
    internals.scheduleFeed();
    await flushFeedCycle();

    const complete = driver.debugSnapshot().coverageMemo;
    expect(complete.materializeCount).toBe(before.materializeCount + 1);
    expect(complete.revisionChangeCount).toBe(before.revisionChangeCount + 1);
    expect(
      feeds,
      'the finer hierarchy becomes visible atomically once viewport-complete'
    ).toHaveLength(1);
    expect(feeds.at(-1)?.coverage?.binSize).toBe(1);
    expect(feeds.at(-1)?.coverage?.bins).toEqual([0, 8, 0, 8, 0, 12, 0, 12]);
    driver.dispose();
  });

  it('gives replacement drivers non-colliding first coverage revisions', async () => {
    const range = { start: 2_000_000, end: 4_000_000 };
    const feedsA: TileEngineFeed[] = [];
    const feedsB: TileEngineFeed[] = [];
    const driverA = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feedsA.push(feed),
      transport: fakeTransport(),
    } as never);
    const driverB = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feedsB.push(feed),
      transport: fakeTransport(),
    } as never);

    const firstA = await feedFor(driverA, feedsA, range, 1024);
    const firstB = await feedFor(driverB, feedsB, range, 1024);
    expect(firstA?.coverage?.coverageRevision).toBeTruthy();
    expect(firstB?.coverage?.coverageRevision).toBeTruthy();
    expect(firstB?.coverage?.coverageRevision).not.toBe(firstA?.coverage?.coverageRevision);
    expect(driverB.debugSnapshot().coverageMemo.producerEpoch).not.toBe(
      driverA.debugSnapshot().coverageMemo.producerEpoch
    );
    driverA.dispose();
    driverB.dispose();
  });

  it('invalidates the fixed-view memo when an exact coverage generation changes', () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const internals = driver as unknown as {
      exactCoverageGeneration: number;
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
    const install = (value: number) => {
      internals.exactCoverageTiles.set('covasm:test:0:0', {
        key: { sourceId: 'covasm:test', level: 0, index: 0 },
        slices: [
          {
            globalStart: 0,
            globalEnd: 1,
            binSize: 1,
            payload: {
              bins: [value],
              binSize: 1,
              provenance: { exact: true, method: 'memo-generation-test' },
            },
          },
        ],
        order: internals.exactCoverageGeneration + 1,
      });
      internals.exactCoverageGeneration += 1;
    };

    install(11);
    driver.presentViewport({ start: 0, end: 1 }, 1);
    const first = feeds.at(-1)?.coverage;
    const before = driver.debugSnapshot().coverageMemo;
    install(99);
    driver.presentViewport({ start: 0, end: 1 }, 1);
    const second = feeds.at(-1)?.coverage;
    const after = driver.debugSnapshot().coverageMemo;

    expect(first?.bins[0]).toBe(11);
    expect(second?.bins[0]).toBe(99);
    expect(second).not.toBe(first);
    expect(second?.coverageRevision).not.toBe(first?.coverageRevision);
    expect(after.materializeCount).toBe(before.materializeCount + 1);
    expect(after.revisionChangeCount).toBe(before.revisionChangeCount + 1);
    driver.dispose();
  });

  it('requests and emits coverage for human-scale full-genome overview, not an empty placeholder', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    const fullGenome = await feedFor(
      driver,
      feeds,
      { start: 0, end: assembly.totalLengthBp },
      2676
    );

    expect(fullGenome?.coverage, 'full-genome overview coverage present').toBeTruthy();
    expect(
      requests.some((req) => req.kind === 'coverage-assembly' && req.level > 14),
      'human-scale overview must request a broad coverage LOD instead of relying on no data'
    ).toBe(true);
    expect(
      requests.some((req) => req.kind === 'coverage'),
      'human-scale overview must not fan out through legacy per-chrom coverage sources'
    ).toBe(false);
    driver.dispose();
  });

  it('does not request an unavailable whole-genome coverage backstop for a remote source', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: {
        bamPath: 'http://127.0.0.1:45678/alignment',
        indexPath: '/cached/remote.bam.bai',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/remote.bam',
            indexPath: '/data/remote.bam.bai',
          },
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    await feedFor(driver, feeds, { start: 1_543_000_000, end: 1_543_010_000 }, 2676);

    const unavailableResidentLevel = maxLevelForAssembly(assembly) - 1;
    const boundedForegroundLevel = maxBoundedForegroundCoverageLevel();
    const coverageRequests = requests.filter((request) => request.kind === 'coverage-assembly');
    const alignmentRequests = requests.filter((request) => request.kind === 'alignment');
    expect(boundedForegroundLevel).toBe(10);
    expect(
      requests.some(
        (request) =>
          request.kind === 'coverage-assembly' && request.level < unavailableResidentLevel
      ),
      'remote sources must still request viewport-local exact coverage'
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.kind === 'coverage-assembly' && request.level === unavailableResidentLevel
      ),
      'remote sources have no prepared whole-genome pyramid and must not retry its permanent 425 response'
    ).toBe(false);
    expect(
      coverageRequests.every((request) => request.level <= boundedForegroundLevel),
      'remote sources must not enqueue any level that requires a prepared coverage pyramid'
    ).toBe(true);
    expect(
      coverageRequests.length,
      'remote first paint must keep coverage fan-out bounded'
    ).toBeLessThanOrEqual(32);
    expect(
      alignmentRequests.length,
      'remote first paint must keep alignment fan-out bounded'
    ).toBeLessThanOrEqual(20);
    driver.dispose();
  });

  it('does not scan a remote BAM for coverage when a BigWig histogram is attached', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: {
        bamPath: 'http://127.0.0.1:45678/alignment',
        indexPath: '/cached/remote.bam.bai',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/remote.bam',
            indexPath: '/data/remote.bam.bai',
            signalPath: '/data/bigwig/remote.bigWig',
          },
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: recordingTransport(requests),
    } as never);

    const feed = await feedFor(driver, feeds, { start: 1_543_000_000, end: 1_583_000_000 }, 2676);

    expect(requests.some((request) => request.kind === 'coverage-assembly')).toBe(false);
    expect(requests.some((request) => request.kind === 'coverage')).toBe(false);
    expect(feed?.ownerPresentation).toEqual({ kind: 'coverage' });
    driver.dispose();
  });

  it('declares an empty exact-read viewport after the bounded remote tile band settles', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const base = fakeTransport();
    const transport: TileTransport = async (request, signal) => {
      requests.push(request);
      if (request.kind !== 'alignment') return base(request, signal);
      return {
        ok: true,
        status: 200,
        body: {
          reads: [],
          alternateColumns: [],
          count: 0,
          sourceCount: 0,
          level: request.level,
          tileIndex: request.tileIndex,
        },
      };
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: {
        bamPath: 'http://127.0.0.1:45678/alignment',
        indexPath: '/cached/remote.bam.bai',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/remote.bam',
            indexPath: '/data/remote.bam.bai',
          },
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport,
    } as never);
    const view = { start: 2_499_000, end: 2_501_000 };

    await feedFor(driver, feeds, view, 1024);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (feeds.at(-1)?.ownerPresentation?.kind === 'empty') break;
      await flushFeedCycle();
    }

    const readComposition = driver.debugSnapshot({ ...view, viewportPx: 1024 }).readComposition;
    const currentLevel = driver.debugSnapshot().level;
    expect(
      requests.filter((request) => request.kind === 'alignment' && request.level === currentLevel)
        .length,
      'the remote empty proof must remain a bounded network working set'
    ).toBeLessThanOrEqual(4);
    expect(readComposition?.stableBandReady).toBe(true);
    expect(readComposition?.readyBandTileCount).toBe(readComposition?.expectedBandTileCount);
    expect(readComposition?.composedRecordCount).toBe(0);
    expect(feeds.at(-1)?.ownerPresentation).toEqual({ kind: 'empty' });

    driver.dispose();
  });

  it('settles an empty bounded-remote read band at the clipped end of the assembly', async () => {
    const assembly = buildAssembly('assembly-end', 'assembly end', [
      {
        id: 'chrMain',
        displayName: 'chrMain',
        length: 3_137_157_002,
        cytobands: [],
      },
      { id: 'chrTail', displayName: 'chrTail', length: 4_262, cytobands: [] },
    ] as never);
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const transport: TileTransport = async (request) => {
      requests.push(request);
      if (request.kind !== 'alignment') {
        throw new Error(`unexpected ${request.kind} request for BigWig-backed remote reads`);
      }
      return {
        ok: true,
        status: 200,
        body: {
          reads: [],
          alternateColumns: [],
          count: 0,
          sourceCount: 0,
          level: request.level,
          tileIndex: request.tileIndex,
        },
      };
    };
    const driver = new TileEngineDriver({
      assembly,
      source: {
        bamPath: 'http://127.0.0.1:45678/alignment',
        indexPath: '/cached/remote.cram.crai',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/remote.cram',
            indexPath: '/data/remote.cram.crai',
            signalPath: '/data/bigwig/remote.bigWig',
          },
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport,
    } as never);
    const view = {
      start: assembly.totalLengthBp - 1_000,
      end: assembly.totalLengthBp,
    };

    await feedFor(driver, feeds, view, 5_542);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (feeds.at(-1)?.ownerPresentation?.kind === 'empty') break;
      await flushFeedCycle();
    }

    const snapshot = driver.debugSnapshot({ ...view, viewportPx: 5_542 });
    const currentAlignmentRequests = requests.filter(
      (request) => request.kind === 'alignment' && request.level === snapshot.level
    );
    expect(snapshot.level).toBe(0);
    expect(currentAlignmentRequests.map((request) => request.tileIndex).sort()).toEqual([
      3_063_632, 3_063_633, 3_063_634,
    ]);
    expect(snapshot.aln.pending).toBe(0);
    expect(snapshot.aln.error).toBe(0);
    expect(snapshot.readComposition?.readyBandTileCount).toBe(3);
    expect(snapshot.readComposition?.expectedBandTileCount).toBe(3);
    expect(snapshot.readComposition?.stableBandReady).toBe(true);
    expect(feeds.at(-1)?.ownerPresentation).toEqual({ kind: 'empty' });

    driver.dispose();
  });

  it('keeps production full-genome cold-start warmup bounded to the next declared handoff', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);

    const firstCoverageAssemblyLevel = (level: number): number =>
      requests.findIndex((req) => req.kind === 'coverage-assembly' && req.level === level);
    const firstDeepCritical = firstCoverageAssemblyLevel(17);
    expect(
      firstCoverageAssemblyLevel(20),
      'overview must start L20 before deep L17 warmup'
    ).toBeGreaterThanOrEqual(0);
    expect(
      firstCoverageAssemblyLevel(19),
      'overview must start L19 before deep L17 warmup'
    ).toBeGreaterThanOrEqual(0);
    expect(
      firstCoverageAssemblyLevel(18),
      'overview must start L18 before deep L17 warmup'
    ).toBeGreaterThanOrEqual(0);
    expect(
      firstDeepCritical,
      'overview must still queue the L17 critical warmup'
    ).toBeGreaterThanOrEqual(0);
    expect(firstCoverageAssemblyLevel(20)).toBeLessThan(firstDeepCritical);
    expect(firstCoverageAssemblyLevel(19)).toBeLessThan(firstDeepCritical);
    expect(firstCoverageAssemblyLevel(18)).toBeLessThan(firstDeepCritical);
    for (const level of [15, 16, 17]) {
      const levelRequests = requests.filter(
        (req) => req.kind === 'coverage-assembly' && req.level === level
      );
      expect(
        levelRequests.length,
        `full-genome cold start must warm a locus-centered L${level} handoff`
      ).toBeGreaterThanOrEqual(1);
      expect(
        levelRequests.length,
        `full-genome cold start must not expand the L${level} handoff across the whole assembly`
      ).toBeLessThanOrEqual(3);
    }
    for (let level = 4; level < 15; level += 1) {
      expect(
        requests.some((req) => req.kind === 'coverage-assembly' && req.level === level),
        `full-genome cold start must not occupy transport or trigger publications for distant L${level}`
      ).toBe(false);
    }
    expect(
      requests.some((req) => req.kind === 'coverage-assembly' && req.level === 2),
      'full-genome overview must not warm exact read-density coverage; that staged handoff starts nearer read zoom to keep overview bounded'
    ).toBe(false);
    expect(
      requests.some((req) => req.kind === 'coverage-assembly' && req.level === 3),
      'full-genome overview must not warm the read-density bridge; that staged handoff starts nearer read zoom to keep overview bounded'
    ).toBe(false);

    for (const span of [2_200_000_000, 1_300_000_000, 500_000_000, 350_000_000, 150_000_000]) {
      const requestsBeforeStep = requests.length;
      const start = Math.floor((assembly.totalLengthBp - span) / 2);
      await feedFor(driver, feeds, { start, end: start + span }, 2676);
      const stepRequests = requests.slice(requestsBeforeStep);
      expect(
        stepRequests.filter((req) => req.kind === 'coverage-assembly').length,
        `${span}: one zoom step must not expand the whole-genome coarse pyramid`
      ).toBeLessThanOrEqual(48);
      expect(
        requests.some(
          (req) => req.kind === 'coverage-assembly' && (req.level === 2 || req.level === 3)
        ),
        `${span}: broad cold corridor must not launch read-density L3/L2 work`
      ).toBe(false);
      expect(
        requests.some((req) => req.kind === 'alignment'),
        `${span}: broad cold corridor must not launch read-row L2/L1 work`
      ).toBe(false);
    }
    driver.dispose();
  });

  it('requests bounded directional floor coverage after a fast 1Mb side-pan', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    const initialRange = { start: 1_543_721_334, end: 1_544_548_497 };
    await feedFor(driver, feeds, initialRange, 2676);
    await feedFor(
      driver,
      feeds,
      { start: initialRange.start + 1_000_000, end: initialRange.end + 1_000_000 },
      2676
    );

    const l9CoverageRequests = requests.filter(
      (req) => req.kind === 'coverage-assembly' && req.level === 9
    );
    expect(
      l9CoverageRequests.length,
      'current L9 coverage must be requested'
    ).toBeGreaterThanOrEqual(2);
    const directionalFloorIdentities = new Set(
      requests
        .filter((req) => req.kind === 'coverage-assembly' && (req.level === 7 || req.level === 8))
        .map((req) => `${req.level}:${req.tileIndex}`)
    );
    expect(
      directionalFloorIdentities.size,
      'the velocity-scaled floor window must cross many real tile identities without restoring the old 64-tile current-level flood'
    ).toBeGreaterThanOrEqual(12);
    driver.dispose();
  });

  it('requests enough read-level coverage and bounded read lookahead for sustained side-pan', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    await feedFor(driver, feeds, { start: 1_544_131_380, end: 1_544_138_452 }, 2676);

    const level2CoverageRequests = requests.filter(
      (req) => req.kind === 'coverage-assembly' && req.level === 2
    );
    expect(
      level2CoverageRequests.length,
      'read-level current coverage must include multiple visible/margin tile identities'
    ).toBeGreaterThanOrEqual(2);
    const readFloorCoverageRequests = requests.filter(
      (req) => req.kind === 'coverage-assembly' && (req.level === 0 || req.level === 1)
    );
    expect(
      readFloorCoverageRequests.length,
      'read-level coverage must also warm its finer floor band'
    ).toBeGreaterThanOrEqual(8);

    const level2AlignmentRequests = requests.filter(
      (req) => req.kind === 'alignment' && req.level === 2
    );
    expect(
      level2AlignmentRequests.length,
      'read-level alignment must also look ahead beyond the visible three tiles, otherwise exact rows lag the density handoff on side-pan'
    ).toBeGreaterThanOrEqual(24);
    expect(
      level2AlignmentRequests.length,
      'read-level alignment lookahead must remain bounded; it should not flood a whole chromosome with read payloads'
    ).toBeLessThanOrEqual(48);
    driver.dispose();
  });

  it('drops obsolete pending remote read lookahead during a sustained side-pan', async () => {
    const neverSettlingTransport: TileTransport = () => new Promise(() => {});
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: {
        bamPath: 'http://127.0.0.1:45678/v1/source/alignment.cram',
        indexPath: '/cached/alignment.crai',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-cluster',
            target: 'remote-cluster',
            alignmentPath: '/data/alignment.cram',
            indexPath: '/data/alignment.crai',
            signalPath: '/data/alignment.bigWig',
          },
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: neverSettlingTransport,
    } as never);

    const initialStart = 1_544_000_000;
    const span = 2_000;
    for (let step = 0; step <= 40; step += 1) {
      const start = initialStart + step * tileSpanBp(0);
      driver.setViewport({ start, end: start + span }, 2676);
    }
    await Promise.resolve();

    const debug = driver.debugSnapshot();
    expect(debug.level).toBe(0);
    expect(
      debug.aln.pending,
      'pending requests from earlier camera positions must not occupy the bounded remote queue after the camera has moved away'
    ).toBeLessThanOrEqual(16);
    expect(
      debug.inFlight,
      'the coordinator must retain only the final viewport, one-tile margin, and bounded directional lead'
    ).toBeLessThanOrEqual(16);

    driver.dispose();
  });

  it('keeps exact reads and reloads the full-axis histogram after a read-level side-pan request storm', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    const initialRange = { start: 1_544_131_380, end: 1_544_138_452 };
    const finalRange = { start: 1_544_496_983, end: 1_544_504_055 };
    const center = (initialRange.start + initialRange.end) / 2;
    const wholeGenomeSpan = assembly.totalLengthBp;
    const readSpan = initialRange.end - initialRange.start;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const span = wholeGenomeSpan * Math.pow(readSpan / wholeGenomeSpan, t);
      await feedFor(driver, feeds, { start: center - span / 2, end: center + span / 2 }, 2676);
    }
    await feedFor(driver, feeds, initialRange, 2676);
    const steps = 96;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const start = initialRange.start + (finalRange.start - initialRange.start) * t;
      const end = initialRange.end + (finalRange.end - initialRange.end) * t;
      await feedFor(driver, feeds, { start, end }, 2676);
    }
    await feedFor(driver, feeds, finalRange, 2676);
    const postPanDebug = driver.debugSnapshot();
    const postPanReads = postPanDebug.readComposition;

    expect(postPanDebug.cache.entries).toBeLessThanOrEqual(512);
    expect(
      postPanDebug.cache.pinned,
      'adjacent-gesture retention must never consume hard draw-safety pins'
    ).toBe(0);
    expect(postPanDebug.cache.retained).toBeLessThanOrEqual(512);
    expect(
      postPanReads?.visibleTileCount ?? 0,
      `visible alignment tiles must survive coverage prefetch pressure: ${JSON.stringify(
        postPanDebug.cache
      )}`
    ).toBeGreaterThan(0);
    expect(
      postPanReads?.readyWithReadsTileCount ?? 0,
      'settled read-level viewport must have non-empty exact-read tiles, not density-only fallback'
    ).toBeGreaterThan(0);
    expect(postPanReads?.composedRecordCount ?? 0).toBeGreaterThan(0);

    const pressuredCache = (
      driver as unknown as {
        cache: {
          size: number;
          set: (entry: unknown) => void;
          entries: () => Array<{ key: { sourceId: string; level: number; index: number } }>;
          setRetained: (keys: Array<{ sourceId: string; level: number; index: number }>) => void;
        };
      }
    ).cache;
    for (let index = 0; pressuredCache.size < 512; index++) {
      const key = { sourceId: 'covasm:/fake.bam', level: 22, index: 10_000 + index };
      pressuredCache.set({
        key,
        state: 'ready',
        epoch: 0,
        byteSize: 1,
        data: { key, state: 'ready', byteSize: 1, count: 0, payload: { segments: [] } },
      });
    }
    pressuredCache.setRetained(pressuredCache.entries().map(({ key }) => key));
    expect(driver.debugSnapshot().cache.entries).toBe(512);
    expect(driver.debugSnapshot().cache.retained).toBe(512);

    const stoppedFullAxisRange = { start: 2_261_015_727, end: 2_273_455_562 };
    const recoveredFeed = await feedFor(driver, feeds, stoppedFullAxisRange, 5352, 2676);
    const recovered = driver.debugSnapshot({ ...stoppedFullAxisRange, viewportPx: 5352 });
    expect(recovered.level).toBe(12);
    expect(recovered.cache.entries).toBeLessThanOrEqual(512);
    expect(recovered.cache.pinned).toBe(0);
    expect(recovered.cache.retained).toBeLessThanOrEqual(512);
    expect(recovered.inFlight).toBe(0);
    expect(recovered.coverageComposition?.visibleCoreTileCount).toBeGreaterThanOrEqual(4);
    expect(recovered.coverageComposition?.absentCoreTileCount).toBe(0);
    expect(recovered.coverageComposition?.pendingCoreTileCount).toBe(0);
    expect(recovered.coverageComposition?.exactReadyCoreTileCount).toBeGreaterThanOrEqual(4);
    expect(recovered.coverageComposition?.coversViewport).toBe(true);
    expect(recoveredFeed?.coverage).toBeTruthy();
    expect(coverageCoversRange(recoveredFeed!.coverage!, stoppedFullAxisRange)).toBe(true);
    driver.dispose();
  });

  it('does not republish an identical resident exact-read feed on read-level pan commits', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: seamDuplicateTransport(),
    } as never);

    const finalRange = { start: 2_500_000, end: 2_507_072 };
    await feedFor(driver, feeds, { start: 2_499_000, end: 2_506_072 }, 2676);
    for (let i = 0; i < 10; i++) {
      const readComposition = driver.debugSnapshot({
        ...finalRange,
        viewportPx: 2676,
      }).readComposition;
      if ((readComposition?.composedRecordCount ?? 0) > 0) break;
      await flushFeedCycle();
    }
    expect(
      driver.debugSnapshot({ ...finalRange, viewportPx: 2676 }).readComposition
        ?.composedRecordCount ?? 0,
      'sanity: the target read-pan locus must already be resident before testing synchronous emission'
    ).toBeGreaterThan(0);
    feeds.length = 0;
    driver.setViewport(finalRange, 2676);

    expect(
      feeds,
      'the renderer already owns the covering resident read band, so the commit is camera-only'
    ).toHaveLength(0);
    driver.dispose();
  });

  it('composes a bounded resident read halo from already-prefetched BAM tiles', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: seamDuplicateTransport(),
    } as never);
    const range = { start: 2_500_000, end: 2_507_072 };

    const feed = await feedFor(driver, feeds, range, 2676);
    const level = driver.debugSnapshot().level;
    expect(level).not.toBeNull();
    const span = tileSpanBp(level!);
    const visibleTileStart = Math.floor(range.start / span) * span;
    const visibleTileEnd = Math.ceil(range.end / span) * span;

    expect(feed?.readSource?.windowStartBp).toBeLessThanOrEqual(visibleTileStart - span * 4);
    expect(feed?.readSource?.windowEndBp).toBeGreaterThanOrEqual(visibleTileEnd + span * 4);
    expect(feed?.records.length ?? 0).toBeGreaterThan(0);
    driver.dispose();
  });

  it('keeps guide projections reusable without carrying broad view state into exact-read detail', () => {
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: seamDuplicateTransport(),
    } as never);
    const level = 0;
    const span = tileSpanBp(level);
    const broadView = {
      globalStart: 0,
      globalEnd: 40 * span,
      viewportPx: 300,
    };
    const narrowView = {
      globalStart: 4 * span + span / 2,
      globalEnd: 5 * span + span / 2,
      viewportPx: 1_000,
    };
    const internals = driver as unknown as {
      cache: {
        set: (entry: unknown) => void;
        evict: (key: { sourceId: string; level: number; index: number }) => boolean;
      };
      composeReads: (
        viewport: typeof narrowView,
        targetLevel: number
      ) => {
        records: ReadonlyArray<unknown>;
        alternateColumns: ReadonlyArray<unknown>;
        windowStartBp?: number;
        windowEndBp?: number;
        revisionKey: string;
      };
      ensureSourcesForRange: (globalStart: number, globalEnd: number) => void;
    };
    internals.ensureSourcesForRange(0, 48 * span);
    const sourceId = 'aln:/fake.bam:chrA';
    const keyFor = (index: number) => ({ sourceId, level, index });
    const publishReadyTile = (index: number) => {
      const key = keyFor(index);
      const start = index * span;
      internals.cache.set({
        key,
        state: 'ready',
        epoch: 1,
        byteSize: 1,
        data: {
          key,
          state: 'ready',
          byteSize: 1,
          count: 1,
          payload: {
            reads: [
              {
                start: start + 100,
                end: start + 250,
                strand: '+',
                mapq: 60,
                readId: `tile-${index}`,
                flag: 0,
              },
            ],
            alternateColumns: [{ pos: start + 120, ref: 'A', alt: 'G', count: 1 }],
            truncated: false,
          },
        },
      });
    };

    for (let index = 0; index < 48; index += 1) publishReadyTile(index);
    const broad = internals.composeReads(broadView, level);
    expect(broad.records, 'broad guide-only composition must not allocate exact records').toEqual(
      []
    );
    expect(broad.alternateColumns).toHaveLength(48);
    expect(broad.windowEndBp! - broad.windowStartBp!).toBe(48 * span);

    for (let index = 0; index < 48; index += 1) {
      if (index === 4 || index === 5) continue;
      internals.cache.evict(keyFor(index));
    }
    const narrow = internals.composeReads(narrowView, level);

    expect(
      narrow.revisionKey,
      'a prior zoom-out cache entry must not become the narrow renderer payload'
    ).not.toBe(broad.revisionKey);
    expect(narrow.records).toHaveLength(2);
    expect(narrow.alternateColumns).toHaveLength(2);
    expect(narrow.windowStartBp).toBe(4 * span);
    expect(narrow.windowEndBp).toBe(6 * span);
    driver.dispose();
  });

  it('retires viewport-derived exact-read state without evicting reusable raw BAM tiles', () => {
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: seamDuplicateTransport(),
    } as never);
    const internals = driver as unknown as {
      cache: {
        set: (entry: unknown) => void;
        size: number;
        has: (key: unknown) => boolean;
      };
      updatePresentationViewport: (
        range: { start: number; end: number },
        viewportPx: number,
        presentationViewportPx: number
      ) => unknown;
      readCompositionCache: Map<string, unknown>;
      exactReadDetailEligible: boolean;
      lastPublishedReadRevisionKey: string | null;
    };
    const key = { sourceId: 'aln:/fake.bam:chrA', level: 0, index: 0 };
    internals.cache.set({
      key,
      state: 'ready',
      epoch: 1,
      byteSize: 1,
      data: {
        key,
        state: 'ready',
        byteSize: 1,
        count: 1,
        payload: { reads: [], alternateColumns: [], truncated: false },
      },
    });

    internals.updatePresentationViewport({ start: 0, end: 50_000 }, 1_000, 1_000);
    expect(internals.exactReadDetailEligible).toBe(true);
    internals.readCompositionCache.set('detail-generation', {});
    internals.lastPublishedReadRevisionKey = 'detail-generation';
    const rawTileCount = internals.cache.size;
    const pendingAbort = new AbortController();
    const pendingKey = { sourceId: 'aln:/fake.bam:chrA', level: 0, index: 1 };
    internals.cache.set({
      key: pendingKey,
      state: 'pending',
      epoch: 2,
      byteSize: 0,
      abort: pendingAbort,
    });

    internals.updatePresentationViewport({ start: 0, end: 500_000 }, 1_000, 1_000);

    expect(internals.exactReadDetailEligible).toBe(false);
    expect(internals.readCompositionCache.size).toBe(0);
    expect(internals.lastPublishedReadRevisionKey).toBeNull();
    expect(pendingAbort.signal.aborted, 'unfinished exact-read I/O is retired with its owner').toBe(
      true
    );
    expect(internals.cache.has(pendingKey)).toBe(false);
    expect(internals.cache.size, 'raw BAM tile cache remains reusable across LOD changes').toBe(
      rawTileCount
    );
    driver.dispose();
  });

  it('uses display pixels—not the supersampled coverage grid—as exact-read authority', () => {
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: seamDuplicateTransport(),
    } as never);
    const internals = driver as unknown as {
      exactReadDetailEligible: boolean;
      sources: Array<{ id: string }>;
    };

    driver.setViewport({ start: 0, end: 120_000 }, 2_308, 1_154);
    expect(internals.exactReadDetailEligible).toBe(false);
    expect(internals.sources.some((source) => source.id.startsWith('aln:'))).toBe(false);

    driver.setViewport({ start: 0, end: 100_000 }, 2_308, 1_154);
    expect(internals.exactReadDetailEligible).toBe(true);
    expect(internals.sources.some((source) => source.id.startsWith('aln:'))).toBe(true);
    driver.dispose();
  });

  it('holds one covering read generation until the complete prefetched band is ready', () => {
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: seamDuplicateTransport(),
    } as never);
    const level = 0;
    const span = tileSpanBp(level);
    const view = {
      globalStart: 4 * span + span / 2,
      globalEnd: 5 * span + span / 2,
      viewportPx: 1_000,
    };
    const internals = driver as unknown as {
      cache: {
        set: (entry: unknown) => void;
      };
      composeReads: (
        viewport: typeof view,
        targetLevel: number
      ) => {
        records: ReadonlyArray<unknown>;
        windowStartBp?: number;
        windowEndBp?: number;
        revisionKey: string;
        coversViewport: boolean;
        stableBandReady: boolean;
        readyBandTileCount: number;
        expectedBandTileCount: number;
      };
      ensureSourcesForRange: (globalStart: number, globalEnd: number) => void;
    };
    internals.ensureSourcesForRange(0, 16 * span);
    const publishReadyTile = (index: number) => {
      const key = { sourceId: 'aln:/fake.bam:chrA', level, index };
      const start = index * span;
      internals.cache.set({
        key,
        state: 'ready',
        epoch: 1,
        byteSize: 1,
        data: {
          key,
          state: 'ready',
          byteSize: 1,
          count: 1,
          payload: {
            reads: [
              {
                start: start + 100,
                end: start + 250,
                strand: '+',
                mapq: 60,
                readId: `tile-${index}`,
                flag: 0,
              },
            ],
            alternateColumns: [],
            truncated: false,
          },
        },
      });
    };

    publishReadyTile(4);
    publishReadyTile(5);
    const first = internals.composeReads(view, level);
    expect(first.coversViewport).toBe(true);
    expect(first.records).toHaveLength(2);
    expect(first.stableBandReady).toBe(false);
    expect(first.readyBandTileCount).toBe(2);
    expect(first.expectedBandTileCount).toBe(16);

    publishReadyTile(6);
    const partialExpansion = internals.composeReads(view, level);
    expect(
      partialExpansion.revisionKey,
      'one late halo tile must not restart the renderer while the current read generation still covers the camera'
    ).toBe(first.revisionKey);
    expect(partialExpansion.windowStartBp).toBe(first.windowStartBp);
    expect(partialExpansion.windowEndBp).toBe(first.windowEndBp);

    for (let index = 0; index < 4; index += 1) publishReadyTile(index);
    const stagedHandoff = internals.composeReads(view, level);
    expect(
      stagedHandoff.revisionKey,
      'a partial halo must not replace the current covering generation before the fixed-size band is complete'
    ).toBe(first.revisionKey);
    expect(stagedHandoff.windowStartBp).toBe(first.windowStartBp);
    expect(stagedHandoff.windowEndBp).toBe(first.windowEndBp);

    publishReadyTile(7);
    const oneTileAfterHandoff = internals.composeReads(view, level);
    expect(
      oneTileAfterHandoff.revisionKey,
      'successive partial arrivals must remain data-cache-only until the atomic band handoff'
    ).toBe(first.revisionKey);

    for (let index = 0; index < 16; index += 1) publishReadyTile(index);
    const completeBand = internals.composeReads(view, level);
    expect(completeBand.revisionKey).not.toBe(first.revisionKey);
    expect(completeBand.stableBandReady).toBe(true);
    expect(completeBand.readyBandTileCount).toBe(16);
    expect(completeBand.expectedBandTileCount).toBe(16);
    expect(completeBand.records).toHaveLength(16);
    expect(completeBand.windowStartBp).toBe(0);
    expect(completeBand.windowEndBp).toBe(16 * span);

    driver.dispose();
  });

  it('keeps every visible boundary-crossing read before and after offscreen halo completion', () => {
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: seamDuplicateTransport(),
    } as never);
    const level = 0;
    const span = tileSpanBp(level);
    const view = { globalStart: 4.5 * span, globalEnd: 5.5 * span, viewportPx: 1_000 };
    const crossing = [
      { readId: 'left-edge', start: view.globalStart - 75, end: view.globalStart + 75 },
      { readId: 'tile-seam', start: 5 * span - 75, end: 5 * span + 75 },
      { readId: 'right-edge', start: view.globalEnd - 75, end: view.globalEnd + 75 },
      { readId: 'long-collar-overlap', start: 4 * span - 75, end: view.globalStart + 100 },
    ];
    const reads = [
      ...Array.from({ length: 16 }, (_, index) => ({
        readId: `tile-${index}`,
        start: index * span + 100,
        end: index * span + 250,
      })),
      ...crossing,
    ].map((record) => ({ ...record, strand: '+', mapq: 60, flag: 0 }));
    const internals = driver as unknown as {
      cache: { set: (entry: unknown) => void };
      ensureSourcesForRange: (start: number, end: number) => void;
      composeReads: (viewport: typeof view, level: number) => {
        records: ReadonlyArray<{ readId: string; start: number; end: number }>;
        coversViewport: boolean;
        stableBandReady: boolean;
        truncated: boolean;
      };
    };
    internals.ensureSourcesForRange(0, 16 * span);
    const ready = (index: number) => {
      const key = { sourceId: 'aln:/fake.bam:chrA', level, index };
      const records = reads.filter(
        (read) => read.end > index * span && read.start < (index + 1) * span
      );
      internals.cache.set({
        key,
        state: 'ready',
        epoch: 1,
        byteSize: 1,
        data: {
          key,
          state: 'ready',
          byteSize: 1,
          count: records.length,
          payload: { reads: records, alternateColumns: [], truncated: false },
        },
      });
    };
    const visibleIds = (records: ReadonlyArray<{ readId: string; start: number; end: number }>) =>
      records
        .filter((read) => read.end > view.globalStart && read.start < view.globalEnd)
        .map((read) => read.readId)
        .sort();

    ready(4);
    expect(internals.composeReads(view, level).coversViewport).toBe(false);
    ready(5);
    const current = internals.composeReads(view, level);
    expect(current.coversViewport).toBe(true);
    expect(current.stableBandReady).toBe(false);
    expect(current.truncated).toBe(false);
    expect(visibleIds(current.records)).toEqual(visibleIds(reads));

    for (let index = 0; index < 16; index++) ready(index);
    const expanded = internals.composeReads(view, level);
    expect(expanded.coversViewport).toBe(true);
    expect(expanded.stableBandReady).toBe(true);
    expect(expanded.truncated).toBe(false);
    expect(visibleIds(expanded.records)).toEqual(visibleIds(current.records));
    expect(new Set(expanded.records.map((read) => read.readId)).size).toBe(expanded.records.length);
    driver.dispose();
  });

  it('clips the stable read band to the chromosome owning a boundary-adjacent viewport', () => {
    const assembly = buildAssembly('short-boundary', 'short boundary', [
      { id: 'chrA', displayName: 'chrA', length: 40_000, cytobands: [] },
      { id: 'chrB', displayName: 'chrB', length: 32_000, cytobands: [] },
    ] as never);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: seamDuplicateTransport(),
    } as never);
    const level = 0;
    const span = tileSpanBp(level);
    const view = {
      globalStart: 48_050,
      globalEnd: 48_550,
      viewportPx: 1_000,
    };
    const internals = driver as unknown as {
      cache: {
        set: (entry: unknown) => void;
      };
      composeReads: (
        viewport: typeof view,
        targetLevel: number
      ) => {
        records: ReadonlyArray<unknown>;
        stableBandReady: boolean;
        readyBandTileCount: number;
        expectedBandTileCount: number;
      };
      ensureSourcesForRange: (globalStart: number, globalEnd: number) => void;
    };
    internals.ensureSourcesForRange(view.globalStart, view.globalEnd);

    for (let index = 39; index <= 53; index += 1) {
      const key = { sourceId: 'aln:/fake.bam:chrB', level, index };
      const localTileStart = index * span - 40_000;
      internals.cache.set({
        key,
        state: 'ready',
        epoch: 1,
        byteSize: 1,
        data: {
          key,
          state: 'ready',
          byteSize: 1,
          count: index === 47 ? 1 : 0,
          payload: {
            reads:
              index === 47
                ? [
                    {
                      start: localTileStart + 100,
                      end: localTileStart + 250,
                      strand: '+',
                      mapq: 60,
                      readId: 'boundary-read',
                      flag: 0,
                    },
                  ]
                : [],
            alternateColumns: [],
            truncated: false,
          },
        },
      });
    }

    const composed = internals.composeReads(view, level);
    expect(composed.stableBandReady).toBe(true);
    expect(composed.readyBandTileCount).toBe(15);
    expect(composed.expectedBandTileCount).toBe(15);
    expect(composed.records).toHaveLength(1);

    driver.dispose();
  });

  it('keeps a chromosome fragment pending when its neighbor shares the same global tile', async () => {
    const assembly = buildAssembly('split-tile', 'split tile', [
      { id: 'chrA', displayName: 'chrA', length: 1_500, cytobands: [] },
      { id: 'chrB', displayName: 'chrB', length: 1_500, cytobands: [] },
    ] as never);
    const feeds: TileEngineFeed[] = [];
    const held = deferred<Awaited<ReturnType<TileTransport>>>();
    let heldRequestCount = 0;
    const alignmentReply = (chrom: string): Awaited<ReturnType<TileTransport>> => ({
      ok: true,
      status: 200,
      body: {
        reads: [
          {
            start: chrom === 'chrA' ? 1_400 : 10,
            end: chrom === 'chrA' ? 1_450 : 60,
            strand: '+',
            mapq: 60,
            readId: `${chrom}-seam-read`,
          },
        ],
        alternateColumns: [],
        truncated: false,
      },
    });
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: (request: Parameters<TileTransport>[0], signal: AbortSignal) => {
        if (request.kind !== 'alignment') return fakeTransport()(request, signal);
        const chrom = String(request.body.chrom);
        if (request.level === 0 && request.tileIndex === 1) {
          if (chrom === 'chrB') {
            heldRequestCount += 1;
            signal.addEventListener('abort', () => held.reject(new Error('aborted')), {
              once: true,
            });
            return held.promise;
          }
          return Promise.resolve(alignmentReply(chrom));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          body: { reads: [], alternateColumns: [], truncated: false },
        });
      },
    } as never);
    const view = { start: 1_400, end: 1_600 };

    try {
      await feedFor(driver, feeds, view, 1024);
      await flushFeedCycle();
      expect(heldRequestCount).toBe(1);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) {
          driver.presentViewport(view, 1024);
          await flushFeedCycle();
        }
        const pending = driver.debugSnapshot();
        expect(pending.aln.pending).toBe(1);
        expect
          .soft(
            pending.readComposition?.stableBandReady,
            'a ready chrA fragment cannot settle the pending chrB half of the same tile'
          )
          .toBe(false);
        expect.soft(pending.readComposition?.readCoversViewport).toBe(false);
        expect.soft(feeds.at(-1)?.ownerPresentation?.kind).not.toBe('reads');
        expect.soft(feeds.at(-1)?.ownerPresentation?.kind).not.toBe('empty');
        expect
          .soft(
            feeds
              .at(-1)
              ?.referenceIntervals?.some(
                (interval) =>
                  interval.state === 'pending' &&
                  interval.startBp <= 1_500 &&
                  interval.endBp >= 1_600
              )
          )
          .toBe(true);
      }

      held.resolve(alignmentReply('chrB'));
      await flushFeedCycle();
      const complete = driver.debugSnapshot();
      expect(complete.aln.pending).toBe(0);
      expect(complete.readComposition?.stableBandReady).toBe(true);
      expect(complete.readComposition?.readCoversViewport).toBe(true);
      expect(feeds.at(-1)?.ownerPresentation).toEqual({ kind: 'reads' });
      expect(
        feeds
          .at(-1)
          ?.records.map((record) => record.chrom)
          .sort()
      ).toEqual(['chrA', 'chrB']);
      expect(feeds.at(-1)?.records.find((record) => record.chrom === 'chrB')).toMatchObject({
        start: 1_510,
        end: 1_560,
      });
    } finally {
      driver.dispose();
    }
  });

  it('publishes viewport-complete exact reads while independent coverage is still pending', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdCoverageTransport();
    held.holdCoverage(true);
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: held.transport,
    } as never);
    const readRange = { start: 0, end: 512 };

    driver.setViewport(readRange, 1024);
    for (let i = 0; i < 10; i += 1) {
      await flushFeedCycle();
      const readComposition = driver.debugSnapshot({
        ...readRange,
        viewportPx: 1024,
      }).readComposition;
      if (
        readComposition?.readCoversViewport === true &&
        (readComposition.composedRecordCount ?? 0) > 0
      ) {
        break;
      }
    }

    const readComposition = driver.debugSnapshot({
      ...readRange,
      viewportPx: 1024,
    }).readComposition;
    expect(readComposition?.readCoversViewport).toBe(true);
    expect(readComposition?.composedRecordCount ?? 0).toBeGreaterThan(0);
    expect(held.pendingCoverageCount()).toBeGreaterThan(0);
    const viewportCompleteReadFeed = feeds.find(
      (feed) =>
        feed.records.length > 0 &&
        (feed.readSource?.windowStartBp ?? Number.POSITIVE_INFINITY) <= readRange.start &&
        (feed.readSource?.windowEndBp ?? Number.NEGATIVE_INFINITY) >= readRange.end
    );
    expect(
      viewportCompleteReadFeed,
      'exact read ownership must publish independently; a late histogram tile must not leave the renderer fading an obsolete read mesh during side-pan'
    ).toBeTruthy();
    expect(
      viewportCompleteReadFeed?.ownerPresentation,
      'positive reads covering the viewport are authoritative before the wider empty-proof halo settles'
    ).toEqual({ kind: 'reads' });

    driver.dispose();
  });

  it.each([26_612, 44_000])(
    'settles whole-viewport exact reads at a physically readable %ibp histogram viewport',
    async (spanBp) => {
      const feeds: TileEngineFeed[] = [];
      const requests: Array<Parameters<TileTransport>[0]> = [];
      const driver = new TileEngineDriver({
        assembly: humanScaleAssembly(),
        source: { bamPath: '/fake.bam' },
        baseUrl: 'http://sidecar',
        onFeed: (feed) => feeds.push(feed),
        transport: recordingTransport(requests),
      } as never);
      const presentationPx = 622;
      const samplePx = presentationPx * 2;
      const view = { start: 1_809_315_000, end: 1_809_315_000 + spanBp };

      try {
        await feedFor(driver, feeds, view, samplePx, presentationPx);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await flushFeedCycle();
          const snapshot = driver.debugSnapshot();
          if (
            snapshot.inFlight === 0 &&
            snapshot.transportQueue.active.length === 0 &&
            snapshot.transportQueue.queued.length === 0 &&
            snapshot.aln.pending === 0 &&
            snapshot.cov.pending === 0
          ) {
            break;
          }
        }

        const snapshot = driver.debugSnapshot();
        expect(snapshot.inFlight).toBe(0);
        expect(snapshot.transportQueue.active).toEqual([]);
        expect(snapshot.transportQueue.queued).toEqual([]);
        expect(snapshot.transportQueue.started).toBe(snapshot.transportQueue.settled);
        expect(snapshot.aln.pending).toBe(0);
        expect(snapshot.aln.error).toBe(0);
        expect(snapshot.cov.pending).toBe(0);
        expect(snapshot.cov.error).toBe(0);
        expect(
          requests.some((request) => request.kind === 'alignment' && request.level <= 2),
          'fine BAM tiles must be available before the settled exact-read publication'
        ).toBe(true);

        const settledFeed = feeds.at(-1);
        expect(
          settledFeed?.ownerPresentation,
          `${spanBp}bp at ${presentationPx}px is physically readable even while coverage uses a coarser grid`
        ).toEqual({ kind: 'reads' });
        expect(settledFeed?.readSource?.truncated).not.toBe(true);
        expect(settledFeed?.readSource?.windowStartBp).toBeLessThanOrEqual(view.start);
        expect(settledFeed?.readSource?.windowEndBp).toBeGreaterThanOrEqual(view.end);
        expect(settledFeed?.records.length ?? 0).toBeGreaterThan(0);
        expect(
          settledFeed?.records.some(
            (record) => record.end > view.start && record.start < view.start + spanBp / 3
          ),
          'the left flank must receive current exact reads'
        ).toBe(true);
        expect(
          settledFeed?.records.some(
            (record) => record.end > view.end - spanBp / 3 && record.start < view.end
          ),
          'the right flank must receive current exact reads'
        ).toBe(true);
      } finally {
        driver.dispose();
      }
    }
  );

  it.each([26_612, 44_000])(
    'replaces the detailed seed across the whole %ibp viewport after widening and panning',
    async (spanBp) => {
      const feeds: TileEngineFeed[] = [];
      const driver = new TileEngineDriver({
        assembly: humanScaleAssembly(),
        source: { bamPath: '/fake.bam' },
        baseUrl: 'http://sidecar',
        onFeed: (feed) => feeds.push(feed),
        transport: fakeTransport(),
      } as never);
      const presentationPx = 622;
      const samplePx = presentationPx * 2;
      const seed = { start: 1_809_293_194, end: 1_809_297_194 };
      const widened = { start: 1_809_315_000, end: 1_809_315_000 + spanBp };
      const panned = {
        start: widened.start + spanBp,
        end: widened.end + spanBp,
      };

      try {
        for (const [label, view] of [
          ['detailed seed', seed],
          ['widened', widened],
          ['panned', panned],
        ] as const) {
          await feedFor(driver, feeds, view, samplePx, presentationPx);
          for (let attempt = 0; attempt < 20; attempt += 1) {
            await flushFeedCycle();
            const snapshot = driver.debugSnapshot();
            if (
              snapshot.inFlight === 0 &&
              snapshot.transportQueue.active.length === 0 &&
              snapshot.transportQueue.queued.length === 0 &&
              snapshot.aln.pending === 0 &&
              snapshot.cov.pending === 0
            ) {
              break;
            }
          }

          const snapshot = driver.debugSnapshot();
          expect(snapshot.inFlight, `${label} requests settled`).toBe(0);
          expect(snapshot.transportQueue.active).toEqual([]);
          expect(snapshot.transportQueue.queued).toEqual([]);
          expect(snapshot.aln.pending).toBe(0);
          expect(snapshot.aln.error).toBe(0);
          expect(snapshot.cov.pending).toBe(0);
          expect(snapshot.cov.error).toBe(0);
          const settledFeed = feeds.at(-1);
          expect(settledFeed?.ownerPresentation, `${label} exact-read ownership`).toEqual({
            kind: 'reads',
          });
          expect(settledFeed?.readSource?.truncated).not.toBe(true);
          expect(settledFeed?.readSource?.windowStartBp, `${label} left flank`).toBeLessThanOrEqual(
            view.start
          );
          expect(
            settledFeed?.readSource?.windowEndBp,
            `${label} right flank`
          ).toBeGreaterThanOrEqual(view.end);
          expect(
            settledFeed?.records.some(
              (record) => record.end > view.start && record.start < view.end
            ),
            `${label} exact records belong to the current viewport`
          ).toBe(true);
        }
      } finally {
        driver.dispose();
      }
    }
  );

  it('refuses cache-only pan completion when bounded fine reads do not cover the new viewport', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = buildAssembly('bounded-pan', 'bounded pan', [
      { id: 'chrA', displayName: 'chrA', length: 1_000_000, cytobands: [] },
    ] as never);
    const driver = new TileEngineDriver({
      assembly,
      source: {
        bamPath: 'http://bounded.test/reads.bam',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'bounded-test',
            target: 'bounded-test',
            alignmentPath: '/reads.bam',
          },
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: recordingTransport(requests),
    } as never);
    const initial = { start: 100_000, end: 144_000 };
    const panned = { start: 115_000, end: 159_000 };
    const samplePx = 2488;
    const presentationPx = 1244;

    try {
      const first = await feedFor(driver, feeds, initial, samplePx, presentationPx);
      await flushFeedCycle();
      const before = driver.debugSnapshot();
      expect(first?.ownerPresentation).toEqual({ kind: 'reads' });
      expect(before.inFlight).toBe(0);
      expect(before.transportQueue.active).toEqual([]);
      expect(before.transportQueue.queued).toEqual([]);
      const coverageTileSpan = tileSpanBp(before.level!);
      expect(Math.floor(panned.start / coverageTileSpan)).toBe(
        Math.floor(initial.start / coverageTileSpan)
      );
      expect(Math.floor((panned.end - 1) / coverageTileSpan)).toBe(
        Math.floor((initial.end - 1) / coverageTileSpan)
      );
      const requestCount = requests.length;

      const presented = driver.presentViewport(panned, samplePx, presentationPx);
      await flushFeedCycle();
      const missingReads = driver.debugSnapshot();
      expect(missingReads.readComposition?.readyCoversViewport).toBe(false);
      expect(missingReads.inFlight).toBe(0);
      expect(missingReads.transportQueue.active).toEqual([]);
      expect(missingReads.transportQueue.queued).toEqual([]);
      expect(requests).toHaveLength(requestCount);
      expect(
        presented,
        'a complete coverage band cannot suppress fetching the missing fine-read flank'
      ).toBe(false);

      await feedFor(driver, feeds, panned, samplePx, presentationPx);
      await flushFeedCycle();
      const complete = driver.debugSnapshot();
      expect(complete.readComposition?.readyCoversViewport).toBe(true);
      expect(complete.readComposition?.readCoversViewport).toBe(true);
      expect(feeds.at(-1)?.ownerPresentation).toEqual({ kind: 'reads' });
      expect(feeds.at(-1)?.readSource?.windowStartBp).toBeLessThanOrEqual(panned.start);
      expect(feeds.at(-1)?.readSource?.windowEndBp).toBeGreaterThanOrEqual(panned.end);
      expect(requests.length).toBeGreaterThan(requestCount);
    } finally {
      driver.dispose();
    }
  });

  it('publishes exact one-base coverage with reads when deep zoom magnifies bases beyond one pixel', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: fakeTransport(),
    } as never);
    const readRange = { start: 0, end: 496 };

    const feed = await feedFor(driver, feeds, readRange, 2048);
    const coverageComposition = driver.debugSnapshot({
      ...readRange,
      viewportPx: 2048,
    }).coverageComposition;

    expect(coverageComposition?.coversViewport).toBe(true);
    expect(coverageComposition?.readyNonzeroBinCount ?? 0).toBeGreaterThan(0);
    expect(feed?.records.length ?? 0).toBeGreaterThan(0);
    expect(
      feed?.coverage,
      'one base is the irreducible genomic resolution; magnifying it beyond one screen pixel must not hide a complete exact histogram'
    ).toBeTruthy();
    expect(feed?.coverage?.binSize).toBe(1);
    expect(feed?.coverage?.maxDepth ?? 0).toBeGreaterThan(0);

    driver.dispose();
  });

  it('loads a bounded current read band without starving blend coverage', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    const view = { start: 1_543_721_334, end: 1_543_921_334 };
    const feed = await feedFor(driver, feeds, view, 2676);

    expect(requests[0]?.kind, 'visible coverage must not be queued behind read warmup').toBe(
      'coverage-assembly'
    );
    const visibleCoverageIndex = requests.findIndex(
      (req) => req.kind === 'coverage-assembly' && req.level === 7
    );
    const firstAlignmentIndex = requests.findIndex((req) => req.kind === 'alignment');
    expect(
      visibleCoverageIndex,
      'the near-read current histogram L7 must be requested'
    ).toBeGreaterThanOrEqual(0);
    expect(
      visibleCoverageIndex,
      'visible histogram coverage must enter transport before exact-read alignment warmup'
    ).toBeLessThan(firstAlignmentIndex);
    expect(
      requests.some((req) => req.kind === 'coverage-assembly' && req.level === 2),
      'production must warm exact read-density coverage before read-level entry so the renderer has a nonblank density bridge while rows finish loading'
    ).toBe(true);
    const readBridgeIndex = requests.findIndex(
      (req) => req.kind === 'coverage-assembly' && req.level === 3
    );
    const exactDensityIndex = requests.findIndex(
      (req) => req.kind === 'coverage-assembly' && req.level === 2
    );
    expect(
      readBridgeIndex,
      'production must warm a publishable level-3 density bridge before read-level entry'
    ).toBeGreaterThanOrEqual(0);
    expect(
      readBridgeIndex,
      'the publishable density bridge must queue before exact read-density coverage'
    ).toBeLessThan(exactDensityIndex);

    const alignmentRequests = requests.filter((req) => req.kind === 'alignment');
    const fineRequests = alignmentRequests.filter((request) => request.level <= 2);
    expect(
      fineRequests.some(
        (request) => request.level === 2 && request.priority?.purpose === 'current'
      ),
      'physically readable rows are current work even while coverage uses L7'
    ).toBe(true);
    expect(
      alignmentRequests.every(
        (request) => request.level <= 2 || (request.level === 3 && request.body.guidesOnly === true)
      ),
      'coarser alignment requests contain bounded guides rather than coarse read payloads'
    ).toBe(true);
    const fineSpan = tileSpanBp(2);
    const visibleFineTiles = Math.ceil(view.end / fineSpan) - Math.floor(view.start / fineSpan);
    expect(
      fineRequests.length,
      'current read preparation covers the viewport with only its bounded margin'
    ).toBeLessThanOrEqual(visibleFineTiles + 32);
    expect(feed?.ownerPresentation).toEqual({ kind: 'reads' });
    expect(feed?.readSource?.windowStartBp).toBeLessThanOrEqual(view.start);
    expect(feed?.readSource?.windowEndBp).toBeGreaterThanOrEqual(view.end);
    expect(feed?.coveragePresentation).toEqual({ kind: 'current' });
    expect(coverageCoversRange(feed!.coverage!, view)).toBe(true);
    driver.dispose();
  });

  it('prepares fine coverage before read preparation at the production sample width', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const driver = new TileEngineDriver({
      assembly: humanScaleAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: recordingTransport(requests),
    } as never);
    const view = { start: 1_543_721_334, end: 1_543_921_334 };

    try {
      const feed = await feedFor(driver, feeds, view, 2676, 1338);
      expect(requests[0]?.kind).toBe('coverage-assembly');
      expect(requests[0]?.level).toBe(7);
      expect(requests.filter((request) => request.kind === 'alignment')).toEqual([]);
      expect(feed?.ownerPresentation).toEqual({ kind: 'coverage' });
      expect(feed?.records).toEqual([]);
      expect(feed?.coveragePresentation).toEqual({ kind: 'current' });
      expect(coverageCoversRange(feed!.coverage!, view)).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it('publishes current blend coverage while every alignment request remains unresolved', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdAlternateColumnAlignmentTransport();
    const driver = new TileEngineDriver({
      assembly: humanScaleAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: held.transport,
    } as never);
    const view = { start: 1_543_721_334, end: 1_543_921_334 };
    const presentationPx = 2676;

    try {
      await feedFor(driver, feeds, view, presentationPx * 2, presentationPx);
      for (let attempt = 0; attempt < 5; attempt += 1) await flushFeedCycle();
      const snapshot = driver.debugSnapshot();
      expect(held.pendingAlignmentCount()).toBeGreaterThan(0);
      expect(snapshot.readComposition?.readCoversViewport).toBe(false);
      const fineQueue = [
        ...snapshot.transportQueue.active,
        ...snapshot.transportQueue.queued,
      ].filter((request) => request.kind === 'alignment' && request.level <= 2);
      const fineSpan = tileSpanBp(2);
      const visibleFineTiles = Math.ceil(view.end / fineSpan) - Math.floor(view.start / fineSpan);
      expect(
        fineQueue.length,
        'exact-read preparation stays within the visible band and its bounded margin'
      ).toBeLessThanOrEqual(visibleFineTiles + 32);
      const coverage = feeds.find(
        (feed) => feed.coverage && coverageCoversRange(feed.coverage, view)
      );
      expect(
        coverage,
        'current histogram coverage must progress before any exact-read request is released'
      ).toBeTruthy();
      expect(coverage?.coveragePresentation).toEqual({ kind: 'current' });
      expect(coverage?.coverage?.binSize).toBeLessThanOrEqual(binBp(snapshot.level!));
      expect(coverage?.coverage?.maxDepth).toBeGreaterThan(0);
    } finally {
      held.releaseAlignment();
      driver.dispose();
    }
  });

  it('does not cache an initial coverage not-ready response as a terminal blank overview', async () => {
    vi.useFakeTimers();
    try {
      const feeds: TileEngineFeed[] = [];
      const retrying = coverageNotReadyOnceTransport();
      const assembly = humanScaleAssembly();
      const driver = new TileEngineDriver({
        assembly,
        source: { bamPath: '/fake.bam' },
        baseUrl: 'http://sidecar',
        onFeed: (f) => feeds.push(f),
        transport: retrying.transport,
        timeoutMs: 5_000,
      } as never);

      driver.setViewport({ start: 0, end: assembly.totalLengthBp }, 2676);
      await flushMicrotasks();

      expect(
        driver.debugSnapshot().cov.error,
        'a 425 readiness response must stay retryable; it must not poison the coverage cache as error'
      ).toBe(0);

      await vi.advanceTimersByTimeAsync(150);
      await flushMicrotasks();

      const fullGenome = feeds.at(-1);
      expect(
        retrying.coverageAttempts(),
        'coverage source retried after sidecar readiness'
      ).toBeGreaterThan(2);
      expect(
        fullGenome?.coverage,
        'full-genome coverage recovers without another camera commit'
      ).toBeTruthy();
      expect(fullGenome?.coverageLod?.role).toBe('current-lod');
      expect(
        driver.debugSnapshot().cov.error,
        'no stale coverage error remains after recovery'
      ).toBe(0);
      driver.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses batched assembly coverage requests for human-scale full-genome overview', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);

    const coverageRequests = requests.filter((req) => isCoverageRequestKind(req.kind));
    expect(
      coverageRequests.every((req) => req.kind === 'coverage-assembly'),
      'full-genome overview coverage must use batched assembly tiles, not legacy chrom tiles'
    ).toBe(true);
    expect(
      coverageRequests.length,
      'full-genome overview may fetch bounded fine handoff prefetch, but must not fan out by chromosome'
    ).toBeLessThanOrEqual(99);
    const requestedChroms = new Set(
      coverageRequests.flatMap((req) =>
        ((req.body as { segments?: Array<{ chrom?: unknown }> } | undefined)?.segments ?? [])
          .map((segment) => segment.chrom)
          .filter((chrom): chrom is string => typeof chrom === 'string')
      )
    );
    expect(
      requestedChroms.size,
      'batched global coverage tiles must cover every chromosome segment in the overview'
    ).toBe(24);
    driver.dispose();
  });

  it('reports nonzero current-LOD coverage composition diagnostics separately from geometric coverage', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: positionAwareFakeTransport(),
    } as never);

    const chr9GlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr9'
    )!.globalStartBp;
    const view = { start: chr9GlobalStart + 19_000_000, end: chr9GlobalStart + 20_000_000 };
    const feed = await feedFor(driver, feeds, view, 2676);
    const composition = driver.debugSnapshot().coverageComposition;

    expect(feed?.coverageLod?.role).toBe('current-lod');
    expect(composition?.coversViewport, 'sanity: geometric coverage is complete').toBe(true);
    expect(
      composition?.readyNonzeroBinCount,
      'ready source slices must expose whether bins have real depth'
    ).toBeGreaterThan(0);
    expect(composition?.readyMaxDepth).toBeGreaterThan(0);
    expect(
      composition?.composedNonzeroBinCount,
      'composed coverage must expose whether the renderer was fed nonzero depth'
    ).toBeGreaterThan(0);
    expect(composition?.composedMaxDepth).toBeGreaterThan(0);
    driver.dispose();
  });

  it('zoom-out replaces narrow coverage with a broad coverage LOD instead of reusing stale fine bins', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const narrow = await feedFor(
      driver,
      feeds,
      { start: targetChromGlobalStart + 5_225_000, end: targetChromGlobalStart + 6_225_000 },
      2676
    );
    const narrowBin = narrow?.coverage?.binSize;
    expect(narrowBin, 'sanity: narrow coverage present before zoom-out').toBeTruthy();
    requests.length = 0;

    const broad = await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);

    expect(broad?.coverage, 'broad coverage present after zoom-out').toBeTruthy();
    expect(
      broad!.coverage!.binSize,
      'broad overview must not keep rendering the narrow-locus coverage bin'
    ).toBeGreaterThan(narrowBin!);
    expect(
      requests.some((req) => req.kind === 'coverage-assembly' && req.level > 14),
      'zoom-out must fetch the broad coverage LOD'
    ).toBe(true);
    expect(
      requests.some((req) => req.kind === 'coverage'),
      'zoom-out must not reintroduce legacy per-chrom coverage fan-out'
    ).toBe(false);
    driver.dispose();
  });

  it('bug #2 — coverage binSize REFINES on zoom-in (not stuck)', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: fakeTransport(),
    } as never);

    const wide = await feedFor(driver, feeds, { start: 2_000_000, end: 4_000_000 }, 1024);
    const narrow = await feedFor(driver, feeds, { start: 2_490_000, end: 2_510_000 }, 1024);

    expect(wide?.coverage, 'wide coverage present').toBeTruthy();
    expect(narrow?.coverage, 'narrow coverage present').toBeTruthy();
    const wideBin = wide!.coverage!.binSize;
    const narrowBin = narrow!.coverage!.binSize;
    expect(narrowBin, `narrow bin ${narrowBin} must be finer than wide ${wideBin}`).toBeLessThan(
      wideBin
    );
    driver.dispose();
  });

  it('does not publish a stretched coarse replacement when every fine target is unavailable', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const held = holdCoverageLevelsAtOrBelowTransport(10);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    const overview = await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);
    expect(overview?.coverage, 'sanity: overview coverage present').toBeTruthy();

    held.holdCoverage(true);
    const view = { start: 1_000_000_000, end: 1_000_050_000 };
    const deep = await feedFor(driver, feeds, view, 2676);

    expect(
      deep?.records.length,
      'current exact rows may publish independently while every fine coverage target is held'
    ).toBeGreaterThan(0);
    expect(deep?.ownerPresentation).toEqual({ kind: 'reads' });
    expect(deep?.readSource?.truncated).not.toBe(true);
    expect(deep?.readSource?.windowStartBp).toBeLessThanOrEqual(view.start);
    expect(deep?.readSource?.windowEndBp).toBeGreaterThanOrEqual(view.end);
    for (const feed of feeds) {
      expect(
        feed.coverage,
        'a held fine coverage target must never be replaced by a stretched coarse histogram'
      ).toBeUndefined();
      expect(feed.coverageGpuAtlas).toBeUndefined();
      expect(feed.coveragePresentation).toEqual({ kind: 'none', reason: 'no-presentable-surface' });
    }
    expect(
      held.pendingCoverageCount(),
      'sanity: the fine target level really was held'
    ).toBeGreaterThan(0);
    driver.dispose();
  });

  it('keeps human-scale 1Mb coverage bins below two density columns after overview zoom-in', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: fakeTransport(),
    } as never);

    await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);

    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const span = 1_000_000;
    const oneMb = await feedFor(
      driver,
      feeds,
      { start: targetChromGlobalStart + 5_000_000, end: targetChromGlobalStart + 5_000_000 + span },
      2676
    );

    expect(oneMb?.coverageLod?.role, '1Mb coverage must be current LOD after settle').toBe(
      'current-lod'
    );
    expect(oneMb?.coverage, '1Mb coverage present').toBeTruthy();
    const columnBp = span / 2676;
    const binPx = oneMb!.coverage!.binSize / columnBp;
    expect(
      binPx,
      `coverage bin ${oneMb!.coverage!.binSize}bp spans ${binPx.toFixed(2)} density columns`
    ).toBeLessThanOrEqual(2);
    driver.dispose();
  });

  it('publishes current-LOD coverage across the ready same-level pan band, not only the committed viewport', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: positionAwareFakeTransport(),
    } as never);

    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const span = 1_000_000;
    const settledRange = {
      start: targetChromGlobalStart + 5_000_000,
      end: targetChromGlobalStart + 5_000_000 + span,
    };
    const settled = await feedFor(driver, feeds, settledRange, 2676);

    expect(settled?.coverageLod?.role, 'sanity: settled range owns current LOD').toBe(
      'current-lod'
    );
    expect(settled?.coverage, 'settled coverage present').toBeTruthy();
    const oneViewportAhead = {
      start: settledRange.start + span,
      end: settledRange.end + span,
    };
    const ahead = await feedFor(driver, feeds, oneViewportAhead, 2676);
    expect(ahead?.coverage, 'fast side-pan is never blank').toBeTruthy();
    expect(
      coverageCoversRange(ahead!.coverage!, oneViewportAhead),
      'pan-ahead coverage covers the committed viewport'
    ).toBe(true);

    driver.dispose();
  });

  it('publishes current-LOD coverage for an exact viewport even when the pan-band prefetch is pending', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const span = 1_000_000;
    const settledRange = {
      start: targetChromGlobalStart + 5_000_000,
      end: targetChromGlobalStart + 5_000_000 + span,
    };
    const held = holdCoverageTileAtBpTransport(settledRange.end + 700_000);
    held.holdCoverage(false);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    const fullGenome = await feedFor(
      driver,
      feeds,
      { start: 0, end: assembly.totalLengthBp },
      2676
    );
    expect(fullGenome?.coverage, 'sanity: broad resident floor is primed').toBeTruthy();

    feeds.length = 0;
    held.holdCoverage(true);
    driver.setViewport(settledRange, 2676);
    await flushFeedCycle();

    expect(
      held.pendingCoverageLevels(),
      'sanity: a same-level pan-band tile, outside the committed viewport, is pending'
    ).toContain(9);
    const feed = feeds.at(-1);
    expect(feed?.coverageLod).toMatchObject({
      role: 'current-lod',
      level: 8,
      targetLevel: 8,
    });
    expect(
      coverageCoversRange(feed!.coverage!, settledRange),
      'the renderer-bound signal must cover the exact committed viewport'
    ).toBe(true);
    expect(
      driver.debugSnapshot().coverageComposition?.composedNonzeroBinCount,
      'visible-viewport diagnostics must describe the nonzero signal actually available for the committed viewport, not fail because the wider pan band is pending'
    ).toBeGreaterThan(0);
    expect(driver.debugSnapshot().coverageComposition?.composedMaxDepth).toBeGreaterThan(0);

    driver.dispose();
  });

  it('reports coverage composition depth for the committed viewport, not whole overlapping tiles', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: zeroInFirstHalfCoverageTransport(),
    } as never);

    const feed = await feedFor(driver, feeds, { start: 0, end: 512 }, 512);
    const composition = driver.debugSnapshot().coverageComposition;

    expect(feed?.coverageLod?.role).toBe('current-lod');
    expect(
      coverageMaxInRange(feed!.coverage!, { start: 512, end: 1024 }),
      'the compact renderer-bound signal no longer materializes offscreen pan-band bins'
    ).toBe(0);
    expect(feed?.coverage?.maxDepth, 'published maxDepth is viewport-local').toBe(
      coverageMaxInRange(feed!.coverage!, { start: 0, end: 512 })
    );
    expect(composition?.coversViewport).toBe(true);
    expect(composition?.readyMaxDepth).toBe(0);
    expect(composition?.readyNonzeroBinCount).toBe(0);
    expect(composition?.composedMaxDepth).toBe(0);
    expect(composition?.composedNonzeroBinCount).toBe(0);

    driver.dispose();
  });

  it('reports coverage composition depth for the supplied renderer viewport during pan', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: zeroInFirstHalfCoverageTransport(),
    } as never);

    await feedFor(driver, feeds, { start: 0, end: 512 }, 512);

    const committed = driver.debugSnapshot().coverageComposition;
    const visible = driver.debugSnapshot({
      start: 512,
      end: 1024,
      viewportPx: 512,
    }).coverageComposition;

    expect(committed?.viewStartBp).toBe(0);
    expect(committed?.viewEndBp).toBe(512);
    expect(committed?.composedMaxDepth).toBe(0);
    expect(visible?.viewStartBp).toBe(512);
    expect(visible?.viewEndBp).toBe(1024);
    expect(visible?.coversViewport).toBe(true);
    expect(visible?.composedMaxDepth).toBe(11);
    expect(visible?.composedNonzeroBinCount).toBeGreaterThan(0);

    driver.dispose();
  });

  it('emits compact offset coverage for a late chromosome instead of global-zero-padding it', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: lateChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: positionAwareFakeTransport(),
    } as never);

    const narrow = await feedFor(driver, feeds, { start: 1_502_490_000, end: 1_502_510_000 }, 1024);

    const coverage = narrow?.coverage as
      | (NonNullable<TileEngineFeed['coverage']> & { startBp?: number })
      | undefined;
    expect(coverage, 'late-chrom coverage present').toBeTruthy();
    expect(coverage!.startBp, 'coverage signal keeps the late-chrom global offset').toBeGreaterThan(
      1_500_000_000
    );
    expect(
      coverage!.binSize,
      'late-chrom coverage must keep tile payload resolution, not the old global-array floor'
    ).toBeLessThan(512);
    expect(
      coverage!.bins.length,
      'offset coverage should stay viewport/tile compact, not allocate global-zero padding'
    ).toBeLessThan(20_000);
    driver.dispose();
  });

  it('publishes an explicit no-coverage feed during an unbridgeable broad LOD handoff', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdCoverageTransport();
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    const fullRange = { start: 0, end: assembly.totalLengthBp };
    const fullGenome = await feedFor(driver, feeds, fullRange, 2676);
    expect(fullGenome?.coverage, 'sanity: whole-genome histogram is drawable first').toBeTruthy();

    feeds.length = 0;
    held.holdCoverage(true);
    const targetSpan = 27_000_000;
    const targetStart = Math.floor((assembly.totalLengthBp - targetSpan) / 2);
    driver.setViewport({ start: targetStart, end: targetStart + targetSpan }, 2676);
    await flushFeedCycle();

    expect(
      held.pendingCoverageCount(),
      'sanity: finer broad target coverage is deliberately unresolved'
    ).toBeGreaterThan(0);
    expectNoCoverageClearingFeed(
      feeds,
      'same-target broad resident coverage remains a valid presentation owner'
    );

    driver.dispose();
  });

  it('keeps a one-viewport same-zoom coverage pan on current LOD instead of the broad resident floor', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdCoverageTransport();
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    const fullGenome = await feedFor(
      driver,
      feeds,
      { start: 0, end: assembly.totalLengthBp },
      2676
    );
    expect(fullGenome?.coverageLod?.role, 'sanity: broad floor is resident').toBe('current-lod');

    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const span = 1_000_000;
    const settledRange = {
      start: targetChromGlobalStart + 5_000_000,
      end: targetChromGlobalStart + 5_000_000 + span,
    };
    const settled = await feedFor(driver, feeds, settledRange, 2676);
    expect(settled?.coverageLod?.role, 'sanity: settled range owns current LOD').toBe(
      'current-lod'
    );
    const settledLevel = settled!.coverageLod!.level;
    const settledBin = settled!.coverage!.binSize;

    feeds.length = 0;
    held.holdCoverage(true);
    const sidePanRange = {
      start: settledRange.start + span,
      end: settledRange.end + span,
    };
    driver.setViewport(sidePanRange, 2676);
    await flushFeedCycle();

    const afterPan = feeds.at(-1);
    expect(afterPan?.coverage, 'held same-zoom side-pan is never blank').toBeTruthy();
    expect(afterPan?.coverageLod?.role).toBe('current-lod');
    expect(
      coverageCoversRange(afterPan!.coverage!, sidePanRange),
      'one-viewport same-zoom pan keeps the visible range covered (coarser margin), not blank'
    ).toBe(true);
    expect(
      afterPan!.coverageLod!.level,
      'stays near the settled LOD, not the broad overview'
    ).toBeLessThanOrEqual(settledLevel + 2);
    void settledBin;

    driver.dispose();
  });

  it('keeps full-genome broad coverage available on a round trip without rehydrating it', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdCoverageTransport();
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    const fullRange = { start: 0, end: assembly.totalLengthBp };
    const fullGenome = await feedFor(driver, feeds, fullRange, 2676);
    expect(fullGenome?.coverage, 'sanity: whole-genome coverage is resident').toBeTruthy();
    const broadLevel = fullGenome!.coverageLod?.level;
    const broadBin = fullGenome!.coverage!.binSize;

    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    await feedFor(
      driver,
      feeds,
      { start: targetChromGlobalStart + 5_225_000, end: targetChromGlobalStart + 5_235_000 },
      2676
    );

    feeds.length = 0;
    held.holdCoverage(true);
    driver.setViewport(fullRange, 2676);
    await flushFeedCycle();

    expect(
      held.pendingCoverageCount(),
      'bounded cold scheduling must preserve the broad resident surface instead of evicting and rehydrating it'
    ).toBe(0);
    const bridged = feeds.at(-1);
    expect(
      bridged?.coverage,
      'same-level resident broad coverage must bridge while the broad tile rehydrates'
    ).toBeTruthy();
    expect(coverageCoversRange(bridged!.coverage!, fullRange)).toBe(true);
    expect(bridged!.coverage!.binSize).toBe(broadBin);
    expect(bridged!.coverageLod).toMatchObject({ level: broadLevel, targetLevel: broadLevel });
    expect(bridged!.coverageLod?.binSize).toBe(broadBin);
    expect(bridged!.coverageLod?.role).toBe('current-lod');

    driver.dispose();
  });

  it('diagnoses expected visible coverage core tile states for a pending target gap', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const targetGlobalBp = targetChromGlobalStart + 5_500_000;
    const held = holdCoverageTileAtBpTransport(targetGlobalBp);
    held.holdCoverage(false);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);

    feeds.length = 0;
    held.holdCoverage(true);
    const range = { start: targetGlobalBp - 413_581, end: targetGlobalBp + 413_582 };
    driver.setViewport(range, 2676);
    await flushFeedCycle();

    const composition = driver.debugSnapshot().coverageComposition;
    expect(composition?.visibleCoreTileCount).toBeGreaterThan(0);
    expect(composition?.pendingCoreTileCount).toBeGreaterThan(0);
    expect(
      composition?.visibleCoreTiles.some(
        (tile) => tile.state === 'pending' && tile.priority?.core === true
      ),
      `composition must name the visible core tile blocking target coverage; composition=${JSON.stringify(
        composition
      )}`
    ).toBe(true);

    driver.dispose();
  });

  it('retains offscreen pan-band geometry while normalizing maxDepth to the visible viewport', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const targetRange = {
      start: targetChromGlobalStart + 5_000_000,
      end: targetChromGlobalStart + 5_827_163,
    };
    const offscreenPeak = {
      start: targetRange.end + 250_000,
      end: targetRange.end + 350_000,
    };
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: offscreenPeakCoverageTransport(offscreenPeak),
    } as never);

    const feed = await feedFor(driver, feeds, targetRange, 2676);

    expect(feed?.coverage, 'coverage must be emitted').toBeTruthy();
    expect(coverageCoversRange(feed!.coverage!, targetRange)).toBe(true);
    expect(
      coverageMaxInRange(feed!.coverage!, offscreenPeak),
      'camera-independent geometry retains the offscreen peak for the next side-pan'
    ).toBe(1000);
    expect(coverageMaxInRange(feed!.coverage!, targetRange)).toBe(10);
    expect(
      feed!.coverage!.maxDepth,
      'published maxDepth drives visible histogram scale and must ignore offscreen draw-band peaks'
    ).toBe(10);

    driver.dispose();
  });

  it('keeps successful exact prefetch coverage publishable after raw cache eviction', async () => {
    const feeds: TileEngineFeed[] = [];
    const cacheLookups = vi.spyOn(TileCache.prototype, 'peek');
    const assembly = humanScaleAssembly();
    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const center = targetChromGlobalStart + 5_500_000;
    const initialRange = { start: center - 45_000, end: center + 45_000 };
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: fakeTransport(),
    } as never);

    try {
      await feedFor(driver, feeds, initialRange, 2676);
      const level = driver.debugSnapshot().level;
      expect(level, 'sanity: the 90 kb view should use the fine histogram target level').toBe(6);

      const sameLevelTileSpan = tileSpanBp(level!);
      const prefetchedCenter = center + sameLevelTileSpan * 2;
      const prefetchedRange = {
        start: prefetchedCenter - 45_000,
        end: prefetchedCenter + 45_000,
      };
      feeds.length = 0;
      expect(
        driver.presentViewport(prefetchedRange, 2676),
        'cached coverage does not complete the missing fine-read flank'
      ).toBe(false);
      expect(driver.debugSnapshot().readComposition?.readCoversViewport).toBe(false);
      const prefetchedFeed = feeds.at(-1);
      expect(prefetchedFeed?.coveragePresentation).toEqual({ kind: 'current' });
      expect(coverageCoversRange(prefetchedFeed!.coverage!, prefetchedRange)).toBe(true);
      expect(prefetchedFeed!.coverage!.binSize).toBeLessThanOrEqual(binBp(level!));
      expect(prefetchedFeed!.coverage!.maxDepth).toBe(10);
      const rawTargetKeys = cacheLookups.mock.calls.flatMap(([key], index) => {
        const result = cacheLookups.mock.results[index];
        return key.sourceId.startsWith('covasm:') &&
          key.level === level &&
          key.index * sameLevelTileSpan < prefetchedRange.end &&
          (key.index + 1) * sameLevelTileSpan > prefetchedRange.start &&
          result?.type === 'return' &&
          result.value !== undefined
          ? [key]
          : [];
      });
      expect(
        rawTargetKeys.length,
        'the future viewport has a real raw coverage tile to evict'
      ).toBeGreaterThan(0);

      const farCenter = targetChromGlobalStart + 80_000_000;
      await feedFor(driver, feeds, { start: farCenter - 45_000, end: farCenter + 45_000 }, 2676);
      cacheLookups.mockClear();
      driver.debugSnapshot({ ...prefetchedRange, viewportPx: 2676 });
      expect(
        rawTargetKeys.every((expected) =>
          cacheLookups.mock.calls.some(([key], index) => {
            const result = cacheLookups.mock.results[index];
            return (
              key.sourceId === expected.sourceId &&
              key.level === expected.level &&
              key.index === expected.index &&
              result?.type === 'return' &&
              result.value === undefined
            );
          })
        )
      ).toBe(true);

      feeds.length = 0;
      expect(
        driver.presentViewport(prefetchedRange, 2676),
        'durable coverage still cannot claim completion of missing exact reads'
      ).toBe(false);
      expect(driver.debugSnapshot().readComposition?.readCoversViewport).toBe(false);

      const feed = feeds.at(-1);
      expect(feed?.coveragePresentation).toEqual({ kind: 'current' });
      expect(feed?.coverage, 'prefetched pan target is never blank after eviction').toBeTruthy();
      expect(coverageCoversRange(feed!.coverage!, prefetchedRange)).toBe(true);
      expect(feed!.coverage!.maxDepth).toBe(10);
      expect(feed!.coverage!.provenance?.exact).toBe(true);
      expect(
        feed!.coverage!.binSize,
        'presented at floor-or-current resolution, not the broad overview'
      ).toBeLessThanOrEqual(binBp(level!));
    } finally {
      driver.dispose();
      cacheLookups.mockRestore();
    }
  });

  it('does not let a narrower same-level surface evict the full-genome resident floor', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdCoverageTransport();
    const assembly = humanScaleAssembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    const fullRange = { start: 0, end: assembly.totalLengthBp };
    const fullGenome = await feedFor(driver, feeds, fullRange, 2676);
    expect(fullGenome?.coverage, 'sanity: whole-genome coverage is resident').toBeTruthy();
    const broadLevel = fullGenome!.coverageLod?.level;
    const broadBin = fullGenome!.coverage!.binSize;

    const narrowerSameLevelRange = { start: 0, end: 2_900_000_000 };
    const narrower = await feedFor(driver, feeds, narrowerSameLevelRange, 2676);
    expect(
      narrower,
      'a narrower camera inside the bp-anchored full-genome band needs no replacement feed'
    ).toBeUndefined();
    expect(driver.presentViewport(narrowerSameLevelRange, 2676)).toBe(true);

    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    await feedFor(
      driver,
      feeds,
      { start: targetChromGlobalStart + 5_225_000, end: targetChromGlobalStart + 5_235_000 },
      2676
    );

    feeds.length = 0;
    held.holdCoverage(true);
    driver.setViewport(fullRange, 2676);
    await flushFeedCycle();

    expect(
      held.pendingCoverageCount(),
      'a narrower same-level surface must not force the full-genome floor to rehydrate on return'
    ).toBe(0);
    const bridged = feeds.at(-1);
    expect(
      bridged?.coverage,
      'a narrower same-level resident surface must not erase the full-genome floor'
    ).toBeTruthy();
    expect(coverageCoversRange(bridged!.coverage!, fullRange)).toBe(true);
    expect(bridged!.coverage!.binSize).toBe(broadBin);
    expect(bridged!.coverageLod).toMatchObject({ level: broadLevel, targetLevel: broadLevel });
    expect(bridged!.coverageLod?.binSize).toBe(broadBin);
    expect(bridged!.coverageLod?.role).toBe('current-lod');

    driver.dispose();
  });

  it('keeps a pending fine coverage handoff tile resident across the adjacent wider zoom commit', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const targetGlobalBp = targetChromGlobalStart + 5_500_000;
    const held = holdCoverageTileAtBpTransport(targetGlobalBp);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);

    const fineRange = {
      start: targetGlobalBp - 413_581,
      end: targetGlobalBp + 413_582,
    };
    driver.setViewport(fineRange, 2676);
    await flushFeedCycle();
    expect(
      held.pendingCoverageLevels(),
      'sanity: the target fine handoff coverage tile is deliberately held'
    ).toContain(9);

    const widerAdjacentRange = {
      start: targetGlobalBp - 2_000_000,
      end: targetGlobalBp + 2_000_000,
    };
    driver.setViewport(widerAdjacentRange, 2676);
    await flushFeedCycle();

    expect(
      held.pendingCoverageLevels(),
      'a level-9 handoff tile that is still spatially near the viewport must not be aborted by the wider level-11 commit'
    ).toContain(9);

    driver.dispose();
  });

  it('keeps pending critical fine coverage handoff tiles across a level-18 same-locus camera correction', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const targetGlobalBp = targetChromGlobalStart + 42_000_000;
    const held = holdCoverageTileAtBpTransport(targetGlobalBp);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);

    const level18CriticalPrefetchRange = {
      start: targetGlobalBp - 300_000_000,
      end: targetGlobalBp + 300_000_000,
    };
    driver.setViewport(level18CriticalPrefetchRange, 2676);
    await flushFeedCycle();

    expect(driver.debugSnapshot().level, 'sanity: this camera frame presents level 18').toBe(18);
    const coveragePrefetch = (driver as any).assemblyCoverageSource.prefetch as {
      criticalFinerLevel: number;
      criticalFinerPrefetchLevels: number;
    };
    const declaredCriticalLevels = Array.from(
      { length: coveragePrefetch.criticalFinerPrefetchLevels },
      (_, offset) => coveragePrefetch.criticalFinerLevel - offset
    ).sort((a, b) => a - b);
    const startedCriticalLevels = held
      .pendingCoverageLevels()
      .filter((level) => declaredCriticalLevels.includes(level));
    expect(
      held.pendingCoverageLevels(),
      'level 18 must prepare every and only level in the source-declared bounded critical corridor'
    ).toEqual(expect.arrayContaining(declaredCriticalLevels));
    expect(held.pendingCoverageLevels()).not.toContain(declaredCriticalLevels[0]! - 1);
    expect(startedCriticalLevels).toEqual(declaredCriticalLevels);

    const level18NoImmediateCriticalPrefetchRange = {
      start: targetGlobalBp - 330_000_000,
      end: targetGlobalBp + 330_000_000,
    };
    driver.setViewport(level18NoImmediateCriticalPrefetchRange, 2676);
    await flushFeedCycle();

    expect(driver.debugSnapshot().level, 'sanity: the correction remains at level 18').toBe(18);
    expect(
      held.pendingCoverageLevels(),
      'started critical handoff coverage near the viewport must survive same-locus level-18 corrections'
    ).toEqual(expect.arrayContaining(startedCriticalLevels));

    driver.dispose();
  });

  it('keeps staged read-density bridge coverage resident across the level-7 to level-6 handoff', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    const targetGlobalBp = targetChromGlobalStart + 42_000_000;
    const held = holdCoverageTileAtBpTransport(targetGlobalBp);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    await feedFor(driver, feeds, { start: 0, end: assembly.totalLengthBp }, 2676);

    driver.setViewport({ start: targetGlobalBp - 130_000, end: targetGlobalBp + 130_000 }, 2676);
    await flushFeedCycle();
    expect(driver.debugSnapshot().level, 'sanity: the bridge stage starts at level 7').toBe(7);
    expect(
      held.pendingCoverageLevels(),
      'level 7 must start the publishable bridge and exact read-density handoff'
    ).toEqual(expect.arrayContaining([2, 3]));

    driver.setViewport({ start: targetGlobalBp - 73_000, end: targetGlobalBp + 73_000 }, 2676);
    await flushFeedCycle();

    expect(driver.debugSnapshot().level, 'sanity: this camera frame presents level 6').toBe(6);
    expect(
      held.pendingCoverageLevels(),
      'staged level-3/level-2 read-density coverage must survive the adjacent level-6 commit'
    ).toEqual(expect.arrayContaining([2, 3]));

    driver.dispose();
  });

  it('keeps pending full-genome broad coverage alive during immediate zoom-in', async () => {
    const feeds: TileEngineFeed[] = [];
    const assembly = humanScaleAssembly();
    const broadTileBp = 2_500_000_000;
    const held = holdCoverageTileAtBpTransport(broadTileBp);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    driver.setViewport({ start: 0, end: assembly.totalLengthBp }, 2676);
    await flushFeedCycle();
    expect(
      held.pendingCoverageLevels(),
      'sanity: whole-genome overview requested a held broad coverage tile'
    ).toContain(21);

    const targetChromGlobalStart = assembly.chromosomes.find(
      (placement) => placement.chromosome.id === 'chr21'
    )!.globalStartBp;
    driver.setViewport(
      { start: targetChromGlobalStart + 5_000_000, end: targetChromGlobalStart + 6_000_000 },
      2676
    );
    await flushFeedCycle();

    expect(
      held.pendingCoverageLevels(),
      'a pending broad full-genome coverage tile must survive immediate zoom-in so zoom-out has a complete resident floor'
    ).toContain(21);
    expect(
      held
        .pendingCoveragePriorities()
        .some(
          (item) =>
            item.level === 21 &&
            item.priority?.purpose === 'critical-handoff' &&
            item.priority.core === true &&
            item.priority.marginDistanceTiles === 0
        ),
      'a retained broad overview tile must be promoted in the fetch queue instead of sitting behind newer fine-locus work'
    ).toBe(true);

    driver.dispose();
  });

  it('does not publish partial or empty current-level coverage while a visible tile is pending', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdCoverageTileAtBpTransport(3_000_000);
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    driver.setViewport({ start: 2_000_000, end: 4_000_000 }, 1024);
    await flushFeedCycle();

    expect(
      held.pendingCoverageCount(),
      'sanity: one visible coverage tile is deliberately unresolved'
    ).toBeGreaterThan(0);
    expect(
      feeds.some((feed) => Boolean(feed.coverage)),
      'ready sibling tiles must not be published as an exact-but-partial histogram'
    ).toBe(false);
    expect(
      feeds,
      'partial current-level coverage must emit no replacement so the renderer retains its last exact histogram'
    ).toHaveLength(0);

    held.releaseCoverage();
    await flushFeedCycle();
    expect(
      feeds.at(-1)?.coverage,
      'coverage publishes once every visible tile is ready'
    ).toBeTruthy();
    driver.dispose();
  });

  it('bug #3 — reads PRESENT after a re-zoom to a NEW chromosome', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: fakeTransport(),
    } as never);

    const atA = await feedFor(driver, feeds, { start: 2_499_000, end: 2_501_000 }, 1024);
    expect(atA?.records.length, 'reads present at chrA').toBeGreaterThan(0);
    expect(
      atA!.records.every((r) => r.start < 5_000_000),
      'chrA reads in chrA global range'
    ).toBe(true);

    await feedFor(driver, feeds, { start: 0, end: 10_000_000 }, 1024);

    const atB = await feedFor(driver, feeds, { start: 7_499_000, end: 7_501_000 }, 1024);
    expect(atB?.records.length, 'reads PRESENT at the new chrB locus (bug #3)').toBeGreaterThan(0);
    expect(
      atB!.records.some((r) => r.start >= 5_000_000),
      'chrB reads offset onto the chrB global range'
    ).toBe(true);
    driver.dispose();
  });

  it('projects sidecar alternate-column summaries onto the assembly-global axis', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: alternateColumnTransport(),
    } as never);

    const feed = await feedFor(driver, feeds, { start: 7_499_000, end: 7_501_000 }, 1024);
    const columns = feed?.alternateColumns ?? [];

    expect(columns.length, 'sidecar summaries reach the pileup feed').toBeGreaterThan(0);
    expect(
      columns.every((column) => column.pos >= 5_000_000),
      'chrB-local summary positions are offset onto the chrB assembly range'
    ).toBe(true);
    expect(columns[0]).toMatchObject({
      kind: 'sub',
      length: 1,
      refBase: 'C',
      readBase: 'T',
      coveringReadCount: 42,
      supportingReadCount: 17,
    });
    expect(columns[0]?.weightedFraction).toBeCloseTo(510 / 1_220);
    driver.dispose();
  });

  it('preserves mutation columns with physically readable rows at the first histogram level', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const base = alternateColumnTransport();
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: async (request, signal) => {
        requests.push(request);
        return base(request, signal);
      },
    } as never);
    const view = { start: 7_496_000, end: 7_504_000 };

    const feed = await feedFor(driver, feeds, view, 1024);

    expect(driver.debugSnapshot().level, 'sanity: this is the first histogram LOD').toBe(3);
    expect(feed?.records.length, 'the physical read size permits exact rows').toBeGreaterThan(0);
    expect(feed?.ownerPresentation).toEqual({ kind: 'reads' });
    expect(
      feed?.readSource?.windowStartBp,
      'exact reads cover the left edge while histogram columns remain available'
    ).toBeLessThanOrEqual(view.start);
    expect(feed?.readSource?.windowEndBp).toBeGreaterThanOrEqual(view.end);
    expect(
      feed?.alternateColumns.length,
      'BAM mismatch columns should remain available over the first histogram raster'
    ).toBeGreaterThan(0);
    expect(
      requests.some(
        (request) =>
          request.kind === 'alignment' && request.level === 2 && request.body.guidesOnly !== true
      ),
      'the histogram grid must not replace exact BAM reads with guide-only payloads'
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.kind === 'alignment' && request.level === 3 && request.body.guidesOnly === true
      ),
      'coarser alignment prefetch remains a bounded guide-only request'
    ).toBe(true);

    driver.dispose();
  });

  it('publishes late first-histogram mutation columns after coverage is already reusable', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdAlternateColumnAlignmentTransport();
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: held.transport,
    } as never);
    const view = { start: 7_496_000, end: 7_504_000 };

    driver.setViewport(view, 1024);
    await flushFeedCycle();
    expect(driver.debugSnapshot().level).toBe(3);
    expect(held.pendingAlignmentCount()).toBeGreaterThan(0);
    expect(feeds.at(-1)?.coverage, 'coverage settles before BAM tiles').toBeTruthy();
    expect(feeds.at(-1)?.alternateColumns ?? []).toEqual([]);

    held.releaseAlignment();
    await flushFeedCycle();

    expect(
      feeds.at(-1)?.alternateColumns.length,
      'late BAM mutation columns must publish even when the coverage memo is unchanged'
    ).toBeGreaterThan(0);
    expect(feeds.at(-1)?.records.length).toBeGreaterThan(0);
    expect(feeds.at(-1)?.ownerPresentation).toEqual({ kind: 'reads' });
    expect(feeds.at(-1)?.readSource?.windowStartBp).toBeLessThanOrEqual(view.start);
    expect(feeds.at(-1)?.readSource?.windowEndBp).toBeGreaterThanOrEqual(view.end);
    driver.dispose();
  });

  it('publishes a called exact-read tile that settles after the histogram band is otherwise stable', async () => {
    const feeds: TileEngineFeed[] = [];
    const calledPosition = 7_500_037;
    const expectedColumnPosition = tileIndex(calledPosition, 2) * tileSpanBp(2) + 37;
    const held = holdCalledAlternateColumnTileTransport(calledPosition, 2);
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: held.transport,
    } as never);
    const view = { start: 7_496_000, end: 7_504_000 };

    driver.setViewport(view, 1024);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await flushFeedCycle();
      const read = driver.debugSnapshot({ ...view, viewportPx: 1024 }).readComposition;
      if (
        held.pendingCalledTileCount() === 1 &&
        read &&
        read.readyBandTileCount === read.expectedBandTileCount - 1
      ) {
        break;
      }
    }
    const before = driver.debugSnapshot({ ...view, viewportPx: 1024 }).readComposition;
    expect(driver.debugSnapshot().level).toBe(3);
    expect(held.pendingCalledTileCount()).toBe(1);
    expect(before?.readyBandTileCount).toBe((before?.expectedBandTileCount ?? 0) - 1);
    expect(feeds.at(-1)?.coverage).toBeTruthy();
    expect(feeds.at(-1)?.alternateColumns ?? []).toEqual([]);

    feeds.length = 0;
    held.releaseCalledTile();
    await flushFeedCycle();

    const after = driver.debugSnapshot({ ...view, viewportPx: 1024 }).readComposition;
    const presentation = driver as unknown as {
      alignmentPresentationGeneration: number;
      processedAlignmentPresentationGeneration: number;
      lastPublishedReadRevisionKey: string | null;
    };
    expect({
      publishedCalledColumn: feeds.some((feed) =>
        feed.alternateColumns.some((column) => column.pos === expectedColumnPosition)
      ),
      payloadAlternateColumnCount: after?.payloadAlternateColumnCount ?? 0,
      composedAlternateColumnCount: after?.composedAlternateColumnCount ?? 0,
      alignmentPresentationGeneration: presentation.alignmentPresentationGeneration,
      processedAlignmentPresentationGeneration:
        presentation.processedAlignmentPresentationGeneration,
    }).toEqual({
      publishedCalledColumn: true,
      payloadAlternateColumnCount: 1,
      composedAlternateColumnCount: 1,
      alignmentPresentationGeneration: expect.any(Number),
      processedAlignmentPresentationGeneration: presentation.alignmentPresentationGeneration,
    });
    driver.dispose();
  });

  it('debugSnapshot attributes exact-read records to visible alignment tile payloads', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: fakeTransport(),
    } as never);

    const view = { start: 2_499_000, end: 2_501_000 };
    const feed = await feedFor(driver, feeds, view, 1024);
    const read = driver.debugSnapshot({ ...view, viewportPx: 1024 }).readComposition;

    expect(feed?.records.length, 'sanity: fake alignment payload reaches the feed').toBeGreaterThan(
      0
    );
    expect(read, 'read-composition diagnostics are present for the live viewport').toBeTruthy();
    expect(read?.fineLevel, 'diagnostic labels exact-read levels as fine').toBe(true);
    expect(read?.visibleTileCount, 'diagnostic sees visible alignment tiles').toBeGreaterThan(0);
    expect(read?.readyTileCount, 'diagnostic sees ready alignment tiles').toBeGreaterThan(0);
    expect(
      read?.readyWithReadsTileCount,
      'diagnostic distinguishes ready tiles that actually carried reads'
    ).toBeGreaterThan(0);
    expect(read?.payloadReadCount, 'diagnostic sums sidecar payload reads').toBeGreaterThan(0);
    expect(read?.composedRecordCount, 'diagnostic reports composed feed records').toBe(
      feed?.records.length
    );
    expect(
      read?.readyCoveredFraction,
      'ready alignment tiles cover the requested source window'
    ).toBe(1);
    driver.dispose();
  });

  it('reuses the composed read union without republishing while the resident band is unchanged', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: fakeTransport(),
    } as never);

    const firstRange = { start: 2_499_000, end: 2_501_000 };
    const secondRange = { start: 2_499_010, end: 2_501_010 };
    const first = await feedFor(driver, feeds, firstRange, 1024);
    const level = driver.debugSnapshot().level;
    expect(level).not.toBeNull();
    const internals = driver as unknown as {
      composeReads: (
        view: { globalStart: number; globalEnd: number; viewportPx: number },
        level: number
      ) => { records: ReadonlyArray<PileupRecord> };
    };
    const firstRecords = internals.composeReads(
      { globalStart: firstRange.start, globalEnd: firstRange.end, viewportPx: 1024 },
      level!
    ).records;

    expect(first?.records.length, 'sanity: first feed has exact reads').toBeGreaterThan(0);
    expect(firstRecords).toBe(first?.records);

    feeds.length = 0;
    driver.setViewport(secondRange, 1024);
    await flushFeedCycle();
    const secondRecords = internals.composeReads(
      { globalStart: secondRange.start, globalEnd: secondRange.end, viewportPx: 1024 },
      level!
    ).records;

    const thirdRecords = internals.composeReads(
      { globalStart: secondRange.start, globalEnd: secondRange.end, viewportPx: 1024 },
      level!
    ).records;
    if (feeds.length === 0) {
      expect(
        secondRecords,
        'small camera moves over the same read-tile set must not rebuild the read union'
      ).toBe(firstRecords);
    }
    expect(
      thirdRecords,
      'once the pan-lead tile has landed, another compose must reuse that union'
    ).toBe(secondRecords);
    driver.dispose();
  });

  it('retains each read projection for exactly the lifetime of its immutable tile payload', () => {
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => {},
      transport: fakeTransport(),
    } as never);
    type Payload = {
      reads: Array<{
        start: number;
        end: number;
        strand: '+';
        mapq: number;
        readId: string;
      }>;
      alternateColumns: [];
    };
    const internals = driver as unknown as {
      projectReadTile: (
        payload: Payload,
        reads: Payload['reads'],
        alternateRows: [],
        chromSource: { chrom: string; globalStartBp: number }
      ) => { records: Array<{ start: number; readId: string }> };
      readTileProjectionMaterializeCount: number;
      readTileProjectionReuseCount: number;
    };
    const chromSource = { chrom: 'chrB', globalStartBp: 5_000_000 };
    const makePayload = (index: number): Payload => ({
      reads: [
        {
          start: index * 10,
          end: index * 10 + 8,
          strand: '+',
          mapq: 60,
          readId: `read-${index}`,
        },
      ],
      alternateColumns: [],
    });
    const firstPayload = makePayload(0);
    const firstProjection = internals.projectReadTile(
      firstPayload,
      firstPayload.reads,
      firstPayload.alternateColumns,
      chromSource
    );

    for (let index = 1; index <= 40; index += 1) {
      const payload = makePayload(index);
      internals.projectReadTile(payload, payload.reads, payload.alternateColumns, chromSource);
    }
    const firstProjectionAgain = internals.projectReadTile(
      firstPayload,
      firstPayload.reads,
      firstPayload.alternateColumns,
      chromSource
    );

    expect(firstProjectionAgain).toBe(firstProjection);
    expect(firstProjectionAgain.records[0]).toBe(firstProjection.records[0]);
    expect(firstProjectionAgain.records[0]).toMatchObject({
      start: 5_000_000,
      readId: 'read-0',
    });
    expect(internals.readTileProjectionMaterializeCount).toBe(41);
    expect(internals.readTileProjectionReuseCount).toBe(1);
    driver.dispose();
  });

  it('propagates a truncated alignment tile to the read-source contract', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: truncatedReadTransport(),
    } as never);

    const feed = await feedFor(driver, feeds, { start: 2_499_000, end: 2_501_000 }, 1024);

    expect(
      feed?.records.length,
      'sanity: the truncated payload still carries rows'
    ).toBeGreaterThan(0);
    expect(feed?.readSource?.truncated).toBe(true);
    driver.dispose();
  });

  it('deduplicates seam-spanning reads without a global string-key scan', async () => {
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: seamDuplicateTransport(),
    } as never);

    const feed = await feedFor(driver, feeds, { start: 2_499_000, end: 2_501_000 }, 1024);
    const readIds = feed?.records.map((record) => record.readId) ?? [];
    const seamIds = readIds.filter((id) => id.startsWith('seam-'));

    expect(
      seamIds.length,
      'sanity: the fake transport produced seam-spanning reads'
    ).toBeGreaterThan(0);
    expect(new Set(readIds).size, 'seam-spanning reads are present once in the feed').toBe(
      readIds.length
    );
    driver.dispose();
  });

  it('does not publish distant exon blocks for a tile that only intersects their intron', async () => {
    const feeds: TileEngineFeed[] = [];
    const base = fakeTransport();
    const transport: TileTransport = async (req, signal) => {
      if (req.kind !== 'alignment') return base(req, signal);
      const span = tileSpanBp(req.level);
      const chromGlobalStart = Number(
        (req.body as { chromGlobalStart?: number } | undefined)?.chromGlobalStart ?? 0
      );
      const localTileStart = req.tileIndex * span - chromGlobalStart;
      return {
        ok: true,
        status: 200,
        body: {
          level: req.level,
          tileIndex: req.tileIndex,
          start: localTileStart,
          end: localTileStart + span,
          count: 1,
          reads: [
            {
              start: localTileStart - 100_000,
              end: localTileStart + 100_000,
              blocks: [
                { start: localTileStart - 100_000, end: localTileStart - 99_940 },
                { start: localTileStart + 99_940, end: localTileStart + 100_000 },
              ],
              strand: '+' as const,
              mapq: 60,
              readId: `spliced-${req.tileIndex}`,
            },
          ],
        },
      };
    };
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport,
    } as never);

    const view = { start: 2_499_000, end: 2_501_000 };
    const feed = await feedFor(driver, feeds, view, 1_024);
    const composition = driver.debugSnapshot({ ...view, viewportPx: 1_024 }).readComposition;

    expect(feed?.readSource).toMatchObject({ truncated: false });
    expect(feed?.records).toEqual([]);
    expect(composition).toMatchObject({
      stableBandReady: true,
      readyCoversViewport: true,
      composedRecordCount: 0,
    });
    driver.dispose();
  });

  it('keeps nearby pending fine-alignment tiles resident across small read-window gestures', async () => {
    const feeds: TileEngineFeed[] = [];
    const held = holdAlignmentTransport();
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: held.transport,
    } as never);

    driver.setViewport({ start: 2_499_000, end: 2_504_000 }, 1024);
    await flushFeedCycle();
    expect(
      held.pendingAlignmentCount(),
      'sanity: read-level alignment tiles are in flight'
    ).toBeGreaterThan(0);
    const firstKeys = held.pendingAlignmentKeys();

    driver.setViewport({ start: 2_519_000, end: 2_524_000 }, 1024);
    await flushFeedCycle();

    expect(
      driver.debugSnapshot().cache.retainedAlignment,
      'fine-alignment residence halo should stay softly retained across async resolves'
    ).toBeGreaterThan(0);
    expect(
      held.abortedAlignmentCount(),
      `nearby pending fine-alignment tiles should stay resident, not restart: first=${firstKeys.join(
        ','
      )} after=${held.pendingAlignmentKeys().join(',')}`
    ).toBe(0);

    held.releaseAlignment();
    await flushFeedCycle();
    driver.dispose();
  });

  it('does not duplicate live tile requests through stale per-chrom sources', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    await feedFor(driver, feeds, { start: 2_499_000, end: 2_501_000 }, 1024);
    requests.length = 0;

    await feedFor(driver, feeds, { start: 7_499_000, end: 7_501_000 }, 1024);

    const routeKeys = requests.map((req) => [req.kind, req.level, req.tileIndex].join(':'));
    expect(routeKeys.length, 'sanity: chrB visit should request live tiles').toBeGreaterThan(0);
    expect(new Set(routeKeys).size, 'no duplicate route requests after visiting chrA first').toBe(
      routeKeys.length
    );
    const alignmentRequests = requests.filter((req) => req.kind === 'alignment');
    expect(
      alignmentRequests.every((req) => req.body.chrom === 'chrB'),
      'every per-chrom alignment request on the chrB visit should target chrB'
    ).toBe(true);
    expect(
      requests.some((req) => req.kind === 'coverage'),
      'coverage should no longer create stale per-chrom source requests'
    ).toBe(false);
    expect(requests[0]?.kind, 'fine read-level fetches should prioritize reads').toBe('alignment');
    driver.dispose();
  });

  it('starts burst commits immediately but publishes the latest viewport feed', async () => {
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const driver = new TileEngineDriver({
      assembly: twoChromAssembly(),
      source: { bamPath: '/fake.bam' },
      baseUrl: 'http://sidecar',
      onFeed: (f) => feeds.push(f),
      transport: recordingTransport(requests),
    } as never);

    driver.setViewport({ start: 2_499_000, end: 2_501_000 }, 1024);
    await Promise.resolve();
    expect(
      requests.length,
      'the first committed viewport should fetch after the scheduler microtask, not a settle timer'
    ).toBeGreaterThan(0);

    requests.length = 0;
    driver.setViewport({ start: 7_499_000, end: 7_501_000 }, 1024);
    await Promise.resolve();
    await flushFeedCycle();

    expect(
      requests.length,
      'the second committed viewport should fetch after the scheduler microtask, not a settle timer'
    ).toBeGreaterThan(0);
    expect(
      requests.filter((req) => req.kind === 'alignment').every((req) => req.body.chrom === 'chrB'),
      'source activation after the second commit should request only chrB alignment'
    ).toBe(true);
    expect(
      requests.some((req) => req.kind === 'coverage'),
      'coverage should not re-enter stale per-chrom request mode on burst commits'
    ).toBe(false);
    expect(
      feeds.at(-1)?.records.some((r) => r.start >= 5_000_000),
      'the latest emitted read feed should belong to chrB'
    ).toBe(true);
    driver.dispose();
  });
});
