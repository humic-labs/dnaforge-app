// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderTexture, Texture, type Renderer } from 'pixi.js';
import {
  GenomeWideTextureCacheLayer,
  type GenomeWideTextureCompositeArgs,
  type PrebuiltGenomeWideTextureMeta,
} from './genome-wide-texture-cache-layer';
import {
  PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
  PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
  PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
  PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
  PREBUILT_ANNOTATION_RASTERIZER_V1,
  prebuiltAnnotationRasterPresentationArtifactKeyV1,
  type PrebuiltAnnotationRasterLaneProjectionV1,
  type PrebuiltAnnotationRasterPresentationIdentityV1,
} from './prebuilt-annotation-raster-contract';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_LANE_STEP_PX,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
} from './prepacked-annotation-scene';
import type { ViewerRenderContract } from './viewer-render-contract';

const META: PrebuiltGenomeWideTextureMeta = {
  widthPx: 16,
  heightPx: 8,
  resolution: 1,
  spineOffsetPx: 4,
  genomeLength: 1_000,
};

function image(width = 16, height = 8): ImageBitmap {
  return { width, height } as ImageBitmap;
}

function projectedMeta(
  overrides: Partial<PrebuiltGenomeWideTextureMeta> = {}
): PrebuiltGenomeWideTextureMeta {
  const identity: PrebuiltAnnotationRasterPresentationIdentityV1 = {
    contract: PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
    sourceValidationContract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
    genomeIdentity: 'grch38-source',
    genomeLengthBp: 1_000,
    sourceFingerprint: '0123456789abcdef01234567',
    placementFingerprint: 'ap1:0123456789abcdef01234567',
    trackType: 'mRNA',
    isoformMode: 'expanded',
    laneLimit: null,
    layerTypes: ['mRNA'],
    maxAnnotationLane: 1,
    maxCdsLane: -1,
    themeMode: 'light',
    laneArtifactContract: PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneStepPx: PREPACKED_ANNOTATION_LANE_STEP_PX,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    rasterizerContractToken: PREBUILT_ANNOTATION_RASTERIZER_V1,
  };
  const laneProjection: PrebuiltAnnotationRasterLaneProjectionV1 = {
    contract: PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
    laneLimit: 8,
    sourceHeightPx: 2 * PREPACKED_ANNOTATION_LANE_STEP_PX,
    sourceSpineOffsetPx: 2 * PREPACKED_ANNOTATION_LANE_STEP_PX - 1,
    sourceMaxAnnotationLane: 1,
    presentedHeightPx: 8 * PREPACKED_ANNOTATION_LANE_STEP_PX,
    presentedSpineOffsetPx: 8 * PREPACKED_ANNOTATION_LANE_STEP_PX - 1,
  };
  return {
    widthPx: 16,
    heightPx: laneProjection.presentedHeightPx,
    resolution: 1,
    spineOffsetPx: laneProjection.presentedSpineOffsetPx,
    genomeLength: 1_000,
    semanticReceipt: {
      artifactKey: prebuiltAnnotationRasterPresentationArtifactKeyV1(identity),
      ...identity,
    },
    laneProjection,
    ...overrides,
  };
}

function contract(): ViewerRenderContract {
  return {
    pixelsPerBp: 1,
    projectX: (bp: number) => bp,
    projectY: () => 0,
  };
}

function extractionArgs(): GenomeWideTextureCompositeArgs {
  const renderer = {
    resolution: 1,
    render: vi.fn(),
    extract: { base64: vi.fn().mockResolvedValue('data:image/png;base64,test') },
  } as unknown as Renderer;
  const source = {
    container: {},
    updateCamera: vi.fn(),
  };
  vi.spyOn(RenderTexture, 'create').mockReturnValue(Texture.EMPTY as unknown as RenderTexture);

  return {
    renderer,
    source: source as unknown as GenomeWideTextureCompositeArgs['source'],
    genomeLength: META.genomeLength,
    trackHeightPx: META.heightPx,
    spineOffsetPx: META.spineOffsetPx,
    liveContract: contract(),
  };
}

