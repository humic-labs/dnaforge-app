import type { GenomeAssembly } from '@waypoint/genome-data';

import type { AssemblyTextureReadRequest } from '../../shared/indexed-genome';

export function assemblyAnnotationSourceRequest(
  assembly: GenomeAssembly | null | undefined,
  workspaceRoot: string | null | undefined
): AssemblyTextureReadRequest | null {
  if (!assembly || !workspaceRoot) return null;
  const chromosomes = assembly.chromosomes.map((chromosome) => ({
    chrom: chromosome.chrom,
    sourcePath: chromosome.manifest.gffPath ?? null,
    manifest: chromosome.manifest.gffPath ? { ...chromosome.manifest } : null,
    length: chromosome.length,
  }));
  if (!chromosomes.some((chromosome) => Boolean(chromosome.sourcePath))) return null;
  return {
    assemblyId: assembly.assemblyId,
    chromosomes,
    workspaceRoot,
  };
}
