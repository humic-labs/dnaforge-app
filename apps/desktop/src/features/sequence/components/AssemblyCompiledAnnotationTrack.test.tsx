// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssemblyAnnotationSceneSourceRequest } from '../../../shared/indexed-genome';
import {
  AssemblyCompiledAnnotationTrack,
  type CompiledBroadTrackReadinessReceipt,
} from './AssemblyCompiledAnnotationTrack';
import type { AssemblyPrepackedAnnotationSceneCacheState } from './useAssemblyPrepackedAnnotationSceneCache';

const { mockUseCache, mockUseRaster, mockUseCompact, mockUseViewport, mockUsePrepackedScene } =
  vi.hoisted(() => ({
    mockUseCache: vi.fn(),
    mockUseRaster: vi.fn(),
    mockUseCompact: vi.fn(),
    mockUseViewport: vi.fn(),
    mockUsePrepackedScene: vi.fn(),
  }));

vi.mock('./useAssemblyPrepackedAnnotationSceneCache', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./useAssemblyPrepackedAnnotationSceneCache')>();
  return {
    ...actual,
    useAssemblyPrepackedAnnotationSceneCache: mockUseCache,
  };
});

vi.mock('./useAssemblyCompiledBroadRasterSurface', () => ({
  useAssemblyCompiledBroadRasterSurface: mockUseRaster,
}));

vi.mock('./useAssemblyCompiledBroadInteraction', () => ({
  useAssemblyCompiledBroadInteraction: mockUseCompact,
}));

vi.mock('./useAssemblyAnnotationViewportDetail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useAssemblyAnnotationViewportDetail')>();
  return {
    ...actual,
    useAssemblyAnnotationViewportDetail: mockUseViewport,
  };
});

vi.mock('./usePrepackedAssemblyAnnotationScene', () => ({
  usePrepackedAssemblyAnnotationScene: mockUsePrepackedScene,
}));

const SOURCE_REQUEST: AssemblyAnnotationSceneSourceRequest = {
  assemblyId: 'grch38',
  workspaceRoot: '/workspace',
  chromosomes: [{ chrom: 'chr1', length: 1_000, sourcePath: '/workspace/chr1.gff' }],
  scope: {
    kind: 'complete-assembly',
    placements: [{ chrom: 'chr1', length: 1_000, annotationCoverage: 'sourced' }],
  },
};

const DERIVED_SURFACE_CACHE = {
  status: 'loading',
  descriptor: {
    artifact: { trackType: 'gene', artifactKey: 'derived-surface' },
    sourceIdentity: 'derived-source',
  },
  result: null,
  error: null,
  lifecycle: { origin: 'pending', initialProbe: 'pending', completedAt: null },
} as AssemblyPrepackedAnnotationSceneCacheState;

const DERIVED_INTERACTION_CACHE = {
  status: 'miss',
  descriptor: {
    artifact: { trackType: 'gene', artifactKey: 'derived-interaction' },
    sourceIdentity: 'derived-source',
  },
  result: null,
  error: null,
  lifecycle: { origin: 'miss', initialProbe: 'miss', completedAt: 8 },
} as AssemblyPrepackedAnnotationSceneCacheState;

const rasterNotify = vi.fn();
const viewportNotify = vi.fn();
const refreshPolicy = vi.fn();
const getDiagnostics = vi.fn(() => null);

function seedCache(trackType: string): AssemblyPrepackedAnnotationSceneCacheState {
  return {
    status: 'hit',
    descriptor: {
      artifact: { trackType, artifactKey: 'seed-artifact' },
      sourceIdentity: 'seed-source',
      runtimeCacheKey: 'seed-runtime',
    },
    result: {
      fingerprint: '1'.repeat(24),
      payload: new Uint8Array([1, 2, 3, 4]),
      manifest: { integrity: { payloadSha256: '2'.repeat(64) } },
      artifact: { artifactKey: 'seed-artifact' },
    },
    error: null,
    lifecycle: { origin: 'durable-hit', initialProbe: 'hit', completedAt: 11 },
  } as AssemblyPrepackedAnnotationSceneCacheState;
}

