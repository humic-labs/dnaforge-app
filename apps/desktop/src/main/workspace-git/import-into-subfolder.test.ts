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
import { importFileIntoWorkspaceRoot, importIntoManagedWorkspaceRepo } from './import';
import { resolveHeadCommit } from './index';

describe('import into a managed-repo subfolder ', () => {
  let db: Database.Database;
  let tmp: string;
  let managedRoot: string;
  let repoPath: string;

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wp-subfolder-'));
    managedRoot = join(tmp, 'managed');
    const seed = join(tmp, 'seed');
    mkdirSync(join(seed, 'plasmids'), { recursive: true });
    writeFileSync(join(seed, 'plasmids', '.keep'), '');
    const managed = await importIntoManagedWorkspaceRepo(seed, { db, managedRootDir: managedRoot });
    repoPath = managed.repoPath;
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function loose(name: string, content: string): string {
    const dir = mkdtempSync(join(tmp, 'src-'));
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  it('copies the file into the subfolder AND commits (repo root resolved from the marker)', async () => {
    const subfolder = join(repoPath, 'plasmids');
    expect(existsSync(subfolder)).toBe(true);
    const before = await resolveHeadCommit(repoPath);

    const src = loose('pUC19.gb', 'LOCUS pUC19 2686 bp\n');
    const res = await importFileIntoWorkspaceRoot(
      { targetRoot: subfolder, sourcePath: src },
      { db, managedRootDir: managedRoot }
    );

    expect(existsSync(join(subfolder, 'pUC19', 'pUC19.gb'))).toBe(true);
    expect(existsSync(join(subfolder, 'pUC19', '.forge', 'plasmid.json'))).toBe(true);
    expect(readFileSync(join(subfolder, 'pUC19', 'pUC19.gb'), 'utf8')).toContain('LOCUS pUC19');
    expect(res.committed).toBe(true);
    expect(await resolveHeadCommit(repoPath)).not.toBe(before);
  });
});
