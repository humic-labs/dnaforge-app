import { useState, useCallback, useRef, useMemo } from 'react';
import type { CellPosition, SelectionRange } from '../types';

interface UseKeyboardNavProps {
  rows: number;
  cols: number;
  dataRows?: number;
  dataCols?: number;
  onTabFromLastCell?: () => void;
  onEscape?: () => boolean;
  resolveFocusable?: (position: CellPosition) => CellPosition;
}

interface UseKeyboardNavResult {
  focusedCell: CellPosition | null;
  setFocusedCell: (pos: CellPosition | null) => void;
  selection: SelectionRange | null;
  isInSelection: (row: number, col: number) => boolean;
  handleCellClick: (pos: CellPosition, shiftKey: boolean) => void;
  extendSelectionTo: (pos: CellPosition) => void;
  handleKeyDown: (
    e: React.KeyboardEvent,
    inputRef: React.RefObject<HTMLInputElement | null>
  ) => void;
  getCellRef: (row: number, col: number) => React.RefCallback<HTMLDivElement>;
  clearSelection: () => void;
  clearFocus: () => void;
  selectAll: () => void;
  setSelection: (range: SelectionRange) => void;
  scrollFocusedCellIntoView: () => void;
}

function normalizeRange(anchor: CellPosition, current: CellPosition): SelectionRange {
  return {
    startRow: Math.min(anchor.row, current.row),
    startCol: Math.min(anchor.col, current.col),
    endRow: Math.max(anchor.row, current.row),
    endCol: Math.max(anchor.col, current.col),
  };
}

