import {
  inputTargetAllows,
  captureInputOwnership,
  subscribeInputRevocation,
} from '@waypoint/platform/input-ownership';
import { cdsPresentationGeometry } from '../cds-presentation';
import { rowHitY, rowPaintY } from '../predictive-wrap-layout';

import React, { useCallback, useMemo, useEffect } from 'react';
import { useHoveredAnnotation, useHoveredAnnotationStore } from '../hovered-annotation-store';
import { useHoveredCodon, useHoveredCodonStore } from '../hovered-codon-store';
import { shouldExposeCanvasDiagnosticsSurface } from '../canvas-test-bridge';
import {
  arrowHitTest,
  cdsExtensionOriginalBounds,
  isCdsExtensionPreview,
  isPredictedCodonCell,
  positionWithinCdsBounds,
} from '../cds-extension-affordance';
import type { CdsExtensionArrowBounds } from '../cds-extension-affordance';
import { useCdsExtensionHoverStore } from '../cds-extension-hover-store';
import {
  findResidueSelectionForMolecule,
  replaceResidueSelectionForMolecule,
  useResidueSelectionsStore,
  type ResidueSelection,
} from '../residue-selection-store';
import {
  buildResidueSelectionForCdsCodon,
  buildResidueSelectionForCdsCodonRange,
  type CdsCodonSelectionHit,
} from '../residue-selection-from-cds';
import {
  cutSiteRecognitionSelection,
  type Annotation,
  type ColoredCutSite,
  type ORF,
} from '@waypoint/sequence-utils';
import type {
  LayoutSnapshot2D,
  WorkspaceEditorConfig,
  Selection,
  InsertedRange,
  DeletedRange,
  PrimerDisplay,
  RenderedGGProductLabel,
  CoordinateSpace,
  ClassifiedCDS,
} from '../types';
import { detectCutSiteLabelHit, detectGGLabelHit } from '../hit-detection';
import {
  canvasAnnotationPointer,
  canvasFallbackCursor,
  applyCanvasHoverCursorOnMove,
  applyNonEdgeCanvasHover,
  tryApplyCanvasHandleDragOnMove,
  tryCommitCanvasLabelHit,
  ggLabelScarSelection,
  hoverCursorChanged,
  hoverCursorForMove,
  nextHoveredCodon,
  nucleotideShiftClickSelection,
  primerHitAtPoint,
  resolveOptionalHover,
  sameAnnotationIdentity,
  sameIntervalStrand,
  shiftPreviewForMove,
  translationIntronUnderCursor,
  tryDeferAnnotationOrIntronMouseDown,
  tryHandleShiftClickAnnotationMouseDown,
  tryHandleShiftClickCodonMouseDown,
} from './canvas-interaction-pointer';
import type { RenderedCutSite } from '../restriction-enzymes/drawCutSites';
import { createSelectionFromAnnotation } from '../selection-model';
import {
  canvasPointFromClient,
  getLineAndPosition,
  getCursorPositionFromX,
  findLineAtY,
  detectAnnotationHit,
  detectCDSLabelHit,
  detectCodonHit,
  detectOrfCodonHit,
  detectHandleHit,
  isOnNucleotideRow,
  calculateLineTrackBounds,
  type HitDetectionConfig,
} from '../hit-detection';
import { calculateOrfHeight } from '../orf-drawing';
import { resolveAnnotationTarget } from '../resolve-annotation-target';
import {
  resolvePointerSelection,
  annotationIdentityEqual,
  orfIdentityEqual,
  type PointerSelectionResult,
} from '../pointer-selection';
import { findOrfAtPoint } from '../orf-hit-test';
import { TRANSLATION_AA_HEIGHT_RATIO } from '../layout-constants';
import { hasPlatformCommandModifier, isAppleControlPrimaryClick } from '../platform-modifiers';
import type { PrecomputedLinePosition } from './usePrecomputedLayout';

function copySelectionRange(range: Selection | null | undefined): Selection | null {
  return range
    ? { start: range.start, end: range.end, ...(range.wraps ? { wraps: true } : {}) }
    : null;
}

function calculateCircularDragDelta(
  position: number,
  lastPos: number,
  sequenceLength: number
): number {
  let delta = position - lastPos;
  if (delta > sequenceLength / 2) {
    delta -= sequenceLength;
  } else if (delta < -sequenceLength / 2) {
    delta += sequenceLength;
  }
  return delta;
}

function buildCircularDragSelection(
  anchor: number,
  position: number,
  cumulativeDelta: number,
  sequenceLength: number
): Selection {
  if (cumulativeDelta >= 0) {
    if (position >= anchor) {
      return { start: anchor, end: position };
    } else {
      return { start: anchor, end: position, wraps: true };
    }
  } else {
    const adjustedAnchor =
      position !== anchor ? (anchor - 1 + sequenceLength) % sequenceLength : anchor;
    if (position <= adjustedAnchor) {
      return { start: position, end: adjustedAnchor };
    } else {
      return { start: position, end: adjustedAnchor, wraps: true };
    }
  }
}

function computeDragSelection(
  anchor: number,
  position: number,
  isCircular: boolean,
  sequenceLength: number,
  lastPosRef: React.MutableRefObject<number | null>,
  cumulativeDeltaRef: React.MutableRefObject<number>
): Selection {
  if (isCircular && sequenceLength > 0) {
    const lastPos = lastPosRef.current ?? anchor;
    const delta = calculateCircularDragDelta(position, lastPos, sequenceLength);
    cumulativeDeltaRef.current += delta;
    lastPosRef.current = position;
    return buildCircularDragSelection(anchor, position, cumulativeDeltaRef.current, sequenceLength);
  }
  if (position < anchor) {
    const adjustedAnchor = anchor > 0 ? anchor - 1 : anchor;
    return { start: position, end: adjustedAnchor };
  }
  return { start: anchor, end: position };
}

function isSecondaryClickIntent(event: React.MouseEvent<HTMLCanvasElement>): boolean {
  return event.button === 2 || isAppleControlPrimaryClick(event);
}

function isResidueSelectionClickIntent(event: React.MouseEvent<HTMLCanvasElement>): boolean {
  return event.button === 0 && hasPlatformCommandModifier(event);
}

interface CdsResidueSelectionAnchor {
  referenceId: string;
  codon: CdsCodonSelectionHit;
  selection: ResidueSelection;
}

function publishResidueSelectionPointerDebug(payload: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const w = window as typeof window & {
    __test?: { residueSelectionPointerDebug?: Record<string, unknown> };
  };
  if (!w.__test) return;
  w.__test.residueSelectionPointerDebug = payload;
}

interface UseCanvasInteractionParams {
  selectionCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.MutableRefObject<{ scrollTop: number; height: number }>;
  drawFnRef: React.MutableRefObject<(() => void) | null>;
  drawRafRef: React.MutableRefObject<number | null>;
  canvasRectRef: React.MutableRefObject<DOMRect | null>;
  hoverCursorRef: React.MutableRefObject<{ x: number; lineIdx: number } | null>;
  drawSelectionAndCursorRef: React.MutableRefObject<
    (
      sel: Selection | null,
      cursorPos: number | undefined,
      showCursor: boolean,
      ranges?: InsertedRange[],
      delRanges?: DeletedRange[],
      hoverCursor?: { x: number; lineIdx: number } | null
    ) => void
  >;
  drawSelectionDirect: (
    sel: Selection | null,
    hoverCursor?: { x: number; lineIdx: number } | null
  ) => void;

  isSelectingRef: React.MutableRefObject<boolean>;
  selectionAnchorRef: React.MutableRefObject<number | null>;
  liveSelectionRef: React.MutableRefObject<Selection | null>;
  editLastDragPositionRef: React.MutableRefObject<number | null>;
  editCumulativeDragDeltaRef: React.MutableRefObject<number>;
  isHighlightingRef: React.MutableRefObject<boolean>;
  highlightAnchorRef: React.MutableRefObject<number | null>;
  lastDragPositionRef: React.MutableRefObject<number | null>;
  cumulativeDragDeltaRef: React.MutableRefObject<number>;
  highlightedRangeRef: React.MutableRefObject<Selection | null>;
  isDraggingHandleRef: React.MutableRefObject<'start' | 'end' | null>;
  handleDragAnchorRef: React.MutableRefObject<number | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  cursorRef: React.MutableRefObject<number | undefined>;
  cursorVisibleRef: React.MutableRefObject<boolean>;
  insertedRangesRef: React.MutableRefObject<InsertedRange[]>;
  deletedRangesRef: React.MutableRefObject<DeletedRange[]>;

  renderedPrimersRef: React.MutableRefObject<
    Array<{ primer: PrimerDisplay; x: number; y: number; width: number; height: number }>
  >;
  renderedGGLabelsRef: React.MutableRefObject<RenderedGGProductLabel[]>;
  renderedCdsExtensionArrowsRef: React.MutableRefObject<CdsExtensionArrowBounds[]>;

  onCdsExtensionAnchor?: (bp: number | null) => void;
  renderedCutSitesRef: React.MutableRefObject<RenderedCutSite[]>;

  layout: LayoutSnapshot2D;

