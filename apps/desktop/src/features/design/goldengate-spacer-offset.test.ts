// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeGoldenGatePrimers, reverseComplement } from './algorithms/draft-assembly';
import { getComposedSequence } from './types';
import type { DesignRegion, DesignSpacer, GoldenGateJunction } from './types';

function createJunction(
  junctionIndex: number,
  junctionPosition: number,
  offset: number,
  composed: string
): GoldenGateJunction {
  const overhangStart = junctionPosition - 2 + offset;
  const overhangEnd = overhangStart + 4;
  const seqLen = composed.length;
  let overhang = '';
  for (let i = 0; i < 4; i++) {
    const idx = (((overhangStart + i) % seqLen) + seqLen) % seqLen;
    overhang += composed[idx];
  }
  return {
    junctionIndex,
    junctionPosition,
    offset,
    overhangStart,
    overhangEnd,
    overhang,
    source: { type: 'pcr-designed' } as const,
    isValid: true,
  };
}

describe('GoldenGate Spacer with Positive Offset', () => {
  const regions: DesignRegion[] = [
    {
      id: 'region-0',
      sourceSequenceId: 'source-0',
      sourceSequenceName: 'Fragment 0',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'A'.repeat(100),
      annotations: [],
    },
    {
      id: 'region-1',
      sourceSequenceId: 'source-1',
      sourceSequenceName: 'Fragment 1',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'T'.repeat(100),
      annotations: [],
    },
  ];

  const spacers: DesignSpacer[] = [
    {
      id: 'spacer-0',
      junctionIndex: 0,
      sequence: 'CGATC',
    },
  ];

  const composed = getComposedSequence(regions, spacers);

  it('verifies composed sequence structure', () => {
    expect(composed.length).toBe(205);
    expect(composed.slice(0, 100)).toBe('A'.repeat(100));
    expect(composed.slice(100, 105)).toBe('CGATC');
    expect(composed.slice(105, 205)).toBe('T'.repeat(100));
  });

  it('includes spacer in reverse primer literalExtra when offset=+3', () => {
    const junctionPos = 105;

    const adjustedJunction = createJunction(0, junctionPos, 3, composed);
    const junction1 = createJunction(1, 205, 0, composed);

    console.log('Junction 0 with offset=+3:');
    console.log('  junctionPosition:', junctionPos);
    console.log('  overhangStart:', adjustedJunction.overhangStart);
    console.log('  overhang:', adjustedJunction.overhang);
    console.log('  spacer:', spacers[0].sequence, 'at [100, 105)');

    const primers = computeGoldenGatePrimers(
      regions,
      [adjustedJunction, junction1],
      'circular',
      'BsaI',
      spacers
    );

    const f0Pair = primers.find((p) => p.fragmentIndex === 0)!;
    const f1Pair = primers.find((p) => p.fragmentIndex === 1)!;

    console.log('\n--- F0 REVERSE PRIMER (right junction 0) ---');
    console.log('  Full sequence:', f0Pair.reverse.sequence);
    console.log('  GG overhang:', f0Pair.reverse.goldenGateOverhang);

    const expectedLiteralExtra = reverseComplement(composed.slice(100, 106));
    console.log('  Expected literalExtra:', expectedLiteralExtra);
    console.log('  Actual literalExtra:', f0Pair.reverse.goldenGateOverhang?.literalExtra);

    expect(f0Pair.reverse.goldenGateOverhang?.literalExtra).toBe(expectedLiteralExtra);

    const fullTail = f0Pair.reverse.goldenGateOverhang?.fullSequence;
    console.log('  Full GG tail:', fullTail);

    const spacerRC = reverseComplement('CGATC');
    expect(fullTail).toContain(spacerRC);

    console.log('\n--- F1 FORWARD PRIMER (left junction 0) ---');
    console.log('  Full sequence:', f1Pair.forward.sequence);
    console.log('  GG overhang:', f1Pair.forward.goldenGateOverhang);

    console.log('  literalExtra:', f1Pair.forward.goldenGateOverhang?.literalExtra);
  });

  it('spacer is in overhang when offset=-3', () => {
    const junctionPos = 105;
    const adjustedJunction = createJunction(0, junctionPos, -3, composed);
    const junction1 = createJunction(1, 205, 0, composed);

    console.log('\nJunction 0 with offset=-3:');
    console.log('  overhang:', adjustedJunction.overhang, 'at [100, 104)');
    console.log('  This is the first 4bp of the spacer');

    const primers = computeGoldenGatePrimers(
      regions,
      [adjustedJunction, junction1],
      'circular',
      'BsaI',
      spacers
    );

    const f0Pair = primers.find((p) => p.fragmentIndex === 0)!;
    const f1Pair = primers.find((p) => p.fragmentIndex === 1)!;

    console.log('\n--- F0 REVERSE PRIMER (right junction 0) ---');
    console.log('  Full sequence:', f0Pair.reverse.sequence);
    console.log('  literalExtra:', f0Pair.reverse.goldenGateOverhang?.literalExtra);
    expect(f0Pair.reverse.goldenGateOverhang?.literalExtra).toBe('');

    console.log('\n--- F1 FORWARD PRIMER (left junction 0) ---');
    console.log('  Full sequence:', f1Pair.forward.sequence);
    console.log('  literalExtra:', f1Pair.forward.goldenGateOverhang?.literalExtra);
    expect(f1Pair.forward.goldenGateOverhang?.literalExtra).toBe('C');

    const overhang = adjustedJunction.overhang;
    const fwdLiteral = f1Pair.forward.goldenGateOverhang?.literalExtra ?? '';
    expect(overhang + fwdLiteral).toBe('CGATC');
  });
});
