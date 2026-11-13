import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  compute1DLayout,
  DEFAULT_EDITOR_CONFIG,
  SequenceViewer1D,
  type PrimerDisplay,
  type RenderedPrimerSegment,
  type SequenceExtraLane,
} from '@waypoint/workspace-editor';
import { reverseComplement, type Annotation } from '@waypoint/sequence-utils';
import type {
  AssemblyWorkbenchEditableField,
  AssemblyWorkbenchLiveFieldPreview,
  AssemblyWorkbenchLivePrimerTemperature,
} from './AssemblyWorkbenchContract';
import { estimateTm } from '../design/public/algorithms/draft-assembly';
import { createAppTmCalculator } from './settings';
import { projectFieldHandlesForRow } from './JunctionFieldHandleProjection';
import {
  hasAnyEnabledSourceContributionBoundaryField,
  isSourceContributionBoundaryField,
  sourceContributionBoundaryFieldById,
  sourceContributionBoundaryFieldForRow,
  sourceRegisterDragCapabilityForProductOwner,
  sourceRegisterDragCapabilityForSourceRow,
} from './AssemblyWorkbenchInteractionCapabilities';
import { JunctionAssemblyHighlightOverlay } from './JunctionAssemblyHighlightOverlay';
import type {
  JunctionAssemblyHighlightCursor,
  JunctionAssemblyHighlightSegment,
} from './JunctionAssemblyHighlightOverlay';
import { JunctionHandleOverlay, type JunctionFieldHandle } from './JunctionHandleOverlay';
import {
  applyProductOverlapLivePreview,
  clearProductOverlapLivePreview,
} from './ProductOverlapPreviewContract';
import {
  goldenGateOverhangLivePreviewForProductRow,
  goldenGateOverhangLivePrimersForRow,
} from './GoldenGateOverhangLivePreviewContract';
import {
  homologyOverlapLivePreviewForProductRow,
  homologyOverlapLivePrimersForRow,
  type HomologyOverlapLivePreview,
} from './HomologyOverlapLivePreviewContract';
import type { JunctionWorkbenchRow } from './model';
import { JUNCTION_WORKBENCH_HORIZONTAL_PADDING } from './coord-mapping';
import { SOURCE_ROW_BUFFER_BP } from './registered-window';
import {
  beginSourceRegisterGesture,
  cancelSourceRegisterGesture,
  updateSourceRegisterGesture,
  updateSourceRegisterRenderedValue,
  type SourceRegisterGestureState,
} from './registered-viewport';
import type { JunctionRowMetric } from './RegisteredSequenceSurface';
import {
  NON_CONTRIBUTING_BACKGROUND_COLOR,
  NON_CONTRIBUTING_COLOR,
  FALLBACK_LEFT_SOURCE_COLOR,
  FALLBACK_RIGHT_SOURCE_COLOR,
  buildProductOwnerPreviewSequence,
  colorWash,
  primersForRow,
  productOwnerColor,
  productOwnerForPoint,
  provenanceForRow,
  rowToSequence,
  type WorkbenchPaintOwner,
} from './WorkbenchPaintingContract';
import {
  WorkbenchPrimerOverlay,
  type WorkbenchPrimerOverlayHandle,
} from './WorkbenchPrimerOverlay';

const ROW_VIEWER_HEIGHT = 132;
const REGISTERED_ASSEMBLY_ZOOM_PERCENT = 100;
const GIBSON_VIRTUAL_CUT_STROKE_WIDTH = 3;

type SourceRegisterRow = JunctionWorkbenchRow & { kind: 'left-source' | 'right-source' };

export type JunctionRowMetricsByRowId = Record<string, JunctionRowMetric>;

interface PrimerLayoutCacheEntry {
  signature: string;
  segments: RenderedPrimerSegment[];
}

interface GoldenGateOptimizerPreviewChoice {
  junctionIndex: number;
  offset: number;
  overhang: string;
}

interface RegisteredAssemblyViewportProps {
  rows: JunctionWorkbenchRow[];
  editableFields?: AssemblyWorkbenchEditableField[];
  rowMetrics?: JunctionRowMetricsByRowId;
  goldenGateOptimizerPreviewChoice?: GoldenGateOptimizerPreviewChoice;
  onFieldPreview?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldCommit?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldCancel?: () => void;
  onFieldLivePreview?: (
    field: AssemblyWorkbenchEditableField,
    preview: AssemblyWorkbenchLiveFieldPreview
  ) => void;
  onFieldLivePreviewEnd?: () => void;
  productControls?: ReactNode;
  defaultSourceRowsVisible?: boolean;
  onSourceDragOverride?: (
    override: { rowKind: 'left-source' | 'right-source'; offsetBp: number } | null
  ) => void;
  pcrPolymerase?: string | null;
}