function idleReceipt(ownerReadinessScopeKey: string): CompiledBroadTrackReadinessReceipt {
  return {
    readiness: 'idle',
    targetIdentityKey: null,
    readinessTargetIdentityKey: null,
    readinessRendererMatchesCurrent: false,
    validatedSourceFingerprint: null,
    interactionReadiness: 'not-applicable',
    interactionOwnerKey: null,
    ownerReadinessScopeKey,
    interactionCacheStatus: 'not-applicable',
    interactionCacheOrigin: null,
    interactionCacheInitialProbe: null,
    interactionCacheCompletedAt: null,
    interactionSourceIdentity: null,
    interactionArtifactKey: null,
    interactionPayloadBytes: null,
    compactInteractionStatus: 'not-applicable',
    compactInteractionOwnerKey: null,
    compactInteractionStartedAt: null,
    compactInteractionReadCompletedAt: null,
    compactInteractionPreparedAt: null,
    compactInteractionCompletedAt: null,
    compactInteractionAuthorityKind: null,
    compactInteractionOrigin: null,
    compactInteractionPayloadBytes: null,
    compactInteractionAuthorityPresent: false,
    compactInteractionGenomeLengthBp: null,
    compactInteractionError: null,
    viewportDetailStatus: 'not-applicable',
    viewportDetailCoverageStartBp: null,
    viewportDetailCoverageEndBp: null,
    viewportDetailPayloadBytes: null,
    viewportDetailError: null,
  };
}

function renderTrack(
  overrides: Partial<Parameters<typeof AssemblyCompiledAnnotationTrack>[0]> &
    Record<string, unknown> = {}
) {
  const onReadinessChanged = vi.fn();
  const onPolicyUnavailable = vi.fn();
  const registerCameraNotifier = vi.fn(() => () => undefined);
  const props = {
    trackType: 'mRNA',
    selected: true,
    seedCache: seedCache('mRNA'),
    assetGeneration: null,
    productPublicationReady: true,
    sourceRequest: SOURCE_REQUEST,
    interactionPayloadEnabled: true,
    interactionPreparationGeneration: 0,
    themeMode: 'light' as const,
    assemblyRequirement: { identityKey: 'indexed-full-assembly:grch38', genomeLengthBp: 1_000 },
    surfacePolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
    interactionPolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
    policyRequestId: 7,
    rendererReadyEpoch: 1,
    rendererGenomeCommitEpoch: 1,
    rendererAdmissionEpoch: 1,
    webglRef: { current: null },
    recordEvent: vi.fn(),
    registerCameraNotifier,
    registerPolicyRefresher: vi.fn(() => () => undefined),
    registerDiagnostics: vi.fn(() => () => undefined),
    overviewFeaturesComplete: true,
    onPolicyCommitted: vi.fn(),
    onPolicyUnavailable,
    onReadinessChanged,
    onDetailRendererAdmission: vi.fn(),
    readinessGeneration: 'gen-1',
    ownerReadinessScopeKey: 'scope-1',
    viewportCssWidthPx: 800,
    ...overrides,
  };
  render(<AssemblyCompiledAnnotationTrack {...props} />);
  return { ...props, onReadinessChanged, onPolicyUnavailable, registerCameraNotifier };
}

