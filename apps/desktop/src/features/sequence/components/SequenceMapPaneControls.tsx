import { useCallback, useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { forwardWheelZoom } from '@waypoint/platform/wheel-motion';

const MINIMUM_WEBGL_MAP_ZOOM_BOUND = 0.01;
export interface WebglMapZoomBounds {
  min: number;
  max: number;
}

export interface WebglMapZoomSource {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
}

const noZoomSubscription = () => () => {};

export const DEFAULT_WEBGL_MAP_ZOOM_BOUNDS: WebglMapZoomBounds = {
  min: 0.5,
  max: 5000,
};
const WEBGL_MAP_ZOOM_STEP = 1.18;
const WEBGL_MAP_ZOOM_SLIDER_MIN = 0;
const WEBGL_MAP_ZOOM_SLIDER_MAX = 1;
const WEBGL_MAP_ZOOM_KEYBOARD_STEP = 0.025;
const WEBGL_MAP_ZOOM_EPSILON = 1e-6;
const WEBGL_MAP_ZOOM_AT_MAX_RELATIVE_EPSILON = 1e-9;

export function resolveWebglMapZoomBounds(
  bounds?: Partial<WebglMapZoomBounds> | null
): WebglMapZoomBounds {
  const fallback = DEFAULT_WEBGL_MAP_ZOOM_BOUNDS;
  const rawMin = Number.isFinite(bounds?.min) ? Number(bounds?.min) : fallback.min;
  const rawMax = Number.isFinite(bounds?.max) ? Number(bounds?.max) : fallback.max;
  const min = Math.max(MINIMUM_WEBGL_MAP_ZOOM_BOUND, rawMin);
  const max = Math.max(MINIMUM_WEBGL_MAP_ZOOM_BOUND, rawMax);
  if (max < min) return { min: max, max: min };
  return { min, max };
}

function webglMapZoomLogSpan(bounds: WebglMapZoomBounds): number {
  if (bounds.max <= bounds.min + WEBGL_MAP_ZOOM_EPSILON) return 0;
  return Math.log10(bounds.max / bounds.min);
}

export function clampWebglMapZoom(
  zoom: number,
  bounds?: Partial<WebglMapZoomBounds> | null
): number {
  const resolved = resolveWebglMapZoomBounds(bounds);
  if (!Number.isFinite(zoom)) return Math.max(resolved.min, Math.min(resolved.max, 1));
  return Math.max(resolved.min, Math.min(resolved.max, zoom));
}

function clampWebglMapSliderValue(value: number): number {
  const finite = Number.isFinite(value) ? value : WEBGL_MAP_ZOOM_SLIDER_MIN;
  return Math.max(WEBGL_MAP_ZOOM_SLIDER_MIN, Math.min(WEBGL_MAP_ZOOM_SLIDER_MAX, finite));
}

export function webglMapZoomToSliderValue(
  zoom: number,
  bounds?: Partial<WebglMapZoomBounds> | null
): number {
  const resolved = resolveWebglMapZoomBounds(bounds);
  const clamped = clampWebglMapZoom(zoom, resolved);
  const logSpan = webglMapZoomLogSpan(resolved);
  if (logSpan <= 0) return clamped >= resolved.max ? 1 : 0;
  const ordersZoomedOutFromMax = Math.log10(resolved.max / clamped);
  return clampWebglMapSliderValue(1 - ordersZoomedOutFromMax / logSpan);
}

export function webglMapSliderValueToZoom(
  value: number,
  bounds?: Partial<WebglMapZoomBounds> | null
): number {
  const resolved = resolveWebglMapZoomBounds(bounds);
  const normalized = clampWebglMapSliderValue(value);
  const logSpan = webglMapZoomLogSpan(resolved);
  if (logSpan <= 0) return normalized >= 1 ? resolved.max : resolved.min;
  const ordersZoomedOutFromMax = (1 - normalized) * logSpan;
  return clampWebglMapZoom(resolved.max / Math.pow(10, ordersZoomedOutFromMax), resolved);
}

export function formatWebglMapZoom(
  zoom: number,
  bounds?: Partial<WebglMapZoomBounds> | null
): string {
  const resolved = resolveWebglMapZoomBounds(bounds);
  const clamped = clampWebglMapZoom(zoom, resolved);
  const percentOfMax = (clamped / resolved.max) * 100;
  const trim = (value: number, digits: number) => {
    const fixed = value.toFixed(digits);
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  };
  if (clamped >= resolved.max * (1 - WEBGL_MAP_ZOOM_AT_MAX_RELATIVE_EPSILON)) return '100%';
  if (percentOfMax >= 10) {
    const floored = Math.floor(percentOfMax * 10 + 1e-9) / 10;
    return `${trim(floored, floored >= 99 ? 1 : 0)}%`;
  }
  if (percentOfMax >= 1) return `${trim(percentOfMax, 1)}%`;
  if (percentOfMax >= 0.1) return `${trim(percentOfMax, 2)}%`;
  return `${trim(percentOfMax, 3)}%`;
}

export function webglMapZoomToDisplaySliderPercent(
  zoom: number,
  bounds?: Partial<WebglMapZoomBounds> | null
): number {
  const resolved = resolveWebglMapZoomBounds(bounds);
  const clamped = clampWebglMapZoom(zoom, resolved);
  if (clamped >= resolved.max * (1 - WEBGL_MAP_ZOOM_AT_MAX_RELATIVE_EPSILON)) return 100;
  const sliderPercent = webglMapZoomToSliderValue(clamped, resolved) * 100;
  return Math.min(99.9, Math.floor(sliderPercent * 10) / 10);
}

function MapPaneIconButton({
  title,
  onClick,
  disabled,
  testId,
  zoomStep,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  zoomStep: 'in' | 'out';
}) {
  return (
    <button
      type="button"
      className="map-pane-zoom-step-button wp-interactive"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      data-ph-name={testId}
      data-testid={testId}
      data-zoom-step={zoomStep}
    >
      <span className="map-pane-zoom-step-glyph" aria-hidden="true" />
    </button>
  );
}

export function SequenceMapPaneControls({
  mapZoomVisible,
  mapZoom,
  mapZoomBounds,
  mapZoomSource,
  onMapZoomChange,
}: {
  mapZoomVisible: boolean;
  mapZoom: number;
  mapZoomBounds?: Partial<WebglMapZoomBounds> | null;
  mapZoomSource?: WebglMapZoomSource;
  onMapZoomChange: (zoom: number) => void;
}) {
  const liveZoom = useSyncExternalStore(
    mapZoomSource?.subscribe ?? noZoomSubscription,
    mapZoomSource?.getSnapshot ?? (() => mapZoom)
  );
  const controlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    const onWheel = (event: WheelEvent) => {
      const target = control
        .closest('[data-sequence-wheel-zoom-scope]')
        ?.querySelector<HTMLElement>('[data-sequence-wheel-zoom-target]');
      if (target) forwardWheelZoom(event, target);
    };
    control.addEventListener('wheel', onWheel, { passive: false });
    return () => control.removeEventListener('wheel', onWheel);
  }, [mapZoomVisible]);
  const resolvedZoomBounds = resolveWebglMapZoomBounds(mapZoomBounds);
  const clampedZoom = clampWebglMapZoom(liveZoom, resolvedZoomBounds);
  const sliderValue = webglMapZoomToSliderValue(clampedZoom, resolvedZoomBounds);
  if (!mapZoomVisible) return null;
  return (
    <div
      ref={controlRef}
      data-ph-name="map-pane-zoom-control"
      data-testid="map-pane-zoom-control"
      data-sequence-wheel-zoom-viewport=""
      className="map-pane-zoom-control"
    >
      <MapPaneZoomControl
        value={clampedZoom}
        bounds={resolvedZoomBounds}
        sliderValue={sliderValue}
        display={formatWebglMapZoom(clampedZoom, resolvedZoomBounds)}
        onSliderChange={(value) =>
          onMapZoomChange(webglMapSliderValueToZoom(value, resolvedZoomBounds))
        }
        onZoomOut={() =>
          onMapZoomChange(clampWebglMapZoom(clampedZoom / WEBGL_MAP_ZOOM_STEP, resolvedZoomBounds))
        }
        onZoomIn={() =>
          onMapZoomChange(clampWebglMapZoom(clampedZoom * WEBGL_MAP_ZOOM_STEP, resolvedZoomBounds))
        }
        onReset={() => onMapZoomChange(clampWebglMapZoom(1, resolvedZoomBounds))}
      />
    </div>
  );
}

