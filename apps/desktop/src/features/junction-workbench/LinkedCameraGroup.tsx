import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type RenderedPrimerSegment } from '@waypoint/workspace-editor';
import type { CoordMapping } from './coord-mapping';
import type { JunctionWorkbenchRow } from './model';
import { LinkedCameraController } from './LinkedCameraController';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import {
  beginSourceRegisterGesture,
  cancelSourceRegisterGesture,
  sourceRegisterPresentationOffsetPx,
  updateSourceRegisterRenderedValue,
  updateSourceRegisterGesture,
  type SourceRegisterGestureState,
} from './registered-viewport';
import { sourceContributionBoundaryFieldForRow } from './JunctionFieldHandleProjection';
import { RegisteredSequenceSurface, type JunctionRowMetric } from './RegisteredSequenceSurface';

const ROW_VIEWER_HEIGHT = 132;
type SourceRegisterRow = JunctionWorkbenchRow & { kind: 'left-source' | 'right-source' };

interface LinkedCameraGroupProps {
  rows: JunctionWorkbenchRow[];
  mapping: CoordMapping;
  initialCameraBioCol?: number;
  editableFields?: AssemblyWorkbenchEditableField[];
  rowMetrics?: JunctionRowMetricsByRowId;
  onFieldPreview?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldPreviewImmediate?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldCommit?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldCancel?: () => void;
  productControls?: ReactNode;
  onLinkedScroll?: (redrawCount: number) => void;
}

export type JunctionRowMetricsByRowId = Record<string, JunctionRowMetric>;

interface PrimerLayoutCacheEntry {
  signature: string;
  segments: RenderedPrimerSegment[];
}

