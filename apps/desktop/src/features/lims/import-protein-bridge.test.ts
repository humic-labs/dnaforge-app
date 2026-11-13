import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsImportPlan } from '../../shared/lims';

const mocks = vi.hoisted(() => ({
  recordProtein: vi.fn(),
  persistImportSet: vi.fn(),
  isGitRepo: vi.fn(async () => false),
  gitCommitPaths: vi.fn(),
  beginWorkflowAction: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));

vi.mock('../proteins/record-proteins', () => ({
  recordProtein: mocks.recordProtein,
  ProteinProjectionError: class ProteinProjectionError extends Error {
    constructor(
      public readonly artifactPath: string,
      public readonly artifactAbsolutePath: string,
      public readonly artifact: { id: string; kind: string },
      public readonly created: boolean,
      cause: unknown
    ) {
      super(cause instanceof Error ? cause.message : String(cause));
    }
  },
}));
vi.mock('./import-set', () => ({ persistImportSet: mocks.persistImportSet }));
vi.mock('../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: mocks.beginWorkflowAction,
}));
vi.mock('./record-entity-artifact', () => ({
  resolveEntityArtifactSchemaFields: vi.fn(async () => []),
}));
vi.mock('../workspace/git', () => ({
  isGitRepo: mocks.isGitRepo,
  gitCommitPaths: mocks.gitCommitPaths,
}));

import { ProteinProjectionError } from '../proteins/record-proteins';
import { recordImportedProteins } from './import-protein-bridge';

function proteinPlan(): LimsImportPlan {
  return {
    id: 'protein-plan',
    sourceName: 'proteins.csv',
    sourceKind: 'csv',
    detectedKind: 'sequence_file',
    columns: [
      {
        sourceColumn: 'Sequence',
        mappedField: 'fields.sequence',
        mappingMode: 'mapped',
        confidence: 'deterministic',
        warnings: [],
      },
    ],
    records: [
      {
        id: 'row-2',
        sourceRow: 2,
        accepted: true,
        action: 'create',
        entityDraft: {
          kind: 'protein',
          name: 'Alpha',
          fields: {
            sequence: {
              mode: 'inline',
              aminoAcids: 'MSTNPKPQR',
              length: 9,
              contentHash: `sha256:${'1'.repeat(64)}`,
            },
            organism: 'Escherichia coli',
          },
        },
        duplicateCandidates: [],
        proposedLinks: [],
        unresolvedLinks: [],
        errors: [],
        warnings: [],
        source: { Name: 'Alpha', Sequence: 'MSTNPKPQR' },
      },
    ],
    aggregateWarnings: [],
    forcedKind: 'protein',
    canApply: true,
    oracle: { ok: true, source: 'proteins.csv', invariants: [] },
  };
}

