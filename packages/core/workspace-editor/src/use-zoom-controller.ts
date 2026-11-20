import { inputTargetAllows, subscribeInputRevocation } from '@waypoint/platform/input-ownership';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { WheelMotion, shouldAnimateWheel } from '@waypoint/platform/wheel-motion';
import { canvasTestWindow } from './canvas-test-bridge';
import type { RefObject } from 'react';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  charsPerRowAt,
  pxPerBpAt,
  normalizeWheelDeltaY,
  nextZoomFromWheelDelta,
  DEFAULT_ZOOM_SENSITIVITY,
  type BaseConfig,
} from './zoom-math';
import { COMMIT_INTERVAL_MS, SETTLE_TIMEOUT_MS } from './zoom-controller';
import { bpAtCursorForZoom } from './use-zoom-gesture';
import {
  absoluteRowIndexForBp,
  bpForAbsoluteRowIndex,
  getScrollYForSequencePosition,
  rowPitchPx,
  yForAbsoluteRowIndex,
} from './layout-utils';
import type { SequenceLayout, WorkspaceEditorConfig } from './types';
import { computeLineTrackPositions, lineTrackBoundaries } from './line-track-layout';
import {
  linearWrapTopBp,
  rowPaintY,
  rowPaintBounds,
  trackBandAt,
  type WrapScreenAnchor,
} from './predictive-wrap-layout';

type ZoomAnchorRowRole = 'top-buffer' | 'real' | 'bottom-buffer';

export interface ZoomAnchorRowPlacement {
  role: ZoomAnchorRowRole;
  progress: number;

  sequenceProgress?: number;

  trackPoint?: { band: number; progress: number };
  edgePoint?: { edge: 'start' | 'end'; offsetPx: number };

  cycle?: number;
}

function rowRoleForIndex(
  rowIndex: number,
  topBufferCount: number,
  realRowCount: number
): ZoomAnchorRowRole {
  if (rowIndex < topBufferCount) return 'top-buffer';
  if (rowIndex >= topBufferCount + realRowCount) return 'bottom-buffer';
  return 'real';
}

function rowIndexForBpAndRole(
  bp: number,
  realRowIndex: number,
  role: ZoomAnchorRowRole,
  topBufferCount: number,
  realRowCount: number,
  layout: SequenceLayout
): number {
  if (role === 'real') return realRowIndex;
  const summary = layout.summary;
  if (!summary) return realRowIndex;
  const first = role === 'top-buffer' ? 0 : topBufferCount + realRowCount;
  const last = role === 'top-buffer' ? topBufferCount : summary.totalRows;
  const normalizedBp = ((bp % summary.seqLength) + summary.seqLength) % summary.seqLength;
  for (let rowIndex = first; rowIndex < last; rowIndex += 1) {
    const rowStart = bpForAbsoluteRowIndex(rowIndex, summary);
    if (rowStart < 0) continue;
    const offset =
      (((normalizedBp - rowStart) % summary.seqLength) + summary.seqLength) % summary.seqLength;
    if (offset < summary.cpr) return rowIndex;
  }
  return realRowIndex;
}

function distanceFromRow(contentY: number, rowIndex: number, layout: SequenceLayout): number {
  const summary = layout.summary;
  if (!summary) return Number.POSITIVE_INFINITY;
  const top = yForAbsoluteRowIndex(rowIndex, summary);
  const bottom = yForAbsoluteRowIndex(rowIndex + 1, summary);
  if (contentY < top) return top - contentY;
  if (contentY >= bottom) return contentY - bottom;
  return 0;
}

function safeProgressInRow(contentY: number, rowIndex: number, layout: SequenceLayout): number {
  const summary = layout.summary;
  if (!summary) return 0;
  const rowTop = yForAbsoluteRowIndex(rowIndex, summary);
  const pitch = rowPitchPx(rowIndex, summary);
  const insetPx = Math.min(2, pitch / 4);

  const actualGap = Math.max(0, pitch - summary.rowHeights[rowIndex]);
  const safeEndPx = Math.max(insetPx, pitch - actualGap - insetPx);
  const offsetPx = Math.max(insetPx, Math.min(safeEndPx, contentY - rowTop));
  return offsetPx / pitch;
}

function nucleotidePaintHeight(config: WorkspaceEditorConfig): number {
  return config.overviewLod || config.lodLevel === 'density'
    ? Math.max(1, Math.ceil(config.rowHeight))
    : config.rowHeight;
}

export function captureZoomAnchorRowPlacement(
  bp: number,
  contentY: number,
  layout: SequenceLayout,
  config?: WorkspaceEditorConfig
): ZoomAnchorRowPlacement {
  const summary = layout.summary;
  if (!summary?.rowYOffsets?.length) return { role: 'real', progress: 0 };
  const realRowIndex = absoluteRowIndexForBp(bp, summary);
  if (realRowIndex < 0) return { role: 'real', progress: 0 };
  const candidates = [
    rowIndexForBpAndRole(
      bp,
      realRowIndex,
      'top-buffer',
      summary.topBufferCount,
      summary.realRowCount,
      layout
    ),
    realRowIndex,
    rowIndexForBpAndRole(
      bp,
      realRowIndex,
      'bottom-buffer',
      summary.topBufferCount,
      summary.realRowCount,
      layout
    ),
  ].filter((rowIndex, index, all) => all.indexOf(rowIndex) === index);
  if (summary.isCircular) {
    for (const line of layout.lines) {
      const offset =
        (((bp - line.startPos) % summary.seqLength) + summary.seqLength) % summary.seqLength;
      if (offset < line.sequence.length && !candidates.includes(line.lineIndex))
        candidates.push(line.lineIndex);
    }
  }
  const rowIndex = candidates.reduce((best, candidate) =>
    distanceFromRow(contentY, candidate, layout) < distanceFromRow(contentY, best, layout)
      ? candidate
      : best
  );
  const line = layout.lines.find((row) => row.lineIndex === rowIndex);
  const sequenceBounds =
    line && config
      ? rowPaintBounds(
          line,
          computeLineTrackPositions(line, config).sequenceY,
          nucleotidePaintHeight(config)
        )
      : null;
  const sequenceY = sequenceBounds?.y ?? null;
  const sequenceHeight = sequenceBounds?.height ?? 0;
  const inSequence =
    sequenceY !== null && contentY >= sequenceY && contentY <= sequenceY + sequenceHeight;
  const bands =
    line && config
      ? (line.trackMorph?.painted ??
        lineTrackBoundaries(line, config).map((y) => y * (line.heightScale ?? 1)))
      : null;
  let trackPoint: ZoomAnchorRowPlacement['trackPoint'];
  let edgePoint: ZoomAnchorRowPlacement['edgePoint'];
  if (line && bands) {
    const localY = contentY - line.y;
    const end = bands[bands.length - 1];
    if (localY < 0) edgePoint = { edge: 'start', offsetPx: localY };
    else if (localY > end) edgePoint = { edge: 'end', offsetPx: localY - end };
    else {
      const band = trackBandAt(bands, localY);
      const span = bands[band + 1] - bands[band];
      trackPoint = { band, progress: span > 0 ? (localY - bands[band]) / span : 0 };
    }
  }
  return {
    role: rowRoleForIndex(rowIndex, summary.topBufferCount, summary.realRowCount),
    cycle: summary.isCircular
      ? Math.floor(
          (summary.topBp +
            (rowIndex - summary.topBufferCount) * summary.cpr +
            ((((bp - bpForAbsoluteRowIndex(rowIndex, summary)) % summary.seqLength) +
              summary.seqLength) %
              summary.seqLength)) /
            summary.seqLength
        )
      : undefined,

    progress: safeProgressInRow(contentY, rowIndex, layout),
    trackPoint,
    edgePoint,
    sequenceProgress:
      inSequence && sequenceHeight > 0 ? (contentY - sequenceY!) / sequenceHeight : undefined,
  };
}

