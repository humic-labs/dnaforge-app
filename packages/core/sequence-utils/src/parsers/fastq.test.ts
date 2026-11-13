import { describe, it, expect } from 'vitest';
import {
  parseFastq,
  parseFastqSingle,
  isFastqFormat,
  averageQuality,
  phredToErrorProb,
  errorProbToPhred,
} from './fastq';
import { SequenceParseError } from './types';

describe('parseFastq', () => {
  const validFastq = `@SEQ_ID_1
GATTTGGGGTTCAAAGCAGTATCGATCAAATAGTAAATCCATTTGTTCAACTCACAGTTT
+
!''*((((***+))%%%++)(%%%%).1***-+*''))**55CCF>>>>>>CCCCCCC65`;

  it('parses a single FASTQ record', () => {
    const result = parseFastq(validFastq);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('SEQ_ID_1');
    expect(result[0].sequence).toBe('GATTTGGGGTTCAAAGCAGTATCGATCAAATAGTAAATCCATTTGTTCAACTCACAGTTT');
    expect(result[0].length).toBe(60);
    expect(result[0].format).toBe('fastq');
    expect(result[0].quality).toHaveLength(60);
  });

  it('parses multiple FASTQ records', () => {
    const multiFastq = `@SEQ1
ATGC
+
IIII
@SEQ2
GCTA
+
HHHH`;

    const result = parseFastq(multiFastq);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('SEQ1');
    expect(result[1].name).toBe('SEQ2');
  });

  it('decodes Sanger/Illumina 1.8 quality scores (Phred+33)', () => {
    const fastq = `@test
ATGC
+
!5II`;

    const result = parseFastq(fastq, { qualityEncoding: 'sanger' });

    expect(result[0].quality).toEqual([0, 20, 40, 40]);
  });

  it('decodes Illumina 1.3 quality scores (Phred+64)', () => {
    const fastq = `@test
ATGC
+
@ehi`;

    const result = parseFastq(fastq, { qualityEncoding: 'illumina-1.3' });

    expect(result[0].quality).toEqual([0, 37, 40, 41]);
  });

  it('auto-detects Sanger encoding from low ASCII values', () => {
    const fastq = `@test
ATGC
+
!III`;

    const result = parseFastq(fastq);

    expect(result[0].metadata?.qualityEncoding).toBe('sanger');
  });

  it('respects limit option', () => {
    const multiFastq = `@SEQ1
ATGC
+
IIII
@SEQ2
GCTA
+
HHHH
@SEQ3
TTTT
+
JJJJ`;

    const result = parseFastq(multiFastq, { limit: 2 });

    expect(result).toHaveLength(2);
  });

  it('throws on missing header', () => {
    const badFastq = `SEQ_ID
ATGC
+
IIII`;

    expect(() => parseFastq(badFastq)).toThrow(SequenceParseError);
  });

  it('throws on missing sequence line', () => {
    const badFastq = `@SEQ_ID`;

    expect(() => parseFastq(badFastq)).toThrow(SequenceParseError);
  });

  it('throws on missing plus line', () => {
    const badFastq = `@SEQ_ID
ATGC`;

    expect(() => parseFastq(badFastq)).toThrow(SequenceParseError);
  });

  it('throws on quality/sequence length mismatch', () => {
    const badFastq = `@SEQ_ID
ATGC
+
III`;

    expect(() => parseFastq(badFastq)).toThrow(SequenceParseError);
  });

  it('throws on invalid sequence characters', () => {
    const badFastq = `@SEQ_ID
ATGC123
+
IIIIIII`;

    expect(() => parseFastq(badFastq)).toThrow(SequenceParseError);
  });

  it('preserves original case of sequence', () => {
    const fastq = `@test
atgcATGC
+
IIIIIIII`;
    const result = parseFastq(fastq);
    expect(result[0].sequence).toBe('atgcATGC');
  });

  it('handles empty lines between records', () => {
    const fastq = `@SEQ1
ATGC
+
IIII

@SEQ2
GCTA
+
HHHH`;

    const result = parseFastq(fastq);
    expect(result).toHaveLength(2);
  });

  it('parses Illumina-style headers', () => {
    const fastq = `@INSTRUMENT:RUN:FLOWCELL:LANE:TILE:X:Y 1:N:0:ATCACG
ATGC
+
IIII`;

    const result = parseFastq(fastq);

    expect(result[0].name).toBe('INSTRUMENT:RUN:FLOWCELL:LANE:TILE:X:Y');
    expect(result[0].metadata?.header).toContain('1:N:0:ATCACG');
  });
});

describe('parseFastqSingle', () => {
  it('returns first record from multi-record file', () => {
    const multiFastq = `@SEQ1
ATGC
+
IIII
@SEQ2
GCTA
+
HHHH`;

    const result = parseFastqSingle(multiFastq);

    expect(result.name).toBe('SEQ1');
  });
});

describe('isFastqFormat', () => {
  it('returns true for valid FASTQ', () => {
    const fastq = `@SEQ_ID
ATGC
+
IIII`;

    expect(isFastqFormat(fastq)).toBe(true);
  });

  it('returns false for FASTA', () => {
    expect(isFastqFormat('>header\nATGC')).toBe(false);
  });

  it('returns false for short content', () => {
    expect(isFastqFormat('@SEQ\nATGC')).toBe(false);
  });

  it('returns false for mismatched sequence/quality lengths', () => {
    const badFastq = `@SEQ_ID
ATGC
+
III`;

    expect(isFastqFormat(badFastq)).toBe(false);
  });
});

describe('quality utility functions', () => {
  it('calculates average quality', () => {
    expect(averageQuality([30, 40, 35, 35])).toBe(35);
    expect(averageQuality([])).toBe(0);
  });

  it('converts Phred to error probability', () => {
    expect(phredToErrorProb(10)).toBeCloseTo(0.1);
    expect(phredToErrorProb(20)).toBeCloseTo(0.01);
    expect(phredToErrorProb(30)).toBeCloseTo(0.001);
  });

  it('converts error probability to Phred', () => {
    expect(errorProbToPhred(0.1)).toBe(10);
    expect(errorProbToPhred(0.01)).toBe(20);
    expect(errorProbToPhred(0.001)).toBe(30);
  });

  it('handles edge cases in error probability conversion', () => {
    expect(errorProbToPhred(0)).toBe(93);
    expect(errorProbToPhred(1)).toBe(0);
  });
});
