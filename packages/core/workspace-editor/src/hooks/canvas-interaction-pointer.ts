import {
  findIntronAtPosition,
  calculateLineTrackBounds,
  type HitDetectionConfig,
} from '../hit-detection';
import { isSplicedCDS } from '../translation';
import { cdsPresentationGeometry } from '../cds-presentation';
import type { ClassifiedCDS, Layout2DRow, Selection } from '../types';
import {
  computeShiftClickRangeForAnnotation,
  handleOptionShiftClickNucleotide,
  handleShiftClickNucleotide,
  type SelectionRange,
} from '../selection-model';

export type ShiftPreviewState = {
  hoverPosition: number;
  anchorPosition: number;
  isOptionHeld: boolean;
};

export function selectionFromHandleDrag(
  draggingEdge: 'start' | 'end',
  position: number,
  anchor: number,
  isCircular: boolean
): Selection {
  const newSel: Selection =
    draggingEdge === 'start' ? { start: position, end: anchor } : { start: anchor, end: position };
  if (isCircular && newSel.start > newSel.end) {
    return { ...newSel, wraps: true };
  }
  return newSel;
}

export function shiftPreviewForMove(args: {
  shiftKey: boolean;
  altKey: boolean;
  position: number | null;
  currentSelection: Selection | null | undefined;
  currentCursor: number | null | undefined;
  isCircular?: boolean;
}): ShiftPreviewState | null {
  const hasAnchor = Boolean(
    args.currentSelection || (args.currentCursor != null && typeof args.currentCursor === 'number')
  );
  if (!args.shiftKey || args.position === null || !hasAnchor) return null;

  if (args.currentSelection) {
    if (args.isCircular) {
      return {
        hoverPosition: args.position,
        anchorPosition: args.altKey ? args.currentSelection.end : args.currentSelection.start,
        isOptionHeld: args.altKey,
      };
    }
    const distToStart = Math.abs(args.position - args.currentSelection.start);
    const distToEnd = Math.abs(args.position - args.currentSelection.end);
    const extendingStart = distToStart <= distToEnd;
    return {
      hoverPosition: args.position,
      anchorPosition: extendingStart ? args.currentSelection.end : args.currentSelection.start,
      isOptionHeld: extendingStart,
    };
  }

  const anchor = args.currentCursor as number;
  return {
    hoverPosition: args.position,
    anchorPosition: anchor,
    isOptionHeld: args.isCircular ? args.altKey : args.position < anchor,
  };
}

export function applyCanvasHandleDrag(args: {
  newSel: Selection;
  editable: boolean;
  liveSelectionRef: { current: Selection | null };
  highlightedRangeRef: { current: Selection | null };
  drawSelectionDirect: (sel: Selection) => void;
  drawRafRef: { current: number | null };
  drawFnRef: { current?: (() => void) | null };
  onHighlightedRangePreview?: (range: Selection) => void;
}): void {
  args.liveSelectionRef.current = args.newSel;
  args.highlightedRangeRef.current = args.newSel;
  args.drawSelectionDirect(args.newSel);
  if (args.drawRafRef.current) cancelAnimationFrame(args.drawRafRef.current);
  const previewRange = args.newSel;
  args.drawRafRef.current = requestAnimationFrame(() => {
    args.drawRafRef.current = null;
    args.drawFnRef.current?.();
    if (!args.editable) args.onHighlightedRangePreview?.(previewRange);
  });
}

export function tryApplyCanvasHandleDragOnMove(args: {
  draggingEdge: 'start' | 'end' | null;
  handleDragAnchor: number | null;
  position: number | null;
  isCircular?: boolean;
  editable: boolean;
  liveSelectionRef: { current: Selection | null };
  highlightedRangeRef: { current: Selection | null };
  drawSelectionDirect: (sel: Selection) => void;
  drawRafRef: { current: number | null };
  drawFnRef: { current?: (() => void) | null };
  onHighlightedRangePreview?: (range: Selection) => void;
  onDragScroll?: (clientY: number, active: boolean) => void;
  clientY: number;
}): boolean {
  if (!(args.draggingEdge && args.handleDragAnchor !== null && args.position !== null)) {
    return false;
  }
  const newSel = selectionFromHandleDrag(
    args.draggingEdge,
    args.position,
    args.handleDragAnchor,
    args.isCircular === true
  );
  applyCanvasHandleDrag({
    newSel,
    editable: args.editable,
    liveSelectionRef: args.liveSelectionRef,
    highlightedRangeRef: args.highlightedRangeRef,
    drawSelectionDirect: args.drawSelectionDirect,
    drawRafRef: args.drawRafRef,
    drawFnRef: args.drawFnRef,
    onHighlightedRangePreview: args.onHighlightedRangePreview,
  });
  args.onDragScroll?.(args.clientY, true);
  return true;
}

