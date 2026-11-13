// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { indexedGenomeSceneHasWholeFeaturePayload } from './indexed-genome-scene';
import { buildIndexedGenomeViewerScene } from './indexed-genome-viewer-scene-state';

function sceneInput(overrides: Partial<Parameters<typeof buildIndexedGenomeViewerScene>[0]> = {}) {
  return {
    manifest: {
      chrom: 'chr11',
      fastaPath: '/fixtures/chr11.fa',
      faiPath: '/fixtures/chr11.fa.fai',
      gffPath: '/fixtures/chr11.gff3.gz',
      tbiPath: '/fixtures/chr11.gff3.gz.tbi',
    },
    sessionId: 'session-chr11',
    length: 135_086_622,
    height: 480,
    containerWidth: 960,
    visibleTypes: new Set(['enhancer', 'gene', 'mRNA']),
    laneLimit: null,
    viewportRange: { start: 1_000_000, end: 1_010_000 },
    sequenceWindow: null,
    annotationOverviewTile: {
      state: 'ready',
      fidelity: 'summary',
      generation: 1,
      byteCount: 2048,
      validationState: 'metadata_match',
      cacheState: 'hit',
      recordCount: 12_758,
      sourceRecordCount: 249_954,
    },
    annotationViewportTile: null,
    ...overrides,
  } satisfies Parameters<typeof buildIndexedGenomeViewerScene>[0];
}

