import { Container } from 'pixi.js';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { RetainedOverlayFallbackReason, RetainedOverlayRenderMode } from './overlay-track';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import { retainedOverviewAnnotationStyle } from '../overview/retained-overview-style';
import { fingerprintAnnotationFeatureSet } from './annotation-feature-fingerprint';
import { RetainedOverviewAnnotationLayer } from '../overview/retained-overview-layer';
import { RetainedLinearFeatureLayer } from '../overview/retained-linear-feature-layer';
import { RetainedLinearTranscriptLayer } from '../overview/retained-linear-transcript-layer';
import type { OverviewBin } from './annotation-overview-cache';
import { OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX } from './annotation-lod-policy';
import type { AnnotationDrawAuditSnapshot } from './annotation-draw-audit';

export type SequenceRetainedLinearSourceWindow = {
  inputKey: string;
  startBp: number;
  endBp: number;
  features: Feature[];
};

export type SequenceRetainedLinearGlue = {
  container: Container;
  features: () => Feature[];
  genomeLength: () => number;
  featuresInRange: (startBp: number, endBp: number) => Feature[];
  clearDrawState: () => void;
  clearDecorationCache: () => void;
  resetDecorationBookkeeping: () => void;
  resetOverviewLodBlendStats: () => void;
};

export type SequenceEmptyRetainedLinearDraw = {
  noteEmptyFrame(): void;
  resetImmediateDrawStats(): void;
  beginDrawAudit(): void;
  renderDecorations(): void;
  renderOutlines(): void;
};

export const RETAINED_LINEAR_SOURCE_WINDOW_MIN_BP = 5_000_000;
export const RETAINED_LINEAR_SOURCE_WINDOW_VISIBLE_MULTIPLIER = 4;
export const RETAINED_LINEAR_SOURCE_WINDOW_MAX_MARGIN_BP = 50_000_000;
export const RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES = 4096;

export class SequenceRetainedLinearPresenter {
  retainedOverviewLayer: RetainedOverviewAnnotationLayer | null = null;
  retainedLinearFeatureLayer: RetainedLinearFeatureLayer | null = null;
  retainedLinearTranscriptLayer: RetainedLinearTranscriptLayer | null = null;
  retainedLinearTranscriptKey = '';
  readonly retainedLinearTranscriptFeatureKeyCache = new WeakMap<readonly Feature[], string>();
  retainedLinearTranscriptFeatureSet: Set<Feature> | null = null;
  retainedLinearTranscriptMembershipNeedsRebind = false;
  retainedLinearFullSetMeshResident = false;
  retainedLinearSourceWindow: SequenceRetainedLinearSourceWindow | null = null;
  retainedLinearDataBuilds = 0;
  retainedLinearBinCount = 0;
  retainedLinearTranscriptBuilds = 0;
  retainedLinearTranscriptBlockCount = 0;
  retainedLinearTranscriptPrevKeyParts: readonly string[] | null = null;
  retainedLinearTranscriptLastBuildCause = '';
  retainedLinearTranscriptStaleHolds = 0;
  retainedLinearTranscriptVisibleFeatureCount = 0;
  lastRetainedTranscriptDecorationsDrawn = false;
  retainedOverviewHitBins: OverviewBin[] = [];
  retainedOverviewMode: RetainedOverlayRenderMode = 'inactive';
  retainedOverviewDataBuilds = 0;
  retainedOverviewCameraUpdates = 0;
  retainedOverviewInteractionUpdates = 0;
  retainedOverviewFallbackRenders = 0;
  retainedOverviewFallbackReason: RetainedOverlayFallbackReason | null = null;
  retainedOverviewStyle: RetainedOverviewAnnotationStyle = 'retained';
  retainedOverviewInstanceCount = 0;
  retainedOverviewVisibleInstanceCount = 0;
  retainedOverviewPassthroughDrawn = false;
  immediateDrawStateClearedForRetained = false;
  retainedDrawStateClean = false;
  renderCallCount = 0;
  geometryRebuildCount = 0;
  geometryCacheHitCount = 0;
  lastRenderMode: 'none' | 'cache-hit' | 'rebuild' | 'retained' = 'none';
  lastRenderKey = '';
  lastRenderKeyParts: Record<string, string> | null = null;
  lastGeometryRebuildReasons: string[] = [];
  drawAuditFrameId = 0;
  lastDrawAudit: AnnotationDrawAuditSnapshot | null = null;
  lastFrameDoubleDraw = false;
  lastOverviewAggregationEnabled = false;
  lastOverviewAggregationCacheHit = false;
  lastOverviewPassthroughFeatureCount = 0;
  lastOverviewDensityAtlasBinBp = 0;
  lastOverviewDensityAtlasSampleScreenPx = OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX;
  lastOverviewDensityAtlasLevelCount = 0;
  lastOverviewDensityAtlasEstimatedBinCount = 0;
  lastOverviewDensityAtlasWasCoarsened = false;
  lastOverviewDensityAtlasBudgetExceeded = false;
  lastOverviewLodCompressionBlend = 0;
  lastOverviewLodFullShapeBlend = 1;
  lastOverviewCacheMs = 0;
  lastOverviewImmediateBlendMs = 0;
  overviewBinDrawCount = 0;

