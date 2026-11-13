import {
  packPrepackedProteinSearchIndexV1,
  type GenomeFeature,
  type IndexableProteinSearchFeatureV1,
  type IndexedGenomeManifest,
  type ResolvedAnnotation,
} from '@waypoint/genome-data';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';

import { resolveTranscripts } from '../../features/sequence/components/spliced-feature-resolver';
import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import { assemblyAnnotationSearchPlacement } from './assembly-annotation-search-cache';
import {
  ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1,
  compileChromosomeProteinSearchFeaturesFromRangesV1,
  type CompileChromosomeProteinSearchFeaturesV1Result,
} from './assembly-protein-search-compiler';
import { writeAssemblyProteinSearchCache } from './assembly-protein-search-cache';
import { sha256BoundedNodeV1 } from './bounded-binary-sha256';

export interface AssemblyProteinSearchWorkerJob {
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly expectedSourceFingerprint: string;
  readonly resolvedChromosomes: ReadonlyArray<{
    chrom: string;
    manifest: IndexedGenomeManifest;
  }>;
  readonly authorizedSourceRealPaths: ReadonlyArray<{
    inputPath: string;
    realPath: string;
  }>;
}

export type AssemblyProteinSearchWorkerResult =
  | Readonly<{
      status: 'committed' | 'stale';
      featureCount: number;
      byteCount: number;
      work: CompileChromosomeProteinSearchFeaturesV1Result['work'];
    }>
  | Readonly<{
      status: 'features-cache-miss';
      featureCount: 0;
      byteCount: 0;
      work: CompileChromosomeProteinSearchFeaturesV1Result['work'];
    }>;

export interface ChromosomeSource {
  readonly rawFeatures: GenomeFeature[];
  readonly resolvedAnnotations: ResolvedAnnotation[];
  readSequence(start: number, end: number): Promise<string>;
  close(): Promise<void>;
}

interface AssemblyProteinSearchBuildDeps {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly openChromosomeSource?: (
    manifest: IndexedGenomeManifest,
    chrom: string,
    length: number
  ) => Promise<ChromosomeSource>;
  readonly writeSearchCache?: typeof writeAssemblyProteinSearchCache;
  readonly compileChromosomes?: (
    job: AssemblyProteinSearchWorkerJob,
    chromosomeIndexes: readonly number[]
  ) => Promise<readonly AssemblyProteinSearchChromosomeResultV1[]>;
}

export type AssemblyProteinSearchChromosomeResultV1 = Readonly<{
  features: IndexableProteinSearchFeatureV1[];
  work: CompileChromosomeProteinSearchFeaturesV1Result['work'];
}> | null;

export async function compileAssemblyProteinSearchChromosomeV1(
  job: AssemblyProteinSearchWorkerJob,
  index: number,
  deps: Pick<AssemblyProteinSearchBuildDeps, 'assertSafePath' | 'openChromosomeSource'>
): Promise<AssemblyProteinSearchChromosomeResultV1> {
  const chromosome = job.request.chromosomes[index];
  const authorized = new Set(job.authorizedSourceRealPaths.map(({ inputPath }) => inputPath));
  const manifest = job.resolvedChromosomes.find(
    (entry) => entry.chrom === chromosome.chrom
  )?.manifest;
  if (!manifest || !manifestPathsAreAuthorized(manifest, authorized)) return null;
  for (const path of manifestPaths(manifest)) await deps.assertSafePath(path);
  let globalStartBp = 0;
  for (let prior = 0; prior < index; prior += 1)
    globalStartBp += job.request.chromosomes[prior].length;
  const source = await (deps.openChromosomeSource ?? openLocalChromosomeSource)(
    manifest,
    chromosome.chrom,
    chromosome.length
  );
  try {
    const compiled = await compileChromosomeProteinSearchFeaturesFromRangesV1({
      chromosomeLengthBp: chromosome.length,
      globalStartBp,
      resolvedAnnotations: source.resolvedAnnotations,
      rawFeatures: source.rawFeatures,
      genomeIdentity: `assembly-annotation-source-sha256.v1:${job.request.datasetContract.sourceSha256}`,
      sourceOrdinalStart: 0,
      readSequence: (start, end) => source.readSequence(start, end),
    });
    return { features: compiled.features, work: compiled.work };
  } finally {
    await source.close();
  }
}

