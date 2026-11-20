import { toUserMessage } from '@waypoint/user-messages';
import type { OrfPresentation } from './orfs/orf-observation';

import React, { useRef, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type {
  Annotation,
  ColoredCutSite,
  GeneticCodeSpec,
  ORF,
  SearchMatch,
} from '@waypoint/sequence-utils';
import type {
  LayoutSnapshot2D,
  SequenceViewportPresentation,
  WorkspaceEditorConfig,
  Selection,
  InsertedRange,
  DeletedRange,
  SubstitutedRange,
  PrimerDisplay,
  RulerSegment,
  RulerDecoration,
  JunctionIndicator,
  RenderedGGProductLabel,
  CoordinateSpace,
  MutationMarker,
  BpHighlight,
} from './types';
import type { RenderedCutSite } from './restriction-enzymes/drawCutSites';
import type { CdsExtensionArrowBounds } from './cds-extension-affordance';
import { usePrecomputedLayout } from './hooks/usePrecomputedLayout';
import { useSelectionDraw } from './hooks/useSelectionDraw';
import { useCanvasWorkerDraw } from './hooks/useCanvasWorkerDraw';
import { useCanvasInteraction } from './hooks/useCanvasInteraction';
import { FeatureHoverTooltip } from './FeatureHoverTooltip';
import { codonNameLine, featureSummaryLine, cdsRegionHoverLine } from './codon-hover-tooltip-lines';
import { useSelectedCodons } from './selected-codons-store';
import type { AnnotationStateIdentity } from './annotation-render-state';
import { AssemblyScaffoldHitTargets } from './AssemblyScaffoldHitTargets';
import { releaseSequenceWebGLContext } from './rendering/webgl-drawing-context';

interface SequenceCanvasProps {
  viewportElementRef?: React.RefObject<HTMLElement | null>;
  onViewportPresented?: (frame: SequenceViewportPresentation) => void;
  onCdsExtensionAnchor?: (bp: number | null) => void;
  layout: LayoutSnapshot2D;

  paintLayout?: LayoutSnapshot2D;
  onOrfsPresented?: OrfPresentation['presented'];
  onPaintLayoutPresented?: (
    scene: LayoutSnapshot2D,
    presented: LayoutSnapshot2D,
    paintedAt: number,
    paintConfig: WorkspaceEditorConfig
  ) => void;

  canvasSurfaceWidth?: number;
  reservedViewportHeight?: number;

  scrollEndHeadroom?: number;
  config: WorkspaceEditorConfig;
  sequenceLength: number;

  geneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis;

  fullSequence: string;
  selection?: Selection | null;
  onSelectionChange?: (selection: Selection | null) => void;
  onPositionClick?: (position: number) => void;
  onAnnotationClick?: (annotation: Annotation) => void;

  viewCursor?: number | null;

  onViewCursorChange?: (position: number | null) => void;

  highlightedRange?: Selection | null;

  highlightPreviewRef?: React.MutableRefObject<((range: Selection | null) => void) | null>;

  onHighlightedRangeChange?: (range: Selection | null) => void;

  onHighlightedRangePreview?: (range: Selection | null) => void;

  viewport?: { scrollTop: number; height: number };

  zoomPreviewTargetRef?: React.RefObject<HTMLDivElement>;

  editable?: boolean;

  cursor?: number;

  onCursorChange?: (position: number) => void;

  onRequestEdit?: (position: number) => void;

  insertedRanges?: InsertedRange[];

  deletedRanges?: DeletedRange[];

  substitutedRanges?: SubstitutedRange[];

  cutSites?: ColoredCutSite[];

  scannedCutSites?: ColoredCutSite[];

  showCutSites?: boolean;

  onCutSiteClick?: (cutSite: ColoredCutSite) => void;

  onCutSiteDoubleClick?: (cutSite: ColoredCutSite) => void;

  onGGLabelClick?: (junctionIndex: number) => void;

  hoveredEnzymeName?: string | null;

  hoveredPositionInfo?: {
    enzymeName: string;
    position: number;
    recognitionStart: number;
    recognitionEnd: number;
  } | null;

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

  onScrollToPosition?: (position: number) => void;

  onDragScroll?: (clientY: number, isDragging: boolean) => void;

  primers?: PrimerDisplay[];

  rulerSegments?: RulerSegment[];
  selectedAssemblyScaffoldRegionId?: string | null;
  onAssemblyScaffoldSelect?: (regionId: string) => void;

  rulerDecorations?: RulerDecoration[];

  junctionIndicators?: JunctionIndicator[];

  coordinateSpace?: CoordinateSpace;

  mutations?: MutationMarker[];

  onMutationClick?: (mutation: MutationMarker) => void;

  orfs?: ORF[];

  candidateOrf?: { start: number; end: number; strand: '+' | '-' } | null;

  forcedSelectedAnnotation?: {
    type: string;
    name: string;
    start: number;
    end: number;
    direction: number;
  } | null;

  selectedAnnotation?: AnnotationStateIdentity | null;
  onSelectedAnnotationChange?: (annotation: AnnotationStateIdentity | null) => void;

  changedAnnotationNames?: Set<string>;

  searchHighlights?: SearchMatch[];

  activeSearchIndex?: number;

  scrollDrawRef?: React.MutableRefObject<
    ((scrollTop: number, height: number, paintNow?: boolean) => void) | null
  >;

  hasPendingZoomFrame?: () => boolean;

  previewCDS?: Annotation | null;

  bpHighlights?: ReadonlyArray<BpHighlight>;

  onHoveredCodonChange?: (codon: { start: number; end: number; strand: 1 | -1 } | null) => void;

  residueSelectionReferenceId?: string | null;
}

const EMPTY_INSERTED_RANGES: InsertedRange[] = [];
const EMPTY_DELETED_RANGES: DeletedRange[] = [];
const EMPTY_SUBSTITUTED_RANGES: SubstitutedRange[] = [];
const EMPTY_COLORED_CUT_SITES: ColoredCutSite[] = [];
const EMPTY_PRIMERS: PrimerDisplay[] = [];
const EMPTY_MUTATIONS: MutationMarker[] = [];
const EMPTY_BP_HIGHLIGHTS_CONSTANT: ReadonlyArray<BpHighlight> = Object.freeze([]);

export const SequenceCanvas: React.FC<SequenceCanvasProps> = ({
  viewportElementRef,
  onViewportPresented,
  onCdsExtensionAnchor,
  layout,
  paintLayout,
  onPaintLayoutPresented,
  onOrfsPresented,
  canvasSurfaceWidth,
  reservedViewportHeight,
  scrollEndHeadroom = 0,
  config: partialConfig,
  geneticCode,
  geneticCodeBasis,
  sequenceLength,
  fullSequence,
  selection,
  onSelectionChange,
  viewCursor,
  onViewCursorChange,
  highlightedRange,
  highlightPreviewRef,
  onHighlightedRangeChange,
  onHighlightedRangePreview,
  viewport,
  editable = false,
  cursor,
  onCursorChange,
  insertedRanges = EMPTY_INSERTED_RANGES,
  deletedRanges = EMPTY_DELETED_RANGES,
  substitutedRanges = EMPTY_SUBSTITUTED_RANGES,
  cutSites = EMPTY_COLORED_CUT_SITES,
  scannedCutSites = EMPTY_COLORED_CUT_SITES,
  showCutSites = false,
  onCutSiteClick,
  onCutSiteDoubleClick,
  onGGLabelClick,
  hoveredEnzymeName,
  hoveredPositionInfo,
  onContextMenu,
  onDragScroll,
  primers = EMPTY_PRIMERS,
  rulerSegments,
  selectedAssemblyScaffoldRegionId,
  onAssemblyScaffoldSelect,
  rulerDecorations,
  junctionIndicators,
  coordinateSpace,
  mutations = EMPTY_MUTATIONS,
  onMutationClick: _onMutationClick,
  orfs,
  candidateOrf,
  forcedSelectedAnnotation,
  selectedAnnotation: externalSelectedAnnotation,
  onSelectedAnnotationChange,
  changedAnnotationNames,
  searchHighlights,
  activeSearchIndex,
  scrollDrawRef,
  hasPendingZoomFrame,
  previewCDS,
  bpHighlights,
  onHoveredCodonChange,
  residueSelectionReferenceId,
  zoomPreviewTargetRef,
}) => {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains('dark'));
    });
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const [mainCanvasGeneration, setMainCanvasGeneration] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const main = canvasRef.current,
      overlay = selectionCanvasRef.current;
    const errors = new Map<EventTarget, string>();
    const error = (event: Event) => {
      if (event.target) errors.set(event.target, String((event as CustomEvent<string>).detail));
      setRenderError(
        [...errors.values()][0] != null
          ? toUserMessage([...errors.values()][0], 'tracks.loadFailed')
          : null
      );
    };
    const status = (event: Event) => {
      const value = (event as CustomEvent<string>).detail;
      if (!event.target) return;
      if (value === 'context-lost')
        errors.set(event.target, 'Graphics context lost. The sequence viewer is restoring it.');
      else if (value === 'error')
        errors.set(event.target, 'The sequence graphics context could not be initialized.');
      else if (value === 'ready' || value === 'released') errors.delete(event.target);
      setRenderError(
        [...errors.values()][0] != null
          ? toUserMessage([...errors.values()][0], 'tracks.loadFailed')
          : null
      );
    };
    for (const canvas of [main, overlay]) {
      canvas?.addEventListener('sequence-render-error', error);
      canvas?.addEventListener('sequence-render-status', status);
      if (canvas?.dataset.renderStatus === 'error')
        errors.set(
          canvas,
          'WebGL 2 is unavailable. Enable hardware acceleration and reopen the sequence viewer.'
        );
    }
    setRenderError(
      [...errors.values()][0] != null
        ? toUserMessage([...errors.values()][0], 'tracks.loadFailed')
        : null
    );
    return () => {
      for (const canvas of [main, overlay]) {
        canvas?.removeEventListener('sequence-render-error', error);
        canvas?.removeEventListener('sequence-render-status', status);
      }
      if (main) releaseSequenceWebGLContext(main);
      if (overlay) releaseSequenceWebGLContext(overlay);
    };
  }, [mainCanvasGeneration]);
  const remountTransferredCanvas = React.useCallback(
    () => setMainCanvasGeneration((generation) => generation + 1),
    []
  );

  const viewportRef = useRef({ scrollTop: 0, height: 0 });
  if (viewport && viewport.height !== viewportRef.current.height) {
    viewportRef.current = { ...viewportRef.current, height: viewport.height };
  }

  const drawFnRef = useRef<(() => void) | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const canvasDimensionsRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const canvasRectRef = useRef<DOMRect | null>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const hoverCursorRef = useRef<{ x: number; lineIdx: number } | null>(null);
  const shiftPreviewRef = useRef<{
    hoverPosition: number;
    anchorPosition: number;
    isOptionHeld: boolean;
  } | null>(null);

  const renderedGGLabelsRef = React.useRef<RenderedGGProductLabel[]>([]);
  const renderedCutSitesRef = useRef<RenderedCutSite[]>([]);

  const renderedCdsExtensionArrowsRef = useRef<CdsExtensionArrowBounds[]>([]);
  const renderedPrimersRef = useRef<
    Array<{ primer: PrimerDisplay; x: number; y: number; width: number; height: number }>
  >([]);

  const hoveredEnzymeNameRef = useRef<string | null | undefined>(hoveredEnzymeName);
  hoveredEnzymeNameRef.current = hoveredEnzymeName;

  const bpHighlightsRef = useRef<ReadonlyArray<BpHighlight>>(
    bpHighlights ?? EMPTY_BP_HIGHLIGHTS_CONSTANT
  );
  bpHighlightsRef.current = bpHighlights ?? EMPTY_BP_HIGHLIGHTS_CONSTANT;

  const isSelectingRef = useRef(false);
  const selectionAnchorRef = useRef<number | null>(null);
  const liveSelectionRef = useRef<Selection | null>(null);
  const editLastDragPositionRef = useRef<number | null>(null);
  const editCumulativeDragDeltaRef = useRef<number>(0);
  const isHighlightingRef = useRef(false);
  const highlightAnchorRef = useRef<number | null>(null);
  const lastDragPositionRef = useRef<number | null>(null);
  const cumulativeDragDeltaRef = useRef<number>(0);
  const highlightedRangeRef = useRef<Selection | null>(highlightedRange || null);
  const viewCursorRef = useRef<number | null>(viewCursor ?? null);
  const isDraggingHandleRef = useRef<'start' | 'end' | null>(null);
  const handleDragAnchorRef = useRef<number | null>(null);

  const selectionRef = useRef<Selection | null>(null);
  const cursorRef = useRef<number | undefined>(undefined);
  const cursorVisibleRef = useRef(true);
  const insertedRangesRef = useRef<InsertedRange[]>([]);
  const deletedRangesRef = useRef<DeletedRange[]>([]);

  const [cursorVisible, setCursorVisible] = useState(true);
  const cursorBlinkRef = useRef<number | null>(null);

  selectionRef.current = selection || null;

  highlightedRangeRef.current = editable && selection ? selection : highlightedRange || null;
  viewCursorRef.current = editable ? null : (viewCursor ?? null);
  cursorRef.current = cursor;
  cursorVisibleRef.current = cursorVisible;
  insertedRangesRef.current = insertedRanges;
  deletedRangesRef.current = deletedRanges;

  useEffect(() => {
    if (!editable || cursor === undefined || selection) {
      if (cursorBlinkRef.current) {
        clearInterval(cursorBlinkRef.current);
        cursorBlinkRef.current = null;
      }
      setCursorVisible(false);
      return;
    }
    setCursorVisible(true);
    if (cursorBlinkRef.current) clearInterval(cursorBlinkRef.current);
    cursorBlinkRef.current = window.setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => {
      if (cursorBlinkRef.current) {
        clearInterval(cursorBlinkRef.current);
        cursorBlinkRef.current = null;
      }
    };
  }, [editable, cursor, selection]);

  const {
    config,
    precomputedLinePositions,
    linePrimerFlagsMap,
    mutationCacheRef,
    alignmentCodonsCacheRef,
    lineCodonsCacheRef,
  } = usePrecomputedLayout({
    layout: paintLayout ?? layout,
    partialConfig,
    fullSequence,
    primers,
    coordinateSpace,
    mutations,
  });
  const interactionLinePositions = useMemo(() => {
    if (!paintLayout || paintLayout === layout) return precomputedLinePositions;
    const displayed = new Map(layout.lines.map((line) => [line.lineIndex, line]));
    return precomputedLinePositions.map((position) => ({
      ...position,
      line: displayed.get(position.line.lineIndex) ?? position.line,
    }));
  }, [layout, paintLayout, precomputedLinePositions]);
  const interactionPrimerFlagsMap = useMemo(() => {
    if (interactionLinePositions === precomputedLinePositions) return linePrimerFlagsMap;
    return new Map(
      interactionLinePositions.map((position) => [
        position.line,
        {
          hasForwardPrimers: position.hasForwardPrimers,
          hasReversePrimers: position.hasReversePrimers,
        },
      ])
    );
  }, [interactionLinePositions, linePrimerFlagsMap, precomputedLinePositions]);

  const { drawSelectionAndCursorRef, drawSelectionDirect } = useSelectionDraw({
    selectionCanvasRef,
    viewportRef,
    hoverCursorRef,
    shiftPreviewRef,
    layout,
    config,
    precomputedLinePositions: interactionLinePositions,
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
  });

  useLayoutEffect(() => {
    if (!highlightPreviewRef) return;
    highlightPreviewRef.current = (range: Selection | null) => {
      highlightedRangeRef.current = range;
      if (range) viewCursorRef.current = null;
      drawFnRef.current?.();
    };
    return () => {
      if (highlightPreviewRef.current) highlightPreviewRef.current = null;
    };
  }, [highlightPreviewRef, drawFnRef]);

  const {
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
  } = useCanvasInteraction({
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
    renderedCutSitesRef,
    renderedCdsExtensionArrowsRef,
    onCdsExtensionAnchor,
    layout,
    paintLayout,
    config,
    precomputedLinePositions: interactionLinePositions,
    linePrimerFlagsMap: interactionPrimerFlagsMap,
    sequenceLength,
    editable,
    selection,
    cursor,
    viewCursor,
    highlightedRange,
    showCutSites,
    coordinateSpace,
    orfs,
    fullSequence,
    residueSelectionReferenceId,
    onSelectionChange,
    onCursorChange,
    onViewCursorChange,
    onHighlightedRangeChange,
    onHighlightedRangePreview,
    onCutSiteClick,
    onCutSiteDoubleClick,
    onGGLabelClick,
    onContextMenu,
    onDragScroll,
    shiftPreviewRef,
    selectedAnnotation: externalSelectedAnnotation,
    onSelectedAnnotationChange,
  });

  useEffect(() => {
    onHoveredCodonChange?.(hoveredCodon);
  }, [hoveredCodon, onHoveredCodonChange]);

  const hoveredCodonName = useMemo(() => {
    if (!hoveredCodon) return null;
    for (const codons of lineCodonsCacheRef.current.values()) {
      const cell = codons.find(
        (codon) => codon.startPos === hoveredCodon.start && codon.endPos === hoveredCodon.end
      );
      if (cell) return codonNameLine(cell.display);
    }
    return null;
  }, [hoveredCodon, lineCodonsCacheRef]);
  const hoveredCdsRegion =
    hoveredAnnotation && annotationTooltipPos
      ? cdsRegionHoverLine(hoveredAnnotation, annotationTooltipPos.position, sequenceLength)
      : null;

  const selectedCodons = useSelectedCodons();

  const orfRenderStateInputMemo = useMemo(
    () => ({
      hovered: hoveredOrf ?? null,
      selected: forcedSelectedAnnotation ? null : (selectedOrf ?? null),
      candidate: candidateOrf ?? null,
    }),
    [
      hoveredOrf?.start,
      hoveredOrf?.end,
      hoveredOrf?.strand,
      selectedOrf?.start,
      selectedOrf?.end,
      selectedOrf?.strand,
      candidateOrf?.start,
      candidateOrf?.end,
      candidateOrf?.strand,

      !!forcedSelectedAnnotation,
    ]
  );

  const annotationRenderStateInputMemo = useMemo(
    () => ({
      hovered: hoveredAnnotation ?? null,
      selected: forcedSelectedAnnotation ?? selectedAnnotation ?? null,
    }),
    [
      hoveredAnnotation?.type,
      hoveredAnnotation?.name,
      hoveredAnnotation?.start,
      hoveredAnnotation?.end,
      hoveredAnnotation?.direction,
      selectedAnnotation?.type,
      selectedAnnotation?.name,
      selectedAnnotation?.start,
      selectedAnnotation?.end,
      selectedAnnotation?.direction,
      forcedSelectedAnnotation?.type,
      forcedSelectedAnnotation?.name,
      forcedSelectedAnnotation?.start,
      forcedSelectedAnnotation?.end,
      forcedSelectedAnnotation?.direction,
    ]
  );

  useCanvasWorkerDraw({
    viewportElementRef,
    onViewportPresented,
    canvasRef,
    remountTransferredCanvas,
    selectionCanvasRef,
    viewportRef,
    drawFnRef,
    drawRafRef,
    canvasDimensionsRef,
    canvasRectRef,
    drawSelectionAndCursorRef,
    hoverCursorRef,
    isSelectingRef,
    liveSelectionRef,
    selectionRef,
    cursorRef,
    cursorVisibleRef,
    insertedRangesRef,
    deletedRangesRef,
    highlightedRangeRef,
    renderedPrimersRef,
    renderedGGLabelsRef,
    renderedCutSitesRef,
    renderedCdsExtensionArrowsRef,
    lineCodonsCacheRef,
    mutationCacheRef,
    alignmentCodonsCacheRef,
    layout: paintLayout ?? layout,
    presentedLayout: layout,
    onPaintLayoutPresented,
    onOrfsPresented,
    canvasSurfaceWidth,
    reservedViewportHeight,
    scrollEndHeadroom,
    config,
    precomputedLinePositions,
    fullSequence,
    sequenceLength,
    cutSites,
    scannedCutSites,
    primers,
    mutations,
    rulerSegments,
    insertedRanges,
    deletedRanges,
    substitutedRanges,
    showCutSites,
    hoveredCodon,
    selectedCodons,
    geneticCode,
    geneticCodeBasis,
    viewCursor,
    viewCursorRef,
    hoveredCutSite,
    hoveredGGProductLabel,
    hoveredEnzymeName,
    hoveredPositionInfo,
    hoveredPrimerId: hoveredPrimer?.id ?? null,
    selectedPrimerId: selectedPrimer?.id ?? null,
    coordinateSpace,
    junctionIndicators,
    orfs,

    orfRenderStateInput: orfRenderStateInputMemo,
    annotationRenderStateInput: annotationRenderStateInputMemo,
    rulerDecorations,
    changedAnnotationNames,
    searchHighlights,
    activeSearchIndex,
    highlightedRange: editable && selection ? selection : highlightedRange,
    isDark,
    scrollDrawRef,
    hasPendingZoomFrame,
    previewCDS,
  });

  useEffect(() => {
    if (!isSelectingRef.current && !isHighlightingRef.current) {
      const effectiveSelection =
        liveSelectionRef.current ?? (editable ? selection || null : highlightedRange || null);
      drawSelectionAndCursorRef.current(
        effectiveSelection,
        cursor,
        cursorVisible,
        insertedRanges,
        deletedRanges,
        null
      );
    }
  }, [
    selection,
    highlightedRange,
    cursor,
    cursorVisible,
    editable,
    insertedRanges,
    deletedRanges,
    shiftPreview,

    bpHighlights,
  ]);

  const contentHeight = layout.totalHeight;
  const stickyViewportHeight =
    viewport?.height && viewport.height > 0
      ? Math.min(viewport.height, contentHeight)
      : contentHeight;

  return (
    <div
      style={{
        position: 'relative',
        width: layout.totalWidth,
        height: contentHeight + scrollEndHeadroom,
      }}
    >
      {renderError && (
        <div
          role="alert"
          data-testid="sequence-render-error"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 3,
            padding: 12,
            background: 'var(--color-bg)',
            color: 'var(--color-fg)',
          }}
        >
          {toUserMessage(renderError, 'tracks.loadFailed')}
        </div>
      )}
      {}
      <div
        ref={zoomPreviewTargetRef}
        style={{
          position: 'sticky',
          top: 0,
          width: layout.totalWidth,
          height: stickyViewportHeight,
          overflow: 'hidden',
          willChange: 'transform',
          transform: 'translate3d(0, 0, 0)',
        }}
      >
        {}
        <canvas
          key={mainCanvasGeneration}
          ref={canvasRef}
          data-testid="sequence-canvas-main"
          data-renderer="webgl2"
          style={{
            display: 'block',
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        />
        {}
        <canvas
          ref={selectionCanvasRef}
          data-testid="sequence-canvas-interactive"
          data-renderer="webgl2"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onClick={handleClick}
          onMouseLeave={handleMouseLeave}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
          style={{
            display: 'block',
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'auto',
            cursor: 'none',
            userSelect: 'none',
          }}
        />
      </div>
      <AssemblyScaffoldHitTargets
        rulerSegments={rulerSegments}
        linePositions={interactionLinePositions}
        sequenceLength={sequenceLength}
        config={config}
        selectedRegionId={selectedAssemblyScaffoldRegionId}
        onSelect={onAssemblyScaffoldSelect}
      />

      {}
      {hoveredPrimer && primerTooltipPos ? (
        <FeatureHoverTooltip
          testId="primer-hover-tooltip"
          title={hoveredPrimer.name}
          lines={[
            `Primer • ${hoveredPrimer.start + 1}..${hoveredPrimer.end} bp`,
            `Tm: ${hoveredPrimer.tm.toFixed(1)}°C • GC: ${hoveredPrimer.gc.toFixed(1)}%`,
            hoveredPrimer.direction === 'forward' ? '→ Forward' : '← Reverse',
            ...(hoveredPrimer.modificationMarkers?.map(
              (marker) => `${marker.label} ${marker.token}`
            ) ?? []),
          ]}
          clientX={primerTooltipPos.x}
          clientY={primerTooltipPos.y}
        />
      ) : hoveredAnnotation && annotationTooltipPos ? (
        <FeatureHoverTooltip
          testId="annotation-hover-tooltip"
          title={hoveredAnnotation.name || hoveredAnnotation.type}
          lines={[
            featureSummaryLine(hoveredAnnotation),
            ...(hoveredCdsRegion ? [hoveredCdsRegion] : []),

            ...(hoveredCodonName ? [hoveredCodonName] : []),
          ]}
          clientX={annotationTooltipPos.x}
          clientY={annotationTooltipPos.y}
        />
      ) : null}
    </div>
  );
};
