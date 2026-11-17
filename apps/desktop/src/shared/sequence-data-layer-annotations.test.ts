import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import {
  fingerprintSequenceDataLayerAnnotations,
  sequenceDataLayerAnnotationCandidates,
} from './sequence-data-layer-annotations';

const annotation: AnnotatedSequence['annotations'][number] = {
  name: 'Gene A',
  type: 'gene',
  start: 2,
  end: 4,
  direction: 1,
  canonicalIdentity: 'canonical-a',
  sourceId: 'source-a',
  qualifiers: { locus_tag: ['locus-a'], ID: ['id-a'], note: ['retained audit detail'] },
};

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sequence layer annotation mapping pins', () => {
  it('retains complete candidate qualifiers and the native identifier precedence', () => {
    const candidates = sequenceDataLayerAnnotationCandidates({
      annotations: [
        annotation,
        { ...annotation, canonicalIdentity: undefined },
        { ...annotation, canonicalIdentity: undefined, sourceId: undefined },
        {
          ...annotation,
          canonicalIdentity: undefined,
          sourceId: undefined,
          qualifiers: { ID: ['id-a'] },
        },
        { ...annotation, canonicalIdentity: undefined, sourceId: undefined, qualifiers: {} },
      ],
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'canonical-a',
      'source-a',
      'locus-a',
      'id-a',
    ]);
    expect(candidates[0]).toEqual({
      id: 'canonical-a',
      start0: 1,
      end0: 4,
      qualifiers: annotation.qualifiers,
    });
  });

  it('canonicalizes candidate and qualifier order without pinning display or descriptive fields', async () => {
    const original = sequenceDataLayerAnnotationCandidates({
      annotations: [
        { ...annotation, qualifiers: { locus_tag: ['second', 'first', 'second'], ID: ['B', 'A'] } },
        { ...annotation, canonicalIdentity: 'canonical-b', start: 6, end: 8 },
      ],
    });
    const reordered = sequenceDataLayerAnnotationCandidates({
      annotations: [
        { ...annotation, canonicalIdentity: 'canonical-b', start: 6, end: 8 },
        {
          ...annotation,
          name: 'Renamed annotation',
          color: '#ffffff',
          qualifiers: { locus_tag: ['first', 'second'], ID: ['A', 'B'], note: ['new note'] },
        },
      ],
    });
    const fingerprint = await fingerprintSequenceDataLayerAnnotations(original);
    expect(fingerprint).toMatch(/^annotation-mapping-v1:sha256:[a-f0-9]{64}$/u);
    expect(await fingerprintSequenceDataLayerAnnotations(reordered)).toBe(fingerprint);
    expect(await fingerprintSequenceDataLayerAnnotations([...original, original[0]])).toBe(
      fingerprint
    );
  });
});
