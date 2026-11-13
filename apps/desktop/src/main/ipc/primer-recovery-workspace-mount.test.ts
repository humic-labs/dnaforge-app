/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
  },
  dialog: { showErrorBox: vi.fn() },
  app: {
    getPath: () => join(tmpdir(), 'primer-recovery-app-data'),
    getVersion: () => 'test',
    exit: vi.fn(),
  },
}));
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { acquireWorkspaceSyncDatabaseFence } from '../workspace-sync-database-fence';
import { registerDatabaseHandlers } from './database';

it.each([false, true])(
  'mounting a recovered project waits for publication and checks current database (changed=%s)',
  async (changed) => {
    const db = createTestDb(),
      replacement = createTestDb();
    ensureSchema(db, ':memory:');
    ensureSchema(replacement, ':memory:');
    const root = mkdtempSync(join(tmpdir(), 'primer-recovered-mount-'));
    const sender = Object.assign(new EventEmitter(), { id: 4108 });
    let current = db;
    registerDatabaseHandlers(() => current);
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      let settled = false;
      const pending = Promise.resolve()
        .then(() => handlers.get('db:ensureWorkspaceOwner')!({ sender }, root))
        .then(
          (value) => {
            settled = true;
            return { value };
          },
          (error) => {
            settled = true;
            return { error };
          }
        );
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
      if (changed) current = replacement;
      release();
      const outcome = await pending;
      if (changed) {
        expect(outcome).toHaveProperty('error');
        expect(String('error' in outcome && outcome.error)).toContain('database changed');
        expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
        expect(replacement.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
      } else {
        expect(outcome).not.toHaveProperty('error');
        expect('value' in outcome && outcome.value).toBeGreaterThan(0);
        expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
      }
    } finally {
      release();
      db.close();
      replacement.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
