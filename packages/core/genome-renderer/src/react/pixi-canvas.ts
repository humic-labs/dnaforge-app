import { Container, type Application } from 'pixi.js';
import { perfTime as ptime, recordWebGLTrace } from '@waypoint/genome-renderer';

function liveResolution(): number {
  if (typeof window === 'undefined') return 1;
  const dpr = window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

let emptyScene: Container | null = null;

export function clearPixiCanvas(app: Application): void {
  emptyScene ??= new Container();
  app.renderer.render({ container: emptyScene });
}

export function resizePixiCanvas(
  app: Application,
  width: number,
  height: number,
  reason: string,
  cssSize?: { width: number; height: number }
): { width: number; height: number; backingChanged: boolean } {
  const targetWidth = Math.max(1, Math.round(width));
  const targetHeight = Math.max(1, Math.round(height));
  const cssWidth = Math.max(1, Math.round(cssSize?.width ?? targetWidth));
  const cssHeight = Math.max(1, Math.round(cssSize?.height ?? targetHeight));

  const currentResolution = app.renderer.resolution || 1;
  const targetResolution = liveResolution();
  const currentScreenWidth = Math.round(app.renderer.width);
  const currentScreenHeight = Math.round(app.renderer.height);
  const resolutionChanged = Math.abs(currentResolution - targetResolution) > 0.001;
  const backingChanged =
    currentScreenWidth !== targetWidth || currentScreenHeight !== targetHeight || resolutionChanged;
  if (backingChanged) {
    ptime('canvas.resize', () => app.renderer.resize(targetWidth, targetHeight, targetResolution));
    clearPixiCanvas(app);
  }

  const canvas = app.canvas as HTMLCanvasElement;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  recordWebGLTrace('resize', {
    reason,
    width: targetWidth,
    height: targetHeight,
    backingChanged,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    cssWidth,
    cssHeight,
    resolution: targetResolution,
    resolutionChanged,
  });

  return { width: targetWidth, height: targetHeight, backingChanged };
}
