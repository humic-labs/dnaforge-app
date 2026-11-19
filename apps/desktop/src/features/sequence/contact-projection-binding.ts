import type { ContactSourceDescriptor } from '../../shared/contact-source';

export function assertContactProjectionReference(
  source: ContactSourceDescriptor,
  chromosomes: readonly { chrom: string; length: number }[]
): void {
  const match = chromosomes.find((chromosome) => chromosome.chrom === source.xReference.chrom);
  if (!match || match.length !== source.xReference.length)
    throw new Error('The contact X axis does not match the open reference accession and length.');
}
