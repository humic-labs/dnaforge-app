import * as XLSX from 'xlsx';
import type { SheetDisposition, SheetVerdict } from '../lims';

export interface WorkbookTriage {
  sheetsTotal: number;
  sheets: SheetDisposition[];
  entitySheetNames: string[];
}

const ENTITY_HEADER_TOKENS: ReadonlySet<string> = new Set([
  'strain',
  'genotype',
  'organism',
  'species',
  'plasmid',
  'oligo',
  'oligos',
  'primer',
  'primers',
  'sequence',
  'seq',
  'name',
  'marker',
  'resistance',
  'well',
  'construct',
  'reagent',
  'backbone',
  'insert',
]);

const SHEET_NAME_ENTITY_HINT = /strain|plasmid|primer|oligo|construct|reagent/i;
const METADATA_NAME = /readme|notes|legend|toc|index|metadata|about/i;

const MIN_ENTITY_ROWS = 3;
const DENSITY_MIN = 0.4;
const LONG_TEXT_LEN = 40;
const DNA_MIN_LEN = 8;
const DNA_CELL = /^[ACGTURYKMSWBDHVN]+$/i;

function normalizeCell(raw: string): string {
  return raw.replace(/^\ufeff/, '').trim();
}

export function boundedSheetRange(
  sheet: XLSX.WorkSheet | undefined,
  opts: { maxRows: number; maxCols: number }
): { range: string | undefined; clippedRows: number; clippedCols: number } {
  const ref = sheet?.['!ref'];
  if (!ref) return { range: undefined, clippedRows: 0, clippedCols: 0 };
  let decoded: XLSX.Range;
  try {
    decoded = XLSX.utils.decode_range(ref);
  } catch {
    return { range: undefined, clippedRows: 0, clippedCols: 0 };
  }
  const boundedEndRow = Math.min(decoded.e.r, decoded.s.r + opts.maxRows - 1);
  const boundedEndCol = Math.min(decoded.e.c, decoded.s.c + opts.maxCols - 1);
  const clippedRows = Math.max(0, decoded.e.r - boundedEndRow);
  const clippedCols = Math.max(0, decoded.e.c - boundedEndCol);
  if (clippedRows === 0 && clippedCols === 0) {
    return { range: undefined, clippedRows: 0, clippedCols: 0 };
  }
  return {
    range: XLSX.utils.encode_range({ s: decoded.s, e: { r: boundedEndRow, c: boundedEndCol } }),
    clippedRows,
    clippedCols,
  };
}

const TRIAGE_MAX_ROWS = 400;
const TRIAGE_MAX_COLS = 256;

function readSheetMatrix(sheet: XLSX.WorkSheet): string[][] {
  const { range } = boundedSheetRange(sheet, {
    maxRows: TRIAGE_MAX_ROWS,
    maxCols: TRIAGE_MAX_COLS,
  });
  const raw = XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(sheet, {
    header: 1,
    defval: '',
    raw: false,
    ...(range ? { range } : {}),
  });
  return raw.map((row) => row.map((cell) => normalizeCell(String(cell ?? ''))));
}

function countPopulated(row: string[]): number {
  return row.reduce((n, cell) => (cell !== '' ? n + 1 : n), 0);
}

function isDnaSequence(cell: string): boolean {
  const s = cell.replace(/\s/g, '');
  return s.length >= DNA_MIN_LEN && DNA_CELL.test(s);
}

function cellHasEntityToken(cell: string): boolean {
  return cell
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((token) => token.length > 0 && ENTITY_HEADER_TOKENS.has(token));
}

interface SheetMetrics {
  populatedCellCount: number;
  width: number;
  colPopulated: number[];
  headerRowIndex: number | undefined;
  headerless: boolean;
  dataRowCount: number;
  entityTokenCount: number;
  hasSequenceColumn: boolean;
  hasLongTextCell: boolean;
  density: number;
  interiorSeparator: boolean;
  nameHint: boolean;
}

