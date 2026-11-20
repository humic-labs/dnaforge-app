import { EventEmitter } from 'node:events';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createTestDb } from './__tests__/test-db';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertCommittedDatabaseReadAllowed,
  assertRendererDatabaseStatementAllowed,
  notifyRendererDatabaseStatementSettled,
  rollbackRendererDatabaseTransactionForOwner,
  withRendererDatabaseRead,
  withRendererDatabaseStatement,
  type RendererDatabaseLifecycleSender,
} from './workspace-sync-database-fence';

type TestRendererSender = RendererDatabaseLifecycleSender & {
  emit(event: string, ...args: unknown[]): boolean;
};

type TestRendererListener =
  | Parameters<RendererDatabaseLifecycleSender['once']>[1]
  | Parameters<RendererDatabaseLifecycleSender['on']>[1];

function createTestRendererSender(id: number): TestRendererSender {
  const emitter = new EventEmitter();
  const listeners: TestRendererListener[] = [];
  const track = <T extends TestRendererListener>(listener: T): T => {
    listeners.push(listener);
    return listener;
  };
  return {
    id,
    once: (event, listener) => emitter.once(event, track(listener)),
    on: (event, listener) => emitter.on(event, track(listener)),
    removeListener: (event, listener) => {
      const registered = listeners.find((candidate) => candidate === listener);
      return registered ? emitter.removeListener(event, registered) : emitter;
    },
    emit: (event, ...args) => emitter.emit(event, ...args),
  };
}

it('returns a single awaited result and checks committed authority again after an async lookup', async () => {
  const db = createTestDb();
  const sender = createTestRendererSender(974);
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  try {
    const result = withRendererDatabaseRead(db, sender, async () => {
      assertCommittedDatabaseReadAllowed(db);
      await wait;
      assertCommittedDatabaseReadAllowed(db);
      return 1;
    });
    expectTypeOf(result).toEqualTypeOf<Promise<number>>();
    withRendererDatabaseStatement(db, sender, () => db.exec('BEGIN'));
    resume();
    await expect(result).rejects.toThrow('DATABASE_');
    withRendererDatabaseStatement(db, sender, () => db.exec('ROLLBACK'));
    expect(await withRendererDatabaseRead(db, sender, async () => 2)).toBe(2);
  } finally {
    db.close();
  }
});

