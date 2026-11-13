import { seedOriginalProjectFixture } from './original-project-fixture';
/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  database: undefined as Database.Database | undefined,
  userData: '',
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => state.userData, getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../ipc/database', () => ({ getDb: () => state.database }));

import { ipcMain } from 'electron';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerLimsIpcHandlers } from '../lims';
import { registerLimsEntityInsideTx, seedLimsBuiltinsInDb } from '../lims-engine-core';
import { prepareDisposableScenarioProfile } from '../scenario-profile';
import { verifyLimsAuditHashChainInDb } from '../lims-projection-rebuild';

let previousArgv: string[];
let previousLease: string | undefined;
const sender = { id: 918, once: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
const snapshot = () =>
  JSON.stringify({
    entities: state.database!.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
    history: state.database!.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
  });

beforeEach(() => {
  previousArgv = process.argv;
  previousLease = process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION;
  process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION = '1';
  state.userData = mkdtempSync(join(tmpdir(), 'dnaforge-scenario-ipc-'));
  process.argv = ['DNAForge', `--user-data-dir=${state.userData}`];
  state.database = createTestDb();
  ensureSchema(state.database, ':memory:');
  seedOriginalProjectFixture(state.database);
  seedLimsBuiltinsInDb(state.database);
  state.database.transaction(() =>
    registerLimsEntityInsideTx(state.database!, {
      id: 'real-owned-record',
      kind: 'oligo',
      name: 'keep me',
      fields: { sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 } },
    })
  )();
  vi.mocked(ipcMain.handle).mockClear();
  registerLimsIpcHandlers();
});
afterEach(() => {
  state.database?.close();
  rmSync(state.userData, { recursive: true, force: true });
  process.argv = previousArgv;
  if (previousLease === undefined) delete process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION;
  else process.env.DNAFORGE_ALLOW_SCENARIO_MUTATION = previousLease;
});

function callHandler(name: string, input?: unknown): unknown {
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(name);
  if (!handler) throw new Error(`Missing production IPC handler ${name}`);
  return handler({ sender } as unknown as Electron.IpcMainInvokeEvent, input);
}

describe('scenario permission is enforced by actual Registry IPC handlers', () => {
  it.each(['lims:resetRegistry', 'lims:seedMockDemo'])(
    '%s refuses an unmarked populated profile despite the permission flag',
    async (name) => {
      writeFileSync(join(state.userData, 'dnaforge.db'), 'existing data is never adopted');
      const before = snapshot();
      await expect(async () => callHandler(name, { reset: true })).rejects.toThrow(
        /disposable LIMS scenario profile/i
      );
      expect(snapshot()).toBe(before);
    }
  );

  it('permits Clear only after startup has approved the exact selected disposable profile', async () => {
    expect(
      prepareDisposableScenarioProfile({
        requested: true,
        argv: process.argv,
        defaultUserData: state.userData,
      })
    ).not.toBeNull();
    await expect(callHandler('lims:resetRegistry')).resolves.toEqual({
      cleared: true,
      entityCount: 0,
    });
    expect(
      state.database!.prepare('SELECT COUNT(*) FROM lims_entity WHERE tombstone = 0').pluck().get()
    ).toBe(0);
    expect(verifyLimsAuditHashChainInDb(state.database!).ok).toBe(true);
  });
});