function computeMetrics(matrix: string[][], sheetName: string): SheetMetrics {
  let populatedCellCount = 0;
  let width = 0;
  let hasLongTextCell = false;
  for (const row of matrix) {
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (cell !== '') {
        populatedCellCount += 1;
        if (c + 1 > width) width = c + 1;
        if (cell.length >= LONG_TEXT_LEN) hasLongTextCell = true;
      }
    }
  }

  const colPopulated = new Array<number>(width).fill(0);
  for (const row of matrix) {
    for (let c = 0; c < width; c += 1) {
      if ((row[c] ?? '') !== '') colPopulated[c] += 1;
    }
  }

  let headerRowIndex: number | undefined;
  for (let i = 0; i < matrix.length; i += 1) {
    if (countPopulated(matrix[i]) >= 2) {
      headerRowIndex = i;
      break;
    }
  }

  const headerless =
    headerRowIndex !== undefined && matrix[headerRowIndex].some((cell) => isDnaSequence(cell));

  const dataStartIndex =
    headerRowIndex === undefined ? 0 : headerless ? headerRowIndex : headerRowIndex + 1;
  const dataRows = matrix.slice(dataStartIndex).filter((row) => row.some((cell) => cell !== ''));
  const dataRowCount = dataRows.length;

  const entityTokenCount =
    headerRowIndex !== undefined && !headerless
      ? countPopulated(matrix[headerRowIndex]) === 0
        ? 0
        : matrix[headerRowIndex].filter((cell) => cell !== '' && cellHasEntityToken(cell)).length
      : 0;

  let hasSequenceColumn = false;
  let populatedDataCells = 0;
  for (let c = 0; c < width; c += 1) {
    const colCells = dataRows.map((row) => row[c] ?? '').filter((cell) => cell !== '');
    populatedDataCells += colCells.length;
    if (colCells.length >= 2) {
      const dnaCount = colCells.filter((cell) => isDnaSequence(cell)).length;
      if (dnaCount / colCells.length >= 0.6) hasSequenceColumn = true;
    }
  }

  const density = dataRowCount > 0 && width > 0 ? populatedDataCells / (dataRowCount * width) : 0;

  let interiorSeparator = false;
  if (width >= 3) {
    for (let c = 1; c <= width - 2; c += 1) {
      if (colPopulated[c] !== 0) continue;
      const leftHasData = colPopulated.slice(0, c).some((n) => n > 0);
      const rightHasData = colPopulated.slice(c + 1).some((n) => n > 0);
      if (leftHasData && rightHasData) {
        interiorSeparator = true;
        break;
      }
    }
  }

  return {
    populatedCellCount,
    width,
    colPopulated,
    headerRowIndex,
    headerless,
    dataRowCount,
    entityTokenCount,
    hasSequenceColumn,
    hasLongTextCell,
    density,
    interiorSeparator,
    nameHint: SHEET_NAME_ENTITY_HINT.test(sheetName),
  };
}

function scoreSheet(m: SheetMetrics): number {
  let score = 0;
  score += m.entityTokenCount * 2;
  score += m.hasSequenceColumn ? 3 : 0;
  score += m.width >= 2 ? 1 : 0;
  score += Math.min(m.dataRowCount, 10) * 0.3;
  score += m.nameHint ? 1 : 0;
  return Math.round(score * 100) / 100;
}

function classify(m: SheetMetrics, sheetName: string): { verdict: SheetVerdict; reason: string } {
  if (m.populatedCellCount === 0) {
    return { verdict: 'empty', reason: 'No populated cells.' };
  }

  const metadataByStructure =
    m.width <= 2 && m.entityTokenCount === 0 && !m.hasSequenceColumn && m.hasLongTextCell;
  if (METADATA_NAME.test(sheetName) || metadataByStructure) {
    return {
      verdict: 'metadata-notes',
      reason: METADATA_NAME.test(sheetName)
        ? 'Sheet name reads as README/legend/notes.'
        : 'Narrow key:value / prose block, not an entity table.',
    };
  }

  if (m.interiorSeparator) {
    return {
      verdict: 'leftover-region',
      reason: 'Fully-empty separator column with data on both sides (side-by-side layout).',
    };
  }

  const hasEntitySignal = m.entityTokenCount >= 1 || m.hasSequenceColumn;
  if (
    m.dataRowCount >= MIN_ENTITY_ROWS &&
    m.width >= 2 &&
    hasEntitySignal &&
    m.density >= DENSITY_MIN
  ) {
    return {
      verdict: 'entity-table',
      reason: m.headerless
        ? 'Headerless data grid of names/sequences.'
        : `Plausible header (${m.entityTokenCount} entity token(s)) over ${m.dataRowCount} data rows.`,
    };
  }

  if (hasEntitySignal || (m.dataRowCount >= 2 && m.width >= 2)) {
    return {
      verdict: 'possible-table',
      reason: 'Tabular-ish but low confidence — surfaced so the user can still pick it.',
    };
  }

  return { verdict: 'low-density', reason: 'Too sparse to be a table.' };
}

function triageSheet(sheetName: string, sheet: XLSX.WorkSheet | undefined): SheetDisposition {
  const matrix = sheet ? readSheetMatrix(sheet) : [];
  const metrics = computeMetrics(matrix, sheetName);
  const { verdict, reason } = classify(metrics, sheetName);

  const disposition: SheetDisposition = {
    sheetName,
    verdict,
    score: scoreSheet(metrics),
    rowCount: metrics.dataRowCount,
    reason,
  };
  if (
    metrics.headerRowIndex !== undefined &&
    !metrics.headerless &&
    (verdict === 'entity-table' || verdict === 'possible-table')
  ) {
    disposition.headerRowIndex = metrics.headerRowIndex;
  }
  return disposition;
}

export function triageWorkbook(workbook: XLSX.WorkBook): WorkbookTriage {
  const sheets = workbook.SheetNames.map((name) => triageSheet(name, workbook.Sheets[name]));
  return {
    sheetsTotal: workbook.SheetNames.length,
    sheets,
    entitySheetNames: sheets.filter((s) => s.verdict === 'entity-table').map((s) => s.sheetName),
  };
}
