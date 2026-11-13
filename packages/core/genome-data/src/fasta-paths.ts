const BGZIP_FASTA_SUFFIXES = ['.fa.gz', '.fasta.gz', '.fna.gz'] as const;

export function isBgzipFastaPath(path: string): boolean {
  const lower = path.toLowerCase();
  return BGZIP_FASTA_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function bgzipFastaGziPath(fastaPath: string): string {
  return `${fastaPath}.gzi`;
}
