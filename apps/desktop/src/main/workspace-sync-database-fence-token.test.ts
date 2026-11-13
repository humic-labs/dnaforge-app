import { describe, expect, it } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertWorkspaceSyncDatabaseFence,
  assertCommittedDatabaseReadAllowed,
  assertRendererDatabaseStatementAllowed,
  withWorkspaceSyncDatabaseFence,
} from './workspace-sync-database-fence';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe('native publication database authority', () => {
  it('admits only committed authority reads by the live fence owner while renderer access stays blocked', async () => {
    const db = createTestDb();
    const other = createTestDb();
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      expect(() => assertCommittedDatabaseReadAllowed(db)).toThrow('WORKSPACE_SYNC_DATABASE_BUSY');
      expect(() => assertCommittedDatabaseReadAllowed(db, release)).not.toThrow();
      expect(() => assertRendererDatabaseStatementAllowed(db)).toThrow(
        'WORKSPACE_SYNC_DATABASE_BUSY'
      );
      expect(() => assertCommittedDatabaseReadAllowed(other, release)).toThrow(
        'WORKSPACE_DATABASE_FENCE_INVALID'
      );
      expect(() => assertCommittedDatabaseReadAllowed(db, () => {})).toThrow(
        'WORKSPACE_DATABASE_FENCE_INVALID'
      );
      db.exec('BEGIN');
      expect(() => assertCommittedDatabaseReadAllowed(db, release)).toThrow(
        'DATABASE_UNCOMMITTED_AUTHORITY_READ'
      );
      db.exec('ROLLBACK');
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      release();
    }
    expect(() => assertCommittedDatabaseReadAllowed(db, release)).toThrow(
      'WORKSPACE_DATABASE_FENCE_INVALID'
    );
    expect(() => assertCommittedDatabaseReadAllowed(db)).not.toThrow();
    db.close();
    other.close();
  });
  it('admits committed reads in the live holder scope and refuses every other context', async () => {
    const db = createTestDb();
    const entered = deferred();
    const finish = deferred();
    const wake = deferred();
    let staleRead!: Promise<void>;
    const holder = withWorkspaceSyncDatabaseFence(db, async () => {
      await Promise.resolve();
      expect(() => assertCommittedDatabaseReadAllowed(db)).not.toThrow();
      expect(() => assertRendererDatabaseStatementAllowed(db)).toThrow(
        'WORKSPACE_SYNC_DATABASE_BUSY'
      );
      db.exec('BEGIN');
      expect(() => assertCommittedDatabaseReadAllowed(db)).toThrow(
        'DATABASE_UNCOMMITTED_AUTHORITY_READ'
      );
      db.exec('ROLLBACK');
      staleRead = wake.promise.then(() => assertCommittedDatabaseReadAllowed(db));
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    expect(() => assertCommittedDatabaseReadAllowed(db)).toThrow('WORKSPACE_SYNC_DATABASE_BUSY');
    finish.resolve();
    await holder;
    const next = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      wake.resolve();
      await expect(staleRead).rejects.toThrow('WORKSPACE_SYNC_DATABASE_BUSY');
    } finally {
      next();
    }
    db.close();
  });
  it('accepts only a live token for the same database', async () => {
    const db = createTestDb();
    const other = createTestDb();
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      expect(() => assertWorkspaceSyncDatabaseFence(db, release)).not.toThrow();
      expect(() => assertWorkspaceSyncDatabaseFence(other, release)).toThrow(
        'WORKSPACE_DATABASE_FENCE_INVALID'
      );
      expect(() => assertWorkspaceSyncDatabaseFence(db, () => {})).toThrow(
        'WORKSPACE_DATABASE_FENCE_INVALID'
      );
    } finally {
      release();
    }
    expect(() => assertWorkspaceSyncDatabaseFence(db, release)).toThrow(
      'WORKSPACE_DATABASE_FENCE_INVALID'
    );
    db.close();
    other.close();
  });
});
