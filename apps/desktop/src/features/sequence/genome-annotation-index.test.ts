// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { buildAnnotationIndex, type IndexableFeature } from './genome-annotation-index';

function feat(
  overrides: Partial<IndexableFeature> &
    Pick<IndexableFeature, 'type' | 'start' | 'end'> & { id?: number | string }
): IndexableFeature {
  const { id: _id, ...rest } = overrides;
  return {
    direction: 'forward',
    displayName: '',
    qualifiers: {},
    ...rest,
  } as IndexableFeature;
}

describe('genome-annotation-index', () => {
  it('returns no matches for empty or whitespace queries', () => {
    const index = buildAnnotationIndex([
      feat({ id: 1, type: 'mRNA', start: 100, end: 200, displayName: 'LGALS12' }),
    ]);
    expect(index.query('')).toHaveLength(0);
    expect(index.query('   ')).toHaveLength(0);
  });

  it('finds a feature by displayName (case-insensitive substring)', () => {
    const index = buildAnnotationIndex([
      feat({ id: 1, type: 'mRNA', start: 100, end: 200, displayName: 'LGALS12' }),
      feat({ id: 2, type: 'mRNA', start: 300, end: 400, displayName: 'DLG2' }),
    ]);
    const hits = index.query('lgals');
    expect(hits).toHaveLength(1);
    expect(hits[0].featureIndex).toBe(0);
    expect(hits[0].label).toBe('LGALS12');
    expect(hits[0].featureType).toBe('mRNA');
  });

  it('preserves logical track and canonical renderer identity on in-memory hits', () => {
    const index = buildAnnotationIndex([
      {
        ...feat({
          type: 'ncRNA',
          annotationTrackId: 'lncRNA',
          canonicalIdentity: 'annotation.v2:test-nr-131224',
          start: 100,
          end: 200,
          displayName: 'NR_131224.2',
        }),
        direction: 'reverse',
      },
    ]);

    expect(index.query('NR_131224.2')).toEqual([
      expect.objectContaining({
        featureType: 'ncRNA',
        annotationTrackId: 'lncRNA',
        canonicalIdentity: 'annotation.v2:test-nr-131224',
        direction: 'reverse',
      }),
    ]);
  });

  it('finds a feature by qualifier value', () => {
    const index = buildAnnotationIndex([
      feat({
        id: 1,
        type: 'mRNA',
        start: 100,
        end: 200,
        displayName: 'mrna.5',
        qualifiers: { gene: ['LGALS12'], product: ['galectin 12'] },
      }),
    ]);
    expect(index.query('galectin')).toHaveLength(1);
    expect(index.query('lgals12')).toHaveLength(1);
  });

  it('handles 1-2 char queries via linear scan', () => {
    const index = buildAnnotationIndex([
      feat({ id: 1, type: 'mRNA', start: 100, end: 200, displayName: 'TP53' }),
      feat({ id: 2, type: 'mRNA', start: 300, end: 400, displayName: 'P53' }),
    ]);
    const hits = index.query('p5');
    expect(hits.length).toBe(2);
  });

  it('sorts matches by genomic start, then end, then index', () => {
    const index = buildAnnotationIndex([
      feat({ id: 1, type: 'mRNA', start: 5000, end: 6000, displayName: 'LGALS12.mrna.2' }),
      feat({ id: 2, type: 'mRNA', start: 1000, end: 2000, displayName: 'LGALS12.mrna.1' }),
      feat({ id: 3, type: 'mRNA', start: 3000, end: 4000, displayName: 'LGALS12.mrna.3' }),
    ]);
    const hits = index.query('LGALS12');
    expect(hits.map((h) => h.start)).toEqual([1000, 3000, 5000]);
  });

  it('respects the limit parameter', () => {
    const features: Feature[] = [];
    for (let i = 0; i < 50; i++) {
      features.push(
        feat({
          id: i + 1,
          type: 'mRNA',
          start: i * 100,
          end: i * 100 + 50,
          displayName: `GENE${i}`,
        })
      );
    }
    const index = buildAnnotationIndex(features);
    expect(index.query('gene', 10)).toHaveLength(10);
    expect(index.query('gene', 200)).toHaveLength(50);
  });

  it('returns no matches when query contains an n-gram never seen', () => {
    const index = buildAnnotationIndex([
      feat({ id: 1, type: 'mRNA', start: 100, end: 200, displayName: 'LGALS12' }),
    ]);
    expect(index.query('zzz')).toHaveLength(0);
  });

  it('returns no matches when a 3-gram is partially-matched but full query is not a substring (false positive eliminated)', () => {
    const index = buildAnnotationIndex([
      feat({ id: 1, type: 'mRNA', start: 100, end: 200, displayName: 'LGALS12' }),
    ]);
    expect(index.query('lalsz')).toHaveLength(0);
  });

  it('does not include features whose qualifiers happen to share an n-gram with the query but the full query is not present', () => {
    const index = buildAnnotationIndex([
      feat({
        id: 1,
        type: 'mRNA',
        start: 100,
        end: 200,
        displayName: 'foo',
        qualifiers: { product: ['contains the substring abc'] },
      }),
    ]);
    expect(index.query('abc')).toHaveLength(1);
    expect(index.query('abz')).toHaveLength(0);
  });

  it('treats different qualifier values as separated (no cross-field n-gram matches)', () => {
    const index = buildAnnotationIndex([
      feat({
        id: 1,
        type: 'mRNA',
        start: 100,
        end: 200,
        displayName: 'mrna.1',
        qualifiers: { gene: ['ABC'], product: ['XYZ'] },
      }),
    ]);
    expect(index.query('abc')).toHaveLength(1);
    expect(index.query('xyz')).toHaveLength(1);
    expect(index.query('bcxy')).toHaveLength(0);
  });

  it('reports the right `size`', () => {
    const index = buildAnnotationIndex([
      feat({ id: 1, type: 'mRNA', start: 1, end: 2, displayName: 'a' }),
      feat({ id: 2, type: 'mRNA', start: 3, end: 4, displayName: 'b' }),
    ]);
    expect(index.size).toBe(2);
  });

  it('uses primaryLabel = displayName when present, else first qualifier', () => {
    const index = buildAnnotationIndex([
      feat({
        id: 1,
        type: 'mRNA',
        start: 100,
        end: 200,
        displayName: '',
        qualifiers: { gene: ['LGALS12'] },
      }),
    ]);
    const hits = index.query('LGALS12');
    expect(hits[0].label).toBe('LGALS12');
  });

  it('scales to thousands of features without obvious quadratic blowup', () => {
    const features: Feature[] = [];
    for (let i = 0; i < 10_000; i++) {
      features.push(
        feat({
          id: i + 1,
          type: 'mRNA',
          start: i * 100,
          end: i * 100 + 50,
          displayName: `GENE${i}`,
          qualifiers: { product: [`hypothetical protein ${i}`] },
        })
      );
    }
    const t0 = Date.now();
    const index = buildAnnotationIndex(features);
    const buildMs = Date.now() - t0;
    const t1 = Date.now();
    const hits = index.query('hypothetical');
    const queryMs = Date.now() - t1;
    expect(hits.length).toBe(200);
    expect(buildMs).toBeLessThan(2_000);
    expect(queryMs).toBeLessThan(500);
  });
});
