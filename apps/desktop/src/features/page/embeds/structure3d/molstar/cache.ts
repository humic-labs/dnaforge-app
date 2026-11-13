import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import {
  structureFetchIdentityCacheIdentity,
  type StructureFetchIdentity,
} from '../utils/structureData';
import {
  invalidateRendererHostActivations,
  type RendererHostActivationState,
} from './rendererHostActivation';

export type MolstarPlugin = PluginContext;

export interface CachedViewer {
  resourcePhase?: 'initializing' | 'active' | 'retired';
  container: HTMLDivElement;
  plugin: MolstarPlugin | null;
  isLoading: boolean;

  isInitializing?: boolean;
  error: string | null;
  lastUsed: number;

  loadedStructureKey?: string | null;

  logicalViewInstanceId?: string;

  rendererHostActivation?: RendererHostActivationState;
}

export type ViewerCacheLifecycleEvent =
  | 'insert'
  | 'delete'
  | 'clear'
  | 'pending-add'
  | 'pending-delete';

export interface ViewerCacheEntryLifecycleDiagnostic {
  isLoading: boolean;
  isInitializing: boolean;
  error: string | null;
  hasPlugin: boolean;
  isConnected: boolean;
  hasParent: boolean;
  childCount: number;
  lastUsed: number;
  loadedStructureKey: string | null;
}

export interface ViewerCacheActiveHandleLifecycleDiagnostic {
  structureKey: string;
  cacheKey: string;
  wrapperConnected: boolean;
  wrapperChildCount: number;
}

export interface ViewerCacheLifecycleDiagnostic {
  sequence: number;
  at: number;
  event: ViewerCacheLifecycleEvent;
  key: string | null;
  reason: string;
  existed: boolean;
  cacheSizeBefore: number;
  cacheSizeAfter: number;
  pendingKeys: string[];
  entry: ViewerCacheEntryLifecycleDiagnostic | null;
  activeHandles: ViewerCacheActiveHandleLifecycleDiagnostic[];
}

export interface ViewerCacheLifecycleSnapshot {
  cacheKeys: string[];
  pendingKeys: string[];
  activeHandles: ViewerCacheActiveHandleLifecycleDiagnostic[];
  events: ViewerCacheLifecycleDiagnostic[];
}

export interface ActiveMolstarViewer {
  structureKey: string;
  cacheKey: string;
  wrapper: HTMLDivElement;
  container: HTMLDivElement;
  plugin: MolstarPlugin;
}

export type ActiveMolstarViewerErrorCode = 'VIEWER_NOT_FOUND' | 'PLUGIN_NOT_READY';

export class ActiveMolstarViewerError extends Error {
  readonly code: ActiveMolstarViewerErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ActiveMolstarViewerErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ActiveMolstarViewerError';
    this.code = code;
    this.details = details;
  }
}

export const viewerCache = new Map<string, CachedViewer>();

export const pendingCreations = new Set<string>();

export const PANE_RENDERER_HOST_RELEASE_GRACE_MS = 1_500;
const cachedViewerLeaseCounts = new Map<string, number>();
const cachedViewerDisposalTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const MOLSTAR_VIEWER_RENDERER_CACHE_VERSION = 'renderer-v10-full-entry-complex-build';

type ActiveViewerHandle = {
  wrapper: HTMLDivElement;
  cacheKey: string;
};

const activeViewerHandles = new Map<string, Map<string, ActiveViewerHandle>>();

const MAX_VIEWER_CACHE_LIFECYCLE_DIAGNOSTICS = 240;
let viewerCacheLifecycleSequence = 0;
const viewerCacheLifecycleDiagnostics: ViewerCacheLifecycleDiagnostic[] = [];

const CACHE_TTL_MS = 5 * 60 * 1000;

function isActiveCacheEntry(cacheKey: string): boolean {
  for (const handles of activeViewerHandles.values()) {
    const handle = handles.get(cacheKey);
    if (handle?.wrapper.isConnected) return true;
  }
  return false;
}

function cacheEntryLifecycleDiagnostic(
  cached: CachedViewer | undefined
): ViewerCacheEntryLifecycleDiagnostic | null {
  if (!cached) return null;
  return {
    isLoading: cached.isLoading,
    isInitializing: cached.isInitializing === true,
    error: cached.error,
    hasPlugin: !!cached.plugin,
    isConnected: cached.container.isConnected,
    hasParent: !!cached.container.parentElement,
    childCount: cached.container.childElementCount,
    lastUsed: cached.lastUsed,
    loadedStructureKey: cached.loadedStructureKey ?? null,
  };
}

