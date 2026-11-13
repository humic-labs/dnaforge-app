import {
  WheelMotion,
  registerWheelZoomTarget,
  shouldAnimateWheel,
} from '@waypoint/platform/wheel-motion';
import type { RenderState } from '../../types';
import { assemblyScaffoldTooltip } from '@waypoint/sequence-utils';
import { log as plog, mark as pmark, time as ptime } from '../../perf-log';
import { recordWebGLSelectionDebug } from './selection-debug';
import {
  applySelectionAction,
  buildSelectionRange,
  buildBoundarySelectionRange,
  selectionContainsBp,
  shiftSelectionRange,
} from './selection-state';
import {
  backboneBoundaryHandleHitPayload,
  backbonePartHitPayload,
  codonHitPayload,
  cutSiteHitPayload,
  featureHitPayload,
  orfHitPayload,
  pileupColumnHitPayload,
  primerHandleHitPayload,
  readHitIdentityKey,
  readHitPayload,
  type BackboneBoundaryHandleHitPayload,
  type BackbonePartHitPayload,
  type FeatureHitPayload,
  type PrimerHandleHitPayload,
  type WebGLHitTarget,
} from './shared/hit-targets';
import { clampLinearViewOffset } from './shared/linear-viewport';
import { isTrackHitConsumed } from './shared/track-hit-consumption';

function readHoverIdentityKey(readHover: ReturnType<typeof readHitPayload>): string | null {
  if (!readHover) return null;
  const event = readHover.event;
  return `${readHitIdentityKey(readHover)}\u0000${event?.pos ?? ''}\u0000${event?.kind ?? ''}\u0000${readHover.screenX}\u0000${readHover.screenY}`;
}

function pileupColumnIdentityKey(hover: ReturnType<typeof pileupColumnHitPayload>): string | null {
  if (!hover) return null;
  return `${hover.chrom}\u0000${hover.position}\u0000${hover.kind}\u0000${hover.readBase ?? ''}`;
}

type HoverKeyState = {
  lastFeatureHoverKey: string | null;
  lastReadHoverKey: string | null;
  lastPileupColumnHoverKey: string | null;
};

function publishReadAndPileupHover(
  keys: HoverKeyState,
  handle: InteractionHandle,
  result: WebGLHitTarget | null
): void {
  const readHover = readHitPayload(result);
  const readHoverKey = readHoverIdentityKey(readHover);
  if (readHoverKey !== keys.lastReadHoverKey) {
    keys.lastReadHoverKey = readHoverKey;
    handle.onReadHover?.(readHover);
  }
  const pileupColumnHover = pileupColumnHitPayload(result);
  const pileupColumnHoverKey = pileupColumnIdentityKey(pileupColumnHover);
  if (pileupColumnHoverKey !== keys.lastPileupColumnHoverKey) {
    keys.lastPileupColumnHoverKey = pileupColumnHoverKey;
    handle.onPileupColumnHover?.(pileupColumnHover);
  }
}

function clearReadAndPileupHover(keys: HoverKeyState, handle: InteractionHandle): void {
  if (keys.lastReadHoverKey !== null) {
    keys.lastReadHoverKey = null;
    handle.onReadHover?.(null);
  }
  if (keys.lastPileupColumnHoverKey !== null) {
    keys.lastPileupColumnHoverKey = null;
    handle.onPileupColumnHover?.(null);
  }
}

function clearTransientHoverVisuals(
  state: RenderState,
  setHoveredCodon: (next: HoveredCodon | null) => void
): void {
  state.hoverPosition = null;
  setHoveredCodon(null);
  state.hoveredOrf = null;
  state.hoveredCutSiteId = null;
}

function clearHoveredFeature(
  state: RenderState,
  handle: InteractionHandle,
  cursorX: number,
  cursorY: number
): void {
  if (state.hoveredId === null) return;
  pmark('hover-transition', { from: state.hoveredId, to: null });
  state.hoveredId = null;
  ptime('onHoverFeature callback', () => handle.onHoverFeature?.(null, cursorX, cursorY));
}

function applySelectionHandleHoverFlush(args: {
  state: RenderState;
  handle: InteractionHandle;
  canvas: HTMLCanvasElement;
  cursorX: number;
  cursorY: number;
  keys: HoverKeyState;
  setHoveredCodon: (next: HoveredCodon | null) => void;
  setHoveredBackbonePart: (next: BackbonePartHitPayload | null) => void;
}): void {
  clearTransientHoverVisuals(args.state, args.setHoveredCodon);
  args.setHoveredBackbonePart(null);
  const pileupResult = args.handle.hitTestPileupFn
    ? ptime('interaction.flush.pileupHandleHitTest', () =>
        args.handle.hitTestPileupFn!(args.cursorX, args.cursorY)
      )
    : null;
  publishReadAndPileupHover(args.keys, args.handle, pileupResult);

  const primer = featureHitPayload(
    args.handle.hitTestPrimerFn?.(args.cursorX, args.cursorY) ?? null
  );
  if (primer) {
    if (args.state.hoveredId !== primer.id) {
      args.state.hoveredId = primer.id;
      args.handle.onHoverFeature?.(primer, args.cursorX, args.cursorY);
    }
  } else {
    clearHoveredFeature(args.state, args.handle, args.cursorX, args.cursorY);
  }
  args.canvas.style.cursor = 'ew-resize';
}

function applySuppressedHoverFlush(args: {
  state: RenderState;
  handle: InteractionHandle;
  canvas: HTMLCanvasElement;
  cursorX: number;
  cursorY: number;
  keys: HoverKeyState;
  setHoveredCodon: (next: HoveredCodon | null) => void;
  setHoveredBackbonePart: (next: BackbonePartHitPayload | null) => void;
}): void {
  clearTransientHoverVisuals(args.state, args.setHoveredCodon);
  args.setHoveredBackbonePart(null);
  clearReadAndPileupHover(args.keys, args.handle);
  clearHoveredFeature(args.state, args.handle, args.cursorX, args.cursorY);
  args.canvas.style.cursor = '';
}

