// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildAssembly, type Feature } from '@waypoint/genome-renderer';
import type { GenomeFeature } from '@waypoint/genome-data';
import type {
  AssemblyOverviewTextureManifest,
  GenomeAnnotationGlyphPayload,
} from '../../../shared/indexed-genome';

import {
  assemblyAnnotationLayoutOwnershipKey,
  assemblyAnnotationLayerTypes,
  applyAssemblyRendererLaneControls,
  buildAssemblyAnnotationScene,
  buildAssemblyComposedFeatures,
  hasCompleteIndexedAssemblyOverview,
} from './assembly-renderer-genome';
import {
  evaluateIndexedGenomeSceneInvariants,
  indexedGenomeSceneHasWholeFeaturePayload,
} from './indexed-genome-scene';
import { indexedGenomeSceneToRendererGenome } from './indexed-genome-renderer-adapter';
import {
  annotationGlyphPayloadFromRendererFeatures,
  applyDensityControls,
} from './indexed-genome-legacy-adapter';

const assembly = buildAssembly('grch38-test', 'GRCh38 Test', [
  { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] },
  { id: 'chr2', displayName: 'chr2', length: 2_000, cytobands: [] },
]);

function feature(overrides: Partial<Feature>): Feature {
  return {
    id: overrides.id ?? 1,
    start: overrides.start ?? 0,
    end: overrides.end ?? 100,
    type: overrides.type ?? 'mRNA',
    displayName: overrides.displayName ?? `feature-${overrides.id ?? 1}`,
    direction: overrides.direction ?? 'forward',
    lane: overrides.lane ?? 0,
    color: overrides.color ?? '#44aa88',
    ...overrides,
  };
}

function prebuiltManifest(
  overrides: Partial<AssemblyOverviewTextureManifest> = {}
): AssemblyOverviewTextureManifest {
  return {
    version: 1,
    assemblyId: 'grch38-test',
    fingerprint: 'test-fingerprint',
    cacheContractToken: 'test-contract',
    sourceBuildFingerprint: 'test-build',
    placementSignature: 'placement:test',
    textureFile: 'grch38-test-test-fingerprint.png',
    widthPx: 8192,
    heightPx: 480,
    resolution: 2,
    spineOffsetPx: 240,
    genomeLength: 3_000,
    maxAnnotationLane: 4,
    maxCdsLane: 2,
    layerTypes: ['mRNA', 'CDS', 'gene'],
    ...overrides,
  };
}

