import {
  runReferenceIntervalAction,
  type GenomeDataSource,
  type ReferenceIntervalOperation,
  type ReferenceIntervalResult,
  type ReferenceIntervalStrand,
} from '@waypoint/genome-data';

import type { IndexedGenomeManifest, IndexedGenomeTabState } from '../../shared/indexed-genome';
import { createPlatformIndexedGenomeDataSource } from '../../shared/platform-indexed-genome-data-source';
import {
  projectIndexedAssemblyLiveViewport,
  projectIndexedLiveViewport,
  type IndexedAssemblyCoordinates,
  type IndexedViewportApply,
} from './indexed-viewport-command';

export type IndexedSequenceActionTarget = IndexedViewportApply;

export function projectIndexedRendererSelection(
  selection: readonly [number, number],
  fallbackChrom: string,
  assembly?: IndexedAssemblyCoordinates
): IndexedSequenceActionTarget | null {
  const start = Math.min(selection[0], selection[1]);
  const end = Math.max(selection[0], selection[1]) + 1;
  return projectIndexedRendererRange({ start, end }, fallbackChrom, assembly);
}

export function projectIndexedRendererRange(
  range: Readonly<{ start: number; end: number }>,
  fallbackChrom: string,
  assembly?: IndexedAssemblyCoordinates
): IndexedSequenceActionTarget | null {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start
  ) {
    return null;
  }
  return assembly
    ? projectIndexedAssemblyLiveViewport(range, assembly)
    : projectIndexedLiveViewport(fallbackChrom, range);
}

export function indexedManifestForTarget(
  state: IndexedGenomeTabState | null | undefined,
  target: IndexedSequenceActionTarget
): IndexedGenomeManifest | null {
  if (!state) return null;
  if (state.assembly) {
    return (
      state.assembly.chromosomes.find((chromosome) => chromosome.chrom === target.chrom)
        ?.manifest ?? null
    );
  }
  return state.manifest?.chrom === target.chrom ? state.manifest : null;
}

export async function runIndexedSequenceAction(
  input: {
    target: IndexedSequenceActionTarget;
    manifest: IndexedGenomeManifest;
    sourceId: string;
    assemblyId?: string;
    operation: ReferenceIntervalOperation;
    strand?: ReferenceIntervalStrand;
    featureId?: string;
    workspaceRootPaths?: readonly string[];
  },
  deps: { source?: GenomeDataSource } = {}
): Promise<ReferenceIntervalResult> {
  const source =
    deps.source ??
    createPlatformIndexedGenomeDataSource(input.manifest, input.workspaceRootPaths ?? []);
  return runReferenceIntervalAction(
    source,
    {
      chrom: input.target.chrom,
      start0: input.target.start0,
      end0: input.target.end0,
      strand: input.strand ?? '+',
      operation: input.operation,
      ...(input.featureId ? { featureId: input.featureId } : {}),
    },
    {
      sourceId: input.sourceId,
      fastaPath: input.manifest.fastaPath,
      ...(input.assemblyId ? { assemblyId: input.assemblyId } : {}),
    }
  );
}
