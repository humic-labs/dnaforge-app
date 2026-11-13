export interface HeaderDetection {
  headerRowIndex: number;
  mode: 'detected' | 'synthesized';
  headers: string[];
  titleRowsAbove: number;
  sideBySide?: { primaryCols: [number, number]; leftoverCols: [number, number][] };
}

type CellType = 'empty' | 'dna' | 'well' | 'number' | 'text';

const HEADER_SCAN_ROWS = 10;
const DNA_CELL = /^[ACGTUNRYKMSWBDHV]+$/i;
const WELL_POSITION = /^[A-P](?:0?[1-9]|1[0-9]|2[0-4])$/i;
const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const DOMINANT_FRACTION = 0.6;

function normalizeCell(value: string): string {
  return (value ?? '').replace(/^\ufeff/, '').trim();
}

function looksLikeDnaSequenceCell(value: string): boolean {
  const cleaned = normalizeCell(value).replace(/[\s*]/g, '');
  return cleaned.length >= 10 && DNA_CELL.test(cleaned);
}

function looksLikeWellPosition(value: string): boolean {
  return WELL_POSITION.test(normalizeCell(value));
}

function classifyCell(value: string): CellType {
  const cell = normalizeCell(value);
  if (cell.length === 0) return 'empty';
  if (looksLikeDnaSequenceCell(cell)) return 'dna';
  if (looksLikeWellPosition(cell)) return 'well';
  if (NUMERIC.test(cell)) return 'number';
  return 'text';
}

function normalizeMatrix(matrix: string[][]): string[][] {
  return matrix.map((row) => row.map((cell) => normalizeCell(cell)));
}

function matrixWidth(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

function cellAt(rows: string[][], r: number, c: number): string {
  return rows[r]?.[c] ?? '';
}

function rowCells(rows: string[][], r: number, width: number): string[] {
  const out: string[] = [];
  for (let c = 0; c < width; c++) out.push(cellAt(rows, r, c));
  return out;
}

function populatedCount(rows: string[][], r: number, width: number): number {
  let count = 0;
  for (let c = 0; c < width; c++) {
    if (cellAt(rows, r, c).length > 0) count++;
  }
  return count;
}

function isSparseRow(populated: number, width: number): boolean {
  if (populated < 2) return true;
  return populated / width < 0.5;
}

function firstContentRow(rows: string[][], width: number): number {
  for (let r = 0; r < rows.length; r++) {
    if (populatedCount(rows, r, width) > 0) return r;
  }
  return -1;
}

function dominantColumnType(rows: string[][], fromRow: number, c: number): CellType {
  let dna = 0;
  let well = 0;
  let num = 0;
  let nonEmpty = 0;
  for (let r = fromRow; r < rows.length; r++) {
    const type = classifyCell(cellAt(rows, r, c));
    if (type === 'empty') continue;
    nonEmpty++;
    if (type === 'dna') dna++;
    else if (type === 'well') well++;
    else if (type === 'number') num++;
  }
  if (nonEmpty === 0) return 'empty';
  if (dna / nonEmpty >= DOMINANT_FRACTION) return 'dna';
  if (well / nonEmpty >= DOMINANT_FRACTION) return 'well';
  if (num / nonEmpty >= DOMINANT_FRACTION) return 'number';
  return 'text';
}

function profileDiffersFromBelow(rows: string[][], headerRow: number, width: number): boolean {
  for (let c = 0; c < width; c++) {
    const candidate = classifyCell(cellAt(rows, headerRow, c));
    if (candidate !== 'text') continue;
    const below = dominantColumnType(rows, headerRow + 1, c);
    if (below === 'dna' || below === 'well' || below === 'number') return true;
  }
  return false;
}

function synthesizeHeaders(rows: string[][], firstData: number, width: number): string[] {
  const used = new Set<string>();
  const headers: string[] = [];
  let nameAssigned = false;
  for (let c = 0; c < width; c++) {
    const colType = dominantColumnType(rows, firstData, c);
    let label: string;
    if (colType === 'dna') {
      label = 'Sequence';
    } else if (colType === 'well') {
      label = 'Well';
    } else if (colType === 'text' && !nameAssigned) {
      label = 'Name';
      nameAssigned = true;
    } else {
      label = `Column ${c + 1}`;
    }
    if (used.has(label)) label = `Column ${c + 1}`;
    used.add(label);
    headers.push(label);
  }
  return headers;
}

function findSeparatorColumn(rows: string[][], width: number): number | null {
  for (let c = 1; c < width - 1; c++) {
    let columnEmpty = true;
    for (let r = 0; r < rows.length; r++) {
      if (cellAt(rows, r, c).length > 0) {
        columnEmpty = false;
        break;
      }
    }
    if (!columnEmpty) continue;
    if (hasDataInRange(rows, 0, c - 1) && hasDataInRange(rows, c + 1, width - 1)) {
      return c;
    }
  }
  return null;
}

function hasDataInRange(rows: string[][], startCol: number, endCol: number): boolean {
  for (let r = 0; r < rows.length; r++) {
    for (let c = startCol; c <= endCol; c++) {
      if (cellAt(rows, r, c).length > 0) return true;
    }
  }
  return false;
}

function detectCore(rows: string[][], width: number): HeaderDetection {
  let sawTitleAbove = false;
  const scanLimit = Math.min(rows.length, HEADER_SCAN_ROWS);

  for (let r = 0; r < scanLimit; r++) {
    const populated = populatedCount(rows, r, width);
    if (populated === 0) continue;
    if (isSparseRow(populated, width)) {
      sawTitleAbove = true;
      continue;
    }

    let hasMachineData = false;
    for (let c = 0; c < width; c++) {
      const type = classifyCell(cellAt(rows, r, c));
      if (type === 'dna' || type === 'well' || type === 'number') {
        hasMachineData = true;
        break;
      }
    }
    if (hasMachineData) break;

    if (profileDiffersFromBelow(rows, r, width) || sawTitleAbove) {
      return {
        headerRowIndex: r,
        mode: 'detected',
        headers: rowCells(rows, r, width),
        titleRowsAbove: r,
      };
    }
    break;
  }

  const firstData = firstContentRow(rows, width);
  if (firstData === -1) {
    return { headerRowIndex: 0, mode: 'synthesized', headers: [], titleRowsAbove: 0 };
  }
  return {
    headerRowIndex: firstData,
    mode: 'synthesized',
    headers: synthesizeHeaders(rows, firstData, width),
    titleRowsAbove: firstData,
  };
}

export function detectHeaderRow(
  matrix: string[][],
  opts?: { headerRowOverride?: number }
): HeaderDetection {
  const rows = normalizeMatrix(matrix);
  const width = matrixWidth(rows);

  if (opts?.headerRowOverride != null) {
    const override = opts.headerRowOverride;
    return {
      headerRowIndex: override,
      mode: 'detected',
      headers: rowCells(rows, override, width),
      titleRowsAbove: override,
    };
  }

  const separator = findSeparatorColumn(rows, width);
  if (separator != null) {
    const primary = rows.map((row) => row.slice(0, separator));
    const inner = detectCore(primary, separator);
    return {
      ...inner,
      sideBySide: {
        primaryCols: [0, separator - 1],
        leftoverCols: [[separator + 1, width - 1]],
      },
    };
  }

  return detectCore(rows, width);
}
