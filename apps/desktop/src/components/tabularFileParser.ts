import * as XLSX from 'xlsx';
import { parseTabularPreview, type TabularParseResult } from '../shared/tabular-file';
export * from '../shared/tabular-file';

export function parseXlsxPreview(
  data: ArrayBuffer | Uint8Array,
  options: { maxRows: number }
): TabularParseResult {
  let csv: string;
  try {
    const workbook = XLSX.read(data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { ok: false, error: 'The spreadsheet has no sheets.' };
    csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
  } catch (err) {
    return {
      ok: false,
      error: `Could not read the spreadsheet: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseTabularPreview(csv, { delimiter: ',', maxRows: options.maxRows });
}
