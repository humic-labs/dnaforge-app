import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerLimsEntityInDb } from '../lims';
import { assertLimsProjectionReplayParityInDb } from '../lims-projection-rebuild';
import { relocateWorkspaceFileRefsInDb } from '../workspace-relocate';

const HASH = (c: string) => `sha256:${c.repeat(64)}`;
const fileSeq = (relPath: string) => ({
  mode: 'file' as const,
  relPath,
  topology: 'circular' as const,
  length: 10,
  contentHash: HASH('a'),
  sourceFormat: 'gb' as const,
});

function seedCatalogFile(db: Database.Database, path: string): void {
  db.prepare(
    `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, created_at, updated_at)
     VALUES (?, 'file', ?, ?, 'file', 'active', 0, 0)`
  ).run(`ce-${path}`, path.split('/').pop(), `file://${path}`);
  db.prepare(
    `INSERT INTO catalog_entity_files (id, entity_id, workspace_id, path, file_kind, status, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'genbank', 'current', 0, 0)`
  ).run(`cf-${path}`, `ce-${path}`, path);
}
function seedIndexedWithBinding(
  db: Database.Database,
  path: string
): { fileId: number; seqId: number } {
  const fi = db
    .prepare(
      `INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (1, ?, ?, 'gb', 0)`
    )
    .run(path, path.split('/').pop());
  const fileId = Number(fi.lastInsertRowid);
  const si = db
    .prepare(`INSERT INTO sequences (file_id, name, length) VALUES (?, 'S', 10)`)
    .run(fileId);
  const seqId = Number(si.lastInsertRowid);
  db.prepare(
    `INSERT INTO primers (id, name, sequence, length, created_at, updated_at) VALUES ('P','P','ACGT',4,0,0)`
  ).run();
  db.prepare(
    `INSERT INTO primer_bindings (id, primer_id, sequence_id, binding_start, binding_end, strand, created_at, updated_at)
     VALUES ('bnd','P',?,10,30,1,0,0)`
  ).run(seqId);
  return { fileId, seqId };
}
const catalogPath = (db: Database.Database, oldPath: string) =>
  (
    db.prepare(`SELECT path FROM catalog_entity_files WHERE id=?`).get(`cf-${oldPath}`) as {
      path: string;
    }
  ).path;
const indexedPathById = (db: Database.Database, id: number) =>
  (db.prepare(`SELECT path FROM indexed_files WHERE id=?`).get(id) as { path: string } | undefined)
    ?.path;
const limsRelPath = (db: Database.Database, id: string) =>
  JSON.parse(
    (db.prepare(`SELECT fields FROM lims_entity WHERE id=?`).get(id) as { fields: string }).fields
  ).sequence.relPath as string;
const updatedAuditCount = (db: Database.Database) =>
  (
    db.prepare(`SELECT COUNT(*) n FROM lims_audit WHERE event_type='entity_updated'`).get() as {
      n: number;
    }
  ).n;

describe('relocateWorkspaceFileRefsInDb — one atomic transaction', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    db.pragma('foreign_keys = ON');
    ensureSchema(db, ':memory:');
    db.prepare(`INSERT INTO workspaces (id,name,path,created_at) VALUES (1,'W','/w',0)`).run();
  });

  it('(a) a single-file move rebases catalog + indexed + LIMS together; the primer binding follows the sequence id', () => {
    const p = registerLimsEntityInDb(db, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq('/w/old.gb') },
    });
    seedCatalogFile(db, '/w/old.gb');
    const { fileId, seqId } = seedIndexedWithBinding(db, '/w/old.gb');

    const counts = db.transaction(() =>
      relocateWorkspaceFileRefsInDb(db, {
        workspaceRoot: '/w',
        oldPath: '/w/old.gb',
        newPath: '/w/new.gb',
      })
    )();
    expect(counts.catalog.updated).toBe(1);
    expect(counts.indexed.indexedFilesMoved).toBe(1);
    expect(counts.lims.rebasedEntityIds).toEqual([p.id]);

    expect(catalogPath(db, '/w/old.gb')).toBe('/w/new.gb');
    expect(indexedPathById(db, fileId)).toBe('/w/new.gb');
    expect(limsRelPath(db, p.id)).toBe('/w/new.gb');

    expect(db.prepare(`SELECT sequence_id FROM primer_bindings WHERE id='bnd'`).get()).toEqual({
      sequence_id: seqId,
    });
    expect((db.prepare(`PRAGMA foreign_key_check`).all() as unknown[]).length).toBe(0);
  });

  it('(b) a mid-LIMS throw rolls back catalog + indexed + LIMS — all-or-nothing, no leaked audit', () => {
    const a = registerLimsEntityInDb(db, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'a',
      fields: { sequence: fileSeq('/w/old.gb') },
    });

    registerLimsEntityInDb(db, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'b',
      fields: { sequence: fileSeq('/w/new.gb') },
    });
    seedCatalogFile(db, '/w/old.gb');
    const { fileId } = seedIndexedWithBinding(db, '/w/old.gb');
    const auditBefore = updatedAuditCount(db);

    expect(() =>
      db.transaction(() =>
        relocateWorkspaceFileRefsInDb(db, {
          workspaceRoot: '/w',
          oldPath: '/w/old.gb',
          newPath: '/w/new.gb',
        })
      )()
    ).toThrow(/already owned/i);

    expect(catalogPath(db, '/w/old.gb')).toBe('/w/old.gb');
    expect(indexedPathById(db, fileId)).toBe('/w/old.gb');
    expect(limsRelPath(db, a.id)).toBe('/w/old.gb');
    expect(updatedAuditCount(db)).toBe(auditBefore);
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
  });

  it('(c) a directory move rebases every descendant across all three systems', () => {
    const p1 = registerLimsEntityInDb(db, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'p1',
      fields: { sequence: fileSeq('/w/dir/a.gb') },
    });
    seedCatalogFile(db, '/w/dir/a.gb');
    const { fileId } = seedIndexedWithBinding(db, '/w/dir/sub/b.gb');

    db.transaction(() =>
      relocateWorkspaceFileRefsInDb(db, {
        workspaceRoot: '/w',
        oldPath: '/w/dir',
        newPath: '/w/moved',
      })
    )();
    expect(limsRelPath(db, p1.id)).toBe('/w/moved/a.gb');
    expect(catalogPath(db, '/w/dir/a.gb')).toBe('/w/moved/a.gb');
    expect(indexedPathById(db, fileId)).toBe('/w/moved/sub/b.gb');
  });
});