export function RegisteredAssemblyViewport({
  rows,
  editableFields = [],
  rowMetrics = {},
  goldenGateOptimizerPreviewChoice,
  onFieldPreview,
  onFieldCommit,
  onFieldCancel,
  onFieldLivePreview,
  onFieldLivePreviewEnd,
  productControls,
  defaultSourceRowsVisible = false,
  onSourceDragOverride,
  pcrPolymerase = null,
}: RegisteredAssemblyViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const primerLayoutsRef = useRef<Record<string, PrimerLayoutCacheEntry>>({});
  const sourceRegisterDragRef = useRef<{
    gesture: SourceRegisterGestureState;
    activeRowKind: 'left-source' | 'right-source';
    frame: HTMLDivElement;
    primerSource: SourceRegisterDragPrimerSource | null;
  } | null>(null);
  const sourceRegisterEndCountRef = useRef(0);
  const sourceRegisterCommitHandlerCallCountRef = useRef(0);
  const bodyCursorBeforeSourceRegisterDragRef = useRef<string | null>(null);
  const sourceRegisterContentPreviewRef = useRef<RegisteredSourceContentPreview>({
    offsetPx: 0,
    productOwnerOffsetPx: 0,
    activeRowKind: null,
  });
  const onFieldPreviewRef = useRef(onFieldPreview);
  onFieldPreviewRef.current = onFieldPreview;
  const pcrPolymeraseRef = useRef(pcrPolymerase);
  pcrPolymeraseRef.current = pcrPolymerase;
  const onFieldLivePreviewRef = useRef(onFieldLivePreview);
  onFieldLivePreviewRef.current = onFieldLivePreview;
  const onFieldLivePreviewEndRef = useRef(onFieldLivePreviewEnd);
  onFieldLivePreviewEndRef.current = onFieldLivePreviewEnd;
  const onSourceDragOverrideRef = useRef(onSourceDragOverride);
  onSourceDragOverrideRef.current = onSourceDragOverride;
  const overlayHandlesRef = useRef<Map<string, WorkbenchPrimerOverlayHandle>>(new Map());
  const registerOverlayHandle = useCallback(
    (rowId: string, handle: WorkbenchPrimerOverlayHandle | null) => {
      if (handle) overlayHandlesRef.current.set(rowId, handle);
      else overlayHandlesRef.current.delete(rowId);
    },
    []
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [viewportWidth, setViewportWidth] = useState(0);
  const [sourceRowsVisible, setSourceRowsVisible] = useState(defaultSourceRowsVisible);
  const crossoverEditingAvailable = hasAnyEnabledSourceContributionBoundaryField(editableFields);
  const previousCrossoverEditingAvailableRef = useRef(crossoverEditingAvailable);
  const [activeProductPreviewOwner, setActiveProductPreviewOwner] = useState<
    'left' | 'right' | null
  >(null);
  const [sideScrollOffset, setSideScrollOffset] = useState(0);
  const [, setPrimerLayoutRevision] = useState(0);

  const pxPerBase = DEFAULT_EDITOR_CONFIG.charWidth;
  const centerX = viewportWidth / 2;
  const productPreviewRows = sourcePreviewRowsByOwner(rows);
  const renderedRows = sourceRowsVisible ? rows : rows.filter((row) => row.kind === 'product');
  const referenceRow = registeredReferenceRow(renderedRows);
  const focusBioCol = viewportFocusBioColForRows(rows);
  const viewportResetKey = rows
    .map(
      (row) =>
        `${row.id}:${row.sequence.length}:${row.viewportFocusBioCol ?? 0}:${
          row.viewportFocusRowPosition ?? row.anchorRowPosition
        }`
    )
    .join('|');
  const clampedSideScrollOffset = clampSideScrollOffset(
    sideScrollOffset,
    renderedRows,
    centerX,
    pxPerBase,
    viewportWidth
  );

  useEffect(() => {
    setSideScrollOffset(0);
  }, [viewportResetKey]);

  useEffect(() => {
    if (previousCrossoverEditingAvailableRef.current && !crossoverEditingAvailable) {
      setSourceRowsVisible(false);
    }
    previousCrossoverEditingAvailableRef.current = crossoverEditingAvailable;
  }, [crossoverEditingAvailable]);

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

  const clearPrimerHandleLivePreview = useCallback(() => {
    overlayHandlesRef.current.forEach((handle) => handle.applyLiveOverride(null));
  }, []);

  const handleSideScroll = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (event.metaKey || event.ctrlKey) return;
      const delta = event.deltaX;
      if (delta === 0) return;
      const nextRows = sourceRowsVisible
        ? rowsRef.current
        : rowsRef.current.filter((row) => row.kind === 'product');
      const next = clampSideScrollOffset(
        sideScrollOffset + delta,
        nextRows,
        centerX,
        pxPerBase,
        viewportWidth
      );
      if (Math.abs(next - sideScrollOffset) < 0.5) return;
      event.preventDefault();
      event.stopPropagation();
      setSideScrollOffset(next);
    },
    [centerX, pxPerBase, sideScrollOffset, sourceRowsVisible, viewportWidth]
  );

  const panByPixels = useCallback(
    (deltaPx: number) => {
      if (!Number.isFinite(deltaPx) || deltaPx === 0) return;
      const panRows = sourceRowsVisible
        ? rowsRef.current
        : rowsRef.current.filter((row) => row.kind === 'product');
      setSideScrollOffset((current) =>
        clampSideScrollOffset(
          clampSideScrollOffset(current, panRows, centerX, pxPerBase, viewportWidth) + deltaPx,
          panRows,
          centerX,
          pxPerBase,
          viewportWidth
        )
      );
    },
    [centerX, pxPerBase, sourceRowsVisible, viewportWidth]
  );

  const applyPrimerHandleLivePreview = useCallback(
    (handle: JunctionFieldHandle, nextValue: number): AssemblyWorkbenchLiveFieldPreview | null => {
      const field = handle.field;
      if (field.kind === 'goldenGateOverhang') {
        const productRow = rowsRef.current.find((row) => row.kind === 'product');
        if (!productRow) return null;
        const preview = goldenGateOverhangLivePreviewForProductRow(productRow, field, nextValue);
        if (!preview) return null;
        let productLivePrimers: PrimerDisplay[] | null = null;
        for (const row of rowsRef.current) {
          const livePrimers = goldenGateOverhangLivePrimersForRow(
            row,
            preview,
            field.target.junctionIndex
          );
          if (livePrimers) {
            if (row.kind === 'product') productLivePrimers = livePrimers;
            overlayHandlesRef.current.get(row.id)?.applyLiveOverride(livePrimers);
          }
        }
        return {
          value: nextValue,
          primerTms: productLivePrimers
            ? primerTemperaturePayload(productLivePrimers, field, pcrPolymeraseRef.current)
            : undefined,
        };
      }
      if (field.kind === 'homologyArm') {
        const productRow = rowsRef.current.find((row) => row.kind === 'product');
        if (!productRow) return null;
        const preview = homologyOverlapLivePreviewForProductRow(productRow, field, nextValue);
        if (!preview) return null;
        let productLivePrimers: PrimerDisplay[] | null = null;
        for (const row of rowsRef.current) {
          const livePrimers = homologyOverlapLivePrimersForRow(
            row,
            preview,
            field.target.junctionIndex
          );
          if (livePrimers) {
            if (row.kind === 'product') productLivePrimers = livePrimers;
            overlayHandlesRef.current.get(row.id)?.applyLiveOverride(livePrimers);
          }
        }
        return {
          value: nextValue,
          homologyTm: homologyTemperaturePayload(preview, field),
          primerTms: productLivePrimers
            ? primerTemperaturePayload(productLivePrimers, field, pcrPolymeraseRef.current)
            : undefined,
        };
      }
      if (field.kind !== 'primerPbs' && field.kind !== 'primerTail') return null;
      let productLivePrimers: PrimerDisplay[] | null = null;
      for (const row of rowsRef.current) {
        const primers = row.primers ?? [];
        if (primers.length === 0) continue;
        const livePrimers = primers.map((primer) =>
          livePrimerForFieldValue(row.sequence, primer, field, nextValue)
        );
        if (row.kind === 'product') productLivePrimers = livePrimers;
        overlayHandlesRef.current.get(row.id)?.applyLiveOverride(livePrimers);
      }
      return {
        value: nextValue,
        primerTms: productLivePrimers
          ? primerTemperaturePayload(productLivePrimers, field, pcrPolymeraseRef.current)
          : undefined,
      };
    },
    []
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setViewportWidth(measureRegisteredViewportWidth(el));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const drag = sourceRegisterDragRef.current;
    if (drag) {
      const renderedValue = renderedValueForGesture(drag.gesture, editableFields);
      drag.gesture = updateSourceRegisterRenderedValue(drag.gesture, renderedValue);
      const offsetPx =
        (drag.gesture.startValue - drag.gesture.latestValue) * drag.gesture.pxPerBase;
      sourceRegisterContentPreviewRef.current = {
        offsetPx,
        productOwnerOffsetPx: productOwnerOffsetPxForGesture(drag.gesture),
        activeRowKind: drag.activeRowKind,
      };
      drag.frame.dataset.registeredSourceRegisterRenderedValue = String(drag.gesture.renderedValue);
      drag.frame.dataset.registeredSourceRegisterPresentationOffsetPx = String(round2(offsetPx));
    } else {
      syncIdleSourceRegisterProbeState(containerRef.current, rows, editableFields);
    }
    applyRegisteredSourceDragPreview(containerRef.current, sourceRegisterContentPreviewRef.current);
  });

  const beginSourceRegisterDrag = useCallback(
    (
      field: AssemblyWorkbenchEditableField,
      activeRow: SourceRegisterRow,
      pointerId: number | null,
      clientX: number,
      frame: HTMLDivElement
    ) => {
      const gesture = beginSourceRegisterGesture({
        field,
        pointerId,
        startClientX: clientX,
        pxPerBase,
      });
      sourceRegisterDragRef.current = {
        gesture,
        activeRowKind: activeRow.kind,
        frame,
        primerSource: sourceRegisterDragPrimerSource(activeRow, field),
      };
      sourceRegisterContentPreviewRef.current = {
        offsetPx: 0,
        productOwnerOffsetPx: 0,
        activeRowKind: activeRow.kind,
      };
      setActiveProductPreviewOwner(activeRow.kind === 'left-source' ? 'left' : 'right');
      applyRegisteredSourceDragPreview(
        containerRef.current,
        sourceRegisterContentPreviewRef.current
      );
      frame.dataset.registeredSourceRegisterDragging = 'true';
      frame.dataset.registeredSourceRegisterFieldId = gesture.field.id;
      frame.dataset.registeredSourceRegisterValue = String(gesture.latestValue);
      frame.dataset.registeredSourceRegisterRenderedValue = String(gesture.renderedValue);
      frame.dataset.registeredSourceRegisterMoveCount = '0';
      frame.dataset.registeredSourceRegisterVisualOffsetPx = '0';
      frame.dataset.registeredSourceRegisterPresentationOffsetPx = '0';
      frame.style.cursor = 'ew-resize';
      bodyCursorBeforeSourceRegisterDragRef.current = document.body.style.cursor;
      document.body.style.cursor = 'ew-resize';
    },
    [pxPerBase]
  );

  const updateSourceRegisterDrag = useCallback((clientX: number) => {
    const drag = sourceRegisterDragRef.current;
    if (!drag) return;
    const update = updateSourceRegisterGesture(drag.gesture, clientX);
    drag.gesture = update.state;
    const visualDx = drag.gesture.visualOffsetPx;
    const snappedDx = (drag.gesture.startValue - drag.gesture.latestValue) * drag.gesture.pxPerBase;
    sourceRegisterContentPreviewRef.current = {
      offsetPx: snappedDx,
      productOwnerOffsetPx: productOwnerOffsetPxForGesture(drag.gesture),
      activeRowKind: drag.activeRowKind,
    };
    drag.frame.dataset.registeredSourceRegisterMoveCount = String(drag.gesture.moveCount);
    drag.frame.dataset.registeredSourceRegisterDeltaPx = String(-visualDx);
    drag.frame.dataset.registeredSourceRegisterPxPerBase = String(drag.gesture.pxPerBase);
    drag.frame.dataset.registeredSourceRegisterVisualOffsetPx = String(visualDx);
    drag.frame.dataset.registeredSourceRegisterRenderedValue = String(drag.gesture.renderedValue);
    drag.frame.dataset.registeredSourceRegisterPresentationOffsetPx = String(round2(snappedDx));
    applyRegisteredSourceDragPreview(containerRef.current, sourceRegisterContentPreviewRef.current);
    if (!update.snappedValueChanged) return;
    drag.frame.dataset.registeredSourceRegisterValue = String(drag.gesture.latestValue);
    const delta = drag.gesture.latestValue - drag.gesture.startValue;
    onSourceDragOverrideRef.current?.({ rowKind: drag.activeRowKind, offsetBp: delta });
    const activeRow = rowsRef.current.find((r) => r.kind === drag.activeRowKind);
    if (!activeRow || !drag.primerSource) return;
    const { sequence: activeSeq, pbsAnchor, sourceBoundaryAnchor } = drag.primerSource;
    const updateRowOverlay = (row: JunctionWorkbenchRow) => {
      const rowPrimers = row.primers ?? [];
      if (rowPrimers.length === 0) return;
      const livePrimers = computeDragLivePrimers(
        rowPrimers,
        activeSeq,
        pbsAnchor,
        sourceBoundaryAnchor,
        delta,
        drag.activeRowKind
      );
      overlayHandlesRef.current.get(row.id)?.applyLiveOverride(livePrimers);
    };
    updateRowOverlay(activeRow);
    const partnerKind: 'left-source' | 'right-source' =
      drag.activeRowKind === 'left-source' ? 'right-source' : 'left-source';
    const partnerRow = rowsRef.current.find((r) => r.kind === partnerKind);
    if (partnerRow) updateRowOverlay(partnerRow);
    const productRow = rowsRef.current.find((r) => r.kind === 'product');
    if (productRow) {
      const productLivePrimers = livePrimersForSourceRegisterDragProductRow(
        productRow,
        activeSeq,
        pbsAnchor,
        sourceBoundaryAnchor,
        delta,
        drag.activeRowKind
      );
      overlayHandlesRef.current.get(productRow.id)?.applyLiveOverride(productLivePrimers);
      onFieldLivePreviewRef.current?.(drag.gesture.field, {
        value: drag.gesture.latestValue,
        primerTms: primerTemperaturePayload(
          productLivePrimers,
          drag.gesture.field,
          pcrPolymeraseRef.current
        ),
      });
    }
  }, []);

  const endSourceRegisterDrag = useCallback(
    (commit: boolean) => {
      const drag = sourceRegisterDragRef.current;
      if (!drag) return;
      overlayHandlesRef.current.forEach((handle) => handle.applyLiveOverride(null));
      onSourceDragOverrideRef.current?.(null);
      sourceRegisterDragRef.current = null;
      const finalGesture = commit ? drag.gesture : cancelSourceRegisterGesture(drag.gesture);
      sourceRegisterEndCountRef.current += 1;
      if (containerRef.current) {
        containerRef.current.dataset.registeredSourceRegisterEndCount = String(
          sourceRegisterEndCountRef.current
        );
        containerRef.current.dataset.registeredSourceRegisterLastEndFieldId = finalGesture.field.id;
        containerRef.current.dataset.registeredSourceRegisterLastEndValue = String(
          finalGesture.latestValue
        );
        containerRef.current.dataset.registeredSourceRegisterLastEndCommit = commit
          ? 'true'
          : 'false';
        containerRef.current.dataset.registeredSourceRegisterLastEndHasCommitHandler = onFieldCommit
          ? 'true'
          : 'false';
      }
      drag.frame.dataset.registeredSourceRegisterDragging = 'false';
      drag.frame.dataset.registeredSourceRegisterVisualOffsetPx = '0';
      drag.frame.dataset.registeredSourceRegisterPresentationOffsetPx = '0';
      drag.frame.style.cursor = '';
      if (bodyCursorBeforeSourceRegisterDragRef.current !== null) {
        document.body.style.cursor = bodyCursorBeforeSourceRegisterDragRef.current;
        bodyCursorBeforeSourceRegisterDragRef.current = null;
      }
      sourceRegisterContentPreviewRef.current = {
        offsetPx: 0,
        productOwnerOffsetPx: 0,
        activeRowKind: null,
      };
      setActiveProductPreviewOwner(null);
      applyRegisteredSourceDragPreview(
        containerRef.current,
        sourceRegisterContentPreviewRef.current
      );
      if (commit) {
        sourceRegisterCommitHandlerCallCountRef.current += 1;
        if (containerRef.current) {
          containerRef.current.dataset.registeredSourceRegisterCommitHandlerCallCount = String(
            sourceRegisterCommitHandlerCallCountRef.current
          );
          containerRef.current.dataset.registeredSourceRegisterCommitHandlerLastFieldId =
            finalGesture.field.id;
          containerRef.current.dataset.registeredSourceRegisterCommitHandlerLastValue = String(
            finalGesture.latestValue
          );
        }
        onFieldCommit?.(finalGesture.field, finalGesture.latestValue);
      } else onFieldCancel?.();
      onFieldLivePreviewEndRef.current?.();
      releasePointerCaptureIfHeld(drag.frame, drag.gesture.pointerId);
    },
    [onFieldCancel, onFieldCommit]
  );

  const beginSourceSurfaceDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!sourceRowsVisible) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.button > 0 || !target || isRegisteredDragExcludedTarget(target)) return;
      const targetRegister = sourceRegisterTargetForFrame({
        frame: event.currentTarget,
        rows,
        fields: editableFields,
        clientX: event.clientX,
        pxPerBase,
      });
      if (!targetRegister) return;
      beginSourceRegisterDrag(
        targetRegister.field,
        targetRegister.activeRow,
        event.pointerId,
        event.clientX,
        event.currentTarget
      );
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [beginSourceRegisterDrag, editableFields, pxPerBase, rows, sourceRowsVisible]
  );

  const beginSourceSurfaceMouseDrag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!sourceRowsVisible) return;
      if (sourceRegisterDragRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.button > 0 || !target || isRegisteredDragExcludedTarget(target)) return;
      const targetRegister = sourceRegisterTargetForFrame({
        frame: event.currentTarget,
        rows,
        fields: editableFields,
        clientX: event.clientX,
        pxPerBase,
      });
      if (!targetRegister) return;
      beginSourceRegisterDrag(
        targetRegister.field,
        targetRegister.activeRow,
        null,
        event.clientX,
        event.currentTarget
      );
      event.preventDefault();
      event.stopPropagation();
    },
    [beginSourceRegisterDrag, editableFields, pxPerBase, rows, sourceRowsVisible]
  );

  const moveSourceSurfaceDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = sourceRegisterDragRef.current;
      if (!drag || drag.gesture.pointerId !== event.pointerId) return;
      updateSourceRegisterDrag(event.clientX);
      event.preventDefault();
      event.stopPropagation();
    },
    [updateSourceRegisterDrag]
  );

  const moveSourceSurfaceMouseDrag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const drag = sourceRegisterDragRef.current;
      if (!drag || drag.gesture.pointerId !== null) return;
      updateSourceRegisterDrag(event.clientX);
      event.preventDefault();
      event.stopPropagation();
    },
    [updateSourceRegisterDrag]
  );

  const endSourceSurfaceDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = sourceRegisterDragRef.current;
      if (!drag || drag.gesture.pointerId !== event.pointerId) return;
      updateSourceRegisterDrag(event.clientX);
      endSourceRegisterDrag(true);
      event.preventDefault();
      event.stopPropagation();
    },
    [endSourceRegisterDrag, updateSourceRegisterDrag]
  );

  const cancelSourceSurfaceDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = sourceRegisterDragRef.current;
      if (!drag || drag.gesture.pointerId !== event.pointerId) return;
      endSourceRegisterDrag(false);
      event.preventDefault();
      event.stopPropagation();
    },
    [endSourceRegisterDrag]
  );

  const endSourceSurfaceMouseDrag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const drag = sourceRegisterDragRef.current;
      if (!drag || drag.gesture.pointerId !== null) return;
      updateSourceRegisterDrag(event.clientX);
      endSourceRegisterDrag(true);
      event.preventDefault();
      event.stopPropagation();
    },
    [endSourceRegisterDrag, updateSourceRegisterDrag]
  );

  return (
    <div
      ref={containerRef}
      data-testid="registered-assembly-viewport"
      data-registered-scroll-authority="fixed-crossover"
      data-registered-camera-bio-col={focusBioCol}
      data-registered-center-x={centerX}
      data-registered-viewport-width={viewportWidth}
      data-registered-zoom-percent={REGISTERED_ASSEMBLY_ZOOM_PERCENT}
      data-registered-px-per-base={pxPerBase}
      data-registered-side-scroll-offset={clampedSideScrollOffset}
      data-registered-source-register-end-count={sourceRegisterEndCountRef.current}
      data-registered-source-register-commit-handler-call-count={
        sourceRegisterCommitHandlerCallCountRef.current
      }
      data-registered-source-rows-visible={sourceRowsVisible ? 'true' : 'false'}
      data-assembly-horizontal-scroll="true"
      className="min-w-0 max-w-full space-y-2 overflow-hidden"
      onWheel={handleSideScroll}
    >
      {renderedRows.map((row) => {
        const referenceScrollLeft = referenceRow
          ? scrollLeftForCenteredFocus(
              referenceRow,
              centerX,
              pxPerBase,
              viewportWidth,
              clampedSideScrollOffset
            )
          : 0;
        const scrollLeft = referenceRow
          ? scrollLeftForRegisteredRow(row, referenceRow, referenceScrollLeft, pxPerBase)
          : scrollLeftForCenteredFocus(
              row,
              centerX,
              pxPerBase,
              viewportWidth,
              clampedSideScrollOffset
            );
        const rowHeight = registeredAssemblyRowHeight(row, pxPerBase, productPreviewRows);
        return (
          <RegisteredAssemblySurface
            key={row.id}
            row={row}
            metric={rowMetrics[row.id]}
            scrollLeft={scrollLeft}
            zoomPercent={REGISTERED_ASSEMBLY_ZOOM_PERCENT}
            pxPerBase={pxPerBase}
            editableFields={editableFields}
            goldenGateOptimizerPreviewChoice={goldenGateOptimizerPreviewChoice}
            primerSegments={primerLayoutsRef.current[row.id]?.segments ?? []}
            productPreviewRows={productPreviewRows}
            activeProductPreviewOwner={activeProductPreviewOwner}
            crossoverEditEnabled={sourceRowsVisible}
            height={rowHeight}
            screenXForBioCol={(bioCol) => worldXForBioCol(row, bioCol, pxPerBase)}
            registerOverlayHandle={registerOverlayHandle}
            onPrimerLayoutChange={updatePrimerLayout}
            onFieldPreview={onFieldPreview}
            onFieldCommit={onFieldCommit}
            onFieldCancel={onFieldCancel}
            onFieldLivePreview={onFieldLivePreview}
            onFieldLivePreviewEnd={onFieldLivePreviewEnd}
            productControls={productControls}
            sourceRowsToggle={
              row.kind === 'product' && crossoverEditingAvailable ? (
                <button
                  type="button"
                  data-testid="registered-assembly-source-rows-toggle"
                  aria-expanded={sourceRowsVisible}
                  title={
                    sourceRowsVisible
                      ? 'Hide source rows (crossover editing off)'
                      : 'Show source rows to drag and move the crossover point'
                  }
                  onClick={() => setSourceRowsVisible((visible) => !visible)}
                  className="mt-0.5 h-4 w-full rounded-[3px] border border-border/70 bg-bg-muted px-1 text-[8px] font-medium leading-3 text-fg hover:bg-bg-emphasis"
                >
                  {sourceRowsVisible ? 'Done' : 'Edit Crossover'}
                </button>
              ) : null
            }
            onHandleLivePreview={applyPrimerHandleLivePreview}
            onHandleLivePreviewEnd={clearPrimerHandleLivePreview}
            onHandlePanRequest={panByPixels}
            onPointerDownCapture={beginSourceSurfaceDrag}
            onPointerMoveCapture={moveSourceSurfaceDrag}
            onPointerUpCapture={endSourceSurfaceDrag}
            onPointerCancelCapture={cancelSourceSurfaceDrag}
            onMouseDownCapture={beginSourceSurfaceMouseDrag}
            onMouseMoveCapture={moveSourceSurfaceMouseDrag}
            onMouseUpCapture={endSourceSurfaceMouseDrag}
          />
        );
      })}
    </div>
  );
}

