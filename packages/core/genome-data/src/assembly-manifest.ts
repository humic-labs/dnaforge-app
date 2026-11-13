import type { AssemblySequenceRole } from './assembly-sequence-role';
import type { ChromosomeMorphologyV1 } from './reference-semantics';
import type { IndexedGenomeManifest } from './types';

export type { AssemblySequenceRole };

export interface AssemblySequenceAliases {
  refseq?: string;
  genbank?: string;
  ucsc?: string;
  ensembl?: string;
}

export interface AssemblyChromosomeEntry {
  chrom: string;
  displayName: string;
  length: number;
  manifest: IndexedGenomeManifest;
  role?: AssemblySequenceRole;
  aliases?: AssemblySequenceAliases;
  md5?: string;
  circular?: boolean;
  cytobandId?: string;
  morphology?: ChromosomeMorphologyV1;
}

export interface IndexedGenomeAssemblyManifest {
  assemblyId: string;
  displayName: string;
  organism?: string;
  taxId?: number;
  assembly?: string;
  ucscTrackTarget?: Readonly<{ genomeId: string; hubUrl: string }>;
  chromosomes: ReadonlyArray<AssemblyChromosomeEntry>;
}

export type GenomeAssembly = IndexedGenomeAssemblyManifest;
export type IndexedChromosome = AssemblyChromosomeEntry;

export function assemblyTotalLengthBp(manifest: IndexedGenomeAssemblyManifest): number {
  let total = 0;
  for (const entry of manifest.chromosomes) total += entry.length;
  return total;
}

export function buildAssemblyManifest(input: {
  assemblyId: string;
  displayName: string;
  organism?: string;
  taxId?: number;
  assembly?: string;
  ucscTrackTarget?: Readonly<{ genomeId: string; hubUrl: string }>;
  chromosomes: ReadonlyArray<AssemblyChromosomeEntry>;
}): IndexedGenomeAssemblyManifest {
  if (input.chromosomes.length === 0) {
    throw new Error(`buildAssemblyManifest: assembly "${input.assemblyId}" has no chromosomes.`);
  }
  const seen = new Set<string>();
  for (const entry of input.chromosomes) {
    if (entry.chrom !== entry.manifest.chrom) {
      throw new Error(
        `buildAssemblyManifest: entry.chrom "${entry.chrom}" !== entry.manifest.chrom "${entry.manifest.chrom}".`
      );
    }
    if (!Number.isFinite(entry.length) || entry.length <= 0) {
      throw new Error(
        `buildAssemblyManifest: chromosome "${entry.chrom}" has non-positive length ${entry.length}.`
      );
    }
    if (seen.has(entry.chrom)) {
      throw new Error(`buildAssemblyManifest: duplicate chromosome id "${entry.chrom}".`);
    }
    seen.add(entry.chrom);
  }
  return {
    assemblyId: input.assemblyId,
    displayName: input.displayName,
    organism: input.organism,
    taxId: input.taxId,
    assembly: input.assembly,
    ...(input.ucscTrackTarget ? { ucscTrackTarget: input.ucscTrackTarget } : {}),
    chromosomes: input.chromosomes,
  };
}

export function assemblyOfOne(
  manifest: IndexedGenomeManifest,
  opts?: { displayName?: string; organism?: string; length?: number; cytobandId?: string }
): IndexedGenomeAssemblyManifest {
  const length = opts?.length ?? manifest.length ?? 0;
  return {
    assemblyId: `assembly-of-one:${manifest.chrom}`,
    displayName: opts?.displayName ?? manifest.chrom,
    organism: opts?.organism,
    chromosomes: [
      {
        chrom: manifest.chrom,
        displayName: manifest.chrom,
        length,
        manifest,
        circular: manifest.circular,
        cytobandId: opts?.cytobandId ?? manifest.chrom,
      },
    ],
  };
}