  paintLayout?: LayoutSnapshot2D;
  config: WorkspaceEditorConfig;
  precomputedLinePositions: PrecomputedLinePosition[];
  linePrimerFlagsMap: Map<
    LayoutSnapshot2D['lines'][0],
    { hasForwardPrimers: boolean; hasReversePrimers: boolean }
  >;
  sequenceLength: number;

  editable: boolean;
  selection?: Selection | null;
  cursor?: number;
  viewCursor?: number | null;
  highlightedRange?: Selection | null;
  showCutSites: boolean;
  coordinateSpace?: CoordinateSpace;
  orfs?: ORF[];
  selectedAnnotation?: AnnotationIdentity | null;

  residueSelectionReferenceId?: string | null;

  fullSequence: string;

  onSelectionChange?: (selection: Selection | null) => void;
  onCursorChange?: (position: number) => void;
  onViewCursorChange?: (position: number | null) => void;
  onHighlightedRangeChange?: (range: Selection | null) => void;
  onHighlightedRangePreview?: (range: Selection | null) => void;
  onCutSiteClick?: (cutSite: ColoredCutSite) => void;
  onCutSiteDoubleClick?: (cutSite: ColoredCutSite) => void;
  onGGLabelClick?: (junctionIndex: number) => void;
  onSelectedAnnotationChange?: (annotation: AnnotationIdentity | null) => void;
  onContextMenu?: (
    event: React.MouseEvent,
    selection: Selection | null,
    contextInfo: {
      isOnNucleotideRow: boolean;
      position: number | null;
      annotation: Annotation | null;
      translatedCDS?: Annotation | null;
      orf?: ORF | null;
      primer?: PrimerDisplay | null;
    }
  ) => void;
  onDragScroll?: (clientY: number, isDragging: boolean) => void;

  shiftPreviewRef: React.MutableRefObject<{
    hoverPosition: number;
    anchorPosition: number;
    isOptionHeld: boolean;
  } | null>;
}

export interface OrfIdentity {
  start: number;

  end: number;
  strand: '+' | '-';
}

export interface AnnotationIdentity {
  type: string;
  name: string;
  start: number;
  end: number;
  direction?: number;
}

interface UseCanvasInteractionResult {
  handleMouseDown: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  handleMouseMove: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  handleMouseUp: () => void;
  handleClick: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  handleDoubleClick: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  handleContextMenu: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  handleMouseLeave: () => void;
  hoveredCutSite: ColoredCutSite | null;
  hoveredCodon: { start: number; end: number; strand: 1 | -1 } | null;

  hoveredOrf: OrfIdentity | null;

  selectedOrf: OrfIdentity | null;

  hoveredAnnotation: AnnotationIdentity | null;

  selectedAnnotation: AnnotationIdentity | null;
  hoveredPrimer: PrimerDisplay | null;
  selectedPrimer: PrimerDisplay | null;
  primerTooltipPos: { x: number; y: number } | null;

  annotationTooltipPos: { x: number; y: number; position: number | null } | null;
  hoveredGGProductLabel: RenderedGGProductLabel | null;
  shiftPreview: {
    hoverPosition: number;
    anchorPosition: number;
    isOptionHeld: boolean;
  } | null;
}

