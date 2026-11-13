import { SEQUENCE_FILE_TYPES } from '@waypoint/sequence-utils/sequence-file-types';

export const DEFAULT_SHARE_BUNDLE_LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  maxBundleBytes: 256 * 1024 * 1024,
  maxFiles: 2000,
} as const;

export type ShareBundleLimits = {
  maxFileBytes: number;
  maxBundleBytes: number;
  maxFiles: number;
};

const PRIVATE_RAW_EXTENSIONS = new Set([
  ...SEQUENCE_FILE_TYPES.filter((type) => type.format === 'ab1' || type.format === 'fastq').flatMap(
    (type) => type.extensions.map((extension) => `.${extension}`)
  ),
  '.bai',
  '.bam',
  '.bcf',
  '.bigwig',
  '.bw',
  '.cram',
  '.crai',
  '.gzi',
  '.h5',
  '.hdf5',
  '.sam',
  '.tbi',
  '.vcf',
]);
const COMPRESSION_EXTENSIONS = new Set([
  '.gz',
  '.gzip',
  '.bgz',
  '.bgzf',
  '.bz2',
  '.bzip2',
  '.xz',
  '.lzma',
  '.zst',
  '.zstd',
  '.zip',
  '.z',
]);
const REFERENCE_POINTER_EXTENSIONS = new Set(['.fai', '.gff', '.gff3', '.gtf']);

export function workspaceSyncSensitivePathExclusion(
  path: string
): 'private-raw-data' | 'reference-pointer' | null {
  let leaf = path.replace(/\\/g, '/').toLowerCase().split('/').pop() ?? '';
  let extension = '';
  while (leaf.length > 0) {
    const dot = leaf.lastIndexOf('.');
    extension = dot < 0 ? '' : leaf.slice(dot);
    if (!COMPRESSION_EXTENSIONS.has(extension)) break;
    leaf = leaf.slice(0, dot);
  }
  if (PRIVATE_RAW_EXTENSIONS.has(extension)) return 'private-raw-data';
  if (REFERENCE_POINTER_EXTENSIONS.has(extension)) return 'reference-pointer';
  return null;
}

export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:/.test(trimmed)) {
    return false;
  }
  const parts = trimmed.split('\\').join('/').split('/');
  return parts.every((part: string) => part !== '' && part !== '.' && part !== '..');
}
