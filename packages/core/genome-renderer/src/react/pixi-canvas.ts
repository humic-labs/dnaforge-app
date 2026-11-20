import { Container, type Application } from 'pixi.js';
import type { UsePixiMapOptions } from './types';
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

function backingExtent(required: number, current: number): number {
  const block = 128;
  if (current >= required && current - required < 3 * block) return current;
  return Math.ceil(required / block) * block;
}

export function resizePixiCanvas(
  app: Application,
  width: number,
  height: number,
  reason: string,
  cssSize?: { width: number; height: number },
  reserveSpace: UsePixiMapOptions['reserveCanvasSpace'] = false
): { width: number; height: number; backingChanged: boolean } {
  const targetWidth = Math.max(1, Math.round(width));
  const targetHeight = Math.max(1, Math.round(height));
  const cssWidth = Math.max(1, Math.round(cssSize?.width ?? targetWidth));
  const cssHeight = Math.max(1, Math.round(cssSize?.height ?? targetHeight));

  const currentResolution = app.renderer.resolution || 1;
  const targetResolution = liveResolution();
  const currentScreenWidth = Math.round(app.renderer.width);
  const currentScreenHeight = Math.round(app.renderer.height);
  const canvas = app.canvas as HTMLCanvasElement;
  const crop = reserveSpace && 'objectViewBox' in canvas.style;
  const reserved = typeof reserveSpace === 'object' ? reserveSpace : undefined;
  const widthCapacity = crop
    ? backingExtent(Math.max(targetWidth, reserved?.width ?? 0), currentScreenWidth)
    : targetWidth;
  const heightCapacity = crop
    ? backingExtent(Math.max(targetHeight, reserved?.height ?? 0), currentScreenHeight)
    : targetHeight;
  const resolutionChanged = Math.abs(currentResolution - targetResolution) > 0.001;
  const backingChanged =
    currentScreenWidth !== widthCapacity ||
    currentScreenHeight !== heightCapacity ||
    resolutionChanged;
  if (backingChanged) {
    ptime('canvas.resize', () =>
      app.renderer.resize(widthCapacity, heightCapacity, targetResolution)
    );
    clearPixiCanvas(app);
  }

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  if (crop) {
    const right =
      Math.round(widthCapacity * targetResolution) - Math.round(targetWidth * targetResolution);
    const bottom =
      Math.round(heightCapacity * targetResolution) - Math.round(targetHeight * targetResolution);
    canvas.style.setProperty('object-view-box', `inset(0 ${right}px ${bottom}px 0)`);
  } else if (canvas.style.getPropertyValue('object-view-box')) {
    canvas.style.removeProperty('object-view-box');
  }

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
