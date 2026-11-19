import { describe, expect, it } from 'vitest';
import { limsOpenTargetOutputSchema } from '../features/ai/tools/lims-output-schemas';
import type { LimsEntity } from './lims';
import { registryRepresentationForEntity } from './registry-entity-opening';

function legacySequence(documentId?: string): LimsEntity {
  return {
    id: 'accepted-assembly-legacy-fixture',
    kind: 'plasmid',
    name: 'Legacy accepted assembly',
    schemaId: 'schema-entity-plasmid',
    schemaRevisionId: 'schema-entity-plasmid-v1',
    registryId: null,
    fields: {
      sequence: {
        mode: 'file',
        relPath: 'assemblies/legacy/result.gb',
        topology: 'circular',
        length: 4,
        contentHash: 'sha256:legacy-fixture',
        sourceFormat: 'gb',
        ...(documentId === undefined ? {} : { documentId }),
      },
    },
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: null,
    actor: null,
    eventSeq: 1,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}

describe('legacy Registry sequence opening contract', () => {
  it.each([undefined, '', '   '])(
    'preserves a legacy record without inventing an openable document for %j',
    (documentId) => {
      const entity = legacySequence(documentId);
      const before = structuredClone(entity);
      const representation = registryRepresentationForEntity(entity);
      const transported = JSON.parse(JSON.stringify(representation.openTarget));

      expect(limsOpenTargetOutputSchema.safeParse(transported).success).toBe(true);
      expect(representation.canOpen).toBe(false);
      expect(transported).toMatchObject({
        kind: 'record_detail',
        entityId: entity.id,
        reason: 'unresolved_sequence',
      });
      expect(transported).not.toHaveProperty('documentId');
      expect(entity).toEqual(before);
    }
  );

  it('keeps an existing exact document identity unchanged', () => {
    const representation = registryRepresentationForEntity(legacySequence('repo-b::sequence-1'));
    expect(representation.canOpen).toBe(true);
    expect(limsOpenTargetOutputSchema.parse(representation.openTarget)).toMatchObject({
      kind: 'sequence_file',
      entityId: 'accepted-assembly-legacy-fixture',
      documentId: 'repo-b::sequence-1',
    });
  });
});
