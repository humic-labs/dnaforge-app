// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWebGLInstance, unregisterWebGLInstance } from '@waypoint/genome-renderer';

import { ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1 } from '../../../shared/indexed-genome';
import {
  assemblyAnnotationBroadHandoffSpanBpV1,
  assemblyAnnotationDetailPrefetchTriggerSpanBpV1,
  assemblyAnnotationDetailUsesWholeSceneV1,
  inferAssemblyAnnotationZoomAnchorBpV1,
  planAssemblyAnnotationDetailCorridorV1,
  planAssemblyAnnotationFinePrewarmRangeV1,
  scheduleViewportDetailRendererAdmissionV1,
  useAssemblyAnnotationViewportDetail,
} from './useAssemblyAnnotationViewportDetail';

const { bindInteraction, readDetail, unpackDetail } = vi.hoisted(() => ({
  bindInteraction: vi.fn(),
  readDetail: vi.fn(),
  unpackDetail: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: { readAssemblyAnnotationSceneDetailV1: readDetail },
  }),
}));

vi.mock('@waypoint/genome-renderer/pure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@waypoint/genome-renderer/pure')>()),
  bindTrustedPartitionedTranscriptSceneDetailInteractionV1: bindInteraction,
  unpackPartitionedTranscriptSceneDetailPacketV1: unpackDetail,
}));

const GENOME_LENGTH_BP = 3_088_269_832;
const SOURCE_BYTES = 300_000_000;
const SOURCE_PAYLOAD_SHA256 = 'a'.repeat(64);
const SOURCE_CONTRACT_SHA256 = 'b'.repeat(64);
const PACKET_PAYLOAD_SHA256 = 'c'.repeat(64);

