// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Feature } from '@waypoint/genome-renderer';
import type { IndexedGenomeScene } from './indexed-genome-scene';
import { annotationSummaryGlyphPayloadFromRendererFeatures } from './indexed-genome-legacy-adapter';
import { indexedGenomeSceneToRendererGenome } from './indexed-genome-renderer-adapter';

function scene(overrides: Partial<IndexedGenomeScene> = {}): IndexedGenomeScene {
  return {
    mode: 'tile-native-session-shell',
    sessionId: 'session-chr11',
    sourceId: '/workspace/chr11.fa',
    sourceFingerprint: 'fingerprint-chr11',
    chrom: 'chr11',
    lengthState: 'coordinate_ready',
    length: 135_086_622,
    coordinateReady: true,
    validationState: 'metadata_match',
    laneEpoch: 'fingerprint-chr11:chr11:lane-v0',
    viewport: {
      chrom: 'chr11',
      startBp: 1_000_000,
      endBp: 1_000_006,
      widthPx: 960,
      heightPx: 480,
      pixelsPerBp: 160,
      generation: 8,
    },
    tracks: [
      {
        id: 'chr11:sequence',
        kind: 'sequence',
        label: 'Sequence',
        state: 'ready',
        userState: 'Showing overview',
      },
      {
        id: 'chr11:annotations',
        kind: 'annotation',
        label: 'Annotations',
        state: 'ready',
        userState: 'Showing overview',
      },
    ],
    tileSlots: [
      {
        trackId: 'chr11:sequence',
        kind: 'sequence',
        chrom: 'chr11',
        startBp: 1_000_000,
        endBp: 1_000_006,
        generation: 8,
        state: 'ready',
        fidelity: 'exact',
        validationState: 'metadata_match',
        cacheState: 'none',
        byteCount: 6,
        recordCount: 6,
        currentForViewport: true,
        payload: {
          type: 'sequence',
          startBp: 1_000_000,
          endBp: 1_000_006,
          bases: 'ATGGCC',
        },
      },
      {
        trackId: 'chr11:annotations',
        kind: 'annotation',
        chrom: 'chr11',
        startBp: 999_900,
        endBp: 1_000_500,
        generation: 8,
        state: 'ready',
        fidelity: 'best_available',
        validationState: 'metadata_match',
        cacheState: 'none',
        byteCount: 128,
        recordCount: 1,
        layerTypes: ['mRNA', 'enhancer'],
        currentForViewport: true,
        laneEpoch: 'fingerprint-chr11:chr11:lane-v0',
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
              strand: '-',
              lane: 2,
              color: 0x3b82f6,
              exons: [
                { start: 1_000_002, end: 1_000_003 },
                { start: 1_000_004, end: 1_000_005 },
              ],
              cds: [{ start: 1_000_002, end: 1_000_005 }],
              transcriptId: 'NM_TX1',
              qualifiers: {
                _locationString: 'join(1000002..1000003,1000004..1000005)',
                translation: 'MA',
              },
            },
          ],
          droppedCount: 0,
          typeFilteredCount: 1,
        },
      },
    ],
    ...overrides,
  };
}

