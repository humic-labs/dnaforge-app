// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { validatePrimerSequence } from './primer-validation';

describe('validatePrimerSequence', () => {
  it('accepts valid DNA (ATCG)', () => {
    const result = validatePrimerSequence('ATCGATCGATCG');
    expect(result.valid).toBe(true);
  });

  it('accepts IUPAC ambiguity codes', () => {
    const result = validatePrimerSequence('ATCGRYSWKMBDHVN');
    expect(result.valid).toBe(true);
  });

  it('accepts lowercase', () => {
    const result = validatePrimerSequence('atcgatcgatcg');
    expect(result.valid).toBe(true);
  });

  it('rejects non-IUPAC characters', () => {
    const result = validatePrimerSequence('ATCGXQZATCG');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ position: 4, char: 'X' }),
        expect.objectContaining({ position: 5, char: 'Q' }),
        expect.objectContaining({ position: 6, char: 'Z' }),
      ])
    );
  });

  it('rejects empty string', () => {
    const result = validatePrimerSequence('');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'empty' })])
    );
  });

  it.each(['A', 'ATCGATCG', 'A'.repeat(501)])('accepts authored lengths (%s)', (sequence) => {
    const result = validatePrimerSequence(sequence);
    expect(result.valid).toBe(true);
    expect(result.trimmed).toBe(sequence);
  });

  it('trims whitespace before validation', () => {
    const result = validatePrimerSequence('  ATCGATCGATCG  ');
    expect(result.valid).toBe(true);
    expect(result.trimmed).toBe('ATCGATCGATCG');
  });

  it('rejects sequences with spaces in middle', () => {
    const result = validatePrimerSequence('ATCGA TCGATCG');
    expect(result.valid).toBe(false);
  });
});
