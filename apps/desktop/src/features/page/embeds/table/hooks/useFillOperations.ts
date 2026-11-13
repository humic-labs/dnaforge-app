import { useState, useCallback, useMemo } from 'react';
import type { CellPosition, SelectionRange } from '../types';

interface UseFillOperationsOptions {
  selection: SelectionRange | null;
  rows: number;
  cols: number;
  onFillRange: (sourceRange: SelectionRange, targetRange: SelectionRange) => void;
}

interface UseFillOperationsReturn {
  isFilling: boolean;
  fillTarget: CellPosition | null;
  fillRange: SelectionRange | null;
  isInFillPreview: (row: number, col: number) => boolean;
  showFillHandleFor: (row: number, col: number) => boolean;
  handleFillStart: () => void;
  handleFillMove: (pos: CellPosition) => void;
  handleFillEnd: () => void;
}

export function useFillOperations({
  selection,
  rows,
  cols,
  onFillRange,
}: UseFillOperationsOptions): UseFillOperationsReturn {
  const [isFilling, setIsFilling] = useState(false);
  const [fillTarget, setFillTarget] = useState<CellPosition | null>(null);

  const getFillRange = useCallback((): SelectionRange | null => {
    if (!selection || !fillTarget) return null;

    return {
      startRow: Math.min(selection.startRow, fillTarget.row),
      startCol: Math.min(selection.startCol, fillTarget.col),
      endRow: Math.max(selection.endRow, fillTarget.row),
      endCol: Math.max(selection.endCol, fillTarget.col),
    };
  }, [selection, fillTarget]);

  const fillRange = useMemo(() => (isFilling ? getFillRange() : null), [isFilling, getFillRange]);

  const isInFillPreview = useCallback(
    (row: number, col: number): boolean => {
      if (!fillRange || !selection) return false;
      const inFillRange =
        row >= fillRange.startRow &&
        row <= fillRange.endRow &&
        col >= fillRange.startCol &&
        col <= fillRange.endCol;
      const inOriginalSelection =
        row >= selection.startRow &&
        row <= selection.endRow &&
        col >= selection.startCol &&
        col <= selection.endCol;
      return inFillRange && !inOriginalSelection;
    },
    [fillRange, selection]
  );

  const showFillHandleFor = useCallback(
    (row: number, col: number): boolean => {
      if (!selection) return false;
      if (row >= rows || col >= cols) return false;
      return row === selection.endRow && col === selection.endCol;
    },
    [selection, rows, cols]
  );

  const handleFillStart = useCallback(() => {
    setIsFilling(true);
  }, []);

  const handleFillMove = useCallback(
    (pos: CellPosition) => {
      if (!selection) return;

      const rowDist = Math.abs(pos.row - selection.endRow);
      const colDist = Math.abs(pos.col - selection.endCol);

      let constrainedPos: CellPosition;
      if (rowDist > colDist) {
        constrainedPos = { row: pos.row, col: selection.endCol };
      } else if (colDist > 0) {
        constrainedPos = { row: selection.endRow, col: pos.col };
      } else {
        constrainedPos = pos;
      }

      setFillTarget(constrainedPos);
    },
    [selection]
  );

  const handleFillEnd = useCallback(() => {
    if (selection && fillTarget) {
      const targetRange = getFillRange();
      if (targetRange) {
        const isDifferent =
          targetRange.startRow !== selection.startRow ||
          targetRange.startCol !== selection.startCol ||
          targetRange.endRow !== selection.endRow ||
          targetRange.endCol !== selection.endCol;
        if (isDifferent) {
          onFillRange(selection, targetRange);
        }
      }
    }
    setIsFilling(false);
    setFillTarget(null);
  }, [selection, fillTarget, getFillRange, onFillRange]);

  return {
    isFilling,
    fillTarget,
    fillRange,
    isInFillPreview,
    showFillHandleFor,
    handleFillStart,
    handleFillMove,
    handleFillEnd,
  };
}