function activeHandleLifecycleDiagnostics(
  keyFilter?: string
): ViewerCacheActiveHandleLifecycleDiagnostic[] {
  const handles: ViewerCacheActiveHandleLifecycleDiagnostic[] = [];
  for (const [structureKey, handleMap] of activeViewerHandles.entries()) {
    for (const [cacheKey, handle] of handleMap.entries()) {
      if (keyFilter && cacheKey !== keyFilter && handle.cacheKey !== keyFilter) continue;
      handles.push({
        structureKey,
        cacheKey: handle.cacheKey,
        wrapperConnected: handle.wrapper.isConnected,
        wrapperChildCount: handle.wrapper.childElementCount,
      });
    }
  }
  return handles;
}

function recordViewerCacheLifecycleDiagnostic(
  event: ViewerCacheLifecycleEvent,
  key: string | null,
  reason: string,
  cacheSizeBefore: number,
  cacheSizeAfter: number,
  entry: CachedViewer | undefined,
  activeHandles: ViewerCacheActiveHandleLifecycleDiagnostic[] = activeHandleLifecycleDiagnostics(
    key ?? undefined
  )
): void {
  viewerCacheLifecycleDiagnostics.push({
    sequence: ++viewerCacheLifecycleSequence,
    at: Date.now(),
    event,
    key,
    reason,
    existed: !!entry,
    cacheSizeBefore,
    cacheSizeAfter,
    pendingKeys: Array.from(pendingCreations),
    entry: cacheEntryLifecycleDiagnostic(entry),
    activeHandles,
  });
  if (viewerCacheLifecycleDiagnostics.length > MAX_VIEWER_CACHE_LIFECYCLE_DIAGNOSTICS) {
    viewerCacheLifecycleDiagnostics.splice(
      0,
      viewerCacheLifecycleDiagnostics.length - MAX_VIEWER_CACHE_LIFECYCLE_DIAGNOSTICS
    );
  }
}

export function getViewerCacheLifecycleDiagnostics(): ViewerCacheLifecycleSnapshot {
  return {
    cacheKeys: Array.from(viewerCache.keys()),
    pendingKeys: Array.from(pendingCreations),
    activeHandles: activeHandleLifecycleDiagnostics(),
    events: [...viewerCacheLifecycleDiagnostics],
  };
}

export function clearViewerCacheLifecycleDiagnostics(): void {
  viewerCacheLifecycleDiagnostics.length = 0;
  viewerCacheLifecycleSequence = 0;
}

export function recordPendingCreationAdd(key: string, reason: string): void {
  const cacheSizeBefore = viewerCache.size;
  const existed = viewerCache.get(key);
  pendingCreations.add(key);
  recordViewerCacheLifecycleDiagnostic(
    'pending-add',
    key,
    reason,
    cacheSizeBefore,
    viewerCache.size,
    existed
  );
}

export function recordPendingCreationDelete(key: string, reason: string): void {
  const cacheSizeBefore = viewerCache.size;
  const existed = viewerCache.get(key);
  pendingCreations.delete(key);
  recordViewerCacheLifecycleDiagnostic(
    'pending-delete',
    key,
    reason,
    cacheSizeBefore,
    viewerCache.size,
    existed
  );
}

export function acquireCachedViewerLease(key: string): void {
  cachedViewerLeaseCounts.set(key, (cachedViewerLeaseCounts.get(key) ?? 0) + 1);
  const disposalTimer = cachedViewerDisposalTimers.get(key);
  if (disposalTimer) {
    clearTimeout(disposalTimer);
    cachedViewerDisposalTimers.delete(key);
  }
}

export function releaseCachedViewerLease(key: string): void {
  const nextCount = Math.max(0, (cachedViewerLeaseCounts.get(key) ?? 0) - 1);
  if (nextCount > 0) {
    cachedViewerLeaseCounts.set(key, nextCount);
    return;
  }
  cachedViewerLeaseCounts.delete(key);
  if (cachedViewerDisposalTimers.has(key)) return;

  const disposeWhenIdle = () => {
    cachedViewerDisposalTimers.delete(key);
    if ((cachedViewerLeaseCounts.get(key) ?? 0) > 0) return;
    const cached = viewerCache.get(key);
    if (!cached) return;
    if (cached.isLoading) {
      cachedViewerDisposalTimers.set(
        key,
        setTimeout(disposeWhenIdle, PANE_RENDERER_HOST_RELEASE_GRACE_MS)
      );
      return;
    }
    deleteCachedViewer(key, 'pane-renderer-host-unleased');
  };
  cachedViewerDisposalTimers.set(
    key,
    setTimeout(disposeWhenIdle, PANE_RENDERER_HOST_RELEASE_GRACE_MS)
  );
}

