import { useEffect, useLayoutEffect, useRef, type RefObject, type MutableRefObject } from 'react';
import {
  onTick,
  computeAnchoredScrollTop,
  INITIAL_STATE,
  COMMIT_INTERVAL_MS,
  MIN_ZOOM,
  MAX_ZOOM,
  type GestureState,
  type TransformEffect,
  type CommitEffect,
  type ResetEffect,
} from './zoom-controller';
import type { SequenceLayout, WorkspaceEditorConfig } from './types';
import { getPositionFromCoordinates } from './useSequenceLayout';
import { computeLineTrackPositions } from './line-track-layout';
import { paintedRowBackgroundBounds } from './row-background-geometry';
import {
  absoluteRowIndexForY,
  bpForAbsoluteRowIndex,
  getScrollYForSequencePosition,
} from './layout-utils';

export interface UseZoomGestureOptions {
  containerRef: RefObject<HTMLElement | null>;
  canvasRef: RefObject<HTMLElement | null>;
  zoomLevel: number;
  onZoomLevelChange: (next: number) => void;
  bpOffset: number;
  onBpOffsetChange: (next: number) => void;
  layout: SequenceLayout | null;
  config: WorkspaceEditorConfig | null;
  containerWidth: number;
}

export interface UseZoomGestureHandle {
  zoomInFlightRef: MutableRefObject<boolean>;
}

export function clampZoomLocal(value: number): number {
  if (Number.isNaN(value)) return 100;
  if (value < MIN_ZOOM) return MIN_ZOOM;
  if (value > MAX_ZOOM) return MAX_ZOOM;
  return value;
}

export function applyTransform(
  canvas: { style: { transform: string; transformOrigin: string } } | null,
  e: TransformEffect
): void {
  if (!canvas) return;
  canvas.style.transform = `scale(${e.scale})`;
  canvas.style.transformOrigin = `${e.origin.x}px ${e.origin.y}px`;
}

export function clearTransform(
  canvas: { style: { transform: string; transformOrigin: string } } | null
): void {
  if (!canvas) return;
  canvas.style.transform = '';
  canvas.style.transformOrigin = '';
}

export function computeBpOffsetForAnchor(
  anchorBp: number,
  cursorColNew: number,
  charsPerLine: number,
  circularOffset: number = 0
): number {
  if (charsPerLine <= 0) return 0;
  const raw = anchorBp - cursorColNew - circularOffset;
  return ((raw % charsPerLine) + charsPerLine) % charsPerLine;
}

export function computeCursorCol(
  clientX: number,
  containerLeft: number,
  marginLeft: number,
  charWidth: number,
  charsPerLine: number
): number {
  if (charWidth <= 0 || charsPerLine <= 0) return 0;
  const xInSeq = Math.max(0, clientX - containerLeft - marginLeft);
  const col = Math.round(xInSeq / charWidth);
  return Math.max(0, Math.min(charsPerLine - 1, col));
}

export function applyCommitEffects(
  effects: ReadonlyArray<CommitEffect | ResetEffect>,
  deps: {
    currentZoom: number;
    onZoomLevelChange: (next: number) => void;
  }
): {
  pendingAnchor: PendingAnchor | null;
  resetPending: boolean;
} {
  let pendingAnchor: PendingAnchor | null = null;
  let resetPending = false;
  for (const e of effects) {
    if (e.kind === 'commit') {
      const newZoom = clampZoomLocal(deps.currentZoom * e.scaleDelta);
      pendingAnchor = { bp: e.anchorBp, cursorX: e.anchorCursorX, cursorY: e.anchorCursorY };
      deps.onZoomLevelChange(newZoom);
    } else if (e.kind === 'resetTransform') {
      resetPending = true;
    }
  }
  return { pendingAnchor, resetPending };
}

export interface PendingAnchor {
  bp: number;
  cursorX: number;
  cursorY: number;
}

