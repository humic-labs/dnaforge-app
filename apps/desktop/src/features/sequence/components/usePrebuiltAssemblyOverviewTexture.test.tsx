import { renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
  PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
  PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
  PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
  PREBUILT_ANNOTATION_RASTERIZER_V1,
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  TRANSCRIPT_PAGE_LANE_STEP_PX,
  prebuiltAnnotationRasterPresentationArtifactKeyV1,
  type PrebuiltAnnotationRasterLaneProjectionV1,
  type PrebuiltAnnotationRasterPresentationIdentityV1,
  type PrebuiltAnnotationRasterPresentationReceiptV1,
} from '@waypoint/genome-renderer/pure';

import type { AssemblyOverviewTexture } from './useAssemblyOverviewTexture';
import { usePrebuiltAssemblyOverviewTexture } from './usePrebuiltAssemblyOverviewTexture';

function overviewTexture(
  fingerprint = 'fixture-fingerprint',
  semanticReceipt?: unknown,
  laneProjection?: unknown
): AssemblyOverviewTexture {
  const manifest: AssemblyOverviewTexture['manifest'] & {
    semanticReceipt?: unknown;
    laneProjection?: unknown;
  } = {
    version: 1 as const,
    assemblyId: 'grch38',
    fingerprint,
    cacheContractToken: 'fixture-contract',
    sourceBuildFingerprint: 'fixture-build',
    placementSignature: 'fixture-placement',
    textureFile: 'fixture.png',
    widthPx: 16,
    heightPx: 8,
    resolution: 1,
    spineOffsetPx: 4,
    genomeLength: 3_088_286_401,
    maxAnnotationLane: 4,
    maxCdsLane: 1,
    layerTypes: ['mRNA', 'CDS'],
    ...(semanticReceipt ? { semanticReceipt } : undefined),
    ...(laneProjection ? { laneProjection } : undefined),
  };
  return {
    image: { width: 16, height: 8 } as ImageBitmap,
    manifest,
  };
}

function verifiedLaneProjection(
  laneLimit: number | null
): PrebuiltAnnotationRasterLaneProjectionV1 {
  const sourceHeightPx = 5 * TRANSCRIPT_PAGE_LANE_STEP_PX;
  const presentedHeightPx =
    laneLimit === null ? sourceHeightPx : laneLimit * TRANSCRIPT_PAGE_LANE_STEP_PX;
  return {
    contract: PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
    laneLimit,
    sourceHeightPx,
    sourceSpineOffsetPx: sourceHeightPx - 1,
    sourceMaxAnnotationLane: 4,
    presentedHeightPx,
    presentedSpineOffsetPx: presentedHeightPx - 1,
  };
}

function verifiedSemanticReceipt(
  isoformMode: 'canonical' | 'expanded'
): PrebuiltAnnotationRasterPresentationReceiptV1 {
  const identity: PrebuiltAnnotationRasterPresentationIdentityV1 = {
    contract: PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
    sourceValidationContract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
    genomeIdentity: 'grch38',
    genomeLengthBp: 3_088_286_401,
    sourceFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    placementFingerprint: 'ap1:bbbbbbbbbbbbbbbbbbbbbbbb',
    trackType: 'mRNA',
    isoformMode,
    laneLimit: null,
    layerTypes: ['CDS', 'mRNA'],
    maxAnnotationLane: 4,
    maxCdsLane: 1,
    themeMode: 'light',
    laneArtifactContract: PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneStepPx: TRANSCRIPT_PAGE_LANE_STEP_PX,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    rasterizerContractToken: PREBUILT_ANNOTATION_RASTERIZER_V1,
  };
  return {
    ...identity,
    artifactKey: prebuiltAnnotationRasterPresentationArtifactKeyV1(identity),
  };
}

function prebuiltRenderer() {
  return {
    loadPrebuiltGenomeWideTexture: vi.fn(),
    commitPrebuiltGenomeWideTexturePolicy: vi.fn(() => true),
    clearPrebuiltGenomeWideTexture: vi.fn(),
    isPrebuiltGenomeWideTextureLoaded: vi.fn(),
  };
}

