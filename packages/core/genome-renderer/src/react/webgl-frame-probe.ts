import type { Application } from 'pixi.js';
import { isWebGLDiagnosticsEnabled } from '@waypoint/genome-renderer/diagnostics-gate';
import type {
  PixiLinearRenderer,
  PixiStadiumRenderer,
  RenderState,
} from '@waypoint/genome-renderer';

export type WebGLFrameProbeSample = {
  t: number;
  instance: string;
  frame: number;
  sinceLast: number;
  frameDt: number;
  fps: number;
  zoom: number;
  viewOffset: number;
  width: number;
  height: number;
  geometryHeight: number;
  timings: Record<string, number>;
  renderedAnnotationCount: number | null;
  renderedPrimerCount: number | null;
  annotationGeometryRebuilds: number | null;
  annotationGeometryCacheHits: number | null;
  annotationLastRenderMode: string | null;
  annotationLastRebuildReasons: string[];
  rulerLineSegmentsDrawn: number | null;
  sequenceVisibleBasesPerStrand: number | null;
  sequenceChildrenPerStrand: number | null;
  visibleWorkBudgetViolations: string[];
  orfTrack: WebGLFrameProbeOrfTrack | null;
  retainedOverlays: WebGLFrameProbeRetainedOverlay[];
  stageChildren: number | null;
};

export type WebGLFrameProbeOrfTrack = {
  forwardOrfCount: number;
  reverseOrfCount: number;
  overviewBinDrawCount: number;
  overviewIndividualDrawCount: number;
  hitCount: number;
};

export type WebGLFrameProbeRetainedOverlay = {
  id: string;
  supported: boolean;
  enabled: boolean;
  mode: string;
  dataBuilds: number;
  cameraUpdates: number;
  interactionUpdates: number;
  fallbackRenders: number;
  lastFallbackReason: string | null;
  retainedInstanceCount: number;
  visibleInstanceCount: number;
};

export type WebGLFrameProbeWindow = Window &
  typeof globalThis & {
    __webglFrameProbeEnabled?: boolean;
    __webglFrameProbeMax?: number;
    __webglFrameProbe?: WebGLFrameProbeSample[];
    __webglFrameProbeClear?: () => void;
    __webglFrameProbeEntries?: () => WebGLFrameProbeSample[];
  };

export function ensureWebGLFrameProbeApi(): void {
  if (typeof window === 'undefined') return;
  const w = window as WebGLFrameProbeWindow;
  if (!isWebGLDiagnosticsEnabled() && w.__webglFrameProbeEnabled !== true) return;
  if (!Array.isArray(w.__webglFrameProbe)) w.__webglFrameProbe = [];
  w.__webglFrameProbeClear ??= () => {
    w.__webglFrameProbe = [];
  };
  w.__webglFrameProbeEntries ??= () => w.__webglFrameProbe ?? [];
}

