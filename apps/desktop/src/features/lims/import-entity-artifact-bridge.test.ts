import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  type LimsImportPlan,
  type LimsImportPlanRecord,
} from '../../shared/lims';

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as Array<{ path: string; content: string; mutationToken?: string }>,
  apply: vi.fn(),
  beginWorkspaceMutation: vi.fn().mockResolvedValue('lims-import-token'),
  endWorkspaceMutation: vi.fn().mockResolvedValue(undefined),
  isGitRepo: vi.fn().mockResolvedValue(false),
  gitCommitPaths: vi.fn().mockResolvedValue(undefined),
  resolveWorkspaceId: vi.fn().mockResolvedValue(7),
  fieldTypes: new Map<string, string>(),
}));

vi.mock('../../db/workspace-catalog', () => ({
  resolveWorkspaceId: mocks.resolveWorkspaceId,
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    lims: {
      listSchemas: async () =>
        LIMS_BUILTIN_ENTITY_SCHEMAS.map((definition) => ({
          schemaId: `schema-entity-${definition.name}`,
          currentRevisionId: `schema-entity-${definition.name}-v1`,
          entityKind: definition.name,
          baseKind: definition.baseKind ?? definition.name,
          displayName: definition.displayName,
          description: definition.description,
          version: 1,
          builtin: true,
          fields: definition.fields.map((field) => ({
            ...field,
            type: mocks.fieldTypes.get(field.key) ?? field.type,
          })),
        })),
    },
    fs: {
      beginWorkspaceMutation: mocks.beginWorkspaceMutation,
      endWorkspaceMutation: mocks.endWorkspaceMutation,
      exists: async (path: string) => mocks.files.has(path),
      readTextFile: async (path: string) => mocks.files.get(path) ?? '',
      writeWorkspaceTextFileAtomic: async (input: {
        path: string;
        content: string;
        mutationToken?: string;
      }) => {
        mocks.writes.push(input);
        mocks.files.set(input.path, input.content);
        return { path: input.path, contentHash: 'sha256:test' };
      },
    },
  }),
}));

vi.mock('./ingress', () => ({
  applyAcceptedLimsImportPlan: mocks.apply,
}));

vi.mock('../workspace/git', () => ({
  isGitRepo: mocks.isGitRepo,
  gitCommitPaths: mocks.gitCommitPaths,
}));

import { parseEntityArtifact } from './entity-artifact';
import {
  EntityArtifactProjectionError,
  recordImportedEntityArtifacts,
} from './import-entity-artifact-bridge';

function record(id: string, name: string): LimsImportPlanRecord {
  return {
    id,
    sourceRow: 2,
    accepted: true,
    action: 'create',
    entityDraft: { kind: 'strain', name, fields: { genotypeCanonical: 'recA1' } },
    duplicateCandidates: [],
    proposedLinks: [],
    unresolvedLinks: [],
    errors: [],
    warnings: [],
    source: { Name: name },
  };
}

function plan(records: LimsImportPlanRecord[]): LimsImportPlan {
  return {
    id: 'plan-1',
    sourceName: 'strains.csv',
    sourceKind: 'csv',
    detectedKind: 'strain_table',
    columns: [],
    records,
    aggregateWarnings: [],
    forcedKind: 'strain',
    canApply: true,
    oracle: { ok: true, source: 'strains.csv', invariants: [] },
  };
}

beforeEach(() => {
  mocks.files.clear();
  mocks.writes.length = 0;
  mocks.fieldTypes.clear();
  mocks.beginWorkspaceMutation.mockClear();
  mocks.endWorkspaceMutation.mockClear();
  mocks.isGitRepo.mockReset().mockResolvedValue(false);
  mocks.gitCommitPaths.mockReset().mockResolvedValue(undefined);
  mocks.apply.mockReset();
  mocks.apply.mockImplementation(async (applied: LimsImportPlan) => {
    const inserted = applied.records.filter(
      (candidate) => candidate.accepted && candidate.action === 'create'
    );
    expect(mocks.files.size).toBe(inserted.length);
    return {
      batchId: 'batch-1',
      insertedEntities: inserted.length,
      insertedLinks: 0,
      skipped: 0,
      insertedEntityIds: inserted.map((candidate) => ({
        recordId: candidate.id,
        entityId: candidate.entityDraft.id!,
      })),
      insertedLinkIds: [],
      skippedRecordIds: [],
      unresolvedLinks: [],
      errors: [],
    };
  });
});

