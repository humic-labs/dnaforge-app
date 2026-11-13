import { seedOriginalProjectFixture } from './original-project-fixture';
/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import {
  clearLimsRegistryInsideTx,
  linkLimsEntitiesOrExistingInsideTx,
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  upsertLimsEntityProjectionInsideTx,
} from '../lims-engine-core';
import { repairLimsEntityProjectionFromAuditInDb } from '../lims';
import { verifyLimsAuditHashChainInDb } from '../lims-projection-rebuild';
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  seedOriginalProjectFixture(db);
  seedLimsBuiltinsInDb(db);
});
afterEach(() => db.close());

const register = (id: string) =>
  db.transaction(() =>
    registerLimsEntityInsideTx(db, {
      id,
      kind: 'strain',
      name: id,
      fields: { genotypeCanonical: 'recA1' },
    })
  )();

describe('selective Registry recovery reconstructs linked missing projections', () => {
  it('repairs both missing endpoints without requiring either absent endpoint to be repaired first', () => {
    const first = register('missing-first');
    const second = register('missing-second');
    const unrelated = register('existing-unrelated');
    const link = db.transaction(() =>
      linkLimsEntitiesOrExistingInsideTx(db, {
        fromEntityId: first.id,
        toEntityId: second.id,
        type: 'associated_with',
      })
    )();

    db.prepare('DELETE FROM lims_link WHERE id=?').run(link.id);
    db.prepare('DELETE FROM lims_entity WHERE id IN (?,?)').run(first.id, second.id);
    db.prepare('UPDATE lims_entity SET fields=? WHERE id=?').run(
      JSON.stringify({ genotypeCanonical: 'retained-current-cache' }),
      unrelated.id
    );
    const retained = JSON.stringify(
      db.prepare('SELECT * FROM lims_entity WHERE id=?').get(unrelated.id)
    );
    const history = JSON.stringify(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all());
    const schemas = JSON.stringify(db.prepare('SELECT * FROM lims_schema ORDER BY id').all());

    expect(repairLimsEntityProjectionFromAuditInDb(db, first.id)).toBe(true);
    expect(repairLimsEntityProjectionFromAuditInDb(db, second.id)).toBe(true);
    expect(
      db
        .prepare('SELECT id FROM lims_entity WHERE id IN (?,?) ORDER BY id')
        .pluck()
        .all(first.id, second.id)
    ).toEqual([first.id, second.id]);
    expect(
      db
        .prepare('SELECT from_entity_id,to_entity_id,tombstone FROM lims_link WHERE id=?')
        .get(link.id)
    ).toEqual({ from_entity_id: first.id, to_entity_id: second.id, tombstone: 0 });
    expect(
      JSON.stringify(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(unrelated.id))
    ).toBe(retained);
    expect(
      JSON.stringify(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()) === history
    ).toBe(true);
    expect(
      JSON.stringify(db.prepare('SELECT * FROM lims_schema ORDER BY id').all()) === schemas
    ).toBe(true);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('handles a missing cycle using its latest archived edge states and restores its missing frozen schema', () => {
    const members = ['missing-first', 'missing-second', 'missing-third'].map(register);
    db.transaction(() => {
      members.forEach((member, index) =>
        linkLimsEntitiesOrExistingInsideTx(db, {
          fromEntityId: member.id,
          toEntityId: members[(index + 1) % members.length].id,
          type: 'associated_with',
        })
      );
      clearLimsRegistryInsideTx(db);
    })();
    db.prepare('DELETE FROM lims_link').run();
    db.prepare('DELETE FROM lims_entity').run();
    db.prepare('DELETE FROM lims_schema_revision WHERE schema_id=?').run(members[0].schemaId);
    db.prepare('DELETE FROM lims_schema WHERE id=?').run(members[0].schemaId);
    const schemas = JSON.stringify(db.prepare('SELECT * FROM lims_schema ORDER BY id').all());
    const history = JSON.stringify(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all());

    expect(repairLimsEntityProjectionFromAuditInDb(db, members[0].id)).toBe(true);
    expect(db.prepare('SELECT id,tombstone FROM lims_entity ORDER BY id').all()).toEqual(
      members.map((member) => ({ id: member.id, tombstone: 1 }))
    );
    expect(db.prepare('SELECT COUNT(*) FROM lims_link WHERE tombstone=1').pluck().get()).toBe(3);
    expect(
      db
        .prepare('SELECT 1 FROM lims_schema_revision WHERE id=?')
        .pluck()
        .get(members[0].schemaRevisionId)
    ).toBe(1);
    expect(
      JSON.stringify(
        db.prepare('SELECT * FROM lims_schema WHERE id!=? ORDER BY id').all(members[0].schemaId)
      ) === schemas
    ).toBe(true);
    expect(
      JSON.stringify(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()) === history
    ).toBe(true);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('rolls back the dependency closure if an endpoint has no verified record authority', () => {
    const first = register('missing-first');

    db.transaction(() =>
      upsertLimsEntityProjectionInsideTx(db, {
        ...first,
        id: 'unrecoverable-target',
        name: 'No authority',
        registryId: null,
      })
    )();
    db.transaction(() =>
      linkLimsEntitiesOrExistingInsideTx(db, {
        fromEntityId: first.id,
        toEntityId: 'unrecoverable-target',
        type: 'associated_with',
      })
    )();
    db.prepare('DELETE FROM lims_link').run();
    db.prepare('DELETE FROM lims_entity').run();
    db.prepare('DELETE FROM lims_schema_revision WHERE schema_id=?').run(first.schemaId);
    db.prepare('DELETE FROM lims_schema WHERE id=?').run(first.schemaId);
    const before = JSON.stringify({
      entities: db.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
      links: db.prepare('SELECT * FROM lims_link ORDER BY id').all(),
      schemas: db.prepare('SELECT * FROM lims_schema ORDER BY id').all(),
      revisions: db.prepare('SELECT * FROM lims_schema_revision ORDER BY id').all(),
      history: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
    });

    expect(() => repairLimsEntityProjectionFromAuditInDb(db, first.id)).toThrow(
      /verified authority.*unrecoverable-target/
    );
    expect(
      JSON.stringify({
        entities: db.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
        links: db.prepare('SELECT * FROM lims_link ORDER BY id').all(),
        schemas: db.prepare('SELECT * FROM lims_schema ORDER BY id').all(),
        revisions: db.prepare('SELECT * FROM lims_schema_revision ORDER BY id').all(),
        history: db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
      }) === before
    ).toBe(true);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });
});
