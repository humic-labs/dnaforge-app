import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { seedOriginalProjectFixture } from './__tests__/original-project-fixture';
import { ensureSchema } from './schema';
import {
  getEntityRowById,
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  updateLimsEntityInsideTx,
} from './lims-engine-core';
import { limsEntityFromRow, type LimsRegisterEntityInput } from '../shared/lims';
import { verifyLimsAuditHashChainInDb } from './lims-projection-rebuild';

describe('Registry projection create idempotency', () => {
  let db: Database.Database;
  const input: LimsRegisterEntityInput = {
    id: 'portable-projection-identity',
    kind: 'strain',
    name: 'Imported strain',
    fields: { genotypeCanonical: 'deltaX' },
    actor: 'workspace-reconcile',
  };
  const register = (value = input) => db.transaction(() => registerLimsEntityInsideTx(db, value))();

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seedOriginalProjectFixture(db);
    seedLimsBuiltinsInDb(db);
  });
  afterEach(() => db.close());

  it('replays the stable create key 100 times without writes, display ID allocation or lost edits', () => {
    const first = register();
    const edited = db.transaction(() =>
      updateLimsEntityInsideTx(db, {
        id: first.id,
        name: 'Later user name',
        fields: { genotypeCanonical: 'deltaY' },
      })
    )();
    const writes = db.prepare('SELECT total_changes() AS n').get();
    for (let tick = 0; tick < 100; tick += 1) expect(register()).toEqual(edited);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(writes);
    expect(limsEntityFromRow(getEntityRowById(db, first.id))).toEqual(edited);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE id=?').get(first.id)).toEqual({
      n: 1,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM lims_audit WHERE subject_id=? AND event_type='entity_registered'"
        )
        .get(first.id)
    ).toEqual({ n: 1 });
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('refuses a reused identity of another kind without writing', () => {
    const first = register();
    expect(() => register({ ...input, kind: 'protein' })).toThrow(/identity.*kind/i);
    expect(limsEntityFromRow(getEntityRowById(db, first.id))).toEqual(first);
  });

  it('refuses a reused identity in another home without writing', () => {
    const first = register();
    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (99, ?, ?, 1)').run(
      'Another home',
      '/another-home'
    );
    expect(() => register({ ...input, workspaceId: 99 })).toThrow(/identity.*project/i);
    expect(limsEntityFromRow(getEntityRowById(db, first.id))).toEqual(first);
  });

  it('retains a stable create key and refuses to recreate a lost projection over its history', () => {
    const first = register();
    const event = db
      .prepare(
        "SELECT idempotency_key FROM lims_audit WHERE subject_id=? AND event_type='entity_registered'"
      )
      .get(first.id);
    expect(event).toEqual({ idempotency_key: `lims:entity-register:${first.id}` });
    db.prepare('DELETE FROM lims_entity WHERE id=?').run(first.id);
    const writes = db.prepare('SELECT total_changes() AS n').get();
    expect(() => register()).toThrow(/identity.*recover/i);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(writes);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });
});