export function applyCanvasHoverCursorOnMove<TLine>(args: {
  isDragging: boolean;
  canvas: { style: { cursor: string } } | null;
  position: number | null;
  line: TLine | null | undefined;
  edge: 'start' | 'end' | null;
  applyLineHover: (line: TLine) => { showPointer: boolean };
  clearHover: () => void;
}): void {
  if (args.isDragging || !args.canvas || args.position === null) return;
  if (args.edge) {
    args.canvas.style.cursor = 'ew-resize';
    return;
  }
  if (!args.line) {
    args.clearHover();
    args.canvas.style.cursor = '';
    return;
  }
  const hover = args.applyLineHover(args.line);
  args.canvas.style.cursor = hover.showPointer ? 'pointer' : '';
}

export function commitCanvasRange(args: {
  editable: boolean;
  range: Selection;
  onSelectionChange?: (range: Selection) => void;
  onHighlightedRangeChange?: (range: Selection) => void;
}): void {
  if (args.editable) args.onSelectionChange?.(args.range);
  else args.onHighlightedRangeChange?.(args.range);
}

export function tryCommitCanvasLabelHit<TItem, THit>(args: {
  enabled: boolean;
  items: readonly TItem[];
  detectHit: (items: readonly TItem[]) => THit | null;
  toRange: (hit: THit) => Selection | null;
  onHit?: (hit: THit) => void;
  event: { stopPropagation: () => void };
  editable: boolean;
  onSelectionChange?: (range: Selection) => void;
  onHighlightedRangeChange?: (range: Selection) => void;
}): boolean {
  if (!args.enabled || args.items.length === 0) return false;
  const hit = args.detectHit(args.items);
  if (!hit) return false;
  const range = args.toRange(hit);
  if (!range) return false;
  args.event.stopPropagation();
  args.onHit?.(hit);
  commitCanvasRange({
    editable: args.editable,
    range,
    onSelectionChange: args.onSelectionChange,
    onHighlightedRangeChange: args.onHighlightedRangeChange,
  });
  return true;
}

export function commitShiftClickCanvasRange(args: {
  editable: boolean;
  range: Selection;
  clearViewCursor?: boolean;
  onSelectionChange?: (range: Selection) => void;
  onHighlightedRangeChange?: (range: Selection) => void;
  onViewCursorChange?: (cursor: number | null) => void;
}): { liveDraw: boolean } {
  if (args.editable) {
    args.onSelectionChange?.(args.range);
    return { liveDraw: true };
  }
  if (args.clearViewCursor) args.onViewCursorChange?.(null);
  args.onHighlightedRangeChange?.(args.range);
  return { liveDraw: false };
}

export function tryCommitShiftClickFeatureRange(args: {
  hit: { start: number; end: number } | null;
  currentSelection: Selection | null;
  cursorPosition: number | null;
  sequenceLength: number;
  isLinear: boolean;
  isAltKey: boolean;
  editable: boolean;
  clearViewCursor?: boolean;
  onSelectionChange?: (range: Selection) => void;
  onHighlightedRangeChange?: (range: Selection) => void;
  onViewCursorChange?: (cursor: number | null) => void;
  liveSelectionRef: { current: Selection | null };
  drawSelectionDirect: (range: Selection) => void;
  setShiftPreview: (preview: null) => void;
}): boolean {
  if (!args.hit) return false;
  const newRange = computeShiftClickRangeForAnnotation({
    currentSelection: args.currentSelection,
    rangeStart: args.hit.start,
    rangeEnd: args.hit.end,
    cursorPosition: args.cursorPosition,
    sequenceLength: args.sequenceLength,
    isLinear: args.isLinear,
    isAltKey: args.isAltKey,
  });
  args.setShiftPreview(null);
  const { liveDraw } = commitShiftClickCanvasRange({
    editable: args.editable,
    range: newRange,
    clearViewCursor: args.clearViewCursor,
    onSelectionChange: args.onSelectionChange,
    onHighlightedRangeChange: args.onHighlightedRangeChange,
    onViewCursorChange: args.onViewCursorChange,
  });
  if (liveDraw) {
    args.liveSelectionRef.current = newRange;
    args.drawSelectionDirect(newRange);
  }
  return true;
}