function MapPaneZoomControl({
  value,
  bounds,
  sliderValue,
  display,
  onSliderChange,
  onZoomOut,
  onZoomIn,
  onReset,
}: {
  value: number;
  bounds: WebglMapZoomBounds;
  sliderValue: number;
  display: string;
  onSliderChange: (value: number) => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const trackRectRef = useRef<DOMRect | null>(null);
  const clampedSliderValue = clampWebglMapSliderValue(sliderValue);
  const displaySliderPercent = webglMapZoomToDisplaySliderPercent(value, bounds);
  const applyPointerValue = useCallback(
    (clientY: number) => {
      const rect = trackRectRef.current;
      if (!rect || rect.height <= 0) return;
      onSliderChange(clampWebglMapSliderValue(1 - (clientY - rect.top) / rect.height));
    },
    [onSliderChange]
  );
  const nudgeSlider = useCallback(
    (delta: number) => onSliderChange(clampWebglMapSliderValue(clampedSliderValue + delta)),
    [clampedSliderValue, onSliderChange]
  );
  return (
    <>
      <MapPaneIconButton
        title="Zoom in"
        onClick={onZoomIn}
        disabled={value >= bounds.max - WEBGL_MAP_ZOOM_EPSILON}
        testId="map-pane-zoom-in"
        zoomStep="in"
      />
      <div
        ref={trackRef}
        className="map-pane-zoom-slider"
        data-ph-name="map-pane-zoom-slider"
        data-testid="map-pane-zoom-slider"
        role="slider"
        aria-label="Map zoom"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displaySliderPercent}
        aria-valuetext={`${display} of maximum`}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          trackRectRef.current = event.currentTarget.getBoundingClientRect();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          applyPointerValue(event.clientY);
        }}
        onPointerMove={(event) => {
          if ((event.buttons & 1) === 0) return;
          event.preventDefault();
          applyPointerValue(event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault();
            nudgeSlider(WEBGL_MAP_ZOOM_KEYBOARD_STEP);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
            event.preventDefault();
            nudgeSlider(-WEBGL_MAP_ZOOM_KEYBOARD_STEP);
          } else if (event.key === 'PageUp') {
            event.preventDefault();
            nudgeSlider(WEBGL_MAP_ZOOM_KEYBOARD_STEP * 4);
          } else if (event.key === 'PageDown') {
            event.preventDefault();
            nudgeSlider(-WEBGL_MAP_ZOOM_KEYBOARD_STEP * 4);
          } else if (event.key === 'Home') {
            event.preventDefault();
            onSliderChange(WEBGL_MAP_ZOOM_SLIDER_MIN);
          } else if (event.key === 'End') {
            event.preventDefault();
            onSliderChange(WEBGL_MAP_ZOOM_SLIDER_MAX);
          }
        }}
        style={
          {
            '--map-pane-zoom-slider-value': clampedSliderValue,
          } as CSSProperties
        }
      >
        <div
          data-ph-name="map-pane-zoom-thumb"
          data-testid="map-pane-zoom-thumb"
          className="map-pane-zoom-slider-thumb"
        />
      </div>
      <MapPaneIconButton
        title="Zoom out"
        onClick={onZoomOut}
        disabled={value <= bounds.min + WEBGL_MAP_ZOOM_EPSILON}
        testId="map-pane-zoom-out"
        zoomStep="out"
      />
      <button
        className="map-pane-zoom-value"
        type="button"
        title="Reset map zoom"
        onClick={onReset}
        data-ph-name="map-pane-zoom-display"
        data-testid="map-pane-zoom-display"
        data-at-rest={Math.abs(value - 1) < 0.001 ? 'true' : 'false'}
      >
        {display}
      </button>
    </>
  );
}
