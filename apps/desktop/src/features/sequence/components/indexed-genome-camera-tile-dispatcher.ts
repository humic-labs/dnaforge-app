import type { IndexedGenomeManifest } from '@waypoint/genome-data';
import type {
  GenomeTileRequest,
  GenomeTrackDescriptor,
  GenomeTrackTile,
} from '../../../shared/indexed-genome';
import {
  markRendererInteractionActivity,
  rendererInteractionQuietDelayMs,
} from '../../../lib/renderer-interaction-activity';
import {
  createAnnotationTileSemaphoreState,
  decideDispatch as decideSemaphoreDispatch,
  recordActiveCleared as recordSemaphoreActiveCleared,
  recordActiveStarted as recordSemaphoreActiveStarted,
  recordQueuedSupersede as recordSemaphoreQueuedSupersede,
  type AnnotationTileSemaphoreState,
} from './annotation-tile-semaphore';
import {
  ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
  decideAnnotationViewportTilePolicy,
  type AnnotationTilePending,
} from './indexed-annotation-tile-policy';
import { decideHysteresis, type HysteresisSample } from './annotation-tile-hysteresis';
import {
  annotationViewportCoverageFromTile,
  annotationViewportTileFromGenomeTile,
  retainAnnotationViewportCoverages,
  shouldDeferAnnotationViewportTileCommit,
  type AnnotationViewportTileState,
} from './indexed-genome-viewer-viewport';
import { buildAnnotationTileRequest } from './indexed-annotation-tile-request';
import { sourceFingerprintForManifest } from './indexed-genome-viewer-scene-state';
import { type LaneLimit } from './stable-lane-assignment';

export const ANNOTATION_VIEWPORT_TILE_COALESCE_MS = 48;

export type AnnotationViewportTileRequestInput = {
  reportedCenterBp: number;
  handleCenterBp?: number | null;
  viewportRange?: { start: number; end: number } | null;
  reason: 'scroll' | 'zoom';
  deferMs?: number;
};

export type CoalescedCameraChange = {
  reportedCenterBp: number;
  reason: 'scroll' | 'zoom';
  viewportRange: Readonly<{ start: number; end: number }> | null;
};

export type IndexedGenomeCameraTileHost = {
  isAssembly: boolean;
  length: number;
  containerWidth: number;
  sessionId: string | undefined;
  manifest: IndexedGenomeManifest;
  visibleTypes: ReadonlySet<string>;
  laneLimit: LaneLimit;
  debugInstanceId: string;
  recordEvent: (event: string, detail?: Record<string, unknown>) => void;
  setPending: (pending: AnnotationTilePending | null) => void;
  commitTile: (tile: AnnotationViewportTileState, reason: 'immediate' | 'camera-idle') => void;
  flushResidentPage: () => void;
  onTrackError: (kind: GenomeTrackDescriptor['kind'], message: string) => void;
  cancelRequest: (requestId: string | null | undefined) => void;
  fetchTile: (request: GenomeTileRequest, requestId: string) => Promise<GenomeTrackTile>;
};

function isGenomeRequestCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export class IndexedGenomeCameraTileDispatcher {
  readonly annotationTileTokenRef = { current: 0 };
  readonly annotationTileCoveragesRef = {
    current: [] as Array<{ startBp: number; endBp: number }>,
  };
  readonly annotationTilePendingRef = { current: null as AnnotationTilePending | null };
  readonly annotationTileDispatchTimerRef = { current: null as number | null };
  readonly annotationTileHysteresisRef = { current: null as HysteresisSample | null };
  readonly annotationTileSemaphoreRef = {
    current: createAnnotationTileSemaphoreState() as AnnotationTileSemaphoreState,
  };
  readonly annotationTilePendingDispatchRef = { current: null as (() => void) | null };
  readonly annotationTileCommitIdleTimerRef = { current: null as number | null };
  readonly cameraChangeDispatchTimerRef = { current: null as number | null };
  readonly cameraInteractionActiveRef = { current: false };
  readonly pendingCameraChangeRef = { current: null as CoalescedCameraChange | null };
  readonly pendingAnnotationViewportTileCommitRef = {
    current: null as AnnotationViewportTileState | null,
  };

  clearAnnotationTileDispatchTimer(): void {
    if (this.annotationTileDispatchTimerRef.current == null) return;
    window.clearTimeout(this.annotationTileDispatchTimerRef.current);
    this.annotationTileDispatchTimerRef.current = null;
  }

  clearAnnotationTileCommitIdleTimer(): void {
    if (this.annotationTileCommitIdleTimerRef.current == null) return;
    window.clearTimeout(this.annotationTileCommitIdleTimerRef.current);
    this.annotationTileCommitIdleTimerRef.current = null;
  }

  clearCameraChangeDispatchTimer(): void {
    if (this.cameraChangeDispatchTimerRef.current == null) return;
    window.clearTimeout(this.cameraChangeDispatchTimerRef.current);
    this.cameraChangeDispatchTimerRef.current = null;
  }

  flushPendingAnnotationViewportTileCommit(
    reason: 'immediate' | 'camera-idle',
    commitTile: IndexedGenomeCameraTileHost['commitTile']
  ): void {
    const tile = this.pendingAnnotationViewportTileCommitRef.current;
    if (!tile) return;
    this.pendingAnnotationViewportTileCommitRef.current = null;
    commitTile(tile, reason);
  }

  flushWhenQuiet(
    host: Pick<IndexedGenomeCameraTileHost, 'commitTile' | 'flushResidentPage'>
  ): void {
    this.clearAnnotationTileCommitIdleTimer();
    const run = (): void => {
      const quietDelayMs = rendererInteractionQuietDelayMs();
      if (quietDelayMs > 0) {
        this.annotationTileCommitIdleTimerRef.current = window.setTimeout(
          run,
          Math.max(1, Math.ceil(quietDelayMs))
        );
        return;
      }
      this.annotationTileCommitIdleTimerRef.current = null;
      this.cameraInteractionActiveRef.current = false;
      this.flushPendingAnnotationViewportTileCommit('camera-idle', host.commitTile);
      host.flushResidentPage();
    };
    run();
  }

  noteCameraInteraction(
    host: Pick<IndexedGenomeCameraTileHost, 'commitTile' | 'flushResidentPage'>
  ): void {
    markRendererInteractionActivity();
    this.cameraInteractionActiveRef.current = true;
    this.flushWhenQuiet(host);
  }

  scheduleCoalescedCameraChange(
    change: CoalescedCameraChange,
    process: (
      reportedCenterBp: number,
      reason: 'scroll' | 'zoom',
      viewportRange: Readonly<{ start: number; end: number }> | null
    ) => void,
    delayMs = ANNOTATION_VIEWPORT_TILE_COALESCE_MS
  ): void {
    this.pendingCameraChangeRef.current = change;
    this.clearCameraChangeDispatchTimer();
    this.cameraChangeDispatchTimerRef.current = window.setTimeout(() => {
      this.cameraChangeDispatchTimerRef.current = null;
      const next = this.pendingCameraChangeRef.current;
      this.pendingCameraChangeRef.current = null;
      if (!next) return;
      process(next.reportedCenterBp, next.reason, next.viewportRange);
    }, delayMs);
  }

  requestAnnotationViewportTile(
    input: AnnotationViewportTileRequestInput,
    host: IndexedGenomeCameraTileHost
  ): void {
    if (host.isAssembly || !host.manifest.gffPath) return;
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: input.reportedCenterBp,
      handleCenterBp: input.handleCenterBp,
      viewportRange: input.viewportRange,
      length: host.length,
      containerWidth: host.containerWidth,
      loadedCoverages: this.annotationTileCoveragesRef.current,
      pendingCoverage: this.annotationTilePendingRef.current,
    });

    if (decision.kind === 'skip-wide') {
      this.annotationTileTokenRef.current += 1;
      this.clearAnnotationTileDispatchTimer();
      host.cancelRequest(this.annotationTilePendingRef.current?.requestId);
      this.annotationTilePendingRef.current = null;
      host.setPending(null);
      host.recordEvent('annotation-viewport-tile-skip-wide', {
        reason: input.reason,
        centerBp: decision.centerBp,
        visibleBp: decision.visibleBp,
        maxVisibleBp: decision.maxVisibleBp,
      });
      return;
    }

    if (decision.kind === 'loaded-coverage') {
      if (this.annotationTilePendingRef.current) {
        this.annotationTileTokenRef.current += 1;
        this.clearAnnotationTileDispatchTimer();
        host.cancelRequest(this.annotationTilePendingRef.current.requestId);
        this.annotationTilePendingRef.current = null;
        host.setPending(null);
      }
      host.recordEvent('annotation-viewport-tile-covered', {
        reason: input.reason,
        centerBp: decision.centerBp,
        requiredStart: decision.requiredStart,
        requiredEnd: decision.requiredEnd,
        coverage: decision.coverage,
      });
      return;
    }

    if (decision.kind === 'pending-coverage') {
      host.recordEvent('annotation-viewport-tile-pending', {
        reason: input.reason,
        centerBp: decision.centerBp,
        requiredStart: decision.requiredStart,
        requiredEnd: decision.requiredEnd,
        pending: decision.pending,
      });
      return;
    }

    const { startBp, endBp } = decision.request;
    if (endBp <= startBp) return;
    if (decision.visibleBp != null) {
      const currentSample: HysteresisSample = {
        visibleBp: decision.visibleBp,
        timestampMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      };
      const hysteresisDecision = decideHysteresis({
        previous: this.annotationTileHysteresisRef.current,
        current: currentSample,
      });
      this.annotationTileHysteresisRef.current = currentSample;
      if (hysteresisDecision.kind === 'wait') {
        host.recordEvent('annotation-viewport-tile-skipped-hysteresis', {
          reason: input.reason,
          velocityBpPerMs: hysteresisDecision.velocityBpPerMs,
          maxBpPerMs: hysteresisDecision.maxBpPerMs,
          visibleBp: decision.visibleBp,
        });
        return;
      }
    }
    if (!host.sessionId) {
      host.recordEvent('annotation-viewport-tile-no-session', {
        reason: input.reason,
        centerBp: decision.centerBp,
        startBp,
        endBp,
      });
      return;
    }

    const token = ++this.annotationTileTokenRef.current;
    const requestId = `annotation-viewport-${token}`;
    this.clearAnnotationTileDispatchTimer();
    host.cancelRequest(this.annotationTilePendingRef.current?.requestId);
    const pending = { startBp, endBp, token, requestId };
    this.annotationTilePendingRef.current = pending;
    host.setPending(pending);
    host.recordEvent('annotation-viewport-tile-request', {
      token,
      requestId,
      reason: input.reason,
      centerBp: decision.centerBp,
      viewportRange: decision.viewportRange,
      requiredStart: decision.requiredStart,
      requiredEnd: decision.requiredEnd,
      visibleBp: decision.visibleBp,
      pixelsPerBp: decision.pixelsPerBp,
      startBp,
      endBp,
      byteBudget: ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
      deferMs: input.deferMs ?? 0,
    });

    const drainSemaphoreActive = (): void => {
      const cleanup = recordSemaphoreActiveCleared(
        this.annotationTileSemaphoreRef.current,
        requestId
      );
      this.annotationTileSemaphoreRef.current = cleanup.state;
      if (cleanup.decision.kind === 'dispatch-queued') {
        const queuedDispatch = this.annotationTilePendingDispatchRef.current;
        this.annotationTilePendingDispatchRef.current = null;
        queuedDispatch?.();
      }
    };
    const dispatchAnnotationTileRequest = (): void => {
      this.annotationTileDispatchTimerRef.current = null;
      if (token !== this.annotationTileTokenRef.current) {
        drainSemaphoreActive();
        return;
      }
      const annotationRequest = buildAnnotationTileRequest({
        chrom: host.manifest.chrom,
        start: startBp,
        end: endBp,
        lod: 1,
        generation: token,
        fidelity: 'best_available',
        byteBudget: ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
        sourceFingerprint: sourceFingerprintForManifest(host.manifest),
        visibleTypes: host.visibleTypes,
        laneLimit: host.laneLimit,
      });
      void Promise.resolve()
        .then(() => host.fetchTile(annotationRequest, requestId))
        .then((tile) => {
          drainSemaphoreActive();
          if (token !== this.annotationTileTokenRef.current) return;
          this.annotationTilePendingRef.current = null;
          host.setPending(null);
          const coverage = annotationViewportCoverageFromTile(tile);
          if (coverage) {
            this.annotationTileCoveragesRef.current = retainAnnotationViewportCoverages(
              this.annotationTileCoveragesRef.current,
              coverage
            );
          }
          const nextTile = annotationViewportTileFromGenomeTile(tile, annotationRequest.laneEpoch);
          const features = nextTile.features;
          const interactionQuietDelayMs = rendererInteractionQuietDelayMs();
          if (
            shouldDeferAnnotationViewportTileCommit(
              this.cameraInteractionActiveRef.current,
              interactionQuietDelayMs
            )
          ) {
            this.pendingAnnotationViewportTileCommitRef.current = nextTile;
            this.flushWhenQuiet(host);
            host.recordEvent('annotation-viewport-tile-commit-deferred', {
              token,
              requestId: tile.requestId,
              startBp: tile.start,
              endBp: tile.end,
              recordCount: tile.recordCount,
              byteCount: tile.byteCount,
              featureCount: features.length,
              laneEpoch: tile.laneEpoch ?? annotationRequest.laneEpoch,
              quietDelayMs: interactionQuietDelayMs,
            });
          } else {
            host.commitTile(nextTile, 'immediate');
          }
          host.recordEvent('annotation-viewport-tile-ready', {
            token,
            requestId: tile.requestId,
            state: tile.state,
            fidelity: tile.fidelity,
            cacheState: tile.cacheState ?? 'none',
            startBp: tile.start,
            endBp: tile.end,
            recordCount: tile.recordCount,
            byteCount: tile.byteCount,
            featureCount: features.length,
            laneEpoch: tile.laneEpoch ?? annotationRequest.laneEpoch,
          });
        })
        .catch((err) => {
          drainSemaphoreActive();
          if (token !== this.annotationTileTokenRef.current) return;
          const message = err instanceof Error ? err.message : String(err);
          this.annotationTilePendingRef.current = null;
          host.setPending(null);
          if (isGenomeRequestCancelled(err)) {
            host.recordEvent('annotation-viewport-tile-cancelled', {
              token,
              centerBp: decision.centerBp,
              startBp,
              endBp,
            });
            return;
          }
          host.recordEvent('annotation-viewport-tile-error', {
            token,
            centerBp: decision.centerBp,
            startBp,
            endBp,
            message,
          });
          host.onTrackError('annotation', message);
        });
    };

    const semaphoreDescriptor = { requestId, token, startBp, endBp };
    const semaphoreDecision = decideSemaphoreDispatch(
      this.annotationTileSemaphoreRef.current,
      semaphoreDescriptor
    );
    if (semaphoreDecision.kind === 'queued') {
      this.annotationTileSemaphoreRef.current = recordSemaphoreQueuedSupersede(
        this.annotationTileSemaphoreRef.current,
        semaphoreDescriptor
      );
      this.annotationTilePendingDispatchRef.current = dispatchAnnotationTileRequest;
      host.recordEvent('annotation-viewport-tile-queued', {
        token,
        requestId,
        cancelRequestId: semaphoreDecision.cancelRequestId,
        droppedQueuedRequestId: semaphoreDecision.droppedQueuedRequestId,
        startBp,
        endBp,
      });
      return;
    }
    this.annotationTileSemaphoreRef.current = recordSemaphoreActiveStarted(
      this.annotationTileSemaphoreRef.current,
      semaphoreDescriptor
    );

    const deferMs = Math.max(0, Math.trunc(input.deferMs ?? 0));
    if (deferMs > 0) {
      host.recordEvent('annotation-viewport-tile-dispatch-deferred', {
        token,
        requestId,
        deferMs,
      });
      this.annotationTileDispatchTimerRef.current = window.setTimeout(
        dispatchAnnotationTileRequest,
        deferMs
      );
      return;
    }
    dispatchAnnotationTileRequest();
  }

  reset(): void {
    this.clearAnnotationTileDispatchTimer();
    this.clearAnnotationTileCommitIdleTimer();
    this.clearCameraChangeDispatchTimer();
    this.annotationTilePendingDispatchRef.current = null;
    this.pendingCameraChangeRef.current = null;
    this.pendingAnnotationViewportTileCommitRef.current = null;
    this.cameraInteractionActiveRef.current = false;
  }
}
