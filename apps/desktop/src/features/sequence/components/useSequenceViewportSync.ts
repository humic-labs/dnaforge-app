import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type {
  CoordinateSpace,
  ViewportChangeSource,
  ViewportRange,
} from '@waypoint/workspace-editor';
import { gappedToBioClamped } from '@waypoint/workspace-editor';
import type { WebGLMapHandle } from '@waypoint/plasmid-viewer';
import type { SequenceViewState } from '../view-state/sequence-view-state';
import type { SequenceViewStatePatchFn } from '../view-state/useSequenceViewState';
import type {
  ScrollToPositionWithTimeout,
  SequenceNavigationSnapshot,
} from './useSequenceScrollNavigation';
import { shouldSyncCanvasCenterFromWebGL, shouldSyncViewportCenterToWebGL } from './viewport-sync';
import {
  normalizeSequenceViewportCenterBp,
  viewportCenterBpFromRange,
} from './sequence-viewport-state';
import type { SequenceViewMode } from './SequenceViewerModeToggle';
import { clampWebglMapZoom, resolveWebglMapZoomBounds } from './SequenceMapPaneControls';

interface CurrentRef<T> {
  current: T;
}

interface MinimapSizingSnapshot {
  paneHeightRaw: number;
  geometryHeightRaw: number;
}

interface WebglCameraRestoreStatus {
  scopeKey: string;
  phase: 'not-needed' | 'running' | 'settled' | 'cancelled';
  appliedFrames: number;
}

interface PaneViewportHandoff {
  centerBp: number;
  mapZoom: number | null;
  sequencePending: boolean;
  mapPending: boolean;
  applied: boolean;
}

const HIGH_FREQUENCY_CAMERA_PERSIST_DEBOUNCE_MS = 120;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface UseSequenceViewportSyncInput {
  sequenceLength: number;
  sequenceViewportScopeKey: string;
  circular: boolean;
  coordinateSpace?: CoordinateSpace;
  seqView: Pick<SequenceViewState, 'centerBp' | 'webglZoom' | 'webglCenterBp'>;
  patchSeqView: SequenceViewStatePatchFn;
  minimapRef: CurrentRef<WebGLMapHandle | null>;
  webglEnabled: boolean;
  webglRendererReadyEpoch: number;
  isWebglSyncLocked: boolean;
  scrollToPositionWithTimeoutRef: CurrentRef<ScrollToPositionWithTimeout | null>;
  scrollActiveSequenceViewerToBiologicalPosition: (
    position: number,
    options?: { continuousCircular?: boolean; animate?: boolean }
  ) => void;
  morphToCircleRef: CurrentRef<number>;
  handleMorphToCircleChangeRef: CurrentRef<(morph: number) => void>;
  minimapRawSizingRef: CurrentRef<MinimapSizingSnapshot>;
  setMinimapHeights: (h: { pane?: number; geometry?: number }) => void;
  lastSequenceNavigationRef: CurrentRef<SequenceNavigationSnapshot | null>;
  paneLayout?: Pick<SequenceViewState, 'rendererVisibility' | 'mapPlacement'>;
  focusedPaneRef?: CurrentRef<'sequence' | 'map' | null>;
}