function registeredReferenceRow(rows: JunctionWorkbenchRow[]): JunctionWorkbenchRow | null {
  return rows.find((row) => row.kind === 'product') ?? rows[0] ?? null;
}

function scrollLeftForRegisteredRow(
  row: JunctionWorkbenchRow,
  referenceRow: JunctionWorkbenchRow,
  referenceScrollLeft: number,
  pxPerBase: number
): number {
  return referenceScrollLeft + (row.anchorRowPosition - referenceRow.anchorRowPosition) * pxPerBase;
}

function computeDragLivePrimers(
  primers: readonly PrimerDisplay[],
  activeSeq: string,
  pbsAnchor: number,
  sourceBoundaryAnchor: number,
  delta: number,
  activeRowKind: 'left-source' | 'right-source'
): PrimerDisplay[] {
  if (delta === 0 || primers.length === 0) return primers.map((p) => p);
  return primers.map((primer) => {
    if (isGoldenGatePrimer(primer)) {
      const withActivePbs = isPrimerOnActiveDragSide(primer, activeRowKind)
        ? shiftActivePbsFromActiveSeq(primer, activeSeq, pbsAnchor, delta, activeRowKind)
        : primer;
      return shiftGoldenGate4bpFromActiveSeq(
        withActivePbs,
        activeSeq,
        sourceBoundaryAnchor,
        delta,
        activeRowKind
      );
    }
    if (isPrimerOnActiveDragSide(primer, activeRowKind)) {
      return shiftActivePbsFromActiveSeq(primer, activeSeq, pbsAnchor, delta, activeRowKind);
    }
    if (isPrimerOnOpposingDragSide(primer, activeRowKind)) {
      return shiftOpposingOverhangFromActiveSeq(
        primer,
        activeSeq,
        sourceBoundaryAnchor,
        delta,
        activeRowKind
      );
    }
    return primer;
  });
}

function livePrimersForSourceRegisterDragProductRow(
  productRow: JunctionWorkbenchRow,
  activeSeq: string,
  pbsAnchor: number,
  sourceBoundaryAnchor: number,
  delta: number,
  activeRowKind: 'left-source' | 'right-source'
): PrimerDisplay[] {
  return computeDragLivePrimers(
    productRow.primers ?? [],
    activeSeq,
    pbsAnchor,
    sourceBoundaryAnchor,
    delta,
    activeRowKind
  );
}

export function primerTemperaturePayload(
  primers: readonly PrimerDisplay[],
  field: AssemblyWorkbenchEditableField,
  polymerase?: string | null
): AssemblyWorkbenchLivePrimerTemperature[] {
  return primers
    .filter((primer) => liveTemperaturePrimerMatchesField(primer, field))
    .map((primer) => ({
      primerId: primer.id,
      sourcePrimerId: primer.sourcePrimerId,
      fragmentIndex: primerFragmentIndex(primer),
      direction: primer.direction,
      tm: estimatePrimerPbsTm(primer, polymerase),
    }));
}

function liveTemperaturePrimerMatchesField(
  primer: PrimerDisplay,
  field: AssemblyWorkbenchEditableField
): boolean {
  if (isSourceContributionBoundaryField(field)) return true;
  if (field.kind === 'homologyArm' || field.kind === 'goldenGateOverhang') {
    return (
      field.target.junctionIndex === undefined ||
      primer.junctionIndex === undefined ||
      primer.junctionIndex === field.target.junctionIndex
    );
  }
  return primerMatchesField(primer, field);
}

function primerFragmentIndex(primer: PrimerDisplay): number | undefined {
  const maybePrimer = primer as PrimerDisplay & { fragmentIndex?: number };
  return typeof maybePrimer.fragmentIndex === 'number' ? maybePrimer.fragmentIndex : undefined;
}

function estimatePrimerPbsTm(primer: PrimerDisplay, polymerase?: string | null): number | null {
  const overhangLength = Math.max(0, Math.min(primer.bases.length, primer.overhangLength ?? 0));
  const pbsBases = primer.bases.slice(overhangLength);
  if (pbsBases.length === 0) return null;
  return createAppTmCalculator(polymerase).estimate(pbsBases);
}

function homologyTemperaturePayload(
  preview: HomologyOverlapLivePreview,
  field: AssemblyWorkbenchEditableField
): AssemblyWorkbenchLiveFieldPreview['homologyTm'] {
  const start = preview.productAnchorRowPosition + preview.startBioCol;
  const end = preview.productAnchorRowPosition + preview.endBioCol;
  const sequence =
    start >= 0 && end >= start && end <= preview.productSequence.length
      ? preview.productSequence.slice(start, end)
      : '';
  return {
    junctionIndex: field.target.junctionIndex ?? 0,
    tm: sequence.length > 0 ? estimateTm(sequence) : null,
  };
}

function isGoldenGatePrimer(primer: PrimerDisplay): boolean {
  const cut = primer.cutPositionInOverhang;
  const overhang = primer.overhangLength ?? 0;
  return (
    typeof cut === 'number' &&
    Number.isFinite(cut) &&
    cut >= 0 &&
    overhang >= cut + 4 &&
    primer.bases.length >= cut + 4
  );
}

function shiftGoldenGate4bpFromActiveSeq(
  primer: PrimerDisplay,
  activeSeq: string,
  sourceBoundaryAnchor: number,
  delta: number,
  activeRowKind: 'left-source' | 'right-source'
): PrimerDisplay {
  const cut = primer.cutPositionInOverhang;
  if (cut === undefined) return primer;
  const activeLength = goldenGateActive4bpLength(primer, activeRowKind);
  if (activeLength <= 0) return primer;

  const sliceStart =
    activeRowKind === 'left-source'
      ? sourceBoundaryAnchor + delta - activeLength
      : sourceBoundaryAnchor + delta;
  const sliceEndExcl =
    activeRowKind === 'left-source'
      ? sourceBoundaryAnchor + delta
      : sourceBoundaryAnchor + delta + activeLength;
  if (sliceStart < 0 || sliceEndExcl > activeSeq.length) return primer;

  const activeForwardBases = activeSeq.slice(sliceStart, sliceEndExcl);
  const forwardSegmentStart = activeRowKind === 'left-source' ? 0 : 4 - activeLength;
  const replacement =
    primer.direction === 'forward' ? activeForwardBases : reverseComplement(activeForwardBases);
  const primerSegmentStart =
    primer.direction === 'forward' ? forwardSegmentStart : 4 - (forwardSegmentStart + activeLength);

  const scar = primer.bases.slice(cut, cut + 4);
  const nextScar =
    scar.slice(0, primerSegmentStart) + replacement + scar.slice(primerSegmentStart + activeLength);
  const nextBases = primer.bases.slice(0, cut) + nextScar + primer.bases.slice(cut + 4);
  if (nextBases.length !== primer.bases.length) return primer;
  return { ...primer, bases: nextBases };
}