export function LinkedCameraGroup({
  rows,
  mapping,
  initialCameraBioCol = 0,
  editableFields = [],
  rowMetrics = {},
  onFieldPreview,
  onFieldPreviewImmediate,
  onFieldCommit,
  onFieldCancel,
  productControls,
  onLinkedScroll,
}: LinkedCameraGroupProps) {
  const controllerRef = useRef<LinkedCameraController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new LinkedCameraController({
      rows,
      mapping,
      initialCameraBioCol,
    });
  }
  const controller = controllerRef.current;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const primerLayoutsRef = useRef<Record<string, PrimerLayoutCacheEntry>>({});
  const panDragRef = useRef<{
    pointerId: number | null;
    lastClientX: number;
    frame: HTMLDivElement;
  } | null>(null);
  const sourceRegisterDragRef = useRef<{
    gesture: SourceRegisterGestureState;
    activeRowKind: 'left-source' | 'right-source';
    frame: HTMLDivElement;
  } | null>(null);
  const sourceRegisterEndCountRef = useRef(0);
  const sourceRegisterCommitHandlerCallCountRef = useRef(0);
  const sourceRegisterContentPreviewRef = useRef<SourceRegisterContentPreview>({
    offsetPx: 0,
    activeRowKind: null,
  });
  const [sourceRegisterPreviewRowKind, setSourceRegisterPreviewRowKind] = useState<
    'left-source' | 'right-source' | null
  >(null);
  const [, setPrimerLayoutRevision] = useState(0);

  const updatePrimerLayout = useCallback((rowId: string, segments: RenderedPrimerSegment[]) => {
    const signature = primerLayoutSignature(segments);
    const current = primerLayoutsRef.current[rowId];
    if (current?.signature === signature) return;
    primerLayoutsRef.current = {
      ...primerLayoutsRef.current,
      [rowId]: { signature, segments },
    };
    setPrimerLayoutRevision((revision) => revision + 1);
  }, []);

  useLayoutEffect(() => {
    controller.setInputs(rows, mapping);
  }, [controller, mapping, rows]);

  useEffect(() => () => controller.dispose(), [controller]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => controller.setViewportWidth(measureViewportWidth(el));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  useLayoutEffect(() => {
    const drag = sourceRegisterDragRef.current;
    if (drag) {
      const renderedValue = renderedValueForGesture(drag.gesture, editableFields);
      drag.gesture = updateSourceRegisterRenderedValue(drag.gesture, renderedValue);
      const offsetPx = sourceRegisterPresentationOffsetPx(drag.gesture);
      sourceRegisterContentPreviewRef.current = {
        offsetPx,
        activeRowKind: drag.activeRowKind,
      };
      drag.frame.dataset.linkedSourceRegisterRenderedValue = String(drag.gesture.renderedValue);
      drag.frame.dataset.linkedSourceRegisterPresentationOffsetPx = String(round2(offsetPx));
    }
    applySourceRegisterContentPreview(
      containerRef.current,
      sourceRegisterContentPreviewRef.current
    );
  });

  useEffect(() => {
    if (snapshot.lastRedrawCount > 0) {
      onLinkedScroll?.(snapshot.lastRedrawCount);
    }
  }, [onLinkedScroll, snapshot.frameCount, snapshot.lastRedrawCount]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest<HTMLElement>('[data-row-id]');
      if (!target || !row || !el.contains(row)) return;
      const viewerFrame = row.querySelector<HTMLElement>('[data-linked-viewer-frame="true"]');
      if (!viewerFrame || !viewerFrame.contains(target)) return;

      const rowId = row.dataset.rowId;
      if (!rowId) return;
      const rect = viewerFrame.getBoundingClientRect();
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        controller.zoomAt(event.deltaY, rowId, event.clientX - rect.left);
        return;
      }
      if (event.deltaX === 0 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      event.stopPropagation();
      controller.panPixels(event.deltaX);
    };
    el.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', handleWheel, { capture: true });
  }, [controller]);

  const beginSourceRegisterDrag = useCallback(
    (
      field: AssemblyWorkbenchEditableField,
      pointerId: number | null,
      clientX: number,
      frame: HTMLDivElement
    ) => {
      const activeRow = sourceRowForFrame(frame, rows);
      if (!activeRow) return;
      const gesture = beginSourceRegisterGesture({
        field,
        pointerId,
        startClientX: clientX,
        pxPerBase: snapshot.pxPerBase,
      });
      sourceRegisterDragRef.current = {
        gesture,
        activeRowKind: activeRow.kind,
        frame,
      };
      sourceRegisterContentPreviewRef.current = {
        offsetPx: 0,
        activeRowKind: activeRow.kind,
      };
      setSourceRegisterPreviewRowKind(activeRow.kind);
      applySourceRegisterContentPreview(
        containerRef.current,
        sourceRegisterContentPreviewRef.current
      );
      frame.dataset.linkedSourceRegisterDragging = 'true';
      frame.dataset.linkedSourceRegisterValue = String(gesture.latestValue);
      frame.dataset.linkedSourceRegisterRenderedValue = String(gesture.renderedValue);
      frame.dataset.linkedSourceRegisterMoveCount = '0';
      frame.dataset.linkedSourceRegisterVisualOffsetPx = '0';
      frame.dataset.linkedSourceRegisterPresentationOffsetPx = '0';
    },
    [rows, snapshot.pxPerBase]
  );

  const updateSourceRegisterDrag = useCallback(
    (clientX: number) => {
      const drag = sourceRegisterDragRef.current;
      if (!drag) return;
      const update = updateSourceRegisterGesture(drag.gesture, clientX);
      drag.gesture = update.state;
      const visualDx = drag.gesture.visualOffsetPx;
      const residualDx = sourceRegisterPresentationOffsetPx(drag.gesture);
      sourceRegisterContentPreviewRef.current = {
        offsetPx: residualDx,
        activeRowKind: drag.activeRowKind,
      };
      drag.frame.dataset.linkedSourceRegisterMoveCount = String(drag.gesture.moveCount);
      drag.frame.dataset.linkedSourceRegisterDeltaPx = String(-visualDx);
      drag.frame.dataset.linkedSourceRegisterPxPerBase = String(drag.gesture.pxPerBase);
      drag.frame.dataset.linkedSourceRegisterVisualOffsetPx = String(visualDx);
      drag.frame.dataset.linkedSourceRegisterRenderedValue = String(drag.gesture.renderedValue);
      drag.frame.dataset.linkedSourceRegisterPresentationOffsetPx = String(round2(residualDx));
      applySourceRegisterContentPreview(
        containerRef.current,
        sourceRegisterContentPreviewRef.current
      );
      if (!update.snappedValueChanged) return;
      drag.frame.dataset.linkedSourceRegisterValue = String(drag.gesture.latestValue);
      (onFieldPreviewImmediate ?? onFieldPreview)?.(drag.gesture.field, drag.gesture.latestValue);
    },
    [onFieldPreview, onFieldPreviewImmediate]
  );

  const endSourceRegisterDrag = useCallback(
    (commit: boolean) => {
      const drag = sourceRegisterDragRef.current;
      if (!drag) return;
      sourceRegisterDragRef.current = null;
      const finalGesture = commit ? drag.gesture : cancelSourceRegisterGesture(drag.gesture);
      sourceRegisterEndCountRef.current += 1;
      if (containerRef.current) {
        containerRef.current.dataset.sourceRegisterEndCount = String(
          sourceRegisterEndCountRef.current
        );
        containerRef.current.dataset.sourceRegisterLastEndFieldId = finalGesture.field.id;
        containerRef.current.dataset.sourceRegisterLastEndValue = String(finalGesture.latestValue);
        containerRef.current.dataset.sourceRegisterLastEndCommit = commit ? 'true' : 'false';
        containerRef.current.dataset.sourceRegisterLastEndHasCommitHandler = onFieldCommit
          ? 'true'
          : 'false';
      }
      drag.frame.dataset.linkedSourceRegisterDragging = 'false';
      drag.frame.dataset.linkedSourceRegisterVisualOffsetPx = '0';
      drag.frame.dataset.linkedSourceRegisterPresentationOffsetPx = '0';
      sourceRegisterContentPreviewRef.current = {
        offsetPx: 0,
        activeRowKind: null,
      };
      setSourceRegisterPreviewRowKind(null);
      applySourceRegisterContentPreview(
        containerRef.current,
        sourceRegisterContentPreviewRef.current
      );
      if (commit) {
        sourceRegisterCommitHandlerCallCountRef.current += 1;
        if (containerRef.current) {
          containerRef.current.dataset.sourceRegisterCommitHandlerCallCount = String(
            sourceRegisterCommitHandlerCallCountRef.current
          );
          containerRef.current.dataset.sourceRegisterCommitHandlerLastFieldId =
            finalGesture.field.id;
          containerRef.current.dataset.sourceRegisterCommitHandlerLastValue = String(
            finalGesture.latestValue
          );
        }
        onFieldCommit?.(finalGesture.field, finalGesture.latestValue);
      } else onFieldCancel?.();
      releasePointerCaptureIfHeld(drag.frame, drag.gesture.pointerId);
    },
    [onFieldCancel, onFieldCommit]
  );

  const beginSurfacePan = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.button > 0 || !target || isLinkedPanExcludedTarget(target)) return;

      const sourceRegisterField = sourceRegisterFieldForFrame({
        frame: event.currentTarget,
        rows,
        fields: editableFields,
      });
      if (sourceRegisterField) {
        beginSourceRegisterDrag(
          sourceRegisterField,
          event.pointerId,
          event.clientX,
          event.currentTarget
        );
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (isSourceRowFrame(event.currentTarget, rows)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      panDragRef.current = {
        pointerId: event.pointerId,
        lastClientX: event.clientX,
        frame: event.currentTarget,
      };
      event.currentTarget.dataset.linkedPanDragging = 'true';
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [beginSourceRegisterDrag, editableFields, rows]
  );

  const beginSurfaceMousePan = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (panDragRef.current || sourceRegisterDragRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.button > 0 || !target || isLinkedPanExcludedTarget(target)) return;

      const sourceRegisterField = sourceRegisterFieldForFrame({
        frame: event.currentTarget,
        rows,
        fields: editableFields,
      });
      if (sourceRegisterField) {
        beginSourceRegisterDrag(sourceRegisterField, null, event.clientX, event.currentTarget);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (isSourceRowFrame(event.currentTarget, rows)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      panDragRef.current = {
        pointerId: null,
        lastClientX: event.clientX,
        frame: event.currentTarget,
      };
      event.currentTarget.dataset.linkedPanDragging = 'true';
      event.preventDefault();
      event.stopPropagation();
    },
    [beginSourceRegisterDrag, editableFields, rows]
  );

  const moveSurfacePan = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const registerDrag = sourceRegisterDragRef.current;
      if (registerDrag && registerDrag.gesture.pointerId === event.pointerId) {
        updateSourceRegisterDrag(event.clientX);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const drag = panDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.lastClientX;
      drag.lastClientX = event.clientX;
      if (dx !== 0) controller.panPixels(-dx);
      event.preventDefault();
      event.stopPropagation();
    },
    [controller, updateSourceRegisterDrag]
  );

  const moveSurfaceMousePan = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const registerDrag = sourceRegisterDragRef.current;
      if (registerDrag && registerDrag.gesture.pointerId === null) {
        updateSourceRegisterDrag(event.clientX);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const drag = panDragRef.current;
      if (!drag || drag.pointerId !== null) return;
      const dx = event.clientX - drag.lastClientX;
      drag.lastClientX = event.clientX;
      if (dx !== 0) controller.panPixels(-dx);
      event.preventDefault();
      event.stopPropagation();
    },
    [controller, updateSourceRegisterDrag]
  );

  const endSurfacePan = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const registerDrag = sourceRegisterDragRef.current;
      if (registerDrag && registerDrag.gesture.pointerId === event.pointerId) {
        endSourceRegisterDrag(true);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const drag = panDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      panDragRef.current = null;
      drag.frame.dataset.linkedPanDragging = 'false';
      drag.frame.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [endSourceRegisterDrag]
  );

  const cancelSurfacePan = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const registerDrag = sourceRegisterDragRef.current;
      if (registerDrag && registerDrag.gesture.pointerId === event.pointerId) {
        endSourceRegisterDrag(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const drag = panDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      panDragRef.current = null;
      drag.frame.dataset.linkedPanDragging = 'false';
      drag.frame.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [endSourceRegisterDrag]
  );

  const endSurfaceMousePan = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const registerDrag = sourceRegisterDragRef.current;
      if (registerDrag && registerDrag.gesture.pointerId === null) {
        endSourceRegisterDrag(true);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const drag = panDragRef.current;
      if (!drag || drag.pointerId !== null) return;
      panDragRef.current = null;
      drag.frame.dataset.linkedPanDragging = 'false';
      event.preventDefault();
      event.stopPropagation();
    },
    [endSourceRegisterDrag]
  );

  return (
    <div
      ref={containerRef}
      data-testid="linked-camera-group"
      data-camera-bio-col={snapshot.cameraBioCol}
      data-shared-scroll-left={snapshot.sharedScrollLeft}
      data-linked-frame-count={snapshot.frameCount}
      data-linked-input-count={snapshot.inputEventCount}
      data-linked-zoom-percent={snapshot.zoomPercent}
      data-linked-px-per-base={snapshot.pxPerBase}
      data-linked-reference-total-width={snapshot.referenceTotalWidth}
      data-linked-max-shared-scroll-left={snapshot.maxSharedScrollLeft}
      data-linked-last-frame-ms={snapshot.lastFrameDurationMs}
      data-linked-max-frame-ms={snapshot.maxFrameDurationMs}
      data-linked-max-frame-interval-ms={snapshot.maxFrameIntervalMs}
      data-source-register-end-count={sourceRegisterEndCountRef.current}
      data-source-register-commit-handler-call-count={
        sourceRegisterCommitHandlerCallCountRef.current
      }
      className="min-w-0 max-w-full space-y-2 overflow-hidden"
    >
      {rows.map((row) => {
        const scrollLeft = snapshot.scrollLeftByRowId[row.id] ?? 0;
        return (
          <RegisteredSequenceSurface
            key={row.id}
            row={row}
            metric={rowMetrics[row.id]}
            scrollLeft={scrollLeft}
            zoomPercent={snapshot.zoomPercent}
            pxPerBase={snapshot.pxPerBase}
            editableFields={editableFields}
            primerSegments={primerLayoutsRef.current[row.id]?.segments ?? []}
            sourceRegisterPreviewRowKind={sourceRegisterPreviewRowKind}
            height={ROW_VIEWER_HEIGHT}
            screenXForBioCol={(bioCol) => controller.screenXForBioColInRow(row.id, bioCol)}
            onPrimerLayoutChange={updatePrimerLayout}
            onFieldPreview={onFieldPreview}
            onFieldPreviewImmediate={onFieldPreviewImmediate}
            onFieldCommit={onFieldCommit}
            onFieldCancel={onFieldCancel}
            onHandlePanRequest={(deltaPx) => controller.panPixels(deltaPx)}
            productControls={productControls}
            onPointerDownCapture={beginSurfacePan}
            onPointerMoveCapture={moveSurfacePan}
            onPointerUpCapture={endSurfacePan}
            onPointerCancelCapture={cancelSurfacePan}
            onMouseDownCapture={beginSurfaceMousePan}
            onMouseMoveCapture={moveSurfaceMousePan}
            onMouseUpCapture={endSurfaceMousePan}
          />
        );
      })}
      <LinkedCameraScrollbar
        totalWidth={snapshot.referenceTotalWidth}
        viewportWidth={snapshot.viewportWidth}
        scrollLeft={snapshot.sharedScrollLeft}
        onScrollChange={(next) => controller.scrollToSharedScrollLeft(next)}
      />
    </div>
  );
}

