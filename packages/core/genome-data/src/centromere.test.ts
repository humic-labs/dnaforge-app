import { describe, expect, it } from 'vitest';

import { normalizeChromosomeCentromere, type CentromereAnnotationSource } from './centromere';

const ELIGIBLE = {
  chromosomeLengthBp: 1_000,
  role: 'assembled-molecule' as const,
  circular: false,
};

describe('normalizeChromosomeCentromere', () => {
  it('combines the adjoining UCSC acen rows admitted for GRCh38', () => {
    expect(
      normalizeChromosomeCentromere({
        ...ELIGIBLE,
        source: {
          kind: 'ucsc-cytobands',
          records: [
            { start: 0, end: 300, stain: 'gneg' },
            { start: 300, end: 400, stain: 'acen' },
            { start: 400, end: 475, stain: 'acen' },
            { start: 475, end: 1_000, stain: 'gpos50' },
          ],
        },
      })
    ).toEqual({ startBp: 300, endBp: 475 });
  });

  it('normalizes the admitted GFF3 centromere representation without UCSC stains', () => {
    expect(
      normalizeChromosomeCentromere({
        chromosomeLengthBp: 91_455_967,
        role: 'assembled-molecule',
        circular: false,
        source: {
          kind: 'gff3-features',
          records: [
            { type: 'region', start: 0, end: 91_455_967 },
            { type: 'centromere', start: 4_072_167, end: 4_161_965 },
          ],
        },
      })
    ).toEqual({ startBp: 4_072_166, endBp: 4_161_965 });
  });

  it('combines touching or overlapping source records that describe one centromere', () => {
    expect(
      normalizeChromosomeCentromere({
        ...ELIGIBLE,
        source: {
          kind: 'gff3-features',
          records: [
            { type: 'centromere', start: 250, end: 350 },
            { type: 'centromere', start: 350, end: 425 },
            { type: 'centromere', start: 400, end: 450 },
          ],
        },
      })
    ).toEqual({ startBp: 249, endBp: 450 });
  });

  it('keeps a one-base GFF3 centromere as a non-empty half-open interval', () => {
    expect(
      normalizeChromosomeCentromere({
        ...ELIGIBLE,
        source: {
          kind: 'gff3-features',
          records: [{ type: 'centromere', start: 300, end: 300 }],
        },
      })
    ).toEqual({ startBp: 299, endBp: 300 });
  });

  it.each([
    ['missing source', undefined],
    [
      'no admitted centromere records',
      { kind: 'gff3-features', records: [{ type: 'region', start: 0, end: 1_000 }] },
    ],
    [
      'ambiguous disjoint records',
      {
        kind: 'gff3-features',
        records: [
          { type: 'centromere', start: 100, end: 200 },
          { type: 'centromere', start: 700, end: 800 },
        ],
      },
    ],
    [
      'inverted interval',
      { kind: 'gff3-features', records: [{ type: 'centromere', start: 300, end: 200 }] },
    ],
    [
      'empty UCSC interval',
      { kind: 'ucsc-cytobands', records: [{ start: 300, end: 300, stain: 'acen' }] },
    ],
    [
      'out-of-range interval',
      { kind: 'gff3-features', records: [{ type: 'centromere', start: 900, end: 1_001 }] },
    ],
    [
      'interval without a p arm',
      { kind: 'gff3-features', records: [{ type: 'centromere', start: 0, end: 100 }] },
    ],
    [
      'interval without a q arm',
      { kind: 'gff3-features', records: [{ type: 'centromere', start: 900, end: 1_000 }] },
    ],
    [
      'non-finite interval',
      {
        kind: 'gff3-features',
        records: [{ type: 'centromere', start: Number.NaN, end: 400 }],
      },
    ],
    ['unsupported representation', { kind: 'provider-midpoint', records: [] }],
  ] as const)('fails closed for %s', (_label, source) => {
    expect(
      normalizeChromosomeCentromere({
        ...ELIGIBLE,
        source: source as CentromereAnnotationSource | undefined,
      })
    ).toBeNull();
  });

  it.each([
    ['mitochondrial members', 'mitochondrion', false],
    ['unplaced members', 'unplaced-scaffold', false],
    ['unlocalized members', 'unlocalized-scaffold', false],
    ['generic other members', 'other', false],
    ['circular members', 'assembled-molecule', true],
    ['members with no authoritative role', undefined, false],
  ] as const)('fails closed for %s even when an interval is present', (_label, role, circular) => {
    expect(
      normalizeChromosomeCentromere({
        chromosomeLengthBp: 1_000,
        role,
        circular,
        source: {
          kind: 'gff3-features',
          records: [{ type: 'centromere', start: 300, end: 400 }],
        },
      })
    ).toBeNull();
  });
});