function twoProteinPlan(): LimsImportPlan {
  const plan = proteinPlan();
  return {
    ...plan,
    records: [
      plan.records[0],
      {
        ...plan.records[0],
        id: 'row-3',
        sourceRow: 3,
        entityDraft: {
          ...plan.records[0].entityDraft,
          name: 'Beta',
          fields: {
            ...plan.records[0].entityDraft.fields,
            sequence: {
              mode: 'inline',
              aminoAcids: 'MKQL',
              length: 4,
              contentHash: `sha256:${'2'.repeat(64)}`,
            },
          },
        },
        source: { Name: 'Beta', Sequence: 'MKQL' },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.beginWorkflowAction.mockReturnValue({ complete: mocks.complete, fail: mocks.fail });
  mocks.recordProtein.mockResolvedValue({
    artifactPath: 'imported/Alpha-12345678.entity.json',
    artifactAbsolutePath: '/ws/imported/Alpha-12345678.entity.json',
    artifact: {
      id: 'protein-authoritative-id',
      kind: 'protein',
      file: { workspaceRelativePath: 'imported/Alpha-12345678.entity.json' },
    },
    limsEntity: { id: 'protein-authoritative-id', kind: 'protein', name: 'Alpha', fields: {} },
    gitCommitted: false,
    created: true,
  });
  mocks.persistImportSet.mockResolvedValue({
    importSet: {
      id: 'import-set-1',
      manifestRelativePath: '.waypoint/import-sets/1/manifest.json',
    },
    relativePaths: ['.waypoint/import-sets/1/manifest.json'],
  });
});

describe('recordImportedProteins', () => {
  it('routes spreadsheet proteins through recordProtein with import provenance', async () => {
    const result = await recordImportedProteins(proteinPlan(), {
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
      fileProvenance: { managedRelPath: 'imported/proteins.csv', workspaceRootPath: '/ws' },
      source: { text: 'Name,Sequence\nAlpha,MSTNPKPQR' },
    });

    expect(mocks.recordProtein).toHaveBeenCalledTimes(1);
    expect(mocks.recordProtein).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Alpha',
        sequence: 'MSTNPKPQR',
        organism: 'Escherichia coli',
        workspaceRoot: '/ws',
        dir: '/ws/imported',
        deferCommit: true,
        source: expect.objectContaining({
          type: 'file_import',
          recordId: 'row-2',
          sourceName: 'proteins.csv',
          sourceKind: 'csv',
          values: expect.objectContaining({ managedRelPath: 'imported/proteins.csv' }),
        }),
      })
    );
    expect(result).toMatchObject({ added: 1, skipped: 0, failed: 0 });
    expect(result.members).toEqual([
      expect.objectContaining({
        entityId: 'protein-authoritative-id',
        entityKind: 'protein',
        artifactRelativePath: 'imported/Alpha-12345678.entity.json',
      }),
    ]);
  });

  it('keeps a file-first package in provenance and Git when Registry projection fails', async () => {
    mocks.isGitRepo.mockResolvedValue(true);
    mocks.recordProtein.mockRejectedValueOnce(
      new ProteinProjectionError(
        'imported/Alpha-12345678.entity.json',
        '/ws/imported/Alpha-12345678.entity.json',
        { id: 'protein-authoritative-id', kind: 'protein' },
        true,
        new Error('database unavailable')
      )
    );

    const result = await recordImportedProteins(proteinPlan(), {
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
      source: { text: 'Name,Sequence\nAlpha,MSTNPKPQR' },
    });

    expect(result).toMatchObject({ added: 1, failed: 0 });
    expect(result.reconciliationRequired).toEqual([
      expect.objectContaining({ artifactRelativePath: 'imported/Alpha-12345678.entity.json' }),
    ]);
    expect(result.members).toEqual([
      expect.objectContaining({
        entityId: 'protein-authoritative-id',
        artifactRelativePath: 'imported/Alpha-12345678.entity.json',
      }),
    ]);
    expect(mocks.persistImportSet).toHaveBeenCalledTimes(1);
    expect(mocks.gitCommitPaths).toHaveBeenCalledWith(
      '/ws',
      'Import 1 protein',
      expect.arrayContaining([
        'imported/Alpha-12345678.entity.json',
        '.waypoint/import-sets/1/manifest.json',
        '.waypoint/lims',
      ])
    );
  });

  it('does not replace an existing import-set manifest after a partial row failure', async () => {
    mocks.recordProtein
      .mockResolvedValueOnce({
        artifactPath: 'imported/Alpha-12345678.entity.json',
        artifactAbsolutePath: '/ws/imported/Alpha-12345678.entity.json',
        artifact: { id: 'protein-alpha', kind: 'protein' },
        limsEntity: { id: 'protein-alpha', kind: 'protein', name: 'Alpha', fields: {} },
        gitCommitted: false,
        created: true,
      })
      .mockRejectedValueOnce(new Error('temporary write failure'));

    const result = await recordImportedProteins(twoProteinPlan(), {
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
      source: { text: 'Name,Sequence\nAlpha,MSTNPKPQR\nBeta,MKQL' },
    });

    expect(result).toMatchObject({ added: 1, failed: 1, importSet: null });
    expect(mocks.persistImportSet).not.toHaveBeenCalled();
    expect(mocks.beginWorkflowAction).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith({
      selectedCount: 2,
      resultCount: 1,
      affectedCount: 1,
      status: 'needs_action',
    });
  });

  it('reports a whole import as one registry create instead of one per record', async () => {
    await recordImportedProteins(twoProteinPlan(), {
      workspaceRoot: '/ws',
      destinationDir: '/ws/imported',
    });
    expect(mocks.recordProtein).toHaveBeenCalledTimes(2);
    expect(mocks.recordProtein.mock.calls.every(([input]) => input.deferCommit === true)).toBe(
      true
    );
    expect(mocks.beginWorkflowAction).toHaveBeenCalledOnce();
    expect(mocks.beginWorkflowAction).toHaveBeenCalledWith({
      workflow: 'registry',
      action: 'create',
      workflowOrigin: 'direct',
    });
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith({
      selectedCount: 2,
      resultCount: 2,
      affectedCount: 2,
      status: 'created',
      outcomeKind: 'record_created',
    });
    expect(mocks.fail).not.toHaveBeenCalled();
  });
});
