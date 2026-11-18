import type { ComparisonSourceDescriptor } from '../../shared/comparison-source';

export function assertComparisonProjectionReference(
  source: ComparisonSourceDescriptor,
  chromosomes: readonly { chrom: string; length: number }[]
): void {
  const match = chromosomes.find((chromosome) => chromosome.chrom === source.targetReference.chrom);
  if (!match || match.length !== source.targetReference.length)
    throw new Error(
      'The comparison target does not match the open reference accession and length.'
    );
}
