import type { RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import type { AnnotationFrameRenderMode } from './annotation-render-mode';

export type AnnotationDrawAuditDecision =
  | 'drawn'
  | 'skipped-subpixel'
  | 'skipped-viewport'
  | 'skipped-overview-aggregated-tiny'
  | 'skipped-batched-transcript'
  | 'skipped-empty-visual-range';

export type AnnotationDrawAuditSnapshot = {
  frameId: number;
  renderMode: AnnotationFrameRenderMode;
  pathMode: 'linear' | 'arc';
  pixelsPerBp: number;
  viewStartBp: number;
  viewEndBp: number;
  zoom: number;
  viewOffset: number;
  featureCount: number;
  renderSetFeatureCount: number;
  renderSetLayerTypes: string[];
  drawnFeatureCount: number;
  decisions: Record<AnnotationDrawAuditDecision, number>;
  samples: Array<{
    id: number;
    type: string;
    start: number;
    end: number;
    lane: number;
    cdsLane: number | null;
    pixelWidth: number;
    decision: AnnotationDrawAuditDecision;
  }>;
  overview: {
    aggregationEnabled: boolean;
    cacheHit: boolean;
    budgetExceeded: boolean;
    binBp: number;
    binCount: number;
    visibleBinCount: number;
    viewportCulledBinCount: number;
    binSourceCount: number;
    passthroughFeatureCount: number;
    atlasInputFeatureCount: number;
    atlasSkippedMinVisibleFeatureCount: number;
    atlasAggregatedFeatureCount: number;
    atlasAggregateWideFeatureCount: number;
    atlasBinContributionCount: number;
  };
  layout: {
    viewportHeight: number;
    totalHeight: number | null;
    offset: number | null;
    annotationTop: number | null;
    annotationHeight: number | null;
    annotationLanes: number;
    cdsLanes: number;
    fwdStrandTop: number | null;
    revStrandBottom: number | null;
    rulerY: number | null;
    sequenceBottom: number | null;
    sequenceOutOfViewport: boolean;
    annotationOffset: number | null;
    annotationStep: number | null;
    cdsBarOffset: number | null;
    cdsLaneStep: number | null;
  };
};

const DRAW_AUDIT_SAMPLE_LIMIT = 80;
const DRAW_AUDIT_DECISIONS: AnnotationDrawAuditDecision[] = [
  'drawn',
  'skipped-subpixel',
  'skipped-viewport',
  'skipped-overview-aggregated-tiny',
  'skipped-batched-transcript',
  'skipped-empty-visual-range',
];

export function emptyDrawAuditDecisions(): Record<AnnotationDrawAuditDecision, number> {
  return Object.fromEntries(DRAW_AUDIT_DECISIONS.map((decision) => [decision, 0])) as Record<
    AnnotationDrawAuditDecision,
    number
  >;
}

export type AnnotationDrawAuditInput = {
  frameId: number;
  renderMode: AnnotationFrameRenderMode;
  path: PathMapper;
  state: RenderState;
  featureCount: number;
  renderSetFeatureCount: number;
  renderSetLayerTypes?: readonly string[];
  maxAnnotationLane: number;
  maxCdsLane: number;
  layout: UnifiedLayout | null;
  overviewAggregationEnabled: boolean;
  overviewCache: {
    binBp: number;
    binCount: number;
    passthroughFeatureCount: number;
    diagnostics: {
      inputFeatureCount: number;
      skippedMinVisibleFeatureCount: number;
      aggregateWideFeatureCount: number;
      aggregatedFeatureCount: number;
      binContributionCount: number;
    };
  } | null;
  overviewCacheHit: boolean;
  overviewBudgetExceeded: boolean;
};

function emptyAnnotationDrawAudit(): AnnotationDrawAuditSnapshot {
  return {
    frameId: 0,
    renderMode: 'none',
    pathMode: 'linear',
    pixelsPerBp: 0,
    viewStartBp: 0,
    viewEndBp: 0,
    zoom: 0,
    viewOffset: 0,
    featureCount: 0,
    renderSetFeatureCount: 0,
    renderSetLayerTypes: [],
    drawnFeatureCount: 0,
    decisions: emptyDrawAuditDecisions(),
    samples: [],
    overview: {
      aggregationEnabled: false,
      cacheHit: false,
      budgetExceeded: false,
      binBp: 0,
      binCount: 0,
      visibleBinCount: 0,
      viewportCulledBinCount: 0,
      binSourceCount: 0,
      passthroughFeatureCount: 0,
      atlasInputFeatureCount: 0,
      atlasSkippedMinVisibleFeatureCount: 0,
      atlasAggregatedFeatureCount: 0,
      atlasAggregateWideFeatureCount: 0,
      atlasBinContributionCount: 0,
    },
    layout: {
      viewportHeight: 0,
      totalHeight: null,
      offset: null,
      annotationTop: null,
      annotationHeight: null,
      annotationLanes: 0,
      cdsLanes: 0,
      fwdStrandTop: null,
      revStrandBottom: null,
      rulerY: null,
      sequenceBottom: null,
      sequenceOutOfViewport: false,
      annotationOffset: null,
      annotationStep: null,
      cdsBarOffset: null,
      cdsLaneStep: null,
    },
  };
}

export function buildAnnotationDrawAudit(
  input: AnnotationDrawAuditInput,
  reuse?: AnnotationDrawAuditSnapshot
): AnnotationDrawAuditSnapshot {
  const layout = input.layout;
  const sequenceBottom = layout ? Math.max(layout.revStrandBottom, layout.rulerY) : null;
  const audit = reuse ?? emptyAnnotationDrawAudit();

  audit.frameId = input.frameId;
  audit.renderMode = input.renderMode;
  audit.pathMode = input.path.isArcMode ? 'arc' : 'linear';
  audit.pixelsPerBp = input.path.pixelsPerBp;
  audit.viewStartBp = input.path.viewStartBp;
  audit.viewEndBp = input.path.viewEndBp;
  audit.zoom = input.state.zoom;
  audit.viewOffset = input.state.viewOffset;
  audit.featureCount = input.featureCount;
  audit.renderSetFeatureCount = input.renderSetFeatureCount;
  audit.renderSetLayerTypes.length = 0;
  audit.renderSetLayerTypes.push(...(input.renderSetLayerTypes ?? []));
  audit.renderSetLayerTypes.sort((a, b) => a.localeCompare(b));
  audit.drawnFeatureCount = 0;
  for (const decision of DRAW_AUDIT_DECISIONS) audit.decisions[decision] = 0;
  audit.samples.length = 0;

  audit.overview.aggregationEnabled = input.overviewAggregationEnabled;
  audit.overview.cacheHit = input.overviewCacheHit;
  audit.overview.budgetExceeded = input.overviewBudgetExceeded;
  audit.overview.binBp = input.overviewCache?.binBp ?? 0;
  audit.overview.binCount = input.overviewCache?.binCount ?? 0;
  audit.overview.visibleBinCount = 0;
  audit.overview.viewportCulledBinCount = 0;
  audit.overview.binSourceCount = 0;
  audit.overview.passthroughFeatureCount = input.overviewCache?.passthroughFeatureCount ?? 0;
  audit.overview.atlasInputFeatureCount = input.overviewCache?.diagnostics.inputFeatureCount ?? 0;
  audit.overview.atlasSkippedMinVisibleFeatureCount =
    input.overviewCache?.diagnostics.skippedMinVisibleFeatureCount ?? 0;
  audit.overview.atlasAggregatedFeatureCount =
    input.overviewCache?.diagnostics.aggregatedFeatureCount ?? 0;
  audit.overview.atlasAggregateWideFeatureCount =
    input.overviewCache?.diagnostics.aggregateWideFeatureCount ?? 0;
  audit.overview.atlasBinContributionCount =
    input.overviewCache?.diagnostics.binContributionCount ?? 0;

  audit.layout.viewportHeight = input.state.height;
  audit.layout.totalHeight = layout?.totalHeight ?? null;
  audit.layout.offset = layout?.offset ?? null;
  audit.layout.annotationTop = layout?.annotationTop ?? null;
  audit.layout.annotationHeight = layout?.annotationHeight ?? null;
  audit.layout.annotationLanes = Math.max(0, input.maxAnnotationLane + 1);
  audit.layout.cdsLanes = Math.max(0, input.maxCdsLane + 1);
  audit.layout.fwdStrandTop = layout?.fwdStrandTop ?? null;
  audit.layout.revStrandBottom = layout?.revStrandBottom ?? null;
  audit.layout.rulerY = layout?.rulerY ?? null;
  audit.layout.sequenceBottom = sequenceBottom;
  audit.layout.sequenceOutOfViewport =
    layout !== null &&
    (layout.fwdStrandTop < 0 ||
      layout.revStrandBottom > input.state.height ||
      layout.rulerY > input.state.height);
  audit.layout.annotationOffset = layout?.annotationOffset ?? null;
  audit.layout.annotationStep = layout?.annotationStep ?? null;
  audit.layout.cdsBarOffset = layout?.cdsBarOffset ?? null;
  audit.layout.cdsLaneStep = layout?.cdsLaneStep ?? null;

  return audit;
}

export function snapshotAnnotationDrawAudit(
  audit: AnnotationDrawAuditSnapshot
): AnnotationDrawAuditSnapshot {
  return {
    ...audit,
    renderSetLayerTypes: [...audit.renderSetLayerTypes],
    decisions: { ...audit.decisions },
    samples: audit.samples.map((sample) => ({ ...sample })),
    overview: { ...audit.overview },
    layout: { ...audit.layout },
  };
}

export function recordAnnotationDrawAuditDecision(
  audit: AnnotationDrawAuditSnapshot,
  sample: {
    id: number;
    type: string;
    start: number;
    end: number;
    lane: number;
    cdsLane: number | null;
    pixelWidth: number;
    decision: AnnotationDrawAuditDecision;
  }
): void {
  audit.decisions[sample.decision] += 1;
  if (audit.samples.length >= DRAW_AUDIT_SAMPLE_LIMIT) return;
  audit.samples.push(sample);
}