function goldenGateActive4bpLength(
  primer: PrimerDisplay,
  activeRowKind: 'left-source' | 'right-source'
): number {
  const ownCognateLength = clampLength(primer.cognate4bpLength ?? Number.NaN, 4);
  if (!Number.isFinite(primer.cognate4bpLength)) return 0;
  if (isPrimerOnActiveDragSide(primer, activeRowKind)) return ownCognateLength;
  if (!isPrimerOnOpposingDragSide(primer, activeRowKind)) return 0;
  const spacerSyntheticLength = clampLength(primer.synthetic4bpSpacerLength ?? 0, 4);
  return Math.max(0, Math.min(4, 4 - ownCognateLength - spacerSyntheticLength));
}

function livePrimerForFieldValue(
  sequence: string,
  primer: PrimerDisplay,
  field: AssemblyWorkbenchEditableField,
  nextValue: number
): PrimerDisplay {
  if (!primerMatchesField(primer, field)) return primer;
  const snappedValue = Math.max(0, Math.round(nextValue));
  if (field.kind === 'primerPbs') return livePrimerForPbsLength(sequence, primer, snappedValue);
  if (field.kind === 'primerTail') return livePrimerForTailLength(sequence, primer, snappedValue);
  return primer;
}

function primerMatchesField(primer: PrimerDisplay, field: AssemblyWorkbenchEditableField): boolean {
  const primerId = field.target.primerId;
  return Boolean(primerId && (primer.id === primerId || primer.sourcePrimerId === primerId));
}

function livePrimerForPbsLength(
  sequence: string,
  primer: PrimerDisplay,
  pbsLength: number
): PrimerDisplay {
  const fullLength = primerDisplayLength(primer);
  const overhangLength = clampLength(primer.overhangLength ?? 0, fullLength);
  const overhangBases = resizedBases(primer.bases.slice(0, overhangLength), overhangLength);
  if (primer.direction === 'forward') {
    const pbsStart = primer.start + overhangLength;
    const end = pbsStart + pbsLength;
    const pbsBases =
      primerBasesForForwardSlice(primer, boundedSequenceSlice(sequence, pbsStart, end)) ??
      resizedBases(primer.bases.slice(overhangLength), pbsLength);
    return { ...primer, end, bases: overhangBases + pbsBases };
  }

  const pbsEnd = primer.end - overhangLength;
  const start = pbsEnd - pbsLength;
  const pbsBases =
    primerBasesForForwardSlice(primer, boundedSequenceSlice(sequence, start, pbsEnd)) ??
    resizedBases(primer.bases.slice(overhangLength), pbsLength);
  return { ...primer, start, bases: overhangBases + pbsBases };
}

function livePrimerForTailLength(
  sequence: string,
  primer: PrimerDisplay,
  overhangLength: number
): PrimerDisplay {
  const fullLength = primerDisplayLength(primer);
  const currentOverhangLength = clampLength(primer.overhangLength ?? 0, fullLength);
  const pbsLength = Math.max(0, fullLength - currentOverhangLength);
  if (primer.direction === 'forward') {
    const pbsStart = primer.end - pbsLength;
    const start = pbsStart - overhangLength;
    const overhangBases =
      primerBasesForForwardSlice(primer, boundedSequenceSlice(sequence, start, pbsStart)) ??
      resizedBases(primer.bases.slice(0, currentOverhangLength), overhangLength);
    const pbsBases =
      primerBasesForForwardSlice(primer, boundedSequenceSlice(sequence, pbsStart, primer.end)) ??
      resizedBases(primer.bases.slice(currentOverhangLength), pbsLength);
    return {
      ...primer,
      start,
      overhangLength,
      bases: overhangBases + pbsBases,
    };
  }

  const pbsEnd = primer.start + pbsLength;
  const end = pbsEnd + overhangLength;
  const overhangBases =
    primerBasesForForwardSlice(primer, boundedSequenceSlice(sequence, pbsEnd, end)) ??
    resizedBases(primer.bases.slice(0, currentOverhangLength), overhangLength);
  const pbsBases =
    primerBasesForForwardSlice(primer, boundedSequenceSlice(sequence, primer.start, pbsEnd)) ??
    resizedBases(primer.bases.slice(currentOverhangLength), pbsLength);
  return {
    ...primer,
    end,
    overhangLength,
    bases: overhangBases + pbsBases,
  };
}

function primerDisplayLength(primer: PrimerDisplay): number {
  return Math.max(0, primer.end - primer.start);
}

function clampLength(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.round(value)));
}

function boundedSequenceSlice(sequence: string, start: number, end: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || end > sequence.length) return null;
  return sequence.slice(start, end);
}

function primerBasesForForwardSlice(
  primer: PrimerDisplay,
  forwardSlice: string | null
): string | null {
  if (forwardSlice === null) return null;
  return primer.direction === 'forward' ? forwardSlice : reverseComplement(forwardSlice);
}

function resizedBases(bases: string, length: number): string {
  if (length <= 0) return '';
  if (bases.length === length) return bases;
  if (bases.length > length) return bases.slice(0, length);
  return bases + 'N'.repeat(length - bases.length);
}

interface SourceRegisterDragPrimerSource {
  sequence: string;
  pbsAnchor: number;
  sourceBoundaryAnchor: number;
}

function sourceRegisterDragPrimerSource(
  row: SourceRegisterRow,
  field: AssemblyWorkbenchEditableField
): SourceRegisterDragPrimerSource | null {
  const activePrimer = row.primers?.find((primer) => isPrimerOnActiveDragSide(primer, row.kind));
  if (!activePrimer) return null;
  const pbsAnchor =
    row.kind === 'left-source'
      ? activePrimer.end - Math.max(0, activePrimer.overhangLength ?? 0)
      : activePrimer.start + Math.max(0, activePrimer.overhangLength ?? 0);
  const boundaryBioCol = field.anchors.find(
    (anchor) => anchor.rowId === row.id && anchor.role === 'boundary'
  )?.bioCol;
  return {
    sequence: row.sequence,
    pbsAnchor,
    sourceBoundaryAnchor:
      typeof boundaryBioCol === 'number'
        ? rowBoundaryColumnForBioCol(row, boundaryBioCol)
        : pbsAnchor,
  };
}

function isPrimerOnActiveDragSide(
  primer: PrimerDisplay,
  activeRowKind: 'left-source' | 'right-source'
): boolean {
  return activeRowKind === 'left-source'
    ? primer.direction === 'reverse'
    : primer.direction === 'forward';
}

function isPrimerOnOpposingDragSide(
  primer: PrimerDisplay,
  activeRowKind: 'left-source' | 'right-source'
): boolean {
  return activeRowKind === 'left-source'
    ? primer.direction === 'forward'
    : primer.direction === 'reverse';
}

function shiftActivePbsFromActiveSeq(
  primer: PrimerDisplay,
  activeSeq: string,
  activeAnchor: number,
  delta: number,
  activeRowKind: 'left-source' | 'right-source'
): PrimerDisplay {
  const overhang = Math.max(0, primer.overhangLength ?? 0);
  const fullLen = primer.bases.length;
  const bindingLen = fullLen - overhang;
  if (bindingLen <= 0) return primer;

  const sliceStart =
    activeRowKind === 'left-source' ? activeAnchor + delta - bindingLen : activeAnchor + delta;
  const sliceEndExcl =
    activeRowKind === 'left-source' ? activeAnchor + delta : activeAnchor + delta + bindingLen;
  if (sliceStart < 0 || sliceEndExcl > activeSeq.length) return primer;

  const forwardSlice = activeSeq.slice(sliceStart, sliceEndExcl);
  const newPbsBases =
    primer.direction === 'forward' ? forwardSlice : reverseComplement(forwardSlice);
  const overhangBases = primer.bases.slice(0, overhang);
  const newBases = overhangBases + newPbsBases;
  if (newBases.length !== fullLen) return primer;
  return { ...primer, bases: newBases };
}

function shiftOpposingOverhangFromActiveSeq(
  primer: PrimerDisplay,
  activeSeq: string,
  activeAnchor: number,
  delta: number,
  activeRowKind: 'left-source' | 'right-source'
): PrimerDisplay {
  const overhang = Math.max(0, primer.overhangLength ?? 0);
  if (overhang <= 0) return primer;
  const fullLen = primer.bases.length;
  const spacerInOverhang = Math.max(0, Math.min(overhang, primer.spacerLength ?? 0));
  const homologyLen = overhang - spacerInOverhang;
  if (homologyLen <= 0) return primer;

  const sliceStart =
    activeRowKind === 'left-source' ? activeAnchor + delta - homologyLen : activeAnchor + delta;
  const sliceEndExcl =
    activeRowKind === 'left-source' ? activeAnchor + delta : activeAnchor + delta + homologyLen;
  if (sliceStart < 0 || sliceEndExcl > activeSeq.length) return primer;

  const forwardSlice = activeSeq.slice(sliceStart, sliceEndExcl);
  const newHomologyBases =
    primer.direction === 'forward' ? forwardSlice : reverseComplement(forwardSlice);
  const spacerBases = primer.bases.slice(homologyLen, overhang);
  const pbsBases = primer.bases.slice(overhang);
  const newBases = newHomologyBases + spacerBases + pbsBases;
  if (newBases.length !== fullLen) return primer;
  return { ...primer, bases: newBases };
}