export function zoomAnchorContentY(
  bp: number,
  placement: ZoomAnchorRowPlacement,
  layout: SequenceLayout,
  config?: WorkspaceEditorConfig
): number | null {
  const summary = layout.summary;
  if (!summary?.rowYOffsets?.length) {
    return getScrollYForSequencePosition(bp, layout, true);
  }
  const realRowIndex = absoluteRowIndexForBp(bp, summary);
  if (realRowIndex < 0) return null;
  let rowIndex = rowIndexForBpAndRole(
    bp,
    realRowIndex,
    placement.role,
    summary.topBufferCount,
    summary.realRowCount,
    layout
  );
  if (summary.isCircular && placement.cycle !== undefined) {
    const exactIndex =
      Math.floor((bp + placement.cycle * summary.seqLength - summary.topBp) / summary.cpr) +
      summary.topBufferCount;
    if (exactIndex >= 0 && exactIndex < summary.totalRows) rowIndex = exactIndex;
  }
  const line = layout.lines.find((row) => row.lineIndex === rowIndex);

  if (line && config && placement.sequenceProgress !== undefined) {
    const bounds = rowPaintBounds(
      line,
      computeLineTrackPositions(line, config).sequenceY,
      nucleotidePaintHeight(config)
    );
    return bounds.y + bounds.height * placement.sequenceProgress;
  }
  if (line && config && (placement.trackPoint || placement.edgePoint)) {
    const bands =
      line.trackMorph?.painted ??
      lineTrackBoundaries(line, config).map((y) => y * (line.heightScale ?? 1));
    if (placement.edgePoint) {
      return (
        line.y +
        (placement.edgePoint.edge === 'start' ? 0 : bands[bands.length - 1]) +
        placement.edgePoint.offsetPx
      );
    }
    const { band, progress } = placement.trackPoint!;
    if (band >= 0 && band < bands.length - 1) {
      return line.y + bands[band] + (bands[band + 1] - bands[band]) * progress;
    }
  }
  const pitch = rowPitchPx(rowIndex, summary);
  const insetProgress = Math.min(0.25, 2 / pitch);
  const actualGap = Math.max(0, pitch - summary.rowHeights[rowIndex]);
  const gapStartProgress = Math.max(insetProgress, (pitch - actualGap - 2) / pitch);
  const progress = Math.max(insetProgress, Math.min(gapStartProgress, placement.progress));
  return yForAbsoluteRowIndex(rowIndex, summary) + progress * pitch;
}

export interface ComputeZoomStepOpts {
  deltaPx: number;
  cursor: { clientX: number; clientY: number };
  currentZoom: number;
  currentTopBp: number;

  isCircular: boolean;
  circularOffset: number;
  baseConfig: BaseConfig;
  containerWidth: number;

  containerRect: { left: number; top: number };

  container: HTMLElement;
  layout: SequenceLayout;
  config: WorkspaceEditorConfig;
  minZoom: number;
  maxZoom: number;
  sensitivity: number;

  maxDeltaPxPerCommit?: number;
}

export interface ComputeZoomStepWithAnchorOpts {
  targetZoom?: number;
  deltaPx: number;
  cursor: { clientX: number; clientY: number };

  anchorBp: number;
  anchorUnwrappedBp?: number;
  currentZoom: number;
  currentTopBp: number;

  isCircular: boolean;
  circularOffset: number;
  baseConfig: BaseConfig;
  containerWidth: number;
  containerRect: { left: number; top: number };
  minZoom: number;
  maxZoom: number;
  sensitivity: number;
  maxDeltaPxPerCommit?: number;

  rebaseCircularOrigin?: boolean;
  rebaseLinearOrigin?: boolean;
  pinLinearOrigin?: boolean;
  holdLinearOrigin?: boolean;
  sequenceLength?: number;
}

export function computeNextZoomFromDelta(
  currentZoom: number,
  deltaPx: number,
  sensitivity: number,
  minZoom: number,
  maxZoom: number,
  maxDeltaPx: number
): number {
  return nextZoomFromWheelDelta(currentZoom, deltaPx, {
    minZoom,
    maxZoom,
    sensitivity,
    maxAbsDeltaPx: maxDeltaPx,
  });
}

function topBpForAnchorColumn(
  anchorBp: number,
  nextZoom: number,
  cursorX: number,
  containerLeft: number,
  containerWidth: number,
  circularOffset: number,
  base: BaseConfig
): { topBp: number; newCpr: number } | null {
  const newCpr = charsPerRowAt(nextZoom, containerWidth, base);
  const newPxPerBp = pxPerBpAt(nextZoom, base);
  if (newCpr <= 0 || newPxPerBp <= 0) return null;

  const rawCol = Math.round((cursorX - containerLeft - base.marginLeft) / newPxPerBp);
  const colNew = Math.max(0, Math.min(newCpr - 1, rawCol));
  const raw = anchorBp - colNew - circularOffset;
  const newBpOffset = ((raw % newCpr) + newCpr) % newCpr;
  return { topBp: circularOffset + newBpOffset, newCpr };
}

