import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { importFolderIntoWorkspaceRoot, importIntoManagedWorkspaceRepo } from './import';

describe('importFolderIntoWorkspaceRoot  D4)', () => {
  let db: Database.Database;
  let tmp: string;
  let managedRoot: string;
  let root: string;

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wp-folder-'));
    managedRoot = join(tmp, 'managed');
    const seed = join(tmp, 'seed-ws');
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, 'existing.gb'), 'LOCUS existing\n');
    const managed = await importIntoManagedWorkspaceRepo(seed, { db, managedRootDir: managedRoot });
    root = managed.repoPath;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function makeDropFolder(name: string): string {
    const dir = join(tmp, 'drops', name);
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'a.gb'), 'LOCUS a\n');
    writeFileSync(join(dir, 'nested', 'b.fasta'), '>b plasmid DNA\nACGT\n');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/x');
    return dir;
  }

  it('lands the folder as a subfolder, files intact, original untouched, committed', async () => {
    const drop = makeDropFolder('Laura Export');
    const res = await importFolderIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: drop },
      { db, managedRootDir: managedRoot }
    );
    expect(res.relPath).toBe('Laura Export');
    expect(readFileSync(join(root, 'Laura Export', 'a', 'a.gb'), 'utf8')).toContain('LOCUS a');
    expect(readFileSync(join(root, 'Laura Export', 'nested', 'b', 'b.gb'), 'utf8')).toContain(
      'LOCUS'
    );
    expect(readFileSync(join(drop, 'a.gb'), 'utf8')).toContain('LOCUS a');
    expect(readFileSync(join(root, 'existing', 'existing.gb'), 'utf8')).toContain('LOCUS existing');
    expect(res.committed).toBe(true);
  });

  it('does NOT copy .git noise into the workspace', async () => {
    const drop = makeDropFolder('Proj');
    await importFolderIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: drop },
      { db, managedRootDir: managedRoot }
    );
    expect(existsSync(join(root, 'Proj', '.git'))).toBe(false);
  });

  it('collision-safe subfolder name when one already exists', async () => {
    await importFolderIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: makeDropFolder('Dup') },
      { db, managedRootDir: managedRoot }
    );
    const res = await importFolderIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: makeDropFolder('Dup') },
      { db, managedRootDir: managedRoot }
    );
    expect(res.relPath).toBe('Dup (1)');
    expect(existsSync(join(root, 'Dup', 'a', 'a.gb'))).toBe(true);
    expect(existsSync(join(root, 'Dup (1)', 'a', 'a.gb'))).toBe(true);
  });

  it('rejects a target that is not a known workspace root', async () => {
    await expect(
      importFolderIntoWorkspaceRoot(
        { targetRoot: join(tmp, 'not-a-workspace'), sourcePath: makeDropFolder('X') },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow();
  });
});