describe('GenomeWideTextureCacheLayer reset semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not expose a runtime render-to-texture presenter', () => {
    const layer = new GenomeWideTextureCacheLayer();

    expect('composite' in layer).toBe(false);
  });

  it('does not expose an unused per-chrom texture presenter', () => {
    const layer = new GenomeWideTextureCacheLayer();

    expect('loadPrebuiltPerChromTextures' in layer).toBe(false);
    expect('compositePerChrom' in layer).toBe(false);
    expect('prebuiltPerChromPresentingCount' in layer).toBe(false);
  });

  it('does not parent offline extraction render textures into the live scene', async () => {
    const layer = new GenomeWideTextureCacheLayer();
    const beforeChildren = layer.container.children.length;

    const extracted = await layer.buildAndExtractPng(extractionArgs());

    expect(extracted).not.toBeNull();
    expect(layer.container.children.length).toBe(beforeChildren);
    expect(layer.runtimeTexturePresenting).toBe(false);
    expect(layer.isPresenting).toBe(false);
  });

  it('keeps prebuilt residency inert across a data reset', () => {
    const layer = new GenomeWideTextureCacheLayer();

    layer.loadPrebuiltTexture(image(), META);

    expect(layer.hasPrebuilt()).toBe(true);

    layer.resetData();

    expect(layer.hasPrebuilt()).toBe(true);
    expect(layer.isPresenting).toBe(false);
  });

  it('disposes prebuilt residency only on explicit clear', () => {
    const layer = new GenomeWideTextureCacheLayer();
    layer.loadPrebuiltTexture(image(), META);

    layer.clearPrebuilt();

    expect(layer.hasPrebuilt()).toBe(false);
    expect(layer.isPresenting).toBe(false);
  });

  it('presents the whole-genome prebuilt texture as the only raster presenter', () => {
    const layer = new GenomeWideTextureCacheLayer();
    const liveContract = contract();

    layer.loadPrebuiltTexture(image(), META);

    expect(layer.compositePrebuilt(liveContract)).toBe(true);

    expect(layer.prebuiltTexturePresenting).toBe(true);
    expect(layer.isPresenting).toBe(true);
  });

  it('admits an exact persisted finite-lane projection without runtime cropping', () => {
    const layer = new GenomeWideTextureCacheLayer();
    const meta = projectedMeta();

    layer.loadPrebuiltTexture(image(16, 128), meta);

    expect(layer.hasPrebuilt()).toBe(true);
    expect(layer.prebuiltLaneProjection).toEqual(meta.laneProjection);
    expect(layer.prebuiltSemanticReceipt?.artifactKey).toBe(meta.semanticReceipt?.artifactKey);
  });

  it('keeps the active raster resident while a replacement is prepared, then swaps synchronously', () => {
    const layer = new GenomeWideTextureCacheLayer();
    const initialMeta = projectedMeta();
    const replacementMeta = projectedMeta({
      heightPx: 24 * PREPACKED_ANNOTATION_LANE_STEP_PX,
      spineOffsetPx: 24 * PREPACKED_ANNOTATION_LANE_STEP_PX - 1,
      laneProjection: {
        ...projectedMeta().laneProjection!,
        laneLimit: 24,
        presentedHeightPx: 24 * PREPACKED_ANNOTATION_LANE_STEP_PX,
        presentedSpineOffsetPx: 24 * PREPACKED_ANNOTATION_LANE_STEP_PX - 1,
      },
    });

    layer.loadPrebuiltTexture(image(16, initialMeta.heightPx), initialMeta);
    const prepared = layer.preparePrebuiltTexture(
      image(16, replacementMeta.heightPx),
      replacementMeta
    );

    expect(prepared).not.toBeNull();
    expect(layer.prebuiltLaneProjection?.laneLimit).toBe(8);
    expect(layer.hasPrebuilt()).toBe(true);

    expect(layer.activatePreparedPrebuiltTexture(prepared!)).toBe(true);
    expect(layer.prebuiltLaneProjection?.laneLimit).toBe(24);
    expect(layer.hasPrebuilt()).toBe(true);
  });

  it('rejects projected assets whose bitmap or source envelope is inconsistent', () => {
    const wrongBitmap = new GenomeWideTextureCacheLayer();
    wrongBitmap.loadPrebuiltTexture(image(16, 127), projectedMeta());
    expect(wrongBitmap.hasPrebuilt()).toBe(false);

    const wrongSourceEnvelope = new GenomeWideTextureCacheLayer();
    wrongSourceEnvelope.loadPrebuiltTexture(
      image(16, 128),
      projectedMeta({
        laneProjection: {
          ...projectedMeta().laneProjection!,
          sourceMaxAnnotationLane: 2,
          sourceHeightPx: 3 * PREPACKED_ANNOTATION_LANE_STEP_PX,
          sourceSpineOffsetPx: 3 * PREPACKED_ANNOTATION_LANE_STEP_PX - 1,
        },
      })
    );
    expect(wrongSourceEnvelope.hasPrebuilt()).toBe(false);
  });
});
