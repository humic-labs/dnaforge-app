import { describe, expect, it, vi } from 'vitest';

import type { TileEngineFeed } from '../tile-engine-driver';
import { createIndexedFirstInteractionReadiness } from './indexed-first-interaction-readiness';

const SOURCE = 'grch38\0HG002.bam';
const TRACK = 'pileup-genomewide-grch38';
const RANGE = { start: 0, end: 1_000_000 };

function exactFeed(overrides: Partial<TileEngineFeed> = {}): TileEngineFeed {
  return {
    coverage: {
      startBp: 0,
      bins: [4, 9, 3, 7],
      binSize: 250_000,
      maxDepth: 9,
      provenance: { exact: true, method: 'resolution-ranked-source-merge', source: 'tile-engine' },
    },
    coverageLod: {
      role: 'current-lod',
      level: 0,
      targetLevel: 0,
      binSize: 250_000,
      authority: 'native-target',
      provenanceExact: true,
      provenanceMethod: 'resolution-ranked-source-merge',
      provenanceSource: 'tile-engine',
    },
    viewRange: RANGE,
    coveragePresentation: { kind: 'current' },
    fullAssemblyInteractionCorridorReady: true,
    records: [],
    ...overrides,
  };
}

function atlasFeed(overrides: Partial<TileEngineFeed> = {}): TileEngineFeed {
  return {
    coverageGpuAtlas: {
      contract: 'coverage-gpu-atlas.v1',
      authorityKey: 'source\0assembly\0mean-depth\0revision-1',
      sourceIdentity: 'source',
      assemblyFingerprint: 'assembly',
      statistic: 'mean-depth',
      payloadRevision: 'revision-1',
      assemblyStartBp: 0,
      assemblyEndBp: 1_000_000,
      baseBinSizeBp: 250_000,
      textureWidth: 4,
      textureHeight: 1,
      data: new Float32Array([4, 9, 3, 7]),
      depthPercentiles: { p50: 4, p90: 9, p95: 9, p99: 9, max: 9 },
      chromosomes: [
        {
          chrom: 'chr1',
          globalStartBp: 0,
          globalEndBp: 1_000_000,
          baseBinCount: 4,
          rowStart: 0,
          rowCount: 1,
        },
      ],
    },
    coverageGpuAtlasPresentation: 'active',
    viewRange: RANGE,
    coveragePresentation: { kind: 'current' },
    fullAssemblyInteractionCorridorReady: true,
    records: [],
    ...overrides,
  };
}

function readyFixture() {
  const renderer = {};
  const signal = createIndexedFirstInteractionReadiness({
    sourceKey: SOURCE,
    viewportPx: 1_000,
    expectedTrackIds: [TRACK],
  });
  signal.noteViewport(renderer, RANGE);
  signal.noteLaneContractWired(renderer, RANGE, [TRACK]);
  signal.noteCoverageFeed(renderer, TRACK, RANGE, exactFeed());
  return { renderer, signal };
}

