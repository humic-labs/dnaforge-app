import { normalizeLegacyTableData } from './normalize-table-data';
import type {
  Cell,
  TableData,
  CellType,
  ColumnSort,
  SelectionRange,
  CellFormat,
} from '../../table-document-types';
import { evaluateTableRevision, isFormula, fillFormula } from './utils/formulas';
import {
  parseCSV,
  clipboardTextToCells,
  csvToCells,
  isCSVLike,
  cellsToCSV,
} from './utils/csv-data';
import { mergeTableDataPatch } from './utils/merge-table-data';
import { invalidateSavedResults, userOwnedCell } from './utils/source-result-edits';
import { readSavedFormulaResult } from '../../source-formula-result';
import { tableCellValue } from './utils/cell-value';
import { tableOperationObservation } from './utils/operation-observation';
import type {
  TableOperation,
  TableOperationObservation,
  TableSurface,
} from '../../table-notebook-observation';
const MAX_HISTORY_SIZE = 50;
type HistoryLayout = Pick<TableData, 'columnLabels' | 'columnWidths' | 'rowHeights'>;
type HistoryView = {
  sort: ColumnSort | null;
  filters: Record<number, string>;
};
type HistoryState = {
  cells: Cell[][];
  layout?: HistoryLayout;
  view?: HistoryView;
};
function historyState(cells: Cell[][], layout?: HistoryLayout, view?: HistoryView): HistoryState {
  return {
    cells: cloneCells(cells),
    ...(layout
      ? {
          layout: {
            columnLabels: layout.columnLabels ? [...layout.columnLabels] : undefined,
            columnWidths: layout.columnWidths ? { ...layout.columnWidths } : undefined,
            rowHeights: layout.rowHeights ? { ...layout.rowHeights } : undefined,
          },
        }
      : {}),
    ...(view
      ? { view: { sort: view.sort ? { ...view.sort } : null, filters: { ...view.filters } } }
      : {}),
  };
}
function removeIndexedEntry<T>(values: Record<number, T>, index: number): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [key, value] of Object.entries(values)) {
    const position = Number(key);
    if (position !== index) next[position > index ? position - 1 : position] = value;
  }
  return next;
}
export interface TableDataModelInput {
  data: TableData;
  onUpdateAttrs?: (attrs: Record<string, unknown>, observation?: TableOperationObservation) => void;
  observationSurface?: TableSurface;
  historyEpoch?: unknown;
  memory: TableDataMemory;
  changed(): void;
  canObserve?: () => boolean;
  browserActions?: {
    download(cells: Cell[][], filename: string): void;
    copy(text: string): Promise<void>;
    parseHTML(html: string): Cell[][] | null;
  };
}
function createEmptyCell(type: CellType = 'text'): Cell {
  return { value: '', type };
}
function createEmptyRow(cols: number): Cell[] {
  return Array.from({ length: cols }, () => createEmptyCell());
}
function cloneCells(cellsToClone: Cell[][]): Cell[][] {
  return cellsToClone.map((row) => row.map((c) => ({ ...c })));
}
function findChangedRange(oldCells: Cell[][], newCells: Cell[][]): SelectionRange | null {
  let minRow = Infinity,
    maxRow = -1,
    minCol = Infinity,
    maxCol = -1;
  const maxRows = Math.max(oldCells.length, newCells.length);
  const maxCols = Math.max(oldCells[0]?.length || 0, newCells[0]?.length || 0);
  for (let row = 0; row < maxRows; row++) {
    for (let col = 0; col < maxCols; col++) {
      if ((oldCells[row]?.[col]?.value ?? '') === (newCells[row]?.[col]?.value ?? '')) continue;
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
    }
  }
  if (maxRow === -1) return null;
  return { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol };
}
function copyCell(cell: Cell | undefined): Cell {
  if (!cell) return createEmptyCell();
  return { ...cell, format: cell.format ? { ...cell.format } : undefined };
}
function rectangularBlock(block: Cell[][]): Cell[][] {
  const width = block.reduce((largest, row) => Math.max(largest, row.length), 0);
  return block.map((row) => Array.from({ length: width }, (_, col) => copyCell(row[col])));
}
function inRange(row: number, col: number, range: SelectionRange): boolean {
  return (
    row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
  );
}
function mapRange(cells: Cell[][], range: SelectionRange, fn: (cell: Cell) => Cell): Cell[][] {
  return cells.map((row, rowIndex) =>
    row.map((cell, colIndex) => (inRange(rowIndex, colIndex, range) ? fn(cell) : cell))
  );
}
function rawValueOf(cell: Cell | undefined): string | number {
  return tableCellValue(cell);
}
export interface TableDataMemory {
  sort: ColumnSort | null;
  filters: Record<number, string>;
  cutRange: SelectionRange | null;
  undoStackRef: {
    current: HistoryState[];
  };
  redoStackRef: {
    current: HistoryState[];
  };
  historyEpochRef: {
    current: unknown;
  };
  cellsRef: {
    current: Cell[][];
  };
  layoutRef: {
    current: HistoryLayout;
  };
  viewRef: {
    current: HistoryView;
  };
  cutCellsRef: {
    current: Cell[][] | null;
  };
  pendingEvaluation: {
    current: {
      cells: Cell[][];
      evaluation: ReturnType<typeof evaluateTableRevision>;
    } | null;
  };
}
export function createTableDataMemory(
  data: TableData = {},
  historyEpoch?: unknown
): TableDataMemory {
  return {
    sort: data.sort ?? null,
    filters: data.filters ?? {},
    cutRange: null,
    undoStackRef: { current: [] },
    redoStackRef: { current: [] },
    historyEpochRef: { current: historyEpoch },
    cellsRef: { current: [] },
    layoutRef: { current: {} },
    viewRef: { current: { sort: null, filters: {} } },
    cutCellsRef: { current: null },
    pendingEvaluation: { current: null },
  };
}
export function tableDataModel({
  data,
  onUpdateAttrs,
  historyEpoch,
  observationSurface,
  memory,
  changed,
  canObserve,
  browserActions,
}: TableDataModelInput) {
  data = normalizeLegacyTableData(data);
  const localSort = memory.sort;
  const setLocalSort = (
    value: ColumnSort | null | ((previous: ColumnSort | null) => ColumnSort | null)
  ) => {
    memory.sort = typeof value === 'function' ? value(memory.sort) : value;
    changed();
  };
  const localFilters = memory.filters;
  const setLocalFilters = (
    value: Record<number, string> | ((previous: Record<number, string>) => Record<number, string>)
  ) => {
    memory.filters = typeof value === 'function' ? value(memory.filters) : value;
    changed();
  };
  const columnWidths = data.columnWidths || {};
  const rowHeights = data.rowHeights || {};
  const columnLabels = data.columnLabels || [];
  const undoStackRef = memory.undoStackRef;
  const redoStackRef = memory.redoStackRef;
  const historyEpochRef = memory.historyEpochRef;
  if (!Object.is(historyEpochRef.current, historyEpoch)) {
    undoStackRef.current = [];
    redoStackRef.current = [];
    historyEpochRef.current = historyEpoch;
    memory.cutCellsRef.current = null;
    memory.cutRange = null;
  }
  const cellsRef = memory.cellsRef;
  const layoutRef = memory.layoutRef;
  layoutRef.current = {
    columnLabels: data.columnLabels,
    columnWidths: data.columnWidths,
    rowHeights: data.rowHeights,
  };
  const viewRef = memory.viewRef;
  viewRef.current = { sort: localSort, filters: localFilters };
  const cells = (() => {
    if (data.cells && data.cells.length > 0) {
      return data.cells;
    }
    const rows = data.rows || 3;
    const cols = data.cols || 3;
    return Array.from({ length: rows }, () => createEmptyRow(cols));
  })();
  cellsRef.current = cells;
  const rows = cells.length;
  const cols = cells[0]?.length || 0;
  const pendingEvaluation = memory.pendingEvaluation;
  const evaluation = (() => {
    const pending = pendingEvaluation.current;
    if (pending?.cells === cells) return pending.evaluation;
    const evaluation = evaluateTableRevision(cells);
    pendingEvaluation.current = { cells, evaluation };
    return evaluation;
  })();
  const displayCells = evaluation.cells;
  const filteredIndices = (() => {
    const active = Object.entries(localFilters).filter(([, value]) => value.trim());
    if (active.length === 0) return Array.from({ length: rows }, (_, i) => i);
    const indices: number[] = [];
    for (let i = 0; i < rows; i++) {
      const matchesAll = active.every(([colStr, filterValue]) => {
        const cell = displayCells[i]?.[parseInt(colStr, 10)];
        if (!cell) return true;
        return String(rawValueOf(cell)).toLowerCase().includes(filterValue.toLowerCase());
      });
      if (matchesAll) indices.push(i);
    }
    return indices;
  })();
  const visibleRowIndices = (() => {
    if (!localSort || localSort.direction === null) {
      return filteredIndices;
    }
    const { column, direction } = localSort;
    const sign = direction === 'asc' ? 1 : -1;
    return [...filteredIndices].sort((a, b) => {
      const valueA = rawValueOf(displayCells[a]?.[column]);
      const valueB = rawValueOf(displayCells[b]?.[column]);
      const numA = typeof valueA === 'number' ? valueA : parseFloat(valueA);
      const numB = typeof valueB === 'number' ? valueB : parseFloat(valueB);
      if (!isNaN(numA) && !isNaN(numB)) return sign * (numA - numB);
      return sign * String(valueA).toLowerCase().localeCompare(String(valueB).toLowerCase());
    });
  })();
  const saveWithoutHistory = (
    nextCells: Cell[][],
    extraAttrs: Record<string, unknown> = {},
    operation?: TableOperation
  ) => {
    if (!onUpdateAttrs) throw new Error('The table source is not available for editing.');
    const next = mergeTableDataPatch(data, {
      cells: nextCells,
      rows: nextCells.length,
      cols: nextCells[0]?.length || 0,
      ...extraAttrs,
    });
    let observation: TableOperationObservation | undefined;
    let pending: TableDataMemory['pendingEvaluation']['current'] = null;
    try {
      if (operation && observationSurface && canObserve?.()) {
        const nextEvaluation = nextCells === cells ? evaluation : evaluateTableRevision(nextCells);
        observation = tableOperationObservation(
          operation,
          observationSurface,
          nextCells,
          nextEvaluation.calculation
        );
        if (nextCells !== cells) {
          pending = { cells: nextCells, evaluation: nextEvaluation };
          pendingEvaluation.current = pending;
        }
      }
    } catch (_error) {
      void _error;
    }
    try {
      if (observation) onUpdateAttrs(next, observation);
      else onUpdateAttrs(next);
    } catch (error) {
      if (pendingEvaluation.current === pending) pendingEvaluation.current = null;
      throw error;
    }
  };
  const persistCells = (
    newCells: Cell[][],
    extraAttrs: Record<string, unknown> = {},
    operation?: TableOperation
  ) => {
    const persistedCells = invalidateSavedResults(cells, newCells);
    const structural =
      cells.length !== newCells.length ||
      cells.some((row, index) => row.length !== newCells[index]?.length) ||
      ['columnLabels', 'columnWidths', 'rowHeights'].some((key) => key in extraAttrs);
    const before = historyState(
      cells,
      structural ? layoutRef.current : undefined,
      structural ? viewRef.current : undefined
    );
    saveWithoutHistory(persistedCells, extraAttrs, operation);
    if (cells.length > 0) {
      undoStackRef.current.push(before);
      if (undoStackRef.current.length > MAX_HISTORY_SIZE) undoStackRef.current.shift();
      redoStackRef.current = [];
    }
  };
  const updateCell = (
    row: number,
    col: number,
    value: string,
    operation: 'edit' | 'paste' = 'edit'
  ) => {
    if (!cells[row]?.[col] || cells[row][col].value === value) return;
    const type: CellType = isFormula(value) ? 'formula' : 'text';
    const newCells = cells.map((r, ri) =>
      r.map((c, ci) => (ri === row && ci === col ? userOwnedCell(c, value, type) : c))
    );
    persistCells(newCells, {}, operation);
  };
  const expandAndSetCell = (
    row: number,
    col: number,
    value: string,
    operation: 'edit' | 'paste' = 'edit'
  ) => {
    const currentCells = cellsRef.current;
    const currentRows = currentCells.length;
    const currentCols = currentCells[0]?.length || 0;
    const newRows = Math.max(currentRows, row + 1);
    const newCols = Math.max(currentCols, col + 1);
    const newCells: Cell[][] = [];
    for (let r = 0; r < newRows; r++) {
      const newRow: Cell[] = [];
      for (let c = 0; c < newCols; c++) {
        if (r === row && c === col) {
          const type: CellType = isFormula(value) ? 'formula' : 'text';
          newRow.push({ value, type });
        } else if (r < currentRows && c < currentCols) {
          newRow.push(currentCells[r][c]);
        } else {
          newRow.push(createEmptyCell());
        }
      }
      newCells.push(newRow);
    }
    persistCells(newCells, {}, operation);
    setLocalSort(null);
    setLocalFilters({});
  };
  const fillRange = (sourceRange: SelectionRange, targetRange: SelectionRange) => {
    const sourceRows = sourceRange.endRow - sourceRange.startRow + 1;
    const sourceCols = sourceRange.endCol - sourceRange.startCol + 1;
    const newCells = cloneCells(cells);
    const cycle = (index: number, start: number, end: number, size: number) =>
      index < start ? end - ((start - index - 1) % size) : start + ((index - start) % size);
    for (let row = targetRange.startRow; row <= targetRange.endRow; row++) {
      for (let col = targetRange.startCol; col <= targetRange.endCol; col++) {
        if (inRange(row, col, sourceRange)) continue;
        const sourceRowIndex = cycle(row, sourceRange.startRow, sourceRange.endRow, sourceRows);
        const sourceColIndex = cycle(col, sourceRange.startCol, sourceRange.endCol, sourceCols);
        const sourceCell = cells[sourceRowIndex]?.[sourceColIndex];
        if (!sourceCell) continue;
        if (!newCells[row]) newCells[row] = createEmptyRow(cols);
        if (!newCells[row][col]) newCells[row][col] = createEmptyCell();
        if (sourceCell.type === 'formula' && !readSavedFormulaResult(sourceCell)) {
          const adjustedFormula = fillFormula(
            sourceCell.value,
            sourceRowIndex,
            sourceColIndex,
            row,
            col,
            rows - 1,
            cols - 1
          );
          newCells[row][col] = { value: adjustedFormula, type: 'formula' };
        } else {
          newCells[row][col] = { ...sourceCell };
        }
      }
    }
    persistCells(newCells, {}, 'fill');
  };
  const deleteRange = (range: SelectionRange) => {
    persistCells(
      mapRange(cells, range, () => createEmptyCell()),
      {},
      'edit'
    );
  };
  const addRow = () => {
    const newCells = [...cells, createEmptyRow(cols)];
    persistCells(newCells, {}, 'structure');
  };
  const removeRow = (index: number) => {
    if (rows <= 1 || !Number.isInteger(index) || index < 0 || index >= rows) return;
    const newCells = cells.filter((_, i) => i !== index);
    persistCells(newCells, { rowHeights: removeIndexedEntry(rowHeights, index) }, 'structure');
  };
  const addColumn = () => {
    const newCells = cells.map((row) => [...row, createEmptyCell()]);
    const extraAttrs = columnLabels.length > 0 ? { columnLabels: [...columnLabels, ''] } : {};
    persistCells(newCells, extraAttrs, 'structure');
  };
  const removeColumn = (index: number) => {
    if (cols <= 1 || !Number.isInteger(index) || index < 0 || index >= cols) return;
    const newCells = cells.map((row) => row.filter((_, i) => i !== index));
    const newFilters = removeIndexedEntry(localFilters, index);
    const extraAttrs =
      columnLabels.length > 0 ? { columnLabels: columnLabels.filter((_, i) => i !== index) } : {};
    persistCells(
      newCells,
      { ...extraAttrs, columnWidths: removeIndexedEntry(columnWidths, index) },
      'structure'
    );
    setLocalFilters(newFilters);
    if (localSort)
      setLocalSort(
        localSort.column === index
          ? null
          : {
              ...localSort,
              column: localSort.column > index ? localSort.column - 1 : localSort.column,
            }
      );
  };
  const setSort = (column: number, direction?: ColumnSort['direction']) => {
    if (direction !== undefined) {
      setLocalSort(direction === null ? null : { column, direction });
      return;
    }
    setLocalSort((prev) => {
      if (prev?.column !== column) {
        return { column, direction: 'asc' };
      }
      if (prev.direction === 'asc') {
        return { column, direction: 'desc' };
      }
      return null;
    });
  };
  const setFilter = (column: number, value: string) => {
    setLocalFilters((prev) => {
      if (!value.trim()) {
        const next = { ...prev };
        delete next[column];
        return next;
      }
      return { ...prev, [column]: value };
    });
  };
  const clearFilters = () => {
    setLocalFilters({});
  };
  const importCSV = (text: string): boolean => {
    if (!isCSVLike(text)) return false;
    const parsed = parseCSV(text);
    if (parsed.length === 0) return false;
    const newCells = csvToCells(parsed);
    persistCells(newCells, {}, 'replace');
    return true;
  };
  const importHTMLTable = (html: string): boolean => {
    const parsed = browserActions?.parseHTML(html) ?? null;
    if (!parsed || parsed.length === 0) return false;
    persistCells(parsed, {}, 'replace');
    return true;
  };
  const name = data.name || 'Untitled Table';
  const setName = (newName: string) => {
    saveWithoutHistory(cells, { name: newName }, 'metadata');
  };
  const exportCSV = () => {
    const filename = `${name.replace(/[^a-zA-Z0-9\s-_]/g, '').trim() || 'table'}.csv`;
    if (!browserActions) throw new Error('Table export is unavailable in this client.');
    browserActions.download(displayCells, filename);
  };
  const copyToClipboard = async (): Promise<void> => {
    if (!browserActions) throw new Error('Clipboard access is unavailable');
    const csv = cellsToCSV(displayCells);
    await browserActions.copy(csv);
  };
  const stepHistory = (
    from: {
      current: HistoryState[];
    },
    to: {
      current: HistoryState[];
    },
    operation: 'undo' | 'redo'
  ): SelectionRange | null => {
    if (from.current.length === 0) return null;
    const currentState = cellsRef.current;
    const restored = from.current[from.current.length - 1];
    const inverse = historyState(
      currentState,
      restored.layout ? layoutRef.current : undefined,
      restored.view ? viewRef.current : undefined
    );
    saveWithoutHistory(restored.cells, { ...restored.layout }, operation);
    from.current.pop();
    to.current.push(inverse);
    if (restored.view) {
      setLocalSort(restored.view.sort);
      setLocalFilters(restored.view.filters);
    }
    return findChangedRange(currentState, restored.cells);
  };
  const undo = () => stepHistory(undoStackRef, redoStackRef, 'undo');
  const redo = () => stepHistory(redoStackRef, undoStackRef, 'redo');
  const setColumnWidth = (column: number, width: number) => {
    saveWithoutHistory(cells, { columnWidths: { ...columnWidths, [column]: width } }, 'metadata');
  };
  const setRowHeight = (row: number, height: number) => {
    saveWithoutHistory(cells, { rowHeights: { ...rowHeights, [row]: height } }, 'metadata');
  };
  const setColumnLabel = (column: number, label: string) => {
    if (column < 0) return;
    const nextLabels = [...columnLabels];
    while (nextLabels.length <= column) nextLabels.push('');
    nextLabels[column] = label;
    while (nextLabels.length > 0 && nextLabels[nextLabels.length - 1]?.trim() === '') {
      nextLabels.pop();
    }
    persistCells(cells, { columnLabels: nextLabels }, 'metadata');
  };
  const cutRangeState = memory.cutRange;
  const setCutRangeState = (range: SelectionRange | null) => {
    memory.cutRange = range;
    changed();
  };
  const cutCellsRef = memory.cutCellsRef;
  const copyCells = (range: SelectionRange): Cell[][] => {
    const copied: Cell[][] = [];
    for (let row = range.startRow; row <= range.endRow; row++) {
      const rowCells: Cell[] = [];
      for (let col = range.startCol; col <= range.endCol; col++) {
        rowCells.push(copyCell(cells[row]?.[col]));
      }
      copied.push(rowCells);
    }
    return copied;
  };
  const cutCells = (range: SelectionRange): Cell[][] => {
    const copied = copyCells(range);
    cutCellsRef.current = copied;
    setCutRangeState(range);
    return copied;
  };
  const clearCut = () => {
    cutCellsRef.current = null;
    setCutRangeState(null);
  };
  const pasteCells = (
    startRow: number,
    startCol: number,
    cellData: Cell[][],
    isCut = false,
    sourceRange?: SelectionRange
  ) => {
    const pasteRows = cellData.length;
    const pasteCols = cellData[0]?.length || 0;
    if (pasteRows === 0 || pasteCols === 0) return;
    if (!Number.isInteger(startRow) || !Number.isInteger(startCol) || startRow < 0 || startCol < 0)
      return;
    if (cellData.some((row) => row.length !== pasteCols)) return;
    const moveSource =
      isCut &&
      sourceRange &&
      sourceRange.endRow - sourceRange.startRow + 1 === pasteRows &&
      sourceRange.endCol - sourceRange.startCol + 1 === pasteCols &&
      cellData.every((row, r) =>
        row.every(
          (cell, c) =>
            JSON.stringify(cells[sourceRange.startRow + r]?.[sourceRange.startCol + c]) ===
            JSON.stringify(cell)
        )
      )
        ? sourceRange
        : undefined;
    const requiredRows = Math.max(rows, startRow + pasteRows);
    const requiredCols = Math.max(cols, startCol + pasteCols);
    const newCells = cloneCells(cells);
    while (newCells.length < requiredRows) newCells.push(createEmptyRow(requiredCols));
    for (const row of newCells) {
      while (row.length < requiredCols) row.push(createEmptyCell());
    }
    for (let r = 0; r < pasteRows; r++) {
      for (let c = 0; c < pasteCols; c++) {
        const sourceCell = cellData[r][c];
        const targetRow = startRow + r;
        const targetCol = startCol + c;
        if (sourceCell.type === 'formula' && moveSource && !readSavedFormulaResult(sourceCell)) {
          const sourceRow = moveSource.startRow + r;
          const sourceCol = moveSource.startCol + c;
          const adjustedFormula = fillFormula(
            sourceCell.value,
            sourceRow,
            sourceCol,
            targetRow,
            targetCol,
            requiredRows - 1,
            requiredCols - 1
          );
          newCells[targetRow][targetCol] = { ...copyCell(sourceCell), value: adjustedFormula };
        } else {
          newCells[targetRow][targetCol] = copyCell(sourceCell);
        }
      }
    }
    if (moveSource) {
      for (let row = moveSource.startRow; row <= moveSource.endRow; row++) {
        for (let col = moveSource.startCol; col <= moveSource.endCol; col++) {
          const isInPasteArea =
            row >= startRow &&
            row < startRow + pasteRows &&
            col >= startCol &&
            col < startCol + pasteCols;
          if (!isInPasteArea && newCells[row]?.[col]) {
            newCells[row][col] = createEmptyCell();
          }
        }
      }
    }
    persistCells(newCells, {}, 'paste');
    if (isCut) clearCut();
  };
  const pasteCSV = (text: string, startRow: number, startCol: number): boolean => {
    if (!isCSVLike(text) && !/[\t\r\n]/.test(text)) return false;
    const parsed = clipboardTextToCells(text);
    if (!parsed.length || !parsed[0]?.length) return false;
    pasteCells(startRow, startCol, parsed);
    return true;
  };
  const pasteHTMLTable = (html: string, startRow: number, startCol: number): boolean => {
    const parsed = browserActions?.parseHTML(html) ?? null;
    if (!parsed?.length || !parsed[0]?.length) return false;
    pasteCells(startRow, startCol, rectangularBlock(parsed));
    return true;
  };
  const replaceTableFromClipboard = (text: string, html = ''): boolean => {
    const parsedHTML = html ? (browserActions?.parseHTML(html) ?? null) : null;
    const parsed = parsedHTML?.length ? parsedHTML : text.trim() ? clipboardTextToCells(text) : [];
    if (!parsed.length || !parsed[0]?.length) return false;
    persistCells(rectangularBlock(parsed), {}, 'replace');
    clearCut();
    return true;
  };
  const setCellFormat = (range: SelectionRange, format: Partial<CellFormat>) => {
    persistCells(
      mapRange(cells, range, (cell) => ({ ...cell, format: { ...cell.format, ...format } })),
      {},
      'format'
    );
  };
  return {
    name,
    setName,
    displayCells,
    cells,
    visibleRowIndices,
    rows,
    cols,
    sort: localSort,
    filters: localFilters,
    updateCell,
    expandAndSetCell,
    fillRange,
    deleteRange,
    copyCells,
    cutCells,
    pasteCells,
    cutRange: cutRangeState,
    clearCut,
    addRow,
    removeRow,
    addColumn,
    removeColumn,
    setSort,
    setFilter,
    clearFilters,
    importCSV,
    importHTMLTable,
    pasteCSV,
    pasteHTMLTable,
    replaceTableFromClipboard,
    exportCSV,
    copyToClipboard,
    undo,
    redo,
    canUndo: undoStackRef.current.length > 0,
    canRedo: redoStackRef.current.length > 0,
    columnWidths,
    rowHeights,
    setRowHeight,
    columnLabels,
    setColumnWidth,
    setColumnLabel,
    setCellFormat,
  };
}
