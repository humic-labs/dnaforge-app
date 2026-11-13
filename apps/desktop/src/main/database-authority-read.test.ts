import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { assertSharedProjectContentWritable } from './shared-project-write-access';
import {
  assertCommittedDatabaseReadAllowed,
  acquireWorkspaceSyncDatabaseFence,
  withRendererDatabaseStatement,
  notifyRendererDatabaseStatementSettled,
  type RendererDatabaseLifecycleSender,
} from './workspace-sync-database-fence';

let fixture: ReturnType<typeof createFileTestDb>;
function createSender(id: number): RendererDatabaseLifecycleSender {
  const emitter = new EventEmitter();
  type Listener = Parameters<RendererDatabaseLifecycleSender['removeListener']>[1];
  const removals = new Map<string, Map<Listener, () => void>>();
  const remember = (event: string, listener: Listener, remove: () => void): void => {
    const callbacks = removals.get(event) ?? new Map<Listener, () => void>();
    callbacks.set(listener, remove);
    removals.set(event, callbacks);
  };
  return {
    id,
    once: (event, listener) => {
      remember(event, listener, () => emitter.removeListener(event, listener));
      return emitter.once(event, listener);
    },
    on: (event, listener) => {
      remember(event, listener, () => emitter.removeListener(event, listener));
      return emitter.on(event, listener);
    },
    removeListener: (event, listener) => {
      const callbacks = removals.get(event);
      callbacks?.get(listener)?.();
      callbacks?.delete(listener);
      if (callbacks?.size === 0) removals.delete(event);
    },
  };
}
const sender = createSender(813);
const other = createSender(814);
const root = '/owned/authority-read';

beforeEach(() => {
  fixture = createFileTestDb('database-authority-read');
  ensureSchema(fixture.db, fixture.dbPath);
  fixture.db
    .prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,'Authority',?,'scope-7',1)"
    )
    .run(root);
  fixture.db
    .prepare(
      "INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,created_at,updated_at) VALUES(7,'scope-7','account-a','remote-a',0,'viewer',1,1)"
    )
    .run();
});
afterEach(() => fixture.cleanup());

it('reads only committed role state and honors a later committed promotion', () => {
  expect(() => assertCommittedDatabaseReadAllowed(fixture.db)).not.toThrow();
  expect(() => assertSharedProjectContentWritable(fixture.db, root)).toThrow(/view only/);
  withRendererDatabaseStatement(fixture.db, sender, () =>
    fixture.db
      .prepare("UPDATE workspace_sync_bindings SET access_role='editor' WHERE workspace_id=7")
      .run()
  );
  expect(() => assertSharedProjectContentWritable(fixture.db, root)).not.toThrow();
});

it('refuses the initiating renderer own uncommitted promotion without blocking its rollback', () => {
  withRendererDatabaseStatement(fixture.db, sender, () => fixture.db.exec('BEGIN'));
  withRendererDatabaseStatement(fixture.db, sender, () =>
    fixture.db
      .prepare("UPDATE workspace_sync_bindings SET access_role='editor' WHERE workspace_id=7")
      .run()
  );
  expect(() =>
    withRendererDatabaseStatement(fixture.db, sender, () =>
      assertSharedProjectContentWritable(fixture.db, root)
    )
  ).toThrow('DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER');
  withRendererDatabaseStatement(fixture.db, sender, () => fixture.db.exec('ROLLBACK'));
  expect(fixture.db.inTransaction).toBe(false);
  expect(() => assertSharedProjectContentWritable(fixture.db, root)).toThrow(/view only/);
});

it('refuses a foreign renderer transaction before reading authority', () => {
  withRendererDatabaseStatement(fixture.db, sender, () => fixture.db.exec('BEGIN'));
  expect(() => assertCommittedDatabaseReadAllowed(fixture.db)).toThrow(
    'DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER'
  );
  expect(() =>
    withRendererDatabaseStatement(fixture.db, other, () =>
      assertSharedProjectContentWritable(fixture.db, root)
    )
  ).toThrow('DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER');
  withRendererDatabaseStatement(fixture.db, sender, () => fixture.db.exec('ROLLBACK'));
  expect(() => assertCommittedDatabaseReadAllowed(fixture.db)).not.toThrow();
});

it('refuses an ambient untracked transaction rather than inventing a renderer identity', () => {
  fixture.db.exec('BEGIN');
  try {
    expect(() => assertCommittedDatabaseReadAllowed(fixture.db)).toThrow(
      'DATABASE_UNCOMMITTED_AUTHORITY_READ'
    );
    expect(() => assertSharedProjectContentWritable(fixture.db, root)).toThrow(
      'DATABASE_UNCOMMITTED_AUTHORITY_READ'
    );
  } finally {
    fixture.db.exec('ROLLBACK');
    notifyRendererDatabaseStatementSettled(fixture.db);
  }
  expect(() => assertCommittedDatabaseReadAllowed(fixture.db)).not.toThrow();
});

it('honors a held database fence and restores committed authority reads after release', async () => {
  const release = await acquireWorkspaceSyncDatabaseFence(fixture.db);
  try {
    expect(() => assertCommittedDatabaseReadAllowed(fixture.db)).toThrow(
      'WORKSPACE_SYNC_DATABASE_BUSY'
    );
    expect(() => assertSharedProjectContentWritable(fixture.db, root)).toThrow(
      'WORKSPACE_SYNC_DATABASE_BUSY'
    );
  } finally {
    release();
  }
  expect(() => assertSharedProjectContentWritable(fixture.db, root)).toThrow(/view only/);
});