interface RegisteredAssemblySurfaceProps {
  row: JunctionWorkbenchRow;
  metric?: JunctionRowMetric;
  scrollLeft: number;
  zoomPercent: number;
  pxPerBase: number;
  editableFields: AssemblyWorkbenchEditableField[];
  goldenGateOptimizerPreviewChoice?: GoldenGateOptimizerPreviewChoice;
  primerSegments: RenderedPrimerSegment[];
  productPreviewRows: ProductPreviewRows;
  activeProductPreviewOwner: 'left' | 'right' | null;
  crossoverEditEnabled: boolean;
  height: number;
  screenXForBioCol: (bioCol: number) => number;
  registerOverlayHandle: (rowId: string, handle: WorkbenchPrimerOverlayHandle | null) => void;
  onPrimerLayoutChange: (rowId: string, segments: RenderedPrimerSegment[]) => void;
  onFieldPreview?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldCommit?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldCancel?: () => void;
  onFieldLivePreview?: (
    field: AssemblyWorkbenchEditableField,
    preview: AssemblyWorkbenchLiveFieldPreview
  ) => void;
  onFieldLivePreviewEnd?: () => void;
  productControls?: ReactNode;
  sourceRowsToggle?: ReactNode;
  onHandleLivePreview?: (
    handle: JunctionFieldHandle,
    nextValue: number
  ) => AssemblyWorkbenchLiveFieldPreview | null;
  onHandleLivePreviewEnd?: () => void;
  onHandlePanRequest?: (deltaPx: number) => void;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onMouseDownCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseMoveCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseUpCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

function RegisteredAssemblySurface({
  row,
  metric,
  scrollLeft,
  zoomPercent,
  pxPerBase,
  editableFields,
  goldenGateOptimizerPreviewChoice,
  primerSegments,
  productPreviewRows,
  activeProductPreviewOwner,
  crossoverEditEnabled,
  height,
  screenXForBioCol,
  registerOverlayHandle,
  onPrimerLayoutChange,
  onFieldPreview,
  onFieldCommit,
  onFieldCancel,
  onFieldLivePreview,
  onFieldLivePreviewEnd,
  productControls,
  sourceRowsToggle,
  onHandleLivePreview,
  onHandleLivePreviewEnd,
  onHandlePanRequest,
  onPointerDownCapture,
  onPointerMoveCapture,
  onPointerUpCapture,
  onPointerCancelCapture,
  onMouseDownCapture,
  onMouseMoveCapture,
  onMouseUpCapture,
}: RegisteredAssemblySurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const provenance = provenanceForRow(row);
  const primers = primersForRow(row);
  const overlayRefCallback = useCallback(
    (handle: WorkbenchPrimerOverlayHandle | null) => registerOverlayHandle(row.id, handle),
    [row.id, registerOverlayHandle]
  );
  const sourceRegisterField = sourceContributionBoundaryFieldForRow(row, editableFields);
  const sourceRow = row.kind === 'left-source' || row.kind === 'right-source';
  const productRow = row.kind === 'product';
  const productSourceRegisterDraggable =
    productRow && hasAnyEnabledSourceContributionBoundaryField(editableFields);
  const sourceRegisterDraggable = Boolean(sourceRegisterField) || productSourceRegisterDraggable;
  const crossoverDragArmed = sourceRegisterDraggable && crossoverEditEnabled;
  const sequence = rowToSequence(row, {
    annotations: sourceRow
      ? (row.dragShiftedContinuousAnnotations ??
        row.dragShiftedAnnotations ??
        row.continuousAnnotations ??
        row.annotations)
      : row.annotations,
  });
  const layoutAnchorSequence =
    sourceRow && (row.dragShiftedContinuousAnnotations || row.dragShiftedAnnotations)
      ? rowToSequence(row, {
          annotations: row.continuousAnnotations ?? row.annotations,
        })
      : undefined;
  const sourceRowBufferPx = sourceRow ? SOURCE_ROW_BUFFER_BP * pxPerBase : 0;
  const canvasScrollLeft = scrollLeft - sourceRowBufferPx;
  const assemblyHighlight = assemblyHighlightForRow({
    row,
    scrollLeft,
    screenXForBioCol,
  });
  const virtualCuts = gibsonVirtualCutsForProductRow(row);
  const laneBackgroundSegments = sourceLaneBackgroundSegmentsForRow({
    row,
    scrollLeft,
    screenXForBioCol,
  });
  const rowHandles = projectFieldHandlesForRow({
    row,
    fields: editableFields,
    primerSegments,
    height,
    screenXForBioCol,
  });
  const handleLivePreview = useCallback(
    (handle: JunctionFieldHandle, nextValue: number) => {
      const overlapHandled = applyProductOverlapLivePreview(surfaceRef.current, {
        row,
        handle,
        nextValue,
        scrollLeft,
        screenXForBioCol,
      });
      if (handle.kind === 'goldenGateOverhang') {
        const livePreview = onHandleLivePreview?.(handle, nextValue) ?? null;
        if (!overlapHandled || !livePreview) {
          throw new Error(
            'Golden Gate overhang handles must use visual-only live preview for geometry and primer bases.'
          );
        }
        onFieldLivePreview?.(handle.field, livePreview);
        return;
      }
      if (handle.kind === 'homologyArm') {
        const livePreview = onHandleLivePreview?.(handle, nextValue) ?? null;
        if (!overlapHandled || !livePreview) {
          throw new Error(
            'Homology overlap handles must use visual-only live preview for geometry and primer bases.'
          );
        }
        onFieldLivePreview?.(handle.field, livePreview);
        return;
      }
      if (overlapHandled) {
        onFieldLivePreview?.(handle.field, { value: nextValue });
        return;
      }
      const livePreview = onHandleLivePreview?.(handle, nextValue) ?? null;
      if (livePreview) {
        onFieldLivePreview?.(handle.field, livePreview);
        return;
      }
      throw new Error(
        `RegisteredAssemblyViewport has no live-sync preview implementation for ${handle.kind}:${handle.role}.`
      );
    },
    [onFieldLivePreview, onHandleLivePreview, row, screenXForBioCol, scrollLeft]
  );
  const handleLivePreviewEnd = useCallback(() => {
    clearProductOverlapLivePreview(surfaceRef.current);
    onHandleLivePreviewEnd?.();
    onFieldLivePreviewEnd?.();
  }, [onFieldLivePreviewEnd, onHandleLivePreviewEnd]);
  const optimizerPreviewAppliedRef = useRef(false);
  useEffect(() => {
    if (!productRow) return;
    const choice = goldenGateOptimizerPreviewChoice;
    if (!choice) {
      if (optimizerPreviewAppliedRef.current) {
        clearProductOverlapLivePreview(surfaceRef.current);
        onHandleLivePreviewEnd?.();
        optimizerPreviewAppliedRef.current = false;
      }
      return;
    }
    const handle = rowHandles.find(
      (candidate) =>
        candidate.kind === 'goldenGateOverhang' &&
        candidate.field.target.junctionIndex === choice.junctionIndex
    );
    if (!handle || handle.disabled) {
      if (optimizerPreviewAppliedRef.current) {
        clearProductOverlapLivePreview(surfaceRef.current);
        onHandleLivePreviewEnd?.();
        optimizerPreviewAppliedRef.current = false;
      }
      return;
    }
    const overlapHandled = applyProductOverlapLivePreview(surfaceRef.current, {
      row,
      handle,
      nextValue: choice.offset,
      scrollLeft,
      screenXForBioCol,
    });
    const livePreview = onHandleLivePreview?.(handle, choice.offset) ?? null;
    if (!overlapHandled || !livePreview) {
      throw new Error(
        'Golden Gate optimizer candidates must use visual-only live preview for geometry and primer bases.'
      );
    }
    optimizerPreviewAppliedRef.current = true;
  }, [
    goldenGateOptimizerPreviewChoice,
    onHandleLivePreview,
    onHandleLivePreviewEnd,
    productRow,
    row,
    rowHandles,
    screenXForBioCol,
    scrollLeft,
  ]);

  return (
    <div
      data-testid={`junction-row-${row.kind}`}
      data-row-id={row.id}
      data-registered-scroll-left={scrollLeft}
      data-row-bp={row.sequence.length}
      data-anchor-row-position={row.anchorRowPosition}
      data-viewport-focus-bio-col={row.viewportFocusBioCol ?? 0}
      data-viewport-focus-row-position={row.viewportFocusRowPosition ?? row.anchorRowPosition}
      data-registered-row-viewer-height={height}
      data-row-sequence={row.sequence}
      data-row-annotation-count={row.annotations.length}
      data-row-candidate-annotation-count={
        row.annotations.filter((a) => a.qualifiers?.candidate?.includes('true')).length
      }
      data-strand-count={2}
      data-visible-column-count={row.visibleColumns?.length ?? row.sequence.length}
      data-contributing-column-count={
        row.contributingColumns?.length ?? row.visibleColumns?.length ?? row.sequence.length
      }
      data-muted-column-count={row.mutedColumns?.length ?? 0}
      data-spacer-column-count={row.spacerColumns?.length ?? 0}
      data-virtual-cut-site-count={virtualCuts.length}
      data-virtual-cut-sites={gibsonVirtualCutSignature(virtualCuts)}
      data-virtual-cut-renderer="layout-neutral-overlay"
      data-restriction-cut-site-count={row.cutSites?.length ?? 0}
      data-restriction-cut-sites={restrictionCutSiteSignature(row.cutSites)}
      data-primer-count={row.primers?.length ?? 0}
      data-fragment-color={row.fragmentColor ?? ''}
      data-left-fragment-color={row.leftFragmentColor ?? ''}
      data-right-fragment-color={row.rightFragmentColor ?? ''}
      data-source-context-status={row.sourceContextStatus ?? ''}
      className="grid min-w-0 max-w-full grid-cols-[8.25rem_minmax(0,1fr)] items-center gap-x-1.5 gap-y-1"
    >
      <div
        data-testid={`junction-row-label-${row.kind}`}
        data-side-overview={productRow ? 'product-junction-controls' : 'source-row'}
        data-side-overview-tone={productRow ? 'control' : 'source'}
        className={`relative flex min-w-0 flex-col justify-center overflow-hidden border ${
          productRow ? 'border-transparent bg-transparent py-0.5 pl-0 pr-1' : 'rounded px-1 py-0.5'
        }`}
        style={{
          borderColor: productRow ? 'transparent' : provenance.borderColor,
          background: productRow ? undefined : provenance.labelBackground,
        }}
      >
        {(!productRow || !productControls) && (
          <div className="min-w-0">
            <div className="truncate text-[11px] font-medium leading-4 text-fg">{row.label}</div>
            {!productRow && (
              <div className="text-[9px] uppercase leading-3 tracking-wide text-fg-muted">
                {row.kind === 'left-source' ? 'upstream' : 'downstream'}
              </div>
            )}
          </div>
        )}
        {productRow && productControls && (
          <div data-testid="junction-row-product-controls" className="min-w-0">
            {productControls}
          </div>
        )}
        {productRow && sourceRowsToggle}
        {metric && (
          <div
            data-testid={`junction-row-metrics-${row.kind}`}
            className="mt-0.5 grid grid-cols-2 gap-0.5 border-t border-border/60 pt-0.5"
          >
            <MetricCell
              testId={`junction-row-metric-${row.kind}-pbs`}
              label="PBS"
              value={metric.primerBindingLength}
            />
            <MetricCell
              testId={`junction-row-metric-${row.kind}-homology`}
              label="Hom"
              value={metric.homologyLength}
            />
          </div>
        )}
      </div>
      <div
        ref={surfaceRef}
        data-registered-viewer-frame="true"
        data-testid={`registered-assembly-pan-surface-${row.kind}`}
        data-registered-source-register-dragging="false"
        data-registered-source-register-field-id={sourceRegisterField?.id ?? ''}
        data-registered-source-register-value={sourceRegisterField?.value ?? ''}
        data-registered-source-register-rendered-value={sourceRegisterField?.value ?? ''}
        data-registered-source-register-presentation-offset-px="0"
        data-registered-drag-action={
          sourceRegisterField
            ? 'source-template'
            : productSourceRegisterDraggable
              ? 'product-source-template'
              : 'none'
        }
        data-registered-selection-start={assemblyHighlight?.startRowPosition ?? ''}
        data-registered-selection-end={assemblyHighlight?.endRowPosition ?? ''}
        data-registered-crossover-edit-enabled={crossoverEditEnabled ? 'true' : 'false'}
        data-registered-crossover-drag-armed={crossoverDragArmed ? 'true' : 'false'}
        title={crossoverDragArmed ? 'Drag to move the crossover point' : undefined}
        className={`group/junction-card relative min-w-0 select-none overflow-hidden rounded border border-border bg-bg ${
          crossoverDragArmed ? 'cursor-ew-resize' : 'cursor-default'
        }`}
        style={{ touchAction: 'none' }}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMoveCapture={onPointerMoveCapture}
        onPointerUpCapture={onPointerUpCapture}
        onPointerCancelCapture={onPointerCancelCapture}
        onMouseDownCapture={onMouseDownCapture}
        onMouseMoveCapture={onMouseMoveCapture}
        onMouseUpCapture={onMouseUpCapture}
      >
        <div
          data-testid={`registered-assembly-source-register-visual-layer-${row.kind}`}
          data-registered-source-register-visual-layer={sourceRow ? 'true' : 'false'}
          data-registered-source-register-visual-row-kind={row.kind}
          className="relative"
          style={{ height }}
        >
          <SourceLaneBackgroundOverlay
            testId={`registered-assembly-source-lane-background-${row.kind}`}
            segments={laneBackgroundSegments}
            height={height}
          />
          <div
            data-testid={`registered-assembly-source-register-content-layer-${row.kind}`}
            data-registered-source-register-content-layer="true"
            data-registered-source-register-content-row-kind={row.kind}
            data-registered-source-register-content-offset-px="0"
            data-registered-source-register-content-buffer-px={sourceRowBufferPx}
            data-registered-source-register-canvas-scroll-left={canvasScrollLeft}
            className="relative"
            style={{
              height,
              willChange: 'transform',
              ...(sourceRow
                ? {
                    width: `calc(100% + ${sourceRowBufferPx * 2}px)`,
                    left: `-${sourceRowBufferPx}px`,
                  }
                : {}),
            }}
          >
            <SequenceViewer1D
              sequence={sequence}
              layoutAnchorSequence={layoutAnchorSequence}
              extraLanes={provenance.extraLanes}
              primers={primers}
              showPrimers={primers.length > 0}
              suppressPrimerDrawing
              cutSites={row.cutSites ?? []}
              showCutSites={(row.cutSites?.length ?? 0) > 0}
              showReverseComplement={true}
              zoomPercent={zoomPercent}
              wheelScrollEnabled={false}
              showScrollbar={false}
              showRuler={false}
              pointerInteractionsEnabled={false}
              passiveCursor="inherit"
              mutedColumns={row.mutedColumns}
              mutedColumnColor={NON_CONTRIBUTING_COLOR}
              transparentBackground
              scrollLeft={canvasScrollLeft}
              onPrimerLayoutChange={(segments) => onPrimerLayoutChange(row.id, segments)}
              style={{ height }}
            />
            {}
            {sourceRow && assemblyHighlight && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  transform: `translate3d(${sourceRowBufferPx}px, 0, 0)`,
                }}
              >
                <JunctionAssemblyHighlightOverlay
                  rowKind={row.kind}
                  height={height}
                  segments={assemblyHighlight.segments}
                  cursors={assemblyHighlight.cursors}
                />
              </div>
            )}
          </div>
          {row.kind === 'product' && (
            <>
              <RegisteredProductOwnerPreviewLayer
                owner="left"
                activeSourceRow={productPreviewRows.left}
                partnerSourceRow={productPreviewRows.right}
                productRow={row}
                height={height}
                zoomPercent={zoomPercent}
                pxPerBase={pxPerBase}
                scrollLeft={scrollLeft}
                active={activeProductPreviewOwner === 'left'}
              />
              <RegisteredProductOwnerPreviewLayer
                owner="right"
                activeSourceRow={productPreviewRows.right}
                partnerSourceRow={productPreviewRows.left}
                productRow={row}
                height={height}
                zoomPercent={zoomPercent}
                pxPerBase={pxPerBase}
                scrollLeft={scrollLeft}
                active={activeProductPreviewOwner === 'right'}
              />
            </>
          )}
          {}
          <WorkbenchPrimerOverlay
            ref={overlayRefCallback}
            sequence={row.sequence}
            annotations={row.annotations}
            primers={primers}
            showPrimers={primers.length > 0}
            pxPerBase={pxPerBase}
            isCircular={false}
            showReverseComplement={true}
            scrollLeft={scrollLeft}
            extraLanes={provenance.extraLanes}
            rowId={row.id}
          />
          {row.kind === 'product' && virtualCuts.length > 0 && (
            <GibsonVirtualCutOverlay
              row={row}
              cuts={virtualCuts}
              height={height}
              pxPerBase={pxPerBase}
              scrollLeft={scrollLeft}
              screenXForBioCol={screenXForBioCol}
              primers={primers}
              extraLanes={provenance.extraLanes}
            />
          )}
          {!sourceRow && assemblyHighlight && (
            <JunctionAssemblyHighlightOverlay
              rowKind={row.kind}
              height={height}
              segments={assemblyHighlight.segments}
              cursors={assemblyHighlight.cursors}
            />
          )}
          {rowHandles.length > 0 && (
            <JunctionHandleOverlay
              handles={rowHandles}
              pxPerBase={pxPerBase}
              scrollLeft={scrollLeft}
              height={height}
              onPreview={(handle, nextValue) => onFieldPreview?.(handle.field, nextValue)}
              onCommit={(handle, nextValue) => onFieldCommit?.(handle.field, nextValue)}
              onCancel={onFieldCancel}
              onLivePreview={handleLivePreview}
              onLivePreviewEnd={handleLivePreviewEnd}
              onPanRequest={onHandlePanRequest}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function restrictionCutSiteSignature(cutSites: JunctionWorkbenchRow['cutSites']): string {
  return (cutSites ?? [])
    .map(
      (site) =>
        `${site.enzyme.name}:${site.cutPositionTop}:${site.cutPositionBottom}:${site.recognitionStart}-${site.recognitionEnd}`
    )
    .join('|');
}

function scrollLeftForCenteredFocus(
  row: JunctionWorkbenchRow,
  centerX: number,
  pxPerBase: number,
  viewportWidth: number,
  sideScrollOffset = 0
): number {
  const focusRowPosition = row.viewportFocusRowPosition ?? row.anchorRowPosition;
  const centered = JUNCTION_WORKBENCH_HORIZONTAL_PADDING + focusRowPosition * pxPerBase - centerX;
  return clampScrollLeftForRow(row, centered + sideScrollOffset, viewportWidth, pxPerBase);
}

function viewportFocusBioColForRows(rows: JunctionWorkbenchRow[]): number {
  return (
    rows.find((row) => row.kind === 'product')?.viewportFocusBioCol ??
    rows[0]?.viewportFocusBioCol ??
    0
  );
}

function clampSideScrollOffset(
  offset: number,
  rows: JunctionWorkbenchRow[],
  centerX: number,
  pxPerBase: number,
  viewportWidth: number
): number {
  if (rows.length === 0) return 0;
  let minOffset = Number.NEGATIVE_INFINITY;
  let maxOffset = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const focusRowPosition = row.viewportFocusRowPosition ?? row.anchorRowPosition;
    const centered = JUNCTION_WORKBENCH_HORIZONTAL_PADDING + focusRowPosition * pxPerBase - centerX;
    const maxScroll = maxScrollLeftForRow(row, viewportWidth, pxPerBase);
    minOffset = Math.max(minOffset, -Math.max(0, centered));
    maxOffset = Math.min(maxOffset, maxScroll - Math.max(0, centered));
  }
  if (!Number.isFinite(minOffset) || !Number.isFinite(maxOffset) || minOffset > maxOffset) {
    return 0;
  }
  return Math.max(minOffset, Math.min(maxOffset, offset));
}

function clampScrollLeftForRow(
  row: JunctionWorkbenchRow,
  scrollLeft: number,
  viewportWidth: number,
  pxPerBase: number
): number {
  return Math.max(0, Math.min(maxScrollLeftForRow(row, viewportWidth, pxPerBase), scrollLeft));
}

function maxScrollLeftForRow(
  row: JunctionWorkbenchRow,
  viewportWidth: number,
  pxPerBase: number
): number {
  const totalWidth = JUNCTION_WORKBENCH_HORIZONTAL_PADDING * 2 + row.sequence.length * pxPerBase;
  return Math.max(0, totalWidth - Math.max(0, viewportWidth));
}

interface ProductPreviewRows {
  left: SourceRegisterRow | null;
  right: SourceRegisterRow | null;
}

function sourcePreviewRowsByOwner(rows: JunctionWorkbenchRow[]): ProductPreviewRows {
  return {
    left: rows.find((row): row is SourceRegisterRow => row.kind === 'left-source') ?? null,
    right: rows.find((row): row is SourceRegisterRow => row.kind === 'right-source') ?? null,
  };
}

interface SourceLaneBackgroundSegment {
  id: string;
  owner: 'left' | 'right' | 'spacer' | 'source' | 'muted';
  startBioCol: number;
  endBioCol: number;
  left: number;
  width: number;
  color: string;
}

function SourceLaneBackgroundOverlay({
  testId,
  segments,
  height,
}: {
  testId: string;
  segments: SourceLaneBackgroundSegment[];
  height: number;
}) {
  return (
    <div
      data-testid={testId}
      data-source-lane-background-segment-count={segments.length}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ height }}
    >
      {segments.map((segment) => (
        <div
          key={segment.id}
          data-source-lane-background-segment={segment.owner}
          data-source-lane-background-start-bio-col={segment.startBioCol}
          data-source-lane-background-end-bio-col={segment.endBioCol}
          className="absolute top-0 bottom-0"
          style={{
            left: segment.left,
            width: segment.width,
            backgroundColor: segment.color,
          }}
        />
      ))}
    </div>
  );
}

