import {
  assignFeatureLanesByType,
  buildAnnotationPolicyProjectionTableV1,
  compilePackedTranscriptBroadSurfaceRgba8V1,
  COMPILED_BROAD_SURFACE_MAX_WEIGHTED_ROLES_V1,
  type BroadSurfaceIsoformModeV2,
  compilePrepackedAnnotationScene,
  packCompiledBroadAnnotationInteractionBinaryV1,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  projectPrepackedAnnotationFeatureLookupIndexV2,
  type BuildAnnotationPolicyProjectionTableV1Input,
  type CompiledBroadSurfaceManifestV2,
  type CompiledBroadSurfaceRgba8CellV1,
  type Feature,
  type PackedCompiledBroadAnnotationInteractionBinaryV1,
  type PackedPartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/pure';

import type {
  AssemblyAnnotationSceneMissResult,
  AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import {
  assemblyAnnotationSceneScopeMatchesChromosomes,
  buildAssemblyCompiledBroadRasterSurfaceManifestV1,
} from '../../shared/indexed-genome';
import { processAssemblyOverviewChromosomeFeatures } from '../../features/sequence/assembly-annotation-feature-pipeline';
import { collapseToCanonicalIsoforms } from '../../features/sequence/components/isoform-collapse';
import type { TranscriptCarrierFeature } from '../../features/sequence/components/indexed-genome-legacy-adapter';
import { rendererFeatureCandidateFromAnnotationGlyph } from '../../shared/indexed-genome-annotation-feature-mapper';
import { readAssemblyOverviewCaches } from './assembly-overview-cache';
import {
  ASSEMBLY_FEATURES_CACHE_VERSION,
  readAssemblyOverviewFeaturesCache,
  writeAssemblyOverviewFeaturesCache,
  writeAssemblyOverviewFeaturesCacheFromFragmentsV1,
  type AssemblyFeaturesCacheDeps,
  type AssemblyFeaturesManifest,
  type CachedOverviewFeaturesByChrom,
} from './assembly-overview-features-cache';
import {
  assemblyCompiledBroadRasterArtifactDirectory,
  writeAssemblyAnnotationSceneCache,
  type AssemblyTextureCacheDeps,
} from './assembly-overview-texture-cache';
import { sha256BoundedNodeV1 } from './bounded-binary-sha256';
import { referencePreparationTiming } from '../reference-assets/reference-prep-timing';
import { isUserAnnotationLayer } from '../../features/sequence/annotation-layer-identity';
import {
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
  publishCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterArtifactManifestV1,
  type CompiledBroadRasterSourceCellV1,
} from './compiled-broad-raster-artifact';

const RENDERER_TYPE_ORDER = ['gene', 'mRNA', 'lncRNA', 'ncRNA', 'miRNA', 'snoRNA', 'tRNA'];

export interface ExpandedAnnotationSceneWorkerJob {
  request: AssemblyAnnotationSceneReadRequest;
  authorizedMiss: AssemblyAnnotationSceneMissResult;
  runtimeSourceBuildFingerprint: string;
  authorizedSourceRealPaths: ReadonlyArray<{ inputPath: string; realPath: string }>;
}

export interface ExpandedAnnotationSceneWorkerSetJob {
  readonly jobs: readonly ExpandedAnnotationSceneWorkerJob[];
  readonly parseTrackTypes?: readonly string[];
}

export interface ExpandedAnnotationSceneWorkerSetResult {
  readonly results: readonly ExpandedAnnotationSceneWorkerResult[];
}

export interface ExpandedAnnotationSceneBroadCompanionReceiptV1 {
  readonly status: 'published';
  readonly sourceFingerprint: string;
  readonly surfaceManifestFingerprint: string;
  readonly catalogFingerprint: string;
  readonly quarantinedCorruptArtifact: false;
}

export type ExpandedAnnotationSceneInventoryWorkerResult =
  | Readonly<{ status: 'ready'; trackTypes: readonly string[] }>
  | Readonly<{ status: 'features-cache-miss'; trackTypes: readonly [] }>;

export type ExpandedAnnotationSceneWorkerResult =
  | {
      status: 'committed' | 'stale';
      featureCount: number;
      droppedCount: number;
      primitiveCount: number;
      byteCount: number;
      broadCompanion?: ExpandedAnnotationSceneBroadCompanionReceiptV1;
    }
  | {
      status: 'features-cache-miss';
      featureCount: 0;
      droppedCount: 0;
      primitiveCount: 0;
      byteCount: 0;
    };

export interface ValidatedExpandedFeaturesCacheRead {
  rawFileJson: string;
  manifest: AssemblyFeaturesManifest;
}

export interface CompiledExpandedAnnotationScene {
  packed: PackedPartitionedTranscriptSceneBinaryV4;
  compiledBroadInteraction: PackedCompiledBroadAnnotationInteractionBinaryV1;
  featureCount: number;
  droppedCount: number;
  primitiveCount: number;
}

interface ValidatedSourceFeature {
  feature: Feature;
  chrom: string;
}

export function createAuthorizedExpandedAnnotationSourcePathGuard(
  authorized: ExpandedAnnotationSceneWorkerJob['authorizedSourceRealPaths'],
  realpathImpl: (path: string) => Promise<string>
): (path: string) => Promise<void> {
  const authorizedPaths = new Map(
    authorized.map(({ inputPath, realPath: authorizedRealPath }) => [inputPath, authorizedRealPath])
  );
  return async (path: string): Promise<void> => {
    const authorizedRealPath = authorizedPaths.get(path);
    if (!authorizedRealPath) {
      throw new Error('Expanded annotation scene worker rejected an unauthorized source path.');
    }
    const currentRealPath = await realpathImpl(path);
    if (currentRealPath !== authorizedRealPath) {
      throw new Error('Expanded annotation scene worker rejected a changed source path.');
    }
  };
}

export function expandedAnnotationSceneAuthorizedInputPaths(
  request: AssemblyAnnotationSceneReadRequest
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const append = (path: string | null | undefined) => {
    const normalized = path?.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  };
  for (let index = 0; index < request.chromosomes.length; index += 1) {
    if (request.scope.placements[index]?.annotationCoverage === 'unsourced') continue;
    const chromosome = request.chromosomes[index];
    append(chromosome.sourcePath);
    if (chromosome.manifest) {
      append(chromosome.manifest.fastaPath);
      append(chromosome.manifest.faiPath);
      append(chromosome.manifest.gffPath);
      append(chromosome.manifest.tbiPath);
    }
  }
  return paths;
}

interface ExpandedCompilerDeps {
  assertSafePath: (path: string) => Promise<void>;
  readFeaturesCache?: (
    input: {
      assemblyId: string;
      chromosomes: AssemblyAnnotationSceneReadRequest['chromosomes'];
      workspaceRoot: string;
      mode: string;
      overviewExtentsOnly?: boolean;
    },
    deps: AssemblyFeaturesCacheDeps
  ) => Promise<ValidatedExpandedFeaturesCacheRead | null>;
  readOverviewCaches?: typeof readAssemblyOverviewCaches;
  writeSceneCache?: typeof writeAssemblyAnnotationSceneCache;
  writeFeaturesCache?: typeof writeAssemblyOverviewFeaturesCache;
  compileBroadCompanion?: typeof compileAndPublishBroadRasterArtifactForPackedScene;
  buildFeatureCacheFragments?: (
    job: ExpandedAnnotationSceneWorkerJob
  ) => Promise<FeatureCacheFragmentsV1>;
  writeFeaturesCacheFragments?: typeof writeAssemblyOverviewFeaturesCacheFromFragmentsV1;
  parsedFeatures?: Map<string, readonly ValidatedSourceFeature[]>;
}

export interface BroadRasterCompilerDeps {
  buildBroadRasterSurfaceManifest?: typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1;
  resolveBroadRasterArtifactDirectory?: typeof assemblyCompiledBroadRasterArtifactDirectory;
  compileBroadRaster?: typeof compilePackedTranscriptBroadSurfaceRgba8V1;
  publishBroadRaster?: (
    input: Parameters<typeof publishCompiledBroadRasterArtifactV1>[0]
  ) => Promise<Pick<CompiledBroadRasterArtifactManifestV1, 'catalogFingerprint'>>;
  encodeBroadRasterCells?: (input: {
    readonly packed: PackedPartitionedTranscriptSceneBinaryV4;
    readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
    readonly roleWeights?: Readonly<Record<BroadSurfaceIsoformModeV2, Uint8Array>>;
  }) => Promise<readonly CompiledBroadRasterSourceCellV1[]>;
}

function fail(reason: string): never {
  throw new Error(`Expanded annotation scene worker rejected ${reason}`);
}

function sceneSourceIdentity(request: AssemblyAnnotationSceneReadRequest): string {
  return `assembly-annotation-source-sha256.v1:${request.datasetContract.sourceSha256}`;
}

function totalAssemblyLength(request: AssemblyAnnotationSceneReadRequest): number {
  let total = 0;
  for (const chromosome of request.chromosomes) {
    if (!chromosome?.chrom || !Number.isSafeInteger(chromosome.length) || chromosome.length <= 0) {
      fail('invalid chromosome placement');
    }
    total += chromosome.length;
    if (!Number.isSafeInteger(total)) fail('unsafe assembly length');
  }
  return total;
}

function manifestsEqual(left: AssemblyFeaturesManifest, right: AssemblyFeaturesManifest): boolean {
  return (
    left.version === right.version &&
    left.assemblyId === right.assemblyId &&
    left.fingerprint === right.fingerprint &&
    left.cacheContractToken === right.cacheContractToken &&
    left.mode === right.mode &&
    left.featureCount === right.featureCount
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAssemblyFeaturesManifest(value: unknown): value is AssemblyFeaturesManifest {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.version === 'number' &&
    typeof value.assemblyId === 'string' &&
    typeof value.fingerprint === 'string' &&
    typeof value.cacheContractToken === 'string' &&
    typeof value.mode === 'string' &&
    typeof value.featureCount === 'number'
  );
}

function isRendererFeature(value: unknown): value is Feature {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === 'number' &&
    typeof value.type === 'string' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    (value.direction === 'forward' ||
      value.direction === 'reverse' ||
      value.direction === 'none') &&
    typeof value.displayName === 'string' &&
    typeof value.color === 'number' &&
    typeof value.lane === 'number'
  );
}

function validateFeatureRange(
  feature: Feature,
  chrom: string,
  globalStartBp: number,
  globalEndBp: number,
  targetTrackTypes: ReadonlySet<string>
): void {
  if (
    !Number.isSafeInteger(feature.id) ||
    !Number.isSafeInteger(feature.start) ||
    !Number.isSafeInteger(feature.end) ||
    feature.start < globalStartBp ||
    feature.end <= feature.start ||
    feature.end > globalEndBp ||
    typeof feature.type !== 'string' ||
    typeof feature.displayName !== 'string' ||
    !Number.isFinite(feature.color) ||
    !['forward', 'reverse', 'none'].includes(feature.direction)
  ) {
    fail(`invalid global feature coordinates for ${chrom}`);
  }
  const trackType = feature.annotationTrackId ?? feature.type;
  if (!targetTrackTypes.has(trackType) || !isTranscriptLikeTrackType(trackType)) return;
  const ranges = [...(feature.exons ?? []), ...(feature.cds ?? []), ...(feature.segments ?? [])];
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < feature.start + 1 ||
      range.end > feature.end ||
      range.end < range.start
    ) {
      fail(
        `invalid global transcript range for ${chrom} ` +
          `${trackType} feature=${feature.id} parent=${feature.start + 1}-${feature.end} ` +
          `child=${range.start}-${range.end}`
      );
    }
  }
}

