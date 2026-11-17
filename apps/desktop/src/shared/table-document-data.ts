import type { TableData } from './table-document-types';

const tableFields = [
  '_fresh',
  'id',
  'name',
  'rows',
  'cols',
  'cells',
  'sort',
  'filters',
  'columnWidths',
  'rowHeights',
  'columnLabels',
  'presentation',
];
const cellFields = [
  'computed',
  'format',
  'reference',
  'span',
  'covered',
  'sourceFormula',
  'sourceRenderedValue',
  'formulaCompatibility',
  'stale',
];
const formatFields = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'align',
  'textColor',
  'bgColor',
  'wrap',
];

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (entry) => 'value' in entry && entry.enumerable
    )
  );
}

function clean(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const next = { ...value };
  for (const key of fields) if (next[key] === undefined) delete next[key];
  return next;
}

export function tableDataForPersistence(data: TableData): TableData {
  if (!plain(data)) return data;
  const next = clean(data, tableFields);
  if (Array.isArray(next.cells))
    next.cells = next.cells.map((row) =>
      Array.isArray(row)
        ? row.map((cell) => {
            if (!plain(cell)) return cell;
            const value = clean(cell, cellFields);
            if (plain(value.format)) value.format = clean(value.format, formatFields);
            return value;
          })
        : row
    );
  return next as TableData;
}
