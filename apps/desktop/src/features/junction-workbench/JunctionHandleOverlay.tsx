import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ASSEMBLY_PRIMER_HANDLE_METRICS,
  assemblyPrimerHandleVisualForMode,
  type AssemblyPrimerHandleVisual,
} from '@waypoint/genome-renderer';
import { useDarkMode } from '../../shared/context/DarkModeContext';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import {
  beginAssemblyWorkbenchEditTransaction,
  clampEditableFieldValue,
  updateAssemblyWorkbenchEditTransaction,
  type AssemblyWorkbenchEditTransaction,
} from './AssemblyWorkbenchEditTransaction';
import {
  layoutJunctionHandles,
  panDeltaToRevealHandle,
  type JunctionHandlePlacement,
} from './JunctionHandleLayout';

const HANDLE_GRIP_BOTTOM_INSET_PX = 5;
const GOLDEN_GATE_HANDLE_MIN_WIDTH_PX = 34;
const GOLDEN_GATE_HANDLE_STROKE_PX = 1;
const PARKED_HANDLE_Z_INDEX = 30;
const PARKED_HANDLE_CHEVRON_WIDTH_PX = 5;
const PARKED_HANDLE_CHEVRON_GAP_PX = 2;
const HANDLE_ENABLED_COLOR =
  'color-mix(in srgb, hsl(var(--color-fg)) 68%, hsl(var(--color-bg)) 32%)';
const HANDLE_OVERLAP_COLOR =
  'color-mix(in srgb, hsl(var(--color-fg)) 80%, hsl(var(--color-fg-muted)) 20%)';
const HANDLE_GUIDE_COLOR =
  'color-mix(in srgb, hsl(var(--color-fg-muted)) 58%, hsl(var(--color-bg)) 42%)';
const HANDLE_GRIP_FILL_COLOR =
  'color-mix(in srgb, hsl(var(--color-bg)) 74%, hsl(var(--color-fg)) 26%)';
const HANDLE_GRIP_BORDER_COLOR =
  'color-mix(in srgb, hsl(var(--color-fg)) 62%, hsl(var(--color-bg)) 38%)';
const HANDLE_DISABLED_COLOR =
  'color-mix(in srgb, hsl(var(--color-fg-muted)) 54%, hsl(var(--color-bg)) 46%)';

export interface JunctionFieldHandle {
  id: string;
  label: string;
  field: AssemblyWorkbenchEditableField;
  rowId: string;
  kind: AssemblyWorkbenchEditableField['kind'];
  role: AssemblyWorkbenchEditableField['anchors'][number]['role'];
  value: number;
  min: number;
  max: number;
  step: number;
  largeStep: number;
  x: number;
  y: number;
  height: number;
  guideStartY?: number;
  dragScale: number;
  previewSegments?: JunctionPrimerPreviewSegment[];
  visualSpan?: {
    startX: number;
    endX: number;
  };
  geometryPending?: boolean;
  disabled?: boolean;
  color?: string;
}

