import { describe, expect, it } from 'vitest';
import {
  REGISTERABLE_SEQUENCE_KINDS,
  coerceRegisterableSequenceKind,
} from '../lims-register-import';

describe('coerceRegisterableSequenceKind runtime membership guard', () => {
  it('has one molecule-level import kind', () => {
    expect([...REGISTERABLE_SEQUENCE_KINDS]).toEqual(['sequence']);
  });

  it('passes through sequence unchanged', () => {
    expect(coerceRegisterableSequenceKind('sequence')).toBe('sequence');
  });

  it('collapses legacy specializations to the base sequence kind', () => {
    expect(coerceRegisterableSequenceKind('plasmid')).toBe('sequence');
    expect(coerceRegisterableSequenceKind('chromosome')).toBe('sequence');
    expect(coerceRegisterableSequenceKind('genome')).toBe('sequence');
  });

  it('rejects unknown/undefined/garbage to the sequence default without throwing', () => {
    expect(coerceRegisterableSequenceKind(undefined)).toBe('sequence');
    expect(coerceRegisterableSequenceKind(null)).toBe('sequence');
    expect(coerceRegisterableSequenceKind('strain')).toBe('sequence');
    expect(coerceRegisterableSequenceKind(42)).toBe('sequence');
  });
});
