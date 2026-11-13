import type { TabViewState } from '../../canvas/public/types';
import { normalizeSequenceViewportZoomLevel } from '../components/sequence-viewport-state';
import {
  DEFAULT_ANNOTATION_COLOR_MODE,
  normalizeAnnotationColorMode,
  type AnnotationColorMode,
} from '@waypoint/sequence-utils';
import {
  parseAnnotationTrackLayout,
  type AnnotationTrackLayout,
} from '@waypoint/genome-data/annotation-catalog';

const WEBGL_OVERVIEW_RENDERERS = ['full-shapes', 'retained'] as const;
export type WebGLOverviewRenderer = (typeof WEBGL_OVERVIEW_RENDERERS)[number];
const DEFAULT_WEBGL_OVERVIEW_RENDERER: WebGLOverviewRenderer = 'retained';

export type SequenceCanvasMode = '2d' | 'tracks';
export type SequenceOrientation = 'forward' | 'reverse-complement';
export type SequenceWebGLPerformancePreference = 'auto' | 'quality' | 'stability';
export type SequenceRendererVisibility = 'sequence' | 'both' | 'map';
export type SequenceMapShape = 'circular' | 'linear';
export type SequenceMapLayout = 'vertical' | 'horizontal';
export type SequenceMapPlacement = 'left' | 'right' | 'top' | 'bottom';

const CANVAS_MODES: readonly SequenceCanvasMode[] = ['2d', 'tracks'] as const;
export const SEQUENCE_RENDERER_VISIBILITIES: readonly SequenceRendererVisibility[] = [
  'sequence',
  'both',
  'map',
] as const;
export const SEQUENCE_MAP_SHAPES: readonly SequenceMapShape[] = ['circular', 'linear'] as const;
export const SEQUENCE_MAP_LAYOUTS: readonly SequenceMapLayout[] = [
  'vertical',
  'horizontal',
] as const;
export const SEQUENCE_MAP_PLACEMENTS: readonly SequenceMapPlacement[] = [
  'left',
  'right',
  'top',
  'bottom',
] as const;
const SEQUENCE_ORIENTATIONS: readonly SequenceOrientation[] = [
  'forward',
  'reverse-complement',
] as const;
export const SEQUENCE_WEBGL_PERFORMANCE_PREFERENCES: readonly SequenceWebGLPerformancePreference[] =
  ['auto', 'quality', 'stability'] as const;

export interface SequenceDisplayToggles {
  showAnnotations: boolean;
  showTranslation: boolean;
  showReverseComplement: boolean;
  showPrimers: boolean;
  showResidueNumbers: boolean;
}

const DISPLAY_TOGGLE_KEYS: readonly (keyof SequenceDisplayToggles)[] = [
  'showAnnotations',
  'showTranslation',
  'showReverseComplement',
  'showPrimers',
  'showResidueNumbers',
] as const;

export interface SequenceViewState {
  rendererVisibility: SequenceRendererVisibility;
  canvasMode: SequenceCanvasMode;
  mapShape: SequenceMapShape;
  mapLayout: SequenceMapLayout;
  mapPlacement: SequenceMapPlacement;
  mapPaneWidth: number | null;
  orientation: SequenceOrientation;
  originOffset: number;
  zoom: number;
  centerBp: number | null;
  sequenceRanges: { start: number; end: number }[];
  selection: { start: number; end: number } | null;
  webglRenderer: WebGLOverviewRenderer;
  webglPerformancePreference: SequenceWebGLPerformancePreference;
  scrollSynced: boolean;
  webglZoom: number | null;
  webglCenterBp: number | null;
  webglMorph: number | null;
  minimapHeight: number | null;
  minimapGeometryHeight: number | null;
  annotationColorMode: AnnotationColorMode;
  display: SequenceDisplayToggles;
  annotationCatalogLayout?: AnnotationTrackLayout;
}

