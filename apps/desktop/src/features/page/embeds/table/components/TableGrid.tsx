'use client';

import { useCallback, useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import type { Cell, CellPosition, CellSpan, ColumnSort, SelectionRange } from '../types';
import { TableCell } from './TableCell';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import { useColumnResize } from '../hooks/useColumnResize';
import { useOverflowXWhenNeeded } from '../hooks/useOverflowXWhenNeeded';
import { useRowResize, autoFitColumnWidth } from '../hooks/useRowResize';
import { useFormatting } from '../hooks/useFormatting';
import { useFillOperations } from '../hooks/useFillOperations';
import { useClipboardOperations, isTableClipboardInput } from '../hooks/useClipboardOperations';
import { useTableGridSearch } from './useTableGridSearch';
import {
  TableGridFilterStatus,
  TableGridFindOverlay,
  TableGridFormulaBar,
} from './TableGridChrome';
import {
  tableGridCanEditColumnLabels,
  tableGridColumnCount,
  tableGridDataCellClasses,
  tableGridFocusedCellAddress,
  tableGridFocusedCellRawValue,
  tableGridFormulaBarValue,
  tableGridIsEmpty,
  tableGridRenderedRowCount,
  tableGridShouldShowColumnLabels,
  tableGridShouldShowFormulaBar,
  tableGridFilterStatusVisible,
  tableGridLabelOnlySelection,
  tableGridLabelSelectionExtendsIntoCells,
  tableGridOverflowX,
  tableGridTotalCount,
  tableGridWhenWritable,
} from './table-grid-flags';
import { tableGridFormatControlsDisabled } from './table-grid-format-classes';
import {
  consumeFocusSinkWhileEditing,
  consumeLabelSelectionKeys,
  consumeTableGridFormatShortcut,
  consumeUndoRedoShortcut,
  isTableGridNavigationKey,
} from './table-grid-focus-sink-keydown';
import {
  columnIndexToLetter,
  buildFormulaReferenceText,
  closeUnclosedFormula,
  insertCellReferenceAtCursor,
} from '../utils/formulas';
import { safeFocus } from '../../../../../shared/utils/safeFocus';
import { tableCellValue } from '../utils/cell-value';
import {
  TELEMETRY_BLOCKED_ATTRIBUTES,
  TELEMETRY_BLOCKED_CLASS,
} from '../../../../../components/TelemetryBlockedSurface';

interface EditingState {
  position: CellPosition;
  value: string;
  cursorPosition: number;
}

interface EditingColumnLabelState {
  column: number;
  value: string;
}

const GHOST_ROWS = 50;
const GHOST_COLS = 10;

const MIN_COL_WIDTH = 40;
const COLUMN_LABEL_SELECTION_ROW = -1;
const NOOP = () => {};
const NOOP_FALSE = () => false;

type HeaderSelectionSegment = 'letters' | 'labels';

interface HeaderDragState {
  kind: HeaderSelectionSegment;
  anchorCol: number;
}

type ActiveSelectionState = { kind: 'cells' | 'column-letters' | 'row-numbers' };

function displayValueOf(cell: Cell | undefined): string {
  return String(tableCellValue(cell));
}

function isInRange(row: number, col: number, range: SelectionRange | null | undefined): boolean {
  if (!range) return false;
  return (
    row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
  );
}

const EMPTY_CELL: Cell = { value: '', type: 'text' };

function headerColumnAt(element: Element | null, cols: number): number | null {
  const colAttr = element
    ?.closest('[data-table-header-col]')
    ?.getAttribute('data-table-header-col');
  if (!colAttr) return null;
  const column = Number(colAttr);
  return Number.isInteger(column) && column >= 0 && column < cols ? column : null;
}

function cellPositionAt(
  element: Element | null,
  cols: number
): { row: number; column: number } | null {
  const positionAttr = element?.closest('[data-cell-position]')?.getAttribute('data-cell-position');
  if (!positionAttr) return null;

  const [row, column] = positionAttr.split(',').map(Number);
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null;
  if (row < COLUMN_LABEL_SELECTION_ROW || column < 0 || column >= cols) return null;
  return { row, column };
}

function headerColumnNearestX(
  clientX: number,
  kind: HeaderSelectionSegment,
  cols: number
): number | null {
  const headers = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-table-header-kind="${kind}"][data-table-header-col]`
    )
  )
    .map((header) => {
      const colAttr = header.getAttribute('data-table-header-col');
      return {
        column: colAttr === null ? Number.NaN : Number(colAttr),
        rect: header.getBoundingClientRect(),
      };
    })
    .filter(
      (entry) =>
        Number.isInteger(entry.column) &&
        entry.column >= 0 &&
        entry.column < cols &&
        entry.rect.width > 0
    )
    .sort((a, b) => a.column - b.column);

  if (headers.length === 0) return null;

  const spanning = headers.find(
    (header) => clientX >= header.rect.left && clientX <= header.rect.right
  );
  if (spanning) return spanning.column;
  return clientX < headers[0].rect.left ? headers[0].column : headers[headers.length - 1].column;
}

interface TableGridProps {
  autoFocus?: boolean;

  displayCells: Cell[][];

  cells: Cell[][];

  visibleRowIndices: number[];
  sort?: ColumnSort | null;
  filters: Record<number, string>;
  onCellChange: (row: number, col: number, value: string, operation?: 'edit' | 'paste') => void;

  onExpandAndSetCell: (
    row: number,
    col: number,
    value: string,
    operation?: 'edit' | 'paste'
  ) => void;

  onFillRange: (sourceRange: SelectionRange, targetRange: SelectionRange) => void;

  onDeleteRange: (range: SelectionRange) => void;

  onCopyCells?: (range: SelectionRange) => Cell[][];

  onCutCells?: (range: SelectionRange) => Cell[][];

  onPasteCells?: (
    startRow: number,
    startCol: number,
    cellData: Cell[][],
    isCut?: boolean,
    sourceRange?: SelectionRange
  ) => void;

  cutRange?: SelectionRange | null;

  onClearCut?: () => void;
  onSort?: (column: number) => void;
  onFilter?: (column: number, value: string) => void;
  onPaste: (text: string, startRow: number, startCol: number) => boolean;

  onPasteHTML?: (html: string, startRow: number, startCol: number) => boolean;

  onUndo?: () => SelectionRange | null;

  onRedo?: () => SelectionRange | null;

  columnWidths?: Record<number, number>;

  rowHeights?: Record<number, number>;

  columnLabels?: string[];

  showCoordinateHeaders?: boolean;

  showColumnLabels?: boolean;

  referenceWorkspaceRoot?: string;

  onColumnLabelChange?: (column: number, label: string) => void;

  onColumnResize?: (column: number, width: number) => void;

  onRowResize?: (row: number, height: number) => void;

  showGhostRows?: boolean;

  showGhostCols?: boolean;

  readOnly?: boolean;

  showFormulaBar?: boolean;

  onCellFormat?: (
    range: SelectionRange,
    format: {
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strikethrough?: boolean;
      align?: 'left' | 'center' | 'right';
      textColor?: string;
      bgColor?: string;
    }
  ) => void;
}

export function TableGrid({
  autoFocus = false,
  displayCells,
  cells,
  visibleRowIndices,
  filters,
  onCellChange,
  onExpandAndSetCell,
  onFillRange,
  onDeleteRange,
  onCopyCells,
  onCutCells,
  onPasteCells,
  cutRange,
  onClearCut,
  onPaste,
  onPasteHTML,
  onUndo,
  onRedo,
  columnWidths = {},
  rowHeights = {},
  columnLabels,
  showCoordinateHeaders = true,
  showColumnLabels,
  referenceWorkspaceRoot,
  onColumnLabelChange,
  onColumnResize,
  onRowResize,
  showGhostRows = false,
  showGhostCols = false,
  readOnly = false,
  showFormulaBar,
  onCellFormat,
}: TableGridProps) {
  const rows = cells.length;
  const cols = tableGridColumnCount(cells);
  const shouldShowFormulaBar = tableGridShouldShowFormulaBar(showFormulaBar, readOnly);
  const {
    globalSearch,
    setGlobalSearch,
    isFindOpen,
    setIsFindOpen,
    searchActive,
    searchedVisibleRowIndices,
  } = useTableGridSearch(displayCells, visibleRowIndices);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [editingColumnLabel, setEditingColumnLabel] = useState<EditingColumnLabelState | null>(
    null
  );
  const editingColumnLabelRef = useRef<EditingColumnLabelState | null>(null);
  const [activeSelection, setActiveSelection] = useState<ActiveSelectionState>({
    kind: 'cells',
  });
  const headerDragRef = useRef<HeaderDragState | null>(null);
  const headerDragCleanupRef = useRef<(() => void) | null>(null);

  const rowDragAnchorRef = useRef<number | null>(null);
  const suppressHeaderClickRef = useRef(false);
  const columnLabelInputRef = useRef<HTMLInputElement>(null);
  const canEditColumnLabels = tableGridCanEditColumnLabels(readOnly, onColumnLabelChange);
  const shouldShowColumnLabels = tableGridShouldShowColumnLabels(showColumnLabels, columnLabels);

  const setColumnLabelEditingState = useCallback((next: EditingColumnLabelState | null) => {
    editingColumnLabelRef.current = next;
    setEditingColumnLabel(next);
  }, []);

  const mergeProjection = useMemo(() => {
    const anchors = new Map<string, CellSpan>();
    const coveredByAnchor = new Map<string, CellPosition>();
    const renderedPositionByRow = new Map(
      searchedVisibleRowIndices.map((rowIndex, displayIndex) => [rowIndex, displayIndex])
    );

    for (let anchorRow = 0; anchorRow < displayCells.length; anchorRow += 1) {
      const displayIndex = renderedPositionByRow.get(anchorRow);
      if (displayIndex === undefined) continue;
      for (let anchorCol = 0; anchorCol < (displayCells[anchorRow]?.length ?? 0); anchorCol += 1) {
        const sourceSpan = displayCells[anchorRow]?.[anchorCol]?.span;
        if (!sourceSpan) continue;

        const preservesVerticalOrder = Array.from({ length: sourceSpan.rows }).every(
          (_, offset) => searchedVisibleRowIndices[displayIndex + offset] === anchorRow + offset
        );
        const span = {
          rows: preservesVerticalOrder ? sourceSpan.rows : 1,
          cols: sourceSpan.cols,
        };
        anchors.set(`${anchorRow}:${anchorCol}`, span);
        for (let rowOffset = 0; rowOffset < span.rows; rowOffset += 1) {
          for (let colOffset = 0; colOffset < span.cols; colOffset += 1) {
            if (rowOffset === 0 && colOffset === 0) continue;
            coveredByAnchor.set(`${anchorRow + rowOffset}:${anchorCol + colOffset}`, {
              row: anchorRow,
              col: anchorCol,
            });
          }
        }
      }
    }

    return { anchors, coveredByAnchor };
  }, [displayCells, searchedVisibleRowIndices]);

  const totalRows = tableGridTotalCount(showGhostRows, rows, GHOST_ROWS);
  const totalCols = tableGridTotalCount(showGhostCols, cols, GHOST_COLS);
  const renderedRowCount = tableGridRenderedRowCount(
    searchActive,
    searchedVisibleRowIndices.length,
    totalRows
  );

  useEffect(() => {
    if (!isFindOpen) return;
    safeFocus(findInputRef.current);
    findInputRef.current?.select();
  }, [isFindOpen]);

  useEffect(() => {
    if (!editingColumnLabel) return;
    safeFocus(columnLabelInputRef.current);
    columnLabelInputRef.current?.select();
  }, [editingColumnLabel]);

  useEffect(() => {
    return () => {
      headerDragCleanupRef.current?.();
    };
  }, []);

  const [editingState, setEditingState] = useState<EditingState | null>(null);
  const editingStateRef = useRef<EditingState | null>(null);

  const applyEditingState = useCallback((next: EditingState | null) => {
    editingStateRef.current = next;
    setEditingState(next);
  }, []);

  const editInputRef = useRef<HTMLInputElement>(null);

  const resolveMergeAnchor = useCallback(
    (position: CellPosition): CellPosition => {
      return mergeProjection.coveredByAnchor.get(`${position.row}:${position.col}`) ?? position;
    },
    [mergeProjection]
  );

  const {
    focusedCell,
    selection,
    isInSelection,
    handleCellClick,
    extendSelectionTo,
    handleKeyDown,
    getCellRef,
    clearSelection,
    clearFocus,
    setSelection,
  } = useKeyboardNav({
    rows: totalRows,
    cols: totalCols,

    dataRows: rows,
    dataCols: cols,
    resolveFocusable: resolveMergeAnchor,
  });

  const dataCellSelection = useMemo((): SelectionRange | null => {
    if (!selection || selection.endRow < 0) return null;
    return {
      ...selection,
      startRow: Math.max(0, selection.startRow),
    };
  }, [selection]);

  const labelSelection = useMemo((): { startCol: number; endCol: number } | null => {
    if (
      shouldShowColumnLabels &&
      activeSelection.kind === 'cells' &&
      selection &&
      selection.startRow <= COLUMN_LABEL_SELECTION_ROW &&
      selection.endRow >= COLUMN_LABEL_SELECTION_ROW
    ) {
      return {
        startCol: Math.max(0, selection.startCol),
        endCol: Math.min(cols - 1, selection.endCol),
      };
    }
    return null;
  }, [activeSelection, cols, selection, shouldShowColumnLabels]);

  const labelOnlySelection = tableGridLabelOnlySelection({
    hasLabelSelection: !!labelSelection,
    activeKind: activeSelection.kind,
    selectionStartRow: selection?.startRow,
    selectionEndRow: selection?.endRow,
    columnLabelSelectionRow: COLUMN_LABEL_SELECTION_ROW,
  });

  const labelSelectionExtendsIntoCells = tableGridLabelSelectionExtendsIntoCells(
    !!labelSelection,
    selection?.endRow
  );

  const { isInFillPreview, showFillHandleFor, handleFillStart, handleFillMove, handleFillEnd } =
    useFillOperations({ selection: dataCellSelection, rows, cols, onFillRange });

  const { getColWidth, handleResizeStart } = useColumnResize({
    columnWidths,
    onColumnResize,
  });

  const gridScrollRef = useRef<HTMLDivElement>(null);
  const gridWidthLayoutKey = `${totalCols}:${JSON.stringify(columnWidths)}`;
  const overflowsX = useOverflowXWhenNeeded(gridScrollRef, gridWidthLayoutKey);

  const { getRowHeight, handleRowResizeStart } = useRowResize({
    rowHeights,
    onRowResize,
  });

  const autoFitColumn = useCallback(
    (colIndex: number) => {
      if (!onColumnResize || colIndex < 0 || colIndex >= cols) return;
      const values: string[] = [];

      if (shouldShowColumnLabels && columnLabels?.[colIndex]) values.push(columnLabels[colIndex]);
      for (let row = 0; row < rows; row++) {
        const cell = displayCells[row]?.[colIndex];
        if (!cell) continue;
        values.push(displayValueOf(cell));
      }
      onColumnResize(colIndex, autoFitColumnWidth(values, { minWidth: MIN_COL_WIDTH }));
    },
    [cols, rows, displayCells, columnLabels, shouldShowColumnLabels, onColumnResize]
  );

  const labelSelectionRangeWidth = useMemo(() => {
    if (!labelSelection) return 0;

    let width = 0;
    for (let col = labelSelection.startCol; col <= labelSelection.endCol; col++) {
      width += getColWidth(col);
    }
    return width;
  }, [getColWidth, labelSelection]);

  const closeFind = useCallback(() => {
    setIsFindOpen(false);
    setGlobalSearch('');
    safeFocus(focusSinkRef.current);
  }, []);

  const handleFindShortcut = useCallback(
    (event: React.KeyboardEvent): boolean => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'f') {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      applyEditingState(null);
      setIsFindOpen(true);
      return true;
    },
    [applyEditingState]
  );

  const selectColumnRange = useCallback(
    (anchorColumn: number, targetColumn: number) => {
      if (rows === 0 || cols === 0) return;
      const startCol = Math.max(0, Math.min(anchorColumn, targetColumn, cols - 1));
      const endCol = Math.max(0, Math.min(Math.max(anchorColumn, targetColumn), cols - 1));
      setActiveSelection({ kind: 'column-letters' });
      setSelection({
        startRow: 0,
        startCol,
        endRow: rows - 1,
        endCol,
      });
      safeFocus(focusSinkRef.current);
    },
    [cols, rows, setSelection]
  );

  const selectLabelRange = useCallback(
    (anchorColumn: number, targetColumn: number, targetRow = COLUMN_LABEL_SELECTION_ROW) => {
      if (cols === 0) return;
      const startCol = Math.max(0, Math.min(anchorColumn, targetColumn, cols - 1));
      const endCol = Math.max(0, Math.min(Math.max(anchorColumn, targetColumn), cols - 1));
      setActiveSelection({ kind: 'cells' });
      setSelection({
        startRow: Math.min(COLUMN_LABEL_SELECTION_ROW, targetRow),
        startCol,
        endRow: Math.max(COLUMN_LABEL_SELECTION_ROW, targetRow),
        endCol,
      });
      safeFocus(focusSinkRef.current);
    },
    [cols, setSelection]
  );

  const selectRowRange = useCallback(
    (anchorRow: number, targetRow: number) => {
      if (rows === 0 || cols === 0) return;
      const startRow = Math.max(0, Math.min(anchorRow, targetRow, rows - 1));
      const endRow = Math.max(0, Math.min(Math.max(anchorRow, targetRow), rows - 1));
      setActiveSelection({ kind: 'row-numbers' });
      setSelection({ startRow, startCol: 0, endRow, endCol: cols - 1 });
      safeFocus(focusSinkRef.current);
    },
    [cols, rows, setSelection]
  );

  const isRowSelected = useCallback(
    (row: number): boolean => {
      if (activeSelection.kind !== 'row-numbers' || !selection || cols === 0) return false;
      return (
        selection.startRow <= row &&
        selection.endRow >= row &&
        selection.startCol === 0 &&
        selection.endCol === cols - 1
      );
    },
    [activeSelection.kind, cols, selection]
  );

  const extendHeaderSelectionToColumn = useCallback(
    (targetColumn: number, targetRow = COLUMN_LABEL_SELECTION_ROW) => {
      const drag = headerDragRef.current;
      if (!drag) return;
      if (targetColumn < 0 || targetColumn >= cols) return;
      if (targetColumn !== drag.anchorCol) {
        suppressHeaderClickRef.current = true;
      }
      if (drag.kind === 'labels') {
        selectLabelRange(drag.anchorCol, targetColumn, targetRow);
      } else {
        selectColumnRange(drag.anchorCol, targetColumn);
      }
    },
    [cols, selectColumnRange, selectLabelRange]
  );

  const beginHeaderSelection = useCallback(
    (kind: HeaderSelectionSegment, column: number, event: React.MouseEvent) => {
      if (column < 0 || column >= cols) return;
      event.preventDefault();
      event.stopPropagation();
      setColumnLabelEditingState(null);
      headerDragCleanupRef.current?.();
      suppressHeaderClickRef.current = false;
      headerDragRef.current = { kind, anchorCol: column };

      const extendToPointer = (pointerEvent: MouseEvent) => {
        const element =
          typeof document.elementFromPoint === 'function'
            ? document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
            : null;
        const targetCell = cellPositionAt(element, cols);
        const targetColumn =
          targetCell?.column ??
          headerColumnAt(element, cols) ??
          headerColumnNearestX(pointerEvent.clientX, kind, cols);
        if (targetColumn === null) return;
        extendHeaderSelectionToColumn(targetColumn, targetCell?.row ?? COLUMN_LABEL_SELECTION_ROW);
      };

      extendHeaderSelectionToColumn(column);

      const handleMouseUp = (upEvent: MouseEvent) => {
        extendToPointer(upEvent);
        cleanup();
        window.requestAnimationFrame(() => {
          if (!editingColumnLabelRef.current) {
            safeFocus(focusSinkRef.current);
          }
        });
      };

      function cleanup() {
        document.removeEventListener('mousemove', extendToPointer);
        document.removeEventListener('mouseup', handleMouseUp);
        headerDragRef.current = null;
        headerDragCleanupRef.current = null;
      }

      headerDragCleanupRef.current = cleanup;
      document.addEventListener('mousemove', extendToPointer);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [cols, extendHeaderSelectionToColumn, setColumnLabelEditingState]
  );

  const isColumnSelected = useCallback(
    (column: number): boolean => {
      if (activeSelection.kind !== 'column-letters' || !selection || rows === 0) return false;
      return (
        selection.startCol <= column &&
        selection.endCol >= column &&
        selection.startRow === 0 &&
        selection.endRow === rows - 1
      );
    },
    [activeSelection.kind, rows, selection]
  );

  const isLabelSelected = useCallback(
    (column: number): boolean => {
      if (!labelSelection) return false;
      return column >= labelSelection.startCol && column <= labelSelection.endCol;
    },
    [labelSelection]
  );

  const startColumnLabelEdit = useCallback(
    (column: number) => {
      if (!canEditColumnLabels || column < 0 || column >= cols) return;
      setColumnLabelEditingState({
        column,
        value: columnLabels?.[column] ?? '',
      });
    },
    [canEditColumnLabels, cols, columnLabels, setColumnLabelEditingState]
  );

  const commitColumnLabelEdit = useCallback(() => {
    if (!editingColumnLabel) return;
    onColumnLabelChange?.(editingColumnLabel.column, editingColumnLabel.value.trim());
    setColumnLabelEditingState(null);
    safeFocus(focusSinkRef.current);
  }, [editingColumnLabel, onColumnLabelChange, setColumnLabelEditingState]);

  const cancelColumnLabelEdit = useCallback(() => {
    setColumnLabelEditingState(null);
    safeFocus(focusSinkRef.current);
  }, [setColumnLabelEditingState]);

  const { handlePaste, handleCopy, handleCut, clearClipboard } = useClipboardOperations({
    displayCells,
    selection: dataCellSelection,
    focusedCell,
    isEditing: !!editingState || !!editingColumnLabel,
    rows,
    cols,
    onPaste: tableGridWhenWritable(readOnly, onPaste, NOOP_FALSE),
    onPasteHTML: tableGridWhenWritable(readOnly, onPasteHTML, undefined),
    onPasteCells: tableGridWhenWritable(readOnly, onPasteCells, undefined),
    onCopyCells,
    onCutCells: tableGridWhenWritable(readOnly, onCutCells, undefined),
    onClearCut,
    onCellChange: tableGridWhenWritable(readOnly, onCellChange, NOOP),
    onExpandAndSetCell: tableGridWhenWritable(readOnly, onExpandAndSetCell, NOOP),
  });

  const getSelectedColumnLabelText = useCallback((): string | null => {
    if (!labelSelection) return null;

    const { startCol, endCol } = labelSelection;
    const columns = Array.from({ length: endCol - startCol + 1 }, (_, i) => startCol + i);
    const headerRow = columns.map((col) => columnLabels?.[col] ?? '').join('\t');

    const bodyRows = Array.from(
      { length: Math.min(rows - 1, selection?.endRow ?? COLUMN_LABEL_SELECTION_ROW) + 1 },
      (_, row) => columns.map((col) => displayValueOf(displayCells[row]?.[col])).join('\t')
    );
    return [headerRow, ...bodyRows].join('\n');
  }, [columnLabels, displayCells, labelSelection, rows, selection]);

  const handleGridClipboard = useCallback(
    (event: React.ClipboardEvent, fallback: (e: React.ClipboardEvent) => void) => {
      if (editingState || editingColumnLabel || isTableClipboardInput(event)) {
        fallback(event);
        return;
      }
      const labelText = getSelectedColumnLabelText();
      if (labelText === null) {
        fallback(event);
        return;
      }
      clearClipboard();
      event.clipboardData.setData('text/plain', labelText);
      event.preventDefault();
    },
    [getSelectedColumnLabelText, clearClipboard, editingState, editingColumnLabel]
  );

  const handleGridCopy = useCallback(
    (event: React.ClipboardEvent) => handleGridClipboard(event, handleCopy),
    [handleGridClipboard, handleCopy]
  );

  const handleGridCut = useCallback(
    (event: React.ClipboardEvent) => handleGridClipboard(event, handleCut),
    [handleGridClipboard, handleCut]
  );

  const [isDragSelecting, setIsDragSelecting] = useState(false);

  const formulaRefAnchorRef = useRef<CellPosition | null>(null);

  const focusSinkRef = useRef<HTMLInputElement>(null);

  const gridRef = useRef<HTMLDivElement>(null);

  const commitEdit = useCallback(
    (navigateDirection?: 'down' | 'right', options: { restoreFocus?: boolean } = {}) => {
      if (!editingState) return;
      const restoreFocus = options.restoreFocus ?? true;

      if (!restoreFocus) clearFocus();

      if (readOnly) {
        applyEditingState(null);
        if (restoreFocus) safeFocus(focusSinkRef.current);
        return;
      }

      const { position, value } = editingState;

      const finalValue = closeUnclosedFormula(value);
      const originalValue = cells[position.row]?.[position.col]?.value ?? '';

      if (finalValue !== originalValue) {
        if (position.row >= rows || position.col >= cols) {
          onExpandAndSetCell(position.row, position.col, finalValue);
        } else {
          onCellChange(position.row, position.col, finalValue);
        }
      }

      applyEditingState(null);

      const row = position.row + (navigateDirection === 'down' ? 1 : 0);
      const col = position.col + (navigateDirection === 'right' ? 1 : 0);
      if (navigateDirection && row < totalRows && col < totalCols) {
        setActiveSelection({ kind: 'cells' });
        setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
      }

      if (restoreFocus) safeFocus(focusSinkRef.current);
    },
    [
      applyEditingState,
      clearFocus,
      editingState,
      readOnly,
      cells,
      rows,
      cols,
      onCellChange,
      onExpandAndSetCell,
      totalRows,
      totalCols,
      setSelection,
    ]
  );

  const cancelEdit = useCallback(() => {
    applyEditingState(null);
    safeFocus(focusSinkRef.current);
  }, [applyEditingState]);

  const handleCellClickUnified = useCallback(
    (pos: CellPosition, shiftKey: boolean) => {
      setActiveSelection({ kind: 'cells' });

      const currentEditingState = editingStateRef.current;
      const currentIsEditingFormula = currentEditingState?.value.startsWith('=') ?? false;

      if (readOnly) {
        if (currentEditingState) {
          cancelEdit();
        }
        handleCellClick(pos, shiftKey);
        return;
      }

      if (
        currentEditingState &&
        currentIsEditingFormula &&
        (pos.row !== currentEditingState.position.row ||
          pos.col !== currentEditingState.position.col)
      ) {
        formulaRefAnchorRef.current = pos;

        handleCellClick(pos, shiftKey);
        return;
      }

      if (
        currentEditingState &&
        pos.row === currentEditingState.position.row &&
        pos.col === currentEditingState.position.col
      ) {
        return;
      }

      if (currentEditingState) {
        commitEdit();
      }

      handleCellClick(pos, shiftKey);
    },
    [commitEdit, cancelEdit, handleCellClick, editingState, readOnly]
  );

  const startEditing = useCallback(
    (pos: CellPosition, initialValue?: string, options?: { viaFormulaBar?: boolean }) => {
      if (readOnly) return;

      const cellValue = cells[pos.row]?.[pos.col]?.value ?? '';
      const value = initialValue !== undefined ? initialValue : cellValue;
      const viaFormulaBar = options?.viaFormulaBar ?? false;

      const newState = {
        position: pos,
        value,
        cursorPosition: value.length,
      };
      applyEditingState(newState);

      if (focusSinkRef.current) {
        focusSinkRef.current.value = '';
      }

      clearSelection();

      if (!viaFormulaBar) {
        setTimeout(() => {
          if (editingStateRef.current !== newState) return;
          if (safeFocus(editInputRef.current)) {
            if (initialValue !== undefined) {
              editInputRef.current!.setSelectionRange(value.length, value.length);
            } else {
              editInputRef.current!.select();
            }
          }
        }, 0);
      }
    },
    [applyEditingState, cells, clearSelection, editingState, readOnly]
  );

  const handleCellDoubleClick = useCallback(
    (pos: CellPosition) => {
      if (readOnly) return;

      if (
        editingState &&
        (pos.row !== editingState.position.row || pos.col !== editingState.position.col)
      ) {
        commitEdit();
      }
      startEditing(pos);
    },
    [editingState, commitEdit, startEditing, readOnly]
  );

  const handleCellChange = useCallback(
    (row: number, col: number, value: string) => {
      if (readOnly) return;

      if (row >= rows || col >= cols) {
        onExpandAndSetCell(row, col, value);
      } else {
        onCellChange(row, col, value);
      }
    },
    [rows, cols, onCellChange, onExpandAndSetCell, readOnly]
  );

  const handleDragSelectStart = useCallback(() => {
    setIsDragSelecting(true);
  }, []);

  const handleDragSelectMove = useCallback(
    (pos: CellPosition) => {
      if (isDragSelecting) {
        extendSelectionTo(pos);
      }
    },
    [isDragSelecting, extendSelectionTo]
  );

  const handleDragSelectEnd = useCallback(() => {
    setIsDragSelecting(false);

    const anchor = formulaRefAnchorRef.current;
    const currentEditingState = editingStateRef.current;

    if (anchor && currentEditingState) {
      formulaRefAnchorRef.current = null;

      const referenceText = buildFormulaReferenceText(anchor, selection);

      const { value, cursorPosition } = currentEditingState;
      const { newValue, newCursorPosition } = insertCellReferenceAtCursor(
        value,
        cursorPosition,
        referenceText
      );

      const newState = {
        ...currentEditingState,
        value: newValue,
        cursorPosition: newCursorPosition,
      };
      applyEditingState(newState);

      setTimeout(() => {
        if (safeFocus(editInputRef.current)) {
          editInputRef.current!.setSelectionRange(newCursorPosition, newCursorPosition);
        }
      }, 0);

      return;
    }

    if (!editingStateRef.current) {
      safeFocus(focusSinkRef.current);
    }
  }, [applyEditingState, selection]);

  const handleFillDoubleClick = useCallback(() => {
    if (readOnly) return;
    if (!dataCellSelection) return;

    let targetRow = dataCellSelection.endRow;
    const checkCol =
      dataCellSelection.startCol > 0
        ? dataCellSelection.startCol - 1
        : dataCellSelection.endCol + 1;

    if (checkCol < cols) {
      for (let row = dataCellSelection.endRow + 1; row < rows; row++) {
        const cell = displayCells[row]?.[checkCol];
        if (!cell || cell.value === '') {
          break;
        }
        targetRow = row;
      }
    }

    if (targetRow > dataCellSelection.endRow) {
      const targetRange: SelectionRange = {
        startRow: dataCellSelection.startRow,
        startCol: dataCellSelection.startCol,
        endRow: targetRow,
        endCol: dataCellSelection.endCol,
      };
      onFillRange(dataCellSelection, targetRange);
    }
  }, [dataCellSelection, displayCells, rows, cols, onFillRange, readOnly]);

  const {
    effectiveSelection,
    selectionFormatState,
    toggleBold,
    toggleItalic,
    toggleUnderline,
    toggleStrikethrough,
    setAlign,
    setTextColor,
    setBgColor,
  } = useFormatting({
    cells,
    selection: dataCellSelection,
    focusedCell,
    onCellFormat,
  });

  const handleGridKeyDown = (e: React.KeyboardEvent) => {
    if (handleFindShortcut(e)) {
      return;
    }

    if (
      consumeFocusSinkWhileEditing(e, {
        editingStateRef,
        editInputRef,
        focusSinkRef,
        setEditingState: applyEditingState,
      })
    ) {
      return;
    }

    if (
      consumeUndoRedoShortcut(e, {
        readOnly,
        onUndo,
        onRedo,
        setActiveSelection,
        setSelection,
      })
    ) {
      return;
    }

    if (
      consumeTableGridFormatShortcut(e, {
        readOnly,
        onCellFormat,
        toggleBold,
        toggleItalic,
        toggleUnderline,
        toggleStrikethrough,
      })
    ) {
      return;
    }

    e.stopPropagation();

    if (
      consumeLabelSelectionKeys(e, {
        labelSelection,
        labelOnlySelection,
        canEditColumnLabels,
        startColumnLabelEdit,
        setActiveSelection,
      })
    ) {
      return;
    }

    if (!focusedCell) return;

    if ((e.key === 'Delete' || e.key === 'Backspace') && dataCellSelection) {
      if (readOnly) {
        e.preventDefault();
        return;
      }

      const isMultiCell =
        dataCellSelection.startRow !== dataCellSelection.endRow ||
        dataCellSelection.startCol !== dataCellSelection.endCol;

      if (isMultiCell) {
        e.preventDefault();
        onDeleteRange(dataCellSelection);
        return;
      }
      e.preventDefault();
      handleCellChange(dataCellSelection.startRow, dataCellSelection.startCol, '');
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (cutRange) {
        onClearCut?.();
        return;
      }
      clearFocus();
      return;
    }

    const goesToKeyboardNav =
      isTableGridNavigationKey(e.key) ||
      ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A'));
    if (goesToKeyboardNav) {
      handleKeyDown(e, focusSinkRef);
      return;
    }

    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      if (readOnly) return;
      startEditing(focusedCell);
      return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (readOnly) return;
      startEditing(focusedCell, e.key);
    }
  };

  const focusedCellRawValue = tableGridFocusedCellRawValue(focusedCell, cells);
  const formulaBarValue = tableGridFormulaBarValue(editingState?.value, focusedCellRawValue);
  const focusedCellAddress = tableGridFocusedCellAddress(focusedCell, columnIndexToLetter);
  const formatControlsDisabled = tableGridFormatControlsDisabled(effectiveSelection, onCellFormat);
  const overflowX = tableGridOverflowX(overflowsX);

  const formulaBarInputRef = useRef<HTMLInputElement>(null);

  const handleFormulaBarChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (readOnly) return;
      if (editingState) {
        const input = e.target;
        const newState = {
          ...editingState,
          value: e.target.value,
          cursorPosition: input.selectionStart ?? e.target.value.length,
        };
        applyEditingState(newState);
      } else if (focusedCell) {
        startEditing(focusedCell, e.target.value, { viaFormulaBar: true });
      }
    },
    [applyEditingState, editingState, focusedCell, startEditing, readOnly]
  );

  const handleFormulaBarBlur = useCallback(() => {
    if (readOnly) return;
    if (editingState) {
      commitEdit();
    }
  }, [editingState, commitEdit, readOnly]);

  const handleFormulaBarKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (readOnly) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (editingState) {
          commitEdit('down');
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    },
    [editingState, commitEdit, cancelEdit, readOnly]
  );

  const handleFormulaBarFocus = useCallback(() => {
    if (readOnly) return;
    if (!editingState && focusedCell) {
      startEditing(focusedCell, undefined, { viaFormulaBar: true });
    }
  }, [editingState, focusedCell, startEditing, readOnly]);

  const handleGridClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.closest('input')) {
      return;
    }
    if (!target.closest('[data-cell-position]') && gridRef.current) {
      safeFocus(gridRef.current);
    }
  }, []);

  const handleSinkBlur = useCallback(
    (e: React.FocusEvent) => {
      const relatedTarget = e.relatedTarget as HTMLElement | null;

      if (editingState) return;

      if (
        relatedTarget?.classList?.contains('table-focus-sink') ||
        (relatedTarget?.closest?.('[data-cell-position]') &&
          !gridRef.current?.contains(relatedTarget))
      ) {
        clearFocus();
        return;
      }

      if (relatedTarget instanceof HTMLInputElement) {
        const cellWrapper = relatedTarget.closest('[data-cell-position]');
        if (cellWrapper && gridRef.current?.contains(cellWrapper)) return;
      }

      if (relatedTarget === gridRef.current) {
        if (focusedCell) safeFocus(focusSinkRef.current);
        return;
      }

      if (relatedTarget && gridRef.current?.contains(relatedTarget)) return;
      const embedWrapper =
        gridRef.current?.closest('[data-embed-type]') ||
        gridRef.current?.closest('.border.rounded-lg');
      if (relatedTarget && embedWrapper?.contains(relatedTarget)) return;

      clearFocus();
    },
    [clearFocus, focusedCell, editingState]
  );

  useLayoutEffect(() => {
    if (focusedCell && !editingState) {
      safeFocus(focusSinkRef.current);
    }
  }, [focusedCell, editingState]);

  const hasAutoFocused = useRef(false);
  useLayoutEffect(() => {
    if (!autoFocus || hasAutoFocused.current || readOnly || rows === 0 || cols === 0) return;
    hasAutoFocused.current = true;
    setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
  }, [autoFocus, readOnly, rows, cols, setSelection]);

  const handleEditingValueChange = useCallback(
    (value: string, cursorPosition: number) => {
      const currentEditingState = editingStateRef.current;
      if (!currentEditingState) return;
      applyEditingState({ ...currentEditingState, value, cursorPosition });
    },
    [applyEditingState]
  );

  if (tableGridIsEmpty(rows, cols)) {
    return <div className="p-4 text-center text-fg-muted text-sm">No table data</div>;
  }

  return (
    <div
      ref={gridRef}
      tabIndex={-1}
      onClick={handleGridClick}
      onPaste={tableGridWhenWritable(readOnly, handlePaste, undefined)}
      onCopy={handleGridCopy}
      onCut={tableGridWhenWritable(readOnly, handleGridCut, undefined)}
      onKeyDown={handleFindShortcut}
      {...TELEMETRY_BLOCKED_ATTRIBUTES}
      data-ph-mask="true"
      className={`${TELEMETRY_BLOCKED_CLASS} outline-none relative`}
      data-table-root="true"
      data-testid="table-grid"
      data-read-only={readOnly ? 'true' : undefined}
    >
      {}
      <input
        ref={focusSinkRef}
        type="text"
        className="table-focus-sink"
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          opacity: 0,
          width: 1,
          height: 1,
          padding: 0,
          margin: 0,
          border: 'none',
          pointerEvents: 'none',
        }}
        onKeyDown={handleGridKeyDown}
        onBlur={handleSinkBlur}
        aria-label="Table keyboard navigation"
        tabIndex={0}
      />
      <TableGridFindOverlay
        isFindOpen={isFindOpen}
        searchActive={searchActive}
        globalSearch={globalSearch}
        setGlobalSearch={setGlobalSearch}
        closeFind={closeFind}
        findInputRef={findInputRef}
        searchedCount={searchedVisibleRowIndices.length}
        visibleCount={visibleRowIndices.length}
      />
      <TableGridFormulaBar
        visible={shouldShowFormulaBar}
        formatDisabled={formatControlsDisabled}
        selectionFormatState={selectionFormatState}
        toggleBold={toggleBold}
        toggleItalic={toggleItalic}
        toggleUnderline={toggleUnderline}
        toggleStrikethrough={toggleStrikethrough}
        setAlign={setAlign}
        setTextColor={setTextColor}
        setBgColor={setBgColor}
        focusedCellAddress={focusedCellAddress}
        formulaBarValue={formulaBarValue}
        formulaBarInputRef={formulaBarInputRef}
        onFormulaBarChange={handleFormulaBarChange}
        onFormulaBarBlur={handleFormulaBarBlur}
        onFormulaBarKeyDown={handleFormulaBarKeyDown}
        onFormulaBarFocus={handleFormulaBarFocus}
        focusedCell={focusedCell}
      />
      {}
      <div
        ref={gridScrollRef}
        data-testid="table-grid-scroll"
        data-overflow-x={overflowX.dataOverflowX}
        className={overflowX.className}
      >
        <div className="inline-flex">
          <table
            className="border-collapse text-sm"
            style={{
              tableLayout: 'fixed',
              width:
                40 +
                Array.from({ length: totalCols }).reduce<number>(
                  (sum, _, i) => sum + getColWidth(i),
                  0
                ),
            }}
          >
            <colgroup>
              <col style={{ width: 40 }} />
              {Array.from({ length: totalCols }).map((_, colIndex) => (
                <col key={colIndex} style={{ width: getColWidth(colIndex) }} />
              ))}
            </colgroup>
            {}
            <thead>
              <tr
                hidden={!showCoordinateHeaders}
                data-testid="table-column-letters-row"
                className="h-5 bg-bg-subtle border-b border-border leading-none"
              >
                {}
                <th className="h-5 p-0 w-10 min-w-[40px] bg-bg-subtle border-r border-border sticky left-0 z-10" />
                {Array.from({ length: totalCols }).map((_, colIndex) => {
                  const isGhost = colIndex >= cols;
                  const colWidth = getColWidth(colIndex);
                  const columnLabel = columnIndexToLetter(colIndex);
                  const columnSelected = isColumnSelected(colIndex);
                  const isLeftEdge = selection?.startCol === colIndex;
                  const isRightEdge = selection?.endCol === colIndex;
                  return (
                    <th
                      key={colIndex}
                      style={{ width: colWidth, minWidth: MIN_COL_WIDTH }}
                      aria-selected={!isGhost && columnSelected ? true : undefined}
                      data-testid={`table-column-header-${columnLabel}`}
                      data-table-header-col={colIndex}
                      data-table-header-kind="letters"
                      className={`p-0 text-center font-medium relative ${
                        isGhost
                          ? 'bg-bg-muted/20 border-r border-border/30'
                          : columnSelected
                            ? 'bg-accent/10 border-r border-accent/30'
                            : 'bg-bg-subtle border-r border-border'
                      }`}
                    >
                      {!isGhost && columnSelected && (
                        <div
                          aria-hidden="true"
                          data-testid={`table-column-header-selection-${columnLabel}`}
                          className={[
                            'pointer-events-none absolute -inset-px z-20 border-accent/75',
                            'border-t-[1.5px] border-b-[1.5px]',
                            isLeftEdge && 'border-l-[1.5px]',
                            isRightEdge && 'border-r-[1.5px]',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        />
                      )}
                      <button
                        type="button"
                        disabled={isGhost}
                        onMouseDown={(e) => {
                          if (isGhost) return;
                          if (e.detail > 1) return;
                          beginHeaderSelection('letters', colIndex, e);
                        }}
                        onMouseEnter={() => {
                          if (isGhost) return;
                          extendHeaderSelectionToColumn(colIndex);
                        }}
                        onClick={(e) => {
                          if (isGhost) return;
                          e.stopPropagation();
                          if (suppressHeaderClickRef.current) {
                            suppressHeaderClickRef.current = false;
                            return;
                          }
                          selectColumnRange(colIndex, colIndex);
                        }}
                        className={`relative z-10 flex h-5 w-full items-center justify-center truncate px-1.5 py-0 text-[11px] font-medium leading-none outline-none ${
                          isGhost
                            ? 'cursor-default text-fg-muted/30'
                            : columnSelected
                              ? 'cursor-pointer text-accent'
                              : 'cursor-pointer text-fg-muted hover:bg-bg-muted hover:text-fg'
                        }`}
                        title={`Select column ${columnLabel}`}
                        aria-label={`Select column ${columnLabel}`}
                      >
                        {columnLabel}
                      </button>
                      {}
                      {!isGhost && onColumnResize && (
                        <div
                          data-column-resize-handle="true"
                          className="absolute top-0 right-[-2px] w-[5px] h-full cursor-col-resize z-50 hover:bg-blue-500/50"
                          title="Drag to resize · double-click to fit"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleResizeStart(colIndex, e);
                          }}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            autoFitColumn(colIndex);
                          }}
                        />
                      )}
                    </th>
                  );
                })}
              </tr>
              {shouldShowColumnLabels && (
                <tr
                  data-testid="table-column-labels-row"
                  className="h-5 bg-bg border-b border-border leading-none"
                >
                  <th className="h-5 p-0 w-10 min-w-[40px] bg-bg border-r border-border sticky left-0 z-10" />
                  {Array.from({ length: totalCols }).map((_, colIndex) => {
                    const isGhost = colIndex >= cols;
                    const colWidth = getColWidth(colIndex);
                    const columnLetter = columnIndexToLetter(colIndex);
                    const label = columnLabels?.[colIndex]?.trim() ?? '';
                    const editingThisLabel = editingColumnLabel?.column === colIndex;
                    const labelSelected = isLabelSelected(colIndex);
                    const isLeftEdge = labelSelection?.startCol === colIndex;
                    return (
                      <th
                        key={colIndex}
                        style={{ width: colWidth, minWidth: MIN_COL_WIDTH }}
                        aria-selected={!isGhost && labelSelected ? true : undefined}
                        data-testid={`table-column-label-cell-${colIndex}`}
                        data-cell-position={`${COLUMN_LABEL_SELECTION_ROW},${colIndex}`}
                        data-table-header-col={colIndex}
                        data-table-header-kind="labels"
                        onMouseDownCapture={(e) => {
                          if (isGhost || !canEditColumnLabels || e.detail <= 1) return;
                          e.preventDefault();
                          e.stopPropagation();
                          startColumnLabelEdit(colIndex);
                        }}
                        onDoubleClickCapture={(e) => {
                          if (isGhost || !canEditColumnLabels) return;
                          e.preventDefault();
                          e.stopPropagation();
                          startColumnLabelEdit(colIndex);
                        }}
                        className={`p-0 text-left font-medium relative ${
                          isGhost
                            ? 'bg-bg-muted/10 border-r border-border/30'
                            : labelSelected
                              ? 'bg-accent/5 border-r border-accent/30'
                              : 'bg-bg border-r border-border'
                        }`}
                      >
                        {editingThisLabel ? (
                          <input
                            ref={columnLabelInputRef}
                            value={editingColumnLabel.value}
                            onChange={(event) =>
                              setColumnLabelEditingState({
                                column: colIndex,
                                value: event.target.value,
                              })
                            }
                            onBlur={commitColumnLabelEdit}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                commitColumnLabelEdit();
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelColumnLabelEdit();
                              }
                            }}
                            data-testid={`table-column-label-input-${colIndex}`}
                            aria-label={`Column ${columnLetter} label`}
                            className="block h-5 w-full border-0 bg-bg px-1.5 py-0 text-[11px] leading-none text-fg outline-none ring-1 ring-accent"
                          />
                        ) : (
                          <>
                            {!isGhost && labelSelected && isLeftEdge && (
                              <div
                                aria-hidden="true"
                                data-testid="table-promoted-row-selection-range"
                                className={`pointer-events-none absolute -left-px -top-[2px] bottom-[-2px] z-20 border-accent/70 bg-fg/[0.08] border-l-[1.5px] border-r-[1.5px] border-t-[1.5px] ${
                                  labelSelectionExtendsIntoCells ? '' : 'border-b-[1.5px]'
                                }`}
                                style={{ width: labelSelectionRangeWidth + 2 }}
                              />
                            )}
                            <button
                              type="button"
                              disabled={isGhost}
                              onMouseDown={(e) => {
                                if (isGhost) return;
                                if (e.detail > 1) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  startColumnLabelEdit(colIndex);
                                  return;
                                }
                                beginHeaderSelection('labels', colIndex, e);
                              }}
                              onMouseEnter={() => {
                                if (isGhost) return;
                                extendHeaderSelectionToColumn(colIndex);
                              }}
                              onClick={(e) => {
                                if (isGhost) return;
                                e.stopPropagation();
                                if (suppressHeaderClickRef.current) {
                                  suppressHeaderClickRef.current = false;
                                  return;
                                }
                                selectLabelRange(colIndex, colIndex);
                              }}
                              onDoubleClick={(e) => {
                                if (isGhost) return;
                                e.stopPropagation();
                                startColumnLabelEdit(colIndex);
                              }}
                              onKeyDown={(e) => {
                                if (isGhost) return;
                                if (e.key === 'Enter' && canEditColumnLabels) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  startColumnLabelEdit(colIndex);
                                } else if (e.key === ' ' || e.key === 'Spacebar') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  selectLabelRange(colIndex, colIndex);
                                }
                              }}
                              data-testid={`table-column-label-${colIndex}`}
                              data-cell-position={`${COLUMN_LABEL_SELECTION_ROW},${colIndex}`}
                              className={`relative z-30 flex h-5 w-full items-center truncate px-1.5 py-0 text-left text-[11px] leading-none outline-none ${
                                isGhost
                                  ? 'cursor-default text-fg-muted/30'
                                  : labelSelected
                                    ? 'cursor-pointer text-accent'
                                    : canEditColumnLabels
                                      ? 'cursor-pointer text-fg hover:bg-bg-muted'
                                      : 'cursor-pointer text-fg'
                              }`}
                              title={
                                label ||
                                (canEditColumnLabels ? `Edit column ${columnLetter} label` : '')
                              }
                              aria-label={`Column ${columnLetter} label${label ? `: ${label}` : ''}`}
                            >
                              {label || ' '}
                            </button>
                          </>
                        )}
                      </th>
                    );
                  })}
                </tr>
              )}
            </thead>
            <tbody>
              {}
              {Array.from({ length: renderedRowCount }).map((_, rowDisplayIndex) => {
                const isGhostRow = !searchActive && rowDisplayIndex >= visibleRowIndices.length;
                const rowIndex = isGhostRow
                  ? rows + (rowDisplayIndex - visibleRowIndices.length)
                  : searchedVisibleRowIndices[rowDisplayIndex];

                const displayRowNum = rowIndex + 1;

                const rowSelected = !isGhostRow && isRowSelected(rowIndex);
                const explicitRowHeight = isGhostRow ? undefined : getRowHeight(rowIndex);
                return (
                  <tr
                    key={`row-${rowDisplayIndex}`}
                    style={explicitRowHeight ? { height: explicitRowHeight } : undefined}
                    className={`last:border-b-0 ${
                      isGhostRow ? 'border-b border-border/30' : 'border-b border-border'
                    }`}
                  >
                    {}
                    <td
                      aria-selected={rowSelected ? true : undefined}
                      data-table-row-header={isGhostRow ? undefined : rowIndex}
                      className={`relative p-0 w-10 min-w-[40px] sticky left-0 z-10 ${
                        isGhostRow
                          ? 'bg-bg-muted/20 border-r border-border/30'
                          : rowSelected
                            ? 'bg-accent/10 border-r border-accent/30'
                            : 'bg-bg-subtle border-r border-border'
                      }`}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        if (isGhostRow) return;
                        e.preventDefault();
                        rowDragAnchorRef.current = rowIndex;
                        if (e.shiftKey && selection && activeSelection.kind === 'row-numbers') {
                          selectRowRange(selection.startRow, rowIndex);
                        } else {
                          selectRowRange(rowIndex, rowIndex);
                        }
                        const onUp = () => {
                          rowDragAnchorRef.current = null;
                          document.removeEventListener('mouseup', onUp);
                        };
                        document.addEventListener('mouseup', onUp);
                      }}
                      onMouseEnter={() => {
                        if (isGhostRow) return;
                        if (rowDragAnchorRef.current !== null) {
                          selectRowRange(rowDragAnchorRef.current, rowIndex);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {rowSelected && (
                        <div
                          aria-hidden="true"
                          data-testid={`table-row-header-selection-${rowIndex}`}
                          className="pointer-events-none absolute -inset-px z-20 border-l-[1.5px] border-r-[1.5px] border-accent/75"
                        />
                      )}
                      <div
                        className={`flex h-full items-center justify-center px-2 py-1 text-xs ${
                          isGhostRow
                            ? 'text-fg-muted/30'
                            : rowSelected
                              ? 'cursor-pointer text-accent'
                              : 'cursor-pointer text-fg-muted hover:text-fg'
                        }`}
                        title={isGhostRow ? undefined : `Select row ${displayRowNum}`}
                      >
                        {displayRowNum}
                      </div>
                      {}
                      {!isGhostRow && onRowResize && (
                        <div
                          data-row-resize-handle="true"
                          className="absolute left-0 bottom-[-2px] h-[5px] w-full cursor-row-resize z-50 hover:bg-blue-500/50"
                          title="Drag to resize row"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleRowResizeStart(rowIndex, e);
                          }}
                        />
                      )}
                    </td>
                    {Array.from({ length: totalCols }).map((_, colIndex) => {
                      const isGhostCol = colIndex >= cols;
                      const isGhost = isGhostRow || isGhostCol;
                      const position: CellPosition = { row: rowIndex, col: colIndex };
                      const isFocused =
                        focusedCell?.row === rowIndex && focusedCell?.col === colIndex;

                      const cell = isGhost
                        ? EMPTY_CELL
                        : displayCells[rowIndex]?.[colIndex] || EMPTY_CELL;

                      const isSelected =
                        isInSelection(rowIndex, colIndex) || isInFillPreview(rowIndex, colIndex);

                      const isEditingThisCell =
                        editingState?.position.row === rowIndex &&
                        editingState?.position.col === colIndex;

                      const mergeKey = `${rowIndex}:${colIndex}`;
                      if (!isGhost && mergeProjection.coveredByAnchor.has(mergeKey)) return null;
                      const span = isGhost ? undefined : mergeProjection.anchors.get(mergeKey);

                      return (
                        <td
                          key={colIndex}
                          colSpan={span && span.cols > 1 ? span.cols : undefined}
                          rowSpan={span && span.rows > 1 ? span.rows : undefined}
                          style={
                            !isGhost && cell.format?.bgColor
                              ? { backgroundColor: cell.format.bgColor }
                              : undefined
                          }
                          className={tableGridDataCellClasses(isGhost)}
                          onClick={(e) => {
                            if (e.target === e.currentTarget) {
                              handleCellClickUnified(position, e.shiftKey);
                            }
                          }}
                          onMouseDown={(e) => {
                            if (e.target === e.currentTarget) {
                              handleDragSelectStart();
                            }
                          }}
                        >
                          <TableCell
                            cell={cell}
                            position={position}
                            isFocused={isFocused}
                            isSelected={isSelected}
                            isCut={isInRange(rowIndex, colIndex, cutRange)}
                            selectionBounds={selection}
                            cutBounds={cutRange}
                            isGhost={isGhost}
                            showFillHandle={
                              !readOnly && showFillHandleFor(rowIndex, colIndex) && !editingState
                            }
                            isEditing={isEditingThisCell}
                            editingValue={isEditingThisCell ? editingState.value : ''}
                            editInputRef={isEditingThisCell ? editInputRef : undefined}
                            referenceWorkspaceRoot={referenceWorkspaceRoot}
                            onCellClick={handleCellClickUnified}
                            onCellDoubleClick={handleCellDoubleClick}
                            onEditingValueChange={handleEditingValueChange}
                            onEditCommit={commitEdit}
                            onEditCancel={cancelEdit}
                            onFillStart={handleFillStart}
                            onFillMove={handleFillMove}
                            onFillEnd={handleFillEnd}
                            onFillDoubleClick={handleFillDoubleClick}
                            onDragSelectStart={handleDragSelectStart}
                            onDragSelectMove={handleDragSelectMove}
                            onDragSelectEnd={handleDragSelectEnd}
                            cellRef={getCellRef(rowIndex, colIndex)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {}
        <TableGridFilterStatus
          visible={tableGridFilterStatusVisible(Object.keys(filters).length, searchActive)}
          shown={searchedVisibleRowIndices.length}
          total={rows}
        />
      </div>
    </div>
  );
}
