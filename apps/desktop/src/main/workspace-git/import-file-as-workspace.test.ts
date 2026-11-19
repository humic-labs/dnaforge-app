import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { convertTreeToPlasmidPackages } from './convert-tree-to-packages';
import { preservedFastaMarkerPath } from '../../shared/preserved-fasta';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  importFileAsNewManagedWorkspace,
  importFileIntoWorkspaceRoot,
  MANAGED_WORKSPACE_MARKER,
} from './import';
import { resolveHeadCommit } from './index';

describe('importFileAsNewManagedWorkspace ', () => {
  let db: Database.Database;
  let tmp: string;
  let managedRoot: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wp-file-ws-'));
    managedRoot = join(tmp, 'managed');
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function loose(name: string, content: string): string {
    const dir = mkdtempSync(join(tmp, 'src-'));
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  it('creates a managed workspace containing the single file, committed, named after the file', async () => {
    const src = loose('pUC19.gb', 'LOCUS pUC19 2686 bp\n');
    const res = await importFileAsNewManagedWorkspace(src, { db, managedRootDir: managedRoot });

    expect(existsSync(join(res.repoPath, 'pUC19', 'pUC19.gb'))).toBe(true);
    expect(existsSync(join(res.repoPath, 'pUC19', '.forge', 'plasmid.json'))).toBe(true);
    expect(readFileSync(join(res.repoPath, 'pUC19', 'pUC19.gb'), 'utf8')).toContain('LOCUS pUC19');
    expect(existsSync(join(res.repoPath, MANAGED_WORKSPACE_MARKER))).toBe(true);
    expect(res.displayName).toBe('pUC19');
    expect(res.entryPath).toBe(join(res.repoPath, 'pUC19', 'pUC19.gb'));
    expect(await resolveHeadCommit(res.repoPath)).toMatch(/^[0-9a-f]{40}$/);

    const row = db
      .prepare('SELECT name, path, repo_uuid FROM workspaces WHERE path = ?')
      .get(res.repoPath) as { name: string; path: string; repo_uuid: string | null } | undefined;
    expect(row?.repo_uuid).toBeTruthy();
    expect(row?.name).toBe('pUC19');
  });

  it('leaves the original source file untouched', async () => {
    const src = loose('reads.fastq', '@x\nACGT\n+\n!!!!\n');
    await importFileAsNewManagedWorkspace(src, { db, managedRootDir: managedRoot });
    expect(readFileSync(src, 'utf8')).toBe('@x\nACGT\n+\n!!!!\n');
  });

  it('preserves duplicate records and original bytes in new and existing projects across conversion scans', async () => {
    const bytes =
      '>dup DNA\r\n' + 'ACGT'.repeat(35) + '\r\n>dup another DNA\r\n' + 'TGCA'.repeat(40) + '\r\n';
    const src = loose('reads.fa', bytes);
    const request = {
      sourcePath: src,
      expectedSourceSha256: createHash('sha256').update(bytes).digest('hex'),
      preserveOriginal: true as const,
    };
    const deps = { db, managedRootDir: managedRoot };
    const project = await importFileAsNewManagedWorkspace(request, deps);
    const copy = await importFileIntoWorkspaceRoot(
      { ...request, targetRoot: project.repoPath },
      deps
    );
    expect(copy.relPath).toBe('reads (1).fa');
    expect((await convertTreeToPlasmidPackages(project.repoPath)).converted).toBe(0);
    for (const path of [project.entryPath!, copy.destPath]) {
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(readFileSync(await preservedFastaMarkerPath(path), 'utf8').trim()).toBe(
        request.expectedSourceSha256
      );
    }
    expect(readFileSync(src, 'utf8')).toBe(bytes);
  });

  it('rejects changed preview bytes without publishing a new project or leaving its files', async () => {
    const src = loose('changed.faa', '>name\nPEPTIDE\n');
    await expect(
      importFileAsNewManagedWorkspace(
        { sourcePath: src, expectedSourceSha256: 'f'.repeat(64), preserveOriginal: true },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow('changed after preview');
    expect(await readdir(managedRoot)).toEqual([]);
    expect(db.prepare('SELECT name FROM workspaces').all()).toEqual([]);
  });

  it('rejects a directory (that path is importIntoManagedWorkspaceRepo)', async () => {
    const dir = join(tmp, 'a-folder');
    mkdirSync(dir, { recursive: true });
    await expect(
      importFileAsNewManagedWorkspace(dir, { db, managedRootDir: managedRoot })
    ).rejects.toThrow();
  });
});
