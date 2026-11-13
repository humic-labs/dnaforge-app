import type { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { webglAnnotationColorForMode } from '../shared/theme';
import { advanceBpByScreenWidth } from '../shared/lane-path';
import { computeBBox } from './hit-testing';
import { reserveLabelBounds, type LabelOccupancyRecord } from '../shared/label-occupancy';
import {
  OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
  planImmediateAnnotationRender,
} from './annotation-lod-policy';
import { planLinearImmediateAnnotationRender } from './linear-lod-policy';
import { retainedOverviewAnnotationStyle } from '../overview/retained-overview-style';
import {
  GraphicsPrimitiveSink,
  type FeaturePrimitiveSink,
} from '../overview/feature-primitive-sink';
import type {
  AnnotationDrawAuditDecision,
  AnnotationDrawAuditSnapshot,
} from './annotation-draw-audit';
import type { AnnotationFrameRenderMode } from './annotation-render-mode';
import type {
  AnnotationOverviewCacheContext,
  OverviewAggregationCache,
} from './annotation-overview-cache';
import { drawTranscriptIntronChevrons } from './indexed-annotation-draw-geometry';

export const RETAINED_TRANSCRIPT_DECORATION_MIN_PIXELS_PER_BP = 0.0005;
export const RETAINED_TRANSCRIPT_DECORATION_FULL_PIXELS_PER_BP = 0.003;
export const DECORATION_CACHE_MARGIN_VIEWPORTS = 1.5;

export type RetainedDrawHost = {
  genomeLength: number;
  features: Feature[];
  featuresInRange(startBp: number, endBp: number): Feature[];
  featureWindowIndex: {
    candidatesForPath(path: PathMapper, features: readonly Feature[]): Iterable<Feature>;
  };
  featureOffset(feature: Feature): number;
  scaledBarHeight(): number;
  graphics: Graphics;
  retainedTranscriptDecorationGraphics: Graphics;
  curvedLabels: { reset(): void };
  labelPool: ReadonlyArray<{ visible: boolean }>;
  labelIndex: number;
  hitCache: { length: number };
  outlineCache: { clear(): void };
  labelOccupancyCache: LabelOccupancyRecord[];
  decorationCacheKey: string;
  decorationCacheAnchorViewStartBp: number;
  decorationCacheAnchorPpb: number;
  decorationCacheBuiltLoBp: number;
  decorationCacheBuiltHiBp: number;
  retainedLinearTranscriptKey: string;
  retainedLinearTranscriptLayoutKey(state: RenderState): string;
  lastRetainedTranscriptDecorationsDrawn: boolean;
  retainedTranscriptDecorationBuilds: number;
  immediateDrawStateClearedForRetained: boolean;
  retainedDrawStateClean: boolean;
  renderCallCount: number;
  geometryRebuildCount: number;
  geometryCacheHitCount: number;
  lastRenderMode: AnnotationFrameRenderMode;
  lastRenderKey: string;
  lastRenderKeyParts: Record<string, string> | null;
  lastGeometryRebuildReasons: string[];
  lastDrawAudit: AnnotationDrawAuditSnapshot | null;
  drawAuditFrameId: number;
  lastDrawnFeatureCount: number;
  lastOverviewImmediateBlendMs: number;
  lastOverviewAggregationCacheHit: boolean;
  lastOverviewAggregationEnabled: boolean;
  lastOverviewPassthroughFeatureCount: number;
  lastOverviewCacheMs: number;
  lastOverviewLodCompressionBlend: number;
  lastOverviewLodFullShapeBlend: number;
  lastOverviewDensityAtlasSampleScreenPx: number;
  lastOverviewDensityAtlasBinBp: number;
  lastOverviewDensityAtlasLevelCount: number;
  lastOverviewDensityAtlasEstimatedBinCount: number;
  lastOverviewDensityAtlasWasCoarsened: boolean;
  lastOverviewDensityAtlasBudgetExceeded: boolean;
  overviewBinDrawCount: number;
  retainedOverviewHitBins: unknown[];
  retainedOverviewLayer: { hide(): void } | null;
  overviewCache: {
    getOverviewAggregationCache(
      path: PathMapper,
      context: AnnotationOverviewCacheContext
    ): OverviewAggregationCache | null;
    mergedDensityAtlasDiagnostics(): {
      estimatedBinCount: number;
      wasCoarsened: boolean;
      budgetExceeded: boolean;
    };
    lastCacheHit: boolean;
  };
  overviewCacheContext(): AnnotationOverviewCacheContext;
  resetAllPresentersToHidden(): void;
  clearDecorationCache(): void;
  resetImmediateDrawStats(): void;
  renderKeyParts(state: RenderState): Record<string, string>;
  renderKeyFromParts(parts: Record<string, string>): string;
  renderKeyChangeReasons(next: Record<string, string>): string[];
  beginDrawAudit(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: OverviewAggregationCache | null
  ): AnnotationDrawAuditSnapshot;
  recordDrawAuditDecision(
    audit: AnnotationDrawAuditSnapshot,
    feature: Feature,
    decision: AnnotationDrawAuditDecision,
    path: PathMapper
  ): void;
  renderImmediateFeature(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    useOverviewAggregation: boolean,
    forceTinyFeatureShapes?: boolean
  ): AnnotationDrawAuditDecision;
  renderInteractionOutlines(path: PathMapper, state: RenderState): void;
  drawRetainedTranscriptIntronConnectors(
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,
    clipRange?: { lo: number; hi: number }
  ): void;
};

export function reserveAnnotationPillBounds(
  host: Pick<RetainedDrawHost, 'genomeLength' | 'labelOccupancyCache'>,
  state: RenderState,
  path: PathMapper,
  startBp: number,
  widthPx: number,
  offset: number,
  halfHeight: number,
  record: { kind: string; featureId?: number; text?: string },
  force = false
): boolean {
  if (widthPx <= 0) return false;
  const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offset);
  const pts = path.featurePolygonAt(startBp, endBp, offset, halfHeight);
  const bounds = computeBBox(pts);
  const reserved = reserveLabelBounds(state, bounds, record, { force });
  if (reserved) {
    host.labelOccupancyCache.push({ ...bounds, ...record });
  }
  return reserved;
}