export interface SequenceViewStatePatch {
  rendererVisibility?: SequenceRendererVisibility;
  canvasMode?: SequenceCanvasMode;
  mapShape?: SequenceMapShape;
  mapLayout?: SequenceMapLayout;
  mapPlacement?: SequenceMapPlacement;
  mapPaneWidth?: number | null;
  orientation?: SequenceOrientation;
  originOffset?: number;
  zoom?: number;
  centerBp?: number | null;
  sequenceRanges?: { start: number; end: number }[];
  selection?: { start: number; end: number } | null;
  webglRenderer?: WebGLOverviewRenderer;
  webglPerformancePreference?: SequenceWebGLPerformancePreference;
  scrollSynced?: boolean;
  webglZoom?: number | null;
  webglCenterBp?: number | null;
  webglMorph?: number | null;
  minimapHeight?: number | null;
  minimapGeometryHeight?: number | null;
  annotationColorMode?: AnnotationColorMode;
  display?: Partial<SequenceDisplayToggles>;
  annotationCatalogLayout?: AnnotationTrackLayout | null;
}

export const DEFAULT_SEQUENCE_VIEW_STATE: SequenceViewState = {
  rendererVisibility: 'both',
  canvasMode: '2d',
  mapShape: 'circular',
  mapLayout: 'vertical',
  mapPlacement: 'bottom',
  mapPaneWidth: null,
  orientation: 'forward',
  originOffset: 0,
  zoom: 100,
  centerBp: null,
  sequenceRanges: [],
  selection: null,
  webglRenderer: DEFAULT_WEBGL_OVERVIEW_RENDERER,
  webglPerformancePreference: 'auto',
  scrollSynced: false,
  webglZoom: null,
  webglCenterBp: null,
  webglMorph: null,
  minimapHeight: null,
  minimapGeometryHeight: null,
  annotationColorMode: DEFAULT_ANNOTATION_COLOR_MODE,
  display: {
    showAnnotations: true,
    showTranslation: true,
    showReverseComplement: true,
    showPrimers: true,
    showResidueNumbers: false,
  },
};

export function isSequenceSurfaceVisible(viewState: SequenceViewState): boolean {
  return viewState.rendererVisibility !== 'map';
}

export function isMapSurfaceVisible(viewState: SequenceViewState): boolean {
  return viewState.rendererVisibility !== 'sequence';
}

export function effectiveSequenceMapShape(
  viewState: Pick<SequenceViewState, 'mapShape'>,
  ctx: SequenceViewContext
): SequenceMapShape {
  return ctx.circular ? viewState.mapShape : 'linear';
}

export function mapLayoutForPlacement(placement: SequenceMapPlacement): SequenceMapLayout {
  return placement === 'left' || placement === 'right' ? 'horizontal' : 'vertical';
}

export function defaultMapPlacementForLayout(layout: SequenceMapLayout): SequenceMapPlacement {
  return layout === 'horizontal' ? 'right' : 'bottom';
}

export function defaultMapPlacementForTopology(circular: boolean): SequenceMapPlacement {
  return circular ? 'right' : 'bottom';
}

export function defaultRendererVisibilityForSurface(
  surface: SequenceViewSurface
): SequenceRendererVisibility {
  return surface === 'assembly' ? 'map' : DEFAULT_SEQUENCE_VIEW_STATE.rendererVisibility;
}

export type SequenceViewSurface = 'sequence' | 'assembly';

export interface SequenceViewContext {
  circular: boolean;
  surface?: SequenceViewSurface;
}

export function sequenceViewCapabilities(ctx: SequenceViewContext): {
  webglMorph: boolean;
  originOffset: boolean;
  mapShape: boolean;
} {
  return {
    webglMorph: ctx.circular === true,
    originOffset: ctx.circular === true,
    mapShape: ctx.circular === true,
  };
}

