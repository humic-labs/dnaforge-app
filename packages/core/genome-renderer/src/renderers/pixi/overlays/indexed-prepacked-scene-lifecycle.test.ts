import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RendererType } from 'pixi.js';
import { PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP } from '../overview/partitioned-instanced-transcript-layer';
import {
  admitPrepackedAnnotationViewportDetailRoster,
  buildAndLoadPrepackedAnnotationScene,
  preparePrepackedAnnotationFineViews,
  type PrepackedSceneLifecycleHost,
  type PrepackedSceneLifecycleResident,
} from './indexed-prepacked-scene-lifecycle';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function resident(
  overrides: Partial<PrepackedSceneLifecycleResident> = {}
): PrepackedSceneLifecycleResident {
  return {
    ownerKey: 'mrna',
    lastUsed: 1,
    policyGeneration: 1,
    viewportDetailPresentationAdmitted: false,
    metadata: { trackType: 'mRNA', themeMode: 'light' },
    input: {
      viewportDetail: { coverageStartBp: 0, coverageEndBp: 1000 },
    },
    layer: {
      isGpuPrepared: true,
      isCoarseFallbackPrepared: true,
      areFineViewsPrewarmed: () => true,
      prepareGpuResources() {},
      prewarmFineViews() {},
      prepareNextCoarseFallbackView() {},
    },
    ...overrides,
  };
}

function host(overrides: Partial<PrepackedSceneLifecycleHost> = {}): PrepackedSceneLifecycleHost {
  const next = resident();
  return {
    genomeLength: 10_000,
    currentGenomeIdentity: 'assembly-1',
    prepackedAnnotationPolicyGeneration: 1,
    prepackedAnnotationSceneGpuPreparations: 0,
    prepackedAnnotationSceneStartupBuilds: 0,
    prepackedAnnotationSceneStatus: 'not-loaded',
    prepackedAnnotationSceneOwnerKey: null,
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationSceneInput: null,
    prepackedAnnotationSceneResidents: new Map([[next.ownerKey, next]]),
    prepackedAnnotationSceneReplacementCandidates: new Map(),
    features: [],
    _layout: {},
    _contract: {},
    pixiRenderer: { type: RendererType.WEBGL },
    annotationLayerTypesForPresentation: () => ['mRNA'],
    scaledBarHeight: () => 10,
    loadPrepackedAnnotationScene: () => false,
    ...overrides,
  };
}

