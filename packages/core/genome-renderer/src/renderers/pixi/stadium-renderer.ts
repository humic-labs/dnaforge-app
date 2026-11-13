import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
import { assemblyScaffoldRulerTicks } from '@waypoint/sequence-utils';
import { genomeFeatures, type Genome, type RenderState } from '../../types';
import {
  getStadiumDimensions,
  closestSeqPosOnBackboneDebug,
  type StadiumDimensions,
} from '../../geometry/stadium';
import { computeLODTier } from '../../geometry/lod';
import { LODTier } from '../../types';
import { SequenceTrack } from './tracks/sequence-track';
import { RetainedLinearNucleotideLayer } from './tracks/retained-linear-nucleotide-layer';
import { CodonTrack } from './tracks/codon-track';
import { OrfTrack } from './tracks/orf-track';
import { RestrictionTrack } from './tracks/restriction-track';
import { getCDSIntrons, translateCDS } from '../../biology/translation';
import { createBaseReader } from './shared/base-reader';
import { findCutSites, type CutSite } from '../../biology/restriction-sites';
import {
  computeTickStep,
  enumerateCircularRulerTickBps,
  formatRulerLabel,
  RULER_COLOR,
  RULER_FONT_SIZE,
  LABEL_FONT_FAMILY,
  LABEL_FONT_WEIGHT,
  webglThemeForMode,
  type WebGLRenderTheme,
  type WebGLThemeMode,
} from './shared';
import { emptyTimings, type SubsystemTimings } from './shared/timing';
import { StadiumPathMapper, type PathMapper } from './shared/path-mapper';
import { OverlayRegistry } from './overlays/overlay-registry';
import { SequenceAnnotationOverlay } from './overlays/sequence-annotation-overlay';
import { PrimerOverlay } from './overlays/primer-overlay';
import type { PrimerOverlayRenderStats } from './overlays/primer-overlay';
import {
  capMaxZoomForStabilityMode,
  computeUnifiedLayout,
  maxZoomForSequencePixelsPerBp,
  type UnifiedLayout,
} from './shared/track-layout';
import {
  resolveInteractionOverlayContract,
  resolveLaneContractSnapshot,
  resolvePhysicalTrackContracts,
  laneContractStackBounds,
  requireTrackLaneEnvelope,
  type LaneStackBounds,
  type LaneContractSnapshot,
  type TrackContract,
} from './shared/lane-contracts';
import { drawDashedLine } from './shared/dashed-line';
import type {
  BackboneBoundaryHandleHitPayload,
  BackbonePartHitPayload,
  BackbonePartReorderPreview,
  WebGLHitTarget,
} from './shared/hit-targets';
import { getMeasureCtx, labelLevelTextRotation } from './shared/curved-label';

const rulerGlyphAdvances = new Map<string, number>();
let rulerFontEpoch = 0;
if (typeof document !== 'undefined') {
  document.fonts?.addEventListener?.('loadingdone', () => {
    rulerGlyphAdvances.clear();
    rulerFontEpoch++;
  });
}
function rulerGlyphAdvance(ctx: CanvasRenderingContext2D, font: string, glyph: string): number {
  const key = `${font}\u0000${glyph}`;
  const cached = rulerGlyphAdvances.get(key);
  if (cached !== undefined) return cached;
  const width = ctx.measureText(glyph).width;
  rulerGlyphAdvances.set(key, width);
  return width;
}
import { destroyPixiText } from './shared/pixi-text-lifecycle';
import { solveStadiumCamera, type StadiumCameraDebug } from './shared/stadium-camera';
import { buildStadiumFrameLayoutContract, type FrameLayoutContract } from './shared/frame-contract';
import { resetLabelOccupancy } from './shared/label-occupancy';
import {
  normalizeBackboneSegmentRanges,
  type BackboneSegmentRange,
} from './shared/backbone-segments';
import { digestFocusMaskSegments } from './shared/digest-focus-mask';
import { FeatureWindowIndex } from './shared/feature-window-index';
import { log as plog, time as ptime } from '../../perf-log';
import { recordWebGLSelectionDebug } from './selection-debug';
import { sourceColorInteractionOutline } from './shared/interaction-outline';
import { ViewportRangeBrackets } from './shared/viewport-range-brackets';

export type LodDist = { hidden: number; rect: number; arrow: number; detailed: number };
const CURVE_SAFETY_MARGIN_PX = 4;
const OVERVIEW_LANE_SCALE_EPSILON_PX = 0.5;
const PREFERRED_STADIUM_OVERVIEW_MIN_ZOOM = 0.05;
const STADIUM_OVERVIEW_WIDTH_MARGIN_PX = 12;
const MAX_ZOOM_FIXPOINT_ITERATIONS = 5;
const MAX_ZOOM_FIXPOINT_EPSILON = 0.001;
const STADIUM_MIN_PADDING_PX = 20;
const ANALYTIC_CIRCLE_MORPH_THRESHOLD = 0.999;
const FULL_CIRCLE_RANGE_EPSILON_BP = 1e-3;
const RULER_CURVE_SEGMENT_PX = 2;
const MAX_RULER_CURVE_SEGMENTS = 2048;
const BACKBONE_BOUNDARY_HANDLE_RADIUS_PX = 5;
const BACKBONE_BOUNDARY_HANDLE_HIT_RADIUS_PX = 10;
const BACKBONE_PART_HIT_SLOP_PX = 2;
const BACKBONE_PART_HIT_TIE_EPSILON_PX = 1e-6;
const EDITING_CURSOR_BLINK_INTERVAL_MS = 530;
const STADIUM_VISIBLE_WORK_BUDGETS = {
  rulerLineSegmentsMax: 2300,
  sequenceVisibleBasesPerStrandMax: 3_200,
  sequenceChildrenPerStrandMax: 3_600,
} as const;

type StadiumVisibleWorkBudgetSnapshot = {
  budgets: typeof STADIUM_VISIBLE_WORK_BUDGETS;
  metrics: {
    rulerLineSegments: number;
    sequenceFwdVisible: number;
    sequenceRevVisible: number;
    sequenceFwdChildren: number;
    sequenceRevChildren: number;
  };
  violations: string[];
};
type StadiumFrame = {
  dims: StadiumDimensions;
  geometryHeight: number;
  ox: number;
  oy: number;
  stagePosX: number;
  stagePosY: number;
  bpPerPixel: number;
  pixelsPerBp: number;
  layout: UnifiedLayout;
  laneStackBounds: LaneStackBounds;
  rawLaneStackBounds: LaneStackBounds;
  physicalTrackContracts: readonly TrackContract[];
  overviewLaneScale: number;
  cameraDebug: StadiumCameraDebug;
  frameContract: FrameLayoutContract;
};

function stadiumGeometryHeight(state: RenderState): number {
  return Math.max(1, state.geometryHeight ?? state.height);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function maxLaneOffset(laneStackBounds: LaneStackBounds): number {
  return Math.max(laneStackBounds.outwardExtent, laneStackBounds.inwardExtent);
}

const FLOATING_LABEL_GUTTER_FADE_END_ZOOM = 2;

function scaleLaneStackBounds(bounds: LaneStackBounds, scale: number): LaneStackBounds {
  return {
    id: bounds.id,
    minOffset: bounds.minOffset * scale,
    maxOffset: bounds.maxOffset * scale,
    outwardExtent: bounds.outwardExtent * scale,
    inwardExtent: bounds.inwardExtent * scale,
  };
}

function hasValidCapGeometry(frame: StadiumFrame, zoom: number): boolean {
  return frame.dims.radius * zoom > maxLaneOffset(frame.laneStackBounds) + CURVE_SAFETY_MARGIN_PX;
}

function distanceToSegment(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = px - a.x;
  const wy = py - a.y;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq)) : 0;
  const x = a.x + t * vx;
  const y = a.y + t * vy;
  return Math.hypot(px - x, py - y);
}

function strokePolyline(graphics: Graphics, points: ReadonlyArray<{ x: number; y: number }>): void {
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (index === 0) graphics.moveTo(point.x, point.y);
    else graphics.lineTo(point.x, point.y);
  }
  graphics.stroke();
}

function pointsAlongBackboneRange(
  path: StadiumPathMapper,
  range: BackboneSegmentRange
): Array<{ x: number; y: number }> {
  const screenSpan =
    (range.end - range.start) *
    (Number.isFinite(path.pixelsPerBp) && path.pixelsPerBp > 0 ? path.pixelsPerBp : 1);
  const steps = Math.max(2, Math.min(256, Math.ceil(screenSpan / 4)));
  return Array.from({ length: steps + 1 }, (_unused, index) => {
    const bp = range.start + (range.end - range.start) * (index / steps);
    return path.rulerAt(bp - 0.5);
  });
}

export class PixiStadiumRenderer {
  private app!: Application;
  private genome!: Genome;
  private getState!: () => RenderState;
  private maxReadableZoomCache: { key: string; value: number } | null = null;
  private minimumZoomCache: { key: string; value: number } | null = null;

  private rulerLayer = new Container();
  private rulerGraphics = new Graphics();
  private selectionLayer = new Container();
  private selectionGraphics = new Graphics();
  private interactionLayer = new Container();
  private interactionGraphics = new Graphics();
  private editingCursorGraphics = new Graphics();
  private editingCursorBlinkActive = false;
  private editingCursorBlinkPosition: number | null = null;
  private editingCursorBlinkTimer: ReturnType<typeof setTimeout> | null = null;
  private backboneBoundaryHandleGraphics = new Graphics();
  private backbonePartInteractionGraphics = new Graphics();
  private backboneBoundaryHandleHitCache: Array<{
    x: number;
    y: number;
    radius: number;
    payload: BackboneBoundaryHandleHitPayload;
  }> = [];
  private backboneBoundaryHandlePreview: {
    regionId: string;
    side: 'upstream' | 'downstream';
    boundaryBp: number;
  } | null = null;
  private backbonePartHitCache: Array<{
    points: Array<{ x: number; y: number }>;
    hitRadius: number;
    payload: BackbonePartHitPayload;
  }> = [];
  private backbonePartInsertionPreview: {
    regionId: string;
    boundaryBp: number;
    preview: BackbonePartReorderPreview | null;
  } | null = null;
  private hoveredBackbonePartRegionId: string | null = null;
  private backbonePartHoverOutline: {
    regionId: string;
    width: number;
    color: number;
    alpha: number;
  } | null = null;
  private selectedBackbonePartOutlineRegionId: string | null = null;

  private rulerCharPool: Text[] = [];
  private rulerTextMetrics = new Map<
    string,
    { text: string; charWidths: number[]; totalWidth: number }
  >();
  private rulerCharIndex = 0;
  private appliedThemeMode: WebGLThemeMode | null = null;
  private rulerCharStyle = new TextStyle({
    fontSize: 0,
    fill: 0,
    fontFamily: '',
    fontWeight: '500',
  });

  rulerLabelsMeta: { text: string; x: number; y: number; w: number }[] = [];
  rulerLineSegmentsDrawn = 0;
  private rulerUsedAnalyticCircle = false;

  private lastRulerWindow: {
    step: number;
    centerBp: number;
    windowBp: number;
    circular: boolean;
  } | null = null;
  private visibleWorkBudget: StadiumVisibleWorkBudgetSnapshot = {
    budgets: STADIUM_VISIBLE_WORK_BUDGETS,
    metrics: {
      rulerLineSegments: 0,
      sequenceFwdVisible: 0,
      sequenceRevVisible: 0,
      sequenceFwdChildren: 0,
      sequenceRevChildren: 0,
    },
    violations: [],
  };