export async function compileAndCommitAssemblyProteinSearchWorkerJob(
  job: AssemblyProteinSearchWorkerJob,
  deps: AssemblyProteinSearchBuildDeps
): Promise<AssemblyProteinSearchWorkerResult> {
  if (!/^[0-9a-f]{24}$/.test(job.expectedSourceFingerprint)) {
    throw new Error('Protein search compiler rejected an invalid source revision.');
  }
  const placement = assemblyAnnotationSearchPlacement(job.request.chromosomes);
  if (!placement || !resolvedManifestSetMatchesRequest(job)) {
    throw new Error('Protein search compiler rejected an invalid assembly placement.');
  }
  const features: IndexableProteinSearchFeatureV1[] = [];
  const work = emptyWork();
  const sourced = job.request.chromosomes.flatMap((_, index) =>
    job.request.scope.placements[index]?.annotationCoverage === 'sourced' ? [index] : []
  );
  const compiled = deps.compileChromosomes
    ? await deps.compileChromosomes(job, sourced)
    : await sequentialChromosomes(job, sourced, deps);
  if (compiled.length !== sourced.length) {
    throw new Error('Protein search compiler returned an incomplete chromosome inventory.');
  }
  for (const chromosome of compiled) {
    if (!chromosome) {
      return { status: 'features-cache-miss', featureCount: 0, byteCount: 0, work };
    }
    const offset = features.length;
    for (const feature of chromosome.features) {
      features.push(
        offset === 0
          ? feature
          : { ...feature, sourceOrdinal: offset + (feature.sourceOrdinal ?? 0) }
      );
    }
    mergeWork(work, chromosome.work);
  }

  const packed = await packPrepackedProteinSearchIndexV1({
    datasetContract: job.request.datasetContract,
    assemblyContract: {
      assemblyId: job.request.assemblyId,
      assemblyLengthBp: placement.assemblyLengthBp,
      placementSignature: placement.placementSignature,
      sourceFingerprint: job.expectedSourceFingerprint,
    },
    features,
    payloadSha256: sha256BoundedNodeV1,
  });
  const written = await (deps.writeSearchCache ?? writeAssemblyProteinSearchCache)(
    {
      request: job.request,
      expectedSourceFingerprint: job.expectedSourceFingerprint,
      manifest: packed.manifest,
      payload: packed.payload,
      work,
    },
    { assertSafePath: deps.assertSafePath }
  );
  return {
    status: written ? 'committed' : 'stale',
    featureCount: features.length,
    byteCount: packed.payload.byteLength,
    work,
  };
}

async function sequentialChromosomes(
  job: AssemblyProteinSearchWorkerJob,
  indexes: readonly number[],
  deps: AssemblyProteinSearchBuildDeps
): Promise<AssemblyProteinSearchChromosomeResultV1[]> {
  const results: AssemblyProteinSearchChromosomeResultV1[] = [];
  for (const index of indexes) {
    const result = await compileAssemblyProteinSearchChromosomeV1(job, index, deps);
    results.push(result);
    if (!result) break;
  }
  return results.length === indexes.length
    ? results
    : [...results, ...indexes.slice(results.length).map(() => null)];
}

export async function openLocalChromosomeSource(
  manifest: IndexedGenomeManifest,
  chrom: string,
  length: number
): Promise<ChromosomeSource> {
  const source = new LocalIndexedGenomeDataSource(manifest, {
    checkFileMtimeOnRead: false,
    featureCacheEntries: 1,
    sequenceCacheEntries: 64,
    sequenceBlockSize: 64 * 1024,
  });
  try {
    const rawFeatures = await source.getFeatures(chrom, 0, length, 0);
    const resolvedAnnotations = resolveTranscripts(rawFeatures);
    return {
      rawFeatures,
      resolvedAnnotations,
      readSequence: (start, end) => source.getSequence(chrom, start, end),
      close: () => source.close(),
    };
  } catch (error) {
    await source.close().catch(() => undefined);
    throw error;
  }
}

function resolvedManifestSetMatchesRequest(job: AssemblyProteinSearchWorkerJob): boolean {
  const expected = job.request.chromosomes.flatMap((chromosome, index) =>
    job.request.scope.placements[index]?.annotationCoverage === 'sourced' ? [chromosome.chrom] : []
  );
  return (
    job.resolvedChromosomes.length === expected.length &&
    job.resolvedChromosomes.every(
      (entry, index) => entry.chrom === expected[index] && Boolean(entry.manifest)
    )
  );
}

function manifestPaths(manifest: IndexedGenomeManifest): string[] {
  return [manifest.fastaPath, manifest.faiPath, manifest.gffPath, manifest.tbiPath].filter(
    (path): path is string => typeof path === 'string' && path.length > 0
  );
}

function manifestPathsAreAuthorized(
  manifest: IndexedGenomeManifest,
  authorized: ReadonlySet<string>
): boolean {
  const paths = manifestPaths(manifest);
  return paths.length === 4 && paths.every((path) => authorized.has(path));
}

function emptyWork(): CompileChromosomeProteinSearchFeaturesV1Result['work'] {
  return {
    transcriptCount: 0,
    sourceTranslationCount: 0,
    derivedTranslationCount: 0,
    skippedEmptyTranslationCount: 0,
    quarantinedIsoformCount: 0,
    quarantinedIsoforms: [],
    quarantineDiagnosticsTruncated: false,
  };
}

function mergeWork(
  target: CompileChromosomeProteinSearchFeaturesV1Result['work'],
  source: CompileChromosomeProteinSearchFeaturesV1Result['work']
): void {
  target.transcriptCount += source.transcriptCount;
  target.sourceTranslationCount += source.sourceTranslationCount;
  target.derivedTranslationCount += source.derivedTranslationCount;
  target.skippedEmptyTranslationCount += source.skippedEmptyTranslationCount;
  target.quarantinedIsoformCount += source.quarantinedIsoformCount;
  const remaining =
    ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1 - target.quarantinedIsoforms.length;
  if (remaining > 0) {
    target.quarantinedIsoforms.push(...source.quarantinedIsoforms.slice(0, remaining));
  }
  target.quarantineDiagnosticsTruncated =
    target.quarantinedIsoformCount > ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1;
}
