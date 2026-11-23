export class ProteinFastaReadError extends Error {
  constructor(
    readonly code: 'malformed' | 'multiple-records',
    message: string
  ) {
    super(message);
    this.name = 'ProteinFastaReadError';
  }
}

export function parseFastaAminoAcidSequence(raw: string): string {
  const lines = raw.split(/\r?\n/u).filter((line) => !line.trimStart().startsWith(';'));
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  const headerIndexes = lines.flatMap((line, index) =>
    line.trimStart().startsWith('>') ? [index] : []
  );
  const hasLeadingHeader = headerIndexes.length === 1 && headerIndexes[0] === firstContentIndex;
  if (headerIndexes.length > 1) {
    throw new ProteinFastaReadError(
      'multiple-records',
      'This protein FASTA contains multiple records. Open it in the sequence viewer to browse its records.'
    );
  }
  if (headerIndexes.length === 1 && !hasLeadingHeader)
    throw new ProteinFastaReadError('malformed', 'The protein sequence precedes its FASTA header.');
  const body = hasLeadingHeader ? lines.slice(firstContentIndex + 1) : lines;
  const sequence = body.join('').replace(/\s/gu, '').toUpperCase();
  if (!/^[ACDEFGHIKLMNOPQRSTUVWYXBZJ.*-]+$/u.test(sequence))
    throw new ProteinFastaReadError(
      'malformed',
      'The protein FASTA has no sequence or contains invalid amino-acid characters.'
    );
  return sequence;
}

export function serializeAminoAcidFasta(name: string, bases: string): string {
  const safeName = name.replace(/[\r\n]+/gu, ' ').trim();
  return `>${safeName}\n${bases}\n`;
}
