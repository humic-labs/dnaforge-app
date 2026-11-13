import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { createTestDb } from '../__tests__/test-db';
import { ensureSchema, CURRENT_SCHEMA_VERSION } from '../schema';
import { AgentStateCapsuleStore, createAgentStateCapsuleTable } from './agent-state-capsule';

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  );
}

function userVersion(db: Database.Database): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0;
}

describe('AgentStateCapsule schema migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates the capsule store when a fresh database is provisioned', () => {
    ensureSchema(db, ':memory:');
    expect(tableExists(db, 'agent_state_capsules')).toBe(true);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('chains a database that skipped every release up to the capsule store', () => {
    db.pragma('user_version = 0');
    ensureSchema(db, ':memory:');
    expect(tableExists(db, 'agent_state_capsules')).toBe(true);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is idempotent when the table already exists', () => {
    ensureSchema(db, ':memory:');
    const store = new AgentStateCapsuleStore(db, () => 1_760_000_000_000);
    const digest = store.writeCandidate({
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 1,
      predecessorDigest: null,
      bindings: { turnId: 'turn-1' },
      watermarks: { message: 1 },
      references: [],
      openToolExecutions: [],
      generations: { catalog: 'catalog-v1' },
      budget: { providerAttempts: 1 },
      compaction: null,
    });
    store.activate('run-1', digest);

    expect(() => createAgentStateCapsuleTable(db)).not.toThrow();
    ensureSchema(db, ':memory:');
    expect(store.readActive('run-1')).toMatchObject({ capsuleDigest: digest });
  });

  it('lets the database, not the writer, enforce one active capsule per run', () => {
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO agent_state_capsules
         (capsule_digest, run_id, sequence, predecessor_digest, state, payload, created_at)
       VALUES (?, 'run-1', 1, NULL, 'active', '{}', 0)`
    ).run('a'.repeat(64));

    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_state_capsules
             (capsule_digest, run_id, sequence, predecessor_digest, state, payload, created_at)
           VALUES (?, 'run-1', 2, NULL, 'active', '{}', 0)`
        )
        .run('b'.repeat(64))
    ).toThrow(/UNIQUE/u);
  });
});
