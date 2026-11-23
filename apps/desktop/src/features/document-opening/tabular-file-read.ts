import { platform } from '../../platform';
import { getExtension } from '../../utils/fileTypes';
import { waitForFileDocumentSaves } from '../workspace/public/file-document-draft';
import {
  parseTabularPreview,
  parseXlsxPreview,
  type TabularDelimiter,
} from '../../components/tabularFileParser';

const MAX_TABULAR_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TABULAR_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_PREVIEW_ROWS = 1000;

export function delimiterForPath(path: string): {
  delimiter: TabularDelimiter | null;
  label: string;
  isXlsx?: boolean;
} {
  const ext = getExtension(path);
  if (ext === 'csv') return { delimiter: ',', label: 'CSV' };
  if (ext === 'tsv') return { delimiter: '\t', label: 'TSV' };
  if (ext === 'xlsx' || ext === 'xls') return { delimiter: null, label: 'Excel', isXlsx: true };
  return { delimiter: null, label: (ext ?? 'table').toUpperCase() };
}

export async function readWorkbookPreview(path: string, isCurrent = () => true) {
  const { size } = await platform().fs.stat(path);
  if (!isCurrent()) return null;
  const bytes = await platform().fs.readFile(path);
  if (!isCurrent()) return null;
  const parsed = parseXlsxPreview(bytes, { maxRows: MAX_PREVIEW_ROWS });
  return { parsed, size };
}

export async function readDelimitedTablePreview(
  path: string,
  delimiter: TabularDelimiter,
  isCurrent = () => true
) {
  await waitForFileDocumentSaves(path);
  if (!isCurrent()) return null;
  const { size } = await platform().fs.stat(path);
  if (!isCurrent()) return null;
  const slicedPreview = size > MAX_TABULAR_FILE_BYTES;
  const read = slicedPreview
    ? await platform().fs.readTextFileSlice(path, MAX_TABULAR_PREVIEW_BYTES)
    : { text: await platform().fs.readTextFile(path), bytesRead: size };
  if (!isCurrent()) return null;
  const parsed = parseTabularPreview(read.text, {
    delimiter,
    maxRows: MAX_PREVIEW_ROWS,
    inputTruncated: slicedPreview,
  });
  return { ...read, parsed, size, slicedPreview };
}
