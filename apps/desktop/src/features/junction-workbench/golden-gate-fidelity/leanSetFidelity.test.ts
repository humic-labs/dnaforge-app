// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  getGoldenGateFidelityDataset,
  reverseComplementOverhang,
  scoreGoldenGateOverhangSet,
  type GoldenGateFidelityDatasetKey,
} from './GoldenGateFidelityDataset';
import {
  buildLeanFidelityIndex,
  overhangToCode,
  reverseComplementCode,
  scoreOverhangCodes,
} from './leanSetFidelity';
import * as leanSetFidelity from './leanSetFidelity';

const DATASET_KEYS: GoldenGateFidelityDatasetKey[] = ['BsaI-HFv2', 'BsmBI-v2', 'BbsI-HF'];
const ALL_4MERS = (() => {
  const bases = ['A', 'C', 'G', 'T'];
  const out: string[] = [];
  for (const a of bases)
    for (const b of bases) for (const c of bases) for (const d of bases) out.push(a + b + c + d);
  return out;
})();

function xorshift32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

describe('lean fidelity module surface', () => {
  it('does not export unused getLeanFidelityIndexForKey', () => {
    expect(leanSetFidelity).not.toHaveProperty('getLeanFidelityIndexForKey');
    expect(leanSetFidelity.buildLeanFidelityIndex).toBe(buildLeanFidelityIndex);
  });
});

describe('leanSetFidelity codec', () => {
  it('overhangToCode round-trips every 4-mer and rejects non-ACGT', () => {
    const seen = new Set<number>();
    for (const overhang of ALL_4MERS) {
      const code = overhangToCode(overhang);
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThan(256);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
    expect(seen.size).toBe(256);
    expect(overhangToCode('acgt')).toBe(overhangToCode('ACGT'));
    expect(overhangToCode('ACG')).toBe(-1);
    expect(overhangToCode('ACGN')).toBe(-1);
    expect(overhangToCode('ACGTA')).toBe(-1);
  });

  it('reverseComplementCode matches the string reverse complement for every 4-mer', () => {
    expect(overhangToCode('GGTC')).toBe(173);
    expect(reverseComplementCode(173)).toBe(overhangToCode('GACC'));
    expect(overhangToCode('GACC')).toBe(133);
    for (const overhang of ALL_4MERS) {
      const code = overhangToCode(overhang);
      const rcCode = reverseComplementCode(code);
      expect(rcCode).toBe(overhangToCode(reverseComplementOverhang(overhang)));
    }
  });
});

describe('scoreOverhangCodes ≡ scoreGoldenGateOverhangSet (the exactness contract)', () => {
  const pool = new Int32Array(64);

  function assertEquivalent(overhangs: string[], key: GoldenGateFidelityDatasetKey): void {
    const dataset = getGoldenGateFidelityDataset(key);
    const index = buildLeanFidelityIndex(dataset);
    const exact = scoreGoldenGateOverhangSet(overhangs, dataset);
    const lean = scoreOverhangCodes(overhangs.map(overhangToCode), index, pool);
    const context = `${key} [${overhangs.join(',')}]`;
    expect(lean.valid, `valid ${context}`).toBe(exact.valid);
    expect(lean.conflictCount, `conflicts ${context}`).toBe(exact.conflicts.length);
    expect(lean.onTargetCount, `onTargetCount ${context}`).toBe(exact.onTargetCount);
    if (exact.logFidelity === Number.NEGATIVE_INFINITY) {
      expect(lean.logFidelity, `logFidelity(-Inf) ${context}`).toBe(Number.NEGATIVE_INFINITY);
    } else {
      expect(lean.logFidelity, `logFidelity ${context}`).toBeCloseTo(exact.logFidelity, 9);
    }
  }

  it('matches on hand-picked structural cases (palindrome, dup, rc-dup, invalid, mixed)', () => {
    const cases: string[][] = [
      ['AATT'],
      ['ACGT'],
      ['AAAA', 'TTTT'],
      ['GGAG', 'GGAG'],
      ['AGCT', 'TCGA', 'CATG'],
      ['ACGN'],
      ['ACGN', 'ACGN'],
      ['GGAG', 'AATT', 'ACGN'],
      ['AGGA', 'TCCT', 'CTGA', 'TCAG'],
      ['acgt'],
      ['ggag', 'ctga', 'attc', 'gcaa'],
    ];
    for (const key of DATASET_KEYS) {
      for (const overhangs of cases) assertEquivalent(overhangs, key);
    }
  });

  it(
    'matches on 1200 random sets (sizes 1-6, biased toward conflict-prone draws)',
    { timeout: 30000 },
    () => {
      const next = xorshift32(0x1234abcd);
      const alphabet = 'ACGT';
      for (let trial = 0; trial < 1200; trial++) {
        const size = 1 + (next() % 6);
        const overhangs: string[] = [];
        for (let i = 0; i < size; i++) {
          if (overhangs.length > 0 && next() % 8 === 0) {
            const prior = overhangs[next() % overhangs.length];
            overhangs.push(next() % 2 === 0 ? prior : reverseComplementOverhang(prior));
            continue;
          }
          let overhang = '';
          for (let b = 0; b < 4; b++) overhang += alphabet[next() % 4];
          overhangs.push(overhang);
        }
        const key = DATASET_KEYS[trial % DATASET_KEYS.length];
        assertEquivalent(overhangs, key);
      }
    }
  );
});