function sourceLaneBackgroundSegmentsForRow(input: {
  row: JunctionWorkbenchRow;
  scrollLeft: number;
  screenXForBioCol: (bioCol: number) => number;
}): SourceLaneBackgroundSegment[] {
  const { row, scrollLeft, screenXForBioCol } = input;
  const points = [...row.points].sort((a, b) => a.bioCol - b.bioCol);
  if (points.length === 0) return [];

  if (row.kind === 'left-source' || row.kind === 'right-source') {
    const color =
      row.fragmentColor ??
      (row.kind === 'left-source' ? FALLBACK_LEFT_SOURCE_COLOR : FALLBACK_RIGHT_SOURCE_COLOR);
    const mutedColumnSet = new Set(row.mutedColumns ?? []);
    const visibleColumnSet = new Set(
      row.visibleColumns ?? points.map((point) => point.rowPosition)
    );
    const sourceSegments: SourceLaneBackgroundSegment[] = [];
    let currentOwner: SourceLaneBackgroundSegment['owner'] | null = null;
    let currentStartBioCol: number | null = null;
    let previousBioCol: number | null = null;

    const flush = () => {
      if (currentOwner === null || currentStartBioCol === null || previousBioCol === null) return;
      const start = currentStartBioCol;
      const end = previousBioCol + 1;
      sourceSegments.push({
        id: `${row.id}:${currentOwner}:${start}:${end}`,
        owner: currentOwner,
        startBioCol: start,
        endBioCol: end,
        left: screenXForBioCol(start) - scrollLeft,
        width: Math.max(1, screenXForBioCol(end) - screenXForBioCol(start)),
        color:
          currentOwner === 'muted' ? NON_CONTRIBUTING_BACKGROUND_COLOR : colorWash(color, 0.14),
      });
    };

    for (const point of points) {
      if (!visibleColumnSet.has(point.rowPosition)) continue;
      const owner: SourceLaneBackgroundSegment['owner'] = mutedColumnSet.has(point.rowPosition)
        ? 'muted'
        : 'source';
      const startsNewRun =
        currentOwner === null ||
        owner !== currentOwner ||
        previousBioCol === null ||
        point.bioCol !== previousBioCol + 1;
      if (startsNewRun) {
        flush();
        currentOwner = owner;
        currentStartBioCol = point.bioCol;
      }
      previousBioCol = point.bioCol;
    }
    flush();

    return sourceSegments;
  }

  if (row.kind !== 'product') return [];

  const segments: SourceLaneBackgroundSegment[] = [];
  let currentOwner: WorkbenchPaintOwner | null = null;
  let currentStartBioCol: number | null = null;
  let previousBioCol: number | null = null;

  const flush = () => {
    if (currentOwner === null || currentStartBioCol === null || previousBioCol === null) return;
    const owner = currentOwner;
    const start = currentStartBioCol;
    const end = previousBioCol + 1;
    segments.push({
      id: `${row.id}:${owner}:${start}:${end}`,
      owner,
      startBioCol: start,
      endBioCol: end,
      left: screenXForBioCol(start) - scrollLeft,
      width: Math.max(1, screenXForBioCol(end) - screenXForBioCol(start)),
      color: colorWash(productOwnerColor(row, owner), owner === 'spacer' ? 0.11 : 0.14),
    });
  };

  for (const point of points) {
    const owner = productOwnerForPoint(row, point);
    const startsNewRun =
      currentOwner === null ||
      owner !== currentOwner ||
      previousBioCol === null ||
      point.bioCol !== previousBioCol + 1;
    if (startsNewRun) {
      flush();
      currentOwner = owner;
      currentStartBioCol = point.bioCol;
    }
    previousBioCol = point.bioCol;
  }
  flush();

  return segments;
}

