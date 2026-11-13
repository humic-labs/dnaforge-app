import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseSheetSyncSnapshot,
  readSheetSyncSnapshot,
  writeSheetSyncSnapshot,
  type SheetSyncConnection,
  type SheetSyncSnapshot,
} from './sheet-sync-connection';
const fs = vi.hoisted(() => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeWorkspaceTextFileAtomic: vi.fn(),
}));
vi.mock('../../platform', () => ({ platform: () => ({ fs }) }));
const files = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  fs.exists.mockImplementation(async (path: string) => files.has(path));
  fs.readTextFile.mockImplementation(async (path: string) => files.get(path));
  fs.writeWorkspaceTextFileAtomic.mockImplementation(
    async ({ path, content }: { path: string; content: string }) => {
      files.set(path, content);
    }
  );
});
const snapshot: SheetSyncSnapshot = {
  schema: 'dnaforge.sheet-sync-snapshot',
  schemaVersion: 1,
  sourceRevision: `sha256:${'a'.repeat(64)}`,
  rows: [
    {
      key: '001',
      record: { kind: 'strain', name: 'K12', fields: { notes: 'Chosen row' } },
      values: { ID: '001', Name: 'K12' },
      sourceRow: 2,
    },
  ],
};
describe('immutable pending spreadsheet payload', () => {
  it('writes only selected row payloads once and recovers the exact source-bound snapshot', async () => {
    const saved = await writeSheetSyncSnapshot({
      workspaceRoot: '/project',
      snapshot,
      mutationToken: 'lease',
    });
    await writeSheetSyncSnapshot({ workspaceRoot: '/project', snapshot, mutationToken: 'lease' });
    expect(fs.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(1);
    const pending: NonNullable<SheetSyncConnection['pending']> = {
      revision: snapshot.sourceRevision,
      snapshotHash: saved.hash,
      snapshotRelativePath: saved.relativePath,
      operation: { kind: 'create', rows: [{ owner: 'record', key: '001', entityId: 'strain-id' }] },
    };
    expect(await readSheetSyncSnapshot({ workspaceRoot: '/project', pending })).toEqual(snapshot);
    await expect(
      readSheetSyncSnapshot({
        workspaceRoot: '/project',
        pending: { ...pending, revision: `sha256:${'b'.repeat(64)}` },
      })
    ).rejects.toThrow('different source revision');
    files.set(`/project/${saved.relativePath}`, '{}');
    await expect(readSheetSyncSnapshot({ workspaceRoot: '/project', pending })).rejects.toThrow(
      'modified'
    );
    await expect(
      writeSheetSyncSnapshot({ workspaceRoot: '/project', snapshot, mutationToken: 'lease' })
    ).rejects.toThrow('modified');
  });
  it('rejects duplicate row identities and unrelated workbook payloads', () => {
    expect(() =>
      parseSheetSyncSnapshot(
        JSON.stringify({ ...snapshot, rows: [snapshot.rows[0], snapshot.rows[0]] })
      )
    ).toThrow('duplicated');
    expect(() =>
      parseSheetSyncSnapshot(JSON.stringify({ ...snapshot, wholeWorkbook: 'unselected tabs' }))
    ).toThrow();
  });
});
