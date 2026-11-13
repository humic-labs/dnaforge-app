import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));
import { backupDatabase, ensureSchema } from './schema';
import {
  ORIGINAL_DEFAULT_PROJECT_SETTING,
  rememberOriginalDefaultProject,
  readOriginalDefaultProjectIdentity,
  resolveOriginalDefaultProject,
  identifyOriginalDefaultProject,
} from './original-default-project';

let db: Database.Database;
let root: string;
let dbPath: string;

function project(id: number, uuid: string, name = 'My Project') {
  const path = join(root, uuid, 'repo');
  mkdirSync(path, { recursive: true });
  db.prepare(
    `INSERT INTO workspaces
      (id, name, path, repo_uuid, created_at, access_mode)
      VALUES (?, ?, ?, ?, ?, 'writable')`
  ).run(id, name, path, uuid, id * 1000);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fixture-default-project-'));
  dbPath = join(root, 'dnaforge.db');
  db = openFileTestDb(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      repo_uuid TEXT UNIQUE, created_at INTEGER NOT NULL,
      access_mode TEXT NOT NULL, archived_at INTEGER, trashed_at INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('original My Project identity', () => {
  it.each(['archived_at', 'trashed_at'] as const)(
    'reads the renamed original UUID without requiring an active project (%s)',
    (column) => {
      project(1, 'original-project', 'Renamed original');
      rememberOriginalDefaultProject(db, 1);
      project(2, 'other-project', 'My Project');
      db.prepare(`UPDATE workspaces SET ${column} = 123 WHERE id = 1`).run();
      const before = db.prepare('SELECT * FROM settings ORDER BY key').all();
      expect(readOriginalDefaultProjectIdentity(db)).toEqual({
        status: 'identified',
        repoUuid: 'original-project',
        evidence: 'stored-identity',
      });
      expect(db.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 2 });
    }
  );

  it('reads exact legacy identity from a trashed project without recording or creating it', () => {
    const originalPath = project(1, 'original-project', 'Renamed original');
    db.prepare('INSERT INTO settings VALUES (?, ?, 1)').run('default_workspace_path', originalPath);
    db.prepare('UPDATE workspaces SET trashed_at = 123 WHERE id = 1').run();
    expect(readOriginalDefaultProjectIdentity(db)).toEqual({
      status: 'identified',
      repoUuid: 'original-project',
      evidence: 'legacy-default-path',
    });
    expect(db.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([
      { key: 'default_workspace_path' },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
  });

  it('retains a recorded original UUID when its project row is missing', () => {
    project(1, 'original-project');
    rememberOriginalDefaultProject(db, 1);
    db.prepare('DELETE FROM workspaces WHERE id = 1').run();
    project(2, 'other-project', 'My Project');
    expect(readOriginalDefaultProjectIdentity(db)).toEqual({
      status: 'identified',
      repoUuid: 'original-project',
      evidence: 'stored-identity',
    });
    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'unresolved',
      reason: 'project-missing',
    });
  });
  it('recognizes a genuinely fresh profile despite its automatic pre-initialization backup', () => {
    const freshPath = join(root, 'fresh', 'dnaforge.db');
    mkdirSync(join(root, 'fresh'));
    const fresh = openFileTestDb(freshPath);
    try {
      fresh.pragma('journal_mode = WAL');
      ensureSchema(fresh, freshPath, { openDatabase: openReadonlyFileTestDb });
      const entries = readdirSync(join(root, 'fresh')).sort();
      expect(
        resolveOriginalDefaultProject(fresh, { openDatabase: openReadonlyFileTestDb })
      ).toMatchObject({ status: 'unresolved', reason: 'identity-not-recorded' });
      expect(readdirSync(join(root, 'fresh')).sort()).toEqual(entries);
    } finally {
      fresh.close();
    }
  });
  it('records an explicit choice of the existing original and refuses a later replacement', () => {
    project(1, 'original-project', 'Renamed original');
    project(2, 'another-project');
    expect(
      identifyOriginalDefaultProject(db, { workspaceId: 1, repoUuid: 'original-project' })
    ).toMatchObject({ status: 'ready', evidence: 'stored-identity', project: { workspaceId: 1 } });
    expect(() =>
      identifyOriginalDefaultProject(db, { workspaceId: 2, repoUuid: 'another-project' })
    ).toThrow(/already identified/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 2 });
  });

  it('rejects a stale explicit choice or unavailable project without storing an identity', () => {
    const path = project(1, 'original-project');
    expect(() =>
      identifyOriginalDefaultProject(db, { workspaceId: 1, repoUuid: 'stale-uuid' })
    ).toThrow(/changed|match/);
    rmSync(path, { recursive: true });
    expect(() =>
      identifyOriginalDefaultProject(db, { workspaceId: 1, repoUuid: 'original-project' })
    ).toThrow(/unavailable/);
    expect(
      db.prepare('SELECT value FROM settings WHERE key = ?').get(ORIGINAL_DEFAULT_PROJECT_SETTING)
    ).toBeUndefined();
  });

  it('recovers the original UUID from an unchanged retained backup after marker removal, rename and move', () => {
    const originalPath = project(1, 'original-project');
    db.prepare('INSERT INTO settings VALUES (?, ?, 1)').run('default_workspace_path', originalPath);
    db.pragma('user_version = 36');
    const backupPath = backupDatabase(db, dbPath)!;
    expect(backupPath).toBeTruthy();
    db.prepare('DELETE FROM settings WHERE key = ?').run('default_workspace_path');
    db.pragma('user_version = 38');
    const moved = join(root, 'moved-original');
    renameSync(join(root, 'original-project'), moved);
    db.prepare('UPDATE workspaces SET name = ?, path = ? WHERE id = 1').run(
      'Renamed original',
      join(moved, 'repo')
    );
    project(2, 'another-project', 'My Project');
    const before = readFileSync(backupPath);
    const currentBefore = readFileSync(dbPath);
    const entries = readdirSync(root).sort();
    const openDatabase = vi.fn((path: string) => openReadonlyFileTestDb(path));
    expect(resolveOriginalDefaultProject(db, { openDatabase })).toMatchObject({
      status: 'ready',
      evidence: 'legacy-backup',
      project: {
        workspaceId: 1,
        repoUuid: 'original-project',
        displayName: 'Renamed original',
        rootPath: join(moved, 'repo'),
      },
    });
    expect(readOriginalDefaultProjectIdentity(db, { openDatabase })).toEqual({
      status: 'identified',
      repoUuid: 'original-project',
      evidence: 'legacy-backup',
    });
    expect(openDatabase).toHaveBeenCalled();
    expect(openDatabase.mock.calls.every(([path]) => path !== backupPath)).toBe(true);
    expect(readFileSync(backupPath)).toEqual(before);
    expect(readFileSync(dbPath)).toEqual(currentBefore);
    expect(readdirSync(root).sort()).toEqual(entries);
    expect(existsSync(backupPath + '-wal')).toBe(false);
    expect(existsSync(backupPath + '-shm')).toBe(false);
    expect(
      db.prepare('SELECT value FROM settings WHERE key = ?').get(ORIGINAL_DEFAULT_PROJECT_SETTING)
    ).toBeUndefined();
    rememberOriginalDefaultProject(db, 1);
    openDatabase.mockClear();
    expect(resolveOriginalDefaultProject(db, { openDatabase })).toMatchObject({
      status: 'ready',
      evidence: 'stored-identity',
      project: { workspaceId: 1 },
    });
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('reports conflicting retained default identities rather than choosing a backup by date or name', () => {
    const original = project(1, 'original-project');
    const replacement = project(2, 'replacement-project');
    db.prepare('INSERT INTO settings VALUES (?, ?, 1)').run('default_workspace_path', original);
    db.pragma('user_version = 36');
    const first = backupDatabase(db, dbPath)!;
    renameSync(first, join(root, 'dnaforge-backup-v36-1.db'));
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      replacement,
      'default_workspace_path'
    );
    expect(backupDatabase(db, dbPath)).toBeTruthy();
    db.prepare('DELETE FROM settings WHERE key = ?').run('default_workspace_path');
    expect(
      resolveOriginalDefaultProject(db, { openDatabase: openReadonlyFileTestDb })
    ).toMatchObject({
      status: 'unresolved',
      reason: 'conflicting-evidence',
    });
  });

  it('reports an unreadable backup without choosing a same-named project or changing the source', () => {
    project(1, 'not-proven-original');
    const backup = join(root, 'dnaforge-backup-v36-1.db');
    writeFileSync(backup, 'unreadable retained backup');
    expect(
      resolveOriginalDefaultProject(db, { openDatabase: openReadonlyFileTestDb })
    ).toMatchObject({
      status: 'unresolved',
      reason: 'evidence-unreadable',
    });
    expect(readFileSync(backup, 'utf8')).toBe('unreadable retained backup');
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
  });

  it('keeps the original after rename and another project takes its old name', () => {
    const originalPath = project(1, 'original-project');
    rememberOriginalDefaultProject(db, 1);
    db.prepare('UPDATE workspaces SET name = ? WHERE id = 1').run('Renamed original');
    project(2, 'selected-project');

    expect(resolveOriginalDefaultProject(db)).toEqual({
      status: 'ready',
      project: {
        workspaceId: 1,
        repoUuid: 'original-project',
        rootPath: originalPath,
        displayName: 'Renamed original',
        createdAt: 1000,
      },
      evidence: 'stored-identity',
    });
    expect(() => rememberOriginalDefaultProject(db, 2)).toThrow(/already identified/i);
  });

  it('follows the original UUID after a project move', () => {
    project(1, 'original-project');
    rememberOriginalDefaultProject(db, 1);
    const movedPath = join(root, 'moved', 'repo');
    mkdirSync(movedPath, { recursive: true });
    db.prepare('UPDATE workspaces SET path = ? WHERE id = 1').run(movedPath);

    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'ready',
      project: { workspaceId: 1, rootPath: movedPath },
    });
  });

  it('accepts the explicit former default path as migration evidence', () => {
    const originalPath = project(1, 'original-project', 'Renamed original');
    project(2, 'other-project');
    db.prepare('INSERT INTO settings VALUES (?, ?, 1)').run('default_workspace_path', originalPath);

    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'ready',
      project: { workspaceId: 1 },
      evidence: 'legacy-default-path',
    });

    expect(
      db.prepare('SELECT value FROM settings WHERE key = ?').get(ORIGINAL_DEFAULT_PROJECT_SETTING)
    ).toBeUndefined();
  });

  it('does not infer the original from its name or which project is newest', () => {
    project(1, 'older-project', 'Renamed project');
    project(2, 'newer-project');
    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'unresolved',
      reason: 'identity-not-recorded',
    });
  });

  it.each(['archived_at', 'trashed_at'] as const)(
    'keeps the identity and reports %s instead of switching projects',
    (column) => {
      project(1, 'original-project');
      rememberOriginalDefaultProject(db, 1);
      project(2, 'other-project');
      db.prepare(`UPDATE workspaces SET ${column} = 123 WHERE id = 1`).run();
      expect(resolveOriginalDefaultProject(db)).toMatchObject({
        status: 'unresolved',
        reason: column === 'archived_at' ? 'project-archived' : 'project-trashed',
      });
    }
  );

  it('never substitutes a different project if the original is missing', () => {
    project(1, 'original-project');
    rememberOriginalDefaultProject(db, 1);
    db.prepare('DELETE FROM workspaces WHERE id = 1').run();
    project(2, 'other-project');
    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'unresolved',
      reason: 'project-missing',
    });
  });

  it('refuses an invalid stored identity without falling back to an old path', () => {
    const originalPath = project(1, 'original-project');
    db.prepare('INSERT INTO settings VALUES (?, ?, 1)').run(
      ORIGINAL_DEFAULT_PROJECT_SETTING,
      '{"version":99,"repoUuid":"original-project"}'
    );
    db.prepare('INSERT INTO settings VALUES (?, ?, 1)').run('default_workspace_path', originalPath);
    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'unresolved',
      reason: 'invalid-identity',
    });
  });
});
