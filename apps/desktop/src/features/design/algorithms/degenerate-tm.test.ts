// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { calculateTmNN } from './tm-calculator';
import { localTmForModel, localTmRangeForModel, MIN_LOCAL_TM_LEN } from './local-tm';
import { DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS } from './tm-model';

const DEGENERATE_21 = 'ATGGCTNNKGTTCGTGCTTAA';
const STRIPPED_18 = 'ATGGCTGTTCGTGCTTAA';
const CONCRETE_21 = 'ATGGCTAAGGTTCGTGCTTAA';

describe('calculateTmNN with degenerate bases ', () => {
  it('does NOT silently equal the ACGT-stripped result', () => {
    expect(calculateTmNN(DEGENERATE_21)).not.toBeCloseTo(calculateTmNN(STRIPPED_18), 1);
  });

  it('scores a degenerate oligo as its true length, not the stripped length', () => {
    expect(calculateTmNN(DEGENERATE_21)).toBeGreaterThan(calculateTmNN(STRIPPED_18));
  });

  it('lands within the range spanned by its concrete members', () => {
    const tm = calculateTmNN(DEGENERATE_21);
    expect(tm).toBeGreaterThan(calculateTmNN(DEGENERATE_21.replace('NNK', 'AAT')) - 15);
    expect(tm).toBeLessThan(calculateTmNN(DEGENERATE_21.replace('NNK', 'GGG')) + 15);
  });

  it('is unchanged for a pure-ACGT sequence (no regression surface)', () => {
    expect(calculateTmNN('ATGCGATCGATCGATCGATC')).toBeCloseTo(54.4, 1);
  });

  it('still drops gap and pad characters (they are not bases)', () => {
    expect(calculateTmNN('ATGC-GATCGATCGATCGATC')).toBeCloseTo(
      calculateTmNN('ATGCGATCGATCGATCGATC'),
      6
    );
  });

  it('returns a real number even when far past the expansion cap', () => {
    const tm = calculateTmNN('NNNNNNNNNNNNATGCGATCG');
    expect(Number.isFinite(tm)).toBe(true);
    expect(tm).toBeGreaterThan(0);
  });
});

describe('localTmForModel with degenerate bases ', () => {
  it('measures the minimum length BEFORE expansion, not after stripping', () => {
    const seq = 'ATGCNNGT';
    expect(seq.length).toBeGreaterThanOrEqual(MIN_LOCAL_TM_LEN);
    expect(localTmForModel(seq, DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500)).not.toBeNull();
  });

  it('still returns null for a genuinely too-short sequence', () => {
    expect(localTmForModel('ATC', DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500)).toBeNull();
  });

  it('does not equal the stripped result', () => {
    const degenerate = localTmForModel(DEGENERATE_21, DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500);
    const stripped = localTmForModel(STRIPPED_18, DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500);
    expect(degenerate).not.toBeCloseTo(stripped!, 1);
  });
});

describe('localTmRangeForModel — the honest readout ', () => {
  const range = (seq: string) =>
    localTmRangeForModel(seq, DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500);

  it('returns a single value for an unambiguous oligo', () => {
    const result = range(CONCRETE_21);
    expect(result.kind).toBe('value');
    if (result.kind === 'value') {
      expect(result.tm).toBeCloseTo(calculateTmNN(CONCRETE_21, { primerConc: 500 }), 6);
    }
  });

  it('returns a real min..max range for a degenerate oligo', () => {
    const result = range(DEGENERATE_21);
    expect(result.kind).toBe('range');
    if (result.kind === 'range') {
      expect(result.minTm).toBeLessThan(result.maxTm);
      expect(result.combinations).toBe(32);
    }
  });

  it('reports indeterminate — with a reason — past the expansion cap', () => {
    const result = range('NNNNNNNNNNNNATGCGATCG');
    expect(result.kind).toBe('indeterminate');
    if (result.kind === 'indeterminate') {
      expect(result.reason).toBe('too-degenerate');
      expect(result.detail).toMatch(/degenerate/i);
    }
  });

  it('reports indeterminate — with a reason — when too short', () => {
    const result = range('ATC');
    expect(result.kind).toBe('indeterminate');
    if (result.kind === 'indeterminate') {
      expect(result.reason).toBe('too-short');
      expect(result.detail).toMatch(/\d/);
    }
  });

  it('never silently reports the ACGT-stripped Tm as a confident value', () => {
    const result = range(DEGENERATE_21);
    const strippedTm = calculateTmNN(STRIPPED_18, { primerConc: 500 });
    if (result.kind === 'value') {
      expect(result.tm).not.toBeCloseTo(strippedTm, 1);
    }
    expect(result.kind).toBe('range');
  });
});
