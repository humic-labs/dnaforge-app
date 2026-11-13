import { parseDelimitedRows } from './delimited-rows';
export { parseDelimitedRows } from './delimited-rows';

export type TabularDelimiter = ',' | '\t';

export interface TabularPreview {
  ok: true;
  headers: string[];
  rows: string[][];
  sourceRows: string[][];
  totalRows: number;
  totalSourceRows: number;
  totalColumns: number;
  truncated: boolean;
  hasHeader: boolean;
}

export interface TabularParseFailure {
  ok: false;
  error: string;
}

export type TabularParseResult = TabularPreview | TabularParseFailure;

interface ParseOptions {
  delimiter: TabularDelimiter;
  maxRows: number;
  inputTruncated?: boolean;
}

export function parseTabularPreview(text: string, options: ParseOptions): TabularParseResult {
  const parsed = parseDelimitedRows(
    text.startsWith('\uFEFF') ? text.slice(1) : text,
    options.delimiter
  );
  if (!parsed.ok) return parsed;

  const completeRows =
    options.inputTruncated && !text.endsWith('\n') && !text.endsWith('\r')
      ? parsed.rows.slice(0, -1)
      : parsed.rows;
  const normalizedRows = completeRows.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (normalizedRows.length === 0) {
    return { ok: false, error: 'No table rows were found.' };
  }

  const totalColumns = Math.max(...normalizedRows.map((row) => row.length));
  if (totalColumns < 2) {
    return { ok: false, error: 'Expected at least two columns.' };
  }

  const paddedRows = normalizedRows.map((row) => padRow(row, totalColumns));
  const hasHeader = inferHeaderRow(paddedRows);
  const headers = hasHeader
    ? paddedRows[0].map((cell, index) => cell.trim() || columnLabel(index))
    : Array.from({ length: totalColumns }, (_, index) => columnLabel(index));
  const dataRows = hasHeader ? paddedRows.slice(1) : paddedRows;
  const previewRows = dataRows.slice(0, Math.max(0, options.maxRows));
  const sourcePreviewRows = paddedRows.slice(
    0,
    hasHeader ? previewRows.length + 1 : previewRows.length
  );

  return {
    ok: true,
    headers,
    rows: previewRows,
    sourceRows: sourcePreviewRows,
    totalRows: dataRows.length,
    totalSourceRows: paddedRows.length,
    totalColumns,
    truncated: options.inputTruncated === true || dataRows.length > previewRows.length,
    hasHeader,
  };
}

export function serializeDelimitedRows(
  rows: string[][],
  delimiter: TabularDelimiter,
  sourceText?: string
): string {
  const lineEnding = sourceText?.includes('\r\n') ? '\r\n' : '\n';
  const body = rows
    .map((row) => row.map((cell) => serializeField(cell, delimiter)).join(delimiter))
    .join(lineEnding);
  return (
    (sourceText?.startsWith('\uFEFF') ? '\uFEFF' : '') +
    body +
    (sourceText && /[\r\n]$/.test(sourceText) ? lineEnding : '')
  );
}

function padRow(row: string[], totalColumns: number): string[] {
  if (row.length >= totalColumns) return row;
  return [...row, ...Array.from({ length: totalColumns - row.length }, () => '')];
}

function serializeField(value: string, delimiter: TabularDelimiter): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes('"');
  if (!needsQuotes) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function inferHeaderRow(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  return first.every((cell) => {
    const trimmed = cell.trim();
    return trimmed.length > 0 && Number.isNaN(Number(trimmed));
  });
}

function columnLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
