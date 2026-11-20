import { viewportCanvasHeight } from './canvas-viewport-sizing';
import { setCanvasTheme } from './canvas-theme';
import { JETBRAINS_MONO_FONT_NAME, loadSequenceFonts } from '@waypoint/platform';
import { renderSequence } from './canvas-renderer';
import type { RenderSequenceParams } from './canvas-renderer';
import type { PrecomputedLinePosition } from './hooks/usePrecomputedLayout';
import {
  createViewportScopedLayout,
  cullLinesToViewport,
  decodeSequenceFromSharedBuffer,
} from './canvas-worker-protocol';
import type {
  MainToWorkerMessage,
  WorkerRenderCompleteMessage,
  WorkerToMainMessage,
} from './canvas-worker-protocol';
import { summarizeDrawnRows } from './drawn-row-diagnostics';
import { WebGLDrawingContext } from './rendering/webgl-drawing-context';

function postToMain(msg: WorkerToMainMessage): void {
  postMessage(msg);
}

let canvas: OffscreenCanvas | null = null;
let ctx: WebGLDrawingContext | null = null;
let dpr = 1;

let cachedParams: Omit<RenderSequenceParams, 'linePositions'> | null = null;
let cachedPrecomputedLines: PrecomputedLinePosition[] = [];
let cachedLinesAreViewportScoped = false;
let cachedCanvasWidth = 0;
let cachedCanvasHeight = 0;
let cachedCollectDrawnRowDiagnostics = false;
let cachedRenderVersion = 0;
let renderedVersion = -1;
let renderedOrfsDrawn = false;
let cachedPresentationVersion = 0;
let cachedPresentationBands: Array<{ top: number; bottom: number; dx: number }> = [];

let pendingViewport: {
  scrollTop: number;
  height: number;
  viewportSeq?: number;
  viewportRequestSeq?: number;
  viewportSentAt?: number;
  viewportReason?: 'scroll' | 'draw';
} | null = null;

let sharedSequence: string | null = null;

const culledLinesCache: PrecomputedLinePosition[] = [];

let drawRafHandle: number | null = null;

let lastDrawTime = 0;

