import type { CanvasTheme } from './canvas-theme';
import type { SequenceFontSources } from '@waypoint/platform';
import type {
  RenderSequenceParams,
  RenderSequenceResult,
  RenderSequenceProfile,
} from './canvas-renderer';
import type { DrawnRowDiagnostic } from './drawn-row-diagnostics';
import type { PrecomputedLinePosition } from './hooks/usePrecomputedLayout';
import type { ClassifiedCDS, SequenceLayout } from './types';

export interface WorkerInitMessage {
  type: 'init';
  canvas: OffscreenCanvas;
  dpr: number;
  theme: CanvasTheme;
}

export interface WorkerRenderMessage {
  type: 'render';
  renderVersion?: number;
  presentationVersion?: number;
  presentationBands?: Array<{ top: number; bottom: number; dx: number }>;
  dpr?: number;

  viewportLinePositions?: PrecomputedLinePosition[];

  precomputedLinePositions?: PrecomputedLinePosition[];

  params: Omit<RenderSequenceParams, 'linePositions'>;

  canvasWidth: number;
  canvasHeight: number;

  collectDrawnRowDiagnostics?: boolean;
}

export interface WorkerViewportMessage {
  type: 'viewport';
  renderVersion?: number;
  presentationVersion?: number;
  presentationBands?: Array<{ top: number; bottom: number; dx: number }>;
  dpr?: number;
  scrollTop: number;
  height: number;

  viewportLinePositions?: PrecomputedLinePosition[];

  viewportSeq?: number;

  viewportRequestSeq?: number;

  viewportSentAt?: number;

  viewportReason?: 'scroll' | 'draw';

  collectDrawnRowDiagnostics?: boolean;

  collectProfile?: boolean;

  highlightedRange?: { start: number; end: number; wraps?: boolean } | null;

  viewCursor?: number | null;
}

export interface WorkerSequenceDataMessage {
  type: 'sequence-data';

  buffer: SharedArrayBuffer;

  length: number;
}

export interface WorkerThemeMessage {
  type: 'theme';
  theme: CanvasTheme;
}

export interface WorkerPingMessage {
  type: 'ping';
  fontSources?: SequenceFontSources;
}

export interface WorkerPresentRowsMessage {
  type: 'present-rows';
  renderVersion: number;
  presentationVersion: number;
  bands: Array<{ top: number; bottom: number; dx: number }>;
  dpr: number;
}

export type MainToWorkerMessage =
  | WorkerPingMessage
  | WorkerInitMessage
  | WorkerRenderMessage
  | WorkerViewportMessage
  | WorkerPresentRowsMessage
  | WorkerSequenceDataMessage
  | WorkerThemeMessage;

export interface WorkerReadyMessage {
  type: 'ready';
}

export interface WorkerRenderCompleteMessage {
  type: 'render-complete';
  renderVersion?: number;
  presentationVersion?: number;
  gpu?: { drawCalls: number; vertices: number };
  cdsPillBounds?: Array<{
    lineIndex: number;
    startPos: number;
    endPos: number;
    cds: Array<
      Pick<
        ClassifiedCDS,
        | 'start'
        | 'end'
        | 'translationLane'
        | '_exonPillBounds'
        | '_cdsPillBounds'
        | '_cdsLineBounds'
        | '_intronPillBounds'
        | '_paintedPresentation'
        | '_interactionOutlineContours'
      >
    >;
  }>;
  result: RenderSequenceResult;

  frameTime: number;

  durMs?: number;

  cullMs?: number;

  renderMs?: number;

  visibleLineCount?: number;

  profile?: RenderSequenceProfile;

  drawnRows?: DrawnRowDiagnostic[];

  viewportSeq?: number;
  viewportRequestSeq?: number;
  viewportSentAt?: number;
  viewportReason?: 'scroll' | 'draw';
  scrollTop?: number;
  height?: number;
}

export interface WorkerPresentCompleteMessage {
  type: 'present-complete';
  orfsDrawn?: boolean;
  renderVersion: number;
  presentationVersion: number;
}

export interface WorkerErrorMessage {
  type: 'error';
  message: string;
  stack?: string;
}

export interface WorkerPongMessage {
  type: 'pong';
}

