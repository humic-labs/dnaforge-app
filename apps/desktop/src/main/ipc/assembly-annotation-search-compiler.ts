import {
  type IndexedGenomeManifest,
  type IndexableAnnotationSearchFeatureV1,
  type ResolvedAnnotation,
} from '@waypoint/genome-data';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import { annotationCanonicalIdentityV2 } from '@waypoint/genome-renderer/pure';

import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import {
  rendererAnnotationIdentityProjection,
  transcriptCarrierFeatureForRendererIdentity,
} from '../../features/sequence/components/indexed-genome-legacy-adapter';
import { resolveTranscripts } from '../../features/sequence/components/spliced-feature-resolver';
import {
  assemblyAnnotationSearchPlacement,
  packAssemblyAnnotationSearchCachePayload,
  writePackedAssemblyAnnotationSearchCache,
  writeAssemblyAnnotationSearchCache,
} from './assembly-annotation-search-cache';

export interface AssemblyAnnotationSearchWorkerJob {
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly expectedSourceFingerprint: string;
  readonly authorizedSourceRealPaths: ReadonlyArray<{ inputPath: string; realPath: string }>;
}

export type AssemblyAnnotationSearchWorkerResult =
  | Readonly<{
      status: 'committed' | 'stale';
      featureCount: number;
      byteCount: number;
    }>
  | Readonly<{
      status: 'features-cache-miss';
      featureCount: 0;
      byteCount: 0;
    }>;

export type AssemblyAnnotationSearchWorkerProgressPhase =
  | 'reading-sources'
  | 'packing-index'
  | 'writing-cache';

export interface AssemblyAnnotationSearchWorkerProgress {
  readonly sequence: number;
  readonly phase: AssemblyAnnotationSearchWorkerProgressPhase;
  readonly completed: number;
  readonly total: number;
  readonly chromosome?: string;
  readonly stage?: string;
}

interface AssemblyAnnotationSearchCompilerDeps {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly readIndexedSourceAnnotations?: (
    chromosome: AssemblyAnnotationSceneReadRequest['chromosomes'][number],
    request: AssemblyAnnotationSceneReadRequest,
    assertSafePath: (path: string) => Promise<void>,
    authorizedSourcePaths: ReadonlySet<string>
  ) => Promise<ResolvedAnnotation[] | null>;
  readonly writeSearchCache?: typeof writeAssemblyAnnotationSearchCache;
  readonly onProgress?: (progress: AssemblyAnnotationSearchWorkerProgress) => void;
  readonly compileChromosomes?: (
    job: AssemblyAnnotationSearchWorkerJob,
    chromosomeIndexes: readonly number[],
    onChromosome: (index: number) => void
  ) => Promise<readonly (IndexableAnnotationSearchFeatureV1[] | null)[]>;
}

export async function compileAssemblyAnnotationSearchChromosomeV1(
  job: AssemblyAnnotationSearchWorkerJob,
  index: number,
  deps: Pick<
    AssemblyAnnotationSearchCompilerDeps,
    'assertSafePath' | 'readIndexedSourceAnnotations'
  >
): Promise<IndexableAnnotationSearchFeatureV1[] | null> {
  const chromosome = job.request.chromosomes[index];
  const authorizedSourcePaths = new Set(
    job.authorizedSourceRealPaths.map(({ inputPath }) => inputPath)
  );
  const sourceFeatures = await (deps.readIndexedSourceAnnotations ?? readIndexedSourceAnnotations)(
    chromosome,
    job.request,
    deps.assertSafePath,
    authorizedSourcePaths
  );
  if (!sourceFeatures) return null;
  let globalStartBp = 0;
  for (let prior = 0; prior < index; prior += 1)
    globalStartBp += job.request.chromosomes[prior].length;
  const genomeIdentity = `assembly-annotation-source-sha256.v1:${job.request.datasetContract.sourceSha256}`;
  const features: IndexableAnnotationSearchFeatureV1[] = [];
  const seen = new Set<string>();
  for (const feature of sourceFeatures) {
    appendIndexableFeature(
      features,
      seen,
      feature,
      chromosome.chrom,
      chromosome.length,
      globalStartBp,
      genomeIdentity
    );
  }
  return features;
}