describe('indexed genome renderer adapter', () => {
  it('converts tile-native scene payloads into renderer-native Genome data', () => {
    const genome = indexedGenomeSceneToRendererGenome(scene());

    expect(genome).toMatchObject({
      name: 'chr11',
      length: 135_086_622,
      circular: false,
      sequenceWindow: {
        startBp: 1_000_000,
        bases: 'ATGGCC',
      },
    });
    expect(genome.sequence).toBeUndefined();
    expect(genome.features).toEqual([
      expect.objectContaining({
        type: 'mRNA',
        start: 1_000_001,
        end: 1_000_005,
        direction: 'reverse',
        displayName: 'TX1',
        color: 0x3b82f6,
        lane: 2,
        exons: [
          { start: 1_000_002, end: 1_000_003 },
          { start: 1_000_004, end: 1_000_005 },
        ],
        cds: [{ start: 1_000_002, end: 1_000_005 }],
        transcriptId: 'NM_TX1',
        qualifiers: {
          _locationString: 'join(1000002..1000003,1000004..1000005)',
          translation: 'MA',
          ID: 'tx-1',
          Name: 'TX1',
          _lane: '2',
        },
      }),
    ]);
    expect(JSON.stringify(genome)).not.toContain('raw');
    expect(JSON.stringify(genome)).not.toContain('attributes');
    expect(genome.annotationLayerTypes).toEqual(['enhancer', 'mRNA']);
    expect(genome.sourceIdentity).toBe('fingerprint-chr11');
  });

  it('treats an explicit scene annotation layout as authoritative over resident detail', () => {
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        annotationLayout: { maxAnnotationLane: 8, maxCdsLane: 1 },
        annotationLayerTypes: ['gene'],
      })
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
    expect(genome.annotationLayout).toEqual({ maxAnnotationLane: 8, maxCdsLane: 1 });
    expect(genome.annotationLayerTypes).toEqual(['enhancer', 'gene', 'mRNA']);
  });

  it('fails closed by dropping features outside an explicit annotation lane contract', () => {
    const base = scene();
    const glyph = base.tileSlots[1].payload;
    if (!glyph || glyph.type !== 'annotation-glyphs' || !glyph.glyphs?.[0]) {
      throw new Error('test fixture annotation glyph is missing');
    }
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        annotationLayout: { maxAnnotationLane: 1, maxCdsLane: -1 },
        tileSlots: [
          base.tileSlots[0],
          {
            ...base.tileSlots[1],
            payload: {
              ...glyph,
              glyphs: [{ ...glyph.glyphs[0], lane: 2 }],
            },
          },
        ],
      })
    );

    expect(genome.annotationLayout).toEqual({ maxAnnotationLane: 1, maxCdsLane: -1 });
    expect(genome.features).toEqual([]);
  });

  it('keeps the last valid lane and drops overflow for a multi-type finite envelope', () => {
    const base = scene();
    const payload = base.tileSlots[1].payload;
    if (!payload || payload.type !== 'annotation-glyphs' || !payload.glyphs?.[0]) {
      throw new Error('test fixture annotation glyph is missing');
    }
    const template = payload.glyphs[0];
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        annotationLayout: { maxAnnotationLane: 24, maxCdsLane: -1 },
        tileSlots: [
          base.tileSlots[0],
          {
            ...base.tileSlots[1],
            payload: {
              ...payload,
              glyphs: [
                { ...template, id: 'gene-last', type: 'gene', label: 'LAST', lane: 24 },
                {
                  ...template,
                  id: 'mrna-overflow',
                  label: 'OVERFLOW',
                  lane: 25,
                  startBp: template.startBp + 10,
                  endBp: template.endBp + 10,
                  exons: template.exons?.map((exon) => ({
                    start: exon.start + 10,
                    end: exon.end + 10,
                  })),
                },
              ],
            },
          },
        ],
      })
    );

    expect(genome.annotationLayout).toEqual({ maxAnnotationLane: 24, maxCdsLane: -1 });
    expect(genome.features?.map((feature) => [feature.displayName, feature.lane])).toEqual([
      ['LAST', 24],
    ]);
  });

  it('resolves cross-tile collisions inside each track without spilling into a neighbor band', () => {
    const base = scene();
    const payload = base.tileSlots[1].payload;
    if (!payload || payload.type !== 'annotation-glyphs' || !payload.glyphs?.[0]) {
      throw new Error('test fixture annotation glyph is missing');
    }
    const template = payload.glyphs[0];
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        annotationLayout: { maxAnnotationLane: 2, maxCdsLane: -1 },
        tileSlots: [
          base.tileSlots[0],
          {
            ...base.tileSlots[1],
            payload: {
              ...payload,
              glyphs: [
                {
                  ...template,
                  id: 'a-1',
                  transcriptId: 'a-1',
                  label: 'A1',
                  trackId: 'track-a',
                  trackLane: 0,
                  trackLaneCapacity: 1,
                  lane: 0,
                },
                {
                  ...template,
                  id: 'a-2',
                  transcriptId: 'a-2',
                  label: 'A2',
                  trackId: 'track-a',
                  trackLane: 0,
                  trackLaneCapacity: 1,
                  lane: 0,
                },
                {
                  ...template,
                  id: 'b-1',
                  transcriptId: 'b-1',
                  label: 'B1',
                  trackId: 'track-b',
                  trackLane: 0,
                  trackLaneCapacity: 1,
                  lane: 2,
                },
              ],
            },
          },
        ],
      })
    );

    const features = genome.features ?? [];
    expect(features).toHaveLength(2);
    expect(features.filter((feature) => feature.annotationTrackId === 'track-a')).toHaveLength(1);
    expect(features.find((feature) => feature.annotationTrackId === 'track-a')?.lane).toBe(0);
    expect(features.find((feature) => feature.annotationTrackId === 'track-b')?.lane).toBe(2);
    expect(features.some((feature) => feature.lane === 1)).toBe(false);
  });

  it('keeps the shared legacy collision pool when no finite track capacity exists', () => {
    const base = scene();
    const payload = base.tileSlots[1].payload;
    if (!payload || payload.type !== 'annotation-glyphs' || !payload.glyphs?.[0]) {
      throw new Error('test fixture annotation glyph is missing');
    }
    const template = payload.glyphs[0];
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          base.tileSlots[0],
          {
            ...base.tileSlots[1],
            payload: {
              ...payload,
              glyphs: [
                {
                  ...template,
                  id: 'all-a',
                  transcriptId: 'all-a',
                  trackId: 'gene',
                  trackLane: 0,
                  lane: 0,
                },
                {
                  ...template,
                  id: 'all-b',
                  transcriptId: 'all-b',
                  trackId: 'mRNA',
                  trackLane: 0,
                  lane: 0,
                },
              ],
            },
          },
        ],
      })
    );

    expect(genome.features?.map((feature) => feature.lane).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('falls back to the current local lane when a previous lane exceeds a reduced capacity', () => {
    const base = scene();
    const payload = base.tileSlots[1].payload;
    if (!payload || payload.type !== 'annotation-glyphs' || !payload.glyphs?.[0]) {
      throw new Error('test fixture annotation glyph is missing');
    }
    const currentScene = scene({
      annotationLayout: { maxAnnotationLane: 7, maxCdsLane: -1 },
      tileSlots: [
        base.tileSlots[0],
        {
          ...base.tileSlots[1],
          layerTypes: ['mRNA'],
          payload: {
            ...payload,
            glyphs: [
              {
                ...payload.glyphs[0],
                trackId: 'mRNA',
                trackLane: 0,
                trackLaneCapacity: 8,
                lane: 0,
              },
            ],
          },
        },
      ],
    });
    const first = indexedGenomeSceneToRendererGenome(currentScene);
    const featureId = first.features?.[0]?.id;
    if (featureId === undefined) throw new Error('current feature is missing');

    const afterCapReduction = indexedGenomeSceneToRendererGenome(currentScene, {
      previousLaneAssignments: new Map([[featureId, 11]]),
    });

    expect(afterCapReduction.features).toEqual([
      expect.objectContaining({ lane: 0, annotationTrackLane: 0 }),
    ]);
  });

  it('continues to infer annotation height when no explicit layout contract exists', () => {
    const genome = indexedGenomeSceneToRendererGenome(scene());

    expect(genome.annotationLayout).toEqual({ maxAnnotationLane: 2, maxCdsLane: -1 });
    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
  });

  it('can omit sequence windows so streaming base updates stay on the cheap renderer path', () => {
    const genome = indexedGenomeSceneToRendererGenome(scene(), { includeSequenceWindow: false });

    expect(genome.sequenceWindow).toBeUndefined();
    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
  });

  it('derives annotation layer types from rendered slots, not stale offscreen slots', () => {
    const base = scene();
    const currentSlot = { ...base.tileSlots[1], layerTypes: ['mRNA'] };
    const staleOffscreenSlot = {
      ...base.tileSlots[1],
      startBp: 42_000_000,
      endBp: 42_001_000,
      currentForViewport: false,
      fidelity: 'summary' as const,
      layerTypes: ['enhancer'],
      payload: {
        type: 'annotation-glyphs' as const,
        featureModel: 'resolved-transcript-v2' as const,
        glyphs: [],
        compactGlyphs: [['enhancer-1', 'enhancer', 'ENH1', 42_000_100, 42_000_200, '+', 0]],
        droppedCount: 0,
        typeFilteredCount: 1,
      },
    };

    const genome = indexedGenomeSceneToRendererGenome(
      scene({ tileSlots: [base.tileSlots[0], staleOffscreenSlot, currentSlot] })
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
    expect(genome.annotationLayerTypes).toEqual(['mRNA']);
  });

  it('ignores retained stale payloads when building the renderer genome', () => {
    const base = scene();
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          ...base.tileSlots,
          {
            ...base.tileSlots[1],
            generation: 7,
            currentForViewport: false,
            payload: {
              type: 'annotation-glyphs',
              featureModel: 'resolved-transcript-v2',
              glyphs: [
                {
                  id: 'stale-tx',
                  type: 'mRNA',
                  label: 'STALE',
                  startBp: 1,
                  endBp: 100,
                  strand: '+',
                  lane: 0,
                  color: 0x111111,
                },
              ],
              droppedCount: 0,
              typeFilteredCount: 1,
            },
          },
        ],
      })
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
  });

  it('uses a retained ready annotation payload while a newer tile is loading', () => {
    const base = scene();
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        viewport: {
          ...base.viewport!,
          generation: 9,
        },
        tileSlots: [
          {
            ...base.tileSlots[1],
            generation: 8,
            currentForViewport: false,
          },
          {
            ...base.tileSlots[1],
            generation: 9,
            state: 'loading',
            fidelity: 'best_available',
            recordCount: 0,
            byteCount: 0,
            currentForViewport: true,
            payload: undefined,
          },
        ],
      })
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
  });

  it('keeps all glyphs from the bounded exact tile so imperative panning stays warm', () => {
    const base = scene();
    const exactSlot = base.tileSlots[1];
    const exactPayload = exactSlot.payload;
    expect(exactPayload?.type).toBe('annotation-glyphs');
    if (exactPayload?.type !== 'annotation-glyphs') return;
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          {
            ...exactSlot,
            payload: {
              ...exactPayload,
              glyphs: [
                ...exactPayload.glyphs,
                {
                  id: 'tx-warm-pan',
                  type: 'mRNA',
                  label: 'WARM-PAN',
                  startBp: 1_000_300,
                  endBp: 1_000_400,
                  strand: '+',
                  lane: 0,
                  color: 0x3b82f6,
                  exons: [{ start: 1_000_320, end: 1_000_360 }],
                },
              ],
            },
          },
        ],
      })
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1', 'WARM-PAN']);
  });

  it('lets current exact viewport refinement replace overlapping summary glyphs', () => {
    const base = scene();
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          {
            ...base.tileSlots[1],
            startBp: 0,
            endBp: 135_086_622,
            generation: 1,
            fidelity: 'summary',
            currentForViewport: false,
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
                  strand: '-',
                  lane: 0,
                  color: 0x3b82f6,
                  transcriptId: 'NM_TX1',
                },
              ],
              droppedCount: 0,
              typeFilteredCount: 1,
            },
          },
          base.tileSlots[1],
        ],
      })
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
    expect(genome.features?.[0]?.exons?.length).toBe(2);
  });

  it('suppresses overlapping overview glyphs even when the detail tile has different source ids', () => {
    const base = scene();
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          {
            ...base.tileSlots[1],
            startBp: 0,
            endBp: 135_086_622,
            generation: 1,
            fidelity: 'summary',
            currentForViewport: false,
            payload: {
              type: 'annotation-glyphs',
              featureModel: 'resolved-transcript-v2',
              glyphs: [
                {
                  id: 'summary-gene-1',
                  type: 'gene',
                  label: 'SUMMARY-GENE',
                  startBp: 1_000_000,
                  endBp: 1_000_010,
                  strand: '+',
                  lane: 0,
                  color: 0x3b82f6,
                },
              ],
              droppedCount: 0,
              typeFilteredCount: 1,
            },
          },
          base.tileSlots[1],
        ],
      })
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
  });

  it('does not retain a stale overview glyph inside a current detail tile range', () => {
    const base = scene();
    const retainedOverviewFeature = {
      id: 101,
      type: 'gene',
      start: 1_000_000,
      end: 1_000_010,
      direction: 'forward',
      displayName: 'RETAINED-SUMMARY-GENE',
      color: 0x3b82f6,
      lane: 0,
      qualifiers: { ID: 'summary-gene-1', Name: 'RETAINED-SUMMARY-GENE', _lane: '0' },
    } as const;
    const genome = indexedGenomeSceneToRendererGenome(scene({ tileSlots: [base.tileSlots[1]] }), {
      previousAnnotationFeatures: new Map([
        ['gene|summary-gene-1|forward', retainedOverviewFeature],
      ]),
    });

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
  });

  it('does not let lane-bound-only summary metadata extend the retention authority', () => {
    const base = scene();
    const exactSlot = base.tileSlots[1];
    const retainedFarFeature = {
      id: 303,
      type: 'gene',
      start: 42_000_000,
      end: 42_001_000,
      direction: 'forward',
      displayName: 'RETAINED-FAR',
      color: 0x3b82f6,
      lane: 17,
      qualifiers: { ID: 'retained-far', Name: 'RETAINED-FAR', _lane: '17' },
    } as const;
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          {
            ...exactSlot,
            startBp: 0,
            endBp: 135_086_622,
            generation: 1,
            fidelity: 'summary',
            currentForViewport: false,
            payload: {
              type: 'annotation-glyphs',
              featureModel: 'resolved-transcript-v2',
              glyphs: [],
              compactGlyphs: [],
              laneBounds: {
                maxAnnotationLane: 17,
                maxCdsLane: -1,
              },
              droppedCount: 0,
              typeFilteredCount: 0,
            },
          },
          exactSlot,
        ],
      }),
      {
        previousAnnotationFeatures: new Map([['gene|retained-far|forward', retainedFarFeature]]),
      }
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
  });

  it('can disable previous-feature retention for assembly-scoped rendering', () => {
    const base = scene();
    const retainedFeature = {
      id: 202,
      type: 'gene',
      start: 1_000_002,
      end: 1_000_004,
      direction: 'forward',
      displayName: 'RETAINED-FEATURE',
      color: 0x10b981,
      lane: 1,
      qualifiers: { ID: 'retained-feature', Name: 'RETAINED-FEATURE', _lane: '1' },
    } as const;
    const currentSummarySlot = { ...base.tileSlots[1], fidelity: 'summary' as const };
    const withRetention = indexedGenomeSceneToRendererGenome(
      scene({ tileSlots: [currentSummarySlot] }),
      {
        previousAnnotationFeatures: new Map([['gene|retained-feature|forward', retainedFeature]]),
      }
    );
    const withoutRetention = indexedGenomeSceneToRendererGenome(
      scene({ tileSlots: [currentSummarySlot] }),
      {
        enableTransitionRetention: false,
        previousAnnotationFeatures: new Map([['gene|retained-feature|forward', retainedFeature]]),
      }
    );

    expect(withRetention.features?.map((feature) => feature.displayName)).toEqual([
      'TX1',
      'RETAINED-FEATURE',
    ]);
    expect(withoutRetention.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
  });

  it('does not let offscreen summary lane bounds drive exact viewport layout', () => {
    const base = scene();
    const exactSlot = base.tileSlots[1];
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          {
            ...exactSlot,
            startBp: 0,
            endBp: 135_086_622,
            generation: 1,
            fidelity: 'summary',
            currentForViewport: false,
            payload: {
              type: 'annotation-glyphs',
              featureModel: 'resolved-transcript-v2',
              glyphs: [],
              compactGlyphs: [
                ['tx-1', 'mRNA', 'TX1', 1_000_001, 1_000_005, '-', 2],
                ['summary-far', 'mRNA', 'FAR', 42_000_000, 42_001_000, '+', 17],
              ],
              laneBounds: {
                maxAnnotationLane: 17,
                maxCdsLane: -1,
              },
              droppedCount: 0,
              typeFilteredCount: 2,
            },
          },
          exactSlot,
        ],
      })
    );

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['TX1']);
    expect(genome.annotationLayout?.maxAnnotationLane).toBe(2);
    expect(genome.features?.find((feature) => feature.displayName === 'TX1')?.exons?.length).toBe(
      2
    );
  });

  it('expands compact summary transcript geometry before the renderer sees it', () => {
    const base = scene();
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        viewport: {
          chrom: 'chr11',
          startBp: 1_000_000,
          endBp: 1_000_010,
          widthPx: 960,
          heightPx: 480,
          pixelsPerBp: 96,
          generation: 1,
        },
        tileSlots: [
          {
            ...base.tileSlots[1],
            startBp: 0,
            endBp: 135_086_622,
            generation: 1,
            fidelity: 'summary',
            currentForViewport: true,
            payload: {
              type: 'annotation-glyphs',
              featureModel: 'resolved-transcript-v2',
              glyphs: [],
              compactGlyphs: [['tx-compact', 'mRNA', 'TX-COMPACT', 1_000_001, 1_000_008, '+', 4]],
              compactGeometry: [
                [
                  'tx-compact',
                  [1_000_001, 1_000_003, 1_000_006, 1_000_008],
                  [1_000_002, 1_000_007],
                  'NM_COMPACT',
                ],
              ],
              laneBounds: {
                maxAnnotationLane: 4,
                maxCdsLane: -1,
              },
              droppedCount: 0,
              typeFilteredCount: 1,
            },
          },
        ],
      })
    );

    expect(genome.features).toEqual([
      expect.objectContaining({
        displayName: 'TX-COMPACT',
        exons: [
          { start: 1_000_001, end: 1_000_003 },
          { start: 1_000_006, end: 1_000_008 },
        ],
        cds: [{ start: 1_000_002, end: 1_000_007 }],
        transcriptId: 'NM_COMPACT',
      }),
    ]);
  });

  it('restores compact logical track identity and local lane metadata', () => {
    const base = scene();
    const slot = base.tileSlots[1];
    const promoted: Feature = {
      id: 91,
      type: 'ncRNA',
      annotationTrackId: 'lncRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 12,
      start: 1_000_001,
      end: 1_000_005,
      direction: 'forward',
      displayName: 'RNA1',
      color: 0x3b82f6,
      lane: 13,
      exons: [{ start: 1_000_001, end: 1_000_005 }],
      transcriptId: 'rna-1',
    };
    const produced = annotationSummaryGlyphPayloadFromRendererFeatures(
      { features: [promoted], droppedCount: 0, typeFilteredCount: 1 },
      {
        chrom: 'chr11',
        viewportRange: { start: 0, end: 135_086_622 },
        widthPx: 960,
        maxPayloadBytes: 1,
      }
    );
    const roundTripped = JSON.parse(
      JSON.stringify({
        type: 'annotation-glyphs',
        featureModel: 'resolved-transcript-v2',
        ...produced,
      })
    );
    expect(roundTripped.compactGlyphs[0]).not.toContain(null);
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          base.tileSlots[0],
          {
            ...slot,
            fidelity: 'summary',
            layerTypes: ['lncRNA'],
            payload: roundTripped,
          },
        ],
      })
    );

    expect(genome.features?.[0]).toMatchObject({
      type: 'ncRNA',
      annotationTrackId: 'lncRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 12,
      lane: 13,
    });
    expect(genome.annotationLayerTypes).toEqual(['lncRNA']);
  });

  it('normalizes malformed compact track metadata without dropping the glyph', () => {
    const base = scene();
    const slot = base.tileSlots[1];
    const malformedPayload = JSON.parse(
      JSON.stringify({
        type: 'annotation-glyphs',
        featureModel: 'resolved-transcript-v2',
        glyphs: [],
        compactGlyphs: [
          ['missing-track', 'ncRNA', 'MISSING', 1_000_001, 1_000_003, '+', 0, null, 0, 12],
          ['bad-cap', 'ncRNA', 'BAD-CAP', 1_000_004, 1_000_006, '+', 1, 'lncRNA', 12, 12],
        ],
        droppedCount: 0,
        typeFilteredCount: 2,
      })
    );
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        viewport: {
          ...base.viewport!,
          endBp: 1_000_010,
        },
        tileSlots: [
          base.tileSlots[0],
          {
            ...slot,
            endBp: 1_000_010,
            fidelity: 'summary',
            layerTypes: [],
            payload: malformedPayload,
          },
        ],
      })
    );

    expect(genome.features).toEqual([
      expect.objectContaining({
        displayName: 'MISSING',
        type: 'ncRNA',
        lane: 0,
      }),
      expect.objectContaining({
        displayName: 'BAD-CAP',
        type: 'ncRNA',
        annotationTrackId: 'lncRNA',
        annotationTrackLane: 12,
        lane: 1,
      }),
    ]);
    expect(genome.features?.[0]).not.toHaveProperty('annotationTrackId');
    expect(genome.features?.[0]).not.toHaveProperty('annotationTrackLane');
    expect(genome.features?.[0]).not.toHaveProperty('annotationTrackLaneCapacity');
    expect(genome.features?.[1]).not.toHaveProperty('annotationTrackLaneCapacity');
  });

  it('reports promoted rich glyphs only under their logical annotation layer', () => {
    const base = scene();
    const slot = base.tileSlots[1];
    const payload = slot.payload;
    if (!payload || payload.type !== 'annotation-glyphs' || !payload.glyphs?.[0]) {
      throw new Error('test fixture annotation glyph is missing');
    }
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          base.tileSlots[0],
          {
            ...slot,
            layerTypes: ['lncRNA'],
            payload: {
              ...payload,
              glyphs: [
                {
                  ...payload.glyphs[0],
                  id: 'rna-rich',
                  type: 'ncRNA',
                  trackId: 'lncRNA',
                  trackLane: 0,
                  trackLaneCapacity: 12,
                  lane: 0,
                },
              ],
            },
          },
        ],
      })
    );

    expect(genome.features?.[0]).toMatchObject({
      type: 'ncRNA',
      annotationTrackId: 'lncRNA',
    });
    expect(genome.annotationLayerTypes).toEqual(['lncRNA']);
  });

  it('does not synthesize exon geometry for compact transcript glyphs without child geometry', () => {
    const base = scene();
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          {
            ...base.tileSlots[1],
            startBp: 0,
            endBp: 135_086_622,
            generation: 1,
            fidelity: 'summary',
            currentForViewport: true,
            payload: {
              type: 'annotation-glyphs',
              featureModel: 'resolved-transcript-v2',
              glyphs: [],
              compactGlyphs: [['single-span', 'mRNA', 'SINGLE-SPAN', 1_000_001, 1_000_002, '+', 4]],
              droppedCount: 0,
              typeFilteredCount: 1,
            },
          },
        ],
      })
    );

    expect(genome.features).toEqual([
      expect.objectContaining({
        displayName: 'SINGLE-SPAN',
      }),
    ]);
    expect(genome.features?.[0]?.exons).toBeUndefined();
  });

  it('drops non-summary transcript glyphs without exon geometry', () => {
    const base = scene();
    const slot = base.tileSlots[1];
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        tileSlots: [
          {
            ...slot,
            payload: {
              type: 'annotation-glyphs',
              featureModel: 'resolved-transcript-v2',
              glyphs: [
                {
                  id: 'coarse-tx',
                  type: 'mRNA',
                  label: 'COARSE-TX',
                  startBp: 1_000_001,
                  endBp: 1_000_020,
                  strand: '+',
                  lane: 4,
                  color: 0x3b82f6,
                  transcriptId: 'NM_COARSE',
                },
              ],
              droppedCount: 0,
              typeFilteredCount: 1,
            },
          },
        ],
      })
    );

    expect(genome.features).toEqual([]);
  });

  it('infers a nonzero length for length-pending shells', () => {
    const genome = indexedGenomeSceneToRendererGenome(
      scene({
        lengthState: 'length_unknown',
        length: null,
        coordinateReady: false,
      })
    );

    expect(genome.length).toBe(1_000_500);
  });

  describe('laneEpoch wire-format (Slice 1a)', () => {
    it('drops a stale-epoch slot from the renderer feature set', () => {
      const base = scene();
      const annotationSlot = base.tileSlots[1];
      const staleSlot = { ...annotationSlot, laneEpoch: 'stale-epoch:v0' };
      const sceneWithStaleSlot: typeof base = {
        ...base,
        laneEpoch: 'fresh-epoch:v1',
        tileSlots: [base.tileSlots[0], staleSlot],
      };

      const genome = indexedGenomeSceneToRendererGenome(sceneWithStaleSlot);
      const mRnaRows = (genome.features ?? []).filter((f) => f.type === 'mRNA');

      expect(mRnaRows).toEqual([]);
    });

    it('does NOT paint a stale-ready slot when a current-pending slot exists', () => {
      const base = scene();
      const annotationSlot = base.tileSlots[1];
      if (annotationSlot.payload?.type !== 'annotation-glyphs') throw new Error('bad fixture');

      const staleReady = {
        ...annotationSlot,
        laneEpoch: 'stale-epoch:v0',
        state: 'ready' as const,
      };
      const currentPending = {
        ...annotationSlot,
        laneEpoch: 'fresh-epoch:v1',
        state: 'loading' as const,
        payload: undefined,
        recordCount: 0,
        byteCount: 0,
        currentForViewport: true,
      };
      const sceneWithBothSlots: typeof base = {
        ...base,
        laneEpoch: 'fresh-epoch:v1',
        tileSlots: [base.tileSlots[0], staleReady, currentPending],
      };

      const genome = indexedGenomeSceneToRendererGenome(sceneWithBothSlots);
      const mRnaRows = (genome.features ?? []).filter((f) => f.type === 'mRNA');

      expect(mRnaRows).toEqual([]);
    });

    it('paints a matching-epoch slot normally', () => {
      const base = scene();
      const annotationSlot = base.tileSlots[1];
      const matchingSlot = { ...annotationSlot, laneEpoch: 'fresh-epoch:v1' };
      const sceneWithMatchingSlot: typeof base = {
        ...base,
        laneEpoch: 'fresh-epoch:v1',
        tileSlots: [base.tileSlots[0], matchingSlot],
      };

      const genome = indexedGenomeSceneToRendererGenome(sceneWithMatchingSlot);
      const mRnaRows = (genome.features ?? []).filter((f) => f.type === 'mRNA');

      expect(mRnaRows.length).toBeGreaterThan(0);
    });

    it('drops an epochless annotation slot instead of accepting stale back-compat authority', () => {
      const base = scene();
      const annotationSlot = base.tileSlots[1];
      const { laneEpoch: _laneEpoch, ...epochlessSlot } = annotationSlot;
      const genome = indexedGenomeSceneToRendererGenome(
        scene({ tileSlots: [base.tileSlots[0], epochlessSlot] })
      );
      const mRnaRows = (genome.features ?? []).filter((f) => f.type === 'mRNA');

      expect(mRnaRows).toEqual([]);
    });
  });
});
