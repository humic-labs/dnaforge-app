import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSequenceDocument, reverseComplement } from '@waypoint/sequence-utils';
import { composeSequenceProduct } from './sequence-product';

const fixtureRoot = resolve(
  import.meta.dirname,
  '../../../../test-fixtures/scientific-object-standard/yeast-heat-recovery'
);
const chromosome = decodeSequenceDocument(
  readFileSync(resolve(fixtureRoot, 'HSP42.NC_001136.10.804621-809748.gb'), 'utf8')
).sequence;
const donor = decodeSequenceDocument(
  readFileSync(resolve(fixtureRoot, 'pUG6.AF298793.1.gb'), 'utf8')
).sequence;
const sources = new Map([
  ['chromosome', chromosome],
  ['donor', donor],
]);

describe('exact sequence products', () => {
  it('joins source ranges without adding assembly overlaps or changing endpoints', () => {
    const product = composeSequenceProduct(
      'Planned allele',
      false,
      [
        { kind: 'source', documentId: 'chromosome', start: 1, end: 100, strand: 1 },
        { kind: 'source', documentId: 'donor', start: 201, end: 400, strand: 1 },
        {
          kind: 'source',
          documentId: 'chromosome',
          start: 1001,
          end: chromosome.length,
          strand: 1,
        },
      ],
      sources
    );
    expect(product.sequence).toBe(
      (
        chromosome.sequence.slice(0, 100) +
        donor.sequence.slice(200, 400) +
        chromosome.sequence.slice(1000)
      ).toUpperCase()
    );
    expect(product.length).toBe(100 + 200 + chromosome.length - 1000);
    expect(product.circular).toBe(false);
  });

  it('preserves reverse source orientation and explicit synthetic bases', () => {
    const product = composeSequenceProduct(
      'Reverse donor',
      false,
      [
        { kind: 'source', documentId: 'donor', start: 201, end: 400, strand: -1 },
        { kind: 'literal', sequence: 'acgtn', label: 'Explicit synthetic DNA' },
      ],
      sources
    );
    expect(product.sequence).toBe(
      reverseComplement(donor.sequence.slice(200, 400)).toUpperCase() + 'ACGTN'
    );
    expect(product.annotations.at(-1)?.name).toBe('Explicit synthetic DNA');
  });

  it('refuses missing sources and out-of-range coordinates instead of clamping', () => {
    expect(() =>
      composeSequenceProduct(
        'Bad',
        false,
        [{ kind: 'source', documentId: 'absent', start: 1, end: 10, strand: 1 }],
        sources
      )
    ).toThrow('source');
    expect(() =>
      composeSequenceProduct(
        'Bad',
        false,
        [{ kind: 'source', documentId: 'donor', start: 1, end: donor.length + 1, strand: 1 }],
        sources
      )
    ).toThrow('range');
    expect(() =>
      composeSequenceProduct(
        'Bad',
        false,
        [{ kind: 'literal', sequence: 'ACGTZ', label: 'Bad DNA' }],
        sources
      )
    ).toThrow('DNA');
  });
});