function applyFeatureHoverHitTestFlush(args: {
  state: RenderState;
  handle: InteractionHandle;
  canvas: HTMLCanvasElement;
  cursorX: number;
  cursorY: number;
  keys: HoverKeyState;
  setHoveredCodon: (next: HoveredCodon | null) => void;
  setHoveredBackbonePart: (next: BackbonePartHitPayload | null) => void;
  canDragBackbonePart: () => boolean;
  hoveredNucleotideText: boolean;
}): void {
  const result = ptime('interaction.flush.hoverHitTest', () =>
    args.handle.hitTestFn!(args.cursorX, args.cursorY)
  );
  const hoverFeature = result
    ? null
    : (args.handle.hitTestHoverFeatureFn?.(args.cursorX, args.cursorY) ?? null);
  const readHover = readHitPayload(result);
  publishReadAndPileupHover(args.keys, args.handle, result);
  const pileupColumnHover = pileupColumnHitPayload(result);
  if (pileupColumnHover && !readHover) args.state.hoverPosition = null;
  const codonHover = codonHitPayload(result);
  if (codonHover) args.state.hoverPosition = null;
  const orfHover = orfHitPayload(result);
  args.setHoveredCodon(
    codonHover
      ? {
          start: codonHover.start,
          end: codonHover.end,
          strand: codonHover.strand === -1 ? -1 : 1,
          ...(codonHover.codingSource ? { codingSource: codonHover.codingSource } : {}),
          ...(codonHover.mutation ? { mutation: codonHover.mutation } : {}),
        }
      : null
  );
  args.state.hoveredOrf = orfHover
    ? { start: orfHover.start, end: orfHover.end, strand: orfHover.strand }
    : null;
  args.state.hoveredCutSiteId = result?.kind === 'cut-site' ? result.payload.id : null;
  const hovered =
    result?.kind === 'feature'
      ? result.payload
      : codonHover && typeof codonHover.featureId === 'number'
        ? {
            id: codonHover.featureId,
            start: codonHover.featureStart ?? codonHover.start,
            end: codonHover.featureEnd ?? codonHover.end + 1,
          }
        : hoverFeature;
  const newId = hovered?.id ?? null;
  const isDirectDragHandle =
    result?.kind === 'primer-handle' || result?.kind === 'backbone-boundary-handle';
  const isBackbonePart = result?.kind === 'backbone-part';
  const isDraggableBackbonePart =
    isBackbonePart && !result.payload.isScaffold && args.canDragBackbonePart();
  const isSelectableHit =
    result?.kind === 'feature' ||
    result?.kind === 'codon' ||
    result?.kind === 'orf' ||
    result?.kind === 'cut-site';
  args.setHoveredBackbonePart(isBackbonePart ? result.payload : null);
  args.canvas.title = isBackbonePart
    ? result.payload.scaffold
      ? assemblyScaffoldTooltip(result.payload.scaffold)
      : isDraggableBackbonePart
        ? 'Drag to reorder part'
        : 'Select part'
    : result?.kind === 'backbone-boundary-handle'
      ? 'Drag to edit source crossover'
      : result?.kind === 'primer-handle'
        ? 'Drag to resize primer binding site'
        : '';
  args.canvas.style.cursor = isDirectDragHandle
    ? 'ew-resize'
    : isDraggableBackbonePart
      ? 'grab'
      : isBackbonePart
        ? 'pointer'
        : isSelectableHit
          ? 'pointer'
          : readHover
            ? 'crosshair'
            : args.hoveredNucleotideText
              ? 'text'
              : '';

  const hoverKey = hovered
    ? [
        newId,
        args.cursorX,
        args.cursorY,
        args.state.viewOffset,
        args.state.zoom,
        args.state.morph,
        args.state.width,
        args.state.height,
        args.state.geometryHeight ?? '',
      ].join(':')
    : null;
  const identityChanged = newId !== args.state.hoveredId;
  if (identityChanged || hoverKey !== args.keys.lastFeatureHoverKey) {
    if (identityChanged) pmark('hover-transition', { from: args.state.hoveredId, to: newId });
    args.state.hoveredId = newId;
    args.keys.lastFeatureHoverKey = hoverKey;

    ptime('onHoverFeature callback', () =>
      args.handle.onHoverFeature?.(hovered, args.cursorX, args.cursorY)
    );
  }
}

function clearIdleFeatureHover(args: {
  state: RenderState;
  handle: InteractionHandle;
  canvas: HTMLCanvasElement;
  keys: HoverKeyState;
  setHoveredCodon: (next: HoveredCodon | null) => void;
  setHoveredBackbonePart: (next: BackbonePartHitPayload | null) => void;
  hoveredNucleotideText: boolean;
}): void {
  args.setHoveredCodon(null);
  args.setHoveredBackbonePart(null);
  args.state.hoveredOrf = null;
  args.state.hoveredCutSiteId = null;
  clearReadAndPileupHover(args.keys, args.handle);
  args.canvas.style.cursor = args.hoveredNucleotideText ? 'text' : '';
}

type SelectionHandle = 'start' | 'end';
type DragMode = 'new' | SelectionHandle | null;
type HoveredCodon = NonNullable<RenderState['hoveredCodon']>;

export interface ShiftClickRangeResolverInput {
  currentRange: [number, number] | null;
  rangeStart: number;
  rangeEnd: number;
  cursorPosition: number | null;
  genomeLength: number;
  circular: boolean;
  altKey: boolean;
}

const WHEEL_PIXELS_PER_LINE = 16;
const WHEEL_PIXEL_SCALE = 0.001;
const MAX_WHEEL_VIEW_OFFSET_STEP = 0.06;
const MAX_ZOOM_RATIO_STEP = 1.3;
const MAX_ZOOM_LOG_STEP = Math.log(MAX_ZOOM_RATIO_STEP);
const STABILITY_MAX_ZOOM_RATIO_STEP = 1.1;
const STABILITY_MAX_ZOOM_LOG_STEP = Math.log(STABILITY_MAX_ZOOM_RATIO_STEP);
const DEFAULT_MIN_ZOOM = 0.5;

export interface InteractionHandle {
  cleanup: () => void;
  cancelMotion: () => void;
  flushInteraction: (options?: { advanceCamera?: boolean }) => void;
  commitPresentedCamera?: () => void;
  invalidateHoverHitTest: () => void;
  getCursorX: () => number;
  getCursorY: () => number;
  onBeforeZoom:
    | ((oldZoom: number, newZoom: number, cursorX: number, cursorY: number) => void)
    | null;

  shouldZoomToCursor: ((screenX: number, screenY: number, state: RenderState) => boolean) | null;

  shouldShowPositionGuide:
    | ((screenX: number, screenY: number, state: RenderState) => boolean)
    | null;

  getMinZoom: ((state: RenderState) => number) | null;

  getMaxZoom: ((state: RenderState) => number) | null;

  onCameraChange: ((reason: 'scroll' | 'zoom') => void) | null;

  screenToBp: ((screenX: number, screenY: number, state: RenderState) => number) | null;

  screenToBoundaryBp: ((screenX: number, screenY: number, state: RenderState) => number) | null;

  screenToPrimerBoundaryBp:
    | ((
        handle: PrimerHandleHitPayload,
        screenX: number,
        screenY: number,
        state: RenderState
      ) => number)
    | null;

  hitTestFn: ((screenX: number, screenY: number) => WebGLHitTarget | null) | null;

  hitTestHoverFeatureFn?: ((screenX: number, screenY: number) => FeatureHitPayload | null) | null;

  hitTestPileupFn: ((screenX: number, screenY: number) => WebGLHitTarget | null) | null;

  hitTestPrimerFn?: ((screenX: number, screenY: number) => WebGLHitTarget | null) | null;

  resolveShiftClickRange: ((input: ShiftClickRangeResolverInput) => [number, number]) | null;

  hitTestSelectionHandle:
    | ((screenX: number, screenY: number, state: RenderState) => SelectionHandle | null)
    | null;

  hitTestNucleotideText: ((screenX: number, screenY: number, state: RenderState) => boolean) | null;

  onPositionClick: ((bp: number) => void) | null;

  onPositionDoubleClick: ((bp: number) => void) | null;

  onHoverFeature:
    | ((
        feat: { id: number; start: number; end: number } | null,
        screenX: number,
        screenY: number
      ) => void)
    | null;

  onCodonHover: ((codon: HoveredCodon | null) => void) | null;

  onFeatureClick: ((feat: { id: number; start: number; end: number } | null) => void) | null;

  onReadHover: ((read: ReturnType<typeof readHitPayload>) => void) | null;

  onReadClick: ((read: ReturnType<typeof readHitPayload>) => void) | null;

  onPileupColumnHover: ((column: ReturnType<typeof pileupColumnHitPayload>) => void) | null;

  onFeatureRangeCommit: ((feat: { id: number; start: number; end: number }) => void) | null;

  onOrfClick:
    | ((
        orf: { start: number; end: number; strand: '+' | '-'; frame: number; length: number } | null
      ) => void)
    | null;

  onOrfRangeCommit:
    | ((orf: {
        start: number;
        end: number;
        strand: '+' | '-';
        frame: number;
        length: number;
      }) => void)
    | null;

  onContextMenu:
    | ((
        event: MouseEvent,
        context: {
          position: number | null;
          hitResult: WebGLHitTarget | null;
          highlightRange: [number, number] | null;
        }
      ) => void)
    | null;

