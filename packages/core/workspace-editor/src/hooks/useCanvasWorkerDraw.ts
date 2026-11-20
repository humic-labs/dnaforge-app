import { reportOrfPaint, type OrfPresentation } from '../orfs/orf-observation';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '../vite-worker';
import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { Annotation, ColoredCutSite, ORF, SearchMatch } from '@waypoint/sequence-utils';
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
} from '../types';
import type { CodonInfo, AlignmentCodonInfo } from '../translation-drawing';
import { computeAllAlignmentCodons } from '../translation-drawing';
import { renderSequence } from '../canvas-renderer';
import { rowPaintY, rowPaintBounds } from '../predictive-wrap-layout';
import { rowPresentationBounds } from '../row-presentation-bounds';
import { getSequenceWebGLContext } from '../rendering/webgl-drawing-context';
import { resolveCanvasTheme } from '../canvas-theme';
import type { RenderedCutSite } from '../restriction-enzymes/drawCutSites';
import type { CdsExtensionArrowBounds } from '../cds-extension-affordance';
import type { PrecomputedLinePosition } from './usePrecomputedLayout';
import CanvasRenderWorker from '../canvas-render-worker?worker&inline';
import { getSequenceFontSources } from '@waypoint/platform';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  WorkerRenderMessage,
} from '../canvas-worker-protocol';
import {
  createViewportScopedLayout,
  cullLinesToViewport,
  encodeSequenceToSharedBuffer,
} from '../canvas-worker-protocol';
import { diag } from '../diagnostics';
import { summarizeDrawnRows } from '../drawn-row-diagnostics';
import {
  shouldSyncViewportCanvasSizesDuringScroll,
  syncViewportCanvasSizes,
  viewportCanvasHeight,
} from '../canvas-viewport-sizing';
import {
  recoverTransferredCanvasForFallback,
  terminateOwnedWorker,
  useStrictModeSafeWorkerLifetime,
} from './useStrictModeSafeWorkerLifetime';
import type {
  CanvasDrawnRowsSnapshot,
  DrawnRowDiagnostic,
  DrawnRowSource,
} from '../drawn-row-diagnostics';
import { canvasTestWindow, shouldExposeCanvasDiagnosticsSurface } from '../canvas-test-bridge';

function shouldAttemptCanvasWorker(): boolean {
  if (typeof window === 'undefined') return false;

  return window.location.protocol !== 'file:';
}

function horizontalPresentationBands(
  scene: LayoutSnapshot2D,
  presented: LayoutSnapshot2D,
  scrollTop: number,
  viewportHeight: number
): Array<{ top: number; bottom: number; dx: number }> {
  if (!scene.summary) return [];
  const displayed = new Map(presented.lines.map((row) => [row.lineIndex, row]));
  const summary = scene.summary;
  const bands: Array<{ top: number; bottom: number; dx: number }> = [];
  for (const row of scene.lines) {
    const current = displayed.get(row.lineIndex);
    if (!current) continue;
    const dx = (current.xOffset ?? 0) - (row.xOffset ?? 0);
    if (Math.abs(dx) < 0.001) continue;
    const { top, bottom } = rowPresentationBounds(
      row,
      summary,
      scrollTop,
      viewportHeight + 100,
      viewportHeight + 100
    );

    if (bottom <= 0 || top >= viewportHeight + 100) continue;
    bands.push({
      top,
      bottom,
      dx,
    });
  }
  return bands;
}

function hasPreparedViewport(
  layout: LayoutSnapshot2D,
  positions: PrecomputedLinePosition[],
  scrollTop: number,
  height: number
): boolean {
  if (height <= 0) return false;
  const summary = layout.summary;
  if (!summary || summary.totalRows === 0) return true;
  const first = positions[0]?.line;
  const last = positions[positions.length - 1]?.line;
  if (!first || !last) return false;
  const top = first.lineIndex > 0 ? first.y : -Infinity;
  const bottom =
    last.lineIndex < summary.totalRows - 1 ? summary.rowYOffsets[last.lineIndex + 1] : Infinity;
  return scrollTop >= top && scrollTop + height <= bottom;
}

interface UseCanvasWorkerDrawParams {
  viewportElementRef?: React.RefObject<HTMLElement | null>;
  onViewportPresented?: (frame: SequenceViewportPresentation) => void;
  scrollEndHeadroom?: number;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  remountTransferredCanvas: () => void;
  selectionCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.MutableRefObject<{ scrollTop: number; height: number }>;
  drawFnRef: React.MutableRefObject<(() => void) | null>;
  drawRafRef: React.MutableRefObject<number | null>;
  canvasDimensionsRef: React.MutableRefObject<{ width: number; height: number }>;
  canvasRectRef: React.MutableRefObject<DOMRect | null>;
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
  hoverCursorRef: React.MutableRefObject<{ x: number; lineIdx: number } | null>;
  isSelectingRef: React.MutableRefObject<boolean>;
  liveSelectionRef: React.MutableRefObject<Selection | null>;
  selectionRef: React.MutableRefObject<Selection | null>;
  cursorRef: React.MutableRefObject<number | undefined>;
  cursorVisibleRef: React.MutableRefObject<boolean>;
  insertedRangesRef: React.MutableRefObject<InsertedRange[]>;
  deletedRangesRef: React.MutableRefObject<DeletedRange[]>;
  highlightedRangeRef: React.MutableRefObject<Selection | null>;
  renderedPrimersRef: React.MutableRefObject<
    Array<{ primer: PrimerDisplay; x: number; y: number; width: number; height: number }>
  >;
  renderedGGLabelsRef: React.MutableRefObject<RenderedGGProductLabel[]>;
  renderedCutSitesRef: React.MutableRefObject<RenderedCutSite[]>;
  renderedCdsExtensionArrowsRef: React.MutableRefObject<CdsExtensionArrowBounds[]>;
  lineCodonsCacheRef: React.MutableRefObject<Map<number, CodonInfo[]>>;
  mutationCacheRef: React.MutableRefObject<{
    mutations: MutationMarker[];
    map: Map<number, MutationMarker>;
  }>;
  alignmentCodonsCacheRef: React.MutableRefObject<{
    alignedRef: string;
    alignedQuery: string;
    codonsMap: Map<string, AlignmentCodonInfo[]>;
  }>;
  layout: LayoutSnapshot2D;

  presentedLayout?: LayoutSnapshot2D;
  onOrfsPresented?: OrfPresentation['presented'];
  onPaintLayoutPresented?: (
    scene: LayoutSnapshot2D,
    presented: LayoutSnapshot2D,
    paintedAt: number,
    paintConfig: WorkspaceEditorConfig
  ) => void;
  canvasSurfaceWidth?: number;
  reservedViewportHeight?: number;
  config: WorkspaceEditorConfig;
  precomputedLinePositions: PrecomputedLinePosition[];
  fullSequence: string;
  sequenceLength: number;
  cutSites: ColoredCutSite[];
  scannedCutSites: ColoredCutSite[];
  primers: PrimerDisplay[];
  mutations: MutationMarker[];
  rulerSegments?: RulerSegment[];
  insertedRanges: InsertedRange[];
  deletedRanges: DeletedRange[];
  substitutedRanges?: SubstitutedRange[];
  showCutSites: boolean;
  hoveredCodon: { start: number; end: number; strand: 1 | -1 } | null;

  geneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis;

  selectedCodons?: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>;
  viewCursor?: number | null;
  viewCursorRef: React.MutableRefObject<number | null>;
  hoveredCutSite: ColoredCutSite | null;
  hoveredGGProductLabel: RenderedGGProductLabel | null;
  hoveredEnzymeName: string | null | undefined;
  hoveredPositionInfo?: {
    enzymeName: string;
    position: number;
    recognitionStart: number;
    recognitionEnd: number;
  } | null;
  coordinateSpace?: CoordinateSpace;
  junctionIndicators?: JunctionIndicator[];
  orfs?: ORF[];

  orfRenderStateInput?: import('../orf-drawing').OrfRenderStateInput;

  annotationRenderStateInput?: import('../annotation-render-state').AnnotationRenderStateInput;
  rulerDecorations?: RulerDecoration[];
  changedAnnotationNames?: Set<string>;
  searchHighlights?: SearchMatch[];
  activeSearchIndex?: number;
  highlightedRange?: Selection | null;
  isDark: boolean;
  hoveredPrimerId?: string | null;
  selectedPrimerId?: string | null;
  scrollDrawRef?: React.MutableRefObject<
    ((scrollTop: number, height: number, paintNow?: boolean) => void) | null
  >;
  hasPendingZoomFrame?: () => boolean;

  previewCDS?: Annotation | null;
}

type WorkerViewportReason = 'scroll' | 'draw';

type CanvasWorkerLifecycle = 'idle' | 'initializing' | 'ready' | 'released';