function doDraw(): void {
  if (!canvas || !ctx || !cachedParams) return;

  const now = performance.now();
  const frameTime = lastDrawTime > 0 ? now - lastDrawTime : 0;
  lastDrawTime = now;
  const drawStart = now;

  const pending = pendingViewport;
  const vp = pending ?? cachedParams.viewport ?? { scrollTop: 0, height: 0 };
  pendingViewport = null;

  cachedParams.viewport = vp;

  const virtualCanvasHeight = Math.max(cachedCanvasHeight, viewportCanvasHeight(vp.height, 0));
  cachedCanvasHeight = virtualCanvasHeight;
  const targetWidth = Math.ceil(cachedCanvasWidth * dpr);
  const targetHeight = Math.ceil(virtualCanvasHeight * dpr);

  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;

  if (!ctx.beginFrame()) return;
  ctx.setPresentationShiftBounds(cachedPresentationBands, dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cullStart = performance.now();
  let linePositions: PrecomputedLinePosition[];
  if (cachedLinesAreViewportScoped) {
    linePositions = cachedPrecomputedLines;
  } else if (vp.height > 0) {
    linePositions =
      cullLinesToViewport(cachedPrecomputedLines, vp.scrollTop, vp.height, culledLinesCache) > 0
        ? culledLinesCache
        : [];
  } else {
    linePositions = cachedPrecomputedLines;
  }
  const cullMs = performance.now() - cullStart;

  const fullParams: RenderSequenceParams = {
    ...cachedParams,
    linePositions,
    fullSequence: sharedSequence ?? cachedParams.fullSequence,
    canvasWidth: cachedParams.canvasWidth,
    canvasHeight: virtualCanvasHeight,
    viewport: vp,
    capturePresentationBackground: cachedPresentationBands.length > 0,
  };

  const renderStart = performance.now();
  const result = renderSequence(ctx, fullParams);
  ctx.endFrame();

  if (cachedPresentationBands.length > 0) ctx.capturePresentationScene();
  renderedVersion = cachedRenderVersion;
  renderedOrfsDrawn = result.orfsDrawn === true;
  if (cachedPresentationBands.length > 0) ctx.presentRows(cachedPresentationBands, dpr);
  const renderMs = performance.now() - renderStart;

  const msg: WorkerRenderCompleteMessage = {
    type: 'render-complete',
    renderVersion: cachedRenderVersion,
    presentationVersion: cachedPresentationVersion,
    gpu: ctx.frameStats,
    cdsPillBounds: linePositions.map(({ line }) => ({
      lineIndex: line.lineIndex,
      startPos: line.startPos,
      endPos: line.endPos,
      cds: (line.classifiedCDSs ?? []).map(
        ({
          start,
          end,
          translationLane,
          _exonPillBounds,
          _cdsPillBounds,
          _cdsLineBounds,
          _intronPillBounds,
          _paintedPresentation,
          _interactionOutlineContours,
        }) => ({
          start,
          end,
          translationLane,
          _exonPillBounds,
          _cdsPillBounds,
          _cdsLineBounds,
          _intronPillBounds,
          _paintedPresentation,
          _interactionOutlineContours,
        })
      ),
    })),
    result,
    frameTime,
    durMs: performance.now() - drawStart,
    cullMs,
    renderMs,
    visibleLineCount: linePositions.length,
    profile: result.profile,
    drawnRows: cachedCollectDrawnRowDiagnostics
      ? summarizeDrawnRows(linePositions, {
          showAnnotations: cachedParams.config.showAnnotations,
          showReverseComplement:
            cachedParams.config.showReverseComplement &&
            !cachedParams.config.overviewLod &&
            cachedParams.config.lodLevel !== 'feature' &&
            cachedParams.config.lodLevel !== 'density',
          showTranslation: cachedParams.config.showTranslation,
        })
      : undefined,
    viewportSeq: pending?.viewportSeq,
    viewportRequestSeq: pending?.viewportRequestSeq,
    viewportSentAt: pending?.viewportSentAt,
    viewportReason: pending?.viewportReason,
    scrollTop: vp.scrollTop,
    height: vp.height,
  };
  postToMain(msg);
}

function scheduleDraw(): void {
  if (drawRafHandle !== null) return;
  drawRafHandle = requestAnimationFrame(() => {
    drawRafHandle = null;
    doDraw();
  });
}

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'ping': {
      void loadSequenceFonts(
        (self as unknown as { fonts: FontFaceSet }).fonts,
        msg.fontSources,
        (source, weight) =>
          new FontFace(JETBRAINS_MONO_FONT_NAME, source, { weight, style: 'normal' })
      )
        .then(() => {
          postToMain({ type: 'pong' });
        })
        .catch((error: unknown) => {
          postToMain({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
      break;
    }
    case 'init': {
      canvas = msg.canvas;
      ctx = new WebGLDrawingContext(canvas, { alpha: false });
      ctx.onRestore = scheduleDraw;
      ctx.onStatus = (status) => postToMain({ type: 'gpu-status', status });
      dpr = msg.dpr;
      setCanvasTheme(msg.theme);

      const readyMsg: WorkerToMainMessage = { type: 'ready' };
      postToMain(readyMsg);
      break;
    }

    case 'render': {
      dpr = msg.dpr ?? dpr;
      cachedRenderVersion = msg.renderVersion ?? cachedRenderVersion + 1;
      renderedVersion = -1;
      cachedPresentationVersion = msg.presentationVersion ?? 0;
      cachedPresentationBands = msg.presentationBands ?? [];
      cachedParams = msg.params;
      if (msg.viewportLinePositions) {
        cachedPrecomputedLines = msg.viewportLinePositions;
        cachedLinesAreViewportScoped = true;
        cachedParams.layout = createViewportScopedLayout(
          cachedParams.layout,
          cachedPrecomputedLines
        );
      } else {
        cachedPrecomputedLines = msg.precomputedLinePositions ?? [];
        cachedLinesAreViewportScoped = false;
      }
      cachedCanvasWidth = msg.canvasWidth;
      cachedCanvasHeight = msg.canvasHeight;
      cachedCollectDrawnRowDiagnostics = msg.collectDrawnRowDiagnostics === true;
      scheduleDraw();
      break;
    }

    case 'viewport': {
      if (msg.canvasHeight) cachedCanvasHeight = msg.canvasHeight;
      dpr = msg.dpr ?? dpr;
      if (msg.renderVersion === cachedRenderVersion && msg.presentationBands) {
        cachedPresentationVersion = msg.presentationVersion ?? cachedPresentationVersion;
        cachedPresentationBands = msg.presentationBands;
      }
      if (msg.viewportLinePositions) {
        cachedPrecomputedLines = msg.viewportLinePositions;
        cachedLinesAreViewportScoped = true;
        if (cachedParams) {
          cachedParams.layout = createViewportScopedLayout(
            cachedParams.layout,
            cachedPrecomputedLines
          );
        }
      }
      pendingViewport = {
        scrollTop: msg.scrollTop,
        height: msg.height,
        viewportSeq: msg.viewportSeq,
        viewportRequestSeq: msg.viewportRequestSeq,
        viewportSentAt: msg.viewportSentAt,
        viewportReason: msg.viewportReason,
      };
      cachedCollectDrawnRowDiagnostics = msg.collectDrawnRowDiagnostics === true;

      if ('highlightedRange' in msg && cachedParams) {
        cachedParams.highlightedRange = msg.highlightedRange ?? null;
      }
      if ('viewCursor' in msg && cachedParams) {
        cachedParams.viewCursor = msg.viewCursor ?? null;
      }
      if (typeof msg.collectProfile === 'boolean' && cachedParams) {
        cachedParams.collectProfile = msg.collectProfile;
      }
      scheduleDraw();
      break;
    }

    case 'present-rows': {
      if (msg.renderVersion !== cachedRenderVersion) break;
      cachedPresentationVersion = msg.presentationVersion;
      cachedPresentationBands = msg.bands;
      if (renderedVersion === cachedRenderVersion && ctx?.presentRows(msg.bands, msg.dpr)) {
        postToMain({
          type: 'present-complete',
          orfsDrawn: renderedOrfsDrawn,
          renderVersion: cachedRenderVersion,
          presentationVersion: msg.presentationVersion,
        });
      } else if (cachedParams) {
        scheduleDraw();
      }
      break;
    }

    case 'sequence-data': {
      sharedSequence = decodeSequenceFromSharedBuffer(msg.buffer, msg.length);

      if (cachedParams) scheduleDraw();
      break;
    }

    case 'theme': {
      setCanvasTheme(msg.theme);

      if (cachedParams) scheduleDraw();
      break;
    }
  }
};

self.onerror = (event) => {
  const errorMsg: WorkerToMainMessage = {
    type: 'error',
    message: typeof event === 'string' ? event : ((event as ErrorEvent).message ?? 'Unknown error'),
    stack: (event as ErrorEvent).error?.stack,
  };
  postToMain(errorMsg);
};
