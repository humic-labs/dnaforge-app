import type { z } from 'zod';
import { tableEditorCommandSchema } from '../../table-editor-command';
import type { tableDataModel } from './table-data-model';
export function executeTableModelCommand(
  table: ReturnType<typeof tableDataModel>,
  command: z.infer<typeof tableEditorCommandSchema>,
  apply: (operation: () => void) => void = (operation) => operation()
) {
  if (command.kind === 'inspect')
    return {
      rows: table.rows,
      columns: table.cols,
      name: table.name,
      sort: table.sort,
      filters: table.filters,
      columnLabels: table.columnLabels.slice(
        command.columnOffset,
        command.columnOffset + command.columnLimit
      ),
      rowOffset: command.rowOffset,
      columnOffset: command.columnOffset,
      cells: table.displayCells
        .slice(command.rowOffset, command.rowOffset + command.rowLimit)
        .map((row) => row.slice(command.columnOffset, command.columnOffset + command.columnLimit)),
      nextRowOffset:
        command.rowOffset + command.rowLimit < table.rows
          ? command.rowOffset + command.rowLimit
          : null,
    };
  if ('row' in command && command.row >= table.rows) throw new Error('Row is outside this table.');
  if ('column' in command && command.column >= table.cols)
    throw new Error('Column is outside this table.');
  if ('index' in command) {
    const maximum = command.kind.includes('row') ? table.rows : table.cols;
    if (command.index > maximum || (command.kind.startsWith('remove') && command.index === maximum))
      throw new Error('Row or column index is outside this table.');
  }
  if ('range' in command) {
    const r = command.range;
    if (
      r.endRow < r.startRow ||
      r.endCol < r.startCol ||
      r.endRow >= table.rows ||
      r.endCol >= table.cols
    )
      throw new Error('Cell range is outside this table.');
  }
  apply(() => {
    switch (command.kind) {
      case 'set-cell':
        table.updateCell(command.row, command.column, command.value);
        break;
      case 'add-row':
        table.addRow();
        break;
      case 'remove-row':
        table.removeRow(command.index);
        break;
      case 'add-column':
        table.addColumn();
        break;
      case 'remove-column':
        table.removeColumn(command.index);
        break;
      case 'set-column-label':
        table.setColumnLabel(command.column, command.label);
        break;
      case 'set-column-width':
        table.setColumnWidth(command.column, command.width);
        break;
      case 'set-row-height':
        table.setRowHeight(command.row, command.height);
        break;
      case 'rename':
        table.setName(command.name);
        break;
      case 'sort':
        table.setSort(command.column, command.direction);
        break;
      case 'filter':
        table.setFilter(command.column, command.value);
        break;
      case 'clear-filters':
        table.clearFilters();
        break;
      case 'clear-cells':
        table.deleteRange(command.range);
        break;
      case 'format-cells':
        table.setCellFormat(command.range, command.format);
        break;
      case 'undo':
        table.undo();
        break;
      case 'redo':
        table.redo();
        break;
    }
  });
  return { applied: true };
}