function registeredAssemblyRowHeight(
  row: JunctionWorkbenchRow,
  pxPerBase: number,
  productPreviewRows: ProductPreviewRows
): number {
  const provenance = provenanceForRow(row);
  const baseHeight = sequenceViewerRequiredHeight({
    sequence: rowToSequence(row, { annotations: renderedAnnotationsForRow(row) }),
    primers: primersForRow(row),
    extraLanes: provenance.extraLanes,
    pxPerBase,
    cutSites: row.cutSites,
  });
  if (row.kind !== 'product') return Math.max(ROW_VIEWER_HEIGHT, Math.ceil(baseHeight));

  const previewHeights: number[] = [];
  for (const owner of ['left', 'right'] as const) {
    const activeSourceRow = productPreviewRows[owner];
    const partnerSourceRow = owner === 'left' ? productPreviewRows.right : productPreviewRows.left;
    const sequence = buildProductOwnerPreviewSequence({
      productRow: row,
      activeSourceRow,
      owner,
      annotationMode: 'settled',
    });
    if (!sequence) continue;
    previewHeights.push(
      sequenceViewerRequiredHeight({
        sequence,
        primers: [
          ...(activeSourceRow ? primersForRow(activeSourceRow) : []),
          ...(partnerSourceRow ? primersForRow(partnerSourceRow) : []),
        ],
        extraLanes: provenance.extraLanes,
        pxPerBase,
      })
    );
  }

  return Math.max(ROW_VIEWER_HEIGHT, Math.ceil(baseHeight), ...previewHeights.map(Math.ceil));
}

function renderedAnnotationsForRow(row: JunctionWorkbenchRow): readonly Annotation[] {
  if (row.kind !== 'left-source' && row.kind !== 'right-source') return row.annotations;
  return (
    row.dragShiftedContinuousAnnotations ??
    row.dragShiftedAnnotations ??
    row.continuousAnnotations ??
    row.annotations
  );
}

function sequenceViewerRequiredHeight(input: {
  sequence: ReturnType<typeof rowToSequence>;
  primers: PrimerDisplay[];
  extraLanes: SequenceExtraLane[];
  pxPerBase: number;
  cutSites?: JunctionWorkbenchRow['cutSites'];
}): number {
  const layout = computeRegisteredSequenceLayout(input);
  const extrasHeight = input.extraLanes.reduce((sum, lane) => sum + Math.max(0, lane.height), 0);
  return layout.totalHeight + extrasHeight;
}

function computeRegisteredSequenceLayout(input: {
  sequence: ReturnType<typeof rowToSequence>;
  primers: PrimerDisplay[];
  pxPerBase: number;
  cutSites?: JunctionWorkbenchRow['cutSites'];
}) {
  return compute1DLayout({
    columnCount: input.sequence.sequence.length,
    annotations: input.sequence.annotations ?? [],
    selectedIds: new Set(),
    pxPerBase: input.pxPerBase,
    fullSequence: input.sequence.sequence,
    orfs: [],
    primers: input.primers,
    showPrimers: input.primers.length > 0,
    showReverseComplement: true,
    showCutSites: (input.cutSites?.length ?? 0) > 0,
    showRuler: false,
    isCircular: false,
  });
}

function RegisteredProductOwnerPreviewLayer({
  owner,
  activeSourceRow,
  partnerSourceRow,
  productRow,
  height,
  zoomPercent,
  pxPerBase,
  scrollLeft,
  active,
}: {
  owner: 'left' | 'right';
  activeSourceRow: SourceRegisterRow | null;
  partnerSourceRow: SourceRegisterRow | null;
  productRow: JunctionWorkbenchRow;
  height: number;
  zoomPercent: number;
  pxPerBase: number;
  scrollLeft: number;
  active: boolean;
}) {
  const semanticPreviewActive = productRow.productDragPreview?.owner === owner;
  const shouldRenderPreview = active || semanticPreviewActive;
  const sequence = shouldRenderPreview
    ? buildProductOwnerPreviewSequence({ productRow, activeSourceRow, owner })
    : null;
  const extraLanes =
    shouldRenderPreview && activeSourceRow ? provenanceForRow(productRow).extraLanes : [];
  const laneBackgroundSegments = sourceLaneBackgroundSegmentsForRow({
    row: productRow,
    scrollLeft,
    screenXForBioCol: (bioCol) => worldXForBioCol(productRow, bioCol, pxPerBase),
  });
  const activePrimers =
    shouldRenderPreview && activeSourceRow ? primersForRow(activeSourceRow) : [];
  const partnerPrimers =
    shouldRenderPreview && partnerSourceRow ? primersForRow(partnerSourceRow) : [];
  const primers = [...activePrimers, ...partnerPrimers];
  const verticalOffsetPx = 0;
  return (
    <div
      data-testid={`registered-assembly-source-register-product-owner-layer-${owner}`}
      data-registered-source-register-product-owner-layer={owner}
      data-registered-source-register-product-owner-active="false"
      data-registered-source-register-product-owner-offset-px="0"
      data-registered-source-register-product-owner-rendered={sequence ? 'true' : 'false'}
      data-registered-source-register-product-owner-annotation-count={
        sequence?.annotations?.length ?? 0
      }
      className="pointer-events-none absolute inset-0 overflow-hidden bg-bg opacity-0"
      style={{ height }}
    >
      {}
      <SourceLaneBackgroundOverlay
        testId={`registered-assembly-source-register-product-owner-lane-background-${owner}`}
        segments={laneBackgroundSegments}
        height={height}
      />
      <div
        data-registered-source-register-product-owner-content="true"
        data-registered-source-register-product-owner-vertical-offset-px={verticalOffsetPx}
        className="relative"
        style={{
          height,
          willChange: 'transform',
          transform:
            verticalOffsetPx === 0 ? undefined : `translate3d(0, ${verticalOffsetPx}px, 0)`,
        }}
      >
        {sequence && (
          <SequenceViewer1D
            sequence={sequence}
            layoutAnchorSequence={rowToSequence(productRow, {
              annotations: productRow.annotations,
            })}
            extraLanes={extraLanes}
            primers={primers}
            showPrimers={primers.length > 0}
            suppressPrimerDrawing
            showReverseComplement={true}
            zoomPercent={zoomPercent}
            wheelScrollEnabled={false}
            showScrollbar={false}
            showRuler={false}
            pointerInteractionsEnabled={false}
            passiveCursor="inherit"
            mutedColumns={[]}
            mutedColumnColor={NON_CONTRIBUTING_COLOR}
            transparentBackground
            scrollLeft={scrollLeft}
            style={{ height }}
          />
        )}
      </div>
    </div>
  );
}

function worldXForBioCol(row: JunctionWorkbenchRow, bioCol: number, pxPerBase: number): number {
  return JUNCTION_WORKBENCH_HORIZONTAL_PADDING + (row.anchorRowPosition + bioCol) * pxPerBase;
}

interface SourceRegisterDragTarget {
  field: AssemblyWorkbenchEditableField;
  activeRow: SourceRegisterRow;
}

function sourceRegisterTargetForFrame(input: {
  frame: HTMLDivElement;
  rows: JunctionWorkbenchRow[];
  fields: AssemblyWorkbenchEditableField[];
  clientX: number;
  pxPerBase: number;
}): SourceRegisterDragTarget | null {
  const row = rowForFrame(input.frame, input.rows);
  if (!row) return null;
  if (isSourceRegisterRow(row)) {
    const capability = sourceRegisterDragCapabilityForSourceRow(row, input.fields);
    return capability.status === 'enabled'
      ? { field: capability.field, activeRow: capability.activeRow }
      : null;
  }
  if (row.kind !== 'product') return null;
  const owner = productOwnerForClientX({
    frame: input.frame,
    productRow: row,
    clientX: input.clientX,
    pxPerBase: input.pxPerBase,
  });
  const capability = sourceRegisterDragCapabilityForProductOwner({
    owner,
    rows: input.rows,
    fields: input.fields,
  });
  return capability.status === 'enabled'
    ? { field: capability.field, activeRow: capability.activeRow }
    : null;
}

function rowForFrame(
  frame: HTMLDivElement,
  rows: JunctionWorkbenchRow[]
): JunctionWorkbenchRow | null {
  const rowId = frame.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
  if (!rowId) return null;
  return rows.find((item) => item.id === rowId) ?? null;
}

function syncIdleSourceRegisterProbeState(
  container: HTMLDivElement | null,
  rows: JunctionWorkbenchRow[],
  fields: AssemblyWorkbenchEditableField[]
): void {
  if (!container) return;
  container
    .querySelectorAll<HTMLDivElement>('[data-registered-viewer-frame="true"]')
    .forEach((frame) => {
      const row = rowForFrame(frame, rows);
      if (!row) return;
      const rowField = sourceContributionBoundaryFieldForRow(row, fields);
      const retainedField =
        row.kind === 'product'
          ? sourceContributionBoundaryFieldById(
              fields,
              frame.dataset.registeredSourceRegisterFieldId
            )
          : null;
      const field = rowField ?? retainedField ?? null;
      frame.dataset.registeredSourceRegisterDragging = 'false';
      frame.dataset.registeredSourceRegisterVisualOffsetPx = '0';
      frame.dataset.registeredSourceRegisterPresentationOffsetPx = '0';
      if (field && field.units === 'bp' && typeof field.value === 'number') {
        frame.dataset.registeredSourceRegisterFieldId = field.id;
        frame.dataset.registeredSourceRegisterValue = String(field.value);
        frame.dataset.registeredSourceRegisterRenderedValue = String(field.value);
      } else if (!rowField) {
        delete frame.dataset.registeredSourceRegisterFieldId;
        delete frame.dataset.registeredSourceRegisterValue;
        delete frame.dataset.registeredSourceRegisterRenderedValue;
      }
    });
}

function productOwnerForClientX(input: {
  frame: HTMLDivElement;
  productRow: JunctionWorkbenchRow;
  clientX: number;
  pxPerBase: number;
}): 'left' | 'right' | 'spacer' | null {
  const rowRoot = input.frame.closest<HTMLElement>('[data-row-id]');
  const scrollLeft = Number(rowRoot?.dataset.registeredScrollLeft ?? 0);
  const localX = input.clientX - input.frame.getBoundingClientRect().left;
  const bioCol = Math.round(
    (localX + scrollLeft - JUNCTION_WORKBENCH_HORIZONTAL_PADDING) / input.pxPerBase -
      input.productRow.anchorRowPosition
  );
  const point =
    input.productRow.points.find((item) => item.bioCol === bioCol) ??
    nearestPointForBioCol(input.productRow, bioCol);
  if (!point) return null;
  return productOwnerForPoint(input.productRow, point);
}

function nearestPointForBioCol(
  row: JunctionWorkbenchRow,
  bioCol: number
): JunctionWorkbenchRow['points'][number] | null {
  let best: JunctionWorkbenchRow['points'][number] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of row.points) {
    const distance = Math.abs(point.bioCol - bioCol);
    if (distance >= bestDistance) continue;
    best = point;
    bestDistance = distance;
  }
  return bestDistance <= 1 ? best : null;
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

function productOwnerOffsetPxForGesture(gesture: SourceRegisterGestureState): number {
  return (gesture.startValue - gesture.latestValue) * gesture.pxPerBase;
}

function isRegisteredDragExcludedTarget(target: Element): boolean {
  return Boolean(
    target.closest(
      [
        '[data-linked-pan-exclude="true"]',
        '[data-registered-pan-exclude="true"]',
        'button',
        'input',
        'select',
        'textarea',
        'a',
      ].join(',')
    )
  );
}

interface RegisteredSourceContentPreview {
  offsetPx: number;
  productOwnerOffsetPx: number;
  activeRowKind: 'left-source' | 'right-source' | null;
}

