import { SEQUENCE_FILE_EXTENSIONS } from '@waypoint/sequence-utils/sequence-file-types';

export const SUPPORTED_SEQUENCE_EXTENSIONS = [...SEQUENCE_FILE_EXTENSIONS, 'gff', 'gff3'] as const;

const SEQUENCE_EXTENSIONS = new Set<string>(SUPPORTED_SEQUENCE_EXTENSIONS);

const SEQUENCE_COMPOUND_GZ_EXTENSIONS = new Set([
  'gff.gz',
  'gff3.gz',
  'fa.gz',
  'fasta.gz',
  'fna.gz',
  'gbff.gz',
]);

const STRUCTURE_FILE_FORMATS = {
  pdb: { parser: 'pdb', encoding: 'text' },
  cif: { parser: 'mmcif', encoding: 'text' },
  mmcif: { parser: 'mmcif', encoding: 'text' },
  mcif: { parser: 'mmcif', encoding: 'text' },
  bcif: { parser: 'mmcif', encoding: 'binary' },
} as const;

export type StructureFileFormat =
  (typeof STRUCTURE_FILE_FORMATS)[keyof typeof STRUCTURE_FILE_FORMATS];

function filename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

function extension(path: string): string | null {
  const name = filename(path);
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0 || lastDot === name.length - 1) return null;
  return name.slice(lastDot + 1).toLowerCase();
}

export function isSupportedSequencePath(path: string): boolean {
  const lowerName = filename(path).toLowerCase();
  for (const compoundExtension of SEQUENCE_COMPOUND_GZ_EXTENSIONS) {
    if (lowerName.endsWith(`.${compoundExtension}`)) return true;
  }
  const ext = extension(path);
  return ext !== null && SEQUENCE_EXTENSIONS.has(ext);
}

export function getStructureFileFormat(path: string): StructureFileFormat | null {
  const ext = extension(path);
  if (!ext || !(ext in STRUCTURE_FILE_FORMATS)) return null;
  return STRUCTURE_FILE_FORMATS[ext as keyof typeof STRUCTURE_FILE_FORMATS];
}