export function deleteCachedViewer(key: string, reason: string = 'deleteCachedViewer'): void {
  const disposalTimer = cachedViewerDisposalTimers.get(key);
  if (disposalTimer) clearTimeout(disposalTimer);
  cachedViewerDisposalTimers.delete(key);
  cachedViewerLeaseCounts.delete(key);
  const cacheSizeBefore = viewerCache.size;
  const cached = viewerCache.get(key);
  const handlesBeforeDelete = activeHandleLifecycleDiagnostics(key);
  for (const [structureKey, handles] of activeViewerHandles.entries()) {
    if (structureKey === key) {
      activeViewerHandles.delete(structureKey);
      continue;
    }
    for (const [cacheKey, handle] of handles.entries()) {
      if (cacheKey === key || handle.cacheKey === key) {
        handles.delete(cacheKey);
      }
    }
    if (handles.size === 0) {
      activeViewerHandles.delete(structureKey);
    }
  }
  viewerCache.delete(key);
  recordViewerCacheLifecycleDiagnostic(
    'delete',
    key,
    reason,
    cacheSizeBefore,
    viewerCache.size,
    cached,
    handlesBeforeDelete
  );

  const plugin = cached?.plugin;
  if (cached) {
    cached.resourcePhase = 'retired';
    cached.isLoading = false;
    cached.isInitializing = false;
    if (cached.rendererHostActivation)
      invalidateRendererHostActivations(cached.rendererHostActivation);
  }
  try {
    plugin?.dispose();
  } catch {}
}

const MAX_CACHE_SIZE = 16;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCacheCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, cached] of viewerCache.entries()) {
      if (
        now - cached.lastUsed > CACHE_TTL_MS &&
        !cached.container.isConnected &&
        !isActiveCacheEntry(key)
      ) {
        deleteCachedViewer(key, 'ttl-cleanup');
      }
    }

    if (viewerCache.size === 0 && cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }, 60000);
}

export function enforceCacheLimit(maxSize: number = MAX_CACHE_SIZE, protectedKey?: string): void {
  if (viewerCache.size <= maxSize) return;

  const entries = Array.from(viewerCache.entries());
  entries.sort((a, b) => {
    const aDisc = !a[1].container.isConnected;
    const bDisc = !b[1].container.isConnected;
    if (aDisc !== bDisc) return aDisc ? -1 : 1;
    return a[1].lastUsed - b[1].lastUsed;
  });
  let toEvict = viewerCache.size - maxSize;
  for (const [key] of entries) {
    if (toEvict <= 0) break;
    if (key === protectedKey) continue;
    if (isActiveCacheEntry(key)) continue;
    deleteCachedViewer(key, 'lru-eviction');
    toEvict -= 1;
  }
}

export function recordCacheInsert(key: string, value: CachedViewer): void {
  const cacheSizeBefore = viewerCache.size;
  viewerCache.set(key, value);
  recordViewerCacheLifecycleDiagnostic(
    'insert',
    key,
    'recordCacheInsert',
    cacheSizeBefore,
    viewerCache.size,
    value
  );
  enforceCacheLimit(MAX_CACHE_SIZE, key);
}

export function getViewerCacheKey(structureKey: string, viewerInstanceId?: string): string {
  if (!structureKey) return '';
  const rendererScopedKey = `${structureKey}::${MOLSTAR_VIEWER_RENDERER_CACHE_VERSION}`;
  if (!viewerInstanceId) return rendererScopedKey;
  return `${rendererScopedKey}::instance:${viewerInstanceId}`;
}

export function getPaneRendererHostCacheKey(
  rendererHostId: string,
  scope: 'loaded' | 'preview' = 'loaded'
): string {
  if (!rendererHostId) return '';
  const key = `${MOLSTAR_VIEWER_RENDERER_CACHE_VERSION}::pane-host:${rendererHostId}`;
  return scope === 'preview' ? `${key}:preview` : key;
}

export function registerActiveWrapper(
  structureKey: string,
  wrapper: HTMLDivElement,
  plugin: MolstarPlugin | null,
  cacheKey: string = structureKey
): void {
  const cached = viewerCache.get(cacheKey);
  if (!cached || cached.plugin !== plugin || cached.container.parentElement !== wrapper) {
    return;
  }
  cached.lastUsed = Date.now();
  const handles = activeViewerHandles.get(structureKey) ?? new Map<string, ActiveViewerHandle>();
  handles.set(cacheKey, { wrapper, cacheKey });
  activeViewerHandles.set(structureKey, handles);
}

export function unregisterActiveWrapper(
  structureKey: string,
  wrapper: HTMLDivElement,
  cacheKey?: string
): void {
  const handles = activeViewerHandles.get(structureKey);
  if (!handles) return;
  for (const [key, handle] of handles.entries()) {
    if (handle.wrapper === wrapper && (cacheKey === undefined || handle.cacheKey === cacheKey)) {
      handles.delete(key);
    }
  }
  if (handles.size === 0) {
    activeViewerHandles.delete(structureKey);
  }
}