function isTranscriptLikeTrackType(trackType: string): boolean {
  if (trackType === 'transcript') return true;
  if (/^genomic /i.test(trackType)) return false;
  return /rna/i.test(trackType);
}

function normalizeTargetTranscriptEnvelope(
  feature: Feature,
  targetTrackTypes: ReadonlySet<string>
): Feature {
  const trackType = feature.annotationTrackId ?? feature.type;
  if (!targetTrackTypes.has(trackType) || !isTranscriptLikeTrackType(trackType)) return feature;
  const ranges = [...(feature.exons ?? []), ...(feature.cds ?? []), ...(feature.segments ?? [])];
  let start = feature.start;
  let end = feature.end;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) continue;
    start = Math.min(start, range.start - 1);
    end = Math.max(end, range.end);
  }
  return start === feature.start && end === feature.end ? feature : { ...feature, start, end };
}

function parseValidatedFeatureEnvelope(
  job: ExpandedAnnotationSceneWorkerJob,
  cache: ValidatedExpandedFeaturesCacheRead,
  targetTrackTypes: ReadonlySet<string> = new Set([job.request.artifact.trackType])
): ValidatedSourceFeature[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(cache.rawFileJson);
  } catch {
    fail('malformed feature-cache JSON');
  }
  if (
    !isPlainRecord(envelope) ||
    !isPlainRecord(envelope.manifest) ||
    !isPlainRecord(envelope.byChrom)
  ) {
    fail('malformed feature-cache envelope');
  }
  if (!isAssemblyFeaturesManifest(envelope.manifest)) {
    fail('malformed feature-cache envelope');
  }
  const diskManifest = envelope.manifest;
  if (
    !manifestsEqual(diskManifest, cache.manifest) ||
    diskManifest.version !== ASSEMBLY_FEATURES_CACHE_VERSION ||
    diskManifest.assemblyId !== job.request.assemblyId ||
    diskManifest.mode !== 'expanded' ||
    !/^[0-9a-f]{24}$/.test(diskManifest.fingerprint) ||
    !Number.isSafeInteger(diskManifest.featureCount) ||
    diskManifest.featureCount < 0
  ) {
    fail('feature-cache manifest mismatch');
  }
  const flattened = flattenValidatedFeatureGraph(job, envelope.byChrom, targetTrackTypes);
  if (flattened.length !== diskManifest.featureCount) {
    fail('feature-cache manifest count mismatch');
  }
  return flattened;
}