  rulerHighlightShapes = 0;

  private _maxLane = 0;
  sequenceTrack!: SequenceTrack;
  private codonTrack!: CodonTrack;
  private orfTrack!: OrfTrack;
  private restrictionTrack!: RestrictionTrack;
  private cutSites: CutSite[] = [];
  private featureWindowIndex = new FeatureWindowIndex({
    genomeLength: 0,
    circular: false,
    features: [],
  });

  private codonCache = new Map<number, import('../../biology/translation').CodonInfo[]>();

  private _stagePosX = 0;
  private _stagePosY = 0;
  private _dims: StadiumDimensions | null = null;
  private _ox = 0;
  private _oy = 0;
  private lastSelectionDrawDebugKey = '';
  private viewportBrackets = new ViewportRangeBrackets();
  private backbonePathSegmentsDrawn = 0;
  private lastLaneContractDebugFrame: {
    layout: UnifiedLayout;
    laneStackBounds: LaneStackBounds;
    rawLaneStackBounds: LaneStackBounds;
    physicalTrackContracts: readonly TrackContract[];
    cameraDebug: StadiumCameraDebug;
    overviewLaneScale: number;
    frameContract: FrameLayoutContract;
  } | null = null;

  private overlayRegistry = new OverlayRegistry();
  private annotationOverlay = new SequenceAnnotationOverlay();
  private primerOverlay = new PrimerOverlay();

  getOverlayRegistry() {
    return this.overlayRegistry;
  }

  getCurrentPathMapper(): PathMapper | null {
    return this._layout;
  }

  getPrimerDebugSnapshot(): PrimerOverlayRenderStats {
    return this.primerOverlay.lastRenderStats;
  }

  getViewportDebugSnapshot() {
    return this.viewportBrackets.snapshot;
  }

  getBackboneBoundaryHandleDebugSnapshot(): ReadonlyArray<{
    x: number;
    y: number;
    payload: BackboneBoundaryHandleHitPayload;
  }> {
    return this.backboneBoundaryHandleHitCache.map((record) => ({
      x: record.x,
      y: record.y,
      payload: { ...record.payload },
    }));
  }

  getBackbonePartInteractionDebugSnapshot(): {
    parts: ReadonlyArray<{
      points: ReadonlyArray<{ x: number; y: number }>;
      payload: BackbonePartHitPayload;
    }>;
    insertionBoundaryBp: number | null;
    previewRegionOrder: ReadonlyArray<string> | null;
    hoveredRegionId: string | null;
    hoverOutline: {
      regionId: string;
      width: number;
      color: number;
      alpha: number;
    } | null;
    selectedOutlineRegionId: string | null;
  } {
    return {
      parts: this.backbonePartHitCache.map((record) => ({
        points: record.points.map((point) => ({ ...point })),
        payload: { ...record.payload },
      })),
      insertionBoundaryBp: this.backbonePartInsertionPreview?.boundaryBp ?? null,
      previewRegionOrder:
        this.backbonePartInsertionPreview?.preview?.ranges.map((range) => range.regionId) ?? null,
      hoveredRegionId: this.hoveredBackbonePartRegionId,
      hoverOutline: this.backbonePartHoverOutline ? { ...this.backbonePartHoverOutline } : null,
      selectedOutlineRegionId: this.selectedBackbonePartOutlineRegionId,
    };
  }

  hasDrawnOrfs(): boolean {
    return this.orfTrack.hasDrawnOrfs();
  }

  getRendererDebugSnapshot(): unknown {
    return {
      sequenceTrack: this.sequenceTrack?.getDebugSnapshot?.() ?? null,
      annotationOverlay: this.annotationOverlay.getDebugSnapshot(),
      codonTrack: this.codonTrack.getDebugSnapshot(),
      orfTrack: this.orfTrack.getDebugSnapshot(),
      retainedOverlays: this.overlayRegistry.getRetainedDebugSnapshots(),
      ruler: {
        lineSegmentsDrawn: this.rulerLineSegmentsDrawn,
        usedAnalyticCircle: this.rulerUsedAnalyticCircle,
        labelCount: this.rulerLabelsMeta.length,
        charCount: this.rulerCharIndex,
        window: this.lastRulerWindow,
      },
      visibleWorkBudget: this.visibleWorkBudget,
      frameContract: this.lastLaneContractDebugFrame?.frameContract ?? null,
      backboneSegmentCount: this.getState?.().backboneSegments?.length ?? 0,
      backbonePathSegmentsDrawn: this.backbonePathSegmentsDrawn,
      backboneBoundaryHandleCount: this.backboneBoundaryHandleHitCache.length,
      backbonePartTargetCount: this.backbonePartHitCache.length,
      backbonePartInsertionBoundaryBp: this.backbonePartInsertionPreview?.boundaryBp ?? null,
      laneContracts: this.lastLaneContractDebugFrame
        ? this.buildLaneContractSnapshot(this.lastLaneContractDebugFrame.layout)
        : null,
      camera: this.lastLaneContractDebugFrame
        ? {
            laneStackBounds: this.lastLaneContractDebugFrame.laneStackBounds,
            rawLaneStackBounds: this.lastLaneContractDebugFrame.rawLaneStackBounds,
            cameraDebug: this.lastLaneContractDebugFrame.cameraDebug,
            overviewLaneScale: this.lastLaneContractDebugFrame.overviewLaneScale,
          }
        : null,
    };
  }

  setFloatingLabelLeadersVisibleForTests(visible: boolean): void {
    this.annotationOverlay.setFloatingLabelLeadersVisibleForTests(visible);
  }

  getFrameLayoutContract(): FrameLayoutContract | null {
    return this.lastLaneContractDebugFrame?.frameContract ?? null;
  }

  getMinZoom(state: RenderState): number {
    const cacheKey = this.minimumZoomCacheKey(state);
    if (cacheKey !== null && this.minimumZoomCache?.key === cacheKey)
      return this.minimumZoomCache.value;
    const value = this.computeMinimumZoom(state);
    this.minimumZoomCache = cacheKey === null ? null : { key: cacheKey, value };
    return value;
  }

  private minimumZoomCacheKey(state: RenderState): string | null {
    if (
      this.overlayRegistry
        .getAll()
        .some((overlay) => overlay !== this.annotationOverlay && overlay !== this.primerOverlay)
    )
      return null;
    return [
      this.overlayRegistry.getLayoutRevision(),
      this.genome.length,
      this.genome.sequence?.length ?? 0,
      this.genome.sequenceWindow?.bases.length ?? 0,
      state.width,
      state.height,
      state.geometryHeight ?? '',
      state.morph,
      state.showResidueNumbers ?? false,
      state.performanceMode ?? 'default',
      this.annotationOverlay.enabled,
      this.annotationOverlay.maxAnnotationLane,
      this.annotationOverlay.maxCdsLane,
      this.annotationOverlay.floatingLabelTopReservePx(),
      this.primerOverlay.enabled,
      this.primerOverlay.maxPrimerLane,
      this.primerOverlay.maxForwardPrimerLane,
      this.primerOverlay.maxReversePrimerLane,
      this.orfTrack.getForwardLaneCount(),
      this.orfTrack.getReverseLaneCount(),
      this.cutSites.length,
    ].join(':');
  }

  private computeMinimumZoom(state: RenderState): number {
    const minimumSearchZoom = 0.001;
    const overviewHigh = 1;
    const fullShapeVisualWidth = (frame: StadiumFrame, zoom: number): number =>
      frame.dims.width * zoom + 2 * frame.rawLaneStackBounds.outwardExtent;
    const fits = (zoom: number): boolean => {
      const frame = this.computeFrameForState(state, zoom);
      const availableWidth = Math.max(1, state.width - 2 * STADIUM_OVERVIEW_WIDTH_MARGIN_PX);
      return (
        frame.cameraDebug.fullShapeVisualHeight <= frame.cameraDebug.availableHeight + 0.0001 &&
        fullShapeVisualWidth(frame, zoom) <= availableWidth + 0.0001
      );
    };
    const capGeometryIsValid = (zoom: number): boolean => {
      return hasValidCapGeometry(this.computeFrameForState(state, zoom), zoom);
    };

    let low = PREFERRED_STADIUM_OVERVIEW_MIN_ZOOM;
    while (!fits(low) && low > minimumSearchZoom) {
      low = Math.max(minimumSearchZoom, low / 2);
    }

    const fitZoom = low;

    if (capGeometryIsValid(fitZoom)) return fitZoom;

    let lo = fitZoom;
    let hi = Math.max(overviewHigh, lo * 2);
    while (!capGeometryIsValid(hi) && hi < 100) {
      lo = hi;
      hi *= 2;
    }
    if (!capGeometryIsValid(hi)) return hi;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (capGeometryIsValid(mid)) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return hi;
  }

  getMaxZoom(state: RenderState): number {
    const hasAnySequence = !!this.genome?.sequence || !!this.genome?.sequenceWindow;
    if (!this.genome || !hasAnySequence) return Number.POSITIVE_INFINITY;
    const cacheKey = [
      this.genome.length,

      this.genome.sequence?.length ?? this.genome.sequenceWindow?.bases.length ?? 0,
      state.width,
      state.height,
      state.geometryHeight ?? '',
      state.morph,
      this.annotationOverlay.maxAnnotationLane,
      this.annotationOverlay.maxCdsLane,
      this.primerOverlay.maxPrimerLane,
      this.primerOverlay.maxForwardPrimerLane,
      this.primerOverlay.maxReversePrimerLane,
      this.orfTrack?.getForwardLaneCount?.() ?? 0,
      this.orfTrack?.getReverseLaneCount?.() ?? 0,
      this.cutSites.length,
      state.performanceMode ?? 'default',
    ].join(':');
    if (this.maxReadableZoomCache?.key === cacheKey) return this.maxReadableZoomCache.value;

    let zoom = 1;
    for (let i = 0; i < MAX_ZOOM_FIXPOINT_ITERATIONS; i++) {
      const frame = this.computeFrameForState(state, zoom);
      const nextZoom = Math.max(
        0.01,
        maxZoomForSequencePixelsPerBp(this.genome.length, frame.dims.totalLength)
      );
      const relativeDelta = Math.abs(nextZoom - zoom) / Math.max(1, nextZoom);
      zoom = nextZoom;
      if (relativeDelta < MAX_ZOOM_FIXPOINT_EPSILON) break;
    }

    const capFrame = this.computeFrameForState(state, zoom);
    zoom = capMaxZoomForStabilityMode({
      genomeLength: this.genome.length,
      screenPathLengthPx: capFrame.dims.totalLength,
      sequenceViewportSpanPx: (state.width + stadiumGeometryHeight(state)) * 2,
      readableMaxZoom: zoom,
      performanceMode: state.performanceMode,
    });

    this.maxReadableZoomCache = { key: cacheKey, value: zoom };
    return zoom;
  }

  private uiContainer = new Container();