export function replayAnnotationLabelOccupancy(
  host: Pick<RetainedDrawHost, 'labelOccupancyCache'>,
  state: RenderState
): void {
  for (const { xMin, xMax, yMin, yMax, kind, featureId, text } of host.labelOccupancyCache) {
    reserveLabelBounds(
      state,
      { xMin, xMax, yMin, yMax },
      { kind, featureId, text },
      { force: true }
    );
  }
}

export function decorationCacheKeyFor(
  host: Pick<
    RetainedDrawHost,
    'retainedLinearTranscriptKey' | 'retainedLinearTranscriptLayoutKey' | 'scaledBarHeight'
  >,
  batchedTranscriptSet: ReadonlySet<Feature>,
  ppb: number,
  state: RenderState
): string {
  return [
    'chev',
    `bn:${batchedTranscriptSet.size}`,
    `fs:${host.retainedLinearTranscriptKey}`,
    `ppb:${ppb}`,
    `th:${state.themeMode ?? 'light'}`,
    `layout:${host.retainedLinearTranscriptLayoutKey(state)}`,
    `bh:${host.scaledBarHeight()}`,
  ].join('|');
}

export function renderRetainedTranscriptDecorations(
  host: RetainedDrawHost,
  batchedTranscriptSet: ReadonlySet<Feature> | null,
  path: PathMapper,
  state: RenderState,
  sourceFeatures: readonly Feature[] = host.features
): void {
  const g = host.retainedTranscriptDecorationGraphics;
  const ppb = path.pixelsPerBp;
  const minPpb = RETAINED_TRANSCRIPT_DECORATION_MIN_PIXELS_PER_BP;
  const fullPpb = RETAINED_TRANSCRIPT_DECORATION_FULL_PIXELS_PER_BP;
  const lodAlpha = ppb >= fullPpb ? 1 : ppb <= minPpb ? 0 : (ppb - minPpb) / (fullPpb - minPpb);
  const batchedSet =
    batchedTranscriptSet && batchedTranscriptSet.size > 0 && lodAlpha > 0
      ? batchedTranscriptSet
      : null;
  if (!batchedSet) {
    g.clear();
    g.visible = false;
    g.position.x = 0;
    host.decorationCacheKey = '';
    host.lastRetainedTranscriptDecorationsDrawn = false;
    return;
  }
  host.lastRetainedTranscriptDecorationsDrawn = true;

  const decorationAlpha = 0.85 * lodAlpha;
  const cacheKey = decorationCacheKeyFor(host, batchedSet, ppb, state);

  const viewStartBp = path.viewStartBp;
  const viewEndBp = path.viewEndBp;
  const ppbMatches = ppb === host.decorationCacheAnchorPpb;
  const insideBuilt =
    viewStartBp >= host.decorationCacheBuiltLoBp && viewEndBp <= host.decorationCacheBuiltHiBp;
  if (cacheKey !== '' && cacheKey === host.decorationCacheKey && ppbMatches && insideBuilt) {
    g.position.x = (host.decorationCacheAnchorViewStartBp - viewStartBp) * ppb;
    g.visible = true;
    return;
  }

  g.clear();
  g.visible = true;
  g.position.x = 0;
  const span = Math.max(1, viewEndBp - viewStartBp);
  const margin = span * DECORATION_CACHE_MARGIN_VIEWPORTS;
  const clipRange = { lo: viewStartBp - margin, hi: viewEndBp + margin };

  const buildCandidates =
    sourceFeatures === host.features
      ? host.featuresInRange(clipRange.lo, clipRange.hi)
      : sourceFeatures.filter(
          (feature) => feature.start < clipRange.hi && feature.end > clipRange.lo
        );
  for (const feature of buildCandidates) {
    if (!batchedSet.has(feature)) continue;
    host.drawRetainedTranscriptIntronConnectors(
      g,
      feature,
      path,
      state,
      decorationAlpha,
      clipRange
    );
    drawTranscriptIntronChevrons(
      g,
      feature,
      path,
      state,
      decorationAlpha,
      host.featureOffset(feature),
      clipRange
    );
  }

  host.decorationCacheKey = cacheKey;
  host.decorationCacheAnchorViewStartBp = viewStartBp;
  host.decorationCacheAnchorPpb = ppb;
  host.decorationCacheBuiltLoBp = clipRange.lo;
  host.decorationCacheBuiltHiBp = clipRange.hi;
  host.retainedTranscriptDecorationBuilds += 1;
}