describe('indexed first-interaction readiness', () => {
  it('stays false before the current renderer lane contract is wired', () => {
    const renderer = {};
    const signal = createIndexedFirstInteractionReadiness({
      sourceKey: SOURCE,
      viewportPx: 1_000,
      expectedTrackIds: [TRACK],
    });

    signal.noteViewport(renderer, RANGE);
    signal.noteCoverageFeed(renderer, TRACK, RANGE, exactFeed());

    expect(signal.getSnapshot()).toBe(false);
    expect(signal.inspect().reason).toBe('lane-contract-not-wired');
  });

  it.each([
    ['partial', exactFeed({ coverage: { ...exactFeed().coverage!, bins: [4, 9] } })],
    ['stale', exactFeed({ viewRange: { start: 2_000_000, end: 3_000_000 } })],
    [
      'empty',
      exactFeed({
        coverage: { ...exactFeed().coverage!, bins: [0, 0, 0, 0], maxDepth: 0 },
      }),
    ],
    [
      'inexact-signal',
      exactFeed({
        coverage: {
          ...exactFeed().coverage!,
          provenance: { exact: false, method: 'coarse-fallback', source: 'tile-engine' },
        },
      }),
    ],
    [
      'inexact-lod',
      exactFeed({ coverageLod: { ...exactFeed().coverageLod!, provenanceExact: false } }),
    ],
  ])('rejects a %s coverage feed', (_name, feed) => {
    const renderer = {};
    const signal = createIndexedFirstInteractionReadiness({
      sourceKey: SOURCE,
      viewportPx: 1_000,
      expectedTrackIds: [TRACK],
    });
    signal.noteViewport(renderer, RANGE);
    signal.noteLaneContractWired(renderer, RANGE, [TRACK]);

    signal.noteCoverageFeed(renderer, TRACK, RANGE, feed);

    expect(signal.getSnapshot()).toBe(false);
    expect(signal.inspect().reason).toBe('coverage-not-ready');
  });

  it('becomes ready only for a full, current, exact, coherent, nonzero feed', () => {
    const renderer = {};
    const signal = createIndexedFirstInteractionReadiness({
      sourceKey: SOURCE,
      viewportPx: 1_000,
      expectedTrackIds: [TRACK],
    });
    const listener = vi.fn();
    signal.subscribe(listener);
    signal.noteViewport(renderer, RANGE);
    signal.noteLaneContractWired(renderer, RANGE, [TRACK]);

    signal.noteCoverageFeed(renderer, TRACK, RANGE, exactFeed());

    expect(signal.getSnapshot()).toBe(true);
    expect(signal.inspect()).toMatchObject({
      ready: true,
      reason: 'ready',
      range: RANGE,
      viewportPx: 1_000,
      readyTrackIds: [TRACK],
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('accepts a complete current active atlas as the cold broad owner', () => {
    const renderer = {};
    const signal = createIndexedFirstInteractionReadiness({
      sourceKey: SOURCE,
      viewportPx: 1_000,
      expectedTrackIds: [TRACK],
      requireFullAssemblyCorridor: true,
    });
    signal.noteViewport(renderer, RANGE);
    signal.noteLaneContractWired(renderer, RANGE, [TRACK]);

    signal.noteCoverageFeed(renderer, TRACK, RANGE, atlasFeed());

    expect(signal.getSnapshot()).toBe(true);
    expect(signal.inspect().reason).toBe('ready');
  });

  it.each([
    ['standby', atlasFeed({ coverageGpuAtlasPresentation: 'standby' })],
    [
      'incomplete-range',
      atlasFeed({
        coverageGpuAtlas: {
          ...atlasFeed().coverageGpuAtlas!,
          assemblyEndBp: 999_998,
        },
      }),
    ],
    [
      'malformed-texture',
      atlasFeed({
        coverageGpuAtlas: {
          ...atlasFeed().coverageGpuAtlas!,
          data: new Float32Array([4, 9, 3]),
        },
      }),
    ],
  ])('rejects a %s atlas as the cold broad owner', (_name, feed) => {
    const renderer = {};
    const signal = createIndexedFirstInteractionReadiness({
      sourceKey: SOURCE,
      viewportPx: 1_000,
      expectedTrackIds: [TRACK],
      requireFullAssemblyCorridor: true,
    });
    signal.noteViewport(renderer, RANGE);
    signal.noteLaneContractWired(renderer, RANGE, [TRACK]);

    signal.noteCoverageFeed(renderer, TRACK, RANGE, feed);

    expect(signal.getSnapshot()).toBe(false);
    expect(signal.inspect().reason).toBe('coverage-not-ready');
  });

  it('latches through cached-band camera motion that emits no replacement feed', () => {
    const { renderer, signal } = readyFixture();
    const listener = vi.fn();
    signal.subscribe(listener);

    signal.noteViewport(renderer, { start: 10, end: 999_990 });
    signal.noteViewport(renderer, { start: 20, end: 999_980 });
    signal.noteCoverageUnavailable(renderer, TRACK, { start: 20, end: 999_980 });

    expect(signal.getSnapshot()).toBe(true);
    expect(signal.inspect()).toMatchObject({
      ready: true,
      reason: 'ready',
      range: { start: 20, end: 999_980 },
      readyTrackIds: [TRACK],
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('re-arms the cold interaction barrier for a new renderer generation', () => {
    const { signal } = readyFixture();
    const listener = vi.fn();
    signal.subscribe(listener);

    const replacementRenderer = {};
    signal.noteLaneContractWired(replacementRenderer, RANGE, [TRACK]);
    expect(signal.getSnapshot()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    signal.noteCoverageFeed(replacementRenderer, TRACK, RANGE, exactFeed());
    expect(signal.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('creates a new false readiness key when source or viewport width changes', () => {
    const { signal: ready } = readyFixture();
    const changedSource = createIndexedFirstInteractionReadiness({
      sourceKey: `${SOURCE}-changed`,
      viewportPx: 1_000,
      expectedTrackIds: [TRACK],
    });
    const changedWidth = createIndexedFirstInteractionReadiness({
      sourceKey: SOURCE,
      viewportPx: 1_001,
      expectedTrackIds: [TRACK],
    });

    expect(ready.getSnapshot()).toBe(true);
    expect(changedSource.getSnapshot()).toBe(false);
    expect(changedSource.inspect().key).not.toBe(ready.inspect().key);
    expect(changedWidth.getSnapshot()).toBe(false);
    expect(changedWidth.inspect().key).not.toBe(ready.inspect().key);
  });

  it('batches an invalidation and synchronous exact presentation without emitting React churn', () => {
    const { renderer, signal } = readyFixture();
    const listener = vi.fn();
    signal.subscribe(listener);

    signal.batch(() => {
      signal.noteViewport(renderer, { start: 100, end: 900_000 });
      signal.noteCoverageFeed(
        renderer,
        TRACK,
        { start: 100, end: 900_000 },
        exactFeed({ viewRange: { start: 100, end: 900_000 } })
      );
    });

    expect(signal.getSnapshot()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
