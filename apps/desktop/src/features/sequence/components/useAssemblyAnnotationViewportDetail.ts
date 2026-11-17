import { useCallback, useEffect, useRef, useState } from 'react';

import {
  PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1,
  PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP,
  scheduleWebGLPostPresentWorkForRenderer,
  type CompiledBroadAnnotationInteractionLoadInputV1,
  type PrepackedAnnotationFinePreparationResult,
  type PrepackedAnnotationSceneLoadInput,
} from '@waypoint/genome-renderer';
import { authenticateAnnotationViewportDetailPayloadV1 } from '../annotation-viewport-detail-auth-worker-runtime';
import {
  bindTrustedPartitionedTranscriptSceneDetailInteractionV1,
  compiledBroadSurfaceHandoffSpanBpV2,
  unpackPartitionedTranscriptSceneDetailPacketV1,
} from '@waypoint/genome-renderer/pure';

import { platform } from '../../../platform';
import {
  ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
  type AssemblyAnnotationSceneDetailHitResultV1,
  type AssemblyAnnotationSceneDetailReadRequestV1,
} from '../../../shared/indexed-genome';
import type { AssemblyPrepackedAnnotationSceneDescriptor } from '../assembly-annotation-product-descriptor';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { readNullableAuthorityUntilPublishedV1 } from './awaitNullableAuthorityPublication';

const DETAIL_PREFETCH_MAX_VISIBLE_BP = 64 * 1024 * 1024;
const DETAIL_CORRIDOR_MIN_BP = 256 * 1024 * 1024;
const DETAIL_CORRIDOR_MAX_BP = 256 * 1024 * 1024;
const DETAIL_CORRIDOR_ALIGNMENT_BP = 16 * 1024 * 1024;
const DETAIL_PREFETCH_LEAD_MULTIPLIER = 32;
const DETAIL_PUBLICATION_DEADLINE_MS = 120_000;

export function assemblyAnnotationBroadHandoffSpanBpV1(input: {
  readonly genomeLengthBp: number;
  readonly broadCorridorFinestSpanBp: number;
  readonly viewportCssWidthPx: number;
  readonly devicePixelRatio: number;
}): number {
  return compiledBroadSurfaceHandoffSpanBpV2(input);
}

export function assemblyAnnotationDetailPrefetchTriggerSpanBpV1(input: {
  readonly genomeLengthBp: number;
  readonly broadCorridorFinestSpanBp: number;
  readonly viewportCssWidthPx: number;
  readonly devicePixelRatio: number;
}): number {
  const broadHandoffSpanBp = assemblyAnnotationBroadHandoffSpanBpV1(input);
  return Math.min(
    input.genomeLengthBp,
    Math.max(DETAIL_CORRIDOR_MAX_BP, broadHandoffSpanBp * DETAIL_PREFETCH_LEAD_MULTIPLIER)
  );
}

export function assemblyAnnotationDetailUsesWholeSceneV1(input: {
  readonly completeAssemblyDetailEnabled: boolean;
  readonly genomeLengthBp: number | null;
  readonly broadHandoffSpanBp: number | undefined;
}): boolean {
  return (
    input.completeAssemblyDetailEnabled &&
    input.genomeLengthBp !== null &&
    input.genomeLengthBp > 0 &&
    input.broadHandoffSpanBp !== undefined &&
    input.broadHandoffSpanBp >= input.genomeLengthBp
  );
}

export type AssemblyAnnotationViewportDetailReadiness =
  | 'not-applicable'
  | 'waiting-camera'
  | 'waiting-interaction'
  | 'loading'
  | 'loaded'
  | 'unavailable'
  | 'error';

export interface AssemblyAnnotationViewportDetailReceiptV1 {
  readonly status: AssemblyAnnotationViewportDetailReadiness;
  readonly ownerKey: string | null;
  readonly coverageStartBp: number | null;
  readonly coverageEndBp: number | null;
  readonly payloadBytes: number | null;
  readonly error: unknown | null;
}

export interface AssemblyAnnotationDetailCorridorV1 {
  readonly startBp: number;
  readonly endBp: number;
  readonly handoffStartBp: number;
  readonly handoffEndBp: number;
  readonly focusBp: number;
  readonly key: string;
}

export interface AssemblyAnnotationFinePrewarmRangeV1 {
  readonly startBp: number;
  readonly endBp: number;
}

export function planAssemblyAnnotationFinePrewarmRangeV1(input: {
  readonly focusBp: number;
  readonly genomeLengthBp: number;
}): AssemblyAnnotationFinePrewarmRangeV1 {
  const genomeLengthBp = Math.max(1, Math.floor(input.genomeLengthBp));
  const spanBp = Math.min(genomeLengthBp, PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP);
  const focusBp = Math.max(0, Math.min(genomeLengthBp, input.focusBp));
  const startBp = Math.max(0, Math.min(genomeLengthBp - spanBp, Math.floor(focusBp - spanBp / 2)));
  return Object.freeze({ startBp, endBp: startBp + spanBp });
}

