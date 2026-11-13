import type { Primer } from '../types';
import { calculateTm, calculateGC, generatePrimerId } from '../utils/primer-calculations';

export class PrimerParseError extends Error {
  constructor(
    message: string,
    public row?: number
  ) {
    super(row ? `Row ${row}: ${message}` : message);
    this.name = 'PrimerParseError';
  }
}

const COLUMN_PATTERNS = {
  name: [
    'name',
    'primer',
    'primer_name',
    'primername',
    'primer name',
    'id',
    'primer_id',
    'primerid',
    'primer id',
    'oligo',
    'oligo_name',
    'oligoname',
    'oligo name',
    'label',
  ],
  sequence: [
    'sequence',
    'seq',
    'primer_sequence',
    'primersequence',
    'primer sequence',
    'oligo_sequence',
    'oligosequence',
    'oligo sequence',
    'bases',
    'nucleotide',
    'nucleotides',
    'dna',
    'dna_sequence',
  ],
  description: [
    'description',
    'desc',
    'notes',
    'note',
    'purpose',
    'comment',
    'comments',
    'info',
    'details',
    'target',
    'target_gene',
  ],
  tm: [
    'tm',
    'melting',
    'melting_temp',
    'meltingtemp',
    'melting temp',
    'melting temperature',
    't_m',
  ],
  direction: ['direction', 'dir', 'orientation', 'strand', 'sense', 'fwd_rev', 'fwd/rev', 'f/r'],
  gc: ['gc', 'gc_content', 'gccontent', 'gc content', 'gc%', '%gc'],
};

export interface ColumnMapping {
  name: number | null;
  sequence: number | null;
  description: number | null;
  tm: number | null;
  direction: number | null;
  gc: number | null;
}

export interface PrimerParseResult {
  primers: ParsedPrimer[];
  columnMapping: ColumnMapping;
  totalRows: number;
  skippedRows: number;
  errors: Array<{ row: number; message: string }>;
}

export interface ParsedPrimer {
  id: string;
  name: string;
  sequence: string;
  description?: string;
  tm: number;
  gc: number;
  direction?: 'forward' | 'reverse';
  originalRow: number;
}

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/[_\-\s]+/g, ' ');
}

export function detectColumnMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    name: null,
    sequence: null,
    description: null,
    tm: null,
    direction: null,
    gc: null,
  };

  const normalizedHeaders = headers.map(normalizeHeader);

  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    for (let i = 0; i < normalizedHeaders.length; i++) {
      const header = normalizedHeaders[i];

      if (patterns.includes(header)) {
        mapping[field as keyof ColumnMapping] = i;
        break;
      }

      const partialMatch = patterns.find((p) => header.includes(p) || p.includes(header));
      if (partialMatch && mapping[field as keyof ColumnMapping] === null) {
        mapping[field as keyof ColumnMapping] = i;
      }
    }
  }

  return mapping;
}

function validateSequence(seq: string): string | null {
  if (!seq || typeof seq !== 'string') return null;

  const cleaned = seq.replace(/[\s\-.]/g, '');

  if (cleaned.length === 0) return null;

  if (!/^[ACGTURYSWKMBDHVN]+$/i.test(cleaned)) {
    return null;
  }

  return cleaned;
}

function parseDirection(dir: string): 'forward' | 'reverse' | undefined {
  if (!dir || typeof dir !== 'string') return undefined;

  const normalized = dir.toLowerCase().trim();

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

export function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    const row: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    row.push(current.trim());
    rows.push(row);
  }

  return rows;
}

export function parseTSV(content: string): string[][] {
  const rows: string[][] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;
    rows.push(line.split('\t').map((cell) => cell.trim()));
  }

  return rows;
}

export function detectDelimiter(content: string): 'csv' | 'tsv' {
  const firstLine = content.split(/\r?\n/)[0] || '';
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;

  return tabCount > commaCount ? 'tsv' : 'csv';
}

