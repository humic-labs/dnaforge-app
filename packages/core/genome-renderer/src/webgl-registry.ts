import type { Application } from 'pixi.js';

type PixiAppInspect = {
  canvas?: HTMLCanvasElement;
  ticker?: { started?: boolean };
  renderer?: { resolution?: number };
  stage?: { children?: { length?: number } };
  destroyed?: boolean;
};

function inspectPixiApp(app: unknown): PixiAppInspect {
  return app as PixiAppInspect;
}
import type { Genome, RenderState } from './types';
import { isWebGLDiagnosticsEnabled } from './diagnostics-gate';
import type { PrebuiltGenomeWideTextureMeta } from './renderers/pixi/overview/genome-wide-texture-cache-layer';
import type {
  GenomeWideTextureExtractResult,
  PixiLinearRendererAnnotationPolicyReadinessSnapshotV1,
  PixiLinearRendererColdGestureSnapshot,
  PixiLinearRendererOperationSnapshot,
} from './renderers/pixi/linear-renderer';
import type {
  PrepackedAnnotationSceneLoadInput,
  PrepackedAnnotationSceneOwnerSnapshot,
} from './renderers/pixi/overview/prepacked-annotation-scene';
import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from './renderers/pixi/overview/bounded-annotation-broad-surface';
import type {
  CompiledBroadSurfaceDemandV2,
  CompiledBroadSurfaceRequirementV1,
  CompiledBroadSurfaceSourcePlacementAuthorityV1,
  CompiledBroadSurfaceRgbaCellAdmissionInputV2,
  CompiledBroadSurfaceRgbaCellAdmissionResultV2,
  CompiledBroadSurfaceResidentLeaseReconcileResultV1,
  CompiledBroadSurfaceRuntimeDiagnosticsV2,
  CompiledBroadSurfaceTransparentCellAdmissionInputV2,
} from './renderers/pixi/overlays/annotation-overlay';
import type { AnnotationPolicyGpuRuntimeV1 } from './renderers/pixi/overview/annotation-policy-gpu-instances-v1';

export const ACTIVE_COMPILED_BROAD_SURFACE_SNAPSHOT_V2 =
  'active-compiled-broad-surface-snapshot.v2' as const;

interface ActiveCompiledBroadSurfaceSnapshotBaseV2 {
  readonly contract: typeof ACTIVE_COMPILED_BROAD_SURFACE_SNAPSHOT_V2;
  readonly verdict: 'exactly-one' | 'none' | 'ambiguous';
  readonly instanceId: string | null;
  readonly instanceCreatedAt: number | null;
  readonly visibleLiveInstanceCount: number;
  readonly candidateInstanceIds: readonly string[];
}

export interface ActiveCompiledBroadSurfaceDiagnosticsSnapshotV2 extends ActiveCompiledBroadSurfaceSnapshotBaseV2 {
  readonly diagnostics: CompiledBroadSurfaceRuntimeDiagnosticsV2 | null;
}

export interface ActiveCompiledBroadSurfaceDemandSnapshotV2 extends ActiveCompiledBroadSurfaceSnapshotBaseV2 {
  readonly demand: CompiledBroadSurfaceDemandV2 | null;
}

export interface WebGLInstanceHandle {
  readonly instanceId: string;
  readonly createdAt: number;
  readonly containerRef: { readonly current: HTMLElement | null };
  readonly appRef: { readonly current: Application | null };
  readonly rendererRef?: { readonly current: unknown | null };
  readonly stateRef: { readonly current: RenderState };
  readonly visibleRef: { readonly current: boolean };
  readonly genomeRef: { readonly current: Genome | null };
  readonly frameCountRef: { readonly current: number };
  readonly lastFrameTRef: { readonly current: number };
  readonly fatalFrameCircuitRef?: {
    readonly current: WebGLFatalFrameCircuitSnapshot | null;
  };
  readonly schedulePostPresentWork?: (
    work: (deadlineMs: number) => void,
    onDropped: (reason: WebGLPostPresentWorkDropReason) => void
  ) => void;
}

export type WebGLPostPresentWorkDropReason = 'teardown' | 'fatal-frame-circuit';

export type WebGLPostPresentWorkScheduleResult =
  | 'scheduled'
  | 'not-found'
  | 'ambiguous'
  | 'inactive'
  | 'fatal-frame-circuit'
  | 'unsupported';

const instances = new Map<string, WebGLInstanceHandle>();

export function registerWebGLInstance(h: WebGLInstanceHandle): void {
  instances.set(h.instanceId, h);
}

export function unregisterWebGLInstance(instanceId: string): void {
  instances.delete(instanceId);
}

export function scheduleWebGLPostPresentWorkForRenderer(
  renderer: unknown,
  work: (deadlineMs: number) => void,
  onDropped: (reason: WebGLPostPresentWorkDropReason) => void
): WebGLPostPresentWorkScheduleResult {
  const owners = [...instances.values()].filter(
    (instance) => instance.rendererRef?.current === renderer
  );
  if (owners.length === 0) return 'not-found';
  if (owners.length !== 1) return 'ambiguous';
  const owner = owners[0];
  if (owner.fatalFrameCircuitRef?.current != null) return 'fatal-frame-circuit';
  const container = owner.containerRef.current;
  const app = owner.appRef.current as (Application & { destroyed?: boolean }) | null;
  if (container?.isConnected !== true || app === null || app.destroyed === true) {
    return 'inactive';
  }
  if (typeof owner.schedulePostPresentWork !== 'function') return 'unsupported';
  owner.schedulePostPresentWork(work, onDropped);
  return 'scheduled';
}

export interface WebGLFatalFrameCircuitSnapshot {
  readonly status: 'open';
  readonly instance: string;
  readonly phase: string;
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly consecutiveFrameErrors: number;
  readonly frameCount: number;
  readonly renderRevision: number;
  readonly zoom: number;
  readonly viewOffset: number;
  readonly width: number;
  readonly height: number;
  readonly openedAt: number;
}