export function hasActiveMolstarViewerHost(structureKey: string, registrationId?: string): boolean {
  const handles = activeViewerHandles.get(structureKey);
  if (!handles) return false;
  return Array.from(handles.values()).some((handle) => {
    const cached = viewerCache.get(handle.cacheKey);
    return (
      handle.wrapper.isConnected &&
      cached?.container.isConnected === true &&
      cached.container.parentElement === handle.wrapper &&
      (registrationId === undefined ||
        handle.wrapper
          .closest('[data-structure-agent-host]')
          ?.getAttribute('data-structure-agent-host') === registrationId)
    );
  });
}

export async function withActivePlugin<T>(
  structureKey: string,
  fn: (active: ActiveMolstarViewer) => T | Promise<T>,
  options: { cacheKey?: string } = {}
): Promise<T> {
  const handles = activeViewerHandles.get(structureKey);
  const activeHandle = options.cacheKey
    ? handles?.get(options.cacheKey)
    : handles
      ? Array.from(handles.values()).find((handle) => {
          const cached = viewerCache.get(handle.cacheKey);
          return (
            handle.wrapper.isConnected &&
            cached?.container.isConnected &&
            cached.container.parentElement === handle.wrapper
          );
        })
      : undefined;
  const exactHandleIsActive =
    options.cacheKey && activeHandle
      ? (() => {
          const cached = viewerCache.get(activeHandle.cacheKey);
          return (
            activeHandle.wrapper.isConnected &&
            cached?.container.isConnected &&
            cached.container.parentElement === activeHandle.wrapper
          );
        })()
      : true;
  const cacheKey = activeHandle?.cacheKey ?? options.cacheKey ?? structureKey;
  const cached = viewerCache.get(cacheKey);
  if (!cached) {
    throw new ActiveMolstarViewerError('VIEWER_NOT_FOUND', `No viewer with id ${structureKey}.`, {
      viewerId: structureKey,
    });
  }
  if (cached.isLoading || cached.error || !cached.plugin) {
    throw new ActiveMolstarViewerError(
      'PLUGIN_NOT_READY',
      `Mol* plugin is not ready for viewer ${structureKey}.`,
      { viewerId: structureKey, error: cached.error }
    );
  }

  const wrapper = activeHandle?.wrapper ?? null;
  if (
    !exactHandleIsActive ||
    !wrapper ||
    !wrapper.isConnected ||
    cached.container.parentElement !== wrapper ||
    !cached.container.isConnected
  ) {
    throw new ActiveMolstarViewerError(
      'VIEWER_NOT_FOUND',
      `No active viewer with id ${structureKey}.`,
      {
        viewerId: structureKey,
      }
    );
  }

  return fn({
    structureKey,
    cacheKey,
    wrapper,
    container: cached.container,
    plugin: cached.plugin,
  });
}

export interface StructurePluginSummary {
  key: string;
  isLoading: boolean;
  isBusy?: boolean;
  isUpdating?: boolean;
  error: string | null;
  hasPlugin: boolean;
  isConnected: boolean;
  loadedStructureKey: string | null;
  requestedStructureKey: string | null;
  structureCount: number;
  modelIds: string[];
  representationCount: number;
  componentLabels: string[];
}

export interface StructureSpinDiagnostic extends StructurePluginSummary {
  trackballAnimateName: string | null;
  trackballAnimateParams: unknown;
  cameraSnapshot: unknown;
  canvasPostprocessing: unknown;
  canvasMarking: unknown;
  canvasRenderer: unknown;
  canvasTransparency: unknown;
  sceneMarkerAverage: number | null;
  renderObjectMarkerAverages: number[];
}

export interface StructureDrawDiagnostic extends StructurePluginSummary {
  drewFrame: boolean;
  canvasRepresentationCount: number;
  canvasWidth: number;
  canvasHeight: number;
  scientificContentReady: boolean;
  reason: string;
}

export interface StructureRepresentationDiagnostic extends StructurePluginSummary {
  components: Array<{
    label: string | null;
    ref: string | null;
    elementCount: number;
    chains: StructureChainInventoryDiagnostic['chains'];
    representations: Array<{
      ref: string | null;
      tags: string[];
      typeName: string | null;
      typeParams: Record<string, unknown>;
      colorThemeName: string | null;
      colorThemeParams: Record<string, unknown>;
      sizeThemeName: string | null;
      sizeThemeParams: Record<string, unknown>;
      alpha: number | null;
    }>;
  }>;
}

export interface StructureChainInventoryDiagnostic extends StructurePluginSummary {
  chains: Array<{
    labelAsymId: string | null;
    authAsymId: string | null;
    entityId: string | null;
    entityType: string | null;
    entitySubtype: string | null;
    operatorName: string | null;
    unitKind: string | number | null;
    elementCount: number;
  }>;
}