export function parsePrimerTabular(
  content: string,
  options: { delimiter?: 'csv' | 'tsv' | 'auto'; hasHeader?: boolean } = {}
): PrimerParseResult {
  const { delimiter = 'auto', hasHeader = true } = options;

  const detectedDelimiter = delimiter === 'auto' ? detectDelimiter(content) : delimiter;
  const rows = detectedDelimiter === 'tsv' ? parseTSV(content) : parseCSV(content);

  if (rows.length === 0) {
    throw new PrimerParseError('No data found in file');
  }

  const headers = hasHeader ? rows[0] : [];
  const columnMapping = hasHeader
    ? detectColumnMapping(headers)
    : {
        name: 0,
        sequence: 1,
        description: null,
        tm: null,
        direction: null,
        gc: null,
      };

  const sequenceColumn = columnMapping.sequence;
  if (sequenceColumn === null) {
    throw new PrimerParseError(
      'Could not detect sequence column. Expected headers like: sequence, seq, bases'
    );
  }

  const primers: ParsedPrimer[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  let skippedRows = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNumber = hasHeader ? i + 2 : i + 1;

    if (row.every((cell) => !cell || !cell.trim())) {
      skippedRows++;
      continue;
    }

    const rawSequence = row[sequenceColumn];
    const sequence = validateSequence(rawSequence);

    if (!sequence) {
      errors.push({
        row: rowNumber,
        message: `Invalid or empty sequence: "${rawSequence?.substring(0, 20)}..."`,
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

  if (primers.length === 0) {
    throw new PrimerParseError(
      `No valid primers found. ${errors.length} rows had errors.` +
        (errors.length > 0 ? ` First error: Row ${errors[0].row}: ${errors[0].message}` : '')
    );
  }

  return {
    primers,
    columnMapping,
    totalRows: dataRows.length,
    skippedRows,
    errors,
  };
}

export function toPlasmidPrimers(parsed: ParsedPrimer[]): Primer[] {
  return parsed.map((p) => ({
    id: p.id,
    name: p.name,
    start: 0,
    end: p.sequence.length,
    direction: p.direction || 'forward',
    bases: p.sequence,
    tm: p.tm,
    gc: p.gc,
    mismatches: [],
    hasExplicitSequence: true,
  }));
}

export function isPrimerTabular(content: string): boolean {
  const delimiter = detectDelimiter(content);
  const rows = delimiter === 'tsv' ? parseTSV(content) : parseCSV(content);

  if (rows.length < 2) return false;

  const mapping = detectColumnMapping(rows[0]);

  return mapping.sequence !== null;
}

export interface TabularPreviewData {
  headers: string[];
  rows: string[][];
  autoMapping: {
    name: number | null;
    sequence: number | null;
    direction: number | null;
  };
  hasDetectedHeaders: boolean;
}

function looksLikeHeaderRow(row: string[]): boolean {
  const mapping = detectColumnMapping(row);
  return mapping.sequence !== null;
}

function looksLikeDnaSequence(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const cleaned = value.replace(/[\s\-.]/g, '');
  return cleaned.length >= 10 && /^[ACGTURYSWKMBDHVN]+$/i.test(cleaned);
}

export function extractTabularPreview(
  content: string,
  options: { delimiter?: 'csv' | 'tsv' | 'auto' } = {}
): TabularPreviewData {
  const { delimiter = 'auto' } = options;

  const detectedDelimiter = delimiter === 'auto' ? detectDelimiter(content) : delimiter;
  const rows = detectedDelimiter === 'tsv' ? parseTSV(content) : parseCSV(content);

  if (rows.length === 0) {
    throw new PrimerParseError('No data found in file');
  }

  const firstRow = rows[0];

  const hasHeaders = looksLikeHeaderRow(firstRow) && !firstRow.some(looksLikeDnaSequence);

  let headers: string[];
  let dataRows: string[][];
  let mapping: ColumnMapping;

  if (hasHeaders) {
    headers = firstRow;
    dataRows = rows.slice(1);
    mapping = detectColumnMapping(headers);
  } else {
    headers = firstRow.map((_, i) => `Column ${String.fromCharCode(65 + i)}`);
    dataRows = rows;
    mapping = {
      name: 0,
      sequence: 1,
      description: firstRow.length > 2 ? 2 : null,
      tm: null,
      direction: null,
      gc: null,
    };
  }

  return {
    headers,
    rows: dataRows,
    autoMapping: {
      name: mapping.name,
      sequence: mapping.sequence,
      direction: mapping.direction,
    },
    hasDetectedHeaders: hasHeaders,
  };
}

export interface CustomColumnMapping {
  nameColumn: number;
  sequenceColumn: number;
  directionColumn?: number | null;
  customColumns: Record<number, string>;
}

export interface ParsedPrimerWithMetadata extends ParsedPrimer {
  metadata: Record<string, string>;
}

export interface PrimerParseResultWithMetadata {
  primers: ParsedPrimerWithMetadata[];
  totalRows: number;
  skippedRows: number;
  errors: Array<{ row: number; message: string }>;
}

export function parsePrimersWithMapping(
  headers: string[],
  rows: string[][],
  mapping: CustomColumnMapping
): PrimerParseResultWithMetadata {
  const primers: ParsedPrimerWithMetadata[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  let skippedRows = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2;

    if (row.every((cell) => !cell || !cell.trim())) {
      skippedRows++;
      continue;
    }

    const rawSequence = row[mapping.sequenceColumn];
    const sequence = validateSequence(rawSequence);

    if (!sequence) {
      errors.push({
        row: rowNumber,
        message: `Invalid or empty sequence: "${rawSequence?.substring(0, 20)}..."`,
      });
      skippedRows++;
      continue;
    }

    let name = row[mapping.nameColumn]?.trim();
    if (!name) {
      name = `Primer_${primers.length + 1}`;
    }

    const tm = calculateTm(sequence);
    const gc = calculateGC(sequence);

    const direction =
      mapping.directionColumn != null ? parseDirection(row[mapping.directionColumn]) : undefined;

    const metadata: Record<string, string> = {};
    for (const [colIndexStr, metadataKey] of Object.entries(mapping.customColumns)) {
      const colIndex = parseInt(colIndexStr, 10);
      const value = row[colIndex]?.trim();
      if (value) {
        metadata[metadataKey] = value;
      }
    }

    primers.push({
      id: generatePrimerId(),
      name,
      sequence,
      tm,
      gc,
      direction,
      originalRow: rowNumber,
      metadata,
    });
  }

  if (primers.length === 0) {
    throw new PrimerParseError(
      `No valid primers found. ${errors.length} rows had errors.` +
        (errors.length > 0 ? ` First error: Row ${errors[0].row}: ${errors[0].message}` : '')
    );
  }

  return {
    primers,
    totalRows: rows.length,
    skippedRows,
    errors,
  };
}
