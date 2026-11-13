import { describe, it, expect } from 'vitest';
import {
  parseFasta,
  parseFastaAsPlasmid,
  parseMultiFasta,
  isFastaFormat,
  countFastaSequences,
  FastaParseError,
} from './fasta';

describe('parseFasta', () => {
  it('parses a simple single-sequence FASTA', () => {
    const content = `>Seq1 A simple sequence
ATGCGATCGATCG
ATCGATCGATCGA`;

    const result = parseFasta(content);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Seq1');
    expect(result[0].description).toBe('A simple sequence');
    expect(result[0].sequence).toBe('ATGCGATCGATCGATCGATCGATCGA');
    expect(result[0].length).toBe(26);
  });

  it('parses multi-sequence FASTA', () => {
    const content = `>Seq1 First sequence
ATGC
>Seq2 Second sequence
GCTA
>Seq3
TTTT`;

    const result = parseFasta(content);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('Seq1');
    expect(result[0].description).toBe('First sequence');
    expect(result[1].name).toBe('Seq2');
    expect(result[1].description).toBe('Second sequence');
    expect(result[2].name).toBe('Seq3');
    expect(result[2].description).toBeUndefined();
  });

  it('handles sequences without description', () => {
    const content = `>MySequence
ATGCATGC`;

    const result = parseFasta(content);

    expect(result[0].name).toBe('MySequence');
    expect(result[0].description).toBeUndefined();
  });

  it('handles empty lines between sequences', () => {
    const content = `>Seq1
ATGC

>Seq2
GCTA`;

    const result = parseFasta(content);

    expect(result).toHaveLength(2);
  });

  it('skips comment lines starting with ;', () => {
    const content = `>Seq1
; This is a comment
ATGC
; Another comment
GCTA`;

    const result = parseFasta(content);

    expect(result).toHaveLength(1);
    expect(result[0].sequence).toBe('ATGCGCTA');
  });

  it('preserves original case of sequence', () => {
    const content = `>Seq1
atgc`;

    const result = parseFasta(content);

    expect(result[0].sequence).toBe('atgc');
  });

  it('preserves mixed case in multi-line sequence', () => {
    const content = `>Seq1
ATGCgatc
GATCatgc`;

    const result = parseFasta(content);

    expect(result[0].sequence).toBe('ATGCgatcGATCatgc');
  });

  it('handles IUPAC ambiguity codes', () => {
    const content = `>Seq1
ATGCRYSWKMBDHVN`;

    const result = parseFasta(content);

    expect(result[0].sequence).toBe('ATGCRYSWKMBDHVN');
  });

  it('handles protein sequences', () => {
    const content = `>Protein1
MKFLILLFNILCLFPVLAADNH`;

    const result = parseFasta(content);

    expect(result[0].sequence).toBe('MKFLILLFNILCLFPVLAADNH');
  });

  it('throws error for invalid characters', () => {
    const content = `>Seq1
ATGC123XYZ`;

    expect(() => parseFasta(content)).toThrow(FastaParseError);
  });

  it('throws error for empty file', () => {
    const content = '';

    expect(() => parseFasta(content)).toThrow('No valid FASTA sequences found');
  });

  it('throws error for file without header', () => {
    const content = 'ATGCGATCGATCG';

    expect(() => parseFasta(content)).toThrow('No valid FASTA sequences found');
  });

  it('handles Windows line endings (CRLF)', () => {
    const content = '>Seq1\r\nATGC\r\nGCTA\r\n';

    const result = parseFasta(content);

    expect(result[0].sequence).toBe('ATGCGCTA');
  });

  it('removes whitespace from sequence lines', () => {
    const content = `>Seq1
ATGC  GATC
GCTA   ATCG`;

    const result = parseFasta(content);

    expect(result[0].sequence).toBe('ATGCGATCGCTAATCG');
  });
});

describe('parseFastaAsPlasmid', () => {
  it('converts first sequence to ParsedPlasmid format', () => {
    const content = `>MyPlasmid A test plasmid
ATGCGATCGATCG`;

    const result = parseFastaAsPlasmid(content);

    expect(result.name).toBe('MyPlasmid');
    expect(result.definition).toBe('A test plasmid');
    expect(result.sequence).toBe('ATGCGATCGATCG');
    expect(result.length).toBe(13);
    expect(result.circular).toBe(false);
    expect(result.features).toEqual([]);
    expect(result.primers).toEqual([]);
  });

  it('only returns first sequence from multi-sequence FASTA', () => {
    const content = `>First
ATGC
>Second
GCTA`;

    const result = parseFastaAsPlasmid(content);

    expect(result.name).toBe('First');
    expect(result.sequence).toBe('ATGC');
  });
});

describe('parseMultiFasta', () => {
  it('converts all sequences to ParsedPlasmid format', () => {
    const content = `>Seq1 First
ATGC
>Seq2 Second
GCTA
>Seq3 Third
TTTT`;

    const result = parseMultiFasta(content);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('Seq1');
    expect(result[1].name).toBe('Seq2');
    expect(result[2].name).toBe('Seq3');
    expect(result.every((p) => p.circular === false)).toBe(true);
    expect(result.every((p) => p.features.length === 0)).toBe(true);
  });
});

describe('isFastaFormat', () => {
  it('returns true for valid FASTA content', () => {
    expect(isFastaFormat('>Seq1\nATGC')).toBe(true);
    expect(isFastaFormat('  >Seq1\nATGC')).toBe(true);
    expect(isFastaFormat('\n>Seq1\nATGC')).toBe(true);
  });

  it('returns false for non-FASTA content', () => {
    expect(isFastaFormat('ATGCGATCG')).toBe(false);
    expect(isFastaFormat('LOCUS pUC19')).toBe(false);
    expect(isFastaFormat('')).toBe(false);
  });
});

describe('countFastaSequences', () => {
  it('counts sequences without parsing', () => {
    const content = `>Seq1
ATGC
>Seq2
GCTA
>Seq3
TTTT`;

    expect(countFastaSequences(content)).toBe(3);
  });

  it('returns 0 for empty content', () => {
    expect(countFastaSequences('')).toBe(0);
  });

  it('handles malformed content gracefully', () => {
    expect(countFastaSequences('not fasta')).toBe(0);
  });
});
