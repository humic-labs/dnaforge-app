import { describe, expect, it } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertWorkspaceSyncDatabaseFence,
  assertCommittedDatabaseReadAllowed,
  assertRendererDatabaseStatementAllowed,
} from './workspace-sync-database-fence';

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
