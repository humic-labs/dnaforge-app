import type { AnnotatedSequence, TraceData } from '@waypoint/sequence-utils';

export function getTraceData(sequence: Pick<AnnotatedSequence, 'metadata'>): TraceData | null {
  const trace = sequence.metadata?.trace;
  if (!trace || typeof trace !== 'object') return null;
  const t = trace as Partial<TraceData>;
  if (!t.channels || !t.peakPositions || typeof t.maxValue !== 'number') return null;
  return trace as TraceData;
}
