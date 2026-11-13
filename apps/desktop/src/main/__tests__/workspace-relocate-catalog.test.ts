import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import {
  assertNoStaleFileLocators,
  detectCatalogRelocationConflict,
  relocateWorkspaceFileRefsInDb,
} from '../workspace-relocate';

const NOW = 1_700_000_000_000;

function freshDb(): Database.Database {
  const db = createTestDb();
  db.pragma('foreign_keys = ON');
  ensureSchema(db, ':memory:');
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at) VALUES (1,'W','/w',${NOW})`
  ).run();
  return db;
}

let ecount = 0;
function addEntity(
  db: Database.Database,
  opts: { type?: string; locator: string; name?: string }
): string {
  const id = `e${++ecount}`;
  db.prepare(
    `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'file', 'active', ${NOW}, ${NOW})`
  ).run(id, opts.type ?? 'file', opts.name ?? 'n', opts.locator);
  return id;
}
function addFile(
  db: Database.Database,
  entityId: string,
  path: string,
  fileKind = 'genbank'
): string {
  const id = `f${++ecount}`;
  db.prepare(
    `INSERT INTO catalog_entity_files (id, entity_id, workspace_id, path, relative_path, file_kind, status, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, 'current', ${NOW}, ${NOW})`
  ).run(id, entityId, path, null, fileKind);
  return id;
}
const fileRow = (db: Database.Database, id: string) =>
  db
    .prepare(
      `SELECT path, relative_path, file_kind, status, missing_since FROM catalog_entity_files WHERE id=?`
    )
    .get(id) as {
    path: string;
    relative_path: string | null;
    file_kind: string;
    status: string;
    missing_since: number | null;
  };
const entityRow = (db: Database.Database, id: string) =>
  db.prepare(`SELECT name, locator FROM catalog_entities WHERE id=?`).get(id) as {
    name: string;
    locator: string;
  };

describe('rebaseCatalogFileRefsInTx (via relocateWorkspaceFileRefsInDb)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('(a) single file: path + relative_path rebased, file:// locator flipped', () => {
    const e = addEntity(db, { type: 'file', locator: 'file:///w/old.gb', name: 'old.gb' });
    const f = addFile(db, e, '/w/old.gb');
    const c = relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/old.gb',
      newPath: '/w/sub/new.gb',
    });
    expect(c.catalog.updated).toBe(1);
    expect(fileRow(db, f)).toMatchObject({
      path: '/w/sub/new.gb',
      relative_path: 'sub/new.gb',
      status: 'current',
      missing_since: null,
    });
    expect(entityRow(db, e)).toEqual({ name: 'new.gb', locator: 'file:///w/sub/new.gb' });
  });

  it('(b) directory prefix: every descendant file rebased with correct relative_path', () => {
    const e1 = addEntity(db, { locator: 'file:///w/dir/a.gb' });
    const f1 = addFile(db, e1, '/w/dir/a.gb');
    const e2 = addEntity(db, { locator: 'file:///w/dir/sub/b.gb' });
    const f2 = addFile(db, e2, '/w/dir/sub/b.gb');
    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/dir',
      newPath: '/w/moved',
    });
    expect(fileRow(db, f1)).toMatchObject({ path: '/w/moved/a.gb', relative_path: 'moved/a.gb' });
    expect(fileRow(db, f2)).toMatchObject({
      path: '/w/moved/sub/b.gb',
      relative_path: 'moved/sub/b.gb',
    });
  });

  it('(c) entity:// locators are NOT rewritten (anti-blind-prefix)', () => {
    const e = addEntity(db, { type: 'notebook', locator: 'entity://page/xyz', name: 'Lab' });
    const f = addFile(db, e, '/w/Lab', 'waypoint-notebook');
    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/Lab',
      newPath: '/w/Renamed',
    });
    expect(fileRow(db, f).path).toBe('/w/Renamed');
    expect(entityRow(db, e).locator).toBe('entity://page/xyz');
    expect(fileRow(db, f).file_kind).toBe('waypoint-notebook');
  });

  it('preserves a plasmid package binding when its directory moves', () => {
    const e = addEntity(db, {
      type: 'design',
      locator: 'entity://design/sequence-package',
      name: 'pUC19',
    });
    const f = addFile(db, e, '/w/pUC19', 'waypoint-plasmid');

    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/pUC19',
      newPath: '/w/archive/pUC19',
    });

    expect(fileRow(db, f)).toMatchObject({
      path: '/w/archive/pUC19',
      file_kind: 'waypoint-plasmid',
    });
  });

  it('flips the file:// locator of a TYPED entity, not just a generic file', () => {
    const e = addEntity(db, {
      type: 'sequence',
      locator: 'file:///w/kit/pJ02.gb',
      name: 'pJ02B2Rm control',
    });
    const f = addFile(db, e, '/w/kit/pJ02.gb');

    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/kit/pJ02.gb',
      newPath: '/w/relocated/pJ02.gb',
    });

    expect(fileRow(db, f).path).toBe('/w/relocated/pJ02.gb');
    expect(entityRow(db, e).locator).toBe('file:///w/relocated/pJ02.gb');
  });

  it('keeps a typed entity’s DISPLAY NAME across a move', () => {
    const e = addEntity(db, {
      type: 'sequence',
      locator: 'file:///w/kit/pJ02.gb',
      name: 'pJ02B2Rm control',
    });
    addFile(db, e, '/w/kit/pJ02.gb');

    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/kit/pJ02.gb',
      newPath: '/w/relocated/pJ02.gb',
    });

    expect(entityRow(db, e).name).toBe('pJ02B2Rm control');
  });

  it('still renames a GENERIC file entity, whose name IS its filename', () => {
    const e = addEntity(db, { type: 'file', locator: 'file:///w/old.gb', name: 'old.gb' });
    addFile(db, e, '/w/old.gb');

    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/old.gb',
      newPath: '/w/new.gb',
    });

    expect(entityRow(db, e)).toEqual({ name: 'new.gb', locator: 'file:///w/new.gb' });
  });

  describe('the post-condition that makes a forgotten reference impossible to commit', () => {
    it('refuses a state where a touched entity still points at the vacated path', () => {
      const e = addEntity(db, { type: 'sequence', locator: 'file:///w/kit/pJ02.gb' });
      expect(() => assertNoStaleFileLocators(db, '/w/kit', [e])).toThrow(/RELOCATE_STALE_LOCATOR/);
    });

    it('names the offending entity, so the failure is actionable', () => {
      const e = addEntity(db, { type: 'sequence', locator: 'file:///w/kit/pJ02.gb' });
      expect(() => assertNoStaleFileLocators(db, '/w/kit', [e])).toThrow(/pJ02\.gb/);
    });

    it('passes once the locator has moved with the file', () => {
      const e = addEntity(db, { type: 'sequence', locator: 'file:///w/relocated/pJ02.gb' });
      expect(() => assertNoStaleFileLocators(db, '/w/kit', [e])).not.toThrow();
    });

    it('ignores identity locators, which carry no location to go stale', () => {
      const e = addEntity(db, { type: 'notebook', locator: 'entity://page/xyz' });
      expect(() => assertNoStaleFileLocators(db, '/w/Lab', [e])).not.toThrow();
    });

    it('respects path-segment boundaries rather than raw prefixes', () => {
      const e = addEntity(db, { type: 'sequence', locator: 'file:///w/beta-archive/x.gb' });
      expect(() => assertNoStaleFileLocators(db, '/w/beta', [e])).not.toThrow();
    });

    it('leaves an UNTOUCHED pre-existing orphan alone', () => {
      const orphan = addEntity(db, { type: 'sequence', locator: 'file:///w/kit/ghost.gb' });
      const moved = addEntity(db, { type: 'sequence', locator: 'file:///w/elsewhere/x.gb' });
      expect(() => assertNoStaleFileLocators(db, '/w/kit', [moved])).not.toThrow();
      expect(entityRow(db, orphan).locator).toBe('file:///w/kit/ghost.gb');
    });

    it('is actually WIRED into the relocate path, not merely exported', () => {
      const e = addEntity(db, {
        type: 'sequence',
        locator: 'file:///w/kit/pJ02.gb',
        name: 'pJ02B2Rm control',
      });
      addFile(db, e, '/w/kit/pJ02.gb');
      expect(() =>
        relocateWorkspaceFileRefsInDb(db, {
          workspaceRoot: '/w',
          oldPath: '/w/kit',
          newPath: '/w/relocated',
        })
      ).not.toThrow();
      expect(entityRow(db, e).locator).toBe('file:///w/relocated/pJ02.gb');
    });
  });

  it('(d) a trailing-separator oldPath still slices its children', () => {
    const e = addEntity(db, { locator: 'file:///w/dir/a.gb' });
    const f = addFile(db, e, '/w/dir/a.gb');
    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/dir/',
      newPath: '/w/moved',
    });
    expect(fileRow(db, f).path).toBe('/w/moved/a.gb');
  });

  it('(e) oldPath === newPath is a no-op', () => {
    const e = addEntity(db, { locator: 'file:///w/x.gb' });
    const f = addFile(db, e, '/w/x.gb');
    const c = relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/x.gb',
      newPath: '/w/x.gb',
    });
    expect(c.catalog.updated).toBe(0);
    expect(fileRow(db, f).path).toBe('/w/x.gb');
  });

  it('(g) statSync refreshes size on a move; status + missing_since are PRESERVED (currency is reconcile’s job)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reloc-cat-'));
    writeFileSync(join(dir, 'new.gb'), 'LOCUS  hello');
    const e = addEntity(db, { locator: `file://${join(dir, 'old.gb')}` });
    const f = addFile(db, e, join(dir, 'old.gb'));
    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: dir,
      oldPath: join(dir, 'old.gb'),
      newPath: join(dir, 'new.gb'),
    });
    const row = db
      .prepare(`SELECT status, missing_since, size_bytes FROM catalog_entity_files WHERE id=?`)
      .get(f) as { status: string; missing_since: number | null; size_bytes: number | null };
    expect(row.size_bytes).toBe('LOCUS  hello'.length);
    expect(row.status).toBe('current');
    expect(row.missing_since).toBeNull();
  });

  it('(h) appends a path_moved catalog event per moved file', () => {
    const e = addEntity(db, { locator: 'file:///w/x.gb' });
    addFile(db, e, '/w/x.gb');
    relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/x.gb',
      newPath: '/w/y.gb',
    });
    const ev = db
      .prepare(`SELECT event_type, payload FROM catalog_entity_events WHERE entity_id=?`)
      .get(e) as { event_type: string; payload: string };
    expect(ev.event_type).toBe('path_moved');
    expect(JSON.parse(ev.payload)).toEqual({ oldPath: '/w/x.gb', newPath: '/w/y.gb' });
  });

  it('(k) a directory move over an entity current + a STILL-ON-DISK superseded sibling stays single-current', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reloc-cat-k-'));
    mkdirSync(join(dir, 'moved'), { recursive: true });
    writeFileSync(join(dir, 'moved', 'new.gb'), 'NEW');
    writeFileSync(join(dir, 'moved', 'old.gb'), 'OLD');
    const e = addEntity(db, { locator: `file://${join(dir, 'sub', 'new.gb')}`, name: 'nb' });
    const current = addFile(db, e, join(dir, 'sub', 'new.gb'), 'waypoint-notebook');
    const superseded = 'f-superseded';
    db.prepare(
      `INSERT INTO catalog_entity_files (id, entity_id, workspace_id, path, relative_path, file_kind, status, created_at, updated_at)
       VALUES (?, ?, 1, ?, NULL, 'waypoint-notebook', 'superseded', 0, 0)`
    ).run(superseded, e, join(dir, 'sub', 'old.gb'));

    expect(() =>
      relocateWorkspaceFileRefsInDb(db, {
        workspaceRoot: dir,
        oldPath: join(dir, 'sub'),
        newPath: join(dir, 'moved'),
      })
    ).not.toThrow();

    expect(fileRow(db, current).path).toBe(join(dir, 'moved', 'new.gb'));
    expect(fileRow(db, current).status).toBe('current');
    expect(fileRow(db, superseded).path).toBe(join(dir, 'moved', 'old.gb'));
    expect(fileRow(db, superseded).status).toBe('superseded');
    const currents = db
      .prepare(`SELECT COUNT(*) n FROM catalog_entity_files WHERE entity_id=? AND status='current'`)
      .get(e) as { n: number };
    expect(currents.n).toBe(1);
    expect((db.prepare(`PRAGMA foreign_key_check`).all() as unknown[]).length).toBe(0);
  });
});