const SEARCH_NAME_ATTRIBUTE_KEYS = [
  'Name',
  'label',
  'gene',
  'gene_name',
  'transcript_name',
  'standard_name',
  'locus_tag',
  'transcript_id',
  'product',
  'Alias',
  'gene_synonym',
] as const;
const SEARCH_VALUE_ATTRIBUTE_KEYS = ['ID', ...SEARCH_NAME_ATTRIBUTE_KEYS] as const;

function searchableAttributes(
  feature: ResolvedAnnotation
): Record<string, ReadonlyArray<string>> | null {
  const source = feature.attributes ?? {};
  const hasUserFacingName = SEARCH_NAME_ATTRIBUTE_KEYS.some((key) =>
    (source[key] ?? []).some((value) => {
      const normalized = value.trim().toLowerCase();
      return (
        normalized.length > 0 &&
        normalized !== feature.type.trim().toLowerCase() &&
        normalized !== 'biological region'
      );
    })
  );
  if (!hasUserFacingName) return null;
  const selected: Record<string, ReadonlyArray<string>> = {};
  for (const key of SEARCH_VALUE_ATTRIBUTE_KEYS) {
    const values = source[key]?.filter((value) => value.trim().length > 0);
    if (values && values.length > 0) selected[key] = values;
  }
  return selected;
}

export async function readIndexedSourceAnnotations(
  chromosome: AssemblyAnnotationSceneReadRequest['chromosomes'][number],
  request: AssemblyAnnotationSceneReadRequest,
  assertSafePath: (path: string) => Promise<void>,
  authorizedSourcePaths: ReadonlySet<string>,
  loadResolved?: (manifest: IndexedGenomeManifest) => Promise<ResolvedAnnotation[]>
): Promise<ResolvedAnnotation[] | null> {
  const manifest = indexedAnnotationSearchManifest(chromosome);
  if (!manifest) return null;
  const paths = indexedQuartetPaths(manifest);
  if (!paths.every((path) => authorizedSourcePaths.has(path))) return null;
  await Promise.all(paths.map((path) => assertSafePath(path)));
  if (loadResolved) return loadResolved(manifest).catch(() => null);
  const source = new LocalIndexedGenomeDataSource(manifest, {
    checkFileMtimeOnRead: false,
    featureCacheEntries: 1,
    sequenceCacheEntries: 1,
  });
  try {
    const raw = await source.getFeatures(chromosome.chrom, 0, chromosome.length, 0);
    return resolveTranscripts(raw);
  } catch {
    return null;
  } finally {
    await source.close();
  }
}

export function indexedAnnotationSearchManifest(
  chromosome: AssemblyAnnotationSceneReadRequest['chromosomes'][number]
): IndexedGenomeManifest | null {
  const sourcePath = chromosome.sourcePath?.trim();
  const manifest = chromosome.manifest;
  if (
    !sourcePath ||
    !manifest ||
    manifest.chrom !== chromosome.chrom ||
    (manifest.length !== undefined && manifest.length !== chromosome.length) ||
    !manifest.fastaPath?.trim() ||
    !manifest.faiPath?.trim() ||
    !manifest.gffPath?.trim() ||
    !manifest.tbiPath?.trim() ||
    manifest.gffPath !== sourcePath
  ) {
    return null;
  }
  return manifest;
}

export function indexedQuartetPaths(manifest: IndexedGenomeManifest): string[] {
  return manifest.gffPath && manifest.tbiPath
    ? [manifest.fastaPath, manifest.faiPath, manifest.gffPath, manifest.tbiPath]
    : [];
}

function sourceFeatureId(feature: ResolvedAnnotation): string | null {
  return (
    feature.attributes?.ID?.[0] ??
    ('transcriptId' in feature ? feature.transcriptId : undefined) ??
    ('geneId' in feature ? feature.geneId : undefined) ??
    null
  );
}

