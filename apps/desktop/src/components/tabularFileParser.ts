import * as XLSX from 'xlsx';
import {
  parseTabularPreview,
  type TabularParseFailure,
  type TabularPreview,
} from '../shared/tabular-file';
export * from '../shared/tabular-file';

type WorkbookPreview = TabularPreview | (TabularParseFailure & { passwordProtected?: true });

export function parseXlsxPreview(
  data: ArrayBuffer | Uint8Array,
  options: { maxRows: number }
): WorkbookPreview {
  let csv: string;
  try {
    const workbook = XLSX.read(data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { ok: false, error: 'The spreadsheet has no sheets.' };
    csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const passwordProtected =
      detail === 'File is password-protected' || detail.startsWith('File is password-protected:');
    return {
      ok: false,
      error: `Could not read the spreadsheet: ${detail}`,
      ...(passwordProtected ? { passwordProtected: true } : {}),
    };
  }
  return parseTabularPreview(csv, { delimiter: ',', maxRows: options.maxRows });
}