export function computeZoomStep(
  opts: ComputeZoomStepOpts
): { zoomLevel: number; topBp: number } | null {
  const {
    deltaPx,
    cursor,
    currentZoom,
    currentTopBp,
    isCircular,
    circularOffset,
    baseConfig: base,
    containerWidth: width,
    containerRect: rect,
    container,
    layout,
    config,
    minZoom,
    maxZoom,
    sensitivity,
    maxDeltaPxPerCommit = 120,
  } = opts;

  if (Math.abs(deltaPx) < 0.5) return null;

  const nextZoom = computeNextZoomFromDelta(
    currentZoom,
    deltaPx,
    sensitivity,
    minZoom,
    maxZoom,
    maxDeltaPxPerCommit
  );
  if (nextZoom === currentZoom) return null;

  if (!isCircular) {
    return { zoomLevel: nextZoom, topBp: currentTopBp };
  }

  const anchorBp = bpAtCursorForZoom(layout, config, container, cursor.clientX, cursor.clientY);
  if (anchorBp === null) {
    return { zoomLevel: nextZoom, topBp: currentTopBp };
  }

  const result = topBpForAnchorColumn(
    anchorBp +
      (captureZoomAnchorRowPlacement(
        anchorBp,
        container.scrollTop + cursor.clientY - rect.top,
        layout,
        config
      ).cycle ?? 0) *
        (layout.summary?.seqLength ?? 0),
    nextZoom,
    cursor.clientX,
    rect.left,
    width,
    circularOffset,
    base
  );
  if (result === null) return null;
  return { zoomLevel: nextZoom, topBp: result.topBp };
}

export function computeZoomStepWithAnchor(
  opts: ComputeZoomStepWithAnchorOpts
): { zoomLevel: number; topBp: number; circularOffset?: number } | null {
  const {
    deltaPx,
    cursor,
    anchorBp,
    currentZoom,
    currentTopBp,
    isCircular,
    circularOffset,
    baseConfig: base,
    containerWidth: width,
    containerRect: rect,
    minZoom,
    maxZoom,
    sensitivity,
    maxDeltaPxPerCommit = 120,
  } = opts;

  if (opts.targetZoom === undefined && Math.abs(deltaPx) < 0.5) return null;

  const nextZoom =
    opts.targetZoom === undefined
      ? computeNextZoomFromDelta(
          currentZoom,
          deltaPx,
          sensitivity,
          minZoom,
          maxZoom,
          maxDeltaPxPerCommit
        )
      : Math.max(minZoom, Math.min(maxZoom, opts.targetZoom));
  if (nextZoom === currentZoom) return null;

  if (!isCircular && opts.holdLinearOrigin) return { zoomLevel: nextZoom, topBp: 0 };

  if (anchorBp < 0 || (!isCircular && !opts.rebaseLinearOrigin)) {
    return { zoomLevel: nextZoom, topBp: currentTopBp };
  }

  if (!isCircular) {
    const cpr = charsPerRowAt(nextZoom, width, base);
    const column = Math.max(
      0,
      Math.min(
        cpr - 1,
        Math.round((cursor.clientX - rect.left - base.marginLeft) / pxPerBpAt(nextZoom, base))
      )
    );
    return {
      zoomLevel: nextZoom,
      topBp: linearWrapTopBp(anchorBp, column, cpr, opts.pinLinearOrigin === true),
    };
  }

  if (opts.rebaseCircularOrigin && (opts.sequenceLength ?? 0) > 0) {
    const seqLen = opts.sequenceLength!;
    const cpr = charsPerRowAt(nextZoom, width, base);
    const column = Math.max(
      0,
      Math.min(
        cpr - 1,
        Math.round((cursor.clientX - rect.left - base.marginLeft) / pxPerBpAt(nextZoom, base))
      )
    );
    const origin = (((anchorBp - column) % seqLen) + seqLen) % seqLen;
    return { zoomLevel: nextZoom, topBp: origin, circularOffset: origin };
  }

  const result = topBpForAnchorColumn(
    opts.anchorUnwrappedBp ?? anchorBp,
    nextZoom,
    cursor.clientX,
    rect.left,
    width,
    circularOffset,
    base
  );
  if (result === null) return null;
  return { zoomLevel: nextZoom, topBp: result.topBp };
}

export interface UseZoomControllerOpts {
  browserWheelGestureOwnership?: boolean;

  continuous?: boolean;

  requestFrame?: () => void;

  onWrapAnchor?: (anchor: WrapScreenAnchor) => void;

  onPreviewZoomTarget?: (zoomLevel: number, direction: -1 | 1) => void;

  zoomLevel: number;

  topBp: number;

  circularOffset: number;

  setZoomState: (next: { zoomLevel: number; topBp: number; circularOffset?: number }) => void;

  seqLength: number;

  isCircular: boolean;

  baseConfig: BaseConfig;

  containerWidth: number;

  containerRef: RefObject<HTMLElement | null>;

  zoomTargetRef: RefObject<HTMLElement | null>;

  layout: SequenceLayout | null;

  config: WorkspaceEditorConfig | null;

  minZoom?: number;
  maxZoom?: number;

  zoomSensitivityPxPerPoint?: number;

  deferCommitsUntilSettle?: boolean;

  onGestureStateChange?: (isZooming: boolean) => void;

  onScrollBoundaryOffset?: (additionalSpace: number, edge?: 'start' | 'end') => void;

  scrollEndHeadroom?: number;
}

export interface UseZoomControllerReturn {
  isZooming(): boolean;

  hasPendingCommit(): boolean;

  flushFrame(now: number): boolean;

  onWheel(e: WheelEvent): void;

  zoomTo(zoomLevel: number): boolean;

  correctZoomFloor(zoomLevel: number): boolean;

  cancelGesture(): void;
}

const MAX_WHEEL_DELTA_PX_PER_COMMIT = 120;

const MAX_WHEEL_DELTA_PX_PER_PREVIEW = 240;

const WHEEL_TAIL_QUIET_MS = 1_000;
const WHEEL_TAIL_NEW_GESTURE_MIN_DELTA_PX = 24;

const MIN_DELTA_PX_PER_TICK_COMMIT = 80;
const PREVIEW_INTERPOLATION_MS = 16;

const ANCHOR_DEADLINE_MS = 1_000;

function applyPreviewTransform(
  target: HTMLElement | null,
  scale: number,
  origin: { x: number; y: number }
): void {
  if (!target) return;
  target.style.transition = `transform ${PREVIEW_INTERPOLATION_MS}ms linear`;
  target.style.transform = `translate3d(0, 0, 0) scale(${scale})`;
  target.style.transformOrigin = `${origin.x}px ${origin.y}px`;
}

function clearPreviewTransform(target: HTMLElement | null): void {
  if (!target) return;
  target.style.transition = 'none';
  target.style.transform = 'translate3d(0, 0, 0)';
  target.style.transformOrigin = '';
}

