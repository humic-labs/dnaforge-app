import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import type { CoverageSignal, PileupRecord, PileupTrackData } from '@waypoint/genome-data';
import {
  baseLevelForBpPerPx,
  maxLevelForAssembly,
  pileupDensitySampleColumnCount,
  tileIndex,
  tileSpanBp,
  type Assembly,
} from '@waypoint/genome-renderer';

import { TileEngineDriver, type TileEngineFeed } from '../tile-engine-driver';
import { resolveSidecarBaseUrl } from '../../../services/sidecar-session';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import type { ActiveStressDataset } from '../lane-contract-store';
import {
  alignedReadBlockedStatus,
  alignedReadRetryDelayMs,
  classifyAlignedReadTileFailure,
  createAlignedReadTrackLifecycleSignal,
  type AlignedReadTrackLifecycleSignal,
  type AlignedReadTrackReadyKind,
} from '../aligned-read-track-lifecycle';
import {
  createIndexedFirstInteractionReadiness,
  type IndexedFirstInteractionReadinessSignal,
} from './indexed-first-interaction-readiness';
import { alignedReadSourceGenerationKey } from '../../../shared/aligned-read-source-generation';
import type { PileupSource } from '../pileup-source';

type PileupRange = { start: number; end: number };

type TileEngineFeedDebugRange = { start: number; end: number } | null;

type TileEngineWindow = Window & {
  __tileEngineDebug?: () => unknown;
  __tileEngineDriver?: { built: number; baseUrl: string };
  __tileEngineFeed?: TileEngineFeedDebug;
  __tileEnginePublishedFeedReceipts?: Map<string, TileEnginePublishedFeedReceipt>;
  __tileEnginePublishedFeedSnapshot?: (trackId: string) => TileEnginePublishedFeedReceipt | null;
  __webglDiagnosticsEnabled?: boolean;
  __webglExposeForTests?: boolean;
};

function tileEngineWindow(): TileEngineWindow {
  return window as TileEngineWindow;
}

type TileEngineFeedDebug = {
  feeds: number;
  publishedFeeds: number;
  suppressedFeeds: number;
  lastRecords: number;
  maxRecords: number;
  lastCovBin: number | null;
  coverageRole: string | null;
  coverageLevel: number | null;
  targetLevel: number | null;
  coverageAuthority: string | null;
  coverageProvenanceMethod: string | null;
  presentationKind: string | null;
  presentationReason: string | null;
  ownerPresentationKind?: string | null;
  lifecyclePresentationAccepted?: boolean;
  lifecycleEntryPlanKey?: string | null;
  lifecycleComputedPlanKey?: string | null;
  coverageGpuAtlasAuthorityKey: string | null;
  coverageGpuAtlasSourceIdentity: string | null;
  coverageGpuAtlasAssemblyFingerprint: string | null;
  coverageGpuAtlasStatistic: string | null;
  coverageGpuAtlasPayloadRevision: string | null;
  coverageGpuAtlasBaseBinSizeBp: number | null;
  published: boolean;
  vetoReason: string | null;
  currentRange: TileEngineFeedDebugRange;
  feedViewRange: TileEngineFeedDebugRange;
  trackId: string;
  lastTiming?: TileEngineFeedDebugTiming;
  maxTotalMs?: number;
  maxReadsComposeMs?: number;
  maxSetTrackDataMs?: number;
  slowFeeds?: Array<TileEngineFeedDebugTiming & { feeds: number }>;
};

type TileEngineFeedDebugTiming = {
  totalMs: number;
  coverageComposeMs: number;
  coverageMaxDepthMs: number;
  readsComposeMs: number;
  setTrackDataMs: number;
  recordCount: number;
  coverageBinCount: number;
  coverageBinSize: number | null;
  targetLevel?: number;
  coverageMemoMaterializeCount?: number;
  coverageMemoRevisionChangeCount?: number;
  exactCoverageRecordScanCount?: number;
  exactCoverageGeneration?: number;
  viewStartBp?: number;
  viewEndBp?: number;
  coveragePresentationKind?: string;
  coveragePresentationReason?: string | null;
  coverageAuthority?: string | null;
  coverageProvenanceExact?: boolean | null;
  coverageProvenanceMethod?: string | null;
  coverageProvenanceSource?: string | null;
  coverageSourceLevel?: number | null;
  coverageSourceBinSize?: number | null;
  targetCoveragePending?: boolean;
  targetCoverageErrored?: boolean;
  currentCoverageBinSize?: number | null;
  mixedCoverageBinSize?: number | null;
  residentCoverageCandidateCount?: number;
};

type TileEnginePublishedFeedReceipt = {
  contract: 'tile-engine-published-feed-receipt.v1';
  trackId: string;
  publisherEpoch: string;
  sourceKey: string;
  publicationSequence: number;
  publishedAt: number;
  currentRange: TileEngineFeedDebugRange;
  feedViewRange: TileEngineFeedDebugRange;
  published: true;
  targetLevel: number | null;
  coverageLevel: number | null;
  coverageRole: string | null;
  coverageGpuAtlasAuthorityKey: string | null;
  coverageGpuAtlasSourceIdentity: string | null;
  coverageGpuAtlasAssemblyFingerprint: string | null;
  coverageGpuAtlasStatistic: string | null;
  coverageGpuAtlasPayloadRevision: string | null;
  coverageGpuAtlasBaseBinSizeBp: number | null;
  coverageMemoMaterializeCount: number | null;
  coverageMemoRevisionChangeCount: number | null;
  exactCoverageRecordScanCount: number | null;
  exactCoverageGeneration: number | null;
  setTrackDataMs: number;
};

type TileEnginePublishedFeedWindow = Window & {
  __tileEnginePublishedFeedReceipts?: Map<string, TileEnginePublishedFeedReceipt>;
  __tileEnginePublishedFeedSnapshot?: (trackId: string) => TileEnginePublishedFeedReceipt | null;
};

type TileDriverRetirementReason =
  | 'sidecar-changed'
  | 'source-generation-conflict'
  | 'source-identity-changed'
  | 'view-inactive'
  | 'track-not-streaming'
  | 'track-admission-blocked'
  | 'assembly-unavailable'
  | 'viewer-unmounted';

type AlignedReadLifecycleDebugEvent = {
  readonly trackId: string;
  readonly reason: string;
  readonly classification: ReturnType<typeof classifyAlignedReadTileFailure> | 'retired';
  readonly sourceKey: string;
  readonly generation: number;
  readonly planKey: string;
};

type AlignedReadLifecycleDebugWindow = Window & {
  __alignedReadLifecycleDebugEvents?: Array<AlignedReadLifecycleDebugEvent & { atEpochMs: number }>;
  __webglDiagnosticsEnabled?: boolean;
  __webglExposeForTests?: boolean;
};

let tileEnginePublisherEpochSequence = 0;
let tileEngineDriverGenerationSequence = 0;

function clearTileEnginePublishedFeedReceipt(trackId: string, publisherEpoch: string): void {
  if (typeof window === 'undefined') return;
  const target = window as TileEnginePublishedFeedWindow;
  const current = target.__tileEnginePublishedFeedReceipts?.get(trackId);
  if (current?.publisherEpoch === publisherEpoch) {
    target.__tileEnginePublishedFeedReceipts?.delete(trackId);
  }
}

function recordAlignedReadLifecycleDebugEvent(event: AlignedReadLifecycleDebugEvent): void {
  if (typeof window === 'undefined') return;
  const target = window as AlignedReadLifecycleDebugWindow;
  if (target.__webglDiagnosticsEnabled !== true && target.__webglExposeForTests !== true) {
    return;
  }
  target.__alignedReadLifecycleDebugEvents = [
    ...(target.__alignedReadLifecycleDebugEvents ?? []),
    { ...event, atEpochMs: Date.now() },
  ].slice(-32);
}

type TileEngineDriverEntry = {
  driver: TileEngineDriver;
  sourceKey: string;
  generation: number;
  requestSequence: number;
  planKey: string;
  currentRange: PileupRange;
  lastPresentedRange: PileupRange | null;
  lastProgressSignature: string | null;
  publishedRenderer: object | null;
  pendingPresentation: PendingAlignedReadPresentation | null;
};

function retireTileDriver(
  trackId: string,
  entry: TileEngineDriverEntry,
  reason: TileDriverRetirementReason
): void {
  recordAlignedReadLifecycleDebugEvent({
    trackId,
    classification: 'retired',
    reason,
    sourceKey: entry.sourceKey,
    generation: entry.generation,
    planKey: entry.planKey,
  });
  entry.driver.dispose();
}

type PendingAlignedReadPresentation = {
  sourceKey: string;
  generation: number;
  rendererGeneration: number;
  requestSequence: number;
  publicationSequence: number;
  planKey: string;
  range: PileupRange;
  kind: AlignedReadTrackReadyKind;
  requiredReadBandReady?: boolean;
};

type AlignedReadRecoveryEpisode = {
  sourceKey: string;
  generation: number;
  planKey: string;
  reason: string;
  completedAttempts: number;
  timer: number | null;
  retrying: boolean;
  sidecarRefreshAttempted: boolean;
  terminal: boolean;
  requiresReadBand: boolean;
};

type AlignedReadStallWatch = {
  readonly sourceKey: string;
  readonly generation: number;
  readonly requestSequence: number;
  readonly planKey: string;
  readonly startedAtMs: number;
  readonly timer: number;
};

type PendingTileEngineReplay = {
  range: PileupRange;
  contextKey: string;
  planKey: string;
};

type SidecarResolutionRecoveryEpisode = {
  contextKey: string;
  planKey: string;
  completedAttempts: number;
  timer: number | null;
  retrying: boolean;
  terminal: boolean;
};

type ScheduleTrackRecovery = (
  trackId: string,
  driver: TileEngineDriver,
  reason: string,
  options?: { readonly immediate?: boolean; readonly requiredReadBand?: boolean }
) => void;

type PileupPresentationRenderer = {
  setTrackData: (trackId: string, data: PileupTrackData) => void;
};

const TILE_ENGINE_CAMERA_COMMIT_MIN_MS = 96;
const TILE_ENGINE_CRITICAL_FINE_COMMIT_LEVEL = 11;
export const ALIGNED_READ_STALL_NOTICE_MS = 4_000;
export const REMOTE_ALIGNED_READ_TILE_TIMEOUT_MS = 20_000;
const LOCAL_ALIGNED_READ_TILE_TIMEOUT_MS = 90_000;
const REMOTE_SOURCE_PROBE_TIMEOUT_MS = 2_500;
const TILE_ENGINE_ASSEMBLY_KEY_CACHE = new WeakMap<Assembly, string>();
const TILE_ENGINE_DRIVER_SOURCE_KEY_CACHE = new WeakMap<
  Assembly,
  WeakMap<
    ActiveStressDataset,
    {
      baseUrl: string;
      referencePathsKey: string;
      bamPath: string;
      indexPath: string;
      referencePath: string;
      generationKey: string;
      grantExpiresAtMs: number;
      key: string;
    }
  >
>();