interface CanvasWorkerDebugSnapshot {
  ownerId: string | null;
  lifecycle: CanvasWorkerLifecycle;
  sequenceLength: number | null;
  startedAt: number | null;
  workerConstructedAt: number | null;
  pingSentAt: number | null;
  pongAt: number | null;
  initPostedAt: number | null;
  readyAt: number | null;
  releasedAt: number | null;
  timeoutAt: number | null;
  errorAt: number | null;
  errorMessage: string | null;
  messageErrorAt: number | null;
  workerUrl: string | null;
}

interface CanvasWorkerReleaseReceipt {
  ownerId: string;
  releasedAt: number;
}

type CanvasWorkerDiagnosticWindow = Window & {
  __canvasWorkerDebug?: CanvasWorkerDebugSnapshot;
  __canvasWorkerReleaseReceipts?: readonly CanvasWorkerReleaseReceipt[];
};

let canvasWorkerOwnerSequence = 0;
const MAX_CANVAS_WORKER_RELEASE_RECEIPTS = 32;

function allocateCanvasWorkerOwnerId(): string {
  canvasWorkerOwnerSequence += 1;
  return `canvas-worker-${canvasWorkerOwnerSequence}`;
}

function publishCanvasWorkerReleaseReceipt(ownerId: string, releasedAt: number): void {
  if (typeof window === 'undefined' || !DEV_TELEMETRY) return;
  const diagnosticWindow: CanvasWorkerDiagnosticWindow = window;
  const prior = diagnosticWindow.__canvasWorkerReleaseReceipts ?? [];
  diagnosticWindow.__canvasWorkerReleaseReceipts = [
    ...prior.filter((receipt) => receipt.ownerId !== ownerId),
    { ownerId, releasedAt },
  ].slice(-MAX_CANVAS_WORKER_RELEASE_RECEIPTS);
}

const DEV_TELEMETRY: boolean = import.meta.env.DEV === true || import.meta.env.MODE === 'test';

function shouldCollectDrawnRowDiagnostics(): boolean {
  if (typeof window === 'undefined') return false;
  return canvasTestWindow(window).__canvasDrawnRowDiagnostics === true;
}

function shouldForceMainThreadCanvas(): boolean {
  if (typeof window === 'undefined') return false;

  return canvasTestWindow(window).__forceMainThreadCanvas === true;
}

function publishDrawnRowsSnapshot(
  source: DrawnRowSource,
  viewport: { scrollTop: number; height: number },
  rows: DrawnRowDiagnostic[]
): void {
  if (typeof window === 'undefined' || !DEV_TELEMETRY) return;
  const snapshot: CanvasDrawnRowsSnapshot = {
    t: performance.now(),
    source,
    scrollTop: viewport.scrollTop,
    height: viewport.height,
    rows,
  };
  canvasTestWindow(window).__canvasLastDrawnRows = snapshot;
}

