import type { CanvasDrawnRowsSnapshot, DrawnRowDiagnostic } from './drawn-row-diagnostics';
import type { PaintedIntronConnector } from './canvas-renderer';
import type { Selection } from './types';

export type CanvasTestBridge = {
  __selectionPaintObserver?: (frame: { t: number; selection: Selection | null }) => void;
  __mainSelectionPaintObserver?: (frame: { t: number; selection: Selection | null }) => void;
  __enableDiag?: boolean;
  __canvasDrawnRowDiagnostics?: boolean;
  __forceMainThreadCanvas?: boolean;
  __canvasLastDrawnRows?: CanvasDrawnRowsSnapshot;
  __canvasLastDrawnFrame?: {
    t: number;
    charWidth: number;
    topBp: number;
    cpr: number;
    scrollTop: number;
    rowBackgroundOffset: number;
    intronConnectors?: PaintedIntronConnector[];
    rows: Array<{
      index: number;
      y: number;
      sequenceY: number;
      sequenceHeight: number;
      xOffset: number;
    }>;
  };
  __canvasWorkerDebug?: unknown;
  __canvasRenderMode?: string;
  __canvasRenderModeReason?: string;
  __lastCanvasRenderTime?: number;
  __diag?: { enabled?: boolean; enable?: () => void };
  __canvasRowOracle?: ((lineIndices: number[]) => DrawnRowDiagnostic[]) | undefined;
  __cdsExtensionActive?:
    | (() => { cdsKey: string; direction: string; pinned: boolean } | null)
    | undefined;
  __canvasTranslationCells?: () => Array<{
    lineIndex: number;
    startPos: number;
    endPos: number;
    codon: string;
    aa: string;
    visibleStart: number;
    visibleEnd: number;
  }>;
  __cdsExtensionArrows?:
    | (() => Array<{
        cdsKey: string;
        direction: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }>)
    | undefined;
  __disableSequenceWheelRaf?: boolean;
  __enableSequenceLogicalScroll?: boolean;
  __sequenceLogicalScrollTop?: number;
  __sequenceLogicalScrollEnabled?: boolean;
  __disableSequenceCanvasScrollDraw?: boolean;
  __webglExposeForTests?: boolean;
  __test?: object | null;
  __canvasContentReport?: unknown;
  __harnessAnchor?: {
    bpAt?: (clientX: number, clientY: number) => number | null;
    zoomBpAt?: (clientX: number, clientY: number) => number | null;
    rowTopForBp?: (bp: number) => number | null;
    startSampling?: (cx: number, cy: number) => void;
    stopSampling?: () => Array<{ t: number; bp: number | null }>;
  };
  __harnessSampler?: {
    samples: Array<{ t: number; bp: number | null }>;
    stopped: boolean;
    rafId: number;
  } | null;
  __sequenceViewerDiagnostics?: Record<string, unknown> | null;
  __zoomPerf?: {
    samples?: Array<{
      t: number;
      durMs: number;
      totalLineCount: number;
      seqLen: number;
      annScanMs: number;
      cdsScanMs: number;
      primerScanMs: number;
      orfScanMs: number;
      complementMs: number;
      packingMs: number;
      phases?: Record<string, number>;
    }>;
    trackMorphs?: Array<{ start: number; t: number; durMs: number }>;
    viewerRenders?: Array<{ t: number; durMs: number }>;
    logThresholdMs?: number;
    commitFlushes?: Array<Record<string, number | string>>;
    anchorSettles?: Array<Record<string, number>>;
    anchorCaptures?: Array<{
      t: number;
      bp: number;
      cursorYViewport: number;
      sequenceProgress: number | null;
      trackPoint: { band: number; progress: number } | null;
      edgePoint: { edge: 'start' | 'end'; offsetPx: number } | null;
    }>;
    anchorAbandons?: Array<Record<string, number>>;
    releasedAnchors?: Array<{
      t: number;
      phase: number | null;
      bp: number;
      y: number | null;
      scrollTop: number;
      viewportY: number;
      pending: boolean;
    }>;
    commits?: Array<Record<string, number | boolean>>;
  } | null;
  __layoutRecomputeCount?: number;
};

declare global {
  interface ImportMetaEnv {
    DEV: boolean;
    MODE: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export function shouldExposeCanvasDiagnosticsSurface(): boolean {
  if (typeof window === 'undefined') return false;
  const w = canvasTestWindow(window);
  if (w.__enableDiag === true || w.__canvasDrawnRowDiagnostics === true) return true;
  if (w.__diag?.enabled === true) return true;
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.has('harness') || searchParams.get('e2e') === 'true';
}

export function canvasTestWindow(win: Window): CanvasTestBridge {
  return win as CanvasTestBridge;
}
