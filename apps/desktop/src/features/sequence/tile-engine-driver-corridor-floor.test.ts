import { describe, expect, it, vi } from 'vitest';
import { buildAssembly, type Assembly, type TileTransport } from '@waypoint/genome-renderer';
import type { TileEngineFeed } from './tile-engine-driver';
import { TileEngineDriver } from './tile-engine-driver';
import {
  COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
  COVERAGE_CORRIDOR_FLOOR_CONTRACT,
  COVERAGE_CORRIDOR_FLOOR_LEVEL,
  COVERAGE_CORRIDOR_FLOOR_STATISTIC,
  buildCoverageCorridorFloorGpuAtlas,
  type VerifiedCoverageCorridorFloor,
} from './coverage-corridor-floor';

const GRCH38_PRIMARY: ReadonlyArray<readonly [string, number]> = [
  ['chr1', 248_956_422],
  ['chr2', 242_193_529],
  ['chr3', 198_295_559],
  ['chr4', 190_214_555],
  ['chr5', 181_538_259],
  ['chr6', 170_805_979],
  ['chr7', 159_345_973],
  ['chr8', 145_138_636],
  ['chr9', 138_394_717],
  ['chr10', 133_797_422],
  ['chr11', 135_086_622],
  ['chr12', 133_275_309],
  ['chr13', 114_364_328],
  ['chr14', 107_043_718],
  ['chr15', 101_991_189],
  ['chr16', 90_338_345],
  ['chr17', 83_257_441],
  ['chr18', 80_373_285],
  ['chr19', 58_617_616],
  ['chr20', 64_444_167],
  ['chr21', 46_709_983],
  ['chr22', 50_818_468],
  ['chrX', 156_040_895],
  ['chrY', 57_227_415],
];

function grch38Assembly(): Assembly {
  return buildAssembly(
    'grch38',
    'GRCh38 human',
    GRCH38_PRIMARY.map(([id, length]) => ({ id, displayName: id, length, cytobands: [] })) as never
  );
}

