import type { Feature, Genome } from '@waypoint/genome-renderer';
import type { GenomeAssembly } from '@waypoint/genome-data';
import { platform } from '../../../platform';
import type {
  AssemblyOverviewChromInput,
  GenomeOpenSource,
  GenomeTrackTile,
} from '../../../shared/indexed-genome';
import { completeManifestFromIndexedGff3Source } from '../assembly-indexed-manifest';
import { extensionForPath } from '../indexed-genome-paths';
import {
  buildGenomeAssembly,
  joinProjectPath,
  referenceAssemblyById,
  referenceAssemblyCacheRoot,
} from '../reference-catalog';
import { resolveCurrentReferenceAssetPublicationV1 } from '../reference-asset-publication';
import { waitForCoordinateReadyGenomeSession } from './assembly-session-ready';
import { loadAssemblyAnnotationTileFeatures } from './assembly-annotation-tile-loader';
import {
  applyDensityControls,
  type AnnotationLaneStackingOptions,
} from './indexed-genome-legacy-adapter';
import { annotationLayerType } from '../annotation-layer-identity';
import { offsetFeaturesToGlobal } from './assembly-feature-offset';

const PRECOMPUTE_VISIBLE_TYPES: ReadonlySet<string> = new Set(['mRNA']);
const PRECOMPUTE_LANE_STACKING: AnnotationLaneStackingOptions = {
  groupByType: true,
  typeOrder: ['mRNA', 'lncRNA', 'ncRNA', 'miRNA', 'snoRNA', 'tRNA'],
};
const PRECOMPUTE_TILE_BYTE_BUDGET = 4_000_000;
const PRECOMPUTE_TILE_MAX_ATTEMPTS = 60;
const PRECOMPUTE_TILE_POLL_MS = 200;

export interface AssemblyOverviewTexturePrecomputeGenome {
  genome: Genome;
  byChrom: Record<string, Feature[]>;
  availableTypes: readonly string[];
  chromosomes: AssemblyOverviewChromInput[];
  layout: {
    maxAnnotationLane: number;
    maxCdsLane: number;
    layerTypes: string[];
  };
  featureCount: number;
  rawFeatureCount: number;
}

export async function buildAssemblyOverviewTexturePrecomputeGenome(input: {
  assemblyId: string;
  referenceAssetCacheRoot?: string | null;
  referenceAssetPublicationRoot?: string | null;
  workspaceRoot: string;
}): Promise<AssemblyOverviewTexturePrecomputeGenome | null> {
  const entry = referenceAssemblyById(input.assemblyId);
  if (!entry) return null;
  const sharedCacheRoot =
    input.referenceAssetCacheRoot ??
    (await platform()
      .path.referenceAssetCacheRoot()
      .catch(() => null));
  if (!sharedCacheRoot) return null;
  const publicationRoot =
    input.referenceAssetPublicationRoot ??
    (await (
      platform().path.referenceAssetPublicationRoot?.() ?? Promise.resolve(sharedCacheRoot)
    ).catch(() => sharedCacheRoot));
  if (!publicationRoot) return null;
  const assemblyCacheRoot = referenceAssemblyCacheRoot(sharedCacheRoot, entry);
  const publicationAssemblyRoot = referenceAssemblyCacheRoot(publicationRoot, entry);
  const currentPublication = await resolveCurrentReferenceAssetPublicationV1({
    assemblyCacheRoot,
    publicationAssemblyRoot,
    fallbackPublicationAssemblyRoot:
      publicationAssemblyRoot === assemblyCacheRoot ? null : assemblyCacheRoot,
    assetCacheKey: entry.assetCacheKey,
    readTextFile: (path) => platform().fs.readTextFile(path),
  });
  if (!currentPublication) return null;
  const assembly = buildGenomeAssembly(entry, (rel) =>
    joinProjectPath(currentPublication.sourceGenerationRoot, rel)
  );
  const chromosomes = assembly.chromosomes
    .filter((chrom) => Boolean(chrom.manifest.gffPath))
    .map((chrom) => ({
      chrom: chrom.chrom,
      sourcePath: chrom.manifest.gffPath ?? null,
      length: chrom.length,
    }));
  if (chromosomes.length === 0) return null;

  const features: Feature[] = [];
  const byChrom: Record<string, Feature[]> = {};
  let rawFeatureCount = 0;
  let globalStart = 0;
  for (const chrom of assembly.chromosomes) {
    if (!chrom.manifest.gffPath) {
      globalStart += chrom.length;
      continue;
    }
    const loaded = await loadChromosomeSummaryFeatures({
      assembly,
      chrom,
      globalStart,
      workspaceRoot: input.workspaceRoot,
    });
    if (!loaded || loaded.features.length === 0) {
      console.error(
        '[assembly-annotation-source-index] chromosome unavailable',
        JSON.stringify({
          assemblyId: assembly.assemblyId,
          chrom: chrom.chrom,
          sourcePath: chrom.manifest.gffPath,
          reason: loaded ? 'empty-expanded-feature-graph' : 'tile-unavailable',
        })
      );
      return null;
    }
    features.push(...loaded.features);
    byChrom[chrom.chrom] = loaded.features;
    rawFeatureCount += loaded.rawFeatureCount;
    globalStart += chrom.length;
  }

  const layout = annotationLayoutForFeatures(features);
  const availableTypes = [
    ...new Set(features.map((feature) => feature.annotationTrackId ?? feature.type)),
  ].sort((left, right) => left.localeCompare(right));
  return {
    genome: {
      name: assembly.displayName,
      length: Math.max(
        1,
        assembly.chromosomes.reduce((sum, chrom) => sum + chrom.length, 0)
      ),
      circular: false,
      annotationLayout: {
        maxAnnotationLane: layout.maxAnnotationLane,
        maxCdsLane: layout.maxCdsLane,
      },
      annotationLayerTypes: layout.layerTypes,
      features,
    },
    byChrom,
    availableTypes,
    chromosomes,
    layout,
    featureCount: features.length,
    rawFeatureCount,
  };
}

