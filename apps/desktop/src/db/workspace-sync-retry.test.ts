import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../main/__tests__/test-db';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertRendererDatabaseStatementAllowed,
  notifyRendererDatabaseStatementSettled,
} from '../main/workspace-sync-database-fence';
import { waitForWorkspaceSyncDatabase } from './workspace-sync-retry';

afterEach(() => vi.useRealTimers());

describe('renderer database statements during cloud finalization', () => {
  it('waits for consecutive replica fences and inserts the imported project once', async () => {
    vi.useFakeTimers();
    const db = createTestDb();
    db.exec('CREATE TABLE imported_project (path TEXT PRIMARY KEY)');
    const releaseFirst = await acquireWorkspaceSyncDatabaseFence(db);
    const secondFence = acquireWorkspaceSyncDatabaseFence(db);
    let executed = 0;
    const insert = waitForWorkspaceSyncDatabase(async () => {
      assertRendererDatabaseStatementAllowed(db);
      executed += 1;
      return db.prepare('INSERT INTO imported_project VALUES (?)').run('/project-two');
    });
    await Promise.resolve();
    expect(executed).toBe(0);
    releaseFirst();
    const releaseSecond = await secondFence;
    await vi.advanceTimersByTimeAsync(100);
    expect(executed).toBe(0);
    releaseSecond();
    await vi.advanceTimersByTimeAsync(250);
    await expect(insert).resolves.toMatchObject({ changes: 1 });
    expect(executed).toBe(1);
    expect(db.prepare('SELECT path FROM imported_project').all()).toEqual([
      { path: '/project-two' },
    ]);
    db.close();
  });

  it('does not retry a real database failure', async () => {
    const db = createTestDb();
    db.exec('CREATE TABLE imported_project (path TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO imported_project VALUES (?)').run('/existing-project');
    let executed = 0;
    await expect(
      waitForWorkspaceSyncDatabase(async () => {
        assertRendererDatabaseStatementAllowed(db);
        executed += 1;
        return db.prepare('INSERT INTO imported_project VALUES (?)').run('/existing-project');
      })
    ).rejects.toThrow('UNIQUE constraint failed');
    expect(executed).toBe(1);
    db.close();
  });

  it('reports an unreleased fence within the bounded wait without executing SQL', async () => {
    vi.useFakeTimers();
    const db = createTestDb();
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    let executed = 0;
    const insert = waitForWorkspaceSyncDatabase(async () => {
      assertRendererDatabaseStatementAllowed(db);
      executed += 1;
    });
    const failed = expect(insert).rejects.toThrow('WORKSPACE_SYNC_DATABASE_BUSY');
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(executed).toBe(0);
    release();
    db.close();
  });

  it('preserves another renderer transaction and rejects its ownership error immediately', async () => {
    const db = createTestDb();
    db.exec('BEGIN');
    notifyRendererDatabaseStatementSettled(db, { senderId: 41, wasInTransaction: false });
    let attempted = 0;
    await expect(
      waitForWorkspaceSyncDatabase(async () => {
        attempted += 1;
        assertRendererDatabaseStatementAllowed(db, 42);
      })
    ).rejects.toThrow('DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER');
    expect(attempted).toBe(1);
    expect(db.inTransaction).toBe(true);
    db.exec('ROLLBACK');
    db.close();
  });
});