export type WorkerToMainMessage =
  | { type: 'gpu-status'; status: string }
  | WorkerPongMessage
  | WorkerReadyMessage
  | WorkerRenderCompleteMessage
  | WorkerPresentCompleteMessage
  | WorkerErrorMessage;

export function encodeSequenceToSharedBuffer(sequence: string): {
  buffer: SharedArrayBuffer;
  length: number;
} {
  const encoded = new TextEncoder().encode(sequence);
  const sab = new SharedArrayBuffer(encoded.byteLength);
  const view = new Uint8Array(sab);
  view.set(encoded);
  return { buffer: sab, length: encoded.byteLength };
}

export function decodeSequenceFromSharedBuffer(buffer: SharedArrayBuffer, length: number): string {
  const shared = new Uint8Array(buffer, 0, length);

  const copy = new Uint8Array(length);
  copy.set(shared);
  return new TextDecoder().decode(copy);
}

export function cullLinesToViewport(
  precomputedLinePositions: PrecomputedLinePosition[],
  scrollTop: number,
  viewportHeight: number,
  cache: PrecomputedLinePosition[]
): number {
  if (viewportHeight <= 0) return 0;

  const vpTop = scrollTop - 100;
  const vpBottom = scrollTop + viewportHeight + 100;
  let count = 0;

  const firstCandidate = firstLineEndingAtOrAfter(precomputedLinePositions, vpTop);
  for (let i = firstCandidate; i < precomputedLinePositions.length; i++) {
    const lp = precomputedLinePositions[i];
    const lineStart = lp.absoluteLineY;
    if (lineStart > vpBottom) break;

    const lineEnd = absoluteLineEndY(lp);
    if (lineEnd >= vpTop && lineStart <= vpBottom) {
      copyLineToViewportCache(lp, scrollTop, cache, count);
      count++;
    }
  }

  cache.length = count;
  return count;
}

export function createViewportScopedLayout(
  layout: SequenceLayout,
  viewportLinePositions: PrecomputedLinePosition[]
): SequenceLayout {
  return {
    lines: viewportLinePositions.map(({ line }) => line),
    totalHeight: layout.totalHeight,
    totalWidth: layout.totalWidth,
    sequenceLength: layout.sequenceLength,
    isCircular: layout.isCircular,
    circularOffset: layout.circularOffset,
    bpOffset: layout.bpOffset,
    firstRealRowIndex: layout.firstRealRowIndex,
    firstBottomBufferIndex: layout.firstBottomBufferIndex,
    realRowsStartY: layout.realRowsStartY,
    bottomBufferStartY: layout.bottomBufferStartY,
  };
}

function absoluteLineEndY(lp: PrecomputedLinePosition): number {
  const end = lp.absoluteLineY + lp.lineEndY - lp.annotationY;
  return rowPaintY(
    { y: lp.absoluteLineY, heightScale: lp.line.heightScale, trackMorph: lp.line.trackMorph },
    end
  );
}

function firstLineEndingAtOrAfter(
  precomputedLinePositions: PrecomputedLinePosition[],
  y: number
): number {
  let lo = 0;
  let hi = precomputedLinePositions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (absoluteLineEndY(precomputedLinePositions[mid]) < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function copyLineToViewportCache(
  lp: PrecomputedLinePosition,
  scrollTop: number,
  cache: PrecomputedLinePosition[],
  index: number
): void {
  if (index >= cache.length) {
    cache.push({ ...lp });
  }
  const cached = cache[index];
  Object.assign(cached, lp);
  cached.annotationY = lp.annotationY - scrollTop;
  cached.translationY = lp.translationY - scrollTop;
  cached.sequenceY = lp.sequenceY - scrollTop;
  cached.complementY = lp.complementY - scrollTop;
  cached.mutationTrackY = lp.mutationTrackY - scrollTop;
  cached.rulerY = lp.rulerY - scrollTop;
  cached.forwardPrimerY = lp.forwardPrimerY - scrollTop;
  cached.reversePrimerY = lp.reversePrimerY - scrollTop;
  cached.forwardOrfY = lp.forwardOrfY - scrollTop;
  cached.reverseOrfY = lp.reverseOrfY - scrollTop;
  cached.lineEndY = lp.lineEndY - scrollTop;
}
import { rowPaintY } from './predictive-wrap-layout';
