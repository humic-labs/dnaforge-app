import type { ImportItem } from '../workspace-loader/public/import-wizard-state';

export type ImportBucket =
  | 'Sequences'
  | 'Reads'
  | 'Tabular'
  | 'Documents'
  | 'Images'
  | 'Multi-record'
  | 'Unsorted';

export const IMPORT_BUCKET_ORDER: ImportBucket[] = [
  'Sequences',
  'Reads',
  'Multi-record',
  'Tabular',
  'Documents',
  'Images',
  'Unsorted',
];

const READS_FORMATS = new Set(['fastq', 'ab1']);
const SEQUENCE_FORMATS = new Set(['fasta', 'genbank', 'gb', 'seq', 'dna', 'embl']);

const TABULAR_EXT = new Set(['csv', 'tsv', 'xlsx', 'xls']);
const DOCUMENT_EXT = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'json']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'bmp', 'svg', 'webp']);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function importBucketFor(
  item: Pick<ImportItem, 'name' | 'kind' | 'format' | 'block'>
): ImportBucket {
  if (item.kind === 'folder') return 'Unsorted';
  if (item.block?.kind === 'multi-record-fasta') return 'Multi-record';

  const fmt = item.format?.toLowerCase();
  if (fmt && READS_FORMATS.has(fmt)) return 'Reads';
  if (fmt && SEQUENCE_FORMATS.has(fmt)) return 'Sequences';

  const ext = extensionOf(item.name);
  if (READS_FORMATS.has(ext)) return 'Reads';
  if (SEQUENCE_FORMATS.has(ext)) return 'Sequences';
  if (TABULAR_EXT.has(ext)) return 'Tabular';
  if (DOCUMENT_EXT.has(ext)) return 'Documents';
  if (IMAGE_EXT.has(ext)) return 'Images';
  return 'Unsorted';
}

export interface ImportBucketGroup {
  bucket: ImportBucket;
  items: ImportItem[];
}

export function groupItemsByBucket(items: ImportItem[]): ImportBucketGroup[] {
  const map = new Map<ImportBucket, ImportItem[]>();
  for (const item of items) {
    const bucket = importBucketFor(item);
    const list = map.get(bucket);
    if (list) list.push(item);
    else map.set(bucket, [item]);
  }
  return IMPORT_BUCKET_ORDER.filter((b) => map.has(b)).map((bucket) => ({
    bucket,
    items: map.get(bucket)!,
  }));
}