function applyRegisteredSourceDragPreview(
  container: HTMLDivElement | null,
  preview: RegisteredSourceContentPreview
): void {
  if (!container) return;
  const roundedOffsetPx = round2(preview.offsetPx);
  const roundedProductOwnerOffsetPx = round2(preview.productOwnerOffsetPx);
  const productOwner =
    preview.activeRowKind === 'left-source'
      ? 'left'
      : preview.activeRowKind === 'right-source'
        ? 'right'
        : null;
  container.dataset.registeredSourceRegisterContentOffsetPx = String(roundedOffsetPx);
  container.dataset.registeredSourceRegisterProductOwnerOffsetPx = String(
    roundedProductOwnerOffsetPx
  );
  container.dataset.registeredSourceRegisterActiveRowKind = preview.activeRowKind ?? '';
  container
    .querySelectorAll<HTMLElement>('[data-registered-source-register-content-layer="true"]')
    .forEach((layer) => {
      const rowKind = layer.dataset.registeredSourceRegisterContentRowKind;
      const layerOffset = rowKind === preview.activeRowKind ? roundedOffsetPx : 0;
      layer.dataset.registeredSourceRegisterContentOffsetPx = String(layerOffset);
      layer.style.transform = '';
    });
  container
    .querySelectorAll<HTMLElement>('[data-registered-source-register-product-owner-layer]')
    .forEach((layer) => {
      const owner = layer.dataset.registeredSourceRegisterProductOwnerLayer;
      const active = owner === productOwner && roundedProductOwnerOffsetPx !== 0;
      layer.dataset.registeredSourceRegisterProductOwnerActive = active ? 'true' : 'false';
      layer.dataset.registeredSourceRegisterProductOwnerOffsetPx = active
        ? String(roundedProductOwnerOffsetPx)
        : '0';
      layer.style.opacity = active ? '1' : '';
      const content = layer.querySelector<HTMLElement>(
        '[data-registered-source-register-product-owner-content="true"]'
      );
      if (content) {
        const verticalOffset = Number(
          content.dataset.registeredSourceRegisterProductOwnerVerticalOffsetPx ?? 0
        );
        content.style.transform =
          Number.isFinite(verticalOffset) && verticalOffset !== 0
            ? `translate3d(0, ${verticalOffset}px, 0)`
            : '';
      }
    });
}

function releasePointerCaptureIfHeld(frame: HTMLDivElement, pointerId: number | null): void {
  if (pointerId === null || !frame.releasePointerCapture) return;
  try {
    if (frame.hasPointerCapture && !frame.hasPointerCapture(pointerId)) return;
    frame.releasePointerCapture(pointerId);
  } catch {}
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

function measureRegisteredViewportWidth(container: HTMLDivElement): number {
  const firstViewer = container.querySelector('[data-registered-viewer-frame="true"]');
  return firstViewer instanceof HTMLElement ? firstViewer.clientWidth : container.clientWidth;
}

function MetricCell({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: number | null;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wide text-fg-muted">{label}</div>
      <div data-testid={testId} className="font-mono text-[10px] leading-4 text-fg">
        {formatBp(value)}
      </div>
    </div>
  );
}

function formatBp(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} bp` : '--';
}

interface JunctionAssemblyHighlight {
  startRowPosition: number;
  endRowPosition: number;
  segments: JunctionAssemblyHighlightSegment[];
  cursors: JunctionAssemblyHighlightCursor[];
}

interface GibsonVirtualCut {
  id: 'gibson-resection';
  label: string;
  topBioCol: number;
  bottomBioCol: number;
  topRowPosition: number;
  bottomRowPosition: number;
}

function GibsonVirtualCutOverlay({
  row,
  cuts,
  height,
  pxPerBase,
  scrollLeft,
  screenXForBioCol,
  primers,
  extraLanes,
}: {
  row: JunctionWorkbenchRow;
  cuts: GibsonVirtualCut[];
  height: number;
  pxPerBase: number;
  scrollLeft: number;
  screenXForBioCol: (bioCol: number) => number;
  primers: PrimerDisplay[];
  extraLanes: SequenceExtraLane[];
}) {
  const layout = useMemo(
    () =>
      compute1DLayout({
        columnCount: row.sequence.length,
        annotations: row.annotations,
        pxPerBase,
        fullSequence: row.sequence,
        orfs: [],
        primers,
        showPrimers: primers.length > 0,
        showReverseComplement: true,
        showCutSites: false,
        showRuler: false,
        isCircular: false,
      }),
    [row.annotations, row.sequence, pxPerBase, primers]
  );
  const extrasHeight = useMemo(
    () => extraLanes.reduce((sum, lane) => sum + Math.max(0, lane.height), 0),
    [extraLanes]
  );
  const layoutTop = (height - (layout.totalHeight + extrasHeight)) / 2;
  const topY = round2(layoutTop + layout.sequenceRowY);
  const strandBoundaryY = round2(layoutTop + layout.sequenceRowY + layout.sequenceRowHeight);
  const bottomY = round2(layoutTop + layout.complementRowY + layout.sequenceRowHeight);

  return (
    <svg
      data-testid="gibson-virtual-cut-overlay"
      data-gibson-virtual-cut-count={cuts.length}
      aria-hidden="true"
      className="absolute inset-0 z-[30] pointer-events-none text-fg"
      height={height}
      width="100%"
      style={{ overflow: 'hidden' }}
    >
      {cuts.map((cut) => {
        const topX = round2(screenXForBioCol(cut.topBioCol) - scrollLeft);
        const bottomX = round2(screenXForBioCol(cut.bottomBioCol) - scrollLeft);
        const connector = topX === bottomX ? '' : ` L ${bottomX} ${strandBoundaryY}`;
        const d = `M ${topX} ${topY} L ${topX} ${strandBoundaryY}${connector} L ${bottomX} ${bottomY}`;
        return (
          <path
            key={cut.id}
            data-testid={`gibson-virtual-cut-${cut.id}`}
            data-gibson-virtual-cut-id={cut.id}
            data-gibson-virtual-cut-label={cut.label}
            data-top-bio-col={cut.topBioCol}
            data-bottom-bio-col={cut.bottomBioCol}
            data-top-row-position={cut.topRowPosition}
            data-bottom-row-position={cut.bottomRowPosition}
            data-top-y={topY}
            data-strand-boundary-y={strandBoundaryY}
            data-bottom-y={bottomY}
            data-canonical-d={d}
            data-canonical-top-bio-col={cut.topBioCol}
            data-canonical-bottom-bio-col={cut.bottomBioCol}
            data-canonical-top-row-position={cut.topRowPosition}
            data-canonical-bottom-row-position={cut.bottomRowPosition}
            data-canonical-overhang-direction={
              cut.topBioCol > cut.bottomBioCol ? 'three-prime' : 'five-prime'
            }
            data-overhang-direction={
              cut.topBioCol > cut.bottomBioCol ? 'three-prime' : 'five-prime'
            }
            d={d}
            fill="none"
            stroke="currentColor"
            strokeLinecap="square"
            strokeLinejoin="miter"
            strokeWidth={GIBSON_VIRTUAL_CUT_STROKE_WIDTH}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

function gibsonVirtualCutsForProductRow(row: JunctionWorkbenchRow): GibsonVirtualCut[] {
  if (row.kind !== 'product') return [];
  const constraint = row.constraints?.find((item) => item.kind === 'homology-width');
  if (!constraint) return [];
  const hasOverlapStart = constraint.overlapStartBioCol !== undefined;
  const hasOverlapEnd = constraint.overlapEndBioCol !== undefined;
  const usePrimerTailDerived = hasOverlapStart && hasOverlapEnd;
  const startBioCol = usePrimerTailDerived
    ? constraint.overlapStartBioCol!
    : constraint.startBioCol;
  const endBioCol = usePrimerTailDerived ? constraint.overlapEndBioCol! : constraint.endBioCol;
  if (endBioCol <= startBioCol) return [];
  const cuts = [
    gibsonVirtualCutForBioCols({
      row,
      id: 'gibson-resection',
      label: 'Gibson 3-prime resection',
      topBioCol: endBioCol,
      bottomBioCol: startBioCol,
    }),
  ];
  return cuts.filter((cut): cut is GibsonVirtualCut => cut !== null);
}

function gibsonVirtualCutForBioCols(input: {
  row: JunctionWorkbenchRow;
  id: GibsonVirtualCut['id'];
  label: string;
  topBioCol: number;
  bottomBioCol: number;
}): GibsonVirtualCut | null {
  const topRowPosition = rowBoundaryColumnForBioCol(input.row, input.topBioCol);
  const bottomRowPosition = rowBoundaryColumnForBioCol(input.row, input.bottomBioCol);
  if (!Number.isFinite(topRowPosition) || !Number.isFinite(bottomRowPosition)) return null;
  return {
    id: input.id,
    label: input.label,
    topBioCol: input.topBioCol,
    bottomBioCol: input.bottomBioCol,
    topRowPosition,
    bottomRowPosition,
  };
}

function rowBoundaryColumnForBioCol(row: JunctionWorkbenchRow, bioCol: number): number {
  return row.anchorRowPosition + bioCol;
}

function gibsonVirtualCutSignature(cuts: GibsonVirtualCut[]): string {
  return cuts.map((cut) => `${cut.id}:${cut.topRowPosition}:${cut.bottomRowPosition}`).join('|');
}

function assemblyHighlightForRow(input: {
  row: JunctionWorkbenchRow;
  scrollLeft: number;
  screenXForBioCol: (bioCol: number) => number;
}): JunctionAssemblyHighlight | null {
  const { row, scrollLeft, screenXForBioCol } = input;
  if (row.kind !== 'product') return null;
  const constraint = row.constraints?.find(
    (item) => item.kind === 'homology-width' || item.kind === 'fixed-overhang'
  );
  if (!constraint || constraint.endBioCol <= constraint.startBioCol) return null;
  const isGoldenGateOverhang = constraint.kind === 'fixed-overhang';

  const start = rowPositionForBioCol(row, constraint.startBioCol);
  const end = rowPositionForBioCol(row, constraint.endBioCol - 1);
  if (start === null || end === null) return null;

  const points = row.points
    .filter(
      (point) => point.bioCol >= constraint.startBioCol && point.bioCol < constraint.endBioCol
    )
    .sort((a, b) => a.bioCol - b.bioCol);
  if (points.length === 0) return null;

  const segments: JunctionAssemblyHighlightSegment[] = [];
  let currentOwner: JunctionAssemblyHighlightSegment['owner'] | null = null;
  let currentStartBioCol: number | null = null;
  let previousBioCol: number | null = null;

  const flush = () => {
    if (currentOwner === null || currentStartBioCol === null || previousBioCol === null) return;
    const color = productOwnerColor(row, currentOwner);
    const left = screenXForBioCol(currentStartBioCol) - scrollLeft;
    const right = screenXForBioCol(previousBioCol + 1) - scrollLeft;
    segments.push({
      id: `${currentOwner}:${currentStartBioCol}:${previousBioCol + 1}`,
      owner: currentOwner,
      left,
      width: Math.max(1, right - left),
      color,
      backgroundColor: colorWash(color, currentOwner === 'spacer' ? 0.2 : 0.28),
    });
  };

  for (const point of points) {
    const owner = productOwnerForPoint(row, point);
    const startsNewRun =
      currentOwner === null ||
      owner !== currentOwner ||
      previousBioCol === null ||
      point.bioCol !== previousBioCol + 1;
    if (startsNewRun) {
      flush();
      currentOwner = owner;
      currentStartBioCol = point.bioCol;
    }
    previousBioCol = point.bioCol;
  }
  flush();

  const leftOwner = productOwnerForPoint(row, points[0]);
  const rightOwner = productOwnerForPoint(row, points[points.length - 1]);
  const cursors: JunctionAssemblyHighlightCursor[] = isGoldenGateOverhang
    ? []
    : [
        {
          id: 'start',
          left: screenXForBioCol(constraint.startBioCol) - scrollLeft,
          color: productOwnerColor(row, leftOwner),
          label: `${constraint.label} start`,
        },
        {
          id: 'end',
          left: screenXForBioCol(constraint.endBioCol) - scrollLeft,
          color: productOwnerColor(row, rightOwner),
          label: `${constraint.label} end`,
        },
      ];

  return {
    startRowPosition: Math.min(start, end),
    endRowPosition: Math.max(start, end),
    segments,
    cursors,
  };
}

function rowPositionForBioCol(row: JunctionWorkbenchRow, bioCol: number): number | null {
  const point = row.points.find((item) => item.bioCol === bioCol);
  return point?.rowPosition ?? null;
}