  async init(app: Application, genome: Genome, getState: () => RenderState): Promise<void> {
    this.app = app;
    this.getState = getState;

    try {
      RetainedLinearNucleotideLayer.prepareProgram(app.renderer);
    } catch (error) {
      plog('stadium.nucleotide-program-preparation-failed', { error: String(error) });
    }

    this.selectionLayer.addChild(this.selectionGraphics);
    this.app.stage.addChild(this.selectionLayer);
    this.uiContainer.addChild(this.rulerLayer);
    this.rulerLayer.addChild(this.rulerGraphics);
    this.app.stage.addChild(this.uiContainer);

    this.rulerCharStyle = new TextStyle({
      fontSize: RULER_FONT_SIZE,
      fill: RULER_COLOR,
      fontFamily: LABEL_FONT_FAMILY,
      fontWeight: LABEL_FONT_WEIGHT,
    });
    this.sequenceTrack = new SequenceTrack(this.uiContainer);
    this.sequenceTrack.setNucleicAcid(this.genome?.nucleicAcid ?? 'dna');
    this.codonTrack = new CodonTrack(this.uiContainer);
    this.orfTrack = new OrfTrack(this.uiContainer);
    this.restrictionTrack = new RestrictionTrack(this.uiContainer);

    this.overlayRegistry.register(this.annotationOverlay);
    this.overlayRegistry.register(this.primerOverlay);
    this.app.stage.addChild(this.annotationOverlay.container);
    this.app.stage.addChild(this.primerOverlay.container);
    this.interactionLayer.addChild(
      this.interactionGraphics,
      this.editingCursorGraphics,
      this.backbonePartInteractionGraphics,
      this.backboneBoundaryHandleGraphics
    );
    this.app.stage.addChild(this.interactionLayer);

    await this.loadGenome(genome);
  }

  private applyTheme(state: RenderState): WebGLRenderTheme {
    const theme = webglThemeForMode(state.themeMode);
    if (this.appliedThemeMode !== theme.mode) {
      this.appliedThemeMode = theme.mode;
      this.rulerCharStyle = new TextStyle({
        fontSize: RULER_FONT_SIZE,
        fill: theme.rulerText,
        fontFamily: LABEL_FONT_FAMILY,
        fontWeight: LABEL_FONT_WEIGHT,
      });
      for (const charText of this.rulerCharPool) charText.style = this.rulerCharStyle;
      this.sequenceTrack.setTheme(theme);
    }
    return theme;
  }

  getWorldContainer(): Container {
    return this.uiContainer;
  }

  async loadGenome(genome: Genome): Promise<void> {
    ptime(
      'stadium.loadGenome',
      () => {
        this.genome = genome;
        this.sequenceTrack?.setNucleicAcid(genome.nucleicAcid ?? 'dna');
        const features = genomeFeatures(genome);
        this.featureWindowIndex = new FeatureWindowIndex({
          genomeLength: genome.length,
          circular: genome.circular,
          features,
        });
        this.maxReadableZoomCache = null;
        this.minimumZoomCache = null;
        this._maxLane = features.reduce((max, f) => Math.max(max, f.lane), 0);
        ptime('stadium.loadGenome.overlay', () => this.overlayRegistry.loadGenome(genome));
        this.codonTrack.reset();
        this.orfTrack.loadGenome(genome);

        const skip =
          typeof window !== 'undefined' &&
          (window as unknown as { __webglSkipInternalCutSites?: boolean })
            .__webglSkipInternalCutSites !== false;
        this.cutSites =
          genome.sequence && !skip
            ? ptime('stadium.loadGenome.findCutSites', () => findCutSites(genome.sequence!), {
                seqLen: genome.sequence.length,
              })
            : [];
        this.codonCache.clear();
      },
      { features: genomeFeatures(genome).length, seqLen: genome.sequence?.length ?? 0 }
    );
  }

  setCutSites(sites: CutSite[]): void {
    this.cutSites = sites;
    this.maxReadableZoomCache = null;
    this.minimumZoomCache = null;
  }

  setSequenceWindow(window?: Genome['sequenceWindow']): void {
    if (!this.genome) return;
    this.genome = { ...this.genome, sequenceWindow: window };

    this.maxReadableZoomCache = null;
    this.minimumZoomCache = null;

    this.codonCache.clear();
  }

  _timings: SubsystemTimings = emptyTimings();
  _detailedCount = 0;

  _layout: StadiumPathMapper | null = null;

  private drawStadiumTransientOverlays(
    state: RenderState,
    stadiumPath: PathMapper,
    dims: StadiumFrame['dims'],
    cx: number,
    cy: number
  ): void {
    this.rulerHighlightShapes = 0;
    this.viewportBrackets.render(this.interactionGraphics, stadiumPath, state, this.genome);
    if (state.hoveredCodon) {
      this.drawHoveredCodonBackground();
    }
    if (state.digestFocusRange) {
      this.drawDigestFocusMask(state.digestFocusRange);
    }
    if (state.highlightRange) {
      this.drawHighlightRange(state.highlightRange, dims, state, cx, cy);
    }
    if (state.residueLinkRange && stadiumPath.sequenceVisible) {
      this.drawResidueLinkRange(state.residueLinkRange);
    }
    if (!state.highlightRange && state.cursorPosition != null) {
      this.drawCursor(
        state.cursorPosition,
        state.cursorBlinking ? this.editingCursorGraphics : this.interactionGraphics
      );
    }
    if (state.hoverPosition != null) {
      this.drawHoverCursor(state.hoverPosition);
    }
  }

  private resolveStadiumRenderFrame(state: RenderState): StadiumFrame {
    const maxZoom = this.getMaxZoom(state);
    if (state.zoom > maxZoom) state.zoom = maxZoom;
    let frame = this.computeFrameForState(state);
    if (!hasValidCapGeometry(frame, state.zoom)) {
      const safeZoom = this.getMinZoom(state);
      if (safeZoom > state.zoom) {
        state.zoom = safeZoom;
        frame = this.computeFrameForState(state);
      }
    }
    return frame;
  }

  private computeFrameForState(state: RenderState, zoom = state.zoom): StadiumFrame {
    const cx = state.width / 2;
    const cy = state.height / 2;
    const geometryHeight = stadiumGeometryHeight(state);
    const layoutState = zoom === state.zoom ? state : { ...state, zoom };
    const minPadding = STADIUM_MIN_PADDING_PX;
    const exteriorMargin = 12;

    const minRingDiameter = 40;
    const gutterFade = Math.min(
      1,
      Math.max(
        0,
        (FLOATING_LABEL_GUTTER_FADE_END_ZOOM - zoom) / (FLOATING_LABEL_GUTTER_FADE_END_ZOOM - 1)
      )
    );
    const labelGutter =
      state.morph >= 1 ? this.annotationOverlay.floatingLabelSideGutterPx() * gutterFade : 0;
    const shapeWidth = Math.max(
      minRingDiameter + 2 * minPadding,
      Math.min(state.width, state.width - 2 * labelGutter)
    );
    const sideLimitedPadding = (Math.min(shapeWidth, geometryHeight) - minRingDiameter) / 2;
    const maxPadding = Math.max(minPadding, Math.min(geometryHeight * 0.35, sideLimitedPadding));
    const measureFrame = (padding: number) => {
      const dims = getStadiumDimensions(shapeWidth, geometryHeight, state.morph, padding);
      const circumferencePixels = dims.totalLength * zoom;
      const bpPerPixel = this.genome.length / circumferencePixels;
      const pixelsPerBp = 1 / bpPerPixel;
      const rawLayout = this.computeLayoutForFrame(layoutState, bpPerPixel, pixelsPerBp);
      const rawLaneStack = this.resolveRawLaneStack(rawLayout);
      return { dims, bpPerPixel, pixelsPerBp, rawLayout, rawLaneStack };
    };

    const measured = measureFrame(minPadding);
    const finalPadding = Math.min(
      Math.max(minPadding, measured.rawLaneStack.bounds.outwardExtent + exteriorMargin),
      maxPadding
    );
    const finalFrame =
      Math.abs(finalPadding - minPadding) > 0.001 ? measureFrame(finalPadding) : measured;
    const { dims, bpPerPixel, pixelsPerBp, rawLayout, rawLaneStack } = finalFrame;
    const { bounds: rawLaneStackBounds, contracts: physicalTrackContracts } = rawLaneStack;
    const overviewLaneScale = this.computeOverviewLaneScale(dims, zoom, rawLaneStackBounds);
    const layout =
      overviewLaneScale < 1 ? { ...rawLayout, overviewLaneScale, laneGeometryScale: 1 } : rawLayout;
    const laneStackBounds = scaleLaneStackBounds(rawLaneStackBounds, overviewLaneScale);
    const visualLaneStackBounds = scaleLaneStackBounds(
      rawLaneStackBounds,
      layout.laneGeometryScale ?? layout.overviewLaneScale ?? 1
    );
    const frame: Omit<StadiumFrame, 'stagePosX' | 'stagePosY' | 'cameraDebug' | 'frameContract'> = {
      dims,
      geometryHeight,
      ox: cx - dims.width / 2,
      oy: cy - dims.height / 2,
      bpPerPixel,
      pixelsPerBp,
      layout,
      laneStackBounds,
      rawLaneStackBounds,
      physicalTrackContracts,
      overviewLaneScale,
    };

    const camera = solveStadiumCamera({
      viewportWidth: state.width,
      viewportHeight: state.height,
      dims,
      ox: frame.ox,
      oy: frame.oy,
      zoom,
      laneStackBounds,
      visualLaneStackBounds,
      floatingLabelTopReservePx: this.annotationOverlay.floatingLabelTopReservePx(),
    });
    const frameContract = buildStadiumFrameLayoutContract({
      viewportWidth: state.width,
      viewportHeight: state.height,
      geometryHeight,
      morph: state.morph,
      zoom,
      dims,
      stagePosX: camera.stagePosX,
      stagePosY: camera.stagePosY,
      layout,
      physicalTrackContracts,
      fitLaneStackBounds: laneStackBounds,
      visualLaneStackBounds: rawLaneStackBounds,
      cameraDebug: camera.debug,
    });

    return {
      ...frame,
      stagePosX: camera.stagePosX,
      stagePosY: camera.stagePosY,
      cameraDebug: camera.debug,
      frameContract,
    };
  }

  private computeLayoutForFrame(
    state: RenderState,
    bpPerPixel: number,
    pixelsPerBp: number,
    overviewLaneScale = 1
  ): UnifiedLayout {
    const geometryHeight = stadiumGeometryHeight(state);
    const layoutState =
      geometryHeight === state.height ? state : { ...state, height: geometryHeight };
    const numTranslationLanes =
      bpPerPixel < 5 && this.genome.sequence
        ? genomeFeatures(this.genome).some((f) => f.type === 'CDS' && f.direction !== 'none')
          ? 1
          : 0
        : 0;

    return computeUnifiedLayout({
      overlays: this.overlayRegistry.getAll(),
      genome: this.genome,
      state: layoutState,
      pixelsPerBp,
      viewportHeight: geometryHeight,
      hasSequence: !!this.genome.sequence,
      sequenceViewportSpanPx: (state.width + geometryHeight) * 2,
      overviewLaneScale,
      cdsSizing: 'canvas',
      translationLanes: numTranslationLanes,
      annotationLanes: Math.max(0, this.annotationOverlay.maxAnnotationLane + 1),
      cdsLanes: Math.max(0, this.annotationOverlay.maxCdsLane + 1),
      orfForwardLanes: this.orfTrack.getForwardLaneCount(),
      orfReverseLanes: this.orfTrack.getReverseLaneCount(),
    });
  }

  private computeOverviewLaneScale(
    dims: StadiumDimensions,
    zoom: number,
    laneStackBounds: LaneStackBounds
  ): number {
    const maxOffset = maxLaneOffset(laneStackBounds);
    if (maxOffset <= 0) return 1;
    const capBudget = Math.max(
      0,
      dims.radius * zoom - CURVE_SAFETY_MARGIN_PX - OVERVIEW_LANE_SCALE_EPSILON_PX
    );
    return clamp01(capBudget / maxOffset);
  }