function featureDisplayName(feature: ResolvedAnnotation): string {
  const attributes = feature.attributes ?? {};
  return (
    attributes.Name?.[0] ??
    attributes.label?.[0] ??
    attributes.gene?.[0] ??
    attributes.gene_name?.[0] ??
    attributes.transcript_name?.[0] ??
    attributes.standard_name?.[0] ??
    attributes.transcript_id?.[0] ??
    attributes.locus_tag?.[0] ??
    attributes.product?.[0] ??
    attributes.mobile_element_type?.[0] ??
    attributes.ID?.[0] ??
    feature.type
  );
}

function appendIndexableFeature(
  output: IndexableAnnotationSearchFeatureV1[],
  seen: Set<string>,
  feature: ResolvedAnnotation,
  chrom: string,
  chromosomeLengthBp: number,
  globalStartBp: number,
  genomeIdentity: string
): void {
  if (
    !feature ||
    typeof feature.type !== 'string' ||
    !feature.type.trim() ||
    !Number.isSafeInteger(feature.start) ||
    !Number.isSafeInteger(feature.end) ||
    feature.start < 0 ||
    feature.end <= feature.start ||
    feature.end > chromosomeLengthBp
  ) {
    throw new Error(`Annotation search compiler rejected an invalid ${chrom} feature.`);
  }

  const identity = JSON.stringify([
    chrom,
    feature.type,
    sourceFeatureId(feature),
    feature.start,
    feature.end,
    feature.source,
    feature.fileOffset ?? null,
  ]);
  if (!seen.has(identity)) {
    seen.add(identity);
    const attributes = searchableAttributes(feature);
    if (attributes) {
      const rendererIdentity = rendererAnnotationIdentityProjection(
        transcriptCarrierFeatureForRendererIdentity(feature)
      );
      if (
        rendererIdentity.start < 0 ||
        rendererIdentity.end <= rendererIdentity.start ||
        rendererIdentity.end > chromosomeLengthBp
      ) {
        throw new Error(
          `Annotation search compiler rejected invalid renderer bounds for a ${chrom} feature.`
        );
      }
      const annotationTrackId = rendererIdentity.annotationTrackId;
      const start = globalStartBp + rendererIdentity.start;
      const end = globalStartBp + rendererIdentity.end;
      output.push({
        sourceOrdinal: output.length,
        type: rendererIdentity.type,
        annotationTrackId,
        direction: rendererIdentity.direction,
        canonicalIdentity: annotationCanonicalIdentityV2({
          genomeIdentity,
          sourceId: rendererIdentity.sourceId,
          transcriptId: rendererIdentity.transcriptId,
          trackId: annotationTrackId,
          type: rendererIdentity.type,
          startBp: start,
          endBp: end,
          direction: rendererIdentity.direction,
        }),
        start,
        end,
        displayName: featureDisplayName(feature),
        attributes,
      });
    }
  }

  if ('transcripts' in feature && Array.isArray(feature.transcripts)) {
    for (const transcript of feature.transcripts) {
      appendIndexableFeature(
        output,
        seen,
        transcript,
        chrom,
        chromosomeLengthBp,
        globalStartBp,
        genomeIdentity
      );
    }
  }
}