export function useCanvasWorkerDraw(params: UseCanvasWorkerDrawParams): void {
  const {
    viewportElementRef,
    onViewportPresented,
    scrollEndHeadroom,
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
    layout: preparedLayout,
    presentedLayout,
    onPaintLayoutPresented,
    onOrfsPresented,
    canvasSurfaceWidth,
    reservedViewportHeight,
    config,
    precomputedLinePositions: preparedLinePositions,
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
    coordinateSpace,
    junctionIndicators,
    orfs,
    orfRenderStateInput,
    annotationRenderStateInput,
    rulerDecorations,
    changedAnnotationNames,
    searchHighlights,
    activeSearchIndex,
    highlightedRange,
    isDark,
    hoveredPrimerId,
    selectedPrimerId,
    scrollDrawRef,
    hasPendingZoomFrame,
    previewCDS,
  } = params;
  const layout = useMemo(() => {
    if (
      !presentedLayout ||
      presentedLayout === preparedLayout ||
      !config.linearWrapPhase ||
      !config.showTranslation ||
      config.cdsDetailProgress === undefined
    )
      return preparedLayout;
    const displayed = new Map(presentedLayout.lines.map((row) => [row.lineIndex, row]));

    return preparedLayout.lines.some(
      (row) =>
        row.classifiedCDSs?.length &&
        displayed.has(row.lineIndex) &&
        Math.abs((displayed.get(row.lineIndex)?.xOffset ?? 0) - (row.xOffset ?? 0)) > 0.001
    )
      ? presentedLayout
      : preparedLayout;
  }, [
    preparedLayout,
    presentedLayout,
    config.linearWrapPhase,
    config.showTranslation,
    config.cdsDetailProgress,
  ]);
  const precomputedLinePositions = useMemo(() => {
    if (layout === preparedLayout) return preparedLinePositions;

    const displayed = new Map(layout.lines.map((row) => [row.lineIndex, row]));
    return preparedLinePositions.map((position) => ({
      ...position,
      line: displayed.get(position.line.lineIndex) ?? position.line,
    }));
  }, [layout, preparedLayout, preparedLinePositions]);
  const presentedLayoutRef = useRef(presentedLayout ?? layout);
  presentedLayoutRef.current = presentedLayout ?? layout;
  const sceneLayoutRef = useRef<LayoutSnapshot2D | null>(null);
  const sceneSequenceRef = useRef<string | null>(null);
  const sceneConfigRef = useRef<WorkspaceEditorConfig | null>(null);
  const sceneScrollTopRef = useRef(0);
  const workerRenderVersionRef = useRef(0);
  const workerPresentationVersionRef = useRef(0);
  const pendingWorkerSceneRef = useRef(false);
  const pendingWorkerSceneSubmitRef = useRef<(() => void) | null>(null);
  const workerSceneRef = useRef<{
    layout: LayoutSnapshot2D;
    version: number;
    sequence: string;
    config: WorkspaceEditorConfig;
    onPaintLayoutPresented: typeof onPaintLayoutPresented;
    onViewportPresented: typeof onViewportPresented;
  } | null>(null);
  const workerPresentedLayoutRef = useRef<{
    layout: LayoutSnapshot2D;
    onOrfsPresented: OrfPresentation['presented'] | undefined;
    onPaintLayoutPresented: typeof onPaintLayoutPresented;
    onViewportPresented: typeof onViewportPresented;
  } | null>(null);
  const workerPresentationFramesRef = useRef(
    new Map<
      number,
      {
        scene: LayoutSnapshot2D;
        presented: LayoutSnapshot2D;
        renderVersion: number;
        sequence: string;
        config: WorkspaceEditorConfig;
        onOrfsPresented?: OrfPresentation['presented'];
        onPaintLayoutPresented: typeof onPaintLayoutPresented;
        onViewportPresented: typeof onViewportPresented;
        viewport: SequenceViewportPresentation['viewport'] | null;
        emptyOrfModel: boolean;
      }
    >()
  );
  const captureViewport = (
    viewport = viewportRef.current
  ): SequenceViewportPresentation['viewport'] => {
    const element = viewportElementRef?.current;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    return {
      scrollTop: viewport.scrollTop,
      height: viewport.height,
      domScrollTop: element?.scrollTop ?? 0,
      scrollLeft: element?.scrollLeft ?? 0,
      width: element?.clientWidth ?? 0,
      visibleHeight: element?.clientHeight ?? 0,
      canvasWidth: (canvas?.width ?? 0) / dpr,
      canvasHeight: (canvas?.height ?? 0) / dpr,
      visible:
        !!element?.isConnected &&
        !!canvas?.isConnected &&
        element.clientWidth > 0 &&
        element.clientHeight > 0 &&
        document.visibilityState === 'visible' &&
        getComputedStyle(element).visibility !== 'hidden',
    };
  };
  const rememberWorkerPresentation = (
    scene: LayoutSnapshot2D,
    presented: LayoutSnapshot2D,
    renderVersion: number,
    paintConfig: WorkspaceEditorConfig = config
  ): number => {
    const version = ++workerPresentationVersionRef.current;
    const frames = workerPresentationFramesRef.current;
    const viewportPresented =
      scene === layout
        ? onViewportPresented
        : workerSceneRef.current?.layout === scene
          ? workerSceneRef.current.onViewportPresented
          : undefined;
    frames.set(version, {
      onViewportPresented: viewportPresented,
      sequence:
        scene === layout ? fullSequence : (workerSceneRef.current?.sequence ?? fullSequence),
      viewport: viewportPresented ? captureViewport() : null,
      scene,
      presented,
      renderVersion,
      config: paintConfig,
      onOrfsPresented: scene === layout ? onOrfsPresented : undefined,
      onPaintLayoutPresented:
        scene === layout
          ? onPaintLayoutPresented
          : workerSceneRef.current?.layout === scene
            ? workerSceneRef.current.onPaintLayoutPresented
            : undefined,
      emptyOrfModel: !orfs?.length,
    });
    if (frames.size > 128) frames.delete(frames.keys().next().value!);
    return version;
  };
  const acknowledgeWorkerPresentation = (
    renderVersion?: number,
    presentationVersion?: number,
    orfsDrawn = false
  ) => {
    if (presentationVersion === undefined) return;
    const frame = workerPresentationFramesRef.current.get(presentationVersion);
    if (frame && frame.renderVersion === renderVersion) {
      reportOrfPaint(frame.onOrfsPresented, frame.emptyOrfModel, orfsDrawn, 'sequence_canvas');
      frame.onPaintLayoutPresented?.(frame.scene, frame.presented, performance.now(), frame.config);
      if (frame.viewport)
        frame.onViewportPresented?.({
          sequence: frame.sequence,
          scene: frame.scene,
          presented: frame.presented,
          config: frame.config,
          viewport: frame.viewport,
        });
    }
  };

  const [workerState, setWorkerState] = useState<Worker | false | null>(null);

  const canvasTransferredRef = useRef(false);

  const initDoneRef = useRef(false);
  const pendingWorkerRef = useRef<Worker | null>(null);
  const workerInstanceRef = useRef<Worker | null>(null);
  const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teardownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workerOwnerIdsRef = useRef(new WeakMap<Worker, string>());
  const workerDebugRef = useRef<CanvasWorkerDebugSnapshot>({
    ownerId: null,
    lifecycle: 'idle',
    sequenceLength: null,
    startedAt: null,
    workerConstructedAt: null,
    pingSentAt: null,
    pongAt: null,
    initPostedAt: null,
    readyAt: null,
    releasedAt: null,
    timeoutAt: null,
    errorAt: null,
    errorMessage: null,
    messageErrorAt: null,
    workerUrl: null,
  });

  const publishWorkerDebug = () => {
    if (typeof window === 'undefined' || !DEV_TELEMETRY) return;
    const diagnosticWindow: CanvasWorkerDiagnosticWindow = window;
    diagnosticWindow.__canvasWorkerDebug = { ...workerDebugRef.current };
  };

  const patchWorkerDebug = (patch: Partial<CanvasWorkerDebugSnapshot>) => {
    Object.assign(workerDebugRef.current, patch);
    publishWorkerDebug();
  };

  const onWorkerTerminatedRef = useRef<((worker: Worker) => void) | null>(null);
  onWorkerTerminatedRef.current = (worker) => {
    const ownerId = workerOwnerIdsRef.current.get(worker);
    if (!ownerId || workerDebugRef.current.ownerId !== ownerId) return;
    const releasedAt = performance.now();
    patchWorkerDebug({ lifecycle: 'released', releasedAt });
    publishCanvasWorkerReleaseReceipt(ownerId, releasedAt);
  };
  useStrictModeSafeWorkerLifetime({
    pendingWorkerRef,
    workerInstanceRef,
    initTimeoutRef,
    teardownTimeoutRef,
    onWorkerTerminatedRef,
  });

  const lastSequenceRef = useRef<string>('');
  const renderModeReasonRef = useRef('pending-init');

  useEffect(() => {
    if (typeof window === 'undefined' || !DEV_TELEMETRY) return;
    canvasTestWindow(window).__canvasRenderMode =
      workerState === false
        ? 'main'
        : workerState && typeof workerState === 'object'
          ? 'worker'
          : 'initializing';
    canvasTestWindow(window).__canvasRenderModeReason =
      workerState && typeof workerState === 'object' ? 'worker-ready' : renderModeReasonRef.current;
    publishWorkerDebug();
  }, [workerState]);

  useEffect(() => {
    if (typeof window === 'undefined' || !shouldExposeCanvasDiagnosticsSurface()) return;
    const w = canvasTestWindow(window);
    const rowOracle = (lineIndices: number[]): DrawnRowDiagnostic[] => {
      if (!Array.isArray(lineIndices) || lineIndices.length === 0) return [];
      const requested = new Set(lineIndices);
      const selected: PrecomputedLinePosition[] = [];
      for (let i = 0; i < precomputedLinePositions.length; i++) {
        const linePosition = precomputedLinePositions[i];
        if (requested.has(linePosition.line.lineIndex)) selected.push(linePosition);
      }
      return summarizeDrawnRows(selected, {
        showAnnotations: config.showAnnotations,
        showReverseComplement:
          config.showReverseComplement &&
          !config.overviewLod &&
          config.lodLevel !== 'feature' &&
          config.lodLevel !== 'density',
        showTranslation: config.showTranslation,
      });
    };
    w.__canvasRowOracle = rowOracle;
    const arrowOracle = () => renderedCdsExtensionArrowsRef.current.map((a) => ({ ...a }));
    w.__cdsExtensionArrows = arrowOracle;
    const translationCellOracle = () => {
      const cells: Array<{
        lineIndex: number;
        startPos: number;
        endPos: number;
        codon: string;
        aa: string;
        visibleStart: number;
        visibleEnd: number;
      }> = [];
      for (const [lineIndex, codons] of lineCodonsCacheRef.current) {
        for (const codon of codons) {
          cells.push({
            lineIndex,
            startPos: codon.startPos,
            endPos: codon.endPos,
            codon: codon.codon,
            aa: codon.aa,
            visibleStart: codon.visibleStart,
            visibleEnd: codon.visibleEnd,
          });
        }
      }
      return cells;
    };
    w.__canvasTranslationCells = translationCellOracle;
    return () => {
      if (w.__canvasRowOracle === rowOracle) {
        delete w.__canvasRowOracle;
      }
      if (w.__cdsExtensionArrows === arrowOracle) {
        delete w.__cdsExtensionArrows;
      }
      if (w.__canvasTranslationCells === translationCellOracle) {
        delete w.__canvasTranslationCells;
      }
    };
  }, [
    renderedCdsExtensionArrowsRef,
    precomputedLinePositions,
    config.showAnnotations,
    config.showReverseComplement,
    config.overviewLod,
    config.lodLevel,
    config.showTranslation,
    lineCodonsCacheRef,
  ]);

  const culledLinesCache = useRef<PrecomputedLinePosition[]>([]);
  const workerViewportLinesCache = useRef<PrecomputedLinePosition[]>([]);
  const workerViewportRequestSeqRef = useRef(0);
  const workerViewportPostSeqRef = useRef(0);
  const workerStateRef = useRef<Worker | false | null>(workerState);
  const selectionOverlayDirtyRef = useRef(false);

  const pendingMainDrawRef = useRef(false);
  const pendingLayoutPaintRef = useRef(false);
  const queueMainLayoutPaint = useCallback(() => {
    pendingMainDrawRef.current = true;
    if (pendingLayoutPaintRef.current) return;
    pendingLayoutPaintRef.current = true;
    queueMicrotask(() => {
      pendingLayoutPaintRef.current = false;
      if (!pendingMainDrawRef.current) return;
      pendingMainDrawRef.current = false;
      if (pendingWorkerSceneRef.current) pendingWorkerSceneSubmitRef.current?.();
      else drawFnRef.current?.();
    });
  }, [drawFnRef]);
  const viewportHeight = viewportRef.current.height;
  useLayoutEffect(() => {
    if (viewportHeight > 0) queueMainLayoutPaint();
  }, [viewportHeight, queueMainLayoutPaint]);

  const layoutRef = useRef(layout);
  const reservedViewportHeightRef = useRef(reservedViewportHeight);
  reservedViewportHeightRef.current = reservedViewportHeight;
  const canvasSurfaceWidthRef = useRef(canvasSurfaceWidth ?? layout.totalWidth);
  const precomputedLinePositionsRef = useRef(precomputedLinePositions);
  precomputedLinePositionsRef.current = precomputedLinePositions;
  workerStateRef.current = workerState;
  layoutRef.current = layout;
  canvasSurfaceWidthRef.current = canvasSurfaceWidth ?? layout.totalWidth;

  useLayoutEffect(
    () => () => {
      if (drawRafRef.current !== null) cancelAnimationFrame(drawRafRef.current);
      drawRafRef.current = null;
      drawFnRef.current = null;
      pendingMainDrawRef.current = false;
      pendingLayoutPaintRef.current = false;
      pendingWorkerSceneRef.current = false;
      pendingWorkerSceneSubmitRef.current = null;
    },
    [drawRafRef, drawFnRef]
  );

  const postWorkerViewport = (
    worker: Worker,
    scrollTop: number,
    height: number,
    reason: WorkerViewportReason
  ): void => {
    if (pendingWorkerSceneRef.current || workerSceneRef.current?.layout !== layoutRef.current) {
      queueMainLayoutPaint();
      return;
    }
    const preparedPositions = precomputedLinePositionsRef.current;
    if (!hasPreparedViewport(layoutRef.current, preparedPositions, scrollTop, height)) return;
    const requestSeq = ++workerViewportRequestSeqRef.current;
    const queuedAt = performance.now();

    diag.capture({
      type: 'worker-viewport-request',
      requestSeq,
      scrollTop,
      height,
      reason,
    });

    const now = performance.now();
    const viewportSeq = ++workerViewportPostSeqRef.current;
    const workerScene = workerSceneRef.current;
    const presented = presentedLayoutRef.current;
    const presentationVersion =
      workerScene && workerScene.layout === layoutRef.current
        ? rememberWorkerPresentation(
            workerScene.layout,
            presented,
            workerScene.version,
            workerScene.config
          )
        : undefined;
    const viewportLinePositions = workerViewportLinesCache.current;
    if (height > 0) {
      cullLinesToViewport(preparedPositions, scrollTop, height, viewportLinePositions);
    } else {
      viewportLinePositions.length = 0;
    }
    const viewportPostStart = performance.now();
    worker.postMessage({
      type: 'viewport',
      canvasHeight: parseFloat(selectionCanvasRef.current?.style.height ?? '') || undefined,
      renderVersion: workerScene?.version,
      presentationVersion,
      presentationBands:
        presentationVersion !== undefined
          ? horizontalPresentationBands(workerScene!.layout, presented, scrollTop, height)
          : undefined,
      dpr: window.devicePixelRatio || 1,
      scrollTop,
      height,
      viewportLinePositions,
      viewportSeq,
      viewportRequestSeq: requestSeq,
      viewportSentAt: now,
      viewportReason: reason,
      collectDrawnRowDiagnostics: shouldCollectDrawnRowDiagnostics(),
      collectProfile:
        typeof window !== 'undefined' && canvasTestWindow(window).__diag?.enabled === true,
      highlightedRange: liveSelectionRef.current ?? highlightedRangeRef.current,
      viewCursor: viewCursorRef.current,
    } as MainToWorkerMessage);
    const viewportPostMs = performance.now() - viewportPostStart;
    diag.capture({
      type: 'marker',
      label: 'worker-viewport-post-cost',
      data: {
        requestSeq,
        viewportSeq,
        reason,
        durMs: viewportPostMs,
        visibleLineCount: viewportLinePositions.length,
      },
    });
    diag.capture({
      type: 'worker-viewport-post',
      requestSeq,
      viewportSeq,
      scrollTop,
      height,
      reason,
      queueDelayMs: now - queuedAt,
    });
  };
  const postWorkerViewportRef = useRef(postWorkerViewport);
  postWorkerViewportRef.current = postWorkerViewport;
  const hasPendingZoomFrameRef = useRef(hasPendingZoomFrame);
  hasPendingZoomFrameRef.current = hasPendingZoomFrame;

  useLayoutEffect(() => {
    if (!scrollDrawRef) return;

    const drawQueuedFrame = () => {
      drawRafRef.current = null;
      if (pendingMainDrawRef.current && hasPendingZoomFrameRef.current?.()) {
        drawRafRef.current = requestAnimationFrame(drawQueuedFrame);
        return;
      }
      const doMainDraw = pendingMainDrawRef.current;
      pendingMainDrawRef.current = false;
      if (doMainDraw) drawFnRef.current?.();
      const liveSel = liveSelectionRef.current ?? selectionRef.current;
      const liveHoverCursor = hoverCursorRef.current;
      const liveHasCursor = cursorRef.current !== undefined && cursorVisibleRef.current;
      const liveHasOverlayContent = liveSel !== null || liveHoverCursor !== null || liveHasCursor;
      if (liveHasOverlayContent || selectionOverlayDirtyRef.current) {
        drawSelectionAndCursorRef.current(
          liveSel ?? null,
          cursorRef.current,
          cursorVisibleRef.current,
          insertedRangesRef.current,
          deletedRangesRef.current,
          liveHoverCursor
        );
      }
      selectionOverlayDirtyRef.current = liveHasOverlayContent;
    };

    const drawSelectionOverlay = (includeMainDraw: boolean) => {
      const sel = liveSelectionRef.current ?? selectionRef.current;
      const hoverCursor = hoverCursorRef.current;
      const hasCursor = cursorRef.current !== undefined && cursorVisibleRef.current;
      const hasOverlayContent = sel !== null || hoverCursor !== null || hasCursor;
      if (!includeMainDraw && !hasOverlayContent && !selectionOverlayDirtyRef.current) {
        return;
      }

      if (includeMainDraw) pendingMainDrawRef.current = true;

      if (drawRafRef.current) return;
      drawRafRef.current = requestAnimationFrame(drawQueuedFrame);
    };

    const handleScrollDraw = (scrollTop: number, height: number, paintNow = false) => {
      viewportRef.current = { scrollTop, height };
      const worker = workerStateRef.current;
      const renderMode =
        worker && typeof worker === 'object'
          ? 'worker'
          : worker === false
            ? 'main'
            : 'initializing';
      if (
        worker &&
        typeof worker === 'object' &&
        shouldSyncViewportCanvasSizesDuringScroll(renderMode)
      ) {
        const currentLayout = layoutRef.current;
        const sizing = syncViewportCanvasSizes({
          mainCanvas: canvasRef.current,
          selectionCanvas: selectionCanvasRef.current,
          width: canvasSurfaceWidthRef.current,
          reservedViewportHeight: reservedViewportHeightRef.current,
          viewportHeight: height,
          totalHeight: currentLayout.totalHeight,
          dpr: window.devicePixelRatio || 1,
          mainCanvasTransferred: canvasTransferredRef.current,
        });
        if (sizing.selectionResized) {
          canvasDimensionsRef.current = {
            width: sizing.backingWidth,
            height: sizing.backingHeight,
          };
          canvasRectRef.current = null;
          selectionOverlayDirtyRef.current = true;
        }
        postWorkerViewportRef.current(worker, scrollTop, height, 'scroll');
        drawSelectionOverlay(false);
        return;
      }

      const currentLayout = layoutRef.current;
      const mainCanvasHeight = canvasRef.current?.clientHeight ?? 0;
      const expectedCanvasHeight = viewportCanvasHeight(
        height,
        currentLayout.totalHeight,
        mainCanvasHeight,
        reservedViewportHeightRef.current
      );
      if (height <= 0 || expectedCanvasHeight <= 0) {
        pendingMainDrawRef.current = false;
        if (drawRafRef.current !== null) {
          cancelAnimationFrame(drawRafRef.current);
          drawRafRef.current = null;
        }
        return;
      }
      const selectionCanvasHeight = selectionCanvasRef.current?.clientHeight ?? 0;
      const hasViewportHeightResize =
        Math.abs(mainCanvasHeight - expectedCanvasHeight) > 1 ||
        Math.abs(selectionCanvasHeight - expectedCanvasHeight) > 1;
      if (hasViewportHeightResize && drawFnRef.current) {
        pendingMainDrawRef.current = false;
        if (drawRafRef.current !== null) {
          cancelAnimationFrame(drawRafRef.current);
          drawRafRef.current = null;
        }
        drawFnRef.current();
        return;
      }

      if (paintNow && drawFnRef.current) {
        if (drawRafRef.current !== null) cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
        pendingMainDrawRef.current = true;
        drawQueuedFrame();
        return;
      }

      drawSelectionOverlay(true);
    };

    scrollDrawRef.current = handleScrollDraw;
    return () => {
      if (scrollDrawRef.current === handleScrollDraw) {
        scrollDrawRef.current = null;
      }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollDrawRef]);

  const WORKER_THRESHOLD = 100_000;

  useEffect(() => {
    patchWorkerDebug({ startedAt: performance.now(), sequenceLength });

    if (initDoneRef.current) {
      if (workerInstanceRef.current) {
        setWorkerState(workerInstanceRef.current);
      }
      return;
    }
    initDoneRef.current = true;

    const canvas = canvasRef.current;
    if (!canvas) {
      renderModeReasonRef.current = 'canvas-missing';
      setWorkerState(false);
      return;
    }

    if (sequenceLength < WORKER_THRESHOLD) {
      renderModeReasonRef.current = 'sequence-below-threshold';
      setWorkerState(false);
      return;
    }

    if (getComputedStyle(canvas).getPropertyValue('-webkit-font-smoothing') === 'antialiased') {
      renderModeReasonRef.current = 'native-font-rendering';
      setWorkerState(false);
      return;
    }

    if (shouldForceMainThreadCanvas()) {
      renderModeReasonRef.current = 'forced-main-thread-diagnostic';
      setWorkerState(false);
      return;
    }

    if (
      typeof OffscreenCanvas === 'undefined' ||
      typeof canvas.transferControlToOffscreen !== 'function' ||
      !shouldAttemptCanvasWorker()
    ) {
      renderModeReasonRef.current =
        typeof OffscreenCanvas === 'undefined'
          ? 'offscreen-canvas-unavailable'
          : 'transfer-control-unavailable';
      setWorkerState(false);
      return;
    }

    let worker: Worker | null = null;
    const failWorkerInitialization = (
      failedWorker: Worker,
      reason: 'worker-init-error' | 'worker-init-exception' | 'worker-init-timeout',
      error?: unknown
    ): void => {
      if (error !== undefined) {
        patchWorkerDebug({
          errorAt: performance.now(),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      terminateOwnedWorker(failedWorker, {
        pendingWorkerRef,
        workerInstanceRef,
        initTimeoutRef,
        teardownTimeoutRef,
      });
      recoverTransferredCanvasForFallback(
        { canvasTransferredRef, initDoneRef },
        remountTransferredCanvas
      );
      renderModeReasonRef.current = reason;
      setWorkerState(false);
    };

    try {
      worker = new CanvasRenderWorker();
      const initializingWorker = worker;
      const ownerId = allocateCanvasWorkerOwnerId();
      workerOwnerIdsRef.current.set(initializingWorker, ownerId);
      pendingWorkerRef.current = initializingWorker;
      patchWorkerDebug({
        ownerId,
        lifecycle: 'initializing',
        workerConstructedAt: performance.now(),
        readyAt: null,
        releasedAt: null,
        workerUrl: 'vite-inline-worker',
      });

      initializingWorker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
        if (
          pendingWorkerRef.current !== initializingWorker &&
          workerInstanceRef.current !== initializingWorker
        ) {
          return;
        }
        const msg = event.data;
        switch (msg.type) {
          case 'pong': {
            patchWorkerDebug({ pongAt: performance.now() });

            if (initTimeoutRef.current) {
              clearTimeout(initTimeoutRef.current);
              initTimeoutRef.current = null;
            }
            try {
              const offscreen = canvas.transferControlToOffscreen();
              canvasTransferredRef.current = true;
              const dpr = window.devicePixelRatio || 1;
              const theme = resolveCanvasTheme();
              initializingWorker.postMessage(
                { type: 'init', canvas: offscreen, dpr, theme } as MainToWorkerMessage,
                [offscreen]
              );
              patchWorkerDebug({ initPostedAt: performance.now() });
              initTimeoutRef.current = setTimeout(() => {
                if (pendingWorkerRef.current !== initializingWorker) return;
                console.warn('[canvas-worker] Worker ready timeout (1s), falling back');
                patchWorkerDebug({ timeoutAt: performance.now() });
                failWorkerInitialization(initializingWorker, 'worker-init-timeout');
              }, 1000);
            } catch (error) {
              failWorkerInitialization(initializingWorker, 'worker-init-exception', error);
            }
            break;
          }
          case 'ready':
            if (canvasRef.current) {
              canvasRef.current.dataset.renderer = 'webgl2';
              canvasRef.current.dataset.renderStatus = 'ready';
            }
            if (initTimeoutRef.current) {
              clearTimeout(initTimeoutRef.current);
              initTimeoutRef.current = null;
            }
            patchWorkerDebug({ lifecycle: 'ready', readyAt: performance.now() });
            pendingWorkerRef.current = null;
            workerInstanceRef.current = initializingWorker;
            setWorkerState(initializingWorker);
            break;
          case 'gpu-status': {
            const surface = canvasRef.current;
            if (surface) {
              surface.dataset.renderStatus = msg.status;
              surface.dispatchEvent(
                new CustomEvent('sequence-render-status', { bubbles: true, detail: msg.status })
              );
            }
            if (msg.status === 'error')
              failWorkerInitialization(initializingWorker, 'worker-init-error');
            break;
          }
          case 'render-complete': {
            acknowledgeWorkerPresentation(
              msg.renderVersion,
              msg.presentationVersion,
              msg.result.orfsDrawn === true
            );
            for (const update of msg.cdsPillBounds ?? []) {
              const line = precomputedLinePositionsRef.current.find(
                (lp) => lp.line.lineIndex === update.lineIndex
              )?.line;
              if (!line || line.startPos !== update.startPos || line.endPos !== update.endPos)
                continue;
              for (const bounds of update.cds) {
                const cds = line.classifiedCDSs?.find(
                  (c) =>
                    c.start === bounds.start &&
                    c.end === bounds.end &&
                    c.translationLane === bounds.translationLane
                );
                if (cds) {
                  cds._exonPillBounds = bounds._exonPillBounds;
                  cds._cdsPillBounds = bounds._cdsPillBounds;
                  cds._cdsLineBounds = bounds._cdsLineBounds;
                  cds._intronPillBounds = bounds._intronPillBounds;
                  cds._paintedPresentation = bounds._paintedPresentation;
                  cds._interactionOutlineContours = bounds._interactionOutlineContours;
                }
              }
            }
            if (canvasRef.current && msg.gpu) {
              canvasRef.current.dataset.gpuDrawCalls = String(msg.gpu.drawCalls);
              canvasRef.current.dataset.gpuVertices = String(msg.gpu.vertices);
              canvasRef.current.dataset.renderStatus = 'ready';
            }
            renderedPrimersRef.current = msg.result.renderedPrimers;
            renderedGGLabelsRef.current = msg.result.renderedGGLabels;
            renderedCutSitesRef.current = msg.result.renderedCutSites;
            renderedCdsExtensionArrowsRef.current = msg.result.renderedCdsExtensionArrows ?? [];
            for (const [lineIndex, codons] of msg.result.lineCodonUpdates) {
              lineCodonsCacheRef.current.set(lineIndex, codons);
            }
            const viewportLatencyMs =
              typeof msg.viewportSentAt === 'number'
                ? performance.now() - msg.viewportSentAt
                : undefined;
            if (typeof msg.viewportSeq === 'number') {
              diag.capture({
                type: 'worker-viewport-complete',
                requestSeq: msg.viewportRequestSeq,
                viewportSeq: msg.viewportSeq,
                scrollTop: msg.scrollTop ?? viewportRef.current.scrollTop,
                height: msg.height ?? viewportRef.current.height,
                reason: msg.viewportReason,
                latencyMs: viewportLatencyMs,
                durMs: msg.durMs ?? msg.renderMs ?? 0,
                cullMs: msg.cullMs ?? 0,
                renderMs: msg.renderMs ?? 0,
                visibleLineCount: msg.visibleLineCount,
              });
            }
            diag.capture({
              type: 'render-frame',
              durMs: msg.durMs ?? msg.renderMs ?? 0,
              layoutMs: msg.cullMs ?? 0,
              drawMs: msg.renderMs ?? 0,
              source: 'worker',
              visibleLineCount: msg.visibleLineCount,
              visibleAnnotationCount: msg.profile?.visibleAnnotationCount,
              annotationsMs: msg.profile?.annotationsMs,
              sequenceMs: msg.profile?.sequenceMs,
              complementMs: msg.profile?.complementMs,
              otherMs: msg.profile?.otherMs,
              backgroundMs: msg.profile?.backgroundMs,
              translationMs: msg.profile?.translationMs,
              rulerMs: msg.profile?.rulerMs,
              viewportSeq: msg.viewportSeq,
              viewportRequestSeq: msg.viewportRequestSeq,
              viewportLatencyMs,
              viewportReason: msg.viewportReason,
              scrollTop: msg.scrollTop,
              height: msg.height,
            });
            if (msg.drawnRows) {
              publishDrawnRowsSnapshot('worker', viewportRef.current, msg.drawnRows);
            }

            if (typeof window !== 'undefined' && DEV_TELEMETRY) {
              canvasTestWindow(window).__lastCanvasRenderTime = performance.now();
            }
            break;
          }
          case 'present-complete': {
            acknowledgeWorkerPresentation(
              msg.renderVersion,
              msg.presentationVersion,
              msg.orfsDrawn === true
            );
            if (typeof window !== 'undefined' && DEV_TELEMETRY)
              canvasTestWindow(window).__lastCanvasRenderTime = performance.now();
            break;
          }
          case 'error':
            console.error('[canvas-worker] Error:', msg.message, msg.stack);
            patchWorkerDebug({
              errorAt: performance.now(),
              errorMessage: msg.stack ? `${msg.message}\n${msg.stack}` : msg.message,
            });
            if (
              pendingWorkerRef.current === initializingWorker ||
              workerInstanceRef.current === initializingWorker
            ) {
              failWorkerInitialization(initializingWorker, 'worker-init-error');
            }
            break;
        }
      };

      initializingWorker.onerror = (err: ErrorEvent) => {
        console.error('[canvas-worker] Worker error:', err);
        const errDetails = [err.message, err.filename, err.lineno, err.colno]
          .filter((value) => value !== undefined && value !== null && value !== '')
          .join(' | ');
        patchWorkerDebug({
          errorAt: performance.now(),
          errorMessage: errDetails || 'Worker error event',
        });
        if (
          pendingWorkerRef.current === initializingWorker ||
          workerInstanceRef.current === initializingWorker
        ) {
          failWorkerInitialization(initializingWorker, 'worker-init-error');
        }
      };

      initializingWorker.onmessageerror = () => {
        patchWorkerDebug({
          messageErrorAt: performance.now(),
          errorMessage: 'Worker messageerror event',
        });
        if (
          pendingWorkerRef.current === initializingWorker ||
          workerInstanceRef.current === initializingWorker
        ) {
          failWorkerInitialization(initializingWorker, 'worker-init-error');
        }
      };

      initializingWorker.postMessage({
        type: 'ping',
        fontSources: getSequenceFontSources(),
      } as MainToWorkerMessage);
      patchWorkerDebug({ pingSentAt: performance.now() });

      initTimeoutRef.current = setTimeout(() => {
        if (!workerInstanceRef.current) {
          console.warn('[canvas-worker] Worker init timeout (1s), falling back');

          patchWorkerDebug({ timeoutAt: performance.now() });
          failWorkerInitialization(initializingWorker, 'worker-init-timeout');
        }
      }, 1000);
    } catch (err) {
      console.warn('[canvas-worker] Failed to init:', err);
      if (worker) failWorkerInitialization(worker, 'worker-init-exception', err);
      else {
        renderModeReasonRef.current = 'worker-init-exception';
        setWorkerState(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (typeof workerState !== 'object' || workerState === null) return;
    const worker = workerState;
    const canvas = canvasRef.current;
    pendingWorkerSceneRef.current = true;

    const postScene = () => {
      const vp = viewportRef.current;
      if (!hasPreparedViewport(layout, precomputedLinePositions, vp.scrollTop, vp.height)) return;
      const sizing = syncViewportCanvasSizes({
        mainCanvas: canvas,
        selectionCanvas: selectionCanvasRef.current,
        width: canvasSurfaceWidth ?? layout.totalWidth,
        reservedViewportHeight,
        viewportHeight: vp.height,
        totalHeight: layout.totalHeight,
        dpr: window.devicePixelRatio || 1,
        mainCanvasTransferred: canvasTransferredRef.current,
      });
      if (sizing.selectionResized) {
        canvasDimensionsRef.current = {
          width: sizing.backingWidth,
          height: sizing.backingHeight,
        };
        canvasRectRef.current = null;
      }

      const viewportLinePositions = workerViewportLinesCache.current;
      if (vp.height > 0) {
        cullLinesToViewport(
          precomputedLinePositions,
          vp.scrollTop,
          vp.height,
          viewportLinePositions
        );
      } else {
        viewportLinePositions.length = 0;
      }
      const workerLayout = createViewportScopedLayout(layout, viewportLinePositions);
      const renderVersion = ++workerRenderVersionRef.current;
      const presented = presentedLayoutRef.current;
      workerSceneRef.current = {
        layout,
        version: renderVersion,
        sequence: fullSequence,
        config,
        onPaintLayoutPresented,
        onViewportPresented,
      };
      workerPresentedLayoutRef.current = {
        layout: presented,
        onOrfsPresented,
        onPaintLayoutPresented,
        onViewportPresented,
      };
      const presentationVersion = rememberWorkerPresentation(layout, presented, renderVersion);
      const renderMsg: WorkerRenderMessage = {
        type: 'render',
        renderVersion,
        presentationVersion,
        presentationBands: horizontalPresentationBands(layout, presented, vp.scrollTop, vp.height),
        viewportLinePositions,
        params: {
          config,
          layout: workerLayout,

          canvasWidth: sizing.cssWidth,
          canvasHeight: sizing.cssHeight,
          sequenceLength,
          fullSequence,
          cutSites,
          scannedCutSites,
          primers,
          mutations,
          rulerSegments: rulerSegments ?? [],
          insertedRanges,
          deletedRanges,
          substitutedRanges,
          showCutSites,
          highlightedRange: liveSelectionRef.current ?? highlightedRangeRef.current,
          hoveredCodon,
          selectedCodons,
          geneticCode,
          geneticCodeBasis,
          viewCursor: viewCursorRef.current,
          hoveredCutSite,
          hoveredGGProductLabel,

          hoveredEnzymeName: null,
          hoveredPositionInfo: hoveredPositionInfo ?? null,
          coordinateSpace,
          junctionIndicators,
          viewport: vp,
          precomputedAlignmentCodons: alignmentCodonsCacheRef.current.codonsMap,
          mutationMap: mutationCacheRef.current.map,
          orfs,
          orfRenderStateInput,
          annotationRenderStateInput,
          rulerDecorations,
          searchHighlights,
          activeSearchIndex,
          hoveredPrimerId,
          selectedPrimerId,
          collectProfile:
            typeof window !== 'undefined' && canvasTestWindow(window).__diag?.enabled === true,
        },
        canvasWidth: sizing.cssWidth,
        canvasHeight: sizing.cssHeight,
        dpr: window.devicePixelRatio || 1,
        collectDrawnRowDiagnostics: shouldCollectDrawnRowDiagnostics(),
      };
      const renderPostStart = performance.now();
      worker.postMessage(renderMsg);
      const renderPostMs = performance.now() - renderPostStart;
      diag.capture({
        type: 'marker',
        label: 'worker-render-post-cost',
        data: {
          durMs: renderPostMs,
          fullSequenceLength: fullSequence.length,
          visibleLineCount: viewportLinePositions.length,
          hasHighlight: (liveSelectionRef.current ?? highlightedRangeRef.current) !== null,
        },
      });

      if (fullSequence !== lastSequenceRef.current) {
        lastSequenceRef.current = fullSequence;
        try {
          const { buffer, length } = encodeSequenceToSharedBuffer(fullSequence);
          worker.postMessage({ type: 'sequence-data', buffer, length } as MainToWorkerMessage);
        } catch {}
      }

      const theme = resolveCanvasTheme();
      worker.postMessage({ type: 'theme', theme } as MainToWorkerMessage);
      pendingWorkerSceneRef.current = false;
    };
    pendingWorkerSceneSubmitRef.current = postScene;

    drawFnRef.current = () => {
      if (pendingWorkerSceneRef.current) {
        queueMainLayoutPaint();
        return;
      }
      const v = viewportRef.current;
      postWorkerViewport(worker, v.scrollTop, v.height, 'draw');
    };
    queueMainLayoutPaint();

    return () => {
      if (pendingWorkerSceneSubmitRef.current === postScene) {
        pendingWorkerSceneSubmitRef.current = null;
        pendingWorkerSceneRef.current = false;
      }
      drawFnRef.current = null;
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workerState,
    layout,
    canvasSurfaceWidth,
    reservedViewportHeight,
    scrollEndHeadroom,
    config,
    fullSequence,
    precomputedLinePositions,
    insertedRanges,
    deletedRanges,
    cutSites,
    scannedCutSites,
    showCutSites,
    hoveredCutSite,
    hoveredGGProductLabel,
    hoveredCodon,
    selectedCodons,
    geneticCode,
    geneticCodeBasis,
    orfRenderStateInput,
    annotationRenderStateInput,
    primers,

    hoveredPositionInfo,
    isDark,
    rulerDecorations,
    searchHighlights,
    activeSearchIndex,
    hoveredPrimerId,
    selectedPrimerId,
  ]);

  useLayoutEffect(() => {
    if (typeof workerState !== 'object' || workerState === null) return;
    drawFnRef.current?.();
  }, [workerState, highlightedRange, viewCursor, drawFnRef]);

  useLayoutEffect(() => {
    if (workerState !== false || canvasTransferredRef.current) return;

    const canvas = canvasRef.current;
    const selectionCanvas = selectionCanvasRef.current;
    if (!canvas || !selectionCanvas) return;

    let fpsReportTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDrawTime = 0;
    const frameIntervals: number[] = [];

    let longTaskObserver: PerformanceObserver | null = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 100) {
            console.log(
              `[PERF] LONG TASK: ${entry.duration.toFixed(0)}ms at ${entry.startTime.toFixed(0)} (${entry.name})`
            );
          }
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {}

    let paintedKey: readonly unknown[] | null = null;
    const doDraw = () => {
      if (canvasTransferredRef.current) {
        diag.capture({ type: 'render-frame', durMs: 0, layoutMs: 0, drawMs: 0 });
        return;
      }

      const now = performance.now();
      if (lastDrawTime > 0) frameIntervals.push(now - lastDrawTime);
      lastDrawTime = now;
      const drawStart = now;

      if (fpsReportTimer) clearTimeout(fpsReportTimer);
      fpsReportTimer = setTimeout(() => {
        if (frameIntervals.length > 2) {
          const avg = frameIntervals.reduce((a, b) => a + b, 0) / frameIntervals.length;
          const fps = 1000 / avg;
          const minI = Math.min(...frameIntervals);
          const maxI = Math.max(...frameIntervals);
          const spikes = frameIntervals.filter((i) => i > 100).length;
          console.log(
            `[PERF] FPS: ${fps.toFixed(1)} (${frameIntervals.length} frames) | ` +
              `interval: avg=${avg.toFixed(1)}ms min=${minI.toFixed(1)}ms max=${maxI.toFixed(1)}ms | ` +
              `spikes>100ms: ${spikes}`
          );
          frameIntervals.length = 0;
        }
        fpsReportTimer = null;
      }, 500);

      const c = canvasRef.current;
      if (!c || !c.isConnected) {
        diag.capture({ type: 'render-frame', durMs: 0, layoutMs: 0, drawMs: 0 });
        return;
      }
      const sc = selectionCanvasRef.current;
      if (!sc || !sc.isConnected) {
        diag.capture({ type: 'render-frame', durMs: 0, layoutMs: 0, drawMs: 0 });
        return;
      }

      const vp = viewportRef.current;
      if (!hasPreparedViewport(layout, precomputedLinePositions, vp.scrollTop, vp.height)) return;

      const dpr = window.devicePixelRatio || 1;
      const vpHeight = viewportRef.current.height;
      const virtualH = viewportCanvasHeight(vpHeight, layout.totalHeight);
      if (vpHeight <= 0 || virtualH <= 0) {
        pendingMainDrawRef.current = false;
        diag.capture({ type: 'render-frame', durMs: 0, layoutMs: 0, drawMs: 0 });
        return;
      }

      let didResize = false;
      const sizing = syncViewportCanvasSizes({
        mainCanvas: c,
        selectionCanvas: sc,
        width: canvasSurfaceWidth ?? layout.totalWidth,
        reservedViewportHeight,
        viewportHeight: vpHeight,
        totalHeight: layout.totalHeight,
        dpr,
        mainCanvasTransferred: false,
      });
      if (
        canvasDimensionsRef.current.width !== sizing.backingWidth ||
        canvasDimensionsRef.current.height !== sizing.backingHeight ||
        sizing.mainResized ||
        sizing.selectionResized
      ) {
        canvasDimensionsRef.current = {
          width: sizing.backingWidth,
          height: sizing.backingHeight,
        };
        canvasRectRef.current = null;
        didResize = true;
      }

      const ctx = getSequenceWebGLContext(c, { alpha: false });
      if (!ctx) return;
      ctx.onRestore = () => {
        paintedKey = null;
        drawFnRef.current?.();
      };
      const paintedSelection = liveSelectionRef.current ?? highlightedRangeRef.current;
      const presented = presentedLayoutRef.current;
      const nextPaintKey = [
        c,
        sc,
        ctx,
        vp.scrollTop,
        vp.height,
        dpr,
        presented,
        JSON.stringify(paintedSelection),
        viewCursorRef.current,
        onPaintLayoutPresented,
      ];

      if (!didResize && paintedKey?.every((value, i) => Object.is(value, nextPaintKey[i]))) return;
      if (!ctx.beginFrame()) return;

      const theme = resolveCanvasTheme();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, sizing.cssWidth, virtualH);

      const culledLines = culledLinesCache.current;
      let culledCount = 0;
      if (vp.height > 0) {
        culledCount = cullLinesToViewport(
          precomputedLinePositions,
          vp.scrollTop,
          vp.height,
          culledLines
        );
      }
      culledLines.length = culledCount;
      const linePositions = vp.height > 0 ? culledLines : precomputedLinePositions;

      let precomputedAlignmentCodons: Map<string, AlignmentCodonInfo[]> | undefined;
      if (
        config.showTranslation &&
        coordinateSpace?.mode === 'gapped' &&
        coordinateSpace?.gappedSequence &&
        coordinateSpace?.alignedQuery
      ) {
        const cache = alignmentCodonsCacheRef.current;
        if (
          cache.alignedRef !== coordinateSpace.gappedSequence ||
          cache.alignedQuery !== coordinateSpace.alignedQuery
        ) {
          const newMap = new Map<string, AlignmentCodonInfo[]>();
          const seenCds = new Set<string>();
          for (const { line } of precomputedLinePositions) {
            if (!line.classifiedCDSs) continue;
            for (const cds of line.classifiedCDSs) {
              const cdsKey = cds.name + ':' + cds.start + ':' + cds.end;
              if (seenCds.has(cdsKey)) continue;
              seenCds.add(cdsKey);
              const allCodons = computeAllAlignmentCodons(
                coordinateSpace.gappedSequence,
                coordinateSpace.alignedQuery,
                cds as typeof cds & { startCol?: number; endCol?: number }
              );
              newMap.set(cdsKey, allCodons);
            }
          }
          alignmentCodonsCacheRef.current = {
            alignedRef: coordinateSpace.gappedSequence,
            alignedQuery: coordinateSpace.alignedQuery,
            codonsMap: newMap,
          };
        }
        precomputedAlignmentCodons = alignmentCodonsCacheRef.current.codonsMap;
      }

      const paintedViewport = onViewportPresented ? captureViewport(vp) : null;
      const presentationBands = horizontalPresentationBands(
        layout,
        presented,
        vp.scrollTop,
        vp.height
      );
      ctx.setPresentationShiftBounds(presentationBands, dpr);

      const renderResult = renderSequence(ctx, {
        linePositions,
        config,
        layout,
        canvasWidth: sizing.cssWidth,
        canvasHeight: c.height / dpr,
        sequenceLength,
        fullSequence,
        cutSites,
        scannedCutSites,
        primers,
        mutations,
        rulerSegments: rulerSegments ?? [],
        insertedRanges,
        deletedRanges,
        substitutedRanges,
        showCutSites,
        highlightedRange: paintedSelection,
        hoveredCodon,
        selectedCodons,
        geneticCode,
        geneticCodeBasis,
        viewCursor: viewCursorRef.current,
        hoveredCutSite,
        hoveredGGProductLabel,

        hoveredEnzymeName: null,
        hoveredPositionInfo: hoveredPositionInfo ?? null,
        coordinateSpace,
        junctionIndicators,
        viewport: vp,
        precomputedAlignmentCodons,
        mutationMap: mutationCacheRef.current.map,
        orfs,
        orfRenderStateInput,
        annotationRenderStateInput,
        rulerDecorations,
        changedAnnotationNames,
        searchHighlights,
        activeSearchIndex,
        hoveredPrimerId,
        selectedPrimerId,
        previewCDS,
        collectProfile:
          typeof window !== 'undefined' && canvasTestWindow(window).__diag?.enabled === true,
        capturePresentationBackground: presentationBands.length > 0,
        captureIntronConnectors: shouldCollectDrawnRowDiagnostics(),
      });

      ctx.endFrame();
      if (presentationBands.length > 0) {
        ctx.capturePresentationScene();
        sceneLayoutRef.current = layout;
        sceneSequenceRef.current = fullSequence;
        sceneConfigRef.current = config;
        sceneScrollTopRef.current = vp.scrollTop;
        ctx.presentRows(presentationBands, dpr);
      } else {
        sceneLayoutRef.current = null;
      }
      paintedKey = nextPaintKey;
      if (import.meta.env.DEV === true || import.meta.env.MODE === 'test') {
        canvasTestWindow(window).__mainSelectionPaintObserver?.({
          t: performance.now(),
          selection: paintedSelection ? { ...paintedSelection } : null,
        });
      }
      reportOrfPaint(
        onOrfsPresented,
        !orfs?.length,
        renderResult.orfsDrawn === true,
        'sequence_canvas'
      );
      onPaintLayoutPresented?.(layout, presented, performance.now(), config);
      if (paintedViewport)
        onViewportPresented?.({
          sequence: fullSequence,
          scene: layout,
          presented,
          config,
          viewport: paintedViewport,
        });
      renderedPrimersRef.current = renderResult.renderedPrimers;
      renderedGGLabelsRef.current = renderResult.renderedGGLabels;
      renderedCutSitesRef.current = renderResult.renderedCutSites;
      renderedCdsExtensionArrowsRef.current = renderResult.renderedCdsExtensionArrows;
      for (const [lineIndex, codons] of renderResult.lineCodonUpdates) {
        lineCodonsCacheRef.current.set(lineIndex, codons);
      }

      if (shouldCollectDrawnRowDiagnostics()) {
        const presentedByIndex = new Map(presented.lines.map((row) => [row.lineIndex, row]));
        const paintedPositions = linePositions.map((position) => ({
          ...position,
          line: presentedByIndex.get(position.line.lineIndex) ?? position.line,
        }));
        canvasTestWindow(window).__canvasLastDrawnFrame = {
          t: performance.now(),
          charWidth: config.charWidth,
          topBp: layout.summary?.topBp ?? 0,
          cpr: layout.summary?.cpr ?? config.charsPerLine,
          scrollTop: vp.scrollTop,
          rowBackgroundOffset: config.rowBackgroundOffset ?? 0,
          intronConnectors: renderResult.intronConnectors?.map((stroke) => {
            const source = linePositions.find(
              (position) => position.line.lineIndex === stroke.lineIndex
            )?.line;
            const dx =
              (presentedByIndex.get(stroke.lineIndex)?.xOffset ?? 0) - (source?.xOffset ?? 0);
            return { ...stroke, x1: stroke.x1 + dx, x2: stroke.x2 + dx };
          }),
          rows: paintedPositions.map((lp) => ({
            index: lp.line.lineIndex,
            y: lp.line.y - vp.scrollTop,
            xOffset: lp.line.xOffset ?? 0,
            sequenceY: rowPaintY(lp.line, lp.sequenceY + vp.scrollTop) - vp.scrollTop,
            sequenceHeight: rowPaintBounds(
              lp.line,
              lp.sequenceY + vp.scrollTop,
              config.overviewLod || config.lodLevel === 'density'
                ? Math.max(1, Math.ceil(config.rowHeight))
                : config.rowHeight
            ).height,
          })),
        };
        publishDrawnRowsSnapshot(
          'main',
          vp,
          summarizeDrawnRows(paintedPositions, {
            showAnnotations: config.showAnnotations,
            showReverseComplement:
              config.showReverseComplement &&
              !config.overviewLod &&
              config.lodLevel !== 'feature' &&
              config.lodLevel !== 'density',
            showTranslation: config.showTranslation,
          })
        );
      }

      if (typeof window !== 'undefined' && DEV_TELEMETRY) {
        canvasTestWindow(window).__lastCanvasRenderTime = performance.now();
      }

      if (didResize && drawSelectionAndCursorRef.current) {
        drawSelectionAndCursorRef.current(
          liveSelectionRef.current ?? selectionRef.current,
          cursorRef.current,
          cursorVisibleRef.current,
          insertedRangesRef.current,
          deletedRangesRef.current
        );
      }

      diag.capture({
        type: 'render-frame',
        durMs: performance.now() - drawStart,
        layoutMs: 0,
        drawMs: renderResult.profile?.totalMs ?? 0,
        source: 'main',
        visibleLineCount: renderResult.profile?.visibleLineCount,
        visibleAnnotationCount: renderResult.profile?.visibleAnnotationCount,
        annotationsMs: renderResult.profile?.annotationsMs,
        sequenceMs: renderResult.profile?.sequenceMs,
        complementMs: renderResult.profile?.complementMs,
        otherMs: renderResult.profile?.otherMs,
        backgroundMs: renderResult.profile?.backgroundMs,
        translationMs: renderResult.profile?.translationMs,
        rulerMs: renderResult.profile?.rulerMs,
      });
    };

    drawFnRef.current = doDraw;

    queueMainLayoutPaint();

    return () => {
      longTaskObserver?.disconnect();
      if (fpsReportTimer) clearTimeout(fpsReportTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workerState,
    onOrfsPresented,
    onPaintLayoutPresented,
    onViewportPresented,
    viewportElementRef,
    layout,
    canvasSurfaceWidth,
    reservedViewportHeight,
    scrollEndHeadroom,
    config,
    fullSequence,
    precomputedLinePositions,
    insertedRanges,
    deletedRanges,
    cutSites,
    scannedCutSites,
    showCutSites,
    hoveredCutSite,
    hoveredGGProductLabel,
    hoveredCodon,
    selectedCodons,
    geneticCode,
    geneticCodeBasis,
    orfRenderStateInput,
    annotationRenderStateInput,
    primers,

    hoveredPositionInfo,
    viewCursor,
    highlightedRange,
    isDark,
    rulerDecorations,
    searchHighlights,
    activeSearchIndex,
    hoveredPrimerId,
    selectedPrimerId,
    previewCDS,
  ]);

  useLayoutEffect(() => {
    if (workerState !== false || pendingMainDrawRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas || !canvas.isConnected) return;
    const vp = viewportRef.current;
    if (
      sceneLayoutRef.current !== layout ||
      Math.abs(vp.scrollTop - sceneScrollTopRef.current) > 0.5
    ) {
      queueMainLayoutPaint();
      return;
    }
    const ctx = getSequenceWebGLContext(canvas, { alpha: false });
    if (!ctx) return;
    const start = performance.now();
    const bands = horizontalPresentationBands(
      layout,
      presentedLayout ?? layout,
      vp.scrollTop,
      vp.height
    );
    const paintedViewport = onViewportPresented ? captureViewport(vp) : null;
    if (!ctx.presentRows(bands, window.devicePixelRatio || 1)) {
      queueMainLayoutPaint();
      return;
    }
    onPaintLayoutPresented?.(
      layout,
      presentedLayout ?? layout,
      performance.now(),
      sceneConfigRef.current ?? config
    );
    if (paintedViewport)
      onViewportPresented?.({
        sequence: sceneSequenceRef.current ?? fullSequence,
        scene: layout,
        presented: presentedLayout ?? layout,
        config: sceneConfigRef.current ?? config,
        viewport: paintedViewport,
      });
    if (shouldCollectDrawnRowDiagnostics()) {
      const w = canvasTestWindow(window);
      const old = w.__canvasLastDrawnFrame;
      const displayed = new Map(
        (presentedLayout ?? layout).lines.map((row) => [row.lineIndex, row])
      );
      if (old && old.cpr === layout.summary?.cpr && old.topBp === layout.summary?.topBp) {
        w.__canvasLastDrawnFrame = {
          ...old,
          t: performance.now(),
          intronConnectors: old.intronConnectors?.map((stroke) => {
            const previousX = old.rows.find((row) => row.index === stroke.lineIndex)?.xOffset ?? 0;
            const dx = (displayed.get(stroke.lineIndex)?.xOffset ?? 0) - previousX;
            return { ...stroke, x1: stroke.x1 + dx, x2: stroke.x2 + dx };
          }),
          rows: old.rows.map((row) => ({
            ...row,
            xOffset: displayed.get(row.index)?.xOffset ?? 0,
          })),
        };
      }
    }
    if (DEV_TELEMETRY) canvasTestWindow(window).__lastCanvasRenderTime = performance.now();
    diag.capture({
      type: 'render-frame',
      durMs: performance.now() - start,
      layoutMs: 0,
      drawMs: performance.now() - start,
      source: 'main',
      visibleLineCount: bands.length,
    });
  }, [
    workerState,
    layout,
    presentedLayout,
    canvasRef,
    viewportRef,
    queueMainLayoutPaint,
    onPaintLayoutPresented,
    onViewportPresented,
    viewportElementRef,
  ]);

  useLayoutEffect(() => {
    if (!workerState || pendingWorkerSceneRef.current) return;
    const scene = workerSceneRef.current;
    const presented = presentedLayout ?? layout;
    if (
      !scene ||
      scene.layout !== layout ||
      (workerPresentedLayoutRef.current?.layout === presented &&
        workerPresentedLayoutRef.current.onOrfsPresented === onOrfsPresented &&
        workerPresentedLayoutRef.current.onPaintLayoutPresented === onPaintLayoutPresented &&
        workerPresentedLayoutRef.current.onViewportPresented === onViewportPresented)
    )
      return;
    workerPresentedLayoutRef.current = {
      layout: presented,
      onOrfsPresented,
      onPaintLayoutPresented,
      onViewportPresented,
    };
    const presentationVersion = rememberWorkerPresentation(
      layout,
      presented,
      scene.version,
      scene.config
    );
    workerState.postMessage({
      type: 'present-rows',
      renderVersion: scene.version,
      presentationVersion,
      bands: horizontalPresentationBands(
        layout,
        presented,
        viewportRef.current.scrollTop,
        viewportRef.current.height
      ),
      dpr: window.devicePixelRatio || 1,
    } as MainToWorkerMessage);
  }, [
    workerState,
    layout,
    presentedLayout,
    viewportRef,
    onOrfsPresented,
    onPaintLayoutPresented,
    onViewportPresented,
    viewportElementRef,
  ]);

  const overlayHoverRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (overlayHoverRafRef.current !== null) {
      cancelAnimationFrame(overlayHoverRafRef.current);
    }
    selectionOverlayDirtyRef.current = true;
    overlayHoverRafRef.current = requestAnimationFrame(() => {
      overlayHoverRafRef.current = null;
      const draw = drawSelectionAndCursorRef.current;
      if (!draw) return;
      const sel = liveSelectionRef.current ?? selectionRef.current;
      draw(
        sel ?? null,
        cursorRef.current,
        cursorVisibleRef.current,
        insertedRangesRef.current,
        deletedRangesRef.current,
        hoverCursorRef.current
      );
    });
    return () => {
      if (overlayHoverRafRef.current !== null) {
        cancelAnimationFrame(overlayHoverRafRef.current);
        overlayHoverRafRef.current = null;
      }
    };
  }, [
    hoveredEnzymeName,
    drawSelectionAndCursorRef,
    isSelectingRef,
    liveSelectionRef,
    selectionRef,
    cursorRef,
    cursorVisibleRef,
    insertedRangesRef,
    deletedRangesRef,
    hoverCursorRef,
  ]);
}
