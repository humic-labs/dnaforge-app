import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readManifest, readCells } = vi.hoisted(() => ({
  readManifest: vi.fn(),
  readCells: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: {
      readAssemblyCompiledBroadRasterManifestV1: readManifest,
      readAssemblyCompiledBroadRasterCellsV1: readCells,
    },
  }),
}));
vi.mock('./useAssemblyPrepackedAnnotationSceneCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useAssemblyPrepackedAnnotationSceneCache')>()),
  useAssemblyPrepackedAnnotationSceneCache: () => ({
    status: 'not-applicable',
    descriptor: null,
    result: null,
    error: null,
    lifecycle: {},
  }),
}));
vi.mock('./useAssemblyCompiledBroadInteraction', () => ({
  useAssemblyCompiledBroadInteraction: () => ({
    status: 'loading',
    ownerKey: null,
    authority: null,
    error: null,
  }),
}));
vi.mock('./useAssemblyAnnotationViewportDetail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useAssemblyAnnotationViewportDetail')>()),
  useAssemblyAnnotationViewportDetail: () => ({
    notifyCameraChanged: () => undefined,
    receipt: { status: 'not-applicable', ownerKey: null, error: null },
  }),
}));
vi.mock('./usePrepackedAssemblyAnnotationScene', () => ({
  usePrepackedAssemblyAnnotationScene: () => 'not-applicable',
}));

import { AssemblyCompiledAnnotationTrack } from './AssemblyCompiledAnnotationTrack';
import type { AssemblyPrepackedAnnotationSceneCacheState } from './useAssemblyPrepackedAnnotationSceneCache';

type TrackProps = Parameters<typeof AssemblyCompiledAnnotationTrack>[0];
function cache(suffix = 'initial'): AssemblyPrepackedAnnotationSceneCacheState {
  const artifact = { artifactKey: `3UTR:${suffix}`, trackType: '3UTR', themeMode: 'light' };
  const request = {
    assemblyId: 'hg19',
    workspaceRoot: '/fixture/prepared-hg19',
    chromosomes: [
      {
        chrom: 'assembly-axis',
        length: 3_137_161_264,
        sourcePath: '/fixture/prepared-hg19/annotations.gff',
      },
    ],
    scope: {
      kind: 'complete-assembly',
      placements: [
        { chrom: 'assembly-axis', length: 3_137_161_264, annotationCoverage: 'sourced' },
      ],
    },
    artifact,
  };
  return {
    status: 'loading',
    descriptor: {
      artifact,
      request,
      runtimeCacheKey: `runtime:${suffix}`,
      sourceIdentity: 'hg19-fixture',
      placementFingerprint: `ap1:${'1'.repeat(24)}`,
    },
    result: null,
    error: null,
    lifecycle: {},
  } as unknown as AssemblyPrepackedAnnotationSceneCacheState;
}
function props(): TrackProps {
  const seedCache = cache();
  const renderer = { requireCompiledBroadSurface: vi.fn(() => true) };
  return {
    trackType: '3UTR',
    selected: true,
    seedCache,
    assetGeneration: null,
    productPublicationReady: true,
    sourceRequest: seedCache.descriptor!.request,
    interactionPayloadEnabled: false,
    interactionPreparationGeneration: 0,
    themeMode: 'light',
    assemblyRequirement: {
      identityKey: 'indexed-full-assembly:hg19',
      genomeLengthBp: 3_137_161_264,
    },
    surfacePolicy: { isoformMode: 'canonical', laneLimit: 2 },
    interactionPolicy: { isoformMode: 'canonical', laneLimit: 2 },
    policyRequestId: null,
    rendererReadyEpoch: 1,
    rendererGenomeCommitEpoch: 1,
    rendererAdmissionEpoch: 1,
    webglRef: {
      current: {
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
        schedulePostPresentWork: vi.fn(),
      } as unknown as NonNullable<TrackProps['webglRef']['current']>,
    },
    recordEvent: vi.fn(),
    registerCameraNotifier: () => () => undefined,
    registerPolicyRefresher: () => () => undefined,
    registerDiagnostics: () => () => undefined,
    overviewFeaturesComplete: true,
    onPolicyCommitted: vi.fn(),
    onPolicyUnavailable: vi.fn(),
    onReadinessChanged: vi.fn(),
    onDetailRendererAdmission: vi.fn(),
    readinessGeneration: 'fixture-gen',
    ownerReadinessScopeKey: 'fixture-scope',
    viewportCssWidthPx: 1200,
  };
}
async function failedInitialLoad() {
  readManifest.mockRejectedValueOnce(new Error('temporary initial metadata failure'));
  const input = props();
  const view = render(<AssemblyCompiledAnnotationTrack {...input} />);
  await waitFor(() =>
    expect(input.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-rejected',
      expect.objectContaining({ reason: 'manifest-read-failed' })
    )
  );
  expect(input.onPolicyUnavailable).not.toHaveBeenCalled();
  return { view, input };
}