function flattenValidatedFeatureGraph(
  job: ExpandedAnnotationSceneWorkerJob,
  byChrom: Record<string, unknown>,
  targetTrackTypes: ReadonlySet<string> = new Set([job.request.artifact.trackType])
): ValidatedSourceFeature[] {
  const expectedChroms = new Set(job.request.chromosomes.map((chromosome) => chromosome.chrom));
  if (Object.keys(byChrom).some((chrom) => !expectedChroms.has(chrom))) {
    fail('feature-cache chromosome set mismatch');
  }

  const flattened: ValidatedSourceFeature[] = [];
  let globalStartBp = 0;
  for (let index = 0; index < job.request.chromosomes.length; index += 1) {
    const chromosome = job.request.chromosomes[index];
    const features = byChrom[chromosome.chrom];
    const globalEndBp = globalStartBp + chromosome.length;
    const coverage = job.request.scope.placements[index]?.annotationCoverage;
    if (coverage === 'unsourced') {
      if (features !== undefined && (!Array.isArray(features) || features.length !== 0)) {
        fail(`nonempty unsourced chromosome ${chromosome.chrom}`);
      }
      globalStartBp = globalEndBp;
      continue;
    }
    validateChromosomeFeatures(chromosome, features, globalStartBp, targetTrackTypes, flattened);
    globalStartBp = globalEndBp;
  }
  return flattened;
}

function validateChromosomeFeatures(
  chromosome: AssemblyAnnotationSceneReadRequest['chromosomes'][number],
  features: unknown,
  globalStartBp: number,
  targetTrackTypes: ReadonlySet<string>,
  out: ValidatedSourceFeature[]
): void {
  if (!Array.isArray(features)) fail(`missing chromosome ${chromosome.chrom}`);
  const globalEndBp = globalStartBp + chromosome.length;
  for (const value of features) {
    if (!isPlainRecord(value) || !isRendererFeature(value)) {
      fail(`invalid feature for chromosome ${chromosome.chrom}`);
    }
    const feature = normalizeTargetTranscriptEnvelope(value, targetTrackTypes);
    validateFeatureRange(feature, chromosome.chrom, globalStartBp, globalEndBp, targetTrackTypes);
    out.push({ feature, chrom: chromosome.chrom });
  }
}

export type FeatureCacheFragmentsV1 =
  | Readonly<{
      status: 'ready';
      fragments: ReadonlyArray<readonly [string, string]>;
      trackTypes: readonly string[];
      featureCount: number;
    }>
  | Readonly<{ status: 'miss' }>;

export async function buildFeatureCacheFragmentsV1(
  job: ExpandedAnnotationSceneWorkerJob,
  indexes: readonly number[],
  deps: Pick<ExpandedCompilerDeps, 'assertSafePath' | 'readOverviewCaches'>
): Promise<FeatureCacheFragmentsV1> {
  const chromosomes = job.request.chromosomes;
  const globalStartBp: number[] = [];
  let startBp = 0;
  for (const chromosome of chromosomes) {
    globalStartBp.push(startBp);
    startBp += chromosome.length;
  }
  const sourced = indexes.flatMap((index) => {
    if (job.request.scope.placements[index]?.annotationCoverage !== 'sourced') return [];
    const sourcePath = chromosomes[index].sourcePath?.trim();
    return sourcePath ? [{ ...chromosomes[index], sourcePath }] : [];
  });
  const overview = await (deps.readOverviewCaches ?? readAssemblyOverviewCaches)(
    { chromosomes: sourced, workspaceRoot: job.request.workspaceRoot },
    { assertSafePath: deps.assertSafePath }
  );
  if (overview.hits !== sourced.length || overview.misses !== 0) return { status: 'miss' };
  const fragments: (readonly [string, string])[] = [];
  const trackTypes = new Set<string>();
  const validated: ValidatedSourceFeature[] = [];
  let featureCount = 0;
  for (const index of indexes) {
    const chromosome = chromosomes[index];
    if (job.request.scope.placements[index]?.annotationCoverage === 'unsourced') {
      fragments.push([chromosome.chrom, '[]']);
      continue;
    }
    const source = overview.byChrom[chromosome.chrom];
    if (!source || source.cacheState !== 'hit' || !Array.isArray(source.features)) {
      return { status: 'miss' };
    }
    const features = processAssemblyOverviewChromosomeFeatures({
      chrom: chromosome.chrom,
      chromosomeLengthBp: chromosome.length,
      globalStartBp: globalStartBp[index],
      rawOrResolvedFeatures: source.features,
      featureModel: 'resolved-transcript-v2',
      isoformMode: 'expanded',
      glyphV2Enabled: true,
    });
    validated.length = 0;
    validateChromosomeFeatures(chromosome, features, globalStartBp[index], new Set(), validated);
    for (const { feature } of validated) {
      const trackType = feature.annotationTrackId ?? feature.type;
      if (trackType && isUserAnnotationLayer(trackType)) trackTypes.add(trackType);
    }
    featureCount += features.length;
    fragments.push([chromosome.chrom, JSON.stringify(features)]);
  }
  return { status: 'ready', fragments, trackTypes: [...trackTypes], featureCount };
}

async function buildFeatureGraphFromPerChromCaches(
  job: ExpandedAnnotationSceneWorkerJob,
  deps: ExpandedCompilerDeps
): Promise<CachedOverviewFeaturesByChrom | null> {
  const readOverviewCaches = deps.readOverviewCaches ?? readAssemblyOverviewCaches;
  const sourcedChromosomes = job.request.chromosomes.flatMap((chromosome, index) => {
    if (job.request.scope.placements[index]?.annotationCoverage !== 'sourced') return [];
    const sourcePath = chromosome.sourcePath?.trim();
    return sourcePath ? [{ ...chromosome, sourcePath }] : [];
  });
  const overview = await readOverviewCaches(
    {
      chromosomes: sourcedChromosomes,
      workspaceRoot: job.request.workspaceRoot,
    },
    { assertSafePath: deps.assertSafePath }
  );
  const expectedChroms = new Set(sourcedChromosomes.map((chromosome) => chromosome.chrom));
  if (
    overview.hits !== sourcedChromosomes.length ||
    overview.misses !== 0 ||
    Object.keys(overview.byChrom).length !== expectedChroms.size ||
    Object.keys(overview.byChrom).some((chrom) => !expectedChroms.has(chrom))
  ) {
    return null;
  }

  const byChrom: Record<string, Feature[]> = {};
  let globalStartBp = 0;
  for (let index = 0; index < job.request.chromosomes.length; index += 1) {
    const chromosome = job.request.chromosomes[index];
    if (job.request.scope.placements[index]?.annotationCoverage === 'unsourced') {
      byChrom[chromosome.chrom] = [];
      globalStartBp += chromosome.length;
      continue;
    }
    const source = overview.byChrom[chromosome.chrom];
    if (!source || source.cacheState !== 'hit' || !Array.isArray(source.features)) return null;
    byChrom[chromosome.chrom] = processAssemblyOverviewChromosomeFeatures({
      chrom: chromosome.chrom,
      chromosomeLengthBp: chromosome.length,
      globalStartBp,
      rawOrResolvedFeatures: source.features,
      featureModel: 'resolved-transcript-v2',
      isoformMode: 'expanded',
      glyphV2Enabled: true,
    });
    globalStartBp += chromosome.length;
  }
  return byChrom;
}

