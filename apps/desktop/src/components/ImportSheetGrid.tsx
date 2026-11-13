import { useMemo } from 'react';
import { TableGrid } from '../features/page/embeds/table/components/TableGrid';
import type { Cell } from '../shared/table-document-types';

export function ImportSheetGrid({
  headers,
  rows,
  className,
}: {
  headers?: readonly string[];
  rows: readonly (readonly string[])[];
  className?: string;
}) {
  const cells = useMemo<Cell[][]>(() => {
    const width = Math.max(headers?.length ?? 0, ...rows.map((row) => row.length), 1);
    const pad = (row: readonly string[]): Cell[] =>
      Array.from({ length: width }, (_, i) => ({ value: row[i] ?? '', type: 'text' as const }));
    const headerRow: Cell[][] =
      headers && headers.length > 0
        ? [
            Array.from({ length: width }, (_, i) => ({
              value: headers[i] ?? '',
              type: 'text' as const,
              format: { bold: true },
            })),
          ]
        : [];
    return [...headerRow, ...rows.map(pad)];
  }, [headers, rows]);

  const visibleRowIndices = useMemo(() => cells.map((_, i) => i), [cells]);

  return (
    <div
      data-testid="import-sheet-grid"
      className={`min-h-0 min-w-0 flex-1 overflow-auto ${className ?? ''}`}
    >
      <TableGrid
        cells={cells}
        displayCells={cells}
        visibleRowIndices={visibleRowIndices}
        sort={null}
        filters={{}}
        readOnly
        showFormulaBar={false}
        onCellChange={noop}
        onExpandAndSetCell={noop}
        onFillRange={noop}
        onDeleteRange={noop}
        onSort={noop}
        onFilter={noop}
        onPaste={returnFalse}
      />
    </div>
  );
}

const noop = () => {};
const returnFalse = () => false;
