import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { WebGLMapHandle } from '@waypoint/plasmid-viewer';
import {
  DEFAULT_WEBGL_MAP_ZOOM_BOUNDS,
  clampWebglMapZoom,
  resolveWebglMapZoomBounds,
  type WebglMapZoomBounds,
  type WebglMapZoomSource,
} from './SequenceMapPaneControls';

const WEBGL_CAMERA_ZOOM_STATE_SYNC_DEBOUNCE_MS = 120;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function createZoomSource(initialZoom: number) {
  let zoom = initialZoom;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => zoom,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (nextZoom: number) => {
      if (zoom === nextZoom) return;
      zoom = nextZoom;
      for (const listener of listeners) listener();
    },
  };
}

export function useWebglCameraZoomState({
  minimapRef,
  persistedZoom,
  viewportScopeKey,
  rendererReadyEpoch = 0,
}: {
  minimapRef: RefObject<WebGLMapHandle | null>;
  persistedZoom: number | undefined;
  viewportScopeKey: string;
  rendererReadyEpoch?: number;
}): {
  webglCameraZoom: number;
  webglCameraZoomBounds: WebglMapZoomBounds;
  webglCameraZoomSource: WebglMapZoomSource;
  commitWebglCameraZoomState: (zoom: number) => void;
  scheduleWebglCameraZoomStateSync: (zoom: number) => void;
  updateWebglCameraZoomBounds: () => WebglMapZoomBounds;
} {
  const [webglCameraZoomBounds, setWebglCameraZoomBounds] = useState<WebglMapZoomBounds>(
    DEFAULT_WEBGL_MAP_ZOOM_BOUNDS
  );
  const [webglCameraZoom, setWebglCameraZoom] = useState(() =>
    clampWebglMapZoom(persistedZoom ?? 1, DEFAULT_WEBGL_MAP_ZOOM_BOUNDS)
  );
  const webglCameraZoomRef = useRef(webglCameraZoom);
  const liveCameraZoomScopeRef = useRef<string | null>(null);
  const zoomSourceRef = useRef<{
    scopeKey: string;
    source: ReturnType<typeof createZoomSource>;
  } | null>(null);
  if (zoomSourceRef.current?.scopeKey !== viewportScopeKey) {
    zoomSourceRef.current = {
      scopeKey: viewportScopeKey,
      source: createZoomSource(clampWebglMapZoom(persistedZoom ?? 1, webglCameraZoomBounds)),
    };
  }
  const webglCameraZoomSource = zoomSourceRef.current.source;
  const webglCameraZoomStateSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webglCameraZoomStateSyncDeadlineRef = useRef(0);

  const clearScheduledWebglCameraZoomStateSync = useCallback(() => {
    if (webglCameraZoomStateSyncTimerRef.current !== null) {
      clearTimeout(webglCameraZoomStateSyncTimerRef.current);
      webglCameraZoomStateSyncTimerRef.current = null;
    }
  }, []);

  const receiveWebglCameraZoomBounds = useCallback(
    (rawBounds?: Partial<WebglMapZoomBounds> | null): WebglMapZoomBounds => {
      const bounds = resolveWebglMapZoomBounds(rawBounds);
      setWebglCameraZoomBounds((previous) =>
        previous.min === bounds.min && previous.max === bounds.max ? previous : bounds
      );
      return bounds;
    },
    []
  );

  const updateWebglCameraZoomBounds = useCallback(
    (): WebglMapZoomBounds =>
      receiveWebglCameraZoomBounds(minimapRef.current?.getCameraZoomBounds?.()),
    [minimapRef, receiveWebglCameraZoomBounds]
  );

  useEffect(() => {
    const map = minimapRef.current;
    if (!map?.subscribeToCameraZoomBounds) return;
    const unsubscribe = map.subscribeToCameraZoomBounds((bounds) => {
      if (zoomSourceRef.current?.source !== webglCameraZoomSource) return;
      receiveWebglCameraZoomBounds(bounds);
    });
    map.requestRender?.();
    return unsubscribe;
  }, [minimapRef, rendererReadyEpoch, receiveWebglCameraZoomBounds, webglCameraZoomSource]);

  const applyWebglCameraZoomState = useCallback(
    (zoom: number) => {
      if (zoomSourceRef.current?.source !== webglCameraZoomSource) return;
      const bounds = updateWebglCameraZoomBounds();
      const clamped = clampWebglMapZoom(zoom, bounds);
      clearScheduledWebglCameraZoomStateSync();
      webglCameraZoomRef.current = clamped;
      webglCameraZoomSource.publish(clamped);
      setWebglCameraZoom((previous) => (Math.abs(previous - clamped) < 0.001 ? previous : clamped));
    },
    [clearScheduledWebglCameraZoomStateSync, updateWebglCameraZoomBounds, webglCameraZoomSource]
  );

  const commitWebglCameraZoomState = useCallback(
    (zoom: number) => {
      if (zoomSourceRef.current?.source !== webglCameraZoomSource) return;
      liveCameraZoomScopeRef.current = viewportScopeKey;
      applyWebglCameraZoomState(zoom);
    },
    [applyWebglCameraZoomState, viewportScopeKey, webglCameraZoomSource]
  );

  const armWebglCameraZoomStateSyncTimer = useCallback(() => {
    if (webglCameraZoomStateSyncTimerRef.current !== null) return;
    const tick = () => {
      if (zoomSourceRef.current?.source !== webglCameraZoomSource) return;
      const remainingMs = webglCameraZoomStateSyncDeadlineRef.current - nowMs();
      if (remainingMs > 0) {
        webglCameraZoomStateSyncTimerRef.current = setTimeout(tick, remainingMs);
        return;
      }
      webglCameraZoomStateSyncTimerRef.current = null;
      const nextZoom = webglCameraZoomRef.current;
      setWebglCameraZoom((previous) =>
        Math.abs(previous - nextZoom) < 0.001 ? previous : nextZoom
      );
    };
    webglCameraZoomStateSyncTimerRef.current = setTimeout(
      tick,
      WEBGL_CAMERA_ZOOM_STATE_SYNC_DEBOUNCE_MS
    );
  }, [webglCameraZoomSource]);

  const scheduleWebglCameraZoomStateSync = useCallback(
    (zoom: number) => {
      if (!Number.isFinite(zoom) || zoomSourceRef.current?.source !== webglCameraZoomSource) return;
      liveCameraZoomScopeRef.current = viewportScopeKey;
      const bounds = updateWebglCameraZoomBounds();
      webglCameraZoomRef.current = clampWebglMapZoom(zoom, bounds);

      webglCameraZoomSource.publish(webglCameraZoomRef.current);
      webglCameraZoomStateSyncDeadlineRef.current =
        nowMs() + WEBGL_CAMERA_ZOOM_STATE_SYNC_DEBOUNCE_MS;
      armWebglCameraZoomStateSyncTimer();
    },
    [
      armWebglCameraZoomStateSyncTimer,
      updateWebglCameraZoomBounds,
      viewportScopeKey,
      webglCameraZoomSource,
    ]
  );

  useEffect(() => clearScheduledWebglCameraZoomStateSync, [clearScheduledWebglCameraZoomStateSync]);

  useEffect(() => {
    if (liveCameraZoomScopeRef.current !== viewportScopeKey)
      applyWebglCameraZoomState(persistedZoom ?? 1);
  }, [applyWebglCameraZoomState, persistedZoom, viewportScopeKey]);

  return {
    webglCameraZoom,
    webglCameraZoomBounds,
    webglCameraZoomSource,
    commitWebglCameraZoomState,
    scheduleWebglCameraZoomStateSync,
    updateWebglCameraZoomBounds,
  };
}