export interface JunctionPrimerPreviewSegment {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface JunctionHandleOverlayProps {
  handles: JunctionFieldHandle[];
  pxPerBase: number;
  scrollLeft: number;
  height: number;
  onPreview: (handle: JunctionFieldHandle, nextValue: number) => void;
  onCommit: (handle: JunctionFieldHandle, nextValue: number) => void;
  onCancel?: () => void;
  onLivePreview?: (handle: JunctionFieldHandle, nextValue: number) => void;
  onLivePreviewEnd?: () => void;
  onPanRequest?: (deltaPx: number) => void;
}

export function JunctionHandleOverlay({
  handles,
  pxPerBase,
  scrollLeft,
  height,
  onPreview,
  onCommit,
  onCancel,
  onLivePreview,
  onLivePreviewEnd,
  onPanRequest,
}: JunctionHandleOverlayProps) {
  const { darkMode } = useDarkMode();
  const primerHandleVisual = assemblyPrimerHandleVisualForMode(darkMode ? 'dark' : 'light');
  assertLiveSyncPreviewWiringForHandles(handles, onLivePreview, onLivePreviewEnd);
  const dragRef = useRef<{
    handle: JunctionFieldHandle;
    pointerId: number | null;
    transaction: AssemblyWorkbenchEditTransaction;
    element: HTMLButtonElement;
  } | null>(null);
  const visualFrameRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [overlayWidth, setOverlayWidth] = useState(0);
  const [revealedHandleId, setRevealedHandleId] = useState<string | null>(null);
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const measure = () => {
      const width = overlay.getBoundingClientRect().width;
      setOverlayWidth(Number.isFinite(width) ? width : 0);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, []);

  const beginDrag = useCallback(
    (
      handle: JunctionFieldHandle,
      pointerId: number | null,
      clientX: number,
      element: HTMLButtonElement
    ) => {
      assertLiveSyncPreviewWired(handle, onLivePreview, onLivePreviewEnd);
      dragRef.current = {
        handle,
        pointerId,
        transaction: beginAssemblyWorkbenchEditTransaction({
          field: handle.field,
          interactionKind: 'field-handle',
          startClientX: clientX,
          pxPerBase,
          dragScale: handle.dragScale,
        }),
        element,
      };
      applyHandleVisual(element, handle, 0, handle.value, true);
    },
    [onLivePreview, onLivePreviewEnd, pxPerBase]
  );

  const scheduleVisualDrag = useCallback((drag: NonNullable<typeof dragRef.current>) => {
    if (visualFrameRef.current !== null) cancelAnimationFrame(visualFrameRef.current);
    visualFrameRef.current = requestAnimationFrame(() => {
      visualFrameRef.current = null;
      applyHandleVisual(
        drag.element,
        drag.handle,
        drag.transaction.latestVisualOffsetPx,
        drag.transaction.latestValue,
        true
      );
    });
  }, []);

  const updateDrag = useCallback(
    (pointerId: number | null, clientX: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      const update = updateAssemblyWorkbenchEditTransaction(drag.transaction, clientX);
      if (!update.visualOffsetChanged && !update.snappedValueChanged) return;
      drag.transaction = update.transaction;
      scheduleVisualDrag(drag);
      if (!update.snappedValueChanged) return;
      if (requiresLiveSyncPreviewDuringDrag(drag.handle)) {
        onLivePreview?.(drag.handle, drag.transaction.latestValue);
      }
    },
    [onLivePreview, scheduleVisualDrag]
  );

  const endDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (visualFrameRef.current !== null) {
        cancelAnimationFrame(visualFrameRef.current);
        visualFrameRef.current = null;
      }
      const liveSyncHandle = requiresLiveSyncPreviewDuringDrag(drag.handle);
      const valueChanged = drag.transaction.latestValue !== drag.transaction.startValue;
      const deferPreviewClear = liveSyncHandle && commit && valueChanged;
      if (liveSyncHandle && !deferPreviewClear) {
        onLivePreviewEnd?.();
      }
      resetHandleVisual(drag.element, drag.handle);
      if (!commit) {
        onCancel?.();
        return;
      }
      if (valueChanged) {
        onCommit(drag.handle, drag.transaction.latestValue);
        if (liveSyncHandle) {
          scheduleLivePreviewEnd(onLivePreviewEnd);
        }
      }
    },
    [onCancel, onCommit, onLivePreviewEnd]
  );

  const keyboardStep = useCallback(
    (handle: JunctionFieldHandle, delta: number) => {
      const nextValue = clampEditableFieldValue(handle.field, handle.value + delta);
      if (nextValue === handle.value) return;
      onPreview(handle, nextValue);
      onCommit(handle, nextValue);
    },
    [onCommit, onPreview]
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
      updateDrag(event.pointerId, event.clientX);
    };
    const up = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      updateDrag(event.pointerId, event.clientX);
      endDrag(true);
    };
    const cancel = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      endDrag(false);
    };
    const mouseMove = (event: MouseEvent) => {
      updateDrag(null, event.clientX);
    };
    const mouseUp = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== null) return;
      updateDrag(null, event.clientX);
      endDrag(true);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!dragRef.current) return;
      event.preventDefault();
      endDrag(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('mousemove', mouseMove);
    window.addEventListener('mouseup', mouseUp);
    window.addEventListener('keydown', keyDown);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('mousemove', mouseMove);
      window.removeEventListener('mouseup', mouseUp);
      window.removeEventListener('keydown', keyDown);
    };
  }, [endDrag, updateDrag]);

  useEffect(
    () => () => {
      if (visualFrameRef.current !== null) cancelAnimationFrame(visualFrameRef.current);
    },
    []
  );

  const renderedHandles = handles.filter(shouldRenderHandle);
  const frames = renderedHandles.map((handle) => {
    const variant = handleVisualVariant(handle);
    return { variant, frame: handleFrame(handle, height, variant) };
  });
  const placements = layoutJunctionHandles(
    renderedHandles.map((handle, index) => ({
      rawCenterX: handle.x - scrollLeft,
      hitWidth: frames[index].frame.width,
      interactive: !handle.disabled,
      boundaryDrawable: !handle.geometryPending || handle.id === revealedHandleId,
    })),
    overlayWidth,
    ASSEMBLY_PRIMER_HANDLE_METRICS.hitWidthPx
  );

  return (
    <div
      ref={overlayRef}
      data-testid="junction-handle-overlay"
      data-overlay-render-count={renderCountRef.current}
      className="absolute inset-0 pointer-events-none"
      style={{ height }}
    >
      {renderedHandles.map((handle, index) => {
        const left = handle.x - scrollLeft;
        const { variant, frame } = frames[index];
        const placement = placements[index];
        if (placement.kind === 'hidden') return null;
        const offscreen = placement.kind === 'offscreen' ? placement : null;
        if (offscreen && !onPanRequest) return null;
        const disabled = Boolean(handle.disabled);
        const color = handleStrokeColor(handle, primerHandleVisual);
        const reveal = () => {
          setRevealedHandleId(handle.id);
          onPanRequest?.(panDeltaToRevealHandle(left, overlayWidth));
        };
        const commonData = {
          'data-testid': `junction-field-handle-${handle.kind}-${handle.role}`,
          'data-field-id': handle.field.id,
          'data-field-kind': handle.kind,
          'data-field-role': handle.role,
          'data-field-value': handle.value,
          'data-handle-variant': variant,
          'data-handle-visual-contract':
            variant === 'primer' ? primerHandleVisual.contractId : undefined,
          'data-handle-placement': offscreen ? `offscreen-${offscreen.edge}` : 'boundary',
          'data-handle-parked-order': offscreen ? offscreen.order : undefined,
          'data-handle-raw-center-x': round2(left),
          'data-handle-center-x': round2(placement.centerX),
          'data-handle-indicator-x':
            placement.kind === 'boundary' ? round2(placement.indicatorX) : undefined,
          'data-handle-dock': offscreen ? `${offscreen.edge}-edge` : 'bottom',
          'data-handle-disabled': disabled ? 'true' : 'false',
          'data-drag-offset-px': 0,
          'data-dragging': false,
        };
        const commonStyle = {
          left: placement.centerX,
          top: offscreen ? Math.max(0, frame.top - offscreen.row * frame.height) : frame.top,
          width: offscreen ? ASSEMBLY_PRIMER_HANDLE_METRICS.hitWidthPx : frame.width,
          height: frame.height,
          touchAction: 'none',
          cursor: offscreen ? 'pointer' : undefined,
          transform: 'translateX(-50%)',
          borderColor: 'transparent',
          color,
          backgroundColor: handleBackgroundColor(handle, false),
          boxShadow: handleBoxShadow(),
          zIndex: offscreen
            ? PARKED_HANDLE_Z_INDEX
            : isProductOverlapHandle(handle)
              ? 20
              : undefined,
        } satisfies CSSProperties;
        const visual = handleVisualChildren(
          handle,
          variant,
          frame,
          placement.kind === 'offscreen'
            ? parkedHandleVisual(handle, placement, frame, pxPerBase)
            : {
                indicatorX: placement.indicatorX,
                guide: !handle.geometryPending,
                parked: null,
              },
          primerHandleVisual
        );
        if (disabled) {
          return (
            <div key={handle.id}>
              <div
                {...commonData}
                aria-hidden="true"
                className="pointer-events-none absolute z-10 rounded-sm border opacity-0 group-hover/junction-card:opacity-70 group-focus-within/junction-card:opacity-70"
                style={commonStyle}
              >
                {visual}
              </div>
            </div>
          );
        }
        return (
          <div key={handle.id}>
            <button
              type="button"
              role="slider"
              {...commonData}
              data-linked-pan-exclude="true"
              aria-label={handle.label}
              aria-valuemin={handle.min}
              aria-valuemax={handle.max}
              aria-valuenow={handle.value}
              title={handle.label}
              className="group pointer-events-none absolute z-10 cursor-ew-resize rounded-sm border opacity-0 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg group-hover/junction-card:pointer-events-auto group-hover/junction-card:opacity-100 group-focus-within/junction-card:pointer-events-auto group-focus-within/junction-card:opacity-100 data-[dragging=true]:pointer-events-auto data-[dragging=true]:opacity-100"
              style={commonStyle}
              onClick={offscreen ? reveal : undefined}
              onFocus={(event) => {
                if (offscreen && focusIsKeyboardDriven(event.currentTarget)) reveal();
              }}
              onPointerDown={(event) => {
                if (offscreen || event.button > 0) return;
                event.preventDefault();
                beginDrag(handle, event.pointerId, event.clientX, event.currentTarget);
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerUp={(event) => {
                event.stopPropagation();
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                updateDrag(event.pointerId, event.clientX);
                endDrag(true);
              }}
              onPointerCancel={(event) => {
                event.stopPropagation();
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                endDrag(false);
              }}
              onMouseDown={(event) => {
                if (offscreen || dragRef.current || event.button > 0) return;
                event.preventDefault();
                beginDrag(handle, null, event.clientX, event.currentTarget);
              }}
              onMouseUp={(event) => {
                event.stopPropagation();
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== null) return;
                updateDrag(null, event.clientX);
                endDrag(true);
              }}
              onKeyDown={(event) => {
                const delta = keyboardDeltaForKey(handle, event.key, event.shiftKey);
                if (delta !== null) {
                  event.preventDefault();
                  if (offscreen) reveal();
                  keyboardStep(handle, delta);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancel?.();
                }
              }}
            >
              {visual}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function keyboardDeltaForKey(
  handle: JunctionFieldHandle,
  key: string,
  shiftKey: boolean
): number | null {
  const step = shiftKey ? handle.largeStep : handle.step;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return -step;
  if (key === 'ArrowRight' || key === 'ArrowUp') return step;
  if (key === 'Home') return handle.min - handle.value;
  if (key === 'End') return handle.max - handle.value;
  return null;
}

function focusIsKeyboardDriven(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

interface HandleVisualPlacement {
  indicatorX: number;
  guide: boolean;
  parked: { edge: 'left' | 'right'; chevronLeft: number; hint: string } | null;
}

function parkedHandleVisual(
  handle: JunctionFieldHandle,
  placement: Extract<JunctionHandlePlacement, { kind: 'offscreen' }>,
  frame: ReturnType<typeof handleFrame>,
  pxPerBase: number
): HandleVisualPlacement {
  const glyphWidth =
    PARKED_HANDLE_CHEVRON_WIDTH_PX + PARKED_HANDLE_CHEVRON_GAP_PX + frame.gripWidth;
  const glyphLeft = (ASSEMBLY_PRIMER_HANDLE_METRICS.hitWidthPx - glyphWidth) / 2;
  const gripLeft =
    placement.edge === 'left'
      ? glyphLeft + PARKED_HANDLE_CHEVRON_WIDTH_PX + PARKED_HANDLE_CHEVRON_GAP_PX
      : glyphLeft;
  const bases = pxPerBase > 0 ? Math.max(1, Math.round(placement.distancePx / pxPerBase)) : null;
  const distance = bases === null ? '' : `${bases} bp `;
  return {
    indicatorX: gripLeft + frame.gripWidth / 2,
    guide: false,
    parked: {
      edge: placement.edge,
      chevronLeft:
        placement.edge === 'left'
          ? glyphLeft
          : glyphLeft + glyphWidth - PARKED_HANDLE_CHEVRON_WIDTH_PX,
      hint: `${handle.label} is ${distance}off screen to the ${placement.edge}. Click to bring it into view.`,
    },
  };
}

function shouldRenderHandle(handle: JunctionFieldHandle): boolean {
  if (!handle.disabled) return true;
  return handle.kind === 'homologyArm';
}

function handleVisualChildren(
  handle: JunctionFieldHandle,
  variant: HandleVisualVariant,
  frame: ReturnType<typeof handleFrame>,
  horizontal: HandleVisualPlacement,
  primerHandleVisual: AssemblyPrimerHandleVisual
): ReactNode {
  return (
    <>
      {horizontal.guide && (
        <span
          data-testid={`junction-field-handle-line-${handle.kind}-${handle.role}`}
          className="absolute pointer-events-none"
          style={{
            left: horizontal.indicatorX,
            top: frame.lineTop,
            width: frame.lineWidth,
            height: frame.lineHeight,
            transform: 'translateX(-50%)',
            backgroundColor: 'transparent',
            backgroundImage: dottedGuideBackground(
              handleGuideColor(handle, primerHandleVisual),
              primerHandleVisual
            ),
            backgroundRepeat: 'repeat-y',
            backgroundPosition: 'center top',
            backgroundSize: `${ASSEMBLY_PRIMER_HANDLE_METRICS.guideWidthPx}px ${
              ASSEMBLY_PRIMER_HANDLE_METRICS.guideDashPx + ASSEMBLY_PRIMER_HANDLE_METRICS.guideGapPx
            }px`,
            boxShadow: 'none',
          }}
        />
      )}
      {variant === 'goldenGateOverhang' && !horizontal.parked ? (
        <span
          data-testid={`junction-field-handle-span-${handle.kind}-${handle.role}`}
          className="absolute pointer-events-none"
          style={{
            left: horizontal.indicatorX - frame.spanWidth / 2,
            top: frame.spanTop,
            width: frame.spanWidth,
            height: frame.spanHeight,
            backgroundColor: handleGripFillColor(handle, primerHandleVisual),
            borderRadius: `${primerHandleVisual.gripRadiusPx}px`,
            borderLeft: `${GOLDEN_GATE_HANDLE_STROKE_PX}px solid currentColor`,
            borderRight: `${GOLDEN_GATE_HANDLE_STROKE_PX}px solid currentColor`,
            borderBottom: `${GOLDEN_GATE_HANDLE_STROKE_PX}px solid currentColor`,
            borderTop: `${GOLDEN_GATE_HANDLE_STROKE_PX}px solid currentColor`,
            boxShadow: 'none',
          }}
        />
      ) : (
        <span
          data-testid={`junction-field-handle-grip-${handle.kind}-${handle.role}`}
          className="absolute pointer-events-none"
          style={{
            left: horizontal.indicatorX,
            top: frame.gripTop,
            width: frame.gripWidth,
            height: frame.gripHeight,
            transform: 'translateX(-50%)',
            backgroundColor: handleGripFillColor(handle, primerHandleVisual),
            border: `${primerHandleVisual.gripBorderWidthPx}px solid ${handleGripBorderColor(
              handle,
              primerHandleVisual
            )}`,
            borderRadius: `${primerHandleVisual.gripRadiusPx}px`,
            boxShadow: 'none',
          }}
        />
      )}
      {horizontal.parked && (
        <>
          <svg
            data-testid={`junction-field-handle-parked-chevron-${handle.kind}-${handle.role}`}
            aria-hidden="true"
            viewBox="0 0 5 9"
            width={PARKED_HANDLE_CHEVRON_WIDTH_PX}
            height={9}
            className="pointer-events-none absolute"
            style={{
              left: horizontal.parked.chevronLeft,
              top: frame.gripTop + frame.gripHeight / 2 - 4.5,
            }}
          >
            <path
              d={horizontal.parked.edge === 'left' ? 'M4 1 L1 4.5 L4 8' : 'M1 1 L4 4.5 L1 8'}
              fill="none"
              stroke={handleGripBorderColor(handle, primerHandleVisual)}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span
            data-testid={`junction-field-handle-parked-hint-${handle.kind}-${handle.role}`}
            title={horizontal.parked.hint}
            className="absolute inset-0"
          />
        </>
      )}
    </>
  );
}

function assertLiveSyncPreviewWiringForHandles(
  handles: JunctionFieldHandle[],
  onLivePreview: JunctionHandleOverlayProps['onLivePreview'],
  onLivePreviewEnd: JunctionHandleOverlayProps['onLivePreviewEnd']
): void {
  const liveHandle = handles.find(
    (handle) => !handle.disabled && requiresLiveSyncPreviewDuringDrag(handle)
  );
  if (!liveHandle) return;
  assertLiveSyncPreviewWired(liveHandle, onLivePreview, onLivePreviewEnd);
}

function applyHandleVisual(
  element: HTMLButtonElement,
  handle: JunctionFieldHandle,
  dx: number,
  value: number,
  dragging: boolean
): void {
  element.dataset.dragOffsetPx = String(dx);
  element.dataset.fieldValue = String(value);
  element.dataset.dragging = dragging ? 'true' : 'false';
  element.setAttribute('aria-valuenow', String(value));
  element.style.transform = `translateX(calc(-50% + ${dx}px))`;
  element.style.willChange = dragging ? 'transform' : '';
  element.style.backgroundColor = handleBackgroundColor(handle, dragging);
  element.style.boxShadow = handleBoxShadow();
}

function resetHandleVisual(element: HTMLButtonElement, handle: JunctionFieldHandle): void {
  applyHandleVisual(element, handle, 0, handle.value, false);
}

type HandleVisualVariant = 'boundary' | 'overlap' | 'primer' | 'goldenGateOverhang';

function handleVisualVariant(handle: JunctionFieldHandle): HandleVisualVariant {
  if (handle.kind === 'primerPbs' || handle.kind === 'primerTail') return 'primer';
  if (handle.kind === 'goldenGateOverhang') return 'goldenGateOverhang';
  if (handle.kind === 'homologyArm') return 'overlap';
  return 'boundary';
}

function handleStrokeColor(
  handle: JunctionFieldHandle,
  primerHandleVisual: AssemblyPrimerHandleVisual
): string {
  if (handle.disabled) return HANDLE_DISABLED_COLOR;
  if (handle.kind === 'primerPbs' || handle.kind === 'primerTail') {
    return primerHandleVisual.strokeColorCss;
  }
  if (handle.kind === 'homologyArm' || handle.kind === 'goldenGateOverhang') {
    return HANDLE_OVERLAP_COLOR;
  }
  return HANDLE_ENABLED_COLOR;
}

function handleGuideColor(
  handle: JunctionFieldHandle,
  primerHandleVisual: AssemblyPrimerHandleVisual
): string {
  if (handle.disabled) return HANDLE_DISABLED_COLOR;
  if (handle.kind === 'primerPbs' || handle.kind === 'primerTail') {
    return primerHandleVisual.guideColorCss;
  }
  return HANDLE_GUIDE_COLOR;
}

function handleGripFillColor(
  handle: JunctionFieldHandle,
  primerHandleVisual: AssemblyPrimerHandleVisual
): string {
  if (handle.disabled) {
    return 'color-mix(in srgb, hsl(var(--color-bg)) 82%, hsl(var(--color-fg-muted)) 18%)';
  }
  if (handle.kind === 'primerPbs' || handle.kind === 'primerTail') {
    return primerHandleVisual.gripFillColorCss;
  }
  return HANDLE_GRIP_FILL_COLOR;
}

function handleGripBorderColor(
  handle: JunctionFieldHandle,
  primerHandleVisual: AssemblyPrimerHandleVisual
): string {
  if (handle.disabled) return HANDLE_DISABLED_COLOR;
  if (handle.kind === 'primerPbs' || handle.kind === 'primerTail') {
    return primerHandleVisual.gripBorderColorCss;
  }
  return HANDLE_GRIP_BORDER_COLOR;
}

function handleFrame(
  handle: JunctionFieldHandle,
  overlayHeight: number,
  variant: HandleVisualVariant
): {
  top: number;
  width: number;
  height: number;
  lineTop: number;
  lineWidth: number;
  lineHeight: number;
  gripTop: number;
  gripWidth: number;
  gripHeight: number;
  spanTop: number;
  spanWidth: number;
  spanHeight: number;
} {
  const height = Math.min(ASSEMBLY_PRIMER_HANDLE_METRICS.hitHeightPx, Math.max(10, overlayHeight));
  const top = Math.max(0, overlayHeight - height);
  const guideStartY = clampNumber(handle.guideStartY ?? handle.y, 0, top);
  const baseLineHeight = Math.max(0, top - guideStartY);
  const visualSpanWidth =
    handle.visualSpan && handle.visualSpan.endX > handle.visualSpan.startX
      ? handle.visualSpan.endX - handle.visualSpan.startX
      : 0;
  const spanWidth = Math.max(GOLDEN_GATE_HANDLE_MIN_WIDTH_PX, visualSpanWidth);
  const gripHeight = Math.min(ASSEMBLY_PRIMER_HANDLE_METRICS.gripHeightPx, Math.max(6, height - 4));
  const gripTop = Math.max(0, height - HANDLE_GRIP_BOTTOM_INSET_PX - gripHeight);
  const lineHeight = baseLineHeight + gripTop;
  return {
    top,
    width:
      variant === 'goldenGateOverhang' ? spanWidth + 10 : ASSEMBLY_PRIMER_HANDLE_METRICS.hitWidthPx,
    height,
    lineTop: -baseLineHeight,
    lineWidth: ASSEMBLY_PRIMER_HANDLE_METRICS.guideWidthPx,
    lineHeight,
    gripTop,
    gripWidth: ASSEMBLY_PRIMER_HANDLE_METRICS.gripWidthPx,
    gripHeight,
    spanTop: gripTop,
    spanWidth,
    spanHeight: gripHeight,
  };
}

function dottedGuideBackground(
  color: string,
  primerHandleVisual: AssemblyPrimerHandleVisual
): string {
  const gapStart = primerHandleVisual.guideDashPx;
  const cycle = primerHandleVisual.guideDashPx + primerHandleVisual.guideGapPx;
  return `repeating-linear-gradient(to bottom, ${color} 0 ${gapStart}px, transparent ${gapStart}px ${cycle}px)`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isProductOverlapHandle(handle: JunctionFieldHandle): boolean {
  return handle.id.includes(':overlap-') || handle.id.endsWith(':overhang-offset');
}

export function requiresLiveSyncPreviewDuringDrag(handle: JunctionFieldHandle): boolean {
  return (
    handle.kind === 'primerPbs' ||
    handle.kind === 'primerTail' ||
    handle.kind === 'homologyArm' ||
    handle.kind === 'goldenGateOverhang'
  );
}

function assertLiveSyncPreviewWired(
  handle: JunctionFieldHandle,
  onLivePreview: JunctionHandleOverlayProps['onLivePreview'],
  onLivePreviewEnd: JunctionHandleOverlayProps['onLivePreviewEnd']
): void {
  if (!requiresLiveSyncPreviewDuringDrag(handle)) return;
  if (onLivePreview && onLivePreviewEnd) return;
  throw new Error(
    `Junction handle ${handle.kind}:${handle.role} requires live-sync preview wiring for pointer drag.`
  );
}

function scheduleLivePreviewEnd(onLivePreviewEnd: JunctionHandleOverlayProps['onLivePreviewEnd']) {
  if (!onLivePreviewEnd) return;
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => onLivePreviewEnd());
    return;
  }
  window.setTimeout(() => onLivePreviewEnd(), 0);
}

function handleBackgroundColor(_handle: JunctionFieldHandle, _dragging: boolean): string {
  return 'transparent';
}

function handleBoxShadow(): string {
  return 'none';
}
