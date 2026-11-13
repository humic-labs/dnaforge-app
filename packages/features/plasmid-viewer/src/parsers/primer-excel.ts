import {
  detectColumnMapping,
  type ColumnMapping,
  type PrimerParseResult,
  type ParsedPrimer,
} from './primer-tabular';
import { calculateTm, calculateGC, generatePrimerId } from '../utils/primer-calculations';

export class ExcelParseError extends Error {
  constructor(
    message: string,
    public sheet?: string,
    public row?: number
  ) {
    const location = [sheet, row ? `row ${row}` : null].filter(Boolean).join(', ');
    super(location ? `${location}: ${message}` : message);
    this.name = 'ExcelParseError';
  }
}

export interface ExcelPrimerParseResult extends PrimerParseResult {
  sheetsProcessed: string[];
}

function validateSequence(seq: unknown): string | null {
  if (!seq || typeof seq !== 'string') return null;

  const cleaned = String(seq).replace(/[\s\-.]/g, '');

  if (cleaned.length === 0) return null;

  if (!/^[ACGTURYSWKMBDHVN]+$/i.test(cleaned)) {
    return null;
  }

  return cleaned;
}

function parseDirection(dir: unknown): 'forward' | 'reverse' | undefined {
  if (!dir || typeof dir !== 'string') return undefined;

  const normalized = String(dir).toLowerCase().trim();

  if (
    normalized === 'f' ||
    normalized === 'fwd' ||
    normalized === 'forward' ||
    normalized === '+' ||
    normalized === 'sense' ||
    normalized === '5'
  ) {
    return 'forward';
  }

  if (
    normalized === 'r' ||
    normalized === 'rev' ||
    normalized === 'reverse' ||
    normalized === '-' ||
    normalized === 'antisense' ||
    normalized === '3'
  ) {
    return 'reverse';
  }

  return undefined;
}

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell.trim();
  if (typeof cell === 'number') return String(cell);
  return String(cell).trim();
}

interface WorkSheet {
  [key: string]: unknown;
}

interface XlsxModule {
  read: (
    data: ArrayBuffer,
    opts: { type: 'array' }
  ) => {
    SheetNames: string[];
    Sheets: Record<string, WorkSheet>;
  };
  utils: {
    sheet_to_json: (
      sheet: WorkSheet,
      opts?: { header?: number; defval?: string; blankrows?: boolean }
    ) => unknown[][];
  };
}

function parseSheet(
  sheet: WorkSheet,
  sheetName: string,
  xlsxUtils: {
    sheet_to_json: (
      sheet: WorkSheet,
      opts?: { header?: number; defval?: string; blankrows?: boolean }
    ) => unknown[][];
  }
): {
  primers: ParsedPrimer[];
  columnMapping: ColumnMapping;
  totalRows: number;
  skippedRows: number;
  errors: Array<{ row: number; message: string }>;
} {
  const rows: string[][] = xlsxUtils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
  }) as string[][];

  if (rows.length < 2) {
    return {
      primers: [],
      columnMapping: {
        name: null,
        sequence: null,
        description: null,
        tm: null,
        direction: null,
        gc: null,
      },
      totalRows: 0,
      skippedRows: 0,
      errors: [],
    };
  }

  const stringRows = rows.map((row) => row.map(cellToString));

  const headers = stringRows[0];
  const columnMapping = detectColumnMapping(headers);

  const sequenceColumn = columnMapping.sequence;
  if (sequenceColumn === null) {
    return {
      primers: [],
      columnMapping,
      totalRows: rows.length - 1,
      skippedRows: rows.length - 1,
      errors: [
        {
          row: 1,
          message: `Sheet "${sheetName}": Could not detect sequence column`,
        },
      ],
    };
  }

  const primers: ParsedPrimer[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  const dataRows = stringRows.slice(1);
  let skippedRows = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNumber = i + 2;

    if (row.every((cell) => !cell || !cell.trim())) {
      skippedRows++;
      continue;
    }

    const rawSequence = row[sequenceColumn];
    const sequence = validateSequence(rawSequence);

    if (!sequence) {
      errors.push({
        row: rowNumber,
        message: `Invalid or empty sequence: "${String(rawSequence).substring(0, 20)}..."`,
      });
      skippedRows++;
      continue;
    }

    let name = columnMapping.name !== null ? row[columnMapping.name]?.trim() : undefined;
    if (!name) {
      name = `Primer_${primers.length + 1}`;
    }

    const description =
      columnMapping.description !== null ? row[columnMapping.description]?.trim() : undefined;

    let tm: number;
    if (columnMapping.tm !== null && row[columnMapping.tm]) {
      tm = parseFloat(row[columnMapping.tm]);
      if (isNaN(tm)) {
        tm = calculateTm(sequence);
      }
    } else {
      tm = calculateTm(sequence);
    }

    let gc: number;
    if (columnMapping.gc !== null && row[columnMapping.gc]) {
      gc = parseFloat(row[columnMapping.gc]);
      if (isNaN(gc)) {
        gc = calculateGC(sequence);
      }
    } else {
      gc = calculateGC(sequence);
    }

    const direction =
      columnMapping.direction !== null ? parseDirection(row[columnMapping.direction]) : undefined;

    primers.push({
      id: generatePrimerId(),
      name,
      sequence,
      description: description || undefined,
      tm,
      gc,
      direction,
      originalRow: rowNumber,
    });
  }

  return {
    primers,
    columnMapping,
    totalRows: dataRows.length,
    skippedRows,
    errors,
  };
}

