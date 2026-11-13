import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { ADOPT_OBJECT_UUID_SQL } from '../../db/workspace-catalog';

const NOW = 1_700_000_000_000;

function freshDb(): Database.Database {
  const db = createTestDb();
  db.pragma('foreign_keys = ON');
  ensureSchema(db, ':memory:');
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at) VALUES (1,'W','/w',${NOW})`
  ).run();
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at) VALUES (2,'X','/x',${NOW})`
  ).run();
  return db;
}

let n = 0;
function addRow(
  db: Database.Database,
  opts: {
    path: string;
    hash: string | null;
    status: string;
    uuid: string | null;
    workspaceId: number | null;
  }
): void {
  const id = `f${++n}`;
  const entityId = `e${n}`;
  db.prepare(
    `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, created_at, updated_at)
     VALUES (?, 'sequence', 'seq', ?, 'file', 'active', ${NOW}, ${NOW})`
  ).run(entityId, `file://${opts.path}`);
  db.prepare(
    `INSERT INTO catalog_entity_files
      (id, entity_id, workspace_id, path, file_kind, content_hash, object_uuid, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'genbank', ?, ?, ?, ${NOW}, ${NOW})`
  ).run(id, entityId, opts.workspaceId, opts.path, opts.hash, opts.uuid, opts.status);
}

const adopt = (db: Database.Database, hash: string, workspaceId: number | null): string[] =>
  (db.prepare(ADOPT_OBJECT_UUID_SQL).all(hash, workspaceId) as Array<{ object_uuid: string }>).map(
    (r) => r.object_uuid
  );

describe('adopting a durable id from a file the app did not see move (real SQLite)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('finds the one missing row with matching content', () => {
    addRow(db, {
      path: '/w/old.gb',
      hash: 'sha256:aaaa',
      status: 'missing',
      uuid: 'uuid-1',
      workspaceId: 1,
    });
    expect(adopt(db, 'sha256:aaaa', 1)).toEqual(['uuid-1']);
  });

  it('returns two candidates when content is duplicated, so the caller refuses', () => {
    addRow(db, {
      path: '/w/a.gb',
      hash: 'sha256:aaaa',
      status: 'missing',
      uuid: 'uuid-1',
      workspaceId: 1,
    });
    addRow(db, {
      path: '/w/b.gb',
      hash: 'sha256:aaaa',
      status: 'missing',
      uuid: 'uuid-2',
      workspaceId: 1,
    });
    expect(adopt(db, 'sha256:aaaa', 1)).toHaveLength(2);
  });

  it('one row per id is a SCHEMA guarantee, which is why the count means what it means', () => {
    addRow(db, {
      path: '/w/a.gb',
      hash: 'sha256:aaaa',
      status: 'missing',
      uuid: 'uuid-1',
      workspaceId: 1,
    });
    expect(() =>
      addRow(db, {
        path: '/w/b.gb',
        hash: 'sha256:aaaa',
        status: 'missing',
        uuid: 'uuid-1',
        workspaceId: 1,
      })
    ).toThrow(/UNIQUE constraint failed: catalog_entity_files\.object_uuid/);
  });

  it('ignores a row that is still current — that is a copy, not a move', () => {
    addRow(db, {
      path: '/w/live.gb',
      hash: 'sha256:aaaa',
      status: 'current',
      uuid: 'uuid-live',
      workspaceId: 1,
    });
    expect(adopt(db, 'sha256:aaaa', 1)).toEqual([]);
  });

  it('ignores an identical file in ANOTHER workspace', () => {
    addRow(db, {
      path: '/x/other.gb',
      hash: 'sha256:aaaa',
      status: 'missing',
      uuid: 'uuid-x',
      workspaceId: 2,
    });
    expect(adopt(db, 'sha256:aaaa', 1)).toEqual([]);
  });

  it('matches a NULL workspace with IS, which `= ?` would silently miss', () => {
    addRow(db, {
      path: '/loose/old.gb',
      hash: 'sha256:aaaa',
      status: 'missing',
      uuid: 'uuid-loose',
      workspaceId: null,
    });
    expect(adopt(db, 'sha256:aaaa', null)).toEqual(['uuid-loose']);
  });

  it('does not match a git: hash against a sha256: one', () => {
    addRow(db, {
      path: '/w/g.gb',
      hash: 'git:abcd',
      status: 'missing',
      uuid: 'uuid-git',
      workspaceId: 1,
    });
    expect(adopt(db, 'sha256:abcd', 1)).toEqual([]);
  });

  it('skips a legacy row that never got an id', () => {
    addRow(db, {
      path: '/w/legacy.gb',
      hash: 'sha256:aaaa',
      status: 'missing',
      uuid: null,
      workspaceId: 1,
    });
    expect(adopt(db, 'sha256:aaaa', 1)).toEqual([]);
  });
});