export function useSequenceViewportSync({
  sequenceLength,
  sequenceViewportScopeKey,
  circular,
  coordinateSpace,
  seqView,
  patchSeqView,
  minimapRef,
  webglEnabled,
  webglRendererReadyEpoch,
  isWebglSyncLocked,
  scrollToPositionWithTimeoutRef,
  scrollActiveSequenceViewerToBiologicalPosition,
  morphToCircleRef,
  handleMorphToCircleChangeRef,
  minimapRawSizingRef,
  setMinimapHeights,
  lastSequenceNavigationRef,
  paneLayout,
  focusedPaneRef,
}: UseSequenceViewportSyncInput) {
  const initialSequenceViewportCenterBp = normalizeSequenceViewportCenterBp(
    seqView.centerBp,
    sequenceLength
  );
  const viewportRestoreScopeRef = useRef(sequenceViewportScopeKey);

  const initialLegacyWebglCenterBpRef = useRef(initialSequenceViewportCenterBp);
  const initialViewportRestoreCompleteRef = useRef(initialSequenceViewportCenterBp == null);
  const latestLiveWebglCameraRef = useRef<{
    scopeKey: string;
    centerBp: number;
    zoom: number;
  } | null>(null);
  if (viewportRestoreScopeRef.current !== sequenceViewportScopeKey) {
    viewportRestoreScopeRef.current = sequenceViewportScopeKey;
    initialLegacyWebglCenterBpRef.current = initialSequenceViewportCenterBp;
    initialViewportRestoreCompleteRef.current = initialSequenceViewportCenterBp == null;
    latestLiveWebglCameraRef.current = null;
  }

  const lastViewportCenterRef = useRef<number | null>(initialSequenceViewportCenterBp);
  const lastViewportRangeRef = useRef<{ scopeKey: string; range: ViewportRange | null }>({
    scopeKey: sequenceViewportScopeKey,
    range: null,
  });
  if (lastViewportRangeRef.current.scopeKey !== sequenceViewportScopeKey) {
    lastViewportRangeRef.current = { scopeKey: sequenceViewportScopeKey, range: null };
  }
  const paneLayoutKey = paneLayout
    ? `${paneLayout.rendererVisibility}:${paneLayout.mapPlacement}`
    : null;
  const previousPaneLayoutRef = useRef({
    scopeKey: sequenceViewportScopeKey,
    key: paneLayoutKey,
    visibility: paneLayout?.rendererVisibility,
  });
  const paneHandoffRef = useRef<PaneViewportHandoff | null>(null);
  const previousPaneLayout = previousPaneLayoutRef.current;
  if (previousPaneLayout.scopeKey !== sequenceViewportScopeKey) {
    paneHandoffRef.current = null;
    lastViewportCenterRef.current = initialSequenceViewportCenterBp;
    if (focusedPaneRef) focusedPaneRef.current = null;
  } else if (
    paneLayoutKey !== null &&
    previousPaneLayout.key !== null &&
    previousPaneLayout.key !== paneLayoutKey
  ) {
    const owner =
      previousPaneLayout.visibility === 'both'
        ? (focusedPaneRef?.current ?? 'sequence')
        : previousPaneLayout.visibility;
    const cameraCenter = minimapRef.current?.getCameraCenter?.();
    const mapCenter = normalizeSequenceViewportCenterBp(
      cameraCenter == null ? seqView.webglCenterBp : cameraCenter + 1,
      sequenceLength
    );
    const centerBp =
      owner === 'map'
        ? (mapCenter ?? lastViewportCenterRef.current)
        : (lastViewportCenterRef.current ?? mapCenter);
    const cameraZoom = minimapRef.current?.getCameraZoom?.() ?? seqView.webglZoom;
    paneHandoffRef.current =
      centerBp == null
        ? null
        : {
            centerBp,
            mapZoom:
              typeof cameraZoom === 'number' && Number.isFinite(cameraZoom) && cameraZoom > 0
                ? cameraZoom
                : null,
            sequencePending: paneLayout?.rendererVisibility !== 'map',
            mapPending: webglEnabled,
            applied: false,
          };
  }
  previousPaneLayoutRef.current = {
    scopeKey: sequenceViewportScopeKey,
    key: paneLayoutKey,
    visibility: paneLayout?.rendererVisibility,
  };
  const syncViewportTarget = useCallback((target: WebGLMapHandle | null) => {
    const range = lastViewportRangeRef.current.range;
    if (target && range) target.setViewport(range);
    const handoff = paneHandoffRef.current;
    if (target && handoff?.mapPending) {
      if (handoff.mapZoom != null) {
        const bounds = resolveWebglMapZoomBounds(target.getCameraZoomBounds?.());
        target.setZoom?.(clampWebglMapZoom(handoff.mapZoom, bounds));
      }
      target.setViewCenter?.(handoff.centerBp - 1);

      handoff.mapPending = false;
      if (handoff.applied && !handoff.sequencePending) paneHandoffRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (webglEnabled) syncViewportTarget(minimapRef.current);
  }, [
    minimapRef,
    sequenceViewportScopeKey,
    syncViewportTarget,
    webglEnabled,
    webglRendererReadyEpoch,
  ]);
  const ownedWorkspaceViewerTestBridgeRef = useRef<object | null>(null);
  const webglRestoreCancelRef = useRef(false);
  const webglCameraRestoreStatusRef = useRef<WebglCameraRestoreStatus>({
    scopeKey: sequenceViewportScopeKey,
    phase:
      webglEnabled && (seqView.webglZoom != null || seqView.webglCenterBp != null)
        ? 'running'
        : 'not-needed',
    appliedFrames: 0,
  });
  if (webglCameraRestoreStatusRef.current.scopeKey !== sequenceViewportScopeKey) {
    webglCameraRestoreStatusRef.current = {
      scopeKey: sequenceViewportScopeKey,
      phase:
        webglEnabled && (seqView.webglZoom != null || seqView.webglCenterBp != null)
          ? 'running'
          : 'not-needed',
      appliedFrames: 0,
    };
  }
  const webglDrivenCanvasSyncUntilRef = useRef(0);
  const pendingSequenceViewportPersistRef = useRef<number | null>(null);
  const sequenceViewportPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequenceViewportPersistDeadlineRef = useRef(0);
  const pendingWebglCameraPersistRef = useRef<{ centerBp: number; zoom: number } | null>(null);
  const webglCameraPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webglCameraPersistDeadlineRef = useRef(0);

  useLayoutEffect(() => {
    const handoff = paneHandoffRef.current;
    if (!handoff || handoff.applied) return;
    handoff.applied = true;
    initialViewportRestoreCompleteRef.current = true;
    lastViewportCenterRef.current = handoff.centerBp;
    latestLiveWebglCameraRef.current = null;

    pendingSequenceViewportPersistRef.current = null;
    pendingWebglCameraPersistRef.current = null;
    patchSeqView(
      {
        centerBp: handoff.centerBp,
        webglCenterBp: handoff.centerBp,
        ...(handoff.mapZoom == null ? {} : { webglZoom: handoff.mapZoom }),
      },
      { debounce: true }
    );
    if (handoff.sequencePending) {
      scrollToPositionWithTimeoutRef.current?.(
        handoff.centerBp,
        () => {
          if (paneHandoffRef.current !== handoff) return;
          handoff.sequencePending = false;
          if (!handoff.mapPending) paneHandoffRef.current = null;
        },
        { animate: false, completion: 'viewer' }
      );
    }
  }, [paneLayoutKey, patchSeqView, scrollToPositionWithTimeoutRef, sequenceViewportScopeKey]);

  useEffect(
    () => () => {
      const testState = (window as unknown as { __test?: { workspaceViewer?: object } }).__test;
      const ownedBridge = ownedWorkspaceViewerTestBridgeRef.current;
      if (ownedBridge && testState?.workspaceViewer === ownedBridge) {
        delete testState.workspaceViewer;
      }
      ownedWorkspaceViewerTestBridgeRef.current = null;
    },
    []
  );

  const flushSequenceViewportPersist = useCallback(() => {
    if (sequenceViewportPersistTimerRef.current !== null) {
      clearTimeout(sequenceViewportPersistTimerRef.current);
      sequenceViewportPersistTimerRef.current = null;
    }
    const pendingCenterBp = pendingSequenceViewportPersistRef.current;
    pendingSequenceViewportPersistRef.current = null;
    if (pendingCenterBp == null || !initialViewportRestoreCompleteRef.current) return;

    patchSeqView({ centerBp: pendingCenterBp }, { debounce: true });
  }, [patchSeqView]);

  const flushWebglCameraPersist = useCallback(() => {
    if (webglCameraPersistTimerRef.current !== null) {
      clearTimeout(webglCameraPersistTimerRef.current);
      webglCameraPersistTimerRef.current = null;
    }
    const pending = pendingWebglCameraPersistRef.current;
    pendingWebglCameraPersistRef.current = null;
    if (!pending || !initialViewportRestoreCompleteRef.current) return;
    patchSeqView({ webglZoom: pending.zoom, webglCenterBp: pending.centerBp }, { debounce: true });
  }, [patchSeqView]);

  const armSequenceViewportPersistTimer = useCallback(() => {
    if (sequenceViewportPersistTimerRef.current !== null) return;
    const tick = () => {
      const remainingMs = sequenceViewportPersistDeadlineRef.current - nowMs();
      if (remainingMs > 0) {
        sequenceViewportPersistTimerRef.current = setTimeout(tick, remainingMs);
        return;
      }
      sequenceViewportPersistTimerRef.current = null;
      flushSequenceViewportPersist();
    };
    sequenceViewportPersistTimerRef.current = setTimeout(
      tick,
      HIGH_FREQUENCY_CAMERA_PERSIST_DEBOUNCE_MS
    );
  }, [flushSequenceViewportPersist]);

  const armWebglCameraPersistTimer = useCallback(() => {
    if (webglCameraPersistTimerRef.current !== null) return;
    const tick = () => {
      const remainingMs = webglCameraPersistDeadlineRef.current - nowMs();
      if (remainingMs > 0) {
        webglCameraPersistTimerRef.current = setTimeout(tick, remainingMs);
        return;
      }
      webglCameraPersistTimerRef.current = null;
      flushWebglCameraPersist();
    };
    webglCameraPersistTimerRef.current = setTimeout(
      tick,
      HIGH_FREQUENCY_CAMERA_PERSIST_DEBOUNCE_MS
    );
  }, [flushWebglCameraPersist]);

  const scheduleSequenceViewportPersist = useCallback(
    (centerBp: number) => {
      if (!initialViewportRestoreCompleteRef.current) return;
      pendingSequenceViewportPersistRef.current = centerBp;
      sequenceViewportPersistDeadlineRef.current =
        nowMs() + HIGH_FREQUENCY_CAMERA_PERSIST_DEBOUNCE_MS;
      armSequenceViewportPersistTimer();
    },
    [armSequenceViewportPersistTimer]
  );

  const scheduleWebglCameraPersist = useCallback(
    (centerBp: number, zoom: number) => {
      if (!initialViewportRestoreCompleteRef.current || !Number.isFinite(zoom)) return;
      pendingWebglCameraPersistRef.current = { centerBp, zoom };
      webglCameraPersistDeadlineRef.current = nowMs() + HIGH_FREQUENCY_CAMERA_PERSIST_DEBOUNCE_MS;
      armWebglCameraPersistTimer();
    },
    [armWebglCameraPersistTimer]
  );

  useEffect(
    () => () => {
      flushSequenceViewportPersist();
      flushWebglCameraPersist();
    },
    [flushSequenceViewportPersist, flushWebglCameraPersist]
  );

  const persistSequenceViewport = useCallback(
    (centerBp: number) => {
      scheduleSequenceViewportPersist(centerBp);
    },
    [scheduleSequenceViewportPersist]
  );

  useEffect(() => {
    if (initialViewportRestoreCompleteRef.current) return;

    const savedCenter = normalizeSequenceViewportCenterBp(seqView.centerBp, sequenceLength);
    if (savedCenter == null) {
      initialViewportRestoreCompleteRef.current = true;
      return;
    }

    lastViewportCenterRef.current = savedCenter;
    const restoreTimer = setTimeout(() => {
      if (initialViewportRestoreCompleteRef.current) return;

      scrollToPositionWithTimeoutRef.current?.(
        savedCenter,
        () => {
          initialViewportRestoreCompleteRef.current = true;
        },
        { animate: false }
      );
    }, 0);

    return () => clearTimeout(restoreTimer);
  }, [scrollToPositionWithTimeoutRef, sequenceLength, sequenceViewportScopeKey, seqView.centerBp]);

  useEffect(() => {
    if (!webglEnabled) {
      webglCameraRestoreStatusRef.current = {
        scopeKey: sequenceViewportScopeKey,
        phase: 'not-needed',
        appliedFrames: 0,
      };
      return;
    }
    const handoff = paneHandoffRef.current;
    const liveCamera =
      latestLiveWebglCameraRef.current?.scopeKey === sequenceViewportScopeKey
        ? latestLiveWebglCameraRef.current
        : null;

    const savedZoom = handoff?.mapZoom ?? liveCamera?.zoom ?? seqView.webglZoom;
    const mapOwnsItsCamera = savedZoom != null || seqView.webglCenterBp != null;
    const savedCenterBp =
      handoff?.centerBp ??
      liveCamera?.centerBp ??
      (mapOwnsItsCamera ? seqView.webglCenterBp : initialLegacyWebglCenterBpRef.current);
    if (savedZoom == null && savedCenterBp == null) {
      webglCameraRestoreStatusRef.current = {
        scopeKey: sequenceViewportScopeKey,
        phase: 'not-needed',
        appliedFrames: 0,
      };
      return;
    }
    webglRestoreCancelRef.current = false;
    webglCameraRestoreStatusRef.current = {
      scopeKey: sequenceViewportScopeKey,
      phase: 'running',
      appliedFrames: 0,
    };
    let frame = 0;
    let raf = requestAnimationFrame(function apply() {
      if (webglRestoreCancelRef.current) {
        webglCameraRestoreStatusRef.current = {
          scopeKey: sequenceViewportScopeKey,
          phase: 'cancelled',
          appliedFrames: frame,
        };
        return;
      }
      const map = minimapRef.current;

      if (savedZoom != null) {
        const bounds = resolveWebglMapZoomBounds(map?.getCameraZoomBounds?.());
        map?.setZoom?.(clampWebglMapZoom(savedZoom, bounds));
      }
      if (savedCenterBp != null) map?.setViewCenter?.(Math.max(0, savedCenterBp - 1));

      webglRestoreCancelRef.current = false;
      frame += 1;
      webglCameraRestoreStatusRef.current = {
        scopeKey: sequenceViewportScopeKey,
        phase: frame < 10 ? 'running' : 'settled',
        appliedFrames: frame,
      };
      if (frame === 10 && map && paneHandoffRef.current === handoff && handoff) {
        handoff.mapPending = false;
        if (!handoff.sequencePending) paneHandoffRef.current = null;
      }
      if (frame < 10) raf = requestAnimationFrame(apply);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (
        webglCameraRestoreStatusRef.current.scopeKey === sequenceViewportScopeKey &&
        webglCameraRestoreStatusRef.current.phase === 'running'
      ) {
        webglCameraRestoreStatusRef.current = {
          ...webglCameraRestoreStatusRef.current,
          phase: 'cancelled',
        };
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequenceViewportScopeKey, webglEnabled, webglRendererReadyEpoch, paneLayoutKey]);

  const cancelWebglCameraRestore = useCallback(() => {
    paneHandoffRef.current = null;
    webglRestoreCancelRef.current = true;
    if (webglCameraRestoreStatusRef.current.phase === 'running') {
      webglCameraRestoreStatusRef.current = {
        ...webglCameraRestoreStatusRef.current,
        phase: 'cancelled',
      };
    }
  }, []);

  const handleWebglMapCameraChange = useCallback(
    (centerBp: number, reason: 'scroll' | 'zoom', zoom: number) => {
      const seqLen = sequenceLength;
      if (seqLen <= 0) return;
      webglRestoreCancelRef.current = true;
      if (webglCameraRestoreStatusRef.current.phase === 'running') {
        webglCameraRestoreStatusRef.current = {
          ...webglCameraRestoreStatusRef.current,
          phase: 'cancelled',
        };
      }
      const centerBio = Math.max(1, Math.min(seqLen, Math.round(centerBp) + 1));

      if (Number.isFinite(zoom) && zoom > 0) {
        latestLiveWebglCameraRef.current = {
          scopeKey: sequenceViewportScopeKey,
          centerBp: centerBio,
          zoom,
        };
      }

      scheduleWebglCameraPersist(centerBio, zoom);

      if (!shouldSyncCanvasCenterFromWebGL({ reason, isWebglSyncLocked })) return;
      lastViewportCenterRef.current = centerBio;
      persistSequenceViewport(centerBio);
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      webglDrivenCanvasSyncUntilRef.current = now + 250;
      scrollActiveSequenceViewerToBiologicalPosition(centerBio, { continuousCircular: true });
    },
    [
      isWebglSyncLocked,
      persistSequenceViewport,
      scheduleWebglCameraPersist,
      scrollActiveSequenceViewerToBiologicalPosition,
      sequenceLength,
      sequenceViewportScopeKey,
    ]
  );

  const handleViewportChange = useCallback(
    (
      range: ViewportRange,
      source: ViewportChangeSource = 'scroll',
      units: 'column' | 'biological' = 'column'
    ) => {
      const previousRange = lastViewportRangeRef.current.range;
      lastViewportRangeRef.current.range = range;
      if (
        !previousRange ||
        previousRange.start !== range.start ||
        previousRange.end !== range.end ||
        Boolean(previousRange.wraps) !== Boolean(range.wraps)
      ) {
        minimapRef.current?.setViewport(range);
      }
      const seqLen = sequenceLength;
      if (seqLen <= 0) return;

      const gappedSeq =
        units === 'column' && coordinateSpace?.mode === 'gapped'
          ? coordinateSpace.gappedSequence
          : undefined;
      const colToBio = (col: number): number =>
        gappedSeq ? gappedToBioClamped(col, gappedSeq) : col + 1;
      const centerBio =
        typeof range.centerColumn === 'number' && Number.isFinite(range.centerColumn)
          ? colToBio(Math.round(range.centerColumn))
          : viewportCenterBpFromRange(range, seqLen, colToBio);
      if (centerBio == null) return;

      const handoff = paneHandoffRef.current;
      if (handoff?.sequencePending || paneLayout?.rendererVisibility === 'map') return;

      if (!initialViewportRestoreCompleteRef.current) {
        if (source !== 'scroll') return;
        initialViewportRestoreCompleteRef.current = true;
      }

      lastViewportCenterRef.current = centerBio;
      persistSequenceViewport(centerBio);
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const isWebglDrivenEcho = now < webglDrivenCanvasSyncUntilRef.current;
      if (
        shouldSyncViewportCenterToWebGL({
          source,
          isWebglSyncLocked,
          isWebglDrivenEcho,
        })
      ) {
        minimapRef.current?.setViewCenter?.(centerBio - 1);
      }

      const w = window as Window & {
        __webglFireCameraChange?: (r: 'scroll' | 'zoom') => void;
        __test?: {
          workspaceViewer?: {
            getLastViewportCenterBp: () => number | null;
            getLastViewportRange: () => { start: number; end: number; wraps?: boolean } | null;
            setViewport: (range: { start: number; end: number; wraps?: boolean }) => void;
            scrollToBp: (bp: number) => void;
            getSequenceLength: () => number;
            getCircular: () => boolean;
            getWebglCameraZoom: () => number | null;
            getWebglCameraZoomBounds: () => { min: number; max: number } | null;
            getWebglCameraCenter: () => number | null;
            setWebglCameraZoom: (zoom: number) => void;
            getWebglCameraRestoreStatus: () => WebglCameraRestoreStatus;
            isInitialViewportRestoreComplete: () => boolean;
            getWebglMorph: () => number;
            setWebglMorph: (morph: number) => void;
            getMinimapHeights: () => { pane: number; geometry: number };
            setMinimapHeights: (h: { pane?: number; geometry?: number }) => void;
            getLastSequenceNavigation: () => {
              position: number;
              mode: SequenceViewMode;
              usedImperative2d: boolean;
              hadSequenceViewerRef: boolean;
              continuousCircular: boolean;
            } | null;
          };
        };
      };
      if (w.__test) {
        const previousBridge = w.__test.workspaceViewer as
          | (Record<string, unknown> & {
              setViewport?: (range: { start: number; end: number; wraps?: boolean }) => void;
            })
          | undefined;
        const bridge = {
          ...previousBridge,
          getLastViewportCenterBp: () => lastViewportCenterRef.current,
          getLastViewportRange: () => ({
            start: range.start,
            end: range.end,
            ...(range.wraps ? { wraps: true } : {}),
          }),
          setViewport:
            previousBridge?.setViewport ??
            ((nextRange: { start: number; end: number; wraps?: boolean }) => {
              const target = minimapRef.current;
              if (!target) return;
              target.setViewport(nextRange);
              lastViewportCenterRef.current = viewportCenterBpFromRange(nextRange, sequenceLength);
            }),
          scrollToBp: (bp: number) => {
            scrollActiveSequenceViewerToBiologicalPosition(bp);
          },
          getSequenceLength: () => sequenceLength,
          getCircular: () => circular,
          getWebglCameraZoom: () => minimapRef.current?.getCameraZoom?.() ?? null,
          getWebglCameraZoomBounds: () => minimapRef.current?.getCameraZoomBounds?.() ?? null,
          getWebglCameraCenter: () => minimapRef.current?.getCameraCenter?.() ?? null,
          setWebglCameraZoom: (zoom: number) => {
            minimapRef.current?.setZoom?.(zoom);
            w.__webglFireCameraChange?.('zoom');
          },
          getWebglCameraRestoreStatus: () => ({ ...webglCameraRestoreStatusRef.current }),
          isInitialViewportRestoreComplete: () => initialViewportRestoreCompleteRef.current,
          getWebglMorph: () => morphToCircleRef.current,
          setWebglMorph: (morph: number) => handleMorphToCircleChangeRef.current(morph),
          getMinimapHeights: () => ({
            pane: minimapRawSizingRef.current.paneHeightRaw,
            geometry: minimapRawSizingRef.current.geometryHeightRaw,
          }),
          setMinimapHeights,
          getLastSequenceNavigation: () => lastSequenceNavigationRef.current,
        };
        w.__test.workspaceViewer = bridge;
        ownedWorkspaceViewerTestBridgeRef.current = bridge;
      }
    },
    [
      circular,
      coordinateSpace,
      handleMorphToCircleChangeRef,
      isWebglSyncLocked,
      lastSequenceNavigationRef,
      minimapRawSizingRef,
      minimapRef,
      morphToCircleRef,
      paneLayout?.rendererVisibility,
      persistSequenceViewport,
      scrollActiveSequenceViewerToBiologicalPosition,
      sequenceLength,
      setMinimapHeights,
    ]
  );

  return {
    lastViewportCenterRef,
    syncViewportTarget,
    handleWebglMapCameraChange,
    handleViewportChange,
    cancelWebglCameraRestore,
  };
}