export function useCanvasInteraction({
  selectionCanvasRef,
  viewportRef,
  drawFnRef,
  drawRafRef,
  canvasRectRef,
  hoverCursorRef,
  drawSelectionAndCursorRef,
  drawSelectionDirect,
  isSelectingRef,
  selectionAnchorRef,
  liveSelectionRef,
  editLastDragPositionRef,
  editCumulativeDragDeltaRef,
  isHighlightingRef,
  highlightAnchorRef,
  lastDragPositionRef,
  cumulativeDragDeltaRef,
  highlightedRangeRef,
  isDraggingHandleRef,
  handleDragAnchorRef,
  mouseDownPosRef,
  cursorRef,
  cursorVisibleRef,
  insertedRangesRef,
  deletedRangesRef,
  renderedPrimersRef,
  renderedGGLabelsRef,
  renderedCdsExtensionArrowsRef,
  onCdsExtensionAnchor,
  renderedCutSitesRef,
  layout,
  paintLayout,
  config,
  precomputedLinePositions,
  linePrimerFlagsMap,
  sequenceLength,
  editable,
  selection,
  cursor,
  viewCursor,
  highlightedRange,
  showCutSites,
  coordinateSpace,
  orfs,
  selectedAnnotation: controlledSelectedAnnotation,
  residueSelectionReferenceId,
  fullSequence,
  onSelectionChange,
  onCursorChange,
  onViewCursorChange,
  onHighlightedRangeChange,
  onHighlightedRangePreview,
  onCutSiteClick,
  onCutSiteDoubleClick,
  onGGLabelClick,
  onSelectedAnnotationChange,
  onContextMenu,
  onDragScroll,
  shiftPreviewRef,
}: UseCanvasInteractionParams): UseCanvasInteractionResult {
  const [hoveredCutSite, setHoveredCutSite] = React.useState<ColoredCutSite | null>(null);

  const [hoveredPrimer, setHoveredPrimer] = React.useState<PrimerDisplay | null>(null);
  const [selectedPrimer, setSelectedPrimer] = React.useState<PrimerDisplay | null>(null);
  const [primerTooltipPos, setPrimerTooltipPos] = React.useState<{ x: number; y: number } | null>(
    null
  );

  const [annotationTooltipPos, setAnnotationTooltipPos] = React.useState<{
    x: number;
    y: number;
    position: number | null;
  } | null>(null);

  const [hoveredGGProductLabel, setHoveredGGProductLabel] =
    React.useState<RenderedGGProductLabel | null>(null);

  const hoveredCodon = useHoveredCodon();
  const hoveredCodonStore = useHoveredCodonStore();
  const cdsExtensionHoverStore = useCdsExtensionHoverStore();

  useEffect(() => {
    if (typeof window === 'undefined' || !cdsExtensionHoverStore) return;
    if (!shouldExposeCanvasDiagnosticsSurface()) return;
    const w = window as unknown as {
      __cdsExtensionActive?: () => { cdsKey: string; direction: string } | null;
      __hoveredCodon?: () => unknown;
    };
    const read = () => cdsExtensionHoverStore.getSnapshot();

    const readCodon = () => hoveredCodonStore?.getSnapshot() ?? null;
    w.__hoveredCodon = readCodon;
    w.__cdsExtensionActive = read;
    return () => {
      if (w.__cdsExtensionActive === read) delete w.__cdsExtensionActive;
      if (w.__hoveredCodon === readCodon) delete w.__hoveredCodon;
    };
  }, [cdsExtensionHoverStore, hoveredCodonStore]);
  const residueSelectionsStore = useResidueSelectionsStore();
  const residueSelectionAnchorRef = React.useRef<CdsResidueSelectionAnchor | null>(null);
  const lastLocalHoveredCodonRef = React.useRef<{
    start: number;
    end: number;
    strand: 1 | -1;
  } | null>(null);
  const setHoveredCodon = useCallback(
    (
      next:
        | { start: number; end: number; strand: 1 | -1 }
        | null
        | ((
            prev: { start: number; end: number; strand: 1 | -1 } | null
          ) => { start: number; end: number; strand: 1 | -1 } | null)
    ) => {
      const store = hoveredCodonStore;
      if (!store) return;
      const prev = store.getSnapshot();
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (resolved) {
        lastLocalHoveredCodonRef.current = resolved;
        store.set({ ...resolved, source: 'sequence' });
        return;
      }
      const lastLocal = lastLocalHoveredCodonRef.current;
      lastLocalHoveredCodonRef.current = null;
      if (
        prev?.source === 'sequence' &&
        lastLocal &&
        prev.start === lastLocal.start &&
        prev.end === lastLocal.end &&
        prev.strand === lastLocal.strand
      ) {
        store.set(null);
      }
    },
    [hoveredCodonStore]
  );

  const [hoveredOrf, setHoveredOrf] = React.useState<OrfIdentity | null>(null);
  const [selectedOrf, setSelectedOrf] = React.useState<OrfIdentity | null>(null);

  const hoveredAnnotation = useHoveredAnnotation();
  const hoveredAnnotationStore = useHoveredAnnotationStore();
  const setHoveredAnnotation = useCallback(
    (
      next:
        | AnnotationIdentity
        | null
        | ((prev: AnnotationIdentity | null) => AnnotationIdentity | null)
    ) => {
      const store = hoveredAnnotationStore;
      if (!store) return;
      const prev = store.getSnapshot();
      const resolved = typeof next === 'function' ? next(prev) : next;

      store.set(resolved);
    },
    [hoveredAnnotationStore]
  );
  const [uncontrolledSelectedAnnotation, setUncontrolledSelectedAnnotation] =
    React.useState<AnnotationIdentity | null>(null);
  const selectedAnnotation =
    controlledSelectedAnnotation !== undefined
      ? controlledSelectedAnnotation
      : uncontrolledSelectedAnnotation;
  const selectedAnnotationRef = React.useRef<AnnotationIdentity | null>(selectedAnnotation);
  useEffect(() => {
    selectedAnnotationRef.current = selectedAnnotation;
    if (selectedAnnotation) {
      setSelectedOrf((prev) => (prev === null ? prev : null));
    }
  }, [
    selectedAnnotation?.type,
    selectedAnnotation?.name,
    selectedAnnotation?.start,
    selectedAnnotation?.end,
    selectedAnnotation?.direction,
  ]);

  const [shiftPreview, setShiftPreview] = React.useState<{
    hoverPosition: number;
    anchorPosition: number;
    isOptionHeld: boolean;
  } | null>(null);
  shiftPreviewRef.current = shiftPreview;

  const hitDetectionConfig = useMemo(
    (): HitDetectionConfig => ({
      showAnnotations: config.showAnnotations,
      showTranslation: config.showTranslation,
      showPrimers: config.showPrimers,
      marginLeft: config.marginLeft,
      charWidth: config.charWidth,
      rowHeight: config.rowHeight,
      showResidueNumbers: config.showResidueNumbers,
      cdsDetailProgress: config.cdsDetailProgress,
      cdsZoomPresentation: config.cdsZoomPresentation,
      lodLevel: config.lodLevel,
    }),
    [
      config.showAnnotations,
      config.showTranslation,
      config.showPrimers,
      config.marginLeft,
      config.charWidth,
      config.rowHeight,
      config.showResidueNumbers,
      config.cdsDetailProgress,
      config.cdsZoomPresentation,
      config.lodLevel,
    ]
  );

  const getLineAndPositionFromEvent = useCallback(
    (
      event: React.MouseEvent<HTMLCanvasElement>
    ): {
      line: (typeof layout.lines)[0] | null;
      position: number | null;
      cursorPosition: number | null;
      x: number;
      y: number;
    } => {
      const canvas = selectionCanvasRef.current;
      if (!canvas) return { line: null, position: null, cursorPosition: null, x: 0, y: 0 };

      const rect = canvasRectRef.current || canvas.getBoundingClientRect();
      const { x, y: canvasY } = canvasPointFromClient(event.clientX, event.clientY, rect);
      const scrollTop = viewportRef.current.scrollTop;

      const result = getLineAndPosition(
        x,
        canvasY,
        scrollTop,
        layout.lines,
        layout.totalHeight,
        hitDetectionConfig,
        sequenceLength
      );

      if (!result) {
        const contentY = canvasY + scrollTop;
        const clickedLine = findLineAtY(contentY, layout.lines, layout.totalHeight);
        return {
          line: clickedLine,
          position: null,
          cursorPosition: null,
          x: x - (clickedLine?.xOffset ?? 0),
          y: clickedLine ? rowHitY(clickedLine, canvasY + scrollTop) - scrollTop : canvasY,
        };
      }

      return {
        line: result.line,
        position: result.position,
        cursorPosition: getCursorPositionFromX(x, result.line, hitDetectionConfig),
        x: x - (result.line.xOffset ?? 0),
        y: rowHitY(result.line, canvasY + scrollTop) - scrollTop,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, hitDetectionConfig, sequenceLength]
  );

  const pointerPaintY = (line: (typeof layout.lines)[0] | null, y: number): number =>
    line ? rowPaintY(line, y + viewportRef.current.scrollTop) - viewportRef.current.scrollTop : y;
  const pointerPaintX = (line: (typeof layout.lines)[0] | null, x: number): number =>
    x + (line?.xOffset ?? 0);
  const targetLayout = paintLayout ?? layout;
  const targetOffsetByLineIndex = useMemo(
    () => new Map(targetLayout.lines.map((line) => [line.lineIndex, line.xOffset ?? 0])),
    [targetLayout]
  );

  const pointerTargetX = (line: (typeof layout.lines)[0] | null, x: number): number =>
    line ? x + (targetOffsetByLineIndex.get(line.lineIndex) ?? line.xOffset ?? 0) : x;

  const isClickOnNucleotideRow = useCallback(
    (line: (typeof layout.lines)[0], mouseY: number): boolean => {
      const scrollTop = viewportRef.current.scrollTop;
      const flags = linePrimerFlagsMap.get(line);

      return isOnNucleotideRow(
        mouseY,
        scrollTop,
        line,
        hitDetectionConfig,
        config.showReverseComplement,
        flags?.hasForwardPrimers ?? false,
        flags?.hasReversePrimers ?? false
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hitDetectionConfig, config.showReverseComplement, linePrimerFlagsMap]
  );

  const detectOrfAtCanvasPoint = useCallback(
    (line: (typeof layout.lines)[0], position: number, mouseY: number): OrfIdentity | null => {
      if (!orfs || orfs.length === 0) return null;
      const lp = precomputedLinePositions.find((p) => p.line === line);
      if (!lp) return null;
      const contentY = mouseY + viewportRef.current.scrollTop;
      const fwdHeight = calculateOrfHeight(lp.forwardOrfLaneCount, config.rowHeight);
      const revHeight = calculateOrfHeight(lp.reverseOrfLaneCount, config.rowHeight);
      const laneHeight = config.rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
      const hit = findOrfAtPoint(
        {
          bandY: lp.forwardOrfY,
          bandHeight: fwdHeight,
          laneCount: lp.forwardOrfLaneCount,
          laneHeight,
          orfs: line.forwardOrfs ?? [],
        },
        {
          bandY: lp.reverseOrfY,
          bandHeight: revHeight,
          laneCount: lp.reverseOrfLaneCount,
          laneHeight,
          orfs: line.reverseOrfs ?? [],
        },
        contentY,
        position
      );
      return hit ? { start: hit.start, end: hit.end, strand: hit.strand } : null;
    },
    [orfs, precomputedLinePositions, config.rowHeight, viewportRef]
  );

  const getAnnotationAtPosition = useCallback(
    (
      line: (typeof layout.lines)[0],
      mouseX: number,
      mouseY: number
    ): (Annotation & { hitStart?: number; hitEnd?: number }) | null => {
      const scrollTop = viewportRef.current.scrollTop;
      const contentY = mouseY + scrollTop;
      const flags = linePrimerFlagsMap.get(line);

      const bounds = calculateLineTrackBounds(
        line,
        hitDetectionConfig,
        config.showReverseComplement,
        flags?.hasForwardPrimers ?? false,
        flags?.hasReversePrimers ?? false
      );

      const hit = detectAnnotationHit(
        mouseX,
        contentY,
        line,
        bounds,
        hitDetectionConfig,
        sequenceLength
      );
      if (hit) return { ...hit.annotation, hitStart: hit.start, hitEnd: hit.end };

      const cdsHit = detectCDSLabelHit(
        mouseX,
        contentY,
        line,
        bounds,
        hitDetectionConfig,
        sequenceLength
      );
      if (cdsHit) return { ...cdsHit.annotation, hitStart: cdsHit.start, hitEnd: cdsHit.end };
      return null;
    },
    [hitDetectionConfig, config.showReverseComplement, linePrimerFlagsMap, sequenceLength]
  );

  const getAminoAcidAtPosition = useCallback(
    (
      line: (typeof layout.lines)[0],
      mouseX: number,
      mouseY: number
    ): {
      start: number;
      end: number;
      strand: 1 | -1;
      isOverlayClick: boolean;
      residueIndex?: number;
      parentRange?: { start: number; end: number };
    } | null => {
      const scrollTop = viewportRef.current.scrollTop;
      const contentY = mouseY + scrollTop;
      const flags = linePrimerFlagsMap.get(line);

      const bounds = calculateLineTrackBounds(
        line,
        hitDetectionConfig,
        config.showReverseComplement,
        flags?.hasForwardPrimers ?? false,
        flags?.hasReversePrimers ?? false
      );

      const alignmentModeOptions =
        coordinateSpace?.mode === 'gapped' &&
        coordinateSpace?.gappedSequence &&
        coordinateSpace?.alignedQuery
          ? {
              alignedRef: coordinateSpace.gappedSequence,
              alignedQuery: coordinateSpace.alignedQuery,
            }
          : undefined;

      if (config.showTranslation) {
        const hit = detectCodonHit(
          mouseX,
          contentY,
          line,
          bounds,
          hitDetectionConfig,
          sequenceLength,
          alignmentModeOptions
        );

        if (hit) {
          let parentRange: { start: number; end: number } | undefined;
          if (!hit.isOverlayClick) {
            const cds = (line.classifiedCDSs || []).find((c) => {
              const cdsStart = c.start - 1;
              const cdsEnd = c.end;
              if (c.start > c.end) {
                return hit.start >= cdsStart || hit.end < cdsEnd;
              }
              return hit.start >= cdsStart && hit.end < cdsEnd;
            });
            if (cds) {
              parentRange = { start: cds.start - 1, end: cds.end - 1 };
            }
          }
          return {
            start: hit.start,
            end: hit.end,
            strand: hit.strand,
            isOverlayClick: hit.isOverlayClick,
            residueIndex: hit.residueIndex,
            parentRange,
          };
        }
      }

      const lp = precomputedLinePositions.find((p) => p.line === line);
      if (lp) {
        if (lp.forwardOrfLaneCount > 0 && line.forwardOrfs) {
          const orfTrackHeight = calculateOrfHeight(lp.forwardOrfLaneCount, config.rowHeight);
          const orfHit = detectOrfCodonHit(
            mouseX,
            contentY,
            lp.forwardOrfY,
            orfTrackHeight,
            line.forwardOrfs,
            line,
            hitDetectionConfig,
            alignmentModeOptions
          );
          if (orfHit) {
            return {
              start: orfHit.start,
              end: orfHit.end,
              strand: orfHit.strand,
              isOverlayClick: false,
              parentRange: { start: orfHit.parentStart, end: orfHit.parentEnd },
            };
          }
        }

        if (lp.reverseOrfLaneCount > 0 && line.reverseOrfs) {
          const orfTrackHeight = calculateOrfHeight(lp.reverseOrfLaneCount, config.rowHeight);
          const orfHit = detectOrfCodonHit(
            mouseX,
            contentY,
            lp.reverseOrfY,
            orfTrackHeight,
            line.reverseOrfs,
            line,
            hitDetectionConfig,
            alignmentModeOptions
          );
          if (orfHit) {
            return {
              start: orfHit.start,
              end: orfHit.end,
              strand: orfHit.strand,
              isOverlayClick: false,
              parentRange: { start: orfHit.parentStart, end: orfHit.parentEnd },
            };
          }
        }
      }

      return null;
    },
    [
      hitDetectionConfig,
      config.showReverseComplement,
      config.showTranslation,
      config.rowHeight,
      linePrimerFlagsMap,
      sequenceLength,
      coordinateSpace,
      precomputedLinePositions,
    ]
  );

  const detectAnnotationTargetAtPosition = useCallback(
    (
      line: (typeof layout.lines)[0],
      mouseX: number,
      mouseY: number,
      position: number | null,
      codon: { parentRange?: { start: number; end: number } } | null
    ): AnnotationIdentity | null => {
      const annotationHit = config.showAnnotations
        ? getAnnotationAtPosition(line, mouseX, mouseY)
        : null;

      const cdsAnns = (line as { classifiedCDSs?: ClassifiedCDS[] }).classifiedCDSs ?? [];
      const parentCdsForCodon = codon?.parentRange
        ? (cdsAnns.find(
            (c) => c.start - 1 === codon.parentRange?.start && c.end - 1 === codon.parentRange?.end
          ) ?? null)
        : null;

      return resolveAnnotationTarget({
        annotationHit,
        parentCdsForCodon,
        classifiedCDSs: cdsAnns,
        position,
        showAnnotations: !!config.showAnnotations,
        showTranslation: !!config.showTranslation,
      });
    },
    [config.showAnnotations, config.showTranslation, getAnnotationAtPosition]
  );

  const pointerOverExtensionPreview = useCallback(
    (line: (typeof layout.lines)[0] | null, x: number, y: number): boolean => {
      if (!line) return false;
      const cdsList = (line as { classifiedCDSs?: ClassifiedCDS[] }).classifiedCDSs ?? [];
      const preview = cdsList.find((a) => isCdsExtensionPreview(a));
      if (!preview) return false;
      const annotation = getAnnotationAtPosition(line, x, y);
      if (annotation && isCdsExtensionPreview(annotation)) return true;
      const codon = getAminoAcidAtPosition(line, x, y);
      if (!codon) return false;

      return (
        positionWithinCdsBounds(preview, codon.start) || positionWithinCdsBounds(preview, codon.end)
      );
    },
    [getAnnotationAtPosition, getAminoAcidAtPosition]
  );

  const pointerOnUnsavedExtension = useCallback(
    (line: (typeof layout.lines)[0] | null, x: number, y: number): boolean => {
      if (
        arrowHitTest(
          renderedCdsExtensionArrowsRef.current,
          pointerTargetX(line, x),
          pointerPaintY(line, y)
        )
      )
        return true;
      if (!line) return false;

      const cdsList = (line as { classifiedCDSs?: ClassifiedCDS[] }).classifiedCDSs ?? [];
      const preview = cdsList.find((a) => isCdsExtensionPreview(a));
      if (!preview) return false;
      const original = cdsExtensionOriginalBounds(preview);
      const codon = getAminoAcidAtPosition(line, x, y);
      if (!original || !codon) return false;
      return isPredictedCodonCell(original, { genomicStart: codon.start, genomicEnd: codon.end });
    },
    [getAminoAcidAtPosition, renderedCdsExtensionArrowsRef]
  );

  const applyPointerSelection = useCallback(
    (result: PointerSelectionResult) => {
      setSelectedOrf((prev) => (orfIdentityEqual(prev, result.orf) ? prev : result.orf));
      if (controlledSelectedAnnotation === undefined) {
        setUncontrolledSelectedAnnotation((prev) =>
          annotationIdentityEqual(prev, result.annotation) ? prev : result.annotation
        );
      }
      if (!annotationIdentityEqual(selectedAnnotationRef.current, result.annotation)) {
        selectedAnnotationRef.current = result.annotation;
        onSelectedAnnotationChange?.(result.annotation);
      }
    },
    [controlledSelectedAnnotation, onSelectedAnnotationChange]
  );

  const gatherAnnotationHits = useCallback(
    (
      line: (typeof layout.lines)[0],
      mouseX: number,
      mouseY: number,
      codon: { parentRange?: { start: number; end: number } } | null
    ) => {
      const annotationHit = config.showAnnotations
        ? getAnnotationAtPosition(line, mouseX, mouseY)
        : null;
      const cdsAnns = (line as { classifiedCDSs?: ClassifiedCDS[] }).classifiedCDSs ?? [];
      const parentCdsForCodon = codon?.parentRange
        ? (cdsAnns.find(
            (c) => c.start - 1 === codon.parentRange?.start && c.end - 1 === codon.parentRange?.end
          ) ?? null)
        : null;
      return { annotationHit, parentCdsForCodon, classifiedCDSs: cdsAnns };
    },
    [config.showAnnotations, getAnnotationAtPosition]
  );

  const getResidueSelectionCodonAtPosition = useCallback(
    (
      line: (typeof layout.lines)[0],
      mouseX: number,
      mouseY: number
    ): {
      start: number;
      end: number;
      strand: 1 | -1;
      isOverlayClick: boolean;
      residueIndex?: number;
      parentRange?: { start: number; end: number };
    } | null => {
      const exactCodon = getAminoAcidAtPosition(line, mouseX, mouseY);
      if (exactCodon && !exactCodon.isOverlayClick) return exactCodon;
      if (coordinateSpace?.mode === 'gapped' || !config.showTranslation) return exactCodon;

      const scrollTop = viewportRef.current.scrollTop;
      const contentY = mouseY + scrollTop;
      const relativeY = contentY - line.y;
      const flags = linePrimerFlagsMap.get(line);
      const bounds = calculateLineTrackBounds(
        line,
        hitDetectionConfig,
        config.showReverseComplement,
        flags?.hasForwardPrimers ?? false,
        flags?.hasReversePrimers ?? false
      );

      const cdsAnns = (line as { classifiedCDSs?: ClassifiedCDS[] }).classifiedCDSs ?? [];
      for (const cds of cdsAnns) {
        const lane = cds.translationLane ?? -1;
        if (lane < 0) continue;
        const pose = cdsPresentationGeometry(
          cds,
          bounds.translationY,
          bounds.annotationY,
          hitDetectionConfig
        );
        if (pose.aaHeight <= 0 || relativeY < pose.labelY || relativeY > pose.aaY + pose.aaHeight)
          continue;

        const hit = detectCodonHit(
          mouseX,
          line.y + pose.aaY + pose.aaHeight / 2,
          { ...line, classifiedCDSs: [cds] },
          bounds,
          hitDetectionConfig,
          sequenceLength
        );

        if (hit && !hit.isOverlayClick) {
          return {
            start: hit.start,
            end: hit.end,
            strand: hit.strand,
            isOverlayClick: hit.isOverlayClick,
            residueIndex: hit.residueIndex,
            parentRange: { start: cds.start - 1, end: cds.end - 1 },
          };
        }
      }

      return exactCodon;
    },
    [
      config.showReverseComplement,
      config.showTranslation,
      coordinateSpace?.mode,
      getAminoAcidAtPosition,
      hitDetectionConfig,
      linePrimerFlagsMap,
      sequenceLength,
    ]
  );

  const toggleResidueSelectionAtPoint = useCallback(
    (
      line: (typeof layout.lines)[0],
      mouseX: number,
      mouseY: number,
      extendRange: boolean
    ): boolean => {
      const referenceId = residueSelectionReferenceId;
      if (!referenceId || coordinateSpace?.mode === 'gapped' || !residueSelectionsStore) {
        publishResidueSelectionPointerDebug({
          stage: 'toggle',
          result: false,
          reason: !referenceId
            ? 'missing-reference-id'
            : coordinateSpace?.mode === 'gapped'
              ? 'gapped-coordinate-space'
              : 'missing-store',
          referenceId: referenceId ?? null,
          coordinateMode: coordinateSpace?.mode ?? null,
          hasStore: !!residueSelectionsStore,
        });
        return false;
      }
      const codon = getResidueSelectionCodonAtPosition(line, mouseX, mouseY);
      if (!codon || codon.isOverlayClick) {
        publishResidueSelectionPointerDebug({
          stage: 'toggle',
          result: false,
          reason: !codon ? 'missing-codon' : 'overlay-click',
          referenceId,
          coordinateMode: coordinateSpace?.mode ?? null,
          hasStore: true,
          mouseX,
          mouseY,
          codon: codon ?? null,
        });
        return false;
      }
      const { parentCdsForCodon } = gatherAnnotationHits(line, mouseX, mouseY, codon);
      if (!parentCdsForCodon) {
        publishResidueSelectionPointerDebug({
          stage: 'toggle',
          result: false,
          reason: 'missing-parent-cds',
          referenceId,
          coordinateMode: coordinateSpace?.mode ?? null,
          hasStore: true,
          mouseX,
          mouseY,
          codon,
          classifiedCdsCount: ((line as { classifiedCDSs?: ClassifiedCDS[] }).classifiedCDSs ?? [])
            .length,
        });
        return false;
      }
      const residueSelection = buildResidueSelectionForCdsCodon({
        referenceId,
        cds: parentCdsForCodon,
        codon,
        fullSequence,
      });
      if (!residueSelection) {
        publishResidueSelectionPointerDebug({
          stage: 'toggle',
          result: false,
          reason: 'build-selection-null',
          referenceId,
          coordinateMode: coordinateSpace?.mode ?? null,
          hasStore: true,
          mouseX,
          mouseY,
          codon,
          parentCds: {
            name: parentCdsForCodon.name,
            type: parentCdsForCodon.type,
            start: parentCdsForCodon.start,
            end: parentCdsForCodon.end,
            direction: parentCdsForCodon.direction,
          },
        });
        return false;
      }

      const anchor = residueSelectionAnchorRef.current;
      const currentResidueSelections = residueSelectionsStore.getSnapshot();
      const existingSelection = anchor
        ? findResidueSelectionForMolecule(currentResidueSelections, anchor.selection.target)
        : undefined;
      if (
        extendRange &&
        anchor &&
        existingSelection &&
        anchor.referenceId === referenceId &&
        anchor.selection.target.moleculeId === residueSelection.target.moleculeId &&
        anchor.selection.target.moleculeKind === residueSelection.target.moleculeKind
      ) {
        const rangeSelection = buildResidueSelectionForCdsCodonRange({
          referenceId,
          cds: parentCdsForCodon,
          anchorCodon: anchor.codon,
          codon,
          existingSelection,
          fullSequence,
        });
        if (rangeSelection) {
          residueSelectionsStore.set(
            replaceResidueSelectionForMolecule(currentResidueSelections, rangeSelection)
          );
          publishResidueSelectionPointerDebug({
            stage: 'range',
            result: true,
            referenceId,
            coordinateMode: coordinateSpace?.mode ?? null,
            hasStore: true,
            mouseX,
            mouseY,
            codon,
            anchorCodon: anchor.codon,
            selectionId: rangeSelection.selectionId ?? null,
            snapshotLength: residueSelectionsStore.getSnapshot().length,
          });
          return true;
        }
        publishResidueSelectionPointerDebug({
          stage: 'range',
          result: false,
          reason: 'build-range-selection-null',
          referenceId,
          coordinateMode: coordinateSpace?.mode ?? null,
          hasStore: true,
          mouseX,
          mouseY,
          codon,
          anchorCodon: anchor.codon,
        });
        return false;
      }

      residueSelectionsStore.dispatch({ type: 'toggle', selection: residueSelection });
      residueSelectionAnchorRef.current =
        residueSelectionsStore.getSnapshot().length === 0
          ? null
          : { referenceId, codon, selection: residueSelection };
      publishResidueSelectionPointerDebug({
        stage: 'toggle',
        result: true,
        referenceId,
        coordinateMode: coordinateSpace?.mode ?? null,
        hasStore: true,
        extendRange,
        hasRangeAnchor: !!residueSelectionAnchorRef.current,
        mouseX,
        mouseY,
        codon,
        selectionId: residueSelection.selectionId ?? null,
        snapshotLength: residueSelectionsStore.getSnapshot().length,
      });
      return true;
    },
    [
      coordinateSpace?.mode,
      fullSequence,
      gatherAnnotationHits,
      getResidueSelectionCodonAtPosition,
      residueSelectionReferenceId,
      residueSelectionsStore,
    ]
  );

  const canToggleResidueSelectionAtPoint = useCallback(
    (line: (typeof layout.lines)[0], mouseX: number, mouseY: number): boolean => {
      if (!residueSelectionReferenceId || coordinateSpace?.mode === 'gapped') return false;
      const codon = getResidueSelectionCodonAtPosition(line, mouseX, mouseY);
      if (!codon || codon.isOverlayClick) return false;
      return gatherAnnotationHits(line, mouseX, mouseY, codon).parentCdsForCodon !== null;
    },
    [
      coordinateSpace?.mode,
      gatherAnnotationHits,
      getResidueSelectionCodonAtPosition,
      residueSelectionReferenceId,
    ]
  );

  const getSelectionEdgeAtPosition = useCallback(
    (position: number): 'start' | 'end' | null => {
      const sel = highlightedRange || selection;
      const hit = detectHandleHit(position, sel ?? null);
      return hit?.edge ?? null;
    },
    [highlightedRange, selection]
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (isSecondaryClickIntent(event)) {
        mouseDownPosRef.current = null;
        return;
      }

      const canvas = selectionCanvasRef.current;
      if (canvas) {
        canvasRectRef.current = canvas.getBoundingClientRect();
      }

      const { line, position, cursorPosition, x, y } = getLineAndPositionFromEvent(event);
      mouseDownPosRef.current = null;

      if (cdsExtensionHoverStore) {
        const arrowHit = arrowHitTest(
          renderedCdsExtensionArrowsRef.current,
          pointerTargetX(line, x),
          pointerPaintY(line, y)
        );
        if (arrowHit) {
          event.preventDefault();

          if (cdsExtensionHoverStore.getSnapshot() === null) {
            onCdsExtensionAnchor?.(arrowHit.anchorBp);
          }
          cdsExtensionHoverStore.requestDraft({
            cdsKey: arrowHit.cdsKey,
            direction: arrowHit.direction,
            kind: arrowHit.kind,
          });
          canvasRectRef.current = null;
          return;
        }
      }

      if (
        line &&
        isResidueSelectionClickIntent(event) &&
        canToggleResidueSelectionAtPoint(line, x, y)
      ) {
        event.preventDefault();
        mouseDownPosRef.current = { x: event.clientX, y: event.clientY };
        canvasRectRef.current = null;
        return;
      }

      if (
        tryCommitCanvasLabelHit({
          enabled: showCutSites,
          items: renderedCutSitesRef.current,
          detectHit: (items) =>
            detectCutSiteLabelHit(pointerTargetX(line, x), pointerPaintY(line, y), items),
          toRange: (clickedSite) => cutSiteRecognitionSelection(clickedSite, sequenceLength),
          onHit: (clickedSite) => onCutSiteClick?.(clickedSite),
          event,
          editable,
          onSelectionChange,
          onHighlightedRangeChange,
        })
      ) {
        canvasRectRef.current = null;
        return;
      }

      if (
        tryCommitCanvasLabelHit({
          enabled: true,
          items: renderedGGLabelsRef.current,
          detectHit: (items) =>
            detectGGLabelHit(pointerTargetX(line, x), pointerPaintY(line, y), items),
          toRange: (clickedGGLabel) =>
            clickedGGLabel.primer.junctionIndex === undefined
              ? null
              : ggLabelScarSelection(clickedGGLabel),
          onHit: (clickedGGLabel) => {
            const junctionIndex = clickedGGLabel.primer.junctionIndex;
            if (junctionIndex !== undefined) onGGLabelClick?.(junctionIndex);
          },
          event,
          editable,
          onSelectionChange,
          onHighlightedRangeChange,
        })
      ) {
        canvasRectRef.current = null;
        return;
      }

      if (
        tryHandleShiftClickAnnotationMouseDown({
          line,
          showAnnotations: config.showAnnotations,
          shiftKey: event.shiftKey,
          x,
          y,
          getAnnotationAtPosition,
          currentSelection: (editable ? selection : highlightedRange) ?? null,
          cursorPosition: (editable ? cursor : viewCursor) ?? null,
          sequenceLength: layout.sequenceLength || 0,
          isLinear: !layout.isCircular,
          isAltKey: event.altKey,
          editable,
          onSelectionChange,
          onHighlightedRangeChange,
          onViewCursorChange,
          liveSelectionRef,
          drawSelectionDirect,
          setShiftPreview,
        })
      ) {
        canvasRectRef.current = null;
        return;
      }

      if (
        tryDeferAnnotationOrIntronMouseDown({
          line,
          showAnnotations: config.showAnnotations,
          showTranslation: config.showTranslation,
          position,
          x,
          y,
          getAnnotationAtPosition,
          intronUnderCursor: (hitLine, hitPosition) => {
            const flags = linePrimerFlagsMap.get(hitLine);
            return translationIntronUnderCursor({
              line: hitLine,
              sequenceLength,
              position: hitPosition,
              y,
              scrollTop: viewportRef.current.scrollTop,
              hitDetectionConfig,
              showReverseComplement: config.showReverseComplement,
              hasForwardPrimers: flags?.hasForwardPrimers ?? false,
              hasReversePrimers: flags?.hasReversePrimers ?? false,
            });
          },
          mouseDownPosRef,
          clientX: event.clientX,
          clientY: event.clientY,
        })
      ) {
        canvasRectRef.current = null;
        return;
      }

      if (
        tryHandleShiftClickCodonMouseDown({
          line,
          shiftKey: event.shiftKey,
          x,
          y,
          getAminoAcidAtPosition,
          currentSelection: (editable ? selection : highlightedRange) ?? null,
          cursorPosition: (editable ? cursor : viewCursor) ?? null,
          sequenceLength: layout.sequenceLength || 0,
          isLinear: !layout.isCircular,
          isAltKey: event.altKey,
          editable,
          onSelectionChange,
          onHighlightedRangeChange,
          liveSelectionRef,
          drawSelectionDirect,
          setShiftPreview,
        })
      ) {
        canvasRectRef.current = null;
        return;
      }

      if (position !== null) {
        const sel = highlightedRange || selection;
        if (sel && sel.start !== sel.end) {
          const edge = getSelectionEdgeAtPosition(position);
          if (edge) {
            isDraggingHandleRef.current = edge;
            handleDragAnchorRef.current = edge === 'start' ? sel.end : sel.start;
            event.preventDefault();
            return;
          }
        }

        mouseDownPosRef.current = { x: event.clientX, y: event.clientY };

        if (editable) {
          const dragAnchor = cursorPosition ?? position;
          const seqLen = layout.sequenceLength || 0;
          const isLinear = !layout.isCircular;

          if (event.shiftKey && (selection || cursor !== undefined)) {
            const newSel = nucleotideShiftClickSelection({
              isLinear,
              altKey: event.altKey,
              current: selection || null,
              position,
              cursor: cursor ?? null,
              sequenceLength: seqLen,
            });
            onSelectionChange?.(newSel);
            liveSelectionRef.current = newSel;
            setShiftPreview(null);
            drawSelectionDirect(newSel);
            return;
          }

          onCursorChange?.(cursorPosition ?? position);
          onSelectionChange?.(null);
          liveSelectionRef.current = null;

          isSelectingRef.current = true;
          selectionAnchorRef.current = dragAnchor;
          editLastDragPositionRef.current = dragAnchor;
          editCumulativeDragDeltaRef.current = 0;
          const newSel = { start: dragAnchor, end: dragAnchor };
          liveSelectionRef.current = newSel;
          drawSelectionDirect(newSel);
        } else {
          const seqLen = layout.sequenceLength || 0;
          const isLinear = !layout.isCircular;

          if (event.shiftKey && (highlightedRange || viewCursor !== null)) {
            const newRange = nucleotideShiftClickSelection({
              isLinear,
              altKey: event.altKey,
              current: highlightedRange || null,
              position,
              cursor: viewCursor ?? null,
              sequenceLength: seqLen,
            });
            onHighlightedRangeChange?.(newRange);
            setShiftPreview(null);
            isHighlightingRef.current = false;
            return;
          }

          onViewCursorChange?.(cursorPosition ?? position);
          onHighlightedRangeChange?.(null);
          isHighlightingRef.current = true;
          highlightAnchorRef.current = cursorPosition ?? position;
          lastDragPositionRef.current = cursorPosition ?? position;
          cumulativeDragDeltaRef.current = 0;
        }
      }
    },
    [
      getLineAndPositionFromEvent,
      drawSelectionDirect,
      onSelectionChange,
      editable,
      onCursorChange,
      showCutSites,
      onCutSiteClick,
      onViewCursorChange,
      onHighlightedRangeChange,
      selection,
      cursor,
      highlightedRange,
      viewCursor,
      getSelectionEdgeAtPosition,
      config.showAnnotations,
      getAnnotationAtPosition,
      canToggleResidueSelectionAtPoint,
      sequenceLength,
      cdsExtensionHoverStore,
      renderedCdsExtensionArrowsRef,
    ]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = selectionCanvasRef.current;
      const { line, position, x, y } = getLineAndPositionFromEvent(event);

      if (
        tryApplyCanvasHandleDragOnMove({
          draggingEdge: isDraggingHandleRef.current,
          handleDragAnchor: handleDragAnchorRef.current,
          position,
          isCircular: layout.isCircular,
          editable,
          liveSelectionRef,
          highlightedRangeRef,
          drawSelectionDirect,
          drawRafRef,
          drawFnRef,
          onHighlightedRangePreview,
          onDragScroll,
          clientY: event.clientY,
        })
      ) {
        return;
      }

      const isDragging = isSelectingRef.current || isHighlightingRef.current;
      applyCanvasHoverCursorOnMove({
        isDragging,
        canvas,
        position,
        line,
        edge: position !== null ? getSelectionEdgeAtPosition(position) : null,
        applyLineHover: (hitLine) => {
          const annotation = getAnnotationAtPosition(hitLine, x, y);
          const flags = linePrimerFlagsMap.get(hitLine);
          const intronHit =
            position !== null &&
            translationIntronUnderCursor({
              line: hitLine,
              sequenceLength,
              position,
              y,
              scrollTop: viewportRef.current.scrollTop,
              hitDetectionConfig,
              showReverseComplement: config.showReverseComplement,
              hasForwardPrimers: flags?.hasForwardPrimers ?? false,
              hasReversePrimers: flags?.hasReversePrimers ?? false,
            });
          const codon = getAminoAcidAtPosition(hitLine, x, y);
          const orfHover = position !== null ? detectOrfAtCanvasPoint(hitLine, position, y) : null;
          const nextHoveredAnn: AnnotationIdentity | null = orfHover
            ? null
            : detectAnnotationTargetAtPosition(hitLine, x, y, position, codon);
          const hover = applyNonEdgeCanvasHover({
            linePresent: true,
            annotationPointer: canvasAnnotationPointer({
              showAnnotations: config.showAnnotations,
              annotationHit: Boolean(annotation),
              showTranslation: config.showTranslation,
              hasPosition: position !== null,
              intronHit,
            }),
            codon,
            orfHover,
            nextHoveredAnn,
            clientX: event.clientX,
            clientY: event.clientY,
          });
          setHoveredCodon((prev) => nextHoveredCodon(hover.codon, prev));
          setHoveredOrf((prev) =>
            sameIntervalStrand(prev, hover.orfHover) ? prev : hover.orfHover
          );
          setHoveredAnnotation((prev) =>
            sameAnnotationIdentity(prev, hover.nextHoveredAnn) ? prev : hover.nextHoveredAnn
          );
          setAnnotationTooltipPos(hover.tooltipPos ? { ...hover.tooltipPos, position } : null);
          return hover;
        },
        clearHover: () => {
          setHoveredCodon((prev) => (prev === null ? prev : null));
          setHoveredOrf((prev) => (prev === null ? prev : null));
          setHoveredAnnotation((prev) => (prev === null ? prev : null));
          setAnnotationTooltipPos(null);
        },
      });
      const cutHover = resolveOptionalHover({
        inspect: Boolean(showCutSites && !isDragging),
        clearWhenIdle: !isDragging,
        items: renderedCutSitesRef.current,
        detect: () =>
          detectCutSiteLabelHit(
            pointerTargetX(line, x),
            pointerPaintY(line, y),
            renderedCutSitesRef.current
          ),
      });
      if (cutHover.apply) setHoveredCutSite(cutHover.value);
      const isOverCutSiteLabel = cutHover.isOver;
      if (canvas && cutHover.value) canvas.style.cursor = 'pointer';

      const ggHover = resolveOptionalHover({
        inspect: !isDragging,
        clearWhenIdle: !isDragging,
        items: renderedGGLabelsRef.current,
        detect: () =>
          detectGGLabelHit(
            pointerTargetX(line, x),
            pointerPaintY(line, y),
            renderedGGLabelsRef.current
          ),
      });
      if (ggHover.apply) setHoveredGGProductLabel(ggHover.value);
      const isOverGGLabel = ggHover.isOver;
      if (canvas && ggHover.value && !isOverCutSiteLabel) canvas.style.cursor = 'pointer';

      let isOverCdsExtensionArrow = false;
      if (cdsExtensionHoverStore && !isDragging) {
        const arrowHit = arrowHitTest(
          renderedCdsExtensionArrowsRef.current,
          pointerTargetX(line, x),
          pointerPaintY(line, y)
        );
        const showing = cdsExtensionHoverStore.getSnapshot();
        const wasShowing = showing !== null;

        const anchorOfShowingPreview = (): number | null => {
          if (!showing) return null;
          const match = renderedCdsExtensionArrowsRef.current.find(
            (arrow) => arrow.cdsKey === showing.cdsKey && arrow.direction === showing.direction
          );
          return match ? match.anchorBp : null;
        };
        if (arrowHit) {
          isOverCdsExtensionArrow = true;
          const next =
            arrowHit.kind === 'extend'
              ? { cdsKey: arrowHit.cdsKey, direction: arrowHit.direction, kind: 'extend' as const }
              : null;
          const changesPreview =
            showing?.cdsKey !== next?.cdsKey || showing?.direction !== next?.direction;

          if (changesPreview) {
            const anchor = next ? arrowHit.anchorBp : anchorOfShowingPreview();
            if (anchor !== null) onCdsExtensionAnchor?.(anchor);
          }

          cdsExtensionHoverStore.setHovered(next);
        } else if (!pointerOverExtensionPreview(line, x, y)) {
          if (wasShowing) {
            const anchor = anchorOfShowingPreview();
            if (anchor !== null) onCdsExtensionAnchor?.(anchor);
          }
          cdsExtensionHoverStore.setHovered(null);
        }
      }
      if (canvas && isOverCdsExtensionArrow) canvas.style.cursor = 'pointer';

      if (!isDragging && pointerOnUnsavedExtension(line, x, y)) {
        setHoveredCodon((prev) => (prev === null ? prev : null));
        setHoveredAnnotation((prev) => (prev === null ? prev : null));
      }

      if (!isSelectingRef.current && !isHighlightingRef.current && !isDraggingHandleRef.current) {
        const lineIdx = line ? layout.lines.indexOf(line) : -1;
        const newHoverCursor = hoverCursorForMove({
          isOverCutSiteLabel,
          isOverGGLabel,
          lineIdx,
          x: pointerPaintX(line, x),
        });
        const prevHoverCursor = hoverCursorRef.current;
        hoverCursorRef.current = newHoverCursor;
        if (hoverCursorChanged(prevHoverCursor, newHoverCursor)) {
          const currentSel = editable ? liveSelectionRef.current : (highlightedRange ?? null);
          drawSelectionDirect(currentSel, newHoverCursor);
        }
      }

      const nextShiftPreview = shiftPreviewForMove({
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        position,
        currentSelection: editable ? selection : highlightedRange,
        currentCursor: editable ? cursor : viewCursor,
        isCircular: layout.isCircular,
      });
      if (nextShiftPreview) {
        setShiftPreview(nextShiftPreview);
      } else {
        setShiftPreview((prev) => (prev === null ? prev : null));
      }

      if (isSelectingRef.current && selectionAnchorRef.current !== null && position !== null) {
        const anchor = selectionAnchorRef.current;
        const sel =
          anchor !== position
            ? computeDragSelection(
                anchor,
                position,
                layout.isCircular ?? false,
                sequenceLength,
                editLastDragPositionRef,
                editCumulativeDragDeltaRef
              )
            : { start: anchor, end: position };

        liveSelectionRef.current = sel;
        highlightedRangeRef.current = sel;
        drawSelectionDirect(sel);

        if (drawRafRef.current) cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = requestAnimationFrame(() => {
          drawRafRef.current = null;
          drawFnRef.current?.();
          if (liveSelectionRef.current) {
            onSelectionChange?.(liveSelectionRef.current);
          }
        });
        onDragScroll?.(event.clientY, true);
      }

      if (isHighlightingRef.current && highlightAnchorRef.current !== null && position !== null) {
        const anchor = highlightAnchorRef.current;
        if (position !== anchor) {
          onViewCursorChange?.(null);

          const range = computeDragSelection(
            anchor,
            position,
            layout.isCircular ?? false,
            sequenceLength,
            lastDragPositionRef,
            cumulativeDragDeltaRef
          );

          liveSelectionRef.current = range;
          highlightedRangeRef.current = range;
          drawSelectionDirect(range);
          const previewRange = range;

          if (drawRafRef.current) cancelAnimationFrame(drawRafRef.current);
          drawRafRef.current = requestAnimationFrame(() => {
            drawRafRef.current = null;
            drawFnRef.current?.();
            onHighlightedRangePreview?.(previewRange);
          });
        }
        onDragScroll?.(event.clientY, true);
      }

      const primerHover = resolveOptionalHover({
        inspect: Boolean(config.showPrimers && !isSelectingRef.current),
        clearWhenIdle: !isSelectingRef.current,
        items: renderedPrimersRef.current,
        detect: () =>
          primerHitAtPoint(
            renderedPrimersRef.current,
            pointerTargetX(line, x),
            pointerPaintY(line, y)
          ) ?? null,
      });
      if (primerHover.apply) {
        const hitPrimer = primerHover.value;
        setHoveredPrimer(hitPrimer?.primer ?? null);
        setPrimerTooltipPos(hitPrimer ? { x: event.clientX, y: event.clientY } : null);
        if (canvas && hitPrimer) canvas.style.cursor = 'pointer';
      }

      if (isOverCutSiteLabel) {
        return;
      }

      if (canvas) {
        const fallback = canvasFallbackCursor(canvas.style.cursor, position);
        if (fallback) canvas.style.cursor = fallback;
      }
    },
    [
      getLineAndPositionFromEvent,
      drawSelectionDirect,
      showCutSites,
      config.showPrimers,
      config.showAnnotations,
      config.showTranslation,
      onDragScroll,
      layout.isCircular,
      sequenceLength,
      onViewCursorChange,
      onHighlightedRangeChange,
      onHighlightedRangePreview,
      getSelectionEdgeAtPosition,
      getAnnotationAtPosition,
      getAminoAcidAtPosition,
      detectOrfAtCanvasPoint,
      editable,
      cdsExtensionHoverStore,
      onCdsExtensionAnchor,
      pointerOverExtensionPreview,
      pointerOnUnsavedExtension,
      renderedCdsExtensionArrowsRef,
    ]
  );

  const handleMouseLeave = useCallback(() => {
    if (selectionCanvasRef.current) {
      selectionCanvasRef.current.style.cursor = 'default';
    }
    setHoveredCutSite(null);
    setHoveredPrimer(null);
    setPrimerTooltipPos(null);
    setAnnotationTooltipPos(null);
    setHoveredCodon(null);
    setHoveredOrf(null);
    setHoveredAnnotation(null);

    cdsExtensionHoverStore?.setHovered(null);
    if (hoverCursorRef.current !== null) {
      hoverCursorRef.current = null;
      const currentSel = editable
        ? liveSelectionRef.current
        : (highlightedRangeRef.current ?? null);
      drawSelectionDirect(currentSel, null);
    }
  }, [editable, drawSelectionDirect, cdsExtensionHoverStore]);

  const handleMouseUp = useCallback(() => {
    const target = selectionCanvasRef.current;
    if (target && !inputTargetAllows(target, 'pointer')) return;
    if (isDraggingHandleRef.current && handleDragAnchorRef.current !== null) {
      if (editable && liveSelectionRef.current) {
        onSelectionChange?.(liveSelectionRef.current);
      } else if (!editable && liveSelectionRef.current) {
        onHighlightedRangeChange?.(liveSelectionRef.current);
      }
      isDraggingHandleRef.current = null;
      handleDragAnchorRef.current = null;
      liveSelectionRef.current = null;
      onDragScroll?.(0, false);
      return;
    }

    if (isHighlightingRef.current && liveSelectionRef.current) {
      onHighlightedRangeChange?.(liveSelectionRef.current);
      liveSelectionRef.current = null;
    }

    if (isSelectingRef.current && liveSelectionRef.current) {
      if (liveSelectionRef.current.start === liveSelectionRef.current.end) {
        onSelectionChange?.(null);
      } else {
        onSelectionChange?.(liveSelectionRef.current);
      }
    }
    isSelectingRef.current = false;
    liveSelectionRef.current = null;
    editLastDragPositionRef.current = null;
    editCumulativeDragDeltaRef.current = 0;

    isHighlightingRef.current = false;
    highlightAnchorRef.current = null;
    lastDragPositionRef.current = null;
    cumulativeDragDeltaRef.current = 0;

    canvasRectRef.current = null;
    onDragScroll?.(0, false);
  }, [onSelectionChange, onHighlightedRangeChange, onDragScroll, editable]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const CLICK_THRESHOLD_SQ = 25;
      const down = mouseDownPosRef.current;
      if (!down) return;

      const dx = event.clientX - down.x;
      const dy = event.clientY - down.y;
      if (dx * dx + dy * dy > CLICK_THRESHOLD_SQ) return;

      const { line, x, y } = getLineAndPositionFromEvent(event);
      if (!line) return;

      if (isResidueSelectionClickIntent(event)) {
        if (toggleResidueSelectionAtPoint(line, x, y, event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.shiftKey || isSecondaryClickIntent(event)) return;

      if (config.showPrimers && renderedPrimersRef.current.length > 0) {
        const hitPrimer = renderedPrimersRef.current.find(
          (rp) =>
            pointerTargetX(line, x) >= rp.x &&
            pointerTargetX(line, x) <= rp.x + rp.width &&
            pointerPaintY(line, y) >= rp.y &&
            pointerPaintY(line, y) <= rp.y + rp.height
        );
        if (hitPrimer && !hitPrimer.primer.isCandidate && !hitPrimer.primer.isDraft) {
          setSelectedPrimer(hitPrimer.primer);
          const seqLen = layout.sequenceLength || 0;

          const range = createSelectionFromAnnotation(
            hitPrimer.primer.start,
            hitPrimer.primer.end - 1,
            seqLen
          );
          if (editable) {
            onSelectionChange?.(range);
            liveSelectionRef.current = range;
            drawSelectionDirect(range);
          } else {
            onViewCursorChange?.(null);
            onHighlightedRangeChange?.(range);
          }
          return;
        }

        setSelectedPrimer(null);
      }

      const codon = getAminoAcidAtPosition(line, x, y);

      const { position } = getLineAndPositionFromEvent(event);
      const orfClick = position !== null ? detectOrfAtCanvasPoint(line, position, y) : null;
      const hits = gatherAnnotationHits(line, x, y, codon);
      const pointerSel = resolvePointerSelection({
        ...hits,
        position,
        showAnnotations: !!config.showAnnotations,
        showTranslation: !!config.showTranslation,
        orfHit: orfClick,
      });
      applyPointerSelection(pointerSel);

      const hitSelectable = !!pointerSel.annotation || !!pointerSel.orf;
      if (hitSelectable) {
        if (editable) {
          onSelectionChange?.(null);
          liveSelectionRef.current = null;
          drawSelectionDirect(null);
        } else {
          onViewCursorChange?.(null);
          onHighlightedRangeChange?.(null);
        }
        return;
      }
    },
    [
      getLineAndPositionFromEvent,
      getAminoAcidAtPosition,
      gatherAnnotationHits,
      detectOrfAtCanvasPoint,
      applyPointerSelection,
      config.showAnnotations,
      config.showTranslation,
      editable,
      layout.sequenceLength,
      onSelectionChange,
      onHighlightedRangeChange,
      onViewCursorChange,
      drawSelectionDirect,
      toggleResidueSelectionAtPoint,
    ]
  );

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const { line, x, y, position } = getLineAndPositionFromEvent(event);

      if (showCutSites && renderedCutSitesRef.current.length > 0) {
        const clickedSite = detectCutSiteLabelHit(
          pointerTargetX(line, x),
          pointerPaintY(line, y),
          renderedCutSitesRef.current
        );
        if (clickedSite) {
          event.stopPropagation();
          onCutSiteDoubleClick?.(clickedSite);
          return;
        }
      }

      const codon = line ? getAminoAcidAtPosition(line, x, y) : null;
      const dblAnnTarget = line
        ? detectAnnotationTargetAtPosition(line, x, y, position, codon)
        : null;

      let dblRange: { start: number; end: number; wraps?: boolean } | null = null;
      if (dblAnnTarget) {
        const pillHit = line ? getAnnotationAtPosition(line, x, y) : null;
        const s = pillHit?.hitStart ?? dblAnnTarget.start - 1;
        const e = pillHit?.hitEnd ?? dblAnnTarget.end - 1;
        dblRange = { start: s, end: e, ...(s > e && { wraps: true }) };
      } else if (codon?.parentRange) {
        const s = codon.parentRange.start;
        const e = codon.parentRange.end;
        dblRange = { start: s, end: e, ...(s > e && { wraps: true }) };
      }

      if (dblRange) {
        if (editable) {
          onSelectionChange?.(dblRange);
          liveSelectionRef.current = dblRange;
          drawSelectionDirect(dblRange);
        } else {
          onViewCursorChange?.(null);
          onHighlightedRangeChange?.(dblRange);
        }
        return;
      }

      if (editable && sequenceLength > 0) {
        onSelectionChange?.({ start: 0, end: sequenceLength - 1 });
      }
    },
    [
      editable,
      sequenceLength,
      onSelectionChange,
      onHighlightedRangeChange,
      onViewCursorChange,
      drawSelectionDirect,
      liveSelectionRef,
      showCutSites,
      getLineAndPositionFromEvent,
      getAminoAcidAtPosition,
      detectAnnotationTargetAtPosition,
      getAnnotationAtPosition,
      onCutSiteDoubleClick,
    ]
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      if (onContextMenu) {
        const { line, position, cursorPosition, x, y } = getLineAndPositionFromEvent(event);
        const isOnNucRow = line ? isClickOnNucleotideRow(line, y) : false;
        if (position !== null) {
          if (editable) {
            onCursorChange?.(cursorPosition ?? position);
          } else {
            onViewCursorChange?.(cursorPosition ?? position);
          }
        }

        const annotationUnderPointer = line ? getAnnotationAtPosition(line, x, y) : null;

        let clickedOrf: ORF | null = null;
        if (orfs && orfs.length > 0 && line && position !== null) {
          const lp = precomputedLinePositions.find((p) => p.line === line);
          if (lp) {
            const contentY = y + viewportRef.current.scrollTop;
            const forwardOrfHeight = calculateOrfHeight(lp.forwardOrfLaneCount, config.rowHeight);
            const reverseOrfHeight = calculateOrfHeight(lp.reverseOrfLaneCount, config.rowHeight);

            const laneHeight = config.rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
            clickedOrf = findOrfAtPoint(
              {
                bandY: lp.forwardOrfY,
                bandHeight: forwardOrfHeight,
                laneCount: lp.forwardOrfLaneCount,
                laneHeight,
                orfs: line.forwardOrfs ?? [],
              },
              {
                bandY: lp.reverseOrfY,
                bandHeight: reverseOrfHeight,
                laneCount: lp.reverseOrfLaneCount,
                laneHeight,
                orfs: line.reverseOrfs ?? [],
              },
              contentY,
              position
            );
          }
        }

        const clickedPrimer = renderedPrimersRef.current.find((rp) => {
          return (
            pointerTargetX(line, x) >= rp.x &&
            pointerTargetX(line, x) <= rp.x + rp.width &&
            pointerPaintY(line, y) >= rp.y &&
            pointerPaintY(line, y) <= rp.y + rp.height
          );
        });

        if (clickedPrimer) {
          setSelectedPrimer(clickedPrimer.primer);
        }

        const codon = line ? getAminoAcidAtPosition(line, x, y) : null;
        const hits = line
          ? gatherAnnotationHits(line, x, y, codon)
          : { annotationHit: null, parentCdsForCodon: null, classifiedCDSs: [] };

        const annotation =
          annotationUnderPointer ??
          (hits.parentCdsForCodon && isCdsExtensionPreview(hits.parentCdsForCodon)
            ? (hits.parentCdsForCodon as unknown as typeof annotationUnderPointer)
            : null);
        const pointerSel = resolvePointerSelection({
          ...hits,
          position,
          showAnnotations: !!config.showAnnotations,
          showTranslation: !!config.showTranslation,
          orfHit: clickedOrf,
        });
        applyPointerSelection(pointerSel);

        const selectionAtTrigger = copySelectionRange(
          editable ? (liveSelectionRef.current ?? selection) : highlightedRangeRef.current
        );

        onContextMenu(event, selectionAtTrigger, {
          isOnNucleotideRow: isOnNucRow,
          position,
          annotation,
          translatedCDS: hits.parentCdsForCodon,
          orf: clickedOrf,
          primer: clickedPrimer?.primer ?? null,
        });
      }
    },
    [
      onContextMenu,
      selection,
      getLineAndPositionFromEvent,
      isClickOnNucleotideRow,
      getAnnotationAtPosition,
      getAminoAcidAtPosition,
      gatherAnnotationHits,
      applyPointerSelection,
      orfs,
      precomputedLinePositions,
      config.rowHeight,
      config.showAnnotations,
      config.showTranslation,
      editable,
      onCursorChange,
      onViewCursorChange,
      renderedPrimersRef,
      viewportRef,
    ]
  );

  useEffect(() => {
    const target = selectionCanvasRef.current;
    const cancel = () => {
      isSelectingRef.current = false;
      isHighlightingRef.current = false;
      isDraggingHandleRef.current = null;
      handleDragAnchorRef.current = null;
      liveSelectionRef.current = null;
      mouseDownPosRef.current = null;
      canvasRectRef.current = null;
      onDragScroll?.(0, false);
    };
    const dispose = target ? subscribeInputRevocation(target, cancel) : () => undefined;
    const handleGlobalMouseUp = () => {
      if (target && !inputTargetAllows(target, 'pointer')) return;
      const current = target ? captureInputOwnership(target, 'pointer') : () => true;
      const committedSelection = isSelectingRef.current ? liveSelectionRef.current : null;

      handleMouseUp();
      if (committedSelection) {
        requestAnimationFrame(() => {
          if (!current()) return;
          drawSelectionAndCursorRef.current(
            committedSelection.start === committedSelection.end ? null : committedSelection,
            cursorRef.current,
            cursorVisibleRef.current,
            insertedRangesRef.current,
            deletedRangesRef.current
          );
        });
      }
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('blur', cancel);
    return () => {
      dispose();
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('blur', cancel);
    };
  }, [
    handleMouseUp,
    selectionCanvasRef,
    isSelectingRef,
    isHighlightingRef,
    isDraggingHandleRef,
    handleDragAnchorRef,
    liveSelectionRef,
    mouseDownPosRef,
    canvasRectRef,
    onDragScroll,
  ]);

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleClick,
    handleDoubleClick,
    handleContextMenu,
    handleMouseLeave,
    hoveredCutSite,
    hoveredCodon,
    hoveredOrf,
    selectedOrf,
    hoveredAnnotation,
    selectedAnnotation,
    hoveredPrimer,
    selectedPrimer,
    primerTooltipPos,
    annotationTooltipPos,
    hoveredGGProductLabel,
    shiftPreview,
  };
}
