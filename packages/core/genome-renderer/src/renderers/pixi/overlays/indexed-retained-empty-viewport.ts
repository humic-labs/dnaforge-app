import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { RetainedOverlayCameraState, RetainedOverlayFallbackReason } from './overlay-track';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import type { AnnotationDrawAuditSnapshot } from './annotation-draw-audit';
import type { OverviewBin } from './annotation-overview-cache';
import { OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP } from './indexed-annotation-body-owner';

export type EmptyRetainedViewportHost = {
  renderCallCount: number;
  lastRenderMode: string;
  lastRenderKey: string;
  lastRenderKeyParts: unknown;
  lastGeometryRebuildReasons: unknown[];
  retainedDrawStateClean: boolean;
  retainedLinearFeatureLayer: { hide(): void } | null;
  retainedLinearTranscriptLayer: { hide(): void } | null;
  retainedLinearBinCount: number;
  retainedOverviewMode: string;
  retainedOverviewStyle: RetainedOverviewAnnotationStyle;
  retainedOverviewCameraUpdates: number;
  retainedOverviewFallbackReason: unknown;
  retainedOverviewInstanceCount: number;
  retainedOverviewVisibleInstanceCount: number;
  retainedOverviewHitBins: unknown[];
  retainedOverviewPassthroughDrawn: boolean;
  lastOverviewAggregationEnabled: boolean;
  lastOverviewPassthroughFeatureCount: number;
  lastOverviewDensityAtlasBinBp: number;
  lastOverviewDensityAtlasLevelCount: number;
  lastOverviewDensityAtlasEstimatedBinCount: number;
  lastOverviewDensityAtlasWasCoarsened: boolean;
  lastOverviewDensityAtlasBudgetExceeded: boolean;
  lastDrawAudit: AnnotationDrawAuditSnapshot | null;
  retainedOverviewFallback(reason: RetainedOverlayFallbackReason): false;
  clearDrawState(): void;
  resetImmediateDrawStats(): void;
  beginDrawAuditIfDiagnosticsEnabled(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: {
      binBp: number;
      bins: OverviewBin[];
      passthroughFeatures: Feature[];
      diagnostics: {
        inputFeatureCount: number;
        skippedMinVisibleFeatureCount: number;
        aggregateWideFeatureCount: number;
        aggregatedFeatureCount: number;
        binContributionCount: number;
      };
    } | null
  ): AnnotationDrawAuditSnapshot | null;
  renderRetainedTranscriptDecorations(
    decorations: null,
    path: PathMapper,
    state: RenderState
  ): void;
  renderInteractionOutlines(path: PathMapper, state: RenderState): void;
  noteAnnotationBodyFrameOwner(owner: 'none'): void;
};

export function presentEmptyRetainedLinearViewport(
  host: EmptyRetainedViewportHost,
  camera: RetainedOverlayCameraState,
  style: RetainedOverviewAnnotationStyle,
  overviewVisibleBp: number,
  prebuiltLayer: { hasPrebuilt(): boolean } | null | undefined
): boolean {
  if (prebuiltLayer?.hasPrebuilt() && overviewVisibleBp > OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP) {
    return host.retainedOverviewFallback('dirty-data');
  }
  host.renderCallCount += 1;
  host.lastRenderMode = 'retained';
  host.lastRenderKey = '';
  host.lastRenderKeyParts = null;
  host.lastGeometryRebuildReasons = [];
  if (!host.retainedDrawStateClean) {
    host.clearDrawState();
    host.retainedDrawStateClean = true;
  }
  host.retainedLinearFeatureLayer?.hide();
  host.retainedLinearTranscriptLayer?.hide();
  host.retainedLinearBinCount = 0;
  host.retainedOverviewMode = 'retained';
  host.retainedOverviewStyle = style;
  host.retainedOverviewCameraUpdates += 1;
  host.retainedOverviewFallbackReason = null;
  host.retainedOverviewInstanceCount = 0;
  host.retainedOverviewVisibleInstanceCount = 0;
  host.retainedOverviewHitBins = [];
  host.retainedOverviewPassthroughDrawn = false;
  host.lastOverviewAggregationEnabled = false;
  host.lastOverviewPassthroughFeatureCount = 0;
  host.lastOverviewDensityAtlasBinBp = 0;
  host.lastOverviewDensityAtlasLevelCount = 0;
  host.lastOverviewDensityAtlasEstimatedBinCount = 0;
  host.lastOverviewDensityAtlasWasCoarsened = false;
  host.lastOverviewDensityAtlasBudgetExceeded = false;
  host.resetImmediateDrawStats();
  host.lastDrawAudit = host.beginDrawAuditIfDiagnosticsEnabled(
    camera.path,
    camera.state,
    [],
    false,
    null
  );
  host.renderRetainedTranscriptDecorations(null, camera.path, camera.state);
  host.renderInteractionOutlines(camera.path, camera.state);
  host.noteAnnotationBodyFrameOwner('none');
  return true;
}