function strandForDirection(direction: Feature['direction']): '+' | '-' | '.' {
  if (direction === 'forward') return '+';
  if (direction === 'reverse') return '-';
  return '.';
}

function mapExpandedFeaturesForRenderer(
  job: ExpandedAnnotationSceneWorkerJob,
  sourceFeatures: readonly ValidatedSourceFeature[],
  genomeLengthBp: number
): {
  features: Feature[];
  droppedCount: 0;
  policyProjection: BuildAnnotationPolicyProjectionTableV1Input;
} {
  const trackType = job.request.artifact.trackType;
  const filtered: ValidatedSourceFeature[] = [];
  const exactSourceIdentities = new Set<string>();
  for (const source of sourceFeatures) {
    const feature = source.feature;
    if ((feature.annotationTrackId ?? feature.type) !== trackType) continue;
    const identity = JSON.stringify([
      source.chrom,
      feature.id,
      feature.sourceId ?? feature.qualifiers?.ID ?? feature.transcriptId ?? null,
      feature.annotationTrackId ?? feature.type,
      feature.type,
      feature.start,
      feature.end,
      feature.direction,
      feature.displayName,
      feature.exons ?? null,
      feature.cds ?? null,
      feature.segments ?? null,
    ]);
    if (exactSourceIdentities.has(identity)) continue;
    exactSourceIdentities.add(identity);
    filtered.push(source);
  }
  const expanded = assignFeatureLanesByType(
    filtered.map(({ feature }) => ({
      start: feature.start,
      end: feature.end,
      type: feature.annotationTrackId ?? feature.type,
    })),
    genomeLengthBp,
    { typeOrder: RENDERER_TYPE_ORDER }
  );
  const canonicalMemberIndices = canonicalFeatureMemberIndices(filtered);
  const canonicalSourceIndices = [...canonicalMemberIndices].sort((left, right) => left - right);
  const canonical = assignFeatureLanesByType(
    canonicalSourceIndices.map((index) => {
      const feature = filtered[index].feature;
      return {
        start: feature.start,
        end: feature.end,
        type: feature.annotationTrackId ?? feature.type,
      };
    }),
    genomeLengthBp,
    { typeOrder: RENDERER_TYPE_ORDER }
  );
  const canonicalLaneBySourceIndex = new Map<number, number>();
  const canonicalTrackLaneBySourceIndex = new Map<number, number>();
  for (
    let canonicalIndex = 0;
    canonicalIndex < canonicalSourceIndices.length;
    canonicalIndex += 1
  ) {
    const sourceIndex = canonicalSourceIndices[canonicalIndex];
    const lane = canonical.laneAssignments.get(canonicalIndex);
    const trackLane = canonical.localLaneAssignments.get(canonicalIndex);
    if (lane === undefined || trackLane === undefined) {
      fail('canonical lane projection dropped a source feature');
    }
    canonicalLaneBySourceIndex.set(sourceIndex, lane);
    canonicalTrackLaneBySourceIndex.set(sourceIndex, trackLane);
  }
  const sourceIdentity = sceneSourceIdentity(job.request);
  const mapped: Array<{
    feature: Feature;
    sourceIndex: number;
    annotationType: string;
    expandedLane: number;
    expandedTrackLane: number;
  }> = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const lane = expanded.laneAssignments.get(index);
    const localLane = expanded.localLaneAssignments.get(index);
    if (lane === undefined || localLane === undefined) {
      fail('expanded lane projection dropped a source feature');
    }
    const source = filtered[index].feature;
    const glyphId = source.id.toString(36);
    const trackId = source.annotationTrackId ?? source.type;
    const strand = strandForDirection(source.direction);
    mapped.push({
      sourceIndex: index,
      annotationType: trackId,
      expandedLane: lane,
      expandedTrackLane: localLane,
      feature: rendererFeatureCandidateFromAnnotationGlyph({
        genomeIdentity: sourceIdentity,
        genomeName: job.request.assemblyId,
        glyph: {
          id: glyphId,
          type: source.type,
          trackId,
          trackLane: localLane,
          label: source.displayName,
          startBp: source.start,
          endBp: source.end,
          strand,
          lane,
          color: source.color,
          ...(source.exons ? { exons: source.exons } : {}),
          ...(source.cds ? { cds: source.cds } : {}),
          ...(source.transcriptId ? { transcriptId: source.transcriptId } : {}),
          ...(source.qualifiers ? { qualifiers: source.qualifiers } : {}),
        },
      }),
    });
  }
  mapped.sort(
    (left, right) =>
      left.feature.start - right.feature.start ||
      left.feature.end - right.feature.end ||
      left.feature.id - right.feature.id ||
      left.sourceIndex - right.sourceIndex
  );
  for (let featureIndex = 0; featureIndex < mapped.length; featureIndex += 1) {
    mapped[featureIndex].feature.id = featureIndex;
  }
  return {
    features: mapped.map(({ feature }) => feature),
    droppedCount: 0,
    policyProjection: {
      features: mapped.map((record) => ({
        annotationType: record.annotationType,
        expandedLane: record.expandedLane,
        expandedTrackLane: record.expandedTrackLane,
        canonicalLane: canonicalLaneBySourceIndex.get(record.sourceIndex) ?? null,
        canonicalTrackLane: canonicalTrackLaneBySourceIndex.get(record.sourceIndex) ?? null,
      })),
      expandedBandOrder: expanded.byType.map(({ type }) => type),
      canonicalBandOrder: canonical.byType.map(({ type }) => type),
    },
  };
}

