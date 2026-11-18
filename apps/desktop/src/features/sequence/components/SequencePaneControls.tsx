import type { ReactNode, KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { forwardWheelZoom } from '@waypoint/platform/wheel-motion';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  formatZoomPercent,
  stepZoomByFactor,
} from '@waypoint/workspace-editor';
import { SequenceViewerModeToggle, type SequenceViewMode } from './SequenceViewerModeToggle';

export const MIN_SEQUENCE_ZOOM = MIN_ZOOM;
export const MAX_SEQUENCE_ZOOM = MAX_ZOOM;

function PaneControlShell({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'nowrap',
        justifyContent: 'flex-end',
        maxWidth: 'calc(100% - 16px)',
        pointerEvents: 'auto',
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

function PaneControlGroup({ children, testId }: { children: ReactNode; testId?: string }) {
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
  }, []);
  return (
    <div
      ref={controlRef}
      data-testid={testId}
      data-sequence-wheel-zoom-viewport=""
      className="sequence-pane-zoom-control"
    >
      {children}
    </div>
  );
}

function PaneIconButton({
  children,
  title,
  onClick,
  disabled,
  testId,
  zoomStep,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  zoomStep: 'in' | 'out';
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-zoom-step={zoomStep}
      className="map-pane-zoom-step-button wp-interactive"
    >
      {children}
    </button>
  );
}

function PaneZoomControl({
  value,
  min,
  max,
  step,
  display,
  sliderValue,
  sliderMin,
  sliderMax,
  sliderStep,
  isDefault = value === 100,
  onSliderChange,
  onSliderKeyDown,
  onZoomOut,
  onZoomIn,
  onReset,
  zoomOutTestId,
  zoomInTestId,
  displayTestId,
  displayInnerTestId,
  sliderTestId,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  sliderValue?: number;
  sliderMin?: number;
  sliderMax?: number;
  sliderStep?: number;
  isDefault?: boolean;
  onSliderChange: (value: number) => void;
  onSliderKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
  zoomOutTestId: string;
  zoomInTestId: string;
  displayTestId: string;
  displayInnerTestId?: string;
  sliderTestId: string;
}) {
  const actualSliderValue = sliderValue ?? value;
  return (
    <PaneControlGroup>
      <PaneIconButton
        title="Zoom out"
        onClick={onZoomOut}
        disabled={value <= min}
        testId={zoomOutTestId}
        zoomStep="out"
      >
        <span className="map-pane-zoom-step-glyph" aria-hidden="true" />
      </PaneIconButton>
      <input
        className="pane-zoom-slider"
        type="range"
        min={sliderMin ?? min}
        max={sliderMax ?? max}
        step={sliderStep ?? step}
        value={actualSliderValue}
        onChange={(event) => onSliderChange(Number(event.currentTarget.value))}
        onKeyDown={onSliderKeyDown}
        data-testid={sliderTestId}
        aria-label="Zoom"
        style={{ width: 104 }}
      />
      <PaneIconButton
        title="Zoom in"
        onClick={onZoomIn}
        disabled={value >= max}
        testId={zoomInTestId}
        zoomStep="in"
      >
        <span className="map-pane-zoom-step-glyph" aria-hidden="true" />
      </PaneIconButton>
      <button
        type="button"
        title="Reset zoom"
        onClick={onReset}
        data-testid={displayTestId}
        data-at-rest={isDefault ? 'true' : 'false'}
        className="map-pane-zoom-value"
      >
        <span data-testid={displayInnerTestId}>{display}</span>
      </button>
    </PaneControlGroup>
  );
}

export function SequencePaneControls({
  mode,
  onModeChange,
  showModeToggle = false,
  tracksLabel = 'Sanger traces',
  zoom,
  minZoom = MIN_SEQUENCE_ZOOM,
  onZoomChange,
}: {
  mode: SequenceViewMode;
  onModeChange: (mode: SequenceViewMode) => void;
  showModeToggle?: boolean;
  tracksLabel?: string;
  zoom: number;
  minZoom?: number;
  onZoomChange: (zoom: number) => void;
}) {
  const minimum = Math.max(MIN_SEQUENCE_ZOOM, Math.min(MAX_SEQUENCE_ZOOM, minZoom));
  const clampedZoom = Math.max(minimum, Math.min(MAX_SEQUENCE_ZOOM, zoom));
  const [control, setControl] = useState({ reported: clampedZoom, value: clampedZoom });
  if (control.reported !== clampedZoom) {
    setControl({ reported: clampedZoom, value: clampedZoom });
  }
  const controlZoom = Math.max(
    minimum,
    control.reported === clampedZoom ? control.value : clampedZoom
  );
  const requestZoom = (requested: number) => {
    const target = Math.max(minimum, Math.min(MAX_SEQUENCE_ZOOM, requested));
    setControl({ reported: clampedZoom, value: target });
    onZoomChange(target);
  };
  return (
    <PaneControlShell testId="sequence-pane-controls">
      {showModeToggle ? (
        <SequenceViewerModeToggle value={mode} onChange={onModeChange} />
      ) : (
        <span
          data-testid={
            mode === 'tracks'
              ? tracksLabel === 'Alignment'
                ? 'sequence-alignment-mode'
                : 'sequence-trace-mode'
              : 'sequence-wrap-mode'
          }
          className="text-xs text-fg-muted"
        >
          {mode === 'tracks' ? tracksLabel : 'Wrap'}
        </span>
      )}
      <PaneZoomControl
        value={controlZoom}
        min={minimum}
        max={MAX_SEQUENCE_ZOOM}
        step={0.2}
        display={formatZoomPercent(controlZoom)}
        onSliderChange={requestZoom}
        onSliderKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const target = event.key === 'Home' ? minimum : MAX_SEQUENCE_ZOOM;
            event.currentTarget.value = String(target);
            requestZoom(target);
            return;
          }
          const direction =
            event.key === 'ArrowLeft' || event.key === 'ArrowDown'
              ? -1
              : event.key === 'ArrowRight' || event.key === 'ArrowUp'
                ? 1
                : 0;
          if (!direction) return;
          event.preventDefault();
          const displayedZoom = Number(event.currentTarget.value);
          const currentZoom =
            Math.abs(displayedZoom - controlZoom) > 0.10000001 ? displayedZoom : controlZoom;
          const target = Math.max(
            minimum,
            Math.min(MAX_SEQUENCE_ZOOM, currentZoom + direction * 0.2)
          );
          event.currentTarget.value = String(target);
          requestZoom(target);
        }}
        onZoomOut={() =>
          requestZoom(
            stepZoomByFactor(controlZoom, -1, {
              minZoom: minimum,
              maxZoom: MAX_SEQUENCE_ZOOM,
            })
          )
        }
        onZoomIn={() =>
          requestZoom(
            stepZoomByFactor(controlZoom, 1, {
              minZoom: minimum,
              maxZoom: MAX_SEQUENCE_ZOOM,
            })
          )
        }
        onReset={() => requestZoom(100)}
        zoomOutTestId="toolbar-zoom-out"
        zoomInTestId="toolbar-zoom-in"
        displayTestId="toolbar-zoom-display"
        displayInnerTestId="sequence-pane-zoom-display"
        sliderTestId="sequence-pane-zoom-slider"
      />
    </PaneControlShell>
  );
}