export function tryHandleShiftClickAnnotationMouseDown<
  TLine,
  TAnnotation extends { hitStart?: number; hitEnd?: number; start: number; end: number },
>(args: {
  line: TLine | null | undefined;
  showAnnotations: boolean;
  shiftKey: boolean;
  x: number;
  y: number;
  getAnnotationAtPosition: (line: TLine, x: number, y: number) => TAnnotation | null | undefined;
  currentSelection: Selection | null;
  cursorPosition: number | null;
  sequenceLength: number;
  isLinear: boolean;
  isAltKey: boolean;
  editable: boolean;
  onSelectionChange?: (range: Selection) => void;
  onHighlightedRangeChange?: (range: Selection) => void;
  onViewCursorChange?: (cursor: number | null) => void;
  liveSelectionRef: { current: Selection | null };
  drawSelectionDirect: (range: Selection) => void;
  setShiftPreview: (preview: null) => void;
}): boolean {
  if (!(args.line && args.showAnnotations && args.shiftKey)) return false;
  const annotation = args.getAnnotationAtPosition(args.line, args.x, args.y);
  if (!annotation) return false;
  return tryCommitShiftClickFeatureRange({
    hit: annotationHitRange(annotation),
    currentSelection: args.currentSelection,
    cursorPosition: args.cursorPosition,
    sequenceLength: args.sequenceLength,
    isLinear: args.isLinear,
    isAltKey: args.isAltKey,
    editable: args.editable,
    clearViewCursor: true,
    onSelectionChange: args.onSelectionChange,
    onHighlightedRangeChange: args.onHighlightedRangeChange,
    onViewCursorChange: args.onViewCursorChange,
    liveSelectionRef: args.liveSelectionRef,
    drawSelectionDirect: args.drawSelectionDirect,
    setShiftPreview: args.setShiftPreview,
  });
}

export function tryHandleShiftClickCodonMouseDown<
  TLine,
  TCodon extends { start: number; end: number },
>(args: {
  line: TLine | null | undefined;
  shiftKey: boolean;
  x: number;
  y: number;
  getAminoAcidAtPosition: (line: TLine, x: number, y: number) => TCodon | null | undefined;
  currentSelection: Selection | null;
  cursorPosition: number | null;
  sequenceLength: number;
  isLinear: boolean;
  isAltKey: boolean;
  editable: boolean;
  onSelectionChange?: (range: Selection) => void;
  onHighlightedRangeChange?: (range: Selection) => void;
  liveSelectionRef: { current: Selection | null };
  drawSelectionDirect: (range: Selection) => void;
  setShiftPreview: (preview: null) => void;
}): boolean {
  if (!(args.shiftKey && args.line)) return false;
  const codon = args.getAminoAcidAtPosition(args.line, args.x, args.y);
  if (!codon) return false;
  return tryCommitShiftClickFeatureRange({
    hit: { start: codon.start, end: codon.end },
    currentSelection: args.currentSelection,
    cursorPosition: args.cursorPosition,
    sequenceLength: args.sequenceLength,
    isLinear: args.isLinear,
    isAltKey: args.isAltKey,
    editable: args.editable,
    onSelectionChange: args.onSelectionChange,
    onHighlightedRangeChange: args.onHighlightedRangeChange,
    liveSelectionRef: args.liveSelectionRef,
    drawSelectionDirect: args.drawSelectionDirect,
    setShiftPreview: args.setShiftPreview,
  });
}

export function tryDeferAnnotationOrIntronMouseDown<TLine>(args: {
  line: TLine | null | undefined;
  showAnnotations: boolean;
  showTranslation: boolean;
  position: number | null;
  x: number;
  y: number;
  getAnnotationAtPosition: (line: TLine, x: number, y: number) => unknown;
  intronUnderCursor: (line: TLine, position: number) => boolean;
  mouseDownPosRef: { current: { x: number; y: number } | null };
  clientX: number;
  clientY: number;
}): boolean {
  if (!(args.line && args.showAnnotations)) return false;
  if (args.getAnnotationAtPosition(args.line, args.x, args.y)) {
    args.mouseDownPosRef.current = { x: args.clientX, y: args.clientY };
    return true;
  }
  if (
    args.position !== null &&
    args.showTranslation &&
    args.intronUnderCursor(args.line, args.position)
  ) {
    args.mouseDownPosRef.current = { x: args.clientX, y: args.clientY };
    return true;
  }
  return false;
}