export interface WebGLInstanceSnapshot {
  instanceId: string;
  createdAt: number;
  ageMs: number;
  visible: boolean;
  msSinceLastFrame: number | null;
  frameCount: number;
  frameCircuit: WebGLFatalFrameCircuitSnapshot | null;
  container: {
    connected: boolean;
    clientRect: { x: number; y: number; w: number; h: number } | null;
    childCanvases: number;
  };
  app: {
    alive: boolean;
    destroyed: boolean | null;
    tickerRunning: boolean | null;
    rendererResolution: number | null;
    stageChildren: number | null;
    canvasEl: {
      widthAttr: number;
      heightAttr: number;
      cssWidth: number;
      cssHeight: number;
      clientRect: { x: number; y: number; w: number; h: number };
    } | null;
  };
  state: {
    zoom: number;
    viewOffset: number;
    width: number;
    height: number;
    geometryHeight: number;
    themeMode: RenderState['themeMode'];
    morph: number;
    hoveredId: number | null;
    selectedIdsSize: number;
    annotationSearchFocus: RenderState['annotationSearchFocus'];
    viewportRange: [number, number] | null;
    highlightRange: [number, number] | null;
    proteinSearchHighlightRanges: ReadonlyArray<readonly [number, number]> | null;
    digestFocusRange: [number, number] | null;
    residueLinkRange: [number, number] | null;
    cursorPosition: number | null;
    cursorBlinking: boolean;
    hoverPosition: number | null;
    backboneSegmentCount: number;
    hoveredCodon: { start: number; end: number; strand: 1 | -1 } | null;
    selectedCodons: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>;
  };
  genome: { name: string; length: number; featureCount: number; primerCount: number } | null;
  renderer: {
    operationOracle: PixiLinearRendererOperationSnapshot | null;
    primerDebug: unknown | null;
    viewportDebug: unknown | null;
    rendererDebug: unknown | null;
  };
}

function safeRect(el: Element | null): { x: number; y: number; w: number; h: number } | null {
  if (!el) return null;
  try {
    const r = el.getBoundingClientRect();
    return {
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
    };
  } catch {
    return null;
  }
}

function collectRendererDebugSnapshots(renderer: unknown): {
  operationOracle: PixiLinearRendererOperationSnapshot | null;
  primerDebug: unknown | null;
  viewportDebug: unknown | null;
  rendererDebug: unknown | null;
} {
  let operationOracle: PixiLinearRendererOperationSnapshot | null = null;
  let primerDebug: unknown | null = null;
  let viewportDebug: unknown | null = null;
  let rendererDebug: unknown | null = null;
  try {
    const maybe = renderer as
      | {
          getRendererOperationSnapshot?: () => PixiLinearRendererOperationSnapshot;
        }
      | null
      | undefined;
    operationOracle = maybe?.getRendererOperationSnapshot?.() ?? null;
  } catch {
    operationOracle = null;
  }
  try {
    const maybe = renderer as { getPrimerDebugSnapshot?: () => unknown } | null | undefined;
    primerDebug = maybe?.getPrimerDebugSnapshot?.() ?? null;
  } catch {
    primerDebug = null;
  }
  try {
    const maybe = renderer as { getViewportDebugSnapshot?: () => unknown } | null | undefined;
    viewportDebug = maybe?.getViewportDebugSnapshot?.() ?? null;
  } catch {
    viewportDebug = null;
  }
  try {
    const maybe = renderer as { getRendererDebugSnapshot?: () => unknown } | null | undefined;
    rendererDebug = maybe?.getRendererDebugSnapshot?.() ?? null;
  } catch {
    rendererDebug = null;
  }
  return { operationOracle, primerDebug, viewportDebug, rendererDebug };
}

function inspectLivePixiAppFields(app: NonNullable<WebGLInstanceHandle['appRef']['current']>): {
  canvasEl: HTMLCanvasElement | null;
  tickerRunning: boolean | null;
  rendererResolution: number | null;
  stageChildren: number | null;
  destroyed: boolean | null;
} {
  let canvasEl: HTMLCanvasElement | null = null;
  let tickerRunning: boolean | null = null;
  let rendererResolution: number | null = null;
  let stageChildren: number | null = null;
  let destroyed: boolean | null = null;
  try {
    canvasEl = inspectPixiApp(app).canvas ?? null;
  } catch {}
  try {
    const t = inspectPixiApp(app).ticker;
    tickerRunning = t?.started ?? null;
  } catch {}
  try {
    const r = inspectPixiApp(app).renderer;
    rendererResolution = r?.resolution ?? null;
  } catch {}
  try {
    const s = inspectPixiApp(app).stage;
    stageChildren = s?.children?.length ?? null;
  } catch {}
  try {
    destroyed = inspectPixiApp(app).destroyed ?? null;
  } catch {
    destroyed = null;
  }
  return { canvasEl, tickerRunning, rendererResolution, stageChildren, destroyed };
}

function snapshotOne(h: WebGLInstanceHandle, now: number): WebGLInstanceSnapshot {
  const container = h.containerRef.current;
  const app = h.appRef.current;
  const state = h.stateRef.current;
  const genome = h.genomeRef.current;
  const renderer = h.rendererRef?.current;

  const appAlive = !!app;
  const { canvasEl, tickerRunning, rendererResolution, stageChildren, destroyed } = app
    ? inspectLivePixiAppFields(app)
    : {
        canvasEl: null,
        tickerRunning: null,
        rendererResolution: null,
        stageChildren: null,
        destroyed: null,
      };

  const canvasInfo = canvasEl
    ? (() => {
        const r = canvasEl.getBoundingClientRect();
        const cs = getComputedStyle(canvasEl);
        return {
          widthAttr: canvasEl.width,
          heightAttr: canvasEl.height,
          cssWidth: parseFloat(cs.width) || 0,
          cssHeight: parseFloat(cs.height) || 0,
          clientRect: {
            x: +r.x.toFixed(1),
            y: +r.y.toFixed(1),
            w: +r.width.toFixed(1),
            h: +r.height.toFixed(1),
          },
        };
      })()
    : null;

  const childCanvases = container ? container.querySelectorAll('canvas').length : 0;
  const { operationOracle, primerDebug, viewportDebug, rendererDebug } =
    collectRendererDebugSnapshots(renderer);

  return {
    instanceId: h.instanceId,
    createdAt: h.createdAt,
    ageMs: +(now - h.createdAt).toFixed(1),
    visible: h.visibleRef.current,
    msSinceLastFrame:
      h.lastFrameTRef.current > 0 ? +(now - h.lastFrameTRef.current).toFixed(1) : null,
    frameCount: h.frameCountRef.current,
    frameCircuit: h.fatalFrameCircuitRef?.current ? { ...h.fatalFrameCircuitRef.current } : null,
    container: {
      connected: !!container && container.isConnected,
      clientRect: safeRect(container),
      childCanvases,
    },
    app: {
      alive: appAlive,
      destroyed,
      tickerRunning,
      rendererResolution,
      stageChildren,
      canvasEl: canvasInfo,
    },
    state: {
      zoom: state.zoom,
      viewOffset: state.viewOffset,
      width: state.width,
      height: state.height,
      geometryHeight: state.geometryHeight ?? state.height,
      themeMode: state.themeMode,
      morph: state.morph,
      hoveredId: state.hoveredId,
      selectedIdsSize: state.selectedIds?.size ?? 0,
      annotationSearchFocus: state.annotationSearchFocus
        ? { ...state.annotationSearchFocus }
        : null,
      viewportRange: state.viewportRange ?? null,
      highlightRange: state.highlightRange ?? null,
      proteinSearchHighlightRanges:
        state.proteinSearchHighlightRanges?.map(([start, end]) => [start, end] as const) ?? null,
      digestFocusRange: state.digestFocusRange ?? null,
      residueLinkRange: state.residueLinkRange ?? null,
      cursorPosition: state.cursorPosition ?? null,
      cursorBlinking: state.cursorBlinking ?? false,
      hoverPosition: state.hoverPosition ?? null,
      backboneSegmentCount: state.backboneSegments?.length ?? 0,
      hoveredCodon: state.hoveredCodon ?? null,
      selectedCodons: state.selectedCodons ?? [],
    },
    genome: genome
      ? {
          name: genome.name ?? 'unknown',
          length: genome.length,
          featureCount: genome.features?.length ?? 0,
          primerCount: genome.primers?.length ?? 0,
        }
      : null,
    renderer: {
      operationOracle,
      primerDebug,
      viewportDebug,
      rendererDebug,
    },
  };
}

