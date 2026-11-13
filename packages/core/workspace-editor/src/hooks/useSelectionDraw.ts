import { computeLineTrackPositions } from '../line-track-layout';
import { withRowMorph } from '../predictive-wrap-layout';
import type { SequenceDrawingContext } from '../rendering/drawing-context';

import { useCallback, useRef } from 'react';
import { canvasTestWindow } from '../canvas-test-bridge';
import { getSequenceWebGLContext } from '../rendering/webgl-drawing-context';
import type {
  LayoutSnapshot2D,
  WorkspaceEditorConfig,
  Selection,
  InsertedRange,
  DeletedRange,
  PrimerDisplay,
  BpHighlight,
} from '../types';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { RenderedCutSite } from '../restriction-enzymes/cut-site-styling';
import { type ShiftPreviewLineInfo, drawShiftPreview } from '../canvas-drawing';
import { RULER_HEIGHT, ROW_BOTTOM_PADDING } from '../layout-constants';
import { PRIMER_CANVAS_CONSTANTS } from '../canvas-constants';
import { getCanvasTheme } from '../canvas-theme';
import { primerOverlapsLine, type PrecomputedLinePosition } from './usePrecomputedLayout';
import { packPrimerLanes } from '../primer-layout';
import { drawHoverCursorLine } from '../selection-primitives';
import { getCursorColumnFromX, getCursorPositionFromX } from '../hit-detection/position';

function computeSequenceY(
  line: BpHighlightLine,
  baseY: number,
  config: BpHighlightDrawConfig
): number {
  return (
    baseY +
    computeLineTrackPositions(
      {
        lineIndex: 0,
        sequence: '',
        complementSequence: '',
        annotations: [],
        ...line,
        translationLaneCount: line.translationLaneCount ?? 0,
      },
      { ...DEFAULT_EDITOR_CONFIG, ...config }
    ).sequenceY -
    line.y
  );
}

