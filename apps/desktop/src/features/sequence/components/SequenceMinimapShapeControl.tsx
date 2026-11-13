import { useCallback, useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react';

type SequenceMapShape = 'circular' | 'linear';

type TopologyMarkerKey = 'circular' | 'stadium' | 'linear';
type TopologySelectionShape = TopologyMarkerKey | 'intermediate';
type TopologyControlMode = 'shape' | 'topology';

interface TopologyThumbMetrics {
  width: number;
  height: number;
  radius: number;
}

interface SequenceMinimapShapeControlProps {
  geometryHeight: number;
  minHeight: number;
  maxHeight: number;
  mapShape: SequenceMapShape;
  morphToCircle: number;
  mode?: TopologyControlMode;
  onMapShapeChange: (shape: SequenceMapShape) => void;
  onGeometryHeightChange: (height: number) => void;
  onMorphToCircleChange: (morph: number) => void;
}

const CIRCLE_VALUE = 0;
const STADIUM_MORPH_END = 25;
const STADIUM_VALUE = 50;
const LINEAR_VALUE = 100;
const LINEAR_SWITCH_THRESHOLD = 92;
const TOPOLOGY_KEYBOARD_STEP = 3;
const TOPOLOGY_MARKER_SNAP_DISTANCE = 4;

const RAIL_WIDTH = 30;
const RAIL_HEIGHT = 96;
const RAIL_CENTER_X = RAIL_WIDTH / 2;
const RAIL_LINE_WIDTH = 3;

const RAIL_GLYPH_GAP = 3;
const THUMB_OUTSET = 5;

export const GLYPH_SILHOUETTES: Record<TopologyMarkerKey, TopologyThumbMetrics> = {
  circular: { width: 15.4, height: 15.4, radius: 7.7 },
  stadium: { width: 16, height: 8.4, radius: 4.2 },
  linear: { width: 17, height: 8.6, radius: 3 },
};

function outsetMetrics(metrics: TopologyThumbMetrics, outset: number): TopologyThumbMetrics {
  return {
    width: metrics.width + outset * 2,
    height: metrics.height + outset * 2,
    radius: metrics.radius + outset,
  };
}

const TOPOLOGY_THUMB_STOPS: Array<{ value: number } & TopologyThumbMetrics> = [
  { value: CIRCLE_VALUE, ...outsetMetrics(GLYPH_SILHOUETTES.circular, THUMB_OUTSET) },
  { value: STADIUM_VALUE, ...outsetMetrics(GLYPH_SILHOUETTES.stadium, THUMB_OUTSET) },
  { value: LINEAR_VALUE, ...outsetMetrics(GLYPH_SILHOUETTES.linear, THUMB_OUTSET) },
];
const TOPOLOGY_ONLY_THUMB_STOPS: Array<{ value: number } & TopologyThumbMetrics> = [
  TOPOLOGY_THUMB_STOPS[0]!,
  TOPOLOGY_THUMB_STOPS[TOPOLOGY_THUMB_STOPS.length - 1]!,
];

const TOPOLOGY_MARKERS: Array<{
  key: TopologyMarkerKey;
  label: string;
  value: number;
}> = [
  { key: 'circular', label: 'Circular map', value: CIRCLE_VALUE },
  { key: 'stadium', label: 'Stadium map', value: STADIUM_VALUE },
  { key: 'linear', label: 'Linear map', value: LINEAR_VALUE },
];

const TOPOLOGY_ONLY_MARKERS: Array<{
  key: TopologyMarkerKey;
  label: string;
  value: number;
}> = [
  { key: 'circular', label: 'Circular map', value: CIRCLE_VALUE },
  { key: 'linear', label: 'Linear map', value: LINEAR_VALUE },
];

function clampTopologyValue(value: number): number {
  if (!Number.isFinite(value)) return CIRCLE_VALUE;
  return Math.max(CIRCLE_VALUE, Math.min(LINEAR_VALUE, value));
}

function railYForValue(value: number): number {
  return (clampTopologyValue(value) / LINEAR_VALUE) * RAIL_HEIGHT;
}

function topologyValueForState({
  mapShape,
  morphToCircle,
  geometryHeight,
  minHeight,
  maxHeight,
  mode,
}: {
  mapShape: SequenceMapShape;
  morphToCircle: number;
  geometryHeight: number;
  minHeight: number;
  maxHeight: number;
  mode: TopologyControlMode;
}): number {
  if (mode === 'topology') return mapShape === 'linear' ? LINEAR_VALUE : CIRCLE_VALUE;
  if (mapShape === 'linear') return LINEAR_VALUE;

  const clampedMorph = Math.max(0, Math.min(1, morphToCircle));
  if (clampedMorph > 0) {
    return (1 - clampedMorph) * STADIUM_MORPH_END;
  }

  const heightSpan = Math.max(1, maxHeight - minHeight);
  const heightRatio = Math.max(0, Math.min(1, (geometryHeight - minHeight) / heightSpan));
  return STADIUM_MORPH_END + (1 - heightRatio) * (STADIUM_VALUE - STADIUM_MORPH_END);
}

function nearestTopologyMarker(
  value: number,
  markers: typeof TOPOLOGY_MARKERS
): (typeof TOPOLOGY_MARKERS)[number] {
  return markers.reduce((best, marker) =>
    Math.abs(marker.value - value) < Math.abs(best.value - value) ? marker : best
  );
}

function topologyValueText(value: number, mode: TopologyControlMode): string {
  if (mode === 'topology') {
    return value >= LINEAR_SWITCH_THRESHOLD ? 'Linear map' : 'Circular map';
  }
  if (value >= LINEAR_SWITCH_THRESHOLD) return 'Linear map';
  const nearest = nearestTopologyMarker(value, TOPOLOGY_MARKERS);
  if (Math.abs(nearest.value - value) <= TOPOLOGY_MARKER_SNAP_DISTANCE) return nearest.label;
  if (value < STADIUM_MORPH_END) return 'Circular to stadium map';
  return 'Stadium height';
}

function topologySelectionShape(
  value: number,
  marker: TopologyMarkerKey | null,
  mode: TopologyControlMode
): TopologySelectionShape {
  if (mode === 'topology') return value >= LINEAR_SWITCH_THRESHOLD ? 'linear' : 'circular';
  if (!marker) return 'intermediate';
  if (value >= LINEAR_SWITCH_THRESHOLD) return 'linear';
  return marker;
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function topologyThumbMetrics(value: number, mode: TopologyControlMode): TopologyThumbMetrics {
  const clamped = clampTopologyValue(value);
  const stops = mode === 'topology' ? TOPOLOGY_ONLY_THUMB_STOPS : TOPOLOGY_THUMB_STOPS;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (clamped <= first.value) return first;
  if (clamped >= last.value) return last;

  const nextStop = stops.find((stop) => clamped <= stop.value) ?? last;
  const nextIndex = stops.indexOf(nextStop);
  const previousStop = stops[Math.max(0, nextIndex - 1)] ?? first;
  const span = Math.max(1, nextStop.value - previousStop.value);
  const t = (clamped - previousStop.value) / span;
  return {
    width: lerp(previousStop.width, nextStop.width, t),
    height: lerp(previousStop.height, nextStop.height, t),
    radius: lerp(previousStop.radius, nextStop.radius, t),
  };
}

function TopologyIcon({ value }: { value: TopologyMarkerKey }) {
  if (value === 'circular') {
    return (
      <svg
        className="sequence-map-topology-icon"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        aria-hidden="true"
        data-icon-shape="hollow"
      >
        <circle cx="12" cy="12" r="6.6" fill="none" stroke="currentColor" strokeWidth="2.2" />
      </svg>
    );
  }

  if (value === 'linear') {
    return (
      <svg
        className="sequence-map-topology-icon"
        width="24"
        height="22"
        viewBox="0 0 24 22"
        aria-hidden="true"
        data-icon-shape="hollow"
      >
        <path
          d="M5 11h14M5 7.7v6.6M19 7.7v6.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const height = 6.4;
  const y = (22 - height) / 2;
  return (
    <svg
      className="sequence-map-topology-icon"
      width="24"
      height="22"
      viewBox="0 0 24 22"
      aria-hidden="true"
      data-icon-shape="hollow"
    >
      <rect
        x="5"
        y={y}
        width="14"
        height={height}
        rx={height / 2}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export function SequenceMinimapShapeControl({
  geometryHeight,
  minHeight,
  maxHeight,
  mapShape,
  morphToCircle,
  mode = 'shape',
  onMapShapeChange,
  onGeometryHeightChange,
  onMorphToCircleChange,
}: SequenceMinimapShapeControlProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const markers = mode === 'topology' ? TOPOLOGY_ONLY_MARKERS : TOPOLOGY_MARKERS;
  const value = clampTopologyValue(
    topologyValueForState({
      mapShape,
      morphToCircle,
      geometryHeight,
      minHeight,
      maxHeight,
      mode,
    })
  );
  const nearestMarker = useMemo(() => nearestTopologyMarker(value, markers), [markers, value]);
  const activeMarkerKey =
    mode === 'topology'
      ? value >= LINEAR_SWITCH_THRESHOLD
        ? 'linear'
        : 'circular'
      : value >= LINEAR_SWITCH_THRESHOLD
        ? 'linear'
        : Math.abs(nearestMarker.value - value) <= TOPOLOGY_MARKER_SNAP_DISTANCE
          ? nearestMarker.key
          : null;
  const selectionShape = topologySelectionShape(value, activeMarkerKey, mode);
  const thumbMetrics = topologyThumbMetrics(value, mode);
  const thumbCenterY = railYForValue(value);

  const railSegments = useMemo(
    () =>
      markers.slice(0, -1).map((marker, index) => {
        const nextMarker = markers[index + 1]!;
        const startHalf = GLYPH_SILHOUETTES[marker.key].height / 2 + RAIL_GLYPH_GAP;
        const endHalf = GLYPH_SILHOUETTES[nextMarker.key].height / 2 + RAIL_GLYPH_GAP;
        return {
          key: `${marker.key}-${nextMarker.key}`,
          from: railYForValue(marker.value) + startHalf,
          to: railYForValue(nextMarker.value) - endHalf,
          dashed: mode === 'shape' && marker.key === 'stadium' && nextMarker.key === 'linear',
        };
      }),
    [markers, mode]
  );

  const applyValue = useCallback(
    (nextValue: number) => {
      const clamped = clampTopologyValue(nextValue);
      if (mode === 'topology') {
        onMapShapeChange(clamped >= LINEAR_SWITCH_THRESHOLD ? 'linear' : 'circular');
        return;
      }

      if (clamped >= LINEAR_SWITCH_THRESHOLD) {
        onMapShapeChange('linear');
        onMorphToCircleChange(0);
        onGeometryHeightChange(minHeight);
        return;
      }

      onMapShapeChange('circular');
      if (clamped <= STADIUM_MORPH_END) {
        onMorphToCircleChange(1 - clamped / STADIUM_MORPH_END);
        onGeometryHeightChange(maxHeight);
        return;
      }

      const stadiumT = Math.min(
        1,
        (clamped - STADIUM_MORPH_END) / (STADIUM_VALUE - STADIUM_MORPH_END)
      );
      onMorphToCircleChange(0);
      onGeometryHeightChange(maxHeight - stadiumT * (maxHeight - minHeight));
    },
    [maxHeight, minHeight, mode, onGeometryHeightChange, onMapShapeChange, onMorphToCircleChange]
  );

  const railRectRef = useRef<DOMRect | null>(null);
  const applyPointerValue = useCallback(
    (clientY: number) => {
      const rect = railRectRef.current;
      if (!rect || rect.height <= 0) return;
      applyValue(clampTopologyValue(((clientY - rect.top) / rect.height) * LINEAR_VALUE));
    },
    [applyValue]
  );

  const markerValueAtTarget = useCallback(
    (target: EventTarget | null): number | null => {
      if (!(target instanceof Element)) return null;
      const markerEl = target.closest<HTMLElement>('.sequence-map-topology-marker');
      const markerKey = markerEl?.dataset.marker;
      if (!markerKey) return null;
      return markers.find((marker) => marker.key === markerKey)?.value ?? null;
    },
    [markers]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = mode === 'topology' ? LINEAR_VALUE : TOPOLOGY_KEYBOARD_STEP;
      const pageStep = mode === 'topology' ? LINEAR_VALUE : TOPOLOGY_KEYBOARD_STEP * 4;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        applyValue(value - step);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        applyValue(value + step);
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        applyValue(value - pageStep);
      } else if (event.key === 'PageDown') {
        event.preventDefault();
        applyValue(value + pageStep);
      } else if (event.key === 'Home') {
        event.preventDefault();
        applyValue(CIRCLE_VALUE);
      } else if (event.key === 'End') {
        event.preventDefault();
        applyValue(LINEAR_VALUE);
      }
    },
    [applyValue, mode, value]
  );

  return (
    <div
      data-ph-name="sequence-minimap-shape-control"
      data-testid="sequence-minimap-shape-control"
      data-control-kind="topology-slider"
      data-topology-stop={activeMarkerKey ?? 'intermediate'}
      data-topology-at-preset={activeMarkerKey ? 'true' : 'false'}
      data-topology-selection-shape={selectionShape}
      data-topology-mode={mode}
      className="sequence-map-topology-control"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        ref={railRef}
        data-ph-name="sequence-map-topology-slider"
        data-testid="sequence-map-topology-slider"
        className="sequence-map-topology-rail"
        style={{ height: RAIL_HEIGHT }}
        role="slider"
        aria-label="Map topology"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(value.toFixed(1))}
        aria-valuetext={topologyValueText(value, mode)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          railRectRef.current = event.currentTarget.getBoundingClientRect();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const snapValue = markerValueAtTarget(event.target);
          if (snapValue !== null) applyValue(snapValue);
          else applyPointerValue(event.clientY);
        }}
        onPointerMove={(event) => {
          if ((event.buttons & 1) === 0) return;
          event.preventDefault();
          applyPointerValue(event.clientY);
        }}
        onKeyDown={handleKeyDown}
      >
        <svg
          className="sequence-map-topology-canvas"
          width={RAIL_WIDTH}
          height={RAIL_HEIGHT}
          viewBox={`0 0 ${RAIL_WIDTH} ${RAIL_HEIGHT}`}
          aria-hidden="true"
        >
          {}
          {railSegments.map((segment) => (
            <line
              key={segment.key}
              data-ph-name="sequence-map-topology-rail-segment"
              data-testid="sequence-map-topology-rail-segment"
              data-rail-segment={segment.key}
              data-rail-segment-style={segment.dashed ? 'dashed' : 'solid'}
              className="sequence-map-topology-rail-segment"
              x1={RAIL_CENTER_X}
              y1={segment.from}
              x2={RAIL_CENTER_X}
              y2={segment.to}
              strokeWidth={RAIL_LINE_WIDTH}
              strokeLinecap="round"
              {...(segment.dashed ? { strokeDasharray: '4 4' } : {})}
            />
          ))}
          {}
          <rect
            data-ph-name="sequence-map-topology-thumb"
            data-testid="sequence-map-topology-thumb"
            className="sequence-map-topology-thumb"
            data-selection-shape={selectionShape}
            x={RAIL_CENTER_X - thumbMetrics.width / 2}
            y={thumbCenterY - thumbMetrics.height / 2}
            width={thumbMetrics.width}
            height={thumbMetrics.height}
            rx={thumbMetrics.radius}
          />
        </svg>
        {markers.map((marker) => (
          <span
            key={marker.key}
            className="sequence-map-topology-marker"
            data-marker={marker.key}
            data-active={marker.key === activeMarkerKey ? 'true' : 'false'}
            style={
              {
                '--sequence-map-topology-marker-value': marker.value,
              } as CSSProperties
            }
            title={marker.label}
            aria-hidden="true"
          >
            <TopologyIcon value={marker.key} />
          </span>
        ))}
      </div>
    </div>
  );
}
