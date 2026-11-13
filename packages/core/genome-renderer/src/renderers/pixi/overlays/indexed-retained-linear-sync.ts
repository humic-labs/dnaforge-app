import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { linearViewerRenderContract } from '../overview/viewer-render-contract';
import { buildTranscriptGlyphBlocks } from '../overview/retained-linear-transcript-layer';
import { isOutlineOnlyFeature, isTranscript } from './annotation-feature-semantics';
import type { OverviewAggregationCache } from './annotation-overview-cache';
import { annotationMutationBodyColors } from './annotation-mutation-paint';

type SyncableFeatureLayer = {
  syncData(key: string, bins: OverviewAggregationCache['bins'], themeMode: unknown): boolean;
  updateCamera(contract: unknown, width: number, height: number): void;
  setAlpha(alpha: number): void;
  hide(): void;
};

type SyncableTranscriptLayer = {
  setFeatureColors?(colors: ReadonlyMap<number, number> | undefined): void;
  syncData(key: string, blocks: unknown): boolean;
  updateCamera(contract: unknown, width: number, height: number, cdsDetail: number): void;
  hide(): void;
};

export type RetainedLinearSyncHost = {
  features: Feature[];
  genomeLength: number;
  maxAnnotationLane: number;
  maxCdsLane: number;
  retainedLinearTranscriptKey: string;
  retainedLinearTranscriptFeatureSet: Set<Feature> | null;
  retainedLinearTranscriptMembershipNeedsRebind: boolean;
  retainedLinearTranscriptVisibleFeatureCount: number;
  retainedLinearTranscriptBlockCount: number;
  retainedLinearTranscriptStaleHolds: number;
  retainedLinearTranscriptBuilds: number;
  retainedLinearTranscriptLastBuildCause: string;
  retainedLinearTranscriptPrevKeyParts: string[] | null;
  retainedLinearFullSetMeshResident: boolean;
  retainedLinearDataBuilds: number;
  retainedOverviewDataBuilds: number;
  retainedLinearBinCount: number;
  retainedLinearFeatureLayer: SyncableFeatureLayer | null;
  retainedLinearTranscriptLayer: SyncableTranscriptLayer | null;
  ensureRetainedLinearFeatureLayer(): SyncableFeatureLayer;
  ensureRetainedLinearTranscriptLayer(): SyncableTranscriptLayer;
  retainedLinearTranscriptFeatureKey(features: readonly Feature[]): string;
  retainedLinearTranscriptLayoutKey(state: RenderState): string;
  cdsDetailProgress(): number;
  featureEnvelope(feature: Feature): { centerOffset: number } | null;
  scaledBarHeight(): number;
  runInvariantGuardAfterRetainedSync(
    transcripts: Feature[],
    blockCount: number,
    transcriptKey: string,
    path: PathMapper
  ): void;
};

