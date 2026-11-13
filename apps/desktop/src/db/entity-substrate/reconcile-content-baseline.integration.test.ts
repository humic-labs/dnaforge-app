import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from '../../main/__tests__/test-db';
import { settleProjectionSourceForTest } from '../../main/__tests__/projection-receipt-for-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));
vi.mock('../../main/analytics', () => ({ trackEvent: vi.fn() }));
let db: Database.Database;
vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      settleEntityProjectionSource: async (
        input: Parameters<typeof settleProjectionSourceForTest>[1]
      ) => settleProjectionSourceForTest(db, input),
      select: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
      execute: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    },
  }),
}));

import { ensureSchema } from '../../main/schema';
import { contentFingerprint, reconcileEntityFile, type WorkspaceEntityAdapter } from './adapter';
import {
  projectionSourceKey,
  sqliteProjectionSynchronizationStore,
} from './projection-source-state';

type Document = { id: string; body: string };
const ctx = { workspaceRoot: '/project', workspaceId: 7, workspaceScope: 'project-uuid' };
const path = '/project/record.fake';
const bytes = (body: string) => JSON.stringify({ id: 'record-1', body });

function adapter(): WorkspaceEntityAdapter<Document> {
  return {
    kind: 'fake',
    matchesPath: (file) => file.endsWith('.fake'),
    parse: (text) => JSON.parse(text) as Document,
    serialize: JSON.stringify,
    identity: (doc) => doc.id,
    projectionFingerprint: (doc) => contentFingerprint(doc.body),
    getProjection: async (id) => {
      const row = db.prepare('SELECT title, updated_at FROM pages WHERE id = ?').get(id) as
        | { title: string; updated_at: number }
        | undefined;
      return row
        ? { fingerprint: contentFingerprint(row.title), updatedAtMs: row.updated_at }
        : null;
    },
    writeProjection: async (doc, id, mtime) => {
      db.prepare(
        `INSERT INTO pages (id, title, content, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
      ).run(id, doc.body, mtime, mtime);
    },
  };
}

describe('content-based entity convergence across real SQLite reloads', () => {
  let fixture: ReturnType<typeof createFileTestDb>;
  beforeEach(() => {
    fixture = createFileTestDb('entity-common-base');
    db = fixture.db;
    ensureSchema(db, fixture.dbPath);
  });
  afterEach(() => {
    if (db.open && db !== fixture.db) db.close();
    fixture.cleanup();
  });

  const projectedBody = () =>
    (db.prepare('SELECT title FROM pages WHERE id = ?').get('record-1') as { title: string }).title;

  it('applies a file-only edit with the original timestamp after closing and reopening SQLite', async () => {
    await reconcileEntityFile(adapter(), bytes('base'), path, 100, ctx);
    db.close();
    db = openFileTestDb(fixture.dbPath);
    const result = await reconcileEntityFile(adapter(), bytes('file edit'), path, 100, ctx);
    expect(result.outcome).toBe('updated-from-file');
    expect(projectedBody()).toBe('file edit');
  });

  it('applies a file-only edit whose timestamp is older than the last app write', async () => {
    await reconcileEntityFile(adapter(), bytes('base'), path, 900, ctx);
    expect((await reconcileEntityFile(adapter(), bytes('file edit'), path, 1, ctx)).outcome).toBe(
      'updated-from-file'
    );
    expect(projectedBody()).toBe('file edit');
  });

  it('preserves an app-only edit even when touching the unchanged file gives it a newer timestamp', async () => {
    await reconcileEntityFile(adapter(), bytes('base'), path, 100, ctx);
    db.prepare('UPDATE pages SET title = ?, updated_at = ? WHERE id = ?').run(
      'app edit',
      200,
      'record-1'
    );
    expect((await reconcileEntityFile(adapter(), bytes('base'), path, 9999, ctx)).outcome).toBe(
      'conflict'
    );
    expect(projectedBody()).toBe('app edit');
  });

  it('preserves both sides of genuinely divergent edits', async () => {
    await reconcileEntityFile(adapter(), bytes('base'), path, 100, ctx);
    db.prepare('UPDATE pages SET title = ?, updated_at = ? WHERE id = ?').run(
      'app edit',
      200,
      'record-1'
    );
    expect(
      (await reconcileEntityFile(adapter(), bytes('file edit'), path, 9999, ctx)).outcome
    ).toBe('conflict');
    expect(projectedBody()).toBe('app edit');
  });

  it('adopts a matching legacy projection as the base, then accepts later file-only edits', async () => {
    await adapter().writeProjection({ id: 'record-1', body: 'legacy' }, 'record-1', 900, path, ctx);
    expect((await reconcileEntityFile(adapter(), bytes('legacy'), path, 1, ctx)).outcome).toBe(
      'in-sync'
    );
    expect((await reconcileEntityFile(adapter(), bytes('file edit'), path, 1, ctx)).outcome).toBe(
      'updated-from-file'
    );
    expect(projectedBody()).toBe('file edit');
  });

  it('does not invent a baseline for a legacy mismatch, even when the file appears newer', async () => {
    await adapter().writeProjection(
      { id: 'record-1', body: 'unknown app state' },
      'record-1',
      1,
      path,
      ctx
    );
    expect(
      (await reconcileEntityFile(adapter(), bytes('unknown file state'), path, 9999, ctx)).outcome
    ).toBe('conflict');
    expect(projectedBody()).toBe('unknown app state');
  });

  it('settles matching edits on both sides and uses that new common state next time', async () => {
    await reconcileEntityFile(adapter(), bytes('base'), path, 100, ctx);
    db.prepare('UPDATE pages SET title = ? WHERE id = ?').run('matching edit', 'record-1');
    expect(
      (await reconcileEntityFile(adapter(), bytes('matching edit'), path, 100, ctx)).outcome
    ).toBe('in-sync');
    expect(
      (await reconcileEntityFile(adapter(), bytes('next file edit'), path, 1, ctx)).outcome
    ).toBe('updated-from-file');
  });

  it('retains the last successful base when a projection write fails', async () => {
    await reconcileEntityFile(adapter(), bytes('base'), path, 100, ctx);
    const failing = adapter();
    failing.writeProjection = async () => {
      throw new Error('projection write failed');
    };
    await expect(reconcileEntityFile(failing, bytes('file edit'), path, 9999, ctx)).rejects.toThrow(
      'projection write failed'
    );
    expect((await reconcileEntityFile(adapter(), bytes('file edit'), path, 1, ctx)).outcome).toBe(
      'updated-from-file'
    );
    expect(projectedBody()).toBe('file edit');
  });

  it('scopes bases to workspace, relative source path, and fingerprint format', async () => {
    const original = projectionSourceKey(adapter(), 'record-1', path, ctx);
    await sqliteProjectionSynchronizationStore.settle(original, 'base-fingerprint');
    const movedProfile = projectionSourceKey(
      adapter(),
      'record-1',
      '/new-profile/project/record.fake',
      {
        ...ctx,
        workspaceRoot: '/new-profile/project',
      }
    );
    expect(movedProfile).toEqual(original);
    expect(await sqliteProjectionSynchronizationStore.read(movedProfile)).toBe('base-fingerprint');
    for (const isolated of [
      { ...original, workspaceKey: 'another-project' },
      { ...original, relativePath: 'another-source.fake' },
      { ...original, projectionVersion: 2 },
    ]) {
      expect(await sqliteProjectionSynchronizationStore.read(isolated)).toBeNull();
    }
  });

  it('does not advance a base after an adapter reports success without matching content', async () => {
    await reconcileEntityFile(adapter(), bytes('base'), path, 100, ctx);
    const incomplete = adapter();
    incomplete.writeProjection = async () => undefined;
    expect(await reconcileEntityFile(incomplete, bytes('file edit'), path, 1, ctx)).toMatchObject({
      outcome: 'conflict',
      conflictReason: 'projection-write-diverged',
    });
    expect(projectedBody()).toBe('base');
    expect((await reconcileEntityFile(adapter(), bytes('file edit'), path, 1, ctx)).outcome).toBe(
      'updated-from-file'
    );
  });
});
