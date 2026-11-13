import { useCallback, useRef } from 'react';
import type { Cell, CellPosition, SelectionRange } from '../types';
import { tableCellValue } from '../utils/cell-value';

export const TABLE_CLIPBOARD_OPERATION = 'application/x-dnaforge-table-operation';

interface UseClipboardOperationsOptions {
  displayCells: Cell[][];
  selection: SelectionRange | null;
  focusedCell: CellPosition | null;
  isEditing: boolean;
  rows: number;
  cols: number;
  onPaste: (text: string, startRow: number, startCol: number) => boolean;
  onPasteHTML?: (html: string, startRow: number, startCol: number) => boolean;
  onPasteCells?: (
    startRow: number,
    startCol: number,
    cellData: Cell[][],
    isCut?: boolean,
    sourceRange?: SelectionRange
  ) => void;
  onCopyCells?: (range: SelectionRange) => Cell[][];
  onCutCells?: (range: SelectionRange) => Cell[][];
  onClearCut?: () => void;
  onCellChange: (row: number, col: number, value: string, operation?: 'edit' | 'paste') => void;
  onExpandAndSetCell: (
    row: number,
    col: number,
    value: string,
    operation?: 'edit' | 'paste'
  ) => void;
}

interface OwnedClipboard {
  token: string;
  text: string;
  cells: Cell[][];
  range: SelectionRange;
  cut: boolean;
}

export interface TableClipboardEvent {
  readonly clipboardData: Pick<DataTransfer, 'getData' | 'setData'>;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  preventDefault(): void;
}

export function isTableClipboardInput(event: TableClipboardEvent): boolean {
  if (!(event.target instanceof Element)) return false;
  const editor = event.target.closest('input, textarea, [contenteditable="true"]');
  if (!editor || editor.classList.contains('table-focus-sink')) return false;
  if (editor.matches('input, textarea')) return true;
  return event.currentTarget instanceof Node && event.currentTarget.contains(editor);
}

export function useClipboardOperations({
  displayCells,
  selection,
  focusedCell,
  isEditing,
  rows,
  cols,
  onPaste,
  onPasteHTML,
  onPasteCells,
  onCopyCells,
  onCutCells,
  onClearCut,
  onCellChange,
  onExpandAndSetCell,
}: UseClipboardOperationsOptions) {
  const ownedRef = useRef<OwnedClipboard | null>(null);
  const clearClipboard = useCallback(() => {
    ownedRef.current = null;
    onClearCut?.();
  }, [onClearCut]);

  const handlePaste = useCallback(
    (event: TableClipboardEvent) => {
      if (isEditing || isTableClipboardInput(event)) return;
      const text = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
      const html = event.clipboardData.getData('text/html');
      const owned = ownedRef.current;
      const matches =
        owned !== null &&
        event.clipboardData.getData(TABLE_CLIPBOARD_OPERATION) === owned.token &&
        text === owned.text &&
        !html;
      if (!matches) clearClipboard();
      if (!focusedCell) return;
      if (matches && owned && onPasteCells) {
        event.preventDefault();
        onPasteCells(
          focusedCell.row,
          focusedCell.col,
          owned.cells,
          owned.cut,
          owned.cut ? owned.range : undefined
        );
        if (owned.cut) clearClipboard();
        return;
      }
      if (html && onPasteHTML?.(html, focusedCell.row, focusedCell.col)) {
        event.preventDefault();
        return;
      }
      if (text) {
        event.preventDefault();
        if (!onPaste(text, focusedCell.row, focusedCell.col)) {
          if (focusedCell.row >= rows || focusedCell.col >= cols) {
            onExpandAndSetCell(focusedCell.row, focusedCell.col, text, 'paste');
          } else {
            onCellChange(focusedCell.row, focusedCell.col, text, 'paste');
          }
        }
      }
    },
    [
      isEditing,
      focusedCell,
      rows,
      cols,
      clearClipboard,
      onPaste,
      onPasteHTML,
      onPasteCells,
      onCellChange,
      onExpandAndSetCell,
    ]
  );

  const copySelection = useCallback(
    (event: TableClipboardEvent, cut: boolean) => {
      if (isEditing || isTableClipboardInput(event) || !selection) return;
      clearClipboard();
      const lines: string[] = [];
      for (let row = selection.startRow; row <= selection.endRow; row++) {
        const values: string[] = [];
        for (let col = selection.startCol; col <= selection.endCol; col++) {
          const cell = displayCells[row]?.[col];
          values.push(String(tableCellValue(cell)));
        }
        lines.push(values.join('\t'));
      }
      const text = lines.join('\n');
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      const readCells = cut ? onCutCells : onCopyCells;
      if (!readCells) return;
      try {
        const token = globalThis.crypto?.randomUUID?.();
        if (!token) return;
        const cells = readCells(selection);
        event.clipboardData.setData(TABLE_CLIPBOARD_OPERATION, token);
        ownedRef.current = { token, text, cells, range: { ...selection }, cut };
      } catch {
        clearClipboard();
      }
    },
    [isEditing, selection, displayCells, clearClipboard, onCopyCells, onCutCells]
  );

  const handleCopy = useCallback(
    (event: TableClipboardEvent) => copySelection(event, false),
    [copySelection]
  );
  const handleCut = useCallback(
    (event: TableClipboardEvent) => copySelection(event, true),
    [copySelection]
  );
  return { handlePaste, handleCopy, handleCut, clearClipboard };
}
