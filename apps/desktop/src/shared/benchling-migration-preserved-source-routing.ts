import type { TabType } from './tab-kind';

export type PreservedMigrationRawSourceTabType = Extract<
  TabType,
  'sequence' | 'image' | 'table' | 'text'
>;

const REVIEWED_SEQUENCE_EXTENSIONS = new Set(['gb', 'gbk', 'gbff', 'genbank', 'ab1', 'abi']);
const REVIEWED_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
]);
const REVIEWED_TABLE_EXTENSIONS = new Set(['csv', 'tsv']);

export function preservedMigrationRawSourceTabType(
  sourceFileName: string
): PreservedMigrationRawSourceTabType {
  const extension = sourceFileName.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  if (REVIEWED_SEQUENCE_EXTENSIONS.has(extension)) return 'sequence';
  if (REVIEWED_IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (REVIEWED_TABLE_EXTENSIONS.has(extension)) return 'table';
  return 'text';
}