describe('indexed prepacked scene lifecycle presenter', () => {
  it('keeps prepare/admit/build-and-load out of the overlay class', () => {
    const source = overlaySource();
    expect(source).toContain('preparePrepackedAnnotationFineViewsFn(');
    expect(source).toContain('admitPrepackedAnnotationViewportDetailRosterFn(');
    expect(source).toContain('buildAndLoadPrepackedAnnotationSceneFn(');
    expect(source).not.toContain('nextPrepackedFinePreparationAction(');
    expect(source).not.toContain('selectAdmissiblePrepackedViewportDetailRoster(');
    expect(source).not.toContain('compilePrepackedAnnotationScene(');
    expect(source).not.toContain('createPrepackedSceneLifecycleHost');
    expect(source).toContain('this.prepacked,');
  });

  it('reports outside-prewarm-corridor for an oversized viewport', () => {
    expect(
      preparePrepackedAnnotationFineViews(
        host({ genomeLength: PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP * 4 }),
        0,
        PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP + 1,
        'light'
      )
    ).toEqual({
      status: 'outside-prewarm-corridor',
      preparedOwnerKey: null,
      pendingOwnerCount: 0,
    });
  });

  it('reports waiting-residents when the selected roster is incomplete', () => {
    expect(
      preparePrepackedAnnotationFineViews(
        host({
          annotationLayerTypesForPresentation: () => ['mRNA', 'gene'],
        }),
        0,
        500,
        'light'
      )
    ).toEqual({
      status: 'waiting-residents',
      preparedOwnerKey: null,
      pendingOwnerCount: 0,
    });
  });

  it('prepares GPU for a selected resident and counts the preparation', () => {
    const next = resident({
      layer: {
        isGpuPrepared: false,
        isCoarseFallbackPrepared: false,
        areFineViewsPrewarmed: () => false,
        prepareGpuResources() {
          this.isGpuPrepared = true;
        },
        prewarmFineViews() {},
        prepareNextCoarseFallbackView() {},
      },
    });
    const lifecycle = host({
      prepackedAnnotationSceneResidents: new Map([[next.ownerKey, next]]),
    });
    expect(preparePrepackedAnnotationFineViews(lifecycle, 0, 500, 'light')).toMatchObject({
      status: 'prepared',
      preparedOwnerKey: 'mrna',
    });
    expect(lifecycle.prepackedAnnotationSceneGpuPreparations).toBe(1);
    expect(next.layer.isGpuPrepared).toBe(true);
  });

  it.each(['fine', 'coarse'] as const)(
    'keeps expired %s work pending and forwards the next slice deadline',
    (kind) => {
      let finePrepared = kind === 'coarse';
      const prewarmFineViews = vi.fn(() => {
        finePrepared = true;
      });
      const prepareNextCoarseFallbackView = vi.fn(() => {
        next.layer.isCoarseFallbackPrepared = true;
      });
      const next = resident({
        layer: {
          isGpuPrepared: true,
          isCoarseFallbackPrepared: kind === 'fine',
          areFineViewsPrewarmed: () => finePrepared,
          prepareGpuResources: vi.fn(),
          prewarmFineViews,
          prepareNextCoarseFallbackView,
        },
      });
      const lifecycle = host({
        prepackedAnnotationSceneResidents: new Map([[next.ownerKey, next]]),
      });
      const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
      try {
        expect(preparePrepackedAnnotationFineViews(lifecycle, 0, 500, 'light', 9)).toEqual({
          status: 'prepared',
          preparedOwnerKey: null,
          pendingOwnerCount: 1,
        });
        expect(prewarmFineViews).not.toHaveBeenCalled();
        expect(prepareNextCoarseFallbackView).not.toHaveBeenCalled();
        expect(next.viewportDetailPresentationAdmitted).toBe(false);
        expect(preparePrepackedAnnotationFineViews(lifecycle, 0, 500, 'light', 20)).toEqual({
          status: 'complete',
          preparedOwnerKey: 'mrna',
          pendingOwnerCount: 0,
        });
        if (kind === 'fine') {
          expect(prewarmFineViews).toHaveBeenCalledExactlyOnceWith(
            0,
            500,
            lifecycle.pixiRenderer,
            undefined,
            20
          );
        } else {
          expect(prepareNextCoarseFallbackView).toHaveBeenCalledExactlyOnceWith(
            lifecycle.pixiRenderer,
            20
          );
        }
        expect(next.viewportDetailPresentationAdmitted).toBe(false);
      } finally {
        clock.mockRestore();
      }
    }
  );

  it('admits a complete viewport-detail roster', () => {
    const next = resident();
    const lifecycle = host({
      prepackedAnnotationSceneResidents: new Map([[next.ownerKey, next]]),
    });
    expect(admitPrepackedAnnotationViewportDetailRoster(lifecycle, 10, 40, 'light')).toBe(true);
    expect(next.viewportDetailPresentationAdmitted).toBe(true);
  });

  it('rejects mixed-layer and unsupported-renderer build-and-load', () => {
    const mixed = host({
      annotationLayerTypesForPresentation: () => ['mRNA', 'gene'],
    });
    const options = {
      ownerKey: 'mrna',
      trackType: 'mRNA',
      themeMode: 'light' as const,
      annotationBarHeightPx: 10,
      partitionSpanBp: 100_000_000,
      artifactKey: 'unused',
      laneAlgorithmToken: 'source-lanes.v1' as const,
      mapperContractToken: 'annotation-isoform-mapper.v2' as const,
      geometryContractToken:
        'retained-linear-directional-block.track-local.theme-final.v3' as const,
      interactionContractToken: 'annotation-feature-hit-index.v3' as const,
    };
    expect(buildAndLoadPrepackedAnnotationScene(mixed, options)).toBeNull();
    expect(mixed.prepackedAnnotationSceneStatus).toBe('mixed-layer-fallback');

    const canvas = host({ pixiRenderer: { type: 0 } });
    expect(buildAndLoadPrepackedAnnotationScene(canvas, options)).toBeNull();
    expect(canvas.prepackedAnnotationSceneStatus).toBe('unsupported-renderer');
  });
});