export async function compileAndCommitAssemblyAnnotationSearchWorkerJob(
  job: AssemblyAnnotationSearchWorkerJob,
  deps: AssemblyAnnotationSearchCompilerDeps
): Promise<AssemblyAnnotationSearchWorkerResult> {
  if (!/^[0-9a-f]{24}$/.test(job.expectedSourceFingerprint)) {
    throw new Error('Annotation search compiler rejected an invalid source revision.');
  }
  const placement = assemblyAnnotationSearchPlacement(job.request.chromosomes);
  if (!placement) {
    throw new Error('Annotation search compiler rejected an invalid assembly placement.');
  }

  const sourcedChromosomes = job.request.chromosomes.flatMap((chromosome, index) => {
    if (job.request.scope.placements[index]?.annotationCoverage !== 'sourced') return [];
    const sourcePath = chromosome.sourcePath?.trim();
    return sourcePath ? [{ ...chromosome, sourcePath }] : [];
  });
  if (sourcedChromosomes.length === 0) {
    return { status: 'features-cache-miss', featureCount: 0, byteCount: 0 };
  }

  let progressSequence = 0;
  const emitProgress = (
    progress: Omit<AssemblyAnnotationSearchWorkerProgress, 'sequence'>
  ): void => {
    deps.onProgress?.({ sequence: (progressSequence += 1), ...progress });
  };
  const sourcedIndexes = job.request.chromosomes.flatMap((_, index) =>
    job.request.scope.placements[index]?.annotationCoverage === 'sourced' ? [index] : []
  );
  const sourcedTotal = sourcedChromosomes.length;
  let sourcedCompleted = 0;
  emitProgress({ phase: 'reading-sources', completed: 0, total: sourcedTotal });
  const onChromosome = (index: number) => {
    sourcedCompleted += 1;
    emitProgress({
      phase: 'reading-sources',
      completed: sourcedCompleted,
      total: sourcedTotal,
      chromosome: job.request.chromosomes[index].chrom,
    });
  };
  const perChromosome = deps.compileChromosomes
    ? await deps.compileChromosomes(job, sourcedIndexes, onChromosome)
    : await sequentialAnnotationChromosomes(job, sourcedIndexes, deps, onChromosome);
  const features: IndexableAnnotationSearchFeatureV1[] = [];
  for (const chromosomeFeatures of perChromosome) {
    if (!chromosomeFeatures) {
      return { status: 'features-cache-miss', featureCount: 0, byteCount: 0 };
    }
    const offset = features.length;
    for (const feature of chromosomeFeatures) {
      features.push(
        offset === 0
          ? feature
          : { ...feature, sourceOrdinal: offset + (feature.sourceOrdinal ?? 0) }
      );
    }
  }

  emitProgress({ phase: 'packing-index', completed: 0, total: 1 });
  const packed = await packAssemblyAnnotationSearchCachePayload({
    request: job.request,
    expectedSourceFingerprint: job.expectedSourceFingerprint,
    features,
    onProgress: (progress) =>
      emitProgress({
        phase: 'packing-index',
        completed: progress.completed,
        total: progress.total,
        stage: progress.phase,
      }),
  });
  if (!packed) throw new Error('Annotation search compiler could not pack its validated source.');
  emitProgress({ phase: 'packing-index', completed: 1, total: 1 });
  emitProgress({ phase: 'writing-cache', completed: 0, total: 1 });
  const written = deps.writeSearchCache
    ? await deps.writeSearchCache(
        {
          request: job.request,
          expectedSourceFingerprint: job.expectedSourceFingerprint,
          manifest: packed.manifest,
          payload: packed.payload,
        },
        { assertSafePath: deps.assertSafePath }
      )
    : await writePackedAssemblyAnnotationSearchCache(
        {
          request: job.request,
          expectedSourceFingerprint: job.expectedSourceFingerprint,
          packed,
        },
        { assertSafePath: deps.assertSafePath }
      );
  emitProgress({ phase: 'writing-cache', completed: 1, total: 1 });
  return {
    status: written ? 'committed' : 'stale',
    featureCount: features.length,
    byteCount: packed.payload.byteLength,
  };
}

async function sequentialAnnotationChromosomes(
  job: AssemblyAnnotationSearchWorkerJob,
  indexes: readonly number[],
  deps: AssemblyAnnotationSearchCompilerDeps,
  onChromosome: (index: number) => void
): Promise<(IndexableAnnotationSearchFeatureV1[] | null)[]> {
  const results: (IndexableAnnotationSearchFeatureV1[] | null)[] = [];
  for (const index of indexes) {
    const features = await compileAssemblyAnnotationSearchChromosomeV1(job, index, deps);
    results.push(features);
    if (!features) return [...results, ...indexes.slice(results.length).map(() => null)];
    onChromosome(index);
  }
  return results;
}
