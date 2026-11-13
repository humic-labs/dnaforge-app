// @vitest-environment node

import {
  packPrepackedAnnotationSearchIndexV1,
  unpackPrepackedAnnotationSearchIndexV1,
} from '@waypoint/genome-data';
import { describe, expect, it } from 'vitest';

import { buildAnnotationIndex, type IndexableFeature } from './genome-annotation-index';

type SearchFixtureFeature = Omit<IndexableFeature, 'direction'> &
  Partial<Pick<IndexableFeature, 'direction'>>;

async function packedIndex(features: ReadonlyArray<IndexableFeature>) {
  const packed = await packPrepackedAnnotationSearchIndexV1({
    datasetContract: {
      datasetId: 'differential-fixture',
      datasetVersion: 'v1',
      sourceSha256: 'a'.repeat(64),
    },
    assemblyContract: {
      assemblyId: 'test',
      assemblyLengthBp: 10_000_000,
      placementSignature: 'chr1:10000000',
      sourceFingerprint: 'b'.repeat(24),
    },
    trackType: 'mRNA',
    features: features.map((feature, index) => ({
      ...feature,
      annotationTrackId: feature.annotationTrackId ?? feature.type,
      canonicalIdentity: feature.canonicalIdentity ?? `annotation.v2:test-${index}`,
    })),
  });
  return unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);
}

function withSearchIdentity(features: ReadonlyArray<SearchFixtureFeature>): IndexableFeature[] {
  return features.map((feature, index) => ({
    ...feature,
    direction: feature.direction ?? 'forward',
    annotationTrackId: feature.annotationTrackId ?? feature.type,
    canonicalIdentity: feature.canonicalIdentity ?? `annotation.v2:test-${index}`,
  }));
}

describe('genome annotation index packed v1 differential', () => {
  it('is result-exact across the legacy contract matrix', async () => {
    const loneHigh = '\ud83d';
    const features = withSearchIdentity([
      {
        type: 'mRNA',
        start: 9_000,
        end: 9_500,
        displayName: 'LGALS12-İSTANBUL-😀',
        qualifiers: {
          gene: ['FIRST', 'SECOND-QUALIFIER', 'THIRD-QUALIFIER'],
          note: `lone-${loneHigh}X`,
        },
        attributes: {
          product: ['first product', 'SECOND-ATTRIBUTE', 'THIRD-ATTRIBUTE'],
        },
      },
      {
        type: 'mRNA',
        start: 5_000,
        end: 5_500,
        displayName: 'ABCxxBCD-AAAAA',
        qualifiers: { gene: 'TP53' },
      },
      {
        type: 'lnc_RNA',
        start: 10,
        end: 20,
        displayName: '',
        qualifiers: { insertedFirst: ['', 'FALLBACK-LABEL'], later: ['later-label'] },
      },
      {
        type: 'enhancer',
        start: 100,
        end: 200,
        displayName: 'alpha',
        attributes: { product: ['beta'] },
      },
      {
        type: 'mRNA',
        start: 1_000,
        end: 1_100,
        displayName: 'MATCH-A',
      },
      {
        type: 'mRNA',
        start: 100,
        end: 150,
        displayName: 'MATCH-B',
      },
      {
        type: 'mRNA',
        start: 1,
        end: 2,
        displayName: 'MATCH-C',
      },
    ]);
    const legacy = buildAnnotationIndex(features);
    const durable = await packedIndex(features);
    const separator = '|][|';
    const queries = [
      '',
      '   ',
      'm',
      'p5',
      'lgals',
      'second-qualifier',
      'third-qualifier',
      'second-attribute',
      'third-attribute',
      'qualifiers',
      'i\u0307stanbul',
      '😀',
      loneHigh,
      `${loneHigh}x`,
      'aaaa',
      'abcd',
      'abcxxbcd',
      'alphabeta',
      `alpha${separator}enhancer`,
      `enhancer${separator}beta`,
      'fallback-label',
      'match',
      'zzz',
    ];
    const limits = [undefined, 0, 1, 2, 3, 200] as const;

    expect(durable.size).toBe(legacy.size);
    for (const query of queries) {
      for (const limit of limits) {
        expect(durable.query(query, limit), `${JSON.stringify(query)} limit=${limit}`).toEqual(
          legacy.query(query, limit)
        );
      }
    }
  });

  it('preserves source-prefix-before-sort for deliberately unsorted overflow', async () => {
    const features = withSearchIdentity(
      Array.from({ length: 20 }, (_, index) => ({
        type: 'mRNA',
        start: (20 - index) * 1_000,
        end: (20 - index) * 1_000 + 50,
        displayName: `COMMON-${index}`,
        qualifiers: { product: [`shared token ${index}`] },
      }))
    );
    const legacy = buildAnnotationIndex(features);
    const durable = await packedIndex(features);

    expect(durable.query('common', 7)).toEqual(legacy.query('common', 7));
    expect(durable.query('common', 7).map((match) => match.featureIndex)).toEqual([
      6, 5, 4, 3, 2, 1, 0,
    ]);
  });
});