export function bpAtCursor(
  layout: SequenceLayout | null,
  config: WorkspaceEditorConfig | null,
  container: HTMLElement | null,
  clientX: number,
  clientY: number
): number | null {
  if (!container || !layout?.lines?.length || !config) return null;
  const rect = container.getBoundingClientRect();
  const x = clientX - rect.left;
  const yBase = container.scrollTop + (clientY - rect.top);
  const direct = getPositionFromCoordinates(x, yBase, layout, config);
  if (direct !== null && direct !== undefined) return direct;
  const maxDy = Math.max(60, Math.ceil((config.rowHeight ?? 20) * 3));
  for (let dy = 1; dy <= maxDy; dy++) {
    const up = getPositionFromCoordinates(x, yBase - dy, layout, config);
    if (up !== null && up !== undefined) return up;
    const down = getPositionFromCoordinates(x, yBase + dy, layout, config);
    if (down !== null && down !== undefined) return down;
  }
  return null;
}

function findLineForContentY(layout: SequenceLayout, y: number): SequenceLayout['lines'][0] | null {
  const rowGap = layout.summary?.rowGapPx ?? 32;
  for (let idx = 0; idx < layout.lines.length; idx++) {
    const line = layout.lines[idx];
    const nextLine = layout.lines[idx + 1];
    const lineEnd = nextLine ? nextLine.y : layout.totalHeight;
    if (y >= line.y && y < lineEnd) {
      return nextLine && y >= nextLine.y - rowGap ? nextLine : line;
    }
  }
  return null;
}

function normalizeBp(position: number, layout: SequenceLayout): number {
  const seqLen = layout.sequenceLength || layout.summary?.seqLength || 0;
  if (seqLen <= 0) return Math.max(0, position);
  if (layout.isCircular || layout.summary?.isCircular) {
    return ((position % seqLen) + seqLen) % seqLen;
  }
  return Math.max(0, Math.min(seqLen - 1, position));
}

export function bpAtCursorForZoom(
  layout: SequenceLayout | null,
  config: WorkspaceEditorConfig | null,
  container: HTMLElement | null,
  clientX: number,
  clientY: number
): number | null {
  if (!container || !layout?.lines?.length || !config) return null;

  const rect = container.getBoundingClientRect();
  const x = clientX - rect.left;
  if (x < config.marginLeft || config.charWidth <= 0) return null;

  const y = container.scrollTop + (clientY - rect.top);
  let paintedLine: SequenceLayout['lines'][0] | undefined;
  if (config.overviewLod !== true && config.lodLevel !== 'density') {
    for (let i = layout.lines.length - 1; i >= 0; i--) {
      const line = layout.lines[i];
      const bounds = paintedRowBackgroundBounds(computeLineTrackPositions(line, config));
      if (y >= bounds.y && y < bounds.y + bounds.height) {
        paintedLine = line;
        break;
      }
    }
  }
  const direct = getPositionFromCoordinates(
    x,
    y,
    paintedLine ? { ...layout, lines: [paintedLine] } : layout,
    config
  );
  if (direct !== null && direct !== undefined) return normalizeBp(direct, layout);

  let rowStart: number | null = null;
  let charsInRow = 0;
  let rowXOffset = 0;

  if (paintedLine) {
    rowStart = paintedLine.startPos;
    charsInRow = paintedLine.sequence.length;
    rowXOffset = paintedLine.xOffset ?? 0;
  } else if (layout.summary?.rowYOffsets?.length) {
    const rowIndex = absoluteRowIndexForY(y, layout.summary);
    const line = layout.lines.find((row) => row.lineIndex === rowIndex);
    rowStart = line?.startPos ?? bpForAbsoluteRowIndex(rowIndex, layout.summary);
    charsInRow = line?.sequence.length ?? layout.summary.cpr;
    rowXOffset = line?.xOffset ?? 0;
  } else {
    const line = findLineForContentY(layout, y);
    if (!line) return null;
    rowStart = line.startPos;
    charsInRow = line.sequence.length;
    rowXOffset = line.xOffset ?? 0;
  }

  if (rowStart === null || rowStart < 0 || charsInRow <= 0) return null;
  const xInSequence = x - config.marginLeft - rowXOffset;
  const charIndex = Math.max(
    0,
    Math.min(charsInRow - 1, Math.round(xInSequence / config.charWidth))
  );
  return normalizeBp(rowStart + charIndex, layout);
}