describe('indexed genome viewer scene state', () => {
  it('builds a tile-native viewer scene from counts and metadata without feature arrays', () => {
    const scene = buildIndexedGenomeViewerScene(sceneInput());

    expect(scene.mode).toBe('tile-native-session-shell');
    expect(scene.sessionId).toBe('session-chr11');
    expect(scene.tracks.map((track) => [track.kind, track.state, track.userState])).toEqual([
      ['sequence', 'coordinate_ready', 'Showing overview'],
      ['annotation', 'ready', 'Showing overview'],
    ]);
    expect(scene.tileSlots).toEqual([
      expect.objectContaining({
        trackId: 'chr11:annotations',
        startBp: 0,
        endBp: 135_086_622,
        generation: 1,
        laneEpoch: scene.laneEpoch,
        recordCount: 12_758,
        currentForViewport: true,
      }),
    ]);
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene)).toBe(false);
  });

  it('stamps the current laneEpoch on synthetic overview annotation payloads', () => {
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        visibleTypes: new Set(['mRNA']),
        laneLimit: null,
        annotationOverviewTile: {
          state: 'ready',
          fidelity: 'summary',
          generation: 1,
          byteCount: 512,
          validationState: 'metadata_match',
          cacheState: 'hit',
          recordCount: 1,
          sourceRecordCount: 12,
          payload: {
            type: 'annotation-glyphs',
            featureModel: 'resolved-transcript-v2',
            glyphs: [],
            compactGlyphs: [['tx-overview', 'mRNA', 'TX overview', 1_000_100, 1_000_500, '+', 0]],
            droppedCount: 0,
            typeFilteredCount: 1,
          },
        },
      })
    );

    expect(scene.tileSlots[0].laneEpoch).toBe(scene.laneEpoch);
  });

  it('marks viewport tiles as current and retains the overview slot separately', () => {
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        annotationViewportTile: {
          startBp: 998_000,
          endBp: 1_018_000,
          generation: 9,
          state: 'loading',
          fidelity: 'exact',
          cacheState: 'miss',
          recordCount: 0,
          byteCount: 0,
        },
      })
    );

    expect(scene.viewport).toMatchObject({
      startBp: 1_000_000,
      endBp: 1_010_000,
      generation: 9,
    });
    expect(scene.tileSlots).toEqual([
      expect.objectContaining({
        generation: 1,
        state: 'ready',
        currentForViewport: true,
      }),
      expect.objectContaining({
        generation: 9,
        state: 'loading',
        currentForViewport: true,
      }),
    ]);
  });

  it('attaches sanitized annotation glyph payloads only to bounded viewport tiles', () => {
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        annotationViewportTile: {
          startBp: 998_000,
          endBp: 1_018_000,
          generation: 9,
          state: 'ready',
          fidelity: 'best_available',
          cacheState: 'none',
          recordCount: 1,
          byteCount: 256,
          payload: {
            type: 'annotation-glyphs',
            featureModel: 'resolved-transcript-v2',
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
              },
            ],
            droppedCount: 0,
            typeFilteredCount: 1,
          },
        },
      })
    );

    expect(scene.tileSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: 'chr11:annotations',
          generation: 9,
          currentForViewport: true,
          payload: expect.objectContaining({
            type: 'annotation-glyphs',
            glyphs: [
              expect.objectContaining({
                id: 'tx-1',
                label: 'TX1',
                startBp: 1_000_100,
                endBp: 1_000_500,
              }),
            ],
          }),
        }),
      ])
    );
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene)).toBe(false);
  });

  it('preserves viewport annotation tile laneEpoch so stale ready tiles can be rejected', () => {
    const annotationViewportTile = {
      startBp: 998_000,
      endBp: 1_018_000,
      generation: 9,
      state: 'ready' as const,
      fidelity: 'best_available' as const,
      cacheState: 'none' as const,
      recordCount: 0,
      byteCount: 0,
      laneEpoch: 'request-epoch:v1',
    } satisfies NonNullable<
      Parameters<typeof buildIndexedGenomeViewerScene>[0]['annotationViewportTile']
    >;
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        visibleTypes: new Set(['mRNA']),
        laneLimit: null,
        annotationViewportTile,
      })
    );

    expect(
      scene.tileSlots.find((slot) => slot.generation === 9 && slot.kind === 'annotation')?.laneEpoch
    ).toBe('request-epoch:v1');
  });

  it('can attach renderer-ready glyph payloads to the overview tile without raw feature arrays', () => {
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        annotationOverviewTile: {
          state: 'ready',
          fidelity: 'summary',
          generation: 1,
          byteCount: 512,
          validationState: 'metadata_match',
          cacheState: 'hit',
          recordCount: 1,
          sourceRecordCount: 12,
          payload: {
            type: 'annotation-glyphs',
            featureModel: 'resolved-transcript-v2',
            glyphs: [
              {
                id: 'tx-overview',
                type: 'mRNA',
                label: 'TX overview',
                startBp: 1_000_100,
                endBp: 1_000_500,
                strand: '+',
                lane: 0,
                color: 0x3b82f6,
                exons: [{ start: 1_000_100, end: 1_000_200 }],
                cds: [{ start: 1_000_120, end: 1_000_180 }],
                transcriptId: 'NM_OVERVIEW',
                qualifiers: { translation: 'M' },
              },
            ],
            droppedCount: 0,
            typeFilteredCount: 1,
          },
        },
      })
    );

    expect(scene.tileSlots[0]).toMatchObject({
      trackId: 'chr11:annotations',
      currentForViewport: true,
      payload: expect.objectContaining({
        glyphs: [
          expect.objectContaining({
            id: 'tx-overview',
            exons: [{ start: 1_000_100, end: 1_000_200 }],
            cds: [{ start: 1_000_120, end: 1_000_180 }],
          }),
        ],
      }),
    });
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene)).toBe(false);
  });

  it('uses the loaded viewport tile as fallback range when the renderer has not reported a range yet', () => {
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        viewportRange: null,
        annotationViewportTile: {
          startBp: 5_000,
          endBp: 21_384,
          generation: 3,
          state: 'ready',
          fidelity: 'exact',
          cacheState: 'hit',
          recordCount: 17,
          byteCount: 4096,
        },
      })
    );

    expect(scene.viewport).toMatchObject({
      startBp: 5_000,
      endBp: 21_384,
      generation: 3,
    });
    expect(scene.viewport?.pixelsPerBp).toBeCloseTo(960 / 16_384);
  });

  it('promotes the sequence track to ready only when a viewport sequence window exists', () => {
    const withoutSequence = buildIndexedGenomeViewerScene(sceneInput());
    const withSequence = buildIndexedGenomeViewerScene(
      sceneInput({
        viewportRange: { start: 1_000_000, end: 1_000_006 },
        sequenceWindow: {
          startBp: 1_000_000,
          endBp: 1_000_006,
          generation: 4,
          byteCount: 6,
          bases: 'ATGGCC',
        },
      })
    );

    expect(withoutSequence.tracks.find((track) => track.kind === 'sequence')?.state).toBe(
      'coordinate_ready'
    );
    expect(withSequence.tracks.find((track) => track.kind === 'sequence')?.state).toBe('ready');
    expect(withSequence.tileSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: 'chr11:sequence',
          kind: 'sequence',
          startBp: 1_000_000,
          endBp: 1_000_006,
          state: 'ready',
          fidelity: 'exact',
          byteCount: 6,
          recordCount: 6,
          currentForViewport: true,
          payload: {
            type: 'sequence',
            startBp: 1_000_000,
            endBp: 1_000_006,
            bases: 'ATGGCC',
          },
        }),
      ])
    );
  });

  it('keeps an out-of-range sequence window retained instead of marking the sequence row ready', () => {
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        viewportRange: { start: 2_000_000, end: 2_001_000 },
        sequenceWindow: {
          startBp: 1_000_000,
          endBp: 1_001_000,
          generation: 4,
          byteCount: 1000,
          bases: 'A'.repeat(1000),
        },
      })
    );

    expect(scene.tracks.find((track) => track.kind === 'sequence')?.state).toBe('coordinate_ready');
    expect(scene.tileSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: 'chr11:sequence',
          currentForViewport: false,
        }),
      ])
    );
  });

  it('represents pending sequence and annotation requests as current row-local loading slots', () => {
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        viewportRange: { start: 2_000_000, end: 2_000_500 },
        sequenceWindow: {
          startBp: 1_000_000,
          endBp: 1_001_000,
          generation: 4,
          byteCount: 1000,
          bases: 'A'.repeat(1000),
        },
        pendingSequenceWindow: {
          startBp: 1_950_000,
          endBp: 2_050_000,
          token: 11,
          requestId: 'sequence-window-11',
        },
        pendingAnnotationViewportTile: {
          startBp: 1_990_000,
          endBp: 2_010_000,
          token: 12,
          requestId: 'annotation-viewport-12',
        },
      })
    );

    expect(scene.viewport?.generation).toBe(12);
    expect(scene.tracks.find((track) => track.kind === 'sequence')).toMatchObject({
      state: 'building_cache',
      userState: 'Updating',
    });
    expect(scene.tracks.find((track) => track.kind === 'annotation')).toMatchObject({
      state: 'building_cache',
      userState: 'Updating',
    });
    expect(scene.tileSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: 'chr11:sequence',
          state: 'loading',
          fidelity: 'exact',
          startBp: 1_950_000,
          endBp: 2_050_000,
          currentForViewport: true,
        }),
        expect.objectContaining({
          trackId: 'chr11:annotations',
          state: 'loading',
          fidelity: 'best_available',
          startBp: 1_990_000,
          endBp: 2_010_000,
          currentForViewport: true,
        }),
        expect.objectContaining({
          trackId: 'chr11:sequence',
          state: 'ready',
          currentForViewport: false,
        }),
      ])
    );
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene)).toBe(false);
  });

  it('maps pending annotation overview state into row-local updating state with a message', () => {
    const scene = buildIndexedGenomeViewerScene(
      sceneInput({
        annotationOverviewTile: {
          state: 'building_summary',
          fidelity: 'summary',
          generation: 2,
          byteCount: 0,
          validationState: 'metadata_match',
          cacheState: 'miss',
          recordCount: 0,
          message: 'Building overview',
        },
      })
    );

    expect(scene.tracks.find((track) => track.kind === 'annotation')).toMatchObject({
      state: 'building_cache',
      userState: 'Updating',
      message: 'Building overview',
    });
  });
});
