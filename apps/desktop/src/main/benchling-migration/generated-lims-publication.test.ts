import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { publishActionLimsExport, verifiedActionLimsPaths } from './generated-lims-publication';
import { benchlingMigrationActionJournalRelativePath } from './action-journal';
import { withUnavailableWindowsDirectoryHandles } from './__fixtures__/windows-directory-handles';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = { ...actual, open: vi.fn(actual.open) };
  return { ...wrapped, default: wrapped };
});

describe('action-owned generated LIMS exports', () => {
  let root: string;
  let db: ReturnType<typeof createTestDb>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'migration-lims-publication-'));
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id,name,path,repo_uuid,created_at,last_opened_at) VALUES (1,'Test',?,NULL,0,0)`
    ).run(root);
  });
  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('flushes generated files and retries unchanged on Windows without opening directory handles', async () => {
    await withUnavailableWindowsDirectoryHandles(async (counts) => {
      const request = { db, workspacePath: root, workspaceDbId: 1, actionId: 'windows-action' };
      await publishActionLimsExport(request);
      const paths = await verifiedActionLimsPaths(root, request.actionId);
      expect(paths).toEqual(['.waypoint/lims/manifest.json', '.waypoint/lims/sheets/oligos.csv']);
      const before = await Promise.all(paths.map((path) => readFile(join(root, path))));
      expect(counts.directoryOpens).toBe(0);
      expect(counts.fileSyncs).toBe(paths.length + 1);
      await publishActionLimsExport(request);
      expect(await Promise.all(paths.map((path) => readFile(join(root, path))))).toEqual(before);
      expect(counts.fileSyncs).toBe(paths.length + 1);
    });
  });

  it('journals only generated files and leaves other files in the same directory untouched', async () => {
    await mkdir(join(root, '.waypoint/lims'), { recursive: true });
    await writeFile(join(root, '.waypoint/lims/my-notes.txt'), 'keep my notes');
    await publishActionLimsExport({
      db,
      workspacePath: root,
      workspaceDbId: 1,
      actionId: 'test-action',
    });
    expect(await verifiedActionLimsPaths(root, 'test-action')).toEqual([
      '.waypoint/lims/manifest.json',
      '.waypoint/lims/sheets/oligos.csv',
    ]);
    await expect(readFile(join(root, '.waypoint/lims/my-notes.txt'), 'utf8')).resolves.toBe(
      'keep my notes'
    );
    await expect(
      publishActionLimsExport({
        db,
        workspacePath: root,
        workspaceDbId: 1,
        actionId: 'test-action',
      })
    ).resolves.toBeUndefined();
  });

  it('preserves an edit made after installation and refuses both retry and commit proof', async () => {
    await publishActionLimsExport({
      db,
      workspacePath: root,
      workspaceDbId: 1,
      actionId: 'test-action',
    });
    const csv = join(root, '.waypoint/lims/sheets/oligos.csv');
    await writeFile(csv, 'a later local edit');
    await expect(
      publishActionLimsExport({
        db,
        workspacePath: root,
        workspaceDbId: 1,
        actionId: 'test-action',
      })
    ).rejects.toThrow(/changed after reservation/);
    await expect(verifiedActionLimsPaths(root, 'test-action')).rejects.toThrow(
      /changed before publication/
    );
    await expect(readFile(csv, 'utf8')).resolves.toBe('a later local edit');
  });

  it('rejects a publication ledger that drops the required generated files', async () => {
    await publishActionLimsExport({
      db,
      workspacePath: root,
      workspaceDbId: 1,
      actionId: 'test-action',
    });
    const ledger = join(root, `${benchlingMigrationActionJournalRelativePath('test-action')}.lims`);
    await writeFile(
      ledger,
      JSON.stringify({
        schema: 'dnaforge.migration-lims-publication.v1',
        actionId: 'test-action',
        files: [],
      })
    );
    await expect(verifiedActionLimsPaths(root, 'test-action')).rejects.toThrow(/required/);
  });
});