export function applicableViewStatePatch(
  patch: SequenceViewStatePatch,
  ctx: SequenceViewContext
): SequenceViewStatePatch {
  const caps = sequenceViewCapabilities(ctx);
  let result = patch;
  for (const key of Object.keys(caps) as (keyof typeof caps)[]) {
    if (!caps[key] && key in result) {
      const { [key]: _dropped, ...rest } = result;
      result = rest;
    }
  }
  if (ctx.surface === 'sequence' && result.canvasMode !== undefined) {
    result = { ...result, canvasMode: '2d' };
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDisplay(input: unknown): Partial<SequenceDisplayToggles> | undefined {
  if (!isPlainObject(input)) return undefined;
  const out: Partial<SequenceDisplayToggles> = {};
  for (const key of DISPLAY_TOGGLE_KEYS) {
    const raw = input[key];
    if (typeof raw === 'boolean') out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

type SequenceViewPatchStringKey =
  | 'rendererVisibility'
  | 'mapShape'
  | 'mapLayout'
  | 'mapPlacement'
  | 'orientation'
  | 'webglRenderer'
  | 'webglPerformancePreference';

type SequenceViewPatchNullableNumberKey =
  | 'mapPaneWidth'
  | 'centerBp'
  | 'webglZoom'
  | 'webglCenterBp'
  | 'minimapHeight'
  | 'minimapGeometryHeight';

function assignAllowedStringField(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch,
  key: SequenceViewPatchStringKey,
  allowed: readonly string[]
): void {
  const raw = input[key];
  if (typeof raw === 'string' && allowed.includes(raw)) {
    (patch as Record<string, unknown>)[key] = raw;
  }
}

function assignNormalizedCanvasMode(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch
): void {
  if (typeof input.canvasMode !== 'string') return;
  if (input.canvasMode === '1d') {
    patch.canvasMode = '2d';
    return;
  }
  if ((CANVAS_MODES as readonly string[]).includes(input.canvasMode)) {
    patch.canvasMode = input.canvasMode as SequenceCanvasMode;
  }
}

function assignNullableFiniteNumberField(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch,
  key: SequenceViewPatchNullableNumberKey,
  options?: { min?: number }
): void {
  if (!(key in input)) return;
  const raw = input[key];
  if (raw === null) {
    patch[key] = null;
    return;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
  if (options?.min !== undefined && raw < options.min) return;
  patch[key] = raw;
}

function assignFloorNonNegativeOriginOffset(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch
): void {
  if (!('originOffset' in input)) return;
  const raw = input.originOffset;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    patch.originOffset = Math.floor(raw);
  }
}

function assignNormalizedZoom(input: Record<string, unknown>, patch: SequenceViewStatePatch): void {
  const zoom = normalizeSequenceViewportZoomLevel(input.zoom);
  if (zoom != null) patch.zoom = zoom;
}

function assignScrollSynced(input: Record<string, unknown>, patch: SequenceViewStatePatch): void {
  if (typeof input.scrollSynced === 'boolean') patch.scrollSynced = input.scrollSynced;
}

function assignAnnotationColorMode(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch
): void {
  if ('annotationColorMode' in input) {
    patch.annotationColorMode = normalizeAnnotationColorMode(input.annotationColorMode);
  }
}

function assignNullableCameraNumberFields(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch
): void {
  for (const key of [
    'webglZoom',
    'webglCenterBp',
    'minimapHeight',
    'minimapGeometryHeight',
  ] as const) {
    assignNullableFiniteNumberField(input, patch, key);
  }
}

function assignClampedWebglMorph(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch
): void {
  if (!('webglMorph' in input)) return;
  const raw = input.webglMorph;
  if (raw === null) {
    patch.webglMorph = null;
    return;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    patch.webglMorph = Math.max(0, Math.min(1, raw));
  }
}

function assignNormalizedDisplay(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch
): void {
  const display = normalizeDisplay(input.display);
  if (display) patch.display = display;
}

function assignParsedAnnotationCatalogLayout(
  input: Record<string, unknown>,
  patch: SequenceViewStatePatch
): void {
  if (!('annotationCatalogLayout' in input)) return;
  const raw = input.annotationCatalogLayout;
  if (raw === null) {
    patch.annotationCatalogLayout = null;
    return;
  }
  const parsed = parseAnnotationTrackLayout(raw);
  if (parsed.ok) patch.annotationCatalogLayout = parsed.layout;
}

export function normalizeSequenceViewStatePatch(input: unknown): SequenceViewStatePatch {
  if (!isPlainObject(input)) return {};
  const patch: SequenceViewStatePatch = {};
  assignAllowedStringField(input, patch, 'rendererVisibility', SEQUENCE_RENDERER_VISIBILITIES);
  assignNormalizedCanvasMode(input, patch);
  assignAllowedStringField(input, patch, 'mapShape', SEQUENCE_MAP_SHAPES);
  assignAllowedStringField(input, patch, 'mapLayout', SEQUENCE_MAP_LAYOUTS);
  assignAllowedStringField(input, patch, 'mapPlacement', SEQUENCE_MAP_PLACEMENTS);
  assignNullableFiniteNumberField(input, patch, 'mapPaneWidth', { min: 0 });
  assignAllowedStringField(input, patch, 'orientation', SEQUENCE_ORIENTATIONS);
  assignFloorNonNegativeOriginOffset(input, patch);
  assignNormalizedZoom(input, patch);
  assignNullableFiniteNumberField(input, patch, 'centerBp');
  assignAllowedStringField(input, patch, 'webglRenderer', WEBGL_OVERVIEW_RENDERERS);
  assignAllowedStringField(
    input,
    patch,
    'webglPerformancePreference',
    SEQUENCE_WEBGL_PERFORMANCE_PREFERENCES
  );
  assignScrollSynced(input, patch);
  assignAnnotationColorMode(input, patch);
  assignNullableCameraNumberFields(input, patch);
  assignClampedWebglMorph(input, patch);
  assignNormalizedDisplay(input, patch);
  assignParsedAnnotationCatalogLayout(input, patch);
  assignSequenceRanges(input, patch);
  assignSelection(input, patch);
  return patch;
}

function assignSequenceRanges(input: Record<string, unknown>, patch: SequenceViewStatePatch): void {
  if (!('sequenceRanges' in input)) return;
  const raw = input.sequenceRanges;
  if (!Array.isArray(raw)) return;
  const ranges: { start: number; end: number }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const start = (item as { start?: unknown }).start;
    const end = (item as { end?: unknown }).end;
    if (typeof start === 'number' && typeof end === 'number') ranges.push({ start, end });
  }
  patch.sequenceRanges = ranges;
}

function assignSelection(input: Record<string, unknown>, patch: SequenceViewStatePatch): void {
  if (!('selection' in input)) return;
  const raw = input.selection;
  if (raw === null) {
    patch.selection = null;
    return;
  }
  if (!raw || typeof raw !== 'object') return;
  const start = (raw as { start?: unknown }).start;
  const end = (raw as { end?: unknown }).end;
  if (typeof start === 'number' && typeof end === 'number') patch.selection = { start, end };
}

function pickDefined<K extends keyof SequenceViewStatePatch>(
  tab: SequenceViewStatePatch,
  memory: SequenceViewStatePatch,
  key: K,
  fallback: NonNullable<SequenceViewStatePatch[K]>
): NonNullable<SequenceViewStatePatch[K]> {
  return (tab[key] ?? memory[key] ?? fallback) as NonNullable<SequenceViewStatePatch[K]>;
}

function pickPresentNullable<K extends keyof SequenceViewStatePatch>(
  tab: SequenceViewStatePatch,
  memory: SequenceViewStatePatch,
  key: K,
  fallback: NonNullable<SequenceViewStatePatch[K]> | null
): NonNullable<SequenceViewStatePatch[K]> | null {
  if (key in tab) return (tab[key] ?? null) as NonNullable<SequenceViewStatePatch[K]> | null;
  if (key in memory) return (memory[key] ?? null) as NonNullable<SequenceViewStatePatch[K]> | null;
  return fallback;
}

function resolveSeededMapPlacement(
  tab: SequenceViewStatePatch,
  memory: SequenceViewStatePatch,
  circular: boolean
): SequenceMapPlacement {
  return (
    tab.mapPlacement ??
    (tab.mapLayout ? defaultMapPlacementForLayout(tab.mapLayout) : undefined) ??
    memory.mapPlacement ??
    (memory.mapLayout ? defaultMapPlacementForLayout(memory.mapLayout) : undefined) ??
    defaultMapPlacementForTopology(circular)
  );
}

function resolveSeededMapLayout(
  tab: SequenceViewStatePatch,
  memory: SequenceViewStatePatch,
  mapPlacement: SequenceMapPlacement
): SequenceMapLayout {
  if (tab.mapPlacement !== undefined) return mapLayoutForPlacement(tab.mapPlacement);
  if (tab.mapLayout !== undefined) return tab.mapLayout;
  if (memory.mapPlacement !== undefined) return mapLayoutForPlacement(memory.mapPlacement);
  if (memory.mapLayout !== undefined) return memory.mapLayout;
  return mapLayoutForPlacement(mapPlacement);
}

export function resolveSeededViewState(layers: {
  memory?: SequenceViewStatePatch;
  tab?: SequenceViewStatePatch;
  circular?: boolean;
  surface?: SequenceViewSurface;
}): SequenceViewState {
  const memory = layers.memory ?? {};
  const tab = layers.tab ?? {};
  const mapPlacement = resolveSeededMapPlacement(tab, memory, layers.circular ?? false);
  const mapLayout = resolveSeededMapLayout(tab, memory, mapPlacement);
  const annotationCatalogLayout = pickPresentNullable(tab, memory, 'annotationCatalogLayout', null);
  return {
    rendererVisibility: pickDefined(
      tab,
      memory,
      'rendererVisibility',
      defaultRendererVisibilityForSurface(layers.surface ?? 'sequence')
    ),
    canvasMode:
      layers.surface === 'sequence'
        ? '2d'
        : pickDefined(tab, memory, 'canvasMode', DEFAULT_SEQUENCE_VIEW_STATE.canvasMode),
    mapShape: pickDefined(tab, memory, 'mapShape', DEFAULT_SEQUENCE_VIEW_STATE.mapShape),
    mapLayout,
    mapPlacement,
    mapPaneWidth: pickPresentNullable(
      tab,
      memory,
      'mapPaneWidth',
      DEFAULT_SEQUENCE_VIEW_STATE.mapPaneWidth
    ),
    orientation: pickDefined(tab, memory, 'orientation', DEFAULT_SEQUENCE_VIEW_STATE.orientation),
    originOffset: pickDefined(
      tab,
      memory,
      'originOffset',
      DEFAULT_SEQUENCE_VIEW_STATE.originOffset
    ),
    zoom: pickDefined(tab, memory, 'zoom', DEFAULT_SEQUENCE_VIEW_STATE.zoom),
    centerBp: pickPresentNullable(tab, memory, 'centerBp', DEFAULT_SEQUENCE_VIEW_STATE.centerBp),
    sequenceRanges: pickDefined(
      tab,
      memory,
      'sequenceRanges',
      DEFAULT_SEQUENCE_VIEW_STATE.sequenceRanges
    ),
    selection: pickPresentNullable(tab, memory, 'selection', DEFAULT_SEQUENCE_VIEW_STATE.selection),
    webglRenderer: pickDefined(
      tab,
      memory,
      'webglRenderer',
      DEFAULT_SEQUENCE_VIEW_STATE.webglRenderer
    ),
    webglPerformancePreference: pickDefined(
      tab,
      memory,
      'webglPerformancePreference',
      DEFAULT_SEQUENCE_VIEW_STATE.webglPerformancePreference
    ),
    scrollSynced: pickDefined(
      tab,
      memory,
      'scrollSynced',
      DEFAULT_SEQUENCE_VIEW_STATE.scrollSynced
    ),
    webglZoom: pickPresentNullable(tab, memory, 'webglZoom', DEFAULT_SEQUENCE_VIEW_STATE.webglZoom),
    webglCenterBp: pickPresentNullable(
      tab,
      memory,
      'webglCenterBp',
      DEFAULT_SEQUENCE_VIEW_STATE.webglCenterBp
    ),
    webglMorph: pickPresentNullable(
      tab,
      memory,
      'webglMorph',
      DEFAULT_SEQUENCE_VIEW_STATE.webglMorph
    ),
    minimapHeight: pickPresentNullable(
      tab,
      memory,
      'minimapHeight',
      DEFAULT_SEQUENCE_VIEW_STATE.minimapHeight
    ),
    minimapGeometryHeight: pickPresentNullable(
      tab,
      memory,
      'minimapGeometryHeight',
      DEFAULT_SEQUENCE_VIEW_STATE.minimapGeometryHeight
    ),
    annotationColorMode: pickDefined(
      tab,
      memory,
      'annotationColorMode',
      DEFAULT_SEQUENCE_VIEW_STATE.annotationColorMode
    ),
    display: {
      ...DEFAULT_SEQUENCE_VIEW_STATE.display,
      ...memory.display,
      ...tab.display,
    },
    ...(annotationCatalogLayout ? { annotationCatalogLayout } : {}),
  };
}

const SEQUENCE_VIEW_PATCH_SCALAR_KEYS = [
  'rendererVisibility',
  'canvasMode',
  'mapShape',
  'mapLayout',
  'mapPlacement',
  'mapPaneWidth',
  'orientation',
  'originOffset',
  'zoom',
  'centerBp',
  'webglRenderer',
  'webglPerformancePreference',
  'scrollSynced',
  'webglZoom',
  'webglCenterBp',
  'webglMorph',
  'minimapHeight',
  'minimapGeometryHeight',
  'annotationColorMode',
  'annotationCatalogLayout',
  'sequenceRanges',
  'selection',
] as const satisfies readonly (keyof SequenceViewStatePatch)[];

function copyMissingSequenceViewPatchScalars(
  source: SequenceViewStatePatch,
  present: SequenceViewStatePatch,
  out: SequenceViewStatePatch
): void {
  for (const key of SEQUENCE_VIEW_PATCH_SCALAR_KEYS) {
    if (key in source && !(key in present)) {
      (out as Record<string, unknown>)[key] = source[key];
    }
  }
}

function copyMissingSequenceViewDisplayToggles(
  source: SequenceViewStatePatch,
  present: SequenceViewStatePatch,
  out: SequenceViewStatePatch
): void {
  if (!source.display) return;
  const display: Partial<SequenceDisplayToggles> = {};
  for (const key of DISPLAY_TOGGLE_KEYS) {
    if (source.display[key] !== undefined && present.display?.[key] === undefined) {
      display[key] = source.display[key];
    }
  }
  if (Object.keys(display).length > 0) out.display = display;
}

export function sequenceViewPatchMissingFrom(
  source: SequenceViewStatePatch,
  present: SequenceViewStatePatch
): SequenceViewStatePatch {
  const out: SequenceViewStatePatch = {};
  copyMissingSequenceViewPatchScalars(source, present, out);
  copyMissingSequenceViewDisplayToggles(source, present, out);
  return out;
}

export function mergeSequenceViewStatePatch(
  base: SequenceViewStatePatch,
  override: SequenceViewStatePatch
): SequenceViewStatePatch {
  const merged: SequenceViewStatePatch = { ...base, ...override };
  if (base.display || override.display) {
    merged.display = { ...base.display, ...override.display };
  }
  return merged;
}

const TAB_TO_MODEL_SCALAR = [
  { tab: 'sequenceRendererVisibility', model: 'rendererVisibility' },
  { tab: 'sequenceViewMode', model: 'canvasMode' },
  { tab: 'sequenceMapShape', model: 'mapShape' },
  { tab: 'sequenceMapLayout', model: 'mapLayout' },
  { tab: 'sequenceMapPlacement', model: 'mapPlacement' },
  { tab: 'sequenceMapPaneWidth', model: 'mapPaneWidth' },
  { tab: 'sequenceOrientation', model: 'orientation' },
  { tab: 'sequenceOriginOffset', model: 'originOffset' },
  { tab: 'sequenceViewportZoomLevel', model: 'zoom' },
  { tab: 'sequenceViewportCenterBp', model: 'centerBp' },
  { tab: 'sequenceWebglRenderer', model: 'webglRenderer' },
  { tab: 'sequenceWebglPerformancePreference', model: 'webglPerformancePreference' },
  { tab: 'sequenceWebglScrollSynced', model: 'scrollSynced' },
  { tab: 'sequenceWebglZoom', model: 'webglZoom' },
  { tab: 'sequenceWebglCenterBp', model: 'webglCenterBp' },
  { tab: 'sequenceWebglMorph', model: 'webglMorph' },
  { tab: 'sequenceMinimapHeight', model: 'minimapHeight' },
  { tab: 'sequenceMinimapGeometryHeight', model: 'minimapGeometryHeight' },
  { tab: 'sequenceAnnotationColorMode', model: 'annotationColorMode' },
  { tab: 'sequenceAnnotationCatalogLayout', model: 'annotationCatalogLayout' },
  { tab: 'sequenceRanges', model: 'sequenceRanges' },
  { tab: 'selection', model: 'selection' },
] as const satisfies ReadonlyArray<{
  tab: keyof TabViewState;
  model: keyof SequenceViewStatePatch;
}>;

const TAB_TO_MODEL_DISPLAY = [
  { tab: 'sequenceShowAnnotations', display: 'showAnnotations' },
  { tab: 'sequenceShowTranslation', display: 'showTranslation' },
  { tab: 'sequenceShowReverseComplement', display: 'showReverseComplement' },
  { tab: 'sequenceShowPrimers', display: 'showPrimers' },
  { tab: 'sequenceShowResidueNumbers', display: 'showResidueNumbers' },
] as const satisfies ReadonlyArray<{
  tab: keyof TabViewState;
  display: keyof SequenceDisplayToggles;
}>;

function copyDefinedTabViewFieldsToRaw(
  viewState: TabViewState,
  raw: Record<string, unknown>
): void {
  for (const { tab, model } of TAB_TO_MODEL_SCALAR) {
    if (viewState[tab] !== undefined) raw[model] = viewState[tab];
  }
}

function copyDefinedTabDisplayFieldsToRaw(
  viewState: TabViewState,
  raw: Record<string, unknown>
): void {
  const display: Record<string, unknown> = {};
  for (const { tab, display: key } of TAB_TO_MODEL_DISPLAY) {
    if (viewState[tab] !== undefined) display[key] = viewState[tab];
  }
  if (Object.keys(display).length > 0) raw.display = display;
}

function copyDefinedModelFieldsToTab(
  patch: SequenceViewStatePatch,
  out: Partial<TabViewState>
): void {
  for (const { tab, model } of TAB_TO_MODEL_SCALAR) {
    if (patch[model] !== undefined) {
      (out as Record<string, unknown>)[tab] = patch[model];
    }
  }
}

function copyDefinedDisplayFieldsToTab(
  patch: SequenceViewStatePatch,
  out: Partial<TabViewState>
): void {
  if (!patch.display) return;
  const display = patch.display;
  for (const { tab, display: key } of TAB_TO_MODEL_DISPLAY) {
    if (display[key] !== undefined) {
      (out as Record<string, unknown>)[tab] = display[key];
    }
  }
}

export function tabViewStateToModelPatch(
  viewState: TabViewState | undefined
): SequenceViewStatePatch {
  if (!viewState) return {};
  const raw: Record<string, unknown> = {};
  copyDefinedTabViewFieldsToRaw(viewState, raw);
  copyDefinedTabDisplayFieldsToRaw(viewState, raw);
  return normalizeSequenceViewStatePatch(raw);
}

export function modelPatchToTabViewState(patch: SequenceViewStatePatch): Partial<TabViewState> {
  const out: Partial<TabViewState> = {};
  copyDefinedModelFieldsToTab(patch, out);
  copyDefinedDisplayFieldsToTab(patch, out);
  return out;
}

const MEMORY_KEY_PREFIX = 'waypoint:sequence-view-state:';

let memoryWriteWarned = false;

export function sequenceViewMemoryKey(documentId: string): string {
  return `${MEMORY_KEY_PREFIX}${documentId}`;
}

export function readSequenceViewMemory(documentId: string): SequenceViewStatePatch {
  try {
    const raw = localStorage.getItem(sequenceViewMemoryKey(documentId));
    if (!raw) return {};
    return normalizeSequenceViewStatePatch(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function writeSequenceViewMemory(documentId: string, patch: SequenceViewStatePatch): void {
  try {
    const next = mergeSequenceViewStatePatch(
      readSequenceViewMemory(documentId),
      normalizeSequenceViewStatePatch(patch)
    );
    localStorage.setItem(sequenceViewMemoryKey(documentId), JSON.stringify(next));
  } catch (err) {
    if (!memoryWriteWarned) {
      memoryWriteWarned = true;
      console.warn(
        '[sequence-view-state] per-file view memory write failed (localStorage full/unavailable); view state will stop persisting',
        err
      );
    }
  }
}

export function clearSequenceViewMemory(documentId: string): void {
  try {
    localStorage.removeItem(sequenceViewMemoryKey(documentId));
  } catch {}
}