describe('recordImportedEntityArtifacts', () => {
  it('refuses an unsupported schema field before file publication or projection', async () => {
    mocks.fieldTypes.set('genotypeCanonical', 'future_opaque_field');
    await expect(
      recordImportedEntityArtifacts({
        plan: plan([record('row-1', 'DH5alpha')]),
        workspaceRoot: '/ws',
        destinationDir: '/ws/imported',
      })
    ).rejects.toThrow('UNSUPPORTED_SCHEMA_FIELD_TYPE');
    expect(mocks.writes).toHaveLength(0);
    expect(mocks.files.size).toBe(0);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.gitCommitPaths).not.toHaveBeenCalled();
  });
  it('holds one workspace mutation across authoritative writes, projection, and Git', async () => {
    mocks.isGitRepo.mockResolvedValue(true);

    const result = await recordImportedEntityArtifacts({
      plan: plan([record('row-1', 'DH5alpha')]),
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
    });

    expect(result.gitCommitted).toBe(true);
    expect(mocks.beginWorkspaceMutation).toHaveBeenCalledOnce();
    expect(mocks.beginWorkspaceMutation).toHaveBeenCalledWith('/ws', undefined);
    expect(mocks.writes.length).toBeGreaterThanOrEqual(2);
    expect(mocks.writes).toEqual(
      expect.arrayContaining([expect.objectContaining({ mutationToken: 'lims-import-token' })])
    );
    expect(mocks.writes.every((write) => write.mutationToken === 'lims-import-token')).toBe(true);
    expect(mocks.apply).toHaveBeenCalledWith(expect.any(Object), {
      mutationToken: 'lims-import-token',
    });
    expect(mocks.isGitRepo).toHaveBeenCalledWith('/ws', 'lims-import-token');
    expect(mocks.gitCommitPaths).toHaveBeenCalledWith(
      '/ws',
      'Import 1 strain record',
      expect.arrayContaining([
        expect.stringMatching(/\.entity\.json$/),
        expect.stringMatching(/manifest\.json$/),
      ]),
      'lims-import-token'
    );
    expect(mocks.endWorkspaceMutation).toHaveBeenCalledOnce();
    expect(mocks.endWorkspaceMutation).toHaveBeenCalledWith('lims-import-token');
    expect(mocks.endWorkspaceMutation.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.gitCommitPaths.mock.invocationCallOrder[0]
    );
  });

  it('releases the workspace mutation when Registry projection fails', async () => {
    mocks.apply.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      recordImportedEntityArtifacts({
        plan: plan([record('row-1', 'DH5alpha')]),
        workspaceRoot: '/ws',
        destinationDir: '/ws',
      })
    ).rejects.toBeInstanceOf(EntityArtifactProjectionError);

    expect(mocks.endWorkspaceMutation).toHaveBeenCalledWith('lims-import-token');
  });

  it('refuses protein records so callers cannot bypass the protein domain writer', async () => {
    const importedProtein = record('protein-row-1', 'Protein A');
    importedProtein.entityDraft = {
      kind: 'protein',
      name: 'Protein A',
      fields: {
        sequence: { mode: 'inline', aminoAcids: 'ACDEFGHIK', length: 9 },
      },
    };

    await expect(
      recordImportedEntityArtifacts({
        plan: plan([importedProtein]),
        workspaceRoot: '/ws',
        destinationDir: '/ws/imported',
      })
    ).rejects.toThrow('Protein imports must use recordImportedProteins()');
    expect(mocks.files.size).toBe(0);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('writes the managed authority before applying the Registry projection', async () => {
    const result = await recordImportedEntityArtifacts({
      plan: plan([record('row-1', 'DH5alpha')]),
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
      fileProvenance: { managedRelPath: 'imported/strains.csv', workspaceRootPath: '/ws' },
    });

    expect(result.artifactPaths).toHaveLength(1);
    expect(result.artifactAbsolutePaths).toHaveLength(1);
    expect(result.artifactPaths[0]).toMatch(
      /^imported\/records\/strain\/DH5alpha-[0-9a-f]{8}\.entity\.json$/
    );
    const artifact = parseEntityArtifact([...mocks.files.values()][0]);
    expect(artifact).toMatchObject({
      kind: 'strain',
      name: 'DH5alpha',
      source: { recordId: 'row-1', sourceName: 'strains.csv' },
    });
    expect(artifact.fields).toMatchObject({
      artifact: { schema: 'waypoint.entity.v2', relativePath: result.artifactPaths[0] },
      sourceMetadata: { importRecordId: 'row-1' },
    });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    const appliedPlan = mocks.apply.mock.calls[0][0] as LimsImportPlan;
    expect(appliedPlan.records[0].entityDraft.workspaceId).toBe(7);
    expect(result.importSet).toMatchObject({
      id: expect.stringMatching(/^import-set-/),
      manifestRelativePath: expect.stringMatching(/manifest\.json$/),
    });
    expect(result.members).toEqual([
      expect.objectContaining({
        sourceRecordId: 'row-1',
        entityId: artifact.id,
        entityKind: 'strain',
        artifactRelativePath: result.artifactPaths[0],
      }),
    ]);
    const manifest = [...mocks.files.entries()].find(([path]) => path.endsWith('/manifest.json'));
    expect(manifest).toBeDefined();
    expect(JSON.parse(manifest![1])).not.toHaveProperty('presentation');
  });

  it('keeps the imported record endpoint implicit for atomic batch apply', async () => {
    const imported = record('row-1', 'DH5alpha');
    imported.proposedLinks = [
      {
        type: 'derived_from',
        toEntityId: 'existing-parent',
        payload: { evidence: 'Parent strain' },
      },
    ];

    await recordImportedEntityArtifacts({
      plan: plan([imported]),
      workspaceRoot: '/ws',
      destinationDir: '/ws',
    });

    const artifact = parseEntityArtifact([...mocks.files.values()][0]);
    expect(artifact.relationships).toEqual([
      expect.objectContaining({
        fromEntityId: artifact.id,
        toEntityId: 'existing-parent',
        type: 'derived_from',
      }),
    ]);
    const applied = mocks.apply.mock.calls[0][0] as LimsImportPlan;
    expect(applied.records[0].entityDraft.id).toBe(artifact.id);
    expect(applied.records[0].proposedLinks).toEqual(imported.proposedLinks);
  });

  it('reports a projection-only failure without discarding the authoritative file', async () => {
    mocks.apply.mockRejectedValueOnce(new Error('database unavailable'));

    const caught = await recordImportedEntityArtifacts({
      plan: plan([record('row-1', 'DH5alpha')]),
      workspaceRoot: '/ws',
      destinationDir: '/ws',
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(EntityArtifactProjectionError);
    expect(caught).toMatchObject({
      artifactPaths: [expect.stringMatching(/\.entity\.json$/)],
      artifactAbsolutePaths: [expect.stringMatching(/\.entity\.json$/)],
    });
    expect(mocks.files.size).toBe(1);
  });

  it('preflights every destination before writing any file in a conflicting batch', async () => {
    const conflicting = record('row-2', 'BL21');
    const initial = await recordImportedEntityArtifacts({
      plan: plan([conflicting]),
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
    });
    const conflictPath = initial.artifactAbsolutePaths[0];
    const conflictBytes = mocks.files.get(conflictPath);
    expect(conflictBytes).toBeDefined();
    const existingFiles = new Map(mocks.files);

    mocks.apply.mockClear();
    const changedConflict = record('row-2', 'BL21');
    changedConflict.entityDraft.fields.genotypeCanonical = 'recA13';
    await expect(
      recordImportedEntityArtifacts({
        plan: plan([record('row-1', 'DH5alpha'), changedConflict]),
        workspaceRoot: '/ws',
        destinationDir: '/ws/imported',
      })
    ).rejects.toThrow(/different entity artifact/i);

    expect(mocks.files).toEqual(existingFiles);
    expect(mocks.files.get(conflictPath)).toBe(conflictBytes);
    expect([...mocks.files.keys()].some((path) => path.includes('DH5alpha'))).toBe(false);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('keeps imported entity identity portable across workspace mount paths', async () => {
    const importedPlan = plan([record('row-1', 'DH5alpha')]);
    const first = await recordImportedEntityArtifacts({
      plan: importedPlan,
      workspaceRoot: '/clone-a',
      destinationDir: '/clone-a/imported',
    });
    const firstId = first.members[0].entityId;

    mocks.files.clear();
    const second = await recordImportedEntityArtifacts({
      plan: importedPlan,
      workspaceRoot: '/clone-b',
      destinationDir: '/clone-b/imported',
    });

    expect(second.members[0].entityId).toBe(firstId);
  });

  it('does not change connector-backed identity for metadata edits, rename, or row movement', async () => {
    const originalRecord = record('row-1', 'DH5alpha');
    originalRecord.externalRowId = 'google-sheet-row-abc';
    const original = plan([originalRecord]);
    const first = await recordImportedEntityArtifacts({
      plan: original,
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
    });
    const firstId = first.members[0].entityId;

    mocks.files.clear();
    const editedRecord = record('row-1', 'Renamed DH5alpha');
    editedRecord.sourceRow = 100;
    editedRecord.externalRowId = 'google-sheet-row-abc';
    editedRecord.entityDraft.fields.notes = 'metadata added after the first import';
    editedRecord.source.Notes = 'metadata added after the first import';
    const second = await recordImportedEntityArtifacts({
      plan: plan([editedRecord]),
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
    });

    expect(second.members[0].entityId).toBe(firstId);
  });

  it('keeps static-file identities stable when rows are reordered', async () => {
    const first = await recordImportedEntityArtifacts({
      plan: plan([record('row-2', 'DH5alpha'), record('row-3', 'BL21')]),
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
    });
    const firstIds = new Map(
      first.members.map((member) => [member.sourceRecordId, member.entityId])
    );

    mocks.files.clear();
    const movedDh5alpha = record('row-3', 'DH5alpha');
    movedDh5alpha.sourceRow = 3;
    const movedBl21 = record('row-2', 'BL21');
    movedBl21.sourceRow = 2;
    const second = await recordImportedEntityArtifacts({
      plan: plan([movedBl21, movedDh5alpha]),
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
    });
    const secondByName = new Map(
      second.members.map((member) => {
        const imported = second.partition.plan.records.find(
          (candidate) => candidate.id === member.sourceRecordId
        );
        return [imported?.entityDraft.name, member.entityId];
      })
    );

    expect(secondByName.get('DH5alpha')).toBe(firstIds.get('row-2'));
    expect(secondByName.get('BL21')).toBe(firstIds.get('row-3'));
  });

  it('rejects indistinguishable static rows instead of assigning positional identities', async () => {
    await expect(
      recordImportedEntityArtifacts({
        plan: plan([record('row-2', 'duplicate'), record('row-3', 'duplicate')]),
        workspaceRoot: '/ws',
        destinationDir: '/ws/imported',
      })
    ).rejects.toThrow(/durable source row identifier/i);
    expect(mocks.files.size).toBe(0);
  });
});