function verifiedFloor(assembly: Assembly): VerifiedCoverageCorridorFloor {
  const layers = new Map();
  for (const placement of assembly.chromosomes) {
    layers.set(placement.chromosome.id, {
      chrom: placement.chromosome.id,
      globalStart: placement.globalStartBp,
      globalEnd: placement.globalEndBp,
      binSize: COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
      bins: new Float32Array(
        Math.ceil(placement.chromosome.length / COVERAGE_CORRIDOR_FLOOR_BIN_SIZE)
      ).fill(10),
    });
  }
  return {
    contract: COVERAGE_CORRIDOR_FLOOR_CONTRACT,
    sourceIdentity: 'b'.repeat(64),
    requestFingerprint: 'c'.repeat(64),
    orderedAssemblyFingerprint: 'd'.repeat(64),
    statistic: COVERAGE_CORRIDOR_FLOOR_STATISTIC,
    level: COVERAGE_CORRIDOR_FLOOR_LEVEL,
    binSize: COVERAGE_CORRIDOR_FLOOR_BIN_SIZE,
    assemblyStart: 0,
    assemblyEnd: assembly.totalLengthBp,
    depthPercentiles: { p50: 10, p90: 10, p95: 10, p99: 10, max: 10 },
    layers,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function manualPostPaintScheduler() {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  return {
    settlementScheduler: {
      requestPostPaint(callback: () => void) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id: number) {
        callbacks.delete(id);
      },
    },
    flush() {
      const current = [...callbacks.values()];
      callbacks.clear();
      for (const callback of current) callback();
    },
  };
}

describe('TileEngineDriver verified corridor floor', () => {
  it('releases obsolete whole-genome HTTP coverage before preparing a local exact-read view', async () => {
    const assembly = grch38Assembly();
    const requests: Array<{ url: string; signal: AbortSignal }> = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const signal = init!.signal!;
      requests.push({ url: String(url), signal });
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/data/HG002.bam', indexPath: '/data/HG002.bam.bai' },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      fetchImpl,
      corridorFloorLoader: async () => null,
    });
    const drain = async () => {
      for (let i = 0; i < 80; i++) await Promise.resolve();
    };
    try {
      driver.setViewport({ start: 0, end: assembly.totalLengthBp }, 1768);
      await drain();
      const broad = requests.filter(({ url }) => /\/coverage-assembly\/21\//.test(url));
      expect(broad.length).toBeGreaterThan(0);
      expect(broad.every(({ signal }) => !signal.aborted)).toBe(true);
      const previousRequests = requests.length;

      driver.setViewport({ start: 1_809_369_836, end: 1_809_396_448 }, 1768);
      await drain();

      expect(broad.every(({ signal }) => signal.aborted)).toBe(true);
      const current = requests.slice(previousRequests);
      expect(current.some(({ url }) => /\/alignment\/2\//.test(url))).toBe(true);
      expect(current.some(({ url }) => /\/coverage-assembly\/4\//.test(url))).toBe(true);
      expect(current.some(({ url }) => /\/coverage-assembly\/21\//.test(url))).toBe(false);
      expect(current.every(({ signal }) => !signal.aborted)).toBe(true);
    } finally {
      driver.dispose();
      await drain();
    }
  });

  it('acknowledges unchanged full-assembly atlas camera moves without another feed or fetch', async () => {
    const assembly = grch38Assembly();
    const feeds = vi.fn();
    const reused = vi.fn();
    const transport = vi.fn();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/data/HG002.bam', indexPath: '/data/HG002.bam.bai' },
      baseUrl: 'http://sidecar',
      onFeed: feeds,
      onCoverageAtlasReuse: reused,
      transport,
      corridorFloorLoader: async () => verifiedFloor(assembly),
    });
    await Promise.resolve();
    await Promise.resolve();
    driver.setViewport({ start: 1_000_000, end: 1_300_999_999 }, 1244, 622);
    const atlas = feeds.mock.lastCall?.[0].coverageGpuAtlas;
    expect(atlas).toBeDefined();
    const publications = feeds.mock.calls.length;
    const requests = transport.mock.calls.length;

    for (const range of [
      { start: 2_000_000, end: 1_301_999_999 },
      { start: 1_100_000_000, end: 2_399_999_999 },
    ]) {
      expect(driver.presentViewport(range, 1244, 622)).toBe(true);
      expect(reused).toHaveBeenLastCalledWith({
        coverageGpuAtlas: atlas,
        viewRange: range,
        fullAssemblyInteractionCorridorReady: true,
      });
      expect(feeds).toHaveBeenCalledTimes(publications);
      expect(transport).toHaveBeenCalledTimes(requests);
    }
    driver.dispose();
  });

  it('does not poll the local whole-genome floor for a live SSH source', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: 'coverage floor is not prepared' }), {
          status: 425,
          headers: { 'Content-Type': 'application/json' },
        })
    ) as unknown as typeof fetch;
    const driver = new TileEngineDriver({
      assembly: grch38Assembly(),
      source: {
        bamPath: 'http://127.0.0.1:61234/v1/session/alignment.bam',
        indexPath: '/tmp/dnaforge-remote-index/alignment.bam.bai',
        remote: {
          sessionId: 'remote-session',
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-endpoint',
            target: 'lab-hpc',
            alignmentPath: '/cluster/run/sample.bam',
            indexPath: '/cluster/run/sample.bam.bai',
          },
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      fetchImpl,
    });

    await Promise.resolve();
    const snapshot = driver.debugSnapshot().coverageCorridorFloor;
    const fetchCallCount = vi.mocked(fetchImpl).mock.calls.length;
    driver.dispose();

    expect(fetchCallCount).toBe(0);
    expect(snapshot).toEqual({
      state: 'idle',
      failureReason: null,
      layerCount: 0,
      atlasAuthorityKey: null,
    });
  });

  it('does not request a whole-source corridor artifact for a regional htsget source', async () => {
    const corridorFloorLoader = vi.fn(async () => verifiedFloor(grch38Assembly()));
    const driver = new TileEngineDriver({
      assembly: grch38Assembly(),
      source: {
        bamPath: `htsget-runtime://${'e'.repeat(64)}/source.bam`,
        grantExpiresAtMs: Date.now() + 900_000,
        htsget: {
          sourceToken: 'short-lived-runtime-token',
          sourceIdentity: 'e'.repeat(64),
          format: 'BAM',
        },
      },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      transport: async () => {
        throw new Error('not used');
      },
      corridorFloorLoader,
    });

    await Promise.resolve();
    expect(corridorFloorLoader).not.toHaveBeenCalled();
    expect(driver.debugSnapshot().coverageCorridorFloor.state).toBe('idle');
    driver.dispose();
  });

  it('admits a worker-prepared floor and atlas only as one matching authority pair', async () => {
    const assembly = grch38Assembly();
    const floor = verifiedFloor(assembly);
    const atlas = buildCoverageCorridorFloorGpuAtlas(floor);
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/data/HG002.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      transport: async () => {
        throw new Error('not used');
      },
      corridorFloorLoader: async () => ({ floor, atlas }),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(driver.debugSnapshot().coverageCorridorFloor).toEqual({
      state: 'ready',
      failureReason: null,
      layerCount: 24,
      atlasAuthorityKey: atlas.authorityKey,
    });
    driver.dispose();
  });

  it('rejects a mismatched worker pair before either authority reference swaps', async () => {
    const assembly = grch38Assembly();
    const floor = verifiedFloor(assembly);
    const atlas = {
      ...buildCoverageCorridorFloorGpuAtlas(floor),
      payloadRevision: 'wrong-revision',
    };
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/data/HG002.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      transport: async () => {
        throw new Error('not used');
      },
      corridorFloorLoader: async () => ({ floor, atlas }),
    });

    await Promise.resolve();
    await Promise.resolve();
    const snapshot = driver.debugSnapshot().coverageCorridorFloor;
    expect(snapshot.state).toBe('error');
    expect(snapshot.failureReason).toContain('atlas-admission-failed');
    expect(snapshot.layerCount).toBe(0);
    expect(snapshot.atlasAuthorityKey).toBeNull();
    driver.dispose();
  });

  it('replaces delayed broad exact work with one retained atlas authority', async () => {
    const assembly = grch38Assembly();
    expect(assembly.totalLengthBp).toBe(3_088_269_832);
    const feeds: TileEngineFeed[] = [];
    const requests: Array<Parameters<TileTransport>[0]> = [];
    const rawCoverageSignals: AbortSignal[] = [];
    const loader = deferred<VerifiedCoverageCorridorFloor | null>();
    const postPaint = manualPostPaintScheduler();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/data/HG002.bam', indexPath: '/data/HG002.bam.bai' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: (request, signal) => {
        requests.push(request);
        if (request.kind.startsWith('coverage')) rawCoverageSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
      corridorFloorLoader: () => loader.promise,
      settlementScheduler: postPaint.settlementScheduler,
    });
    const internals = driver as any;
    const oldBinSize = 2 ** 20;
    internals.exactCoverageTiles.set('old-exact-owner', {
      key: { sourceId: 'covasm:/data/HG002.bam', level: 20, index: 0 },
      slices: [
        {
          globalStart: 0,
          globalEnd: assembly.totalLengthBp,
          binSize: oldBinSize,
          payload: {
            bins: new Array(Math.ceil(assembly.totalLengthBp / oldBinSize)).fill(7),
            binSize: oldBinSize,
            provenance: { exact: true, method: 'existing-exact-owner' },
          },
        },
      ],
      order: 1,
    });
    internals.exactCoverageGeneration += 1;

    const fullRange = { start: 0, end: assembly.totalLengthBp };
    driver.setViewport(fullRange, 2676, 2676);
    await Promise.resolve();
    await Promise.resolve();
    expect(feeds.at(-1)?.coverage?.provenance?.method).toBe('resolution-ranked-source-merge');
    expect(feeds.at(-1)?.coverage?.bins.every((value) => value === 7)).toBe(true);
    expect(internals.residentBaseLayerVerified).toBe(false);
    expect(requests.some((request) => request.kind.startsWith('coverage'))).toBe(true);
    expect(rawCoverageSignals.some((signal) => !signal.aborted)).toBe(true);
    const obsoleteCoverageSignals = internals.cache
      .entries()
      .filter(
        (entry: any) =>
          entry.state === 'pending' &&
          (entry.key.sourceId.startsWith('cov:') || entry.key.sourceId.startsWith('covasm:'))
      )
      .map((entry: any) => entry.abort.signal as AbortSignal);
    expect(obsoleteCoverageSignals.length).toBeGreaterThan(0);

    loader.resolve(verifiedFloor(assembly));
    await Promise.resolve();
    await Promise.resolve();
    postPaint.flush();
    expect(internals.verifiedCorridorFloor?.layers.size).toBe(24);
    expect(internals.corridorFloorState).toBe('ready');
    expect(internals.residentBaseLayerVerified).toBe(false);
    expect(internals.residentBaseLayer.size).toBe(0);
    expect(internals.residentPyramid).toHaveLength(0);
    expect(driver.fullAssemblyInteractionCorridorReady(2676)).toBe(true);
    expect(obsoleteCoverageSignals.every((signal: AbortSignal) => signal.aborted)).toBe(true);
    expect(
      internals.cache
        .entries()
        .some(
          (entry: any) =>
            entry.state === 'pending' &&
            (entry.key.sourceId.startsWith('cov:') || entry.key.sourceId.startsWith('covasm:'))
        )
    ).toBe(false);
    expect(feeds.at(-1)?.coverage).toBeUndefined();
    expect(feeds.at(-1)?.coverageGpuAtlas?.authorityKey).toBe(
      internals.verifiedCorridorFloorGpuAtlas.authorityKey
    );
    expect(feeds.at(-1)?.coverageGpuAtlasPresentation).toBe('active');
    expect(feeds.at(-1)?.fullAssemblyInteractionCorridorReady).toBe(true);

    const afterFirstReadiness = driver.debugSnapshot().coverageMemo;
    const coverageRequestsAfterInstall = requests.filter((request) =>
      request.kind.startsWith('coverage')
    ).length;
    for (let packet = 0; packet < 100; packet += 1) {
      const span = 150_000_000;
      const start = (packet * 23_000_000) % (assembly.totalLengthBp - span);
      driver.setViewport({ start, end: start + span }, 2676, 2676);
    }
    const afterReadinessPackets = driver.debugSnapshot().coverageMemo;
    expect(requests.filter((request) => request.kind.startsWith('coverage')).length).toBe(
      coverageRequestsAfterInstall
    );
    expect(afterReadinessPackets.exactCoverageRecordScanCount).toBe(
      afterFirstReadiness.exactCoverageRecordScanCount
    );
    expect(afterReadinessPackets.materializeCount).toBe(afterFirstReadiness.materializeCount);
    expect(afterReadinessPackets.revisionChangeCount).toBe(afterFirstReadiness.revisionChangeCount);

    driver.dispose();
  });

  it('keeps exact coverage authoritative when the ready-only floor is not prepared', async () => {
    const assembly = grch38Assembly();
    const loader = deferred<VerifiedCoverageCorridorFloor | null>();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/data/HG002.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      transport: async () => {
        throw new Error('not used');
      },
      corridorFloorLoader: () => loader.promise,
    });
    loader.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    expect((driver as any).verifiedCorridorFloor).toBeNull();
    expect((driver as any).corridorFloorState).toBe('error');
    expect(driver.debugSnapshot().coverageCorridorFloor).toEqual({
      state: 'error',
      failureReason: 'loader-returned-no-candidate',
      layerCount: 0,
      atlasAuthorityKey: null,
    });
    expect((driver as any).residentBaseLayerVerified).toBe(false);
    expect((driver as any).residentBaseLayer.size).toBe(0);
    driver.dispose();
  });

  it('reports the exact rejected loader boundary without replacing a last-good owner', async () => {
    const assembly = grch38Assembly();
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/data/HG002.bam' },
      baseUrl: 'http://sidecar',
      onFeed: () => undefined,
      transport: async () => {
        throw new Error('not used');
      },
      corridorFloorLoader: async () => {
        throw new Error('response contract header mismatch');
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(driver.debugSnapshot().coverageCorridorFloor).toEqual({
      state: 'error',
      failureReason: 'loader-rejected:Error:response contract header mismatch',
      layerCount: 0,
      atlasAuthorityKey: null,
    });
    driver.dispose();
  });

  it('hands off active atlas to exact coverage without an ownerless feed and reverses atomically', async () => {
    const assembly = grch38Assembly();
    const feeds: TileEngineFeed[] = [];
    const driver = new TileEngineDriver({
      assembly,
      source: { bamPath: '/data/HG002.bam', indexPath: '/data/HG002.bam.bai' },
      baseUrl: 'http://sidecar',
      onFeed: (feed) => feeds.push(feed),
      transport: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
      corridorFloorLoader: async () => verifiedFloor(assembly),
    });
    await Promise.resolve();
    await Promise.resolve();
    const internals = driver as any;

    const broadRange = { start: 0, end: assembly.totalLengthBp };
    driver.setViewport(broadRange, 2676, 2676);
    await Promise.resolve();
    expect(feeds.at(-1)?.coverageGpuAtlasPresentation).toBe('active');
    expect(feeds.at(-1)?.coverage).toBeUndefined();

    const narrowRange = { start: 55_000_000, end: 55_500_000 };
    driver.setViewport(narrowRange, 1000, 1000);
    await Promise.resolve();
    expect(feeds.at(-1)?.coverageGpuAtlasPresentation).toBe('handoff-hold');
    expect(feeds.at(-1)?.coverageGpuAtlas).toBeDefined();
    expect(feeds.at(-1)?.coverage).toBeUndefined();

    const exactLevel = Math.floor(Math.log2((narrowRange.end - narrowRange.start) / 1000));
    const exactBinSize = 2 ** exactLevel;
    const exactStart = Math.floor(narrowRange.start / exactBinSize) * exactBinSize;
    const exactEnd = Math.ceil(narrowRange.end / exactBinSize) * exactBinSize;
    internals.exactCoverageTiles.set('narrow-exact-owner', {
      key: { sourceId: 'covasm:/data/HG002.bam', level: exactLevel, index: 0 },
      slices: [
        {
          globalStart: exactStart,
          globalEnd: exactEnd,
          binSize: exactBinSize,
          payload: {
            bins: new Array(Math.ceil((exactEnd - exactStart) / exactBinSize)).fill(17),
            binSize: exactBinSize,
            provenance: { exact: true, method: 'test-exact-handoff-owner' },
          },
        },
      ],
      order: 1,
    });
    internals.exactCoverageGeneration += 1;
    expect(driver.presentViewport(narrowRange, 1000, 1000)).toBe(true);
    expect(feeds.at(-1)?.coverageGpuAtlasPresentation).toBe('standby');
    expect(feeds.at(-1)?.coverageGpuAtlas).toBeDefined();
    expect(feeds.at(-1)?.coverage).toBeDefined();

    expect(driver.presentViewport(broadRange, 2676, 2676)).toBe(true);
    expect(feeds.at(-1)?.coverageGpuAtlasPresentation).toBe('active');
    expect(feeds.at(-1)?.coverage).toBeUndefined();

    const lifecycleFeeds = feeds.filter((feed) => feed.coverageGpuAtlasPresentation != null);
    expect(lifecycleFeeds.map((feed) => feed.coverageGpuAtlasPresentation)).toEqual([
      'active',
      'handoff-hold',
      'standby',
      'active',
    ]);
    expect(
      lifecycleFeeds.every(
        (feed) =>
          feed.coverage != null ||
          (feed.coverageGpuAtlas != null &&
            (feed.coverageGpuAtlasPresentation === 'active' ||
              feed.coverageGpuAtlasPresentation === 'handoff-hold'))
      )
    ).toBe(true);

    driver.dispose();
  });
});