describe('AssemblyCompiledAnnotationTrack', () => {
  beforeEach(() => {
    mockUseCache.mockReset();
    mockUseRaster.mockReset();
    mockUseCompact.mockReset();
    mockUseViewport.mockReset();
    mockUsePrepackedScene.mockReset();
    rasterNotify.mockReset();
    viewportNotify.mockReset();
    refreshPolicy.mockReset();
    getDiagnostics.mockReset();
    mockUseCache.mockImplementation((input: { prepareProductOnly?: boolean }) =>
      input.prepareProductOnly ? DERIVED_SURFACE_CACHE : DERIVED_INTERACTION_CACHE
    );
    mockUseRaster.mockImplementation(() => ({
      notifyCameraChanged: rasterNotify,
      refreshPolicy,
      getDiagnostics,
      readiness: 'ready',
      readinessTargetIdentityKey: 'ready-target',
      readinessRendererMatchesCurrent: true,
      validatedSourceFingerprint: 'validated-fp',
      admittedBroadCorridorFinestSpanBp: 250,
      targetIdentityKey: 'raster-target',
      expectedInteractionOwnerKey: 'raster-owner',
      policyControlsReadiness: 'ready',
      policyFailureRequestId: null,
    }));
    mockUseCompact.mockImplementation(() => ({
      status: 'loaded',
      ownerKey: 'compact-owner',
      payloadBytes: 16,
      startedAt: 1,
      readCompletedAt: 2,
      preparedAt: 3,
      completedAt: 4,
      authorityKind: 'portable',
      origin: 'durable-hit',
      error: null,
      authority: { metadata: { genomeLengthBp: 1_000 } },
    }));
    mockUseViewport.mockImplementation(() => ({
      notifyCameraChanged: viewportNotify,
      receipt: {
        status: 'loaded',
        ownerKey: 'detail-owner',
        coverageStartBp: 10,
        coverageEndBp: 20,
        payloadBytes: 32,
        error: null,
      },
    }));
    mockUsePrepackedScene.mockReturnValue('loaded-hit');
  });

  it('uses the seed cache when its artifact track type matches', () => {
    const seed = seedCache('mRNA');
    renderTrack({ seedCache: seed, trackType: 'mRNA' });

    const surfaceInputs = mockUseCache.mock.calls
      .map(([input]) => input)
      .filter((input: { prepareProductOnly?: boolean }) => input.prepareProductOnly);
    expect(surfaceInputs.length).toBeGreaterThan(0);
    expect(surfaceInputs.every((input: { enabled?: boolean }) => input.enabled === false)).toBe(
      true
    );
    expect(
      mockUseRaster.mock.calls.every(
        ([input]: [{ cache: AssemblyPrepackedAnnotationSceneCacheState }]) => input.cache === seed
      )
    ).toBe(true);
  });

  it('derives a new surface cache when the seed track type does not match', () => {
    const seed = seedCache('mRNA');
    renderTrack({ seedCache: seed, trackType: 'gene', selected: true });

    const surfaceInputs = mockUseCache.mock.calls
      .map(([input]) => input)
      .filter((input: { prepareProductOnly?: boolean }) => input.prepareProductOnly);
    expect(surfaceInputs.length).toBeGreaterThan(0);
    expect(
      surfaceInputs.every(
        (input: { enabled?: boolean; requiredInteractionOwnerKey?: string }) =>
          input.enabled === true && input.requiredInteractionOwnerKey === undefined
      )
    ).toBe(true);
    expect(
      mockUseRaster.mock.calls.every(
        ([input]: [{ cache: AssemblyPrepackedAnnotationSceneCacheState }]) =>
          input.cache === DERIVED_SURFACE_CACHE
      )
    ).toBe(true);
    expect(
      mockUseRaster.mock.calls.some(
        ([input]: [{ cache: AssemblyPrepackedAnnotationSceneCacheState }]) => input.cache === seed
      )
    ).toBe(false);
  });

  it('does not reuse a seed cache for a distinct case-only scientific identity', () => {
    const seed = seedCache('transposon:DM88');
    renderTrack({ seedCache: seed, trackType: 'transposon:Dm88', selected: true });

    const surfaceInputs = mockUseCache.mock.calls
      .map(([input]) => input)
      .filter((input: { prepareProductOnly?: boolean }) => input.prepareProductOnly);
    expect(surfaceInputs).not.toHaveLength(0);
    expect(surfaceInputs.every((input: { enabled?: boolean }) => input.enabled === true)).toBe(
      true
    );
    expect(
      mockUseRaster.mock.calls.every(
        ([input]: [{ cache: AssemblyPrepackedAnnotationSceneCacheState }]) =>
          input.cache === DERIVED_SURFACE_CACHE
      )
    ).toBe(true);
  });

  it('emits the selected raster+interaction receipt and the idle unselected receipt', () => {
    const selected = renderTrack({ selected: true, ownerReadinessScopeKey: 'scope-selected' });
    const selectedReceipt = selected.onReadinessChanged.mock.calls.at(
      -1
    )?.[1] as CompiledBroadTrackReadinessReceipt;
    expect(selected.onReadinessChanged.mock.calls.at(-1)?.[0]).toBe('mRNA');
    expect(selectedReceipt).toMatchObject({
      readiness: 'ready',
      targetIdentityKey: 'raster-target',
      readinessTargetIdentityKey: 'ready-target',
      readinessRendererMatchesCurrent: true,
      validatedSourceFingerprint: 'validated-fp',
      ownerReadinessScopeKey: 'scope-selected',
      compactInteractionStatus: 'loaded',
      compactInteractionOwnerKey: 'compact-owner',
      compactInteractionPayloadBytes: 16,
      compactInteractionAuthorityPresent: true,
      compactInteractionGenomeLengthBp: 1_000,
      viewportDetailStatus: 'loaded',
      viewportDetailCoverageStartBp: 10,
      viewportDetailCoverageEndBp: 20,
      viewportDetailPayloadBytes: 32,
    });
    expect(selectedReceipt.readiness).not.toBe('idle');
    expect(selectedReceipt.interactionReadiness).not.toBe('not-applicable');

    const unselected = renderTrack({
      selected: false,
      ownerReadinessScopeKey: 'scope-idle',
    });
    expect(unselected.onReadinessChanged).toHaveBeenCalledWith('mRNA', idleReceipt('scope-idle'));
  });

  it('registers camera notifiers from both the raster loader and viewport detail', () => {
    const { registerCameraNotifier } = renderTrack();
    expect(registerCameraNotifier).toHaveBeenCalledWith(rasterNotify);
    expect(registerCameraNotifier).toHaveBeenCalledWith(viewportNotify);
    expect(registerCameraNotifier).toHaveBeenCalledTimes(2);
  });

  it('fires onPolicyUnavailable only for the selected policy request id', () => {
    mockUseRaster.mockImplementation(() => ({
      notifyCameraChanged: rasterNotify,
      refreshPolicy,
      getDiagnostics,
      readiness: 'error',
      readinessTargetIdentityKey: null,
      readinessRendererMatchesCurrent: false,
      validatedSourceFingerprint: null,
      admittedBroadCorridorFinestSpanBp: null,
      targetIdentityKey: 'raster-target',
      expectedInteractionOwnerKey: null,
      policyControlsReadiness: 'unavailable',
      policyFailureRequestId: 12,
    }));

    const selected = renderTrack({ selected: true, policyRequestId: 12, trackType: 'gene' });
    expect(selected.onPolicyUnavailable).toHaveBeenCalledWith(12, 'gene');

    const unselected = renderTrack({ selected: false, policyRequestId: 12, trackType: 'gene' });
    expect(unselected.onPolicyUnavailable).not.toHaveBeenCalled();

    const idleRequest = renderTrack({ selected: true, policyRequestId: null, trackType: 'gene' });
    expect(idleRequest.onPolicyUnavailable).not.toHaveBeenCalled();
  });

  it('does not attribute a raster failure for an older request to the current request', () => {
    mockUseRaster.mockReturnValue({
      notifyCameraChanged: rasterNotify,
      refreshPolicy,
      getDiagnostics,
      readiness: 'error',
      policyControlsReadiness: 'error',
      policyFailureRequestId: 11,
    });
    const track = renderTrack({ policyRequestId: 12 });
    expect(track.onPolicyUnavailable).not.toHaveBeenCalled();
  });
});