export function getStructurePluginSummary(structureKey?: string): StructurePluginSummary[] {
  return Array.from(viewerCache.entries())
    .filter(
      ([key, cached]) =>
        !structureKey ||
        cached.loadedStructureKey === structureKey ||
        key === structureKey ||
        key.startsWith(`${structureKey}::`)
    )
    .map(([key, cached]) => {
      const structures = cached.plugin?.managers?.structure?.hierarchy?.current?.structures ?? [];
      const componentLabels: string[] = [];
      const representationCount = structures.reduce((sum: number, structure: unknown) => {
        const components = (structure as { components?: unknown[] })?.components ?? [];
        for (const component of components) {
          const label = (component as { cell?: { obj?: { label?: unknown } } })?.cell?.obj?.label;
          if (typeof label === 'string') componentLabels.push(label);
        }
        return (
          sum +
          components.reduce((componentSum: number, component: unknown) => {
            const representations =
              (component as { representations?: unknown[] })?.representations ?? [];
            return componentSum + representations.length;
          }, 0)
        );
      }, 0);
      return {
        key,
        isLoading: cached.isLoading,
        isBusy: cached.plugin?.isBusy === true,
        isUpdating: cached.plugin?.behaviors?.state?.isUpdating?.value === true,
        error: cached.error,
        hasPlugin: !!cached.plugin,
        isConnected: cached.container.isConnected,
        loadedStructureKey:
          cached.rendererHostActivation?.loadedStructureKey ?? cached.loadedStructureKey ?? null,
        requestedStructureKey:
          cached.rendererHostActivation?.requestedStructureKey ?? cached.loadedStructureKey ?? null,
        structureCount: structures.length,
        modelIds: structures.flatMap(
          (structure) => structure.cell.obj?.data.models.map((model) => model.id) ?? []
        ),
        representationCount,
        componentLabels,
      };
    });
}

export function getStructureSpinDiagnostics(structureKey?: string): StructureSpinDiagnostic[] {
  return getStructurePluginSummary(structureKey).map((summary) => {
    const cached = viewerCache.get(summary.key);
    const canvas3d = cached?.plugin?.canvas3d as
      | {
          props?: {
            trackball?: {
              animate?: {
                name?: string;
                params?: unknown;
              };
            };
            postprocessing?: unknown;
            marking?: unknown;
            renderer?: unknown;
          };
          camera?: {
            getSnapshot?: () => unknown;
          };
          scene?: {
            markerAverage?: unknown;
          };
          getRenderObjects?: () => Array<{
            values?: {
              markerAverage?: {
                ref?: {
                  value?: unknown;
                };
              };
            };
          }>;
        }
      | undefined;
    const animate = canvas3d?.props?.trackball?.animate;
    return {
      ...summary,
      trackballAnimateName: animate?.name ?? null,
      trackballAnimateParams: animate?.params ?? null,
      cameraSnapshot: canvas3d?.camera?.getSnapshot?.() ?? null,
      canvasPostprocessing: canvas3d?.props?.postprocessing ?? null,
      canvasMarking: canvas3d?.props?.marking ?? null,
      canvasRenderer: canvas3d?.props?.renderer ?? null,
      canvasTransparency: cached?.plugin?.canvas3dContext?.props?.transparency ?? null,
      sceneMarkerAverage:
        typeof canvas3d?.scene?.markerAverage === 'number' ? canvas3d.scene.markerAverage : null,
      renderObjectMarkerAverages:
        canvas3d
          ?.getRenderObjects?.()
          .map((renderObject) => renderObject.values?.markerAverage?.ref?.value)
          .filter((value): value is number => typeof value === 'number') ?? [],
    };
  });
}

