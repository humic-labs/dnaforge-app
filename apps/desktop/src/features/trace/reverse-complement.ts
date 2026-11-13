import { complementBase } from '@waypoint/sequence-utils';
import type { TraceData } from './types';

export function reverseComplementTrace(trace: TraceData): TraceData {
  const { channels, peakPositions, baseOrder, maxValue } = trace;

  const totalSamples = Math.max(
    channels.A.length,
    channels.C.length,
    channels.G.length,
    channels.T.length
  );

  const revA = [...channels.A].reverse();
  const revC = [...channels.C].reverse();
  const revG = [...channels.G].reverse();
  const revT = [...channels.T].reverse();

  const rcChannels: TraceData['channels'] = {
    A: revT,
    C: revG,
    G: revC,
    T: revA,
  };

  const N = peakPositions.length;
  const rcPeaks = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    rcPeaks[i] = totalSamples - 1 - peakPositions[N - 1 - i];
  }

  const rcBaseOrder = baseOrder
    .split('')
    .map((c) => complementBase(c.toUpperCase()))
    .join('');

  return {
    channels: rcChannels,
    peakPositions: rcPeaks,
    baseOrder: rcBaseOrder,
    maxValue,
  };
}
