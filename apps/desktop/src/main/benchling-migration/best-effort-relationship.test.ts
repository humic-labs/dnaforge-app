import { describe, expect, it } from 'vitest';
import type { SourceObject, SourceRelationship } from '../../shared/benchling-migration';
import { resolveOfflineRelationships } from './relationship-resolver';

describe('best-effort Benchling references', () => {
  it('keeps an exact link unresolved while its target is only a preserved raw file', () => {
    const relationship: SourceRelationship = {
      id: 'relationship-to-failed-sequence',
      sourceObjectId: 'etr_NOTES1',
      targetSourceId: 'seq_FAILED1',
      relationType: 'linked_sequence',
      direction: 'outbound',
      evidence: [{ kind: 'stable_id', value: 'seq_FAILED1' }],
    };
    const source: SourceObject = {
      id: 'etr_NOTES1',
      stableId: 'etr_NOTES1',
      sourceType: 'notebook_entry',
      name: 'Notes',
      aliases: [],
      sourceUrl: 'urn:dnaforge:test:notes',
      attachmentHashes: [],
      memberships: [],
      metadata: {},
      content: {},
      relationships: [relationship],
    };
    const target: SourceObject = {
      ...source,
      id: 'seq_FAILED1',
      stableId: 'seq_FAILED1',
      sourceType: 'unsupported_object',
      name: 'Failed sequence',
      sourceUrl: 'urn:dnaforge:test:failed-sequence',
      relationships: [],
    };
    const resolve = (targetType: string) =>
      resolveOfflineRelationships({
        sourceObjects: [source, { ...target, sourceType: targetType }],
        relationships: [relationship],
        selectedSnapshotStableIdsAreAuthoritative: true,
      }).resolutions[0];

    expect(resolve('unsupported_object')).toMatchObject({
      classification: 'unresolved',
      targetSourceId: 'seq_FAILED1',
      candidateSourceIds: [],
    });
    expect(resolve('dna_sequence')).toMatchObject({
      classification: 'exact',
      targetSourceId: 'seq_FAILED1',
    });
  });
});