export function ggLabelScarSelection(label: { scarStart: number; scarEnd: number }): Selection {
  const scarSpansOrigin = label.scarEnd < label.scarStart;
  return {
    start: label.scarStart,
    end: label.scarEnd - 1,
    ...(scarSpansOrigin ? { wraps: true } : {}),
  };
}

export function annotationHitRange(annotation: {
  hitStart?: number;
  hitEnd?: number;
  start: number;
  end: number;
}): { start: number; end: number } {
  return {
    start: annotation.hitStart ?? annotation.start - 1,
    end: annotation.hitEnd ?? annotation.end - 1,
  };
}

export function handleLinearShiftClick(
  selection: SelectionRange | null,
  clickedPos: number,
  cursorPos: number | null
): SelectionRange {
  if (!selection) {
    if (cursorPos !== null) {
      return {
        start: Math.min(cursorPos, clickedPos),
        end: Math.max(cursorPos, clickedPos),
      };
    }
    return { start: clickedPos, end: clickedPos };
  }

  const distToStart = Math.abs(clickedPos - selection.start);
  const distToEnd = Math.abs(clickedPos - selection.end);
  const newStart = distToStart <= distToEnd ? clickedPos : selection.start;
  const newEnd = distToStart <= distToEnd ? selection.end : clickedPos;
  return {
    start: Math.min(newStart, newEnd),
    end: Math.max(newStart, newEnd),
  };
}

export function nucleotideShiftClickSelection(args: {
  isLinear: boolean;
  altKey: boolean;
  current: Selection | null;
  position: number;
  cursor: number | null;
  sequenceLength: number;
}): Selection {
  if (args.isLinear) {
    return handleLinearShiftClick(args.current, args.position, args.cursor);
  }
  if (args.altKey) {
    return handleOptionShiftClickNucleotide(
      args.current,
      args.position,
      args.cursor,
      args.sequenceLength,
      true
    );
  }
  return handleShiftClickNucleotide(
    args.current,
    args.position,
    args.cursor,
    args.sequenceLength,
    true
  );
}

export function primerHitAtPoint<T extends { x: number; y: number; width: number; height: number }>(
  primers: readonly T[],
  x: number,
  y: number
): T | undefined {
  return primers.find(
    (rp) => x >= rp.x && x <= rp.x + rp.width && y >= rp.y && y <= rp.y + rp.height
  );
}

export function applyNonEdgeCanvasHover<
  TCodon extends { start: number; end: number; strand: number },
  TOrf extends { start?: number; end?: number; strand?: number | string } | null,
  TAnn extends {
    type?: string;
    name?: string;
    start?: number;
    end?: number;
    direction?: string | number;
  } | null,
>(args: {
  linePresent: boolean;
  annotationPointer: boolean;
  codon: TCodon | null;
  orfHover: TOrf;
  nextHoveredAnn: TAnn;
  clientX: number;
  clientY: number;
}): {
  showPointer: boolean;
  codon: TCodon | null;
  orfHover: TOrf | null;
  nextHoveredAnn: TAnn | null;
  tooltipPos: { x: number; y: number } | null;
} {
  if (!args.linePresent) {
    return {
      showPointer: false,
      codon: null,
      orfHover: null,
      nextHoveredAnn: null,
      tooltipPos: null,
    };
  }
  return {
    showPointer: Boolean(args.codon) || args.annotationPointer,
    codon: args.codon,
    orfHover: args.orfHover,
    nextHoveredAnn: args.nextHoveredAnn,
    tooltipPos: args.nextHoveredAnn ? { x: args.clientX, y: args.clientY } : null,
  };
}

export function resolveOptionalHover<T>(args: {
  inspect: boolean;
  clearWhenIdle: boolean;
  items: readonly unknown[];
  detect: () => T | null;
}): { value: T | null; isOver: boolean; apply: boolean } {
  if (args.inspect && args.items.length > 0) {
    const value = args.detect();
    return { value, isOver: value !== null, apply: true };
  }
  if (args.clearWhenIdle) return { value: null, isOver: false, apply: true };
  return { value: null, isOver: false, apply: false };
}