function sourceRegisterFieldForFrame(input: {
  frame: HTMLDivElement;
  rows: JunctionWorkbenchRow[];
  fields: AssemblyWorkbenchEditableField[];
}): AssemblyWorkbenchEditableField | null {
  const row = sourceRowForFrame(input.frame, input.rows);
  if (!row) return null;
  return sourceContributionBoundaryFieldForRow(row, input.fields);
}

function isSourceRowFrame(frame: HTMLDivElement, rows: JunctionWorkbenchRow[]): boolean {
  return sourceRowForFrame(frame, rows) !== null;
}

function sourceRowForFrame(
  frame: HTMLDivElement,
  rows: JunctionWorkbenchRow[]
): SourceRegisterRow | null {
  const rowId = frame.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
  if (!rowId) return null;
  const row = rows.find((item) => item.id === rowId);
  return row && isSourceRegisterRow(row) ? row : null;
}

function isSourceRegisterRow(row: JunctionWorkbenchRow): row is SourceRegisterRow {
  return row.kind === 'left-source' || row.kind === 'right-source';
}

function renderedValueForGesture(
  gesture: SourceRegisterGestureState,
  fields: AssemblyWorkbenchEditableField[]
): number {
  const renderedField = fields.find((field) => field.id === gesture.field.id);
  return typeof renderedField?.value === 'number' ? renderedField.value : gesture.renderedValue;
}

