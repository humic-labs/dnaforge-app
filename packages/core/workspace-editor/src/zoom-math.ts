import { cdsReplacementZoomPresentation } from '@waypoint/platform';
export { cdsReplacementZoomPresentation };
import type { SequenceLodLevel, WorkspaceEditorConfig } from './types';

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 120;
export const OVERVIEW_MIN_ROW_HEIGHT_PX = 1;
export const DEFAULT_ZOOM_SENSITIVITY = 10;
export const WRAP_ZOOM_SENSITIVITY = 15;
export const TOOLBAR_ZOOM_FACTOR = 1.1;

export type { SequenceLodLevel } from './types';

export interface SequenceLodMetrics {
  charWidth: number;
  rowHeight: number;
  fontSize: number;
  viewportSpanPx?: number;
}

const NUCLEOTIDE_MIN_CHAR_WIDTH_PX = 3.5;
const NUCLEOTIDE_MIN_ROW_HEIGHT_PX = 8;
const NUCLEOTIDE_MIN_FONT_SIZE_PX = 5;

export function canRenderNucleotideText({
  charWidth,
  rowHeight,
  fontSize,
}: SequenceLodMetrics): boolean {
  return (
    charWidth >= NUCLEOTIDE_MIN_CHAR_WIDTH_PX &&
    rowHeight >= NUCLEOTIDE_MIN_ROW_HEIGHT_PX &&
    fontSize >= NUCLEOTIDE_MIN_FONT_SIZE_PX
  );
}

export function cdsDetailZoomProgress(metrics: SequenceLodMetrics): number {
  return cdsReplacementZoomPresentation(metrics.charWidth, metrics.viewportSpanPx ?? 0).progress;
}

export function detailTrackPreviewProgress(metrics: SequenceLodMetrics): number {
  const density = Math.min(
    metrics.charWidth / NUCLEOTIDE_MIN_CHAR_WIDTH_PX,
    metrics.rowHeight / NUCLEOTIDE_MIN_ROW_HEIGHT_PX,
    metrics.fontSize / NUCLEOTIDE_MIN_FONT_SIZE_PX
  );
  return Math.max(0, Math.min(1, (density - 0.75) / 0.2));
}

export function deriveSequenceLodLevel(metrics: SequenceLodMetrics): SequenceLodLevel {
  return cdsDetailZoomProgress(metrics) > 0 ? 'detail' : 'feature';
}

export function resolveIndexedCdsZoomConfig(
  config: Pick<
    WorkspaceEditorConfig,
    'cdsZoomPresentation' | 'charWidth' | 'showAnnotations' | 'showTranslation'
  >,
  viewportSpanPx: number
) {
  if (!config.cdsZoomPresentation) return {};
  const presentation = cdsReplacementZoomPresentation(config.charWidth, viewportSpanPx);
  const detail = presentation.progress > 0;
  return {
    cdsZoomPresentation: presentation,
    cdsDetailProgress:
      config.showAnnotations === false && config.showTranslation ? 1 : presentation.progress,
    lodLevel: detail ? ('detail' as const) : ('feature' as const),
    showTranslation: config.showTranslation,
  };
}

export function clampZoom(value: number): number {
  if (Number.isNaN(value)) return 100;
  if (value < MIN_ZOOM) return MIN_ZOOM;
  if (value > MAX_ZOOM) return MAX_ZOOM;
  return value;
}

export interface ZoomDeltaOptions {
  minZoom?: number;
  maxZoom?: number;
  sensitivity?: number;
  maxAbsDeltaPx?: number;
}

function clampZoomToRange(value: number, minZoom: number, maxZoom: number): number {
  if (Number.isNaN(value)) return Math.min(Math.max(100, minZoom), maxZoom);
  if (value < minZoom) return minZoom;
  if (value > maxZoom) return maxZoom;
  return value;
}

function roundZoom(value: number): number {
  if (value >= 10) return Math.round(value * 10) / 10;
  if (value >= 1) return Math.round(value * 100) / 100;
  return Math.round(value * 1000) / 1000;
}

export function nextZoomFromWheelDelta(
  currentZoom: number,
  deltaPx: number,
  {
    minZoom = MIN_ZOOM,
    maxZoom = MAX_ZOOM,
    sensitivity = DEFAULT_ZOOM_SENSITIVITY,
    maxAbsDeltaPx = Number.POSITIVE_INFINITY,
  }: ZoomDeltaOptions = {}
): number {
  const safeCurrentZoom = currentZoom > 0 && Number.isFinite(currentZoom) ? currentZoom : 100;
  const safeSensitivity = Math.max(1, sensitivity);
  const cappedDeltaPx = Math.max(-maxAbsDeltaPx, Math.min(maxAbsDeltaPx, deltaPx));
  const pixelsPerOctave = 2400 / safeSensitivity;
  const scale = 2 ** (-cappedDeltaPx / pixelsPerOctave);
  const next = safeCurrentZoom * scale;
  return clampZoomToRange(next, minZoom, maxZoom);
}