export function translationIntronUnderCursor(args: {
  line: Layout2DRow & { classifiedCDSs?: ClassifiedCDS[] };
  position: number;
  y: number;
  scrollTop: number;
  hitDetectionConfig: HitDetectionConfig;
  showReverseComplement: boolean;
  hasForwardPrimers: boolean;
  hasReversePrimers: boolean;
  sequenceLength?: number;
}): boolean {
  const contentY = args.y + args.scrollTop;
  const bounds = calculateLineTrackBounds(
    args.line,
    args.hitDetectionConfig,
    args.showReverseComplement,
    args.hasForwardPrimers,
    args.hasReversePrimers
  );
  const relY = contentY - args.line.y;
  for (const cds of args.line.classifiedCDSs ?? []) {
    if (!isSplicedCDS(cds, args.sequenceLength)) continue;
    const lane = cds.translationLane;
    if (lane < 0) continue;
    if (
      cds._intronPillBounds?.some(
        (pill) =>
          pill.y !== undefined &&
          contentY >= pill.y &&
          contentY <= pill.y + (pill.h ?? 14) &&
          (pill.rangeStart <= pill.rangeEnd
            ? args.position >= pill.rangeStart && args.position <= pill.rangeEnd
            : args.position >= pill.rangeStart || args.position <= pill.rangeEnd)
      )
    )
      return true;
    const pose = cdsPresentationGeometry(
      cds,
      bounds.translationY,
      bounds.annotationY,
      args.hitDetectionConfig
    );
    if (relY < pose.intronY - 7 || relY > pose.intronY + 7) continue;
    if (
      cds.segments &&
      findIntronAtPosition(args.position, orderedCdsSegments(cds), args.sequenceLength)
    )
      return true;
  }
  return false;
}

export function sameIntervalStrand(
  a: { start?: number; end?: number; strand?: number | string } | null | undefined,
  b: { start?: number; end?: number; strand?: number | string } | null | undefined
): boolean {
  return a?.start === b?.start && a?.end === b?.end && a?.strand === b?.strand;
}

export function sameAnnotationIdentity(
  a:
    | {
        type?: string;
        name?: string;
        start?: number;
        end?: number;
        direction?: string | number;
      }
    | null
    | undefined,
  b:
    | {
        type?: string;
        name?: string;
        start?: number;
        end?: number;
        direction?: string | number;
      }
    | null
    | undefined
): boolean {
  return (
    a?.type === b?.type &&
    a?.name === b?.name &&
    a?.start === b?.start &&
    a?.end === b?.end &&
    a?.direction === b?.direction
  );
}

export function canvasAnnotationPointer(args: {
  showAnnotations: boolean;
  annotationHit: boolean;
  showTranslation: boolean;
  hasPosition: boolean;
  intronHit: boolean;
}): boolean {
  if (!args.showAnnotations) return false;
  if (args.annotationHit) return true;
  return args.showTranslation && args.hasPosition && args.intronHit;
}

export function hoverCursorForMove(args: {
  isOverCutSiteLabel: boolean;
  isOverGGLabel: boolean;
  lineIdx: number;
  x: number;
}): { x: number; lineIdx: number } | null {
  if (args.isOverCutSiteLabel || args.isOverGGLabel) return null;
  if (args.lineIdx < 0) return null;
  return { x: args.x, lineIdx: args.lineIdx };
}

export function hoverCursorChanged(
  prev: { x: number; lineIdx: number } | null | undefined,
  next: { x: number; lineIdx: number } | null | undefined
): boolean {
  return prev?.x !== next?.x || prev?.lineIdx !== next?.lineIdx;
}

export function nextHoveredCodon<
  T extends { start: number; end: number; strand: number; isOverlayClick?: boolean },
>(codon: T | null | undefined, prev: T | null): T | null {
  if (!codon || codon.isOverlayClick) return prev === null ? prev : null;
  return sameIntervalStrand(prev, codon) ? prev : codon;
}

export function canvasFallbackCursor(
  currentCursor: string,
  position: number | null
): 'text' | 'default' | null {
  if (currentCursor === 'ew-resize' || currentCursor === 'pointer') return null;
  return position !== null ? 'text' : 'default';
}
import { orderedCdsSegments } from '../hit-detection/spliced-cds';