export function useZoomController(opts: UseZoomControllerOpts): UseZoomControllerReturn {
  const zoomLevelRef = useRef(opts.zoomLevel);
  const topBpRef = useRef(opts.topBp);
  const isCircularRef = useRef(opts.isCircular);
  const circularOffsetRef = useRef(opts.circularOffset);
  const containerWidthRef = useRef(opts.containerWidth);
  const baseConfigRef = useRef(opts.baseConfig);
  const layoutRef = useRef(opts.layout);
  const configRef = useRef(opts.config);
  const setZoomStateRef = useRef(opts.setZoomState);
  const onGestureStateChangeRef = useRef(opts.onGestureStateChange);
  const onWrapAnchorRef = useRef(opts.onWrapAnchor);
  const onPreviewZoomTargetRef = useRef(opts.onPreviewZoomTarget);
  const requestFrameRef = useRef(opts.requestFrame);
  const containerRefRef = useRef(opts.containerRef);
  const zoomTargetRefRef = useRef(opts.zoomTargetRef);
  zoomLevelRef.current = opts.zoomLevel;
  topBpRef.current = opts.topBp;
  isCircularRef.current = opts.isCircular;
  circularOffsetRef.current = opts.circularOffset;
  containerWidthRef.current = opts.containerWidth;
  baseConfigRef.current = opts.baseConfig;
  layoutRef.current = opts.layout;
  configRef.current = opts.config;
  setZoomStateRef.current = opts.setZoomState;
  onGestureStateChangeRef.current = opts.onGestureStateChange;
  onWrapAnchorRef.current = opts.onWrapAnchor;
  onPreviewZoomTargetRef.current = opts.onPreviewZoomTarget;
  requestFrameRef.current = opts.requestFrame;
  containerRefRef.current = opts.containerRef;
  zoomTargetRefRef.current = opts.zoomTargetRef;

  const minZoom = opts.minZoom ?? MIN_ZOOM;
  const maxZoom = opts.maxZoom ?? MAX_ZOOM;
  const sensitivity = opts.zoomSensitivityPxPerPoint ?? DEFAULT_ZOOM_SENSITIVITY;
  const coarseZoomMotionRef = useRef(new WheelMotion(1e-6));
  const clampLogZoom = useCallback(
    (value: number) => Math.max(Math.log(minZoom), Math.min(Math.log(maxZoom), value)),
    [minZoom, maxZoom]
  );

  const isZoomingRef = useRef(false);
  const inputOwnerRef = useRef<'wheel' | 'control' | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWheelAtRef = useRef<number | null>(null);
  const wheelTailUntilRef = useRef(0);
  const lastZoomWheelDirectionRef = useRef(0);
  const lastZoomWheelMagnitudeRef = useRef(0);
  const pendingZoomDirectionRef = useRef<-1 | 1>(-1);

  const lastAnchorCommitAppliedAtRef = useRef<number | null>(null);
  const lastCommitAtRef = useRef<number | null>(null);
  const pendingDeltaPxRef = useRef(0);
  const pendingTargetZoomRef = useRef<number | null>(null);

  const cursorRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const gestureContainerRectRef = useRef<{ left: number; top: number } | null>(null);

  const frozenAnchorRef = useRef<{
    bp: number;
    cursorYViewport: number;
    rowPlacement: ZoomAnchorRowPlacement;
    clientX: number;
    clientY: number;
    backgroundParity?: number;
    capacityBias: number;
    holdsLinearOrigin: boolean;
  } | null>(null);
  const pendingScrollAnchorRef = useRef<{
    bp: number;
    cursorYViewport: number;
    rowPlacement: ZoomAnchorRowPlacement;
    zoomLevel: number;
    topBp: number;
  } | null>(null);

  const committedScreenAnchorRef = useRef<typeof pendingScrollAnchorRef.current>(null);
  const endZoomingAfterCommitRef = useRef(false);
  const pendingResetRef = useRef(false);
  const previewActiveRef = useRef(false);
  const anchorLayoutGenerationRef = useRef(0);
  const anchorFinalizeRafRef = useRef<number | null>(null);
  const anchorDeadlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setZooming = useCallback((next: boolean) => {
    if (isZoomingRef.current === next) return;
    isZoomingRef.current = next;
    if (!next) committedScreenAnchorRef.current = null;
    onGestureStateChangeRef.current?.(next);
  }, []);

  const clearAnchorDeadline = useCallback(() => {
    if (anchorDeadlineTimerRef.current === null) return;
    clearTimeout(anchorDeadlineTimerRef.current);
    anchorDeadlineTimerRef.current = null;
  }, []);

  const abandonPendingAnchor = useCallback(() => {
    clearAnchorDeadline();
    if (pendingScrollAnchorRef.current === null) return;
    coarseZoomMotionRef.current.cancel();
    pendingScrollAnchorRef.current = null;
    if (pendingResetRef.current) {
      clearPreviewTransform(zoomTargetRefRef.current.current);
      pendingResetRef.current = false;
      previewActiveRef.current = false;
    }
    endZoomingAfterCommitRef.current = false;
    setZooming(false);
    if (typeof window !== 'undefined' && typeof performance !== 'undefined') {
      const w = canvasTestWindow(window);
      if (!w.__zoomPerf) w.__zoomPerf = { samples: [], logThresholdMs: 8 };
      if (!w.__zoomPerf.anchorAbandons) w.__zoomPerf.anchorAbandons = [];
      w.__zoomPerf.anchorAbandons.push({ t: performance.now() });
      if (w.__zoomPerf.anchorAbandons.length > 50) w.__zoomPerf.anchorAbandons.shift();
    }
  }, [clearAnchorDeadline, setZooming]);

  const flushPendingCommit = useCallback(
    (now: number, flushReason: 'tick' | 'settle'): boolean => {
      const commitStartedAt = performance.now();
      const deltaPx = pendingDeltaPxRef.current;
      if (
        pendingTargetZoomRef.current === null &&
        Math.abs(deltaPx) < 0.5 &&
        !coarseZoomMotionRef.current.pending
      ) {
        if (flushReason === 'settle') pendingDeltaPxRef.current = 0;
        return false;
      }

      if (
        !opts.continuous &&
        flushReason === 'tick' &&
        Math.abs(deltaPx) < MIN_DELTA_PX_PER_TICK_COMMIT
      ) {
        return false;
      }

      if (
        !opts.continuous &&
        flushReason === 'tick' &&
        lastCommitAtRef.current !== null &&
        now - lastCommitAtRef.current < COMMIT_INTERVAL_MS
      ) {
        return false;
      }

      const cursor = cursorRef.current;
      const anchor = frozenAnchorRef.current;
      if (!cursor || !anchor) {
        if (flushReason === 'settle') pendingDeltaPxRef.current = 0;
        return false;
      }

      const container = containerRefRef.current.current;
      const layout = layoutRef.current;
      const config = configRef.current;
      if (!container || !layout || !config) {
        if (flushReason === 'settle') pendingDeltaPxRef.current = 0;
        return false;
      }

      const rect = container.getBoundingClientRect();
      const animatedLogZoom = coarseZoomMotionRef.current.advance(
        Math.log(pendingTargetZoomRef.current ?? zoomLevelRef.current),
        now,
        clampLogZoom
      );
      const requestedTarget =
        animatedLogZoom === null ? pendingTargetZoomRef.current : Math.exp(animatedLogZoom);

      const next = computeZoomStepWithAnchor({
        targetZoom: requestedTarget ?? undefined,
        deltaPx,
        cursor,
        anchorBp: anchor.bp,
        anchorUnwrappedBp:
          anchor.bp + (anchor.rowPlacement.cycle ?? 0) * (layout.summary?.seqLength ?? 0),
        currentZoom: zoomLevelRef.current,
        currentTopBp: topBpRef.current,
        isCircular: isCircularRef.current,
        circularOffset: circularOffsetRef.current,
        baseConfig: baseConfigRef.current,
        containerWidth: containerWidthRef.current,
        containerRect: { left: rect.left, top: rect.top },
        minZoom,
        maxZoom,
        sensitivity,
        maxDeltaPxPerCommit:
          opts.continuous || (flushReason === 'settle' && opts.deferCommitsUntilSettle)
            ? Number.POSITIVE_INFINITY
            : MAX_WHEEL_DELTA_PX_PER_COMMIT,
        rebaseCircularOrigin: opts.continuous && isCircularRef.current,
        rebaseLinearOrigin: opts.continuous && !isCircularRef.current,
        pinLinearOrigin: config.pinLinearOrigin,
        holdLinearOrigin: anchor.holdsLinearOrigin,
        sequenceLength: layout.summary?.seqLength ?? opts.seqLength,
      });
      pendingDeltaPxRef.current = 0;
      pendingTargetZoomRef.current = null;
      if (next === null) return false;
      coarseZoomMotionRef.current.commit(Math.log(next.zoomLevel));

      lastCommitAtRef.current = now;

      const committedTopBp = next.topBp;
      pendingScrollAnchorRef.current = {
        bp: anchor.bp,
        cursorYViewport: anchor.cursorYViewport,
        rowPlacement:
          next.circularOffset === undefined
            ? anchor.rowPlacement
            : { ...anchor.rowPlacement, role: 'real', cycle: anchor.bp < next.topBp ? 1 : 0 },
        zoomLevel: next.zoomLevel,
        topBp: committedTopBp,
      };
      pendingResetRef.current = true;
      clearAnchorDeadline();
      anchorDeadlineTimerRef.current = setTimeout(abandonPendingAnchor, ANCHOR_DEADLINE_MS);
      if (opts.continuous) {
        onWrapAnchorRef.current?.({
          unwrappedBp:
            anchor.bp +
            (isCircularRef.current && anchor.bp < next.topBp
              ? (layout.summary?.seqLength ?? opts.seqLength)
              : 0),
          viewportX: anchor.clientX - rect.left,
          viewportY: anchor.cursorYViewport,
          backgroundParity: anchor.backgroundParity ?? 0,
          capacityBias: anchor.capacityBias,
          holdsLinearOrigin: anchor.holdsLinearOrigin,
        });
      }
      const commit = () =>
        setZoomStateRef.current(
          next.circularOffset === undefined
            ? { zoomLevel: next.zoomLevel, topBp: committedTopBp }
            : {
                zoomLevel: next.zoomLevel,
                topBp: committedTopBp,
                circularOffset: next.circularOffset,
              }
        );
      if (opts.continuous)
        flushSync(() => {
          onPreviewZoomTargetRef.current?.(next.zoomLevel, pendingZoomDirectionRef.current);
          commit();
        });
      else commit();
      if (coarseZoomMotionRef.current.pending) requestFrameRef.current?.();

      if (typeof window !== 'undefined' && typeof performance !== 'undefined') {
        const w = canvasTestWindow(window);
        if (!w.__zoomPerf) w.__zoomPerf = { samples: [], logThresholdMs: 8 };
        if (!w.__zoomPerf.commitFlushes) w.__zoomPerf.commitFlushes = [];
        w.__zoomPerf.commitFlushes.push({
          t: performance.now(),
          startedAt: commitStartedAt,
          workMs: performance.now() - commitStartedAt,
          flushReason,
          deltaPx,
          nextZoomLevel: next.zoomLevel,
          nextTopBp: committedTopBp,
        });
        if (w.__zoomPerf.commitFlushes.length > 200) w.__zoomPerf.commitFlushes.shift();
      }

      return true;
    },
    [
      abandonPendingAnchor,
      clearAnchorDeadline,
      maxZoom,
      minZoom,
      opts.deferCommitsUntilSettle,
      opts.continuous,
      opts.seqLength,
      sensitivity,
      clampLogZoom,
    ]
  );

  const resetSettleTimer = useCallback(() => {
    lastWheelAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (settleTimerRef.current !== null) return;

    const settleAfterIdle = () => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const lastWheelAt = lastWheelAtRef.current;
      if (lastWheelAt !== null) {
        const remainingInputIdleMs = SETTLE_TIMEOUT_MS - Math.max(0, now - lastWheelAt);
        if (remainingInputIdleMs > 0) {
          settleTimerRef.current = setTimeout(settleAfterIdle, remainingInputIdleMs);
          return;
        }
      }

      if (
        pendingScrollAnchorRef.current !== null &&
        pendingScrollAnchorRef.current !== committedScreenAnchorRef.current
      ) {
        settleTimerRef.current = setTimeout(settleAfterIdle, 16);
        return;
      }
      const lastAnchorCommitAppliedAt = lastAnchorCommitAppliedAtRef.current;
      if (lastAnchorCommitAppliedAt !== null) {
        const remainingIdleMs = SETTLE_TIMEOUT_MS - Math.max(0, now - lastAnchorCommitAppliedAt);
        if (remainingIdleMs > 0) {
          settleTimerRef.current = setTimeout(settleAfterIdle, remainingIdleMs);
          return;
        }
      }
      const committed = flushPendingCommit(now, 'settle');
      settleTimerRef.current = null;
      lastWheelAtRef.current = null;
      gestureContainerRectRef.current = null;
      frozenAnchorRef.current = null;
      lastCommitAtRef.current = null;
      if (committed) {
        endZoomingAfterCommitRef.current = true;
        return;
      }
      setZooming(false);
      if (previewActiveRef.current) {
        clearPreviewTransform(zoomTargetRefRef.current.current);
        previewActiveRef.current = false;
      }
    };
    settleTimerRef.current = setTimeout(settleAfterIdle, SETTLE_TIMEOUT_MS);
  }, [flushPendingCommit, setZooming]);

  useLayoutEffect(() => {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const pending = pendingScrollAnchorRef.current;
    const anchor = pending ?? (isZoomingRef.current ? committedScreenAnchorRef.current : null);
    if (!anchor) return;

    if (
      Math.abs(opts.zoomLevel - anchor.zoomLevel) > Number.EPSILON ||
      Math.abs(opts.topBp - anchor.topBp) > Number.EPSILON
    ) {
      return;
    }
    const container = containerRefRef.current.current;
    const layout = layoutRef.current;
    const finishPendingSettle = () => {
      if (!endZoomingAfterCommitRef.current) return;
      endZoomingAfterCommitRef.current = false;
      setZooming(false);
    };

    if (!container || !layout) {
      abandonPendingAnchor();
      return;
    }
    const anchorContentY = zoomAnchorContentY(
      anchor.bp,
      anchor.rowPlacement,
      layout,
      configRef.current ?? undefined
    );
    if (anchorContentY === null) {
      abandonPendingAnchor();
      return;
    }
    const desiredScrollTop = anchorContentY - anchor.cursorYViewport;
    if (
      opts.continuous &&
      !opts.isCircular &&
      !configRef.current?.pinLinearOrigin &&
      desiredScrollTop < -0.000001 &&
      opts.onScrollBoundaryOffset
    ) {
      opts.onScrollBoundaryOffset(-desiredScrollTop, 'start');
      return;
    }
    const maximumScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (
      opts.continuous &&
      !opts.isCircular &&
      desiredScrollTop > maximumScrollTop + 0.000001 &&
      opts.onScrollBoundaryOffset
    ) {
      opts.onScrollBoundaryOffset(Math.ceil(desiredScrollTop - maximumScrollTop) + 1, 'end');
      return;
    }
    const newScrollTop = Math.max(0, desiredScrollTop);
    const prevScrollTop = container.scrollTop;
    const wouldWrite = Math.abs(prevScrollTop - newScrollTop) >= 0.5;
    if (wouldWrite) container.scrollTop = newScrollTop;
    if (committedScreenAnchorRef.current !== anchor) {
      lastAnchorCommitAppliedAtRef.current =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
    committedScreenAnchorRef.current = anchor;
    if (pendingResetRef.current) {
      clearPreviewTransform(zoomTargetRefRef.current.current);
      pendingResetRef.current = false;
      previewActiveRef.current = false;
    }

    if (pending) {
      clearAnchorDeadline();
      anchorLayoutGenerationRef.current += 1;
      const generation = anchorLayoutGenerationRef.current;
      if (anchorFinalizeRafRef.current !== null) {
        cancelAnimationFrame(anchorFinalizeRafRef.current);
      }
      anchorFinalizeRafRef.current = requestAnimationFrame(() => {
        anchorFinalizeRafRef.current = requestAnimationFrame(() => {
          anchorFinalizeRafRef.current = null;
          if (
            anchorLayoutGenerationRef.current !== generation ||
            pendingScrollAnchorRef.current !== anchor
          ) {
            return;
          }
          pendingScrollAnchorRef.current = null;
          finishPendingSettle();
          if (typeof window !== 'undefined' && typeof performance !== 'undefined') {
            const w = canvasTestWindow(window);
            if (!w.__zoomPerf) w.__zoomPerf = { samples: [], logThresholdMs: 8 };
            if (!w.__zoomPerf.anchorSettles) w.__zoomPerf.anchorSettles = [];
            w.__zoomPerf.anchorSettles.push({
              t: performance.now(),
              zoomLevel: anchor.zoomLevel,
              topBp: anchor.topBp,
              bp: anchor.bp,
            });
            if (w.__zoomPerf.anchorSettles.length > 200) w.__zoomPerf.anchorSettles.shift();
          }
        });
      });
    }

    if (typeof window !== 'undefined' && typeof performance !== 'undefined') {
      const durMs = performance.now() - t0;
      const w = canvasTestWindow(window);
      if (!w.__zoomPerf) w.__zoomPerf = { samples: [], logThresholdMs: 8 };
      if (!w.__zoomPerf.commits) w.__zoomPerf.commits = [];
      w.__zoomPerf.commits.push({
        t: performance.now(),
        zoomLevel: opts.zoomLevel,
        topBp: opts.topBp,
        totalHeight: layout.totalHeight,
        anchorBp: anchor.bp,
        prevScrollTop,
        targetScrollTop: newScrollTop,
        rowY: anchorContentY,
        wrote: wouldWrite,
        scrollEffectMs: durMs,
      });
      if (w.__zoomPerf.commits.length > 200) w.__zoomPerf.commits.shift();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.zoomLevel, opts.topBp, opts.layout, opts.scrollEndHeadroom]);

  useEffect(() => {
    if (opts.continuous) {
      if (opts.requestFrame) return;
      let frame: number;
      const tick = (now: number) => {
        if (isZoomingRef.current) flushPendingCommit(now, 'tick');
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    const id = setInterval(
      () => {
        if (!isZoomingRef.current) return;
        if (opts.deferCommitsUntilSettle) return;
        void flushPendingCommit(
          typeof performance !== 'undefined' ? performance.now() : Date.now(),
          'tick'
        );
      },
      Math.max(16, Math.floor(COMMIT_INTERVAL_MS / 2))
    );
    return () => clearInterval(id);
  }, [flushPendingCommit, opts.deferCommitsUntilSettle, opts.continuous, opts.requestFrame]);

  const cancelGesture = useCallback(() => {
    coarseZoomMotionRef.current.cancel();
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    clearAnchorDeadline();
    if (anchorFinalizeRafRef.current !== null) cancelAnimationFrame(anchorFinalizeRafRef.current);
    anchorFinalizeRafRef.current = null;
    pendingScrollAnchorRef.current = null;
    frozenAnchorRef.current = null;
    pendingDeltaPxRef.current = 0;
    pendingTargetZoomRef.current = null;
    inputOwnerRef.current = null;
    endZoomingAfterCommitRef.current = false;
    pendingResetRef.current = false;
    lastWheelAtRef.current = null;
    lastCommitAtRef.current = null;
    lastAnchorCommitAppliedAtRef.current = null;
    wheelTailUntilRef.current = 0;
    lastZoomWheelDirectionRef.current = 0;
    lastZoomWheelMagnitudeRef.current = 0;
    gestureContainerRectRef.current = null;
    clearPreviewTransform(zoomTargetRefRef.current.current);
    previewActiveRef.current = false;
    setZooming(false);
  }, [clearAnchorDeadline, setZooming]);

  useEffect(() => {
    const container = containerRefRef.current.current;
    if (container) return subscribeInputRevocation(container, cancelGesture);
  }, [cancelGesture]);

  const captureScreenAnchor = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRefRef.current.current;
      if (!container) return false;
      const layout = layoutRef.current;
      const config = configRef.current;
      if (!layout || !config) return false;
      const rect = container.getBoundingClientRect();
      gestureContainerRectRef.current = { left: rect.left, top: rect.top };
      const bp = bpAtCursorForZoom(layout, config, container, clientX, clientY);
      if (bp === null) return false;
      const cursorYViewport = clientY - rect.top;
      frozenAnchorRef.current = {
        bp,
        cursorYViewport,
        rowPlacement: captureZoomAnchorRowPlacement(
          bp,
          container.scrollTop + cursorYViewport,
          layout,
          config
        ),
        clientX: clientX,
        clientY: clientY,
        capacityBias: 0,
        holdsLinearOrigin:
          config.pinLinearOrigin === true &&
          !isCircularRef.current &&
          container.scrollTop < (layout.summary?.rowYOffsets?.[1] ?? Number.POSITIVE_INFINITY),
      };
      const perf = canvasTestWindow(window).__zoomPerf;
      if (perf) {
        (perf.anchorCaptures ??= []).push({
          t: performance.now(),
          bp,
          cursorYViewport,
          sequenceProgress: frozenAnchorRef.current.rowPlacement.sequenceProgress ?? null,
          trackPoint: frozenAnchorRef.current.rowPlacement.trackPoint ?? null,
          edgePoint: frozenAnchorRef.current.rowPlacement.edgePoint ?? null,
        });
      }
      const unwrappedBp =
        bp +
        (frozenAnchorRef.current.rowPlacement.cycle ?? 0) *
          (layout.summary?.seqLength ?? opts.seqLength);
      const anchorRow = layout.summary
        ? Math.floor((unwrappedBp - layout.summary.topBp) / layout.summary.cpr) +
          layout.summary.topBufferCount
        : 0;

      const row = layout.lines.find((line) => line.lineIndex === anchorRow);
      const neighbor = layout.lines.find(
        (line) => line.lineIndex === anchorRow + 1 || line.lineIndex === anchorRow - 1
      );
      const paintedSpacing =
        row && neighbor && config.charWidth > 0
          ? (layout.summary?.isCircular
              ? layout.summary.cpr
              : (neighbor.startPos - row.startPos) / (neighbor.lineIndex - anchorRow)) -
            ((neighbor.xOffset ?? 0) - (row.xOffset ?? 0)) /
              ((neighbor.lineIndex - anchorRow) * config.charWidth)
          : (layout.summary?.cpr ?? config.charsPerLine);
      frozenAnchorRef.current.capacityBias =
        paintedSpacing - (config.wrapCapacity ?? paintedSpacing);
      frozenAnchorRef.current.backgroundParity =
        (anchorRow + (config.rowBackgroundOffset ?? 0)) % 2;
      onWrapAnchorRef.current?.({
        unwrappedBp,
        viewportX: clientX - rect.left,
        viewportY: cursorYViewport,
        backgroundParity: frozenAnchorRef.current.backgroundParity,
        capacityBias: frozenAnchorRef.current.capacityBias,
        holdsLinearOrigin: frozenAnchorRef.current.holdsLinearOrigin,
      });
      return true;
    },
    [opts.seqLength]
  );

  const zoomTo = useCallback(
    (targetZoom: number) => {
      if (!Number.isFinite(targetZoom)) return false;
      coarseZoomMotionRef.current.cancel();
      const target = Math.max(minZoom, Math.min(maxZoom, targetZoom));
      if (target === zoomLevelRef.current) {
        pendingTargetZoomRef.current = null;
        pendingDeltaPxRef.current = 0;
        return true;
      }
      const container = containerRefRef.current.current;
      const layout = layoutRef.current;
      const config = configRef.current;
      if (!container || !layout || !config) return false;
      if (inputOwnerRef.current !== 'control' || !frozenAnchorRef.current) {
        cancelGesture();
        const rect = container.getBoundingClientRect();
        const centerY = container.scrollTop + container.clientHeight / 2;
        const rows = layout.lines
          .map((line) => ({
            y: rowPaintY(
              line,
              computeLineTrackPositions(line, config).sequenceY + config.rowHeight / 2
            ),
          }))
          .filter(
            ({ y }) => y >= container.scrollTop && y < container.scrollTop + container.clientHeight
          );
        rows.sort((a, b) => Math.abs(a.y - centerY) - Math.abs(b.y - centerY));
        const cursorY = rows[0]?.y ?? centerY;
        if (
          !captureScreenAnchor(
            rect.left + container.clientWidth / 2,
            rect.top + cursorY - container.scrollTop
          )
        )
          return false;
        inputOwnerRef.current = 'control';
      }
      const anchor = frozenAnchorRef.current!;
      cursorRef.current = { clientX: anchor.clientX, clientY: anchor.clientY };
      pendingDeltaPxRef.current =
        Math.log2(zoomLevelRef.current / target) * (2400 / Math.max(1, sensitivity));
      pendingTargetZoomRef.current = target;
      pendingZoomDirectionRef.current = target > zoomLevelRef.current ? 1 : -1;
      if (!opts.continuous)
        onPreviewZoomTargetRef.current?.(target, pendingZoomDirectionRef.current);
      setZooming(true);
      resetSettleTimer();
      if (opts.continuous) requestFrameRef.current?.();

      return true;
    },
    [
      cancelGesture,
      captureScreenAnchor,
      minZoom,
      maxZoom,
      sensitivity,
      opts.continuous,
      setZooming,
      resetSettleTimer,
    ]
  );

  const correctZoomFloor = useCallback(
    (floorZoom: number): boolean => {
      if (!isZoomingRef.current || !frozenAnchorRef.current) return false;
      const target = Math.max(minZoom, Math.min(maxZoom, floorZoom));
      if (target <= zoomLevelRef.current) return false;
      pendingDeltaPxRef.current = 0;
      pendingTargetZoomRef.current = target;
      pendingZoomDirectionRef.current = 1;
      if (!opts.continuous) onPreviewZoomTargetRef.current?.(target, 1);
      return flushPendingCommit(performance.now(), 'tick');
    },
    [flushPendingCommit, maxZoom, minZoom, opts.continuous]
  );

  const onWheel = useCallback(
    (e: WheelEvent) => {
      const inputTarget = containerRefRef.current.current;
      if (!inputTarget || !inputTargetAllows(inputTarget, 'pointer')) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const wheelDelta = normalizeWheelDeltaY(e);
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) {
        const direction = Math.sign(wheelDelta);
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !opts.browserWheelGestureOwnership &&
          now < wheelTailUntilRef.current &&
          (direction === 0 || direction === lastZoomWheelDirectionRef.current) &&
          Math.abs(wheelDelta) <=
            Math.max(WHEEL_TAIL_NEW_GESTURE_MIN_DELTA_PX, lastZoomWheelMagnitudeRef.current * 1.5)
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          wheelTailUntilRef.current = now + WHEEL_TAIL_QUIET_MS;
          lastZoomWheelMagnitudeRef.current = Math.abs(wheelDelta);
          return;
        }
        cancelGesture();
        wheelTailUntilRef.current = 0;
        lastZoomWheelDirectionRef.current = 0;
        lastZoomWheelMagnitudeRef.current = 0;
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();

      const container = containerRefRef.current.current;
      if (!container) return;

      if (
        opts.continuous &&
        !coarseZoomMotionRef.current.pending &&
        pendingTargetZoomRef.current === null &&
        computeNextZoomFromDelta(
          zoomLevelRef.current,
          wheelDelta,
          sensitivity,
          minZoom,
          maxZoom,
          Number.POSITIVE_INFINITY
        ) === zoomLevelRef.current
      ) {
        lastZoomWheelDirectionRef.current = Math.sign(wheelDelta);
        lastZoomWheelMagnitudeRef.current = Math.abs(wheelDelta);
        wheelTailUntilRef.current = now + WHEEL_TAIL_QUIET_MS;
        pendingDeltaPxRef.current = 0;
        return;
      }

      const previousPoint = frozenAnchorRef.current;
      if (
        inputOwnerRef.current === 'control' ||
        (previousPoint &&
          Math.hypot(e.clientX - previousPoint.clientX, e.clientY - previousPoint.clientY) > 2)
      ) {
        cancelGesture();
      }
      if (frozenAnchorRef.current === null && !captureScreenAnchor(e.clientX, e.clientY)) return;
      lastZoomWheelDirectionRef.current = Math.sign(wheelDelta);
      lastZoomWheelMagnitudeRef.current = Math.abs(wheelDelta);
      wheelTailUntilRef.current = now + WHEEL_TAIL_QUIET_MS;
      inputOwnerRef.current = 'wheel';

      cursorRef.current = { clientX: e.clientX, clientY: e.clientY };
      pendingDeltaPxRef.current += wheelDelta;
      setZooming(true);
      resetSettleTimer();

      if (opts.continuous) {
        const coarse = shouldAnimateWheel(e, container.ownerDocument);
        const firstCoarseStep = coarse && !coarseZoomMotionRef.current.pending;
        if (!coarse) coarseZoomMotionRef.current.cancel();
        const target = computeNextZoomFromDelta(
          coarse ? zoomLevelRef.current : (pendingTargetZoomRef.current ?? zoomLevelRef.current),
          pendingDeltaPxRef.current,
          sensitivity,
          minZoom,
          maxZoom,
          Number.POSITIVE_INFINITY
        );
        if (coarse) {
          coarseZoomMotionRef.current.add(
            Math.log(target / zoomLevelRef.current),
            Math.log(zoomLevelRef.current),
            now,
            clampLogZoom
          );
        } else pendingTargetZoomRef.current = target === zoomLevelRef.current ? null : target;
        pendingDeltaPxRef.current = 0;
        pendingZoomDirectionRef.current = wheelDelta < 0 ? 1 : -1;

        if (!firstCoarseStep || !flushPendingCommit(now, 'tick')) requestFrameRef.current?.();
        return;
      }

      const previewZoom = computeNextZoomFromDelta(
        zoomLevelRef.current,
        pendingDeltaPxRef.current,
        sensitivity,
        minZoom,
        maxZoom,
        opts.deferCommitsUntilSettle ? Number.POSITIVE_INFINITY : MAX_WHEEL_DELTA_PX_PER_PREVIEW
      );

      const isZoomingOut = pendingDeltaPxRef.current > 0;
      if (isZoomingOut && previewZoom >= zoomLevelRef.current) {
        pendingDeltaPxRef.current = 0;
        if (previewActiveRef.current) {
          clearPreviewTransform(zoomTargetRefRef.current.current);
          previewActiveRef.current = false;
        }
        return;
      }

      const isZoomingIn = pendingDeltaPxRef.current < 0;
      if (isZoomingIn && previewZoom <= zoomLevelRef.current) {
        pendingDeltaPxRef.current = 0;
        if (previewActiveRef.current) {
          clearPreviewTransform(zoomTargetRefRef.current.current);
          previewActiveRef.current = false;
        }
        return;
      }

      if (!opts.continuous && previewZoom !== zoomLevelRef.current) {
        const rect =
          gestureContainerRectRef.current ??
          (() => {
            const current = container.getBoundingClientRect();
            return { left: current.left, top: current.top };
          })();
        const previewScale = zoomLevelRef.current > 0 ? previewZoom / zoomLevelRef.current : 1;
        applyPreviewTransform(zoomTargetRefRef.current.current, previewScale, {
          x: e.clientX - rect.left,

          y: e.clientY - rect.top,
        });
        previewActiveRef.current = true;
      } else if (previewActiveRef.current) {
        clearPreviewTransform(zoomTargetRefRef.current.current);
        previewActiveRef.current = false;
      }
    },
    [
      cancelGesture,
      captureScreenAnchor,
      flushPendingCommit,
      maxZoom,
      minZoom,
      opts.deferCommitsUntilSettle,
      opts.continuous,
      opts.browserWheelGestureOwnership,
      opts.seqLength,
      clampLogZoom,
      resetSettleTimer,
      sensitivity,
      setZooming,
    ]
  );

  useEffect(() => {
    return () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      if (anchorDeadlineTimerRef.current !== null) {
        clearTimeout(anchorDeadlineTimerRef.current);
        anchorDeadlineTimerRef.current = null;
      }
      if (anchorFinalizeRafRef.current !== null) {
        cancelAnimationFrame(anchorFinalizeRafRef.current);
        anchorFinalizeRafRef.current = null;
      }
      clearPreviewTransform(zoomTargetRefRef.current.current);
      gestureContainerRectRef.current = null;
      previewActiveRef.current = false;
      if (isZoomingRef.current) {
        isZoomingRef.current = false;
        onGestureStateChangeRef.current?.(false);
      }
    };
  }, []);

  return {
    isZooming: () => isZoomingRef.current,
    hasPendingCommit: () =>
      isZoomingRef.current &&
      (coarseZoomMotionRef.current.pending ||
        pendingTargetZoomRef.current !== null ||
        Math.abs(pendingDeltaPxRef.current) >= 0.5),
    flushFrame: (now) => isZoomingRef.current && flushPendingCommit(now, 'tick'),
    onWheel,
    zoomTo,
    correctZoomFloor,
    cancelGesture,
  };
}