async function loadChromosomeSummaryFeatures(input: {
  assembly: GenomeAssembly;
  chrom: GenomeAssembly['chromosomes'][number];
  globalStart: number;
  workspaceRoot: string;
}): Promise<{ features: Feature[]; rawFeatureCount: number } | null> {
  const manifest = completeManifestFromIndexedGff3Source(input.chrom.manifest);
  if (!manifest.gffPath) return null;
  const source: GenomeOpenSource = {
    sourcePath: manifest.gffPath,
    workspaceRoot: input.workspaceRoot,
    chrom: input.chrom.chrom,
    sourceExt: extensionForPath(manifest.gffPath),
    manifest,
    intent: { kind: 'internal-assembly-segment' },
  };
  const opened = await platform().genome.open(source);
  const shell = await waitForCoordinateReadyGenomeSession({
    initialShell: opened,
    getSession: (sessionId) => platform().genome.getSession(sessionId),
  });
  let lastTile: GenomeTrackTile | null = null;
  try {
    const loaded = await loadAssemblyAnnotationTileFeatures({
      sessionId: shell.sessionId,
      requestId: `assembly-overview-texture-precompute:${input.assembly.assemblyId}:${input.chrom.chrom}`,
      chrom: input.chrom.chrom,
      start: 0,
      end: input.chrom.length,
      lod: 0,
      generation: 0,
      fidelity: 'summary',
      byteBudget: PRECOMPUTE_TILE_BYTE_BUDGET,
      sourceFingerprint: shell.sourceFingerprint,
      visibleTypes: PRECOMPUTE_VISIBLE_TYPES,
      laneLimit: null,
      length: manifest.length ?? input.chrom.length,
      globalStart: input.globalStart,
      glyphV2Enabled: true,
      transcriptDisplayMode: 'canonical',
      expandedGeneIds: new Set<string>(),
      laneStacking: PRECOMPUTE_LANE_STACKING,
      requireCompleteSource: true,
      maxAttempts: PRECOMPUTE_TILE_MAX_ATTEMPTS,
      pollMs: PRECOMPUTE_TILE_POLL_MS,
      isCurrent: () => true,
      onTile: (tile) => {
        lastTile = tile;
      },
      getAnnotationTile: (sessionId, request, requestId) =>
        platform().genome.getAnnotationTile(sessionId, request, requestId),
    });
    if (!loaded) {
      const rejectedTile = lastTile as GenomeTrackTile | null;
      console.error(
        '[assembly-annotation-source-index] complete tile rejected',
        JSON.stringify({
          assemblyId: input.assembly.assemblyId,
          chrom: input.chrom.chrom,
          state: rejectedTile?.state ?? null,
          message: rejectedTile?.message ?? null,
          recordCount: rejectedTile?.recordCount ?? null,
          sourceRecordCount: rejectedTile?.sourceRecordCount ?? null,
          sourceRepresentationComplete: rejectedTile?.sourceRepresentationComplete ?? null,
          degradedReason: rejectedTile?.degradedReason ?? null,
        })
      );
      return null;
    }
    const presentTypes = new Set(
      loaded.resolvedExpandedFeatures.map((feature) => annotationLayerType(feature))
    );
    const expanded = applyDensityControls(
      [...loaded.resolvedExpandedFeatures],
      input.chrom.chrom,
      input.chrom.length,
      presentTypes,
      null,
      PRECOMPUTE_LANE_STACKING
    );
    return {
      features: offsetFeaturesToGlobal(expanded.features, input.globalStart),
      rawFeatureCount: loaded.rawFeatureCount,
    };
  } finally {
    await platform()
      .genome.closeSession(shell.sessionId)
      .catch(() => undefined);
  }
}

function annotationLayoutForFeatures(features: readonly Feature[]): {
  maxAnnotationLane: number;
  maxCdsLane: number;
  layerTypes: string[];
} {
  let maxAnnotationLane = -1;
  let maxCdsLane = -1;
  const layerTypes = new Set<string>();
  for (const feature of features) {
    if (feature.type === 'CDS') maxCdsLane = Math.max(maxCdsLane, feature.lane);
    else maxAnnotationLane = Math.max(maxAnnotationLane, feature.lane);
    if (PRECOMPUTE_VISIBLE_TYPES.has(feature.type)) layerTypes.add(feature.type);
  }
  return {
    maxAnnotationLane,
    maxCdsLane,
    layerTypes: [...layerTypes].sort((a, b) => a.localeCompare(b)),
  };
}