export function inferAssemblyAnnotationZoomAnchorBpV1(input: {
  readonly previousStartBp: number;
  readonly previousEndBp: number;
  readonly currentStartBp: number;
  readonly currentEndBp: number;
  readonly genomeLengthBp: number;
}): number | null {
  const previousSpanBp = input.previousEndBp - input.previousStartBp;
  const currentSpanBp = input.currentEndBp - input.currentStartBp;
  if (
    !Number.isFinite(previousSpanBp) ||
    !Number.isFinite(currentSpanBp) ||
    previousSpanBp <= 0 ||
    currentSpanBp <= 0 ||
    !Number.isFinite(input.genomeLengthBp) ||
    input.genomeLengthBp <= 0
  ) {
    return null;
  }
  const scale = currentSpanBp / previousSpanBp;
  const divisor = 1 - scale;
  if (!Number.isFinite(scale) || Math.abs(divisor) < 1e-7) return null;
  const fromStart = (input.currentStartBp - scale * input.previousStartBp) / divisor;
  const fromEnd = (input.currentEndBp - scale * input.previousEndBp) / divisor;
  const anchorBp = (fromStart + fromEnd) / 2;
  if (!Number.isFinite(anchorBp)) return null;
  const epsilonBp = Math.max(1, input.genomeLengthBp * Number.EPSILON * 8);
  const insidePrevious =
    anchorBp >= input.previousStartBp - epsilonBp && anchorBp <= input.previousEndBp + epsilonBp;
  const insideCurrent =
    anchorBp >= input.currentStartBp - epsilonBp && anchorBp <= input.currentEndBp + epsilonBp;
  if (!insidePrevious || !insideCurrent) return null;
  return Math.max(0, Math.min(input.genomeLengthBp, anchorBp));
}

const EMPTY_RECEIPT: AssemblyAnnotationViewportDetailReceiptV1 = Object.freeze({
  status: 'not-applicable',
  ownerKey: null,
  coverageStartBp: null,
  coverageEndBp: null,
  payloadBytes: null,
  error: null,
});

export function planAssemblyAnnotationDetailCorridorV1(input: {
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly genomeLengthBp: number;
  readonly prefetchTriggerSpanBp?: number;
  readonly broadHandoffSpanBp?: number;
  readonly corridorCenterBp?: number;
}): AssemblyAnnotationDetailCorridorV1 | null {
  const start = Math.max(0, Math.floor(input.viewportStartBp));
  const end = Math.min(input.genomeLengthBp, Math.ceil(input.viewportEndBp));
  const visibleBp = end - start;
  if (
    !Number.isSafeInteger(input.genomeLengthBp) ||
    input.genomeLengthBp <= 0 ||
    visibleBp <= 0 ||
    visibleBp >
      (input.prefetchTriggerSpanBp ?? input.broadHandoffSpanBp ?? DETAIL_PREFETCH_MAX_VISIBLE_BP)
  ) {
    return null;
  }
  const requestedCenter = input.corridorCenterBp;
  const center =
    typeof requestedCenter === 'number' && Number.isFinite(requestedCenter)
      ? Math.max(0, Math.min(input.genomeLengthBp, requestedCenter))
      : (start + end) / 2;
  if (input.prefetchTriggerSpanBp !== undefined) {
    const successorVisibleBp = Math.min(
      input.genomeLengthBp,
      Math.max(1, input.broadHandoffSpanBp ?? DETAIL_PREFETCH_MAX_VISIBLE_BP)
    );
    const scale = successorVisibleBp / visibleBp;
    let handoffStartBp = Math.floor(center + (start - center) * scale);
    let handoffEndBp = Math.ceil(center + (end - center) * scale);
    if (handoffStartBp < 0) {
      handoffEndBp -= handoffStartBp;
      handoffStartBp = 0;
    }
    if (handoffEndBp > input.genomeLengthBp) {
      handoffStartBp -= handoffEndBp - input.genomeLengthBp;
      handoffEndBp = input.genomeLengthBp;
    }
    handoffStartBp = Math.max(0, handoffStartBp);
    handoffEndBp = Math.min(input.genomeLengthBp, handoffEndBp);
    const corridorSpan = Math.min(
      input.genomeLengthBp,
      Math.max(DETAIL_CORRIDOR_MIN_BP, handoffEndBp - handoffStartBp)
    );
    const handoffCenterBp = (handoffStartBp + handoffEndBp) / 2;
    let corridorStart =
      Math.round((handoffCenterBp - corridorSpan / 2) / DETAIL_CORRIDOR_ALIGNMENT_BP) *
      DETAIL_CORRIDOR_ALIGNMENT_BP;
    corridorStart = Math.max(0, Math.min(corridorStart, input.genomeLengthBp - corridorSpan));
    const corridorEnd = corridorStart + corridorSpan;
    return Object.freeze({
      startBp: corridorStart,
      endBp: corridorEnd,
      handoffStartBp,
      handoffEndBp,
      focusBp: center,
      key: `${corridorStart}:${corridorEnd}`,
    });
  }
  const handoffSpanBp = Math.min(
    input.genomeLengthBp,
    Math.max(1, Math.ceil(input.broadHandoffSpanBp ?? visibleBp))
  );
  const handoffStartBp = Math.max(
    0,
    Math.min(input.genomeLengthBp - handoffSpanBp, Math.floor(center - handoffSpanBp / 2))
  );
  const handoffEndBp = handoffStartBp + handoffSpanBp;
  const corridorSpan = Math.min(
    input.genomeLengthBp,
    Math.max(
      handoffSpanBp,
      Math.min(DETAIL_CORRIDOR_MAX_BP, Math.max(DETAIL_CORRIDOR_MIN_BP, visibleBp * 4))
    )
  );
  let corridorStart =
    Math.floor((center - corridorSpan / 2) / DETAIL_CORRIDOR_ALIGNMENT_BP) *
    DETAIL_CORRIDOR_ALIGNMENT_BP;
  corridorStart = Math.max(0, Math.min(corridorStart, input.genomeLengthBp - corridorSpan));
  const corridorEnd = Math.min(input.genomeLengthBp, corridorStart + corridorSpan);
  return Object.freeze({
    startBp: corridorStart,
    endBp: corridorEnd,
    handoffStartBp,
    handoffEndBp,
    focusBp: center,
    key: `${corridorStart}:${corridorEnd}`,
  });
}

