import { describe, it, expect } from 'vitest';
import { decideSequenceOpenRoute } from './openSequenceFile';

const MIB = 1024 * 1024;

describe('decideSequenceOpenRoute  pre-copy gate, shared with openSequenceFile)', () => {
  it('loads a small sequence file directly', () => {
    expect(decideSequenceOpenRoute('/ws/pUC19.gb', 2_700)).toBe('load');
    expect(decideSequenceOpenRoute('/ws/seq.fasta', 5_000)).toBe('load');
  });

  it('routes a chromosome-scale GenBank/FASTA to the indexed viewer (never blocks it)', () => {
    expect(decideSequenceOpenRoute('/ws/chr.gb', 25 * MIB)).toBe('indexed');
    expect(decideSequenceOpenRoute('/ws/genome.fasta', 70 * MIB)).toBe('indexed');
    expect(decideSequenceOpenRoute('/ws/huge.gb', 300 * MIB)).toBe('indexed');
  });

  it('warns at/above the soft cap for a non-indexable format', () => {
    expect(decideSequenceOpenRoute('/ws/trace.ab1', 150 * MIB)).toBe('warn');
  });

  it('blocks above the hard cap for a non-indexable format', () => {
    expect(decideSequenceOpenRoute('/ws/trace.ab1', 300 * MIB)).toBe('block');
  });
});