export function syncRetainedLinearOverviewLayers(
  host: RetainedLinearSyncHost,
  path: PathMapper,
  state: RenderState,
  overviewCache: OverviewAggregationCache,
  featuresToRender: readonly Feature[]
): Set<Feature> | null {
  host.retainedLinearTranscriptLayer?.setFeatureColors?.(
    annotationMutationBodyColors(host.features, state.sequencePresentation)
  );
  if (overviewCache.bins.length > 0) {
    const layer = host.ensureRetainedLinearFeatureLayer();
    const key = `linear-feat|${overviewCache.key}|theme:${state.themeMode ?? 'light'}`;
    if (layer.syncData(key, overviewCache.bins, state.themeMode)) {
      host.retainedLinearDataBuilds += 1;
      host.retainedOverviewDataBuilds += 1;
    }
    layer.updateCamera(linearViewerRenderContract(path), state.width, state.height);
    layer.setAlpha(1);
    host.retainedLinearBinCount = overviewCache.bins.length;
  } else {
    host.retainedLinearFeatureLayer?.hide();
    host.retainedLinearBinCount = 0;
  }

  const cdsDetail = host.cdsDetailProgress();
  const codingMorph = Boolean(path.cdsZoomPresentation?.bandProgress);
  const canBatch = (feature: Feature) =>
    isTranscript(feature) &&
    !isOutlineOnlyFeature(feature) &&
    !(codingMorph && feature.cds?.length);
  const tKeyParts = [
    'linear-tx',
    `g:${host.genomeLength}`,
    `n:${host.features.length}`,
    `fs:${host.retainedLinearTranscriptFeatureKey(featuresToRender)}`,
    `al:${host.maxAnnotationLane}`,
    `cl:${host.maxCdsLane}`,
    `th:${state.themeMode ?? 'light'}`,
    `layout:${host.retainedLinearTranscriptLayoutKey(state)}`,
    `coding-morph:${codingMorph}`,
  ];
  const tKey = tKeyParts.join('|');
  if (tKey === host.retainedLinearTranscriptKey && host.retainedLinearTranscriptFeatureSet) {
    if (host.retainedLinearTranscriptMembershipNeedsRebind) {
      const reboundFeatureSet = new Set<Feature>();
      for (const feature of featuresToRender) {
        if (canBatch(feature)) {
          reboundFeatureSet.add(feature);
        }
      }
      host.retainedLinearTranscriptFeatureSet = reboundFeatureSet;
      host.retainedLinearTranscriptVisibleFeatureCount = reboundFeatureSet.size;
      host.retainedLinearTranscriptMembershipNeedsRebind = false;
    }
    host.retainedLinearTranscriptLayer?.updateCamera(
      linearViewerRenderContract(path),
      state.width,
      state.height,
      cdsDetail
    );
    return host.retainedLinearTranscriptFeatureSet.size > 0
      ? host.retainedLinearTranscriptFeatureSet
      : null;
  }

  const transcripts: Feature[] = [];
  const batchedTranscriptSet = new Set<Feature>();
  for (const f of featuresToRender) {
    if (canBatch(f)) {
      batchedTranscriptSet.add(f);
      transcripts.push(f);
    }
  }

  if (!codingMorph && transcripts.length === 0 && host.retainedLinearTranscriptBlockCount > 0) {
    host.retainedLinearTranscriptStaleHolds += 1;
    host.retainedLinearTranscriptLayer?.updateCamera(
      linearViewerRenderContract(path),
      state.width,
      state.height,
      cdsDetail
    );
    return host.retainedLinearTranscriptFeatureSet;
  }

  host.retainedLinearTranscriptKey = tKey;
  host.retainedLinearTranscriptFeatureSet = batchedTranscriptSet;
  host.retainedLinearTranscriptMembershipNeedsRebind = false;
  host.retainedLinearTranscriptVisibleFeatureCount = transcripts.length;

  if (transcripts.length === 0) {
    host.retainedLinearTranscriptLayer?.hide();
    host.retainedLinearTranscriptBlockCount = 0;
    return null;
  }

  const tLayer = host.ensureRetainedLinearTranscriptLayer();
  const blocks = buildTranscriptGlyphBlocks(transcripts, {
    getFeatureId: (feature) => (feature as Feature).id,
    getOffset: (f) => {
      const env = host.featureEnvelope(f as Feature);
      return env ? env.centerOffset : null;
    },
    halfHeight: host.scaledBarHeight() / 2,
    themeMode: state.themeMode,
    cdsDetail,
  });
  if (tLayer.syncData(tKey, blocks)) {
    host.retainedLinearTranscriptBuilds += 1;
    host.retainedOverviewDataBuilds += 1;

    const prev = host.retainedLinearTranscriptPrevKeyParts;
    if (prev) {
      const changed: string[] = [];
      for (let i = 0; i < tKeyParts.length; i += 1) {
        if (tKeyParts[i] !== prev[i]) changed.push(tKeyParts[i].split(':')[0] || `#${i}`);
      }
      host.retainedLinearTranscriptLastBuildCause = changed.join(',') || 'first';
    } else {
      host.retainedLinearTranscriptLastBuildCause = 'first';
    }
    host.retainedLinearTranscriptPrevKeyParts = tKeyParts;
  }
  tLayer.setFeatureColors?.(
    annotationMutationBodyColors(host.features, state.sequencePresentation)
  );

  if (featuresToRender === host.features) host.retainedLinearFullSetMeshResident = true;
  host.retainedLinearTranscriptBlockCount = blocks.length;
  tLayer.updateCamera(linearViewerRenderContract(path), state.width, state.height, cdsDetail);

  host.runInvariantGuardAfterRetainedSync(transcripts, blocks.length, tKey, path);

  return batchedTranscriptSet;
}
