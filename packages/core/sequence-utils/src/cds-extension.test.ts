import { describe, expect, it } from 'vitest';
import {
  cdsEndsInStopCodon,
  cdsStartsOnStartCodon,
  extendCdsFivePrime,
  extendCdsThreePrime,
} from './cds-extension';

const FORWARD = 'ATGAAACCCGGGTAATTT';

const REVERSE = 'TTACCCGGGTTTCAT';

describe('cdsEndsInStopCodon', () => {
  it('is false for a CDS that stops mid-protein', () => {
    expect(cdsEndsInStopCodon({ start: 0, end: 8, strand: 'forward' }, FORWARD)).toBe(false);
  });

  it('is true once the CDS covers its stop codon', () => {
    expect(cdsEndsInStopCodon({ start: 0, end: 14, strand: 'forward' }, FORWARD)).toBe(true);
  });

  it('is false when the CDS length is not a whole number of codons', () => {
    expect(cdsEndsInStopCodon({ start: 0, end: 13, strand: 'forward' }, FORWARD)).toBe(false);
  });

  it('reads the reverse strand in its own direction', () => {
    expect(cdsEndsInStopCodon({ start: 6, end: 14, strand: 'reverse' }, REVERSE)).toBe(false);
    expect(cdsEndsInStopCodon({ start: 0, end: 14, strand: 'reverse' }, REVERSE)).toBe(true);
  });
});

describe('extendCdsThreePrime', () => {
  it('reads on to the first stop codon and includes it', () => {
    const ext = extendCdsThreePrime({ start: 0, end: 8, strand: 'forward' }, FORWARD);
    expect(ext).toEqual({
      start: 9,
      end: 14,
      direction: 'three-prime',
      openEnded: false,
      addedBases: 6,
    });
  });

  it('extends a reverse-strand CDS toward LOWER coordinates', () => {
    const ext = extendCdsThreePrime({ start: 6, end: 14, strand: 'reverse' }, REVERSE);
    expect(ext).toEqual({
      start: 0,
      end: 5,
      direction: 'three-prime',
      openEnded: false,
      addedBases: 6,
    });
  });

  it('respects /codon_start when it shifts the frame', () => {
    const shifted = extendCdsThreePrime(
      { start: 0, end: 9, strand: 'forward', codonStart: 2 },
      FORWARD
    );
    expect(shifted?.start).toBe(10);
    expect(shifted?.direction).toBe('three-prime');
  });

  it('reports openEnded when a linear sequence runs out before a stop', () => {
    const ext = extendCdsThreePrime({ start: 0, end: 8, strand: 'forward' }, 'ATGAAACCCGGG');
    expect(ext).toEqual({
      start: 9,
      end: 11,
      direction: 'three-prime',
      openEnded: true,
      addedBases: 3,
    });
  });

  it('terminates on a circular sequence with no stop in frame', () => {
    const ext = extendCdsThreePrime({ start: 0, end: 5, strand: 'forward' }, 'AAAAAAAAAAAA', {
      circular: true,
    });
    expect(ext?.openEnded).toBe(true);
  });
});

describe('extendCdsFivePrime', () => {
  it('reaches back to the nearest in-frame start codon', () => {
    const seq = 'TTTATGCCCAAATAA';
    const ext = extendCdsFivePrime({ start: 6, end: 11, strand: 'forward' }, seq);
    expect(ext).toEqual({
      start: 3,
      end: 5,
      direction: 'five-prime',
      openEnded: false,
      addedBases: 3,
    });
  });

  it('refuses to read through an in-frame stop codon', () => {
    const seq = 'TTTTAACCCAAA';
    expect(extendCdsFivePrime({ start: 6, end: 11, strand: 'forward' }, seq)).toBeNull();
  });

  it('extends a reverse-strand CDS toward HIGHER coordinates', () => {
    const ext = extendCdsFivePrime({ start: 0, end: 5, strand: 'reverse' }, REVERSE);
    expect(ext).not.toBeNull();
    expect(ext!.start).toBeGreaterThan(5);
    expect(ext!.direction).toBe('five-prime');
  });
});

describe('cdsStartsOnStartCodon', () => {
  it('accepts ATG under the standard code', () => {
    expect(cdsStartsOnStartCodon({ start: 0, end: 8, strand: 'forward' }, FORWARD)).toBe(true);
  });

  it('rejects a CDS that begins mid-protein', () => {
    expect(cdsStartsOnStartCodon({ start: 3, end: 8, strand: 'forward' }, FORWARD)).toBe(false);
  });

  it('accepts GTG only under the bacterial code', () => {
    const seq = 'GTGAAACCCTAA';
    expect(cdsStartsOnStartCodon({ start: 0, end: 8, strand: 'forward' }, seq)).toBe(false);
    expect(
      cdsStartsOnStartCodon({ start: 0, end: 8, strand: 'forward', geneticCode: 11 }, seq)
    ).toBe(true);
  });

  it('reads the reverse strand from its own 5 prime end', () => {
    expect(cdsStartsOnStartCodon({ start: 6, end: 14, strand: 'reverse' }, REVERSE)).toBe(true);
    expect(cdsStartsOnStartCodon({ start: 0, end: 11, strand: 'reverse' }, REVERSE)).toBe(false);
  });
});