describe('detectCatalogRelocationConflict', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('(i) reports a conflict when a non-mover row already sits at the target path', () => {
    const e1 = addEntity(db, { locator: 'file:///w/old.gb' });
    addFile(db, e1, '/w/old.gb');
    const e2 = addEntity(db, { locator: 'file:///w/new.gb' });
    addFile(db, e2, '/w/new.gb');
    expect(detectCatalogRelocationConflict(db, '/w/old.gb', '/w/new.gb')).toBe('/w/new.gb');
  });

  it('(i) reports no conflict for a clear target', () => {
    const e = addEntity(db, { locator: 'file:///w/old.gb' });
    addFile(db, e, '/w/old.gb');
    expect(detectCatalogRelocationConflict(db, '/w/old.gb', '/w/clear.gb')).toBeNull();
  });

  it('(i) reports a conflict when a different entity already holds the file:// locator', () => {
    const e1 = addEntity(db, { locator: 'file:///w/old.gb' });
    addFile(db, e1, '/w/old.gb');
    addEntity(db, { locator: 'file:///w/target.gb' });
    expect(detectCatalogRelocationConflict(db, '/w/old.gb', '/w/target.gb')).toBe('/w/target.gb');
  });
});

describe('(j) relocateWorkspaceFileRefsInDb composition', () => {
  it('rebases both catalog and indexed_files in one call', () => {
    const db = freshDb();
    const e = addEntity(db, { locator: 'file:///w/old.gb' });
    addFile(db, e, '/w/old.gb');
    db.prepare(
      `INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (1,'/w/old.gb','old.gb','gb',${NOW})`
    ).run();
    const c = relocateWorkspaceFileRefsInDb(db, {
      workspaceRoot: '/w',
      oldPath: '/w/old.gb',
      newPath: '/w/new.gb',
    });
    expect(c.catalog.updated).toBe(1);
    expect(c.indexed.indexedFilesMoved).toBe(1);
    expect(db.prepare(`SELECT path FROM indexed_files`).get()).toEqual({ path: '/w/new.gb' });
    expect(db.prepare(`SELECT path FROM catalog_entity_files`).get()).toEqual({
      path: '/w/new.gb',
    });
  });
});