export async function requestStructureDrawDiagnostics(
  structureKey?: string,
  timeoutMs = 2_500
): Promise<StructureDrawDiagnostic[]> {
  const summaries = getStructurePluginSummary(structureKey);
  return Promise.all(
    summaries.map(async (summary) => {
      const cached = viewerCache.get(summary.key);
      const canvas = cached?.container.querySelector('canvas');
      const canvas3d = cached?.plugin?.canvas3d as
        | {
            requestDraw?: () => void;
            commit?: (isSynchronous?: boolean) => void;
            animate?: () => void;
            didDraw?: {
              subscribe?: (listener: () => void) => { unsubscribe?: () => void };
            };
            reprCount?: { value?: number };
          }
        | undefined;
      const canvasWidth = canvas?.width ?? 0;
      const canvasHeight = canvas?.height ?? 0;
      const canvasRepresentationCount = canvas3d?.reprCount?.value ?? 0;

      if (!summary.isConnected || !canvas || !canvas3d) {
        return {
          ...summary,
          drewFrame: false,
          canvasRepresentationCount,
          canvasWidth,
          canvasHeight,
          scientificContentReady: false,
          reason: !summary.isConnected
            ? 'viewer_not_connected'
            : !canvas
              ? 'canvas_missing'
              : 'canvas3d_missing',
        };
      }

      const drewFrame = await new Promise<boolean>((resolve) => {
        let armed = false;
        let settled = false;
        const cleanup: {
          timer?: ReturnType<typeof setTimeout>;
          subscription?: { unsubscribe?: () => void };
        } = {};
        const finish = (value: boolean): void => {
          if (settled) return;
          settled = true;
          if (cleanup.timer) clearTimeout(cleanup.timer);
          cleanup.subscription?.unsubscribe?.();
          resolve(value);
        };
        cleanup.subscription = canvas3d.didDraw?.subscribe?.(() => {
          if (armed) finish(true);
        });
        cleanup.timer = setTimeout(() => finish(false), timeoutMs);
        armed = true;
        canvas3d.requestDraw?.();
        canvas3d.commit?.(true);
        canvas3d.animate?.();
      });

      const currentCached = viewerCache.get(summary.key);
      const currentSummary = getStructurePluginSummary(summary.key).find(
        (candidate) => candidate.key === summary.key
      );
      const currentCanvas = currentCached?.container.querySelector('canvas');
      const currentCanvas3d = currentCached?.plugin?.canvas3d as
        | { reprCount?: { value?: number } }
        | undefined;
      const viewerUnchanged =
        currentCached === cached &&
        currentCached?.plugin === cached?.plugin &&
        currentCanvas === canvas &&
        currentCanvas3d === canvas3d;
      const postDrawSummary: StructurePluginSummary = currentSummary ?? {
        ...summary,
        isLoading: false,
        error: null,
        hasPlugin: false,
        isConnected: false,
        loadedStructureKey: null,
        requestedStructureKey: null,
        structureCount: 0,
        representationCount: 0,
        componentLabels: [],
      };
      const currentCanvasWidth = currentCanvas?.width ?? 0;
      const currentCanvasHeight = currentCanvas?.height ?? 0;
      const currentCanvasRepresentationCount = currentCanvas3d?.reprCount?.value ?? 0;
      const scientificContentReady =
        drewFrame &&
        viewerUnchanged &&
        postDrawSummary.isConnected &&
        !postDrawSummary.isLoading &&
        !postDrawSummary.error &&
        postDrawSummary.hasPlugin &&
        postDrawSummary.loadedStructureKey !== null &&
        postDrawSummary.requestedStructureKey === postDrawSummary.loadedStructureKey &&
        currentCanvasWidth >= 40 &&
        currentCanvasHeight >= 40 &&
        currentCanvasRepresentationCount > 0 &&
        postDrawSummary.structureCount > 0 &&
        postDrawSummary.representationCount > 0;

      const reason = scientificContentReady
        ? 'molstar_did_draw_scientific_scene'
        : !drewFrame
          ? 'draw_timeout'
          : !currentCached
            ? 'viewer_removed_during_draw'
            : !viewerUnchanged
              ? 'viewer_changed_during_draw'
              : !postDrawSummary.isConnected
                ? 'viewer_disconnected_during_draw'
                : postDrawSummary.isLoading
                  ? 'viewer_loading'
                  : postDrawSummary.error
                    ? 'viewer_error'
                    : !postDrawSummary.hasPlugin
                      ? 'plugin_missing'
                      : postDrawSummary.loadedStructureKey === null ||
                          postDrawSummary.requestedStructureKey !==
                            postDrawSummary.loadedStructureKey
                        ? 'structure_identity_not_ready'
                        : 'scene_not_ready';

      return {
        ...postDrawSummary,
        drewFrame,
        canvasRepresentationCount: currentCanvasRepresentationCount,
        canvasWidth: currentCanvasWidth,
        canvasHeight: currentCanvasHeight,
        scientificContentReady,
        reason,
      };
    })
  );
}

export function getStructureRepresentationDiagnostics(
  structureKey?: string
): StructureRepresentationDiagnostic[] {
  return getStructurePluginSummary(structureKey).map((summary) => {
    const cached = viewerCache.get(summary.key);
    const structures = cached?.plugin?.managers?.structure?.hierarchy?.current?.structures ?? [];
    const components = structures.flatMap((structure: unknown) =>
      (((structure as { components?: unknown[] })?.components ?? []) as unknown[]).map(
        (component) => {
          const componentCell = (component as { cell?: unknown }).cell as
            | {
                obj?: { label?: unknown; data?: unknown };
                transform?: { ref?: unknown };
              }
            | undefined;
          const representations =
            (component as { representations?: unknown[] })?.representations ?? [];
          return {
            label: typeof componentCell?.obj?.label === 'string' ? componentCell.obj.label : null,
            ref:
              typeof componentCell?.transform?.ref === 'string'
                ? componentCell.transform.ref
                : null,
            elementCount: structureElementCount(componentCell?.obj?.data),
            chains: chainInventoryForStructure(componentCell?.obj?.data),
            representations: representations.map(representationDiagnostic),
          };
        }
      )
    );

    return {
      ...summary,
      components,
    };
  });
}