type DetailRenderer = {
  preparePrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean;
  preparePrepackedAnnotationFineViews(
    viewportStartBp: number,
    viewportEndBp: number,
    themeMode?: 'light' | 'dark',
    deadlineMs?: number
  ): PrepackedAnnotationFinePreparationResult;
  admitPrepackedAnnotationViewportDetailRoster(
    viewportStartBp: number,
    viewportEndBp: number,
    themeMode?: 'light' | 'dark'
  ): boolean;
};

type UnpackedViewportDetailPacketV1 = Awaited<
  ReturnType<typeof unpackPartitionedTranscriptSceneDetailPacketV1>
>;

type PreparedViewportDetailPacketV1 = Readonly<{
  corridor: AssemblyAnnotationDetailCorridorV1;
  result: AssemblyAnnotationSceneDetailHitResultV1;
  unpacked: UnpackedViewportDetailPacketV1;
  requestGeneration: number;
  startedAt: number;
}>;

export function useAssemblyAnnotationViewportDetail(input: {
  readonly enabled: boolean;
  readonly descriptor: AssemblyPrepackedAnnotationSceneDescriptor | null;
  readonly expectedInteractionOwnerKey: string | null;
  readonly interactionAuthority: CompiledBroadAnnotationInteractionLoadInputV1 | null;
  readonly policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
  readonly detailPrefetchTriggerSpanBp?: number;
  readonly detailBroadHandoffSpanBp?: number;
  readonly onRendererAdmission?: () => void;
  readonly recordEvent?: (event: string, detail?: Record<string, unknown>) => void;
  readonly rendererReadyEpoch: number;
  readonly rendererGenomeCommitEpoch: number;
  readonly rendererAdmissionEpoch?: number;
  readonly webglRef: {
    readonly current:
      | (Pick<IndexedGenomeTileNativeMapHandle, 'getLinearRenderer' | 'getViewportRange'> &
          Partial<
            Pick<IndexedGenomeTileNativeMapHandle, 'requestRender' | 'schedulePostPresentWork'>
          >)
      | null;
  };
}): Readonly<{
  receipt: AssemblyAnnotationViewportDetailReceiptV1;
  notifyCameraChanged: (
    reason?: 'scroll' | 'zoom',
    publishedViewport?: Readonly<{ start: number; end: number }>
  ) => void;
}> {
  const [corridor, setCorridor] = useState<AssemblyAnnotationDetailCorridorV1 | null>(null);
  const [receipt, setReceipt] = useState<AssemblyAnnotationViewportDetailReceiptV1>(EMPTY_RECEIPT);
  const [rendererAdmissionRetryEpoch, setRendererAdmissionRetryEpoch] = useState(0);
  const corridorKeyRef = useRef<string | null>(null);
  const corridorRef = useRef<AssemblyAnnotationDetailCorridorV1 | null>(null);
  const previousViewportRef = useRef<Readonly<{ start: number; end: number }> | null>(null);
  const zoomAnchorBpRef = useRef<number | null>(null);
  const requestGenerationRef = useRef(0);
  const activeDetailRequestRef = useRef<{
    requestGeneration: number;
    controller: AbortController;
  } | null>(null);
  const publishedAdmissionIdentityRef = useRef<string | null>(null);
  const preparedPacketRef = useRef<PreparedViewportDetailPacketV1 | null>(null);
  const rendererAdmissionAttemptRef = useRef<{
    requestGeneration: number;
    ownerKey: string;
    interactionAuthority: CompiledBroadAnnotationInteractionLoadInputV1;
    token: symbol;
  } | null>(null);
  const admittedPacketIdentityRef = useRef<{
    requestGeneration: number;
    ownerKey: string;
    interactionAuthority: CompiledBroadAnnotationInteractionLoadInputV1;
  } | null>(null);
  const latestAdmissionInputRef = useRef(input);
  latestAdmissionInputRef.current = input;
  const liveDescriptorKey = input.descriptor?.sceneKey ?? input.descriptor?.runtimeCacheKey ?? null;
  const descriptorSnapshotRef = useRef<{
    key: string | null;
    descriptor: AssemblyPrepackedAnnotationSceneDescriptor | null;
  }>({ key: liveDescriptorKey, descriptor: input.descriptor });
  if (!input.enabled) {
    descriptorSnapshotRef.current = { key: null, descriptor: null };
  } else if (
    liveDescriptorKey !== null &&
    descriptorSnapshotRef.current.key !== liveDescriptorKey
  ) {
    descriptorSnapshotRef.current = { key: liveDescriptorKey, descriptor: input.descriptor };
  }
  const descriptor = descriptorSnapshotRef.current.descriptor;
  const descriptorGenomeLengthBp = descriptor?.request.scope.placements.reduce(
    (total, placement) => total + placement.length,
    0
  );
  const genomeLengthBp =
    input.interactionAuthority?.metadata.genomeLengthBp ??
    (descriptorGenomeLengthBp && Number.isSafeInteger(descriptorGenomeLengthBp)
      ? descriptorGenomeLengthBp
      : null);

  const notifyCameraChanged = useCallback(
    (
      reason?: 'scroll' | 'zoom',
      publishedViewport?: Readonly<{ start: number; end: number }>,
      publishedZoomAnchorBp?: number | null
    ) => {
      const range = publishedViewport ?? input.webglRef.current?.getViewportRange?.() ?? null;
      if (!range || genomeLengthBp === null) return;
      const previousRange = previousViewportRef.current;
      previousViewportRef.current = { start: range.start, end: range.end };
      if (reason === 'zoom' && previousRange) {
        const previousSpanBp = previousRange.end - previousRange.start;
        const currentSpanBp = range.end - range.start;
        const rangesOverlap = range.start < previousRange.end && range.end > previousRange.start;
        if (currentSpanBp > previousSpanBp && rangesOverlap) {
          zoomAnchorBpRef.current = null;
          const broadHandoffSpanBp =
            input.detailBroadHandoffSpanBp ?? DETAIL_PREFETCH_MAX_VISIBLE_BP;
          const currentCorridor = corridorRef.current;
          const currentCorridorRemainsUseful = Boolean(
            currentSpanBp <= broadHandoffSpanBp &&
            currentCorridor &&
            currentCorridor.startBp <= range.start &&
            currentCorridor.endBp >= range.end
          );
          if (!currentCorridorRemainsUseful) {
            const activeRequest = activeDetailRequestRef.current;
            if (activeRequest) {
              requestGenerationRef.current += 1;
              activeDetailRequestRef.current = null;
              activeRequest.controller.abort();
              rendererAdmissionAttemptRef.current = null;
              preparedPacketRef.current = null;
              corridorKeyRef.current = null;
              corridorRef.current = null;
              setCorridor(null);
              setReceipt({
                status: 'waiting-camera',
                ownerKey: input.expectedInteractionOwnerKey,
                coverageStartBp: null,
                coverageEndBp: null,
                payloadBytes: null,
                error: null,
              });
              input.recordEvent?.('annotation-viewport-detail-request-revoked', {
                reason: 'zoom-out',
                requestGeneration: activeRequest.requestGeneration,
                previousSpanBp,
                currentSpanBp,
              });
            }
            if (currentSpanBp > broadHandoffSpanBp) return;
          }
        } else {
          const inferredAnchorBp =
            publishedZoomAnchorBp === null
              ? null
              : typeof publishedZoomAnchorBp === 'number' && Number.isFinite(publishedZoomAnchorBp)
                ? Math.max(0, Math.min(genomeLengthBp, publishedZoomAnchorBp))
                : inferAssemblyAnnotationZoomAnchorBpV1({
                    previousStartBp: previousRange.start,
                    previousEndBp: previousRange.end,
                    currentStartBp: range.start,
                    currentEndBp: range.end,
                    genomeLengthBp,
                  });
          zoomAnchorBpRef.current = inferredAnchorBp;
        }
      }
      const visibleBp = range.end - range.start;
      const zoomIntentCenterBp = reason === 'zoom' ? zoomAnchorBpRef.current : null;
      const planned = planAssemblyAnnotationDetailCorridorV1({
        viewportStartBp: range.start,
        viewportEndBp: range.end,
        genomeLengthBp,
        ...(reason === 'zoom' && input.detailPrefetchTriggerSpanBp
          ? { prefetchTriggerSpanBp: input.detailPrefetchTriggerSpanBp }
          : {}),
        ...(input.detailBroadHandoffSpanBp
          ? { broadHandoffSpanBp: input.detailBroadHandoffSpanBp }
          : {}),
        ...(zoomIntentCenterBp === null ? {} : { corridorCenterBp: zoomIntentCenterBp }),
      });
      const current = corridorRef.current;
      if (!planned) return;
      const currentCoversViewport =
        reason !== 'zoom' &&
        current !== null &&
        current.startBp <= range.start &&
        current.endBp >= range.end;
      if (currentCoversViewport) return;
      const nextKey = planned?.key ?? null;
      if (corridorKeyRef.current === nextKey) {
        corridorRef.current = planned;
        return;
      }
      input.recordEvent?.('annotation-viewport-detail-corridor-selected', {
        reason: reason ?? 'mount',
        visibleBp,
        publishedViewport: publishedViewport !== undefined,
        previousViewportStartBp: previousRange?.start ?? null,
        previousViewportEndBp: previousRange?.end ?? null,
        viewportStartBp: range.start,
        viewportEndBp: range.end,
        previousCorridorKey: corridorKeyRef.current,
        corridorKey: nextKey,
        corridorStartBp: planned.startBp,
        corridorEndBp: planned.endBp,
        handoffStartBp: planned.handoffStartBp,
        handoffEndBp: planned.handoffEndBp,
        zoomAnchorBp: zoomIntentCenterBp,
      });
      corridorKeyRef.current = nextKey;
      corridorRef.current = planned;
      setCorridor(planned);
    },
    [
      genomeLengthBp,
      input.detailBroadHandoffSpanBp,
      input.detailPrefetchTriggerSpanBp,
      input.expectedInteractionOwnerKey,
      input.recordEvent,
      input.webglRef,
    ]
  );

  useEffect(() => {
    notifyCameraChanged();
  }, [input.rendererGenomeCommitEpoch, input.rendererReadyEpoch, notifyCameraChanged]);

  const attemptPreparedPacketAdmission = useCallback(
    (packet: PreparedViewportDetailPacketV1): void => {
      const latest = latestAdmissionInputRef.current;
      const ownerKey = latest.expectedInteractionOwnerKey;
      const authority = latest.interactionAuthority;
      const admitted = admittedPacketIdentityRef.current;
      const attempt = rendererAdmissionAttemptRef.current;
      if (
        !latest.enabled ||
        preparedPacketRef.current?.requestGeneration !== packet.requestGeneration ||
        (ownerKey !== null &&
          authority !== null &&
          admitted?.requestGeneration === packet.requestGeneration &&
          admitted.ownerKey === ownerKey &&
          admitted.interactionAuthority === authority) ||
        (ownerKey !== null &&
          authority !== null &&
          attempt?.requestGeneration === packet.requestGeneration &&
          attempt.ownerKey === ownerKey &&
          attempt.interactionAuthority === authority)
      ) {
        return;
      }
      if (!ownerKey || !authority) {
        setReceipt({
          status: 'waiting-interaction',
          ownerKey,
          coverageStartBp: packet.corridor.startBp,
          coverageEndBp: packet.corridor.endBp,
          payloadBytes: packet.result.payload.byteLength,
          error: null,
        });
        return;
      }
      const { corridor: packetCorridor, result, unpacked, requestGeneration, startedAt } = packet;
      if (
        result.manifest.sourceScene.byteLength !== authority.sourceScene.byteCount ||
        result.manifest.sourceScene.payloadSha256 !== authority.sourceScene.payloadSha256 ||
        result.manifest.sourceScene.contractSha256 !== authority.sourceScene.contractSha256
      ) {
        setReceipt({
          status: 'error',
          ownerKey: latest.expectedInteractionOwnerKey,
          coverageStartBp: packetCorridor.startBp,
          coverageEndBp: packetCorridor.endBp,
          payloadBytes: null,
          error: new Error(
            'The viewport detail packet does not share the raster interaction owner.'
          ),
        });
        return;
      }
      const renderer = latest.webglRef.current?.getLinearRenderer?.() as DetailRenderer | null;
      const handle = latest.webglRef.current;
      if (!renderer || !handle) return;

      const token = Symbol(`annotation-detail-admission-${requestGeneration}`);
      rendererAdmissionAttemptRef.current = {
        requestGeneration,
        ownerKey,
        interactionAuthority: authority,
        token,
      };
      const policyIsoformMode = latest.policy.isoformMode;
      const policyLaneLimit = latest.policy.laneLimit;
      const rendererReadyEpoch = latest.rendererReadyEpoch;
      const rendererGenomeCommitEpoch = latest.rendererGenomeCommitEpoch;
      const invalidReason = (): string | null => {
        const current = latestAdmissionInputRef.current;
        if (!current.enabled) return 'disabled';
        if (current.expectedInteractionOwnerKey !== ownerKey) return 'owner-changed';
        if (current.interactionAuthority !== authority) return 'interaction-authority-changed';
        if (
          current.policy.isoformMode !== policyIsoformMode ||
          current.policy.laneLimit !== policyLaneLimit
        ) {
          return 'policy-changed';
        }
        if (current.rendererReadyEpoch !== rendererReadyEpoch) return 'renderer-ready-changed';
        if (current.rendererGenomeCommitEpoch !== rendererGenomeCommitEpoch) {
          return 'renderer-genome-changed';
        }
        if (preparedPacketRef.current?.requestGeneration !== requestGeneration) {
          return 'packet-superseded';
        }
        if (rendererAdmissionAttemptRef.current?.token !== token) return 'attempt-superseded';
        if (current.webglRef.current?.getLinearRenderer?.() !== renderer) {
          return 'renderer-changed';
        }
        return null;
      };
      const isCurrent = (): boolean => invalidReason() === null;
      latest.recordEvent?.('annotation-viewport-detail-renderer-admission-started', {
        requestGeneration,
        corridorKey: packetCorridor.key,
        elapsedMs: performance.now() - startedAt,
      });

      void (async () => {
        let retryAfterInvalidation = false;
        try {
          const latestCorridor = corridorRef.current;
          const presentationCorridor =
            latestCorridor?.startBp === packetCorridor.startBp &&
            latestCorridor.endBp === packetCorridor.endBp
              ? latestCorridor
              : packetCorridor;
          latestAdmissionInputRef.current.recordEvent?.(
            'annotation-viewport-detail-interaction-bind-started',
            {
              requestGeneration,
              corridorKey: packetCorridor.key,
              elapsedMs: performance.now() - startedAt,
            }
          );
          const interaction = bindTrustedPartitionedTranscriptSceneDetailInteractionV1(
            result.manifest,
            unpacked.scene,
            authority.featureLookup,
            unpacked.rendererAdmissionCapability
          );
          latestAdmissionInputRef.current.recordEvent?.(
            'annotation-viewport-detail-interaction-bound',
            {
              requestGeneration,
              corridorKey: packetCorridor.key,
              elapsedMs: performance.now() - startedAt,
            }
          );
          const loadInput: PrepackedAnnotationSceneLoadInput = {
            ownerKey,
            scene: {
              primitives: [],
              families: [...result.manifest.families],
              featureFamilyIndices: unpacked.featureFamilyIndices,
            },
            gpuReadyScene: unpacked.scene,
            interactionIndex: interaction.interactionIndex,
            policyProjection: authority.policyProjection,
            submissionBank: unpacked.submissionBank,
            submissionFineIndices: unpacked.submissionFineIndices,
            ...(result.colorRoles ? { colorRoles: result.colorRoles } : {}),
            trustedViewportDetailPacketAdmissionV1: unpacked.rendererAdmissionCapability,
            trustedViewportDetailInteractionAdmissionV1: interaction.rendererAdmissionCapability,
            runtimePolicy: { ...latest.policy },
            metadata: authority.metadata,
            viewportDetail: {
              contract: PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1,
              packetPayloadSha256: result.manifest.integrity.payloadSha256,
              sourceFingerprint: authority.sourceFingerprint,
              interactionPayloadSha256: authority.interactionPayloadSha256,
              sourceScene: result.manifest.sourceScene,
              empty: unpacked.empty,
              coverageStartBp: packetCorridor.startBp,
              coverageEndBp: packetCorridor.endBp,
              handoffStartBp: presentationCorridor.handoffStartBp,
              handoffEndBp: presentationCorridor.handoffEndBp,
            },
          };
          const admission = await scheduleViewportDetailRendererAdmissionV1({
            renderer,
            loadInput,
            finePrewarmRange: planAssemblyAnnotationFinePrewarmRangeV1({
              focusBp: presentationCorridor.focusBp,
              genomeLengthBp: authority.metadata.genomeLengthBp,
            }),
            handle,
            resolveCurrentHandle: () => latestAdmissionInputRef.current.webglRef.current,
            cancelled: () => !isCurrent(),
            onPhase: (phase, detail) =>
              latestAdmissionInputRef.current.recordEvent?.(
                `annotation-viewport-detail-renderer-admission-${phase}`,
                {
                  requestGeneration,
                  corridorKey: packetCorridor.key,
                  elapsedMs: performance.now() - startedAt,
                  ...detail,
                }
              ),
          });
          const admissionInvalidReason = invalidReason();
          if (admissionInvalidReason !== null || admission.startsWith('staged-')) {
            latestAdmissionInputRef.current.recordEvent?.(
              'annotation-viewport-detail-renderer-admission-staged',
              {
                requestGeneration,
                corridorKey: packetCorridor.key,
                elapsedMs: performance.now() - startedAt,
                admission,
                invalidReason: admissionInvalidReason,
              }
            );
            retryAfterInvalidation =
              (admission === 'staged-cancelled' || admissionInvalidReason !== null) &&
              admissionInvalidReason !== 'disabled' &&
              admissionInvalidReason !== 'packet-superseded' &&
              admissionInvalidReason !== 'attempt-superseded';
            return;
          }
          if (admission === 'rejected') {
            throw new Error('The annotation viewport detail packet was rejected by the renderer.');
          }
          if (activeDetailRequestRef.current?.requestGeneration === requestGeneration) {
            activeDetailRequestRef.current = null;
          }
          admittedPacketIdentityRef.current = {
            requestGeneration,
            ownerKey,
            interactionAuthority: authority,
          };
          const current = latestAdmissionInputRef.current;
          current.recordEvent?.('annotation-viewport-detail-renderer-admitted', {
            requestGeneration,
            corridorKey: packetCorridor.key,
            elapsedMs: performance.now() - startedAt,
            payloadBytes: result.payload.byteLength,
          });
          const publishedAdmissionIdentity = `${requestGeneration}\u0000${ownerKey}`;
          if (publishedAdmissionIdentityRef.current !== publishedAdmissionIdentity) {
            publishedAdmissionIdentityRef.current = publishedAdmissionIdentity;
            current.onRendererAdmission?.();
          }
          current.webglRef.current?.requestRender?.();
          if (!isCurrent()) return;
          setReceipt({
            status: 'loaded',
            ownerKey,
            coverageStartBp: packetCorridor.startBp,
            coverageEndBp: packetCorridor.endBp,
            payloadBytes: result.payload.byteLength,
            error: null,
          });
        } catch (error: unknown) {
          if (!isCurrent()) return;
          if (activeDetailRequestRef.current?.requestGeneration === requestGeneration) {
            activeDetailRequestRef.current = null;
          }
          const current = latestAdmissionInputRef.current;
          current.recordEvent?.('annotation-viewport-detail-request-error', {
            requestGeneration,
            corridorKey: packetCorridor.key,
            elapsedMs: performance.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack ?? null) : null,
          });
          setReceipt({
            status: 'error',
            ownerKey,
            coverageStartBp: packetCorridor.startBp,
            coverageEndBp: packetCorridor.endBp,
            payloadBytes: null,
            error,
          });
        } finally {
          if (rendererAdmissionAttemptRef.current?.token === token) {
            rendererAdmissionAttemptRef.current = null;
          }
          if (
            retryAfterInvalidation &&
            latestAdmissionInputRef.current.enabled &&
            preparedPacketRef.current?.requestGeneration === requestGeneration
          ) {
            setRendererAdmissionRetryEpoch((epoch) => epoch + 1);
          }
        }
      })();
    },
    []
  );

  useEffect(() => {
    if (!input.enabled || !descriptor) {
      preparedPacketRef.current = null;
      setReceipt(EMPTY_RECEIPT);
      return;
    }
    if (!corridor) {
      preparedPacketRef.current = null;
      setReceipt({
        status: 'waiting-camera',
        ownerKey: input.expectedInteractionOwnerKey,
        coverageStartBp: null,
        coverageEndBp: null,
        payloadBytes: null,
        error: null,
      });
      return;
    }

    let cancelled = false;
    let terminalPhase = 'in-flight';
    const controller = new AbortController();
    const requestGeneration = ++requestGenerationRef.current;
    activeDetailRequestRef.current = { requestGeneration, controller };
    const startedAt = performance.now();
    const requestOwnerContractSha256 = input.expectedInteractionOwnerKey?.split('\n')[3] ?? null;
    const request: AssemblyAnnotationSceneDetailReadRequestV1 = {
      contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
      source: descriptor.request,
      startBp: corridor.startBp,
      endBp: corridor.endBp,
    };
    preparedPacketRef.current = null;
    setReceipt({
      status: 'loading',
      ownerKey: input.expectedInteractionOwnerKey,
      coverageStartBp: corridor.startBp,
      coverageEndBp: corridor.endBp,
      payloadBytes: null,
      error: null,
    });
    input.recordEvent?.('annotation-viewport-detail-request-started', {
      requestGeneration,
      corridorKey: corridor.key,
      ownerContractSha256: requestOwnerContractSha256,
      startBp: corridor.startBp,
      endBp: corridor.endBp,
    });
    let publicationAttempt = 0;
    void readNullableAuthorityUntilPublishedV1({
      authorityLabel: 'The annotation viewport detail',
      signal: controller.signal,
      deadlineMs: DETAIL_PUBLICATION_DEADLINE_MS,
      read: async (signal) => {
        const attempt = ++publicationAttempt;
        const attemptStartedAt = performance.now();
        try {
          const result = await platform().genome.readAssemblyAnnotationSceneDetailV1(request, {
            signal,
          });
          input.recordEvent?.('annotation-viewport-detail-publication-attempt', {
            requestGeneration,
            corridorKey: corridor.key,
            attempt,
            attemptElapsedMs: performance.now() - attemptStartedAt,
            elapsedMs: performance.now() - startedAt,
            outcome: result === null ? 'not-published' : result.status,
          });
          return result;
        } catch (error: unknown) {
          input.recordEvent?.('annotation-viewport-detail-publication-attempt', {
            requestGeneration,
            corridorKey: corridor.key,
            attempt,
            attemptElapsedMs: performance.now() - attemptStartedAt,
            elapsedMs: performance.now() - startedAt,
            outcome: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    })
      .then(async (result) => {
        if (cancelled || requestGenerationRef.current !== requestGeneration) return;
        if (result.status === 'unavailable') {
          terminalPhase = 'unavailable';
          if (activeDetailRequestRef.current?.requestGeneration === requestGeneration) {
            activeDetailRequestRef.current = null;
          }
          input.recordEvent?.('annotation-viewport-detail-request-unavailable', {
            requestGeneration,
            corridorKey: corridor.key,
            elapsedMs: performance.now() - startedAt,
          });
          setReceipt({
            status: 'unavailable',
            ownerKey: latestAdmissionInputRef.current.expectedInteractionOwnerKey,
            coverageStartBp: corridor.startBp,
            coverageEndBp: corridor.endBp,
            payloadBytes: null,
            error: null,
          });
          return;
        }
        input.recordEvent?.('annotation-viewport-detail-request-returned', {
          requestGeneration,
          corridorKey: corridor.key,
          elapsedMs: performance.now() - startedAt,
          payloadBytes: result.payload.byteLength,
        });
        const authenticated = await authenticateAnnotationViewportDetailPayloadV1(
          result.payload,
          controller.signal
        );
        if (cancelled || requestGenerationRef.current !== requestGeneration) return;
        const unpacked = await unpackPartitionedTranscriptSceneDetailPacketV1(
          result.manifest,
          authenticated.payload,
          async (payload) => {
            if (payload !== authenticated.payload) {
              throw new Error('annotation viewport detail authenticated payload identity changed');
            }
            return authenticated.sha256;
          }
        );
        if (cancelled || requestGenerationRef.current !== requestGeneration) return;
        input.recordEvent?.('annotation-viewport-detail-packet-unpacked', {
          requestGeneration,
          corridorKey: corridor.key,
          elapsedMs: performance.now() - startedAt,
        });
        terminalPhase = 'prepared';
        const prepared = {
          corridor,
          result: { ...result, payload: authenticated.payload },
          unpacked,
          requestGeneration,
          startedAt,
        } satisfies PreparedViewportDetailPacketV1;
        preparedPacketRef.current = prepared;
        attemptPreparedPacketAdmission(prepared);
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        terminalPhase = 'error';
        if (activeDetailRequestRef.current?.requestGeneration === requestGeneration) {
          activeDetailRequestRef.current = null;
        }
        input.recordEvent?.('annotation-viewport-detail-request-error', {
          requestGeneration,
          corridorKey: corridor.key,
          elapsedMs: performance.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
        });
        setReceipt({
          status: 'error',
          ownerKey: latestAdmissionInputRef.current.expectedInteractionOwnerKey,
          coverageStartBp: corridor.startBp,
          coverageEndBp: corridor.endBp,
          payloadBytes: null,
          error,
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (activeDetailRequestRef.current?.requestGeneration === requestGeneration) {
        activeDetailRequestRef.current = null;
      }
      input.recordEvent?.('annotation-viewport-detail-request-cleanup', {
        requestGeneration,
        corridorKey: corridor.key,
        ownerContractSha256: requestOwnerContractSha256,
        terminalPhase,
        elapsedMs: performance.now() - startedAt,
      });
    };
  }, [attemptPreparedPacketAdmission, corridor, descriptor, input.enabled, input.recordEvent]);

  useEffect(() => {
    const packet = preparedPacketRef.current;
    if (!packet) return;
    attemptPreparedPacketAdmission(packet);
  }, [
    attemptPreparedPacketAdmission,
    input.expectedInteractionOwnerKey,
    input.interactionAuthority,
    input.policy.isoformMode,
    input.policy.laneLimit,
    input.rendererGenomeCommitEpoch,
    input.rendererAdmissionEpoch,
    input.rendererReadyEpoch,
    rendererAdmissionRetryEpoch,
  ]);

  return { receipt, notifyCameraChanged };
}

export async function scheduleViewportDetailRendererAdmissionV1(input: {
  readonly renderer: DetailRenderer;
  readonly loadInput: PrepackedAnnotationSceneLoadInput;
  readonly finePrewarmRange: AssemblyAnnotationFinePrewarmRangeV1;
  readonly handle: {
    readonly getLinearRenderer?: () => unknown;
    readonly schedulePostPresentWork?: (work: (deadlineMs: number) => void) => void;
  };
  readonly resolveCurrentHandle?: () => {
    readonly getLinearRenderer?: () => unknown;
    readonly schedulePostPresentWork?: (work: (deadlineMs: number) => void) => void;
  } | null;
  readonly cancelled: () => boolean;
  readonly onPhase?: (
    phase: 'enqueued' | 'scheduled' | 'post-present-entered' | 'scene-prepared',
    detail: Record<string, unknown>
  ) => void;
}): Promise<
  | 'admitted'
  | 'staged-cancelled'
  | 'staged-renderer-changed'
  | 'staged-waiting-residents'
  | 'staged-fine-status'
  | 'staged-roster-barrier'
  | 'rejected'
> {
  return new Promise((resolve, reject) => {
    const queuedAt = performance.now();
    input.onPhase?.('enqueued', {});
    let scenePrepared = false;
    let settled = false;
    const finish = (value: Parameters<typeof resolve>[0]): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const scheduleAdmissionSlice = (): void => {
      if (settled) return;
      try {
        if (input.cancelled()) {
          finish('staged-cancelled');
          return;
        }
        const liveHandle = input.resolveCurrentHandle?.() ?? input.handle;
        if (liveHandle.getLinearRenderer?.() !== input.renderer) {
          finish('staged-renderer-changed');
          return;
        }
        const scheduleResult = scheduleWebGLPostPresentWorkForRenderer(
          input.renderer,
          admit,
          (reason) => {
            if (reason === 'fatal-frame-circuit') {
              fail(new Error('The annotation renderer opened its fatal frame circuit.'));
            } else {
              finish('staged-renderer-changed');
            }
          }
        );
        input.onPhase?.('scheduled', { outcome: scheduleResult });
        if (scheduleResult === 'scheduled') return;
        if (scheduleResult === 'not-found') {
          if (liveHandle.schedulePostPresentWork) {
            liveHandle.schedulePostPresentWork((deadlineMs) => admit(deadlineMs));
          } else {
            setTimeout(() => admit(), 0);
          }
          return;
        }
        if (scheduleResult === 'fatal-frame-circuit' || scheduleResult === 'ambiguous') {
          fail(
            new Error(
              `The annotation renderer cannot schedule post-present work (${scheduleResult}).`
            )
          );
          return;
        }
        finish('staged-renderer-changed');
      } catch (error) {
        fail(error);
      }
    };
    const admit = (deadlineMs?: number): void => {
      try {
        if (input.cancelled()) {
          finish('staged-cancelled');
          return;
        }
        const currentHandle = input.resolveCurrentHandle?.() ?? input.handle;
        const currentRenderer = currentHandle.getLinearRenderer?.() as DetailRenderer | null;
        if (currentRenderer !== input.renderer) {
          finish('staged-renderer-changed');
          return;
        }
        if (!scenePrepared) {
          const preparationStartedAt = performance.now();
          input.onPhase?.('post-present-entered', {
            queueDelayMs: preparationStartedAt - queuedAt,
          });
          scenePrepared = input.renderer.preparePrepackedAnnotationScene(input.loadInput);
          input.onPhase?.('scene-prepared', {
            durationMs: performance.now() - preparationStartedAt,
            prepared: scenePrepared,
          });
          if (!scenePrepared) {
            finish('rejected');
            return;
          }
          queueMicrotask(scheduleAdmissionSlice);
          return;
        }
        let fine: PrepackedAnnotationFinePreparationResult;
        do {
          fine = input.renderer.preparePrepackedAnnotationFineViews(
            input.finePrewarmRange.startBp,
            input.finePrewarmRange.endBp,
            input.loadInput.metadata.themeMode,
            deadlineMs
          );
        } while (
          fine.pendingOwnerCount > 0 &&
          deadlineMs !== undefined &&
          performance.now() < deadlineMs
        );
        if (fine.status === 'waiting-residents') {
          finish('staged-waiting-residents');
          return;
        }
        if (fine.status === 'outside-prewarm-corridor') {
          throw new Error(
            `The admitted annotation scene could not prepare its exact GPU views (${fine.status}).`
          );
        }
        if (fine.pendingOwnerCount > 0) {
          queueMicrotask(scheduleAdmissionSlice);
          return;
        }
        if (fine.status !== 'complete') {
          finish('staged-fine-status');
          return;
        }
        finish(
          input.renderer.admitPrepackedAnnotationViewportDetailRoster(
            input.finePrewarmRange.startBp,
            input.finePrewarmRange.endBp,
            input.loadInput.metadata.themeMode
          )
            ? 'admitted'
            : 'staged-roster-barrier'
        );
      } catch (error) {
        fail(error);
      }
    };
    scheduleAdmissionSlice();
  });
}
