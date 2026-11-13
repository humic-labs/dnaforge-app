import { useState, useCallback, useRef } from 'react';

export const MIN_ROW_HEIGHT = 20;

interface UseRowResizeOptions {
  rowHeights: Record<number, number>;
  onRowResize?: (row: number, height: number) => void;
}

interface UseRowResizeReturn {
  getRowHeight: (rowIndex: number) => number | undefined;
  resizingRow: number | null;
  handleRowResizeStart: (rowIndex: number, e: React.PointerEvent | React.MouseEvent) => void;
}

export function useRowResize({ rowHeights, onRowResize }: UseRowResizeOptions): UseRowResizeReturn {
  const [resizingRow, setResizingRow] = useState<number | null>(null);
  const [dragPreviewHeight, setDragPreviewHeight] = useState<number | null>(null);
  const resizeStartY = useRef<number>(0);
  const resizeStartHeight = useRef<number>(0);
  const latestHeightRef = useRef<number>(0);

  const getRowHeight = useCallback(
    (rowIndex: number) => {
      if (resizingRow === rowIndex && dragPreviewHeight != null) {
        return dragPreviewHeight;
      }
      return rowHeights[rowIndex];
    },
    [rowHeights, resizingRow, dragPreviewHeight]
  );

  const handleRowResizeStart = useCallback(
    (rowIndex: number, e: React.PointerEvent | React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rowEl = (e.currentTarget as HTMLElement)?.closest('tr');
      const currentRendered = rowEl ? rowEl.getBoundingClientRect().height : MIN_ROW_HEIGHT;
      const startHeight = rowHeights[rowIndex] ?? currentRendered;
      setResizingRow(rowIndex);
      setDragPreviewHeight(startHeight);
      resizeStartY.current = e.clientY;
      resizeStartHeight.current = startHeight;
      latestHeightRef.current = startHeight;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - resizeStartY.current;
        const newHeight = Math.max(MIN_ROW_HEIGHT, resizeStartHeight.current + delta);
        latestHeightRef.current = newHeight;
        setDragPreviewHeight(newHeight);
      };

      const handlePointerUp = () => {
        const finalHeight = latestHeightRef.current;
        setResizingRow(null);
        setDragPreviewHeight(null);
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('mousemove', handlePointerMove as EventListener);
        document.removeEventListener('mouseup', handlePointerUp);
        onRowResize?.(rowIndex, finalHeight);
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('mousemove', handlePointerMove as EventListener);
      document.addEventListener('mouseup', handlePointerUp);
    },
    [rowHeights, onRowResize]
  );

  return { getRowHeight, resizingRow, handleRowResizeStart };
}

export interface AutoFitOptions {
  padding?: number;
  minWidth: number;
  maxWidth?: number;
}

export function autoFitWidthFromMeasurements(
  values: string[],
  measure: (text: string) => number,
  opts: AutoFitOptions
): number {
  const { padding = 24, minWidth, maxWidth = 600 } = opts;
  let widest = 0;
  for (const value of values) {
    for (const line of String(value ?? '').split('\n')) {
      const w = measure(line);
      if (w > widest) widest = w;
    }
  }
  return Math.min(maxWidth, Math.max(minWidth, Math.ceil(widest) + padding));
}

let _measureCanvas: HTMLCanvasElement | null = null;
export function autoFitColumnWidth(
  values: string[],
  opts: AutoFitOptions & { font?: string }
): number {
  const { font = '13px system-ui, sans-serif' } = opts;
  if (typeof document === 'undefined') return opts.minWidth;
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  if (!ctx) return opts.minWidth;
  ctx.font = font;
  return autoFitWidthFromMeasurements(values, (t) => ctx.measureText(t).width, opts);
}