describe('assembly annotation viewport detail', () => {
  beforeEach(() => {
    readDetail.mockReset();
    unpackDetail.mockReset();
    bindInteraction.mockReset();
    unpackDetail.mockResolvedValue({
      scene: { partitionSpanBp: 100_000_000, sortedPrimitives: [] },
      submissionBank: { expanded: {}, canonical: {} },
      submissionFineIndices: { expanded: {}, canonical: {} },
      featureFamilyIndices: new Uint32Array([0]),
      empty: false,
      rendererAdmissionCapability: {},
    });
    bindInteraction.mockReturnValue({
      interactionIndex: { featureCount: 1, primitiveCount: 0 },
      rendererAdmissionCapability: {},
    });
  });

  it('plans stable bounded corridors and declines broad overview reads', () => {
    const first = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: 500_000_000,
      viewportEndBp: 501_000_000,
      genomeLengthBp: GENOME_LENGTH_BP,
    });
    const nearby = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: 502_000_000,
      viewportEndBp: 503_000_000,
      genomeLengthBp: GENOME_LENGTH_BP,
    });
    const broad = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: 0,
      viewportEndBp: 450_000_000,
      genomeLengthBp: GENOME_LENGTH_BP,
    });

    expect(first).not.toBeNull();
    expect(nearby?.key).toBe(first?.key);
    expect(first?.startBp).toBeGreaterThanOrEqual(0);
    expect(first?.endBp).toBeLessThanOrEqual(GENOME_LENGTH_BP);
    expect(broad).toBeNull();
  });

  it('derives a zoom-overlap request from the physical broad handoff without enabling broad pans', () => {
    const broadHandoffSpanBp = assemblyAnnotationBroadHandoffSpanBpV1({
      genomeLengthBp: GENOME_LENGTH_BP,
      broadCorridorFinestSpanBp: 16_000_000,
      viewportCssWidthPx: 1_600,
      devicePixelRatio: 2,
    });
    const triggerSpanBp = assemblyAnnotationDetailPrefetchTriggerSpanBpV1({
      genomeLengthBp: GENOME_LENGTH_BP,
      broadCorridorFinestSpanBp: 16_000_000,
      viewportCssWidthPx: 1_600,
      devicePixelRatio: 2,
    });
    expect(triggerSpanBp).toBe(GENOME_LENGTH_BP);
    const zoomPrefetch = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: 1_300_000_000,
      viewportEndBp: 1_650_000_000,
      genomeLengthBp: GENOME_LENGTH_BP,
      prefetchTriggerSpanBp: triggerSpanBp,
      broadHandoffSpanBp,
    });
    expect(zoomPrefetch).not.toBeNull();
    expect(zoomPrefetch!.endBp - zoomPrefetch!.startBp).toBe(256 * 1024 * 1024);
    expect(zoomPrefetch!.handoffEndBp - zoomPrefetch!.handoffStartBp).toBeGreaterThanOrEqual(
      broadHandoffSpanBp
    );
    expect(zoomPrefetch!.startBp).toBeLessThanOrEqual(zoomPrefetch!.handoffStartBp);
    expect(zoomPrefetch!.endBp).toBeGreaterThanOrEqual(zoomPrefetch!.handoffEndBp);
    expect(
      planAssemblyAnnotationDetailCorridorV1({
        viewportStartBp: 1_300_000_000,
        viewportEndBp: 1_650_000_000,
        genomeLengthBp: GENOME_LENGTH_BP,
      })
    ).toBeNull();
  });

  it('uses the authenticated whole scene only when the admitted handoff spans the genome', () => {
    expect(
      assemblyAnnotationDetailUsesWholeSceneV1({
        completeAssemblyDetailEnabled: true,
        genomeLengthBp: 12_157_105,
        broadHandoffSpanBp: 12_157_105,
      })
    ).toBe(true);
    expect(
      assemblyAnnotationDetailUsesWholeSceneV1({
        completeAssemblyDetailEnabled: true,
        genomeLengthBp: 12_157_105,
        broadHandoffSpanBp: 8_105_000,
      })
    ).toBe(false);
    expect(
      assemblyAnnotationDetailUsesWholeSceneV1({
        completeAssemblyDetailEnabled: false,
        genomeLengthBp: 12_157_105,
        broadHandoffSpanBp: 12_157_105,
      })
    ).toBe(false);
  });

  it('keeps the complete physical handoff covered after detail has already narrowed', () => {
    const broadHandoffSpanBp = assemblyAnnotationBroadHandoffSpanBpV1({
      genomeLengthBp: GENOME_LENGTH_BP,
      broadCorridorFinestSpanBp: 16_000_000,
      viewportCssWidthPx: 1_600,
      devicePixelRatio: 2,
    });
    const currentStartBp = 1_847_189_801;
    const currentEndBp = currentStartBp + 50_000_000;
    const corridor = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: currentStartBp,
      viewportEndBp: currentEndBp,
      genomeLengthBp: GENOME_LENGTH_BP,
      prefetchTriggerSpanBp: GENOME_LENGTH_BP,
      broadHandoffSpanBp,
      corridorCenterBp: 1_872_189_801,
    });

    expect(corridor).not.toBeNull();
    expect(corridor!.handoffEndBp - corridor!.handoffStartBp).toBeGreaterThanOrEqual(
      broadHandoffSpanBp
    );
    expect(corridor!.handoffStartBp).toBeLessThanOrEqual(currentStartBp);
    expect(corridor!.handoffEndBp).toBeGreaterThanOrEqual(currentEndBp);
    expect(corridor!.startBp).toBeLessThanOrEqual(corridor!.handoffStartBp);
    expect(corridor!.endBp).toBeGreaterThanOrEqual(corridor!.handoffEndBp);
  });

  it('translates rather than shrinks the physical handoff at either genome edge', () => {
    const broadHandoffSpanBp = 100_000_000;
    const left = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: 0,
      viewportEndBp: 50_000_000,
      genomeLengthBp: GENOME_LENGTH_BP,
      prefetchTriggerSpanBp: GENOME_LENGTH_BP,
      broadHandoffSpanBp,
      corridorCenterBp: 10_000_000,
    });
    const right = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: GENOME_LENGTH_BP - 50_000_000,
      viewportEndBp: GENOME_LENGTH_BP,
      genomeLengthBp: GENOME_LENGTH_BP,
      prefetchTriggerSpanBp: GENOME_LENGTH_BP,
      broadHandoffSpanBp,
      corridorCenterBp: GENOME_LENGTH_BP - 10_000_000,
    });

    expect(left).toMatchObject({ handoffStartBp: 0, handoffEndBp: broadHandoffSpanBp });
    expect(right).toMatchObject({
      handoffStartBp: GENOME_LENGTH_BP - broadHandoffSpanBp,
      handoffEndBp: GENOME_LENGTH_BP,
    });
  });

  it('recovers one stable zoom anchor and plans the corridor around intent, not the moving center', () => {
    const anchorBp = 1_872_189_801;
    const scale = 0.72;
    const previous = { start: 0, end: GENOME_LENGTH_BP };
    const current = {
      start: anchorBp + (previous.start - anchorBp) * scale,
      end: anchorBp + (previous.end - anchorBp) * scale,
    };
    const inferredAnchorBp = inferAssemblyAnnotationZoomAnchorBpV1({
      previousStartBp: previous.start,
      previousEndBp: previous.end,
      currentStartBp: current.start,
      currentEndBp: current.end,
      genomeLengthBp: GENOME_LENGTH_BP,
    });
    expect(inferredAnchorBp).toBeCloseTo(anchorBp, 5);

    const corridor = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: current.start,
      viewportEndBp: current.end,
      genomeLengthBp: GENOME_LENGTH_BP,
      prefetchTriggerSpanBp: GENOME_LENGTH_BP,
      broadHandoffSpanBp: assemblyAnnotationBroadHandoffSpanBpV1({
        genomeLengthBp: GENOME_LENGTH_BP,
        broadCorridorFinestSpanBp: 16_000_000,
        viewportCssWidthPx: 1_600,
        devicePixelRatio: 2,
      }),
      corridorCenterBp: inferredAnchorBp!,
    });
    expect(corridor).not.toBeNull();
    expect(corridor!.startBp).toBeLessThan(anchorBp);
    expect(corridor!.endBp).toBeGreaterThan(anchorBp);
    expect(corridor!.endBp - corridor!.startBp).toBe(256 * 1024 * 1024);
    expect(corridor!.focusBp).toBeCloseTo(anchorBp, 5);
    expect(corridor!.handoffStartBp).toBeLessThan(anchorBp);
    expect(corridor!.handoffEndBp).toBeGreaterThan(anchorBp);
    const handoffSpanBp = assemblyAnnotationBroadHandoffSpanBpV1({
      genomeLengthBp: GENOME_LENGTH_BP,
      broadCorridorFinestSpanBp: 16_000_000,
      viewportCssWidthPx: 1_600,
      devicePixelRatio: 2,
    });
    const handoffScale = handoffSpanBp / (current.end - current.start);
    expect(corridor!.handoffStartBp).toBe(
      Math.floor(anchorBp + (current.start - anchorBp) * handoffScale)
    );
    expect(corridor!.handoffEndBp).toBe(
      Math.ceil(anchorBp + (current.end - anchorBp) * handoffScale)
    );
    const shiftedIntent = planAssemblyAnnotationDetailCorridorV1({
      viewportStartBp: current.start,
      viewportEndBp: current.end,
      genomeLengthBp: GENOME_LENGTH_BP,
      prefetchTriggerSpanBp: GENOME_LENGTH_BP,
      broadHandoffSpanBp: handoffSpanBp,
      corridorCenterBp: inferredAnchorBp! + 10_000,
    });
    expect(shiftedIntent?.key).toBe(corridor!.key);
    expect(shiftedIntent?.handoffStartBp).not.toBe(corridor!.handoffStartBp);

    const fine = planAssemblyAnnotationFinePrewarmRangeV1({
      focusBp: corridor!.focusBp,
      genomeLengthBp: GENOME_LENGTH_BP,
    });
    expect(fine.endBp - fine.startBp).toBe(4 * 1024 * 1024);
    expect(fine.startBp).toBeLessThan(anchorBp);
    expect(fine.endBp).toBeGreaterThan(anchorBp);
    expect(Math.abs((fine.startBp + fine.endBp) / 2 - anchorBp)).toBeLessThanOrEqual(1);
    expect((corridor!.startBp + corridor!.endBp) / 2).not.toBeCloseTo(anchorBp, 0);
  });

  it('rejects a false zoom anchor when navigation jumps to a disjoint chromosome', () => {
    expect(
      inferAssemblyAnnotationZoomAnchorBpV1({
        previousStartBp: 1_853_681_051,
        previousEndBp: 1_858_681_051,
        currentStartBp: 2_834_183_054,
        currentEndBp: 2_869_183_054,
        genomeLengthBp: GENOME_LENGTH_BP,
      })
    ).toBeNull();
  });

  it('replaces an obsolete chromosome corridor after a disjoint zoom/navigation jump', async () => {
    const viewport = { start: 0, end: GENOME_LENGTH_BP };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue(detailResult());
    const renderer = detailRenderer();
    const webglRef = {
      current: {
        getViewportRange: () => ({ ...viewport }),
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
      },
    };
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        detailPrefetchTriggerSpanBp: GENOME_LENGTH_BP,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    const chr11Viewport = { start: 1_853_681_051, end: 1_858_681_051 };
    act(() => result.current.notifyCameraChanged('zoom', chr11Viewport));
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));

    const publishedViewport = { start: 2_834_183_054, end: 2_869_183_054 };
    act(() => result.current.notifyCameraChanged('zoom', publishedViewport));

    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(2));
    const replacement = readDetail.mock.calls[1]?.[0];
    expect(replacement.startBp).toBeLessThanOrEqual(publishedViewport.start);
    expect(replacement.endBp).toBeGreaterThanOrEqual(publishedViewport.end);
    expect(replacement.startBp).toBeGreaterThan(2_700_000_000);
  });

  it('does not abort useful zoom-intent work during a transient broad pan', async () => {
    const anchorBp = 1_872_189_801;
    const viewport = { start: 0, end: GENOME_LENGTH_BP };
    const pendingRead = new Promise<never>(() => undefined);
    readDetail.mockReturnValue(pendingRead);
    const renderer = detailRenderer();
    const webglRef = {
      current: {
        getViewportRange: () => ({ ...viewport }),
        getLinearRenderer: () => renderer,
      },
    };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        detailPrefetchTriggerSpanBp: GENOME_LENGTH_BP,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    const scale = 0.72;
    viewport.start = anchorBp + (0 - anchorBp) * scale;
    viewport.end = anchorBp + (GENOME_LENGTH_BP - anchorBp) * scale;
    act(() => result.current.notifyCameraChanged('zoom'));
    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(1));
    const signal = readDetail.mock.calls[0]?.[1]?.signal as AbortSignal;
    const request = readDetail.mock.calls[0]?.[0];
    expect(request.endBp - request.startBp).toBe(256 * 1024 * 1024);
    expect(request.startBp).toBeLessThan(anchorBp);
    expect(request.endBp).toBeGreaterThan(anchorBp);

    viewport.start += 100_000_000;
    viewport.end += 100_000_000;
    act(() => result.current.notifyCameraChanged('scroll'));
    await act(async () => Promise.resolve());
    expect(signal.aborted).toBe(false);
    expect(readDetail).toHaveBeenCalledTimes(1);
  });

  it('revokes unfinished predictive detail when zoom intent reverses outward', async () => {
    const anchorBp = 1_500_000_000;
    const viewport = { start: 0, end: GENOME_LENGTH_BP };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    const pending: Array<(value: ReturnType<typeof detailResult>) => void> = [];
    readDetail.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        })
    );
    const renderer = detailRenderer();
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getViewportRange: () => ({ ...viewport }),
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
      },
    };
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        detailPrefetchTriggerSpanBp: GENOME_LENGTH_BP,
        recordEvent,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    const inward = { start: 900_000_000, end: 2_100_000_000 };
    act(() => result.current.notifyCameraChanged('zoom', inward, anchorBp));
    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(1));
    const obsoleteSignal = readDetail.mock.calls[0]?.[1]?.signal as AbortSignal;

    const outward = { start: 700_000_000, end: 2_300_000_000 };
    act(() => result.current.notifyCameraChanged('zoom', outward, anchorBp));
    expect(obsoleteSignal.aborted).toBe(true);
    expect(result.current.receipt.status).toBe('waiting-camera');
    expect(recordEvent).toHaveBeenCalledWith(
      'annotation-viewport-detail-request-revoked',
      expect.objectContaining({ reason: 'zoom-out' })
    );

    await act(async () => pending[0]?.(detailResult()));
    expect(renderer.preparePrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(readDetail).toHaveBeenCalledTimes(1);

    const resumedInward = { start: 1_000_000_000, end: 2_000_000_000 };
    act(() => result.current.notifyCameraChanged('zoom', resumedInward, anchorBp));
    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(2));
    await act(async () => pending[1]?.(detailResult()));
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
  });

  it('retargets unfinished detail when an outward zoom remains inside the detail handoff', async () => {
    const anchorBp = 1_500_000_000;
    const viewport = { start: 0, end: GENOME_LENGTH_BP };
    const pendingRead = new Promise<never>(() => undefined);
    readDetail.mockReturnValue(pendingRead);
    const renderer = detailRenderer();
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getViewportRange: () => ({ ...viewport }),
        getLinearRenderer: () => renderer,
      },
    };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        detailPrefetchTriggerSpanBp: GENOME_LENGTH_BP,
        detailBroadHandoffSpanBp: 4_000_000,
        recordEvent,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    const inward = { start: anchorBp - 500_000, end: anchorBp + 500_000 };
    act(() => result.current.notifyCameraChanged('zoom', inward, anchorBp));
    await waitFor(() => expect(readDetail).toHaveBeenCalledOnce());
    const usefulSignal = readDetail.mock.calls[0]?.[1]?.signal as AbortSignal;

    const outwardButStillDetailOwned = {
      start: anchorBp - 1_500_000,
      end: anchorBp + 1_500_000,
    };
    act(() => result.current.notifyCameraChanged('zoom', outwardButStillDetailOwned, anchorBp));
    await act(async () => Promise.resolve());

    expect(usefulSignal.aborted).toBe(false);
    expect(readDetail).toHaveBeenCalledOnce();
    expect(recordEvent).not.toHaveBeenCalledWith(
      'annotation-viewport-detail-request-revoked',
      expect.anything()
    );
  });

  it('does not restart an in-flight read for an equivalent descriptor object', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const pendingRead = new Promise<never>(() => undefined);
    readDetail.mockReturnValue(pendingRead);
    const renderer = detailRenderer();
    const webglRef = {
      current: {
        getViewportRange: () => ({ ...viewport }),
        getLinearRenderer: () => renderer,
      },
    };
    const stableInteractionAuthority = interactionAuthority();
    const initialDescriptor = {
      ...descriptor(),
      sceneKey: 'stable-source-scene',
      runtimeCacheKey: 'runtime-without-generation',
    };
    const { rerender } = renderHook(
      ({ currentDescriptor }: { currentDescriptor: ReturnType<typeof descriptor> | null }) =>
        useAssemblyAnnotationViewportDetail({
          enabled: true,
          descriptor: currentDescriptor as never,
          expectedInteractionOwnerKey: 'annotation-owner',
          interactionAuthority: stableInteractionAuthority as never,
          policy: { isoformMode: 'expanded', laneLimit: null },
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          webglRef: webglRef as never,
        }),
      { initialProps: { currentDescriptor: initialDescriptor } }
    );

    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(1));
    const signal = readDetail.mock.calls[0]?.[1]?.signal as AbortSignal;
    rerender({ currentDescriptor: null });
    await act(async () => Promise.resolve());
    expect(signal.aborted).toBe(false);
    expect(readDetail).toHaveBeenCalledTimes(1);

    rerender({
      currentDescriptor: {
        ...initialDescriptor,
        runtimeCacheKey: 'runtime-with-late-generation-receipt',
        request: { ...initialDescriptor.request },
      },
    });
    await act(async () => Promise.resolve());

    expect(signal.aborted).toBe(false);
    expect(readDetail).toHaveBeenCalledTimes(1);
  });

  it('retains immutable detail bytes across a raster owner reseal', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    let resolveRead!: (value: ReturnType<typeof detailResult>) => void;
    readDetail.mockReturnValue(
      new Promise<ReturnType<typeof detailResult>>((resolve) => {
        resolveRead = resolve;
      })
    );
    const renderer = detailRenderer();
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
      },
    };
    const { result, rerender } = renderHook(
      ({ ownerKey }: { ownerKey: string }) =>
        useAssemblyAnnotationViewportDetail({
          enabled: true,
          descriptor: stableDescriptor as never,
          expectedInteractionOwnerKey: ownerKey,
          interactionAuthority: stableInteractionAuthority as never,
          policy: { isoformMode: 'expanded', laneLimit: null },
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          webglRef: webglRef as never,
        }),
      { initialProps: { ownerKey: 'portable-publication-owner' } }
    );

    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(1));
    const signal = readDetail.mock.calls[0]?.[1]?.signal as AbortSignal;
    rerender({ ownerKey: 'locally-resealed-owner' });
    expect(signal.aborted).toBe(false);
    expect(readDetail).toHaveBeenCalledTimes(1);

    await act(async () => resolveRead(detailResult()));
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerKey: 'locally-resealed-owner' })
    );
    expect(readDetail).toHaveBeenCalledTimes(1);
  });

  it('reads and authenticates viewport geometry in parallel with complete interaction authority', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue(detailResult());
    const renderer = detailRenderer();
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
      },
    };
    const { result, rerender } = renderHook(
      ({ authority }: { authority: ReturnType<typeof interactionAuthority> | null }) =>
        useAssemblyAnnotationViewportDetail({
          enabled: true,
          descriptor: stableDescriptor as never,
          expectedInteractionOwnerKey: 'annotation-owner',
          interactionAuthority: authority as never,
          policy: { isoformMode: 'expanded', laneLimit: null },
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          webglRef: webglRef as never,
        }),
      { initialProps: { authority: null } }
    );

    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.receipt.status).toBe('waiting-interaction'));
    expect(renderer.preparePrepackedAnnotationScene).not.toHaveBeenCalled();

    rerender({ authority: stableInteractionAuthority });
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(readDetail).toHaveBeenCalledTimes(1);
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
  });

  it('reuses one packet inside its corridor and replaces it only after crossing the boundary', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue(detailResult());
    const preparePrepackedAnnotationScene = vi.fn(() => true);
    const preparePrepackedAnnotationFineViews = vi.fn(() => fineComplete());
    const requestRender = vi.fn();
    const onRendererAdmission = vi.fn();
    const admitPrepackedAnnotationViewportDetailRoster = vi.fn(() => true);
    const renderer = {
      preparePrepackedAnnotationScene,
      preparePrepackedAnnotationFineViews,
      admitPrepackedAnnotationViewportDetailRoster,
    };
    const webglRef = {
      current: {
        getViewportRange: () => ({ ...viewport }),
        getLinearRenderer: () => renderer,
        requestRender,
      },
    };

    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        onRendererAdmission,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(readDetail).toHaveBeenCalledTimes(1);
    expect(preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(preparePrepackedAnnotationFineViews).toHaveBeenCalledTimes(1);
    expect(preparePrepackedAnnotationFineViews.mock.calls[0]?.[1]).toBe(
      preparePrepackedAnnotationFineViews.mock.calls[0]?.[0] + 4 * 1024 * 1024
    );
    expect(preparePrepackedAnnotationFineViews.mock.calls[0]?.[2]).toBe('dark');
    expect(onRendererAdmission).toHaveBeenCalledTimes(1);

    viewport.start = 502_000_000;
    viewport.end = 503_000_000;
    act(() => result.current.notifyCameraChanged());
    await act(async () => Promise.resolve());
    expect(readDetail).toHaveBeenCalledTimes(1);

    viewport.start = 900_000_000;
    viewport.end = 901_000_000;
    act(() => result.current.notifyCameraChanged());
    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(preparePrepackedAnnotationScene).toHaveBeenCalledTimes(2));
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(onRendererAdmission).toHaveBeenCalledTimes(2);
    expect(preparePrepackedAnnotationScene.mock.calls[1]?.[0]).toMatchObject({
      ownerKey: 'annotation-owner',
      viewportDetail: {
        sourceFingerprint: 'd'.repeat(24),
        interactionPayloadSha256: '9'.repeat(64),
        sourceScene: {
          byteLength: SOURCE_BYTES,
          payloadSha256: SOURCE_PAYLOAD_SHA256,
          contractSha256: SOURCE_CONTRACT_SHA256,
        },
        handoffStartBp: expect.any(Number),
        handoffEndBp: expect.any(Number),
      },
    });
  });

  it('aborts an obsolete corridor and never lets its late packet replace the current owner', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    const pending: Array<(value: ReturnType<typeof detailResult>) => void> = [];
    readDetail.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        })
    );
    const preparePrepackedAnnotationScene = vi.fn(() => true);
    const renderer = {
      preparePrepackedAnnotationScene,
      preparePrepackedAnnotationFineViews: vi.fn(() => fineComplete()),
      admitPrepackedAnnotationViewportDetailRoster: vi.fn(() => true),
    };
    const webglRef = {
      current: {
        getViewportRange: () => ({ ...viewport }),
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
      },
    };
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(1));
    const obsoleteSignal = readDetail.mock.calls[0]?.[1]?.signal as AbortSignal;
    viewport.start = 900_000_000;
    viewport.end = 901_000_000;
    act(() => result.current.notifyCameraChanged());
    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(2));
    expect(obsoleteSignal.aborted).toBe(true);

    await act(async () => pending[0]?.(detailResult()));
    expect(preparePrepackedAnnotationScene).not.toHaveBeenCalled();
    await act(async () => pending[1]?.(detailResult()));
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
  });

  it('retries a transient publication miss without authorizing the whole-scene fallback', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValueOnce(null).mockResolvedValueOnce(detailResult());
    const preparePrepackedAnnotationScene = vi.fn(() => true);
    const renderer = {
      preparePrepackedAnnotationScene,
      preparePrepackedAnnotationFineViews: vi.fn(() => fineComplete()),
      admitPrepackedAnnotationViewportDetailRoster: vi.fn(() => true),
    };
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
      },
    };
    const recordEvent = vi.fn();
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        recordEvent,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(2));
    expect(result.current.receipt.status).not.toBe('unavailable');
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      'annotation-viewport-detail-publication-attempt',
      expect.objectContaining({ attempt: 1, outcome: 'not-published' })
    );
    expect(recordEvent).toHaveBeenCalledWith(
      'annotation-viewport-detail-publication-attempt',
      expect.objectContaining({ attempt: 2, outcome: 'hit' })
    );
  });

  it('fails closed when the renderer rejects an immutable viewport packet', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue(detailResult());
    const renderer = {
      preparePrepackedAnnotationScene: vi.fn(() => false),
      preparePrepackedAnnotationFineViews: vi.fn(() => fineComplete()),
      admitPrepackedAnnotationViewportDetailRoster: vi.fn(() => true),
    };
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
      },
    };
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        recordEvent,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(result.current.receipt.status).toBe('error'));
    expect(renderer.preparePrepackedAnnotationFineViews).not.toHaveBeenCalled();
    expect(renderer.admitPrepackedAnnotationViewportDetailRoster).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      'annotation-viewport-detail-request-error',
      expect.objectContaining({
        message: 'The annotation viewport detail packet was rejected by the renderer.',
      })
    );
  });

  it('authorizes legacy compatibility only from an explicit range-catalog result', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue({
      contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
      status: 'unavailable',
      reason: 'range-catalog-unavailable',
      fingerprint: 'd'.repeat(24),
      sourceBuildFingerprint: 'f'.repeat(64),
      scope: descriptor().request.scope,
      artifact: descriptor().request.artifact,
    });
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => detailRenderer(),
      },
    };
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(result.current.receipt.status).toBe('unavailable'));
  });

  it('does not publish packet admission until every exact fine owner is GPU-ready', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue(detailResult());
    const postPresentQueue: Array<(deadlineMs: number) => void> = [];
    const preparePrepackedAnnotationScene = vi.fn(() => true);
    const preparePrepackedAnnotationFineViews = vi
      .fn()
      .mockReturnValueOnce({
        status: 'prepared',
        preparedOwnerKey: 'mRNA-dark-owner',
        pendingOwnerCount: 1,
      })
      .mockReturnValueOnce(fineComplete());
    const admitPrepackedAnnotationViewportDetailRoster = vi.fn(() => true);
    const renderer = {
      preparePrepackedAnnotationScene,
      preparePrepackedAnnotationFineViews,
      admitPrepackedAnnotationViewportDetailRoster,
    };
    const onRendererAdmission = vi.fn();
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
        schedulePostPresentWork: (work: (deadlineMs: number) => void) => {
          postPresentQueue.push(work);
        },
      },
    };
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        onRendererAdmission,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(postPresentQueue).toHaveLength(1));
    await act(async () => {
      postPresentQueue.shift()?.(Number.POSITIVE_INFINITY);
      await Promise.resolve();
    });
    expect(preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(preparePrepackedAnnotationFineViews).not.toHaveBeenCalled();
    expect(result.current.receipt.status).toBe('loading');
    expect(onRendererAdmission).not.toHaveBeenCalled();
    expect(postPresentQueue).toHaveLength(1);

    await act(async () => {
      postPresentQueue.shift()?.(Number.POSITIVE_INFINITY);
      await Promise.resolve();
    });
    expect(preparePrepackedAnnotationFineViews).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(postPresentQueue).toHaveLength(0);
    expect(preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(preparePrepackedAnnotationFineViews).toHaveBeenCalledTimes(2);
    expect(admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledTimes(1);
    expect(onRendererAdmission).toHaveBeenCalledTimes(1);
  });

  it('stages a returned packet immediately behind the post-present boundary', async () => {
    let viewport = { start: 500_000_000, end: 600_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue(detailResult());
    const postPresentQueue: Array<(deadlineMs: number) => void> = [];
    const renderer = detailRenderer();
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
        schedulePostPresentWork: (work: (deadlineMs: number) => void) => {
          postPresentQueue.push(work);
        },
      },
    };
    const { result } = renderHook(() =>
      useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        detailPrefetchTriggerSpanBp: 1_280_000_000,
        detailBroadHandoffSpanBp: 40_000_000,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    act(() => result.current.notifyCameraChanged('zoom', viewport));
    await waitFor(() => expect(readDetail).toHaveBeenCalledOnce());
    await waitFor(() => expect(unpackDetail).toHaveBeenCalledOnce());
    expect(postPresentQueue).toHaveLength(1);
    expect(renderer.preparePrepackedAnnotationScene).not.toHaveBeenCalled();

    await act(async () => {
      postPresentQueue.shift()?.(Number.POSITIVE_INFINITY);
      await Promise.resolve();
    });
    expect(result.current.receipt.status).toBe('loading');
    expect(postPresentQueue).toHaveLength(1);
    act(() => postPresentQueue.shift()?.(Number.POSITIVE_INFINITY));
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(readDetail).toHaveBeenCalledOnce();
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledOnce();
  });

  it('does not publish packet preparation through React state before renderer admission', async () => {
    const viewport = { start: 500_000_000, end: 600_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    let resolveDetail: ((value: ReturnType<typeof detailResult>) => void) | null = null;
    readDetail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        })
    );
    const postPresentQueue: Array<(deadlineMs: number) => void> = [];
    const renderer = detailRenderer();
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
        schedulePostPresentWork: (work: (deadlineMs: number) => void) => {
          postPresentQueue.push(work);
        },
      },
    };
    let hookRenderCount = 0;
    const { result } = renderHook(() => {
      hookRenderCount += 1;
      return useAssemblyAnnotationViewportDetail({
        enabled: true,
        descriptor: stableDescriptor as never,
        expectedInteractionOwnerKey: 'annotation-owner',
        interactionAuthority: stableInteractionAuthority as never,
        policy: { isoformMode: 'expanded', laneLimit: null },
        detailPrefetchTriggerSpanBp: 1_280_000_000,
        detailBroadHandoffSpanBp: 40_000_000,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      });
    });

    act(() => result.current.notifyCameraChanged('zoom', viewport));
    await waitFor(() => expect(readDetail).toHaveBeenCalledOnce());
    const renderCountBeforePacket = hookRenderCount;

    await act(async () => {
      resolveDetail?.(detailResult());
      await Promise.resolve();
    });
    await waitFor(() => expect(unpackDetail).toHaveBeenCalledOnce());
    await waitFor(() => expect(postPresentQueue).toHaveLength(1));

    expect(result.current.receipt.status).toBe('loading');
    expect(hookRenderCount).toBe(renderCountBeforePacket);
  });

  it('stages one track at the renderer roster barrier until a peer admits the complete set', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue(detailResult());
    const preparePrepackedAnnotationScene = vi.fn(() => true);
    const admitPrepackedAnnotationViewportDetailRoster = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const renderer = {
      preparePrepackedAnnotationScene,
      preparePrepackedAnnotationFineViews: vi.fn(() => fineComplete()),
      admitPrepackedAnnotationViewportDetailRoster,
    };
    const onRendererAdmission = vi.fn();
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
      },
    };
    const { result, rerender } = renderHook(
      ({ admissionEpoch }: { admissionEpoch: number }) =>
        useAssemblyAnnotationViewportDetail({
          enabled: true,
          descriptor: stableDescriptor as never,
          expectedInteractionOwnerKey: 'annotation-owner',
          interactionAuthority: stableInteractionAuthority as never,
          policy: { isoformMode: 'expanded', laneLimit: null },
          onRendererAdmission,
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          rendererAdmissionEpoch: admissionEpoch,
          webglRef: webglRef as never,
        }),
      { initialProps: { admissionEpoch: 0 } }
    );

    await waitFor(() =>
      expect(admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledTimes(1)
    );
    expect(result.current.receipt.status).toBe('loading');
    expect(onRendererAdmission).not.toHaveBeenCalled();
    expect(readDetail).toHaveBeenCalledTimes(1);

    rerender({ admissionEpoch: 1 });
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));
    expect(admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledTimes(2);
    expect(onRendererAdmission).toHaveBeenCalledTimes(1);
    expect(readDetail).toHaveBeenCalledTimes(1);
  });

  it('retries a prepared packet after a renderer generation advances during admission', async () => {
    const viewport = { start: 500_000_000, end: 501_000_000 };
    const stableDescriptor = descriptor();
    const stableInteractionAuthority = interactionAuthority();
    readDetail.mockResolvedValue(detailResult());
    const postPresentQueue: Array<(deadlineMs: number) => void> = [];
    const renderer = detailRenderer();
    const webglRef = {
      current: {
        getViewportRange: () => viewport,
        getLinearRenderer: () => renderer,
        requestRender: vi.fn(),
        schedulePostPresentWork: (work: (deadlineMs: number) => void) => {
          postPresentQueue.push(work);
        },
      },
    };
    const { result, rerender } = renderHook(
      ({ genomeCommitEpoch }: { genomeCommitEpoch: number }) =>
        useAssemblyAnnotationViewportDetail({
          enabled: true,
          descriptor: stableDescriptor as never,
          expectedInteractionOwnerKey: 'annotation-owner',
          interactionAuthority: stableInteractionAuthority as never,
          policy: { isoformMode: 'expanded', laneLimit: null },
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: genomeCommitEpoch,
          webglRef: webglRef as never,
        }),
      { initialProps: { genomeCommitEpoch: 1 } }
    );

    await waitFor(() => expect(postPresentQueue).toHaveLength(1));
    rerender({ genomeCommitEpoch: 2 });
    act(() => postPresentQueue.shift()?.(Number.POSITIVE_INFINITY));

    await waitFor(() => expect(postPresentQueue).toHaveLength(1));
    act(() => postPresentQueue.shift()?.(Number.POSITIVE_INFINITY));
    await waitFor(() => expect(postPresentQueue).toHaveLength(1));
    act(() => postPresentQueue.shift()?.(Number.POSITIVE_INFINITY));
    await waitFor(() => expect(result.current.receipt.status).toBe('loaded'));

    expect(readDetail).toHaveBeenCalledTimes(1);
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(renderer.admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledTimes(1);
  });

  it('prepares the current hidden successor in the post-present budget during a live gesture', async () => {
    const renderer = detailRenderer();
    const scheduled: Array<(deadlineMs: number) => void> = [];
    const phases: Array<{ phase: string; detail: Record<string, unknown> }> = [];
    const admission = scheduleViewportDetailRendererAdmissionV1({
      renderer,
      loadInput: { metadata: { themeMode: 'light' } } as never,
      finePrewarmRange: { startBp: 100, endBp: 200 },
      handle: {
        getLinearRenderer: () => renderer,
        schedulePostPresentWork: (work) => scheduled.push(work),
      },
      cancelled: () => false,
      onPhase: (phase, detail) => phases.push({ phase, detail }),
    });

    expect(scheduled).toHaveLength(1);
    expect(renderer.preparePrepackedAnnotationScene).not.toHaveBeenCalled();
    scheduled.shift()!(performance.now() + 8);
    await Promise.resolve();
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledOnce();
    expect(renderer.preparePrepackedAnnotationFineViews).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!(performance.now() + 8);

    await expect(admission).resolves.toBe('admitted');
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledOnce();
    expect(renderer.preparePrepackedAnnotationFineViews).toHaveBeenCalledOnce();
    expect(renderer.admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledOnce();
    expect(phases.map(({ phase }) => phase)).toEqual([
      'enqueued',
      'scheduled',
      'post-present-entered',
      'scene-prepared',
      'scheduled',
    ]);
    expect(phases[2]?.detail.queueDelayMs).toEqual(expect.any(Number));
    expect(phases[3]?.detail).toEqual(
      expect.objectContaining({ durationMs: expect.any(Number), prepared: true })
    );
  });

  it('forwards the absolute fine deadline and requeues pending work before admission', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const preparePrepackedAnnotationFineViews = vi
      .fn()
      .mockImplementationOnce(() => {
        now = 11;
        return { status: 'prepared', preparedOwnerKey: null, pendingOwnerCount: 1 };
      })
      .mockImplementationOnce(() => fineComplete());
    const renderer = { ...detailRenderer(), preparePrepackedAnnotationFineViews };
    const scheduled: Array<(deadlineMs: number) => void> = [];
    const admission = scheduleViewportDetailRendererAdmissionV1({
      renderer,
      loadInput: { metadata: { themeMode: 'dark' } } as never,
      finePrewarmRange: { startBp: 100, endBp: 200 },
      handle: {
        getLinearRenderer: () => renderer,
        schedulePostPresentWork: (work) => scheduled.push(work),
      },
      cancelled: () => false,
    });
    try {
      scheduled.shift()!(5);
      await Promise.resolve();
      scheduled.shift()!(10);
      expect(preparePrepackedAnnotationFineViews).toHaveBeenCalledExactlyOnceWith(
        100,
        200,
        'dark',
        10
      );
      expect(renderer.admitPrepackedAnnotationViewportDetailRoster).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(scheduled).toHaveLength(1);
      scheduled.shift()!(20);
      await expect(admission).resolves.toBe('admitted');
      expect(preparePrepackedAnnotationFineViews).toHaveBeenLastCalledWith(100, 200, 'dark', 20);
      expect(renderer.admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('completes the legacy timeout fallback with one fine preparation call per timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
    let prepared = 0;
    const preparePrepackedAnnotationFineViews = vi.fn(
      (_start: number, _end: number, _theme: string, deadlineMs = Number.POSITIVE_INFINITY) => {
        if (performance.now() < deadlineMs) prepared += 1;
        return prepared >= 2
          ? fineComplete()
          : { status: 'prepared' as const, preparedOwnerKey: null, pendingOwnerCount: 1 };
      }
    );
    const renderer = { ...detailRenderer(), preparePrepackedAnnotationFineViews };
    const admission = scheduleViewportDetailRendererAdmissionV1({
      renderer,
      loadInput: { metadata: { themeMode: 'light' } } as never,
      finePrewarmRange: { startBp: 100, endBp: 200 },
      handle: { getLinearRenderer: () => renderer },
      cancelled: () => false,
    });
    try {
      await vi.runOnlyPendingTimersAsync();
      expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledOnce();
      expect(preparePrepackedAnnotationFineViews).not.toHaveBeenCalled();
      await vi.runOnlyPendingTimersAsync();
      expect(preparePrepackedAnnotationFineViews).toHaveBeenCalledExactlyOnceWith(
        100,
        200,
        'light',
        undefined
      );
      expect(renderer.admitPrepackedAnnotationViewportDetailRoster).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      await vi.runOnlyPendingTimersAsync();
      await expect(admission).resolves.toBe('admitted');
      expect(preparePrepackedAnnotationFineViews).toHaveBeenCalledTimes(2);
      expect(renderer.admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      clock.mockRestore();
    }
  });

  it('runs each admission slice through the exact registered renderer queue', async () => {
    const renderer = detailRenderer();
    const instanceId = 'viewport-detail-registered-renderer';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const scheduled: Array<{
      work: (deadlineMs: number) => void;
      onDropped: (reason: 'teardown' | 'fatal-frame-circuit') => void;
    }> = [];
    registerWebGLInstance({
      instanceId,
      createdAt: 1,
      containerRef: { current: container },
      appRef: { current: { destroyed: false } as never },
      rendererRef: { current: renderer },
      stateRef: { current: {} as never },
      visibleRef: { current: true },
      genomeRef: { current: null },
      frameCountRef: { current: 1 },
      lastFrameTRef: { current: 1 },
      fatalFrameCircuitRef: { current: null },
      schedulePostPresentWork: (work, onDropped) => scheduled.push({ work, onDropped }),
    });
    const currentHandle = {
      getLinearRenderer: () => renderer,
      schedulePostPresentWork: vi.fn(),
    };
    const admission = scheduleViewportDetailRendererAdmissionV1({
      renderer,
      loadInput: { metadata: { themeMode: 'light' } } as never,
      finePrewarmRange: { startBp: 100, endBp: 200 },
      handle: currentHandle,
      resolveCurrentHandle: () => currentHandle,
      cancelled: () => false,
    });

    expect(scheduled).toHaveLength(1);
    scheduled.shift()!.work(performance.now() + 8);
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!.work(performance.now() + 8);

    await expect(admission).resolves.toBe('admitted');
    expect(currentHandle.schedulePostPresentWork).not.toHaveBeenCalled();
    unregisterWebGLInstance(instanceId);
    container.remove();
  });

  it('preserves registered admission work until a hidden renderer becomes visible', async () => {
    const renderer = detailRenderer();
    const instanceId = 'viewport-detail-hidden-renderer';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const visibleRef = { current: false };
    const scheduled: Array<{
      work: (deadlineMs: number) => void;
      onDropped: (reason: 'teardown' | 'fatal-frame-circuit') => void;
    }> = [];
    registerWebGLInstance({
      instanceId,
      createdAt: 1,
      containerRef: { current: container },
      appRef: { current: { destroyed: false } as never },
      rendererRef: { current: renderer },
      stateRef: { current: {} as never },
      visibleRef,
      genomeRef: { current: null },
      frameCountRef: { current: 1 },
      lastFrameTRef: { current: 1 },
      fatalFrameCircuitRef: { current: null },
      schedulePostPresentWork: (work, onDropped) => scheduled.push({ work, onDropped }),
    });
    const currentHandle = {
      getLinearRenderer: () => renderer,
      schedulePostPresentWork: vi.fn(),
    };
    const admission = scheduleViewportDetailRendererAdmissionV1({
      renderer,
      loadInput: { metadata: { themeMode: 'light' } } as never,
      finePrewarmRange: { startBp: 100, endBp: 200 },
      handle: currentHandle,
      resolveCurrentHandle: () => currentHandle,
      cancelled: () => false,
    });

    expect(scheduled).toHaveLength(1);
    expect(renderer.preparePrepackedAnnotationScene).not.toHaveBeenCalled();
    visibleRef.current = true;
    scheduled.shift()!.work(performance.now() + 8);
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!.work(performance.now() + 8);

    await expect(admission).resolves.toBe('admitted');
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledOnce();
    expect(renderer.admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledOnce();
    expect(currentHandle.schedulePostPresentWork).not.toHaveBeenCalled();
    unregisterWebGLInstance(instanceId);
    container.remove();
  });

  it('settles registered admission work when its renderer mount tears down', async () => {
    const renderer = detailRenderer();
    const instanceId = 'viewport-detail-dropped-renderer';
    const container = document.createElement('div');
    document.body.appendChild(container);
    let drop!: (reason: 'teardown' | 'fatal-frame-circuit') => void;
    registerWebGLInstance({
      instanceId,
      createdAt: 1,
      containerRef: { current: container },
      appRef: { current: { destroyed: false } as never },
      rendererRef: { current: renderer },
      stateRef: { current: {} as never },
      visibleRef: { current: true },
      genomeRef: { current: null },
      frameCountRef: { current: 1 },
      lastFrameTRef: { current: 1 },
      fatalFrameCircuitRef: { current: null },
      schedulePostPresentWork: (_work, onDropped) => {
        drop = onDropped;
      },
    });
    const handle = { getLinearRenderer: () => renderer, schedulePostPresentWork: vi.fn() };
    const admission = scheduleViewportDetailRendererAdmissionV1({
      renderer,
      loadInput: { metadata: { themeMode: 'light' } } as never,
      finePrewarmRange: { startBp: 100, endBp: 200 },
      handle,
      resolveCurrentHandle: () => handle,
      cancelled: () => false,
    });

    drop('teardown');

    await expect(admission).resolves.toBe('staged-renderer-changed');
    expect(handle.schedulePostPresentWork).not.toHaveBeenCalled();
    unregisterWebGLInstance(instanceId);
    container.remove();
  });
});

function fineComplete() {
  return {
    status: 'complete' as const,
    preparedOwnerKey: 'annotation-owner',
    pendingOwnerCount: 0,
  };
}

function detailRenderer() {
  return {
    preparePrepackedAnnotationScene: vi.fn(() => true),
    preparePrepackedAnnotationFineViews: vi.fn(() => fineComplete()),
    admitPrepackedAnnotationViewportDetailRoster: vi.fn(() => true),
  };
}

function descriptor() {
  return {
    request: {
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      chromosomes: [{ chrom: 'chr1', length: GENOME_LENGTH_BP, sourcePath: '/workspace/a.gff' }],
      scope: {
        kind: 'complete-assembly',
        placements: [{ chrom: 'chr1', length: GENOME_LENGTH_BP, annotationCoverage: 'sourced' }],
      },
      datasetContract: {
        datasetId: 'fixture',
        datasetVersion: '1',
        sourceSha256: 'e'.repeat(64),
      },
      artifact: {
        artifactKey: 'fixture-dark',
        themeMode: 'dark',
        trackType: 'enhancer',
        partitionSpanBp: 100_000_000,
      },
      requestedPolicy: { isoformMode: 'expanded', laneLimit: null },
    },
  };
}

function interactionAuthority() {
  return {
    sourceFingerprint: 'd'.repeat(24),
    interactionPayloadSha256: '9'.repeat(64),
    sourceScene: {
      byteCount: SOURCE_BYTES,
      payloadSha256: SOURCE_PAYLOAD_SHA256,
      contractSha256: SOURCE_CONTRACT_SHA256,
    },
    featureLookup: { featureCount: 1 },
    policyProjection: { features: [] },
    metadata: { trackType: 'enhancer', themeMode: 'dark', genomeLengthBp: GENOME_LENGTH_BP },
  };
}

function detailResult() {
  return {
    contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
    status: 'hit' as const,
    fingerprint: 'd'.repeat(24),
    sourceBuildFingerprint: 'f'.repeat(64),
    scope: descriptor().request.scope,
    artifact: descriptor().request.artifact,
    byteCount: 4,
    manifest: {
      sourceScene: {
        byteLength: SOURCE_BYTES,
        payloadSha256: SOURCE_PAYLOAD_SHA256,
        contractSha256: SOURCE_CONTRACT_SHA256,
      },
      families: [{ id: 'annotation', kind: 'box', metadata: {} }],
      integrity: { payloadSha256: PACKET_PAYLOAD_SHA256 },
    },
    payload: new Uint8Array([1, 2, 3, 4]),
  };
}

describe('queued viewport detail cancellation recovery', () => {
  beforeEach(() => {
    readDetail.mockReset().mockResolvedValue(detailResult());
    unpackDetail.mockReset().mockResolvedValue({
      scene: { partitionSpanBp: 100_000_000, sortedPrimitives: [] },
      submissionBank: { expanded: {}, canonical: {} },
      submissionFineIndices: { expanded: {}, canonical: {} },
      featureFamilyIndices: new Uint32Array([0]),
      empty: false,
      rendererAdmissionCapability: {},
    });
    bindInteraction.mockReset().mockReturnValue({
      interactionIndex: { featureCount: 1, primitiveCount: 0 },
      rendererAdmissionCapability: {},
    });
  });

  function queuedAdmission() {
    const renderer = detailRenderer();
    let currentRenderer: ReturnType<typeof detailRenderer> | null = renderer;
    const postPresentQueue: Array<(deadlineMs: number) => void> = [];
    const recordEvent = vi.fn();
    const onRendererAdmission = vi.fn();
    const initialProps = {
      enabled: true,
      currentDescriptor: { ...descriptor(), runtimeCacheKey: 'queued-original-source' } as
        | (ReturnType<typeof descriptor> & { runtimeCacheKey: string })
        | null,
      authority: interactionAuthority() as ReturnType<typeof interactionAuthority> | null,
    };
    const webglRef = {
      current: {
        getViewportRange: () => ({ start: 500_000_000, end: 501_000_000 }),
        getLinearRenderer: () => currentRenderer,
        requestRender: vi.fn(),
        schedulePostPresentWork: (work: (deadlineMs: number) => void) => {
          postPresentQueue.push(work);
        },
      },
    };
    const hook = renderHook(
      ({ enabled, currentDescriptor, authority }) =>
        useAssemblyAnnotationViewportDetail({
          enabled,
          descriptor: currentDescriptor as never,
          expectedInteractionOwnerKey: 'annotation-owner',
          interactionAuthority: authority as never,
          policy: { isoformMode: 'expanded', laneLimit: null },
          recordEvent,
          onRendererAdmission,
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          webglRef: webglRef as never,
        }),
      { initialProps }
    );
    return {
      ...hook,
      renderer,
      postPresentQueue,
      recordEvent,
      onRendererAdmission,
      initialProps,
      setCurrentRenderer: (value: typeof currentRenderer) => {
        currentRenderer = value;
      },
    };
  }

  it('retries a current packet after a transient queued cancellation without refetching', async () => {
    const state = queuedAdmission();
    try {
      await waitFor(() => expect(state.postPresentQueue).toHaveLength(1));
      await act(async () => {
        state.setCurrentRenderer(null);
        state.postPresentQueue.shift()!(Number.POSITIVE_INFINITY);
        state.setCurrentRenderer(state.renderer);
        await Promise.resolve();
      });
      expect(state.recordEvent).toHaveBeenCalledWith(
        'annotation-viewport-detail-renderer-admission-staged',
        expect.objectContaining({ admission: 'staged-cancelled', invalidReason: null })
      );
      await waitFor(() => expect(state.postPresentQueue).toHaveLength(1), { timeout: 150 });
      await act(async () => {
        state.postPresentQueue.shift()!(Number.POSITIVE_INFINITY);
        await Promise.resolve();
      });
      await waitFor(() => expect(state.postPresentQueue).toHaveLength(1));
      await act(async () => {
        state.postPresentQueue.shift()!(Number.POSITIVE_INFINITY);
        await Promise.resolve();
      });
      await waitFor(() => expect(state.result.current.receipt.status).toBe('loaded'));
      expect(readDetail).toHaveBeenCalledOnce();
      expect(unpackDetail).toHaveBeenCalledOnce();
      expect(state.renderer.preparePrepackedAnnotationScene).toHaveBeenCalledOnce();
      expect(state.renderer.admitPrepackedAnnotationViewportDetailRoster).toHaveBeenCalledOnce();
      expect(state.onRendererAdmission).toHaveBeenCalledOnce();
    } finally {
      state.unmount();
    }
  });

  it.each(['disabled', 'source-superseded', 'not-current'] as const)(
    'does not admit queued work while %s',
    async (guard) => {
      const state = queuedAdmission();
      try {
        await waitFor(() => expect(state.postPresentQueue).toHaveLength(1));
        if (guard === 'source-superseded') {
          readDetail.mockImplementationOnce(() => new Promise(() => undefined));
        }
        state.rerender({
          ...state.initialProps,
          ...(guard === 'disabled' ? { enabled: false } : {}),
          ...(guard === 'source-superseded'
            ? {
                currentDescriptor: {
                  ...state.initialProps.currentDescriptor!,
                  runtimeCacheKey: 'queued-replacement-source',
                },
              }
            : {}),
          ...(guard === 'not-current' ? { authority: null } : {}),
        });
        if (guard === 'source-superseded') {
          await waitFor(() => expect(readDetail).toHaveBeenCalledTimes(2));
        }
        await act(async () => {
          state.postPresentQueue.shift()!(Number.POSITIVE_INFINITY);
          await Promise.resolve();
        });
        expect(state.result.current.receipt.status).not.toBe('loaded');
        expect(readDetail).toHaveBeenCalledTimes(guard === 'source-superseded' ? 2 : 1);
        expect(state.renderer.preparePrepackedAnnotationScene).not.toHaveBeenCalled();
        expect(state.renderer.admitPrepackedAnnotationViewportDetailRoster).not.toHaveBeenCalled();
        expect(state.onRendererAdmission).not.toHaveBeenCalled();
        expect(state.postPresentQueue).toHaveLength(0);
      } finally {
        state.unmount();
      }
    }
  );
});
