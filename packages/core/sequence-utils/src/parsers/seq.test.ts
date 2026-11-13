import { describe, it, expect } from 'vitest';
import { parseSeq, isSeqFormat } from './seq';
import { SequenceParseError } from './types';

describe('parseSeq', () => {
  it('parses plain sequence text', () => {
    const content = 'ATGCGATCGATCG';
    const result = parseSeq(content, 'test.seq');

    expect(result.sequence).toBe('ATGCGATCGATCG');
    expect(result.length).toBe(13);
    expect(result.format).toBe('seq');
    expect(result.name).toBe('test');
  });

  it('handles multi-line sequences', () => {
    const content = `ATGC
GATC
GATCG`;
    const result = parseSeq(content);

    expect(result.sequence).toBe('ATGCGATCGATCG');
    expect(result.length).toBe(13);
  });

  it('ignores numbers and whitespace in sequence', () => {
    const content = `1 ATGC GATC
2 GATC GATC
3 AAAA`;
    const result = parseSeq(content);

    expect(result.sequence).toBe('ATGCGATCGATCGATCAAAA');
  });

  it('parses sequences with comments', () => {
    const content = `; This is a comment
; Another comment
ATGCGATCGATCG`;
    const result = parseSeq(content);

    expect(result.sequence).toBe('ATGCGATCGATCG');
    expect(result.metadata?.comments).toEqual(['This is a comment', 'Another comment']);
  });

  it('parses sequences with header line', () => {
    const content = `>MySequence
ATGCGATCGATCG`;
    const result = parseSeq(content);

    expect(result.name).toBe('MySequence');
    expect(result.sequence).toBe('ATGCGATCGATCG');
  });

  it('detects circular topology from comments', () => {
    const content = `; circular plasmid
ATGCGATCGATCG`;
    const result = parseSeq(content);

    expect(result.metadata?.circular).toBe(true);
  });

  it('handles IUPAC ambiguity codes', () => {
    const content = 'ATGCRYSWKMBDHVN';
    const result = parseSeq(content);

    expect(result.sequence).toBe('ATGCRYSWKMBDHVN');
  });

  it('preserves original case of input sequence', () => {
    const content = 'atgcgatcgatcg';
    const result = parseSeq(content);

    expect(result.sequence).toBe('atgcgatcgatcg');
  });

  it('preserves mixed case in sequence', () => {
    const content = 'ATGCgatcGATCg';
    const result = parseSeq(content);

    expect(result.sequence).toBe('ATGCgatcGATCg');
  });

  it('throws on empty content', () => {
    expect(() => parseSeq('')).toThrow(SequenceParseError);
    expect(() => parseSeq('; just a comment')).toThrow(SequenceParseError);
  });

  it('throws on invalid characters', () => {
    const content = 'ATGC123XYZ';
    expect(() => parseSeq(content)).toThrow(SequenceParseError);
  });

  it('generates stable ID from name', () => {
    const result = parseSeq('ATGC', 'My Test Sequence.seq');
    expect(result.id).toBe('my-test-sequence');
  });
});

describe('isSeqFormat', () => {
  it('returns true for plain sequence', () => {
    expect(isSeqFormat('ATGCGATCGATCG')).toBe(true);
  });

  it('returns true for sequence with comments', () => {
    expect(isSeqFormat('; comment\nATGCGATCGATCG')).toBe(true);
  });

  it('returns false for FASTA format', () => {
    expect(isSeqFormat('>header\nATGC')).toBe(false);
  });

  it('returns false for FASTQ format', () => {
    expect(isSeqFormat('@header\nATGC\n+\nIIII')).toBe(false);
  });

  it('returns false for GenBank format', () => {
    expect(isSeqFormat('LOCUS test 1000 bp')).toBe(false);
  });
});
