import { describe, expect, it } from 'vitest';

import type { SourceObject } from '../../shared/benchling-migration';
import {
  dnaScientificFingerprint,
  findUnboundExactNativeMatch,
  type NativeExactMatchCandidate,
} from './native-exact-match';

function sequence(id: string, bases: string, moleculeType = 'DNA'): SourceObject {
  return {
    id,
    stableId: id,
    aliases: [],
    sourceType: 'dna_sequence',
    name: id,
    sourceUrl: '',
    sourcePath: undefined,
    content: { moleculeType, bases, topology: 'linear', annotations: [] },
    attachmentHashes: [],
    memberships: [],
    relationships: [],
    metadata: {},
  };
}

function candidate(
  entityId: string,
  scientificSha256: `sha256:${string}`,
  providerBindingCount = 0
): NativeExactMatchCandidate {
  return {
    entityId,
    displayName: entityId,
    nativeKind: 'dna_sequence',
    scientificSha256,
    providerBindingCount,
    location: {
      kind: 'catalog-record',
      parentRelativePath: '',
      presentationKind: 'sequence',
      catalogType: 'sequence',
    },
  };
}

function fingerprint(sourceObject: SourceObject): `sha256:${string}` {
  const value = dnaScientificFingerprint(sourceObject);
  if (!value) throw new Error('Fixture has no DNA fingerprint.');
  return value;
}

describe('native exact match', () => {
  it('normalizes direct DNA sequence case without treating serialized bytes as science', () => {
    expect(dnaScientificFingerprint(sequence('seq_INCOMING2', 'ACGTN'))).toMatch(/[0-9a-f]{64}/);
    expect(dnaScientificFingerprint(sequence('seq_INCOMING1', 'acgtN'))).toBe(
      dnaScientificFingerprint(sequence('seq_INCOMING2', 'ACGTN'))
    );
  });

  it('declines RNA, malformed alphabets, and non-sequence objects', () => {
    expect(dnaScientificFingerprint(sequence('seq_RNA0001', 'ACGU', 'RNA'))).toBeNull();
    expect(dnaScientificFingerprint(sequence('seq_BAD0001', 'ACGT!'))).toBeNull();
    expect(
      dnaScientificFingerprint({ ...sequence('seq_NOTE0001', 'ACGT'), sourceType: 'notebook' })
    ).toBeNull();
  });

  it('returns one unbound compatible candidate and ignores bound or unequal entities', () => {
    const incoming = sequence('seq_INCOMING3', 'ACGTACGT');
    const scientificSha256 = fingerprint(incoming);

    expect(
      findUnboundExactNativeMatch({
        sourceObject: incoming,
        candidates: [
          candidate('exact-unbound', scientificSha256),
          candidate('exact-already-bound', scientificSha256, 1),
          candidate('different', fingerprint(sequence('seq_DIFF001', 'TTTT'))),
        ],
      })
    ).toEqual({ kind: 'single', candidate: candidate('exact-unbound', scientificSha256) });
  });

  it('fails closed when two unbound native entities have identical science', () => {
    const incoming = sequence('seq_INCOMING4', 'GATTACA');
    const scientificSha256 = fingerprint(incoming);

    expect(
      findUnboundExactNativeMatch({
        sourceObject: incoming,
        candidates: [
          candidate('candidate-b', scientificSha256),
          candidate('candidate-a', scientificSha256),
        ],
      })
    ).toEqual({
      kind: 'ambiguous',
      candidateEntityIds: ['candidate-a', 'candidate-b'],
    });
  });
});
