import { shouldEnableTestBridge } from '../../../lib/test-bridge-gate';

const ENABLED = shouldEnableTestBridge(import.meta.env);

export interface SequenceProbe {
  documentId: string | null;
  hasMetadata: boolean;
  hasTrace: boolean;
  peakCount: number | null;
  baseOrder: string | null;
  sequenceLength: number;
}

export interface ExtraLanesProbe {
  count: number;
  ids: string[];
  totalHeight: number;
}

export interface DrawCallProbe {
  invocation: number;
  laneY: number;
  laneHeight: number;
  pxPerBase: number;
  visibleStart: number;
  visibleEnd: number;
  columnsDrawn: number;
  channelStrokes: number;
  lineTos: number;
  iupacOverlays: number;
  letterGlyphs: number;
  phredBars: number;
  t: number;
}

interface TraceProbeState {
  enabled: boolean;
  sequence: SequenceProbe | null;
  extraLanes: ExtraLanesProbe | null;
  drawCalls: DrawCallProbe[];
  totalInvocations: number;
}

declare global {
  interface Window {
    __traceProbe?: TraceProbeState;
  }
}

const MAX_DRAW_HISTORY = 5;

function getState(): TraceProbeState | null {
  if (!ENABLED || typeof window === 'undefined') return null;
  if (!window.__traceProbe) {
    window.__traceProbe = {
      enabled: true,
      sequence: null,
      extraLanes: null,
      drawCalls: [],
      totalInvocations: 0,
    };
  }
  return window.__traceProbe;
}

export function recordSequence(seq: {
  documentId: string | null;
  metadata: Record<string, unknown> | undefined;
  sequenceLength: number;
}): void {
  const state = getState();
  if (!state) return;
  const meta = seq.metadata;
  const trace = meta && (meta as Record<string, unknown>).trace;
  const traceObj = trace && typeof trace === 'object' ? (trace as Record<string, unknown>) : null;
  state.sequence = {
    documentId: seq.documentId,
    hasMetadata: !!meta,
    hasTrace: !!traceObj,
    peakCount:
      traceObj && Array.isArray(traceObj.peakPositions) ? traceObj.peakPositions.length : null,
    baseOrder:
      traceObj && typeof traceObj.baseOrder === 'string' ? (traceObj.baseOrder as string) : null,
    sequenceLength: seq.sequenceLength,
  };
}

export function recordExtraLanes(lanes: ReadonlyArray<{ id: string; height: number }>): void {
  const state = getState();
  if (!state) return;
  state.extraLanes = {
    count: lanes.length,
    ids: lanes.map((l) => l.id),
    totalHeight: lanes.reduce((s, l) => s + Math.max(0, l.height), 0),
  };
}

export function recordDraw(call: Omit<DrawCallProbe, 'invocation' | 't'>): void {
  const state = getState();
  if (!state) return;
  state.totalInvocations += 1;
  const entry: DrawCallProbe = {
    ...call,
    invocation: state.totalInvocations,
    t: typeof performance !== 'undefined' ? Math.round(performance.now()) : 0,
  };
  state.drawCalls.unshift(entry);
  if (state.drawCalls.length > MAX_DRAW_HISTORY) {
    state.drawCalls.length = MAX_DRAW_HISTORY;
  }
}

export function getTraceProbeState(): TraceProbeState | null {
  return getState();
}