export async function probeRemoteAlignmentSource(
  source: PileupSource,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!source.remote || !/^https?:\/\//u.test(source.bamPath)) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_SOURCE_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(source.bamPath, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok && response.headers.get('accept-ranges')?.toLowerCase() === 'bytes';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

interface UseIndexedPileupStreamingOptions {
  webglRef: { readonly current: IndexedGenomeTileNativeMapHandle | null };
  rendererAssembly: Assembly | null;
  containerWidth: number;
  activeStressDatasets: ReadonlyArray<ActiveStressDataset>;
  referencePathsByChrom?: ReadonlyMap<string, string>;
  enabled?: boolean;
  onTrackDataPublished?: (trackId: string, data: PileupTrackData) => void;
  reconnectRemoteTrack?: (trackId: string) => Promise<boolean>;
  remoteSourceProbe?: (source: PileupSource) => Promise<boolean>;
}

export interface IndexedPileupStreamingController {
  streamPileupViaTileEngine: (range: PileupRange | null | undefined) => boolean;
  firstInteractionReadiness: IndexedFirstInteractionReadinessSignal;
  trackLifecycle: AlignedReadTrackLifecycleSignal;
  retryTrack: (trackId: string) => void;
  noteLaneContractWired: (
    renderer: object,
    range: PileupRange | null,
    wiredTrackIds: ReadonlyArray<string>
  ) => void;
}

export function useIndexedPileupStreaming({
  webglRef,
  rendererAssembly,
  containerWidth,
  activeStressDatasets,
  referencePathsByChrom,
  enabled = true,
  onTrackDataPublished,
  reconnectRemoteTrack,
  remoteSourceProbe = probeRemoteAlignmentSource,
}: UseIndexedPileupStreamingOptions): IndexedPileupStreamingController {
  const onTrackDataPublishedRef = useRef(onTrackDataPublished);
  onTrackDataPublishedRef.current = onTrackDataPublished;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const previouslyEnabledRef = useRef(enabled);
  const tileEnginePublisherEpochRef = useRef<string | null>(null);
  if (tileEnginePublisherEpochRef.current == null) {
    tileEnginePublisherEpochSequence += 1;
    tileEnginePublisherEpochRef.current = `tile-engine-publisher:${tileEnginePublisherEpochSequence}`;
  }
  const tileEnginePublisherEpoch = tileEnginePublisherEpochRef.current;
  const rendererAssemblyRef = useRef(rendererAssembly);
  rendererAssemblyRef.current = rendererAssembly;
  const containerWidthRef = useRef(containerWidth);
  containerWidthRef.current = containerWidth;
  const activeStressDatasetsRef = useRef(activeStressDatasets);
  activeStressDatasetsRef.current = activeStressDatasets;
  const referencePathsKey = useMemo(
    () => tileEngineReferencePathsKey(rendererAssembly, referencePathsByChrom),
    [referencePathsByChrom, rendererAssembly]
  );
  const referencePathsKeyRef = useRef(referencePathsKey);
  referencePathsKeyRef.current = referencePathsKey;
  const tileEngineDriversRef = useRef<Map<string, TileEngineDriverEntry>>(new Map());
  const tileEnginePublishedPayloadsRef = useRef<Map<string, PileupTrackData>>(new Map());
  const tileEngineRecoveryRef = useRef<Map<string, AlignedReadRecoveryEpisode>>(new Map());
  const alignedReadStallWatchesRef = useRef<Map<string, AlignedReadStallWatch>>(new Map());
  const scheduleTrackRecoveryRef = useRef<ScheduleTrackRecovery>(() => undefined);
  const sidecarResolutionRecoveryRef = useRef<SidecarResolutionRecoveryEpisode | null>(null);
  const tileEnginePublicationSequenceRef = useRef(0);
  const presentationRendererRef = useRef<object | null>(null);
  const presentationRendererGenerationRef = useRef(0);
  const presentedFrameListenerRef = useRef<() => void>(() => undefined);
  const presentedFrameSubscriptionRef = useRef<{
    map: IndexedGenomeTileNativeMapHandle;
    rendererGeneration: number;
    unsubscribe: () => void;
  } | null>(null);
  const trackLifecycle = useMemo(() => createAlignedReadTrackLifecycleSignal(), []);
  const tileEngineBaseUrlRef = useRef<string | null>(null);
  const tileEngineUrlResolvingRef = useRef(false);
  const tileEngineLastRangeRef = useRef<PendingTileEngineReplay | null>(null);
  const tileEnginePendingCommitRef = useRef<PendingTileEngineReplay | null>(null);
  const tileEngineCommitTimerRef = useRef<number | null>(null);
  const flushPendingTileEngineCommitRef = useRef<() => void>(() => undefined);
  const tileEngineLastCommitMsRef = useRef<number | null>(null);
  const tileEngineLastCommitPlanKeyRef = useRef<string | null>(null);
  const streamPileupViaTileEngineRef = useRef<
    ((range: PileupRange | null | undefined) => boolean) | null
  >(null);
  const tileEngineReplayContextKey = useMemo(
    () =>
      rendererAssembly && activeStressDatasets.some(isTileEngineOwnedPileupDataset)
        ? tileEngineReplayKey(rendererAssembly, activeStressDatasets, referencePathsKey)
        : null,
    [activeStressDatasets, referencePathsKey, rendererAssembly]
  );
  const tileEngineReplayContextKeyRef = useRef<string | null>(null);
  tileEngineReplayContextKeyRef.current = tileEngineReplayContextKey;
  const tileEngineOwnedTrackIds = useMemo(
    () =>
      activeStressDatasets
        .filter(isTileEngineOwnedPileupDataset)
        .map((dataset) => dataset.trackId)
        .sort(),
    [activeStressDatasets]
  );
  const admissionBlockedPileupTracks = useMemo(
    () =>
      activeStressDatasets.flatMap((dataset) => {
        const admissionError = dataset.kind === 'pileup' ? dataset.source?.admissionError : null;
        return admissionError ? [{ trackId: dataset.trackId, admissionError }] : [];
      }),
    [activeStressDatasets]
  );
  const remoteConnectionPileupTracks = useMemo(
    () =>
      activeStressDatasets.flatMap((dataset) => {
        if (dataset.kind !== 'pileup' || !dataset.source?.remote?.connection) return [];
        return [
          {
            trackId: dataset.trackId,
            sessionId: dataset.source.remote.sessionId ?? null,
            connection: dataset.source.remote.connection,
          },
        ];
      }),
    [activeStressDatasets]
  );
  const remoteTransportGenerationsRef = useRef<Map<string, number>>(new Map());
  const tileEngineOwnedTrackIdsRef = useRef(tileEngineOwnedTrackIds);
  tileEngineOwnedTrackIdsRef.current = tileEngineOwnedTrackIds;
  const tileEngineOwnedTrackIdsKey = tileEngineOwnedTrackIds.join('\0');
  const firstInteractionReadiness = useMemo(
    () =>
      createIndexedFirstInteractionReadiness({
        sourceKey: enabled ? tileEngineReplayContextKey : null,
        viewportPx: pileupDensitySampleColumnCount(containerWidth),
        expectedTrackIds: tileEngineOwnedTrackIds,
        requireFullAssemblyCorridor: (rendererAssembly?.totalLengthBp ?? 0) >= 150_000_000,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [containerWidth, enabled, tileEngineOwnedTrackIdsKey, tileEngineReplayContextKey]
  );
  const firstInteractionReadinessRef = useRef(firstInteractionReadiness);
  firstInteractionReadinessRef.current = firstInteractionReadiness;
  const adoptPresentationRenderer = useCallback((renderer: object): number => {
    if (presentationRendererRef.current !== renderer) {
      presentationRendererRef.current = renderer;
      presentationRendererGenerationRef.current += 1;
    }
    return presentationRendererGenerationRef.current;
  }, []);

  const clearTileEngineCommitTimer = useCallback(() => {
    if (tileEngineCommitTimerRef.current == null) return;
    window.clearTimeout(tileEngineCommitTimerRef.current);
    tileEngineCommitTimerRef.current = null;
  }, []);

  const clearTrackRecovery = useCallback((trackId: string): void => {
    const recovery = tileEngineRecoveryRef.current.get(trackId);
    if (recovery?.timer != null) window.clearTimeout(recovery.timer);
    tileEngineRecoveryRef.current.delete(trackId);
  }, []);

  const clearAllTrackRecovery = useCallback((): void => {
    for (const recovery of tileEngineRecoveryRef.current.values()) {
      if (recovery.timer != null) window.clearTimeout(recovery.timer);
    }
    tileEngineRecoveryRef.current.clear();
  }, []);

  const clearTrackStallWatch = useCallback((trackId: string): void => {
    const watch = alignedReadStallWatchesRef.current.get(trackId);
    if (watch) window.clearTimeout(watch.timer);
    alignedReadStallWatchesRef.current.delete(trackId);
  }, []);

  const clearAllTrackStallWatches = useCallback((): void => {
    for (const watch of alignedReadStallWatchesRef.current.values()) {
      window.clearTimeout(watch.timer);
    }
    alignedReadStallWatchesRef.current.clear();
  }, []);

  const armTrackStallWatch = useCallback(
    (trackId: string, entry: TileEngineDriverEntry): void => {
      clearTrackStallWatch(trackId);
      const startedAtMs = Date.now();
      const identity = {
        sourceKey: entry.sourceKey,
        generation: entry.generation,
        requestSequence: entry.requestSequence,
        planKey: entry.planKey,
      };
      const timer = window.setTimeout(() => {
        const watch = alignedReadStallWatchesRef.current.get(trackId);
        const current = tileEngineDriversRef.current.get(trackId);
        if (
          !watch ||
          watch.timer !== timer ||
          !current ||
          current.sourceKey !== identity.sourceKey ||
          current.generation !== identity.generation ||
          current.requestSequence !== identity.requestSequence ||
          current.planKey !== identity.planKey
        ) {
          return;
        }
        const status = trackLifecycle.getSnapshot()[trackId];
        if (status?.phase === 'ready' || status?.phase === 'blocked') {
          clearTrackStallWatch(trackId);
          return;
        }
        trackLifecycle.set(trackId, {
          phase: 'stalled',
          hasLastGood: current.lastPresentedRange !== null,
          elapsedMs: Math.max(ALIGNED_READ_STALL_NOTICE_MS, Date.now() - startedAtMs),
        });
        scheduleTrackRecoveryRef.current(trackId, current.driver, 'stalled', {
          immediate: true,
        });
      }, ALIGNED_READ_STALL_NOTICE_MS);
      alignedReadStallWatchesRef.current.set(trackId, {
        ...identity,
        startedAtMs,
        timer,
      });
    },
    [clearTrackStallWatch, trackLifecycle]
  );

  const beginTrackStreaming = useCallback(
    (trackId: string, entry: TileEngineDriverEntry): void => {
      entry.lastProgressSignature = null;
      trackLifecycle.set(
        trackId,
        entry.lastPresentedRange ? { phase: 'refreshing', hasLastGood: true } : { phase: 'loading' }
      );
      armTrackStallWatch(trackId, entry);
    },
    [armTrackStallWatch, trackLifecycle]
  );

  const clearSidecarResolutionRecovery = useCallback((): void => {
    const recovery = sidecarResolutionRecoveryRef.current;
    if (recovery?.timer != null) window.clearTimeout(recovery.timer);
    sidecarResolutionRecoveryRef.current = null;
    tileEngineUrlResolvingRef.current = false;
  }, []);

  const hasPendingPresentedFrame = useCallback((): boolean => {
    for (const entry of tileEngineDriversRef.current.values()) {
      if (entry.pendingPresentation) return true;
    }
    return false;
  }, []);

  const detachPresentedFrameSubscription = useCallback((): void => {
    const subscription = presentedFrameSubscriptionRef.current;
    if (!subscription) return;
    presentedFrameSubscriptionRef.current = null;
    subscription.unsubscribe();
  }, []);

  const detachPresentedFrameSubscriptionIfIdle = useCallback((): void => {
    if (!hasPendingPresentedFrame()) detachPresentedFrameSubscription();
  }, [detachPresentedFrameSubscription, hasPendingPresentedFrame]);

  const acceptPendingPresentedFrames = useCallback((): void => {
    if (!hasPendingPresentedFrame()) {
      detachPresentedFrameSubscription();
      return;
    }
    const assembly = rendererAssemblyRef.current;
    const currentRenderer = webglRef.current?.getLinearRenderer?.() ?? null;
    const currentViewport = webglRef.current?.getViewportRange?.() ?? null;
    const currentRange = assembly
      ? normalizeTileEngineDataRange(currentViewport, assembly.totalLengthBp)
      : null;
    if (!assembly || !currentRange) {
      return;
    }
    const currentPlanKey = tileEngineCommitPlanKey(currentRange, assembly, containerWidth);
    if (!currentPlanKey) return;

    for (const [trackId, entry] of tileEngineDriversRef.current.entries()) {
      const pending = entry.pendingPresentation;
      if (
        !pending ||
        pending.sourceKey !== entry.sourceKey ||
        pending.generation !== entry.generation ||
        pending.rendererGeneration !== presentationRendererGenerationRef.current ||
        currentRenderer !== presentationRendererRef.current ||
        pending.requestSequence !== entry.requestSequence ||
        pending.planKey !== entry.planKey ||
        pending.planKey !== currentPlanKey ||
        !pileupRangesEqual(pending.range, currentRange)
      ) {
        continue;
      }
      if (pending.kind === 'reads' || pending.kind === 'empty') {
        const presentation = currentRenderer?.getReadPresentationSnapshot?.(trackId);
        const payload = tileEnginePublishedPayloadsRef.current.get(trackId);
        const sourceGenerationKey = payload?.readSource?.sourceGenerationKey ?? '';
        const presentationOwnerKey =
          payload?.readSource?.presentationOwnerKey ?? sourceGenerationKey;
        if (
          !presentation ||
          !payload ||
          presentation.kind !== pending.kind ||
          presentation.sourceGenerationKey !== sourceGenerationKey ||
          presentation.presentationOwnerKey !== presentationOwnerKey ||
          !pileupRangesEqual(
            { start: presentation.viewStartBp, end: presentation.viewEndBp },
            currentRange
          ) ||
          presentation.sourceCoversViewport !== true ||
          presentation.truncated !== false ||
          (pending.kind === 'reads' &&
            (!Number.isFinite(presentation.meshCoverageFraction) ||
              presentation.meshCoverageFraction < 0.999 ||
              presentation.visible !== true ||
              !Number.isSafeInteger(presentation.recordCount) ||
              presentation.recordCount <= 0)) ||
          (pending.kind === 'empty' &&
            (presentation.visible !== false || presentation.recordCount !== 0))
        ) {
          if (trackLifecycle.getSnapshot()[trackId]?.phase === 'ready')
            beginTrackStreaming(trackId, entry);
          continue;
        }
      }
      entry.pendingPresentation = null;
      entry.lastPresentedRange = pending.range;
      const recovery = tileEngineRecoveryRef.current.get(trackId);
      if (recovery?.requiresReadBand && pending.requiredReadBandReady !== true) {
        if (!recovery.terminal) {
          trackLifecycle.set(trackId, {
            phase: 'recovering',
            attempt: recovery.completedAttempts + 1,
            hasLastGood: true,
          });
        }
        continue;
      }
      clearTrackRecovery(trackId);
      clearTrackStallWatch(trackId);
      trackLifecycle.set(trackId, { phase: 'ready', kind: pending.kind });
    }
    detachPresentedFrameSubscriptionIfIdle();
  }, [
    beginTrackStreaming,
    clearTrackRecovery,
    clearTrackStallWatch,
    containerWidth,
    detachPresentedFrameSubscription,
    detachPresentedFrameSubscriptionIfIdle,
    hasPendingPresentedFrame,
    trackLifecycle,
    webglRef,
  ]);
  presentedFrameListenerRef.current = acceptPendingPresentedFrames;

  const ensurePresentedFrameSubscription = useCallback(
    (map: IndexedGenomeTileNativeMapHandle): void => {
      if (!hasPendingPresentedFrame()) {
        detachPresentedFrameSubscription();
        return;
      }
      const rendererGeneration = presentationRendererGenerationRef.current;
      const currentSubscription = presentedFrameSubscriptionRef.current;
      if (
        currentSubscription?.map === map &&
        currentSubscription.rendererGeneration === rendererGeneration
      ) {
        return;
      }
      detachPresentedFrameSubscription();
      if (typeof map.subscribeToPresentedFrames !== 'function') return;
      const subscribedRendererGeneration = rendererGeneration;
      const unsubscribe = map.subscribeToPresentedFrames(() => {
        if (subscribedRendererGeneration !== presentationRendererGenerationRef.current) return;
        presentedFrameListenerRef.current();
      });
      presentedFrameSubscriptionRef.current = { map, rendererGeneration, unsubscribe };
    },
    [detachPresentedFrameSubscription, hasPendingPresentedFrame]
  );

  const noteLaneContractWired = useCallback(
    (renderer: object, range: PileupRange | null, wiredTrackIds: ReadonlyArray<string>): void => {
      const rendererChanged = presentationRendererRef.current !== renderer;
      const rendererGeneration = adoptPresentationRenderer(renderer);
      firstInteractionReadiness.noteLaneContractWired(renderer, range, wiredTrackIds);
      if (rendererChanged) {
        for (const entry of tileEngineDriversRef.current.values()) {
          entry.pendingPresentation = null;
        }
        detachPresentedFrameSubscription();
      }

      const liveMap = webglRef.current;
      const liveRenderer = liveMap?.getLinearRenderer?.() ?? null;
      const assembly = rendererAssemblyRef.current;
      const normalizedRange = assembly
        ? normalizeTileEngineDataRange(range, assembly.totalLengthBp)
        : null;
      const planKey =
        normalizedRange && assembly
          ? tileEngineCommitPlanKey(normalizedRange, assembly, containerWidth)
          : null;
      const rendererTarget =
        liveRenderer === renderer && isPileupPresentationRenderer(renderer) ? renderer : null;
      const wiredTrackIdSet = new Set(wiredTrackIds);
      let replayed = false;

      for (const [trackId, entry] of tileEngineDriversRef.current.entries()) {
        if (!wiredTrackIdSet.has(trackId)) continue;
        if (!rendererChanged && entry.publishedRenderer === renderer) continue;
        const status = trackLifecycle.getSnapshot()[trackId];
        if (status?.phase !== 'ready') continue;
        trackLifecycle.set(trackId, { phase: 'loading' });

        const payload = tileEnginePublishedPayloadsRef.current.get(trackId);
        if (
          !rendererTarget ||
          !payload ||
          !normalizedRange ||
          planKey !== entry.planKey ||
          !pileupRangesEqual(entry.lastPresentedRange, normalizedRange)
        ) {
          continue;
        }

        entry.requestSequence += 1;
        tileEnginePublicationSequenceRef.current += 1;
        entry.pendingPresentation = {
          sourceKey: entry.sourceKey,
          generation: entry.generation,
          rendererGeneration,
          requestSequence: entry.requestSequence,
          publicationSequence: tileEnginePublicationSequenceRef.current,
          planKey: entry.planKey,
          range: normalizedRange,
          kind: status.kind,
        };
        rendererTarget.setTrackData(trackId, payload);
        entry.publishedRenderer = rendererTarget;
        onTrackDataPublishedRef.current?.(trackId, payload);
        replayed = true;
      }

      if (replayed && liveMap) {
        ensurePresentedFrameSubscription(liveMap);
        liveMap.requestRender?.();
      }
    },
    [
      adoptPresentationRenderer,
      containerWidth,
      detachPresentedFrameSubscription,
      ensurePresentedFrameSubscription,
      firstInteractionReadiness,
      trackLifecycle,
      webglRef,
    ]
  );

  const replaceTileEngineSidecarUrl = useCallback(
    (refreshedBaseUrl: string): void => {
      tileEngineBaseUrlRef.current = refreshedBaseUrl;
      clearAllTrackStallWatches();
      for (const [activeTrackId, activeEntry] of tileEngineDriversRef.current.entries()) {
        retireTileDriver(activeTrackId, activeEntry, 'sidecar-changed');
        clearTileEnginePublishedFeedReceipt(activeTrackId, tileEnginePublisherEpoch);
        trackLifecycle.set(activeTrackId, { phase: 'loading' });
      }
      tileEngineDriversRef.current.clear();
      detachPresentedFrameSubscriptionIfIdle();
      clearAllTrackRecovery();
      tileEngineLastCommitPlanKeyRef.current = null;
      const pending = tileEngineLastRangeRef.current;
      if (pending?.contextKey === tileEngineReplayContextKeyRef.current) {
        streamPileupViaTileEngineRef.current?.(pending.range);
      }
    },
    [
      clearAllTrackRecovery,
      clearAllTrackStallWatches,
      detachPresentedFrameSubscriptionIfIdle,
      tileEnginePublisherEpoch,
      trackLifecycle,
    ]
  );

  const scheduleTrackRecovery = useCallback<ScheduleTrackRecovery>(
    (trackId, driver, reason, options): void => {
      const entry = tileEngineDriversRef.current.get(trackId);
      if (!entry || entry.driver !== driver) return;
      clearTrackStallWatch(trackId);
      if (options?.requiredReadBand) {
        entry.pendingPresentation = null;
        detachPresentedFrameSubscriptionIfIdle();
      }
      recordAlignedReadLifecycleDebugEvent({
        trackId,
        reason,
        classification: classifyAlignedReadTileFailure(reason),
        sourceKey: entry.sourceKey,
        generation: entry.generation,
        planKey: entry.planKey,
      });
      const hasLastGood = entry.lastPresentedRange !== null;
      if (classifyAlignedReadTileFailure(reason) === 'permanent') {
        clearTrackRecovery(trackId);
        entry.pendingPresentation = null;
        detachPresentedFrameSubscriptionIfIdle();
        if (reason === 'http-409') {
          retireTileDriver(trackId, entry, 'source-generation-conflict');
          tileEngineDriversRef.current.delete(trackId);
          tileEnginePublishedPayloadsRef.current.delete(trackId);
          clearTileEnginePublishedFeedReceipt(trackId, tileEnginePublisherEpoch);
          const renderer = webglRef.current?.getLinearRenderer?.();
          renderer?.setTrackData(trackId, {
            dataAuthority: 'tile-engine',
            records: [],
            ...pileupCoverageCutoffData(
              activeStressDatasetsRef.current.find((dataset) => dataset.trackId === trackId)
            ),
          });
          webglRef.current?.requestRender?.();
        }
        trackLifecycle.set(trackId, alignedReadBlockedStatus(reason, hasLastGood));
        return;
      }

      let recovery = tileEngineRecoveryRef.current.get(trackId);
      if (
        !recovery ||
        recovery.sourceKey !== entry.sourceKey ||
        recovery.generation !== entry.generation ||
        recovery.planKey !== entry.planKey
      ) {
        clearTrackRecovery(trackId);
        recovery = {
          sourceKey: entry.sourceKey,
          generation: entry.generation,
          planKey: entry.planKey,
          reason,
          completedAttempts: 0,
          timer: null,
          retrying: false,
          sidecarRefreshAttempted: false,
          terminal: false,
          requiresReadBand: options?.requiredReadBand === true,
        };
        tileEngineRecoveryRef.current.set(trackId, recovery);
      } else {
        recovery.reason = reason;
        recovery.requiresReadBand ||= options?.requiredReadBand === true;
      }

      if (recovery.terminal) return;
      if (recovery.timer != null || recovery.retrying) return;
      const delayMs = options?.immediate
        ? 0
        : alignedReadRetryDelayMs(reason, recovery.completedAttempts);
      if (delayMs == null) {
        recovery.terminal = true;
        recovery.retrying = false;
        entry.pendingPresentation = null;
        detachPresentedFrameSubscriptionIfIdle();
        trackLifecycle.set(trackId, alignedReadBlockedStatus(reason, hasLastGood));
        return;
      }

      trackLifecycle.set(trackId, {
        phase: 'recovering',
        attempt: recovery.completedAttempts + 1,
        hasLastGood,
      });
      const recoveryEpisode = recovery;
      const retryCurrentEntry = async (): Promise<void> => {
        recoveryEpisode.timer = null;
        recoveryEpisode.retrying = true;
        let refreshedBaseUrl: string | null = null;
        const retryReason = recoveryEpisode.reason;
        if (retryReason === 'fetch-failed' && !recoveryEpisode.sidecarRefreshAttempted) {
          recoveryEpisode.sidecarRefreshAttempted = true;
          try {
            refreshedBaseUrl = await resolveSidecarBaseUrl('tile-engine');
          } catch {}
        }

        if (tileEngineRecoveryRef.current.get(trackId) !== recoveryEpisode) return;
        const current = tileEngineDriversRef.current.get(trackId);
        if (
          !current ||
          current.driver !== driver ||
          current.sourceKey !== recoveryEpisode.sourceKey ||
          current.generation !== recoveryEpisode.generation ||
          current.planKey !== recoveryEpisode.planKey
        ) {
          return;
        }
        recoveryEpisode.retrying = false;
        recoveryEpisode.completedAttempts += 1;

        if (refreshedBaseUrl && refreshedBaseUrl !== tileEngineBaseUrlRef.current) {
          replaceTileEngineSidecarUrl(refreshedBaseUrl);
          return;
        }

        const currentDataset = activeStressDatasetsRef.current.find(
          (dataset) => dataset.trackId === trackId && isTileEngineOwnedPileupDataset(dataset)
        );
        const remoteTransportOwnsTimeout = Boolean(currentDataset?.source?.remote);
        if (
          currentDataset?.source?.remote &&
          reconnectRemoteTrack &&
          (retryReason === 'fetch-failed' || retryReason === 'timeout' || retryReason === 'stalled')
        ) {
          let sourceHealthy = false;
          try {
            sourceHealthy = await remoteSourceProbe(currentDataset.source);
          } catch {
            sourceHealthy = false;
          }
          if (tileEngineRecoveryRef.current.get(trackId) !== recoveryEpisode) return;
          if (!sourceHealthy) {
            try {
              await reconnectRemoteTrack(trackId);
            } catch {}
          }
        }

        if (tileEngineRecoveryRef.current.get(trackId) !== recoveryEpisode) return;
        const retryEntry = tileEngineDriversRef.current.get(trackId);
        if (retryEntry !== current) return;

        current.pendingPresentation = null;
        detachPresentedFrameSubscriptionIfIdle();
        current.requestSequence += 1;
        current.lastProgressSignature = null;
        armTrackStallWatch(trackId, current);
        current.driver.retryCurrentViewport({
          restartPending: retryReason === 'stalled' && !remoteTransportOwnsTimeout,
        });
      };
      if (delayMs === 0) {
        void retryCurrentEntry();
      } else {
        recoveryEpisode.timer = window.setTimeout(() => {
          void retryCurrentEntry();
        }, delayMs);
      }
    },
    [
      clearTrackRecovery,
      clearTrackStallWatch,
      armTrackStallWatch,
      detachPresentedFrameSubscriptionIfIdle,
      replaceTileEngineSidecarUrl,
      reconnectRemoteTrack,
      remoteSourceProbe,
      tileEnginePublisherEpoch,
      trackLifecycle,
      webglRef,
    ]
  );
  scheduleTrackRecoveryRef.current = scheduleTrackRecovery;

  const scheduleSidecarResolutionRecovery = useCallback(
    function scheduleSidecarResolutionRecovery(pending: PendingTileEngineReplay): void {
      let recovery = sidecarResolutionRecoveryRef.current;
      if (
        !recovery ||
        recovery.contextKey !== pending.contextKey ||
        recovery.planKey !== pending.planKey
      ) {
        clearSidecarResolutionRecovery();
        recovery = {
          contextKey: pending.contextKey,
          planKey: pending.planKey,
          completedAttempts: 0,
          timer: null,
          retrying: false,
          terminal: false,
        };
        sidecarResolutionRecoveryRef.current = recovery;
      }
      if (recovery.terminal || recovery.timer != null || recovery.retrying) return;

      const delayMs = alignedReadRetryDelayMs('fetch-failed', recovery.completedAttempts);
      if (delayMs == null) {
        recovery.terminal = true;
        for (const trackId of tileEngineOwnedTrackIdsRef.current) {
          trackLifecycle.set(trackId, alignedReadBlockedStatus('fetch-failed', false));
        }
        return;
      }

      for (const trackId of tileEngineOwnedTrackIdsRef.current) {
        trackLifecycle.set(trackId, {
          phase: 'recovering',
          attempt: recovery.completedAttempts + 1,
          hasLastGood: false,
        });
      }
      const scheduledRecovery = recovery;
      scheduledRecovery.timer = window.setTimeout(() => {
        scheduledRecovery.timer = null;
        scheduledRecovery.retrying = true;
        tileEngineUrlResolvingRef.current = true;
        void resolveSidecarBaseUrl('tile-engine')
          .then((url) => {
            if (sidecarResolutionRecoveryRef.current !== scheduledRecovery) return;
            scheduledRecovery.retrying = false;
            tileEngineUrlResolvingRef.current = false;
            if (pending.contextKey !== tileEngineReplayContextKeyRef.current) {
              clearSidecarResolutionRecovery();
              return;
            }
            tileEngineBaseUrlRef.current = url;
            clearSidecarResolutionRecovery();
            for (const trackId of tileEngineOwnedTrackIdsRef.current) {
              trackLifecycle.set(trackId, { phase: 'loading' });
            }
            const currentPending = tileEngineLastRangeRef.current;
            if (currentPending?.contextKey === pending.contextKey) {
              streamPileupViaTileEngineRef.current?.(currentPending.range);
            }
          })
          .catch(() => {
            if (sidecarResolutionRecoveryRef.current !== scheduledRecovery) return;
            scheduledRecovery.retrying = false;
            scheduledRecovery.completedAttempts += 1;
            tileEngineUrlResolvingRef.current = false;
            scheduleSidecarResolutionRecovery(pending);
          });
      }, delayMs);
    },
    [clearSidecarResolutionRecovery, trackLifecycle]
  );

  const retryTrack = useCallback(
    (trackId: string): void => {
      const entry = tileEngineDriversRef.current.get(trackId);
      const source = activeStressDatasetsRef.current.find(
        (dataset) => dataset.trackId === trackId && dataset.kind === 'pileup'
      )?.source;
      clearTrackRecovery(trackId);
      clearTrackStallWatch(trackId);
      trackLifecycle.set(trackId, { phase: 'loading' });
      if (source?.remote && reconnectRemoteTrack) {
        void reconnectRemoteTrack(trackId).catch(() => undefined);
      }
      if (entry) {
        entry.pendingPresentation = null;
        detachPresentedFrameSubscriptionIfIdle();
        entry.requestSequence += 1;
        const expectedSourceKey = entry.sourceKey;
        const expectedGeneration = entry.generation;
        const expectedPlanKey = entry.planKey;
        void resolveSidecarBaseUrl('tile-engine')
          .then((refreshedBaseUrl) => {
            const current = tileEngineDriversRef.current.get(trackId);
            if (
              !current ||
              current !== entry ||
              current.sourceKey !== expectedSourceKey ||
              current.generation !== expectedGeneration ||
              current.planKey !== expectedPlanKey
            ) {
              return;
            }
            if (refreshedBaseUrl !== tileEngineBaseUrlRef.current) {
              replaceTileEngineSidecarUrl(refreshedBaseUrl);
              return;
            }
            beginTrackStreaming(trackId, current);
            current.driver.retryCurrentViewport();
          })
          .catch(() => {
            const current = tileEngineDriversRef.current.get(trackId);
            if (
              !current ||
              current !== entry ||
              current.sourceKey !== expectedSourceKey ||
              current.generation !== expectedGeneration ||
              current.planKey !== expectedPlanKey
            ) {
              return;
            }
            scheduleTrackRecovery(trackId, current.driver, 'fetch-failed');
          });
        return;
      }
      clearSidecarResolutionRecovery();
      tileEngineBaseUrlRef.current = null;
      tileEngineUrlResolvingRef.current = false;
      tileEngineLastCommitPlanKeyRef.current = null;
      const pending = tileEngineLastRangeRef.current;
      if (pending?.contextKey === tileEngineReplayContextKeyRef.current) {
        streamPileupViaTileEngineRef.current?.(pending.range);
      }
    },
    [
      beginTrackStreaming,
      clearSidecarResolutionRecovery,
      clearTrackRecovery,
      clearTrackStallWatch,
      detachPresentedFrameSubscriptionIfIdle,
      replaceTileEngineSidecarUrl,
      reconnectRemoteTrack,
      scheduleTrackRecovery,
      trackLifecycle,
    ]
  );

  const dispatchPileupViaTileEngine = useCallback(
    (range: PileupRange, contextKey: string): boolean => {
      if (!enabledRef.current) return false;
      const asm = rendererAssembly;
      if (!asm || containerWidth <= 0) return false;
      const dataRange = normalizeTileEngineDataRange(range, asm.totalLengthBp);
      if (!dataRange) return false;
      const renderer = webglRef.current?.getLinearRenderer?.();
      if (!renderer) return false;
      if (!activeStressDatasets.some(isTileEngineOwnedPileupDataset)) return false;
      const baseUrl = tileEngineBaseUrlRef.current;
      if (baseUrl == null) return false;
      if (contextKey !== tileEngineReplayContextKeyRef.current) return false;
      const planKey = tileEngineCommitPlanKey(dataRange, asm, containerWidth);
      if (!planKey) return false;

      let drove = false;
      for (const ds of activeStressDatasets) {
        if (!isTileEngineOwnedPileupDataset(ds)) continue;
        const trackId = ds.trackId;
        const sourceKey = tileEngineDriverSourceKey(asm, baseUrl, ds, referencePathsKey);
        let entry = tileEngineDriversRef.current.get(trackId);
        if (entry && entry.sourceKey !== sourceKey) {
          clearTrackRecovery(trackId);
          clearTrackStallWatch(trackId);
          retireTileDriver(trackId, entry, 'source-identity-changed');
          tileEngineDriversRef.current.delete(trackId);
          tileEnginePublishedPayloadsRef.current.delete(trackId);
          clearTileEnginePublishedFeedReceipt(trackId, tileEnginePublisherEpoch);
          trackLifecycle.set(trackId, { phase: 'loading' });
          renderer.setTrackData(trackId, {
            dataAuthority: 'tile-engine',
            records: [],
            ...pileupCoverageCutoffData(ds),
          });
          entry = undefined;
        }
        if (!entry) {
          const driver = new TileEngineDriver({
            assembly: asm,
            source: {
              bamPath: ds.source.bamPath,
              indexPath: ds.source.indexPath,
              referencePath: ds.source.referencePath,
              generation: ds.source.generation,
              remote: ds.source.remote,
              grantExpiresAtMs: ds.source.grantExpiresAtMs,
              htsget: ds.source.htsget,
            },
            referencePathsByChrom,
            baseUrl,
            timeoutMs:
              ds.source.remote == null
                ? LOCAL_ALIGNED_READ_TILE_TIMEOUT_MS
                : REMOTE_ALIGNED_READ_TILE_TIMEOUT_MS,
            onTileError: ({ key, reason }) =>
              scheduleTrackRecovery(trackId, driver, reason, {
                requiredReadBand: key.sourceId.startsWith('aln:'),
              }),
            onReadPresentationReuse: (presentation) => {
              if (!enabledRef.current) return;
              const currentAssembly = rendererAssemblyRef.current;
              const currentDataset = activeStressDatasetsRef.current.find(
                (dataset) => dataset.trackId === trackId && isTileEngineOwnedPileupDataset(dataset)
              );
              const currentMap = webglRef.current;
              const renderer = currentMap?.getLinearRenderer?.();
              const currentEntry = tileEngineDriversRef.current.get(trackId);
              const payload = tileEnginePublishedPayloadsRef.current.get(trackId);
              const currentRange = currentAssembly
                ? normalizeTileEngineDataRange(
                    currentMap?.getViewportRange?.(),
                    currentAssembly.totalLengthBp
                  )
                : null;
              const reusedRange = currentAssembly
                ? normalizeTileEngineDataRange(
                    presentation.viewRange,
                    currentAssembly.totalLengthBp
                  )
                : null;
              const currentPlanKey =
                currentRange && currentAssembly
                  ? tileEngineCommitPlanKey(
                      currentRange,
                      currentAssembly,
                      containerWidthRef.current
                    )
                  : null;
              const kind = alignedReadReadyKindForFeed(presentation.feed);
              if (
                !isCurrentTileEngineFeedSource({
                  currentAssembly,
                  currentBaseUrl: tileEngineBaseUrlRef.current,
                  currentDataset,
                  sourceKey,
                  referencePathsKey: referencePathsKeyRef.current,
                }) ||
                currentEntry?.driver !== driver ||
                currentEntry.sourceKey !== sourceKey ||
                !currentMap ||
                !renderer ||
                currentEntry.publishedRenderer !== renderer ||
                renderer !== presentationRendererRef.current ||
                payload?.records !== presentation.feed.records ||
                !currentRange ||
                !pileupRangesEqual(currentRange, reusedRange) ||
                !pileupRangesEqual(currentEntry.currentRange, currentRange) ||
                currentEntry.planKey !== currentPlanKey ||
                (kind !== 'reads' && kind !== 'empty')
              )
                return;
              firstInteractionReadinessRef.current.noteCoverageFeed(
                renderer,
                trackId,
                currentRange,
                { ...presentation.feed, viewRange: currentRange }
              );
              const status = trackLifecycle.getSnapshot()[trackId];
              if (
                (pileupRangesEqual(currentEntry.pendingPresentation?.range ?? null, currentRange) &&
                  currentEntry.pendingPresentation?.kind === kind &&
                  currentEntry.pendingPresentation.requiredReadBandReady ===
                    presentation.requiredReadBandReady) ||
                (pileupRangesEqual(currentEntry.lastPresentedRange, currentRange) &&
                  status?.phase === 'ready' &&
                  status.kind === kind)
              )
                return;
              if (status?.phase === 'ready') beginTrackStreaming(trackId, currentEntry);
              tileEnginePublicationSequenceRef.current += 1;
              currentEntry.pendingPresentation = {
                sourceKey: currentEntry.sourceKey,
                generation: currentEntry.generation,
                rendererGeneration: presentationRendererGenerationRef.current,
                requestSequence: currentEntry.requestSequence,
                publicationSequence: tileEnginePublicationSequenceRef.current,
                planKey: currentEntry.planKey,
                range: currentRange,
                kind,
                requiredReadBandReady: presentation.requiredReadBandReady,
              };
              ensurePresentedFrameSubscription(currentMap);
              currentMap.requestRender?.();
            },
            onCoverageAtlasReuse: (presentation) => {
              if (!enabledRef.current) return;
              const currentAssembly = rendererAssemblyRef.current;
              const currentDataset = activeStressDatasetsRef.current.find(
                (dataset) => dataset.trackId === trackId && isTileEngineOwnedPileupDataset(dataset)
              );
              const currentMap = webglRef.current;
              const renderer = currentMap?.getLinearRenderer?.();
              const currentEntry = tileEngineDriversRef.current.get(trackId);
              const payload = tileEnginePublishedPayloadsRef.current.get(trackId);
              const currentRange = currentAssembly
                ? normalizeTileEngineDataRange(
                    currentMap?.getViewportRange?.(),
                    currentAssembly.totalLengthBp
                  )
                : null;
              const reusedRange = currentAssembly
                ? normalizeTileEngineDataRange(
                    presentation.viewRange,
                    currentAssembly.totalLengthBp
                  )
                : null;
              const currentPlanKey =
                currentRange && currentAssembly
                  ? tileEngineCommitPlanKey(
                      currentRange,
                      currentAssembly,
                      containerWidthRef.current
                    )
                  : null;
              if (
                !isCurrentTileEngineFeedSource({
                  currentAssembly,
                  currentBaseUrl: tileEngineBaseUrlRef.current,
                  currentDataset,
                  sourceKey,
                  referencePathsKey: referencePathsKeyRef.current,
                }) ||
                currentEntry?.driver !== driver ||
                !currentMap ||
                !renderer ||
                currentEntry.publishedRenderer !== renderer ||
                renderer !== presentationRendererRef.current ||
                payload?.coverageGpuAtlas !== presentation.coverageGpuAtlas ||
                payload.coverageGpuAtlasPresentation !== 'active' ||
                !currentRange ||
                !pileupRangesEqual(currentRange, reusedRange) ||
                currentEntry.planKey !== currentPlanKey
              )
                return;
              firstInteractionReadinessRef.current.noteCoverageFeed(
                renderer,
                trackId,
                currentRange,
                {
                  records: [],
                  viewRange: currentRange,
                  coverageGpuAtlas: presentation.coverageGpuAtlas,
                  coverageGpuAtlasPresentation: 'active',
                  ownerPresentation: { kind: 'coverage' },
                  fullAssemblyInteractionCorridorReady:
                    presentation.fullAssemblyInteractionCorridorReady,
                }
              );
              if (
                pileupRangesEqual(currentEntry.pendingPresentation?.range ?? null, currentRange) ||
                (pileupRangesEqual(currentEntry.lastPresentedRange, currentRange) &&
                  trackLifecycle.getSnapshot()[trackId]?.phase === 'ready')
              )
                return;
              tileEnginePublicationSequenceRef.current += 1;
              currentEntry.pendingPresentation = {
                sourceKey: currentEntry.sourceKey,
                generation: currentEntry.generation,
                rendererGeneration: presentationRendererGenerationRef.current,
                requestSequence: currentEntry.requestSequence,
                publicationSequence: tileEnginePublicationSequenceRef.current,
                planKey: currentEntry.planKey,
                range: currentRange,
                kind: 'coverage',
              };
              ensurePresentedFrameSubscription(currentMap);
              currentMap?.requestRender?.();
            },
            onFeed: (feed) => {
              if (!enabledRef.current) return;
              if (tileEngineDriversRef.current.get(trackId)?.driver !== driver) return;
              const currentAssembly = rendererAssemblyRef.current;
              const currentBaseUrl = tileEngineBaseUrlRef.current;
              const currentDataset = activeStressDatasetsRef.current.find(
                (dataset) => dataset.trackId === trackId && isTileEngineOwnedPileupDataset(dataset)
              );
              if (
                !isCurrentTileEngineFeedSource({
                  currentAssembly,
                  currentBaseUrl,
                  currentDataset,
                  sourceKey,
                  referencePathsKey: referencePathsKeyRef.current,
                })
              ) {
                return;
              }
              const currentRange = webglRef.current?.getViewportRange?.() ?? null;
              const currentDataRange = normalizeTileEngineDataRange(
                currentRange,
                asm.totalLengthBp
              );
              const feedViewRange = normalizeTileEngineDataRange(feed.viewRange, asm.totalLengthBp);
              const progressEntry = tileEngineDriversRef.current.get(trackId);
              const progressPlanKey =
                currentDataRange && currentAssembly
                  ? tileEngineCommitPlanKey(
                      currentDataRange,
                      currentAssembly,
                      containerWidthRef.current
                    )
                  : null;
              if (
                progressEntry?.driver === driver &&
                currentDataRange &&
                pileupRangesEqual(currentDataRange, feedViewRange) &&
                progressEntry.planKey === progressPlanKey
              ) {
                const currentStatus = trackLifecycle.getSnapshot()[trackId];
                const progressSignature = alignedReadFeedProgressSignature(feed);
                if (
                  progressEntry.lastProgressSignature !== progressSignature &&
                  (currentStatus?.phase === 'loading' ||
                    currentStatus?.phase === 'refreshing' ||
                    currentStatus?.phase === 'recovering' ||
                    currentStatus?.phase === 'stalled')
                ) {
                  progressEntry.lastProgressSignature = progressSignature;
                  const awaitingRecoveredPresentation =
                    currentStatus?.phase === 'recovering' &&
                    alignedReadReadyKindForFeed(feed) !== null;
                  if (!awaitingRecoveredPresentation) {
                    trackLifecycle.set(
                      trackId,
                      progressEntry.lastPresentedRange
                        ? { phase: 'refreshing', hasLastGood: true }
                        : { phase: 'loading' }
                    );
                  }
                  armTrackStallWatch(trackId, progressEntry);
                }
              }
              if (
                shouldVetoTileEngineCoverageMiss({
                  currentDataRange,
                  coverage: feed.coverage,
                })
              ) {
                recordTileEngineFeedDebug(trackId, feed, {
                  publisherEpoch: tileEnginePublisherEpoch,
                  sourceKey,
                  setTrackDataMs: 0,
                  published: false,
                  vetoReason: 'coverage-misses-current-viewport',
                  currentRange: currentDataRange,
                  feedViewRange,
                });
                return;
              }
              const currentWebgl = webglRef.current;
              const r = currentWebgl?.getLinearRenderer?.();
              if (
                shouldVetoTransientEmptyTileEngineFeed({
                  feed,
                  currentDataRange,
                  feedViewRange,
                  renderer: r,
                  trackId,
                })
              ) {
                recordTileEngineFeedDebug(trackId, feed, {
                  publisherEpoch: tileEnginePublisherEpoch,
                  sourceKey,
                  setTrackDataMs: 0,
                  published: false,
                  vetoReason: 'transient-no-presentable-coverage',
                  currentRange: currentDataRange,
                  feedViewRange,
                });
                return;
              }
              if (!r) return;
              const setTrackDataStartedAt =
                typeof performance !== 'undefined' ? performance.now() : Date.now();
              const previousPayload = tileEnginePublishedPayloadsRef.current.get(trackId);
              const retainedCoverage = retainPreviousTileEngineCoverage({
                feed,
                previousPayload,
                currentDataRange,
              });
              const publishedCoverageGpuAtlas =
                feed.coverageGpuAtlas ?? previousPayload?.coverageGpuAtlas;
              const publishedCoverageGpuAtlasPresentation =
                feed.coverageGpuAtlasPresentation ?? previousPayload?.coverageGpuAtlasPresentation;
              const presentationKind = alignedReadReadyKindForFeed(feed);
              trackLifecycle.setIntervals(trackId, feed.referenceIntervals ?? []);
              const terminalCoverageError =
                feed.coveragePresentation?.kind === 'none' &&
                feed.coveragePresentation.reason === 'target-error';
              const retainsCommittedExactOwner =
                !terminalCoverageError &&
                presentationKind !== 'reads' &&
                presentationKind !== 'empty';
              const publishedRecords = retainsCommittedExactOwner
                ? (previousPayload?.records ?? [])
                : feed.records;
              const publishedReadSource = retainsCommittedExactOwner
                ? previousPayload?.readSource
                : feed.readSource
                  ? {
                      ...feed.readSource,
                      sourceGenerationKey: alignedReadSourceGenerationKey(
                        currentDataset?.source?.generation
                      ),
                      presentationOwnerKey: sourceKey,
                    }
                  : undefined;
              const publishedPayload: PileupTrackData = {
                dataAuthority: 'tile-engine',
                ...pileupCoverageCutoffData(
                  activeStressDatasetsRef.current.find((dataset) => dataset.trackId === trackId)
                ),
                coverage: feed.coverage ?? retainedCoverage,
                ...(publishedCoverageGpuAtlas
                  ? { coverageGpuAtlas: publishedCoverageGpuAtlas }
                  : {}),
                ...(publishedCoverageGpuAtlasPresentation
                  ? {
                      coverageGpuAtlasPresentation: publishedCoverageGpuAtlasPresentation,
                    }
                  : {}),
                ...((feed.coverageLod ??
                (retainedCoverage ? previousPayload?.coverageLod : undefined))
                  ? {
                      coverageLod:
                        feed.coverageLod ??
                        (retainedCoverage ? previousPayload?.coverageLod : undefined),
                    }
                  : {}),
                records: publishedRecords,
                alternateColumns: feed.alternateColumns ?? [],
                referenceIntervals: feed.referenceIntervals ?? [],
                ...(publishedReadSource ? { readSource: publishedReadSource } : {}),
              };
              tileEnginePublishedPayloadsRef.current.set(trackId, publishedPayload);
              r.setTrackData(trackId, publishedPayload);
              onTrackDataPublishedRef.current?.(trackId, publishedPayload);
              const currentEntry = tileEngineDriversRef.current.get(trackId);
              if (currentEntry?.driver === driver && currentEntry.publishedRenderer !== r) {
                currentEntry.pendingPresentation = null;
                detachPresentedFrameSubscriptionIfIdle();
                if (trackLifecycle.getSnapshot()[trackId]?.phase === 'ready') {
                  beginTrackStreaming(trackId, currentEntry);
                }
              }
              const rendererGeneration = adoptPresentationRenderer(r);
              if (currentEntry?.driver === driver) currentEntry.publishedRenderer = r;
              const computedPlanKey =
                currentDataRange && currentAssembly
                  ? tileEngineCommitPlanKey(
                      currentDataRange,
                      currentAssembly,
                      containerWidthRef.current
                    )
                  : null;
              const lifecyclePresentationAccepted = Boolean(
                currentEntry?.driver === driver &&
                presentationKind !== null &&
                currentDataRange &&
                pileupRangesEqual(currentDataRange, feedViewRange) &&
                currentEntry.planKey === computedPlanKey
              );
              if (
                lifecyclePresentationAccepted &&
                currentEntry &&
                currentDataRange &&
                presentationKind !== null
              ) {
                tileEnginePublicationSequenceRef.current += 1;
                const pendingPresentation: PendingAlignedReadPresentation = {
                  sourceKey: currentEntry.sourceKey,
                  generation: currentEntry.generation,
                  rendererGeneration,
                  requestSequence: currentEntry.requestSequence,
                  publicationSequence: tileEnginePublicationSequenceRef.current,
                  planKey: currentEntry.planKey,
                  range: currentDataRange,
                  kind: presentationKind,
                  requiredReadBandReady: feed.requiredReadBandReady,
                };
                currentEntry.pendingPresentation = pendingPresentation;
              }
              if (lifecyclePresentationAccepted && currentWebgl) {
                ensurePresentedFrameSubscription(currentWebgl);
              }
              currentWebgl?.requestRender?.();
              firstInteractionReadinessRef.current.noteCoverageFeed(
                r,
                trackId,
                currentDataRange,
                feed
              );
              const setTrackDataMs =
                (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
                setTrackDataStartedAt;
              recordTileEngineFeedDebug(trackId, feed, {
                publisherEpoch: tileEnginePublisherEpoch,
                sourceKey,
                setTrackDataMs,
                published: true,
                vetoReason: null,
                currentRange: currentDataRange,
                feedViewRange,
                ownerPresentationKind: feed.ownerPresentation?.kind ?? null,
                lifecyclePresentationAccepted,
                lifecycleEntryPlanKey: currentEntry?.planKey ?? null,
                lifecycleComputedPlanKey: computedPlanKey,
              });
            },
          });
          if (typeof window !== 'undefined') {
            const w = tileEngineWindow();
            w.__tileEngineDebug = () => {
              const out: Record<string, unknown> = {};
              const currentRange = webglRef.current?.getViewportRange?.() ?? null;
              const currentDataRange = normalizeTileEngineDataRange(
                currentRange,
                asm.totalLengthBp
              );
              const currentWidth = containerWidthRef.current;
              const viewportPx = pileupDensitySampleColumnCount(currentWidth);
              for (const [tid, activeEntry] of tileEngineDriversRef.current.entries()) {
                const currentPlanKey = currentDataRange
                  ? tileEngineCommitPlanKey(currentDataRange, asm, currentWidth)
                  : null;
                const recovery = tileEngineRecoveryRef.current.get(tid);
                out[tid] = {
                  ...activeEntry.driver.debugSnapshot(
                    currentDataRange
                      ? { start: currentDataRange.start, end: currentDataRange.end, viewportPx }
                      : undefined
                  ),
                  alignedReadLifecycle: {
                    retirements: (
                      window as AlignedReadLifecycleDebugWindow
                    ).__alignedReadLifecycleDebugEvents
                      ?.filter(
                        (event) => event.trackId === tid && event.classification === 'retired'
                      )
                      .map((event) => ({
                        reason: event.reason,
                        generation: event.generation,
                        atEpochMs: event.atEpochMs,
                        sourceMatchesCurrent: event.sourceKey === activeEntry.sourceKey,
                      })),
                    status: trackLifecycle.getSnapshot()[tid] ?? null,
                    sourceKey: activeEntry.sourceKey,
                    generation: activeEntry.generation,
                    requestSequence: activeEntry.requestSequence,
                    planKey: activeEntry.planKey,
                    currentPlanKey,
                    currentRange: activeEntry.currentRange,
                    lastPresentedRange: activeEntry.lastPresentedRange,
                    pendingPresentation: activeEntry.pendingPresentation,
                    recovery: recovery
                      ? {
                          sourceKey: recovery.sourceKey,
                          generation: recovery.generation,
                          planKey: recovery.planKey,
                          reason: recovery.reason,
                          completedAttempts: recovery.completedAttempts,
                          timerScheduled: recovery.timer !== null,
                          retrying: recovery.retrying,
                          terminal: recovery.terminal,
                        }
                      : null,
                  },
                };
              }
              return out;
            };
            w.__tileEngineDriver = {
              built: (w.__tileEngineDriver?.built ?? 0) + 1,
              baseUrl,
            };
          }
          tileEngineDriverGenerationSequence += 1;
          entry = {
            driver,
            sourceKey,
            generation: tileEngineDriverGenerationSequence,
            requestSequence: 1,
            planKey,
            currentRange: dataRange,
            lastPresentedRange: null,
            lastProgressSignature: null,
            publishedRenderer: null,
            pendingPresentation: null,
          };
          tileEngineDriversRef.current.set(trackId, entry);
          beginTrackStreaming(trackId, entry);
        } else if (entry.planKey !== planKey) {
          clearTrackRecovery(trackId);
          entry.requestSequence += 1;
          entry.planKey = planKey;
          entry.currentRange = dataRange;
          entry.pendingPresentation = null;
          detachPresentedFrameSubscriptionIfIdle();
          beginTrackStreaming(trackId, entry);
        } else if (
          trackLifecycle.getSnapshot()[trackId]?.phase === 'ready' &&
          !pileupRangesEqual(entry.lastPresentedRange, dataRange)
        ) {
          clearTrackRecovery(trackId);
          entry.requestSequence += 1;
          entry.currentRange = dataRange;
          entry.pendingPresentation = null;
          detachPresentedFrameSubscriptionIfIdle();
          beginTrackStreaming(trackId, entry);
        }
        entry.driver.setViewport(
          { start: dataRange.start, end: dataRange.end },
          pileupDensitySampleColumnCount(containerWidth),
          containerWidth
        );
        drove = true;
      }
      return drove;
    },
    [
      activeStressDatasets,
      armTrackStallWatch,
      beginTrackStreaming,
      clearTrackRecovery,
      clearTrackStallWatch,
      containerWidth,
      detachPresentedFrameSubscriptionIfIdle,
      referencePathsByChrom,
      referencePathsKey,
      rendererAssembly,
      scheduleTrackRecovery,
      adoptPresentationRenderer,
      ensurePresentedFrameSubscription,
      tileEnginePublisherEpoch,
      trackLifecycle,
      webglRef,
    ]
  );

  const commitTileEnginePending = useCallback(
    (pending: PendingTileEngineReplay): boolean => {
      tileEnginePendingCommitRef.current = null;
      const committed = dispatchPileupViaTileEngine(pending.range, pending.contextKey);
      if (committed) {
        tileEngineLastCommitMsRef.current =
          typeof performance !== 'undefined' ? performance.now() : Date.now();
        tileEngineLastCommitPlanKeyRef.current = pending.planKey;
      }
      return committed;
    },
    [dispatchPileupViaTileEngine]
  );

  const presentPileupViaTileEngine = useCallback(
    (range: PileupRange, contextKey: string): boolean => {
      if (!enabledRef.current) return false;
      const asm = rendererAssembly;
      if (!asm || containerWidth <= 0) return false;
      const dataRange = normalizeTileEngineDataRange(range, asm.totalLengthBp);
      if (!dataRange) return false;
      const baseUrl = tileEngineBaseUrlRef.current;
      if (baseUrl == null) return false;
      if (contextKey !== tileEngineReplayContextKeyRef.current) return false;
      const viewportPx = pileupDensitySampleColumnCount(containerWidth);
      const presentable: Array<{ driver: TileEngineDriver; range: PileupRange }> = [];
      for (const ds of activeStressDatasets) {
        if (!isTileEngineOwnedPileupDataset(ds)) continue;
        const entry = tileEngineDriversRef.current.get(ds.trackId);
        if (!entry) continue;
        if (entry.sourceKey !== tileEngineDriverSourceKey(asm, baseUrl, ds, referencePathsKey)) {
          continue;
        }
        const planKey = tileEngineCommitPlanKey(dataRange, asm, containerWidth);
        if (!planKey) continue;
        if (entry.planKey !== planKey) {
          clearTrackRecovery(ds.trackId);
          entry.requestSequence += 1;
          entry.planKey = planKey;
          entry.pendingPresentation = null;
          detachPresentedFrameSubscriptionIfIdle();
          beginTrackStreaming(ds.trackId, entry);
        }
        entry.currentRange = dataRange;
        presentable.push({ driver: entry.driver, range: dataRange });
      }
      if (presentable.length === 0) return false;
      let presented = true;
      for (const entry of presentable) {
        presented =
          entry.driver.presentViewport(
            { start: entry.range.start, end: entry.range.end },
            viewportPx,
            containerWidth
          ) && presented;
      }
      return presented;
    },
    [
      activeStressDatasets,
      beginTrackStreaming,
      clearTrackRecovery,
      containerWidth,
      detachPresentedFrameSubscriptionIfIdle,
      referencePathsKey,
      rendererAssembly,
      trackLifecycle,
    ]
  );

  const flushPendingTileEngineCommit = useCallback(() => {
    tileEngineCommitTimerRef.current = null;
    const pending = tileEnginePendingCommitRef.current;
    if (!pending) return;
    if (pending.contextKey !== tileEngineReplayContextKeyRef.current) {
      tileEnginePendingCommitRef.current = null;
      return;
    }
    commitTileEnginePending(pending);
  }, [commitTileEnginePending]);
  useLayoutEffect(() => {
    flushPendingTileEngineCommitRef.current = flushPendingTileEngineCommit;
  }, [flushPendingTileEngineCommit]);

  const streamPileupViaTileEngine = useCallback(
    (range: PileupRange | null | undefined): boolean => {
      if (!enabledRef.current) return false;
      const asm = rendererAssembly;
      if (!range || !tileEngineReplayContextKey || !asm) return false;
      const dataRange = normalizeTileEngineDataRange(range, asm.totalLengthBp);
      if (!dataRange) return false;
      const planKey = tileEngineCommitPlanKey(dataRange, asm, containerWidth);
      if (!planKey) return false;
      return firstInteractionReadiness.batch(() => {
        firstInteractionReadiness.noteViewport(
          webglRef.current?.getLinearRenderer?.() ?? null,
          dataRange
        );
        const pending = {
          range: dataRange,
          contextKey: tileEngineReplayContextKey,
          planKey,
        };
        tileEngineLastRangeRef.current = pending;
        const baseUrl = tileEngineBaseUrlRef.current;
        if (baseUrl == null) {
          const existingRecovery = sidecarResolutionRecoveryRef.current;
          if (
            existingRecovery &&
            existingRecovery.contextKey === pending.contextKey &&
            existingRecovery.planKey === pending.planKey
          ) {
            return true;
          }
          if (existingRecovery) clearSidecarResolutionRecovery();
          if (!tileEngineUrlResolvingRef.current) {
            tileEngineUrlResolvingRef.current = true;
            void resolveSidecarBaseUrl('tile-engine')
              .then((url) => {
                tileEngineUrlResolvingRef.current = false;
                const currentPending = tileEngineLastRangeRef.current;
                if (
                  currentPending?.contextKey === pending.contextKey &&
                  pending.contextKey === tileEngineReplayContextKeyRef.current
                ) {
                  tileEngineBaseUrlRef.current = url;
                  streamPileupViaTileEngineRef.current?.(currentPending.range);
                } else {
                  tileEngineLastRangeRef.current = null;
                }
              })
              .catch(() => {
                tileEngineUrlResolvingRef.current = false;
                const currentPending = tileEngineLastRangeRef.current;
                if (
                  currentPending?.contextKey === pending.contextKey &&
                  currentPending.contextKey === tileEngineReplayContextKeyRef.current
                ) {
                  scheduleSidecarResolutionRecovery(currentPending);
                }
              });
          }
          return true;
        }
        const presentedFromTargetGrid = presentPileupViaTileEngine(
          pending.range,
          pending.contextKey
        );
        if (planKey === tileEngineLastCommitPlanKeyRef.current) {
          const everyCurrentTrackHasDriver = activeStressDatasets
            .filter(isTileEngineOwnedPileupDataset)
            .every((dataset) => {
              const entry = tileEngineDriversRef.current.get(dataset.trackId);
              return (
                entry?.sourceKey ===
                tileEngineDriverSourceKey(asm, baseUrl, dataset, referencePathsKey)
              );
            });
          if (presentedFromTargetGrid && everyCurrentTrackHasDriver) return true;
          clearTileEngineCommitTimer();
          return commitTileEnginePending(pending);
        }
        tileEnginePendingCommitRef.current = pending;

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const lastCommitMs = tileEngineLastCommitMsRef.current;
        const elapsed = lastCommitMs == null ? Number.POSITIVE_INFINITY : now - lastCommitMs;
        if (
          shouldCommitTileEnginePlanImmediately(
            tileEngineLastCommitPlanKeyRef.current,
            planKey,
            elapsed
          )
        ) {
          clearTileEngineCommitTimer();
          return commitTileEnginePending(pending);
        }

        if (tileEngineCommitTimerRef.current == null) {
          tileEngineCommitTimerRef.current = window.setTimeout(
            () => flushPendingTileEngineCommitRef.current(),
            Math.max(0, TILE_ENGINE_CAMERA_COMMIT_MIN_MS - elapsed)
          );
        }
        return true;
      });
    },
    [
      clearTileEngineCommitTimer,
      clearSidecarResolutionRecovery,
      commitTileEnginePending,
      containerWidth,
      flushPendingTileEngineCommit,
      firstInteractionReadiness,
      activeStressDatasets,
      presentPileupViaTileEngine,
      referencePathsKey,
      rendererAssembly,
      scheduleSidecarResolutionRecovery,
      tileEngineReplayContextKey,
      webglRef,
    ]
  );
  streamPileupViaTileEngineRef.current = streamPileupViaTileEngine;

  useEffect(() => {
    if (!enabled || !rendererAssembly || containerWidth <= 0) return;
    const range = normalizeTileEngineDataRange(
      webglRef.current?.getViewportRange?.(),
      rendererAssembly.totalLengthBp
    );
    if (!range) return;
    const planKey = tileEngineCommitPlanKey(range, rendererAssembly, containerWidth);
    if (!planKey) return;
    const needsCurrentPlan = tileEngineOwnedTrackIdsRef.current.some(
      (trackId) => tileEngineDriversRef.current.get(trackId)?.planKey !== planKey
    );
    if (needsCurrentPlan) streamPileupViaTileEngineRef.current?.(range);
  }, [containerWidth, enabled, rendererAssembly, webglRef]);

  useEffect(() => {
    const liveTrackIds = new Set([
      ...tileEngineOwnedTrackIds,
      ...admissionBlockedPileupTracks.map(({ trackId }) => trackId),
      ...remoteConnectionPileupTracks.map(({ trackId }) => trackId),
    ]);
    trackLifecycle.retain(liveTrackIds);
    for (const trackId of liveTrackIds) {
      if (!trackLifecycle.getSnapshot()[trackId]) {
        trackLifecycle.set(trackId, { phase: 'loading' });
      }
    }
    for (const { trackId, admissionError } of admissionBlockedPileupTracks) {
      trackLifecycle.set(trackId, {
        phase: 'blocked',
        message: admissionError,
        action: 'repair',
        hasLastGood: false,
      });
    }
    const liveRemoteTrackIds = new Set<string>();
    for (const { trackId, sessionId, connection } of remoteConnectionPileupTracks) {
      liveRemoteTrackIds.add(trackId);
      if (admissionBlockedPileupTracks.some((entry) => entry.trackId === trackId)) continue;
      if (connection.state === 'connecting' || (connection.state === 'online' && !sessionId)) {
        trackLifecycle.set(trackId, { phase: 'loading' });
      } else if (connection.state === 'needs-authentication') {
        trackLifecycle.set(trackId, {
          phase: 'waiting-for-authentication',
          hasLastGood: connection.transportGeneration > 0,
        });
      } else if (connection.state === 'retrying') {
        trackLifecycle.set(trackId, {
          phase: 'recovering',
          attempt: Math.max(1, connection.attempt),
          hasLastGood: connection.transportGeneration > 0,
        });
      } else if (connection.state === 'blocked') {
        trackLifecycle.set(trackId, {
          phase: 'blocked',
          message: connection.lastFailure?.message ?? 'The remote source needs attention.',
          action: 'repair',
          hasLastGood: connection.transportGeneration > 0,
        });
      }

      const previousGeneration = remoteTransportGenerationsRef.current.get(trackId) ?? 0;
      remoteTransportGenerationsRef.current.set(trackId, connection.transportGeneration);
      if (
        sessionId &&
        connection.state === 'online' &&
        previousGeneration > 0 &&
        connection.transportGeneration > previousGeneration
      ) {
        const entry = tileEngineDriversRef.current.get(trackId);
        if (entry) {
          clearTrackRecovery(trackId);
          clearTrackStallWatch(trackId);
          entry.pendingPresentation = null;
          detachPresentedFrameSubscriptionIfIdle();
          entry.requestSequence += 1;
          entry.lastProgressSignature = null;
          armTrackStallWatch(trackId, entry);
          trackLifecycle.set(trackId, { phase: 'refreshing', hasLastGood: true });
          entry.driver.retryCurrentViewport({ restartPending: true });
        } else {
          const range = webglRef.current?.getViewportRange?.() ?? null;
          if (range) streamPileupViaTileEngineRef.current?.(range);
        }
      }
    }
    for (const trackId of [...remoteTransportGenerationsRef.current.keys()]) {
      if (!liveRemoteTrackIds.has(trackId)) remoteTransportGenerationsRef.current.delete(trackId);
    }
  }, [
    admissionBlockedPileupTracks,
    armTrackStallWatch,
    clearTrackRecovery,
    clearTrackStallWatch,
    detachPresentedFrameSubscriptionIfIdle,
    remoteConnectionPileupTracks,
    tileEngineOwnedTrackIds,
    trackLifecycle,
    webglRef,
  ]);

  useEffect(() => {
    const wasEnabled = previouslyEnabledRef.current;
    previouslyEnabledRef.current = enabled;
    if (enabled) {
      const missingCurrentDriver = tileEngineOwnedTrackIds.some(
        (trackId) => !tileEngineDriversRef.current.has(trackId)
      );
      if (!wasEnabled || missingCurrentDriver) {
        for (const trackId of tileEngineOwnedTrackIds) {
          trackLifecycle.set(trackId, { phase: 'loading' });
        }
        const range = webglRef.current?.getViewportRange?.() ?? null;
        if (range) streamPileupViaTileEngineRef.current?.(range);
      }
      return;
    }

    clearTileEngineCommitTimer();
    tileEnginePendingCommitRef.current = null;
    tileEngineLastCommitPlanKeyRef.current = null;
    tileEngineLastCommitMsRef.current = null;
    clearAllTrackRecovery();
    clearAllTrackStallWatches();
    clearSidecarResolutionRecovery();
    tileEngineUrlResolvingRef.current = false;
    for (const [trackId, entry] of tileEngineDriversRef.current) {
      retireTileDriver(trackId, entry, 'view-inactive');
    }
    tileEngineDriversRef.current.clear();
    detachPresentedFrameSubscriptionIfIdle();
  }, [
    clearAllTrackRecovery,
    clearAllTrackStallWatches,
    clearSidecarResolutionRecovery,
    clearTileEngineCommitTimer,
    detachPresentedFrameSubscriptionIfIdle,
    enabled,
    tileEngineOwnedTrackIds,
    trackLifecycle,
    webglRef,
  ]);

  useEffect(() => {
    const webgl = webglRef.current;
    const renderer = webgl?.getLinearRenderer?.();
    if (!renderer || typeof renderer.updateTrackData !== 'function') return;
    let presentationChanged = false;
    for (const dataset of activeStressDatasets) {
      if (dataset.kind !== 'pileup') continue;
      presentationChanged =
        renderer.updateTrackData<PileupTrackData>(dataset.trackId, (current) => {
          const coverageCutoffDepth = normalizedPileupCoverageCutoff(dataset);
          if (coverageCutoffDepth === null) {
            if (current.coverageCutoffDepth === undefined) return current;
            const next = { ...current };
            delete next.coverageCutoffDepth;
            return next;
          }
          return current.coverageCutoffDepth === coverageCutoffDepth
            ? current
            : { ...current, coverageCutoffDepth };
        }) || presentationChanged;
    }
    if (presentationChanged) webgl?.requestRender?.();
  }, [activeStressDatasets, webglRef]);

  useEffect(() => {
    const live = new Set(
      activeStressDatasets.filter(isTileEngineOwnedPileupDataset).map((d) => d.trackId)
    );
    const renderer = webglRef.current?.getLinearRenderer?.();
    for (const [trackId, entry] of [...tileEngineDriversRef.current.entries()]) {
      if (!live.has(trackId)) {
        clearTrackRecovery(trackId);
        clearTrackStallWatch(trackId);
        const admissionError = activeStressDatasets.find((dataset) => dataset.trackId === trackId)
          ?.source?.admissionError;
        retireTileDriver(
          trackId,
          entry,
          admissionError ? 'track-admission-blocked' : 'track-not-streaming'
        );
        tileEngineDriversRef.current.delete(trackId);
        tileEnginePublishedPayloadsRef.current.delete(trackId);
        clearTileEnginePublishedFeedReceipt(trackId, tileEnginePublisherEpoch);
        if (admissionError) {
          trackLifecycle.set(trackId, {
            phase: 'blocked',
            message: admissionError,
            action: 'repair',
            hasLastGood: false,
          });
        } else {
          trackLifecycle.remove(trackId);
        }
        renderer?.setTrackData(
          trackId,
          pileupTrackDataAfterTileEngineDispose(
            activeStressDatasets.find((dataset) => dataset.trackId === trackId)
          )
        );
      }
    }
    detachPresentedFrameSubscriptionIfIdle();
  }, [
    activeStressDatasets,
    clearTrackRecovery,
    clearTrackStallWatch,
    detachPresentedFrameSubscriptionIfIdle,
    tileEnginePublisherEpoch,
    trackLifecycle,
    webglRef,
  ]);

  useEffect(() => {
    if (rendererAssembly) return;
    clearTileEngineCommitTimer();
    tileEnginePendingCommitRef.current = null;
    clearSidecarResolutionRecovery();
    tileEngineUrlResolvingRef.current = false;
    const renderer = webglRef.current?.getLinearRenderer?.();
    for (const [trackId, entry] of tileEngineDriversRef.current.entries()) {
      clearTrackRecovery(trackId);
      clearTrackStallWatch(trackId);
      retireTileDriver(trackId, entry, 'assembly-unavailable');
      tileEnginePublishedPayloadsRef.current.delete(trackId);
      clearTileEnginePublishedFeedReceipt(trackId, tileEnginePublisherEpoch);
      trackLifecycle.remove(trackId);
      renderer?.setTrackData(
        trackId,
        pileupTrackDataAfterTileEngineDispose(
          activeStressDatasets.find((dataset) => dataset.trackId === trackId)
        )
      );
    }
    tileEngineDriversRef.current.clear();
    detachPresentedFrameSubscriptionIfIdle();
  }, [
    activeStressDatasets,
    clearTrackRecovery,
    clearTrackStallWatch,
    clearSidecarResolutionRecovery,
    clearTileEngineCommitTimer,
    detachPresentedFrameSubscriptionIfIdle,
    rendererAssembly,
    tileEnginePublisherEpoch,
    trackLifecycle,
    webglRef,
  ]);

  useEffect(() => {
    const drivers = tileEngineDriversRef.current;
    const publishedPayloads = tileEnginePublishedPayloadsRef.current;
    return () => {
      clearTileEngineCommitTimer();
      clearAllTrackRecovery();
      clearAllTrackStallWatches();
      clearSidecarResolutionRecovery();
      tileEnginePendingCommitRef.current = null;
      for (const [trackId, entry] of drivers) {
        retireTileDriver(trackId, entry, 'viewer-unmounted');
        publishedPayloads.delete(trackId);
        clearTileEnginePublishedFeedReceipt(trackId, tileEnginePublisherEpoch);
      }
      drivers.clear();
      detachPresentedFrameSubscription();
      trackLifecycle.clear();
    };
  }, [
    clearAllTrackRecovery,
    clearAllTrackStallWatches,
    clearSidecarResolutionRecovery,
    clearTileEngineCommitTimer,
    detachPresentedFrameSubscription,
    tileEnginePublisherEpoch,
    trackLifecycle,
  ]);

  return useMemo(
    () => ({
      streamPileupViaTileEngine,
      firstInteractionReadiness,
      trackLifecycle,
      retryTrack,
      noteLaneContractWired,
    }),
    [
      firstInteractionReadiness,
      noteLaneContractWired,
      retryTrack,
      streamPileupViaTileEngine,
      trackLifecycle,
    ]
  );
}

function isPileupPresentationRenderer(renderer: object): renderer is PileupPresentationRenderer {
  return (
    'setTrackData' in renderer &&
    typeof (renderer as { setTrackData?: unknown }).setTrackData === 'function'
  );
}

function isTileEngineOwnedPileupDataset(
  dataset: ActiveStressDataset
): dataset is ActiveStressDataset & {
  kind: 'pileup';
  source: ActiveStressDataset['source'] & { bamPath: string };
} {
  return (
    dataset.kind === 'pileup' &&
    Boolean(dataset.source?.bamPath) &&
    !dataset.source?.admissionError &&
    (!dataset.source?.remote || Boolean(dataset.source.remote.sessionId))
  );
}

function coverageSignalCoversRange(
  coverage: CoverageSignal | undefined,
  range: PileupRange
): boolean {
  if (!coverage || coverage.binSize <= 0 || coverage.bins.length === 0) return false;
  const start = coverage.startBp ?? 0;
  const end = start + coverage.bins.length * coverage.binSize;
  const minRange = Math.min(range.start, range.end);
  const maxRange = Math.max(range.start, range.end);
  return minRange >= start - 1 && maxRange <= end + 1;
}

function coverageSignalOverlapsRange(
  coverage: CoverageSignal | undefined,
  range: PileupRange
): boolean {
  if (!coverage || coverage.binSize <= 0 || coverage.bins.length === 0) return false;
  const start = coverage.startBp ?? 0;
  const end = start + coverage.bins.length * coverage.binSize;
  const minRange = Math.min(range.start, range.end);
  const maxRange = Math.max(range.start, range.end);
  return start < maxRange && minRange < end;
}

function isTransientNoCoverageFeed(feed: TileEngineFeed): boolean {
  if (feed.ownerPresentation?.kind === 'empty') return false;
  const presentation = feed.coveragePresentation;
  if (presentation?.kind === 'none') return presentation.reason !== 'target-error';
  return true;
}

function alignedReadReadyKindForFeed(feed: TileEngineFeed): AlignedReadTrackReadyKind | null {
  const owner = feed.ownerPresentation?.kind;
  if (owner === 'coverage' || owner === 'reads' || owner === 'empty') return owner;
  if (owner === 'pending') return null;
  if (feed.records.length > 0) return 'reads';
  if (feed.coverage || (feed.coverageGpuAtlas && feed.coverageGpuAtlasPresentation !== 'standby')) {
    return 'coverage';
  }
  return null;
}

function rendererCoverageOverlapsRange(
  renderer: unknown,
  trackId: string,
  range: PileupRange | null
): boolean {
  if (!range) return false;
  const diagnostics = (
    renderer as
      | {
          getTrackDiagnostics?: (trackId: string) => {
            coverageSignalStartBp?: unknown;
            coverageSignalEndBp?: unknown;
            activeCoverageBinSize?: unknown;
          } | null;
        }
      | null
      | undefined
  )?.getTrackDiagnostics?.(trackId);
  const start = diagnostics?.coverageSignalStartBp;
  const end = diagnostics?.coverageSignalEndBp;
  const binSize = diagnostics?.activeCoverageBinSize;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    typeof binSize !== 'number' ||
    binSize <= 0
  ) {
    return false;
  }
  const minRange = Math.min(range.start, range.end);
  const maxRange = Math.max(range.start, range.end);
  return start < maxRange && minRange < end;
}

function pileupRangesEqual(a: PileupRange | null, b: PileupRange | null): boolean {
  if (!a || !b || ![a.start, a.end, b.start, b.end].every(Number.isFinite)) return false;
  const equalCoordinate = (left: number, right: number): boolean => {
    if (left === right) return true;
    const magnitude = Math.max(Math.abs(left), Math.abs(right));
    let exponent = Math.floor(Math.log2(magnitude));
    if (2 ** exponent > magnitude) exponent -= 1;
    const ulp = Math.max(Number.MIN_VALUE, 2 ** (exponent - 52));
    return Math.abs(left - right) <= Math.min(1e-6, ulp * 4);
  };
  return equalCoordinate(a.start, b.start) && equalCoordinate(a.end, b.end);
}

function alignedReadFeedProgressSignature(feed: TileEngineFeed): string {
  const pendingShape = (feed.referenceIntervals ?? [])
    .map((interval) => `${interval.state}:${interval.startBp}:${interval.endBp}`)
    .join(',');
  return [
    feed.ownerPresentation?.kind ?? 'unknown',
    pendingShape,
    feed.records.length,
    feed.alternateColumns?.length ?? 0,
    feed.readSource?.windowStartBp ?? '',
    feed.readSource?.windowEndBp ?? '',
    feed.readSource?.truncated === true ? 1 : 0,
  ].join('|');
}

function tileEngineCommitPlanKey(
  range: PileupRange,
  assembly: Assembly | null,
  containerWidth: number
): string | null {
  if (!assembly || containerWidth <= 0) return null;
  const viewportPx = pileupDensitySampleColumnCount(containerWidth);
  if (!(viewportPx > 0)) return null;
  const span = Math.max(1, range.end - range.start);
  const level = baseLevelForBpPerPx(span / viewportPx, maxLevelForAssembly(assembly));
  const levelSpanBp = tileSpanBp(level);
  const maxIndex = Math.max(0, Math.floor((assembly.totalLengthBp - 1) / levelSpanBp));
  const firstCore = Math.max(0, Math.min(maxIndex, tileIndex(range.start, level)));
  const lastCore = Math.max(0, Math.min(maxIndex, tileIndex(range.end - 1, level)));
  const firstResident = Math.max(0, firstCore - 1);
  const lastResident = Math.min(maxIndex, lastCore + 1);
  return [
    `L${level}`,
    `core:${firstCore}-${lastCore}`,
    `resident:${firstResident}-${lastResident}`,
    `px:${viewportPx}`,
  ].join('|');
}

function shouldCommitTileEnginePlanImmediately(
  previousPlanKey: string | null,
  nextPlanKey: string,
  elapsedMs: number
): boolean {
  if (!previousPlanKey) return true;
  const nextLevel = tileEnginePlanLevel(nextPlanKey);
  const previousLevel = tileEnginePlanLevel(previousPlanKey);
  if (
    nextLevel != null &&
    previousLevel != null &&
    nextLevel <= TILE_ENGINE_CRITICAL_FINE_COMMIT_LEVEL &&
    nextLevel < previousLevel
  ) {
    return true;
  }
  return elapsedMs >= TILE_ENGINE_CAMERA_COMMIT_MIN_MS;
}

function tileEnginePlanLevel(planKey: string | null): number | null {
  const match = planKey?.match(/^L(\d+)\|/);
  if (!match) return null;
  const level = Number(match[1]);
  return Number.isFinite(level) ? level : null;
}

function tileEngineFeedDebugTiming(
  feed: TileEngineFeed,
  setTrackDataMs: number
): TileEngineFeedDebugTiming {
  return {
    totalMs: feed.debugTimings?.totalMs ?? 0,
    coverageComposeMs: feed.debugTimings?.coverageComposeMs ?? 0,
    coverageMaxDepthMs: feed.debugTimings?.coverageMaxDepthMs ?? 0,
    readsComposeMs: feed.debugTimings?.readsComposeMs ?? 0,
    setTrackDataMs,
    recordCount: feed.debugTimings?.recordCount ?? feed.records.length,
    coverageBinCount: feed.debugTimings?.coverageBinCount ?? feed.coverage?.bins.length ?? 0,
    coverageBinSize: feed.debugTimings?.coverageBinSize ?? feed.coverage?.binSize ?? null,
    targetLevel: feed.debugTimings?.targetLevel,
    coverageMemoMaterializeCount: feed.debugTimings?.coverageMemoMaterializeCount,
    coverageMemoRevisionChangeCount: feed.debugTimings?.coverageMemoRevisionChangeCount,
    exactCoverageRecordScanCount: feed.debugTimings?.exactCoverageRecordScanCount,
    exactCoverageGeneration: feed.debugTimings?.exactCoverageGeneration,
    viewStartBp: feed.debugTimings?.viewStartBp,
    viewEndBp: feed.debugTimings?.viewEndBp,
    coveragePresentationKind: feed.debugTimings?.coveragePresentationKind,
    coveragePresentationReason: feed.debugTimings?.coveragePresentationReason,
    coverageAuthority: feed.coverageLod?.authority ?? null,
    coverageProvenanceExact: feed.coverageLod?.provenanceExact ?? null,
    coverageProvenanceMethod: feed.coverageLod?.provenanceMethod ?? null,
    coverageProvenanceSource: feed.coverageLod?.provenanceSource ?? null,
    coverageSourceLevel: feed.coverageLod?.sourceLevel ?? null,
    coverageSourceBinSize: feed.coverageLod?.sourceBinSize ?? null,
    targetCoveragePending: feed.debugTimings?.targetCoveragePending,
    targetCoverageErrored: feed.debugTimings?.targetCoverageErrored,
    currentCoverageBinSize: feed.debugTimings?.currentCoverageBinSize,
    mixedCoverageBinSize: feed.debugTimings?.mixedCoverageBinSize,
    residentCoverageCandidateCount: feed.debugTimings?.residentCoverageCandidateCount,
  };
}

function tileEngineGpuAtlasDebugFields(feed: TileEngineFeed): {
  coverageGpuAtlasAuthorityKey: string | null;
  coverageGpuAtlasSourceIdentity: string | null;
  coverageGpuAtlasAssemblyFingerprint: string | null;
  coverageGpuAtlasStatistic: string | null;
  coverageGpuAtlasPayloadRevision: string | null;
  coverageGpuAtlasBaseBinSizeBp: number | null;
} {
  return {
    coverageGpuAtlasAuthorityKey: feed.coverageGpuAtlas?.authorityKey ?? null,
    coverageGpuAtlasSourceIdentity: feed.coverageGpuAtlas?.sourceIdentity ?? null,
    coverageGpuAtlasAssemblyFingerprint: feed.coverageGpuAtlas?.assemblyFingerprint ?? null,
    coverageGpuAtlasStatistic: feed.coverageGpuAtlas?.statistic ?? null,
    coverageGpuAtlasPayloadRevision: feed.coverageGpuAtlas?.payloadRevision ?? null,
    coverageGpuAtlasBaseBinSizeBp: feed.coverageGpuAtlas?.baseBinSizeBp ?? null,
  };
}

function shouldVetoTileEngineCoverageMiss(args: {
  currentDataRange: ReturnType<typeof normalizeTileEngineDataRange>;
  coverage: TileEngineFeed['coverage'];
}): boolean {
  return Boolean(
    args.currentDataRange &&
    args.coverage &&
    !coverageSignalCoversRange(args.coverage, args.currentDataRange) &&
    !coverageSignalOverlapsRange(args.coverage, args.currentDataRange)
  );
}

function shouldVetoTransientEmptyTileEngineFeed(args: {
  feed: TileEngineFeed;
  currentDataRange: ReturnType<typeof normalizeTileEngineDataRange>;
  feedViewRange: ReturnType<typeof normalizeTileEngineDataRange>;
  renderer: unknown;
  trackId: string;
}): boolean {
  const presentsCoverageGpuAtlas =
    args.feed.coverageGpuAtlas != null && args.feed.coverageGpuAtlasPresentation !== 'standby';
  if (
    args.feed.coverage ||
    presentsCoverageGpuAtlas ||
    args.feed.records.length !== 0 ||
    (args.feed.alternateColumns?.length ?? 0) !== 0 ||
    !isTransientNoCoverageFeed(args.feed)
  ) {
    return false;
  }
  const staleFeedRange =
    args.currentDataRange && !pileupRangesEqual(args.currentDataRange, args.feedViewRange);
  const currentCoverageRetained =
    !staleFeedRange &&
    rendererCoverageOverlapsRange(args.renderer, args.trackId, args.currentDataRange);
  return Boolean(staleFeedRange || currentCoverageRetained);
}

function retainPreviousTileEngineCoverage(args: {
  feed: TileEngineFeed;
  previousPayload: PileupTrackData | undefined;
  currentDataRange: ReturnType<typeof normalizeTileEngineDataRange>;
}): PileupTrackData['coverage'] | undefined {
  if (
    !args.feed.coverage &&
    args.feed.records.length > 0 &&
    args.previousPayload?.coverage &&
    args.currentDataRange &&
    coverageSignalOverlapsRange(args.previousPayload.coverage, args.currentDataRange)
  ) {
    return args.previousPayload.coverage;
  }
  return undefined;
}

function isCurrentTileEngineFeedSource(args: {
  currentAssembly: Assembly | null | undefined;
  currentBaseUrl: string | null;
  currentDataset: ActiveStressDataset | undefined;
  sourceKey: string;
  referencePathsKey: string;
}): boolean {
  return Boolean(
    args.currentAssembly &&
    args.currentBaseUrl !== null &&
    args.currentDataset &&
    args.sourceKey ===
      tileEngineDriverSourceKey(
        args.currentAssembly,
        args.currentBaseUrl,
        args.currentDataset,
        args.referencePathsKey
      )
  );
}

function recordTileEngineFeedDebug(
  trackId: string,
  feed: TileEngineFeed,
  state: {
    publisherEpoch: string;
    sourceKey: string;
    setTrackDataMs: number;
    published: boolean;
    vetoReason: string | null;
    currentRange: TileEngineFeedDebugRange;
    feedViewRange: TileEngineFeedDebugRange;
    ownerPresentationKind?: string | null;
    lifecyclePresentationAccepted?: boolean;
    lifecycleEntryPlanKey?: string | null;
    lifecycleComputedPlanKey?: string | null;
  }
): void {
  if (typeof window === 'undefined') return;
  const w = tileEngineWindow();
  if (w.__webglDiagnosticsEnabled !== true && w.__webglExposeForTests !== true) return;
  const prev = w.__tileEngineFeed;
  const feedCount = (prev?.feeds ?? 0) + 1;
  const timing = tileEngineFeedDebugTiming(feed, state.setTrackDataMs);
  const gpuAtlas = tileEngineGpuAtlasDebugFields(feed);
  const slowFeeds = [...(prev?.slowFeeds ?? []), { feeds: feedCount, ...timing }]
    .sort((a, b) => {
      const aCost = Math.max(a.totalMs, a.setTrackDataMs);
      const bCost = Math.max(b.totalMs, b.setTrackDataMs);
      return bCost - aCost;
    })
    .slice(0, 8);
  const presentation = feed.coveragePresentation;
  w.__tileEngineFeed = {
    feeds: feedCount,
    publishedFeeds: (prev?.publishedFeeds ?? 0) + (state.published ? 1 : 0),
    suppressedFeeds: (prev?.suppressedFeeds ?? 0) + (state.published ? 0 : 1),
    lastRecords: feed.records.length,
    maxRecords: Math.max(prev?.maxRecords ?? 0, feed.records.length),
    lastCovBin: feed.coverage?.binSize ?? null,
    coverageRole: feed.coverageLod?.role ?? null,
    coverageLevel: feed.coverageLod?.level ?? null,
    targetLevel: feed.coverageLod?.targetLevel ?? feed.debugTimings?.targetLevel ?? null,
    coverageAuthority: feed.coverageLod?.authority ?? null,
    coverageProvenanceMethod: feed.coverageLod?.provenanceMethod ?? null,
    presentationKind: presentation?.kind ?? null,
    presentationReason: presentation?.kind === 'none' ? presentation.reason : null,
    ownerPresentationKind: state.ownerPresentationKind,
    lifecyclePresentationAccepted: state.lifecyclePresentationAccepted,
    lifecycleEntryPlanKey: state.lifecycleEntryPlanKey,
    lifecycleComputedPlanKey: state.lifecycleComputedPlanKey,
    ...gpuAtlas,
    published: state.published,
    vetoReason: state.vetoReason,
    currentRange: state.currentRange,
    feedViewRange: state.feedViewRange,
    trackId,
    lastTiming: timing,
    maxTotalMs: Math.max(prev?.maxTotalMs ?? 0, timing.totalMs),
    maxReadsComposeMs: Math.max(prev?.maxReadsComposeMs ?? 0, timing.readsComposeMs),
    maxSetTrackDataMs: Math.max(prev?.maxSetTrackDataMs ?? 0, timing.setTrackDataMs),
    slowFeeds,
  };
  if (state.published) {
    const receipts = w.__tileEnginePublishedFeedReceipts ?? new Map();
    w.__tileEnginePublishedFeedReceipts = receipts;
    const previousPublished = receipts.get(trackId);
    const receipt: TileEnginePublishedFeedReceipt = {
      contract: 'tile-engine-published-feed-receipt.v1',
      trackId,
      publisherEpoch: state.publisherEpoch,
      sourceKey: state.sourceKey,
      publicationSequence:
        previousPublished?.publisherEpoch === state.publisherEpoch
          ? previousPublished.publicationSequence + 1
          : 1,
      publishedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      currentRange: state.currentRange,
      feedViewRange: state.feedViewRange,
      published: true,
      targetLevel: feed.coverageLod?.targetLevel ?? feed.debugTimings?.targetLevel ?? null,
      coverageLevel: feed.coverageLod?.level ?? null,
      coverageRole: feed.coverageLod?.role ?? null,
      ...gpuAtlas,
      coverageMemoMaterializeCount: feed.debugTimings?.coverageMemoMaterializeCount ?? null,
      coverageMemoRevisionChangeCount: feed.debugTimings?.coverageMemoRevisionChangeCount ?? null,
      exactCoverageRecordScanCount: feed.debugTimings?.exactCoverageRecordScanCount ?? null,
      exactCoverageGeneration: feed.debugTimings?.exactCoverageGeneration ?? null,
      setTrackDataMs: state.setTrackDataMs,
    };
    receipts.set(trackId, receipt);
    w.__tileEnginePublishedFeedSnapshot = (requestedTrackId) => {
      const current = w.__tileEnginePublishedFeedReceipts?.get(requestedTrackId);
      return current ? { ...current } : null;
    };
  }
}

function normalizeTileEngineDataRange(
  range: PileupRange | null | undefined,
  length: number
): PileupRange | null {
  if (!range || !(length > 0) || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
    return null;
  }
  const rawStart = Math.min(range.start, range.end);
  const rawEnd = Math.max(range.start, range.end);
  const start = Math.max(0, Math.min(length, rawStart));
  const end = Math.max(start, Math.min(length, rawEnd));
  return end > start ? { start, end } : null;
}

function tileEngineDriverSourceKey(
  assembly: Assembly,
  baseUrl: string,
  dataset: ActiveStressDataset,
  referencePathsKey: string
): string {
  const source = dataset.source;
  let assemblyCache = TILE_ENGINE_DRIVER_SOURCE_KEY_CACHE.get(assembly);
  if (!assemblyCache) {
    assemblyCache = new WeakMap();
    TILE_ENGINE_DRIVER_SOURCE_KEY_CACHE.set(assembly, assemblyCache);
  }
  const cached = assemblyCache.get(dataset);
  const generationKey = alignedReadSourceGenerationKey(source?.generation);
  const grantExpiresAtMs = source?.grantExpiresAtMs ?? 0;
  if (
    cached?.baseUrl === baseUrl &&
    cached.referencePathsKey === referencePathsKey &&
    cached.bamPath === (source?.bamPath ?? '') &&
    cached.indexPath === (source?.indexPath ?? '') &&
    cached.referencePath === (source?.referencePath ?? '') &&
    cached.generationKey === generationKey &&
    cached.grantExpiresAtMs === grantExpiresAtMs
  ) {
    return cached.key;
  }
  const key = [
    tileEngineAssemblyKey(assembly),
    baseUrl,
    source?.bamPath ?? '',
    source?.indexPath ?? '',
    source?.referencePath ?? '',
    generationKey,
    String(grantExpiresAtMs),
    referencePathsKey,
  ].join('\0');
  assemblyCache.set(dataset, {
    baseUrl,
    referencePathsKey,
    bamPath: source?.bamPath ?? '',
    indexPath: source?.indexPath ?? '',
    referencePath: source?.referencePath ?? '',
    generationKey,
    grantExpiresAtMs,
    key,
  });
  return key;
}

export function tileEngineReplayKey(
  assembly: Assembly,
  datasets: ReadonlyArray<ActiveStressDataset>,
  referencePathsKey: string
): string {
  return [
    tileEngineAssemblyKey(assembly),
    referencePathsKey,
    datasets
      .filter(isTileEngineOwnedPileupDataset)
      .map((dataset) => {
        const source = dataset.source;
        return [
          dataset.trackId,
          source.bamPath,
          source.indexPath ?? '',
          source.referencePath ?? '',
          alignedReadSourceGenerationKey(source.generation),
          String(source.grantExpiresAtMs ?? 0),
        ].join(':');
      })
      .sort()
      .join('|'),
  ].join('\0');
}

function tileEngineReferencePathsKey(
  assembly: Assembly | null,
  referencePathsByChrom: ReadonlyMap<string, string> | undefined
): string {
  if (!assembly || !referencePathsByChrom) return '';
  return assembly.chromosomes
    .map((placement) => {
      const chrom = placement.chromosome.id;
      return `${chrom}\0${referencePathsByChrom.get(chrom) ?? ''}`;
    })
    .join('\u0001');
}

function tileEngineAssemblyKey(assembly: Assembly): string {
  const cached = TILE_ENGINE_ASSEMBLY_KEY_CACHE.get(assembly);
  if (cached) return cached;
  const key = [
    assembly.id,
    assembly.totalLengthBp,
    assembly.chromosomes
      .map(
        (placement) =>
          `${placement.chromosome.id}:${placement.globalStartBp}:${placement.globalEndBp}:${placement.chromosome.length}`
      )
      .join('|'),
  ].join('\0');
  TILE_ENGINE_ASSEMBLY_KEY_CACHE.set(assembly, key);
  return key;
}

function staticPileupTrackData(dataset: ActiveStressDataset | undefined): {
  dataAuthority: 'static';
  records: ReadonlyArray<PileupRecord>;
  coverage?: ActiveStressDataset['coverage'];
  coverageCutoffDepth?: number;
} {
  if (!dataset || dataset.kind !== 'pileup') {
    return { dataAuthority: 'static', records: [] };
  }
  return {
    dataAuthority: 'static',
    records: dataset.pileupRecords ?? (dataset.records as ReadonlyArray<PileupRecord>),
    ...(dataset.coverage ? { coverage: dataset.coverage } : {}),
    ...pileupCoverageCutoffData(dataset),
  };
}

function pileupTrackDataAfterTileEngineDispose(dataset: ActiveStressDataset | undefined):
  | {
      dataAuthority: 'tile-engine';
      records: [];
      coverageCutoffDepth?: number;
    }
  | ReturnType<typeof staticPileupTrackData> {
  if (dataset?.kind === 'pileup' && dataset.source?.bamPath) {
    return {
      dataAuthority: 'tile-engine',
      records: [],
      ...pileupCoverageCutoffData(dataset),
    };
  }
  return staticPileupTrackData(dataset);
}

function normalizedPileupCoverageCutoff(dataset: ActiveStressDataset | undefined): number | null {
  const value = dataset?.coverageCutoffDepth;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function pileupCoverageCutoffData(
  dataset: ActiveStressDataset | undefined
): { coverageCutoffDepth: number } | Record<string, never> {
  const value = normalizedPileupCoverageCutoff(dataset);
  return value === null ? {} : { coverageCutoffDepth: value };
}
