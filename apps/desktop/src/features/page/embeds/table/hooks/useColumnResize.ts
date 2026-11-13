import { useState, useCallback, useRef } from 'react';

const DEFAULT_COL_WIDTH = 80;
const MIN_COL_WIDTH = 40;

interface UseColumnResizeOptions {
  columnWidths: Record<number, number>;
  onColumnResize?: (column: number, width: number) => void;
}

interface UseColumnResizeReturn {
  getColWidth: (colIndex: number) => number;
  resizingCol: number | null;
  handleResizeStart: (colIndex: number, e: React.PointerEvent | React.MouseEvent) => void;
}

export function useColumnResize({
  columnWidths,
  onColumnResize,
}: UseColumnResizeOptions): UseColumnResizeReturn {
  const [resizingCol, setResizingCol] = useState<number | null>(null);
  const [dragPreviewWidth, setDragPreviewWidth] = useState<number | null>(null);
  const resizeStartX = useRef<number>(0);
  const resizeStartWidth = useRef<number>(0);
  const latestWidthRef = useRef<number>(0);

  const getColWidth = useCallback(
    (colIndex: number) => {
      if (resizingCol === colIndex && dragPreviewWidth != null) {
        return dragPreviewWidth;
      }
      return columnWidths[colIndex] ?? DEFAULT_COL_WIDTH;
    },
    [columnWidths, resizingCol, dragPreviewWidth]
  );

  const handleResizeStart = useCallback(
    (colIndex: number, e: React.PointerEvent | React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const startWidth = columnWidths[colIndex] ?? DEFAULT_COL_WIDTH;
      setResizingCol(colIndex);
      setDragPreviewWidth(startWidth);
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = startWidth;
      latestWidthRef.current = startWidth;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - resizeStartX.current;
        const newWidth = Math.max(MIN_COL_WIDTH, resizeStartWidth.current + delta);
        latestWidthRef.current = newWidth;
        setDragPreviewWidth(newWidth);
      };

      const handlePointerUp = () => {
        const finalWidth = latestWidthRef.current;
        setResizingCol(null);
        setDragPreviewWidth(null);
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('mousemove', handlePointerMove as EventListener);
        document.removeEventListener('mouseup', handlePointerUp);
        onColumnResize?.(colIndex, finalWidth);
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('mousemove', handlePointerMove as EventListener);
      document.addEventListener('mouseup', handlePointerUp);
    },
    [columnWidths, onColumnResize]
  );

  return {
    getColWidth,
    resizingCol,
    handleResizeStart,
  };
}

export { DEFAULT_COL_WIDTH, MIN_COL_WIDTH };