  constructor(private readonly glue: SequenceRetainedLinearGlue | null = null) {}

  private requiredGlue(): SequenceRetainedLinearGlue {
    if (!this.glue) {
      throw new Error('SequenceRetainedLinearPresenter requires overlay glue');
    }
    return this.glue;
  }

  ensureRetainedOverviewLayer(): RetainedOverviewAnnotationLayer {
    if (!this.retainedOverviewLayer) {
      this.retainedOverviewLayer = new RetainedOverviewAnnotationLayer();
      const { container } = this.requiredGlue();
      container.addChildAt(
        this.retainedOverviewLayer.container,
        Math.min(1, container.children.length)
      );
    }
    return this.retainedOverviewLayer;
  }

  ensureRetainedLinearFeatureLayer(): RetainedLinearFeatureLayer {
    if (!this.retainedLinearFeatureLayer) {
      this.retainedLinearFeatureLayer = new RetainedLinearFeatureLayer();
      const { container } = this.requiredGlue();
      container.addChildAt(
        this.retainedLinearFeatureLayer.container,
        Math.min(1, container.children.length)
      );
    }
    return this.retainedLinearFeatureLayer;
  }

  ensureRetainedLinearTranscriptLayer(): RetainedLinearTranscriptLayer {
    if (!this.retainedLinearTranscriptLayer) {
      this.retainedLinearTranscriptLayer = new RetainedLinearTranscriptLayer();
      const { container } = this.requiredGlue();
      container.addChildAt(
        this.retainedLinearTranscriptLayer.container,
        Math.min(2, container.children.length)
      );
    }
    return this.retainedLinearTranscriptLayer;
  }

  resetRetainedOverviewDebug(opts: { preserveTranscriptMesh?: boolean } = {}): void {
    this.retainedOverviewMode = 'inactive';
    this.retainedOverviewDataBuilds = 0;
    this.retainedLinearDataBuilds = 0;
    this.retainedLinearBinCount = 0;
    if (!opts.preserveTranscriptMesh) {
      this.retainedLinearTranscriptBuilds = 0;
      this.retainedLinearTranscriptBlockCount = 0;
      this.retainedLinearTranscriptVisibleFeatureCount = 0;
      this.retainedLinearTranscriptKey = '';
      this.retainedLinearTranscriptFeatureSet = null;
      this.retainedLinearTranscriptMembershipNeedsRebind = false;
    }
    this.retainedLinearSourceWindow = null;
    this.glue?.resetDecorationBookkeeping();
    this.retainedOverviewCameraUpdates = 0;
    this.retainedOverviewInteractionUpdates = 0;
    this.retainedOverviewFallbackRenders = 0;
    this.retainedOverviewFallbackReason = null;
    this.retainedOverviewStyle = retainedOverviewAnnotationStyle();
    this.retainedOverviewInstanceCount = 0;
    this.retainedOverviewVisibleInstanceCount = 0;
    this.immediateDrawStateClearedForRetained = false;
    this.retainedDrawStateClean = false;
  }

  retainedOverviewFallback(reason: RetainedOverlayFallbackReason): false {
    this.retainedOverviewMode = 'fallback';
    this.retainedOverviewFallbackRenders += 1;
    this.retainedOverviewFallbackReason = reason;
    this.retainedOverviewStyle = retainedOverviewAnnotationStyle();
    this.retainedOverviewVisibleInstanceCount = 0;
    this.glue?.resetOverviewLodBlendStats();
    this.retainedOverviewHitBins = [];
    this.retainedOverviewPassthroughDrawn = false;
    this.retainedDrawStateClean = false;
    this.resetAllPresentersToHidden();
    this.retainedOverviewLayer?.hide();
    this.retainedLinearFeatureLayer?.hide();
    this.retainedLinearTranscriptLayer?.hide();
    this.glue?.clearDecorationCache();
    return false;
  }

  resetAllPresentersToHidden(): void {
    this.retainedOverviewLayer?.hide();
    this.retainedLinearFeatureLayer?.hide();
    this.retainedLinearTranscriptLayer?.hide();
  }

  retainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string {
    if (featuresToRender.length === 0) return 'empty';
    const g = globalThis as { __webglFeatureKeyMs?: number; __webglFeatureKeyCalls?: number };
    const t0 = performance.now();
    const result = this.hashRetainedLinearTranscriptFeatureKey(featuresToRender);
    g.__webglFeatureKeyMs = (g.__webglFeatureKeyMs ?? 0) + (performance.now() - t0);
    g.__webglFeatureKeyCalls = (g.__webglFeatureKeyCalls ?? 0) + 1;
    return result;
  }

  hashRetainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string {
    const memoize = featuresToRender.length >= RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES;
    if (memoize) {
      const cached = this.retainedLinearTranscriptFeatureKeyCache.get(featuresToRender);
      if (cached !== undefined) {
        const gg = globalThis as { __webglFeatureKeyHit?: number };
        gg.__webglFeatureKeyHit = (gg.__webglFeatureKeyHit ?? 0) + 1;
        return cached;
      }
    }
    const gm = globalThis as { __webglFeatureKeyMiss?: number; __webglFeatureKeyMissN?: number };
    gm.__webglFeatureKeyMiss = (gm.__webglFeatureKeyMiss ?? 0) + 1;
    gm.__webglFeatureKeyMissN = (gm.__webglFeatureKeyMissN ?? 0) + featuresToRender.length;
    const key = fingerprintAnnotationFeatureSet(featuresToRender);
    if (memoize) this.retainedLinearTranscriptFeatureKeyCache.set(featuresToRender, key);
    return key;
  }

  retainedLinearSourceFeaturesForViewport(path: PathMapper): Feature[] {
    const glue = this.requiredGlue();
    const features = glue.features();
    const genomeLength = glue.genomeLength();
    const inputKey = this.retainedLinearTranscriptFeatureKey(features);
    const viewportStart = Math.max(0, Math.min(genomeLength, path.viewStartBp));
    const viewportEnd = Math.max(viewportStart, Math.min(genomeLength, path.viewEndBp));
    const visibleBp = Math.max(1, viewportEnd - viewportStart);
    const overfetchPerSideBp = Math.min(
      (visibleBp * (RETAINED_LINEAR_SOURCE_WINDOW_VISIBLE_MULTIPLIER - 1)) / 2,
      RETAINED_LINEAR_SOURCE_WINDOW_MAX_MARGIN_BP
    );
    const targetSpanBp = Math.min(
      genomeLength,
      Math.max(RETAINED_LINEAR_SOURCE_WINDOW_MIN_BP, visibleBp + 2 * overfetchPerSideBp)
    );
    const current = this.retainedLinearSourceWindow;
    const currentSpanBp = current ? current.endBp - current.startBp : 0;
    const currentCoversViewport =
      current !== null && current.startBp <= viewportStart && current.endBp >= viewportEnd;
    const currentIsWholeGenome = current !== null && currentSpanBp >= Math.max(1, genomeLength - 1);
    const currentIsNotOversized =
      current !== null && (!currentIsWholeGenome || currentSpanBp <= targetSpanBp * 4);
    if (current?.inputKey === inputKey && currentCoversViewport && currentIsNotOversized) {
      return current.features;
    }

    if (currentCoversViewport && currentIsNotOversized && current) {
      const windowFeatures = glue.featuresInRange(current.startBp, current.endBp);
      this.retainedLinearSourceWindow = {
        inputKey,
        startBp: current.startBp,
        endBp: current.endBp,
        features: windowFeatures,
      };
      return windowFeatures;
    }

    const centerBp = (viewportStart + viewportEnd) / 2;
    let startBp = Math.max(0, centerBp - targetSpanBp / 2);
    const endBp = Math.min(genomeLength, startBp + targetSpanBp);
    startBp = Math.max(0, endBp - targetSpanBp);
    const windowFeatures = glue.featuresInRange(startBp, endBp);
    this.retainedLinearSourceWindow = {
      inputKey,
      startBp,
      endBp,
      features: windowFeatures,
    };
    return windowFeatures;
  }

  presentEmptyRetainedLinearViewport(
    style: RetainedOverviewAnnotationStyle,
    draw: SequenceEmptyRetainedLinearDraw
  ): boolean {
    draw.noteEmptyFrame();
    if (!this.retainedDrawStateClean) {
      this.requiredGlue().clearDrawState();
      this.retainedDrawStateClean = true;
    }
    this.retainedLinearFeatureLayer?.hide();
    this.retainedLinearTranscriptLayer?.hide();
    this.retainedLinearBinCount = 0;
    this.retainedOverviewMode = 'retained';
    this.retainedOverviewStyle = style;
    this.retainedOverviewCameraUpdates += 1;
    this.retainedOverviewFallbackReason = null;
    this.retainedOverviewInstanceCount = 0;
    this.retainedOverviewVisibleInstanceCount = 0;
    this.retainedOverviewHitBins = [];
    this.retainedOverviewPassthroughDrawn = false;
    draw.resetImmediateDrawStats();
    draw.beginDrawAudit();
    draw.renderDecorations();
    draw.renderOutlines();
    return true;
  }

  finalizeRetainedImmediateLinearFrame(
    style: RetainedOverviewAnnotationStyle,
    lastDrawnFeatureCount: number,
    renderOutlines: () => void
  ): boolean {
    this.retainedOverviewMode = 'retained';
    this.retainedOverviewStyle = style;
    this.retainedOverviewCameraUpdates += 1;
    this.retainedOverviewFallbackReason = null;
    this.retainedOverviewInstanceCount = this.retainedLinearTranscriptBlockCount;
    this.retainedOverviewVisibleInstanceCount =
      this.retainedLinearTranscriptBlockCount + lastDrawnFeatureCount;
    this.retainedOverviewHitBins = [];
    this.retainedOverviewPassthroughDrawn =
      this.retainedLinearTranscriptBlockCount > 0 || lastDrawnFeatureCount > 0;
    renderOutlines();
    return true;
  }
}
