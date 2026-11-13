// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildColumnGridMapping, detectMixedCall, reverseComplementTrace } from '..';
import type { TraceData } from '..';

function demoTrace(): TraceData {
  const samples = 70;
  const A = new Array(samples).fill(0);
  const C = new Array(samples).fill(0);
  const G = new Array(samples).fill(0);
  const T = new Array(samples).fill(0);

  const peak = (channel: number[], at: number, height: number) => {
    for (let dx = -3; dx <= 3; dx++) {
      const i = at + dx;
      if (i < 0 || i >= channel.length) continue;
      const v = Math.round(height * (1 - Math.abs(dx) / 4));
      if (v > channel[i]) channel[i] = v;
    }
  };

  peak(A, 10, 1000);
  peak(C, 22, 950);
  peak(C, 35, 700);
  peak(T, 35, 700);
  peak(G, 50, 800);
  peak(T, 60, 850);

  return {
    channels: { A, C, G, T },
    peakPositions: [10, 22, 35, 50, 60],
    baseOrder: 'GATC',
    maxValue: 1000,
  };
}

describe('demo: trace primitives on a synthetic 5-base read', () => {
  const trace = demoTrace();
  const baseToColumn = [0, 1, 2, 4, 5];
  const totalColumns = 6;

  it('column grid mapping yields expected sample positions, with null at the gap column', () => {
    const mapping = buildColumnGridMapping(trace.peakPositions, baseToColumn, totalColumns);

    console.log('\n[demo] column → sample at frac=0.5 (centered on the called peak):');
    for (let column = 0; column < totalColumns; column++) {
      const sample = mapping.sampleAtColumnX(column, 0.5);
      const annotated = sample === null ? 'null (gap)' : String(sample);
      console.log(`  col ${column}: ${annotated}`);
    }

    console.log('\n[demo] walking the right half of column 1 (frac=0.5..1.0):');
    for (let f = 0.5; f <= 1.0 + 1e-9; f += 0.1) {
      const sample = mapping.sampleAtColumnX(1, f);
      console.log(
        `  frac=${f.toFixed(2)} → sample=${sample === null ? 'null' : Number(sample).toFixed(2)}`
      );
    }

    expect(mapping.sampleAtColumnX(0, 0.5)).toBe(10);
    expect(mapping.sampleAtColumnX(2, 0.5)).toBe(35);
    expect(mapping.sampleAtColumnX(3, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(5, 0.5)).toBe(60);
  });

  it('IUPAC detection identifies the C/T heterozygous call at sample 35 as Y', () => {
    const result = detectMixedCall(trace.channels, 35, 0.5);

    console.log('\n[demo] detectMixedCall at sample 35 (default threshold 0.5):');
    console.log(`  dominant  = ${result.dominant}`);
    console.log(`  secondary = [${result.secondary.join(', ')}]`);
    console.log(`  iupacCode = ${result.iupacCode}`);

    const cleanA = detectMixedCall(trace.channels, 10, 0.5);
    console.log(
      `\n[demo] detectMixedCall at sample 10 (clean A peak): iupacCode = ${cleanA.iupacCode}`
    );

    expect(result.iupacCode).toBe('Y');
    expect(cleanA.iupacCode).toBe('A');
  });

  it('reverse-complement is self-inverse over the full TraceData', () => {
    const rc = reverseComplementTrace(trace);
    const back = reverseComplementTrace(rc);

    console.log('\n[demo] reverse-complement transforms peak positions:');
    console.log(`  original: [${trace.peakPositions.join(', ')}]`);
    console.log(`  RC:       [${rc.peakPositions.join(', ')}]`);
    console.log(`  RC(RC):   [${back.peakPositions.join(', ')}] (round-trip)`);
    console.log(`  baseOrder: ${trace.baseOrder} → ${rc.baseOrder} → ${back.baseOrder}`);

    expect(rc.baseOrder).toBe('CTAG');
    expect(back.peakPositions).toEqual(trace.peakPositions);
    expect(back.channels.A).toEqual(trace.channels.A);
    expect(back.channels.T).toEqual(trace.channels.T);
  });
});
