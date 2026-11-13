import type { Chromosome } from './chromosome';

export interface AssemblyChromosomePlacement {
  chromosome: Chromosome;
  globalStartBp: number;
  globalEndBp: number;
  order: number;
}

export interface Assembly {
  id: string;
  displayName: string;
  chromosomes: ReadonlyArray<AssemblyChromosomePlacement>;
  totalLengthBp: number;
}

export interface AssemblyLocus {
  chrom: string;
  localBp: number;
  placement: AssemblyChromosomePlacement;
}
