import type { Genome } from '../../../types';

export function genomeSequenceAvailable(genome: Genome): boolean {
  return genome.sequenceAvailable ?? (!!genome.sequence || !!genome.sequenceWindow);
}