function StrictModeHarness({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

describe('usePrebuiltAssemblyOverviewTexture renderer-lifecycle reconciliation', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => {
        throw new Error('prebuilt texture delivery must not poll animation frames');
      })
    );
    vi.spyOn(window, 'setInterval').mockImplementation(() => {
      throw new Error('prebuilt texture delivery must not install timers');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('admits one residency for the same renderer epoch and exact artifact identity', () => {
    const renderer = prebuiltRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const first = overviewTexture();
    const recordEvent = vi.fn();

    const { rerender } = renderHook(
      ({ texture, epoch }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: texture,
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: epoch,
          webglRef,
          recordEvent,
        }),
      { initialProps: { texture: first, epoch: 1 } }
    );

    rerender({ texture: overviewTexture(), epoch: 1 });
    rerender({ texture: overviewTexture(), epoch: 1 });

    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(1);
    expect(renderer.isPrebuiltGenomeWideTextureLoaded).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('reconciles exact semantic artifact keys when a receipt is available', () => {
    const renderer = prebuiltRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { rerender } = renderHook(
      ({ texture }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: texture,
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: 1,
          webglRef,
          recordEvent: vi.fn(),
        }),
      {
        initialProps: {
          texture: overviewTexture('same-fingerprint', verifiedSemanticReceipt('canonical')),
        },
      }
    );

    rerender({
      texture: overviewTexture('same-fingerprint', verifiedSemanticReceipt('canonical')),
    });
    const replacementReceipt = verifiedSemanticReceipt('expanded');
    rerender({ texture: overviewTexture('same-fingerprint', replacementReceipt) });

    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(2);
    expect(renderer.loadPrebuiltGenomeWideTexture.mock.calls[1]?.[1]).toMatchObject({
      semanticReceipt: { artifactKey: replacementReceipt.artifactKey },
    });
  });

  it('reloads the same immutable artifact when its exact finite-lane projection changes', () => {
    const renderer = prebuiltRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const receipt = verifiedSemanticReceipt('expanded');

    const { rerender } = renderHook(
      ({ laneLimit }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: overviewTexture(
            'same-source-artifact',
            receipt,
            verifiedLaneProjection(laneLimit)
          ),
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: 1,
          webglRef,
          recordEvent: vi.fn(),
        }),
      { initialProps: { laneLimit: 8 } }
    );

    rerender({ laneLimit: 8 });
    rerender({ laneLimit: 24 });
    rerender({ laneLimit: 24 });

    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(2);
    expect(renderer.loadPrebuiltGenomeWideTexture.mock.calls[1]?.[1]).toMatchObject({
      semanticReceipt: { artifactKey: receipt.artifactKey },
      laneProjection: { laneLimit: 24 },
    });
  });

  it('commits a pending finite-cap raster and policy through one renderer transaction', () => {
    const renderer = prebuiltRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const receipt = verifiedSemanticReceipt('expanded');
    const initial = overviewTexture('same-source-artifact', receipt, verifiedLaneProjection(8));
    const replacement = overviewTexture(
      'same-source-artifact',
      receipt,
      verifiedLaneProjection(24)
    );

    const { result, rerender } = renderHook(
      ({ texture, atomicRequest }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: texture,
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: 1,
          webglRef,
          recordEvent: vi.fn(),
          atomicRequest,
        }),
      {
        initialProps: {
          texture: initial,
          atomicRequest: null as {
            requestId: number;
            policy: {
              isoformMode: 'canonical' | 'expanded';
              laneLimit: number | null;
            };
          } | null,
        },
      }
    );
    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledOnce();

    rerender({
      texture: replacement,
      atomicRequest: {
        requestId: 1,
        policy: { isoformMode: 'expanded', laneLimit: 24 },
      },
    });

    expect(renderer.commitPrebuiltGenomeWideTexturePolicy).toHaveBeenCalledOnce();
    expect(renderer.commitPrebuiltGenomeWideTexturePolicy).toHaveBeenCalledWith(
      replacement.image,
      replacement.manifest,
      { isoformMode: 'expanded', laneLimit: 24 }
    );
    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({
      status: 'committed',
      requestId: 1,
      policy: { isoformMode: 'expanded', laneLimit: 24 },
    });
  });

  it('retries the same raster and policy after an error when the request identity advances', () => {
    const renderer = prebuiltRenderer();
    renderer.commitPrebuiltGenomeWideTexturePolicy
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const receipt = verifiedSemanticReceipt('expanded');
    const texture = overviewTexture('same-source-artifact', receipt, verifiedLaneProjection(24));
    const recordEvent = vi.fn();

    const { result, rerender } = renderHook(
      ({ requestId }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: texture,
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: 1,
          webglRef,
          recordEvent,
          atomicRequest: {
            requestId,
            policy: { isoformMode: 'expanded', laneLimit: 24 },
          },
        }),
      { initialProps: { requestId: 71 }, wrapper: StrictModeHarness }
    );

    expect(result.current).toMatchObject({ status: 'error', requestId: 71 });
    expect(renderer.commitPrebuiltGenomeWideTexturePolicy).toHaveBeenCalledOnce();
    rerender({ requestId: 71 });
    expect(renderer.commitPrebuiltGenomeWideTexturePolicy).toHaveBeenCalledOnce();

    rerender({ requestId: 72 });

    expect(result.current).toMatchObject({ status: 'committed', requestId: 72 });
    expect(renderer.commitPrebuiltGenomeWideTexturePolicy).toHaveBeenCalledTimes(2);
    rerender({ requestId: 72 });
    expect(renderer.commitPrebuiltGenomeWideTexturePolicy).toHaveBeenCalledTimes(2);
    expect(renderer.loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    expect(
      recordEvent.mock.calls.filter(([event]) => event === 'overview-texture-policy-commit-failed')
    ).toHaveLength(1);
    expect(
      recordEvent.mock.calls.filter(([event]) => event === 'overview-texture-policy-committed')
    ).toHaveLength(1);
  });

  it('never treats an unverified receipt artifact key as semantic proof', () => {
    const renderer = prebuiltRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { rerender } = renderHook(
      ({ artifactKey }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: overviewTexture('physical-fingerprint', { artifactKey }),
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: 1,
          webglRef,
          recordEvent: vi.fn(),
        }),
      { initialProps: { artifactKey: 'unverified-a' } }
    );

    rerender({ artifactKey: 'unverified-b' });

    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(1);
  });

  it('reloads exactly once when the physical artifact identity changes', () => {
    const renderer = prebuiltRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { rerender } = renderHook(
      ({ fingerprint }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: overviewTexture(fingerprint),
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: 1,
          webglRef,
          recordEvent: vi.fn(),
        }),
      { initialProps: { fingerprint: 'physical-a' } }
    );

    rerender({ fingerprint: 'physical-b' });
    rerender({ fingerprint: 'physical-b' });

    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(2);
  });

  it('loads once for a replacement renderer lifecycle and never reloads from a readiness probe', () => {
    const firstRenderer = prebuiltRenderer();
    const replacementRenderer = prebuiltRenderer();
    let activeRenderer = firstRenderer;
    const webglRef = { current: { getLinearRenderer: () => activeRenderer } };
    const texture = overviewTexture();

    const { rerender } = renderHook(
      ({ epoch }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: texture,
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: epoch,
          webglRef,
          recordEvent: vi.fn(),
        }),
      { initialProps: { epoch: 1 } }
    );

    activeRenderer = replacementRenderer;
    rerender({ epoch: 2 });
    rerender({ epoch: 2 });

    expect(firstRenderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(1);
    expect(replacementRenderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(1);
    expect(firstRenderer.isPrebuiltGenomeWideTextureLoaded).not.toHaveBeenCalled();
    expect(replacementRenderer.isPrebuiltGenomeWideTextureLoaded).not.toHaveBeenCalled();
  });

  it('cancels superseded not-yet-ready admissions instead of polling stale texture arrivals', () => {
    const renderer = prebuiltRenderer();
    let activeRenderer: ReturnType<typeof prebuiltRenderer> | null = null;
    const webglRef = { current: { getLinearRenderer: () => activeRenderer } };

    const { rerender } = renderHook(
      ({ texture, epoch }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: texture,
          overviewTextureStatus: 'loaded',
          rendererReadyEpoch: epoch,
          webglRef,
          recordEvent: vi.fn(),
        }),
      {
        initialProps: {
          texture: overviewTexture('superseded'),
          epoch: 0,
        },
      }
    );

    const current = overviewTexture('current');
    rerender({ texture: current, epoch: 0 });
    activeRenderer = renderer;
    rerender({ texture: current, epoch: 1 });

    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(1);
    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledWith(
      current.image,
      current.manifest
    );
  });

  it('clears once across a non-loaded status run and admits again only after that clear', () => {
    const renderer = prebuiltRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const texture = overviewTexture();
    const recordEvent = vi.fn();

    const { rerender } = renderHook(
      ({ status, value }) =>
        usePrebuiltAssemblyOverviewTexture({
          overviewTexture: value,
          overviewTextureStatus: status,
          rendererReadyEpoch: 1,
          webglRef,
          recordEvent,
        }),
      {
        initialProps: {
          status: 'loaded' as const,
          value: texture as AssemblyOverviewTexture | null,
        },
      }
    );

    rerender({ status: 'loading', value: null });
    rerender({ status: 'miss', value: null });
    rerender({ status: 'error', value: null });
    expect(renderer.clearPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(1);

    rerender({ status: 'loaded', value: texture });
    expect(renderer.loadPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(2);

    rerender({ status: 'not-applicable', value: null });
    expect(renderer.clearPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(2);
    expect(renderer.isPrebuiltGenomeWideTextureLoaded).not.toHaveBeenCalled();
    expect(recordEvent.mock.calls.map(([event]) => event)).toEqual([
      'overview-texture-loaded',
      'overview-texture-cleared',
      'overview-texture-loaded',
      'overview-texture-cleared',
    ]);
  });
});