export interface WebGLSnapshot {
  instanceCount: number;
  visibleCount: number;
  instances: WebGLInstanceSnapshot[];
  domCanvases: Array<{
    widthAttr: number;
    heightAttr: number;
    clientRect: { x: number; y: number; w: number; h: number };
    visible: boolean;
    parentTag: string | null;
    parentTestId: string | null;
  }>;
  approxWebGLContextCount: number;
}

export interface WebGLTraceState {
  instanceCount: number;
  visibleCount: number;
  instances: WebGLInstanceSnapshot[];
  domCanvasCount: number;
  visibleDomCanvasCount: number;
  documentVisibility: string | null;
  viewport: {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
  } | null;
}

export interface WebGLTraceEntry {
  t: number;
  elapsedMs: number;
  wallTime: string;
  event: string;
  detail?: Record<string, unknown>;
  state?: WebGLTraceState;
}

export interface WebGLTraceDump {
  active: boolean;
  startedAt: number | null;
  startedAtWallTime: string | null;
  durationMs: number;
  entries: WebGLTraceEntry[];
}

function snapshotDomCanvases(): WebGLSnapshot['domCanvases'] {
  const out: WebGLSnapshot['domCanvases'] = [];
  const all = document.querySelectorAll('canvas');
  all.forEach((c) => {
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    const visible =
      cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    const parent = c.parentElement;
    const parentTestId = parent?.getAttribute('data-testid') ?? null;
    out.push({
      widthAttr: c.width,
      heightAttr: c.height,
      clientRect: {
        x: +r.x.toFixed(1),
        y: +r.y.toFixed(1),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
      },
      visible,
      parentTag: parent?.tagName ?? null,
      parentTestId,
    });
  });
  return out;
}

const TRACE_BUFFER_SIZE = 1500;
const traceBuffer: WebGLTraceEntry[] = [];
let traceWriteIndex = 0;
let traceFilled = false;
let traceActive = false;
let traceStartedAt: number | null = null;
let traceStartedAtWallTime: string | null = null;
let removeTraceErrorListeners: (() => void) | null = null;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function pushTraceEntry(entry: WebGLTraceEntry): void {
  traceBuffer[traceWriteIndex] = entry;
  traceWriteIndex = (traceWriteIndex + 1) % TRACE_BUFFER_SIZE;
  if (traceWriteIndex === 0) traceFilled = true;
}

function getTraceEntries(): WebGLTraceEntry[] {
  if (!traceFilled) return traceBuffer.slice(0, traceWriteIndex);
  return [...traceBuffer.slice(traceWriteIndex), ...traceBuffer.slice(0, traceWriteIndex)];
}

function failedSnapshot(h: WebGLInstanceHandle, now: number): WebGLInstanceSnapshot {
  return {
    instanceId: h.instanceId,
    createdAt: h.createdAt,
    ageMs: +(now - h.createdAt).toFixed(1),
    visible: false,
    msSinceLastFrame: null,
    frameCount: 0,
    frameCircuit: null,
    container: { connected: false, clientRect: null, childCanvases: 0 },
    app: {
      alive: false,
      destroyed: null,
      tickerRunning: null,
      rendererResolution: null,
      stageChildren: null,
      canvasEl: null,
    },
    state: {
      zoom: 0,
      viewOffset: 0,
      width: 0,
      height: 0,
      geometryHeight: 0,
      themeMode: undefined,
      morph: 0,
      hoveredId: null,
      selectedIdsSize: 0,
      annotationSearchFocus: null,
      viewportRange: null,
      highlightRange: null,
      proteinSearchHighlightRanges: null,
      digestFocusRange: null,
      residueLinkRange: null,
      cursorPosition: null,
      cursorBlinking: false,
      hoverPosition: null,
      backboneSegmentCount: 0,
      hoveredCodon: null,
      selectedCodons: [],
    },
    genome: null,
    renderer: {
      operationOracle: null,
      primerDebug: null,
      viewportDebug: null,
      rendererDebug: null,
    },
  };
}

function snapshotTraceState(): WebGLTraceState | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;

  const now = nowMs();
  const list: WebGLInstanceSnapshot[] = [];
  for (const h of instances.values()) {
    try {
      list.push(snapshotOne(h, now));
    } catch (err) {
      list.push(failedSnapshot(h, now));
      console.warn('[webgl-trace] snapshot failed for', h.instanceId, err);
    }
  }

  const domCanvases = snapshotDomCanvases();
  return {
    instanceCount: list.length,
    visibleCount: list.filter((i) => i.visible).length,
    instances: list,
    domCanvasCount: domCanvases.length,
    visibleDomCanvasCount: domCanvases.filter((c) => c.visible).length,
    documentVisibility: document.visibilityState ?? null,
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
  };
}

export function isWebGLTraceActive(): boolean {
  return traceActive;
}

export function clearWebGLTrace(): void {
  traceBuffer.length = 0;
  traceWriteIndex = 0;
  traceFilled = false;
  traceStartedAt = traceActive ? nowMs() : null;
  traceStartedAtWallTime = traceActive ? new Date().toISOString() : null;
}

export function getWebGLTrace(): WebGLTraceDump {
  const now = nowMs();
  return {
    active: traceActive,
    startedAt: traceStartedAt,
    startedAtWallTime: traceStartedAtWallTime,
    durationMs: traceStartedAt === null ? 0 : +(now - traceStartedAt).toFixed(1),
    entries: getTraceEntries(),
  };
}

