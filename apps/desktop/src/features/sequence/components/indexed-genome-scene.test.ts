// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { GenomeSessionShell, GenomeTrackTile } from '../../../shared/indexed-genome';
import {
  buildIndexedGenomeScene,
  evaluateIndexedGenomeSceneInvariants,
  indexedGenomeSceneHasWholeFeaturePayload,
  type IndexedGenomeSceneViewport,
} from './indexed-genome-scene';

function shell(overrides: Partial<GenomeSessionShell> = {}): GenomeSessionShell {
  return {
    sessionId: 'session-chr11',
    sourcePath: '/workspace/chr11.fa',
    sourceFingerprint: 'fingerprint-chr11',
    chrom: 'chr11',
    sourceSizeBytes: 140_000_000,
    coordinateReady: false,
    validationState: 'unvalidated',
    openedAt: 1,
    tracks: [
      {
        id: 'chr11:sequence',
        kind: 'sequence',
        label: 'Sequence',
        state: 'metadata_pending',
        userState: 'Preparing',
      },
      {
        id: 'chr11:annotations',
        kind: 'annotation',
        label: 'Annotations',
        state: 'metadata_pending',
        userState: 'Preparing',
      },
    ],
    ...overrides,
  };
}

function viewport(overrides: Partial<IndexedGenomeSceneViewport> = {}): IndexedGenomeSceneViewport {
  return {
    chrom: 'chr11',
    startBp: 1_000_000,
    endBp: 1_010_000,
    widthPx: 1000,
    heightPx: 480,
    pixelsPerBp: 0.1,
    generation: 7,
    ...overrides,
  };
}

function tile(overrides: Partial<GenomeTrackTile> = {}): GenomeTrackTile {
  return {
    sessionId: 'session-chr11',
    requestId: 'annotation-7',
    trackId: 'chr11:annotations',
    chrom: 'chr11',
    start: 990_000,
    end: 1_020_000,
    generation: 7,
    state: 'ready',
    fidelity: 'summary',
    validationState: 'metadata_match',
    cacheState: 'hit',
    byteCount: 128,
    recordCount: 2,
    ...overrides,
  };
}