export function maybeRecordWebGLFrameProbe(params: {
  instanceId: string;
  frame: number;
  sinceLast: number;
  frameDt: number;
  state: RenderState;
  renderer: PixiStadiumRenderer | PixiLinearRenderer;
  app: Application;
}): void {
  if (typeof window === 'undefined') return;
  const w = window as WebGLFrameProbeWindow;
  if (!w.__webglFrameProbeEnabled) return;
  ensureWebGLFrameProbeApi();

  const rendererDebug = params.renderer as unknown as {
    _timings?: Record<string, number>;
    getRendererDebugSnapshot?: () => {
      annotationOverlay?: {
        hitRecords?: number;
        geometryRebuilds?: number;
        geometryCacheHits?: number;
        lastRenderMode?: string;
        lastGeometryRebuildReasons?: string[];
      };
      orfTrack?: WebGLFrameProbeOrfTrack | null;
      retainedOverlays?: WebGLFrameProbeRetainedOverlay[];
      ruler?: {
        lineSegmentsDrawn?: number;
      };
      sequenceTrack?: {
        fwdVisible?: number;
        revVisible?: number;
        fwdChildren?: number;
        revChildren?: number;
      };
      visibleWorkBudget?: {
        violations?: string[];
      };
    };
    annotationOverlay?: {
      getDebugSnapshot?: () => {
        hitRecords?: number;
        geometryRebuilds?: number;
        geometryCacheHits?: number;
        lastRenderMode?: string;
        lastGeometryRebuildReasons?: string[];
      };
      hitCache?: unknown[];
    };
    primerOverlay?: { hitCache?: unknown[] };
  };
  let rendererSnapshot: {
    annotationOverlay?: {
      hitRecords?: number;
      geometryRebuilds?: number;
      geometryCacheHits?: number;
      lastRenderMode?: string;
      lastGeometryRebuildReasons?: string[];
    };
    orfTrack?: WebGLFrameProbeOrfTrack | null;
    retainedOverlays?: WebGLFrameProbeRetainedOverlay[];
    ruler?: {
      lineSegmentsDrawn?: number;
    };
    sequenceTrack?: {
      fwdVisible?: number;
      revVisible?: number;
      fwdChildren?: number;
      revChildren?: number;
    };
    visibleWorkBudget?: {
      violations?: string[];
    };
  } | null = null;
  try {
    rendererSnapshot = rendererDebug.getRendererDebugSnapshot?.() ?? null;
  } catch {
    rendererSnapshot = null;
  }
  let annotationDebug = rendererSnapshot?.annotationOverlay ?? null;
  if (!annotationDebug) {
    try {
      annotationDebug = rendererDebug.annotationOverlay?.getDebugSnapshot?.() ?? null;
    } catch {
      annotationDebug = null;
    }
  }
  const maxSamples = Math.max(1, Math.floor(w.__webglFrameProbeMax ?? 12_000));
  const samples = w.__webglFrameProbe ?? (w.__webglFrameProbe = []);
  samples.push({
    t: performance.now(),
    instance: params.instanceId,
    frame: params.frame,
    sinceLast: +params.sinceLast.toFixed(3),
    frameDt: +params.frameDt.toFixed(3),
    fps: params.sinceLast > 0 ? +(1000 / params.sinceLast).toFixed(2) : 0,
    zoom: params.state.zoom,
    viewOffset: params.state.viewOffset,
    width: params.state.width,
    height: params.state.height,
    geometryHeight: params.state.geometryHeight ?? params.state.height,
    timings: { ...(rendererDebug._timings ?? {}) },
    renderedAnnotationCount:
      typeof annotationDebug?.hitRecords === 'number'
        ? annotationDebug.hitRecords
        : Array.isArray(rendererDebug.annotationOverlay?.hitCache)
          ? rendererDebug.annotationOverlay.hitCache.length
          : null,
    renderedPrimerCount: Array.isArray(rendererDebug.primerOverlay?.hitCache)
      ? rendererDebug.primerOverlay.hitCache.length
      : null,
    annotationGeometryRebuilds:
      typeof annotationDebug?.geometryRebuilds === 'number'
        ? annotationDebug.geometryRebuilds
        : null,
    annotationGeometryCacheHits:
      typeof annotationDebug?.geometryCacheHits === 'number'
        ? annotationDebug.geometryCacheHits
        : null,
    annotationLastRenderMode: annotationDebug?.lastRenderMode ?? null,
    annotationLastRebuildReasons: annotationDebug?.lastGeometryRebuildReasons ?? [],
    rulerLineSegmentsDrawn:
      typeof rendererSnapshot?.ruler?.lineSegmentsDrawn === 'number'
        ? rendererSnapshot.ruler.lineSegmentsDrawn
        : null,
    sequenceVisibleBasesPerStrand:
      typeof rendererSnapshot?.sequenceTrack?.fwdVisible === 'number'
        ? Math.max(
            rendererSnapshot.sequenceTrack.fwdVisible,
            rendererSnapshot.sequenceTrack.revVisible ?? 0
          )
        : null,
    sequenceChildrenPerStrand:
      typeof rendererSnapshot?.sequenceTrack?.fwdChildren === 'number'
        ? Math.max(
            rendererSnapshot.sequenceTrack.fwdChildren,
            rendererSnapshot.sequenceTrack.revChildren ?? 0
          )
        : null,
    visibleWorkBudgetViolations: rendererSnapshot?.visibleWorkBudget?.violations ?? [],
    orfTrack: rendererSnapshot?.orfTrack ?? null,
    retainedOverlays: rendererSnapshot?.retainedOverlays ?? [],
    stageChildren: Array.isArray(params.app.stage?.children)
      ? params.app.stage.children.length
      : null,
  });
  if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
}
