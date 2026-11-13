import { describe, expect, it } from 'vitest';
import { referenceContentIdentity } from './reference-content-identity';

const source = { fastaSha256: 'a'.repeat(64), gffSha256: 'b'.repeat(64) };
const members = [
  { chrom: 'chr1', sourceSeqId: 'NC_000001.11', lengthBp: 248956422, circular: false },
];
const input = { source, members, pipelineRevision: 3 };

describe('reference content identities', () => {
  it('keeps coordinates stable across annotation and preparation changes', () => {
    const old = referenceContentIdentity(input);
    const update = referenceContentIdentity({
      ...input,
      source: { ...source, gffSha256: 'c'.repeat(64) },
    });
    expect(old.sequenceIdentity).toBe(update.sequenceIdentity);
    expect(old.annotationIdentity).not.toBe(update.annotationIdentity);
    const artifactPreparation = referenceContentIdentity({
      ...input,
      annotationPreparation: [{ themeMode: 'dark', inventoryFingerprint: 'e'.repeat(64) }],
    });
    expect(artifactPreparation.sequenceIdentity).toBe(old.sequenceIdentity);
    expect(artifactPreparation.annotationIdentity).not.toBe(old.annotationIdentity);
    const preparation = referenceContentIdentity({ ...input, pipelineRevision: 4 });
    expect(preparation.sequenceIdentity).toBe(old.sequenceIdentity);
    expect(preparation.annotationIdentity).not.toBe(old.annotationIdentity);
  });

  it('changes sequence identity on bytes, names, lengths, order, or topology changes', () => {
    const old = referenceContentIdentity(input).sequenceIdentity;
    for (const next of [
      { ...input, source: { ...source, fastaSha256: 'd'.repeat(64) } },
      { ...input, members: [{ ...members[0], chrom: 'chrI' }] },
      { ...input, members: [{ ...members[0], lengthBp: 248956421 }] },
      { ...input, members: [{ ...members[0], circular: true }] },
    ])
      expect(referenceContentIdentity(next).sequenceIdentity).not.toBe(old);
  });
});
