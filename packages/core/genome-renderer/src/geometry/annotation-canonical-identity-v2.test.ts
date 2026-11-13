import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_CANONICAL_IDENTITY_V2,
  annotationCanonicalIdentityV2,
  type AnnotationCanonicalIdentityV2Input,
} from './annotation-canonical-identity-v2';

const input: AnnotationCanonicalIdentityV2Input = {
  genomeIdentity: 'grch38-source-v47',
  sourceId: 'rna-NM_001.4',
  transcriptId: 'NM_001.4',
  trackId: 'mRNA',
  type: 'mRNA',
  startBp: 154_400_000,
  endBp: 154_401_000,
  direction: 'forward',
};

describe('annotationCanonicalIdentityV2', () => {
  it('matches the exact historical JSON tuple without local renderer identity', () => {
    expect(annotationCanonicalIdentityV2(input)).toBe(
      JSON.stringify([
        'annotation.v2',
        'grch38-source-v47',
        'rna-NM_001.4',
        'NM_001.4',
        'mRNA',
        'mRNA',
        154_400_000,
        154_401_000,
        'forward',
      ])
    );
    expect(ANNOTATION_CANONICAL_IDENTITY_V2).toBe('annotation.v2');
  });

  it('preserves exact well-formed Unicode without normalization', () => {
    const composed = annotationCanonicalIdentityV2({
      ...input,
      genomeIdentity: 'GRCh38-🧬',
      sourceId: 'β-café',
      transcriptId: null,
      trackId: '长链RNA',
    });
    const decomposed = annotationCanonicalIdentityV2({
      ...input,
      genomeIdentity: 'GRCh38-🧬',
      sourceId: 'β-cafe\u0301',
      transcriptId: null,
      trackId: '长链RNA',
    });

    expect(JSON.parse(composed)).toEqual([
      'annotation.v2',
      'GRCh38-🧬',
      'β-café',
      null,
      '长链RNA',
      'mRNA',
      154_400_000,
      154_401_000,
      'forward',
    ]);
    expect(decomposed).not.toBe(composed);
  });

  it.each([
    ['genomeIdentity', { ...input, genomeIdentity: '' }],
    ['sourceId', { ...input, sourceId: '' }],
    ['transcriptId', { ...input, transcriptId: '' }],
    ['trackId', { ...input, trackId: '' }],
    ['type', { ...input, type: '' }],
    ['coordinates', { ...input, startBp: -1 }],
    ['coordinates', { ...input, endBp: input.startBp }],
    ['coordinates', { ...input, endBp: Number.MAX_SAFE_INTEGER + 1 }],
    ['direction', { ...input, direction: 'sideways' }],
    ['malformed UTF-16', { ...input, sourceId: 'broken-\ud800' }],
  ])('rejects invalid %s input', (_label, invalid) => {
    expect(() =>
      annotationCanonicalIdentityV2(invalid as AnnotationCanonicalIdentityV2Input)
    ).toThrow();
  });

  it('rejects renderer-local or occupancy-derived identity fields', () => {
    expect(() =>
      annotationCanonicalIdentityV2({
        ...input,
        rendererId: 41,
      } as AnnotationCanonicalIdentityV2Input)
    ).toThrow(/rendererId/);
  });
});
