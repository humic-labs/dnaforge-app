import { seedOriginalProjectFixture } from './original-project-fixture';
/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import {
  clearDevSeededLimsRegistryInsideTx,
  clearLimsRegistryInsideTx,
  linkLimsEntitiesOrExistingInsideTx,
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
} from '../lims-engine-core';
import { seedLimsMockDemoInDb } from '../lims-demo-seed';
import {
  assertLimsProjectionReplayParityInDb,
  verifyLimsAuditHashChainInDb,
} from '../lims-projection-rebuild';

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
      kind: 'oligo',
      name: id,
      fields: { sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 } },
    })
  )();

const auditRows = () => db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();

describe('developer Registry cleanup preserves append-only, replayable history', () => {
  it('retires seeded endpoints and their relationships without changing retained events', () => {
    const seed = register('mock-dna509-seeded');
    const user = register('user-created');
    const link = db.transaction(() =>
      linkLimsEntitiesOrExistingInsideTx(db, {
        fromEntityId: seed.id,
        toEntityId: user.id,
        type: 'associated_with',
      })
    )();
    const before = auditRows();
    db.transaction(() => clearDevSeededLimsRegistryInsideTx(db, ['mock-dna509-']))();

    expect(auditRows().slice(0, before.length)).toEqual(before);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
    expect(db.prepare('SELECT tombstone FROM lims_entity WHERE id = ?').pluck().get(seed.id)).toBe(
      1
    );
    expect(db.prepare('SELECT tombstone FROM lims_entity WHERE id = ?').pluck().get(user.id)).toBe(
      0
    );
    expect(db.prepare('SELECT tombstone FROM lims_link WHERE id = ?').pluck().get(link.id)).toBe(1);
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
  });

  it('full mock reseed preserves the user row, stable IDs, every old event, and replay parity', () => {
    seedLimsMockDemoInDb(db, { actor: 'test', reset: true });
    const user = register('user-after-full-demo');
    const seedBefore = db
      .prepare("SELECT id, registry_id FROM lims_entity WHERE id LIKE 'mock-dna509-%' ORDER BY id")
      .all();
    const before = auditRows();

    seedLimsMockDemoInDb(db, { actor: 'test', reset: true, resetScope: 'dev-seed' });

    expect(auditRows().slice(0, before.length)).toEqual(before);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
    expect(db.prepare('SELECT tombstone FROM lims_entity WHERE id = ?').pluck().get(user.id)).toBe(
      0
    );
    expect(
      db
        .prepare(
          "SELECT id, registry_id FROM lims_entity WHERE id LIKE 'mock-dna509-%' ORDER BY id"
        )
        .all()
    ).toEqual(seedBefore);
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
  });

  it('Clear removes active inventory without deleting history or reusing allocated IDs', () => {
    const previous = register('clear-me');
    const before = auditRows();
    db.transaction(() => clearLimsRegistryInsideTx(db))();
    expect(db.prepare('SELECT COUNT(*) FROM lims_entity WHERE tombstone = 0').pluck().get()).toBe(
      0
    );
    expect(auditRows().slice(0, before.length)).toEqual(before);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();

    const next = register('after-clear');
    expect(next.registryId).not.toBe(previous.registryId);
  });

  it('rolls back both retirement events and projections if a replacement fails', () => {
    register('mock-dna509-rollback');
    register('user-rollback');
    const before = auditRows();
    const projection = db.prepare('SELECT * FROM lims_entity ORDER BY id').all();
    expect(() =>
      db.transaction(() => {
        clearDevSeededLimsRegistryInsideTx(db, ['mock-dna509-']);
        throw new Error('replacement failed');
      })()
    ).toThrow('replacement failed');
    expect(auditRows()).toEqual(before);
    expect(db.prepare('SELECT * FROM lims_entity ORDER BY id').all()).toEqual(projection);
  });
});