  private resolveRawLaneStack(layout: UnifiedLayout): {
    contracts: readonly TrackContract[];
    bounds: LaneStackBounds;
  } {
    const contracts = resolvePhysicalTrackContracts({
      layout,
      mode: 'stadium',
      maxAnnotationLane: this.annotationOverlay.maxAnnotationLane,
      maxCdsLane: this.annotationOverlay.maxCdsLane,
      maxPrimerLane: this.primerOverlay.maxPrimerLane,
      maxForwardPrimerLane: this.primerOverlay.maxForwardPrimerLane,
      maxReversePrimerLane: this.primerOverlay.maxReversePrimerLane,
      orfForwardLaneCount: this.orfTrack.getForwardLaneCount(),
      orfReverseLaneCount: this.orfTrack.getReverseLaneCount(),
    });
    return {
      contracts,
      bounds: laneContractStackBounds(contracts, 'physical-lane-stack'),
    };
  }

  private buildLaneContractSnapshot(layout: UnifiedLayout): LaneContractSnapshot {
    return resolveLaneContractSnapshot({
      layout,
      mode: 'stadium',
      maxAnnotationLane: this.annotationOverlay.maxAnnotationLane,
      maxCdsLane: this.annotationOverlay.maxCdsLane,
      maxPrimerLane: this.primerOverlay.maxPrimerLane,
      maxForwardPrimerLane: this.primerOverlay.maxForwardPrimerLane,
      maxReversePrimerLane: this.primerOverlay.maxReversePrimerLane,
      orfForwardLaneCount: this.orfTrack.getForwardLaneCount(),
      orfReverseLaneCount: this.orfTrack.getReverseLaneCount(),
      includeInteractions: true,
    });
  }

  render(state: RenderState): void {
    if (!this.genome) return;

    if (
      state.width <= 2 * STADIUM_MIN_PADDING_PX ||
      state.height <= 0 ||
      stadiumGeometryHeight(state) <= 2 * STADIUM_MIN_PADDING_PX
    )
      return;
    this.applyTheme(state);
    resetLabelOccupancy(state);
    const cx = state.width / 2;
    const cy = state.height / 2;
    this.selectionGraphics.clear();
    this.interactionGraphics.clear();
    this.editingCursorGraphics.clear();
    this.syncEditingCursorBlink(state);
    this.backbonePathSegmentsDrawn = 0;

    let t0 = performance.now();

    const frame = this.resolveStadiumRenderFrame(state);
    const { dims, geometryHeight, ox, oy, stagePosX, stagePosY, bpPerPixel, layout } = frame;
    this.lastLaneContractDebugFrame = {
      layout,
      rawLaneStackBounds: frame.rawLaneStackBounds,
      laneStackBounds: frame.laneStackBounds,
      physicalTrackContracts: frame.physicalTrackContracts,
      cameraDebug: frame.cameraDebug,
      overviewLaneScale: frame.overviewLaneScale,
      frameContract: frame.frameContract,
    };
    const circumferencePixels = dims.totalLength * state.zoom;
    const topMidFrac = dims.straightLength > 0 ? dims.straightLength / dims.totalLength / 2 : 0;
    this._dims = dims;
    this._ox = ox;
    this._oy = oy;
    this._stagePosX = stagePosX;
    this._stagePosY = stagePosY;
    this._timings.transform = performance.now() - t0;

    const viewLeft = -50;
    const viewTop = -50;
    const viewRight = state.width + 50;
    const viewBottom = state.height + 50;

    const stadiumPath = (this._layout = new StadiumPathMapper({
      genomeLength: this.genome.length,
      viewOffset: state.viewOffset,
      zoom: state.zoom,
      dims,
      ox,
      oy,
      stagePosX,
      stagePosY,
      bpPerPixel,
      hasSequence: !!this.genome.sequence,
      viewportWidth: state.width,
      viewportHeight: state.height,
      geometryHeight,
      layout,
    }));

    this.annotationOverlay.setLayout(layout);
    this.annotationOverlay.setFloatingLabelOutwardExtent(
      scaleLaneStackBounds(
        frame.rawLaneStackBounds,
        layout.laneGeometryScale ?? layout.overviewLaneScale ?? 1
      ).outwardExtent
    );
    this.primerOverlay.setLayout(layout);

    t0 = performance.now();
    this.drawRuler(
      dims,
      state,
      cx,
      cy,
      circumferencePixels,
      viewLeft,
      viewTop,
      viewRight,
      viewBottom,
      0
    );
    this._timings.backbone = performance.now() - t0;

    t0 = performance.now();
    for (const overlay of this.overlayRegistry.getAll()) {
      this.overlayRegistry.renderOverlay(overlay, stadiumPath, state, 0, 0);
    }
    this._timings.features = performance.now() - t0;

    t0 = performance.now();
    this.drawStadiumTransientOverlays(state, stadiumPath, dims, cx, cy);
    this._timings.highlight = performance.now() - t0;

    t0 = performance.now();
    this.codonTrack.reset();
    const codonBaseReader = createBaseReader(
      this.genome.sequence,
      this.genome.sequenceWindow,
      this.genome.circular
    );
    const cdsInteractionContours = new Map<number, number[][]>();
    if (
      codonBaseReader &&
      (stadiumPath.sequenceVisible || state.selectedIds.size > 0 || state.hoveredId !== null)
    ) {
      const screenPixelsPerBp = circumferencePixels / this.genome.length;
      const candidateFeatures = this.featureWindowIndex.candidatesForPath(
        stadiumPath,
        genomeFeatures(this.genome)
      );

      for (const feature of candidateFeatures) {
        const activeCds =
          feature.type === 'CDS' &&
          (state.selectedIds.has(feature.id) || state.hoveredId === feature.id);
        if (!stadiumPath.sequenceVisible && !activeCds) continue;

        const isLegacyCds = feature.type === 'CDS';
        const v2CdsSegments = feature.cds;
        const hasV2Cds = !!(v2CdsSegments && v2CdsSegments.length > 0);
        if (!isLegacyCds && !hasV2Cds) continue;
        if (feature.direction === 'none') continue;

        const featureLen =
          feature.end > feature.start
            ? feature.end - feature.start
            : this.genome.length - feature.start + feature.end;
        const featurePxW = featureLen * screenPixelsPerBp;
        if (featurePxW < 30) continue;

        const isV2Carrier = feature.type !== 'CDS' && !!(feature.cds && feature.cds.length > 0);
        const perTranscriptOffset = isV2Carrier
          ? this.annotationOverlay.getFeatureRenderOffset(feature)
          : null;
        const cdsLane = feature.cdsLane ?? 0;
        const chevronOffset =
          perTranscriptOffset ?? layout.cdsChevronOffset - cdsLane * layout.cdsLaneStep;
        const residueRowOffset =
          layout.cdsResidueRowOffset !== 0
            ? layout.cdsResidueRowOffset - cdsLane * layout.cdsLaneStep
            : 0;
        if (
          !stadiumPath.isFeatureVisible(
            feature.start,
            featureLen,
            chevronOffset,
            layout.translationLaneHeight / 2
          )
        )
          continue;

        const useV2 = hasV2Cds && !isLegacyCds && v2CdsSegments && v2CdsSegments.length > 0;
        const segmentsForTranslate = useV2 ? v2CdsSegments : feature.segments;
        const codingStart = useV2 ? v2CdsSegments[0].start - 1 : feature.start;
        const codingEnd = useV2 ? v2CdsSegments[v2CdsSegments.length - 1].end : feature.end;

        let codons = this.codonCache.get(feature.id);
        if (!codons) {
          codons = translateCDS(
            codonBaseReader,
            codingStart,
            codingEnd,
            feature.direction,
            this.genome.length,
            this.genome.circular,
            {
              segments: segmentsForTranslate,
              qualifiers: feature.qualifiers,
              geneticCodeBasis: this.genome.geneticCodeBasis,
              sequenceGeneticCode: this.genome.geneticCode,
            }
          );
          this.codonCache.set(feature.id, codons);
        }
        const introns = getCDSIntrons(
          codonBaseReader,
          codingStart,
          codingEnd,
          feature.direction,
          { segments: segmentsForTranslate, qualifiers: feature.qualifiers },
          this.genome.length
        );
        if (codons.length === 0 && introns.length === 0) continue;

        this.codonTrack.renderCodons(
          feature,
          codons,
          stadiumPath,
          chevronOffset,
          this.genome.length,
          state,
          layout.sequenceOpacity,
          residueRowOffset,
          Number.POSITIVE_INFINITY,
          activeCds
            ? (points) => {
                const contours = cdsInteractionContours.get(feature.id);
                if (contours) contours.push(points);
                else cdsInteractionContours.set(feature.id, [points]);
              }
            : undefined
        );

        if (isLegacyCds) {
          this.codonTrack.renderIntrons(
            feature,
            introns,
            stadiumPath,
            chevronOffset,
            this.genome.length,
            state,
            layout.sequenceOpacity
          );
        }
      }
    }
    this.annotationOverlay.renderCompoundCdsInteractionOutlines(
      stadiumPath,
      state,
      cdsInteractionContours
    );
    this._timings.codons = performance.now() - t0;

    t0 = performance.now();
    const orfContract =
      frame.physicalTrackContracts.find((contract) => contract.trackId === 'orfs') ?? null;
    this.orfTrack.render(
      stadiumPath,
      state,
      layout,
      this.genome.length,
      this.genome.sequence,
      orfContract
    );
    this._timings.orfs = performance.now() - t0;

    t0 = performance.now();
    this.restrictionTrack.reset();
    if (bpPerPixel < 50 && this.cutSites.length > 0) {
      const showRecognition = bpPerPixel < 10;
      this.restrictionTrack.renderSites(
        this.cutSites,
        stadiumPath,
        showRecognition,
        state,
        this.genome.length
      );
    }
    this._timings.restrictions = performance.now() - t0;

    this._timings.labels = 0;

    t0 = performance.now();
    if (
      stadiumPath.sequenceVisible &&
      ((this.genome.sequence && this.genome.sequence.length > 0) ||
        (this.genome.sequenceWindow && this.genome.sequenceWindow.bases.length > 0))
    ) {
      const screenPixelsPerBp = circumferencePixels / this.genome.length;
      const visibleBpCount = ((state.width + geometryHeight) / screenPixelsPerBp) * 2;

      const viewCenterBp = ((topMidFrac + state.viewOffset) % 1) * this.genome.length;
      const rawVisStartBp = viewCenterBp - visibleBpCount / 2;
      const rawVisEndBp = viewCenterBp + visibleBpCount / 2;
      const visStartBp = this.genome.circular ? rawVisStartBp : Math.max(0, rawVisStartBp);
      const visEndBp = this.genome.circular
        ? rawVisEndBp
        : Math.min(this.genome.length, rawVisEndBp);

      const sequenceTextMargin = Math.max(64, layout.sequenceFontSize * 8);
      this.sequenceTrack.renderArc(
        this.genome.sequence,
        visStartBp,
        visEndBp,
        bpPerPixel,
        (bp: number) => stadiumPath.fwdStrandAt(bp),
        1,
        (bp: number) => stadiumPath.revStrandAt(bp),
        {
          wrap: this.genome.circular,
          opacity: layout.sequenceOpacity,
          sequenceWindow: this.genome.sequenceWindow,
          strandOverrides: this.genome.strandOverrides,
          screenBounds: {
            xMin: -sequenceTextMargin,
            yMin: -sequenceTextMargin,
            xMax: state.width + sequenceTextMargin,
            yMax: state.height + sequenceTextMargin,
          },
        }
      );
    } else {
      this.sequenceTrack.renderArc(
        undefined,
        0,
        0,
        bpPerPixel,
        () => ({ x: 0, y: 0, angle: 0 }),
        1
      );
    }
    this._timings.sequence = performance.now() - t0;
    this.updateVisibleWorkBudget();
  }

