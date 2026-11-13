export function parseFastaAminoAcidSequence(raw: string): string {
  const lines = raw.split(/\r?\n/u);
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  const headerIndexes = lines.flatMap((line, index) =>
    line.trimStart().startsWith('>') ? [index] : []
  );
  const hasLeadingHeader = headerIndexes.length === 1 && headerIndexes[0] === firstContentIndex;
  if (headerIndexes.length > 1 || (headerIndexes.length === 1 && !hasLeadingHeader)) {
    throw new Error(
      'This protein FASTA contains multiple records. Open it in the sequence viewer to browse its records.'
    );
  }
  const body = hasLeadingHeader ? lines.slice(firstContentIndex + 1) : lines;
  return body.join('').replace(/\s/gu, '').toUpperCase();
}

export function serializeAminoAcidFasta(name: string, bases: string): string {
  const safeName = name.replace(/[\r\n]+/gu, ' ').trim();
  return `>${safeName}\n${bases}\n`;
}