export function getStructureChainInventoryDiagnostics(
  structureKey?: string
): StructureChainInventoryDiagnostic[] {
  return getStructurePluginSummary(structureKey).map((summary) => {
    const cached = viewerCache.get(summary.key);
    const structures = cached?.plugin?.managers?.structure?.hierarchy?.current?.structures ?? [];
    const chains = structures.flatMap((structure: unknown) =>
      chainInventoryForStructure(
        (structure as { cell?: { obj?: { data?: unknown } } })?.cell?.obj?.data
      )
    );
    return {
      ...summary,
      chains,
    };
  });
}

function chainInventoryForStructure(
  structureData: unknown
): StructureChainInventoryDiagnostic['chains'] {
  const units = (structureData as { units?: unknown[] } | undefined)?.units ?? [];
  const seen = new Set<string>();
  const chains: StructureChainInventoryDiagnostic['chains'] = [];
  for (const unit of units) {
    const unitRecord = unit as {
      kind?: string | number;
      elements?: ArrayLike<number>;
      chainIndex?: ArrayLike<number>;
      model?: {
        atomicHierarchy?: {
          chains?: {
            label_asym_id?: { value?: (index: number) => unknown };
            auth_asym_id?: { value?: (index: number) => unknown };
            label_entity_id?: { value?: (index: number) => unknown };
          };
          index?: { getEntityFromChain?: (index: number) => number };
        };
        entities?: {
          data?: { type?: { value?: (index: number) => unknown } };
          subtype?: { value?: (index: number) => unknown };
        };
      };
      conformation?: { operator?: { name?: unknown } };
    };
    const firstElement = unitRecord.elements?.[0];
    if (typeof firstElement !== 'number') continue;
    const chainIndex = unitRecord.chainIndex?.[firstElement];
    if (typeof chainIndex !== 'number') continue;
    const hierarchy = unitRecord.model?.atomicHierarchy;
    const entityIndex = hierarchy?.index?.getEntityFromChain?.(chainIndex);
    const labelAsymId = stringOrNull(hierarchy?.chains?.label_asym_id?.value?.(chainIndex));
    const authAsymId = stringOrNull(hierarchy?.chains?.auth_asym_id?.value?.(chainIndex));
    const entityId = stringOrNull(hierarchy?.chains?.label_entity_id?.value?.(chainIndex));
    const entityType =
      typeof entityIndex === 'number'
        ? stringOrNull(unitRecord.model?.entities?.data?.type?.value?.(entityIndex))
        : null;
    const entitySubtype =
      typeof entityIndex === 'number'
        ? stringOrNull(unitRecord.model?.entities?.subtype?.value?.(entityIndex))
        : null;
    const operatorName = stringOrNull(unitRecord.conformation?.operator?.name);
    const key = [
      labelAsymId,
      authAsymId,
      entityId,
      entityType,
      entitySubtype,
      operatorName,
      String(unitRecord.kind ?? ''),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    chains.push({
      labelAsymId,
      authAsymId,
      entityId,
      entityType,
      entitySubtype,
      operatorName,
      unitKind: unitRecord.kind ?? null,
      elementCount: unitRecord.elements?.length ?? 0,
    });
  }
  return chains;
}

function structureElementCount(structureData: unknown): number {
  const units = (structureData as { units?: unknown[] } | undefined)?.units ?? [];
  return units.reduce<number>((sum, unit) => {
    const elements = (unit as { elements?: ArrayLike<number> } | undefined)?.elements;
    return sum + (elements?.length ?? 0);
  }, 0);
}

function representationDiagnostic(
  representation: unknown
): StructureRepresentationDiagnostic['components'][number]['representations'][number] {
  const cell = (representation as { cell?: unknown }).cell as
    | {
        params?: { values?: unknown };
        transform?: { ref?: unknown; tags?: unknown; params?: unknown };
        obj?: { tags?: unknown; params?: { values?: unknown } };
      }
    | undefined;
  const params = asRecord(
    cell?.params?.values ?? cell?.transform?.params ?? cell?.obj?.params?.values
  );
  const type = asMappedParam(params.type);
  const colorTheme = asMappedParam(params.colorTheme);
  const sizeTheme = asMappedParam(params.sizeTheme);
  const typeParams = asRecord(type.params);

  return {
    ref: typeof cell?.transform?.ref === 'string' ? cell.transform.ref : null,
    tags: representationTags(cell),
    typeName: type.name,
    typeParams,
    colorThemeName: colorTheme.name,
    colorThemeParams: asRecord(colorTheme.params),
    sizeThemeName: sizeTheme.name,
    sizeThemeParams: asRecord(sizeTheme.params),
    alpha: typeof typeParams.alpha === 'number' ? typeParams.alpha : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asMappedParam(value: unknown): { name: string | null; params: unknown } {
  if (!value || typeof value !== 'object') return { name: null, params: {} };
  const record = value as { name?: unknown; params?: unknown };
  return {
    name: typeof record.name === 'string' ? record.name : null,
    params: record.params ?? {},
  };
}

function representationTags(cell: unknown): string[] {
  const record = cell as
    | {
        transform?: { tags?: unknown };
        obj?: { tags?: unknown };
      }
    | undefined;
  const tags = record?.transform?.tags ?? record?.obj?.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

function hashStructureData(data: string | Uint8Array): string {
  let hash = 5381;
  for (let i = 0; i < data.length; i++) {
    const value = typeof data === 'string' ? data.charCodeAt(i) : data[i];
    hash = ((hash << 5) + hash) ^ value;
    hash = hash >>> 0;
  }
  return hash.toString(16);
}

export function getStructureKey(
  pdbId?: string,
  uniprotId?: string,
  url?: string,
  structureData?: string | Uint8Array,
  structureIdentity?: StructureFetchIdentity,
  structureDataFormat?: 'pdb' | 'mmcif',
  coordinateModel?: { blockIndex: number; modelIndex: number }
): string {
  if (structureIdentity) return `provider:${structureIdentityKey(structureIdentity)}`;
  if (pdbId) return `provider:RCSB:${pdbId.toUpperCase()}:ENTRY`;
  if (uniprotId) return `provider:AF:${uniprotId.toUpperCase()}:F1:LATEST`;
  if (url) return `url:${url}`;
  if (structureData)
    return `data:${structureDataFormat ?? 'auto'}:${hashStructureData(structureData)}${coordinateModel && (coordinateModel.blockIndex || coordinateModel.modelIndex) ? `:block:${coordinateModel.blockIndex}:model:${coordinateModel.modelIndex}` : ''}`;
  return '';
}

function structureIdentityKey(identity: StructureFetchIdentity): string {
  return structureFetchIdentityCacheIdentity(identity);
}

export function clearViewerCache(reason: string = 'clearViewerCache'): void {
  console.log('[viewerCache] Clearing all cached viewers:', Array.from(viewerCache.keys()));
  recordViewerCacheLifecycleDiagnostic(
    'clear',
    null,
    reason,
    viewerCache.size,
    viewerCache.size,
    undefined,
    activeHandleLifecycleDiagnostics()
  );
  for (const key of viewerCache.keys()) {
    deleteCachedViewer(key, `${reason}:entry`);
  }
  for (const timer of cachedViewerDisposalTimers.values()) clearTimeout(timer);
  cachedViewerDisposalTimers.clear();
  cachedViewerLeaseCounts.clear();
  activeViewerHandles.clear();
  pendingCreations.clear();
}

export function dumpCacheState(): void {
  console.log('[viewerCache] DIAGNOSTIC DUMP:', {
    cacheSize: viewerCache.size,
    pendingCount: pendingCreations.size,
    activeCount: Array.from(activeViewerHandles.values()).reduce(
      (count, handles) => count + handles.size,
      0
    ),
    entries: Array.from(viewerCache.entries()).map(([key, cached]) => ({
      key,
      isLoading: cached.isLoading,
      error: cached.error,
      hasPlugin: !!cached.plugin,
      isActive: Array.from(activeViewerHandles.values()).some((handles) =>
        Array.from(handles.values()).some(
          (handle) => handle.cacheKey === key && handle.wrapper === cached.container.parentElement
        )
      ),
      isConnected: cached.container.isConnected,
      hasParent: !!cached.container.parentElement,
      childCount: cached.container.childElementCount,
      lastUsed: new Date(cached.lastUsed).toISOString(),
    })),
    pending: Array.from(pendingCreations),
  });
}

import { shouldEnableTestBridge } from '../../../../../lib/test-bridge-gate';

if (typeof window !== 'undefined' && shouldEnableTestBridge(import.meta.env)) {
  const testWindow = window as Window & {
    __dumpCacheState?: typeof dumpCacheState;
    __clearStructureCache?: () => void;
    __viewerCacheKeys?: () => string[];
    __getStructurePluginSummary?: typeof getStructurePluginSummary;
    __getStructureRepresentationDiagnostics?: typeof getStructureRepresentationDiagnostics;
    __getViewerCacheLifecycleDiagnostics?: typeof getViewerCacheLifecycleDiagnostics;
  };
  testWindow.__dumpCacheState = dumpCacheState;
  testWindow.__clearStructureCache = () => {
    clearViewerCache();
    console.log('[viewerCache] Cache cleared! Reload page to see fresh data.');
  };
  testWindow.__viewerCacheKeys = () => {
    console.log('[viewerCache] Cached structures:', Array.from(viewerCache.keys()));
    return Array.from(viewerCache.keys());
  };
  testWindow.__getStructurePluginSummary = getStructurePluginSummary;
  testWindow.__getStructureRepresentationDiagnostics = getStructureRepresentationDiagnostics;
  testWindow.__getViewerCacheLifecycleDiagnostics = getViewerCacheLifecycleDiagnostics;
}