export function rowTopForBp(layout: SequenceLayout | null, bp: number): number | null {
  if (!layout?.lines?.length) return null;
  return getScrollYForSequencePosition(bp, layout, true);
}

export function useZoomGesture(opts: UseZoomGestureOptions): UseZoomGestureHandle {
  const stateRef = useRef<GestureState>(INITIAL_STATE);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const zoomInFlightRef = useRef<boolean>(false);

  const pendingAnchorRef = useRef<PendingAnchor | null>(null);
  const pendingResetRef = useRef<boolean>(false);

  const handleCommitEffects = (effects: ReadonlyArray<CommitEffect | ResetEffect>): void => {
    const current = optsRef.current;
    let commitFired: CommitEffect | null = null;
    let resetPending = false;
    for (const e of effects) {
      if (e.kind === 'commit') commitFired = e;
      else if (e.kind === 'resetTransform') resetPending = true;
    }

    if (commitFired !== null) {
      const cfg = current.config;
      const container = current.containerRef.current;
      if (cfg && container && current.containerWidth > 0) {
        const newZoom = clampZoomLocal(current.zoomLevel * commitFired.scaleDelta);
        const newCharWidth =
          current.zoomLevel > 0 ? cfg.charWidth * (newZoom / current.zoomLevel) : cfg.charWidth;
        const newCpl =
          cfg.charsPerLine > 0
            ? cfg.charsPerLine
            : Math.max(
                10,
                Math.floor((current.containerWidth - cfg.marginLeft) / Math.max(0.1, newCharWidth))
              );

        const rect = container.getBoundingClientRect();
        const cursorColNew = computeCursorCol(
          commitFired.anchorCursorX,
          rect.left,
          cfg.marginLeft,
          newCharWidth,
          newCpl
        );
        const circularOffset = current.layout?.circularOffset ?? 0;
        const newBpOffset = computeBpOffsetForAnchor(
          commitFired.anchorBp,
          cursorColNew,
          newCpl,
          circularOffset
        );

        current.onZoomLevelChange(newZoom);
        current.onBpOffsetChange(newBpOffset);

        pendingAnchorRef.current = {
          bp: commitFired.anchorBp,
          cursorX: commitFired.anchorCursorX,
          cursorY: commitFired.anchorCursorY,
        };
      }
    }

    if (resetPending) pendingResetRef.current = true;
  };

  useEffect(() => {
    const id = setInterval(
      () => {
        const result = onTick(stateRef.current, performance.now());
        if (result.effects.length === 0) return;
        stateRef.current = result.state;
        handleCommitEffects(result.effects);
      },
      Math.max(16, Math.floor(COMMIT_INTERVAL_MS / 2))
    );
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    const current = optsRef.current;
    const pending = pendingAnchorRef.current;

    if (pending !== null) {
      const newScrollTop = computeAnchoredScrollTop(pending.bp, pending.cursorY, (bp) =>
        rowTopForBp(current.layout, bp)
      );
      if (newScrollTop !== null) {
        const container = current.containerRef.current;
        if (container !== null) {
          container.scrollTop = newScrollTop;
        }
      }
      pendingAnchorRef.current = null;
    }

    if (pendingResetRef.current) {
      clearTransform(
        current.canvasRef.current as {
          style: { transform: string; transformOrigin: string };
        } | null
      );
      pendingResetRef.current = false;
    }
  }, [opts.zoomLevel, opts.bpOffset, opts.layout]);

  return { zoomInFlightRef };
}
