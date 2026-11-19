import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { convertTreeToPlasmidPackages } from './convert-tree-to-packages';
import { preservedFastaMarkerPath } from '../../shared/preserved-fasta';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

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
import { readFileAtHead, resolveHeadCommit } from './index';
import { convertTreeToMolecularPackages } from './coordinate-package-import';
import { resolveImportedCoordinate } from '../imported-coordinate-location';
import { readMolecularDocumentFile } from '../molecular-document-library';
import { MOLECULAR_DOCUMENT_FILE_KIND } from '../../shared/molecular-document';
import { MOLECULAR_MIGRATION_DIRECTORY } from './molecular-migration-journal';

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

  it('returns stable molecular documents from both preview import destinations and retains the exact input', async () => {
    const original =
      'HEADER    SAMPLE\r\nATOM      1  CA  ALA A   1      11.104  13.207   2.100  1.00 20.00           C\r\nEND\r\n';
    const sourcePath = loose('model.pdb', original);
    const expectedSourceSha256 = createHash('sha256').update(original).digest('hex');
    const request = { sourcePath, expectedSourceSha256, preserveOriginal: true as const };
    const deps = { db, managedRootDir: managedRoot };
    const project = await importFileAsNewManagedWorkspace(request, deps);
    writeFileSync(join(project.repoPath, '.gitignore'), MOLECULAR_MIGRATION_DIRECTORY + '/\n');
    const second = await importFileIntoWorkspaceRoot(
      { ...request, targetRoot: project.repoPath },
      deps
    );
    expect(project.entryPath).toBe(join(project.repoPath, 'model.dnaforge-molecular.json'));
    expect(second.destPath).toBe(join(project.repoPath, 'model 2.dnaforge-molecular.json'));
    expect(
      (await convertTreeToMolecularPackages(project.repoPath, { removeSource: unlink })).converted
    ).toBe(0);
    const ids = new Set<string>();
    for (const path of [project.entryPath!, second.destPath]) {
      const { document } = await readMolecularDocumentFile({
        workspaceRoot: project.repoPath,
        path,
      });
      ids.add(document.id);
      expect(document.history[0].snapshot.coordinates.text).toBe(original);
    }
    expect(ids.size).toBe(2);
    const ledger = join(project.repoPath, MOLECULAR_MIGRATION_DIRECTORY);
    const [source] = await readdir(ledger);
    const attempts = (await readdir(join(ledger, source))).filter((name) =>
      name.startsWith('attempt-')
    );
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      const archived = join(ledger, source, attempt, 'original');
      expect(readFileSync(archived, 'utf8')).toBe(original);
      expect(
        (
          await readFileAtHead(
            project.repoPath,
            relative(project.repoPath, archived).split('\\').join('/')
          )
        ).toString('utf8')
      ).toBe(original);
    }
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);
    expect(existsSync(join(project.repoPath, 'model.pdb'))).toBe(false);
  });

  it('recovers a previous loose-path tab by its completed conversion and current project binding', async () => {
    const project = await importFileAsNewManagedWorkspace(loose('notes.txt', 'Notes'), {
      db,
      managedRootDir: managedRoot,
    });
    const root = project.repoPath;
    const path = join(root, 'model.pdb');
    const location = { workspaceRoot: root, path };
    writeFileSync(join(root, 'model.dnaforge-molecular.json'), 'Occupied');
    const original =
      'HEADER    EARLIER\nATOM      1  CA  ALA A   1      11.104  13.207   2.100  1.00 20.00           C\nEND\n';
    writeFileSync(path, original);
    expect(await resolveImportedCoordinate(db, location)).toBeNull();
    await convertTreeToMolecularPackages(root, { removeSource: unlink });
    const first = { workspaceRoot: root, path: join(root, 'model 2.dnaforge-molecular.json') };
    expect(await resolveImportedCoordinate(db, location)).toEqual(first);
    expect(
      await resolveImportedCoordinate(db, { ...location, expectedSourceSha256: 'f'.repeat(64) })
    ).toBeNull();
    writeFileSync(path, original.replace('EARLIER', 'LATER'));
    await expect(resolveImportedCoordinate(db, location)).rejects.toThrow(
      'occupies the original path'
    );
    await convertTreeToMolecularPackages(root, { removeSource: unlink });
    expect(await resolveImportedCoordinate(db, location)).toBeNull();
    const pinned = {
      ...location,
      expectedSourceSha256: createHash('sha256').update(original).digest('hex'),
    };
    expect(await resolveImportedCoordinate(db, pinned)).toEqual(first);
    const { document } = await readMolecularDocumentFile(first);
    const moved = { ...first, path: join(root, 'renamed.dnaforge-molecular.json') };
    await rename(first.path, moved.path);
    expect(await resolveImportedCoordinate(db, pinned)).toBeNull();
    const owner = db.prepare('SELECT id FROM workspaces WHERE path=?').get(root) as { id: number };
    const entityId = project.workspaceUuid + '::' + document.id;
    db.prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
      VALUES(?,'molecular-document','Model',?,'file',?,1,1)`
    ).run(entityId, 'entity://molecular-document/' + entityId, owner.id);
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
      VALUES('binding',?,?,?,?,'current',1,1)`
    ).run(entityId, owner.id, moved.path, MOLECULAR_DOCUMENT_FILE_KIND);
    expect(await resolveImportedCoordinate(db, pinned)).toEqual(moved);
    writeFileSync(moved.path, readFileSync(join(root, 'model 3.dnaforge-molecular.json')));
    expect(await resolveImportedCoordinate(db, pinned)).toBeNull();
  });

  it('rejects a directory (that path is importIntoManagedWorkspaceRepo)', async () => {
    const dir = join(tmp, 'a-folder');
    mkdirSync(dir, { recursive: true });
    await expect(
      importFileAsNewManagedWorkspace(dir, { db, managedRootDir: managedRoot })
    ).rejects.toThrow();
  });
});