function canonicalFeatureMemberIndices(
  features: readonly ValidatedSourceFeature[]
): ReadonlySet<number> {
  const sourceByChrom = new Map<
    string,
    Array<{ sourceIndex: number; carrier: TranscriptCarrierFeature }>
  >();
  for (let index = 0; index < features.length; index += 1) {
    const { feature, chrom } = features[index];
    const entries = sourceByChrom.get(chrom) ?? [];
    const attributes: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(feature.qualifiers ?? {})) {
      if (value !== undefined) attributes[key] = [value];
    }
    const carrier: TranscriptCarrierFeature = {
      chrom,
      source: 'assembly-annotation-policy-v4',
      type: feature.type,
      start: feature.start,
      end: feature.end,
      score: null,
      strand: feature.direction === 'forward' ? '+' : feature.direction === 'reverse' ? '-' : '.',
      phase: null,
      attributes,
      raw: '',
      ...(feature.segments ? { segments: feature.segments } : {}),
      ...(feature.exons ? { exons: feature.exons, _resolvedExons: feature.exons } : {}),
      ...(feature.cds ? { cds: feature.cds, _resolvedCds: feature.cds } : {}),
      ...(feature.transcriptId
        ? {
            transcriptId: feature.transcriptId,
            _resolvedTranscriptId: feature.transcriptId,
          }
        : {}),
      ...(feature.qualifiers?.gene ? { geneId: feature.qualifiers.gene } : {}),
    };
    entries.push({ sourceIndex: index, carrier });
    sourceByChrom.set(chrom, entries);
  }
  const result = new Set<number>();
  for (const entries of sourceByChrom.values()) {
    const sourceIndexByCarrier = new Map(
      entries.map(({ sourceIndex, carrier }) => [carrier, sourceIndex])
    );
    const canonical = collapseToCanonicalIsoforms(
      entries.map(({ carrier }) => carrier),
      { mode: 'canonical' }
    );
    for (const carrier of canonical) {
      const sourceIndex = sourceIndexByCarrier.get(carrier);
      if (sourceIndex === undefined) fail('canonical policy returned a feature outside its source');
      result.add(sourceIndex);
    }
  }
  return result;
}

function validateExpandedJob(job: ExpandedAnnotationSceneWorkerJob): void {
  if (
    !assemblyAnnotationSceneScopeMatchesChromosomes(job.request.scope, job.request.chromosomes) ||
    job.request.scope.kind !== 'complete-assembly'
  ) {
    fail('invalid complete-assembly scope');
  }
  const chromosomeNames = new Set<string>();
  for (let index = 0; index < job.request.chromosomes.length; index += 1) {
    const chromosome = job.request.chromosomes[index];
    if (
      !chromosome.chrom ||
      chromosomeNames.has(chromosome.chrom) ||
      !Number.isSafeInteger(chromosome.length) ||
      chromosome.length <= 0
    ) {
      fail('invalid chromosome placement');
    }
    chromosomeNames.add(chromosome.chrom);
    if (job.request.scope.placements[index]?.annotationCoverage === 'unsourced') continue;
    const sourcePath = chromosome.sourcePath?.trim();
    if (!sourcePath) fail('invalid annotation source path');
  }
  const sourcedPaths = expandedAnnotationSceneAuthorizedInputPaths(job.request);
  const authorizedInputPaths = job.authorizedSourceRealPaths.map(({ inputPath, realPath }) => {
    if (!inputPath || !realPath) fail('invalid authorized annotation source path');
    return inputPath;
  });
  if (
    job.authorizedMiss.status !== 'miss' ||
    job.authorizedMiss.ipcContractVersion !== job.request.ipcContractVersion ||
    !/^[0-9a-f]{24}$/.test(job.authorizedMiss.fingerprint) ||
    !/^[0-9a-f]{64}$/.test(job.authorizedMiss.sourceBuildFingerprint) ||
    !job.request.artifact.trackType.trim() ||
    sourcedPaths.length === 0 ||
    authorizedInputPaths.length !== sourcedPaths.length ||
    sourcedPaths.some((sourcePath, index) => authorizedInputPaths[index] !== sourcePath)
  ) {
    fail('unsupported or unauthorized job');
  }
}

export async function compileExpandedAnnotationSceneEnvelope(
  job: ExpandedAnnotationSceneWorkerJob,
  cache: ValidatedExpandedFeaturesCacheRead
): Promise<CompiledExpandedAnnotationScene> {
  validateExpandedJob(job);
  const parsed = parseValidatedFeatureEnvelope(job, cache);
  return compileAnnotationSceneFeatures(job, parsed);
}

async function compileAnnotationSceneFeatureGraph(
  job: ExpandedAnnotationSceneWorkerJob,
  byChrom: CachedOverviewFeaturesByChrom,
  targetTrackTypes?: ReadonlySet<string>
): Promise<CompiledExpandedAnnotationScene> {
  validateExpandedJob(job);
  const parsed = flattenValidatedFeatureGraph(
    job,
    byChrom as Record<string, unknown>,
    targetTrackTypes
  );
  return compileAnnotationSceneFeatures(job, parsed);
}

async function compileAnnotationSceneFeatures(
  job: ExpandedAnnotationSceneWorkerJob,
  parsed: readonly ValidatedSourceFeature[]
): Promise<CompiledExpandedAnnotationScene> {
  const genomeLengthBp = totalAssemblyLength(job.request);
  const mapped = mapExpandedFeaturesForRenderer(job, parsed, genomeLengthBp);
  const metadata: Parameters<typeof compilePrepackedAnnotationScene>[0]['metadata'] = {
    genomeIdentity: sceneSourceIdentity(job.request),
    genomeLengthBp,
    partitionSpanBp: job.request.artifact.partitionSpanBp,
    artifactKey: job.request.artifact.artifactKey,
    themeMode: job.request.artifact.themeMode,
    trackType: job.request.artifact.trackType,
    annotationBarHeightPx: job.request.artifact.annotationBarHeightPx,
    laneAlgorithmToken: job.request.artifact.laneAlgorithmToken,
    mapperContractToken: job.request.artifact.mapperContractToken,
    geometryContractToken: job.request.artifact.geometryContractToken,
    interactionContractToken: job.request.artifact.interactionContractToken,
  };
  const compiled = compilePrepackedAnnotationScene({
    ownerKey: `worker-annotation-scene:${job.authorizedMiss.fingerprint}:${job.request.artifact.artifactKey}`,
    features: mapped.features,
    metadata,
  });
  if (!compiled.gpuReadyScene || !compiled.interactionIndex) {
    fail('compiler omitted GPU or interaction authority');
  }
  const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
    datasetContract: job.request.datasetContract,
    assemblyContract: {
      assemblyId: job.request.assemblyId,
      assemblyLengthBp: genomeLengthBp,
    },
    families: compiled.scene.families,
    featureFamilyIndices: compiled.scene.featureFamilyIndices,
    scene: compiled.gpuReadyScene,
    interactionIndex: compiled.interactionIndex,
    policyProjection: mapped.policyProjection,
    payloadSha256: sha256BoundedNodeV1,
  });
  const compiledBroadInteraction = await packCompiledBroadAnnotationInteractionBinaryV1({
    sourceScene: {
      schema: packed.manifest.schema,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      contractSha256: packed.manifest.integrity.contractSha256,
      byteLength: packed.manifest.byteLength,
    },
    datasetContract: packed.manifest.datasetContract,
    assemblyContract: packed.manifest.assemblyContract,
    policyProjection: buildAnnotationPolicyProjectionTableV1(mapped.policyProjection),
    featureLookup: projectPrepackedAnnotationFeatureLookupIndexV2(compiled.interactionIndex),
    payloadSha256: sha256BoundedNodeV1,
  });
  return {
    packed,
    compiledBroadInteraction,
    featureCount: mapped.features.length,
    droppedCount: mapped.droppedCount,
    primitiveCount: compiled.gpuReadyScene.featureIndices.length,
  };
}