  private updateVisibleWorkBudget(): void {
    const sequence = this.sequenceTrack.getDebugSnapshot();
    const metrics = {
      rulerLineSegments: this.rulerLineSegmentsDrawn,
      sequenceFwdVisible: sequence.fwdVisible,
      sequenceRevVisible: sequence.revVisible,
      sequenceFwdChildren: sequence.fwdChildren,
      sequenceRevChildren: sequence.revChildren,
    };
    const b = STADIUM_VISIBLE_WORK_BUDGETS;
    const violations: string[] = [];
    if (metrics.rulerLineSegments > b.rulerLineSegmentsMax) {
      violations.push(`rulerLineSegments ${metrics.rulerLineSegments} > ${b.rulerLineSegmentsMax}`);
    }
    if (metrics.sequenceFwdVisible > b.sequenceVisibleBasesPerStrandMax) {
      violations.push(
        `sequenceFwdVisible ${metrics.sequenceFwdVisible} > ${b.sequenceVisibleBasesPerStrandMax}`
      );
    }
    if (metrics.sequenceRevVisible > b.sequenceVisibleBasesPerStrandMax) {
      violations.push(
        `sequenceRevVisible ${metrics.sequenceRevVisible} > ${b.sequenceVisibleBasesPerStrandMax}`
      );
    }
    if (metrics.sequenceFwdChildren > b.sequenceChildrenPerStrandMax) {
      violations.push(
        `sequenceFwdChildren ${metrics.sequenceFwdChildren} > ${b.sequenceChildrenPerStrandMax}`
      );
    }
    if (metrics.sequenceRevChildren > b.sequenceChildrenPerStrandMax) {
      violations.push(
        `sequenceRevChildren ${metrics.sequenceRevChildren} > ${b.sequenceChildrenPerStrandMax}`
      );
    }
    this.visibleWorkBudget = { budgets: b, metrics, violations };
  }

  private drawRuler(
    dims: StadiumDimensions,
    state: RenderState,
    _cx: number,
    _cy: number,
    circumferencePixels: number,
    viewLeft: number,
    viewTop: number,
    viewRight: number,
    viewBottom: number,
    _baseOffset: number = 0
  ): void {
    if (!this._layout) return;
    const path = this._layout;
    const g = this.rulerGraphics;
    const theme = webglThemeForMode(state.themeMode);
    g.clear();

    for (let i = 0; i < this.rulerCharIndex; i++) {
      this.rulerCharPool[i].visible = false;
    }
    this.rulerCharIndex = 0;
    this.rulerLabelsMeta.length = 0;
    this.rulerLineSegmentsDrawn = 0;
    this.rulerUsedAnalyticCircle = false;

    const visibleBpFraction = Math.min(
      1,
      (state.width + stadiumGeometryHeight(state)) / circumferencePixels
    );
    const estimatedVisibleBp = this.genome.length * visibleBpFraction;
    const rulerWindowBp = Math.min(this.genome.length, estimatedVisibleBp * 2);
    if (rulerWindowBp <= 0) return;
    const step = computeTickStep(rulerWindowBp);

    const TICK_LEN = 6;
    const LABEL_GAP = 4;
    const genLen = this.genome.length;
    const topMidFracLocal =
      dims.straightLength > 0 ? dims.straightLength / dims.totalLength / 2 : 0;
    const centerBp = ((((topMidFracLocal + state.viewOffset) % 1) + 1) % 1) * genLen;

    g.setStrokeStyle({ width: 2, color: theme.rulerLine, alpha: 0.7 });
    const drawAnalyticCircle = (startBp: number, endBp: number): boolean => {
      if (
        state.morph < ANALYTIC_CIRCLE_MORPH_THRESHOLD ||
        Math.abs(endBp - startBp - genLen) > FULL_CIRCLE_RANGE_EPSILON_BP
      ) {
        return false;
      }
      const p0 = path.rulerAt(startBp);
      const p1 = path.rulerAt(startBp + genLen / 2);
      const circleX = (p0.x + p1.x) / 2;
      const circleY = (p0.y + p1.y) / 2;
      const radius = Math.hypot(p0.x - p1.x, p0.y - p1.y) / 2;
      if (!Number.isFinite(radius) || radius <= 0) return false;
      g.circle(circleX, circleY, radius);
      this.rulerUsedAnalyticCircle = true;
      return true;
    };
    const drawRulerLineRange = (startBp: number, endBp: number) => {
      const spanBp = endBp - startBp;
      if (spanBp <= 0) return;
      if (drawAnalyticCircle(startBp, endBp)) return;
      const screenSpan = spanBp * Math.max(path.pixelsPerBp, 1e-4);
      const segments = Math.max(
        16,
        Math.min(MAX_RULER_CURVE_SEGMENTS, Math.ceil(screenSpan / RULER_CURVE_SEGMENT_PX))
      );
      for (let i = 0; i <= segments; i++) {
        const bp = startBp + spanBp * (i / segments);
        const pos = path.rulerAt(bp);
        if (i === 0) g.moveTo(pos.x, pos.y);
        else g.lineTo(pos.x, pos.y);
      }
      this.rulerLineSegmentsDrawn += segments;
    };
    if (rulerWindowBp >= genLen * 0.999) {
      drawRulerLineRange(0, genLen);
    } else {
      const halfVisible = rulerWindowBp / 2;
      const rawStart = centerBp - halfVisible;
      const rawEnd = centerBp + halfVisible;
      if (!this.genome.circular) {
        drawRulerLineRange(Math.max(0, rawStart), Math.min(genLen, rawEnd));
      } else {
        const spanBp = Math.min(genLen, Math.max(0, rawEnd - rawStart));
        const start = ((rawStart % genLen) + genLen) % genLen;
        const end = start + spanBp;
        if (end <= genLen) {
          drawRulerLineRange(start, end);
        } else {
          drawRulerLineRange(start, genLen);
          drawRulerLineRange(0, end - genLen);
        }
      }
    }
    g.stroke();
    this.drawBackboneSegments(path, state);
    this.drawBackbonePartInteractions(path, state);
    this.drawBackboneBoundaryHandles(path, state);

    g.setStrokeStyle({ width: 1, color: theme.rulerLine, alpha: 0.6 });

    this.lastRulerWindow = {
      step,
      centerBp,
      windowBp: rulerWindowBp,
      circular: this.genome.circular,
    };
    const candidatesBp = new Set<number>(
      enumerateCircularRulerTickBps(centerBp, rulerWindowBp, genLen, step, this.genome.circular)
    );
    const scaffoldLabels = new Map<number, number>();
    if (state.backboneSegments?.some((segment) => segment.scaffold)) {
      candidatesBp.clear();
      for (const cycle of this.genome.circular ? [-genLen, 0, genLen] : [0]) {
        const from = Math.max(0, centerBp - rulerWindowBp / 2 + cycle);
        const to = Math.min(genLen, centerBp + rulerWindowBp / 2 + cycle);
        for (const tick of assemblyScaffoldRulerTicks(
          genLen,
          state.backboneSegments,
          step,
          from,
          to
        )) {
          candidatesBp.add(tick.position);
          scaffoldLabels.set(tick.position, tick.label);
        }
      }
    }

    const placed: Array<{ bp: number; halfW: number }> = [];
    const MIN_TICK_GAP_PX = 5;
    const MIN_LABEL_GAP_PX = 4;
    const radiusPx = dims.radius * state.zoom;
    const rulerOffset = path.scaleNormalOffset(path.layoutRulerOffset);
    const rulerSpacingPxPerBp =
      path.pixelsPerBp *
      Math.max(0, Math.min(1, radiusPx > 0 ? (radiusPx - rulerOffset) / radiusPx : 0));
    const mctx = getMeasureCtx();
    const rulerFont = `${LABEL_FONT_WEIGHT} ${RULER_FONT_SIZE}px ${LABEL_FONT_FAMILY}`;
    mctx.font = rulerFont;

    const orderedBp = Array.from(candidatesBp).sort((a, b) => a - b);
    const previousTextMetrics = this.rulerTextMetrics;
    this.rulerTextMetrics = new Map();

    for (const bp of orderedBp) {
      const label = scaffoldLabels.get(bp) ?? bp;
      const key = `${rulerFontEpoch}:${label}:${step}`;
      let metrics = previousTextMetrics.get(key);
      if (!metrics) {
        const text = formatRulerLabel(label, step);
        const charWidths = Array.from(text, (char) => rulerGlyphAdvance(mctx, rulerFont, char));
        metrics = {
          text,
          charWidths,
          totalWidth: charWidths.reduce((sum, width) => sum + width, 0),
        };
      }
      this.rulerTextMetrics.set(key, metrics);
      const { text, charWidths, totalWidth } = metrics;
      const halfW = totalWidth / 2;

      let suppressed = false;
      for (const p of placed) {
        const distanceBp = Math.abs(bp - p.bp);
        const spacingBp = this.genome.circular
          ? Math.min(distanceBp, genLen - distanceBp)
          : distanceBp;
        if (
          spacingBp * rulerSpacingPxPerBp <
          Math.max(MIN_TICK_GAP_PX, halfW + p.halfW + MIN_LABEL_GAP_PX)
        ) {
          suppressed = true;
          break;
        }
      }
      if (suppressed) continue;
      placed.push({ bp, halfW });

      const pos = path.rulerAt(bp);
      if (pos.x < viewLeft || pos.x > viewRight || pos.y < viewTop || pos.y > viewBottom) continue;

      const nx = -Math.sin(pos.angle);
      const ny = Math.cos(pos.angle);
      const labelDist = TICK_LEN + LABEL_GAP;
      const labelX = pos.x + nx * labelDist;
      const labelY = pos.y + ny * labelDist;

      g.moveTo(pos.x, pos.y);
      g.lineTo(pos.x + nx * TICK_LEN, pos.y + ny * TICK_LEN);
      if (totalWidth <= 0) continue;

      const probeBack = path.rulerAt(bp - 1);
      const probeFwd = path.rulerAt(bp + 1);
      const dxp = probeFwd.x - probeBack.x;
      const dyp = probeFwd.y - probeBack.y;
      const rulerPxPerBp2 = Math.hypot(dxp, dyp) / 2;

      const rulerPxPerBp = rulerPxPerBp2 > 1e-4 ? rulerPxPerBp2 : path.pixelsPerBp;

      const cosA = Math.cos(pos.angle);
      const sinA = Math.sin(pos.angle);
      let bpDir = dxp * cosA + dyp * sinA >= 0 ? 1 : -1;

      let a = pos.angle;
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      const flip = a > Math.PI / 2 || a < -Math.PI / 2;
      if (flip) bpDir = -bpDir;

      let accumulated = 0;
      for (let i = 0; i < text.length; i++) {
        const charCenter = accumulated + charWidths[i] / 2;
        const tFrac = charCenter / totalWidth;
        const dxFromCenter = (tFrac - 0.5) * totalWidth;
        const charBp = bp + (dxFromCenter * bpDir) / rulerPxPerBp;
        const cp = path.rulerAt(charBp);
        const cnx = -Math.sin(cp.angle);
        const cny = Math.cos(cp.angle);
        const cx = cp.x + cnx * labelDist;
        const cy = cp.y + cny * labelDist;

        const rot = labelLevelTextRotation(cp.angle, flip);

        let charText: Text;
        if (this.rulerCharIndex < this.rulerCharPool.length) {
          charText = this.rulerCharPool[this.rulerCharIndex];
          charText.visible = true;
        } else {
          charText = new Text({ text: '', style: this.rulerCharStyle });
          this.rulerLayer.addChild(charText);
          this.rulerCharPool.push(charText);
        }
        this.rulerCharIndex++;

        if (charText.style !== this.rulerCharStyle) charText.style = this.rulerCharStyle;
        if (charText.text !== text[i]) charText.text = text[i];
        charText.anchor.set(0.5, 0.5);
        charText.x = cx;
        charText.y = cy;
        charText.rotation = rot;

        accumulated += charWidths[i];
      }

      this.rulerLabelsMeta.push({ text, x: labelX, y: labelY, w: totalWidth });
    }
    g.stroke();
  }

