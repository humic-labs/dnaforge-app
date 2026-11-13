export const ALIGNMENT_QUERY_EXTENSIONS = [
  'ab1',
  'abi',
  'seq',
  'fastq',
  'fq',
  'fasta',
  'fa',
  'fas',
  'fna',
  'ffn',
  'gb',
  'gbk',
  'gbff',
  'genbank',
] as const;

const ALIGNMENT_QUERY_EXTENSION_SET = new Set<string>(ALIGNMENT_QUERY_EXTENSIONS);

export function isAlignmentQueryPath(filePath: string): boolean {
  const ext = filePath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase();
  return !!ext && ALIGNMENT_QUERY_EXTENSION_SET.has(ext);
}
