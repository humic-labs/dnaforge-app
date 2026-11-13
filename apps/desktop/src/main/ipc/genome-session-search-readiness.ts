import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSceneSourceRequest,
  AssemblyReferenceAssetGenerationV1,
  GenomeOpenSource,
  IndexedGenomeManifest,
  IndexedGenomeTabState,
} from '../../shared/indexed-genome';
import {
  assemblyAnnotationSceneScopeForRequest,
  isAssemblyReferenceAssetGenerationV1,
} from '../../shared/indexed-genome';
import { deriveAssemblyPrepackedAnnotationSceneDescriptor } from '../../features/sequence/assembly-annotation-product-descriptor';
import { isPreparedReferenceAssetPath } from '../reference-assets/reference-asset-runtime-boundary';
import { isBoundedAssemblyAnnotationSearchSource } from './genome-data-request-guards';

export interface GenomeSessionSearchReadinessDeps {
  ensureImportedReferenceSearchIndexes(
    source: AssemblyAnnotationSceneReadRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<GenomeSessionSearchIndexMetadata>;
  verifyPreparedReferenceSearchIndexes(
    source: AssemblyAnnotationSceneReadRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<GenomeSessionSearchIndexMetadata>;
  verifyReferenceAssetGeneration(
    source: AssemblyAnnotationSceneReadRequest,
    expected: AssemblyReferenceAssetGenerationV1,
    options?: { readonly signal?: AbortSignal }
  ): Promise<void>;
}

export interface GenomeSessionSearchIndexMetadata {
  readonly annotationFeatureCount: number;
}

export type GenomeSessionSearchReadiness =
  | { readonly status: 'not-required' }
  | { readonly status: 'not-applicable' }
  | { readonly status: 'pending' }
  | {
      readonly status: 'ready';
      readonly source: AssemblyAnnotationSceneReadRequest;
      readonly annotationFeatureCount: number;
    };

export async function prepareGenomeSessionSearchReadiness(input: {
  source: GenomeOpenSource;
  preparedTabState?: IndexedGenomeTabState;
  referenceAssetCacheRoot: string;
  deps: GenomeSessionSearchReadinessDeps;
  signal?: AbortSignal;
}): Promise<GenomeSessionSearchReadiness> {
  throwIfSearchReadinessAborted(input.signal);
  const { intent } = input.source;
  if (intent.kind === 'internal-assembly-segment') return { status: 'not-required' };

  if (intent.kind === 'reference-assembly' && intent.searchReadiness === 'not-applicable') {
    return { status: 'not-applicable' };
  }

  if (intent.kind === 'reference-assembly' && intent.searchReadiness === 'pending') {
    return { status: 'pending' };
  }

  const searchSource =
    intent.kind === 'reference-assembly'
      ? requiredPreparedSearchSource(intent.searchSource)
      : await deriveStandaloneReferenceSearchSource({
          source: input.source,
          preparedTabState: requiredPreparedTabState(input.preparedTabState),
        });
  throwIfSearchReadinessAborted(input.signal);

  assertSearchSourceBoundToManifest(
    searchSource,
    input.source,
    intent.kind === 'reference-assembly'
      ? input.source.manifest
      : requiredPreparedTabState(input.preparedTabState).manifest
  );
  await assertStandaloneReferenceSearchWriteAllowed({
    referenceAssetCacheRoot: input.referenceAssetCacheRoot,
    source: input.source,
    searchSource,
  });
  throwIfSearchReadinessAborted(input.signal);
  let searchMetadata: GenomeSessionSearchIndexMetadata;
  if (intent.kind === 'reference-assembly') {
    try {
      await input.deps.verifyReferenceAssetGeneration(
        searchSource,
        requiredPreparedGeneration(intent.assetGeneration),
        { signal: input.signal }
      );
      searchMetadata = await input.deps.verifyPreparedReferenceSearchIndexes(searchSource, {
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) throw error;
      return { status: 'pending' };
    }
  } else {
    searchMetadata = await input.deps.ensureImportedReferenceSearchIndexes(searchSource, {
      signal: input.signal,
    });
  }
  throwIfSearchReadinessAborted(input.signal);
  if (
    !Number.isSafeInteger(searchMetadata.annotationFeatureCount) ||
    searchMetadata.annotationFeatureCount < 0
  ) {
    throw new Error('Search readiness produced an invalid annotation feature count.');
  }
  return {
    status: 'ready',
    source: searchSource,
    annotationFeatureCount: searchMetadata.annotationFeatureCount,
  };
}

function throwIfSearchReadinessAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Genome-session search readiness was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function requiredPreparedTabState(
  preparedTabState: IndexedGenomeTabState | undefined
): IndexedGenomeTabState {
  if (!preparedTabState) {
    throw new Error('Standalone reference search readiness requires prepared tab state.');
  }
  return preparedTabState;
}

export async function assertStandaloneReferenceSearchWriteAllowed(input: {
  referenceAssetCacheRoot: string;
  source: Pick<GenomeOpenSource, 'sourcePath' | 'workspaceRoot' | 'intent'>;
  searchSource?: Pick<AssemblyAnnotationSceneReadRequest, 'workspaceRoot'>;
}): Promise<void> {
  if (input.source.intent.kind !== 'reference-single') return;
  if (await isPreparedReferenceSearchLocation(input)) {
    throw new Error(
      'Prepared reference cache requires exact reference-assembly generation authority.'
    );
  }
}

export async function isPreparedReferenceSearchLocation(input: {
  referenceAssetCacheRoot: string;
  source: Pick<GenomeOpenSource, 'sourcePath' | 'workspaceRoot'>;
  searchSource?: Pick<AssemblyAnnotationSceneReadRequest, 'workspaceRoot'>;
}): Promise<boolean> {
  const canonicalRoot = await canonicalPathForOwnership(input.referenceAssetCacheRoot);
  const candidatePaths = [
    input.source.sourcePath,
    input.source.workspaceRoot,
    input.searchSource?.workspaceRoot,
  ].filter((candidate): candidate is string => typeof candidate === 'string' && !!candidate.trim());
  const canonicalCandidates = await Promise.all(
    [...new Set(candidatePaths)].map((candidate) => canonicalPathForOwnership(candidate))
  );
  return canonicalCandidates.some((candidatePath) =>
    isPreparedReferenceAssetPath({
      referenceAssetCacheRoot: canonicalRoot,
      candidatePath,
    })
  );
}

export async function deriveStandaloneReferenceSearchSource(input: {
  source: GenomeOpenSource;
  preparedTabState: IndexedGenomeTabState;
}): Promise<AssemblyAnnotationSceneReadRequest> {
  const manifest = input.preparedTabState.manifest;
  const length = input.preparedTabState.metadata?.length ?? manifest?.length;
  if (
    !manifest ||
    !Number.isSafeInteger(length) ||
    typeof length !== 'number' ||
    length <= 0 ||
    !manifest.gffPath ||
    !manifest.tbiPath
  ) {
    throw new Error(
      'Reference search readiness requires an exact indexed FASTA/FAI/GFF3/TBI manifest.'
    );
  }

  const chromosomes: AssemblyAnnotationSceneSourceRequest['chromosomes'] = [
    {
      chrom: manifest.chrom,
      sourcePath: manifest.gffPath,
      manifest: { ...manifest, length },
      length,
    },
  ];
  const sourceRequest: AssemblyAnnotationSceneSourceRequest = {
    assemblyId: `single-reference:${manifest.chrom}`,
    workspaceRoot: requiredWorkspaceRoot(input.source),
    chromosomes,
    scope: assemblyAnnotationSceneScopeForRequest('complete-assembly', chromosomes),
  };
  const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
    request: sourceRequest,
    themeMode: 'light',
    policy: {
      trackType: 'mRNA',
      isoformMode: 'canonical',
      laneLimit: 2,
    },
  });
  return descriptor.request;
}

export function assertGenomeOpenIntent(source: GenomeOpenSource): void {
  const intent = (source as Partial<GenomeOpenSource>).intent;
  if (!intent || typeof intent !== 'object' || typeof intent.kind !== 'string') {
    throw new Error('Genome open requires an explicit session intent.');
  }
  if (intent.kind === 'reference-single') {
    if (Object.keys(intent).length !== 1) {
      throw new Error('Genome open intent reference-single contains unexpected fields.');
    }
    requiredWorkspaceRoot(source);
    return;
  }
  if (intent.kind === 'internal-assembly-segment') {
    const keys = Object.keys(intent);
    if (
      keys.length !== 1 &&
      (keys.length !== 2 || !isAssemblyReferenceAssetGenerationV1(intent.assetGeneration))
    ) {
      throw new Error(
        'Genome open intent internal-assembly-segment contains an invalid asset generation.'
      );
    }
    return;
  }
  if (intent.kind !== 'reference-assembly') {
    throw new Error('Genome open has an unsupported session intent.');
  }
  const allowedKeys = new Set([
    'kind',
    'searchSource',
    'annotationProductsReadiness',
    'searchReadiness',
    'assetGeneration',
  ]);
  if (
    Object.keys(intent).some((key) => !allowedKeys.has(key)) ||
    !isCapabilityReadiness(intent.annotationProductsReadiness) ||
    !isCapabilityReadiness(intent.searchReadiness) ||
    (intent.annotationProductsReadiness === 'not-applicable') !==
      (intent.searchReadiness === 'not-applicable') ||
    (intent.searchReadiness === 'not-applicable' && intent.searchSource !== undefined) ||
    (intent.searchSource !== undefined &&
      !isBoundedAssemblyAnnotationSearchSource(intent.searchSource)) ||
    ((intent.annotationProductsReadiness === 'ready' || intent.searchReadiness === 'ready') &&
      !isAssemblyReferenceAssetGenerationV1(intent.assetGeneration)) ||
    (intent.searchReadiness === 'ready' &&
      !isBoundedAssemblyAnnotationSearchSource(intent.searchSource))
  ) {
    throw new Error('Genome assembly open contains an invalid product/search readiness contract.');
  }
  if (!source.manifest) {
    throw new Error('Genome assembly open requires the exact opened chromosome manifest.');
  }
  const manifestHasGff = Boolean(source.manifest.gffPath);
  const manifestHasTbi = Boolean(source.manifest.tbiPath);
  if (
    manifestHasGff !== manifestHasTbi ||
    (intent.searchReadiness === 'not-applicable' && manifestHasGff)
  ) {
    throw new Error('Genome assembly open contains an invalid annotation capability contract.');
  }
  if (intent.searchSource) {
    assertSearchSourceBoundToManifest(intent.searchSource, source, source.manifest);
  }
}

function isCapabilityReadiness(value: unknown): boolean {
  return value === 'not-applicable' || value === 'pending' || value === 'ready';
}

function requiredPreparedSearchSource(
  source: AssemblyAnnotationSceneReadRequest | undefined
): AssemblyAnnotationSceneReadRequest {
  if (!source) throw new Error('Prepared reference search source is unavailable.');
  return source;
}

function requiredPreparedGeneration(
  generation: AssemblyReferenceAssetGenerationV1 | undefined
): AssemblyReferenceAssetGenerationV1 {
  if (!generation) throw new Error('Prepared reference asset generation is unavailable.');
  return generation;
}

function assertSearchSourceBoundToManifest(
  searchSource: AssemblyAnnotationSceneReadRequest,
  source: GenomeOpenSource,
  expectedManifest: IndexedGenomeManifest | undefined
): void {
  if (!isBoundedAssemblyAnnotationSearchSource(searchSource)) {
    throw new Error('Genome reference search source is invalid or incomplete.');
  }
  if (searchSource.workspaceRoot !== requiredWorkspaceRoot(source)) {
    throw new Error('Genome reference search source does not belong to the opened workspace.');
  }
  if (!expectedManifest) {
    throw new Error('Genome assembly open requires the exact opened chromosome manifest.');
  }
  const matchingChromosome = searchSource.chromosomes.find(
    (chromosome) => chromosome.chrom === expectedManifest.chrom
  );
  if (
    !matchingChromosome?.manifest ||
    !sameExactManifest(matchingChromosome.manifest, expectedManifest)
  ) {
    throw new Error('Genome reference search source does not contain the opened exact manifest.');
  }
}

function sameExactManifest(
  left: NonNullable<AssemblyAnnotationSceneReadRequest['chromosomes'][number]['manifest']>,
  right: IndexedGenomeManifest
): boolean {
  return (
    left.chrom === right.chrom &&
    left.fastaPath === right.fastaPath &&
    left.faiPath === right.faiPath &&
    (left.gffPath ?? null) === (right.gffPath ?? null) &&
    (left.tbiPath ?? null) === (right.tbiPath ?? null) &&
    (right.length === undefined || left.length === right.length) &&
    (right.circular === undefined || left.circular === right.circular)
  );
}

function requiredWorkspaceRoot(source: GenomeOpenSource): string {
  const workspaceRoot = source.workspaceRoot?.trim();
  if (!workspaceRoot) {
    throw new Error('Genome reference open requires a workspace root.');
  }
  return workspaceRoot;
}

async function canonicalPathForOwnership(path: string): Promise<string> {
  const absolutePath = resolve(path);
  let existingAncestor = absolutePath;

  for (;;) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      return resolve(canonicalAncestor, relative(existingAncestor, absolutePath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
}
