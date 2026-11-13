import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerLimsEntityInDb } from '../lims';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../ipc/path-allowlist', () => ({
  assertSafePath: vi.fn(async (path: string) => path),
  withSafeWritablePaths: vi.fn(
    async <T>(
      requests: Array<{
        path: string;
      }>,
      operation: (paths: string[]) => Promise<T>
    ) => operation(requests.map((request) => request.path))
  ),
}));
let testDb: Database.Database;
vi.mock('../ipc/database', () => ({ getDb: () => testDb }));
const materializeSpy = vi.fn();
vi.mock('../lims-export-sync', () => ({
  materializeLimsGitExportForWorkspaceIds: (...args: unknown[]) => materializeSpy(...args),
}));
const hoisted = vi.hoisted(() => ({ forceThrow: null as Error | null }));
vi.mock('../workspace-relocate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-relocate')>();
  return {
    ...actual,
    relocateWorkspaceFileRefsInDb: (
      db: Database.Database,
      input: Parameters<typeof actual.relocateWorkspaceFileRefsInDb>[1]
    ) => {
      if (hoisted.forceThrow) throw hoisted.forceThrow;
      return actual.relocateWorkspaceFileRefsInDb(db, input);
    },
  };
});
import { createWorkspaceRelocationTestOwner } from './workspace-relocate-fixture';
let relinkMovedEntityFile: ReturnType<
  typeof createWorkspaceRelocationTestOwner
>['relinkMovedEntityFile'];
const HASH = (c: string) => `sha256:${c.repeat(64)}`;
const fileSeq = (relPath: string) => ({
  mode: 'file' as const,
  relPath,
  topology: 'circular' as const,
  length: 10,
  contentHash: HASH('a'),
  sourceFormat: 'gb' as const,
});
const seedCatalogFile = (db: Database.Database, path: string): void => {
  db.prepare(
    `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, created_at, updated_at)
     VALUES (?, 'file', ?, ?, 'file', 'active', 0, 0)`
  ).run(`ce-${path}`, path.split('/').pop(), `file://${path}`);
  db.prepare(
    `INSERT INTO catalog_entity_files (id, entity_id, workspace_id, path, file_kind, status, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'genbank', 'current', 0, 0)`
  ).run(`cf-${path}`, `ce-${path}`, path);
};
const seedIndexed = (db: Database.Database, path: string): number => {
  const fi = db
    .prepare(
      `INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (1, ?, ?, 'gb', 0)`
    )
    .run(path, path.split('/').pop());
  return Number(fi.lastInsertRowid);
};
const catalogPath = (db: Database.Database, seedKey: string) =>
  (
    db.prepare(`SELECT path FROM catalog_entity_files WHERE id=?`).get(`cf-${seedKey}`) as {
      path: string;
    }
  ).path;
const limsRelPath = (db: Database.Database, id: string) =>
  JSON.parse(
    (
      db.prepare(`SELECT fields FROM lims_entity WHERE id=?`).get(id) as {
        fields: string;
      }
    ).fields
  ).sequence.relPath as string;