describe('annotation settings failure ownership and recovery', () => {
  beforeEach(() => {
    readManifest.mockReset();
    readCells.mockReset();
  });
  afterEach(cleanup);

  it('a new settings request retries the failed product without a selection or camera gesture', async () => {
    const { view, input } = await failedInitialLoad();
    readManifest.mockImplementation(() => new Promise(() => undefined));
    await act(async () =>
      view.rerender(
        <AssemblyCompiledAnnotationTrack
          {...input}
          policyRequestId={12}
          surfacePolicy={{ isoformMode: 'canonical', laneLimit: 4 }}
        />
      )
    );
    expect(readManifest).toHaveBeenCalledTimes(2);
    expect(input.onPolicyUnavailable).not.toHaveBeenCalled();
  });

  it('an old error cannot fail a replacement product while the replacement is loading', async () => {
    const { view, input } = await failedInitialLoad();
    readManifest.mockImplementation(() => new Promise(() => undefined));
    const replacement = cache('replacement');
    await act(async () =>
      view.rerender(
        <AssemblyCompiledAnnotationTrack
          {...input}
          seedCache={replacement}
          sourceRequest={replacement.descriptor!.request}
          policyRequestId={13}
          surfacePolicy={{ isoformMode: 'canonical', laneLimit: 4 }}
        />
      )
    );
    expect(readManifest).toHaveBeenCalledTimes(2);
    expect(input.onPolicyUnavailable).not.toHaveBeenCalled();
  });

  it('a genuine failure of the new request still reports that exact request', async () => {
    const { view, input } = await failedInitialLoad();
    readManifest.mockRejectedValueOnce(new Error('new request failed'));
    await act(async () =>
      view.rerender(
        <AssemblyCompiledAnnotationTrack
          {...input}
          policyRequestId={14}
          surfacePolicy={{ isoformMode: 'expanded', laneLimit: 8 }}
        />
      )
    );
    await waitFor(() => expect(input.onPolicyUnavailable).toHaveBeenCalledWith(14, '3UTR'));
    expect(readManifest).toHaveBeenCalledTimes(2);
    expect(input.onPolicyUnavailable).toHaveBeenCalledTimes(1);
  });

  it('hiding and reselecting a failed track starts a new load', async () => {
    const { view, input } = await failedInitialLoad();
    readManifest.mockImplementation(() => new Promise(() => undefined));
    await act(async () =>
      view.rerender(<AssemblyCompiledAnnotationTrack {...input} selected={false} />)
    );
    await act(async () => view.rerender(<AssemblyCompiledAnnotationTrack {...input} />));
    expect(readManifest).toHaveBeenCalledTimes(2);
  });

  it.each(['product', 'source generation', 'renderer'])(
    'ignores a previous %s failure even when the request number is unchanged',
    async (change) => {
      const input = { ...props(), policyRequestId: 15 };
      readManifest.mockRejectedValueOnce(new Error('previous owner failed'));
      const view = render(<AssemblyCompiledAnnotationTrack {...input} />);
      await waitFor(() => expect(input.onPolicyUnavailable).toHaveBeenCalledWith(15, '3UTR'));
      vi.mocked(input.onPolicyUnavailable).mockClear();
      readManifest.mockImplementation(() => new Promise(() => undefined));
      let replacement: TrackProps = input;
      if (change === 'product') {
        const seedCache = cache('replacement');
        replacement = { ...input, seedCache, sourceRequest: seedCache.descriptor!.request };
      } else if (change === 'source generation') {
        replacement = {
          ...input,
          assetGeneration: {
            contract: 'assembly-reference-asset-generation.v1',
            sourceFingerprint: '2'.repeat(24),
            inventoryFingerprint: '3'.repeat(64),
            themeMode: 'light',
          },
        };
      } else {
        const renderer = { requireCompiledBroadSurface: vi.fn(() => true) };
        replacement = {
          ...input,
          rendererReadyEpoch: 2,
          webglRef: {
            current: {
              ...input.webglRef.current,
              getLinearRenderer: () => renderer,
            } as unknown as NonNullable<TrackProps['webglRef']['current']>,
          },
        };
      }
      await act(async () => view.rerender(<AssemblyCompiledAnnotationTrack {...replacement} />));
      expect(readManifest).toHaveBeenCalledTimes(2);
      expect(input.onPolicyUnavailable).not.toHaveBeenCalled();
    }
  );
});