function hoverCursorLineBottom(args: {
  nextLine: LayoutSnapshot2D['lines'][number] | undefined;
  yOffset: number;
  rowTopPadding: number;
  sequenceY: number;
  config: WorkspaceEditorConfig;
  primers: PrimerDisplay[];
  line: LayoutSnapshot2D['lines'][number];
  sequenceLength: number;
  rowBottomPadding: number;
}): number {
  if (args.line.naturalHeight !== undefined) {
    return args.line.y - args.yOffset + args.line.naturalHeight;
  }
  if (args.nextLine) {
    return args.nextLine.y - args.yOffset - args.rowTopPadding;
  }
  const revPrimersOnLine = args.config.showPrimers
    ? args.primers.filter(
        (p) =>
          p.direction === 'reverse' &&
          primerOverlapsLine(p, args.line.startPos, args.line.endPos, args.sequenceLength)
      )
    : [];
  const revLaneCount =
    revPrimersOnLine.length > 0
      ? packPrimerLanes(revPrimersOnLine, args.line.startPos, args.line.endPos, args.sequenceLength)
          .laneCount
      : 0;
  const reversePrimerHeight =
    revLaneCount *
    args.config.rowHeight *
    (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
  const complementHeight = args.config.showReverseComplement ? args.config.rowHeight : 0;
  return (
    args.sequenceY +
    args.config.rowHeight +
    complementHeight +
    reversePrimerHeight +
    RULER_HEIGHT +
    ROW_BOTTOM_PADDING +
    args.rowBottomPadding
  );
}

function drawEditableCursorOnSelectionOverlay(args: {
  ctx: SequenceDrawingContext;
  editable: boolean;
  cursorPos: number | undefined;
  showCursor: boolean;
  sel: Selection | null;
  precomputedLinePositions: PrecomputedLinePosition[];
  vp: { scrollTop: number; height: number };
  yOffset: number;
  x: number;
  config: WorkspaceEditorConfig;
}): void {
  if (!args.editable || args.cursorPos === undefined || !args.showCursor || args.sel) return;
  for (const lp of args.precomputedLinePositions) {
    if (args.cursorPos < lp.line.startPos || args.cursorPos > lp.line.endPos) continue;
    if (
      args.vp.height > 0 &&
      (lp.absoluteLineY < args.vp.scrollTop - 50 ||
        lp.absoluteLineY > args.vp.scrollTop + args.vp.height + 50)
    ) {
      continue;
    }
    const sequenceY = lp.sequenceY - args.yOffset;
    const cursorX = args.x + (args.cursorPos - lp.line.startPos) * args.config.charWidth;
    args.ctx.fillStyle = getCanvasTheme().accent;
    args.ctx.fillRect(cursorX - 1, sequenceY, 2, args.config.rowHeight);
    break;
  }
}

function collectShiftPreviewLineInfos(args: {
  layout: LayoutSnapshot2D;
  vp: { scrollTop: number; height: number };
  yOffset: number;
  config: WorkspaceEditorConfig;
}): ShiftPreviewLineInfo[] {
  const lineInfos: ShiftPreviewLineInfo[] = [];
  for (let i = 0; i < args.layout.lines.length; i++) {
    const line = args.layout.lines[i];
    if (
      args.vp.height > 0 &&
      (line.y < args.vp.scrollTop - 50 || line.y > args.vp.scrollTop + args.vp.height + 50)
    ) {
      continue;
    }
    const y = line.y - args.yOffset;
    const sequenceY = computeSequenceY(line, y, args.config);
    const complementY = sequenceY + args.config.rowHeight;
    lineInfos.push({
      startPos: line.startPos,
      endPos: line.endPos,
      annotationY: y,
      sequenceY,
      complementY,
      lineEndY: complementY + (args.config.showReverseComplement ? args.config.rowHeight : 0),
    });
  }
  return lineInfos;
}

function strokeHoveredEnzymeCutSiteLabels(args: {
  ctx: SequenceDrawingContext;
  hoveredEnzymeName: string | null | undefined;
  renderedCutSites: RenderedCutSite[] | undefined;
  yOffset: number;
  vp: { scrollTop: number; height: number };
}): void {
  if (!args.hoveredEnzymeName) return;
  if (!args.renderedCutSites || args.renderedCutSites.length === 0) return;
  args.ctx.save();
  args.ctx.lineWidth = 1.5;
  for (const r of args.renderedCutSites) {
    if (r.cutSite.enzyme.name !== args.hoveredEnzymeName) continue;
    const lb = r.labelBounds;
    const ry = lb.y - args.yOffset;
    if (args.vp.height > 0 && (ry + lb.height < -10 || ry > args.vp.height + 10)) {
      continue;
    }
    args.ctx.strokeStyle = r.cutSite.color;
    args.ctx.strokeRect(lb.x - 1, ry - 1, lb.width + 2, lb.height + 2);
  }
  args.ctx.restore();
}

function drawHoverCursorOnSelectionOverlay(args: {
  ctx: SequenceDrawingContext;
  hoverCursor: { x: number; lineIdx: number } | null;
  sel: Selection | null;
  layout: LayoutSnapshot2D;
  vp: { scrollTop: number; height: number };
  yOffset: number;
  x: number;
  config: WorkspaceEditorConfig;
  cursorPos: number | undefined;
  showCursor: boolean;
  primers: PrimerDisplay[];
  sequenceLength: number;
  rowTopPadding: number;
  rowBottomPadding: number;
}): void {
  if (args.hoverCursor === null || args.sel) return;
  const line = args.layout.lines[args.hoverCursor.lineIdx];
  if (!line) return;
  if (
    args.vp.height !== 0 &&
    !(line.y >= args.vp.scrollTop - 50 && line.y <= args.vp.scrollTop + args.vp.height + 50)
  ) {
    return;
  }
  const y = line.y - args.yOffset;
  const sequenceY = computeSequenceY(line, y, args.config);
  const cursorColumn = getCursorColumnFromX(args.hoverCursor.x, line, args.config);
  const hoverX = args.x + cursorColumn * args.config.charWidth;
  const hoverPosition = getCursorPositionFromX(args.hoverCursor.x, line, args.config);
  if (args.cursorPos !== undefined && hoverPosition === args.cursorPos && args.showCursor) {
    return;
  }
  const lineTop = y - args.rowTopPadding;
  const nextLine = args.layout.lines[args.hoverCursor.lineIdx + 1];
  const lineBottom = hoverCursorLineBottom({
    nextLine,
    yOffset: args.yOffset,
    rowTopPadding: args.rowTopPadding,
    sequenceY,
    config: args.config,
    primers: args.primers,
    line,
    sequenceLength: args.sequenceLength,
    rowBottomPadding: args.rowBottomPadding,
  });
  drawHoverCursorLine(args.ctx, hoverX, lineTop, lineBottom);
}

interface UseSelectionDrawParams {
  selectionCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.MutableRefObject<{ scrollTop: number; height: number }>;
  hoverCursorRef: React.MutableRefObject<{ x: number; lineIdx: number } | null>;
  shiftPreviewRef: React.MutableRefObject<{
    hoverPosition: number;
    anchorPosition: number;
    isOptionHeld: boolean;
  } | null>;
  layout: LayoutSnapshot2D;
  config: WorkspaceEditorConfig;
  precomputedLinePositions: PrecomputedLinePosition[];
  editable: boolean;
  sequenceLength: number;
  primers: PrimerDisplay[];
  cursor: number | undefined;
  cursorVisible: boolean;
  insertedRanges: InsertedRange[];
  deletedRanges: DeletedRange[];
  hoveredEnzymeNameRef: React.MutableRefObject<string | null | undefined>;
  renderedCutSitesRef: React.MutableRefObject<RenderedCutSite[]>;
  bpHighlightsRef: React.MutableRefObject<ReadonlyArray<BpHighlight>>;
}

export type { BpHighlight } from '../types';

export interface BpHighlightLine {
  startPos: number;
  endPos: number;
  y: number;
  annotationLaneCount: number;
  translationLaneCount?: number;
  forwardOrfLaneCount?: number;
  reverseOrfLaneCount?: number;
  forwardPrimerLaneCount?: number;
  reversePrimerLaneCount?: number;
}

export interface BpHighlightDrawConfig {
  marginLeft: number;
  charWidth: number;
  rowHeight: number;
  showAnnotations: boolean;
  showTranslation: boolean;
  showReverseComplement: boolean;
  showResidueNumbers?: boolean;
}

export interface BpHighlightDrawViewport {
  scrollTop: number;
  height: number;
}

export function paintBpHighlights(
  ctx: SequenceDrawingContext,
  highlights: ReadonlyArray<BpHighlight>,
  lines: ReadonlyArray<BpHighlightLine>,
  config: BpHighlightDrawConfig,
  viewport: BpHighlightDrawViewport
): void {
  if (highlights.length === 0) return;
  const x = config.marginLeft;
  ctx.save();
  for (const h of highlights) {
    ctx.fillStyle = h.color;
    ctx.globalAlpha = h.alpha ?? 0.4;
    for (const line of lines) {
      if (h.end < line.startPos || h.start > line.endPos) continue;
      if (
        viewport.height > 0 &&
        (line.y < viewport.scrollTop - 50 || line.y > viewport.scrollTop + viewport.height + 50)
      ) {
        continue;
      }
      const bpStart = Math.max(h.start, line.startPos);
      const bpEnd = Math.min(h.end, line.endPos);
      const charStart = bpStart - line.startPos;
      const charEnd = bpEnd - line.startPos;
      const yLine = line.y - viewport.scrollTop;
      const sequenceY = computeSequenceY(line, yLine, config);
      const xStart = x + charStart * config.charWidth;
      const xEnd = x + (charEnd + 1) * config.charWidth;
      const fillHeight = config.rowHeight + (config.showReverseComplement ? config.rowHeight : 0);
      ctx.fillRect(xStart, sequenceY, xEnd - xStart, fillHeight);
    }
  }
  ctx.restore();
}

interface UseSelectionDrawResult {
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
}

export function useSelectionDraw({
  selectionCanvasRef,
  viewportRef,
  hoverCursorRef,
  shiftPreviewRef,
  layout,
  config,
  precomputedLinePositions,
  editable,
  sequenceLength,
  primers,
  cursor,
  cursorVisible,
  insertedRanges,
  deletedRanges,
  hoveredEnzymeNameRef,
  renderedCutSitesRef,
  bpHighlightsRef,
}: UseSelectionDrawParams): UseSelectionDrawResult {
  const drawSelectionAndCursor = useCallback(
    (
      sel: Selection | null,
      cursorPos: number | undefined,
      showCursor: boolean,
      _ranges: InsertedRange[] = [],
      _delRanges: DeletedRange[] = [],
      hoverCursor: { x: number; lineIdx: number } | null = null
    ) => {
      const shiftPreviewState = shiftPreviewRef.current;
      const canvas = selectionCanvasRef.current;
      if (!canvas || !canvas.isConnected) return;

      const ctx = getSequenceWebGLContext(canvas);
      if (!ctx) return;
      ctx.onRestore = () =>
        drawSelectionAndCursorRef.current(
          sel,
          cursorPos,
          showCursor,
          _ranges,
          _delRanges,
          hoverCursor
        );
      if (!ctx.beginFrame()) return;

      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const vp = viewportRef.current;
      const yOffset = vp.scrollTop;
      const canvasHeight = vp.height > 0 ? vp.height + 100 : layout.totalHeight;

      ctx.clearRect(0, 0, layout.totalWidth, canvasHeight);

      const x = config.marginLeft;
      const rowTopPadding = 32;
      const rowBottomPadding = 16;

      for (const lp of precomputedLinePositions) {
        const lineIndex = layout.lines.indexOf(lp.line);
        const rowLayout = { ...layout, lines: [lp.line] };
        withRowMorph(ctx, lp.line, yOffset, () => {
          drawEditableCursorOnSelectionOverlay({
            ctx,
            editable,
            cursorPos,
            showCursor,
            sel,
            precomputedLinePositions: [lp],
            vp,
            yOffset,
            x,
            config,
          });

          drawHoverCursorOnSelectionOverlay({
            ctx,
            hoverCursor: hoverCursor?.lineIdx === lineIndex ? { ...hoverCursor, lineIdx: 0 } : null,
            sel,
            layout: rowLayout,
            vp,
            yOffset,
            x,
            config,
            cursorPos,
            showCursor,
            primers,
            sequenceLength,
            rowTopPadding,
            rowBottomPadding,
          });

          if (shiftPreviewState) {
            drawShiftPreview(
              ctx,
              collectShiftPreviewLineInfos({ layout: rowLayout, vp, yOffset, config }),
              shiftPreviewState,
              x,
              config,
              sequenceLength
            );
          }

          const bpHighlights = bpHighlightsRef.current;
          if (bpHighlights?.length) paintBpHighlights(ctx, bpHighlights, [lp.line], config, vp);
        });
      }

      strokeHoveredEnzymeCutSiteLabels({
        ctx,
        hoveredEnzymeName: hoveredEnzymeNameRef.current,
        renderedCutSites: renderedCutSitesRef.current,
        yOffset,
        vp,
      });

      ctx.endFrame();
      if (import.meta.env.DEV === true || import.meta.env.MODE === 'test') {
        canvasTestWindow(window).__selectionPaintObserver?.({
          t: performance.now(),
          selection: sel ? { ...sel } : null,
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, config, editable, sequenceLength, primers]
  );

  const drawSelectionAndCursorRef = useRef(drawSelectionAndCursor);
  drawSelectionAndCursorRef.current = drawSelectionAndCursor;

  const drawSelectionDirect = useCallback(
    (sel: Selection | null, hoverCursor: { x: number; lineIdx: number } | null = null) => {
      drawSelectionAndCursor(
        sel,
        cursor,
        cursorVisible,
        insertedRanges,
        deletedRanges,
        hoverCursor ?? hoverCursorRef.current
      );
    },
    [drawSelectionAndCursor, cursor, cursorVisible, insertedRanges, deletedRanges]
  );

  return {
    drawSelectionAndCursorRef,
    drawSelectionDirect,
  };
}
