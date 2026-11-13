import { describe, expect, it, vi } from 'vitest';
import * as translation from './translation';
import type { Feature, Genome } from '../types';
import { recomputeCds } from './recomputed-cds';
import { reverseComplement } from '@waypoint/sequence-utils';

const feature: Feature = {
  id: 8,
  type: 'CDS',
  start: 0,
  end: 12,
  direction: 'forward',
  displayName: 'example',
  color: 0x33aa55,
  lane: 0,
};
const genome = (sequence: string, circular = false): Genome => ({
  name: 'example',
  sequence,
  length: sequence.length,
  circular,
  features: [feature],
});

describe('whole CDS recomputation from actual DNA', () => {
  it('does not translate unrelated downstream DNA after the anchored CDS already ends', () => {
    const spy = vi.spyOn(translation, 'translateCDS');
    try {
      expect(
        recomputeCds({ ...feature, end: 6 }, genome('ATGTAA' + 'C'.repeat(4000))).protein
      ).toBe('M*');
      const spans = spy.mock.calls.map(
        ([, start, end, , , , options]) =>
          options?.segments?.reduce((sum, part) => sum + part.end - part.start + 1, 0) ??
          end - start
      );
      expect(Math.max(...spans)).toBeLessThanOrEqual(12);
    } finally {
      spy.mockRestore();
    }
  });
  it('ends both the entire coding feature and protein at an early stop', () => {
    const source = genome('ATGTAACCCTAA');
    const before = structuredClone(source);
    const result = recomputeCds(feature, source);
    expect(result.feature).toMatchObject({ start: 0, end: 6 });
    expect(result.protein).toBe('M*');
    expect(result.codons.every((codon) => codon.endBp <= 6 && codon.residueIndex! <= 2)).toBe(true);
    expect(result.terminated).toBe(true);
    expect(source).toEqual(before);
  });
  it('extends a lost stop to the next actual in-frame stop', () => {
    const source = genome('ATGAAACAACCCTAA');
    const result = recomputeCds({ ...feature, end: 9 }, source);
    expect(result.feature.end).toBe(15);
    expect(result.protein).toBe('MKQP*');
    expect(result.terminated).toBe(true);
  });
  it('extends an imported composite CDS past its former stop and coding exon endpoint', () => {
    const result = recomputeCds(
      {
        ...feature,
        end: 9,
        exons: [{ start: 1, end: 9 }],
        cds: [{ start: 1, end: 9 }],
        segments: [{ start: 1, end: 9 }],
      },
      genome('ATGAAACAACCCTAA')
    );
    expect(result.protein).toBe('MKQP*');
    expect(result.feature).toMatchObject({
      start: 0,
      end: 15,
      exons: [{ start: 1, end: 15 }],
      cds: [{ start: 1, end: 15 }],
    });
  });
  it('recomputes a reverse-strand CDS endpoint', () => {
    const result = recomputeCds({ ...feature, direction: 'reverse' }, genome('TTAGGGTTACAT'));
    expect(result.protein).toBe('M*');
    expect(result.feature).toMatchObject({ start: 6, end: 12 });
  });
  it('trims the entire joined CDS at a stop, preserving the actual splice junction', () => {
    const result = recomputeCds(
      {
        ...feature,
        end: 15,
        segments: [
          { start: 1, end: 3 },
          { start: 7, end: 15 },
        ],
      },
      genome('ATGCCCTAACCCTAA')
    );
    expect(result.protein).toBe('M*');
    expect(result.feature).toMatchObject({
      start: 0,
      end: 9,
      segments: [
        { start: 1, end: 3 },
        { start: 7, end: 9 },
      ],
    });
  });
  it('recomputes every part of an imported composite CDS, including its exon shape and protein metadata', () => {
    const source = {
      ...feature,
      exons: [{ start: 1, end: 12 }],
      cds: [{ start: 1, end: 12 }],
      segments: [{ start: 1, end: 12 }],
      compositeKind: 'compound-cds' as const,
      qualifiers: { translation: 'MKP' },
      qualifierValues: { translation: ['MKP'] },
    };
    const result = recomputeCds(source, genome('ATGTAACCCTAA'));
    expect(result.feature.exons).toEqual([{ start: 1, end: 6 }]);
    expect(result.feature.cds).toEqual([{ start: 1, end: 6 }]);
    expect(result.feature.qualifiers?.translation).toBe('M');
    expect(result.feature.qualifierValues?.translation).toEqual(['M']);
    expect(source.exons).toEqual([{ start: 1, end: 12 }]);
  });
  it('uses the declared code and programmed translation instead of treating every TGA as a stop', () => {
    const result = recomputeCds(
      { ...feature, qualifiers: { transl_table: '4' } },
      genome('ATGTGACCCTAA')
    );
    expect(result.protein).toBe('MWP*');
    expect(result.feature.end).toBe(12);
    expect(result.terminated).toBe(true);
  });
  it('keeps a stopless linear CDS bounded by observed DNA', () => {
    const result = recomputeCds({ ...feature, end: 6 }, genome('ATGAAACCC'));
    expect(result.protein).toBe('MKP');
    expect(result.feature.end).toBe(9);
    expect(result.terminated).toBe(false);
  });
  it('extends a circular composite CDS across the origin to the next actual stop', () => {
    const source = genome('CCCTAAGGGATGAAACAA', true);
    const result = recomputeCds(
      {
        ...feature,
        start: 9,
        end: 18,
        exons: [{ start: 10, end: 18 }],
        cds: [{ start: 10, end: 18 }],
      },
      source
    );
    expect(result.protein).toBe('MKQP*');
    expect(result.feature).toMatchObject({
      start: 9,
      end: 6,
      cds: [
        { start: 10, end: 18 },
        { start: 1, end: 6 },
      ],
    });
  });
  it('extends a reverse circular composite CDS across the origin in reading order', () => {
    const result = recomputeCds(
      { ...feature, start: 0, end: 9, direction: 'reverse', cds: [{ start: 1, end: 9 }] },
      genome(reverseComplement('CCCTAAGGGATGAAACAA'), true)
    );
    expect(result.protein).toBe('MKQP*');
    expect(result.feature).toMatchObject({
      start: 12,
      end: 9,
      cds: [
        { start: 13, end: 18 },
        { start: 1, end: 9 },
      ],
    });
  });
});