export function useKeyboardNav({
  rows,
  cols,
  dataRows,
  dataCols,
  onTabFromLastCell,
  onEscape,
  resolveFocusable,
}: UseKeyboardNavProps): UseKeyboardNavResult {
  const [focusedCell, setFocusedCell] = useState<CellPosition | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<CellPosition | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<CellPosition | null>(null);
  const cellRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const cellRefCallbacks = useRef<Map<string, React.RefCallback<HTMLDivElement>>>(new Map());

  const getCellKey = (row: number, col: number) => `${row}-${col}`;

  const getCellRef = useCallback((row: number, col: number): React.RefCallback<HTMLDivElement> => {
    const key = getCellKey(row, col);
    const existing = cellRefCallbacks.current.get(key);
    if (existing) return existing;
    const callback: React.RefCallback<HTMLDivElement> = (el) => {
      if (el) {
        cellRefs.current.set(key, el);
      } else {
        cellRefs.current.delete(key);
        cellRefCallbacks.current.delete(key);
      }
    };
    cellRefCallbacks.current.set(key, callback);
    return callback;
  }, []);

  const selection = useMemo((): SelectionRange | null => {
    const effectiveEnd = selectionEnd ?? focusedCell;
    if (effectiveEnd && selectionAnchor) {
      return normalizeRange(selectionAnchor, effectiveEnd);
    }
    if (focusedCell) {
      return {
        startRow: focusedCell.row,
        startCol: focusedCell.col,
        endRow: focusedCell.row,
        endCol: focusedCell.col,
      };
    }
    return null;
  }, [selectionEnd, focusedCell, selectionAnchor]);

  const isInSelection = useCallback(
    (row: number, col: number): boolean => {
      if (!selection) return false;
      return (
        row >= selection.startRow &&
        row <= selection.endRow &&
        col >= selection.startCol &&
        col <= selection.endCol
      );
    },
    [selection]
  );

  const focusCellAt = useCallback(
    (row: number, col: number, extendSelection = false) => {
      const newPos = resolveFocusable ? resolveFocusable({ row, col }) : { row, col };
      setFocusedCell(newPos);
      setSelectionEnd(null);
      if (!extendSelection) {
        setSelectionAnchor(newPos);
      }

      const key = getCellKey(newPos.row, newPos.col);
      const cell = cellRefs.current.get(key);
      cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    [resolveFocusable]
  );

  const handleCellClick = useCallback(
    (pos: CellPosition, shiftKey: boolean) => {
      console.log('[useKeyboardNav] handleCellClick', {
        pos,
        shiftKey,
        currentFocusedCell: focusedCell,
        currentAnchor: selectionAnchor,
      });
      if (shiftKey && selectionAnchor) {
        setSelectionEnd(pos);
      } else {
        const target = resolveFocusable ? resolveFocusable(pos) : pos;
        setSelectionEnd(null);
        setFocusedCell(target);
        setSelectionAnchor(target);
        console.log('[useKeyboardNav] Set new focused cell', target);
      }
    },
    [selectionAnchor, focusedCell, resolveFocusable]
  );

  const extendSelectionTo = useCallback((pos: CellPosition) => {
    setSelectionEnd(pos);
    setFocusedCell(pos);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectionEnd(null);
    if (focusedCell) {
      setSelectionAnchor(focusedCell);
    }
  }, [focusedCell]);

  const clearFocus = useCallback(() => {
    console.log('[useKeyboardNav] clearFocus called', {
      previousFocusedCell: focusedCell,
      previousAnchor: selectionAnchor,
    });
    setFocusedCell(null);
    setSelectionAnchor(null);
    setSelectionEnd(null);
  }, [focusedCell, selectionAnchor]);

  const selectAll = useCallback(() => {
    const selectRows = dataRows ?? rows;
    const selectCols = dataCols ?? cols;
    if (selectRows === 0 || selectCols === 0) return;

    setSelectionAnchor({ row: 0, col: 0 });
    const lastRow = selectRows - 1;
    const lastCol = selectCols - 1;
    setSelectionEnd({ row: lastRow, col: lastCol });

    if (!focusedCell) {
      setFocusedCell({ row: 0, col: 0 });
    }
  }, [rows, cols, dataRows, dataCols, focusedCell]);

  const setSelection = useCallback((range: SelectionRange) => {
    if (range.startRow === range.endRow && range.startCol === range.endCol) {
      const pos = { row: range.startRow, col: range.startCol };
      setFocusedCell(pos);
      setSelectionAnchor(pos);
      setSelectionEnd(null);
      const key = getCellKey(pos.row, pos.col);
      const cell = cellRefs.current.get(key);
      cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      setSelectionAnchor({ row: range.startRow, col: range.startCol });
      setSelectionEnd({ row: range.endRow, col: range.endCol });
      setFocusedCell({ row: range.startRow, col: range.startCol });
      const key = getCellKey(range.startRow, range.startCol);
      const cell = cellRefs.current.get(key);
      cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, []);

  const scrollFocusedCellIntoView = useCallback(() => {
    if (focusedCell) {
      const key = getCellKey(focusedCell.row, focusedCell.col);
      const cell = cellRefs.current.get(key);
      cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [focusedCell]);

  const PAGE_SIZE = 20;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, _inputRef: React.RefObject<HTMLInputElement | null>) => {
      if (!focusedCell) return;
      const { row, col } = focusedCell;
      const extendSelection = e.shiftKey;
      const jumpToEdge = e.metaKey || e.ctrlKey;

      const maxRow = (dataRows ?? rows) - 1;
      const maxCol = (dataCols ?? cols) - 1;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          if (jumpToEdge) {
            focusCellAt(0, col, extendSelection);
          } else if (row > 0) {
            focusCellAt(row - 1, col, extendSelection);
          }
          break;

        case 'ArrowDown':
          e.preventDefault();
          if (jumpToEdge) {
            focusCellAt(maxRow, col, extendSelection);
          } else if (row < rows - 1) {
            focusCellAt(row + 1, col, extendSelection);
          }
          break;

        case 'ArrowLeft':
          e.preventDefault();
          if (jumpToEdge) {
            focusCellAt(row, 0, extendSelection);
          } else if (col > 0) {
            focusCellAt(row, col - 1, extendSelection);
          }
          break;

        case 'ArrowRight':
          e.preventDefault();
          if (jumpToEdge) {
            focusCellAt(row, maxCol, extendSelection);
          } else if (col < cols - 1) {
            focusCellAt(row, col + 1, extendSelection);
          }
          break;

        case 'Tab':
          e.preventDefault();
          if (e.shiftKey) {
            if (col > 0) {
              focusCellAt(row, col - 1, false);
            } else if (row > 0) {
              focusCellAt(row - 1, cols - 1, false);
            }
          } else {
            if (col < cols - 1) {
              focusCellAt(row, col + 1, false);
            } else if (row < rows - 1) {
              focusCellAt(row + 1, 0, false);
            } else if (onTabFromLastCell) {
              onTabFromLastCell();
              setTimeout(() => {
                focusCellAt(rows, 0, false);
              }, 0);
            }
          }
          break;

        case 'Enter':
          if (row < rows - 1) {
            e.preventDefault();
            focusCellAt(row + 1, col, false);
          }
          break;

        case 'Escape':
          e.preventDefault();
          if (onEscape?.()) {
            break;
          }
          setFocusedCell(null);
          setSelectionAnchor(null);
          setSelectionEnd(null);
          break;

        case 'PageUp': {
          e.preventDefault();
          const pageUpRow = Math.max(0, row - PAGE_SIZE);
          focusCellAt(pageUpRow, col, extendSelection);
          break;
        }

        case 'PageDown': {
          e.preventDefault();
          const pageDownRow = Math.min(rows - 1, row + PAGE_SIZE);
          focusCellAt(pageDownRow, col, extendSelection);
          break;
        }

        case 'a':
        case 'A':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            selectAll();
          }
          break;

        case 'Home':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            focusCellAt(0, 0, extendSelection);
          } else {
            focusCellAt(row, 0, extendSelection);
          }
          break;

        case 'End':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            focusCellAt(maxRow, maxCol, extendSelection);
          } else {
            focusCellAt(row, maxCol, extendSelection);
          }
          break;
      }
    },
    [
      focusedCell,
      rows,
      cols,
      dataRows,
      dataCols,
      focusCellAt,
      onTabFromLastCell,
      onEscape,
      selectAll,
      PAGE_SIZE,
    ]
  );

  return {
    focusedCell,
    setFocusedCell,
    selection,
    isInSelection,
    handleCellClick,
    extendSelectionTo,
    handleKeyDown,
    getCellRef,
    clearSelection,
    clearFocus,
    selectAll,
    setSelection,
    scrollFocusedCellIntoView,
  };
}
