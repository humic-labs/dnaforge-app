import type { TraceData } from './types';

export function rotateTrace(trace: TraceData, firstCall: number): TraceData {
  if (firstCall <= 0 || firstCall >= trace.peakPositions.length) return trace;
  const { channels, peakPositions } = trace;
  const cut = Math.ceil((peakPositions[firstCall - 1] + peakPositions[firstCall]) / 2);
  const sampleCount = Math.max(
    channels.A.length,
    channels.C.length,
    channels.G.length,
    channels.T.length
  );
  const rotate = (samples: number[]) => samples.slice(cut).concat(samples.slice(0, cut));
  return {
    ...trace,
    channels: {
      A: rotate(channels.A),
      C: rotate(channels.C),
      G: rotate(channels.G),
      T: rotate(channels.T),
    },
    peakPositions: peakPositions
      .slice(firstCall)
      .map((pos) => pos - cut)
      .concat(peakPositions.slice(0, firstCall).map((pos) => pos + sampleCount - cut)),
  };
}
