import type { Cell, TableData } from '../../table-document-types';

export function normalizeLegacyTableData(data: TableData): TableData {
  const raw = data.cells as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return data;
  const entries: Array<{ row: number; column: number; cell: Cell }> = [];
  let rows = typeof data.rows === 'number' ? data.rows : 0;
  let columns = typeof data.cols === 'number' ? data.cols : 0;
  for (const [coordinate, value] of Object.entries(raw)) {
    const match = /^([A-Z]+)([1-9]\d*)$/.exec(coordinate);
    if (
      !match ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.value !== 'string'
    )
      throw new Error('This table contains an invalid saved cell. Its original data is preserved.');
    let column = 0;
    for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
    const row = Number(match[2]);
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) || row > 10000 || column > 1000)
      throw new Error(
        'This table exceeds the supported editing dimensions. Its original data is preserved.'
      );
    rows = Math.max(rows, row);
    columns = Math.max(columns, column);
    entries.push({
      row: row - 1,
      column: column - 1,
      cell: {
        ...value,
        type: value.type ?? (value.value.startsWith('=') ? 'formula' : 'text'),
      } as Cell,
    });
  }
  if (
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(columns) ||
    rows < 0 ||
    columns < 0 ||
    rows > 10000 ||
    columns > 1000 ||
    rows * columns > 1000000
  )
    throw new Error(
      'This table exceeds the supported editing dimensions. Its original data is preserved.'
    );
  const cells = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, (): Cell => ({ value: '', type: 'text' }))
  );
  for (const entry of entries) cells[entry.row][entry.column] = entry.cell;
  return { ...data, rows, cols: columns, cells };
}
