import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsEntity, LimsRegisterEntityInput } from '../../shared/lims';

const mocks = vi.hoisted(() => ({
  queryLimsEntities: vi.fn(),
}));

vi.mock('./operations', () => ({
  queryLimsEntities: mocks.queryLimsEntities,
}));

import {
  getLimsEntityById,
  hasOpenableFileRepresentation,
  resolveLimsEntityOpenTarget,
  resolveLimsEntityOpenTargetFromEntity,
} from './open-target';

describe('LIMS entity open target resolver', () => {
  beforeEach(() => {
    mocks.queryLimsEntities.mockReset();
  });

  it.each(['strain', 'organism', 'custom_record'])(
    'opens a saved %s record by its existing identity and home',
    (kind) => {
      const record = makeEntity({
        id: 'saved-record',
        kind,
        name: 'Saved record',
        workspaceId: 7,
        fields: {
          artifact: { schema: 'waypoint.entity.v2', relativePath: 'records/saved.entity.json' },
        },
      });
      expect(resolveLimsEntityOpenTargetFromEntity(record)).toEqual({
        kind: 'record_file',
        entityId: record.id,
        entityKind: kind,
        label: record.name,
        workspaceId: 7,
        artifactRelativePath: 'records/saved.entity.json',
      });
    }
  );

  it.each(['../outside.entity.json', '/outside.entity.json', 'records/not-an-entity.json'])(
    'keeps an invalid saved-record locator in Details: %s',
    (relativePath) => {
      expect(
        resolveLimsEntityOpenTargetFromEntity(
          makeEntity({
            kind: 'strain',
            workspaceId: 7,
            fields: { artifact: { schema: 'waypoint.entity.v2', relativePath } },
          })
        )
      ).toMatchObject({ kind: 'record_detail' });
    }
  );

  it('does not invent a home for an unassigned saved-record projection', () => {
    expect(
      resolveLimsEntityOpenTargetFromEntity(
        makeEntity({
          kind: 'strain',
          workspaceId: null,
          fields: { artifact: { schema: 'waypoint.entity.v2', relativePath: 'saved.entity.json' } },
        })
      )
    ).toMatchObject({ kind: 'record_detail' });
  });

  it.each([
    {
      kind: 'protein',
      sequence: { mode: 'inline', bases: 'MKW', length: 3 },
      expected: 'protein_sequence',
    },
    { kind: 'notebook', sequence: undefined, expected: 'notebook' },
    { kind: 'track-view', sequence: undefined, expected: 'track_view' },
    {
      kind: 'dna_sequence',
      sequence: {
        mode: 'file',
        documentId: 'dna-doc',
        relPath: '/workspace/dna.gb',
        topology: 'linear',
        length: 3,
      },
      expected: 'sequence_file',
    },
  ])(
    'retains the specialized $kind route before generic record opening',
    ({ kind, sequence, expected }) => {
      const record = makeEntity({
        kind,
        workspaceId: 7,
        fields: {
          sequence,
          ...(kind === 'notebook' ? { packagePath: '/workspace/Notebook' } : {}),
          artifact: { schema: 'waypoint.entity.v2', relativePath: 'saved.entity.json' },
        },
      });
      expect(resolveLimsEntityOpenTargetFromEntity(record)).toMatchObject({ kind: expected });
    }
  );

  it('resolves file-backed sequence entities to sequence file open targets', () => {
    const plasmid = makeEntity({
      id: 'demo-dna509-plasmid-puc19',
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/fixtures/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
        source: 'fixture',
      },
      registrationStatus: 'registered',
    });

    const target = resolveLimsEntityOpenTargetFromEntity(plasmid);

    expect(target).toMatchObject({
      kind: 'sequence_file',
      entityId: 'demo-dna509-plasmid-puc19',
      entityKind: 'plasmid',
      label: 'pUC19',
      registrationStatus: 'registered',
      sequence: {
        topology: 'circular',
        length: 2686,
        sourceFormat: 'gb',
      },
      source: 'fixture',
    });
    expect(target).not.toHaveProperty('filePath');
    expect(target.kind === 'sequence_file' ? target.sequence : null).not.toHaveProperty('relPath');
    expect(hasOpenableFileRepresentation(plasmid)).toBe(true);
  });

  it.each(['oligo', 'rna_oligo', 'custom-primer'])(
    'resolves a saved %s through the primer editor regardless of its schema kind',
    (kind) => {
      const primer = makeEntity({
        id: 'saved-primer-1',
        kind,
        name: 'Saved primer',
        workspaceId: 7,
        fields: {
          sequence: { mode: 'inline', bases: 'ACGTACGT', length: 8, topology: 'linear' },
          artifact: { schema: 'dnaforge.primer', relativePath: 'primers/saved.primer.json' },
        },
      });

      expect(resolveLimsEntityOpenTargetFromEntity(primer)).toMatchObject({
        kind: 'primer',
        entityId: primer.id,
        label: primer.name,
        workspaceId: 7,
        artifactRelativePath: 'primers/saved.primer.json',
      });
    }
  );

  it('keeps a record-only inline sequence distinct from a saved primer artifact', () => {
    const oligo = makeEntity({
      id: 'primer-1',
      kind: 'oligo',
      name: 'M13 Forward',
      fields: {
        sequence: {
          mode: 'inline',
          bases: 'GTAAAACGACGGCCAGT',
          topology: 'linear',
          length: 17,
          contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    });

    expect(resolveLimsEntityOpenTargetFromEntity(oligo)).toMatchObject({
      kind: 'record_detail',
      entityId: 'primer-1',
      reason: 'inline_sequence',
      inlineSequence: {
        length: 17,
        topology: 'linear',
        contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    expect(hasOpenableFileRepresentation(oligo)).toBe(false);
  });

  it('prefers a managed package ref over a projected raw product path', () => {
    const sequence = makeEntity({
      id: 'managed-sequence-1',
      kind: 'sequence',
      name: 'Logical sequence name',
      fields: {
        _managedSequenceDocument: {
          kind: 'managed-sequence',
          packageId: 'managed-sequence-1',
          packageRoot: '/workspace/Package',
        },
        sequence: {
          mode: 'file',
          relPath: '/workspace/Package/physical-file.gb',
          topology: 'circular',
          length: 42,
          contentHash: 'sha256:raw-file-projection',
          sourceFormat: 'gb',
        },
      },
      registrationStatus: 'tracked',
    });

    expect(resolveLimsEntityOpenTargetFromEntity(sequence)).toEqual({
      kind: 'managed_sequence',
      entityId: 'managed-sequence-1',
      entityKind: 'sequence',
      label: 'Logical sequence name',
      registrationStatus: 'tracked',
      document: {
        kind: 'managed-sequence',
        packageId: 'managed-sequence-1',
        packageRoot: '/workspace/Package',
      },
    });
  });

  it('queries one entity by id when resolving from the registry API', async () => {
    const plasmid = makeEntity({
      id: 'demo-dna509-plasmid-puc19',
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/fixtures/pUC19.gb',
          topology: 'circular',
          length: 2686,
          contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceFormat: 'gb',
        },
      },
    });
    mocks.queryLimsEntities.mockResolvedValue([plasmid]);

    const entity = await getLimsEntityById('demo-dna509-plasmid-puc19');
    const target = await resolveLimsEntityOpenTarget('demo-dna509-plasmid-puc19');

    expect(entity).toBe(plasmid);
    expect(target.kind).toBe('sequence_file');
    expect(mocks.queryLimsEntities).toHaveBeenCalledWith({
      id: 'demo-dna509-plasmid-puc19',
      includeArchived: true,
      limit: 1,
    });
  });

  it('returns a missing target for unknown entity ids', async () => {
    mocks.queryLimsEntities.mockResolvedValueOnce([]);

    await expect(resolveLimsEntityOpenTarget('missing-entity')).resolves.toEqual({
      kind: 'missing_entity',
      entityId: 'missing-entity',
      label: 'missing-entity',
      reason: 'not_found',
    });
  });

  it('returns a missing target for archived entities instead of reopening them', async () => {
    const archivedProtein = makeEntity({
      id: 'archived-protein',
      kind: 'protein',
      name: 'Archived protein',
      fields: { sequence: { mode: 'inline', aminoAcids: 'MPEPTIDE', length: 8 } },
    });
    mocks.queryLimsEntities.mockResolvedValueOnce([
      { ...archivedProtein, tombstone: true, archivedAt: 123 },
    ]);

    await expect(resolveLimsEntityOpenTarget('archived-protein')).resolves.toEqual({
      kind: 'missing_entity',
      entityId: 'archived-protein',
      label: 'Archived protein',
      reason: 'not_found',
    });
  });
});

describe('LIMS entity open target resolver — protein entities ', () => {
  it('resolves a file-backed protein to a protein_sequence open target, never sequence_file', () => {
    const protein = makeEntity({
      id: 'protein-uuid-1',
      kind: 'protein',
      name: 'GFP',
      fields: {
        sequence: {
          mode: 'file',
          relPath: 'proteins/GFP-abcd1234.faa',
          length: 238,
          contentHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          sourceFormat: 'fasta',
        },
      },
    });

    expect(resolveLimsEntityOpenTargetFromEntity(protein)).toEqual({
      kind: 'protein_sequence',
      entityId: 'protein-uuid-1',
      entityKind: 'protein',
      label: 'GFP',
      filePath: 'proteins/GFP-abcd1234.faa',
      registrationStatus: 'registered',
    });
  });

  it('does not misclassify a protein as a DNA sequence_file despite the structural overlap', () => {
    const protein = makeEntity({
      id: 'protein-uuid-2',
      kind: 'protein',
      name: 'GFP',
      fields: {
        sequence: { mode: 'file', relPath: 'proteins/GFP.faa', length: 5, contentHash: 'x' },
      },
    });

    const target = resolveLimsEntityOpenTargetFromEntity(protein);
    expect(target.kind).not.toBe('sequence_file');
    expect(target.kind).toBe('protein_sequence');
  });

  it('resolves an unresolved protein to a record_detail target', () => {
    const protein = makeEntity({
      id: 'protein-uuid-3',
      kind: 'protein',
      name: 'GFP',
      fields: { sequence: { mode: 'unresolved' } },
    });

    expect(resolveLimsEntityOpenTargetFromEntity(protein)).toMatchObject({
      kind: 'record_detail',
      entityId: 'protein-uuid-3',
      reason: 'unresolved_sequence',
    });
  });

  it('opens a package-backed inline protein in the protein editor', () => {
    const protein = makeEntity({
      id: 'protein-package-1',
      kind: 'protein',
      name: 'Inline GFP',
      fields: {
        sequence: { mode: 'inline', aminoAcids: 'MSKX*', length: 5 },
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'proteins/GFP.entity.json' },
      },
    });

    expect(resolveLimsEntityOpenTargetFromEntity(protein)).toEqual({
      kind: 'protein_sequence',
      entityId: 'protein-package-1',
      entityKind: 'protein',
      label: 'Inline GFP',
      registrationStatus: 'registered',
    });
  });

  it('keeps notebook-class metadata records openable without inventing a missing notebook page', () => {
    const notebook = makeEntity({ id: 'metadata-notebook', kind: 'notebook', fields: {} });
    expect(resolveLimsEntityOpenTargetFromEntity(notebook)).toMatchObject({
      kind: 'record_detail',
      entityId: 'metadata-notebook',
      reason: 'no_primary_representation',
    });
  });

  it('resolves notebook entities to the notebook page open target', () => {
    const notebook = makeEntity({
      id: 'ws1::page-1',
      kind: 'notebook',
      name: 'Miniprep',
      fields: { packagePath: '/lab/Miniprep' },
    });

    expect(resolveLimsEntityOpenTargetFromEntity(notebook)).toEqual({
      kind: 'notebook',
      entityId: 'ws1::page-1',
      entityKind: 'notebook',
      label: 'Miniprep',
      filePath: '/lab/Miniprep',
    });
  });

  it('resolves saved Track view projections to their file-backed viewer target', () => {
    const trackView = makeEntity({
      id: 'track-view-1',
      kind: 'track-view',
      name: 'Yeast detail',
      fields: {
        referenceAssemblyId: 'sacCer3',
        referenceName: 'S. cerevisiae',
        trackCount: 2,
        artifactFingerprint: 'track-view-fingerprint',
      },
    });

    expect(resolveLimsEntityOpenTargetFromEntity(trackView)).toEqual({
      kind: 'track_view',
      entityId: 'track-view-1',
      entityKind: 'track-view',
      label: 'Yeast detail',
    });
  });
});

function makeEntity(input: LimsRegisterEntityInput): LimsEntity {
  const now = Date.now();
  return {
    id: input.id ?? 'entity-1',
    kind: input.kind,
    schemaId: `schema-entity-${input.kind}`,
    schemaRevisionId: input.schemaRevisionId ?? `schema-entity-${input.kind}-v1`,
    name: input.name,
    registryId: null,
    fields: input.fields,
    registrationStatus: input.registrationStatus ?? 'registered',
    domainStatus: input.domainStatus ?? null,
    workspaceId: input.workspaceId ?? null,
    actor: input.actor ?? 'test',
    eventSeq: null,
    tombstone: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}
