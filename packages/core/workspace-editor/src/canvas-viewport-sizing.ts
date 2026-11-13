export function viewportCanvasHeight(viewportHeight: number, totalHeight: number): number {
  return viewportHeight > 0 ? viewportHeight + 100 : totalHeight;
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
  totalHeight,
  dpr,
  mainCanvasTransferred,
}: SyncViewportCanvasSizesParams): SyncViewportCanvasSizesResult {
  const cssWidth = width;
  const cssHeight = viewportCanvasHeight(viewportHeight, totalHeight);
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