describe('relinkMovedEntityFile — external (Finder / git mv / agent) move convergence', () => {
  let ws: string;
  let oldPath: string;
  let newPath: string;
  beforeEach(() => {
    hoisted.forceThrow = null;
    materializeSpy.mockClear();
    testDb = createTestDb();
    testDb.pragma('foreign_keys = ON');
    ensureSchema(testDb, ':memory:');
    ws = mkdtempSync(join(tmpdir(), 'reloc-ext-'));
    testDb.prepare(`INSERT INTO workspaces (id,name,path,created_at) VALUES (1,'W',?,0)`).run(ws);
    ({ relinkMovedEntityFile } = createWorkspaceRelocationTestOwner(testDb, ws));
    oldPath = join(ws, 'old.gb');
    newPath = join(ws, 'sub-moved.gb');

    writeFileSync(newPath, 'LOCUS moved\n//\n');
  });
  afterEach(() => {
    testDb.close();
  });
  it('rebases references to the plasmid INSIDE a moved package directory', async () => {
    const oldPkg = join(ws, 'pUC19');
    const newPkg = join(ws, 'plasmids', 'pUC19');
    const oldProduct = join(oldPkg, 'pUC19.gb');
    const newProduct = join(newPkg, 'pUC19.gb');
    const entity = registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'pUC19',
      fields: { sequence: fileSeq(oldProduct) },
    });
    seedCatalogFile(testDb, oldProduct);
    seedIndexed(testDb, oldProduct);
    mkdirSync(join(newPkg, '.forge'), { recursive: true });
    writeFileSync(newProduct, 'LOCUS pUC19\n//\n');
    writeFileSync(
      join(newPkg, '.forge', 'plasmid.json'),
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'pkg-1',
        name: 'pUC19',
        product: { file: 'pUC19.gb' },
      })
    );
    const result = await relinkMovedEntityFile({
      workspaceRoot: ws,
      oldPath: oldProduct,
      newPath: newProduct,
    });
    expect(result.newPath).toBe(newProduct);

    expect(result.counts.lims.rebasedEntityIds).toEqual([entity.id]);
    expect(limsRelPath(testDb, entity.id)).toBe(newProduct);
    expect(catalogPath(testDb, oldProduct)).toBe(newProduct);
  });
  it('rebases catalog + indexed + LIMS onto the new path WITHOUT moving the file (same entity id)', async () => {
    const p = registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    seedCatalogFile(testDb, oldPath);
    const fileId = seedIndexed(testDb, oldPath);
    materializeSpy.mockClear();
    const result = await relinkMovedEntityFile({ workspaceRoot: ws, oldPath, newPath });
    expect(result.newPath).toBe(newPath);
    expect(result.counts.lims.rebasedEntityIds).toEqual([p.id]);

    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(oldPath)).toBe(false);

    expect(catalogPath(testDb, oldPath)).toBe(newPath);
    expect(limsRelPath(testDb, p.id)).toBe(newPath);
    expect(
      (
        testDb.prepare(`SELECT path FROM indexed_files WHERE id=?`).get(fileId) as {
          path: string;
        }
      ).path
    ).toBe(newPath);
    expect(materializeSpy).toHaveBeenCalledTimes(1);
  });
  it('updates a path-derived typed entity name after an external rename', async () => {
    seedCatalogFile(testDb, oldPath);
    testDb
      .prepare(`UPDATE catalog_entities SET type = 'sequence' WHERE locator = ?`)
      .run(`file://${oldPath}`);
    await relinkMovedEntityFile({ workspaceRoot: ws, oldPath, newPath });
    expect(
      testDb.prepare(`SELECT name FROM catalog_entities WHERE locator = ?`).get(`file://${newPath}`)
    ).toEqual({ name: 'sub-moved.gb' });
  });
  it('preserves a human name after an external file rename', async () => {
    seedCatalogFile(testDb, oldPath);
    testDb
      .prepare(`UPDATE catalog_entities SET type = 'sequence', name = ? WHERE locator = ?`)
      .run('Reporter plasmid', `file://${oldPath}`);
    await relinkMovedEntityFile({ workspaceRoot: ws, oldPath, newPath });
    expect(
      testDb.prepare(`SELECT name FROM catalog_entities WHERE locator = ?`).get(`file://${newPath}`)
    ).toEqual({ name: 'Reporter plasmid' });
  });
  it('refuses when the destination does not exist (RELINK_TARGET_MISSING) — DB untouched', async () => {
    const p = registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    const gonePath = join(ws, 'not-there.gb');
    await expect(
      relinkMovedEntityFile({ workspaceRoot: ws, oldPath, newPath: gonePath })
    ).rejects.toThrow(/RELINK_TARGET_MISSING/);
    expect(limsRelPath(testDb, p.id)).toBe(oldPath);
  });
  it('refuses a COPY (oldPath still on disk) — RELINK_SOURCE_PRESENT, never a mis-link', async () => {
    const p = registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    writeFileSync(oldPath, 'LOCUS still-here\n//\n');
    await expect(relinkMovedEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /RELINK_SOURCE_PRESENT/
    );
    expect(limsRelPath(testDb, p.id)).toBe(oldPath);
  });
  it('rejects when a genuinely DIFFERENT entity already occupies the destination (catalog conflict)', async () => {
    const p = registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'a',
      fields: { sequence: fileSeq(oldPath) },
    });
    seedCatalogFile(testDb, oldPath);
    seedCatalogFile(testDb, newPath);
    await expect(relinkMovedEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /RELOCATE_CATALOG_CONFLICT/
    );
    expect(limsRelPath(testDb, p.id)).toBe(oldPath);
  });
  it('on a post-preflight rebase failure it does NOT move the user’s file back (no reverse move)', async () => {
    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    seedCatalogFile(testDb, oldPath);
    hoisted.forceThrow = new Error('boom in the rebase txn');
    await expect(relinkMovedEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /boom in the rebase txn/
    );

    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(oldPath)).toBe(false);

    expect(catalogPath(testDb, oldPath)).toBe(oldPath);
  });
});
