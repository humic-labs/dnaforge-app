import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPrimerArtifact, serializePrimerArtifact } from '../primers/public/primer-artifact';
import {
  createSheetSyncArtifact,
  sheetSyncEntityRecord,
  updateSheetSyncPrimer,
} from './sheet-sync-artifacts';
import type { SheetSyncConnection, SheetSyncSnapshot } from './sheet-sync-connection';
import type { SheetSyncCheckpoint } from './sheet-sync';
const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  readPrimer: vi.fn(),
  reconcilePrimer: vi.fn(),
  updatePrimer: vi.fn(),
  recordPrimers: vi.fn(),
  query: vi.fn(),
  reconcileWorkspace: vi.fn(),
}));
vi.mock('../../db/workspace-catalog', () => ({ resolveWorkspaceId: vi.fn(async () => 1) }));
vi.mock('../../platform', () => ({
  platform: () => ({ fs: { exists: mocks.exists, readTextFile: mocks.readTextFile } }),
}));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: async (
    _root: string,
    operation: (token: string) => Promise<unknown>
  ) => operation('owner-lease'),
}));
vi.mock('../../services/workspace-operations', () => ({
  reconcileWorkspaceAfterFilesChanged: mocks.reconcileWorkspace,
}));
vi.mock('../primers/primer-artifact-service', () => ({
  readPrimerArtifactAtPath: mocks.readPrimer,
  reconcilePrimerArtifact: mocks.reconcilePrimer,
  updatePrimerArtifactContent: mocks.updatePrimer,
}));
vi.mock('../primers/record-primers', () => ({ recordPrimers: mocks.recordPrimers }));
vi.mock('../proteins/record-proteins', () => ({ recordProtein: vi.fn() }));
vi.mock('./record-entity-artifact', () => ({ recordEntityArtifact: vi.fn() }));
vi.mock('./operations', () => ({ queryLimsEntities: mocks.query }));
const bases = 'GTAAAACGACGGCCAGT';
const sequence = {
  mode: 'inline',
  bases,
  topology: 'linear',
  length: bases.length,
  contentHash: 'source-hash',
};
const record = { kind: 'oligo', name: 'Primer', fields: { sequence }, oligoNotation: bases };
const row: SheetSyncSnapshot['rows'][number] = {
  key: '001',
  record,
  values: { Name: 'Primer', Sequence: bases },
  sourceRow: 2,
};
const checkpoint: SheetSyncCheckpoint = {
  key: '001',
  entityId: 'sheet-id',
  artifactRelativePath: 'primers/one.primer.json',
  source: record,
  applied: record,
};
const connection: SheetSyncConnection = {
  schema: 'dnaforge.sheet-sync',
  schemaVersion: 1,
  id: 'd788e456-ebdf-4672-818c-d5e6a1ff99b4',
  importSetId: 'import-set',
  source: {
    path: '/master.xlsx',
    sheetName: 'Primers',
    keyColumn: 'ID',
    forcedKind: 'oligo',
    columnMappings: [],
  },
  destinationRelativePath: '',
  revision: `sha256:${'a'.repeat(64)}`,
  enabled: true,
  pending: null,
  finalization: null,
  checkpoints: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.exists.mockResolvedValue(false);
  mocks.query.mockResolvedValue([{ id: 'sheet-id', tombstone: false, archivedAt: null }]);
});
async function artifact() {
  return buildPrimerArtifact({
    id: 'sheet-id',
    catalogNumber: 'PR-000001',
    name: 'Primer',
    sequence: bases,
    workspaceRoot: '/project',
    artifactPath: '/project/primers/one.primer.json',
    actor: 'test',
    source: 'manual',
    notes: 'Unmapped local note',
  });
}
describe('spreadsheet native artifact ownership', () => {
  it('compares only mapped fields and reads chemistry from the Registry projection', () => {
    expect(
      sheetSyncEntityRecord(
        {
          kind: 'oligo',
          name: 'Primer',
          fields: { sequence, notes: 'Unmapped', oligo: { notation: `/5Phos/${bases}` } },
        },
        record
      )
    ).toEqual({ ...record, oligoNotation: `/5Phos/${bases}` });
  });
  it('passes the pending durable ID and existing owner lease through oligo creation', async () => {
    const value = await artifact();
    mocks.query.mockResolvedValue([]);
    mocks.recordPrimers.mockResolvedValue({
      recorded: [
        { artifact: value, limsEntity: { kind: 'oligo', name: 'Primer', fields: { sequence } } },
      ],
      failed: [],
      skipped: [],
    });
    const result = await createSheetSyncArtifact({
      workspaceRoot: '/project',
      connection,
      row,
      intent: {
        owner: 'primer',
        key: '001',
        entityId: 'sheet-id',
        artifactRelativePath: checkpoint.artifactRelativePath,
      },
    });
    expect(result.entityId).toBe('sheet-id');
    expect(mocks.recordPrimers).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationToken: 'owner-lease',
        primers: [
          expect.objectContaining({
            artifactId: 'sheet-id',
            artifactPath: '/project/primers/one.primer.json',
          }),
        ],
      })
    );
  });
  it('rejects a pending identity owned by another project before creating any file', async () => {
    mocks.query.mockResolvedValue([{ id: 'sheet-id', workspaceId: 99, fields: {} }]);
    await expect(
      createSheetSyncArtifact({
        workspaceRoot: '/project',
        connection,
        row,
        intent: {
          owner: 'primer',
          key: '001',
          entityId: 'sheet-id',
          artifactRelativePath: checkpoint.artifactRelativePath,
        },
      })
    ).rejects.toThrow('another project');
    expect(mocks.recordPrimers).not.toHaveBeenCalled();
    expect(mocks.exists).not.toHaveBeenCalled();
  });

  it('rejects a foreign identity at the pending path before projection recovery', async () => {
    const value = await artifact();
    mocks.exists.mockResolvedValue(true);
    mocks.query.mockResolvedValue([]);
    mocks.readPrimer.mockResolvedValue({ artifact: { ...value, id: 'foreign-id' } });
    await expect(
      createSheetSyncArtifact({
        workspaceRoot: '/project',
        connection,
        row,
        intent: {
          owner: 'primer',
          key: '001',
          entityId: 'sheet-id',
          artifactRelativePath: checkpoint.artifactRelativePath,
        },
      })
    ).rejects.toThrow('different oligo');
    expect(mocks.reconcilePrimer).not.toHaveBeenCalled();
  });
  it('preserves an unmapped local note and propagates the lease while changing chemistry', async () => {
    const value = await artifact();
    mocks.readPrimer.mockResolvedValue({ artifact: value });
    const modified = { ...row, record: { ...record, oligoNotation: `/5Phos/${bases}` } };
    mocks.updatePrimer.mockResolvedValue({
      limsEntity: {
        kind: 'oligo',
        name: 'Primer',
        fields: { sequence, oligo: { notation: modified.record.oligoNotation } },
      },
    });
    await updateSheetSyncPrimer({
      workspaceRoot: '/project',
      row: modified,
      checkpoint,
      pending: {
        kind: 'update-primer',
        key: '001',
        entityId: 'sheet-id',
        artifactRelativePath: checkpoint.artifactRelativePath,
        priorContent: serializePrimerArtifact(value),
      },
    });
    expect(mocks.updatePrimer).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: 'Unmapped local note',
        mutationToken: 'owner-lease',
        oligo: expect.objectContaining({ notation: modified.record.oligoNotation }),
      })
    );
  });
  it('does not restore or overwrite an archived spreadsheet target', async () => {
    const value = await artifact();
    mocks.query.mockResolvedValue([{ id: 'sheet-id', tombstone: true, archivedAt: 10 }]);
    await expect(
      updateSheetSyncPrimer({
        workspaceRoot: '/project',
        row,
        checkpoint,
        pending: {
          kind: 'update-primer',
          key: '001',
          entityId: 'sheet-id',
          artifactRelativePath: checkpoint.artifactRelativePath,
          priorContent: serializePrimerArtifact(value),
        },
      })
    ).rejects.toThrow('missing or archived');
    expect(mocks.updatePrimer).not.toHaveBeenCalled();
    expect(mocks.reconcilePrimer).not.toHaveBeenCalled();
  });
});
