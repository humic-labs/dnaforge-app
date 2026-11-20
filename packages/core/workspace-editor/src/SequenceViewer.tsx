import { projectedCdsDiagnostics } from './cds-presentation';
import { installAnimatedWheelScroll } from './animated-wheel-scroll';
import { registerWheelZoomTarget } from '@waypoint/platform/wheel-motion';

import {
  useCallback,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import type { UIEvent, ForwardedRef } from 'react';
import { flushSync } from 'react-dom';
import { resolveSequenceGeneticCode } from '@waypoint/sequence-utils';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { SequenceCanvas } from './SequenceCanvas';
import { resolveCircularInitialScrollTop } from './circular-initial-scroll';
import { SequenceScrollbar } from './SequenceScrollbar';
import type { SequenceScrollbarHandle } from './SequenceScrollbar';
import { useSequenceLayout } from './useSequenceLayout';
import type { ViewportRange as LayoutViewportRange } from './useSequenceLayout';
import { bpAtCursor, bpAtCursorForZoom, rowTopForBp } from './use-zoom-gesture';
import { paintedRowBackgroundBounds } from './row-background-geometry';
import {
  useZoomController,
  captureZoomAnchorRowPlacement,
  zoomAnchorContentY,
  type ZoomAnchorRowPlacement,
} from './use-zoom-controller';
import {
  captureScreenTracks,
  morphScreenTracks,
  type ScreenTrackFrame,
} from './screen-track-morph';
import { computeLineTrackPositions, lineTrackBoundaries } from './line-track-layout';
import { linearScrollEndGeometry, offsetLayoutViewport } from './linear-scroll-headroom';
import { useScrollCoordinator } from './use-scroll-coordinator';
import type { ScrollPlacement } from './use-scroll-coordinator';
import { computeCircularVirtualRowCount } from './circular-buffer-rows';
import { useEditorState, hasUncommittedSequenceEdits } from './hooks/useEditorState';
import { useKeyboardNavigation } from './hooks/useKeyboardNavigation';
import { useTrackedRef, summarize } from './hooks/useTrackedRef';
import { diag, visiblePaintedBandMidpoint } from './diagnostics';
import { canvasTestWindow } from './canvas-test-bridge';
import { viewportCanvasWidth } from './canvas-viewport-sizing';
import type {
  WorkspaceEditorProps,
  WorkspaceEditorConfig,
  Selection,
  ViewportRange,
  ViewportChangeSource,
  WorkspaceEditorHandle,
  ScrollToBiologicalPositionOptions,
  SequenceScrollPresentation,
  SequenceViewportPresentation,
  PrimerDisplay,
  LayoutSnapshot2D,
} from './types';
import { DEFAULT_EDITOR_CONFIG } from './types';
import { validateCoordinateSpace, isGappedMode, isEditingDisabled } from './coordinate-space';
import { useCoordinateSpaceRemap } from './hooks/useCoordinateSpaceRemap';
import { debugLog } from './debug-log';
import {
  getSequencePositionAtScrollY,
  getScrollYForSequencePosition,
  nearestRowCopyForBp,
  calculateVisibleRange,
  captureViewportCenterPosition,
  captureSelectionScreenAnchor,
  getSequenceBandY,
  type SequenceTrackGeometry,
  convertScrollPosition,
  absoluteRowIndexForY,
  bpForAbsoluteRowIndex,
  hasCircularScrollBuffers,
  continuousCircularScrollY,
} from './layout-utils';
import {
  MIN_ZOOM,
  charsPerRowAt,
  clampZoom,
  resolveIndexedCdsZoomConfig,
  WRAP_ZOOM_SENSITIVITY,
} from './zoom-math';
import {
  ANNOTATION_BAR_HEIGHT,
  calculateCdsHeight,
  RULER_HEIGHT,
  ROW_BOTTOM_PADDING,
} from './layout-constants';
import {
  linearWrapTopBp,
  rowPaintY,
  rowPaintBounds,
  paintedWrapRowXOffset,
  sharedWrapRowXs,
  sameWrapRowContent,
  type WrapRowXPosition,
  type WrapScreenAnchor,
} from './predictive-wrap-layout';
import { ANNOTATION_CANVAS_CONSTANTS } from './canvas-constants';
import { calculateLineTrackBounds } from './hit-detection/track-bounds';
import { getHitTarget } from './hit-detection/resolve';
import { canvasPointFromClient, getPositionFromX } from './hit-detection/position';
import { isDraftContentEntry } from './content-report';
import {
  INITIAL_PORTAL_WIDTH_STABILITY,
  samplePortalReattachWidth,
  type PortalWidthStability,
} from './portal-reattach-width-stability';

const EMPTY_PRIMERS: PrimerDisplay[] = [];
const AUTO_WRAP_FALLBACK_WIDTH = 920;
const SEQUENCE_SCROLLBAR_WIDTH = 28;
const VIEWPORT_SCOPED_LAYOUT_SEQUENCE_THRESHOLD = 100_000;
const DISTAL_ROW_X_MORPH_MS = 48;
const DISTAL_ROW_X_STEP_PX = 3;
const DISTAL_ROW_X_MAX_PROGRESS_PER_FRAME = 0.25;

interface WrapRowXFrame {
  rows: Map<number, WrapRowXPosition>;
  anchorRowIndex: number;
  charWidth: number;
  marginLeft: number;
}

interface WrapRowXMotion {
  id: number;
  fromOffset: number;
  targetOffset: number;
  startedAt: number | null;
  durationMs: number;
  scene: LayoutSnapshot2D;
  charWidth: number;
  marginLeft: number;
  presentedProgress: number;
}

function captureWrapRowXFrame(
  layout: LayoutSnapshot2D,
  config: WorkspaceEditorConfig,
  anchor: WrapScreenAnchor
): WrapRowXFrame | null {
  const summary = layout.summary;
  if (!summary || summary.cpr <= 0) return null;
  const anchorRowIndex =
    Math.floor((anchor.unwrappedBp - summary.topBp) / summary.cpr) + summary.topBufferCount;
  const rows = new Map<number, WrapRowXPosition>();
  for (const row of layout.lines) {
    const rawStart = summary.topBp + (row.lineIndex - summary.topBufferCount) * summary.cpr;
    rows.set(row.lineIndex - anchorRowIndex, {
      start: summary.isCircular ? rawStart : Math.max(0, rawStart),
      length: row.sequence.length,
      offset: row.xOffset ?? 0,
      charWidth: config.charWidth,
      marginLeft: config.marginLeft,
      circularLength: summary.isCircular ? summary.seqLength : 0,
    });
  }
  return { rows, anchorRowIndex, charWidth: config.charWidth, marginLeft: config.marginLeft };
}

type ScopedCenterRole = 'top-buffer' | 'real' | 'bottom-buffer';

function calculateAutoCharsPerLine(config: WorkspaceEditorConfig, containerWidth: number): number {
  if (config.charsPerLine > 0) return config.charsPerLine;

  const wrapWidth = containerWidth > config.marginLeft ? containerWidth : AUTO_WRAP_FALLBACK_WIDTH;
  return Math.max(10, Math.floor((wrapWidth - config.marginLeft) / config.charWidth));
}

function absoluteRowIndexForBpInGeometry(
  bp: number,
  opts: {
    cpr: number;
    seqLen: number;
    isCircular: boolean;
    topBp: number;
    topBufferCount: number;
    realRowCount: number;
  }
): number {
  const { cpr, seqLen, isCircular, topBp, topBufferCount, realRowCount } = opts;
  if (cpr <= 0 || seqLen <= 0 || realRowCount <= 0) return -1;

  const normalizedBp = isCircular ? ((bp % seqLen) + seqLen) % seqLen : bp;
  if (!isCircular && (normalizedBp < 0 || normalizedBp >= seqLen)) return -1;
  const diff = isCircular
    ? (((normalizedBp - topBp) % seqLen) + seqLen) % seqLen
    : normalizedBp - topBp;
  if (!isCircular && diff < 0) return -1;
  const effectiveIndex = Math.floor(diff / cpr);
  if (effectiveIndex < 0 || effectiveIndex >= realRowCount) return -1;
  return topBufferCount + effectiveIndex;
}

function aliasRowIndexForRole(
  realRowIndex: number,
  role: ScopedCenterRole,
  opts: {
    topBufferCount: number;
    realRowCount: number;
    bottomBufferCount: number;
  }
): number {
  const { topBufferCount, realRowCount, bottomBufferCount } = opts;
  if (role === 'real' || realRowCount <= 0) return realRowIndex;
  const effectiveIndex = realRowIndex - topBufferCount;

  if (role === 'top-buffer') {
    const topAlias = topBufferCount + effectiveIndex - realRowCount;
    if (topAlias >= 0 && topAlias < topBufferCount) return topAlias;
    return realRowIndex;
  }

  const bottomAlias = topBufferCount + realRowCount + effectiveIndex;
  const totalRows = topBufferCount + realRowCount + bottomBufferCount;
  if (bottomAlias >= topBufferCount + realRowCount && bottomAlias < totalRows) {
    return bottomAlias;
  }
  return realRowIndex;
}

function shouldEnableSequenceLogicalScroll(): boolean {
  if (typeof window === 'undefined') return false;
  return canvasTestWindow(window).__enableSequenceLogicalScroll === true;
}

function publishSequenceLogicalScroll(scrollTop: number, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  const w = canvasTestWindow(window);
  w.__sequenceLogicalScrollTop = scrollTop;
  w.__sequenceLogicalScrollEnabled = enabled;
}

function WorkspaceEditorInner(
  {
    sequence,
    browserWheelGestureOwnership = false,
    config: partialConfig,
    coordinateSpace,
    selection: controlledSelection,
    onSelectionChange,
    onPositionClick,
    onAnnotationClick,
    editable = false,
    keyboardActive = true,
    onSequenceChange,
    onAnnotationsChange,
    resolvePasteFragment,
    onCopyDraftSelection,
    onCursorChange,
    onRequestEdit,
    initialCursor,
    onCommit,
    onDiscard,
    onPendingChangesChange,
    className,
    style,
    cutSites,
    scannedCutSites,
    showCutSites,
    onCutSiteClick,
    onCutSiteDoubleClick,
    onGGLabelClick,
    hoveredEnzymeName,
    hoveredPositionInfo,
    scrollToPosition,
    scrollCommandId,
    scrollAnimate,
    onScrollToPositionComplete,
    scrollPresentation,
    onContextMenu,
    showMinimap = false,
    onViewportChange,
    primers = EMPTY_PRIMERS,
    viewCursor,
    onViewCursorChange,
    highlightedRange,
    onHighlightedRangeChange,
    onHighlightedRangePreview,
    rulerSegments,
    selectedAssemblyScaffoldRegionId,
    onAssemblyScaffoldSelect,
    junctionIndicators,
    mutations,
    onMutationClick,
    orfs,
    onOrfsPresented,
    candidateOrf,
    forcedSelectedAnnotation,
    selectedAnnotation,
    onSelectedAnnotationChange,
    rulerDecorations,
    editorSession,
    changedAnnotationNames,
    searchMatches,
    activeSearchIndex,
    previewCDS,
    bpHighlights,
    onHoveredCodonChange,
    residueSelectionReferenceId,
    zoomLevel,
    onZoomLevelChange,
    onMinZoomChange,
    circularBufferViewportHeight,
    initialContainerWidth,
    surfaceVisible = true,
    viewportHeightHint,
    freezeViewportHeight = false,
  }: WorkspaceEditorProps,
  ref: ForwardedRef<WorkspaceEditorHandle>
) {
  const viewerRenderStartedAt = typeof performance === 'undefined' ? 0 : performance.now();
  const recordCode = useMemo(
    () => resolveSequenceGeneticCode(sequence),
    [sequence.annotations, sequence.chosenGeneticCode, sequence.unreadableGeneticCode]
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollContainerElement, setScrollContainerElement] = useState<HTMLDivElement | null>(null);
  const minimapRef = useRef<SequenceScrollbarHandle>(null);
  const [measuredContainerWidth, setContainerWidth] = useState(0);
  const containerWidth =
    measuredContainerWidth ||
    Math.max(0, (initialContainerWidth ?? 0) - (showMinimap ? SEQUENCE_SCROLLBAR_WIDTH : 0));
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const viewportHeightHintValue =
    surfaceVisible || viewport.height === 0 ? Math.max(0, viewportHeightHint ?? 0) : 0;
  const frozenScrollAnchorRef = useRef<{
    scrollTop: number;
    topBp: number | null;
    layoutTotalHeight: number;
  } | null>(null);
  const wasFreezeViewportHeightRef = useRef(false);
  if (freezeViewportHeight && !wasFreezeViewportHeightRef.current) {
    const container = containerRef.current;
    frozenScrollAnchorRef.current = {
      scrollTop: container?.scrollTop ?? viewport.scrollTop,
      topBp: null,
      layoutTotalHeight: 0,
    };
  }
  wasFreezeViewportHeightRef.current = freezeViewportHeight;

  const liveScrollContainerHeight =
    scrollContainerElement && scrollContainerElement.clientHeight > 0
      ? scrollContainerElement.clientHeight
      : 0;
  const renderViewport =
    liveScrollContainerHeight > 0 && Math.abs(liveScrollContainerHeight - viewport.height) > 1
      ? { ...viewport, height: liveScrollContainerHeight }
      : viewportHeightHintValue > 0 && Math.abs(viewportHeightHintValue - viewport.height) > 1
        ? { ...viewport, height: viewportHeightHintValue }
        : viewport;

  const canvasScrollDrawRef = useRef<
    ((scrollTop: number, height: number, paintNow?: boolean) => void) | null
  >(null);
  const viewportPreparationQueuedRef = useRef(false);

  const pendingScrollDelta = useRef(0);
  const scrollRafActive = useRef(false);
  const bindScrollContainer = useCallback((el: HTMLDivElement | null) => {
    if (containerRef.current === el) return;
    if (el) {
      debugLog('[SequenceViewer] Container ref changed:', {
        oldExists: !!containerRef.current,
        newExists: true,
        oldScrollTop: containerRef.current?.scrollTop,
        newScrollTop: el.scrollTop,
        timestamp: new Date().toISOString(),
      });
    }
    containerRef.current = el;
    if (el) {
      el.style.overflowAnchor = 'none';
    }
    setScrollContainerElement(el);
  }, []);

  const handleCdsExtensionAnchor = useCallback((bp: number | null) => {
    if (bp === null) return;
    const container = containerRef.current;
    const currentLayout = layoutRef.current;
    if (!container || !currentLayout) return;
    cdsExtensionRowAnchorRef.current = nearestRowCopyForBp(currentLayout, bp, container.scrollTop);
  }, []);

  const [circularOffset, setCircularOffset] = useState(0);

  const [bpOffset, setBpOffset] = useState(0);

  const pendingScrollTargetRef = useRef<{
    position: number;
    placement: ScrollPlacement;
    anchorOffsetPx?: number;
    capturedGappedSequence?: string;
    cause?:
      | 'resize'
      | 'mutation-track'
      | 'circular-wrap'
      | 'compact-toggle'
      | 'selection-anchor'
      | 'navigation';
  } | null>(null);

  const anchorSelectionRef = useRef<Selection | null>(null);
  anchorSelectionRef.current = highlightedRange ?? controlledSelection ?? null;
  const committedTrackGeometryRef = useRef<SequenceTrackGeometry | null>(null);
  const scrollAnimationRafRef = useRef<number | null>(null);
  const scrollAnimationDestinationRef = useRef<{
    position: number;
    capturedGappedSequence?: string;
    onComplete?: () => void;
    cancel: () => void;
  } | null>(null);

  const buildRewrapScrollTarget = useCallback(
    (
      centerPos: number,
      scrollTop: number,
      clientHeight: number,
      prevLayout: LayoutSnapshot2D | null,
      capturedGappedSequence: string | undefined,
      cause: 'resize' | 'compact-toggle'
    ) => {
      const sel = anchorSelectionRef.current;
      if (sel && !capturedGappedSequence && prevLayout) {
        const anchor = captureSelectionScreenAnchor(
          scrollTop,
          clientHeight,
          prevLayout,
          sel.start,
          committedTrackGeometryRef.current ?? undefined
        );
        if (anchor) {
          return {
            position: anchor.position,
            placement: 'anchor' as const,
            anchorOffsetPx: anchor.anchorOffsetPx,
            capturedGappedSequence,
            cause: 'selection-anchor' as const,
          };
        }
      }
      return {
        position: centerPos,
        placement: 'center' as const,
        capturedGappedSequence,
        cause,
      };
    },
    []
  );

  const prevCharsPerLineRef = useRef<number>(0);
  const layoutForScrollPreservationRef = useRef<LayoutSnapshot2D | null>(null);

  const cdsExtensionRowAnchorRef = useRef<{ lineIndex: number; offsetPx: number } | null>(null);

  const prevTotalHeightRef = useRef<number>(0);

  const prevBpOffsetRef = useRef<number>(0);

  const layoutGappedSequenceRef = useRef<string | undefined>(undefined);

  const scrollPositionIntoViewRef = useRef<(position: number) => void>(() => {});

  const viewModeCursorRef = useRef<number>(0);
  const viewModeAnchorRef = useRef<number | null>(null);

  const autoScrollRef = useRef<{
    rafId: number | null;
    scrollSpeed: number;
  }>({ rafId: null, scrollSpeed: 0 });

  const { state: editorState, dispatch: editorDispatch } = useEditorState(
    sequence?.sequence || '',
    sequence?.annotations || [],
    onSequenceChange,
    onAnnotationsChange,
    onCursorChange,
    editorSession
  );

  // eslint-disable-next-line no-empty
  if (sequence?.sequence && !validateCoordinateSpace(coordinateSpace, sequence.sequence)) {
  }

  const effectiveEditable = editable && !isEditingDisabled(coordinateSpace);

  const prevEditableRef = useRef(effectiveEditable);

  useEffect(() => {
    if (effectiveEditable && !prevEditableRef.current) {
      const entrySelection = highlightedRange ?? controlledSelection ?? null;
      if (entrySelection) {
        editorDispatch({ type: 'SET_SELECTION', selection: entrySelection });
      } else if (initialCursor !== undefined) {
        editorDispatch({ type: 'SET_CURSOR', position: initialCursor });
      }
    } else if (!effectiveEditable && prevEditableRef.current && !editorSession) {
      editorDispatch({ type: 'DISCARD' });
    }
    prevEditableRef.current = effectiveEditable;
  }, [
    effectiveEditable,
    initialCursor,
    highlightedRange,
    controlledSelection,
    editorDispatch,
    editorSession,
  ]);

  const hasPendingChanges =
    editorState.insertedRanges.length > 0 || editorState.deletedRanges.length > 0;
  const prevHasPendingRef = useRef(hasPendingChanges);
  useEffect(() => {
    if (hasPendingChanges !== prevHasPendingRef.current) {
      prevHasPendingRef.current = hasPendingChanges;
      onPendingChangesChange?.(hasPendingChanges);
    }
  }, [hasPendingChanges, onPendingChangesChange]);

  const prevControlledSelectionRef = useRef(controlledSelection);
  useEffect(() => {
    if (effectiveEditable && controlledSelection !== prevControlledSelectionRef.current) {
      prevControlledSelectionRef.current = controlledSelection;
      editorDispatch({ type: 'SET_SELECTION', selection: controlledSelection ?? null });
    }
  }, [effectiveEditable, controlledSelection, editorDispatch]);

  const handleCommit = useCallback(() => {
    if (!hasUncommittedSequenceEdits(editorState)) return;
    if (onCommit) {
      onCommit();
      return;
    }
    if (!editorSession) editorDispatch({ type: 'COMMIT' });
  }, [editorState, editorDispatch, editorSession, onCommit]);

  const handleDiscard = useCallback(() => {
    if (!editorSession) editorDispatch({ type: 'DISCARD' });
    onDiscard?.();
  }, [editorDispatch, editorSession, onDiscard]);

  const canvasHighlightPreviewRef = useRef<((range: Selection | null) => void) | null>(null);
  const anchoredZoomToRef = useRef<((zoomLevel: number) => boolean) | null>(null);
  const anchoredFloorZoomToRef = useRef<((zoomLevel: number) => boolean) | null>(null);
  const scrollToBiologicalPositionRef = useRef<
    ((position: number, options?: ScrollToBiologicalPositionOptions) => void) | null
  >(null);
  useImperativeHandle(
    ref,
    () => ({
      zoomTo: (nextZoom: number) => anchoredZoomToRef.current?.(nextZoom) ?? false,
      commit: handleCommit,
      discard: handleDiscard,
      hasPendingChanges: () => hasPendingChanges,
      previewHighlight: (range: Selection | null) => {
        canvasHighlightPreviewRef.current?.(range);
      },
      scrollToBiologicalPosition: (
        position: number,
        options?: ScrollToBiologicalPositionOptions
      ) => {
        scrollToBiologicalPositionRef.current?.(position, options);
      },
    }),
    [handleCommit, handleDiscard, hasPendingChanges]
  );

  const remap = useCoordinateSpaceRemap({
    sequence,
    coordinateSpace,
    orfs,
    cutSites,
    scannedCutSites,
    rulerDecorations,
  });
  const { effectiveOrfs, effectiveCutSites, effectiveScannedCutSites, effectiveRulerDecorations } =
    remap;

  const effectiveSequence: AnnotatedSequence | null = useMemo(() => {
    if (!sequence) return null;
    if (isGappedMode(coordinateSpace) || !effectiveEditable) {
      return remap.effectiveSequence;
    }
    return {
      ...sequence,
      sequence: editorState.sequence,
      length: editorState.sequence.length,
      annotations: editorState.annotations,
    };
  }, [
    sequence,
    coordinateSpace,
    effectiveEditable,
    editorState.sequence,
    editorState.annotations,
    remap.effectiveSequence,
  ]);

  useEffect(() => {
    if (!effectiveSequence?.circular && bpOffset > 0) {
      setBpOffset(0);
    }
  }, [effectiveSequence?.circular, bpOffset]);
  const viewportRef = useTrackedRef<{ scrollTop: number; height: number }>(
    'viewportRef',
    { scrollTop: 0, height: 0 },
    summarize.viewport
  );
  useLayoutEffect(() => {
    if (freezeViewportHeight) return;
    if (viewportHeightHintValue <= 0) return;
    if (Math.abs(viewportHeightHintValue - viewportRef.current.height) <= 1) return;
    const scrollTop = viewportRef.current.scrollTop;
    const next = { scrollTop, height: viewportHeightHintValue };
    viewportRef.current = next;
    setViewport((prev) =>
      Math.abs(prev.height - viewportHeightHintValue) <= 1 && prev.scrollTop === scrollTop
        ? prev
        : next
    );
    canvasScrollDrawRef.current?.(scrollTop, viewportHeightHintValue);
  }, [viewportHeightHintValue, viewportRef, freezeViewportHeight]);

  const totalHeightRef = useRef(0);
  const layoutRef = useTrackedRef<typeof layout | null>('layoutRef', null, summarize.layout);
  const scrollRafRef = useRef<number | null>(null);
  const lastPublishedViewportRangeRef = useRef<string | null>(null);

  const getPreviousLayoutForScrollPreservation = useCallback(
    () => layoutForScrollPreservationRef.current ?? layoutRef.current,
    []
  );

  const getSequencePositionAtY = useCallback(
    (y: number, layout: typeof layoutRef.current): number | null =>
      getSequencePositionAtScrollY(y, layout),
    []
  );

  const lastKnownSequencePositionRef = useRef<number | null>(null);
  const [navigationEpoch, setNavigationEpoch] = useState(0);

  const publishViewportRange = useCallback(
    (
      currentLayout: typeof layoutRef.current,
      scrollTop: number,
      viewportHeight: number,
      source: ViewportChangeSource
    ): ViewportRange | null => {
      if (!currentLayout?.lines.length) return null;
      const range = calculateVisibleRange(
        scrollTop,
        viewportHeight,
        currentLayout.lines,
        currentLayout.sequenceLength || 0,
        effectiveSequence?.circular ?? false,
        currentLayout.summary
      );
      if (!range) return null;
      const wraps = (effectiveSequence?.circular ?? false) && range.endPos < range.startPos;
      const viewportRange: ViewportRange = wraps
        ? { start: range.startPos, end: range.endPos, wraps: true }
        : { start: range.startPos, end: range.endPos };
      const centerColumn = captureViewportCenterPosition(
        scrollTop,
        viewportHeight,
        currentLayout,
        null
      );
      if (centerColumn !== null) viewportRange.centerColumn = centerColumn;
      const key = `${viewportRange.start}:${viewportRange.end}:${viewportRange.wraps === true ? 1 : 0}:${viewportRange.centerColumn ?? ''}`;
      if (lastPublishedViewportRangeRef.current === key) return viewportRange;
      lastPublishedViewportRangeRef.current = key;
      onViewportChange?.(viewportRange, source);
      minimapRef.current?.setViewportPositions(viewportRange);
      return viewportRange;
    },
    [effectiveSequence?.circular, onViewportChange]
  );

  const handleViewportScroll = useCallback(
    (newScrollTop: number, newHeight: number, scrollHeight: number, paintNow = false) => {
      const collectScrollDiagnostics = diag.enabled;
      const scrollHandlerStart = collectScrollDiagnostics ? performance.now() : 0;
      const prevHeight = viewportRef.current.height;
      const logicalScrollEnabled = shouldEnableSequenceLogicalScroll();
      publishSequenceLogicalScroll(newScrollTop, logicalScrollEnabled);

      if (newScrollTop === 0 && viewportRef.current.scrollTop > 100) {
        debugLog('[SequenceViewer] SCROLL RESET TO 0!', {
          prevScrollTop: viewportRef.current.scrollTop,
          timestamp: new Date().toISOString(),
        });
      }

      diag.capture({
        type: 'scroll',
        scrollTop: newScrollTop,
        scrollHeight,
        clientHeight: newHeight,
      });

      viewportRef.current = { scrollTop: newScrollTop, height: newHeight };

      const visibleRangeStart = collectScrollDiagnostics ? performance.now() : 0;
      publishViewportRange(layoutRef.current, newScrollTop, newHeight, 'scroll');
      const visibleRangeMs = collectScrollDiagnostics ? performance.now() - visibleRangeStart : 0;

      const activeLayout = layoutRef.current;
      const activeLines = activeLayout?.lines;
      const scoped =
        (effectiveSequence?.sequence?.length ?? 0) >= VIEWPORT_SCOPED_LAYOUT_SEQUENCE_THRESHOLD &&
        activeLines &&
        activeLines.length > 0;
      const firstPrepared = scoped ? activeLines[0] : null;
      const lastPrepared = scoped ? activeLines[activeLines.length - 1] : null;
      const summary = activeLayout?.summary;
      const preparedTop =
        firstPrepared && firstPrepared.lineIndex > 0 ? firstPrepared.y : -Infinity;
      const preparedBottom =
        lastPrepared && summary && lastPrepared.lineIndex < summary.totalRows - 1
          ? summary.rowYOffsets[lastPrepared.lineIndex + 1]
          : Infinity;
      const needsPreparation =
        newScrollTop < preparedTop || newScrollTop + newHeight > preparedBottom;
      const margin = Math.max(100, newHeight / 4);
      const needsLayoutWindow =
        newScrollTop < preparedTop + margin || newScrollTop + newHeight > preparedBottom - margin;

      const drawDispatchStart = collectScrollDiagnostics ? performance.now() : 0;
      const drawAvailable = canvasScrollDrawRef.current !== null;
      const disableScrollDraw =
        typeof window !== 'undefined' &&
        canvasTestWindow(window).__disableSequenceCanvasScrollDraw === true;
      if (needsPreparation) {
        if (!viewportPreparationQueuedRef.current) {
          viewportPreparationQueuedRef.current = true;
          queueMicrotask(() => {
            viewportPreparationQueuedRef.current = false;
            const container = containerRef.current;
            if (!container) return;
            flushSync(() =>
              setViewport({ scrollTop: container.scrollTop, height: container.clientHeight })
            );
            if (!disableScrollDraw)
              canvasScrollDrawRef.current?.(container.scrollTop, container.clientHeight, true);
          });
        }
      } else if (!disableScrollDraw) {
        canvasScrollDrawRef.current?.(newScrollTop, newHeight, paintNow);
      }
      const drawDispatchMs = collectScrollDiagnostics ? performance.now() - drawDispatchStart : 0;

      if (!needsPreparation && (newHeight !== prevHeight || needsLayoutWindow)) {
        setViewport({ scrollTop: newScrollTop, height: newHeight });
      }

      if (collectScrollDiagnostics) {
        diag.capture({
          type: 'scroll-handler',
          scrollTop: newScrollTop,
          height: newHeight,
          drawAvailable,
          drawDispatchMs,
          visibleRangeMs,
          totalMs: performance.now() - scrollHandlerStart,
        });
      }

      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      scrollRafRef.current = requestAnimationFrame(() => {
        const scrollRafStart = diag.enabled ? performance.now() : 0;
        const minimapStart = diag.enabled ? performance.now() : 0;
        minimapRef.current?.setViewport(newScrollTop, newHeight, totalHeightRef.current);
        if (diag.enabled) {
          diag.capture({
            type: 'minimap-viewport',
            scrollTop: newScrollTop,
            height: newHeight,
            totalHeight: totalHeightRef.current,
            durMs: performance.now() - minimapStart,
          });
        }

        const centerStart = diag.enabled ? performance.now() : 0;
        let centerMs = 0;
        if (newScrollTop > 0 && layoutRef.current) {
          const centerPos = captureViewportCenterPosition(
            newScrollTop,
            newHeight,
            layoutRef.current,
            null
          );
          if (centerPos !== null) {
            lastKnownSequencePositionRef.current = centerPos;
          }
        }
        if (diag.enabled) centerMs = performance.now() - centerStart;

        if (diag.enabled) {
          diag.capture({
            type: 'scroll-raf',
            scrollTop: newScrollTop,
            height: newHeight,
            centerMs,
            visibleRangeMs: 0,
            totalMs: performance.now() - scrollRafStart,
          });
        }
      });
    },
    [publishViewportRange, effectiveSequence?.sequence?.length]
  );

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      if (
        target.scrollTop === viewportRef.current.scrollTop &&
        target.clientHeight === viewportRef.current.height
      )
        return;
      handleViewportScroll(target.scrollTop, target.clientHeight, target.scrollHeight);
    },
    [handleViewportScroll]
  );

  useEffect(() => {
    const onPortalHostAttached = () => {
      const container = containerRef.current;
      if (!container?.isConnected) return;
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el?.isConnected) return;
        handleViewportScroll(el.scrollTop, el.clientHeight, el.scrollHeight);
      });
    };
    window.addEventListener('waypoint:tab-portal-host-attached', onPortalHostAttached);
    return () =>
      window.removeEventListener('waypoint:tab-portal-host-attached', onPortalHostAttached);
  }, [handleViewportScroll]);

  const requestCircularScrollReanchor = useCallback(
    (
      currentLayout: LayoutSnapshot2D,
      scrollTop: number,
      viewportHeight: number,
      direction: 1 | -1,
      source: 'wheel' | 'webgl-sync'
    ): boolean => {
      if (!effectiveSequence?.circular || !effectiveSequence.sequence) return false;
      if (!hasCircularScrollBuffers(currentLayout)) return false;

      const seqLen = effectiveSequence.sequence.length;
      const {
        realRowsStartY = 0,
        bottomBufferStartY = 0,
        firstRealRowIndex = 0,
        firstBottomBufferIndex = 0,
      } = currentLayout;

      const charsPerLine = currentLayout.lines[0]?.sequence.length || 108;
      const baseLineCount = firstBottomBufferIndex - firstRealRowIndex;
      const circularShift = (baseLineCount * charsPerLine) % seqLen;
      if (circularShift <= 0) return false;

      const topBufferMidY = realRowsStartY / 2;
      const bottomBufferMidY =
        bottomBufferStartY + (currentLayout.totalHeight - bottomBufferStartY) / 2;
      const shouldWrapDown = direction > 0 && scrollTop + viewportHeight >= bottomBufferMidY;
      const shouldWrapUp = direction < 0 && scrollTop <= topBufferMidY;
      if (!shouldWrapDown && !shouldWrapUp) return false;

      const viewportTopPosition = getSequencePositionAtY(scrollTop, currentLayout);
      if (viewportTopPosition === null) return false;

      const newOffset = shouldWrapDown
        ? (circularOffset + circularShift) % seqLen
        : (((circularOffset - circularShift) % seqLen) + seqLen) % seqLen;

      pendingScrollTargetRef.current = {
        position: viewportTopPosition,
        placement: 'top',
        cause: 'circular-wrap',
      };

      debugLog(shouldWrapDown ? '[WRAP DOWN]' : '[WRAP UP]', {
        source,
        oldOffset: circularOffset,
        newOffset,
        circularShift,
        viewportTopPosition,
      });
      diag.capture({
        type: 'marker',
        label: 'circular-wrap',
        data: {
          source,
          direction: shouldWrapDown ? 'down' : 'up',
          scrollTop,
          viewportHeight,
          circularOffset,
          newOffset,
          circularShift,
          viewportTopPosition,
        },
      });

      setCircularOffset(newOffset);
      return true;
    },
    [
      circularOffset,
      effectiveSequence?.circular,
      effectiveSequence?.sequence,
      getSequencePositionAtY,
    ]
  );

  useEffect(() => {
    const useLogicalScroll = shouldEnableSequenceLogicalScroll();
    if (!useLogicalScroll) return;
    const container = scrollContainerElement;
    if (!container) return;
    let cancelled = false;
    publishSequenceLogicalScroll(viewportRef.current.scrollTop, useLogicalScroll);

    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) return;
      if (e.ctrlKey || e.metaKey) return;

      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      e.preventDefault();
      pendingScrollDelta.current += e.deltaY;

      if (!scrollRafActive.current) {
        scrollRafActive.current = true;
        const pump = () => {
          if (cancelled) {
            pendingScrollDelta.current = 0;
            scrollRafActive.current = false;
            return;
          }
          if (Math.abs(pendingScrollDelta.current) > 0.5) {
            const delta = pendingScrollDelta.current;
            pendingScrollDelta.current = 0;
            const height = container.clientHeight;
            const maxScrollTop = Math.max(0, totalHeightRef.current - height);
            const currentTop = viewportRef.current.scrollTop || container.scrollTop || 0;
            const nextScrollTop = Math.max(0, Math.min(maxScrollTop, currentTop + delta));
            handleViewportScroll(nextScrollTop, height, container.scrollHeight);
            requestAnimationFrame(pump);
          } else {
            scrollRafActive.current = false;
          }
        };
        requestAnimationFrame(pump);
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelled = true;
      pendingScrollDelta.current = 0;
      scrollRafActive.current = false;
      container.removeEventListener('wheel', onWheel);
    };
  }, [scrollContainerElement, handleViewportScroll]);

  const baseConfig = useMemo<WorkspaceEditorConfig>(
    () => ({ ...DEFAULT_EDITOR_CONFIG, ...partialConfig }),
    [
      partialConfig?.charsPerLine,
      partialConfig?.charWidth,
      partialConfig?.rowHeight,
      partialConfig?.marginLeft,
      partialConfig?.fontFamily,
      partialConfig?.fontSize,
      partialConfig?.rulerInterval,
      partialConfig?.showTranslation,
      partialConfig?.showAnnotations,
      partialConfig?.showReverseComplement,
      partialConfig?.showPrimers,
      partialConfig?.translationMode,
      partialConfig?.colorPalette,
      partialConfig?.annotationColorMode,
      partialConfig?.aaColorScheme,
      partialConfig?.showResidueNumbers,
      partialConfig?.lodLevel,
      partialConfig?.previewDetailTracks?.progress,
      partialConfig?.previewDetailTracks?.showTranslation,
      partialConfig?.previewDetailTracks?.showReverseComplement,
      partialConfig?.previewDetailTracks?.showResidueNumbers,
      partialConfig?.overviewLod,
    ]
  );

  const virtualRowCount = useMemo(() => {
    if (!effectiveSequence?.circular) return 0;
    const stableViewportHeight =
      typeof circularBufferViewportHeight === 'number' && circularBufferViewportHeight > 0
        ? circularBufferViewportHeight
        : 0;
    const bufferViewportHeight = freezeViewportHeight
      ? stableViewportHeight > 0
        ? stableViewportHeight
        : renderViewport.height
      : stableViewportHeight > 0
        ? Math.max(stableViewportHeight, renderViewport.height)
        : renderViewport.height;
    return computeCircularVirtualRowCount(baseConfig, bufferViewportHeight);
  }, [
    effectiveSequence?.circular,
    baseConfig,
    circularBufferViewportHeight,
    renderViewport.height,
    freezeViewportHeight,
    baseConfig.rowHeight,
    baseConfig.lodLevel,
    baseConfig.overviewLod,
  ]);

  const getYForSequencePosition = useCallback(
    (
      position: number,
      layout: typeof layoutRef.current,
      preferRealRows: boolean = false
    ): number | null => getScrollYForSequencePosition(position, layout, preferRealRows),
    []
  );

  const handleCircularWheel = useCallback(
    (e: WheelEvent) => {
      if (!effectiveSequence?.circular || !effectiveSequence.sequence) return;

      const container = containerRef.current;
      const currentLayout = layoutRef.current;
      if (!container || !currentLayout || currentLayout.lines.length === 0) return;

      const seqLen = effectiveSequence.sequence.length;

      if (e.shiftKey) {
        e.preventDefault();
        const charDelta = Math.sign(e.deltaY) * Math.max(1, Math.floor(Math.abs(e.deltaY) / 30));
        setCircularOffset((prev) => (((prev + charDelta) % seqLen) + seqLen) % seqLen);
        return;
      }

      if (e.ctrlKey || e.metaKey) return;

      if (
        shouldEnableSequenceLogicalScroll() &&
        requestCircularScrollReanchor(
          currentLayout,
          container.scrollTop,
          container.clientHeight,
          e.deltaY > 0 ? 1 : -1,
          'wheel'
        )
      ) {
        e.preventDefault();
        return;
      }
    },
    [effectiveSequence?.circular, effectiveSequence?.sequence, requestCircularScrollReanchor]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !effectiveSequence?.circular) return;

    container.addEventListener('wheel', handleCircularWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleCircularWheel);
    };
  }, [effectiveSequence?.circular, handleCircularWheel]);

  const cancelAnimatedScrollRef = useRef<(() => void) | null>(null);
  const animatedScrollHandlersRef = useRef({
    publish: handleViewportScroll,
    reanchor: requestCircularScrollReanchor,
  });
  animatedScrollHandlersRef.current = {
    publish: handleViewportScroll,
    reanchor: requestCircularScrollReanchor,
  };
  useEffect(() => {
    const container = scrollContainerElement;
    if (!container || shouldEnableSequenceLogicalScroll()) return;
    const wheelScroll = installAnimatedWheelScroll(
      container,
      () =>
        animatedScrollHandlersRef.current.publish(
          container.scrollTop,
          container.clientHeight,
          container.scrollHeight,
          true
        ),
      (direction) => {
        const currentLayout = layoutRef.current;
        return (
          !!currentLayout &&
          animatedScrollHandlersRef.current.reanchor(
            currentLayout,
            container.scrollTop,
            container.clientHeight,
            direction,
            'wheel'
          )
        );
      }
    );
    cancelAnimatedScrollRef.current = wheelScroll.cancel;
    return () => {
      cancelAnimatedScrollRef.current = null;
      wheelScroll.dispose();
    };
  }, [scrollContainerElement, effectiveSequence?.id]);

  const initialScrollAppliedYRef = useRef<number | null>(null);

  const [internalSelection, setInternalSelection] = useState<Selection | null>(null);
  const selection = controlledSelection !== undefined ? controlledSelection : internalSelection;

  const isShiftSelectingRef = useRef(false);

  const handleSelectionChange = useCallback(
    (newSelection: Selection | null) => {
      if (!effectiveEditable && !isShiftSelectingRef.current) {
        if (newSelection) {
          viewModeCursorRef.current = newSelection.end;
          viewModeAnchorRef.current = null;
        }
      }
      if (onSelectionChange) {
        onSelectionChange(newSelection);
      } else {
        setInternalSelection(newSelection);
      }
    },
    [onSelectionChange, effectiveEditable]
  );

  const handleCursorChange = useCallback(
    (position: number) => {
      if (effectiveEditable) {
        editorDispatch({ type: 'SET_CURSOR', position });
      } else {
        viewModeCursorRef.current = position;
        viewModeAnchorRef.current = null;
      }
    },
    [effectiveEditable, editorDispatch]
  );

  useEffect(() => {
    if (viewCursor !== null && viewCursor !== undefined) {
      viewModeAnchorRef.current = null;
    }
  }, [viewCursor]);

  const effectiveCharsPerLine = useMemo(() => {
    return calculateAutoCharsPerLine(baseConfig, containerWidth);
  }, [baseConfig.charsPerLine, baseConfig.marginLeft, baseConfig.charWidth, containerWidth]);

  useKeyboardNavigation({
    keyboardTargetRef: containerRef,
    editable: effectiveEditable,
    keyboardActive,
    editorState,
    editorDispatch,
    selection: controlledSelection,
    sequence,
    handleSelectionChange,
    effectiveCharsPerLine,
    handleCommit,
    highlightedRange,
    viewCursor,
    onViewCursorChange,
    onHighlightedRangeChange,
    viewModeCursorRef,
    viewModeAnchorRef,
    scrollPositionIntoViewRef,
    resolvePasteFragment,
    onCopyDraftSelection,
  });

  const measureScrollContainerRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const container = scrollContainerElement;
    if (!container) return;
    let lastWidth = 0;
    let lastHeight = 0;
    let rafId: number | null = null;

    let reattachWidthSettling = false;
    let reattachWidthStability: PortalWidthStability = INITIAL_PORTAL_WIDTH_STABILITY;
    let settleRafId: number | null = null;

    const handleResize = () => {
      if (!container.isConnected || containerRef.current !== container) return;
      const width = container.clientWidth;
      const height = container.clientHeight;

      if (!containerRef.current.isConnected || width <= 0) {
        return;
      }

      // eslint-disable-next-line no-empty
      if (reattachWidthSettling) {
      } else if (Math.abs(width - lastWidth) > 1) {
        if (
          lastWidth > 0 &&
          (!effectiveSequence?.circular || initialScrollAppliedYRef.current !== null)
        ) {
          const capturedGappedSeq = layoutGappedSequenceRef.current;
          const currentScrollTop = container.scrollTop;
          const centerPos = captureViewportCenterPosition(
            currentScrollTop,
            container.clientHeight,
            getPreviousLayoutForScrollPreservation(),
            lastKnownSequencePositionRef.current
          );

          if (
            centerPos !== null &&
            pendingScrollTargetRef.current?.cause !== 'navigation' &&
            pendingScrollTargetRef.current?.cause !== 'selection-anchor'
          ) {
            pendingScrollTargetRef.current = buildRewrapScrollTarget(
              centerPos,
              currentScrollTop,
              container.clientHeight,
              getPreviousLayoutForScrollPreservation(),
              capturedGappedSeq,
              'resize'
            );
          }
        }
        lastWidth = width;
        setContainerWidth(width);
      }

      if (Math.abs(height - lastHeight) > 1) {
        lastHeight = height;
        const newViewport = {
          scrollTop: container.scrollTop,
          height: height,
        };
        viewportRef.current = newViewport;
        setViewport(newViewport);
        canvasScrollDrawRef.current?.(newViewport.scrollTop, newViewport.height);
      }
    };

    measureScrollContainerRef.current = handleResize;
    handleResize();
    rafId = requestAnimationFrame(handleResize);

    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(container);
    window.addEventListener('resize', handleResize);

    const onPortalHostAttachedForWidth = () => {
      if (containerRef.current !== container || !container.isConnected) return;
      reattachWidthSettling = true;
      reattachWidthStability = INITIAL_PORTAL_WIDTH_STABILITY;
      if (settleRafId !== null) cancelAnimationFrame(settleRafId);
      const step = () => {
        if (containerRef.current !== container || !container.isConnected) {
          settleRafId = null;
          return;
        }
        const result = samplePortalReattachWidth(reattachWidthStability, container.clientWidth);
        reattachWidthStability = result.state;
        handleResize();
        if (!result.settled) {
          settleRafId = requestAnimationFrame(step);
          return;
        }
        reattachWidthSettling = false;
        settleRafId = null;
        handleResize();
      };
      settleRafId = requestAnimationFrame(step);
    };
    window.addEventListener('waypoint:tab-portal-host-attached', onPortalHostAttachedForWidth);

    return () => {
      measureScrollContainerRef.current = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (settleRafId !== null) cancelAnimationFrame(settleRafId);
      reattachWidthSettling = false;
      reattachWidthStability = INITIAL_PORTAL_WIDTH_STABILITY;
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('waypoint:tab-portal-host-attached', onPortalHostAttachedForWidth);
    };
  }, [scrollContainerElement, getPreviousLayoutForScrollPreservation]);

  useLayoutEffect(() => {
    if (surfaceVisible) measureScrollContainerRef.current?.();
  }, [initialContainerWidth, surfaceVisible]);

  const zoomWrapAnchorRef = useRef<WrapScreenAnchor | null>(null);
  const releasedZoomAnchorRef = useRef<{
    bp: number;
    viewportY: number;
    placement: ZoomAnchorRowPlacement;
    lastScrollTop: number;
  } | null>(null);
  const rowBackgroundOffsetRef = useRef(0);
  const [zoomGestureEpoch, setZoomGestureEpoch] = useState(0);
  const [releasedWrapPhase, setReleasedWrapPhase] = useState<{
    anchor: WrapScreenAnchor;
    phase: number;
    direction?: -1 | 1;
  } | null>(null);
  const [previewTargetZoom, setPreviewTargetZoom] = useState<{
    zoom: number;
    direction: -1 | 1;
  } | null>(null);
  const previewZoomDirectionRef = useRef<-1 | 1 | undefined>(undefined);
  const [trackForecastActive, setTrackForecastActive] = useState(false);
  const horizontalTargetFrameRef = useRef<WrapRowXFrame | null>(null);
  const horizontalPaintedFrameRef = useRef<WrapRowXFrame | null>(null);
  const horizontalMotionRef = useRef<Map<number, WrapRowXMotion>>(new Map());
  const horizontalMotionSeqRef = useRef(0);
  const horizontalAnchorRef = useRef<WrapScreenAnchor | null>(null);
  const horizontalReleasedAtRef = useRef<number | null>(null);
  const [horizontalTick, setHorizontalTick] = useState(0);
  const screenTrackFrameRef = useRef<ScreenTrackFrame | null>(null);
  const pendingScreenTrackFrameRef = useRef<ScreenTrackFrame | null>(null);
  const presentationFrameRafRef = useRef<number | null>(null);
  const presentationAdvanceRef = useRef<(now: number) => void>(() => {});
  const presentedLayoutRef = useRef<LayoutSnapshot2D | null>(null);
  const presentedAtRef = useRef(0);
  const pendingZoomFrameRef = useRef<() => boolean>(() => false);
  const flushZoomFrameRef = useRef<(now: number) => boolean>(() => false);
  const requestPresentationFrame = useCallback(() => {
    if (presentationFrameRafRef.current !== null) return;
    presentationFrameRafRef.current = requestAnimationFrame((now) => {
      presentationFrameRafRef.current = null;
      presentationAdvanceRef.current(now);
    });
  }, []);
  const previousTrackConfigRef = useRef<WorkspaceEditorConfig | null>(null);
  const [screenTrackTick, setScreenTrackTick] = useState(0);
  const [viewportOriginOffset, setViewportOriginOffset] = useState(0);
  const [scrollEndAnchorHeadroom, setScrollEndAnchorHeadroom] = useState(0);
  useLayoutEffect(
    () => () => {
      if (presentationFrameRafRef.current !== null)
        cancelAnimationFrame(presentationFrameRafRef.current);
      presentationFrameRafRef.current = null;
    },
    []
  );
  const config = useMemo<WorkspaceEditorConfig>(() => {
    const newCharsPerLine = calculateAutoCharsPerLine(baseConfig, containerWidth);
    const previewAhead =
      previewTargetZoom !== null &&
      (previewTargetZoom.zoom - (zoomLevel ?? 100)) * previewTargetZoom.direction > 0.000001;
    const previewCpr =
      previewAhead && baseConfig.charsPerLine <= 0
        ? charsPerRowAt(previewTargetZoom!.zoom, containerWidth, {
            baseCharWidth: DEFAULT_EDITOR_CONFIG.charWidth,
            baseRowHeight: DEFAULT_EDITOR_CONFIG.rowHeight,
            marginLeft: baseConfig.marginLeft,
          })
        : null;
    const nextCpr =
      previewCpr !== null && previewCpr !== newCharsPerLine ? previewCpr : newCharsPerLine + 1;
    const gestureAnchor = zoomWrapAnchorRef.current ?? releasedWrapPhase?.anchor;
    const anchor = gestureAnchor?.holdsLinearOrigin ? undefined : gestureAnchor;
    const nextColumn = anchor
      ? Math.max(
          0,
          Math.min(
            nextCpr - 1,
            Math.round(
              ((anchor.viewportX - baseConfig.marginLeft) * nextCpr) /
                Math.max(1, containerWidth - baseConfig.marginLeft)
            )
          )
        )
      : 0;
    const seqLen = effectiveSequence?.sequence.length ?? 0;
    const nextOffset = anchor ? anchor.unwrappedBp - nextColumn : 0;
    if (anchor && seqLen > 0) {
      const currentTop = effectiveSequence?.circular
        ? (((circularOffset + bpOffset) % seqLen) + seqLen) % seqLen
        : bpOffset;
      const anchorRow =
        Math.floor((anchor.unwrappedBp - currentTop) / newCharsPerLine) +
        (effectiveSequence?.circular ? virtualRowCount : 0);
      rowBackgroundOffsetRef.current = anchor.backgroundParity - anchorRow;
    }
    return {
      ...baseConfig,
      ...resolveIndexedCdsZoomConfig(
        baseConfig,
        containerWidth > baseConfig.marginLeft ? containerWidth : AUTO_WRAP_FALLBACK_WIDTH
      ),
      linearWrapPhase: true,
      pinLinearOrigin: true,
      rowBackgroundOffset: rowBackgroundOffsetRef.current,
      wrapAnchorBp: anchor?.unwrappedBp,
      wrapAnchorViewportX: anchor?.viewportX,
      wrapAnchorCapacityBias: anchor?.capacityBias,
      wrapForecastDirection: previewTargetZoom?.direction ?? releasedWrapPhase?.direction,
      wrapTrackForecast: trackForecastActive,
      charsPerLine: newCharsPerLine,
      wrapPreviewTargetCpr: previewCpr === newCharsPerLine ? undefined : (previewCpr ?? undefined),
      wrapCapacity:
        baseConfig.charsPerLine > 0
          ? undefined
          : Math.max(
              10,
              ((containerWidth > baseConfig.marginLeft
                ? containerWidth
                : AUTO_WRAP_FALLBACK_WIDTH) -
                baseConfig.marginLeft) /
                baseConfig.charWidth
            ),
      predictedTopBp: anchor
        ? effectiveSequence?.circular
          ? ((nextOffset % seqLen) + seqLen) % seqLen
          : linearWrapTopBp(anchor.unwrappedBp, nextColumn, nextCpr, true)
        : undefined,
    };
  }, [
    baseConfig,
    containerWidth,
    previewTargetZoom,
    trackForecastActive,
    releasedWrapPhase?.anchor,
    zoomLevel,
    circularOffset,
    bpOffset,
    virtualRowCount,
    effectiveSequence?.circular,
    effectiveSequence?.sequence.length,
  ]);

  const zoomTargetRef = useRef<HTMLDivElement>(null);
  const zoomInFlightRef = useRef<boolean>(false);

  const prevHasMutationTrackRef = useRef<boolean | undefined>(undefined);

  const hasMutationTrack = (mutations?.length ?? 0) > 0 || !!coordinateSpace?.alignedQuery;

  useEffect(() => {
    if (
      prevHasMutationTrackRef.current !== undefined &&
      prevHasMutationTrackRef.current !== hasMutationTrack &&
      containerRef.current
    ) {
      const currentScrollTop = containerRef.current.scrollTop;
      const capturedGappedSeq = layoutGappedSequenceRef.current;

      const centerPos = captureViewportCenterPosition(
        currentScrollTop,
        containerRef.current.clientHeight,
        getPreviousLayoutForScrollPreservation(),
        lastKnownSequencePositionRef.current
      );

      debugLog('[SequenceViewer] Mutation track state changing:', {
        prevHasMutationTrack: prevHasMutationTrackRef.current,
        hasMutationTrack,
        currentScrollTop,
        containerHeight: containerRef.current.clientHeight,
        centerPos,
        usedFallback: currentScrollTop === 0,
        lastKnownSequencePosition: lastKnownSequencePositionRef.current,
        timestamp: new Date().toISOString(),
      });

      if (centerPos !== null && !pendingScrollTargetRef.current) {
        debugLog('[SequenceViewer] Mutation track changing, saving center position:', {
          prevHasMutationTrack: prevHasMutationTrackRef.current,
          hasMutationTrack,
          direction: hasMutationTrack ? 'adding track' : 'removing track',
          centerPosition: centerPos,
          capturedGappedSeqLen: capturedGappedSeq?.length ?? 'none',
          currentCoordSpaceIsGapped: isGappedMode(coordinateSpace),
          timestamp: new Date().toISOString(),
        });
        pendingScrollTargetRef.current = {
          position: centerPos,
          placement: 'center',
          capturedGappedSequence: capturedGappedSeq,
        };
      }
    }
    prevHasMutationTrackRef.current = hasMutationTrack;
  }, [hasMutationTrack, getPreviousLayoutForScrollPreservation]);

  const viewportScopedLayoutRange = useMemo<LayoutViewportRange | undefined>(() => {
    const seqLen = effectiveSequence?.sequence?.length ?? 0;
    const isCircular = effectiveSequence?.circular ?? false;
    const cpr = config.charsPerLine;
    if (seqLen < VIEWPORT_SCOPED_LAYOUT_SEQUENCE_THRESHOLD) return undefined;
    if (cpr <= 0) return undefined;

    const normalizedTopBp = isCircular
      ? (((circularOffset + bpOffset) % seqLen) + seqLen) % seqLen
      : bpOffset;
    const effectiveLinearLen = Math.max(0, seqLen - normalizedTopBp);
    const realRowCount = isCircular
      ? Math.ceil(seqLen / cpr)
      : Math.max(1, Math.ceil(effectiveLinearLen / cpr));
    const topBufferCount = isCircular ? virtualRowCount : 0;
    const bottomBufferCount = isCircular ? virtualRowCount : 0;
    const totalRows = topBufferCount + realRowCount + bottomBufferCount;
    const density = config.overviewLod || config.lodLevel === 'density';
    let minimumPitch =
      (density
        ? Math.max(1, Math.ceil(config.rowHeight))
        : config.rowHeight + RULER_HEIGHT + ROW_BOTTOM_PADDING + 32) +
      (config.showReverseComplement ? config.rowHeight : 0) +
      (hasMutationTrack ? config.rowHeight : 0);
    const oldFrame = screenTrackFrameRef.current;
    let maxPaintedRowPitch = Infinity;
    for (const [slot, bands] of oldFrame?.bands ?? []) {
      maxPaintedRowPitch = Math.min(
        maxPaintedRowPitch,
        bands[bands.length - 1] + (oldFrame!.gaps.get(slot) ?? oldFrame!.rowGapPx)
      );
    }
    minimumPitch = Math.min(minimumPitch, maxPaintedRowPitch);
    const overscanRows =
      Math.ceil((Math.max(0, viewportRef.current.height) + 100) / Math.max(0.001, minimumPitch)) +
      2;
    const aroundRow = (anchorRowIndex: number): LayoutViewportRange => ({
      firstRowIndex: Math.max(0, anchorRowIndex - overscanRows),
      lastRowIndex: Math.min(totalRows - 1, anchorRowIndex + overscanRows),
      emitOnlyViewportLines: true,
      anchorRowIndex,
      radiusPx: Math.max(0, viewportRef.current.height) + 100,
      maxPaintedRowPitch,
    });

    const pendingNavigation = pendingScrollTargetRef.current;
    if (pendingNavigation?.cause === 'navigation') {
      const position = convertScrollPosition(
        pendingNavigation.position,
        !!pendingNavigation.capturedGappedSequence,
        isGappedMode(coordinateSpace),
        pendingNavigation.capturedGappedSequence,
        coordinateSpace?.gappedSequence
      );
      const destinationRow = absoluteRowIndexForBpInGeometry(position, {
        cpr,
        seqLen,
        isCircular,
        topBp: normalizedTopBp,
        topBufferCount,
        realRowCount,
      });
      if (destinationRow >= 0) return aroundRow(destinationRow);
    }

    const zoomAnchor = zoomInFlightRef.current ? zoomWrapAnchorRef.current : null;
    if (zoomAnchor) {
      const centerRow =
        Math.floor((zoomAnchor.unwrappedBp - normalizedTopBp) / cpr) + topBufferCount;
      return aroundRow(centerRow);
    }

    if (
      isCircular &&
      initialScrollAppliedYRef.current === null &&
      !pendingScrollTargetRef.current
    ) {
      return aroundRow(topBufferCount);
    }

    const previousSummary = layoutRef.current?.summary;
    const viewportCenterY =
      viewportRef.current.scrollTop + Math.max(0, viewportRef.current.height) / 2;
    if (
      previousSummary?.cpr === cpr &&
      previousSummary.topBp === normalizedTopBp &&
      previousSummary.topBufferCount === topBufferCount
    ) {
      const centerRow = absoluteRowIndexForY(viewportCenterY, previousSummary);
      return aroundRow(centerRow);
    }
    let centerBp = lastKnownSequencePositionRef.current ?? normalizedTopBp;
    let centerRole: ScopedCenterRole = 'real';

    if (previousSummary) {
      const previousCenterRow = absoluteRowIndexForY(viewportCenterY, previousSummary);
      const previousBp = bpForAbsoluteRowIndex(previousCenterRow, previousSummary);
      if (previousBp >= 0) centerBp = previousBp;
      if (previousCenterRow < previousSummary.topBufferCount) {
        centerRole = 'top-buffer';
      } else if (
        previousCenterRow >=
        previousSummary.topBufferCount + previousSummary.realRowCount
      ) {
        centerRole = 'bottom-buffer';
      }
    }

    if (centerBp === null || centerBp === undefined) return undefined;
    const realCenterRow = absoluteRowIndexForBpInGeometry(centerBp, {
      cpr,
      seqLen,
      isCircular,
      topBp: normalizedTopBp,
      topBufferCount,
      realRowCount,
    });
    if (realCenterRow < 0) return undefined;

    const centerRow = aliasRowIndexForRole(realCenterRow, centerRole, {
      topBufferCount,
      realRowCount,
      bottomBufferCount,
    });
    return aroundRow(centerRow);
  }, [
    zoomGestureEpoch,
    navigationEpoch,
    coordinateSpace?.mode,
    coordinateSpace?.gappedSequence,
    viewport.scrollTop,
    viewport.height,
    effectiveSequence?.sequence,
    effectiveSequence?.circular,
    config.charsPerLine,
    config.wrapAnchorBp,
    config.wrapTrackForecast,
    circularOffset,
    bpOffset,
    virtualRowCount,
    config.rowHeight,
    config.overviewLod,
    config.lodLevel,
    config.showReverseComplement,
    hasMutationTrack,
    layoutRef,
    viewportRef,
  ]);

  const { snapshot: targetLayout } = useSequenceLayout(
    effectiveSequence,
    config,
    effectiveSequence?.circular ? circularOffset : 0,
    effectiveSequence?.circular ? virtualRowCount : 0,
    primers,
    hasMutationTrack,
    effectiveOrfs,
    bpOffset,
    viewportScopedLayoutRange
  );

  const screenTrackMorph = useMemo(() => {
    const start = performance.now();
    const frame = screenTrackFrameRef.current;
    const scroll = containerRef.current;
    const anchorBp = zoomWrapAnchorRef.current?.unwrappedBp ?? frame?.anchorBp;
    const visibleSlots = (() => {
      if (!frame || !scroll) return undefined;
      const anchorY =
        zoomWrapAnchorRef.current?.viewportY ??
        releasedWrapPhase?.anchor.viewportY ??
        scroll.clientHeight / 2;
      const pitch = (slot: number) => {
        const bands = frame.bands.get(slot);
        return (
          (bands ? bands[bands.length - 1] : Math.max(1, config.rowHeight * 4)) +
          (frame.gaps.get(slot) ?? frame.rowGapPx)
        );
      };
      let above = anchorY;
      let min = 0;
      while (above > -64 && min > -64) above -= pitch(--min);
      let below = anchorY;
      let max = 0;
      while (below < scroll.clientHeight + 64 && max < 64) below += pitch(max++);
      return { min, max };
    })();
    const result = frame
      ? morphScreenTracks(targetLayout, config, frame, anchorBp!, start, visibleSlots, {
          fastZoomInternal:
            zoomInFlightRef.current ||
            releasedZoomAnchorRef.current !== null ||
            releasedWrapPhase !== null,
        })
      : null;
    const perf = typeof window === 'undefined' ? null : canvasTestWindow(window).__zoomPerf;
    if (perf) {
      const t = performance.now();
      (perf.trackMorphs ??= []).push({ start, t, durMs: t - start });
      if (perf.trackMorphs.length > 400) perf.trackMorphs.shift();
    }
    return result;
  }, [targetLayout, config, screenTrackTick, releasedWrapPhase]);
  const targetScreenLayout = useMemo(() => {
    const base = offsetLayoutViewport(
      screenTrackMorph?.layout ?? targetLayout,
      effectiveSequence?.circular ? 0 : viewportOriginOffset
    );
    if (!releasedWrapPhase || zoomWrapAnchorRef.current || !base.summary) return base;
    const phase = releasedWrapPhase.phase;
    return {
      ...base,
      lines: base.lines.map((row) => ({ ...row, xOffset: (row.xOffset ?? 0) * phase })),
    };
  }, [
    screenTrackMorph,
    targetLayout,
    effectiveSequence?.circular,
    viewportOriginOffset,
    releasedWrapPhase,
  ]);

  const layout = useMemo(() => {
    const now = performance.now();
    const anchor =
      zoomWrapAnchorRef.current ??
      releasedWrapPhase?.anchor ??
      (horizontalReleasedAtRef.current !== null &&
      (horizontalMotionRef.current.size > 0 ||
        now - horizontalReleasedAtRef.current < DISTAL_ROW_X_MORPH_MS + 100)
        ? horizontalAnchorRef.current
        : null);
    if (!anchor) {
      horizontalMotionRef.current.clear();
      horizontalTargetFrameRef.current = null;
      horizontalPaintedFrameRef.current = null;
      horizontalAnchorRef.current = null;
      return targetScreenLayout;
    }
    const targetFrame = captureWrapRowXFrame(targetScreenLayout, config, anchor);
    if (!targetFrame) return targetScreenLayout;
    horizontalAnchorRef.current = anchor;
    const previousTarget = horizontalTargetFrameRef.current;
    const previousPainted = horizontalPaintedFrameRef.current;
    const activeSlots = new Set<number>();
    const lines = targetScreenLayout.lines.map((row) => {
      const slot = row.lineIndex - targetFrame.anchorRowIndex;
      activeSlots.add(slot);
      const targetPose = targetFrame.rows.get(slot);
      if (!targetPose || slot === 0) {
        horizontalMotionRef.current.delete(slot);
        return row;
      }
      const oldTargetPose = previousTarget?.rows.get(slot);
      const oldPaintedPose = previousPainted?.rows.get(slot);
      if (
        oldPaintedPose &&
        (!sameWrapRowContent(oldPaintedPose, targetPose) ||
          oldPaintedPose.charWidth !== targetPose.charWidth)
      ) {
        horizontalMotionRef.current.delete(slot);
        return row;
      }
      const targetPair = oldTargetPose && sharedWrapRowXs(oldTargetPose, targetPose);
      const paintedPair = oldPaintedPose && sharedWrapRowXs(oldPaintedPose, targetPose);
      const priorMotion = horizontalMotionRef.current.get(slot);
      const targetStep = targetPair ? Math.abs(targetPair.targetX - targetPair.previousX) : 0;
      const targetChanged =
        !!oldTargetPose &&
        (oldTargetPose.start !== targetPose.start ||
          oldTargetPose.length !== targetPose.length ||
          oldTargetPose.offset !== targetPose.offset ||
          oldTargetPose.charWidth !== targetPose.charWidth ||
          oldTargetPose.marginLeft !== targetPose.marginLeft);
      const inputGeometryChanged =
        oldTargetPose &&
        (oldTargetPose.start !== targetPose.start ||
          oldTargetPose.length !== targetPose.length ||
          oldTargetPose.charWidth !== targetPose.charWidth ||
          oldTargetPose.marginLeft !== targetPose.marginLeft);
      if (targetChanged && paintedPair && priorMotion && !inputGeometryChanged) {
        const progress = priorMotion.presentedProgress;
        const paintedOffset = targetPose.offset + paintedPair.previousX - paintedPair.targetX;
        if (progress < 1)
          priorMotion.fromOffset = (paintedOffset - targetPose.offset * progress) / (1 - progress);
        priorMotion.targetOffset = targetPose.offset;
      } else if (
        targetChanged &&
        paintedPair &&
        (targetStep > DISTAL_ROW_X_STEP_PX || priorMotion)
      ) {
        const sourceDelta = paintedPair.previousX - paintedPair.targetX;
        const largeStep = targetStep > DISTAL_ROW_X_STEP_PX;
        const fromOffset = targetPose.offset + sourceDelta * (largeStep ? 0.9 : 1);
        if (slot === 6) {
          const perf = canvasTestWindow(window).__zoomPerf as
            | { horizontalRetargets?: Array<Record<string, number | boolean | null>> }
            | undefined;
          if (perf) {
            (perf.horizontalRetargets ??= []).push({
              t: now,
              targetStep,
              sourceDelta,
              oldTargetStart: oldTargetPose?.start ?? null,
              oldPaintedStart: oldPaintedPose?.start ?? null,
              targetStart: targetPose.start,
              oldPaintedOffset: oldPaintedPose?.offset ?? null,
              targetOffset: targetPose.offset,
              fromOffset,
              largeStep,
            });
          }
        }
        if (Math.abs(fromOffset - targetPose.offset) > 0.5) {
          horizontalMotionRef.current.set(slot, {
            id: ++horizontalMotionSeqRef.current,
            fromOffset,
            targetOffset: targetPose.offset,
            startedAt: null,
            durationMs: DISTAL_ROW_X_MORPH_MS,
            scene: targetScreenLayout,
            charWidth: config.charWidth,
            marginLeft: config.marginLeft,
            presentedProgress: 0,
          });
        } else {
          horizontalMotionRef.current.delete(slot);
        }
      }
      const motion = horizontalMotionRef.current.get(slot);
      if (!motion) return row;
      motion.scene = targetScreenLayout;
      const timedOffset = paintedWrapRowXOffset(
        0,
        1,
        motion.startedAt ?? now,
        now,
        motion.durationMs
      );
      const progress = Math.min(
        timedOffset,
        motion.presentedProgress + DISTAL_ROW_X_MAX_PROGRESS_PER_FRAME
      );
      const xOffset = motion.fromOffset + (motion.targetOffset - motion.fromOffset) * progress;
      if (motion.presentedProgress >= 1) horizontalMotionRef.current.delete(slot);
      return { ...row, xOffset };
    });
    for (const slot of horizontalMotionRef.current.keys()) {
      if (!activeSlots.has(slot)) horizontalMotionRef.current.delete(slot);
    }
    const painted = { ...targetScreenLayout, lines };
    horizontalTargetFrameRef.current = targetFrame;
    return painted;
  }, [targetScreenLayout, config, releasedWrapPhase, horizontalTick]);

  presentationAdvanceRef.current = (now) => {
    if (presentedLayoutRef.current === layout && pendingScreenTrackFrameRef.current) {
      screenTrackFrameRef.current = pendingScreenTrackFrameRef.current;
      pendingScreenTrackFrameRef.current = null;
    }

    if (presentedAtRef.current >= now) {
      requestPresentationFrame();
      return;
    }
    if (flushZoomFrameRef.current(now)) return;
    if (presentedLayoutRef.current !== layout || pendingZoomFrameRef.current()) return;
    if (trackForecastActive) {
      flushSync(() => setTrackForecastActive(false));
      return;
    }
    const horizontal = [...horizontalMotionRef.current.values()].some(
      (motion) => motion.startedAt !== null
    );
    const vertical = !!screenTrackMorph?.pending;
    if (!horizontal && !vertical && !releasedWrapPhase) return;
    flushSync(() => {
      if (horizontal) setHorizontalTick((tick) => tick + 1);
      if (vertical) setScreenTrackTick((tick) => tick + 1);
      if (releasedWrapPhase) {
        const anchor = releasedWrapPhase.anchor;
        setReleasedWrapPhase((current) =>
          current?.anchor === anchor
            ? current.phase <= 0.25
              ? null
              : { anchor, phase: current.phase - 0.25, direction: current.direction }
            : current
        );
      }
    });
  };

  const scrollDrawSequence = effectiveEditable
    ? editorState.sequence
    : (effectiveSequence?.sequence ?? sequence.sequence);
  const scrollPresentationOwnerRef = useRef<{
    request: SequenceScrollPresentation;
    drawSequence: string;
    source: typeof sequence;
    coordinateSpace: typeof coordinateSpace;
    status: 'pending' | 'retired' | 'presented';
  } | null>(null);
  useLayoutEffect(() => {
    const owner = scrollPresentationOwnerRef.current;
    if (!scrollPresentation) scrollPresentationOwnerRef.current = null;
    else if (owner?.request !== scrollPresentation) {
      scrollPresentationOwnerRef.current = {
        request: scrollPresentation,
        drawSequence: scrollDrawSequence,
        source: sequence,
        coordinateSpace,
        status: 'pending',
      };
    } else if (
      owner.source !== sequence ||
      owner.coordinateSpace !== coordinateSpace ||
      owner.drawSequence !== scrollDrawSequence
    ) {
      owner.status = 'retired';
    }
  }, [scrollPresentation, sequence, coordinateSpace, scrollDrawSequence]);
  useLayoutEffect(
    () => () => {
      scrollPresentationOwnerRef.current = null;
    },
    []
  );

  const scrollPaintContext = useMemo(
    () =>
      scrollPresentation
        ? {
            request: scrollPresentation,
            drawSequence: scrollDrawSequence,
            source: sequence,
            coordinateSpace,
            scene: targetScreenLayout,
            presented: layout,
            primers,
            bioToColMap: remap.bioToColMap,
          }
        : null,
    [
      scrollPresentation,
      scrollDrawSequence,
      sequence,
      coordinateSpace,
      targetScreenLayout,
      layout,
      primers,
      remap.bioToColMap,
    ]
  );
  const scrollPaintContextRef = useRef<typeof scrollPaintContext | null>(null);
  useLayoutEffect(() => {
    scrollPaintContextRef.current = scrollPaintContext;
    return () => {
      if (scrollPaintContextRef.current === scrollPaintContext)
        scrollPaintContextRef.current = null;
    };
  }, [scrollPaintContext]);
  const onViewportPresented = useMemo(() => {
    if (!scrollPaintContext) return undefined;
    const request = scrollPaintContext.request;
    return (frame: SequenceViewportPresentation) => {
      const owner = scrollPresentationOwnerRef.current;
      const element = containerRef.current;
      const viewport = frame.viewport;

      if (
        !owner ||
        owner.request !== request ||
        owner.status !== 'pending' ||
        scrollPaintContextRef.current !== scrollPaintContext ||
        frame.sequence !== scrollPaintContext.drawSequence ||
        frame.scene !== scrollPaintContext.scene ||
        frame.presented !== scrollPaintContext.presented ||
        viewport.scrollTop !== viewport.domScrollTop ||
        viewport.height <= 0 ||
        !viewport.visible ||
        !element?.isConnected ||
        document.visibilityState !== 'visible' ||
        getComputedStyle(element).visibility === 'hidden' ||
        viewport.domScrollTop !== element.scrollTop ||
        viewport.scrollLeft !== element.scrollLeft ||
        viewport.width !== element.clientWidth ||
        viewport.visibleHeight !== element.clientHeight ||
        viewport.width <= 0 ||
        viewport.visibleHeight <= 0 ||
        viewport.canvasWidth <= 0 ||
        viewport.canvasHeight <= 0
      )
        return;
      const position = scrollPaintContext.bioToColMap
        ? scrollPaintContext.bioToColMap.get(request.position)
        : request.position - 1;
      const length = frame.presented.sequenceLength ?? frame.presented.summary?.seqLength ?? 0;
      if (
        position === undefined ||
        !Number.isInteger(position) ||
        position < 0 ||
        position >= length
      )
        return;
      const visibleWidth = Math.min(viewport.width, viewport.canvasWidth);
      const visibleHeight = Math.min(
        viewport.height,
        viewport.visibleHeight,
        viewport.canvasHeight
      );
      const config = frame.config;
      for (const line of frame.presented.lines) {
        const column = (((position - line.startPos) % length) + length) % length;
        if (column >= line.sequence.length) continue;
        const left = config.marginLeft + (line.xOffset ?? 0) + column * config.charWidth;
        const right = left + config.charWidth;
        if (
          getPositionFromX((left + right) / 2, line, config, length) !== position ||
          left < viewport.scrollLeft ||
          right > viewport.scrollLeft + visibleWidth ||
          right <= left
        )
          continue;
        const tracks = calculateLineTrackBounds(
          line,
          config,
          config.showReverseComplement,
          (line.forwardPrimerLaneCount ?? 0) > 0,
          (line.reversePrimerLaneCount ?? 0) > 0
        );
        const top = rowPaintY(line, line.y + tracks.sequenceY);

        const bottom = rowPaintY(line, line.y + tracks.sequenceY + tracks.sequenceHeight);
        if (
          top < viewport.scrollTop ||
          bottom > viewport.scrollTop + visibleHeight ||
          bottom <= top
        )
          continue;
        owner.status = 'presented';
        request.presented();
        return;
      }
    };
  }, [scrollPaintContext]);

  const onPaintLayoutPresented = useCallback(
    (
      scene: LayoutSnapshot2D,
      presented: LayoutSnapshot2D,
      paintedAt: number,
      paintConfig: WorkspaceEditorConfig
    ) => {
      presentedLayoutRef.current = presented;
      presentedAtRef.current = paintedAt;
      const anchor = horizontalAnchorRef.current;
      if (anchor)
        horizontalPaintedFrameRef.current = captureWrapRowXFrame(presented, paintConfig, anchor);
      const targetFrame = horizontalTargetFrameRef.current;
      for (const [slot, motion] of horizontalMotionRef.current) {
        const rowIndex = targetFrame === null ? null : targetFrame.anchorRowIndex + slot;
        const matchingScene =
          paintConfig.charWidth === motion.charWidth &&
          paintConfig.marginLeft === motion.marginLeft &&
          (motion.scene === scene ||
            (rowIndex !== null &&
              motion.scene.summary?.cpr === scene.summary?.cpr &&
              motion.scene.summary?.topBp === scene.summary?.topBp &&
              (() => {
                const currentRow = motion.scene.lines.find((line) => line.lineIndex === rowIndex);
                const paintedRow = scene.lines.find((line) => line.lineIndex === rowIndex);
                return (
                  !!currentRow &&
                  !!paintedRow &&
                  currentRow.startPos === paintedRow.startPos &&
                  currentRow.endPos === paintedRow.endPos
                );
              })()));
        if (!matchingScene) continue;
        const row = targetFrame
          ? presented.lines.find((line) => line.lineIndex - targetFrame.anchorRowIndex === slot)
          : undefined;
        if (row && Math.abs(motion.targetOffset - motion.fromOffset) > 0.001) {
          const progress =
            ((row.xOffset ?? 0) - motion.fromOffset) / (motion.targetOffset - motion.fromOffset);
          motion.presentedProgress = Math.max(
            motion.presentedProgress,
            Math.min(1, Math.max(0, progress))
          );
          const perf = canvasTestWindow(window).__zoomPerf as
            | {
                horizontalPaints?: Array<{ t: number; id: number; slot: number; progress: number }>;
              }
            | undefined;
          if (perf) {
            (perf.horizontalPaints ??= []).push({
              t: paintedAt,
              id: motion.id,
              slot,
              progress: motion.presentedProgress,
            });
          }
        }
        if (motion.startedAt === null) {
          motion.startedAt = paintedAt;
        }
      }
      requestPresentationFrame();
    },
    [requestPresentationFrame]
  );

  useLayoutEffect(() => {
    if (horizontalMotionRef.current.size || screenTrackMorph?.pending || releasedWrapPhase)
      requestPresentationFrame();
  }, [layout, screenTrackMorph, releasedWrapPhase, requestPresentationFrame]);

  const oldLayout = layoutRef.current;
  const morphContainer = containerRef.current;
  const idleMorphPoint =
    screenTrackMorph && !zoomInFlightRef.current && oldLayout && morphContainer
      ? (() => {
          const released = releasedZoomAnchorRef.current;
          if (released) {
            if (Math.abs(morphContainer.scrollTop - released.lastScrollTop) <= 1) return released;
            releasedZoomAnchorRef.current = null;
          }
          const rect = morphContainer.getBoundingClientRect();
          const x = rect.left + morphContainer.clientWidth / 2,
            y = rect.top + morphContainer.clientHeight / 2;
          const oldConfig = previousTrackConfigRef.current ?? config;
          const bp = bpAtCursorForZoom(oldLayout, oldConfig, morphContainer, x, y);
          return bp === null
            ? null
            : {
                bp,
                viewportY: y - rect.top,
                placement: captureZoomAnchorRowPlacement(
                  bp,
                  morphContainer.scrollTop + y - rect.top,
                  oldLayout,
                  oldConfig
                ),
              };
        })()
      : null;
  useLayoutEffect(() => {
    previousTrackConfigRef.current = config;
    if (!screenTrackMorph) return;
    pendingScreenTrackFrameRef.current = screenTrackMorph.frame;
    requestPresentationFrame();
    if (idleMorphPoint && morphContainer && !zoomInFlightRef.current) {
      const y = zoomAnchorContentY(idleMorphPoint.bp, idleMorphPoint.placement, layout, config);
      const perf = canvasTestWindow(window).__zoomPerf;
      if (perf) {
        (perf.releasedAnchors ??= []).push({
          t: performance.now(),
          phase: releasedWrapPhase?.phase ?? null,
          bp: idleMorphPoint.bp,
          y,
          scrollTop: morphContainer.scrollTop,
          viewportY: idleMorphPoint.viewportY,
          pending: screenTrackMorph.pending,
        });
      }
      if (
        y !== null &&
        Math.abs(morphContainer.scrollTop - (y - idleMorphPoint.viewportY)) >= 0.5
      ) {
        morphContainer.scrollTop = Math.max(0, y - idleMorphPoint.viewportY);
      }
      if (releasedZoomAnchorRef.current === idleMorphPoint)
        releasedZoomAnchorRef.current.lastScrollTop = morphContainer.scrollTop;
    }
    if (!screenTrackMorph.pending) {
      if (!releasedWrapPhase) releasedZoomAnchorRef.current = null;
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenTrackMorph, config, requestPresentationFrame]);

  useLayoutEffect(() => {
    if (freezeViewportHeight) {
      const anchor = frozenScrollAnchorRef.current;
      if (anchor && anchor.topBp == null) {
        const scrollTop = containerRef.current?.scrollTop ?? anchor.scrollTop;
        anchor.scrollTop = scrollTop;
        anchor.topBp = getSequencePositionAtScrollY(scrollTop, layoutRef.current);
        anchor.layoutTotalHeight = layoutRef.current?.totalHeight ?? 0;
      }
      const container = containerRef.current;
      if (container && anchor && Math.abs(container.scrollTop - anchor.scrollTop) > 0.5) {
        container.scrollTop = anchor.scrollTop;
      }
      return;
    }

    const anchor = frozenScrollAnchorRef.current;
    if (!anchor) return;
    frozenScrollAnchorRef.current = null;
    const container = containerRef.current;
    if (!container) return;

    let nextScrollTop = anchor.scrollTop;
    const prevTotal = anchor.layoutTotalHeight;
    const nextTotal = layoutRef.current?.totalHeight ?? 0;
    const layoutGeometryChanged =
      prevTotal > 0 && nextTotal > 0 && Math.abs(nextTotal - prevTotal) > 1;
    if (layoutGeometryChanged && anchor.topBp != null && layoutRef.current) {
      const restored = getScrollYForSequencePosition(anchor.topBp, layoutRef.current, false);
      if (typeof restored === 'number' && Number.isFinite(restored)) {
        nextScrollTop = restored;
      }
    }
    if (Math.abs(container.scrollTop - nextScrollTop) > 0.5) {
      container.scrollTop = nextScrollTop;
    }
    viewportRef.current = { ...viewportRef.current, scrollTop: container.scrollTop };
    setViewport((prev) =>
      Math.abs(prev.scrollTop - container.scrollTop) <= 0.5
        ? prev
        : { ...prev, scrollTop: container.scrollTop }
    );
    canvasScrollDrawRef.current?.(container.scrollTop, viewportRef.current.height);
  }, [freezeViewportHeight, layout, viewportRef]);

  const scrollCoordinator = useScrollCoordinator({
    containerRef,
    layout,
    getAnchorY: (position, currentLayout) =>
      getSequenceBandY(position, currentLayout, { config, primers }),
  });

  const isCircular = effectiveSequence?.circular === true;
  const sequenceContentHeight =
    targetLayout?.realRowsStartY !== undefined && targetLayout?.bottomBufferStartY !== undefined
      ? Math.max(0, targetLayout.bottomBufferStartY - targetLayout.realRowsStartY)
      : (targetLayout?.totalHeight ?? 0);

  const canvasFitFloorScope = useMemo(
    () => ({}),
    [
      effectiveSequence?.id,
      effectiveSequence?.sequence,
      effectiveSequence?.annotations,
      isCircular,
      containerWidth,
      renderViewport.height,
    ]
  );
  const canvasFitFloorRef = useRef<{ scope: object; zoom: number | null }>({
    scope: canvasFitFloorScope,
    zoom: null,
  });
  const retainedFitFloor =
    canvasFitFloorRef.current.scope === canvasFitFloorScope ? canvasFitFloorRef.current.zoom : null;
  const observedZoom = zoomLevel ?? 100;
  const observedFitFloor =
    isCircular &&
    sequenceContentHeight > 0 &&
    renderViewport.height > 0 &&
    sequenceContentHeight < renderViewport.height &&
    Number.isFinite(observedZoom) &&
    observedZoom > 0
      ? clampZoom(observedZoom)
      : null;
  const nextFitFloor = retainedFitFloor ?? observedFitFloor;
  const canvasFitOnceMinZoom = isCircular ? (nextFitFloor ?? MIN_ZOOM) : MIN_ZOOM;

  useLayoutEffect(() => {
    canvasFitFloorRef.current = { scope: canvasFitFloorScope, zoom: nextFitFloor };
  }, [canvasFitFloorScope, nextFitFloor]);

  useLayoutEffect(() => {
    onMinZoomChange?.(canvasFitOnceMinZoom);
  }, [canvasFitOnceMinZoom, onMinZoomChange]);

  useLayoutEffect(() => {
    if (zoomLevel == null) return;
    if (sequenceContentHeight >= renderViewport.height && renderViewport.height > 0) return;
    if (zoomLevel >= canvasFitOnceMinZoom - 0.001) return;
    if (zoomInFlightRef.current && anchoredFloorZoomToRef.current?.(canvasFitOnceMinZoom)) return;
    onZoomLevelChange?.(canvasFitOnceMinZoom);
  }, [
    canvasFitOnceMinZoom,
    onZoomLevelChange,
    zoomLevel,
    sequenceContentHeight,
    renderViewport.height,
  ]);

  const scrollEnd = linearScrollEndGeometry(layout, renderViewport.height);

  const newZoomController = useZoomController({
    browserWheelGestureOwnership,
    zoomLevel: zoomLevel ?? 100,
    topBp: effectiveSequence?.circular ? circularOffset + bpOffset : bpOffset,
    circularOffset,
    setZoomState: ({
      zoomLevel: nextZoom,
      topBp: nextTopBp,
      circularOffset: nextCircularOffset,
    }) => {
      if (nextCircularOffset !== undefined) setCircularOffset(nextCircularOffset);
      setBpOffset(
        effectiveSequence?.circular ? nextTopBp - (nextCircularOffset ?? circularOffset) : nextTopBp
      );
      onZoomLevelChange?.(nextZoom);
    },
    onGestureStateChange: (isZooming: boolean) => {
      zoomInFlightRef.current = isZooming;
      scrollCoordinator.setZooming(isZooming);
      if (!isZooming) {
        horizontalReleasedAtRef.current = performance.now();
        const anchor = zoomWrapAnchorRef.current;
        const container = containerRef.current;
        const currentLayout = layoutRef.current;
        const seqLen = effectiveSequence?.sequence.length ?? 0;
        if (anchor && container && currentLayout) {
          const bp =
            effectiveSequence?.circular && seqLen > 0
              ? ((anchor.unwrappedBp % seqLen) + seqLen) % seqLen
              : anchor.unwrappedBp;
          releasedZoomAnchorRef.current = {
            bp,
            viewportY: anchor.viewportY,
            placement: captureZoomAnchorRowPlacement(
              bp,
              container.scrollTop + anchor.viewportY,
              currentLayout,
              config
            ),
            lastScrollTop: container.scrollTop,
          };
        }
        if (anchor)
          setReleasedWrapPhase({
            anchor,
            phase: 1,
            direction: previewZoomDirectionRef.current,
          });
        zoomWrapAnchorRef.current = null;
        setPreviewTargetZoom(null);
      } else {
        horizontalReleasedAtRef.current = null;
        setReleasedWrapPhase(null);
        releasedZoomAnchorRef.current = null;
        pendingScrollTargetRef.current = null;
      }
      setZoomGestureEpoch((epoch) => epoch + 1);
    },
    onWrapAnchor: (anchor) => {
      if (zoomWrapAnchorRef.current === null && layoutRef.current?.summary) {
        horizontalMotionRef.current.clear();
        horizontalTargetFrameRef.current = captureWrapRowXFrame(layoutRef.current, config, anchor);
        horizontalPaintedFrameRef.current = horizontalTargetFrameRef.current;
        horizontalAnchorRef.current = anchor;
        if (presentationFrameRafRef.current !== null)
          cancelAnimationFrame(presentationFrameRafRef.current);
        presentationFrameRafRef.current = null;
        pendingScreenTrackFrameRef.current = null;
        screenTrackFrameRef.current = captureScreenTracks(
          layoutRef.current,
          config,
          anchor.unwrappedBp,
          performance.now()
        );
      }
      zoomWrapAnchorRef.current = anchor;
    },
    onPreviewZoomTarget: (zoom, direction) => {
      previewZoomDirectionRef.current = direction;
      setPreviewTargetZoom({ zoom, direction });
      setTrackForecastActive(true);
    },
    seqLength: effectiveSequence?.sequence?.length ?? 0,
    isCircular: effectiveSequence?.circular ?? false,
    baseConfig: {
      baseCharWidth: DEFAULT_EDITOR_CONFIG.charWidth,
      baseRowHeight: DEFAULT_EDITOR_CONFIG.rowHeight,
      marginLeft: DEFAULT_EDITOR_CONFIG.marginLeft,
    },
    containerWidth,
    containerRef,
    zoomTargetRef,
    zoomSensitivityPxPerPoint: WRAP_ZOOM_SENSITIVITY,
    continuous: true,
    requestFrame: requestPresentationFrame,
    onScrollBoundaryOffset: (additionalSpace, edge) => {
      if (edge === 'end') {
        const viewportHeight = containerRef.current?.clientHeight ?? renderViewport.height;
        setScrollEndAnchorHeadroom(
          (current) =>
            Math.max(current, viewportHeight - layout.totalHeight - scrollEnd.headroom) +
            additionalSpace
        );
      } else
        setViewportOriginOffset((current) =>
          Math.max(current, (layout.viewportOriginOffset ?? 0) + additionalSpace)
        );
    },
    scrollEndHeadroom: scrollEndAnchorHeadroom,
    minZoom: canvasFitOnceMinZoom,
    layout,
    config,
  });
  pendingZoomFrameRef.current = newZoomController.hasPendingCommit;
  flushZoomFrameRef.current = newZoomController.flushFrame;
  anchoredZoomToRef.current = newZoomController.zoomTo;
  anchoredFloorZoomToRef.current = newZoomController.correctZoomFloor;
  useLayoutEffect(() => {
    newZoomController.cancelGesture();
    setTrackForecastActive(false);
    setViewportOriginOffset(0);
    setScrollEndAnchorHeadroom(0);
    horizontalMotionRef.current.clear();
    horizontalTargetFrameRef.current = null;
    horizontalPaintedFrameRef.current = null;
    horizontalAnchorRef.current = null;
    horizontalReleasedAtRef.current = null;
    if (presentationFrameRafRef.current !== null)
      cancelAnimationFrame(presentationFrameRafRef.current);
    presentationFrameRafRef.current = null;
    pendingScreenTrackFrameRef.current = null;
    screenTrackFrameRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSequence?.id]);

  useEffect(() => {
    const container = scrollContainerElement;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      newZoomController.onWheel(event);
      if (!(event.ctrlKey || event.metaKey) && !event.defaultPrevented)
        releasedZoomAnchorRef.current = null;
    };
    container.addEventListener('wheel', onWheel, { passive: false, capture: true });
    const disposeZoomTarget = registerWheelZoomTarget(container, (event) => {
      cancelAnimatedScrollRef.current?.();
      onWheel(event);
    });
    return () => {
      disposeZoomTarget();
      container.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [scrollContainerElement, newZoomController.onWheel]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const w = canvasTestWindow(window);
    const isDev = import.meta.env.DEV === true;
    const optIn = w.__enableDiag === true;
    const exposeForTests = w.__webglExposeForTests === true;
    const testBridgeEnabled = typeof w.__test === 'object' && w.__test !== null;
    if (!(isDev || optIn || exposeForTests || testBridgeEnabled)) return;
    const searchParams = new URLSearchParams(window.location.search);
    const shouldPublishContentReport =
      optIn ||
      exposeForTests ||
      testBridgeEnabled ||
      searchParams.has('harness') ||
      searchParams.get('e2e') === 'true';
    if (layout && shouldPublishContentReport) {
      let annotationLineCount = 0;
      let cdsLineCount = 0;
      let forwardOrfLineCount = 0;
      let reverseOrfLineCount = 0;
      let complementLineCount = 0;
      let totalAnnotations = 0;
      let totalCdsLanes = 0;
      let totalDraftAnnotations = 0;
      let totalDraftCds = 0;
      let totalForwardOrfs = 0;
      let totalReverseOrfs = 0;
      for (const line of layout.lines) {
        if (line.annotations.length > 0) annotationLineCount++;
        if ((line.classifiedCDSs?.length ?? 0) > 0) cdsLineCount++;
        if ((line.forwardOrfs?.length ?? 0) > 0) forwardOrfLineCount++;
        if ((line.reverseOrfs?.length ?? 0) > 0) reverseOrfLineCount++;
        if (line.complementSequence.length > 0) complementLineCount++;
        totalAnnotations += line.annotations.length;
        totalCdsLanes += line.translationLaneCount ?? 0;
        totalDraftAnnotations += line.annotations.filter(isDraftContentEntry).length;
        totalDraftCds += (line.classifiedCDSs ?? []).filter(isDraftContentEntry).length;
        totalForwardOrfs += line.forwardOrfs?.length ?? 0;
        totalReverseOrfs += line.reverseOrfs?.length ?? 0;
      }
      w.__canvasContentReport = {
        totalLines: layout.lines.length,
        annotationLineCount,
        cdsLineCount,
        forwardOrfLineCount,
        reverseOrfLineCount,
        complementLineCount,
        totalAnnotations,
        totalCdsLanes,
        totalDraftAnnotations,
        totalDraftCds,
        totalForwardOrfs,
        totalReverseOrfs,
        sequenceLength: layout.sequenceLength ?? 0,
        isCircular: layout.isCircular ?? false,
        lodLevel: config.overviewLod ? 'density' : (config.lodLevel ?? 'detail'),
        overviewLod: config.overviewLod === true,
        zoomLevel: typeof zoomLevel === 'number' ? zoomLevel : null,
        virtualRowCount,
        circularBufferViewportHeight:
          typeof circularBufferViewportHeight === 'number' && circularBufferViewportHeight > 0
            ? Math.max(circularBufferViewportHeight, viewportRef.current.height)
            : viewportRef.current.height,
        layoutVersion:
          typeof w.__layoutRecomputeCount === 'number' ? w.__layoutRecomputeCount : null,
      };
    }

    w.__harnessAnchor = {
      bpAt: (clientX: number, clientY: number) =>
        bpAtCursor(layout ?? null, config ?? null, containerRef.current, clientX, clientY),
      zoomBpAt: (clientX: number, clientY: number) =>
        bpAtCursorForZoom(layout ?? null, config ?? null, containerRef.current, clientX, clientY),
      rowTopForBp: (bp: number) => rowTopForBp(layout ?? null, bp),
      startSampling: (cx: number, cy: number) => {
        const prior = w.__harnessSampler;
        if (prior) {
          prior.stopped = true;
          if (prior.rafId) cancelAnimationFrame(prior.rafId);
        }
        const samples: Array<{ t: number; bp: number | null }> = [];
        const t0 = performance.now();
        const st = { samples, stopped: false, rafId: 0 };
        w.__harnessSampler = st;
        const tick = () => {
          if (st.stopped) return;
          const live = w.__harnessAnchor;
          const bp =
            live?.bpAt?.(cx, cy) ??
            bpAtCursor(layout ?? null, config ?? null, containerRef.current, cx, cy);
          samples.push({ t: performance.now() - t0, bp });
          st.rafId = requestAnimationFrame(tick);
        };
        st.rafId = requestAnimationFrame(tick);
      },
      stopSampling: () => {
        const st = w.__harnessSampler;
        if (!st) return [];
        st.stopped = true;
        if (st.rafId) cancelAnimationFrame(st.rafId);
        w.__harnessSampler = null;
        return st.samples;
      },
    };
    w.__sequenceViewerDiagnostics = {
      frameState: () => {
        const vp = viewportRef.current;
        const visibleIndices = new Set(
          layout.lines
            .filter(
              (row) =>
                row.y + (layout.summary?.rowHeights[row.lineIndex] ?? row.naturalHeight ?? 0) >=
                  vp.scrollTop - 100 && row.y <= vp.scrollTop + vp.height + 100
            )
            .map((row) => row.lineIndex)
        );
        const compactLayout = (snapshot: LayoutSnapshot2D | null) =>
          snapshot && {
            totalHeight: snapshot.totalHeight,
            cpr: snapshot.summary?.cpr,
            topBp: snapshot.summary?.topBp,
            preparedIndices: snapshot.lines.map((row) => row.lineIndex),
            rows: snapshot.lines
              .filter((row) => visibleIndices.has(row.lineIndex))
              .map((row) => ({
                index: row.lineIndex,
                start: row.startPos,
                end: row.endPos,
                sequenceLength: row.sequence.length,
                y: row.y,
                height: snapshot.summary?.rowHeights[row.lineIndex],
                nextY: snapshot.summary?.rowYOffsets[row.lineIndex + 1],
                xOffset: row.xOffset ?? 0,
                stripeInset: row.stripeInsetPx,
                stripeTopOffset: row.stripeTopOffsetPx,
                trackMorph: row.trackMorph,
                annotations: row.annotations.map(
                  ({ name, type, start, end, direction, lane, segments }) => ({
                    name,
                    type,
                    start,
                    end,
                    direction,
                    lane,
                    segments,
                  })
                ),
                cds: row.classifiedCDSs?.map(
                  ({ name, start, end, direction, translationLane, segments }) => ({
                    name,
                    start,
                    end,
                    direction,
                    translationLane,
                    segments,
                  })
                ),
                forwardOrfs: row.forwardOrfs,
                reverseOrfs: row.reverseOrfs,
                lanes: {
                  annotations: row.annotationLaneCount,
                  translation: row.translationLaneCount,
                  forwardPrimers: row.forwardPrimerLaneCount,
                  reversePrimers: row.reversePrimerLaneCount,
                  forwardOrfs: row.forwardOrfLaneCount,
                  reverseOrfs: row.reverseOrfLaneCount,
                },
              })),
          };
        const compactTracks = (frame: ScreenTrackFrame | null) =>
          frame && {
            ...frame,
            bands: [...frame.bands],
            targets: [...frame.targets],
            gaps: [...frame.gaps],
            stripes: [...frame.stripes],
            stripeTopOffsets: [...frame.stripeTopOffsets],
          };
        return {
          zoomLevel,
          previewTargetZoom,
          bpOffset,
          circularOffset,
          domScrollTop: containerRef.current?.scrollTop,
          viewportRef: viewportRef.current,
          reactViewport: viewport,
          renderViewport,
          zooming: zoomInFlightRef.current,
          pendingZoomCommit: pendingZoomFrameRef.current(),
          requestedFrame: presentationFrameRafRef.current,
          paintedAt: presentedAtRef.current,
          ackMatchesDisplayedLayout: presentedLayoutRef.current === layout,
          zoomAnchor: zoomWrapAnchorRef.current,
          releasedZoomAnchor: releasedZoomAnchorRef.current,
          releasedWrapPhase,
          motions: [...horizontalMotionRef.current].map(([slot, { scene, ...motion }]) => ({
            slot,
            ...motion,
            sceneCpr: scene.summary?.cpr,
            sceneTopBp: scene.summary?.topBp,
          })),
          tracks: compactTracks(screenTrackFrameRef.current),
          pendingTracks: compactTracks(pendingScreenTrackFrameRef.current),
          target: compactLayout(targetLayout),
          scene: compactLayout(targetScreenLayout),
          displayed: compactLayout(layout),
          acknowledged: compactLayout(presentedLayoutRef.current),
          primers,
          cutSites,
          orfs: effectiveOrfs,
        };
      },
      annotationGeometry: () =>
        layout.lines.flatMap((line) => {
          const scroll = containerRef.current;
          if (
            scroll &&
            (line.y + (layout.summary?.rowHeights[line.lineIndex] ?? line.naturalHeight ?? 0) <
              scroll.scrollTop - 100 ||
              line.y > scroll.scrollTop + scroll.clientHeight + 100)
          )
            return [];
          const candidates =
            line.annotations.length <= 12
              ? line.annotations
              : [...line.annotations.slice(0, 6), ...line.annotations.slice(-6)];
          return candidates.flatMap((annotation) => {
            if (annotation.start > annotation.end || annotation.segments?.length) return [];
            const visibleStart = Math.max(annotation.start - 1, line.startPos);
            const visibleEnd = Math.min(annotation.end, line.endPos);
            if (visibleEnd <= visibleStart) return [];
            const xStart =
              config.marginLeft +
              (line.xOffset ?? 0) +
              (visibleStart - line.startPos) * config.charWidth;
            const xEnd = xStart + (visibleEnd - visibleStart) * config.charWidth;
            const paintedShape = rowPaintBounds(
              line,
              line.y +
                annotation.lane *
                  (ANNOTATION_BAR_HEIGHT + ANNOTATION_CANVAS_CONSTANTS.LANE_SPACING),
              ANNOTATION_BAR_HEIGHT
            );
            return [
              {
                key: `${annotation.type}:${annotation.name}:${annotation.start}:${annotation.end}:${annotation.direction}`,
                lineIndex: line.lineIndex,
                visibleStart,
                visibleEnd,
                xStart,
                xEnd,
                xCenter: (xStart + xEnd) / 2,
                name: annotation.name,
                type: annotation.type,
                direction: annotation.direction ?? 1,
                yStart: paintedShape.y,
                yEnd: paintedShape.y + paintedShape.height,
                height: paintedShape.height,
              },
            ];
          });
        }),
      visiblePaintedBandMidpoint,
      layoutGeometry: () => ({
        config,
        summary: layout.summary,
        rows: layout.lines.map((line) => {
          const {
            sequence: _sequence,
            complementSequence: _complementSequence,
            annotations: _annotations,
            classifiedCDSs,
            forwardOrfs: _forwardOrfs,
            reverseOrfs: _reverseOrfs,
            ...geometry
          } = line;
          const { line: _line, ...tracks } = computeLineTrackPositions(line, config);
          return {
            ...geometry,
            tracks,
            paintedBackground: paintedRowBackgroundBounds({ ...tracks, line }),
            paintedBands:
              line.trackMorph?.painted ??
              lineTrackBoundaries(line, config).map((y) => y * (line.heightScale ?? 1)),
            paintedTracks: Object.fromEntries(
              Object.entries(tracks)
                .filter(([key, value]) => typeof value === 'number' && key.endsWith('Y'))
                .map(([key, value]) => [key, rowPaintY(line, value as number)])
            ),
            paintedSequenceHeight: rowPaintBounds(
              line,
              tracks.sequenceY,
              config.overviewLod || config.lodLevel === 'density'
                ? Math.max(1, Math.ceil(config.rowHeight))
                : config.rowHeight
            ).height,
            cds: (classifiedCDSs ?? []).map(
              ({
                name,
                start,
                end,
                direction,
                translationLane,
                _exonPillBounds,
                _cdsPillBounds,
                _cdsLineBounds,
                _intronPillBounds,
                _paintedPresentation,
                _interactionOutlineContours,
              }) => ({
                name,
                start,
                end,
                direction,
                translationLane,
                labelY: rowPaintY(
                  line,
                  _paintedPresentation
                    ? _paintedPresentation.labelY + 7
                    : tracks.translationY +
                        (translationLane ?? 0) *
                          calculateCdsHeight(
                            1,
                            0,
                            true,
                            config.rowHeight,
                            config.showResidueNumbers,
                            1,
                            config.cdsZoomPresentation?.aaHeight
                          ) +
                        7
                ),
                ...projectedCdsDiagnostics(line, {
                  _paintedPresentation,
                  _interactionOutlineContours,
                  _cdsPillBounds,
                  _cdsLineBounds,
                  _exonPillBounds,
                  _intronPillBounds,
                }),
              })
            ),
          };
        }),
      }),
      canvasGeometry: () => ({
        charWidth: config.charWidth,
        marginLeft: config.marginLeft,
      }),
      assemblyDisplay: () => ({
        sequence: effectiveSequence?.sequence,
        strandOverrides: effectiveSequence?.strandOverrides,
        annotations: effectiveSequence?.annotations,
        primers,
        rulerSegments,
        lines: layout?.lines.map((line) => ({
          start: line.startPos,
          end: line.endPos,
          sequence: line.sequence,
          complementSequence: line.complementSequence,
        })),
      }),
      viewportAnchor: () => {
        const vp = viewportRef.current;
        return {
          scrollTop: vp.scrollTop,
          zooming: zoomInFlightRef.current,
          presentationFrameScheduled: presentationFrameRafRef.current !== null,
          paintedAt: presentedAtRef.current,
          ackMatchesDisplayedLayout: presentedLayoutRef.current === layout,
          presentationPending:
            releasedWrapPhase !== null ||
            !!screenTrackMorph?.pending ||
            [...horizontalMotionRef.current.values()].some(
              (motion) => motion.presentedProgress < 1
            ) ||
            presentedLayoutRef.current !== layout,
          height: vp.height,
          topBp: getSequencePositionAtScrollY(vp.scrollTop, layout ?? null),
          centerBp: getSequencePositionAtScrollY(
            vp.scrollTop + Math.max(0, vp.height) / 2,
            layout ?? null
          ),
          virtualRowCount,
          circularBufferViewportHeight:
            typeof circularBufferViewportHeight === 'number' && circularBufferViewportHeight > 0
              ? Math.max(circularBufferViewportHeight, vp.height)
              : vp.height,
          layoutVersion:
            typeof w.__layoutRecomputeCount === 'number' ? w.__layoutRecomputeCount : null,
          coordinateMode: coordinateSpace?.mode ?? null,
        };
      },
      scrollToBiologicalPosition: (
        position: number,
        options?: ScrollToBiologicalPositionOptions
      ) => {
        scrollToBiologicalPositionRef.current?.(position, options);
      },
      annotationClickTarget: () => {
        const currentLayout = layoutRef.current ?? layout;
        const vp = viewportRef.current;
        const canvasWidth = containerRef.current?.clientWidth ?? 0;
        if (!currentLayout?.lines.length || !config.showAnnotations) return null;

        const laneSpacing = ANNOTATION_BAR_HEIGHT + ANNOTATION_CANVAS_CONSTANTS.LANE_SPACING;
        for (const line of currentLayout.lines) {
          if (line.annotations.length === 0) continue;
          for (const annotation of line.annotations) {
            if (annotation.start > annotation.end) continue;

            const annStart = annotation.start - 1;
            const annEnd = annotation.end - 1;
            const visibleStart = Math.max(annStart, line.startPos);
            const visibleEnd = Math.min(annEnd, line.endPos - 1);
            if (visibleEnd < visibleStart) continue;

            const barX =
              config.marginLeft +
              (line.xOffset ?? 0) +
              (visibleStart - line.startPos) * config.charWidth;
            const barWidth = (visibleEnd - visibleStart + 1) * config.charWidth;
            if (barWidth < 8) continue;

            const bounds = calculateLineTrackBounds(
              line,
              config,
              config.showReverseComplement,
              false,
              false
            );
            const contentY =
              line.y +
              bounds.annotationY +
              annotation.lane * laneSpacing +
              ANNOTATION_BAR_HEIGHT / 2;
            const y = contentY - vp.scrollTop;
            const x = barX + Math.min(Math.max(barWidth / 2, 4), Math.max(4, barWidth - 2));
            if (y < 0 || y > vp.height || x < 0 || (canvasWidth > 0 && x > canvasWidth)) continue;

            return {
              x,
              y,
              annotation: {
                type: annotation.type,
                name: annotation.name,
                start: annotation.start,
                end: annotation.end,
                direction: annotation.direction,
              },
            };
          }
        }
        return null;
      },
      hitTargetAt: (clientX: number, clientY: number) => {
        const currentLayout = layoutRef.current ?? layout;
        const canvas = containerRef.current?.querySelector<HTMLCanvasElement>(
          'canvas[data-testid="sequence-canvas-interactive"]'
        );
        if (!currentLayout?.lines.length || !canvas) return null;
        const point = canvasPointFromClient(clientX, clientY, canvas.getBoundingClientRect());
        return getHitTarget(
          point.x,
          point.y,
          viewportRef.current.scrollTop,
          currentLayout.lines,
          currentLayout.totalHeight,
          config,
          currentLayout.sequenceLength ?? editorState.sequence.length,
          null,
          config.showReverseComplement,
          EMPTY_PRIMERS
        );
      },
    };
    return () => {
      if (w.__harnessAnchor && !w.__harnessSampler) {
        delete w.__harnessAnchor;
      }
      if (w.__sequenceViewerDiagnostics?.viewportAnchor) {
        delete w.__sequenceViewerDiagnostics;
      }
    };
  }, [
    layout,
    config,
    virtualRowCount,
    circularBufferViewportHeight,
    effectiveSequence,
    primers,
    rulerSegments,
  ]);

  const realContentHeight = useMemo(() => {
    if (!layout.lines.length) return layout.totalHeight;

    if (layout.realRowsStartY !== undefined && layout.bottomBufferStartY !== undefined) {
      return layout.bottomBufferStartY - layout.realRowsStartY;
    }

    const firstVirtualRowIndex = layout.lines.findIndex((line) => line.isBottomBuffer);
    if (firstVirtualRowIndex === -1) return layout.totalHeight;
    return layout.lines[firstVirtualRowIndex].y;
  }, [layout]);

  totalHeightRef.current = realContentHeight;
  layoutRef.current = layout;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const clientHeight = container?.clientHeight ?? 0;
    const clientWidth = container?.clientWidth ?? 0;
    const scrollHeight = container?.scrollHeight ?? layout.totalHeight;
    const rowAnchor = cdsExtensionRowAnchorRef.current;
    if (rowAnchor) {
      cdsExtensionRowAnchorRef.current = null;
      const anchorContainer = container;
      const anchorLine = layout.lines.find((l) => l.lineIndex === rowAnchor.lineIndex);
      if (anchorContainer && anchorLine) {
        const target = Math.max(0, anchorLine.y - rowAnchor.offsetPx);
        if (Math.abs(anchorContainer.scrollTop - target) >= 1) {
          anchorContainer.scrollTop = target;
        }
      }
    }

    const currentCharsPerLine = layout.lines[0]?.sequence.length || 0;
    const currentTotalHeight = layout.totalHeight || 0;
    const charsPerLineChanged =
      prevCharsPerLineRef.current > 0 &&
      currentCharsPerLine > 0 &&
      currentCharsPerLine !== prevCharsPerLineRef.current;
    const heightChangedSignificantly =
      prevTotalHeightRef.current > 0 &&
      currentTotalHeight > 0 &&
      Math.abs(currentTotalHeight - prevTotalHeightRef.current) / prevTotalHeightRef.current > 0.05;

    const bpOffsetChanged = bpOffset !== prevBpOffsetRef.current;
    const isZoomCommit = bpOffsetChanged || zoomInFlightRef.current;
    const previousPrimers = committedTrackGeometryRef.current?.primers;
    const primerTracksChanged =
      previousPrimers != null &&
      (previousPrimers.length !== primers.length ||
        primers.some((primer, index) => {
          const previous = previousPrimers[index];
          return (
            primer.start !== previous.start ||
            primer.end !== previous.end ||
            primer.direction !== previous.direction ||
            primer.overhangLength !== previous.overhangLength ||
            primer.bases.length !== previous.bases.length
          );
        }));

    if (
      (charsPerLineChanged || heightChangedSignificantly || primerTracksChanged) &&
      !rowAnchor &&
      !pendingScrollTargetRef.current &&
      !(screenTrackMorph && screenTrackMorph.layout !== targetLayout) &&
      (!effectiveSequence?.circular || initialScrollAppliedYRef.current !== null) &&
      !isZoomCommit
    ) {
      const previousLayout = getPreviousLayoutForScrollPreservation();
      if (previousLayout && previousLayout.lines.length > 0 && container) {
        const centerPosition = captureViewportCenterPosition(
          container.scrollTop,
          clientHeight,
          previousLayout,
          lastKnownSequencePositionRef.current
        );

        if (centerPosition !== null) {
          pendingScrollTargetRef.current = buildRewrapScrollTarget(
            centerPosition,
            container.scrollTop,
            clientHeight,
            previousLayout,
            layoutGappedSequenceRef.current,
            'resize'
          );
        }
      }
    }
    prevCharsPerLineRef.current = currentCharsPerLine;
    prevTotalHeightRef.current = currentTotalHeight;
    prevBpOffsetRef.current = bpOffset;

    totalHeightRef.current = realContentHeight;
    layoutRef.current = layout;
    layoutGappedSequenceRef.current = isGappedMode(coordinateSpace)
      ? coordinateSpace?.gappedSequence
      : undefined;
    layoutForScrollPreservationRef.current = layout;
    committedTrackGeometryRef.current = { config, primers };

    {
      if (container) {
        const nextInitialScrollY = resolveCircularInitialScrollTop({
          circular: !!effectiveSequence?.circular,
          isZoomCommit,
          realRowsStartY: layout.realRowsStartY,
          currentScrollTop: container.scrollTop,
          lastAppliedRealRowsStartY: initialScrollAppliedYRef.current,
        });
        if (nextInitialScrollY !== null) {
          if (Math.abs(container.scrollTop - nextInitialScrollY) > 1) {
            container.scrollTop = nextInitialScrollY;
          }
          if (Math.abs(container.scrollTop - nextInitialScrollY) <= 1)
            initialScrollAppliedYRef.current = nextInitialScrollY;
        }
      }
    }

    const widthStillPending =
      pendingScrollTargetRef.current?.cause !== 'circular-wrap' &&
      container != null &&
      Math.abs(clientWidth - containerWidth) > 1;
    if (
      pendingScrollTargetRef.current &&
      layout.lines.length > 0 &&
      !isZoomCommit &&
      !widthStillPending
    ) {
      const { placement, anchorOffsetPx } = pendingScrollTargetRef.current;
      const activeAnimation =
        scrollAnimationRafRef.current !== null ? scrollAnimationDestinationRef.current : null;
      const originalPosition = activeAnimation?.position ?? pendingScrollTargetRef.current.position;
      const capturedGappedSequence =
        activeAnimation?.capturedGappedSequence ??
        pendingScrollTargetRef.current.capturedGappedSequence;
      const restorePlacement = activeAnimation ? 'center' : placement;

      const currentlyGapped = isGappedMode(coordinateSpace);
      const wasCapturedInGapped = !!capturedGappedSequence;

      const position = convertScrollPosition(
        originalPosition,
        wasCapturedInGapped,
        currentlyGapped,
        capturedGappedSequence,
        coordinateSpace?.gappedSequence
      );

      const reason = placement === 'top' ? 'circular-wrap' : 'center-preserve';
      debugLog('[SequenceViewer] Restoring scroll via coordinator:', {
        originalPosition,
        convertedPosition: position,
        reason,
        placement: restorePlacement,
        anchorOffsetPx: activeAnimation ? undefined : anchorOffsetPx,
        wasCapturedInGapped,
        currentlyGapped,
        capturedGappedSeqLen: capturedGappedSequence?.length ?? 'none',
        layoutSeqLen: layout.sequenceLength,
        layoutLinesCount: layout.lines.length,
        timestamp: new Date().toISOString(),
      });
      scrollCoordinator.setScrollToBp(position, reason, {
        placement: restorePlacement,
        anchorOffsetPx: activeAnimation ? undefined : anchorOffsetPx,
      });
      if (activeAnimation && scrollAnimationDestinationRef.current === activeAnimation) {
        activeAnimation.cancel();
        scrollAnimationDestinationRef.current = null;
        activeAnimation.onComplete?.();
      }
      pendingScrollTargetRef.current = null;
    }

    if (layout.lines.length > 0) {
      const domScrollTop = container ? container.scrollTop : viewportRef.current.scrollTop;
      const domHeight = clientHeight || viewportRef.current.height || 0;
      if (domHeight > 0) {
        handleViewportScroll(domScrollTop, domHeight, scrollHeight);
      }
    }

    publishViewportRange(
      layout,
      viewportRef.current.scrollTop,
      viewportRef.current.height,
      zoomInFlightRef.current ? 'zoom' : 'layout'
    );
  }, [
    layout,
    realContentHeight,
    containerWidth,
    scrollEndAnchorHeadroom,
    navigationEpoch,
    config,
    primers,
    getYForSequencePosition,
    getPreviousLayoutForScrollPreservation,
    effectiveSequence?.circular,
    publishViewportRange,
    handleViewportScroll,
  ]);

  const handleMinimapNavigate = useCallback(
    (scrollTop: number) => {
      cancelAnimatedScrollRef.current?.();
      newZoomController.cancelGesture();
      if (containerRef.current) {
        containerRef.current.scrollTop = scrollTop;
      }
    },
    [newZoomController.cancelGesture]
  );

  const scrollPositionIntoView = useCallback(
    (position: number) => {
      const container = containerRef.current;
      if (!container || !layout.lines.length) return;

      const targetY = getScrollYForSequencePosition(position, layout, true);
      if (targetY === null) return;
      const rowIndex = layout.summary ? absoluteRowIndexForY(targetY, layout.summary) : -1;
      const lineHeight =
        rowIndex >= 0 && layout.summary ? (layout.summary.rowHeights[rowIndex] ?? 100) : 100;

      const viewportTop = container.scrollTop;
      const viewportBottom = viewportTop + container.clientHeight;
      const padding = 20;

      if (targetY + lineHeight > viewportBottom) {
        container.scrollTop = targetY + lineHeight - container.clientHeight + padding;
      } else if (targetY < viewportTop) {
        container.scrollTop = Math.max(0, targetY - padding);
      }
    },
    [layout]
  );

  scrollPositionIntoViewRef.current = scrollPositionIntoView;

  const lastContinuousCircularSyncPositionRef = useRef<number | null>(null);
  const scrollToBiologicalPositionNow = useCallback(
    (position: number, options?: ScrollToBiologicalPositionOptions, onComplete?: () => void) => {
      cancelAnimatedScrollRef.current?.();
      newZoomController.cancelGesture();
      setPreviewTargetZoom(null);
      setTrackForecastActive(false);
      horizontalMotionRef.current.clear();
      horizontalTargetFrameRef.current = null;
      horizontalPaintedFrameRef.current = null;
      horizontalAnchorRef.current = null;
      horizontalReleasedAtRef.current = null;
      screenTrackFrameRef.current = null;
      pendingScreenTrackFrameRef.current = null;
      releasedZoomAnchorRef.current = null;
      setReleasedWrapPhase(null);
      setScreenTrackTick((tick) => tick + 1);
      if (presentationFrameRafRef.current !== null)
        cancelAnimationFrame(presentationFrameRafRef.current);
      presentationFrameRafRef.current = null;
      debugLog('[SequenceViewer] scrollToBiologicalPosition:', {
        position,
        hasContainer: !!containerRef.current,
        layoutLines: layout.lines.length,
        currentScrollTop: containerRef.current?.scrollTop,
        timestamp: new Date().toISOString(),
      });

      if (!containerRef.current || !layout.lines.length) return;

      let pos: number;
      if (remap.bioToColMap) {
        const mapped = remap.bioToColMap.get(position);
        if (mapped === undefined) {
          onComplete?.();
          return;
        }
        pos = mapped;
      } else {
        pos = position - 1;
      }

      let continuousScrollDirection: 1 | -1 | null = null;
      if (options?.continuousCircular === true && effectiveSequence?.circular) {
        const seqLen = effectiveSequence.sequence.length;
        const prevPos = lastContinuousCircularSyncPositionRef.current;
        if (prevPos != null && seqLen > 0) {
          let delta = pos - prevPos;
          if (delta > seqLen / 2) delta -= seqLen;
          if (delta < -seqLen / 2) delta += seqLen;
          if (Math.abs(delta) >= 0.5) {
            continuousScrollDirection = delta > 0 ? 1 : -1;
          }
        }
        lastContinuousCircularSyncPositionRef.current = pos;
      } else {
        lastContinuousCircularSyncPositionRef.current = null;
      }

      let targetY = getScrollYForSequencePosition(pos, layout, true);

      if (targetY !== null && options?.continuousCircular === true) {
        const continuousY = continuousCircularScrollY(pos, layout);
        if (continuousY !== null) targetY = continuousY;
      }

      if (targetY !== null && containerRef.current) {
        const container = containerRef.current;
        if (Math.abs(container.clientWidth - containerWidth) > 1) {
          pendingScrollTargetRef.current = {
            position: pos,
            placement: 'center',
            capturedGappedSequence: layoutGappedSequenceRef.current,
            cause: 'navigation',
          };
        }
        const currentScrollBefore = container.scrollTop;
        let targetScroll = Math.max(0, targetY - container.clientHeight / 2);

        if (
          continuousScrollDirection == null &&
          options?.continuousCircular === true &&
          Math.abs(targetScroll - currentScrollBefore) > 0.5
        ) {
          continuousScrollDirection = targetScroll > currentScrollBefore ? 1 : -1;
        }

        if (
          options?.continuousCircular === true &&
          continuousScrollDirection !== null &&
          requestCircularScrollReanchor(
            layout,
            currentScrollBefore,
            container.clientHeight,
            continuousScrollDirection,
            'webgl-sync'
          )
        ) {
          handleViewportScroll(container.scrollTop, container.clientHeight, container.scrollHeight);
          onComplete?.();
          return;
        }

        if (hasCircularScrollBuffers(layout)) {
          const realSpan = (layout.bottomBufferStartY ?? 0) - (layout.realRowsStartY ?? 0);
          if (realSpan > 0) {
            const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
            const current = container.scrollTop;
            for (const candidate of [targetScroll - realSpan, targetScroll + realSpan]) {
              if (candidate < 0 || candidate > maxScroll) continue;
              if (Math.abs(candidate - current) < Math.abs(targetScroll - current)) {
                targetScroll = candidate;
              }
            }
          }
        }

        debugLog('[SequenceViewer] Found line, scrolling:', {
          targetY,
          containerHeight: container.clientHeight,
          currentScroll: currentScrollBefore,
          targetScroll,
          animate: !!options?.animate,
          timestamp: new Date().toISOString(),
        });

        if (scrollAnimationRafRef.current !== null) {
          scrollAnimationDestinationRef.current?.cancel();
          scrollAnimationRafRef.current = null;
          scrollAnimationDestinationRef.current = null;
        }

        if (!options?.animate) {
          container.scrollTo({ top: targetScroll, behavior: 'instant' });
          if (!hasCircularScrollBuffers(layout)) {
            const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
            for (let i = 0; i < 2; i += 1) {
              const centerPos = captureViewportCenterPosition(
                container.scrollTop,
                container.clientHeight,
                layout,
                null
              );
              if (centerPos === null || Math.abs(centerPos - pos) <= 1) break;
              const centerY = getScrollYForSequencePosition(centerPos, layout, true);
              const desiredY = getScrollYForSequencePosition(pos, layout, true);
              if (centerY === null || desiredY === null) break;
              const nextScrollTop = Math.max(
                0,
                Math.min(maxScroll, container.scrollTop + desiredY - centerY)
              );
              if (Math.abs(nextScrollTop - container.scrollTop) < 0.5) break;
              container.scrollTop = nextScrollTop;
            }
          }
          if (options?.continuousCircular !== true) {
            pendingScrollTargetRef.current = {
              position: pos,
              placement: 'center',
              capturedGappedSequence: layoutGappedSequenceRef.current,
              cause: 'navigation',
            };
            setNavigationEpoch((epoch) => epoch + 1);
          }
          handleViewportScroll(container.scrollTop, container.clientHeight, container.scrollHeight);
          onComplete?.();
          return;
        }

        const startScroll = container.scrollTop;
        const distance = targetScroll - startScroll;
        if (Math.abs(distance) < 0.5) {
          onComplete?.();
          return;
        }
        const duration = 350;
        const startTime = performance.now();
        let completionTimer: ReturnType<typeof setTimeout> | null = null;
        const destination: NonNullable<typeof scrollAnimationDestinationRef.current> = {
          position: pos,
          capturedGappedSequence: layoutGappedSequenceRef.current,
          onComplete,
          cancel: () => {
            if (completionTimer !== null) {
              clearTimeout(completionTimer);
              completionTimer = null;
            }
            if (scrollAnimationDestinationRef.current !== destination) return;
            if (scrollAnimationRafRef.current !== null) {
              cancelAnimationFrame(scrollAnimationRafRef.current);
              scrollAnimationRafRef.current = null;
            }
          },
        };
        scrollAnimationDestinationRef.current = destination;
        const finish = () => {
          if (scrollAnimationDestinationRef.current !== destination) return;
          destination.cancel();
          container.scrollTop = targetScroll;
          handleViewportScroll(container.scrollTop, container.clientHeight, container.scrollHeight);
          if (scrollAnimationDestinationRef.current !== destination) return;
          scrollAnimationDestinationRef.current = null;
          onComplete?.();
        };
        scrollAnimationDestinationRef.current = destination;
        const step = (now: number) => {
          if (scrollAnimationDestinationRef.current !== destination) return;
          const elapsed = now - startTime;
          const t = Math.min(1, elapsed / duration);
          if (t >= 1) {
            finish();
            return;
          }
          const eased = 1 - Math.pow(1 - t, 3);
          container.scrollTop = startScroll + distance * eased;
          handleViewportScroll(container.scrollTop, container.clientHeight, container.scrollHeight);
          if (scrollAnimationDestinationRef.current !== destination) return;
          scrollAnimationRafRef.current = requestAnimationFrame(step);
        };
        completionTimer = setTimeout(finish, duration);
        scrollAnimationRafRef.current = requestAnimationFrame(step);
        return () => {
          if (scrollAnimationDestinationRef.current !== destination) return;
          destination.cancel();
          scrollAnimationDestinationRef.current = null;
        };
      } else {
        debugLog('[SequenceViewer] Line not found for position:', position);
        onComplete?.();
      }
    },
    [
      containerWidth,
      newZoomController.cancelGesture,
      effectiveSequence?.circular,
      effectiveSequence?.sequence.length,
      handleViewportScroll,
      layout,
      remap.bioToColMap,
      requestCircularScrollReanchor,
    ]
  );

  const controlledScrollCommandRef = useRef<{
    position: number;
    id: number | null;
    cancel?: () => void;
  } | null>(null);

  useEffect(() => {
    return () => {
      scrollAnimationDestinationRef.current?.cancel();
      if (scrollAnimationRafRef.current !== null) {
        cancelAnimationFrame(scrollAnimationRafRef.current);
        scrollAnimationRafRef.current = null;
      }
      scrollAnimationDestinationRef.current = null;
      controlledScrollCommandRef.current = null;
    };
  }, []);

  scrollToBiologicalPositionRef.current = scrollToBiologicalPositionNow;

  useEffect(() => {
    if (scrollToPosition == null) {
      controlledScrollCommandRef.current?.cancel?.();
      controlledScrollCommandRef.current = null;
      return;
    }
    if (!containerRef.current || !layout.lines.length) return;
    const previous = controlledScrollCommandRef.current;
    const alreadyHandled =
      scrollCommandId != null
        ? previous?.id === scrollCommandId
        : previous?.id == null && previous?.position === scrollToPosition;
    if (alreadyHandled) return;
    debugLog('[SequenceViewer] scrollToPosition effect triggered:', {
      scrollToPosition,
      hasContainer: !!containerRef.current,
      layoutLines: layout.lines.length,
      currentScrollTop: containerRef.current?.scrollTop,
      timestamp: new Date().toISOString(),
    });
    const cancel = scrollToBiologicalPositionNow(
      scrollToPosition,
      { animate: scrollAnimate !== false },
      onScrollToPositionComplete
    );
    controlledScrollCommandRef.current = {
      position: scrollToPosition,
      id: scrollCommandId ?? null,
      cancel,
    };
  }, [
    scrollToPosition,
    scrollCommandId,
    scrollAnimate,
    layout.lines.length,
    scrollToBiologicalPositionNow,
    onScrollToPositionComplete,
  ]);

  const handleDragScroll = useCallback((clientY: number, isDragging: boolean) => {
    const container = containerRef.current;
    if (!container) return;

    if (autoScrollRef.current.rafId !== null) {
      cancelAnimationFrame(autoScrollRef.current.rafId);
      autoScrollRef.current.rafId = null;
    }

    if (!isDragging) {
      autoScrollRef.current.scrollSpeed = 0;
      return;
    }

    const rect = container.getBoundingClientRect();
    const mouseYInContainer = clientY - rect.top;
    const containerHeight = rect.height;

    const edgeZone = 60;
    const maxSpeed = 20;

    let scrollSpeed = 0;

    if (mouseYInContainer < edgeZone) {
      const distance = edgeZone - mouseYInContainer;
      scrollSpeed = -Math.min(maxSpeed, (distance / edgeZone) * maxSpeed);
    } else if (mouseYInContainer > containerHeight - edgeZone) {
      const distance = mouseYInContainer - (containerHeight - edgeZone);
      scrollSpeed = Math.min(maxSpeed, (distance / edgeZone) * maxSpeed);
    }

    autoScrollRef.current.scrollSpeed = scrollSpeed;

    if (scrollSpeed !== 0) {
      const scrollFrame = () => {
        const cont = containerRef.current;
        if (!cont || autoScrollRef.current.scrollSpeed === 0) {
          autoScrollRef.current.rafId = null;
          return;
        }

        cont.scrollTop += autoScrollRef.current.scrollSpeed;
        autoScrollRef.current.rafId = requestAnimationFrame(scrollFrame);
      };

      autoScrollRef.current.rafId = requestAnimationFrame(scrollFrame);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (autoScrollRef.current.rafId !== null) {
        cancelAnimationFrame(autoScrollRef.current.rafId);
      }
    };
  }, []);

  if (!sequence) {
    return (
      <div
        ref={bindScrollContainer}
        className={className}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
          fontFamily: 'Roboto Mono, monospace',
          height: '100%',
          ...style,
        }}
      >
        No sequence loaded
      </div>
    );
  }

  const currentAnnotations = config.showAnnotations
    ? effectiveEditable
      ? editorState.annotations
      : (effectiveSequence?.annotations ?? sequence.annotations)
    : [];
  const currentSequenceLength = effectiveEditable
    ? editorState.sequence.length
    : (effectiveSequence?.length ?? sequence.sequence.length);
  if (typeof window !== 'undefined') {
    const perf = canvasTestWindow(window).__zoomPerf;
    if (perf) {
      (perf.viewerRenders ??= []).push({
        t: performance.now(),
        durMs: performance.now() - viewerRenderStartedAt,
      });
      if (perf.viewerRenders.length > 400) perf.viewerRenders.shift();
    }
  }

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        height: '100%',
        backgroundColor: 'hsl(var(--color-bg))',
        fontFamily: 'Roboto Mono, monospace',
        ...style,
      }}
    >
      {showMinimap && (
        <SequenceScrollbar
          ref={minimapRef}
          layout={layout}
          sequenceLength={currentSequenceLength}
          annotations={currentAnnotations}
          annotationColorMode={config.annotationColorMode}
          cutSites={showCutSites ? effectiveCutSites : []}
          scannedCutSites={showCutSites ? effectiveScannedCutSites : []}
          selection={effectiveEditable ? editorState.selection : highlightedRange || selection}
          viewportScrollTop={viewport.scrollTop}
          viewportHeight={renderViewport.height}
          totalHeight={realContentHeight}
          onNavigate={handleMinimapNavigate}
          onNavigationStart={() => {
            releasedZoomAnchorRef.current = null;
            newZoomController.cancelGesture();
          }}
          width={SEQUENCE_SCROLLBAR_WIDTH}
          searchMatches={searchMatches}
          activeSearchIndex={activeSearchIndex}
        />
      )}
      {}
      <div
        data-testid="sequence-scroll-container"
        data-sequence-wheel-zoom-viewport={browserWheelGestureOwnership ? '' : undefined}
        ref={bindScrollContainer}
        onScroll={handleScroll}
        onPointerDownCapture={() => {
          releasedZoomAnchorRef.current = null;
          newZoomController.cancelGesture();
        }}
        onKeyDownCapture={() => {
          releasedZoomAnchorRef.current = null;
          newZoomController.cancelGesture();
        }}
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          overflow: 'auto',
          contain: 'layout',
          scrollbarWidth: showMinimap ? 'none' : 'auto',
          willChange: 'scroll-position',
          WebkitOverflowScrolling: 'touch',
          overflowAnchor: 'none',
        }}
      >
        {containerWidth > 0 && (
          <div>
            <SequenceCanvas
              onCdsExtensionAnchor={handleCdsExtensionAnchor}
              layout={layout}
              paintLayout={targetScreenLayout}
              onPaintLayoutPresented={onPaintLayoutPresented}
              onViewportPresented={onViewportPresented}
              viewportElementRef={containerRef}
              onOrfsPresented={onOrfsPresented}
              canvasSurfaceWidth={viewportCanvasWidth(
                containerWidth,
                layout.totalWidth,
                baseConfig.charsPerLine <= 0
              )}
              scrollEndHeadroom={scrollEnd.headroom + scrollEndAnchorHeadroom}
              config={config}
              geneticCode={recordCode.code}
              geneticCodeBasis={recordCode.basis}
              zoomPreviewTargetRef={zoomTargetRef}
              sequenceLength={currentSequenceLength}
              fullSequence={
                effectiveEditable
                  ? editorState.sequence
                  : (effectiveSequence?.sequence ?? sequence.sequence)
              }
              selection={effectiveEditable ? editorState.selection : selection}
              onSelectionChange={
                effectiveEditable
                  ? (sel) => editorDispatch({ type: 'SET_SELECTION', selection: sel })
                  : handleSelectionChange
              }
              onPositionClick={onPositionClick}
              onAnnotationClick={onAnnotationClick}
              viewport={renderViewport}
              editable={effectiveEditable}
              cursor={effectiveEditable ? editorState.cursor : undefined}
              onCursorChange={handleCursorChange}
              onRequestEdit={onRequestEdit}
              insertedRanges={effectiveEditable ? editorState.insertedRanges : undefined}
              deletedRanges={effectiveEditable ? editorState.deletedRanges : undefined}
              substitutedRanges={effectiveEditable ? editorState.substitutedRanges : undefined}
              coordinateSpace={coordinateSpace}
              cutSites={effectiveCutSites}
              scannedCutSites={effectiveScannedCutSites}
              showCutSites={showCutSites}
              onCutSiteClick={onCutSiteClick}
              onCutSiteDoubleClick={onCutSiteDoubleClick}
              onGGLabelClick={onGGLabelClick}
              hoveredEnzymeName={hoveredEnzymeName}
              hoveredPositionInfo={hoveredPositionInfo}
              onContextMenu={onContextMenu}
              onDragScroll={handleDragScroll}
              primers={primers}
              viewCursor={viewCursor}
              onViewCursorChange={onViewCursorChange}
              highlightedRange={highlightedRange}
              highlightPreviewRef={canvasHighlightPreviewRef}
              onHighlightedRangeChange={onHighlightedRangeChange}
              onHighlightedRangePreview={onHighlightedRangePreview}
              rulerSegments={rulerSegments}
              selectedAssemblyScaffoldRegionId={selectedAssemblyScaffoldRegionId}
              onAssemblyScaffoldSelect={onAssemblyScaffoldSelect}
              rulerDecorations={effectiveRulerDecorations ?? rulerDecorations}
              junctionIndicators={junctionIndicators}
              mutations={mutations}
              onMutationClick={onMutationClick}
              orfs={effectiveOrfs}
              candidateOrf={candidateOrf}
              forcedSelectedAnnotation={forcedSelectedAnnotation}
              selectedAnnotation={selectedAnnotation}
              onSelectedAnnotationChange={onSelectedAnnotationChange}
              changedAnnotationNames={changedAnnotationNames}
              searchHighlights={searchMatches}
              activeSearchIndex={activeSearchIndex}
              scrollDrawRef={canvasScrollDrawRef}
              hasPendingZoomFrame={() =>
                newZoomController.hasPendingCommit() || !!screenTrackMorph?.pending
              }
              previewCDS={previewCDS}
              bpHighlights={bpHighlights}
              onHoveredCodonChange={onHoveredCodonChange}
              residueSelectionReferenceId={residueSelectionReferenceId}
            />
          </div>
        )}
        {!effectiveSequence?.circular && renderViewport.height > 0 && (
          <div
            data-testid="sequence-scroll-end-headroom"
            aria-hidden
            data-headroom-px={scrollEnd.headroom}
            data-last-row-height-px={scrollEnd.lastRowHeight}
            data-last-row-top-y={scrollEnd.lastRowTop}
            data-layout-total-height={scrollEnd.totalHeight}
            data-viewport-height={scrollEnd.viewportHeight}
          />
        )}
      </div>
    </div>
  );
}

export const SequenceViewer = forwardRef(WorkspaceEditorInner);

SequenceViewer.displayName = 'SequenceViewer';

export const WorkspaceEditor = SequenceViewer;
