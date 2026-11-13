// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type {
  AssemblyOptimizationGoldenGateJunctionInput,
  AssemblyOptimizationInput,
} from '../assembly/assembly-optimization-input';
import {
  clearGoldenGateAutoOptimizationCacheForTesting,
  planGoldenGateAutoOptimization,
} from './AssemblyWorkbenchAutoOptimizer';

const RUN = process.env.GG_OPT_BENCH === '1';

function circularSequenceSlice(sequence: string, start: number, length: number): string {
  const n = sequence.length;
  let out = '';
  for (let i = 0; i < length; i++) out += sequence[(((start + i) % n) + n) % n];
  return out;
}

function pseudoRandomDna(length: number, seed: number): string {
  const alphabet = 'ACGT';
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    out += alphabet[s & 3];
  }
  return out;
}

function deBruijnDna4(): string {
  const alphabet = ['A', 'C', 'G', 'T'];
  const subsequence: number[] = [];
  const work = new Array(alphabet.length * 4).fill(0);
  function db(t: number, p: number): void {
    if (t > 4) {
      if (4 % p === 0) for (let i = 1; i <= p; i++) subsequence.push(work[i]);
      return;
    }
    work[t] = work[t - p];
    db(t + 1, p);
    for (let j = work[t - p] + 1; j < alphabet.length; j++) {
      work[t] = j;
      db(t + 1, t);
    }
  }
  db(1, 1);
  return subsequence.map((i) => alphabet[i]).join('');
}

function junction(
  productSequence: string,
  junctionIndex: number,
  junctionPosition: number
): AssemblyOptimizationGoldenGateJunctionInput {
  const overhangStart = junctionPosition - 2;
  return {
    junctionIndex,
    junctionPosition,
    offset: 0,
    overhangStart,
    overhangEnd: overhangStart + 4,
    overhang: circularSequenceSlice(productSequence, overhangStart, 4),
    source: { type: 'pcr-designed' },
  };
}

const SPACING = 120;

function buildInput(
  productSequence: string,
  junctionCount: number,
  offsetLimit: number,
  tag: string
): AssemblyOptimizationInput {
  const junctions: AssemblyOptimizationGoldenGateJunctionInput[] = [];
  for (let j = 0; j < junctionCount; j++) {
    junctions.push(junction(productSequence, j, 80 + j * SPACING));
  }
  return {
    schemaVersion: 2,
    optimizationFingerprint: `bench:${tag}:${junctionCount}:${offsetLimit}`,
    method: 'goldengate',
    topology: 'linear',
    productSequence,
    regions: [],
    spacers: [],
    primerPbsConstraints: [],
    homologyRegions: [],
    goldenGate: { enzyme: 'BsaI', offsetLimitBp: offsetLimit, junctions },
  };
}

interface Cell {
  junctions: number;
  offsetLimit: number;
  candidatesPerJunction: number;
  rawSpace: string;
  nodes: number;
  exhaustive: boolean | 'n/a';
  ms: number;
}

function measure(
  regime: 'structured' | 'uniform',
  junctionCount: number,
  offsetLimit: number
): Cell {
  const seqLen = 80 + junctionCount * SPACING + 80;
  const productSequence =
    regime === 'uniform'
      ? deBruijnDna4().repeat(Math.ceil(seqLen / 256) + 1)
      : pseudoRandomDna(seqLen, 0x9e3779b9 ^ (junctionCount * 131 + offsetLimit));
  const input = buildInput(productSequence, junctionCount, offsetLimit, regime);
  clearGoldenGateAutoOptimizationCacheForTesting();
  const start = performance.now();
  const plan = planGoldenGateAutoOptimization(input, { topCombinationCount: 8 });
  const ms = performance.now() - start;
  const candidates = Math.min(2 * offsetLimit + 1, 256);
  return {
    junctions: junctionCount,
    offsetLimit,
    candidatesPerJunction: candidates,
    rawSpace: `${candidates}^${junctionCount}≈${Math.pow(candidates, junctionCount).toExponential(1)}`,
    nodes: plan.status === 'planned' ? plan.evaluatedNodes : (plan.evaluatedNodes ?? -1),
    exhaustive: plan.status === 'planned' ? plan.exhaustive : 'n/a',
    ms: +ms.toFixed(1),
  };
}

describe.skipIf(!RUN)('Golden Gate optimizer performance scaling sweep', () => {
  it('reports node/time dropoff as a function of junctions × overlap window', () => {
    const junctionCounts = [2, 3, 4, 5, 6, 7];
    const offsetLimits = [6, 12, 18, 24];

    for (const regime of ['structured', 'uniform'] as const) {
      const rows: Cell[] = [];
      for (const j of junctionCounts) {
        for (const l of offsetLimits) rows.push(measure(regime, j, l));
      }
      // eslint-disable-next-line no-console
      console.log(`\n=== regime: ${regime} (2,000,000-node cap) ===`);
      // eslint-disable-next-line no-console
      console.log('J  L   cand/junc  raw-space        nodes      exhaustive  ms');
      for (const r of rows) {
        // eslint-disable-next-line no-console
        console.log(
          `${String(r.junctions).padEnd(2)} ${String(r.offsetLimit).padEnd(3)} ${String(
            r.candidatesPerJunction
          ).padEnd(9)} ${r.rawSpace.padEnd(15)} ${String(r.nodes).padEnd(10)} ${String(
            r.exhaustive
          ).padEnd(10)} ${r.ms}`
        );
      }
    }
    expect(true).toBe(true);
  }, 600000);
});

describe('Golden Gate optimizer never errors or hangs on complex assemblies', () => {
  it('returns a usable plan (never an error) for up to 7 junctions at the default offset window', () => {
    for (const junctionCount of [4, 5, 6, 7]) {
      const seqLen = 80 + junctionCount * SPACING + 80;
      const input = buildInput(
        pseudoRandomDna(seqLen, 0x1234abcd ^ junctionCount),
        junctionCount,
        24,
        'guard'
      );
      clearGoldenGateAutoOptimizationCacheForTesting();
      const plan = planGoldenGateAutoOptimization(input, {
        topCombinationCount: 8,
        maxExactSearchNodes: 60_000,
      });
      expect(plan.status, `J=${junctionCount}`).toBe('planned');
      if (plan.status !== 'planned')
        throw new Error('optimizer must never error on a complex assembly');
      expect(plan.topCombinations.length, `J=${junctionCount} rows`).toBeGreaterThanOrEqual(1);
    }
  });
});