describe('indexed genome scene contract', () => {
  it('builds an honest length-unknown shell without requiring a manifest', () => {
    const scene = buildIndexedGenomeScene({ shell: shell() });

    expect(scene.mode).toBe('tile-native-session-shell');
    expect(scene.lengthState).toBe('length_unknown');
    expect(scene.length).toBeNull();
    expect(scene.coordinateReady).toBe(false);
    expect(scene.tracks.map((track) => [track.kind, track.state, track.userState])).toEqual([
      ['sequence', 'metadata_pending', 'Preparing'],
      ['annotation', 'metadata_pending', 'Preparing'],
    ]);
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene)).toBe(false);
  });

  it('promotes coordinate-ready sessions into a bounded scene descriptor', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({
        coordinateReady: true,
        length: 135_086_622,
        validationState: 'metadata_match',
        tracks: [
          {
            id: 'chr11:sequence',
            kind: 'sequence',
            label: 'Sequence',
            state: 'coordinate_ready',
            userState: 'Showing overview',
          },
        ],
      }),
      viewport: viewport(),
    });

    expect(scene.lengthState).toBe('coordinate_ready');
    expect(scene.length).toBe(135_086_622);
    expect(scene.viewport).toMatchObject({
      chrom: 'chr11',
      startBp: 1_000_000,
      endBp: 1_010_000,
      generation: 7,
    });
    expect(scene.laneEpoch).toBe('fingerprint-chr11:chr11:lane-v0');
  });

  it('keeps retained ready tiles usable while a newer generation is loading', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport({ generation: 8 }),
      tiles: [
        tile({ generation: 7, state: 'ready' }),
        tile({ generation: 8, state: 'loading', byteCount: 0, recordCount: 0 }),
      ],
    });

    expect(scene.tileSlots).toEqual([
      expect.objectContaining({
        generation: 7,
        state: 'ready',
        currentForViewport: true,
      }),
      expect.objectContaining({
        generation: 8,
        state: 'loading',
        currentForViewport: true,
      }),
    ]);
  });

  it('reports scene invariants for current and retained tile state', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport({ generation: 8, startBp: 1_000_000, endBp: 1_000_006 }),
      tiles: [
        tile({ generation: 7, state: 'ready' }),
        tile({
          requestId: 'sequence-8',
          trackId: 'chr11:sequence',
          start: 1_000_000,
          end: 1_000_006,
          generation: 8,
          state: 'ready',
          fidelity: 'exact',
          byteCount: 6,
          recordCount: 6,
          payload: {
            type: 'sequence',
            startBp: 1_000_000,
            endBp: 1_000_006,
            bases: 'ATGGCC',
          },
        }),
        tile({
          requestId: 'annotation-8',
          start: 1_000_000,
          end: 1_000_006,
          generation: 8,
          payload: {
            type: 'annotation-glyphs',
            featureModel: 'resolved-transcript-v2',
            glyphs: [
              {
                id: 'tx-1',
                type: 'mRNA',
                label: 'TX1',
                startBp: 1_000_001,
                endBp: 1_000_005,
                strand: '+',
                lane: 0,
                color: 0x3b82f6,
              },
            ],
            droppedCount: 0,
            typeFilteredCount: 1,
          },
        }),
      ],
    });

    expect(evaluateIndexedGenomeSceneInvariants(scene)).toMatchObject({
      ok: true,
      violations: [],
      currentTileSlots: 3,
      retainedTileSlots: 0,
      sequencePayloadBases: 6,
      annotationGlyphs: 1,
    });
  });

  it('fails invariants for stale pending current tiles', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport({ generation: 8 }),
      tiles: [tile({ generation: 7, state: 'loading' })],
    });
    const poisoned = {
      ...scene,
      tileSlots: scene.tileSlots.map((slot) => ({ ...slot, currentForViewport: true })),
    };

    expect(evaluateIndexedGenomeSceneInvariants(poisoned).violations).toContain(
      'chr11:annotations[0] is current for a stale pending generation'
    );
  });

  it('fails invariants for oversized sequence payloads', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport({ generation: 8, startBp: 1_000_000, endBp: 1_000_010 }),
      tiles: [
        tile({
          requestId: 'sequence-8',
          trackId: 'chr11:sequence',
          start: 1_000_000,
          end: 1_000_010,
          generation: 8,
          state: 'ready',
          fidelity: 'exact',
          byteCount: 10,
          recordCount: 10,
          payload: {
            type: 'sequence',
            startBp: 1_000_000,
            endBp: 1_000_010,
            bases: 'ATGGCCATGG',
          },
        }),
      ],
    });

    const report = evaluateIndexedGenomeSceneInvariants(scene, { maxSequencePayloadBases: 6 });

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual(
      expect.arrayContaining(['chr11:sequence[0] exceeds the sequence payload budget'])
    );
  });

  it('fails invariants for raw feature keys in annotation glyph payloads', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport(),
      tiles: [
        tile({
          payload: {
            type: 'annotation-glyphs',
            featureModel: 'raw-gff3',
            glyphs: [
              {
                id: 'tx-1',
                type: 'mRNA',
                label: 'TX1',
                startBp: 1_000_100,
                endBp: 1_000_500,
                strand: '+',
                lane: 0,
                color: 0x3b82f6,
                raw: 'chr11\tfixture\tmRNA\t1\t400\t.\t+\t.\tID=tx-1',
              } as never,
            ],
            droppedCount: 0,
            typeFilteredCount: 1,
          },
        }),
      ],
    });

    expect(evaluateIndexedGenomeSceneInvariants(scene).violations).toContain(
      'chr11:annotations[0].glyphs[0] contains raw feature key "raw"'
    );
  });

  it('filters tiles from stale sessions before they reach renderer state', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport(),
      tiles: [
        tile({ sessionId: 'session-chr11' }),
        tile({ sessionId: 'old-session', requestId: 'old-session-tile' }),
      ],
    });

    expect(scene.tileSlots).toHaveLength(1);
    expect(scene.tileSlots[0].trackId).toBe('chr11:annotations');
  });

  it('does not copy GenomeFeature arrays from tile responses into scene slots', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport(),
      tiles: [
        tile({
          features: [
            {
              chrom: 'chr11',
              source: 'fixture',
              type: 'gene',
              start: 1,
              end: 10,
              score: null,
              strand: '+',
              phase: null,
              attributes: {},
              raw: 'chr11\tfixture\tgene\t1\t10\t.\t+\t.\tID=g1',
            },
          ],
        }),
      ],
    });

    expect(scene.tileSlots).toEqual([
      expect.not.objectContaining({
        features: expect.any(Array),
      }),
    ]);
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene)).toBe(false);
  });

  it('detects accidental whole GenomeFeature payloads in the scene contract', () => {
    const scene = buildIndexedGenomeScene({ shell: shell() });
    const poisoned = {
      ...scene,
      tileSlots: [
        ...scene.tileSlots,
        {
          features: [
            {
              chrom: 'chr11',
              source: 'fixture',
              type: 'gene',
              start: 1,
              end: 10,
              score: null,
              strand: '+',
              phase: null,
              attributes: {},
              raw: 'chr11\tfixture\tgene\t1\t10\t.\t+\t.\tID=g1',
            },
          ],
        },
      ],
    };

    expect(indexedGenomeSceneHasWholeFeaturePayload(scene)).toBe(false);
    expect(indexedGenomeSceneHasWholeFeaturePayload(poisoned)).toBe(true);
  });

  it('counts stale-epoch slots in the invariant report', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport({ generation: 8 }),
      laneEpoch: 'fresh-epoch:v1',
      tiles: [
        tile({ generation: 8, state: 'ready', laneEpoch: 'fresh-epoch:v1' }),
        tile({ generation: 7, state: 'ready', laneEpoch: 'stale-epoch:v0' }),
      ],
    });

    const report = evaluateIndexedGenomeSceneInvariants(scene);
    expect(report.staleEpochSlotsDropped).toBe(1);
  });

  it('counts annotation slots with undefined laneEpoch as untrusted rendering authority', () => {
    const scene = buildIndexedGenomeScene({
      shell: shell({ coordinateReady: true, length: 135_086_622 }),
      viewport: viewport({ generation: 8 }),
      laneEpoch: 'fresh-epoch:v1',
      tiles: [tile({ generation: 8, state: 'ready' }), tile({ generation: 7, state: 'ready' })],
    });

    const report = evaluateIndexedGenomeSceneInvariants(scene);
    expect(report.staleEpochSlotsDropped).toBe(2);
  });
});
