// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ profile: '', dialog: vi.fn(), exit: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => mocks.profile, isPackaged: false, exit: mocks.exit },
  dialog: { showErrorBox: mocks.dialog },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('better-sqlite3', async (importOriginal) => {
  const original: unknown = await importOriginal();
  if (original === null || typeof original !== 'object' || !('default' in original)) {
    throw new Error('The native database module has no default constructor.');
  }
  const Sqlite = original.default as typeof import('better-sqlite3');
  const { fileURLToPath } = await import('node:url');
  const nativeBinding = fileURLToPath(
    new URL('./__fixtures__/better_sqlite3_node.node', import.meta.url)
  );
  return {
    default: function NativeDatabase(file: string) {
      return new Sqlite(file, { nativeBinding });
    },
  };
});

import { closeDatabase, getDatabaseHealth, getDb } from '../ipc/database';

afterEach(() => {
  closeDatabase();
  if (mocks.profile) rmSync(mocks.profile, { recursive: true, force: true });
  vi.clearAllMocks();
});

it('throws a noninteractive open failure without a dialog or cached broken connection', () => {
  mocks.profile = mkdtempSync(join(tmpdir(), 'native-db-open-'));
  const file = join(mocks.profile, 'dnaforge.db');
  writeFileSync(file, 'This is not a SQLite database.');
  expect(() => getDb({ interactive: false })).toThrow();
  expect(mocks.dialog).not.toHaveBeenCalled();
  expect(mocks.exit).not.toHaveBeenCalled();
  rmSync(file);
  const database = getDb({ interactive: false });
  expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
});

it('retains the existing interactive error presentation for an ordinary app launch', () => {
  mocks.profile = mkdtempSync(join(tmpdir(), 'native-db-open-'));
  writeFileSync(join(mocks.profile, 'dnaforge.db'), 'This is not a SQLite database.');
  expect(() => getDb()).toThrow();
  expect(mocks.dialog).toHaveBeenCalledTimes(1);
  expect(mocks.exit).toHaveBeenCalledWith(1);
});

it('reports diagnostics from the active native connection', () => {
  mocks.profile = mkdtempSync(join(tmpdir(), 'native-db-health-'));
  const database = getDb({ interactive: false });
  database.pragma('user_version = 37');
  expect(getDatabaseHealth()).toMatchObject({
    ok: true,
    error: null,
    connection: { journalMode: 'wal', foreignKeys: 1, schemaVersion: 37 },
  });
  database.pragma('foreign_keys = OFF');
  expect(getDatabaseHealth()).toMatchObject({
    ok: true,
    error: null,
    connection: { journalMode: 'wal', foreignKeys: 0, schemaVersion: 37 },
  });
});
