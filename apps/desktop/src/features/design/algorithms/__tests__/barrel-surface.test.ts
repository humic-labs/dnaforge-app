// @vitest-environment node

import { describe, it, expect } from 'vitest';
import * as barrel from '../draft-assembly';
import type { TmOptions, DraftAssemblyResult } from '../draft-assembly';

const EXPECTED_FUNCTIONS = [
  'estimateTm',
  'calculateGcContent',
  'calculateTmNN',
  'isPalindrome',
  'reverseComplement',
  'calculateHomologyLengthForTm',
  'generateId',
  'identifyJunctions',
  'getLeftPortion',
  'getRightPortion',
  'getLeftJunctionIndex',
  'getRightJunctionIndex',
  'computeHomologyRegions',
  'computePrimers',
  'recomputePrimers',
  'computeGoldenGateJunctions',
  'buildGoldenGateOverhang',
  'computeGoldenGatePrimers',
  'updatePrimerPbsLength',
  'calculateNewEncodingForOverhang',
  'recomputeHomologyMetadata',
  'updatePrimerOverhangFromHomology',
  'computeOverhangSequence',
  'computePbsSequence',
  'computePrimerDisplay',
  'computeDraftAssembly',
] as const;

const EXPECTED_CONSTANTS: Record<string, string> = {
  DEFAULT_PBS_LENGTH: 'number',
};

describe('draft-assembly barrel surface', () => {
  describe('functions', () => {
    for (const name of EXPECTED_FUNCTIONS) {
      it(`re-exports ${name} as a function`, () => {
        const value = (barrel as Record<string, unknown>)[name];
        expect(value, `barrel is missing "${name}"`).toBeDefined();
        expect(typeof value, `"${name}" should be a function`).toBe('function');
      });
    }
  });

  describe('constants', () => {
    for (const [name, expectedType] of Object.entries(EXPECTED_CONSTANTS)) {
      it(`re-exports ${name} as a ${expectedType}`, () => {
        const value = (barrel as Record<string, unknown>)[name];
        expect(value, `barrel is missing "${name}"`).toBeDefined();
        expect(typeof value).toBe(expectedType);
      });
    }
  });

  it('type-only exports compile (TmOptions, DraftAssemblyResult)', () => {
    const _probe: { opts?: TmOptions; result?: DraftAssemblyResult } = {};
    expect(_probe).toBeDefined();
  });

  it('exports have not silently disappeared from the barrel', () => {
    const keys = new Set(Object.keys(barrel));
    const missing: string[] = [];
    for (const name of EXPECTED_FUNCTIONS) {
      if (!keys.has(name)) missing.push(name);
    }
    for (const name of Object.keys(EXPECTED_CONSTANTS)) {
      if (!keys.has(name)) missing.push(name);
    }
    expect(missing, `missing from barrel: ${missing.join(', ')}`).toEqual([]);
  });
});