export function stepZoomByFactor(
  currentZoom: number,
  direction: 1 | -1,
  {
    minZoom = MIN_ZOOM,
    maxZoom = MAX_ZOOM,
    factor = TOOLBAR_ZOOM_FACTOR,
  }: {
    minZoom?: number;
    maxZoom?: number;
    factor?: number;
  } = {}
): number {
  const safeFactor = factor > 1 ? factor : TOOLBAR_ZOOM_FACTOR;
  const safeCurrentZoom = currentZoom > 0 && Number.isFinite(currentZoom) ? currentZoom : 100;
  const raw = direction > 0 ? safeCurrentZoom * safeFactor : safeCurrentZoom / safeFactor;
  return roundZoom(clampZoomToRange(raw, minZoom, maxZoom));
}

export function formatZoomPercent(zoomLevel: number): string {
  const rounded = roundZoom(zoomLevel);
  if (rounded >= 10) return `${Math.round(rounded)}%`;
  if (rounded >= 1) return `${Number(rounded.toFixed(1))}%`;
  return `${Number(rounded.toFixed(3))}%`;
}

export function normalizeWheelDeltaY(input: { deltaY: number; deltaMode: number }): number {
  const LINE_PX = 16;
  if (input.deltaMode === 1) return input.deltaY * LINE_PX;
  if (input.deltaMode === 2) return input.deltaY * LINE_PX * 20;
  return input.deltaY;
}

export interface ScalableConfig {
  charWidth: number;
  fontSize: number;
  rowHeight: number;
}

export function computeScaledConfig<T extends ScalableConfig>(baseConfig: T, zoomLevel: number): T {
  const scale = clampZoom(zoomLevel) / 100;
  return {
    ...baseConfig,
    charWidth: baseConfig.charWidth * scale,
    fontSize: baseConfig.fontSize * scale,
    rowHeight: baseConfig.rowHeight * scale,
  };
}

export function autofitCharsPerLine(
  containerWidth: number,
  marginLeft: number,
  charWidth: number
): number {
  if (charWidth <= 0 || containerWidth <= marginLeft) return 10;
  return Math.max(10, Math.floor((containerWidth - marginLeft) / charWidth));
}

export const MIN_CHARS_PER_ROW = 10;

export interface BaseConfig {
  baseCharWidth: number;
  baseRowHeight: number;
  marginLeft: number;
}

export function pxPerBpAt(zoomLevel: number, base: BaseConfig): number {
  return (base.baseCharWidth * zoomLevel) / 100;
}

export function pxPerRowAt(zoomLevel: number, base: BaseConfig): number {
  return (base.baseRowHeight * zoomLevel) / 100;
}

export function charsPerRowAt(zoomLevel: number, containerWidth: number, base: BaseConfig): number {
  const pxPerBp = pxPerBpAt(zoomLevel, base);
  if (pxPerBp <= 0) return MIN_CHARS_PER_ROW;
  const raw = (containerWidth - base.marginLeft) / pxPerBp;
  return Math.max(MIN_CHARS_PER_ROW, Math.floor(raw));
}

export interface CanvasFitOnceMinZoomOptions {
  observedHeight: number;
  observedZoom: number;
  viewportHeight: number;
  minZoom?: number;
  maxZoom?: number;
}

const PLATEAU_ESCAPE_STEP = 1.5;

export function computeCanvasFitOnceMinZoom({
  observedHeight,
  observedZoom,
  viewportHeight,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
}: CanvasFitOnceMinZoomOptions): number {
  const safeMin = clampZoomToRange(minZoom, MIN_ZOOM, MAX_ZOOM);
  const safeMax = clampZoomToRange(maxZoom, safeMin, MAX_ZOOM);
  if (
    observedHeight <= 0 ||
    observedZoom <= 0 ||
    viewportHeight <= 0 ||
    !Number.isFinite(observedHeight) ||
    !Number.isFinite(observedZoom)
  ) {
    return safeMin;
  }
  const ratio = viewportHeight / observedHeight;
  const z2Predict = observedZoom * Math.sqrt(ratio);
  const isUnderfilling = observedHeight < viewportHeight;
  const plateauStep = isUnderfilling ? observedZoom * PLATEAU_ESCAPE_STEP : 0;
  const fitZoom = Math.max(z2Predict, plateauStep);
  return roundZoom(clampZoomToRange(fitZoom, safeMin, safeMax));
}