interface AwaitedOneCellHandoff<T> {
  readonly cells: AsyncIterable<T>;
  publish(value: T): Promise<void>;
  close(): void;
  fail(error: unknown): void;
}

interface PendingCellOffer<T> {
  readonly value: T;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingCellRead<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

function createAwaitedOneCellHandoff<T>(): AwaitedOneCellHandoff<T> {
  let offered: PendingCellOffer<T> | null = null;
  let borrowed: PendingCellOffer<T> | null = null;
  let waitingReader: PendingCellRead<T> | null = null;
  let terminal: { readonly kind: 'closed' } | { readonly kind: 'failed'; error: unknown } | null =
    null;

  const deliver = (offer: PendingCellOffer<T>, reader: PendingCellRead<T>): void => {
    borrowed = offer;
    reader.resolve({ done: false, value: offer.value });
  };

  const acknowledgeBorrowed = (): void => {
    const previous = borrowed;
    borrowed = null;
    previous?.resolve();
  };

  const fail = (error: unknown): void => {
    if (terminal) return;
    terminal = { kind: 'failed', error };
    const pendingOffer = offered;
    const inFlightOffer = borrowed;
    const reader = waitingReader;
    offered = null;
    borrowed = null;
    waitingReader = null;
    pendingOffer?.reject(error);
    inFlightOffer?.reject(error);
    reader?.reject(error);
  };

  const close = (): void => {
    if (terminal) return;
    terminal = { kind: 'closed' };
    const reader = waitingReader;
    waitingReader = null;
    reader?.resolve({ done: true, value: undefined });
  };

  const iterator: AsyncIterator<T> = {
    next: async (): Promise<IteratorResult<T>> => {
      acknowledgeBorrowed();
      const pendingOffer = offered;
      if (pendingOffer) {
        offered = null;
        return await new Promise<IteratorResult<T>>((resolve) => {
          deliver(pendingOffer, { resolve, reject: () => undefined });
        });
      }
      if (terminal?.kind === 'closed') return { done: true, value: undefined };
      if (terminal?.kind === 'failed') throw terminal.error;
      if (waitingReader) throw new Error('Broad raster handoff has concurrent consumers.');
      return await new Promise<IteratorResult<T>>((resolve, reject) => {
        waitingReader = { resolve, reject };
      });
    },
    return: async (): Promise<IteratorResult<T>> => {
      fail(new Error('Broad raster publication stopped before consuming the complete bank.'));
      return { done: true, value: undefined };
    },
  };

  return {
    cells: Object.freeze({
      [Symbol.asyncIterator]: () => iterator,
    }),
    publish: async (value: T): Promise<void> => {
      if (terminal?.kind === 'failed') throw terminal.error;
      if (terminal?.kind === 'closed') {
        throw new Error('Broad raster handoff is already closed.');
      }
      if (offered || borrowed) {
        throw new Error('Broad raster compiler offered more than one live cell.');
      }
      await new Promise<void>((resolve, reject) => {
        const offer: PendingCellOffer<T> = { value, resolve, reject };
        const reader = waitingReader;
        if (reader) {
          waitingReader = null;
          deliver(offer, reader);
        } else {
          offered = offer;
        }
      });
    },
    close,
    fail,
  };
}

function persistedCellFromCompilerCell(
  cell: CompiledBroadSurfaceRgba8CellV1
): CompiledBroadRasterSourceCellV1 {
  const address = {
    isoformMode: cell.isoformMode,
    level: cell.level,
    tileX: cell.tileX,
    laneSlabIndex: cell.laneSlabIndex,
  } as const;
  if (cell.transparent) {
    return Object.freeze({
      ...address,
      occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
    });
  }
  return Object.freeze({
    ...address,
    occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
    premultipliedRgba: cell.pixels,
  });
}

export async function compileAndPublishBroadRasterArtifactForPackedScene(
  input: {
    readonly request: AssemblyAnnotationSceneReadRequest;
    readonly sourceFingerprint: string;
    readonly packed: PackedPartitionedTranscriptSceneBinaryV4;
    readonly publishWhen?: Promise<boolean>;
  },
  deps: BroadRasterCompilerDeps = {}
): Promise<ExpandedAnnotationSceneBroadCompanionReceiptV1 | undefined> {
  const buildSurfaceManifest =
    deps.buildBroadRasterSurfaceManifest ?? buildAssemblyCompiledBroadRasterSurfaceManifestV1;
  const resolveArtifactDirectory =
    deps.resolveBroadRasterArtifactDirectory ?? assemblyCompiledBroadRasterArtifactDirectory;
  const compileBroadRaster = deps.compileBroadRaster ?? compilePackedTranscriptBroadSurfaceRgba8V1;
  const publishBroadRaster = deps.publishBroadRaster ?? publishCompiledBroadRasterArtifactV1;
  const surfaceManifest = await buildSurfaceManifest({
    sceneManifest: input.packed.manifest,
    artifact: input.request.artifact,
  });
  const artifactDirectory = resolveArtifactDirectory({
    request: input.request,
    sourceFingerprint: input.sourceFingerprint,
    surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
  });
  if (!artifactDirectory) fail('invalid broad raster artifact directory');
  const roles = input.packed.roleSidecar;
  const roleWeights =
    roles && roles.roleTable.length <= COMPILED_BROAD_SURFACE_MAX_WEIGHTED_ROLES_V1
      ? {
          weights: {
            expanded: roles.expandedRoleIndices,
            canonical: roles.canonicalRoleIndices,
          },
          roleTable: roles.roleTable,
        }
      : null;

  if (deps.encodeBroadRasterCells) {
    const cells = await deps.encodeBroadRasterCells({
      packed: input.packed,
      surfaceManifest,
      ...(roleWeights ? { roleWeights: roleWeights.weights } : {}),
    });
    if (input.publishWhen && !(await input.publishWhen)) return undefined;
    const published = await publishBroadRaster({
      artifactDirectory,
      surfaceManifest,
      cells,
      ...(roleWeights ? { roleTable: roleWeights.roleTable } : {}),
    });
    return Object.freeze({
      status: 'published',
      sourceFingerprint: input.sourceFingerprint,
      surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
      catalogFingerprint: published.catalogFingerprint,
      quarantinedCorruptArtifact: false,
    });
  }

  if (input.publishWhen && !(await input.publishWhen)) return undefined;
  const handoff = createAwaitedOneCellHandoff<CompiledBroadRasterSourceCellV1>();
  const compiler = (async () => {
    try {
      const result = await compileBroadRaster({
        packedScene: input.packed,
        surfaceManifest,
        rasterizer: 'wasm',
        ...(roleWeights ? { roleWeights: roleWeights.weights } : {}),
        onCell: async (cell) => {
          await handoff.publish(persistedCellFromCompilerCell(cell));
        },
      });
      handoff.close();
      return result;
    } catch (error) {
      handoff.fail(error);
      throw error;
    }
  })();

  try {
    const published = await publishBroadRaster({
      artifactDirectory,
      surfaceManifest,
      cells: handoff.cells,
      ...(roleWeights ? { roleTable: roleWeights.roleTable } : {}),
    });
    await compiler;
    return Object.freeze({
      status: 'published',
      sourceFingerprint: input.sourceFingerprint,
      surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
      catalogFingerprint: published.catalogFingerprint,
      quarantinedCorruptArtifact: false,
    });
  } catch (error) {
    handoff.fail(error);
    await compiler.catch(() => undefined);
    throw error;
  }
}

export async function compileAndCommitExpandedAnnotationSceneWorkerJob(
  job: ExpandedAnnotationSceneWorkerJob,
  deps: ExpandedCompilerDeps
): Promise<ExpandedAnnotationSceneWorkerResult> {
  validateExpandedJob(job);
  const readFeaturesCache =
    deps.readFeaturesCache ??
    (readAssemblyOverviewFeaturesCache as NonNullable<ExpandedCompilerDeps['readFeaturesCache']>);
  const cache = await readFeaturesCache(
    {
      assemblyId: job.request.assemblyId,
      chromosomes: job.request.chromosomes,
      workspaceRoot: job.request.workspaceRoot,
      mode: 'expanded',
      overviewExtentsOnly: false,
    },
    {
      assertSafePath: deps.assertSafePath,
    }
  );
  const preparedFeatureGraph = cache ? null : await buildFeatureGraphFromPerChromCaches(job, deps);
  if (!cache && !preparedFeatureGraph) return featuresCacheMissResult();
  if (preparedFeatureGraph && deps.writeFeaturesCache) {
    const persisted = await deps.writeFeaturesCache(
      {
        assemblyId: job.request.assemblyId,
        chromosomes: job.request.chromosomes,
        workspaceRoot: job.request.workspaceRoot,
        mode: 'expanded',
        byChrom: preparedFeatureGraph,
      },
      { assertSafePath: deps.assertSafePath }
    );
    if (!persisted) fail('expanded full-assembly feature-cache publication');
  }
  const compiled = cache
    ? await compileExpandedAnnotationSceneEnvelope(job, cache)
    : await compileAnnotationSceneFeatureGraph(job, preparedFeatureGraph!);
  const writeSceneCache = deps.writeSceneCache ?? writeAssemblyAnnotationSceneCache;
  const writeResult = await writeSceneCache(
    {
      ...job.request,
      expectedSourceFingerprint: job.authorizedMiss.fingerprint,
      expectedSourceBuildFingerprint: job.authorizedMiss.sourceBuildFingerprint,
      manifest: compiled.packed.manifest,
      payload: compiled.packed.payload,
      compiledBroadInteraction: compiled.compiledBroadInteraction,
    },
    {
      assertSafePath: deps.assertSafePath,
      sourceBuildFingerprint: job.runtimeSourceBuildFingerprint,
    } as AssemblyTextureCacheDeps
  );
  return {
    status: writeResult?.fingerprint === job.authorizedMiss.fingerprint ? 'committed' : 'stale',
    featureCount: compiled.featureCount,
    droppedCount: compiled.droppedCount,
    primitiveCount: compiled.primitiveCount,
    byteCount: compiled.packed.payload.byteLength,
  };
}

export async function compileAndCommitExpandedAnnotationSceneWorkerSetJob(
  setJob: ExpandedAnnotationSceneWorkerSetJob,
  deps: ExpandedCompilerDeps
): Promise<ExpandedAnnotationSceneWorkerSetResult> {
  if (!Array.isArray(setJob.jobs) || setJob.jobs.length === 0) {
    fail('empty annotation product set');
  }
  const jobs = [...setJob.jobs];
  for (const job of jobs) validateExpandedJob(job);
  const sourceIdentity = JSON.stringify({
    request: productSetSourceIdentity(jobs[0].request),
    authorized: jobs[0].authorizedSourceRealPaths,
    runtimeSourceBuildFingerprint: jobs[0].runtimeSourceBuildFingerprint,
  });
  if (
    jobs.some(
      (job) =>
        JSON.stringify({
          request: productSetSourceIdentity(job.request),
          authorized: job.authorizedSourceRealPaths,
          runtimeSourceBuildFingerprint: job.runtimeSourceBuildFingerprint,
        }) !== sourceIdentity
    )
  ) {
    fail('mixed-source annotation product set');
  }
  const trackTypes = new Set(jobs.map((job) => job.request.artifact.trackType));
  if (trackTypes.size !== jobs.length) fail('duplicate annotation product-set track');
  const parseTrackTypes = new Set(setJob.parseTrackTypes ?? trackTypes);
  for (const trackType of trackTypes) {
    if (!parseTrackTypes.has(trackType)) fail('annotation product-set slice outside its parse set');
  }
  const parsedKey = JSON.stringify([sourceIdentity, [...parseTrackTypes].sort()]);
  const memoized = deps.parsedFeatures?.get(parsedKey);

  const first = jobs[0];
  const timing = referencePreparationTiming(`scene-set[${first.request.artifact.themeMode}]`);
  const readFeaturesCache =
    deps.readFeaturesCache ??
    (readAssemblyOverviewFeaturesCache as NonNullable<ExpandedCompilerDeps['readFeaturesCache']>);
  const cache = memoized
    ? null
    : await readFeaturesCache(
        {
          assemblyId: first.request.assemblyId,
          chromosomes: first.request.chromosomes,
          workspaceRoot: first.request.workspaceRoot,
          mode: 'expanded',
          overviewExtentsOnly: false,
        },
        { assertSafePath: deps.assertSafePath }
      );
  const preparedFeatureGraph =
    memoized || cache ? null : await buildFeatureGraphFromPerChromCaches(first, deps);
  if (!memoized && !cache && !preparedFeatureGraph) {
    return { results: jobs.map(() => featuresCacheMissResult()) };
  }
  if (preparedFeatureGraph && deps.writeFeaturesCache) {
    const persisted = await deps.writeFeaturesCache(
      {
        assemblyId: first.request.assemblyId,
        chromosomes: first.request.chromosomes,
        workspaceRoot: first.request.workspaceRoot,
        mode: 'expanded',
        byChrom: preparedFeatureGraph,
      },
      { assertSafePath: deps.assertSafePath }
    );
    if (!persisted) fail('expanded full-assembly feature-cache publication');
  }
  const parsed =
    memoized ??
    (cache
      ? parseValidatedFeatureEnvelope(first, cache, parseTrackTypes)
      : flattenValidatedFeatureGraph(
          first,
          preparedFeatureGraph as Record<string, unknown>,
          parseTrackTypes
        ));
  deps.parsedFeatures?.set(parsedKey, parsed);
  timing('features');
  const spent = { compile: 0, write: 0, broad: 0 };
  let mark = performance.now();
  const lap = (key: keyof typeof spent) => {
    const now = performance.now();
    spent[key] += now - mark;
    mark = now;
  };
  const results: ExpandedAnnotationSceneWorkerResult[] = [];
  for (const job of jobs) {
    mark = performance.now();
    const trackStarted = mark;
    const before = { ...spent };
    const compiled = await compileAnnotationSceneFeatures(job, parsed);
    lap('compile');
    const writeSceneCache = deps.writeSceneCache ?? writeAssemblyAnnotationSceneCache;
    const written = writeSceneCache(
      {
        ...job.request,
        expectedSourceFingerprint: job.authorizedMiss.fingerprint,
        expectedSourceBuildFingerprint: job.authorizedMiss.sourceBuildFingerprint,
        manifest: compiled.packed.manifest,
        payload: compiled.packed.payload,
        compiledBroadInteraction: compiled.compiledBroadInteraction,
        ...(compiled.packed.roleSidecar ? { roleSidecar: compiled.packed.roleSidecar } : {}),
      },
      {
        assertSafePath: deps.assertSafePath,
        sourceBuildFingerprint: job.runtimeSourceBuildFingerprint,
      } as AssemblyTextureCacheDeps
    );
    const committed = written.then(
      (writeResult) => writeResult?.fingerprint === job.authorizedMiss.fingerprint,
      () => false
    );
    const broad = (
      deps.compileBroadCompanion ?? compileAndPublishBroadRasterArtifactForPackedScene
    )({
      request: job.request,
      sourceFingerprint: job.authorizedMiss.fingerprint,
      packed: compiled.packed,
      publishWhen: committed,
    });
    let writeResult: Awaited<typeof written>;
    try {
      writeResult = await written;
    } catch (error) {
      await broad.catch(() => undefined);
      throw error;
    }
    lap('write');
    const status =
      writeResult?.fingerprint === job.authorizedMiss.fingerprint ? 'committed' : 'stale';
    const broadCompanion = await broad;
    lap('broad');
    if (performance.now() - trackStarted > 1000) {
      timing(
        `track ${job.request.artifact.trackType} compile=${Math.round(spent.compile - before.compile)}ms write=${Math.round(spent.write - before.write)}ms broad=${Math.round(spent.broad - before.broad)}ms`
      );
    }
    results.push({
      status,
      featureCount: compiled.featureCount,
      droppedCount: compiled.droppedCount,
      primitiveCount: compiled.primitiveCount,
      byteCount: compiled.packed.payload.byteLength,
      ...(broadCompanion ? { broadCompanion } : {}),
    });
  }
  timing(
    `tracks compile=${Math.round(spent.compile)}ms write=${Math.round(spent.write)}ms broad=${Math.round(spent.broad)}ms`
  );
  return { results };
}

export async function readExpandedAnnotationSceneTrackInventoryWorkerJob(
  job: ExpandedAnnotationSceneWorkerJob,
  deps: ExpandedCompilerDeps
): Promise<ExpandedAnnotationSceneInventoryWorkerResult> {
  validateExpandedJob(job);
  const timing = referencePreparationTiming('discovery');
  const readFeaturesCache =
    deps.readFeaturesCache ??
    (readAssemblyOverviewFeaturesCache as NonNullable<ExpandedCompilerDeps['readFeaturesCache']>);
  const cache = await readFeaturesCache(
    {
      assemblyId: job.request.assemblyId,
      chromosomes: job.request.chromosomes,
      workspaceRoot: job.request.workspaceRoot,
      mode: 'expanded',
      overviewExtentsOnly: false,
    },
    { assertSafePath: deps.assertSafePath }
  );
  timing('read-features-cache');
  if (!cache && deps.buildFeatureCacheFragments && deps.writeFeaturesCacheFragments) {
    const built = await deps.buildFeatureCacheFragments(job);
    timing('build-feature-cache-fragments');
    if (built.status !== 'ready') return { status: 'features-cache-miss', trackTypes: [] };
    await deps.writeFeaturesCacheFragments(
      {
        assemblyId: job.request.assemblyId,
        chromosomes: job.request.chromosomes,
        workspaceRoot: job.request.workspaceRoot,
        mode: 'expanded',
        fragments: built.fragments,
        featureCount: built.featureCount,
      },
      { assertSafePath: deps.assertSafePath }
    );
    timing('write-features-cache');
    const trackTypes = [...built.trackTypes].sort((left, right) => left.localeCompare(right));
    if (trackTypes.length === 0) fail('empty annotation track inventory');
    return { status: 'ready', trackTypes };
  }
  const preparedFeatureGraph = cache ? null : await buildFeatureGraphFromPerChromCaches(job, deps);
  timing('build-feature-graph');
  if (!cache && !preparedFeatureGraph) {
    return { status: 'features-cache-miss', trackTypes: [] };
  }
  if (preparedFeatureGraph && deps.writeFeaturesCache) {
    await deps.writeFeaturesCache(
      {
        assemblyId: job.request.assemblyId,
        chromosomes: job.request.chromosomes,
        workspaceRoot: job.request.workspaceRoot,
        mode: 'expanded',
        byChrom: preparedFeatureGraph,
      },
      { assertSafePath: deps.assertSafePath }
    );
  }
  timing('write-features-cache');
  const parsed = cache
    ? parseValidatedFeatureEnvelope(job, cache, new Set())
    : flattenValidatedFeatureGraph(job, preparedFeatureGraph as Record<string, unknown>, new Set());
  const trackTypes = [
    ...new Set(
      parsed
        .map(({ feature }) => feature.annotationTrackId ?? feature.type)
        .filter((trackType) => trackType && isUserAnnotationLayer(trackType))
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (trackTypes.length === 0) fail('empty annotation track inventory');
  timing('parse-and-list-tracks');
  return { status: 'ready', trackTypes };
}

function productSetSourceIdentity(request: AssemblyAnnotationSceneReadRequest): unknown {
  const { artifact: _artifact, requestedPolicy: _requestedPolicy, ...source } = request;
  return source;
}

function featuresCacheMissResult(): ExpandedAnnotationSceneWorkerResult {
  return {
    status: 'features-cache-miss',
    featureCount: 0,
    droppedCount: 0,
    primitiveCount: 0,
    byteCount: 0,
  };
}