export async function parsePrimerExcel(data: ArrayBuffer): Promise<ExcelPrimerParseResult> {
  let XLSX: XlsxModule;
  try {
    XLSX = (await import('xlsx')) as XlsxModule;
  } catch (err) {
    throw new ExcelParseError(
      'Excel parsing requires the xlsx library. Install it with: npm install xlsx',
      undefined,
      undefined
    );
  }

  const workbook = XLSX.read(data, { type: 'array' });

  const allPrimers: ParsedPrimer[] = [];
  const allErrors: Array<{ row: number; message: string }> = [];
  let totalRows = 0;
  let skippedRows = 0;
  let lastColumnMapping: ColumnMapping = {
    name: null,
    sequence: null,
    description: null,
    tm: null,
    direction: null,
    gc: null,
  };
  const sheetsProcessed: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const result = parseSheet(sheet, sheetName, XLSX.utils);

    if (result.primers.length > 0 || result.errors.length > 0) {
      sheetsProcessed.push(sheetName);
      allPrimers.push(...result.primers);
      allErrors.push(
        ...result.errors.map((e) => ({
          row: e.row,
          message: `[${sheetName}] ${e.message}`,
        }))
      );
      totalRows += result.totalRows;
      skippedRows += result.skippedRows;
      lastColumnMapping = result.columnMapping;
    }
  }

  if (allPrimers.length === 0 && sheetsProcessed.length === 0) {
    throw new ExcelParseError(
      'No valid primer data found in any sheet. Expected headers like: Name, Sequence'
    );
  }

  return {
    primers: allPrimers,
    columnMapping: lastColumnMapping,
    totalRows,
    skippedRows,
    errors: allErrors,
    sheetsProcessed,
  };
}

export function isExcelFile(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false;

  const view = new Uint8Array(data);

  if (view[0] === 0x50 && view[1] === 0x4b && view[2] === 0x03 && view[3] === 0x04) {
    return true;
  }

  if (view[0] === 0xd0 && view[1] === 0xcf && view[2] === 0x11 && view[3] === 0xe0) {
    return true;
  }

  return false;
}

export interface ExcelPreviewData {
  headers: string[];
  rows: string[][];
  autoMapping: {
    name: number | null;
    sequence: number | null;
    direction: number | null;
  };
  sheetName: string;
}

export async function extractExcelPreview(data: ArrayBuffer): Promise<ExcelPreviewData> {
  const XLSX = await import('xlsx');

  const workbook = XLSX.read(data, { type: 'array' });

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];

    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
    });

    if (rows.length < 2) continue;

    const stringRows = rows.map((row) => row.map(cellToString));
    const headers = stringRows[0];
    const dataRows = stringRows.slice(1);

    const columnMapping = detectColumnMapping(headers);
    if (columnMapping.sequence === null) continue;

    return {
      headers,
      rows: dataRows,
      autoMapping: {
        name: columnMapping.name,
        sequence: columnMapping.sequence,
        direction: columnMapping.direction,
      },
      sheetName,
    };
  }

  throw new ExcelParseError(
    'No valid primer data found in any sheet. Expected headers like: Name, Sequence'
  );
}
