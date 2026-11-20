export function viewportCanvasHeight(
  viewportHeight: number,
  totalHeight: number,
  currentHeight = 0,
  reservedViewportHeight = 0
): number {
  if (viewportHeight <= 0) return totalHeight;
  const required = Math.max(viewportHeight, reservedViewportHeight) + 100;
  if (!(currentHeight > 0)) return required;
  if (currentHeight >= required && currentHeight - required < 256) return currentHeight;
  return Math.ceil(required / 128) * 128;
}

export function viewportCanvasWidth(
  viewportWidth: number,
  totalWidth: number,
  autoWrap: boolean
): number {
  return autoWrap ? Math.max(totalWidth, Math.ceil((viewportWidth + 128) / 128) * 128) : totalWidth;
}

export type CanvasRenderMode = 'worker' | 'main' | 'initializing';

export function shouldSyncViewportCanvasSizesDuringScroll(mode: CanvasRenderMode): boolean {
  return mode === 'worker';
}

export interface SyncViewportCanvasSizesParams {
  mainCanvas: HTMLCanvasElement | null;
  selectionCanvas: HTMLCanvasElement | null;
  width: number;
  viewportHeight: number;
  reservedViewportHeight?: number;
  totalHeight: number;
  dpr: number;
  mainCanvasTransferred: boolean;
}

export interface SyncViewportCanvasSizesResult {
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  mainResized: boolean;
  selectionResized: boolean;
}

function setCanvasStyleSize(canvas: HTMLCanvasElement, width: number, height: number): void {
  const cssWidth = `${width}px`;
  const cssHeight = `${height}px`;
  if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
  if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
}

export function syncViewportCanvasSizes({
  mainCanvas,
  selectionCanvas,
  width,
  viewportHeight,
  reservedViewportHeight,
  totalHeight,
  dpr,
  mainCanvasTransferred,
}: SyncViewportCanvasSizesParams): SyncViewportCanvasSizesResult {
  const cssWidth = width;
  const currentHeight = parseFloat((mainCanvas ?? selectionCanvas)?.style.height ?? '');
  const cssHeight = viewportCanvasHeight(
    viewportHeight,
    totalHeight,
    currentHeight,
    reservedViewportHeight
  );
  const backingWidth = Math.ceil(cssWidth * dpr);
  const backingHeight = Math.ceil(cssHeight * dpr);
  let mainResized = false;
  let selectionResized = false;

  if (mainCanvas) {
    setCanvasStyleSize(mainCanvas, cssWidth, cssHeight);
    if (!mainCanvasTransferred) {
      if (mainCanvas.width !== backingWidth) {
        mainCanvas.width = backingWidth;
        mainResized = true;
      }
      if (mainCanvas.height !== backingHeight) {
        mainCanvas.height = backingHeight;
        mainResized = true;
      }
    }
  }

  if (selectionCanvas) {
    setCanvasStyleSize(selectionCanvas, cssWidth, cssHeight);
    if (selectionCanvas.width !== backingWidth) {
      selectionCanvas.width = backingWidth;
      selectionResized = true;
    }
    if (selectionCanvas.height !== backingHeight) {
      selectionCanvas.height = backingHeight;
      selectionResized = true;
    }
  }

  return {
    cssWidth,
    cssHeight,
    backingWidth,
    backingHeight,
    mainResized,
    selectionResized,
  };
}
