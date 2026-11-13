import { describe, it, expect } from 'vitest';
import { parseSequenceFile } from './index';

describe('parseSequenceFile case preservation', () => {
  it('FASTA: preserves original case through unified parser', () => {
    const content = `>TestSeq
atgcATGC`;
    const result = parseSequenceFile(content, { filename: 'test.fasta' });
    expect(result[0].sequence).toBe('atgcATGC');
  });

  it('GenBank: preserves original case through unified parser', () => {
    const content = `LOCUS       test                     8 bp    DNA     linear
ORIGIN
        1 atgcATGC
//`;
    const result = parseSequenceFile(content, { filename: 'test.gb' });
    expect(result[0].sequence).toBe('atgcATGC');
  });

  it('SEQ: preserves original case through unified parser', () => {
    const content = 'atgcATGC';
    const result = parseSequenceFile(content, { filename: 'test.seq' });
    expect(result[0].sequence).toBe('atgcATGC');
  });

  it('accepts an explicit zero-base GenBank record through the unified parser', () => {
    const content = `LOCUS       Empty sequence             0 bp    DNA     linear   28-AUG-2026
ACCESSION   Empty sequence
VERSION     Empty sequence
ORIGIN
//
`;

    const [result] = parseSequenceFile(content, { filename: 'Empty sequence.gb' });
    expect(result).toMatchObject({
      name: 'Empty sequence',
      sequence: '',
      length: 0,
      format: 'genbank',
    });
  });

  it('rejects a zero-length GenBank record without an explicit ORIGIN section', () => {
    const content = `LOCUS       Truncated                   0 bp    DNA     linear   28-AUG-2026
//
`;

    expect(() => parseSequenceFile(content, { filename: 'truncated.gb' })).toThrow(
      'No sequence found in GenBank file'
    );
  });
});

describe('parseSequenceFile multi-record GenBank support', () => {
  it('returns one parsed sequence per GenBank record', () => {
    const content = `LOCUS       chromosome_one            8 bp    DNA     linear
ORIGIN
        1 atgcATGC
//
LOCUS       chromosome_two            6 bp    DNA     linear
ORIGIN
        1 ttgCaa
//`;

    const result = parseSequenceFile(content, { filename: 'assembly.gbk' });

    expect(result.map(({ name, sequence }) => ({ name, sequence }))).toEqual([
      { name: 'chromosome_one', sequence: 'atgcATGC' },
      { name: 'chromosome_two', sequence: 'ttgCaa' },
    ]);
  });
});

describe('parseSequenceFile FASTA invalid characters', () => {
  it('names the stray character and its column (real SGD download shape)', () => {
    const content = '>YPRWdelta20\nTGTTGGAATA\nATATACGGTG\nCTGAAACGCAAGGATTG`ATAATG\n';
    expect(() => parseSequenceFile(content, { filename: 'x.dnas' })).toThrow(
      'Line 4: Invalid sequence character "`" at column 18'
    );
  });
});
