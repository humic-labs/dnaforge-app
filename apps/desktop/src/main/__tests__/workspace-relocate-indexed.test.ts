import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { rebaseIndexedFilesRefsInTx } from '../workspace-relocate';

const NOW = 1_700_000_000_000;

function freshDb(): Database.Database {
  const db = createTestDb();
  db.pragma('foreign_keys = ON');
  ensureSchema(db, ':memory:');
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at) VALUES (1, 'W', '/w', ${NOW})`
  ).run();
  db.prepare(
    `INSERT INTO primers (id, name, sequence, length, created_at, updated_at)
     VALUES ('P', 'P', 'ACGT', 4, ${NOW}, ${NOW})`
  ).run();
  return db;
}

function addFile(db: Database.Database, path: string, ext = 'gb'): number {
  const info = db
    .prepare(
      `INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at)
       VALUES (1, ?, ?, ?, ${NOW})`
    )
    .run(path, path.split('/').pop(), ext);
  return Number(info.lastInsertRowid);
}
function addSeq(db: Database.Database, fileId: number): number {
  const info = db
    .prepare(`INSERT INTO sequences (file_id, name, length) VALUES (?, 'S', 10)`)
    .run(fileId);
  return Number(info.lastInsertRowid);
}
function addBinding(db: Database.Database, id: string, seqId: number, start: number): void {
  db.prepare(
    `INSERT INTO primer_bindings (id, primer_id, sequence_id, binding_start, binding_end, strand, created_at, updated_at)
     VALUES (?, 'P', ?, ?, ?, 1, ${NOW}, ${NOW})`
  ).run(id, seqId, start, start + 20);
}
const files = (db: Database.Database) =>
  db.prepare(`SELECT id, path FROM indexed_files ORDER BY id`).all() as Array<{
    id: number;
    path: string;
  }>;
const bindings = (db: Database.Database) =>
  db
    .prepare(`SELECT id, sequence_id, binding_start FROM primer_bindings ORDER BY id`)
    .all() as Array<{ id: string; sequence_id: number; binding_start: number }>;
const fkClean = (db: Database.Database) =>
  (db.prepare(`PRAGMA foreign_key_check`).all() as unknown[]).length === 0;

describe('rebaseIndexedFilesRefsInTx', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('(a) single-file move: same row id, same sequence id, bindings unchanged, name+extension rebased', () => {
    const f = addFile(db, '/w/old.gb');
    const s = addSeq(db, f);
    addBinding(db, 'b1', s, 10);

    const c = rebaseIndexedFilesRefsInTx(db, '/w/old.gb', '/w/new.gbk', NOW);
    expect(c).toEqual({
      indexedFilesMoved: 1,
      staleIndexedFilesMerged: 0,
      primerBindingsRepointed: 0,
    });

    const rows = files(db);
    expect(rows).toEqual([{ id: f, path: '/w/new.gbk' }]);
    const nm = db.prepare(`SELECT name, extension FROM indexed_files WHERE id=?`).get(f) as {
      name: string;
      extension: string;
    };
    expect(nm).toEqual({ name: 'new.gbk', extension: 'gbk' });
    expect(db.prepare(`SELECT id, file_id FROM sequences`).all()).toEqual([{ id: s, file_id: f }]);
    expect(bindings(db)).toEqual([{ id: 'b1', sequence_id: s, binding_start: 10 }]);
    expect(fkClean(db)).toBe(true);
  });

  it('(b) directory-prefix move: every descendant rebased to a distinct target, no merges', () => {
    const a = addFile(db, '/w/dir/a.gb');
    const b = addFile(db, '/w/dir/sub/b.gb');
    const c = rebaseIndexedFilesRefsInTx(db, '/w/dir', '/w/moved', NOW);
    expect(c).toEqual({
      indexedFilesMoved: 2,
      staleIndexedFilesMerged: 0,
      primerBindingsRepointed: 0,
    });
    expect(files(db)).toEqual([
      { id: a, path: '/w/moved/a.gb' },
      { id: b, path: '/w/moved/sub/b.gb' },
    ]);
    expect(fkClean(db)).toBe(true);
  });

  it('(c) collision-merge: mover wins, stale binding re-pointed to the mover sequence, stale rows gone', () => {
    const mover = addFile(db, '/w/old.gb');
    const sMover = addSeq(db, mover);
    addBinding(db, 'b1', sMover, 10);
    const stale = addFile(db, '/w/new.gb');
    const sStale = addSeq(db, stale);
    addBinding(db, 'b2', sStale, 20);

    const c = rebaseIndexedFilesRefsInTx(db, '/w/old.gb', '/w/new.gb', NOW);
    expect(c).toEqual({
      indexedFilesMoved: 1,
      staleIndexedFilesMerged: 1,
      primerBindingsRepointed: 1,
    });

    expect(files(db)).toEqual([{ id: mover, path: '/w/new.gb' }]);
    expect(db.prepare(`SELECT id FROM sequences ORDER BY id`).all()).toEqual([{ id: sMover }]);

    expect(bindings(db)).toEqual([
      { id: 'b1', sequence_id: sMover, binding_start: 10 },
      { id: 'b2', sequence_id: sMover, binding_start: 20 },
    ]);
    expect(fkClean(db)).toBe(true);
  });

  it('(d) UNIQUE(primer_id,sequence_id,binding_start) collision: OR IGNORE drops the dup, survivor intact, no throw', () => {
    const mover = addFile(db, '/w/old.gb');
    const sMover = addSeq(db, mover);
    addBinding(db, 'b1', sMover, 10);
    const stale = addFile(db, '/w/new.gb');
    const sStale = addSeq(db, stale);
    addBinding(db, 'b2', sStale, 10);

    expect(() => rebaseIndexedFilesRefsInTx(db, '/w/old.gb', '/w/new.gb', NOW)).not.toThrow();

    expect(bindings(db)).toEqual([{ id: 'b1', sequence_id: sMover, binding_start: 10 }]);
    expect(fkClean(db)).toBe(true);
  });

  it('(e) mover-without-sequence: a stale donor sequence is reparented onto the moved file, bindings preserved', () => {
    const mover = addFile(db, '/w/old.gb');
    const stale = addFile(db, '/w/new.gb');
    const sStale = addSeq(db, stale);
    addBinding(db, 'b1', sStale, 10);

    const c = rebaseIndexedFilesRefsInTx(db, '/w/old.gb', '/w/new.gb', NOW);
    expect(c.indexedFilesMoved).toBe(1);
    expect(c.staleIndexedFilesMerged).toBe(1);

    expect(files(db)).toEqual([{ id: mover, path: '/w/new.gb' }]);

    expect(db.prepare(`SELECT id, file_id FROM sequences`).all()).toEqual([
      { id: sStale, file_id: mover },
    ]);
    expect(bindings(db)).toEqual([{ id: 'b1', sequence_id: sStale, binding_start: 10 }]);
    expect(fkClean(db)).toBe(true);
  });

  it('(f) no matching files: zero counts, nothing touched', () => {
    const other = addFile(db, '/w/elsewhere.gb');
    const c = rebaseIndexedFilesRefsInTx(db, '/w/nothing-here', '/w/moved', NOW);
    expect(c).toEqual({
      indexedFilesMoved: 0,
      staleIndexedFilesMerged: 0,
      primerBindingsRepointed: 0,
    });
    expect(files(db)).toEqual([{ id: other, path: '/w/elsewhere.gb' }]);
  });

  it('(g) case-insensitive destination (win32): a differently-cased pre-existing row is merged, not left dangling', () => {
    const mover = addFile(db, 'C:\\w\\old.gb');
    const sMover = addSeq(db, mover);
    const stale = addFile(db, 'C:\\w\\new.gb');
    addSeq(db, stale);

    const c = rebaseIndexedFilesRefsInTx(db, 'C:\\w\\old.gb', 'C:\\w\\NEW.gb', NOW);
    expect(c.staleIndexedFilesMerged).toBe(1);
    expect(files(db)).toEqual([{ id: mover, path: 'C:\\w\\NEW.gb' }]);
    expect(db.prepare(`SELECT id FROM sequences`).all()).toEqual([{ id: sMover }]);
    expect(fkClean(db)).toBe(true);
  });

  it('(h) large directory move exceeding the SQLite variable cap: no SQLITE error (JS-computed stale set)', () => {
    const N = 2000;
    const insert = db.prepare(
      `INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (1, ?, ?, 'gb', ${NOW})`
    );
    const seed = db.transaction(() => {
      for (let i = 0; i < N; i++) insert.run(`/w/dir/f${i}.gb`, `f${i}.gb`);
    });
    seed();
    let c!: ReturnType<typeof rebaseIndexedFilesRefsInTx>;
    expect(() => {
      c = rebaseIndexedFilesRefsInTx(db, '/w/dir', '/w/moved', NOW);
    }).not.toThrow();
    expect(c.indexedFilesMoved).toBe(N);
    expect(
      db.prepare(`SELECT COUNT(*) n FROM indexed_files WHERE path LIKE '/w/moved/%'`).get()
    ).toEqual({ n: N });
  });
});