export function renderAnnotationOverlayFrame(
  host: RetainedDrawHost,
  path: PathMapper,
  state: RenderState
): void {
  host.immediateDrawStateClearedForRetained = false;
  host.retainedDrawStateClean = false;
  host.resetAllPresentersToHidden();
  host.retainedOverviewLayer?.hide();
  host.retainedOverviewHitBins = [];
  host.lastOverviewImmediateBlendMs = 0;
  host.renderCallCount += 1;
  host.lastOverviewAggregationCacheHit = false;
  const renderKeyParts = host.renderKeyParts(state);
  const renderKey = host.renderKeyFromParts(renderKeyParts);
  if (renderKey === host.lastRenderKey) {
    host.geometryCacheHitCount += 1;
    host.lastRenderMode = 'cache-hit';
    host.lastGeometryRebuildReasons = [];
    if (host.lastDrawAudit) {
      host.lastDrawAudit = {
        ...host.lastDrawAudit,
        frameId: ++host.drawAuditFrameId,
        renderMode: 'cache-hit',
        pixelsPerBp: path.pixelsPerBp,
        viewStartBp: path.viewStartBp,
        viewEndBp: path.viewEndBp,
        zoom: state.zoom,
        viewOffset: state.viewOffset,
      };
    }
    replayAnnotationLabelOccupancy(host, state);
    host.renderInteractionOutlines(path, state);
    return;
  }
  host.lastGeometryRebuildReasons = host.renderKeyChangeReasons(renderKeyParts);
  host.lastRenderKeyParts = renderKeyParts;
  host.geometryRebuildCount += 1;
  host.lastRenderMode = 'rebuild';
  host.lastRenderKey = renderKey;

  const g = host.graphics;
  g.clear();
  g.visible = true;
  host.clearDecorationCache();
  host.retainedTranscriptDecorationGraphics.visible = false;
  const sink: FeaturePrimitiveSink = new GraphicsPrimitiveSink(g, path);
  host.labelIndex = 0;
  host.curvedLabels.reset();
  host.hitCache.length = 0;
  host.outlineCache.clear();
  host.labelOccupancyCache = [];
  host.overviewBinDrawCount = 0;
  host.resetImmediateDrawStats();
  host.lastOverviewLodCompressionBlend = 0;
  host.lastOverviewLodFullShapeBlend = 1;

  const immediatePlan = path.isArcMode
    ? planImmediateAnnotationRender({
        style: retainedOverviewAnnotationStyle(),
        isArcMode: path.isArcMode,
        pixelsPerBp: path.pixelsPerBp,
      })
    : planLinearImmediateAnnotationRender(path.pixelsPerBp);
  const forceFullShapeOverview = immediatePlan.forceTinyFeatureShapes;
  const useOverviewAggregation = immediatePlan.kind === 'overview-aggregation';
  host.lastOverviewDensityAtlasSampleScreenPx = OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX;
  const overviewCacheStart = performance.now();
  const overviewCache = useOverviewAggregation
    ? host.overviewCache.getOverviewAggregationCache(path, host.overviewCacheContext())
    : null;
  host.lastOverviewCacheMs = performance.now() - overviewCacheStart;
  const atlasDiagnostics = host.overviewCache.mergedDensityAtlasDiagnostics();
  host.lastOverviewDensityAtlasBinBp = overviewCache?.binBp ?? 0;
  host.lastOverviewDensityAtlasLevelCount = overviewCache?.atlasLevelCount ?? 0;
  host.lastOverviewDensityAtlasEstimatedBinCount = atlasDiagnostics.estimatedBinCount;
  host.lastOverviewDensityAtlasWasCoarsened = atlasDiagnostics.wasCoarsened;
  host.lastOverviewDensityAtlasBudgetExceeded = atlasDiagnostics.budgetExceeded;
  host.lastOverviewAggregationCacheHit = host.overviewCache.lastCacheHit;
  const rawFeaturesToRender = overviewCache?.passthroughFeatures ?? host.features;
  const featuresToRender = path.isArcMode
    ? [...host.featureWindowIndex.candidatesForPath(path, rawFeaturesToRender)]
    : overviewCache
      ? rawFeaturesToRender
      : host.featuresInRange(path.viewStartBp, path.viewEndBp);
  host.lastOverviewAggregationEnabled = Boolean(overviewCache);
  host.lastOverviewPassthroughFeatureCount = featuresToRender.length;
  const drawAudit = host.beginDrawAudit(
    path,
    state,
    featuresToRender,
    useOverviewAggregation,
    overviewCache
  );
  host.lastDrawAudit = drawAudit;

  for (const feature of featuresToRender) {
    const decision = host.renderImmediateFeature(
      sink,
      feature,
      path,
      state,
      useOverviewAggregation,
      forceFullShapeOverview
    );
    host.recordDrawAuditDecision(drawAudit, feature, decision, path);
  }

  if (overviewCache && overviewCache.bins.length > 0) {
    let visibleBinCount = 0;
    let viewportCulledBinCount = 0;
    let binSourceCount = 0;
    for (const bin of overviewCache.bins) {
      binSourceCount += bin.sourceCount;
      if (
        !path.isFeatureVisible(bin.startBp, bin.endBp - bin.startBp, bin.offset, bin.halfHeight)
      ) {
        viewportCulledBinCount += 1;
        continue;
      }
      const pts = path.isArcMode
        ? path.featurePolygonAt(bin.startBp, bin.endBp, bin.offset, bin.halfHeight)
        : path.featureQuadAt(bin.startBp, bin.endBp, bin.offset, bin.halfHeight);
      sink.fillPoly(pts, webglAnnotationColorForMode(bin.color, state.themeMode), bin.alpha);
      host.overviewBinDrawCount += 1;
      visibleBinCount += 1;
    }
    drawAudit.overview.visibleBinCount = visibleBinCount;
    drawAudit.overview.viewportCulledBinCount = viewportCulledBinCount;
    drawAudit.overview.binSourceCount = binSourceCount;
  }
  renderRetainedTranscriptDecorations(host, null, path, state);
  drawAudit.drawnFeatureCount = host.lastDrawnFeatureCount;

  for (let i = host.labelIndex; i < host.labelPool.length; i++) {
    host.labelPool[i].visible = false;
  }
  host.renderInteractionOutlines(path, state);
}
