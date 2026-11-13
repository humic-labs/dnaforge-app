import { afterEach, describe, expect, it } from 'vitest';
import type { RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { RetainedOverlayCameraState } from './overlay-track';
import {
  buildAndExtractGenomeWideTexturePng,
  forceMeshOverview,
  prebuiltRasterEligibility,
  prebuiltRasterTexelsPerDevicePx,
  type PrebuiltRasterEligibilityHost,
} from './indexed-prebuilt-raster-eligibility';

type MeshOverviewGlobal = typeof globalThis & {
  __WAYPOINT_FORCE_MESH_OVERVIEW?: boolean;
};

afterEach(() => {
  delete (globalThis as MeshOverviewGlobal).__WAYPOINT_FORCE_MESH_OVERVIEW;
});

function camera(
  overrides: { pixelsPerBp?: number; viewStartBp?: number; viewEndBp?: number } = {}
): RetainedOverlayCameraState {
  const viewStartBp = overrides.viewStartBp ?? 0;
  const viewEndBp = overrides.viewEndBp ?? 1_000;
  return {
    path: {
      pixelsPerBp: overrides.pixelsPerBp ?? 1,
      viewStartBp,
      viewEndBp,
    } as PathMapper,
    state: { themeMode: 'light' } as RenderState,
    yOffset: 0,
    height: 200,
  };
}

function eligibilityHost(
  overrides: Partial<PrebuiltRasterEligibilityHost> = {}
): PrebuiltRasterEligibilityHost {
  const layer = {
    prebuiltWidthPx: 100,
    prebuiltResolution: 1,
    prebuiltSemanticReceipt: null,
    prebuiltLaneProjection: null,
    hasPrebuilt: () => false,
    buildAndExtractPng: async () => null,
  };
  const host: PrebuiltRasterEligibilityHost = {
    genomeLength: 1_000,
    genomeWideTextureCacheLayer: layer,
    pixiRenderer: { resolution: 1 },
    currentGenomeIdentity: 'g1',
    currentAnnotationSourceFingerprint: 'src',
    currentAnnotationPlacementFingerprint: 'place',
    prepackedAnnotationRuntimePolicy: null,
    maxAnnotationLane: 0,
    maxCdsLane: -1,
    lastGenomeWideContext: null,
    retainedLinearTranscriptBlockCount: 0,
    prebuiltRasterContractForLastFrame: {
      contractMatch: false,
      sourceMatch: false,
      placementMatch: false,
      artifactLayerTypes: [],
      artifactSourceFingerprint: null,
      artifactPlacementFingerprint: null,
    },
    annotationLayerTypesForPresentation: () => ['mRNA'],
    forceMeshOverview: () => false,
    prebuiltRasterTexelsPerDevicePx(nextCamera) {
      return prebuiltRasterTexelsPerDevicePx(host, nextCamera);
    },
    buildGenomeWideCompositeArgs: () => ({ ok: true }),
    ensureGenomeWideTextureCacheLayer: () => layer,
    ...overrides,
  };
  return host;
}

describe('indexed prebuilt raster eligibility', () => {
  it('stores the last contract and reports unavailable when no raster is loaded', () => {
    const host = eligibilityHost();
    const result = prebuiltRasterEligibility(host, camera());
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(host.prebuiltRasterContractForLastFrame.contractMatch).toBe(false);
    expect(host.prebuiltRasterContractForLastFrame.artifactLayerTypes).toEqual([]);
  });

  it('returns infinite texels when the artifact has no width and refuses PNG extract without a mesh', async () => {
    expect(forceMeshOverview()).toBe(false);
    (globalThis as MeshOverviewGlobal).__WAYPOINT_FORCE_MESH_OVERVIEW = true;
    expect(forceMeshOverview()).toBe(true);

    const noWidth = eligibilityHost({
      genomeWideTextureCacheLayer: {
        prebuiltWidthPx: 0,
        hasPrebuilt: () => true,
        buildAndExtractPng: async () => null,
      } as PrebuiltRasterEligibilityHost['genomeWideTextureCacheLayer'],
    });
    expect(prebuiltRasterTexelsPerDevicePx(noWidth, camera())).toBe(Number.POSITIVE_INFINITY);

    const notReady = eligibilityHost({
      lastGenomeWideContext: null,
      retainedLinearTranscriptBlockCount: 0,
    });
    await expect(buildAndExtractGenomeWideTexturePng(notReady)).resolves.toBeNull();

    const extracted = eligibilityHost({
      lastGenomeWideContext: {
        path: camera().path,
        state: camera().state,
      },
      retainedLinearTranscriptBlockCount: 4,
      maxAnnotationLane: 2,
      maxCdsLane: 1,
      ensureGenomeWideTextureCacheLayer: () => ({
        hasPrebuilt: () => true,
        buildAndExtractPng: async () => ({
          dataUrl: 'data:image/png;base64,xx',
          widthPx: 64,
          heightPx: 8,
          resolution: 1,
          spineOffsetPx: 0,
          genomeLength: 1_000,
        }),
      }),
    });
    await expect(buildAndExtractGenomeWideTexturePng(extracted)).resolves.toEqual({
      dataUrl: 'data:image/png;base64,xx',
      widthPx: 64,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 0,
      genomeLength: 1_000,
      maxAnnotationLane: 2,
      maxCdsLane: 1,
      layerTypes: ['mRNA'],
    });
  });
});