export function recordWebGLTrace(
  event: string,
  detail?: Record<string, unknown>,
  options: { snapshot?: boolean } = {}
): void {
  if (!traceActive) return;

  const now = nowMs();
  const startedAt = traceStartedAt ?? now;
  const entry: WebGLTraceEntry = {
    t: +now.toFixed(1),
    elapsedMs: +(now - startedAt).toFixed(1),
    wallTime: new Date().toISOString(),
    event,
  };
  if (detail) entry.detail = detail;

  if (options.snapshot !== false) {
    try {
      const state = snapshotTraceState();
      if (state) entry.state = state;
    } catch (err) {
      entry.detail = {
        ...(entry.detail ?? {}),
        snapshotError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  pushTraceEntry(entry);
}

export function startWebGLTrace(): WebGLTraceDump {
  traceBuffer.length = 0;
  traceWriteIndex = 0;
  traceFilled = false;
  traceActive = true;
  traceStartedAt = nowMs();
  traceStartedAtWallTime = new Date().toISOString();
  if (typeof window !== 'undefined' && removeTraceErrorListeners === null) {
    const onError = (event: ErrorEvent) => {
      recordWebGLTrace('window-error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error instanceof Error ? event.error.stack : null,
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      recordWebGLTrace('unhandled-rejection', {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : null,
      });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    removeTraceErrorListeners = () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }
  recordWebGLTrace('trace-start');
  return getWebGLTrace();
}

export function stopWebGLTrace(): WebGLTraceDump {
  if (traceActive) {
    recordWebGLTrace('trace-stop');
  }
  traceActive = false;
  removeTraceErrorListeners?.();
  removeTraceErrorListeners = null;
  return getWebGLTrace();
}

export function snapshotWebGLState(): WebGLSnapshot {
  const now = performance.now();
  const list: WebGLInstanceSnapshot[] = [];
  for (const h of instances.values()) {
    try {
      list.push(snapshotOne(h, now));
    } catch (err) {
      list.push(failedSnapshot(h, now));
      console.warn('[webgl-registry] snapshot failed for', h.instanceId, err);
    }
  }
  return {
    instanceCount: list.length,
    visibleCount: list.filter((i) => i.visible).length,
    instances: list,
    domCanvases: snapshotDomCanvases(),
    approxWebGLContextCount: list.filter((i) => i.app.alive && i.app.canvasEl !== null).length,
  };
}

export async function extractActiveGenomeWideTexture(): Promise<{
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  resolution: number;
  spineOffsetPx: number;
  genomeLength: number;
  maxAnnotationLane: number;
  maxCdsLane: number;
  layerTypes: string[];
} | null> {
  for (const h of instances.values()) {
    const r = h.rendererRef?.current as
      | { buildAndExtractGenomeWideTexturePng?: () => Promise<unknown> }
      | null
      | undefined;
    if (r && typeof r.buildAndExtractGenomeWideTexturePng === 'function') {
      const out = (await r.buildAndExtractGenomeWideTexturePng()) as {
        dataUrl: string;
        widthPx: number;
        heightPx: number;
        resolution: number;
        spineOffsetPx: number;
        genomeLength: number;
        maxAnnotationLane: number;
        maxCdsLane: number;
        layerTypes: string[];
      } | null;
      if (out) return out;
    }
  }
  return null;
}

export async function extractActiveGenomeWideTextureForGenome(
  genome: Genome
): Promise<GenomeWideTextureExtractResult | null> {
  for (const h of instances.values()) {
    const r = h.rendererRef?.current as
      | {
          buildAndExtractGenomeWideTextureForGenome?: (
            genome: Genome
          ) => Promise<GenomeWideTextureExtractResult | null>;
        }
      | null
      | undefined;
    if (r && typeof r.buildAndExtractGenomeWideTextureForGenome === 'function') {
      const out = await r.buildAndExtractGenomeWideTextureForGenome(genome);
      if (out) return out;
    }
  }
  return null;
}

export async function loadActivePrebuiltGenomeWideTexture(
  input: PrebuiltGenomeWideTextureMeta & { dataUrl: string }
): Promise<boolean> {
  for (const h of instances.values()) {
    const r = h.rendererRef?.current as
      | {
          loadPrebuiltGenomeWideTexture?: (
            image: ImageBitmap,
            meta: PrebuiltGenomeWideTextureMeta
          ) => void;
        }
      | null
      | undefined;
    if (r && typeof r.loadPrebuiltGenomeWideTexture === 'function') {
      const blob = await (await fetch(input.dataUrl)).blob();
      const image = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      r.loadPrebuiltGenomeWideTexture(image, {
        widthPx: input.widthPx,
        heightPx: input.heightPx,
        resolution: input.resolution,
        spineOffsetPx: input.spineOffsetPx,
        genomeLength: input.genomeLength,
      });
      return true;
    }
  }
  return false;
}

type ActiveCompiledBroadSurfaceRenderer = {
  requireCompiledBroadSurface?: (requirement: CompiledBroadSurfaceRequirementV1) => boolean;
  admitCompiledBroadSurfaceSourcePlacementAuthority?: (
    authority: CompiledBroadSurfaceSourcePlacementAuthorityV1
  ) => boolean;
  loadCompiledBroadSurfaceManifest?: (
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ) => boolean;
  admitCompiledBroadSurfaceRgbaCell?: (
    input: CompiledBroadSurfaceRgbaCellAdmissionInputV2
  ) => CompiledBroadSurfaceRgbaCellAdmissionResultV2;
  admitCompiledBroadSurfaceTransparentCell?: (
    input: CompiledBroadSurfaceTransparentCellAdmissionInputV2
  ) => CompiledBroadSurfaceRgbaCellAdmissionResultV2;
  getCompiledBroadSurfaceDemand?: (
    policy?: AnnotationPolicyGpuRuntimeV1,
    manifestFingerprint?: string
  ) => CompiledBroadSurfaceDemandV2;
  reconcileCompiledBroadSurfaceResidentLeases?: (
    demandLeaseIds: readonly string[]
  ) => CompiledBroadSurfaceResidentLeaseReconcileResultV1;
  getCompiledBroadSurfaceDiagnostics?: () => CompiledBroadSurfaceRuntimeDiagnosticsV2 | null;
  clearCompiledBroadSurfaceManifest?: (manifestFingerprint?: string) => void;
  clearCompiledBroadSurfaceRequirement?: () => void;
};

type ActivePrepackedAnnotationSceneRenderer = {
  loadPrepackedAnnotationScene?: (scene: PrepackedAnnotationSceneLoadInput) => boolean;
  preparePrepackedAnnotationScene?: (scene: PrepackedAnnotationSceneLoadInput) => boolean;
  activatePrepackedAnnotationScene?: (candidateOwnerKey: string) => boolean;
  clearPrepackedAnnotationScene?: () => void;
};

interface VisibleLiveWebGLRendererCandidate {
  readonly instanceId: string;
  readonly createdAt: number;
  readonly renderer: unknown;
}

function visibleLiveWebGLRenderers(): VisibleLiveWebGLRendererCandidate[] {
  const candidates: VisibleLiveWebGLRendererCandidate[] = [];
  for (const handle of instances.values()) {
    const container = handle.containerRef.current;
    const app = handle.appRef.current;
    const renderer = handle.rendererRef?.current;
    let appDestroyed = true;
    if (app != null) {
      try {
        appDestroyed = inspectPixiApp(app).destroyed === true;
      } catch {
        appDestroyed = true;
      }
    }
    if (
      handle.visibleRef.current &&
      container?.isConnected === true &&
      app != null &&
      !appDestroyed &&
      renderer != null
    ) {
      candidates.push({
        instanceId: handle.instanceId,
        createdAt: handle.createdAt,
        renderer,
      });
    }
  }
  return candidates;
}

function soleVisibleLiveWebGLRenderer(): unknown | null {
  const candidates = visibleLiveWebGLRenderers();
  return candidates.length === 1 ? candidates[0].renderer : null;
}

function visibleLiveCompiledBroadSurfaceRenderers(): Array<{
  readonly instanceId: string;
  readonly createdAt: number;
  readonly renderer: ActiveCompiledBroadSurfaceRenderer;
}> {
  return visibleLiveWebGLRenderers() as Array<{
    readonly instanceId: string;
    readonly createdAt: number;
    readonly renderer: ActiveCompiledBroadSurfaceRenderer;
  }>;
}

function soleActiveCompiledBroadSurfaceRenderer(): ActiveCompiledBroadSurfaceRenderer | null {
  return soleVisibleLiveWebGLRenderer() as ActiveCompiledBroadSurfaceRenderer | null;
}

export function requireActiveCompiledBroadSurface(
  requirement: CompiledBroadSurfaceRequirementV1
): boolean {
  return (
    soleActiveCompiledBroadSurfaceRenderer()?.requireCompiledBroadSurface?.(requirement) ?? false
  );
}

export function admitActiveCompiledBroadSurfaceSourcePlacementAuthority(
  authority: CompiledBroadSurfaceSourcePlacementAuthorityV1
): boolean {
  return (
    soleActiveCompiledBroadSurfaceRenderer()?.admitCompiledBroadSurfaceSourcePlacementAuthority?.(
      authority
    ) ?? false
  );
}

export function loadActiveCompiledBroadSurfaceManifest(
  manifest: CompiledBroadSurfaceManifestV2,
  provenance: CompiledBroadSurfaceAdmissionProvenanceV1
): boolean {
  return (
    soleActiveCompiledBroadSurfaceRenderer()?.loadCompiledBroadSurfaceManifest?.(
      manifest,
      provenance
    ) ?? false
  );
}

export function admitActiveCompiledBroadSurfaceRgbaCell(
  input: CompiledBroadSurfaceRgbaCellAdmissionInputV2
): CompiledBroadSurfaceRgbaCellAdmissionResultV2 | null {
  return (
    soleActiveCompiledBroadSurfaceRenderer()?.admitCompiledBroadSurfaceRgbaCell?.(input) ?? null
  );
}

export function admitActiveCompiledBroadSurfaceTransparentCell(
  input: CompiledBroadSurfaceTransparentCellAdmissionInputV2
): CompiledBroadSurfaceRgbaCellAdmissionResultV2 | null {
  return (
    soleActiveCompiledBroadSurfaceRenderer()?.admitCompiledBroadSurfaceTransparentCell?.(input) ??
    null
  );
}

export function reconcileActiveCompiledBroadSurfaceResidentLeases(
  demandLeaseIds: readonly string[]
): CompiledBroadSurfaceResidentLeaseReconcileResultV1 | null {
  return (
    soleActiveCompiledBroadSurfaceRenderer()?.reconcileCompiledBroadSurfaceResidentLeases?.(
      demandLeaseIds
    ) ?? null
  );
}

export function clearActiveCompiledBroadSurfaceManifest(): boolean {
  const renderer = soleActiveCompiledBroadSurfaceRenderer();
  if (!renderer?.clearCompiledBroadSurfaceManifest) return false;
  renderer.clearCompiledBroadSurfaceManifest();
  return true;
}

export function clearActiveCompiledBroadSurfaceRequirement(): boolean {
  const renderer = soleActiveCompiledBroadSurfaceRenderer();
  if (!renderer?.clearCompiledBroadSurfaceRequirement) return false;
  renderer.clearCompiledBroadSurfaceRequirement();
  return true;
}

export function snapshotActiveCompiledBroadSurfaceDiagnostics(): ActiveCompiledBroadSurfaceDiagnosticsSnapshotV2 {
  const candidates = visibleLiveCompiledBroadSurfaceRenderers();
  const candidateInstanceIds = Object.freeze(candidates.map(({ instanceId }) => instanceId));
  if (candidates.length !== 1) {
    return Object.freeze({
      contract: ACTIVE_COMPILED_BROAD_SURFACE_SNAPSHOT_V2,
      verdict: candidates.length === 0 ? 'none' : 'ambiguous',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount: candidates.length,
      candidateInstanceIds,
      diagnostics: null,
    });
  }
  const candidate = candidates[0];
  let diagnostics: CompiledBroadSurfaceRuntimeDiagnosticsV2 | null = null;
  try {
    diagnostics = candidate.renderer.getCompiledBroadSurfaceDiagnostics?.() ?? null;
  } catch {
    diagnostics = null;
  }
  return Object.freeze({
    contract: ACTIVE_COMPILED_BROAD_SURFACE_SNAPSHOT_V2,
    verdict: 'exactly-one',
    instanceId: candidate.instanceId,
    instanceCreatedAt: candidate.createdAt,
    visibleLiveInstanceCount: 1,
    candidateInstanceIds,
    diagnostics,
  });
}

export function snapshotActiveCompiledBroadSurfaceDemand(
  policy?: AnnotationPolicyGpuRuntimeV1
): ActiveCompiledBroadSurfaceDemandSnapshotV2 {
  const candidates = visibleLiveCompiledBroadSurfaceRenderers();
  const candidateInstanceIds = Object.freeze(candidates.map(({ instanceId }) => instanceId));
  if (candidates.length !== 1) {
    return Object.freeze({
      contract: ACTIVE_COMPILED_BROAD_SURFACE_SNAPSHOT_V2,
      verdict: candidates.length === 0 ? 'none' : 'ambiguous',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount: candidates.length,
      candidateInstanceIds,
      demand: null,
    });
  }
  const candidate = candidates[0];
  let demand: CompiledBroadSurfaceDemandV2 | null = null;
  try {
    demand = candidate.renderer.getCompiledBroadSurfaceDemand?.(policy) ?? null;
  } catch {
    demand = null;
  }
  return Object.freeze({
    contract: ACTIVE_COMPILED_BROAD_SURFACE_SNAPSHOT_V2,
    verdict: 'exactly-one',
    instanceId: candidate.instanceId,
    instanceCreatedAt: candidate.createdAt,
    visibleLiveInstanceCount: 1,
    candidateInstanceIds,
    demand,
  });
}

export function loadActivePrepackedAnnotationScene(
  input: PrepackedAnnotationSceneLoadInput
): boolean {
  const renderer = soleVisibleLiveWebGLRenderer() as ActivePrepackedAnnotationSceneRenderer | null;
  return renderer?.loadPrepackedAnnotationScene?.(input) ?? false;
}

export function prepareActivePrepackedAnnotationScene(
  input: PrepackedAnnotationSceneLoadInput
): boolean {
  const renderer = soleVisibleLiveWebGLRenderer() as ActivePrepackedAnnotationSceneRenderer | null;
  return renderer?.preparePrepackedAnnotationScene?.(input) ?? false;
}

export function activateActivePrepackedAnnotationScene(ownerKey: string): boolean {
  const renderer = soleVisibleLiveWebGLRenderer() as ActivePrepackedAnnotationSceneRenderer | null;
  return renderer?.activatePrepackedAnnotationScene?.(ownerKey) ?? false;
}

export function clearActivePrepackedAnnotationScene(): boolean {
  const renderer = soleVisibleLiveWebGLRenderer() as ActivePrepackedAnnotationSceneRenderer | null;
  if (!renderer?.clearPrepackedAnnotationScene) return false;
  renderer.clearPrepackedAnnotationScene();
  return true;
}

export interface ActivePrepackedAnnotationSceneOwnerSnapshot {
  verdict: 'exactly-one' | 'none' | 'ambiguous';
  instanceId: string | null;
  instanceCreatedAt: number | null;
  visibleLiveInstanceCount: number;
  candidateInstanceIds: string[];
  owner: PrepackedAnnotationSceneOwnerSnapshot | null;
}

export const ACTIVE_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1 =
  'active-annotation-policy-readiness-snapshot.v1' as const;

export interface ActiveAnnotationPolicyReadinessSnapshotV1 {
  readonly contract: typeof ACTIVE_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1;
  readonly verdict: 'exactly-one' | 'none' | 'ambiguous' | 'unsupported';
  readonly instanceId: string | null;
  readonly instanceCreatedAt: number | null;
  readonly visibleLiveInstanceCount: number;
  readonly renderer: PixiLinearRendererAnnotationPolicyReadinessSnapshotV1 | null;
}

export const ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1 =
  'active-pixi-linear-renderer-operation-snapshot.v1' as const;

export interface ActivePixiLinearRendererOperationSnapshot {
  readonly contract: typeof ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1;
  readonly verdict: 'exactly-one' | 'none' | 'ambiguous' | 'unsupported';
  readonly instanceId: string | null;
  readonly instanceCreatedAt: number | null;
  readonly visibleLiveInstanceCount: number;
  readonly operationOracle: PixiLinearRendererOperationSnapshot | null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

function validFiniteNumberArray(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

const RENDERER_OPERATION_ORACLE_KEYS = [
  'loadGenome',
  'annotationSnapshotAttempt',
  'annotationSnapshotApply',
  'prepackedLoad',
  'prepackedPrepare',
  'prepackedActivate',
  'prepackedPolicyUpdate',
  'prepackedRetire',
  'contentChangedFrame',
  'cameraOnlyFrame',
] as const;

function validRendererOperationSnapshot(
  value: unknown
): value is PixiLinearRendererOperationSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<PixiLinearRendererOperationSnapshot>;
  if (
    snapshot.contract !== 'pixi-linear-renderer-operation-snapshot.v1' ||
    !isNonNegativeSafeInteger(snapshot.rendererGeneration) ||
    snapshot.rendererGeneration === 0 ||
    !isNonNegativeSafeInteger(snapshot.operationEpoch) ||
    !isNonNegativeSafeInteger(snapshot.contentOperationEpoch) ||
    !isNonNegativeSafeInteger(snapshot.completedFrameEpoch) ||
    !isNonNegativeSafeInteger(snapshot.presentedFrameEpoch) ||
    !isNonNegativeSafeInteger(snapshot.presentedContentOperationEpoch) ||
    typeof snapshot.counts !== 'object' ||
    snapshot.counts === null ||
    typeof snapshot.lastEpochs !== 'object' ||
    snapshot.lastEpochs === null
  ) {
    return false;
  }
  for (const key of RENDERER_OPERATION_ORACLE_KEYS) {
    if (
      !isNonNegativeSafeInteger(snapshot.counts?.[key]) ||
      !isNonNegativeSafeInteger(snapshot.lastEpochs?.[key])
    ) {
      return false;
    }
  }
  return true;
}

export function snapshotActivePixiLinearRendererOperations(): ActivePixiLinearRendererOperationSnapshot {
  let candidate: { instanceId: string; createdAt: number; renderer: unknown } | null = null;
  let visibleLiveInstanceCount = 0;
  for (const h of instances.values()) {
    const container = h.containerRef.current;
    const app = h.appRef.current;
    const renderer = h.rendererRef?.current;
    let appDestroyed = true;
    if (app != null) {
      try {
        appDestroyed = inspectPixiApp(app).destroyed === true;
      } catch {
        appDestroyed = true;
      }
    }
    if (
      h.visibleRef.current &&
      container?.isConnected === true &&
      app != null &&
      !appDestroyed &&
      renderer != null
    ) {
      visibleLiveInstanceCount += 1;
      if (visibleLiveInstanceCount === 1) {
        candidate = { instanceId: h.instanceId, createdAt: h.createdAt, renderer };
      } else {
        candidate = null;
      }
    }
  }

  if (visibleLiveInstanceCount === 0) {
    return {
      contract: ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
      verdict: 'none',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount,
      operationOracle: null,
    };
  }
  if (visibleLiveInstanceCount !== 1 || candidate === null) {
    return {
      contract: ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
      verdict: 'ambiguous',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount,
      operationOracle: null,
    };
  }

  let operationOracle: PixiLinearRendererOperationSnapshot | null = null;
  try {
    const renderer = candidate.renderer as {
      getRendererOperationSnapshot?: () => unknown;
    };
    const possible = renderer.getRendererOperationSnapshot?.();
    if (validRendererOperationSnapshot(possible)) operationOracle = possible;
  } catch {
    operationOracle = null;
  }
  return {
    contract: ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
    verdict: operationOracle === null ? 'unsupported' : 'exactly-one',
    instanceId: candidate.instanceId,
    instanceCreatedAt: candidate.createdAt,
    visibleLiveInstanceCount,
    operationOracle,
  };
}

export const ACTIVE_WEBGL_COLD_GESTURE_SNAPSHOT_V1 =
  'active-webgl-cold-gesture-snapshot.v1' as const;

export interface ActiveWebGLColdGestureSnapshot {
  readonly contract: typeof ACTIVE_WEBGL_COLD_GESTURE_SNAPSHOT_V1;
  readonly verdict: 'exactly-one' | 'none' | 'ambiguous' | 'inactive' | 'unsupported';
  readonly requestedTrackId: string;
  readonly instanceId: string | null;
  readonly instanceCreatedAt: number | null;
  readonly registeredInstanceCount: number;
  readonly frameCount: number | null;
  readonly registryGenomeIdentity: string | null;
  readonly registryGenomeLengthBp: number | null;
  readonly renderer: PixiLinearRendererColdGestureSnapshot | null;
}

function validColdGestureViewport(
  snapshot: Partial<PixiLinearRendererColdGestureSnapshot>
): boolean {
  return (
    typeof snapshot.viewportStartBp === 'number' &&
    Number.isFinite(snapshot.viewportStartBp) &&
    typeof snapshot.viewportEndBp === 'number' &&
    Number.isFinite(snapshot.viewportEndBp) &&
    typeof snapshot.viewportWidthPx === 'number' &&
    Number.isFinite(snapshot.viewportWidthPx) &&
    typeof snapshot.viewportHeightPx === 'number' &&
    Number.isFinite(snapshot.viewportHeightPx)
  );
}

function validColdGestureTrack(
  track: PixiLinearRendererColdGestureSnapshot['track'] | undefined,
  requestedTrackId: string
): boolean {
  return Boolean(
    track &&
    track.requestedTrackId === requestedTrackId &&
    track.trackFound === true &&
    track.diagnosticsSupported === true
  );
}

function validColdGestureAnnotation(
  annotation: PixiLinearRendererColdGestureSnapshot['annotation'] | undefined,
  registryGenomeIdentity: string,
  registryGenomeLengthBp: number
): boolean {
  return Boolean(
    annotation &&
    annotation.contract === 'annotation-overlay-cold-gesture-snapshot.v1' &&
    annotation.genomeIdentity === registryGenomeIdentity &&
    annotation.genomeLengthBp === registryGenomeLengthBp &&
    isNonNegativeSafeInteger(annotation.soleOwnerCount) &&
    validStringArray(annotation.soleOwnerLayerTypes) &&
    validStringArray(annotation.soleOwnerVisualGroups) &&
    typeof annotation.soleOwnerCoverageComplete === 'boolean' &&
    typeof annotation.soleOwnerContractValid === 'boolean' &&
    validStringArray(annotation.compiledBroadRasterActiveLevelIds) &&
    validFiniteNumberArray(annotation.compiledBroadRasterActiveMipWeights) &&
    validStringArray(annotation.compiledBroadRasterActiveResidentCellIds) &&
    validStringArray(annotation.compiledBroadRasterSubmittedCellIds) &&
    isNonNegativeSafeInteger(annotation.compiledBroadRasterRuntimeCellCompileCount) &&
    isNonNegativeSafeInteger(annotation.compiledBroadRasterRuntimeDurableWriteCount)
  );
}

function validColdGestureIdentity(
  snapshot: Partial<PixiLinearRendererColdGestureSnapshot>,
  registryGenomeIdentity: string,
  registryGenomeLengthBp: number
): boolean {
  return (
    snapshot.contract === 'pixi-linear-renderer-cold-gesture-snapshot.v1' &&
    snapshot.supported === true &&
    snapshot.genomeIdentity === registryGenomeIdentity &&
    snapshot.genomeLengthBp === registryGenomeLengthBp
  );
}

function validColdGestureRendererSnapshot(
  value: unknown,
  requestedTrackId: string,
  registryGenomeIdentity: string,
  registryGenomeLengthBp: number
): value is PixiLinearRendererColdGestureSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<PixiLinearRendererColdGestureSnapshot>;
  if (!validColdGestureIdentity(snapshot, registryGenomeIdentity, registryGenomeLengthBp)) {
    return false;
  }
  if (!validColdGestureViewport(snapshot)) return false;
  if (!validRendererOperationSnapshot(snapshot.operation)) return false;
  if (!validColdGestureTrack(snapshot.track, requestedTrackId)) return false;
  if (
    !validColdGestureAnnotation(snapshot.annotation, registryGenomeIdentity, registryGenomeLengthBp)
  ) {
    return false;
  }
  return true;
}

function inactiveColdGestureSnapshot(
  verdict: ActiveWebGLColdGestureSnapshot['verdict'],
  requestedTrackId: string,
  registeredInstanceCount: number
): ActiveWebGLColdGestureSnapshot {
  return {
    contract: ACTIVE_WEBGL_COLD_GESTURE_SNAPSHOT_V1,
    verdict,
    requestedTrackId,
    instanceId: null,
    instanceCreatedAt: null,
    registeredInstanceCount,
    frameCount: null,
    registryGenomeIdentity: null,
    registryGenomeLengthBp: null,
    renderer: null,
  };
}

export function snapshotActiveWebGLColdGesture(
  requestedTrackId: string
): ActiveWebGLColdGestureSnapshot {
  const registeredInstanceCount = instances.size;
  if (registeredInstanceCount === 0) {
    return inactiveColdGestureSnapshot('none', requestedTrackId, 0);
  }
  if (registeredInstanceCount !== 1) {
    return inactiveColdGestureSnapshot('ambiguous', requestedTrackId, registeredInstanceCount);
  }
  const handle = instances.values().next().value as WebGLInstanceHandle | undefined;
  if (!handle) {
    return inactiveColdGestureSnapshot('none', requestedTrackId, registeredInstanceCount);
  }
  const app = handle.appRef.current;
  const renderer = handle.rendererRef?.current as
    | { getColdGestureSnapshot?: (trackId: string) => unknown }
    | null
    | undefined;
  let destroyed = true;
  if (app !== null) {
    try {
      destroyed = inspectPixiApp(app).destroyed === true;
    } catch {
      destroyed = true;
    }
  }
  if (!handle.visibleRef.current || app === null || destroyed || renderer == null) {
    return inactiveColdGestureSnapshot('inactive', requestedTrackId, registeredInstanceCount);
  }
  const genome = handle.genomeRef.current;
  const registryGenomeIdentity = genome?.sourceIdentity ?? genome?.name ?? '';
  const registryGenomeLengthBp = genome?.length ?? 0;
  if (!registryGenomeIdentity || !Number.isSafeInteger(registryGenomeLengthBp)) {
    return inactiveColdGestureSnapshot('unsupported', requestedTrackId, registeredInstanceCount);
  }
  let snapshot: unknown = null;
  try {
    snapshot = renderer.getColdGestureSnapshot?.(requestedTrackId) ?? null;
  } catch {
    snapshot = null;
  }
  if (
    !validColdGestureRendererSnapshot(
      snapshot,
      requestedTrackId,
      registryGenomeIdentity,
      registryGenomeLengthBp
    )
  ) {
    return {
      ...inactiveColdGestureSnapshot('unsupported', requestedTrackId, registeredInstanceCount),
      instanceId: handle.instanceId,
      instanceCreatedAt: handle.createdAt,
      frameCount: handle.frameCountRef.current,
      registryGenomeIdentity,
      registryGenomeLengthBp,
    };
  }
  return {
    contract: ACTIVE_WEBGL_COLD_GESTURE_SNAPSHOT_V1,
    verdict: 'exactly-one',
    requestedTrackId,
    instanceId: handle.instanceId,
    instanceCreatedAt: handle.createdAt,
    registeredInstanceCount,
    frameCount: handle.frameCountRef.current,
    registryGenomeIdentity,
    registryGenomeLengthBp,
    renderer: snapshot,
  };
}

export function snapshotActivePrepackedAnnotationSceneOwner(): ActivePrepackedAnnotationSceneOwnerSnapshot {
  const candidates = visibleLiveWebGLRenderers();
  const candidateInstanceIds = candidates.map(({ instanceId }) => instanceId);
  if (candidates.length === 0) {
    return {
      verdict: 'none',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount: 0,
      candidateInstanceIds,
      owner: null,
    };
  }
  if (candidates.length !== 1) {
    return {
      verdict: 'ambiguous',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount: candidates.length,
      candidateInstanceIds,
      owner: null,
    };
  }

  const [{ instanceId, createdAt, renderer }] = candidates;
  let owner: PrepackedAnnotationSceneOwnerSnapshot | null = null;
  try {
    const candidate = renderer as {
      getPrepackedAnnotationSceneOwnerSnapshot?: () => PrepackedAnnotationSceneOwnerSnapshot;
    };
    owner = candidate.getPrepackedAnnotationSceneOwnerSnapshot?.() ?? null;
  } catch {
    owner = null;
  }
  return {
    verdict: 'exactly-one',
    instanceId,
    instanceCreatedAt: createdAt,
    visibleLiveInstanceCount: 1,
    candidateInstanceIds,
    owner,
  };
}

export function snapshotActiveAnnotationPolicyReadiness(): ActiveAnnotationPolicyReadinessSnapshotV1 {
  const candidates = visibleLiveWebGLRenderers();
  if (candidates.length === 0) {
    return {
      contract: ACTIVE_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1,
      verdict: 'none',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount: 0,
      renderer: null,
    };
  }
  if (candidates.length !== 1) {
    return {
      contract: ACTIVE_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1,
      verdict: 'ambiguous',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount: candidates.length,
      renderer: null,
    };
  }
  const [{ instanceId, createdAt, renderer }] = candidates;
  let snapshot: PixiLinearRendererAnnotationPolicyReadinessSnapshotV1 | null = null;
  try {
    const candidate = renderer as {
      getAnnotationPolicyReadinessSnapshot?: () => unknown;
    };
    const value = candidate.getAnnotationPolicyReadinessSnapshot?.() ?? null;
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as { contract?: unknown }).contract ===
        'pixi-linear-renderer-annotation-policy-readiness-snapshot.v1' &&
      (value as { supported?: unknown }).supported === true &&
      Number.isFinite((value as { genomeLengthBp?: unknown }).genomeLengthBp) &&
      Number.isFinite((value as { viewportStartBp?: unknown }).viewportStartBp) &&
      Number.isFinite((value as { viewportEndBp?: unknown }).viewportEndBp) &&
      (value as { annotation?: { contract?: unknown } }).annotation?.contract ===
        'annotation-overlay-policy-readiness-snapshot.v1'
    ) {
      snapshot = value as PixiLinearRendererAnnotationPolicyReadinessSnapshotV1;
    }
  } catch {
    snapshot = null;
  }
  return {
    contract: ACTIVE_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1,
    verdict: snapshot === null ? 'unsupported' : 'exactly-one',
    instanceId,
    instanceCreatedAt: createdAt,
    visibleLiveInstanceCount: 1,
    renderer: snapshot,
  };
}

export function snapshotActiveAnnotationBodyPresentationAuthority(): {
  verdict: 'exactly-one' | 'none' | 'ambiguous';
  instanceId: string | null;
  bodyAuthority: unknown | null;
} {
  const candidates = visibleLiveWebGLRenderers();
  if (candidates.length === 0) {
    return { verdict: 'none', instanceId: null, bodyAuthority: null };
  }
  if (candidates.length !== 1) {
    return { verdict: 'ambiguous', instanceId: null, bodyAuthority: null };
  }
  const [{ instanceId, renderer }] = candidates;
  try {
    const candidate = renderer as {
      getAnnotationBodyPresentationAuthoritySnapshot?: () => unknown;
    };
    return {
      verdict: 'exactly-one',
      instanceId,
      bodyAuthority: candidate.getAnnotationBodyPresentationAuthoritySnapshot?.() ?? null,
    };
  } catch {
    return { verdict: 'exactly-one', instanceId, bodyAuthority: null };
  }
}

type WebGLRegistryWindow = Window & {
  __webglStateSnapshot?: unknown;
  __webglExtractGenomeWideTexture?: unknown;
  __webglExtractGenomeWideTextureForGenome?: unknown;
  __webglLoadPrebuiltGenomeWideTexture?: unknown;
  __webglPrepackedAnnotationSceneOwnerSnapshot?: unknown;
  __webglAnnotationPolicyReadinessSnapshot?: unknown;
  __webglAnnotationBodyPresentationAuthoritySnapshot?: unknown;
  __webglRendererOperationSnapshot?: unknown;
  __webglColdGestureSnapshot?: unknown;
  __webglTrace?: unknown;
  __webglTraceStart?: unknown;
  __webglTraceStop?: unknown;
  __webglTraceDump?: unknown;
  __webglTraceClear?: unknown;
};

if (typeof window !== 'undefined' && isWebGLDiagnosticsEnabled()) {
  const w = window as WebGLRegistryWindow;
  w.__webglStateSnapshot = snapshotWebGLState;
  w.__webglExtractGenomeWideTexture = extractActiveGenomeWideTexture;
  w.__webglExtractGenomeWideTextureForGenome = extractActiveGenomeWideTextureForGenome;
  w.__webglLoadPrebuiltGenomeWideTexture = loadActivePrebuiltGenomeWideTexture;
  w.__webglPrepackedAnnotationSceneOwnerSnapshot = snapshotActivePrepackedAnnotationSceneOwner;
  w.__webglAnnotationPolicyReadinessSnapshot = snapshotActiveAnnotationPolicyReadiness;
  w.__webglAnnotationBodyPresentationAuthoritySnapshot =
    snapshotActiveAnnotationBodyPresentationAuthority;
  w.__webglRendererOperationSnapshot = snapshotActivePixiLinearRendererOperations;
  w.__webglColdGestureSnapshot = snapshotActiveWebGLColdGesture;
  w.__webglTrace = {
    start: startWebGLTrace,
    stop: stopWebGLTrace,
    clear: clearWebGLTrace,
    dump: getWebGLTrace,
    mark: recordWebGLTrace,
    active: isWebGLTraceActive,
  };
  w.__webglTraceStart = startWebGLTrace;
  w.__webglTraceStop = stopWebGLTrace;
  w.__webglTraceDump = getWebGLTrace;
  w.__webglTraceClear = clearWebGLTrace;
}