  private drawBackboneSegments(
    path: StadiumPathMapper,
    state: RenderState,
    arcSteps?: number
  ): void {
    const ranges = normalizeBackboneSegmentRanges(
      state.backboneSegments,
      this.genome.length,
      state
    );
    this.backbonePathSegmentsDrawn = 0;
    for (const range of ranges) {
      const span = range.end - range.start;
      if (span <= 0) continue;
      const pxPerBp =
        Number.isFinite(path.pixelsPerBp) && path.pixelsPerBp > 0 ? path.pixelsPerBp : 1;
      const screenSpan = span * pxPerBp;
      const steps =
        typeof arcSteps === 'number' && Number.isFinite(arcSteps)
          ? Math.max(1, Math.floor(arcSteps))
          : Math.max(
              1,
              Math.min(MAX_RULER_CURVE_SEGMENTS, Math.ceil(screenSpan / RULER_CURVE_SEGMENT_PX))
            );
      this.rulerGraphics.setStrokeStyle({
        width: range.strokeWidth,
        color: range.color,
        alpha: range.alpha,
      });
      if (
        state.morph >= ANALYTIC_CIRCLE_MORPH_THRESHOLD &&
        Math.abs(span - this.genome.length) <= FULL_CIRCLE_RANGE_EPSILON_BP
      ) {
        const p0 = path.rulerAt(range.start - 0.5);
        const p1 = path.rulerAt(range.start - 0.5 + this.genome.length / 2);
        const circleX = (p0.x + p1.x) / 2;
        const circleY = (p0.y + p1.y) / 2;
        const radius = Math.hypot(p0.x - p1.x, p0.y - p1.y) / 2;
        if (Number.isFinite(radius) && radius > 0) {
          this.rulerGraphics.circle(circleX, circleY, radius);
          this.rulerGraphics.stroke();
          this.backbonePathSegmentsDrawn++;
          continue;
        }
      }
      for (let i = 0; i <= steps; i++) {
        const bp = range.start + span * (i / steps);

        const pos = path.rulerAt(bp - 0.5);
        if (i === 0) this.rulerGraphics.moveTo(pos.x, pos.y);
        else this.rulerGraphics.lineTo(pos.x, pos.y);
      }
      this.rulerGraphics.stroke();
      this.backbonePathSegmentsDrawn++;
    }
  }

  private drawBackboneBoundaryHandles(path: StadiumPathMapper, state: RenderState): void {
    const graphics = this.backboneBoundaryHandleGraphics;
    graphics.clear();
    this.backboneBoundaryHandleHitCache.length = 0;
    for (const handle of state.backboneBoundaryHandles ?? []) {
      const preview =
        this.backboneBoundaryHandlePreview?.regionId === handle.regionId &&
        this.backboneBoundaryHandlePreview.side === handle.side
          ? this.backboneBoundaryHandlePreview
          : null;
      const boundaryBp = preview?.boundaryBp ?? handle.boundaryBp;
      const point = path.rulerAt(boundaryBp - 0.5);
      graphics.circle(point.x, point.y, BACKBONE_BOUNDARY_HANDLE_RADIUS_PX);
      graphics.fill({ color: 0xffffff, alpha: 1 });
      graphics.stroke({ color: handle.color, width: 2, alpha: 1 });
      this.backboneBoundaryHandleHitCache.push({
        x: point.x,
        y: point.y,
        radius: BACKBONE_BOUNDARY_HANDLE_HIT_RADIUS_PX,
        payload: {
          regionId: handle.regionId,
          side: handle.side,
          rangeStart: handle.rangeStart,
          rangeEnd: handle.rangeEnd,
          boundaryBp,
        },
      });
    }
  }

  private drawBackbonePartInteractions(path: StadiumPathMapper, state: RenderState): void {
    const graphics = this.backbonePartInteractionGraphics;
    graphics.clear();
    this.backbonePartHitCache.length = 0;
    this.backbonePartHoverOutline = null;
    this.selectedBackbonePartOutlineRegionId = null;
    const canonicalRanges = normalizeBackboneSegmentRanges(
      state.backboneSegments,
      this.genome.length,
      state
    );
    const ranges = this.projectBackbonePartPreviewRanges(canonicalRanges);
    if (this.backbonePartInsertionPreview?.preview) {
      for (const range of ranges) {
        if (!range.regionId || range.end <= range.start) continue;
        const points = pointsAlongBackboneRange(path, range);
        graphics.setStrokeStyle({
          width: range.strokeWidth,
          color: range.color,
          alpha: range.alpha,
        });
        strokePolyline(graphics, points);
      }
    }

    for (const range of ranges) {
      if (!range.regionId || range.end <= range.start) continue;
      const points = pointsAlongBackboneRange(path, range);
      const payload: BackbonePartHitPayload = {
        regionId: range.regionId,
        rangeStart: range.start,
        rangeEnd: range.end,
        ...(range.scaffold ? { isScaffold: true } : {}),
        ...(range.scaffold ? { scaffold: range.scaffold } : {}),
      };
      this.backbonePartHitCache.push({
        points,
        hitRadius: range.strokeWidth / 2 + BACKBONE_PART_HIT_SLOP_PX,
        payload,
      });

      const isHovered = range.regionId === this.hoveredBackbonePartRegionId;
      const isSelected = range.selected === true;
      if (isHovered || isSelected) {
        const hoverOutline = {
          regionId: range.regionId,
          width: range.strokeWidth + (isHovered ? (isSelected ? 5 : 4) : 3),
          color: sourceColorInteractionOutline(range.color, state),
          alpha: isHovered ? 0.9 : 0.74,
        };
        if (isHovered) this.backbonePartHoverOutline = hoverOutline;
        if (isSelected) this.selectedBackbonePartOutlineRegionId = range.regionId;
        graphics.setStrokeStyle(hoverOutline);
        strokePolyline(graphics, points);
        graphics.setStrokeStyle({
          width: range.strokeWidth,
          color: range.color,
          alpha: range.alpha,
        });
        strokePolyline(graphics, points);
      }
    }

    if (this.backbonePartInsertionPreview) {
      const point = path.rulerAt(this.backbonePartInsertionPreview.boundaryBp - 0.5);
      const before = path.rulerAt(this.backbonePartInsertionPreview.boundaryBp - 1.5);
      const after = path.rulerAt(this.backbonePartInsertionPreview.boundaryBp + 0.5);
      const tangentLength = Math.max(1, Math.hypot(after.x - before.x, after.y - before.y));
      const nx = -(after.y - before.y) / tangentLength;
      const ny = (after.x - before.x) / tangentLength;
      graphics.moveTo(point.x - nx * 10, point.y - ny * 10);
      graphics.lineTo(point.x + nx * 10, point.y + ny * 10);
      const movedColor =
        canonicalRanges.find(
          (range) => range.regionId === this.backbonePartInsertionPreview?.regionId
        )?.color ?? 0x111827;
      graphics.stroke({
        color: sourceColorInteractionOutline(movedColor, state),
        width: 3,
        alpha: 1,
      });
    }
  }

  private projectBackbonePartPreviewRanges(
    canonicalRanges: BackboneSegmentRange[]
  ): BackboneSegmentRange[] {
    const previewRanges = this.backbonePartInsertionPreview?.preview?.ranges;
    if (!previewRanges?.length) return canonicalRanges;
    const canonicalByRegionId = new Map(
      canonicalRanges.flatMap((range) => (range.regionId ? [[range.regionId, range] as const] : []))
    );
    const projected = previewRanges.flatMap((previewRange) => {
      const canonical = canonicalByRegionId.get(previewRange.regionId);
      if (
        !canonical ||
        !Number.isFinite(previewRange.rangeStart) ||
        !Number.isFinite(previewRange.rangeEnd) ||
        previewRange.rangeStart < 0 ||
        previewRange.rangeEnd > this.genome.length ||
        previewRange.rangeEnd <= previewRange.rangeStart
      ) {
        return [];
      }
      return [
        {
          ...canonical,
          start: previewRange.rangeStart,
          end: previewRange.rangeEnd,
        },
      ];
    });
    return projected.length === previewRanges.length ? projected : canonicalRanges;
  }