describe('workspace sync database fence', () => {
  it('waits for an open renderer transaction while allowing its commit', async () => {
    const db = createTestDb();
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)');
    db.exec('BEGIN TRANSACTION');
    expect(db.inTransaction).toBe(true);

    let fenceEntered = false;
    const fencing = acquireWorkspaceSyncDatabaseFence(db).then((release) => {
      fenceEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(fenceEntered).toBe(false);

    expect(() => assertRendererDatabaseStatementAllowed(db)).not.toThrow();
    db.exec('COMMIT');
    notifyRendererDatabaseStatementSettled(db);
    const release = await fencing;
    expect(fenceEntered).toBe(true);
    expect(db.inTransaction).toBe(false);
    release();
  });

  it('blocks every new renderer statement during the final fence', async () => {
    const db = createTestDb();
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)');
    const release = await acquireWorkspaceSyncDatabaseFence(db);

    expect(() => assertRendererDatabaseStatementAllowed(db)).toThrow(
      'WORKSPACE_SYNC_DATABASE_BUSY'
    );
    release();
    expect(() => assertRendererDatabaseStatementAllowed(db)).not.toThrow();
  });

  it('delivers a queued read after native publication without borrowing its connection', async () => {
    const db = createTestDb();
    db.exec("CREATE TABLE item (value TEXT); INSERT INTO item VALUES ('before')");
    const sender = createTestRendererSender(51);
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    let readFinished = false;
    const read = withRendererDatabaseRead(db, sender, () =>
      db.prepare('SELECT value FROM item').get()
    ).then((result) => {
      readFinished = true;
      return result;
    });
    await Promise.resolve();
    expect(readFinished).toBe(false);
    expect(() => withRendererDatabaseStatement(db, sender, () => db.exec('BEGIN'))).toThrow(
      'WORKSPACE_SYNC_DATABASE_BUSY'
    );
    db.transaction(() => db.prepare("UPDATE item SET value = 'accepted'").run())();
    release();
    expect(await read).toEqual({ value: 'accepted' });
  });

  it('cannot be bypassed by comment-prefixed BEGIN or SAVEPOINT statements', async () => {
    const db = createTestDb();
    const release = await acquireWorkspaceSyncDatabaseFence(db);

    for (const sql of ['/* ordinary comment */ BEGIN', '-- ordinary comment\nSAVEPOINT nested']) {
      expect(() => {
        assertRendererDatabaseStatementAllowed(db);
        db.exec(sql);
      }).toThrow('WORKSPACE_SYNC_DATABASE_BUSY');
      expect(db.inTransaction).toBe(false);
    }
    release();
  });

  it('rolls back an abandoned renderer transaction and releases a waiting fence', async () => {
    const db = createTestDb();
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)');
    const senderId = 41;
    const wasInTransaction = db.inTransaction;
    db.exec('BEGIN');
    notifyRendererDatabaseStatementSettled(db, { senderId, wasInTransaction });
    db.exec("INSERT INTO item VALUES (1, 'uncommitted')");

    let entered = false;
    const pendingFence = acquireWorkspaceSyncDatabaseFence(db).then((release) => {
      entered = true;
      return release;
    });
    await Promise.resolve();
    expect(entered).toBe(false);

    expect(rollbackRendererDatabaseTransactionForOwner(db, senderId)).toBe(true);
    const release = await pendingFence;
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM item').get()).toEqual({ count: 0 });
    release();
  });

  it('rejects a custom database operation from another renderer while the owner drains', async () => {
    const db = createTestDb();
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)');
    const owner = createTestRendererSender(41);
    const other = createTestRendererSender(42);

    withRendererDatabaseStatement(db, owner, () => db.exec('BEGIN TRANSACTION'));
    withRendererDatabaseStatement(db, owner, () =>
      db.prepare('INSERT INTO item (id, value) VALUES (?, ?)').run(1, 'owner')
    );

    let fenceEntered = false;
    const fencing = acquireWorkspaceSyncDatabaseFence(db).then((release) => {
      fenceEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(fenceEntered).toBe(false);

    expect(() =>
      withRendererDatabaseStatement(db, other, () =>
        db.prepare('INSERT INTO item (id, value) VALUES (?, ?)').run(2, 'other')
      )
    ).toThrow('DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER');

    withRendererDatabaseStatement(db, owner, () => db.exec('COMMIT'));
    const release = await fencing;
    expect(db.prepare('SELECT id, value FROM item ORDER BY id').all()).toEqual([
      { id: 1, value: 'owner' },
    ]);
    release();
  });

  it('rolls back an abandoned renderer transaction on main-frame navigation', async () => {
    const db = createTestDb();
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)');
    const sender = createTestRendererSender(91);

    withRendererDatabaseStatement(db, sender, () => db.exec('BEGIN TRANSACTION'));
    withRendererDatabaseStatement(db, sender, () =>
      db.prepare('INSERT INTO item (id, value) VALUES (?, ?)').run(1, 'abandoned')
    );
    let fenceEntered = false;
    const fencing = acquireWorkspaceSyncDatabaseFence(db).then((release) => {
      fenceEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(fenceEntered).toBe(false);

    sender.emit('did-start-navigation', {}, 'app://renderer', false, true);
    await Promise.resolve();
    const navigationRolledBack = !db.inTransaction;
    if (!navigationRolledBack) rollbackRendererDatabaseTransactionForOwner(db, sender.id);
    const release = await fencing;

    expect(navigationRolledBack).toBe(true);
    expect(fenceEntered).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM item').get()).toEqual({ count: 0 });
    release();
  });
});