function isLinkedPanExcludedTarget(target: Element): boolean {
  return Boolean(
    target.closest(
      [
        '[data-linked-pan-exclude="true"]',
        '[data-testid="linked-camera-scrollbar"]',
        '[data-testid="linked-camera-scrollbar-thumb"]',
        'button',
        'input',
        'select',
        'textarea',
        'a',
      ].join(',')
    )
  );
}

function primerLayoutSignature(segments: RenderedPrimerSegment[]): string {
  return segments
    .map(
      (segment) =>
        `${segment.primerId}:${segment.role}:${round2(segment.x)}:${round2(segment.y)}:${round2(
          segment.width
        )}:${round2(segment.height)}`
    )
    .join('|');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function releasePointerCaptureIfHeld(frame: HTMLDivElement, pointerId: number | null): void {
  if (pointerId === null || !frame.releasePointerCapture) return;
  try {
    if (frame.hasPointerCapture && !frame.hasPointerCapture(pointerId)) return;
    frame.releasePointerCapture(pointerId);
  } catch {}
}

interface SourceRegisterContentPreview {
  offsetPx: number;
  activeRowKind: 'left-source' | 'right-source' | null;
}

function applySourceRegisterContentPreview(
  container: HTMLDivElement | null,
  preview: SourceRegisterContentPreview
): void {
  if (!container) return;
  const roundedOffsetPx = round2(preview.offsetPx);
  const transform = roundedOffsetPx === 0 ? '' : `translate3d(${roundedOffsetPx}px, 0px, 0px)`;
  const productOwner =
    preview.activeRowKind === 'left-source'
      ? 'left'
      : preview.activeRowKind === 'right-source'
        ? 'right'
        : null;
  container.dataset.sourceRegisterContentOffsetPx = String(roundedOffsetPx);
  container.dataset.sourceRegisterActiveRowKind = preview.activeRowKind ?? '';
  container
    .querySelectorAll<HTMLElement>('[data-linked-source-register-content-layer="true"]')
    .forEach((layer) => {
      const rowKind = layer.dataset.linkedSourceRegisterContentRowKind;
      const layerOffset = rowKind === preview.activeRowKind ? roundedOffsetPx : 0;
      layer.dataset.linkedSourceRegisterContentOffsetPx = String(layerOffset);
      layer.style.transform =
        rowKind === preview.activeRowKind && layerOffset !== 0
          ? `translate3d(${layerOffset}px, 0px, 0px)`
          : '';
    });
  container
    .querySelectorAll<HTMLElement>('[data-linked-source-register-product-owner-layer]')
    .forEach((layer) => {
      const owner = layer.dataset.linkedSourceRegisterProductOwnerLayer;
      const active = owner === productOwner && roundedOffsetPx !== 0;
      layer.dataset.linkedSourceRegisterProductOwnerActive = active ? 'true' : 'false';
      layer.dataset.linkedSourceRegisterProductOwnerOffsetPx = active
        ? String(roundedOffsetPx)
        : '0';
      layer.style.opacity = active ? '1' : '';
      const content = layer.querySelector<HTMLElement>(
        '[data-linked-source-register-product-owner-content="true"]'
      );
      if (content) content.style.transform = active ? transform : '';
    });
}

function LinkedCameraScrollbar({
  totalWidth,
  viewportWidth,
  scrollLeft,
  onScrollChange,
}: {
  totalWidth: number;
  viewportWidth: number;
  scrollLeft: number;
  onScrollChange: (scrollLeft: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startClientX: number;
    startScrollLeft: number;
    trackWidth: number;
  } | null>(null);
  const needsScrollbar = totalWidth > viewportWidth + 1 && viewportWidth > 0;
  const trackWidth = trackRef.current?.clientWidth ?? viewportWidth;
  const maxScroll = Math.max(0, totalWidth - viewportWidth);
  const thumbWidth = needsScrollbar
    ? Math.max(24, Math.floor(trackWidth * (viewportWidth / totalWidth)))
    : trackWidth;
  const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
  const thumbLeft = maxScroll > 0 ? Math.round((scrollLeft / maxScroll) * maxThumbLeft) : 0;

  const onThumbPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!trackRef.current) return;
      dragRef.current = {
        startClientX: event.clientX,
        startScrollLeft: scrollLeft,
        trackWidth: trackRef.current.clientWidth,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    [scrollLeft]
  );

  const onThumbPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const localMaxThumbLeft = Math.max(0, drag.trackWidth - thumbWidth);
      if (localMaxThumbLeft <= 0) return;
      const dxScroll = ((event.clientX - drag.startClientX) / localMaxThumbLeft) * maxScroll;
      onScrollChange(drag.startScrollLeft + dxScroll);
    },
    [maxScroll, onScrollChange, thumbWidth]
  );

  const onThumbPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const onTrackPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!trackRef.current || !needsScrollbar || event.target !== trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const direction = localX < thumbLeft ? -1 : 1;
      onScrollChange(scrollLeft + direction * viewportWidth);
    },
    [needsScrollbar, onScrollChange, scrollLeft, thumbLeft, viewportWidth]
  );

  if (!needsScrollbar) return null;

  return (
    <div className="grid min-w-0 max-w-full grid-cols-[9.5rem_minmax(0,1fr)] gap-2">
      <div aria-hidden="true" />
      <div
        ref={trackRef}
        data-testid="linked-camera-scrollbar"
        onPointerDown={onTrackPointerDown}
        className="relative h-3 min-w-0 rounded-full bg-black/10"
      >
        <div
          data-testid="linked-camera-scrollbar-thumb"
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          onPointerCancel={onThumbPointerUp}
          className="absolute top-0 h-3 cursor-grab rounded-full bg-black/35"
          style={{ left: thumbLeft, width: thumbWidth, touchAction: 'none' }}
        />
      </div>
    </div>
  );
}

function measureViewportWidth(container: HTMLDivElement): number {
  const firstViewer = container.querySelector('[data-testid="sequence-viewer-1d"]');
  return firstViewer instanceof HTMLElement ? firstViewer.clientWidth : container.clientWidth;
}
