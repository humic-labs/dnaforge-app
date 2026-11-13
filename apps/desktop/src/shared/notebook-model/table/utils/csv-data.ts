import type { Cell } from '../../../table-document-types';
import { tableCellValue } from './cell-value';

export function parseCSV(
  text: string,
  options: { delimiter?: ',' | '\t'; preserveEmptyRows?: boolean } = {}
): string[][] {
  if (!text) return [];
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"' && currentField.length === 0) {
        inQuotes = true;
      } else if (options.delimiter ? char === options.delimiter : char === ',' || char === '\t') {
        currentRow.push(currentField);
        currentField = '';
      } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
        currentRow.push(currentField);
        if (options.preserveEmptyRows || currentRow.some((f) => f.trim() !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        if (char === '\r') i++;
      } else if (char !== '\r') {
        currentField += char;
      }
    }
  }

  currentRow.push(currentField);
  if (
    currentRow.some((f) => f.trim() !== '') ||
    (options.preserveEmptyRows && !/[\r\n]$/.test(text))
  ) {
    rows.push(currentRow);
  }

  return rows;
}

export function cellsToCSV(cells: Cell[][]): string {
  return cells
    .map((row) =>
      row
        .map((cell) => {
          const value = String(tableCellValue(cell));

          if (value.includes(',') || value.includes('\n') || value.includes('"')) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        })
        .join(',')
    )
    .join('\n');
}

export function csvToCells(data: string[][]): Cell[][] {
  const maxCols = Math.max(...data.map((row) => row.length));

  return data.map((row) => {
    const cells: Cell[] = [];
    for (let i = 0; i < maxCols; i++) {
      const value = row[i] ?? '';
      cells.push({ value, type: 'text' });
    }
    return cells;
  });
}

export function clipboardTextToCells(text: string): Cell[][] {
  let quoted = false;
  let fieldStart = true;
  let delimiter: ',' | '\t' = ',';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') index++;
      else if (character === '"') quoted = false;
    } else if (character === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (character === '\t') {
      delimiter = '\t';
      break;
    } else {
      fieldStart = character === ',' || character === '\n' || character === '\r';
    }
  }
  return csvToCells(parseCSV(text, { delimiter, preserveEmptyRows: true }));
}

export function isCSVLike(text: string): boolean {
  if (!text || !text.trim()) return false;

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 1) return false;

  const hasAnyTabs = lines.some((line) => line.includes('\t'));
  const hasAnyCommas = lines.some((line) => line.includes(','));

  if (!hasAnyTabs && !hasAnyCommas) return false;

  const delimiter = hasAnyTabs ? '\t' : ',';

  const maxCols = Math.max(...lines.map((line) => line.split(delimiter).length));

  return maxCols > 1 || (lines.length > 1 && (hasAnyTabs || hasAnyCommas));
}