  onSelectionChange: ((startBp: number, endBp: number) => void) | null;

  onSelectionPreview: ((startBp: number, endBp: number) => void) | null;

  onSelectionStart: ((mode: 'new' | 'start' | 'end') => void) | null;

  onPrimerHandleDragPreview: ((handle: PrimerHandleHitPayload, boundaryBp: number) => void) | null;

  onPrimerHandleDragCommit: ((handle: PrimerHandleHitPayload, boundaryBp: number) => void) | null;

  onBackboneBoundaryHandleDragPreview:
    | ((handle: BackboneBoundaryHandleHitPayload, boundaryBp: number) => void)
    | null;

  onBackboneBoundaryHandleDragCommit:
    | ((handle: BackboneBoundaryHandleHitPayload, boundaryBp: number) => void)
    | null;

  onBackbonePartSelect: ((part: BackbonePartHitPayload) => void) | null;

  onBackbonePartHover: ((part: BackbonePartHitPayload | null) => void) | null;

  canDragBackbonePart: (() => boolean) | null;

  onBackbonePartDragPreview: ((part: BackbonePartHitPayload, boundaryBp: number) => void) | null;

  onBackbonePartDragCommit: ((part: BackbonePartHitPayload, boundaryBp: number) => void) | null;

  genomeLength: number;

  genomeCircular: boolean;

  isDragging: boolean;
}

function normalizeWheelDeltaPx(e: WheelEvent, canvas: HTMLCanvasElement): number {
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (e.deltaMode === 1) return delta * WHEEL_PIXELS_PER_LINE;
  if (e.deltaMode === 2) return delta * Math.max(1, canvas.clientHeight);
  return delta;
}

function clampWheelStep(delta: number): number {
  return Math.max(-MAX_WHEEL_VIEW_OFFSET_STEP, Math.min(MAX_WHEEL_VIEW_OFFSET_STEP, delta));
}

function maxZoomLogStepForState(state: RenderState): number {
  return state.performanceMode === 'stability' ? STABILITY_MAX_ZOOM_LOG_STEP : MAX_ZOOM_LOG_STEP;
}

function clampZoomLogStep(delta: number, maxLogStep = MAX_ZOOM_LOG_STEP): number {
  return Math.max(-maxLogStep, Math.min(maxLogStep, delta));
}

function selectionDebugState(state: RenderState): Record<string, unknown> {
  return {
    width: state.width,
    height: state.height,
    zoom: state.zoom,
    viewOffset: state.viewOffset,
    morph: state.morph,
    highlightRange: state.highlightRange,
    cursorPosition: state.cursorPosition,
    hoverPosition: state.hoverPosition ?? null,
    hoveredCodon: state.hoveredCodon ?? null,
    selectedIdsSize: state.selectedIds.size,
  };
}

function normalizeBp(bp: number, genomeLength: number): number {
  if (genomeLength <= 0) return bp;
  return ((bp % genomeLength) + genomeLength) % genomeLength;
}

function getShiftClickSurfaceRange(
  hitResult: WebGLHitTarget | null,
  genomeLength: number
): [number, number] | null {
  const hitFeature = featureHitPayload(hitResult);
  if (hitFeature) {
    return [
      normalizeBp(hitFeature.start, genomeLength),
      normalizeBp(hitFeature.end - 1, genomeLength),
    ];
  }

  const hitCodon = codonHitPayload(hitResult);
  if (hitCodon) {
    return [normalizeBp(hitCodon.start, genomeLength), normalizeBp(hitCodon.end, genomeLength)];
  }

  return null;
}

