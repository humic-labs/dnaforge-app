import type { SequenceFormat } from './parsers/types';

export const SEQUENCE_FILE_TYPES = [
  {
    format: 'genbank',
    extensions: ['gb', 'gbk', 'gbff', 'genbank'],
    encoding: 'text',
    managedImport: 'genbank',
  },
  {
    format: 'fasta',
    extensions: ['fasta', 'fa', 'fas', 'fna', 'ffn', 'dnas'],
    encoding: 'text',
    managedImport: 'nucleotide-fasta',
  },
  { format: 'fasta', extensions: ['faa'], encoding: 'text', managedImport: 'source' },
  { format: 'snapgene', extensions: ['dna'], encoding: 'binary', managedImport: 'snapgene' },
  { format: 'seq', extensions: ['seq'], encoding: 'text', managedImport: 'source' },
  { format: 'ab1', extensions: ['ab1', 'abi'], encoding: 'binary', managedImport: 'source' },
  { format: 'fastq', extensions: ['fastq', 'fq'], encoding: 'text', managedImport: 'source' },
] as const satisfies readonly {
  format: SequenceFormat;
  extensions: readonly string[];
  encoding: 'text' | 'binary';
  managedImport: 'genbank' | 'nucleotide-fasta' | 'snapgene' | 'source';
}[];

export type SequenceFileType = (typeof SEQUENCE_FILE_TYPES)[number];
export const SEQUENCE_FILE_EXTENSIONS: readonly string[] = SEQUENCE_FILE_TYPES.flatMap((type) => [
  ...type.extensions,
]);
export const MANAGED_DNA_FILE_EXTENSIONS: readonly string[] = SEQUENCE_FILE_TYPES.filter(
  (type) => type.managedImport !== 'source'
).flatMap((type) => [...type.extensions]);

export function sequenceFileTypeForPath(path: string): SequenceFileType | null {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return (
    SEQUENCE_FILE_TYPES.find((type) =>
      (type.extensions as readonly string[]).includes(extension)
    ) ?? null
  );
}

export function isBinarySequenceFilePath(path: string): boolean {
  return sequenceFileTypeForPath(path)?.encoding === 'binary';
}
