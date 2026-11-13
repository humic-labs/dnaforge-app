import type { MixedCallResult, TraceData } from './types';

const IUPAC_TWO: Record<string, string> = {
  AG: 'R',
  CT: 'Y',
  CG: 'S',
  AT: 'W',
  GT: 'K',
  AC: 'M',
};

const IUPAC_THREE: Record<string, string> = {
  CGT: 'B',
  AGT: 'D',
  ACT: 'H',
  ACG: 'V',
};

export function detectMixedCall(
  channels: TraceData['channels'],
  sampleIdx: number,
  threshold = 0.5
): MixedCallResult {
  if (!Number.isFinite(sampleIdx) || sampleIdx < 0) {
    throw new Error(
      `detectMixedCall: sampleIdx must be a non-negative finite number (got ${sampleIdx})`
    );
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`detectMixedCall: threshold must be in [0, 1] (got ${threshold})`);
  }

  const amps: Array<{ base: 'A' | 'C' | 'G' | 'T'; amp: number }> = [
    { base: 'A', amp: amplitudeAt(channels.A, sampleIdx) },
    { base: 'C', amp: amplitudeAt(channels.C, sampleIdx) },
    { base: 'G', amp: amplitudeAt(channels.G, sampleIdx) },
    { base: 'T', amp: amplitudeAt(channels.T, sampleIdx) },
  ];
  amps.sort((x, y) => y.amp - x.amp || x.base.localeCompare(y.base));

  const top = amps[0];
  if (top.amp <= 0) {
    return { dominant: top.base, secondary: [], iupacCode: 'N' };
  }

  const cutoff = top.amp * threshold;
  const called = amps.filter((b) => b.amp > 0 && b.amp >= cutoff);

  if (called.length === 1) {
    return { dominant: top.base, secondary: [], iupacCode: top.base };
  }
  if (called.length === 4) {
    return {
      dominant: top.base,
      secondary: called.slice(1).map((b) => b.base),
      iupacCode: 'N',
    };
  }

  const sortedKey = called
    .map((b) => b.base)
    .sort()
    .join('');
  const code = called.length === 2 ? IUPAC_TWO[sortedKey] : IUPAC_THREE[sortedKey];

  return {
    dominant: top.base,
    secondary: called.slice(1).map((b) => b.base),
    iupacCode: code ?? 'N',
  };
}

function amplitudeAt(channel: ReadonlyArray<number>, sampleIdx: number): number {
  if (channel.length === 0) return 0;
  if (sampleIdx <= 0) return Math.abs(channel[0] ?? 0);
  if (sampleIdx >= channel.length - 1) return Math.abs(channel[channel.length - 1] ?? 0);

  const i = Math.floor(sampleIdx);
  const frac = sampleIdx - i;
  const a = channel[i] ?? 0;
  const b = channel[i + 1] ?? 0;
  return Math.abs(a + (b - a) * frac);
}