export function setupInteraction(canvas: HTMLCanvasElement, state: RenderState): InteractionHandle {
  const mouseMotion = new WheelMotion(1e-8);
  const zoomMotion = new WheelMotion(1e-6);
  const clampScrollOffset = (value: number) =>
    handle.genomeCircular ? value : clampLinearViewOffset(value, state.zoom);
  canvas.dataset.sequenceWheelZoomViewport = '';
  let pendingWheelDelta = 0;
  let pendingZoomDelta = 0;
  let pendingZoomAnchorX = 0;
  let pendingZoomAnchorY = 0;
  let presentedCamera = {
    zoom: state.zoom,
    viewOffset: state.viewOffset,
    viewportRange: state.viewportRange
      ? ([...state.viewportRange] as [number, number])
      : state.viewportRange,
  };
  let hasUnpresentedCameraChange = false;
  const zoomBounds = () => {
    const sequenceFloor = state.sequencePresentation?.minSequencePixelsPerBp;
    const lowerBound =
      sequenceFloor !== undefined && Number.isFinite(sequenceFloor) && sequenceFloor > 0
        ? Number.EPSILON
        : 0.01;
    const min = Math.max(lowerBound, handle.getMinZoom?.(state) ?? DEFAULT_MIN_ZOOM);
    const max = Math.max(0.01, handle.getMaxZoom?.(state) ?? Number.MAX_VALUE);
    return { min: Math.min(min, max), max: Number.isFinite(max) ? max : Number.MAX_VALUE };
  };
  const clampLogZoom = (value: number) => {
    const { min, max } = zoomBounds();
    return Math.max(Math.log(min), Math.min(Math.log(max), value));
  };
  const cancelMotion = () => {
    mouseMotion.cancel();
    zoomMotion.cancel();
    pendingWheelDelta = 0;
    pendingZoomDelta = 0;
    hasUnpresentedCameraChange = false;
  };
  const cancelMotionForPointerDown = () => {
    const restorePresentedCamera = hasUnpresentedCameraChange;
    cancelMotion();
    if (!restorePresentedCamera) return;
    const reason = state.zoom === presentedCamera.zoom ? 'scroll' : 'zoom';
    state.zoom = presentedCamera.zoom;
    state.viewOffset = presentedCamera.viewOffset;
    state.viewportRange = presentedCamera.viewportRange
      ? [...presentedCamera.viewportRange]
      : presentedCamera.viewportRange;
    handle.onCameraChange?.(reason);
    markHoverDirty();
  };
  let cursorX = 0;
  let cursorY = 0;
  let hasPointer = false;
  let lastTapTime = -Infinity;
  let lastTapX = -Infinity;
  let lastTapY = -Infinity;
  let lastCameraInteractionAt = -Infinity;
  let hoverDirty = true;

  let isDragging = false;
  let dragMode: DragMode = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartBp = -1;
  let fixedHandleBp = -1;
  let activePrimerHandle: PrimerHandleHitPayload | null = null;
  let activePrimerPreviewBoundaryBp: number | null = null;
  let activeBackboneBoundaryHandle: BackboneBoundaryHandleHitPayload | null = null;
  let pendingBackbonePart: BackbonePartHitPayload | null = null;
  let activeBackbonePart: BackbonePartHitPayload | null = null;
  const DRAG_THRESHOLD = 5;
  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerDownTime = 0;
  let pendingHostClear: ReturnType<typeof setTimeout> | null = null;
  let lastSelectionChangeKey: string | null = null;
  let lastSelectionPreviewKey: string | null = null;
  let lastFeatureHoverKey: string | null = null;
  let lastReadHoverKey: string | null = null;
  let lastPileupColumnHoverKey: string | null = null;
  let lastHoveredBackbonePartRegionId: string | null = null;

  const markHoverDirty = () => {
    hoverDirty = true;
  };

  const sameHoveredCodon = (a: HoveredCodon | null | undefined, b: HoveredCodon | null) => {
    if ((a ?? null) === b) return true;
    if (!a || !b) return false;
    return (
      a.start === b.start &&
      a.end === b.end &&
      a.strand === b.strand &&
      a.codingSource === b.codingSource &&
      a.mutation?.kind === b.mutation?.kind &&
      a.mutation?.queryAa === b.mutation?.queryAa &&
      a.mutation?.referenceAa === b.mutation?.referenceAa
    );
  };

  const setHoveredCodon = (next: HoveredCodon | null) => {
    if (sameHoveredCodon(state.hoveredCodon, next)) return;
    state.hoveredCodon = next;
    handle.onCodonHover?.(next);
  };

  const setHoveredBackbonePart = (next: BackbonePartHitPayload | null) => {
    const nextRegionId = next?.regionId ?? null;
    if (nextRegionId === lastHoveredBackbonePartRegionId) return;
    lastHoveredBackbonePartRegionId = nextRegionId;
    handle.onBackbonePartHover?.(next);
  };

  const canDragBackbonePart = () =>
    handle.canDragBackbonePart?.() ??
    Boolean(handle.onBackbonePartDragPreview && handle.onBackbonePartDragCommit);

  const setHighlightRange = (
    range: [number, number] | null,
    opts?: { clearSelectedIds?: boolean }
  ) => {
    applySelectionAction(state, {
      type: 'set-highlight-range',
      range,
      clearSelectedIds: opts?.clearSelectedIds,
    });
  };

  const emitSelectionChange = (range: [number, number] | null) => {
    if (!range) return;
    const key = `${range[0]}:${range[1]}`;
    if (key === lastSelectionChangeKey) return;
    lastSelectionChangeKey = key;
    ptime('onSelectionChange callback', () => handle.onSelectionChange?.(range[0], range[1]));
  };

  const emitSelectionPreview = (range: [number, number] | null) => {
    if (!range) return;
    const key = `${range[0]}:${range[1]}`;
    if (key === lastSelectionPreviewKey) return;
    lastSelectionPreviewKey = key;
    handle.onSelectionPreview?.(range[0], range[1]);
  };

  const selectCutSite = (cutSite: NonNullable<ReturnType<typeof cutSiteHitPayload>>) => {
    const end = cutSite.recognitionEnd === 0 ? handle.genomeLength - 1 : cutSite.recognitionEnd - 1;
    setHighlightRange([cutSite.recognitionStart, end], { clearSelectedIds: true });
    state.hoveredCutSiteId = cutSite.id;
  };

  const cancelPendingHostClear = () => {
    if (pendingHostClear !== null) {
      clearTimeout(pendingHostClear);
      pendingHostClear = null;
    }
  };

  const scheduleHostClear = () => {
    cancelPendingHostClear();
    pendingHostClear = setTimeout(() => {
      pendingHostClear = null;
      if (state.highlightRange !== null || state.selectedIds.size > 0 || state.selectedOrf) return;
      ptime('onFeatureClear callback', () => handle.onFeatureClick?.(null));
    }, 0);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!isDragging || !activePrimerHandle) {
      cursorX = e.clientX;
      cursorY = e.clientY;
    }
    hasPointer = true;
    markHoverDirty();
    const deltaPx = normalizeWheelDeltaPx(e, canvas);
    if (e.ctrlKey || e.metaKey) {
      mouseMotion.cancel();

      pendingZoomAnchorX = e.clientX;
      pendingZoomAnchorY = e.clientY;

      const delta = clampZoomLogStep(-deltaPx * 0.008, maxZoomLogStepForState(state));
      if (shouldAnimateWheel(e, canvas.ownerDocument)) {
        zoomMotion.add(
          delta,
          Math.log(Math.max(Number.MIN_VALUE, state.zoom)),
          performance.now(),
          clampLogZoom
        );
      } else {
        zoomMotion.cancel();
        pendingZoomDelta += delta;
      }
    } else {
      zoomMotion.cancel();
      const eventWheelDelta = (deltaPx * WHEEL_PIXEL_SCALE) / Math.max(0.1, state.zoom);
      const delta = clampWheelStep(eventWheelDelta);
      if (!(isDragging && activePrimerHandle) && shouldAnimateWheel(e, canvas.ownerDocument)) {
        mouseMotion.add(delta, state.viewOffset, performance.now(), clampScrollOffset);
      } else {
        mouseMotion.cancel();
        pendingWheelDelta += delta;
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    cancelMotion();
    if (e.key === 'p' || e.key === 'P') {
      state.perfPanelVisible = !state.perfPanelVisible;
      const perf = document.getElementById('perf');
      if (perf) perf.classList.toggle('visible', state.perfPanelVisible);
    }

    if (e.key === 'Escape') {
      applySelectionAction(state, { type: 'clear-selection' });
      scheduleHostClear();
      markHoverDirty();
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    cursorX = e.clientX;
    cursorY = e.clientY;
    hasPointer = true;
    markHoverDirty();

    if (isDragging && activeBackbonePart && handle.screenToBoundaryBp) {
      const boundaryBp = handle.screenToBoundaryBp(e.clientX, e.clientY, state);
      handle.onBackbonePartDragPreview?.(activeBackbonePart, boundaryBp);
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (pendingBackbonePart) {
      canvas.style.cursor = 'grab';
      return;
    }

    if (isDragging && activeBackboneBoundaryHandle && handle.screenToBp) {
      const boundaryBp =
        handle.screenToBoundaryBp?.(e.clientX, e.clientY, state) ??
        handle.screenToBp(e.clientX, e.clientY, state);
      handle.onBackboneBoundaryHandleDragPreview?.(activeBackboneBoundaryHandle, boundaryBp);
      canvas.style.cursor = 'ew-resize';
      return;
    }

    if (isDragging && activePrimerHandle && handle.screenToBp) {
      const boundaryBp =
        handle.screenToPrimerBoundaryBp?.(activePrimerHandle, e.clientX, e.clientY, state) ??
        handle.screenToBoundaryBp?.(e.clientX, e.clientY, state) ??
        handle.screenToBp(e.clientX, e.clientY, state);
      activePrimerPreviewBoundaryBp = boundaryBp;
      handle.onPrimerHandleDragPreview?.(activePrimerHandle, boundaryBp);
      canvas.style.cursor = 'ew-resize';
      return;
    }

    if (isDragging && handle.screenToBp) {
      const currentBp = handle.screenToBp(e.clientX, e.clientY, state);
      if (dragMode === 'start') {
        setHighlightRange(
          handle.genomeCircular
            ? [currentBp, fixedHandleBp]
            : buildSelectionRange(fixedHandleBp, currentBp, handle.genomeLength, false)
        );
      } else if (dragMode === 'end') {
        setHighlightRange(
          handle.genomeCircular
            ? [fixedHandleBp, currentBp]
            : buildSelectionRange(fixedHandleBp, currentBp, handle.genomeLength, false)
        );
      } else {
        setHighlightRange(
          handle.screenToBoundaryBp
            ? buildBoundarySelectionRange(
                dragStartBp,
                handle.screenToBoundaryBp(e.clientX, e.clientY, state),
                handle.genomeLength,
                handle.genomeCircular
              )
            : buildSelectionRange(
                dragStartBp,
                currentBp,
                handle.genomeLength,
                handle.genomeCircular
              )
        );
      }
      emitSelectionPreview(state.highlightRange);
      recordWebGLSelectionDebug('interaction.drag-update', {
        client: { x: e.clientX, y: e.clientY },
        dragMode,
        dragStartBp,
        fixedHandleBp,
        currentBp,
        range: state.highlightRange,
        state: selectionDebugState(state),
      });
    }
  };

  const onPointerLeave = () => {
    hasPointer = false;
    markHoverDirty();
    state.hoverPosition = null;
    setHoveredCodon(null);
    state.hoveredOrf = null;
    state.hoveredCutSiteId = null;
    setHoveredBackbonePart(null);
    canvas.title = '';
    canvas.style.cursor = '';
    if (lastReadHoverKey !== null) {
      lastReadHoverKey = null;
      handle.onReadHover?.(null);
    }
    if (lastPileupColumnHoverKey !== null) {
      lastPileupColumnHoverKey = null;
      handle.onPileupColumnHover?.(null);
    }
    if (state.hoveredId !== null) {
      state.hoveredId = null;
      ptime('onHoverFeature callback', () => handle.onHoverFeature?.(null, cursorX, cursorY));
    }
  };

  const navigateAtPointer = (e: MouseEvent, fallbackBp: number) => {
    if (!handle.onPositionDoubleClick) return;
    const bp = handle.screenToBp?.(e.clientX, e.clientY, state) ?? fallbackBp;
    ptime('onPositionDoubleClick callback', () => handle.onPositionDoubleClick?.(bp));
  };

  const onPointerDown = (e: PointerEvent) => {
    cancelMotionForPointerDown();
    if ((e.target as HTMLElement)?.tagName !== 'CANVAS') return;
    if (e.button !== 0) return;
    cancelPendingHostClear();
    plog('pointerdown', { x: e.clientX, y: e.clientY });
    markHoverDirty();

    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
    pointerDownTime = performance.now();
    lastSelectionChangeKey = null;
    lastSelectionPreviewKey = null;

    const directHit = handle.hitTestFn?.(e.clientX, e.clientY) ?? null;
    const backboneBoundaryHandle = backboneBoundaryHandleHitPayload(directHit);
    if (backboneBoundaryHandle) {
      cancelPendingHostClear();
      e.preventDefault();
      isDragging = true;
      handle.isDragging = true;
      activeBackboneBoundaryHandle = backboneBoundaryHandle;
      applySelectionAction(state, { type: 'set-external-cursor', bp: null });
      canvas.style.cursor = 'ew-resize';
      if (typeof e.pointerId === 'number') canvas.setPointerCapture?.(e.pointerId);
      return;
    }

    const primerHandle = primerHandleHitPayload(directHit);
    if (primerHandle) {
      cancelPendingHostClear();
      e.preventDefault();
      isDragging = true;
      handle.isDragging = true;
      activePrimerHandle = primerHandle;
      activePrimerPreviewBoundaryBp = null;
      applySelectionAction(state, { type: 'set-external-cursor', bp: null });
      canvas.style.cursor = 'ew-resize';
      if (typeof e.pointerId === 'number') canvas.setPointerCapture?.(e.pointerId);
      return;
    }

    const backbonePart = backbonePartHitPayload(directHit);
    if (backbonePart) {
      e.preventDefault();
      handle.onBackbonePartSelect?.(backbonePart);
      applySelectionAction(state, { type: 'set-external-cursor', bp: null });
      if (backbonePart.isScaffold) navigateAtPointer(e, backbonePart.rangeStart);
      if (!backbonePart.isScaffold && canDragBackbonePart()) {
        pendingBackbonePart = backbonePart;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        canvas.style.cursor = 'grab';
        if (typeof e.pointerId === 'number') canvas.setPointerCapture?.(e.pointerId);
      } else {
        canvas.style.cursor = 'pointer';
      }
      return;
    }

    const selectionHandle = handle.hitTestSelectionHandle?.(e.clientX, e.clientY, state) ?? null;
    recordWebGLSelectionDebug('interaction.pointerdown', {
      client: { x: e.clientX, y: e.clientY },
      selectionHandle,
      state: selectionDebugState(state),
      genomeLength: handle.genomeLength,
      genomeCircular: handle.genomeCircular,
    });
    if (selectionHandle && state.highlightRange) {
      cancelPendingHostClear();
      e.preventDefault();
      isDragging = true;
      handle.isDragging = true;
      dragMode = selectionHandle;
      applySelectionAction(state, { type: 'set-external-cursor', bp: null });
      ptime('onSelectionStart callback', () => handle.onSelectionStart?.(selectionHandle));
      fixedHandleBp =
        selectionHandle === 'start' ? state.highlightRange[1] : state.highlightRange[0];
      canvas.style.cursor = 'ew-resize';
      return;
    }

    if (handle.screenToBp) {
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartBp = ptime('screenToBp(pointerdown)', () =>
        (handle.screenToBoundaryBp ?? handle.screenToBp!)(e.clientX, e.clientY, state)
      );
      recordWebGLSelectionDebug('interaction.pointerdown.dragStartBp', {
        client: { x: e.clientX, y: e.clientY },
        dragStartBp,
        state: selectionDebugState(state),
      });
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    markHoverDirty();
    if (!isDragging && pendingBackbonePart) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        isDragging = true;
        handle.isDragging = true;
        activeBackbonePart = pendingBackbonePart;
        pendingBackbonePart = null;
        const boundaryBp = handle.screenToBoundaryBp?.(e.clientX, e.clientY, state);
        if (boundaryBp !== undefined) {
          handle.onBackbonePartDragPreview?.(activeBackbonePart, boundaryBp);
        }
        canvas.style.cursor = 'grabbing';
      }
      return;
    }

    if (!isDragging && dragStartBp >= 0) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        cancelPendingHostClear();
        isDragging = true;
        handle.isDragging = true;
        dragMode = 'new';
        applySelectionAction(state, { type: 'set-external-cursor', bp: null });
        ptime('onSelectionStart callback', () => handle.onSelectionStart?.('new'));
        if (handle.screenToBp) {
          const currentBp = handle.screenToBp(e.clientX, e.clientY, state);
          setHighlightRange(
            handle.screenToBoundaryBp
              ? buildBoundarySelectionRange(
                  dragStartBp,
                  handle.screenToBoundaryBp(e.clientX, e.clientY, state),
                  handle.genomeLength,
                  handle.genomeCircular
                )
              : buildSelectionRange(
                  dragStartBp,
                  currentBp,
                  handle.genomeLength,
                  handle.genomeCircular
                )
          );
          emitSelectionPreview(state.highlightRange);
        }
        recordWebGLSelectionDebug('interaction.drag-start', {
          client: { x: e.clientX, y: e.clientY },
          dragStart: { x: dragStartX, y: dragStartY, bp: dragStartBp },
          delta: { dx, dy },
          state: selectionDebugState(state),
        });
        canvas.style.cursor = 'crosshair';
      }
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;

    if (isTrackHitConsumed(e)) return;
    plog('pointerup', { x: e.clientX, y: e.clientY, isDragging });
    markHoverDirty();
    if (isDragging && activeBackbonePart) {
      const boundaryBp = handle.screenToBoundaryBp?.(e.clientX, e.clientY, state);
      if (boundaryBp !== undefined) {
        handle.onBackbonePartDragCommit?.(activeBackbonePart, boundaryBp);
      }
      if (typeof e.pointerId === 'number' && canvas.hasPointerCapture?.(e.pointerId)) {
        canvas.releasePointerCapture?.(e.pointerId);
      }
      activeBackbonePart = null;
      pendingBackbonePart = null;
      isDragging = false;
      handle.isDragging = false;
      dragStartBp = -1;
      canvas.style.cursor = '';
      return;
    }
    if (pendingBackbonePart) {
      if (typeof e.pointerId === 'number' && canvas.hasPointerCapture?.(e.pointerId)) {
        canvas.releasePointerCapture?.(e.pointerId);
      }
      pendingBackbonePart = null;
      dragStartBp = -1;
      canvas.style.cursor = '';
      return;
    }
    if (isDragging && activeBackboneBoundaryHandle) {
      const dx = e.clientX - pointerDownX;
      const dy = e.clientY - pointerDownY;
      const movedPastDragThreshold = Math.hypot(dx, dy) >= DRAG_THRESHOLD;
      if (movedPastDragThreshold) {
        const boundaryBp =
          handle.screenToBoundaryBp?.(e.clientX, e.clientY, state) ??
          handle.screenToBp?.(e.clientX, e.clientY, state);
        if (boundaryBp !== undefined) {
          handle.onBackboneBoundaryHandleDragCommit?.(activeBackboneBoundaryHandle, boundaryBp);
        }
      } else {
        const boundaryBp = activeBackboneBoundaryHandle.boundaryBp;
        applySelectionAction(state, { type: 'place-cursor', bp: boundaryBp });
        handle.onPositionClick?.(boundaryBp);
      }
      if (typeof e.pointerId === 'number' && canvas.hasPointerCapture?.(e.pointerId)) {
        canvas.releasePointerCapture?.(e.pointerId);
      }
      activeBackboneBoundaryHandle = null;
      isDragging = false;
      handle.isDragging = false;
      dragStartBp = -1;
      canvas.style.cursor = '';
      return;
    }
    if (isDragging && activePrimerHandle) {
      const boundaryBp =
        activePrimerPreviewBoundaryBp ??
        handle.screenToPrimerBoundaryBp?.(activePrimerHandle, e.clientX, e.clientY, state) ??
        handle.screenToBoundaryBp?.(e.clientX, e.clientY, state) ??
        handle.screenToBp?.(e.clientX, e.clientY, state);
      if (boundaryBp !== undefined) {
        handle.onPrimerHandleDragCommit?.(activePrimerHandle, boundaryBp);
      }
      if (typeof e.pointerId === 'number' && canvas.hasPointerCapture?.(e.pointerId)) {
        canvas.releasePointerCapture?.(e.pointerId);
      }
      activePrimerHandle = null;
      activePrimerPreviewBoundaryBp = null;
      isDragging = false;
      handle.isDragging = false;
      dragStartBp = -1;
      canvas.style.cursor = '';
      return;
    }
    if (isDragging) {
      const range = state.highlightRange;
      emitSelectionChange(range);
      recordWebGLSelectionDebug('interaction.pointerup.drag-complete', {
        client: { x: e.clientX, y: e.clientY },
        dragMode,
        finalRange: range,
        state: selectionDebugState(state),
      });
      isDragging = false;
      handle.isDragging = false;
      dragMode = null;
      dragStartBp = -1;
      fixedHandleBp = -1;
      canvas.style.cursor = '';
      return;
    }

    dragStartBp = -1;
    const elapsed = performance.now() - pointerDownTime;
    const dx = e.clientX - pointerDownX;
    const dy = e.clientY - pointerDownY;
    const isTap = elapsed < 300 && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD;

    if (!isTap) return;

    const now = performance.now();
    const doubleTap =
      now - lastTapTime < 350 &&
      Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < DRAG_THRESHOLD;
    lastTapTime = doubleTap ? -Infinity : now;
    lastTapX = e.clientX;
    lastTapY = e.clientY;
    if (doubleTap) {
      cancelPendingHostClear();
      return;
    }

    if (e.shiftKey && handle.screenToBp) {
      cancelPendingHostClear();
      const hitResult = ptime('hitTestFn(shift-click)', () =>
        handle.hitTestFn?.(e.clientX, e.clientY)
      );
      const hitRange = getShiftClickSurfaceRange(hitResult ?? null, handle.genomeLength);
      const range =
        hitRange && handle.resolveShiftClickRange
          ? handle.resolveShiftClickRange({
              currentRange: state.highlightRange,
              rangeStart: hitRange[0],
              rangeEnd: hitRange[1],
              cursorPosition: state.cursorPosition ?? null,
              genomeLength: handle.genomeLength,
              circular: handle.genomeCircular,
              altKey: e.altKey,
            })
          : shiftSelectionRange({
              currentRange: state.highlightRange,
              bp: handle.screenToBp(e.clientX, e.clientY, state),
              genomeLength: handle.genomeLength,
              circular: handle.genomeCircular,
              forceStartHandle: e.altKey,
            });
      setHighlightRange(range, { clearSelectedIds: true });
      const updated = state.highlightRange;
      if (!updated) return;
      pmark('shift-click->selection-updated', { start: updated[0], end: updated[1] });
      ptime('onSelectionChange callback', () => handle.onSelectionChange?.(updated[0], updated[1]));
      return;
    }

    const hitResult = ptime('hitTestFn(click)', () => handle.hitTestFn?.(e.clientX, e.clientY));
    if (hitResult?.kind === 'read') {
      cancelPendingHostClear();
      pmark('click->read-pinned', {
        trackId: hitResult.payload.trackId,
        readId: hitResult.payload.readId,
      });
      ptime('onReadClick callback', () => handle.onReadClick?.(hitResult.payload));
    } else if (hitResult?.kind === 'codon') {
      cancelPendingHostClear();
      const codon = hitResult.payload;
      if (typeof codon.featureId === 'number') {
        applySelectionAction(state, {
          type: 'select-feature',
          feature: { id: codon.featureId },
        });
        pmark('click->codon-feature-focused', { id: codon.featureId });
        ptime('onFeatureClick callback', () =>
          handle.onFeatureClick?.({
            id: codon.featureId!,
            start: codon.featureStart ?? codon.start,
            end: codon.featureEnd ?? codon.end + 1,
          })
        );
      } else {
        setHighlightRange(null, { clearSelectedIds: true });
        pmark('click->codon-cleared-range', { start: codon.start, end: codon.end });
        ptime('onFeatureClear callback', () => handle.onFeatureClick?.(null));
      }
    } else if (hitResult?.kind === 'orf') {
      cancelPendingHostClear();
      const orf = hitResult.payload;
      applySelectionAction(state, {
        type: 'select-orf',
        orf,
      });
      pmark('click->orf-focused', { start: orf.start, end: orf.end, strand: orf.strand });
      ptime('onOrfClick callback', () => handle.onOrfClick?.(orf));
    } else if (hitResult?.kind === 'feature') {
      cancelPendingHostClear();
      const feat = hitResult.payload;
      applySelectionAction(state, {
        type: 'select-feature',
        feature: feat,
      });
      pmark('click->feature-focused', { id: feat.id });
      ptime('onFeatureClick callback', () => handle.onFeatureClick?.(feat));
    } else if (hitResult?.kind === 'cut-site') {
      cancelPendingHostClear();
      selectCutSite(hitResult.payload);
      pmark('click->cut-site-selected', {
        id: hitResult.payload.id,
        start: hitResult.payload.recognitionStart,
        end: hitResult.payload.recognitionEnd,
      });
      emitSelectionChange(state.highlightRange);
    } else {
      const hadSomething =
        state.highlightRange !== null || state.selectedIds.size > 0 || !!state.selectedOrf;
      let clickBp: number | null = null;
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (handle.screenToBp) {
          clickBp = handle.screenToBp(e.clientX, e.clientY, state);
          applySelectionAction(state, { type: 'place-cursor', bp: clickBp });
        } else {
          applySelectionAction(state, { type: 'clear-selection' });
        }
      }
      pmark(hadSomething ? 'click->cleared' : 'click->seek', {});
      const isPlainClick = !e.shiftKey && !e.ctrlKey && !e.metaKey;
      if (isPlainClick) {
        ptime('onReadClick dismiss callback', () => handle.onReadClick?.(null));
      }
      if (hadSomething && isPlainClick) {
        scheduleHostClear();
        ptime('onOrfClear callback', () => handle.onOrfClick?.(null));
      }
      if (isPlainClick && handle.screenToBp && handle.onPositionClick) {
        const bp = clickBp ?? handle.screenToBp(e.clientX, e.clientY, state);
        ptime('onPositionClick callback', () => handle.onPositionClick!(bp));
      }
    }
  };

  const onDoubleClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement)?.tagName !== 'CANVAS') return;
    cancelPendingHostClear();
    markHoverDirty();
    const navigateBeforeRangeCommit = (fallbackBp: number) => {
      navigateAtPointer(e, fallbackBp);
    };
    const hitResult = ptime('hitTestFn(double-click)', () =>
      handle.hitTestFn?.(e.clientX, e.clientY)
    );
    if (hitResult?.kind === 'read') return;
    const backbonePart = backbonePartHitPayload(hitResult ?? null);
    if (backbonePart?.isScaffold) {
      handle.onBackbonePartSelect?.(backbonePart);
      navigateBeforeRangeCommit(backbonePart.rangeStart);
      return;
    }
    if (
      backbonePart &&
      !backbonePart.isScaffold &&
      backbonePart.rangeEnd > backbonePart.rangeStart
    ) {
      const range: [number, number] = [backbonePart.rangeStart, backbonePart.rangeEnd - 1];
      setHighlightRange(range, { clearSelectedIds: true });
      handle.onBackbonePartSelect?.(backbonePart);
      pmark('double-click->backbone-part-selected', {
        regionId: backbonePart.regionId,
        start: range[0],
        end: range[1],
      });
      navigateBeforeRangeCommit(backbonePart.rangeStart);
      emitSelectionChange(range);
      return;
    }
    if (hitResult?.kind === 'codon') {
      const codon = hitResult.payload;
      if (
        typeof codon.featureId !== 'number' ||
        typeof codon.featureStart !== 'number' ||
        typeof codon.featureEnd !== 'number'
      ) {
        return;
      }
      const feature = {
        id: codon.featureId,
        start: codon.featureStart,
        end: codon.featureEnd,
      };
      applySelectionAction(state, {
        type: 'select-feature-range',
        feature,
        genomeLength: handle.genomeLength,
      });
      pmark('double-click->codon-cds-selected', {
        id: feature.id,
        start: feature.start,
        end: feature.end,
      });
      navigateBeforeRangeCommit(codon.start);
      ptime('onFeatureRangeCommit callback', () => handle.onFeatureRangeCommit?.(feature));
      return;
    }
    if (hitResult?.kind === 'orf') {
      const orf = hitResult.payload;
      applySelectionAction(state, {
        type: 'select-orf-range',
        orf,
      });
      pmark('double-click->orf-selected', {
        start: orf.start,
        end: orf.end,
        strand: orf.strand,
      });
      navigateBeforeRangeCommit(orf.start);
      ptime('onOrfRangeCommit callback', () => handle.onOrfRangeCommit?.(orf));
      return;
    }
    if (hitResult?.kind === 'feature') {
      const feat = hitResult.payload;
      applySelectionAction(state, {
        type: 'select-feature-range',
        feature: feat,
        genomeLength: handle.genomeLength,
      });
      pmark('double-click->feature-selected', {
        id: feat.id,
        start: feat.start,
        end: feat.end,
      });
      navigateBeforeRangeCommit(feat.start);
      ptime('onFeatureRangeCommit callback', () => handle.onFeatureRangeCommit?.(feat));
      return;
    }
    if (hitResult?.kind === 'cut-site') {
      selectCutSite(hitResult.payload);
      emitSelectionChange(state.highlightRange);
      pmark('double-click->cut-site', {
        id: hitResult.payload.id,
        position: hitResult.payload.position,
      });
      ptime('onPositionDoubleClick callback', () =>
        handle.onPositionDoubleClick?.(hitResult.payload.position)
      );
      return;
    }
    if (!handle.screenToBp || !handle.onPositionDoubleClick) return;
    const bp = handle.screenToBp(e.clientX, e.clientY, state);
    pmark('double-click->position', { bp });
    ptime('onPositionDoubleClick callback', () => handle.onPositionDoubleClick!(bp));
  };

  const onContextMenu = (e: MouseEvent) => {
    if ((e.target as HTMLElement)?.tagName !== 'CANVAS') return;
    e.preventDefault();
    cancelPendingHostClear();
    markHoverDirty();
    dragStartBp = -1;
    const position = handle.screenToBp ? handle.screenToBp(e.clientX, e.clientY, state) : null;
    const hitResult = handle.hitTestFn?.(e.clientX, e.clientY) ?? null;
    const hitFeature = featureHitPayload(hitResult);
    const hitOrf = orfHitPayload(hitResult);
    const hitCutSite = cutSiteHitPayload(hitResult);
    const hitBackbonePart = backbonePartHitPayload(hitResult);
    const keepExistingHighlight = selectionContainsBp(
      state.highlightRange,
      position,
      handle.genomeLength
    );

    if (hitBackbonePart) {
      pmark('contextmenu->backbone-part-selected', { regionId: hitBackbonePart.regionId });
      ptime('onBackbonePartSelect callback', () => handle.onBackbonePartSelect?.(hitBackbonePart));
    }

    if (!keepExistingHighlight) {
      if (hitFeature) {
        applySelectionAction(state, {
          type: 'select-feature-range',
          feature: hitFeature,
          genomeLength: handle.genomeLength,
        });
        pmark('contextmenu->feature-selected', { id: hitFeature.id });
        ptime('onFeatureRangeCommit callback', () => handle.onFeatureRangeCommit?.(hitFeature));
      } else if (hitOrf) {
        applySelectionAction(state, {
          type: 'select-orf-range',
          orf: hitOrf,
        });
        pmark('contextmenu->orf-selected', {
          start: hitOrf.start,
          end: hitOrf.end,
          strand: hitOrf.strand,
        });
        ptime('onOrfRangeCommit callback', () => handle.onOrfRangeCommit?.(hitOrf));
      } else if (hitCutSite) {
        selectCutSite(hitCutSite);
        pmark('contextmenu->cut-site-selected', { id: hitCutSite.id });
        ptime('onFeatureClear callback', () => handle.onFeatureClick?.(null));
      } else if (state.highlightRange !== null || state.selectedIds.size > 0 || state.selectedOrf) {
        applySelectionAction(state, { type: 'clear-selection' });
        pmark('contextmenu->cleared-selection', {});
        ptime('onFeatureClear callback', () => handle.onFeatureClick?.(null));
        ptime('onOrfClear callback', () => handle.onOrfClick?.(null));
      }
    }

    handle.onContextMenu?.(e, {
      position,
      hitResult,
      highlightRange: state.highlightRange ? [...state.highlightRange] : null,
    });
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });
  const disposeZoomTarget = registerWheelZoomTarget(canvas, onWheel);
  canvas.addEventListener('pointermove', onMouseMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointerdown', cancelMotionForPointerDown, {
    capture: true,
    passive: true,
  });
  window.addEventListener('blur', cancelMotion);
  window.addEventListener('resize', cancelMotion, { passive: true });

  const handle: InteractionHandle = {
    cancelMotion,
    commitPresentedCamera: () => {
      presentedCamera = {
        zoom: state.zoom,
        viewOffset: state.viewOffset,
        viewportRange: state.viewportRange ? [...state.viewportRange] : state.viewportRange,
      };
      hasUnpresentedCameraChange = false;
    },
    cleanup: () => {
      disposeZoomTarget();
      cancelPendingHostClear();
      cancelMotion();
      delete canvas.dataset.sequenceWheelZoomViewport;
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointermove', onMouseMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', cancelMotionForPointerDown, { capture: true });
      window.removeEventListener('blur', cancelMotion);
      window.removeEventListener('resize', cancelMotion);
    },
    flushInteraction: ({ advanceCamera = true } = {}) => {
      let cameraChanged = false;
      if (advanceCamera && (pendingWheelDelta !== 0 || mouseMotion.pending)) {
        ptime('interaction.flush.wheel', () => {
          const wheelStep = pendingWheelDelta;
          pendingWheelDelta = 0;
          const oldViewOffset = state.viewOffset;
          const normalize = (value: number) =>
            handle.genomeCircular
              ? ((value % 1) + 1) % 1
              : clampLinearViewOffset(value, state.zoom);

          state.viewOffset = normalize(state.viewOffset + wheelStep);
          const animatedOffset = mouseMotion.advance(
            state.viewOffset,
            performance.now(),
            clampScrollOffset
          );
          if (animatedOffset !== null) state.viewOffset = normalize(animatedOffset);
          mouseMotion.commit(state.viewOffset);
          if (state.viewOffset !== oldViewOffset) {
            lastCameraInteractionAt = performance.now();
            handle.onCameraChange?.('scroll');
            cameraChanged = true;
          }
        });
      }
      if (advanceCamera && (pendingZoomDelta !== 0 || zoomMotion.pending)) {
        ptime('interaction.flush.zoom', () => {
          const oldZoom = state.zoom;
          const { min: effectiveMinZoom, max: boundedMaxZoom } = zoomBounds();
          const zoomStep = pendingZoomDelta;
          pendingZoomDelta = 0;
          const currentZoom = Math.max(Number.MIN_VALUE, state.zoom);
          const boundedZoomStep = Math.max(
            Math.log(effectiveMinZoom) - Math.log(currentZoom),
            Math.min(Math.log(boundedMaxZoom) - Math.log(currentZoom), zoomStep)
          );
          const rawZoom = Math.min(boundedMaxZoom, currentZoom * Math.exp(boundedZoomStep));
          const directZoom = Math.max(effectiveMinZoom, rawZoom);
          const animatedLogZoom = zoomMotion.advance(
            Math.log(directZoom),
            performance.now(),
            clampLogZoom
          );
          const newZoom =
            animatedLogZoom === null
              ? directZoom
              : Math.max(effectiveMinZoom, Math.min(boundedMaxZoom, Math.exp(animatedLogZoom)));
          zoomMotion.commit(Math.log(newZoom));
          if (newZoom === oldZoom) return;
          const shouldZoomToCursor =
            handle.shouldZoomToCursor?.(pendingZoomAnchorX, pendingZoomAnchorY, state) ?? true;
          if (shouldZoomToCursor) {
            handle.onBeforeZoom?.(oldZoom, newZoom, pendingZoomAnchorX, pendingZoomAnchorY);
          }
          state.zoom = newZoom;
          lastCameraInteractionAt = performance.now();
          handle.onCameraChange?.('zoom');
          cameraChanged = true;
        });
      }
      if (cameraChanged && isDragging && activePrimerHandle) {
        const boundaryBp =
          handle.screenToPrimerBoundaryBp?.(activePrimerHandle, cursorX, cursorY, state) ??
          handle.screenToBoundaryBp?.(cursorX, cursorY, state) ??
          handle.screenToBp?.(cursorX, cursorY, state);
        if (boundaryBp !== undefined) {
          activePrimerPreviewBoundaryBp = boundaryBp;
          handle.onPrimerHandleDragPreview?.(activePrimerHandle, boundaryBp);
        }
      }
      if (cameraChanged) {
        hasUnpresentedCameraChange = true;
        markHoverDirty();
      }
      const suppressHoverHitTest = performance.now() - lastCameraInteractionAt < 80;
      if (!hoverDirty && !isDragging && !suppressHoverHitTest) return;

      hoverDirty = suppressHoverHitTest;

      const hoveredSelectionHandle =
        !suppressHoverHitTest && !isDragging && hasPointer
          ? (handle.hitTestSelectionHandle?.(cursorX, cursorY, state) ?? null)
          : null;
      const hoveredNucleotideText =
        !suppressHoverHitTest && !isDragging && hasPointer && !hoveredSelectionHandle
          ? (handle.hitTestNucleotideText?.(cursorX, cursorY, state) ?? false)
          : false;
      const hoverKeys: HoverKeyState = {
        lastFeatureHoverKey,
        lastReadHoverKey,
        lastPileupColumnHoverKey,
      };
      if (hoveredSelectionHandle) {
        applySelectionHandleHoverFlush({
          state,
          handle,
          canvas,
          cursorX,
          cursorY,
          keys: hoverKeys,
          setHoveredCodon,
          setHoveredBackbonePart,
        });
      } else if (suppressHoverHitTest) {
        applySuppressedHoverFlush({
          state,
          handle,
          canvas,
          cursorX,
          cursorY,
          keys: hoverKeys,
          setHoveredCodon,
          setHoveredBackbonePart,
        });
      } else if (
        !isDragging &&
        hasPointer &&
        handle.screenToBp &&
        (handle.shouldShowPositionGuide?.(cursorX, cursorY, state) ?? true)
      ) {
        state.hoverPosition = (handle.screenToBoundaryBp ?? handle.screenToBp)(
          cursorX,
          cursorY,
          state
        );
      } else if (!hasPointer || isDragging || handle.shouldShowPositionGuide) {
        state.hoverPosition = null;
        setHoveredCodon(null);
        setHoveredBackbonePart(null);
      }

      if (
        handle.hitTestFn &&
        !suppressHoverHitTest &&
        !isDragging &&
        hasPointer &&
        !hoveredSelectionHandle
      ) {
        applyFeatureHoverHitTestFlush({
          state,
          handle,
          canvas,
          cursorX,
          cursorY,
          keys: hoverKeys,
          setHoveredCodon,
          setHoveredBackbonePart,
          canDragBackbonePart,
          hoveredNucleotideText,
        });
      } else if (!hoveredSelectionHandle && !isDragging) {
        clearIdleFeatureHover({
          state,
          handle,
          canvas,
          keys: hoverKeys,
          setHoveredCodon,
          setHoveredBackbonePart,
          hoveredNucleotideText,
        });
      }
      lastFeatureHoverKey = hoverKeys.lastFeatureHoverKey;
      lastReadHoverKey = hoverKeys.lastReadHoverKey;
      lastPileupColumnHoverKey = hoverKeys.lastPileupColumnHoverKey;
    },
    invalidateHoverHitTest: markHoverDirty,
    getCursorX: () => cursorX,
    getCursorY: () => cursorY,
    onBeforeZoom: null,
    shouldZoomToCursor: null,
    shouldShowPositionGuide: null,
    getMinZoom: null,
    getMaxZoom: null,
    onCameraChange: null,
    screenToBp: null,
    screenToBoundaryBp: null,
    screenToPrimerBoundaryBp: null,
    hitTestFn: null,
    hitTestHoverFeatureFn: null,
    hitTestPileupFn: null,
    hitTestPrimerFn: null,
    resolveShiftClickRange: null,
    hitTestSelectionHandle: null,
    hitTestNucleotideText: null,
    onPositionClick: null,
    onPositionDoubleClick: null,
    onHoverFeature: null,
    onCodonHover: null,
    onFeatureClick: null,
    onReadHover: null,
    onReadClick: null,
    onPileupColumnHover: null,
    onFeatureRangeCommit: null,
    onOrfClick: null,
    onOrfRangeCommit: null,
    onContextMenu: null,
    onSelectionChange: null,
    onSelectionPreview: null,
    onSelectionStart: null,
    onPrimerHandleDragPreview: null,
    onPrimerHandleDragCommit: null,
    onBackboneBoundaryHandleDragPreview: null,
    onBackboneBoundaryHandleDragCommit: null,
    onBackbonePartSelect: null,
    onBackbonePartHover: null,
    canDragBackbonePart: null,
    onBackbonePartDragPreview: null,
    onBackbonePartDragCommit: null,
    genomeLength: 1,
    genomeCircular: false,
    isDragging: false,
  };
  return handle;
}