describe('assembly renderer genome composition', () => {
  it('derives overview completeness from indexed chromosome partition presence, including empty chromosomes', () => {
    const complete = new Map<string, Feature[]>([
      ['chr1', [feature({ id: 1 })]],
      ['chr2', []],
      ['unindexed-extra', [feature({ id: 9 })]],
    ]);
    expect(
      hasCompleteIndexedAssemblyOverview({
        assemblyByChrom: complete,
        indexedChroms: ['chr1', 'chr2'],
      })
    ).toBe(true);
    expect(
      hasCompleteIndexedAssemblyOverview({
        assemblyByChrom: new Map([['chr1', []]]),
        indexedChroms: ['chr1', 'chr2'],
      })
    ).toBe(false);
    expect(
      hasCompleteIndexedAssemblyOverview({ assemblyByChrom: complete, indexedChroms: [] })
    ).toBe(false);
  });

  it('uses only streamed detail for assembly renderer features without re-laning them', () => {
    const detail = new Map<string, Feature[]>([
      ['chr1', [feature({ id: 4, start: 20, end: 60, type: 'mRNA', lane: 42 })]],
      ['chr2', [feature({ id: 5, start: 1_020, end: 1_060, type: 'enhancer', lane: 17 })]],
    ]);

    const composed = buildAssemblyComposedFeatures({
      rendererAssembly: assembly,
      assemblyDetailByChrom: detail,
      visibleTypes: new Set(['mRNA']),
    });

    expect(composed?.map((f) => f.id)).toEqual([4]);
    expect(composed?.map((f) => f.lane)).toEqual([42]);
  });

  it('preserves assembly chromosome order and per-chromosome feature order for cached feature indices', () => {
    const byChrom = new Map<string, Feature[]>([
      ['chr2', [feature({ id: 22, start: 1_100 }), feature({ id: 23, start: 1_200 })]],
      ['chr1', [feature({ id: 11, start: 100 }), feature({ id: 12, start: 200 })]],
    ]);
    const composed = buildAssemblyComposedFeatures({
      rendererAssembly: assembly,
      assemblyByChrom: byChrom,
      assemblyDetailByChrom: new Map(),
      visibleTypes: new Set(['mRNA']),
    });
    expect(composed?.map(({ id }) => id)).toEqual([11, 12, 22, 23]);
  });

  it('derives assembly annotation controls from composed renderer features, not anchor tiles', () => {
    const composed = [
      feature({ id: 11, type: 'mRNA', lane: 1 }),
      feature({ id: 12, type: 'gene', lane: 0 }),
      feature({ id: 13, type: 'mRNA', lane: 2 }),
      feature({ id: 14, type: 'CDS', lane: 3 }),
    ];

    expect(assemblyAnnotationLayerTypes(composed)).toEqual(['CDS', 'gene', 'mRNA']);
  });

  it('keeps prebuilt overview layer controls available before streamed detail loads', () => {
    expect(assemblyAnnotationLayerTypes(null, ['mRNA'])).toEqual(['mRNA']);
    expect(assemblyAnnotationLayerTypes([feature({ id: 15, type: 'enhancer' })], ['mRNA'])).toEqual(
      ['enhancer', 'mRNA']
    );
  });

  it('does not fabricate an assembly renderer genome without streamed detail', () => {
    expect(
      buildAssemblyComposedFeatures({
        rendererAssembly: assembly,
        assemblyDetailByChrom: new Map(),
        visibleTypes: new Set(['mRNA']),
      })
    ).toBeNull();
  });

  it('builds an empty assembly scene shell without fabricating feature payloads', () => {
    const scene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: null,
      payload: null,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 0,
    });

    expect(scene).not.toBeNull();
    expect(scene!.length).toBe(3_000);
    expect(scene!.tileSlots).toEqual([]);
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene!)).toBe(false);
    expect(evaluateIndexedGenomeSceneInvariants(scene!).ok).toBe(true);
  });

  it('threads the prepacked annotation source identity into the renderer Genome', () => {
    const sourceIdentity = 'assembly-annotation-source.v1\ngrch38-test\nfingerprint-a';
    const scene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      sourceIdentity,
      features: [feature({ id: 101, type: 'mRNA' })],
      payload: null,
      annotationLayerTypes: ['mRNA'],
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 0,
    });
    expect(scene?.sourceFingerprint).toBe(sourceIdentity);
    expect(indexedGenomeSceneToRendererGenome(scene!).sourceIdentity).toBe(sourceIdentity);
  });

  it('reserves the full finite annotation lane cap before detail and keeps it for sparse and dense detail', () => {
    const emptyScene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: null,
      payload: null,
      annotationLayerTypes: ['mRNA'],
      laneLimit: 12,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 0,
    });
    const detailPayload = (lane: number): GenomeAnnotationGlyphPayload => ({
      type: 'annotation-glyphs',
      featureModel: 'resolved-transcript-v2',
      glyphs: [
        {
          id: 'tx-16',
          type: 'mRNA',
          label: 'TX16',
          startBp: 0,
          endBp: 100,
          strand: '+',
          lane,
          color: 0x44aa88,
          transcriptId: 'tx-16',
          exons: [{ start: 0, end: 100 }],
        },
      ],
      droppedCount: 0,
      typeFilteredCount: 1,
    });
    const sparseFeature = feature({ id: 16, type: 'mRNA', lane: 0 });
    const sparseScene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: [sparseFeature],
      payload: detailPayload(0),
      annotationLayerTypes: ['mRNA'],
      laneLimit: 12,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 1,
    });
    const laneElevenFeature = feature({ id: 16, type: 'mRNA', lane: 11 });
    const denseScene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: [laneElevenFeature],
      payload: detailPayload(11),
      annotationLayerTypes: ['mRNA'],
      laneLimit: 12,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 2,
    });
    const prebuiltScene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: null,
      payload: null,
      annotationLayerTypes: ['mRNA'],
      laneLimit: 12,
      prebuiltOverviewTextureManifest: prebuiltManifest({
        maxAnnotationLane: 17,
        maxCdsLane: 2,
      }),
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 3,
    });

    const emptyGenome = indexedGenomeSceneToRendererGenome(emptyScene!);
    const sparseGenome = indexedGenomeSceneToRendererGenome(sparseScene!);
    const denseGenome = indexedGenomeSceneToRendererGenome(denseScene!);
    const prebuiltGenome = indexedGenomeSceneToRendererGenome(prebuiltScene!);

    expect(emptyGenome.features).toEqual([]);
    expect(emptyGenome.annotationLayout).toEqual({ maxAnnotationLane: 11, maxCdsLane: -1 });
    expect(sparseGenome.annotationLayout).toEqual(emptyGenome.annotationLayout);
    expect(denseGenome.annotationLayout).toEqual(emptyGenome.annotationLayout);
    expect(prebuiltGenome.annotationLayout).toEqual(emptyGenome.annotationLayout);
    expect(emptyGenome.annotationLayerTypes).toEqual(['mRNA']);
  });

  it('makes the finite lane cap authoritative over realized prebuilt lanes and changes height only when the cap changes', () => {
    const build = (laneLimit: 12 | 8) =>
      indexedGenomeSceneToRendererGenome(
        buildAssemblyAnnotationScene({
          rendererAssembly: assembly,
          features: null,
          payload: null,
          annotationLayerTypes: ['mRNA'],
          laneLimit,
          prebuiltOverviewTextureManifest: prebuiltManifest({ maxAnnotationLane: 17 }),
          viewportRange: { start: 0, end: 3_000 },
          viewportWidthPx: 800,
          viewportHeightPx: 480,
          generation: 0,
        })!
      );

    expect(build(12).annotationLayout).toEqual({ maxAnnotationLane: 11, maxCdsLane: -1 });
    expect(build(8).annotationLayout).toEqual({ maxAnnotationLane: 7, maxCdsLane: -1 });
  });

  it('re-lanes an uncapped multi-type overview under the finite mapper policy without annotation loss', () => {
    const rawFeatures: GenomeFeature[] = ['gene', 'mRNA'].flatMap((type) =>
      Array.from({ length: 12 }, (_, index) => ({
        chrom: 'chr1',
        source: 'test',
        type,
        start: 0,
        end: 100,
        score: null,
        strand: '+' as const,
        phase: null,
        attributes: { ID: [`${type}-${index}`] },
        raw: '',
      }))
    );
    const uncappedOverview = applyDensityControls(
      rawFeatures,
      'chr1',
      1_000,
      new Set(['gene', 'mRNA']),
      null,
      { groupByType: true, typeOrder: ['gene', 'mRNA'] }
    );
    expect(
      uncappedOverview.features
        .filter((entry) => entry.type === 'mRNA')
        .map((entry) => entry.lane)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 13));
    const finiteTwoType = applyAssemblyRendererLaneControls({
      features: uncappedOverview.features,
      length: 1_000,
      visibleTypes: new Set(['gene', 'mRNA']),
      laneLimit: 12,
      typeOrder: ['gene', 'mRNA'],
    });
    expect(finiteTwoType.droppedCount).toBe(0);
    expect(finiteTwoType.features).toHaveLength(24);
    expect(Math.max(...finiteTwoType.features.map((entry) => entry.lane))).toBe(24);
    expect(
      buildAssemblyAnnotationScene({
        rendererAssembly: assembly,
        features: finiteTwoType.features,
        payload: null,
        annotationLayerTypes: ['gene', 'mRNA'],
        laneLimit: 12,
        viewportRange: { start: 0, end: 3_000 },
        viewportWidthPx: 800,
        viewportHeightPx: 480,
        generation: 0,
      })?.annotationLayout
    ).toEqual({ maxAnnotationLane: 24, maxCdsLane: -1 });

    const density = applyAssemblyRendererLaneControls({
      features: uncappedOverview.features,
      length: 1_000,
      visibleTypes: new Set(['mRNA']),
      laneLimit: 12,
      typeOrder: ['gene', 'mRNA'],
    });
    const detail = applyDensityControls(rawFeatures, 'chr1', 1_000, new Set(['mRNA']), 12, {
      groupByType: true,
      typeOrder: ['gene', 'mRNA'],
    });
    const normalizedDetail = applyAssemblyRendererLaneControls({
      features: detail.features,
      length: 1_000,
      visibleTypes: new Set(['mRNA']),
      laneLimit: 12,
      typeOrder: ['gene', 'mRNA'],
    });
    const payload: GenomeAnnotationGlyphPayload = {
      type: 'annotation-glyphs',
      featureModel: 'resolved-transcript-v2',
      ...annotationGlyphPayloadFromRendererFeatures(density),
    };
    const scene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: density.features,
      payload,
      annotationLayerTypes: ['mRNA'],
      laneLimit: 12,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 0,
    });

    expect(density.droppedCount).toBe(0);
    expect(density.features).toHaveLength(12);
    expect(density.features.map((entry) => entry.lane).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index)
    );
    expect(
      density.features.map((entry) => Number(entry.qualifiers?._lane)).sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(density.features.map((entry) => [entry.qualifiers?.ID, entry.lane])).toEqual(
      normalizedDetail.features.map((entry) => [entry.qualifiers?.ID, entry.lane])
    );
    expect(scene?.annotationLayout).toEqual({ maxAnnotationLane: 11, maxCdsLane: -1 });
    const genome = indexedGenomeSceneToRendererGenome(scene!);
    expect(genome.features).toHaveLength(12);
    expect(Math.max(...genome.features.map((entry) => entry.lane))).toBe(11);
  });

  it('keeps the mRNA band origin fixed across empty sparse and saturated preceding tracks', () => {
    const feature = (id: number, type: string, start = 0, end = 100): Feature => ({
      id,
      type,
      start,
      end,
      direction: 'forward',
      displayName: `${type}-${id}`,
      color: 0x123456,
      lane: 0,
      qualifiers: { ID: `${type}-${id}`, _lane: '0' },
    });
    const mRna = feature(100, 'mRNA');
    const apply = (features: ReadonlyArray<Feature>) =>
      applyAssemblyRendererLaneControls({
        features,
        length: 1_000,
        visibleTypes: new Set(['gene', 'mRNA']),
        laneLimit: 12,
        typeOrder: ['gene', 'mRNA'],
      });

    const empty = apply([mRna]);
    const sparse = apply([feature(1, 'gene'), mRna]);
    const saturated = apply([
      ...Array.from({ length: 12 }, (_, index) => feature(index, 'gene')),
      mRna,
    ]);

    for (const result of [empty, sparse, saturated]) {
      const mapped = result.features.find((entry) => entry.type === 'mRNA');
      expect(mapped?.lane).toBe(13);
      expect(mapped?.annotationTrackLane).toBe(0);
      expect(mapped?.qualifiers?._lane).toBe('13');
    }
  });

  it('preserves promoted logical track identity through renderer conversion and assembly re-laning', () => {
    const promoted: GenomeFeature = {
      chrom: 'chr1',
      source: 'test',
      type: 'ncRNA',
      start: 100,
      end: 500,
      score: null,
      strand: '+',
      phase: null,
      attributes: { ID: ['rna-a'], ncRNA_class: ['lncRNA'] },
      raw: '',
    };
    const converted = applyDensityControls([promoted], 'chr1', 1_000, new Set(['lncRNA']), 12, {
      groupByType: true,
      typeOrder: ['lncRNA'],
    });
    const rendererFeature = converted.features[0] as Feature & { annotationTrackId?: string };
    expect(rendererFeature.type).toBe('ncRNA');
    expect(rendererFeature.annotationTrackId).toBe('lncRNA');
    expect(rendererFeature.annotationTrackLane).toBe(0);

    const relaned = applyAssemblyRendererLaneControls({
      features: converted.features,
      length: 1_000,
      visibleTypes: new Set(['lncRNA']),
      laneLimit: 12,
      typeOrder: ['lncRNA'],
    });
    expect(relaned.features).toHaveLength(1);
    expect(
      (relaned.features[0] as Feature & { annotationTrackId?: string }).annotationTrackId
    ).toBe('lncRNA');
  });

  it('keys layout ownership by cap, logical layer signature, and policy-derived layout', () => {
    const key = (
      overrides: {
        laneLimit?: number | null;
        requestedLayerTypes?: string[];
        maxAnnotationLane?: number;
      } = {}
    ) =>
      assemblyAnnotationLayoutOwnershipKey({
        laneLimit: overrides.laneLimit ?? 12,
        requestedLayerTypes: overrides.requestedLayerTypes ?? ['mRNA'],
        realizedLayout: {
          maxAnnotationLane: overrides.maxAnnotationLane ?? 11,
          maxCdsLane: -1,
        },
      });

    expect(key()).toBe(key());
    expect(key()).not.toBe(key({ laneLimit: 8, maxAnnotationLane: 7 }));
    expect(key()).not.toBe(key({ requestedLayerTypes: ['gene', 'mRNA'], maxAnnotationLane: 24 }));
    expect(key({ requestedLayerTypes: ['gene', 'mRNA'], maxAnnotationLane: 24 })).not.toBe(
      key({ requestedLayerTypes: ['mRNA', 'gene'], maxAnnotationLane: 24 })
    );
    expect(key()).not.toBe(key({ maxAnnotationLane: 17 }));
    expect(
      assemblyAnnotationLayoutOwnershipKey({
        laneLimit: null,
        requestedLayerTypes: ['mRNA'],
        realizedLayout: { maxAnnotationLane: 4, maxCdsLane: 2 },
      })
    ).not.toBe(
      assemblyAnnotationLayoutOwnershipKey({
        laneLimit: null,
        requestedLayerTypes: ['mRNA'],
        realizedLayout: { maxAnnotationLane: 17, maxCdsLane: 2 },
      })
    );
  });

  it('keeps All mode data-derived for empty, sparse, and prebuilt requested pools', () => {
    const empty = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: null,
      payload: null,
      annotationLayerTypes: ['mRNA'],
      laneLimit: null,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 0,
    });
    const sparse = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: [feature({ id: 20, type: 'mRNA', lane: 3 })],
      payload: null,
      annotationLayerTypes: ['mRNA'],
      laneLimit: null,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 1,
    });
    const prebuilt = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: null,
      payload: null,
      annotationLayerTypes: ['mRNA'],
      laneLimit: null,
      prebuiltOverviewTextureManifest: prebuiltManifest(),
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 2,
    });

    expect(empty?.annotationLayout).toBeUndefined();
    expect(sparse?.annotationLayout).toEqual({ maxAnnotationLane: 3, maxCdsLane: -1 });
    expect(prebuilt?.annotationLayout).toEqual({ maxAnnotationLane: 4, maxCdsLane: -1 });
  });

  it('leaves finite contracts containing CDS data-derived until the per-track compositor owns lane starts', () => {
    const empty = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: null,
      payload: null,
      annotationLayerTypes: ['mRNA', 'CDS'],
      laneLimit: 12,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 0,
    });
    const realized = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: [
        feature({ id: 21, type: 'mRNA', lane: 2 }),
        feature({ id: 22, type: 'CDS', lane: 13 }),
      ],
      payload: null,
      annotationLayerTypes: ['mRNA', 'CDS'],
      laneLimit: 12,
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 1,
    });

    expect(empty?.annotationLayout).toBeUndefined();
    expect(realized?.annotationLayout).toEqual({ maxAnnotationLane: 2, maxCdsLane: 13 });
  });

  it('carries prebuilt overview annotation layout without fabricating feature payloads', () => {
    const scene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: null,
      payload: null,
      laneLimit: null,
      prebuiltOverviewTextureManifest: prebuiltManifest(),
      viewportRange: { start: 0, end: 3_000 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 0,
    });

    expect(scene).not.toBeNull();
    expect(scene!.tileSlots).toEqual([]);
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene!)).toBe(false);
    expect(evaluateIndexedGenomeSceneInvariants(scene!).ok).toBe(true);

    const genome = indexedGenomeSceneToRendererGenome(scene!);
    expect(genome.features).toEqual([]);
    expect(genome.annotationLayout).toEqual({ maxAnnotationLane: 4, maxCdsLane: 2 });
    expect(genome.annotationLayerTypes).toEqual(['CDS', 'gene', 'mRNA']);
  });

  it('routes assembly detail through a tile-native scene instead of a whole feature payload', () => {
    const detailFeature = feature({
      id: 9,
      type: 'mRNA',
      displayName: 'HBB-201',
      start: 1_050,
      end: 1_250,
      lane: 2,
      transcriptId: 'tx-hbb',
      exons: [
        { start: 1_050, end: 1_080 },
        { start: 1_200, end: 1_250 },
      ],
    });
    const payload: GenomeAnnotationGlyphPayload = {
      type: 'annotation-glyphs',
      featureModel: 'resolved-transcript-v2',
      glyphs: [
        {
          id: 'tx-hbb',
          type: 'mRNA',
          label: 'HBB-201',
          startBp: 1_050,
          endBp: 1_250,
          strand: '+',
          lane: 2,
          color: 0x44aa88,
          transcriptId: 'tx-hbb',
          exons: [
            { start: 1_050, end: 1_080 },
            { start: 1_200, end: 1_250 },
          ],
        },
      ],
      droppedCount: 0,
      typeFilteredCount: 1,
    };

    const scene = buildAssemblyAnnotationScene({
      rendererAssembly: assembly,
      features: [detailFeature],
      payload,
      viewportRange: { start: 1_000, end: 1_400 },
      viewportWidthPx: 800,
      viewportHeightPx: 480,
      generation: 7,
    });

    expect(scene).not.toBeNull();
    expect(scene!.mode).toBe('tile-native-session-shell');
    expect(indexedGenomeSceneHasWholeFeaturePayload(scene!)).toBe(false);
    expect(evaluateIndexedGenomeSceneInvariants(scene!).ok).toBe(true);
    expect(scene!.tileSlots).toHaveLength(1);
    expect(scene!.tileSlots[0]).toMatchObject({
      chrom: 'grch38-test',
      currentForViewport: true,
      fidelity: 'best_available',
      recordCount: 1,
    });

    const genome = indexedGenomeSceneToRendererGenome(scene!);
    expect(genome.features).toHaveLength(1);
    expect(genome.features[0]).toMatchObject({
      type: 'mRNA',
      start: 1_050,
      end: 1_250,
      lane: 2,
      transcriptId: 'tx-hbb',
    });
  });
});
