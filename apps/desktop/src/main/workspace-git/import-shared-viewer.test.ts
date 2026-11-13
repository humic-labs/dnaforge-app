import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  importContentIntoWorkspaceRoot,
  importFileIntoWorkspaceRoot,
  importFolderIntoWorkspaceRoot,
  importIntoManagedWorkspaceRepo,
  importSequenceContentIntoWorkspaceRoot,
} from './import';
import { resolveHeadCommit } from './index';

const CONTENT = '>new-sequence\nACGTACGTACGTACGT\n';

describe('shared viewer content import authority', () => {
  let db: Database.Database;
  let root: string;
  let managedRootDir: string;
  let repoPath: string;
  let sourcePath: string;

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    root = mkdtempSync(join(tmpdir(), 'fixture-viewer-import-'));
    managedRootDir = join(root, 'managed');
    const seed = join(root, 'seed');
    mkdirSync(join(seed, 'sequences'), { recursive: true });
    writeFileSync(join(seed, 'sequences', '.keep'), '');
    const imported = await importIntoManagedWorkspaceRepo(seed, { db, managedRootDir });
    repoPath = imported.repoPath;
    sourcePath = join(root, 'new.fna');
    writeFileSync(sourcePath, CONTENT);
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
      enabled, access_role, access_source, shared_with_others, created_at, updated_at
    ) SELECT id, repo_uuid, 'viewer-account', 'shared-remote', 1, 'viewer', 'direct', 1, 1, 1
      FROM workspaces WHERE path = ?`
    ).run(repoPath);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { kind: 'file', enabled: 1, nested: false },
    { kind: 'file', enabled: 0, nested: true },
    { kind: 'content', enabled: 1, nested: true },
    { kind: 'content', enabled: 0, nested: false },
  ])(
    'refuses $kind import with sync=$enabled before any write',
    async ({ kind, enabled, nested }) => {
      db.prepare('UPDATE workspace_sync_bindings SET enabled = ?').run(enabled);
      const targetRoot = nested ? join(repoPath, 'sequences') : repoPath;
      const beforeHead = await resolveHeadCommit(repoPath);
      const beforeFiles = readdirSync(targetRoot);
      const beforeCatalog = db.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get();
      const operation =
        kind === 'file'
          ? importFileIntoWorkspaceRoot({ sourcePath, targetRoot }, { db, managedRootDir })
          : importContentIntoWorkspaceRoot(
              { targetRoot, fileName: 'new.fna', content: CONTENT },
              { db, managedRootDir }
            );
      await expect(operation).rejects.toThrow(/shared project is view only/i);
      expect(await resolveHeadCommit(repoPath)).toBe(beforeHead);
      expect(readdirSync(targetRoot)).toEqual(beforeFiles);
      expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get()).toEqual(
        beforeCatalog
      );
      expect(existsSync(sourcePath)).toBe(true);
    }
  );

  it('resolves an aliased destination to the actual viewer project', async () => {
    const alias = join(root, 'viewer-alias');
    symlinkSync(repoPath, alias);
    await expect(
      importFileIntoWorkspaceRoot(
        { sourcePath, targetRoot: join(alias, 'sequences') },
        { db, managedRootDir }
      )
    ).rejects.toThrow(/shared project is view only/i);
  });

  it('returns a precise side-effect-free native sequence refusal', async () => {
    const beforeHead = await resolveHeadCommit(repoPath);
    const beforeFiles = readdirSync(repoPath);
    await expect(
      importSequenceContentIntoWorkspaceRoot(
        {
          targetRoot: repoPath,
          relativePath: 'new.fna',
          content: CONTENT,
          collisionPolicy: 'refuse',
        },
        { db, managedRootDir }
      )
    ).resolves.toMatchObject({
      kind: 'refused',
      code: 'IMPORT_INVALID_DESTINATION',
      stateChanged: false,
      error: expect.stringMatching(/shared project is view only/i),
    });
    expect(await resolveHeadCommit(repoPath)).toBe(beforeHead);
    expect(readdirSync(repoPath)).toEqual(beforeFiles);
  });

  it.each(['editor', 'manager', 'owner'])(
    'allows a current %s without requiring an online request',
    async (role) => {
      db.prepare('UPDATE workspace_sync_bindings SET access_role = ?').run(role);
      const result = await importFileIntoWorkspaceRoot(
        { sourcePath, targetRoot: repoPath },
        { db, managedRootDir }
      );
      expect(result.committed).toBe(true);
      expect(existsSync(result.destPath)).toBe(true);
    }
  );

  it('refuses a folder import before copying or committing its contents', async () => {
    const folder = join(root, 'incoming-folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.txt'), 'incoming content');
    const beforeHead = await resolveHeadCommit(repoPath);
    const beforeFiles = readdirSync(repoPath);
    await expect(
      importFolderIntoWorkspaceRoot(
        { sourcePath: folder, targetRoot: repoPath },
        { db, managedRootDir }
      )
    ).rejects.toThrow(/shared project is view only/i);
    expect(await resolveHeadCommit(repoPath)).toBe(beforeHead);
    expect(readdirSync(repoPath)).toEqual(beforeFiles);
  });

  it('reads the current grant again after a viewer is promoted', async () => {
    await expect(
      importFileIntoWorkspaceRoot({ sourcePath, targetRoot: repoPath }, { db, managedRootDir })
    ).rejects.toThrow(/shared project is view only/i);
    db.prepare("UPDATE workspace_sync_bindings SET access_role = 'editor'").run();
    const result = await importFileIntoWorkspaceRoot(
      { sourcePath, targetRoot: repoPath },
      { db, managedRootDir }
    );
    expect(result.committed).toBe(true);
  });

  it('preserves writes to an unrelated private project', async () => {
    const seed = join(root, 'other-seed');
    mkdirSync(seed);
    writeFileSync(join(seed, 'notes.txt'), 'private project');
    const other = await importIntoManagedWorkspaceRepo(seed, { db, managedRootDir });
    const result = await importFileIntoWorkspaceRoot(
      { sourcePath, targetRoot: other.repoPath },
      { db, managedRootDir }
    );
    expect(result.committed).toBe(true);
  });

  it('ignores an old viewer binding after the project UUID is replaced', async () => {
    db.prepare("UPDATE workspaces SET repo_uuid = 'replacement-project' WHERE path = ?").run(
      repoPath
    );
    const result = await importFileIntoWorkspaceRoot(
      { sourcePath, targetRoot: repoPath },
      { db, managedRootDir }
    );
    expect(result.committed).toBe(true);
  });
});
