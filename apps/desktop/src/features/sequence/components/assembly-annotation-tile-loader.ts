import type { Feature } from '@waypoint/genome-renderer';
import type {
  GenomeTileFidelity,
  GenomeTileRequest,
  GenomeTrackTile,
} from '../../../shared/indexed-genome';
import {
  applyDensityControls,
  type RendererAnnotationFeatureStats,
  resolveAnnotationFeaturesForViewer,
  type AnnotationLaneStackingOptions,
  type LaneLimit,
  type TranscriptCarrierFeature,
} from './indexed-genome-legacy-adapter';
import { collapseToCanonicalIsoforms, type TranscriptDisplayMode } from './isoform-collapse';
import { offsetFeaturesToGlobal } from './assembly-feature-offset';
import { buildAnnotationTileRequest } from './indexed-annotation-tile-request';

export const ASSEMBLY_ANNOTATION_PENDING_TILE_STATES: ReadonlySet<string> = new Set([
  'missing',
  'queued',
  'loading',
  'building_summary',
  'stale',
]);

export interface AssemblyAnnotationTileFeatureLoadResult {
  tile: GenomeTrackTile;
  resolvedExpandedFeatures: ReadonlyArray<TranscriptCarrierFeature>;
  features: Feature[];
  rawFeatureCount: number;
  resolvedFeatureCount: number;
  collapsedFeatureCount: number;
  localFeatureCount: number;
  typeFilteredCount: number;
  droppedCount: number;
  featureStats: RendererAnnotationFeatureStats;
}

export interface AssemblyAnnotationTileFeatureLoadInput {
  sessionId: string;
  requestId: string;
  chrom: string;
  start: number;
  end: number;
  lod: number;
  generation: number;
  fidelity: GenomeTileFidelity;
  byteBudget: number;
  annotationOwner?: {
    start: number;
    end: number;
  };
  sourceFingerprint: string;
  visibleTypes: ReadonlySet<string>;
  laneLimit: LaneLimit;
  length: number;
  globalStart: number;
  glyphV2Enabled: boolean;
  transcriptDisplayMode: TranscriptDisplayMode;
  expandedGeneIds: ReadonlySet<string>;
  laneStacking: AnnotationLaneStackingOptions;
  maxAttempts: number;
  pollMs: number;
  requireCompleteSource?: boolean;
  isCurrent: () => boolean;
  getAnnotationTile: (
    sessionId: string,
    request: GenomeTileRequest,
    requestId: string
  ) => Promise<GenomeTrackTile>;
  onTile?: (tile: GenomeTrackTile, attempt: number) => void;
}

export async function loadAssemblyAnnotationTileFeatures(
  input: AssemblyAnnotationTileFeatureLoadInput
): Promise<AssemblyAnnotationTileFeatureLoadResult | null> {
  let tile: GenomeTrackTile | null = null;
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    if (!input.isCurrent()) return null;
    tile = await input.getAnnotationTile(
      input.sessionId,
      buildAnnotationTileRequest({
        chrom: input.chrom,
        start: input.start,
        end: input.end,
        lod: input.lod,
        generation: input.generation,
        fidelity: input.fidelity,
        byteBudget: input.byteBudget,
        annotationOwner: input.annotationOwner,
        sourceFingerprint: input.sourceFingerprint,
        visibleTypes: input.visibleTypes,
        laneLimit: input.laneLimit,
      }),
      input.requestId
    );
    input.onTile?.(tile, attempt + 1);
    if (!ASSEMBLY_ANNOTATION_PENDING_TILE_STATES.has(tile.state)) break;
    await delay(input.pollMs);
  }

  if (!tile || !input.isCurrent()) return null;
  if (tile.state !== 'ready' && tile.state !== 'empty') return null;
  if (
    input.requireCompleteSource &&
    tile.sourceRepresentationComplete !== true &&
    (tile.degradedReason !== undefined ||
      (tile.sourceRecordCount !== undefined && tile.sourceRecordCount > tile.recordCount))
  ) {
    return null;
  }
  const rawFeatures = Array.isArray(tile.features) ? tile.features : [];
  const resolved = resolveAnnotationFeaturesForViewer(
    rawFeatures,
    tile.featureModel ?? 'raw-gff3',
    input.glyphV2Enabled
  );
  const collapsed = collapseToCanonicalIsoforms(resolved as TranscriptCarrierFeature[], {
    mode: input.transcriptDisplayMode,
    expandedGeneIds: input.expandedGeneIds,
  });
  const density = applyDensityControls(
    collapsed,
    input.chrom,
    input.length,
    input.visibleTypes,
    input.laneLimit,
    input.laneStacking
  );
  return {
    tile,
    resolvedExpandedFeatures: resolved,
    features: offsetFeaturesToGlobal(density.features, input.globalStart),
    rawFeatureCount: rawFeatures.length,
    resolvedFeatureCount: resolved.length,
    collapsedFeatureCount: collapsed.length,
    localFeatureCount: density.features.length,
    typeFilteredCount: density.typeFilteredCount,
    droppedCount: density.droppedCount,
    featureStats: density.featureStats ?? {
      featureCount: density.features.length,
      transcriptCount: 0,
      codingTranscriptCount: 0,
      multiExonTranscriptCount: 0,
      exonCount: 0,
      cdsCount: 0,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