  hitTestBackbonePart(screenX: number, screenY: number): WebGLHitTarget | null {
    let nearest: {
      payload: BackbonePartHitPayload;
      distance: number;
      startsAtPointer: boolean;
    } | null = null;
    for (const record of this.backbonePartHitCache) {
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 1; index < record.points.length; index += 1) {
        distance = Math.min(
          distance,
          distanceToSegment(screenX, screenY, record.points[index - 1], record.points[index])
        );
      }
      if (distance > record.hitRadius) continue;

      const start = record.points[0];
      const startsAtPointer =
        Math.hypot(screenX - start.x, screenY - start.y) <= BACKBONE_PART_HIT_TIE_EPSILON_PX;
      const isNearer =
        nearest === null || distance < nearest.distance - BACKBONE_PART_HIT_TIE_EPSILON_PX;
      const winsBoundaryTie =
        nearest !== null &&
        Math.abs(distance - nearest.distance) <= BACKBONE_PART_HIT_TIE_EPSILON_PX &&
        startsAtPointer &&
        !nearest.startsAtPointer;
      if (isNearer || winsBoundaryTie) {
        nearest = { payload: record.payload, distance, startsAtPointer };
      }
    }
    return nearest ? { kind: 'backbone-part', payload: nearest.payload } : null;
  }

  setHoveredBackbonePart(regionId: string | null): boolean {
    if (regionId !== null) {
      const exists = this.getState().backboneSegments?.some(
        (segment) => segment.regionId === regionId
      );
      if (!exists) return false;
    }
    if (regionId === this.hoveredBackbonePartRegionId) return false;
    this.hoveredBackbonePartRegionId = regionId;
    return true;
  }

  setBackbonePartInsertionPreview(
    part: BackbonePartHitPayload,
    boundaryBp: number,
    preview: BackbonePartReorderPreview | null = null
  ): boolean {
    if (!Number.isFinite(boundaryBp) || this.genome.length <= 0) return false;
    const exists = this.getState().backboneSegments?.some(
      (segment) => segment.regionId === part.regionId
    );
    if (!exists) return false;
    this.backbonePartInsertionPreview = {
      regionId: part.regionId,
      boundaryBp: Math.max(0, Math.min(this.genome.length, Math.round(boundaryBp))),
      preview: preview
        ? {
            ranges: preview.ranges.map((range) => ({ ...range })),
          }
        : null,
    };
    return true;
  }

  clearBackbonePartInsertionPreview(): void {
    this.backbonePartInsertionPreview = null;
  }

  hitTestBackboneBoundaryHandle(screenX: number, screenY: number): WebGLHitTarget | null {
    for (let index = this.backboneBoundaryHandleHitCache.length - 1; index >= 0; index -= 1) {
      const record = this.backboneBoundaryHandleHitCache[index];
      if (Math.hypot(screenX - record.x, screenY - record.y) <= record.radius) {
        return { kind: 'backbone-boundary-handle', payload: record.payload };
      }
    }
    return null;
  }

  setBackboneBoundaryHandlePreview(
    handle: BackboneBoundaryHandleHitPayload,
    boundaryBp: number
  ): boolean {
    if (!Number.isFinite(boundaryBp) || this.genome.length <= 0) return false;
    const canonical = this.getState().backboneBoundaryHandles?.find(
      (candidate) => candidate.regionId === handle.regionId && candidate.side === handle.side
    );
    if (!canonical) return false;
    this.backboneBoundaryHandlePreview = {
      regionId: handle.regionId,
      side: handle.side,
      boundaryBp: Math.max(0, Math.min(this.genome.length, Math.round(boundaryBp))),
    };
    return true;
  }

  clearBackboneBoundaryHandlePreview(): void {
    this.backboneBoundaryHandlePreview = null;
  }

  private drawHoveredCodonBackground(): void {
    if (!this._layout || this.genome.length <= 0) return;
    const state = this.getState();
    const codon = state.hoveredCodon;
    if (!codon) return;

    const path = this._layout;
    const L = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    if (!L.sequenceVisible) return;

    const len = this.genome.length;
    const topOffset = codon.strand === -1 ? L.revStrandOffset : L.fwdStrandOffset;
    const bottomOffset = topOffset + L.rowHeight;
    const pointAtBoundary = (bp: number, offset: number) =>
      path.featureLabelPosAt(bp - 0.5, offset);
    const g = this.interactionGraphics;

    const drawArc = (a: number, b: number) => {
      const spanBp = b - a;
      if (spanBp <= 0) return;
      const segs = Math.max(2, Math.min(64, Math.ceil((spanBp * path.pixelsPerBp) / 6)));
      const topPts: number[] = [];
      const bottomPts: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const bp = a + spanBp * (i / segs);
        const top = pointAtBoundary(bp, topOffset);
        const bottom = pointAtBoundary(bp, bottomOffset);
        topPts.push(top.x, top.y);
        bottomPts.push(bottom.x, bottom.y);
      }
      const reversedBottom: number[] = [];
      for (let i = bottomPts.length - 2; i >= 0; i -= 2) {
        reversedBottom.push(bottomPts[i], bottomPts[i + 1]);
      }
      g.poly([...topPts, ...reversedBottom]);
      g.fill({ color: 0x8c8c8c, alpha: 0.25 });
    };

    if (this.genome.circular && codon.end < codon.start) {
      drawArc(codon.start, len);
      drawArc(0, codon.end + 1);
    } else {
      drawArc(codon.start, Math.min(codon.end + 1, len));
    }
  }

  private drawDigestFocusMask(range: [number, number]): void {
    if (!this._layout || this.genome.length <= 0) return;
    const state = this.getState();
    const path = this._layout;
    const L = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const interactionContract = resolveInteractionOverlayContract({ layout: L, mode: 'stadium' });
    const band = requireTrackLaneEnvelope(interactionContract, 'selection-band');
    const theme = webglThemeForMode(state.themeMode);
    const g = this.interactionGraphics;

    for (const segment of digestFocusMaskSegments(range, this.genome.length)) {
      const polygon = path.featurePolygonAt(
        segment.start,
        segment.end,
        (band.minOffset + band.maxOffset) / 2,
        (band.maxOffset - band.minOffset) / 2
      );
      if (polygon.length === 0) continue;
      g.poly(polygon);
      g.fill({ color: theme.digestFocusMask, alpha: theme.digestFocusMaskAlpha });
    }
  }

  private drawHighlightRange(
    range: [number, number],
    _dims: StadiumDimensions,
    _state: RenderState,
    _cx: number,
    _cy: number
  ): void {
    if (!this._layout) return;
    const path = this._layout;
    const L = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const theme = webglThemeForMode(_state.themeMode);
    const len = this.genome.length;

    const [startBp, endBp] = range;
    const endBoundaryBp = Math.min(endBp + 1, len);

    const interactionContract = resolveInteractionOverlayContract({ layout: L, mode: 'stadium' });
    const band = requireTrackLaneEnvelope(interactionContract, 'selection-band');
    const outerOffset = band.minOffset;
    const innerOffset = band.maxOffset;
    const pointAtBoundary = (bp: number, offset: number) =>
      path.featureLabelPosAt(bp - 0.5, offset);

    const selectionGraphics = this.selectionGraphics;
    const wraps = endBp < startBp;

    const drawArc = (a: number, b: number) => {
      const spanBp = b - a;
      if (spanBp <= 0) return;
      const segs = Math.max(16, Math.min(256, Math.round((spanBp / len) * 512)));
      const outerPts: number[] = [];
      const innerPts: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const bp = a + spanBp * (i / segs);
        const outer = pointAtBoundary(bp, outerOffset);
        const inner = pointAtBoundary(bp, innerOffset);
        outerPts.push(outer.x, outer.y);
        innerPts.push(inner.x, inner.y);
      }
      const reversed: number[] = [];
      for (let i = innerPts.length - 2; i >= 0; i -= 2) reversed.push(innerPts[i], innerPts[i + 1]);
      selectionGraphics.poly([...outerPts, ...reversed]);
      selectionGraphics.fill({ color: theme.selectionFill, alpha: theme.selectionFillAlpha });
      this.rulerHighlightShapes++;
    };

    if (wraps) {
      drawArc(startBp, len);
      drawArc(0, endBp + 1);
    } else {
      drawArc(startBp, endBoundaryBp);
    }

    const endEdgeBp = wraps ? endBp + 1 : endBoundaryBp;
    const startOuter = pointAtBoundary(startBp, outerOffset);
    const startInner = pointAtBoundary(startBp, innerOffset);
    const endOuter = pointAtBoundary(endEdgeBp, outerOffset);
    const endInner = pointAtBoundary(endEdgeBp, innerOffset);
    const drawDebugKey = [
      startBp,
      endBp,
      endBoundaryBp,
      wraps ? 1 : 0,
      _state.zoom.toFixed(4),
      _state.viewOffset.toFixed(6),
      _state.width,
      _state.height,
      this._stagePosX.toFixed(2),
      this._stagePosY.toFixed(2),
    ].join(':');
    if (drawDebugKey !== this.lastSelectionDrawDebugKey) {
      this.lastSelectionDrawDebugKey = drawDebugKey;
      recordWebGLSelectionDebug('stadium.drawHighlightRange', {
        range,
        wraps,
        endBoundaryBp,
        state: {
          width: _state.width,
          height: _state.height,
          zoom: _state.zoom,
          viewOffset: _state.viewOffset,
          morph: _state.morph,
        },
        camera: {
          stagePosX: this._stagePosX,
          stagePosY: this._stagePosY,
          ox: this._ox,
          oy: this._oy,
        },
        dims: this._dims,
        endpoints: {
          startOuter,
          startInner,
          endOuter,
          endInner,
          startBackbone: path.boundaryAt(startBp, 'backbone'),
          endBackbone: path.boundaryAt(endEdgeBp, 'backbone'),
        },
      });
    }
    const g = this.interactionGraphics;
    g.setStrokeStyle({ width: 2, color: theme.selectionStroke, alpha: 1.0 });
    g.moveTo(startOuter.x, startOuter.y);
    g.lineTo(startInner.x, startInner.y);
    g.stroke();
    g.moveTo(endOuter.x, endOuter.y);
    g.lineTo(endInner.x, endInner.y);
    g.stroke();
  }

  private drawResidueLinkRange(range: [number, number]): void {
    if (!this._layout) return;
    const path = this._layout;
    const L = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const len = this.genome.length;

    const [startBp, endBp] = range;
    const endBoundaryBp = Math.min(endBp + 1, len);
    const interactionContract = resolveInteractionOverlayContract({ layout: L, mode: 'stadium' });
    const band = requireTrackLaneEnvelope(interactionContract, 'selection-band');
    const outerOffset = band.minOffset;
    const innerOffset = band.maxOffset;
    const pointAtBoundary = (bp: number, offset: number) =>
      path.featureLabelPosAt(bp - 0.5, offset);

    const g = this.interactionGraphics;
    const wraps = endBp < startBp;

    const RESIDUE_LINK_FILL = 0xfbbf24;
    const RESIDUE_LINK_FILL_ALPHA = 0.45;

    const drawArc = (a: number, b: number) => {
      const spanBp = b - a;
      if (spanBp <= 0) return;

      const segs = Math.max(8, Math.min(64, Math.round((spanBp / len) * 512)));
      const outerPts: number[] = [];
      const innerPts: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const bp = a + spanBp * (i / segs);
        const outer = pointAtBoundary(bp, outerOffset);
        const inner = pointAtBoundary(bp, innerOffset);
        outerPts.push(outer.x, outer.y);
        innerPts.push(inner.x, inner.y);
      }
      const reversed: number[] = [];
      for (let i = innerPts.length - 2; i >= 0; i -= 2) reversed.push(innerPts[i], innerPts[i + 1]);
      g.poly([...outerPts, ...reversed]);
      g.fill({ color: RESIDUE_LINK_FILL, alpha: RESIDUE_LINK_FILL_ALPHA });
    };

    if (wraps) {
      drawArc(startBp, len);
      drawArc(0, endBp + 1);
    } else {
      drawArc(startBp, endBoundaryBp);
    }
  }

  private syncEditingCursorBlink(state: RenderState): void {
    const active =
      state.cursorBlinking === true && !state.highlightRange && state.cursorPosition != null;
    const position = active ? state.cursorPosition : null;
    if (active !== this.editingCursorBlinkActive || position !== this.editingCursorBlinkPosition) {
      this.clearEditingCursorBlinkTimer();
      this.editingCursorBlinkActive = active;
      this.editingCursorBlinkPosition = position;
      this.editingCursorGraphics.visible = active;
    }
    if (!active) {
      this.editingCursorGraphics.visible = false;
      this.clearEditingCursorBlinkTimer();
      return;
    }
    this.scheduleEditingCursorBlink();
  }

  private scheduleEditingCursorBlink(): void {
    if (this.editingCursorBlinkTimer !== null || !this.editingCursorBlinkActive) return;
    this.editingCursorBlinkTimer = setTimeout(() => {
      this.editingCursorBlinkTimer = null;
      if (!this.editingCursorBlinkActive) return;
      this.editingCursorGraphics.visible = !this.editingCursorGraphics.visible;

      this.app.render();
      this.scheduleEditingCursorBlink();
    }, EDITING_CURSOR_BLINK_INTERVAL_MS);
  }

  private clearEditingCursorBlinkTimer(): void {
    if (this.editingCursorBlinkTimer === null) return;
    clearTimeout(this.editingCursorBlinkTimer);
    this.editingCursorBlinkTimer = null;
  }

  getCursorDebugSnapshot(): {
    blinking: boolean;
    visible: boolean;
    position: number | null;
  } {
    return {
      blinking: this.editingCursorBlinkActive,
      visible: this.editingCursorGraphics.visible,
      position: this.editingCursorBlinkPosition,
    };
  }

  private drawCursor(bp: number, g: Graphics): void {
    if (!this._layout) return;
    const path = this._layout;
    const L = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const theme = webglThemeForMode(this.getState().themeMode);
    const interactionContract = resolveInteractionOverlayContract({ layout: L, mode: 'stadium' });
    const band = requireTrackLaneEnvelope(interactionContract, 'cursor-line');
    const outerOffset = band.minOffset;
    const innerOffset = band.maxOffset;
    const outer = path.featureLabelPosAt(bp - 0.5, outerOffset);
    const inner = path.featureLabelPosAt(bp - 0.5, innerOffset);

    g.setStrokeStyle({ width: 2, color: theme.selectionStroke, alpha: 1.0 });
    g.moveTo(outer.x, outer.y);
    g.lineTo(inner.x, inner.y);
    g.stroke();
  }

  private drawHoverCursor(bp: number): void {
    if (!this._layout) return;
    const path = this._layout;
    const L = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const theme = webglThemeForMode(this.getState().themeMode);
    const interactionContract = resolveInteractionOverlayContract({ layout: L, mode: 'stadium' });
    const band = requireTrackLaneEnvelope(interactionContract, 'cursor-line');
    const outerOffset = band.minOffset;
    const innerOffset = band.maxOffset;
    const outer = path.featureLabelPosAt(bp - 0.5, outerOffset);
    const inner = path.featureLabelPosAt(bp - 0.5, innerOffset);

    const g = this.interactionGraphics;
    g.setStrokeStyle({ width: 1.5, color: theme.selectionStroke, alpha: 0.55 });
    drawDashedLine(g, outer.x, outer.y, inner.x, inner.y, 5, 4);
  }

  screenToBp(screenX: number, screenY: number, state: RenderState): number {
    const frame = this.computeFrameForState(state);

    const worldX = (screenX - frame.stagePosX) / state.zoom - frame.ox;
    const worldY = (screenY - frame.stagePosY) / state.zoom - frame.oy;
    const debug = closestSeqPosOnBackboneDebug(
      worldX,
      worldY,
      frame.dims,
      0,
      this.genome.length,
      state.viewOffset
    );
    const roundtrip = this._layout?.backboneAt(debug.seqPos) ?? null;
    recordWebGLSelectionDebug('stadium.screenToBp', {
      screen: { x: screenX, y: screenY },
      state: {
        width: state.width,
        height: state.height,
        zoom: state.zoom,
        viewOffset: state.viewOffset,
        morph: state.morph,
        highlightRange: state.highlightRange,
      },
      camera: {
        stagePosX: frame.stagePosX,
        stagePosY: frame.stagePosY,
        ox: frame.ox,
        oy: frame.oy,
      },
      dims: frame.dims,
      world: { x: worldX, y: worldY },
      resultBp: debug.seqPos,
      bestCandidate: debug.best,
      candidates: debug.candidates,
      roundtrip: roundtrip
        ? {
            x: roundtrip.x,
            y: roundtrip.y,
            distancePx: Math.hypot(roundtrip.x - screenX, roundtrip.y - screenY),
          }
        : null,
    });
    return debug.seqPos;
  }

  screenToBoundaryBp(screenX: number, screenY: number, state: RenderState): number {
    const frame = this.computeFrameForState(state);
    const worldX = (screenX - frame.stagePosX) / state.zoom - frame.ox;
    const worldY = (screenY - frame.stagePosY) / state.zoom - frame.oy;
    const debug = closestSeqPosOnBackboneDebug(
      worldX,
      worldY,
      frame.dims,
      0,
      this.genome.length,
      state.viewOffset
    );
    const unwrappedBp =
      debug.best.normalizedPos * this.genome.length + state.viewOffset * this.genome.length;
    const boundary = Math.round(unwrappedBp + 0.5);
    return ((boundary % this.genome.length) + this.genome.length) % this.genome.length;
  }

  screenToPrimerBoundaryBp(
    screenX: number,
    screenY: number,
    state: RenderState,
    renderId: number
  ): number {
    const normalOffsetPx = this.primerOverlay.getPbsHandleNormalOffsetPx(renderId);
    if (normalOffsetPx === null) return this.screenToBoundaryBp(screenX, screenY, state);
    const frame = this.computeFrameForState(state);
    const worldX = (screenX - frame.stagePosX) / state.zoom - frame.ox;
    const worldY = (screenY - frame.stagePosY) / state.zoom - frame.oy;
    const debug = closestSeqPosOnBackboneDebug(
      worldX,
      worldY,
      frame.dims,
      0,
      this.genome.length,
      state.viewOffset,
      normalOffsetPx / state.zoom
    );
    const unwrappedBp =
      debug.best.normalizedPos * this.genome.length + state.viewOffset * this.genome.length;
    const boundary = Math.round(unwrappedBp + 0.5);
    return ((boundary % this.genome.length) + this.genome.length) % this.genome.length;
  }

  getViewCenterBp(state: RenderState): number {
    if (!this.genome?.length) return 0;
    const frame = this.computeFrameForState(state);
    const topMidFrac =
      frame.dims.straightLength > 0 ? frame.dims.straightLength / frame.dims.totalLength / 2 : 0;
    return ((((topMidFrac + state.viewOffset) % 1) + 1) % 1) * this.genome.length;
  }

  setViewCenterBp(bp: number, state: RenderState): void {
    if (!this.genome?.length) return;
    const frame = this.computeFrameForState(state);
    const topMidFrac =
      frame.dims.straightLength > 0 ? frame.dims.straightLength / frame.dims.totalLength / 2 : 0;
    const targetNorm = Math.max(0, Math.min(this.genome.length - 1, bp)) / this.genome.length;
    state.viewOffset = (((targetNorm - topMidFrac) % 1) + 1) % 1;
  }

  hitTestZoomAnchor(screenX: number, screenY: number, state: RenderState): boolean {
    const path = this._layout;
    if (!path || !this.genome?.length) return false;
    const { layout } = this.computeFrameForState(state);

    const interactionContract = resolveInteractionOverlayContract({ layout, mode: 'stadium' });
    const band = requireTrackLaneEnvelope(interactionContract, 'cursor-line');
    const outerOffset = band.minOffset;
    const innerOffset = band.maxOffset;
    const bp = this.screenToBp(screenX, screenY, state);
    const outer = path.featureLabelPosAt(bp - 0.5, outerOffset);
    const inner = path.featureLabelPosAt(bp - 0.5, innerOffset);
    return distanceToSegment(screenX, screenY, outer, inner) <= 10;
  }

  adjustViewOffsetForZoom(
    _oldZoom: number,
    newZoom: number,
    state: RenderState,
    cursorX = state.width / 2,
    cursorY = state.height / 2
  ): void {
    if (!this.genome?.length || newZoom <= 0) return;

    const anchorBp = this.screenToBp(cursorX, cursorY, state);
    const frame = this.computeFrameForState(state, newZoom);
    const worldX = (cursorX - frame.stagePosX) / newZoom - frame.ox;
    const worldY = (cursorY - frame.stagePosY) / newZoom - frame.oy;
    const targetNorm = closestSeqPosOnBackboneDebug(
      worldX,
      worldY,
      frame.dims,
      0,
      this.genome.length,
      0
    ).best.normalizedPos;
    const anchorNorm = anchorBp / this.genome.length;
    state.viewOffset = (((anchorNorm - targetNorm) % 1) + 1) % 1;
  }

  hitTestSelectionHandle(
    screenX: number,
    screenY: number,
    state: RenderState
  ): 'start' | 'end' | null {
    const range = state.highlightRange;
    if (!range) return null;
    const startLine = this.selectionHandleLineAt(range[0]);
    const endLine = this.selectionHandleLineAt(Math.min(range[1] + 1, this.genome.length));
    if (!startLine || !endLine) return null;

    const startDist = distanceToSegment(screenX, screenY, startLine.outer, startLine.inner);
    const endDist = distanceToSegment(screenX, screenY, endLine.outer, endLine.inner);
    const tolerancePx = 8;
    const best = startDist <= endDist ? 'start' : 'end';
    const bestDist = Math.min(startDist, endDist);
    return bestDist <= tolerancePx ? best : null;
  }

  hitTestNucleotideText(screenX: number, screenY: number, state: RenderState): boolean {
    if (!this._layout || !this._dims) return false;
    const path = this._layout;
    const L = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    if (!L.sequenceVisible || L.sequenceOpacity <= 0) return false;

    const dims = this._dims;
    const worldX = (screenX - this._stagePosX) / state.zoom - this._ox;
    const worldY = (screenY - this._stagePosY) / state.zoom - this._oy;
    const closest = closestSeqPosOnBackboneDebug(
      worldX,
      worldY,
      dims,
      0,
      this.genome.length,
      state.viewOffset
    );
    const fwd = path.fwdStrandAt(closest.seqPos);
    const rev = path.revStrandAt(closest.seqPos);
    const tolerance = Math.max(4, L.rowHeight / 2 + 2);
    return (
      Math.hypot(screenX - fwd.x, screenY - fwd.y) <= tolerance ||
      Math.hypot(screenX - rev.x, screenY - rev.y) <= tolerance
    );
  }

  hitTestCodon(
    screenX: number,
    screenY: number
  ): {
    start: number;
    end: number;
    featureId: number;
    featureStart: number;
    featureEnd: number;
    strand: 1 | -1;
  } | null {
    return this.codonTrack.hitTest(screenX, screenY);
  }

  hitTestIntron(screenX: number, screenY: number) {
    return this.codonTrack.hitTestIntron(screenX, screenY);
  }

  hitTestOrf(screenX: number, screenY: number) {
    return this.orfTrack.hitTest(screenX, screenY);
  }

  hitTestCutSite(screenX: number, screenY: number): WebGLHitTarget | null {
    return this.restrictionTrack.hitTest(screenX, screenY);
  }

  private selectionHandleLineAt(bp: number): {
    outer: { x: number; y: number };
    inner: { x: number; y: number };
  } | null {
    if (!this._layout) return null;
    const path = this._layout;
    const L = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const interactionContract = resolveInteractionOverlayContract({ layout: L, mode: 'stadium' });
    const band = requireTrackLaneEnvelope(interactionContract, 'selection-band');
    const outerOffset = band.minOffset;
    const innerOffset = band.maxOffset;
    return {
      outer: path.featureLabelPosAt(bp - 0.5, outerOffset),
      inner: path.featureLabelPosAt(bp - 0.5, innerOffset),
    };
  }

  getLastLodDist(): LodDist {
    return { hidden: 0, rect: 0, arrow: 0, detailed: 0 };
  }

  getLODTier(featureLength: number, zoom: number): LODTier {
    const dims = getStadiumDimensions(800, 600, 0, 80);
    return computeLODTier(featureLength, this.genome.length / zoom, dims.totalLength);
  }

  destroy(): void {
    this.editingCursorBlinkActive = false;
    this.clearEditingCursorBlinkTimer();
    for (const t of this.rulerCharPool) destroyPixiText(t);
    this.rulerCharPool = [];
    this.rulerTextMetrics.clear();
    this.codonTrack.destroy();
    this.orfTrack.destroy();
    this.restrictionTrack.destroy();
    this.sequenceTrack.destroy();
    this.overlayRegistry.destroyAll();
    this.uiContainer.destroy();
    this.selectionGraphics.destroy();
    this.selectionLayer.destroy();

    this.interactionGraphics.destroy();
    this.editingCursorGraphics.destroy();
    this.backbonePartInteractionGraphics.destroy();
    this.backboneBoundaryHandleGraphics.destroy();
    this.interactionLayer.destroy();
    this.rulerGraphics.destroy();
    this.rulerLayer.destroy();
  }
}
