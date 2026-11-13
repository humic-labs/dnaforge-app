import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type { IndexedGenomeManifest } from '@waypoint/genome-data';

import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import {
  indexedAnnotationSearchManifest,
  indexedQuartetPaths,
} from './assembly-annotation-search-compiler';
import {
  assemblyAnnotationSearchPlacement,
  type AssemblyAnnotationSearchSourceContinuityEntryV1,
} from './assembly-annotation-search-cache';

const ASSEMBLY_PROTEIN_SEARCH_SOURCE_REVISION_V1 =
  'assembly-protein-search-source-revision.v1' as const;

interface SourceStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs?: number;
}

export interface AssemblyProteinSearchResolvedChromosomeV1 {
  readonly chromosome: AssemblyAnnotationSceneReadRequest['chromosomes'][number];
  readonly manifest: IndexedGenomeManifest;
}

export interface AssemblyProteinSearchSourceRevisionV1 {
  readonly fingerprint: string;
  readonly sourceContinuity: readonly AssemblyAnnotationSearchSourceContinuityEntryV1[];
  readonly chromosomes: readonly AssemblyProteinSearchResolvedChromosomeV1[];
}

export interface AssemblyProteinSearchSourceDeps {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly statImpl?: (path: string) => Promise<SourceStat>;
}

export async function resolveAssemblyProteinSearchSourceRevisionV1(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyProteinSearchSourceDeps
): Promise<AssemblyProteinSearchSourceRevisionV1 | null> {
  if (!isCompleteAssemblyProteinSource(request)) return null;
  const placement = assemblyAnnotationSearchPlacement(request.chromosomes);
  if (!placement) return null;
  const statImpl = deps.statImpl ?? stat;
  const observations = new Map<string, AssemblyAnnotationSearchSourceContinuityEntryV1>();
  const resolved: AssemblyProteinSearchResolvedChromosomeV1[] = [];

  try {
    for (let index = 0; index < request.chromosomes.length; index += 1) {
      if (request.scope.placements[index]?.annotationCoverage !== 'sourced') continue;
      const chromosome = request.chromosomes[index];
      const sourcePath = chromosome.sourcePath?.trim();
      if (!sourcePath) return null;
      const manifest = await completeExplicitManifest(
        indexedAnnotationSearchManifest(chromosome),
        deps.assertSafePath,
        statImpl,
        observations
      );
      if (!manifest) return null;
      resolved.push({ chromosome, manifest });
    }
  } catch {
    return null;
  }
  if (resolved.length === 0) return null;

  const sourceContinuity = [...observations.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath)
  );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        ASSEMBLY_PROTEIN_SEARCH_SOURCE_REVISION_V1,
        request.assemblyId,
        placement.assemblyLengthBp,
        placement.placementSignature,
        request.datasetContract,
        resolved.map(({ chromosome, manifest }) => [
          chromosome.chrom,
          chromosome.length,
          manifest.fastaPath,
          manifest.faiPath,
          manifest.gffPath,
          manifest.tbiPath,
        ]),
        sourceContinuity.map((entry) => [
          entry.sourcePath,
          entry.size,
          entry.mtimeMs,
          entry.ctimeMs,
        ]),
      ])
    )
    .digest('hex')
    .slice(0, 24);
  return { fingerprint, sourceContinuity, chromosomes: resolved };
}

function isCompleteAssemblyProteinSource(request: AssemblyAnnotationSceneReadRequest): boolean {
  return Boolean(
    request &&
    request.scope?.kind === 'complete-assembly' &&
    Array.isArray(request.chromosomes) &&
    request.chromosomes.length > 0 &&
    request.scope.placements?.length === request.chromosomes.length &&
    request.scope.placements.some(
      (placement, index) =>
        placement.annotationCoverage === 'sourced' && request.chromosomes[index]?.sourcePath?.trim()
    )
  );
}

async function completeExplicitManifest(
  candidate: IndexedGenomeManifest | null,
  assertSafePath: (path: string) => Promise<void>,
  statImpl: (path: string) => Promise<SourceStat>,
  observations: Map<string, AssemblyAnnotationSearchSourceContinuityEntryV1>
): Promise<IndexedGenomeManifest | null> {
  if (!candidate) return null;
  const paths = indexedQuartetPaths(candidate);
  if (paths.length !== 4) return null;
  try {
    for (const path of paths) {
      await assertSafePath(path);
      await observe(path, statImpl, observations);
    }
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return null;
  }
}

async function observe(
  path: string,
  statImpl: (path: string) => Promise<SourceStat>,
  observations: Map<string, AssemblyAnnotationSearchSourceContinuityEntryV1>
): Promise<SourceStat> {
  const incumbent = observations.get(path);
  if (incumbent) {
    return {
      size: incumbent.size,
      mtimeMs: incumbent.mtimeMs,
      ...(incumbent.ctimeMs == null ? {} : { ctimeMs: incumbent.ctimeMs }),
    };
  }
  const current = await statImpl(path);
  if (!Number.isFinite(current.size) || current.size < 0 || !Number.isFinite(current.mtimeMs)) {
    throw new Error('Protein search source stat is invalid.');
  }
  observations.set(path, {
    sourcePath: path,
    size: current.size,
    mtimeMs: current.mtimeMs,
    ctimeMs: current.ctimeMs ?? null,
  });
  return current;
}
