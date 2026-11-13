import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));

vi.mock('../ipc/database', () => ({
  getDb: () => {
    if (!mocks.db) throw new Error('test database not initialized');
    return mocks.db;
  },
}));

import { ensureSchema } from '../schema';
import { registerLimsEntityInDb, registerLimsIpcHandlers, seedLimsBuiltinsInDb } from '../lims';
import { workspaceMutationCapabilities } from '../ipc/workspace-mutation-capability';
import {
  acquireWorkspaceSyncMutationLease,
  tryAcquireWorkspaceMutationShared,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import {
  acquireWorkspaceSyncDatabaseFence,
  notifyRendererDatabaseStatementSettled,
} from '../workspace-sync-database-fence';
import { readLimsAuditExportRowsFromWorkspace } from '../lims-git-export';
import { createTestDb } from './test-db';

describe('LIMS IPC workspace-sync mutation lease', () => {
  let db: Database.Database;
  let workspaceRoot: string;

  beforeEach(() => {
    mocks.handlers.clear();
    db = createTestDb();
    mocks.db = db;
    ensureSchema(db, ':memory:');
    workspaceRoot = join(mkdtempSync(join(tmpdir(), 'lims-sync-lease-')), 'repo');
    mkdirSync(workspaceRoot);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Lease fixture', ?, 'workspace-a', 1, 1)`
    ).run(workspaceRoot);
    registerLimsIpcHandlers();
  });

  it('queues a dedicated LIMS mutation while a replica holds the exclusive workspace lease', async () => {
    const ensureSeeded = mocks.handlers.get('lims:ensureSeeded');
    if (!ensureSeeded) throw new Error('lims:ensureSeeded handler was not registered');
    const sender = Object.assign(new EventEmitter(), { id: 76 });
    const releasePull = await acquireWorkspaceSyncMutationLease(workspaceRoot);
    let mutationSettled = false;
    const mutation = Promise.resolve(ensureSeeded({ sender })).finally(() => {
      mutationSettled = true;
    });

    await Promise.resolve();
    expect(mutationSettled).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_schema`).get()).toEqual({ count: 0 });

    releasePull();
    await expect(mutation).resolves.toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_schema`).get()).toEqual({ count: 38 });
  });

  it('records workspace-less telemetry without holding a foreground root while another root is busy', async () => {
    const logTelemetry = mocks.handlers.get('lims:logTelemetry');
    if (!logTelemetry) throw new Error('lims:logTelemetry handler was not registered');
    const otherRoot = join(workspaceRoot, '..', 'z-other');
    mkdirSync(otherRoot);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (2, 'Other workspace', ?, 'workspace-b', 1, 1)`
    ).run(otherRoot);
    const releaseOther = await acquireWorkspaceSyncMutationLease(otherRoot);
    const sender = Object.assign(new EventEmitter(), { id: 80 });
    let settled = false;
    const telemetry = Promise.resolve(
      logTelemetry({ sender }, { eventType: 'badge_consulted', subjectId: 'sequence-1' })
    ).finally(() => {
      settled = true;
    });

    try {
      await setImmediate();
      expect(settled).toBe(true);
      expect(
        db
          .prepare('SELECT event_type,workspace_id FROM lims_audit WHERE subject_id=?')
          .get('sequence-1')
      ).toEqual({ event_type: 'badge_consulted', workspace_id: null });
      expect(readLimsAuditExportRowsFromWorkspace(workspaceRoot)).toEqual([]);
      expect(readLimsAuditExportRowsFromWorkspace(otherRoot)).toEqual([]);
      const releaseForeground = tryAcquireWorkspaceMutationShared(workspaceRoot);
      try {
        expect(releaseForeground).not.toBeNull();
      } finally {
        releaseForeground?.();
      }
    } finally {
      releaseOther();
      await telemetry;
    }
  });

  it('keeps workspace telemetry behind its own replica lease and exports its audit event', async () => {
    const logTelemetry = mocks.handlers.get('lims:logTelemetry');
    if (!logTelemetry) throw new Error('lims:logTelemetry handler was not registered');
    const sender = Object.assign(new EventEmitter(), { id: 81 });
    const releaseReplica = await acquireWorkspaceSyncMutationLease(workspaceRoot);
    let settled = false;
    const telemetry = Promise.resolve(
      logTelemetry({ sender }, { eventType: 'badge_consulted', workspaceId: 1 })
    ).finally(() => {
      settled = true;
    });
    try {
      await setImmediate();
      expect(settled).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual({ count: 0 });
    } finally {
      releaseReplica();
      await telemetry;
    }
    const event = db
      .prepare("SELECT id FROM lims_audit WHERE event_type='badge_consulted' AND workspace_id=1")
      .get();
    expect(event).toBeDefined();
    expect(readLimsAuditExportRowsFromWorkspace(workspaceRoot)).toContainEqual(
      expect.objectContaining(event)
    );
  });

  it('keeps workspace-less telemetry outside a replica-owned SQLite finalization', async () => {
    const logTelemetry = mocks.handlers.get('lims:logTelemetry');
    if (!logTelemetry) throw new Error('lims:logTelemetry handler was not registered');
    const sender = Object.assign(new EventEmitter(), { id: 82 });
    const releaseFence = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      await expect(
        Promise.resolve(logTelemetry({ sender }, { eventType: 'badge_consulted' }))
      ).rejects.toThrow('WORKSPACE_SYNC_DATABASE_BUSY');
      expect(db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual({ count: 0 });
    } finally {
      releaseFence();
    }
  });

  it('rejects a dedicated LIMS read while replica finalization owns SQLite', async () => {
    const listSchemas = mocks.handlers.get('lims:listSchemas');
    if (!listSchemas) throw new Error('lims:listSchemas handler was not registered');
    const sender = Object.assign(new EventEmitter(), { id: 78 });
    const releaseFence = await acquireWorkspaceSyncDatabaseFence(db);

    await expect(async () => listSchemas({ sender })).rejects.toThrow(
      'WORKSPACE_SYNC_DATABASE_BUSY'
    );

    releaseFence();
    const schemas = await listSchemas({ sender });
    expect(Array.isArray(schemas)).toBe(true);
    expect((schemas as unknown[]).length).toBeGreaterThan(0);
  });

  it('queues Registry summaries until native publication releases SQLite, then reads the published record', async () => {
    seedLimsBuiltinsInDb(db);
    const entity = registerLimsEntityInDb(db, {
      kind: 'genome',
      name: 'Before publication',
      fields: { sequence: { mode: 'unresolved' } },
      workspaceId: 1,
    });
    const query = mocks.handlers.get('lims:queryRegistrySummaries');
    if (!query) throw new Error('lims:queryRegistrySummaries handler was not registered');
    const sender = Object.assign(new EventEmitter(), { id: 80 });
    const releaseFence = await acquireWorkspaceSyncDatabaseFence(db);
    const prepare = vi.spyOn(db, 'prepare');
    let settled = false;
    const pending = Promise.resolve()
      .then(() => query({ sender }, { ids: [entity.id] }))
      .finally(() => {
        settled = true;
      });
    void pending.catch(() => {});
    try {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      db.prepare('UPDATE lims_entity SET name = ? WHERE id = ?').run(
        'Published Registry record',
        entity.id
      );
      releaseFence();
      await expect(pending).resolves.toMatchObject({
        totalCount: 1,
        summaries: [{ id: entity.id, name: 'Published Registry record' }],
      });
      expect(db.inTransaction).toBe(false);
    } finally {
      releaseFence();
      prepare.mockRestore();
    }
  });

  it('keeps Registry summaries outside another renderer transaction', async () => {
    const query = mocks.handlers.get('lims:queryRegistrySummaries');
    if (!query) throw new Error('lims:queryRegistrySummaries handler was not registered');
    db.exec('BEGIN');
    notifyRendererDatabaseStatementSettled(db, { senderId: 81, wasInTransaction: false });
    try {
      await expect(Promise.resolve().then(() => query({ sender: { id: 82 } }, {}))).rejects.toThrow(
        'DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER'
      );
      expect(db.inTransaction).toBe(true);
    } finally {
      db.exec('ROLLBACK');
      notifyRendererDatabaseStatementSettled(db);
    }
  });

  it('admits only the prepared renderer capability while the replica lease is exclusive', async () => {
    const ensureSeeded = mocks.handlers.get('lims:ensureSeeded');
    if (!ensureSeeded) throw new Error('lims:ensureSeeded handler was not registered');
    const releasePull = await acquireWorkspaceSyncMutationLease(workspaceRoot);
    const secondWorkspaceRoot = join(mkdtempSync(join(tmpdir(), 'lims-sync-lease-b-')), 'repo');
    mkdirSync(secondWorkspaceRoot);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (2, 'Second active workspace', ?, 'workspace-b', 1, 1)`
    ).run(secondWorkspaceRoot);
    const ownerId = 77;
    const token = workspaceMutationCapabilities.issue(
      ownerId,
      workspaceMutationRootIdentity(workspaceRoot),
      () => undefined
    );

    await expect(
      Promise.resolve(ensureSeeded({ sender: { id: ownerId + 1 } }, token))
    ).rejects.toThrow('WORKSPACE_MUTATION_TOKEN_INVALID');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_schema`).get()).toEqual({ count: 0 });

    await expect(
      Promise.resolve(ensureSeeded({ sender: { id: ownerId } }, token))
    ).resolves.toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_schema`).get()).toEqual({ count: 38 });

    const registerEntity = mocks.handlers.get('lims:registerEntity');
    if (!registerEntity) throw new Error('lims:registerEntity handler was not registered');
    await expect(
      Promise.resolve(
        registerEntity(
          { sender: { id: ownerId } },
          {
            id: 'replica-entity-a',
            kind: 'dna_sequence',
            name: 'Replica entity',
            workspaceId: 1,
            fields: { sequence: { mode: 'unresolved' } },
            actor: 'workspace-reconcile',
          },
          token
        )
      )
    ).resolves.toMatchObject({ id: 'replica-entity-a' });

    workspaceMutationCapabilities.release(token, ownerId);
    releasePull();
  });

  it('admits source-scoped links to reference targets and rejects a different source owner', async () => {
    const workspaceRootB = join(mkdtempSync(join(tmpdir(), 'lims-sync-lease-b-')), 'repo');
    mkdirSync(workspaceRootB);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (2, 'Lease fixture B', ?, 'workspace-b', 1, 1)`
    ).run(workspaceRootB);
    seedLimsBuiltinsInDb(db);
    const from = registerLimsEntityInDb(db, {
      kind: 'genome',
      name: 'Workspace A genome',
      fields: { sequence: { mode: 'unresolved' } },
      workspaceId: 1,
    });
    const to = registerLimsEntityInDb(db, {
      kind: 'genome',
      name: 'Workspace B genome',
      fields: { sequence: { mode: 'unresolved' } },
      workspaceId: 2,
    });
    const linkEntities = mocks.handlers.get('lims:linkEntities');
    if (!linkEntities) throw new Error('lims:linkEntities handler was not registered');
    const ownerId = 79;
    const token = workspaceMutationCapabilities.issue(
      ownerId,
      workspaceMutationRootIdentity(workspaceRoot),
      () => undefined
    );
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=2").run();
    const releasePullB = await acquireWorkspaceSyncMutationLease(workspaceRootB);

    try {
      await expect(
        Promise.resolve(
          linkEntities(
            { sender: { id: ownerId } },
            {
              fromEntityId: from.id,
              toEntityId: to.id,
              type: 'associated_with',
            },
            token
          )
        )
      ).resolves.toMatchObject({ fromEntityId: from.id, toEntityId: to.id });
      db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=2").run();
      await expect(
        Promise.resolve(
          linkEntities(
            { sender: { id: ownerId } },
            { fromEntityId: to.id, toEntityId: from.id, type: 'associated_with' },
            token
          )
        )
      ).rejects.toThrow('WORKSPACE_MUTATION_CROSSES_KNOWN_WORKSPACES');
      expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_link`).get()).toEqual({ count: 1 });
    } finally {
      workspaceMutationCapabilities.release(token, ownerId);
      releasePullB();
    }
  });
});
