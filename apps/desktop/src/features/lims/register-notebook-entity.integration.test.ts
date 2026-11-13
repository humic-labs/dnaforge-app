/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type { PlatformBridge } from '../../platform';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  lims: null as PlatformBridge['lims'] | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler);
    }),
  },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../../main/ipc/database', () => ({ getDb: () => state.db }));
vi.mock('../../platform', () => ({ platform: () => ({ lims: state.lims }) }));

import { createTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { createLimsBridgeForDb } from '../../main/__tests__/lims-bridge-for-db';
import { registerLimsIpcHandlers } from '../../main/lims';
import { ensureNotebookRegisteredInLims } from './register-notebook-entity';
import { rehydrateWorkspaceSyncState } from '../../main/workspace-sync-restore';
import { materializeLimsGitReadableExportInDb } from '../../main/lims-git-export';
import { seedLimsBuiltinsInDb } from '../../main/lims-engine-core';
import {
  buildNotebookPackageMetadata,
  serializeNotebookPackageMetadata,
} from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';

const sender = Object.assign(new EventEmitter(), { id: 82719 });
let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'waypoint-notebook-registry-'));
  state.db = createTestDb();
  ensureSchema(state.db, ':memory:');
  state.db
    .prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)')
    .run('Notebook regression fixture', workspaceRoot, 'notebook-regression-workspace');
  state.handlers.clear();
  registerLimsIpcHandlers();
  const base = createLimsBridgeForDb(state.db);
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = state.handlers.get(channel);
    if (!handler) throw new Error(`Missing production handler ${channel}`);
    return handler({ sender }, ...args);
  };
  state.lims = {
    ...base,
    registerEntity: (...args) =>
      invoke('lims:registerEntity', ...args) as ReturnType<typeof base.registerEntity>,
    updateEntity: (...args) =>
      invoke('lims:updateEntity', ...args) as ReturnType<typeof base.updateEntity>,
    archiveEntity: (...args) =>
      invoke('lims:archiveEntity', ...args) as ReturnType<typeof base.archiveEntity>,
    revertEntity: (...args) =>
      invoke('lims:revertEntity', ...args) as ReturnType<typeof base.revertEntity>,
  };
});

function restoreSavedNotebookPackage(): { pageId: string; packagePath: string } {
  const packagePath = join(workspaceRoot, 'Lab notes');
  mkdirSync(join(packagePath, '.forge'), { recursive: true });
  writeFileSync(
    join(packagePath, '.forge', 'notebook.json'),
    serializeNotebookPackageMetadata(
      buildNotebookPackageMetadata({
        id: 'restored-notebook',
        title: 'Lab notes',
        markdownFileName: 'Lab notes.md',
        updatedAt: '2026-08-25T00:00:00.000Z',
      })
    )
  );
  writeFileSync(
    join(packagePath, 'Lab notes.md'),
    serializeNotebookMarkdown({
      identity: { id: 'restored-notebook', title: 'Lab notes', formatVersion: 2 },
      content: { type: 'doc', content: [] },
    }).markdown
  );
  rehydrateWorkspaceSyncState(state.db!, {
    workspaceId: 7,
    workspaceRoot,
    strict: true,
  });
  const page = state.db!.prepare('SELECT id FROM pages').get() as { id: string };
  return { pageId: page.id, packagePath };
}

afterEach(() => {
  state.db?.close();
  state.db = null;
  state.lims = null;
  rmSync(workspaceRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('notebook Registry projection through production IPC and real SQLite', () => {
  it('reconstructs a restored saved notebook through native IPC without rewriting Registry exports', async () => {
    const { pageId, packagePath } = restoreSavedNotebookPackage();
    seedLimsBuiltinsInDb(state.db!);
    const exported = materializeLimsGitReadableExportInDb(state.db!, { workspaceRoot });
    const paths = [
      join(workspaceRoot, '.waypoint', 'lims', 'manifest.json'),
      exported.oligosCsvPath,
      ...exported.logFiles,
    ];
    const before = new Map(paths.map((path) => [path, readFileSync(path)]));
    const logDirectory = join(workspaceRoot, '.waypoint', 'lims', 'log');
    const logsBefore = readdirSync(logDirectory).sort();

    await ensureNotebookRegisteredInLims({
      id: pageId,
      name: 'Lab notes',
      packagePath,
      workspaceId: 7,
    });

    expect(await state.lims!.queryEntities({ id: pageId })).toMatchObject([
      { id: pageId, kind: 'notebook', name: 'Lab notes', workspaceId: 7, fields: { packagePath } },
    ]);
    expect(readdirSync(logDirectory).sort()).toEqual(logsBefore);
    for (const [path, bytes] of before) expect(readFileSync(path), path).toEqual(bytes);
  });

  it('archives a saved notebook package in the Registry and still refuses Registry-only revert', async () => {
    const { pageId, packagePath } = restoreSavedNotebookPackage();
    const registration = { id: pageId, name: 'Lab notes', packagePath, workspaceId: 7 };
    await ensureNotebookRegisteredInLims(registration);

    const archived = await state.lims!.archiveEntity({ id: pageId });
    await ensureNotebookRegisteredInLims(registration);

    expect(await state.lims!.queryEntities({ id: pageId })).toEqual([]);
    expect(await state.lims!.queryEntities({ id: pageId, includeArchived: true })).toMatchObject([
      {
        id: pageId,
        kind: 'notebook',
        name: 'Lab notes',
        tombstone: true,
        archivedAt: archived.archivedAt,
        fields: { packagePath },
      },
    ]);
    await expect(state.lims!.revertEntity({ id: pageId })).rejects.toThrow('owning file operation');
  });

  it('refreshes a rename and external move without changing identity or unrelated metadata', async () => {
    await ensureNotebookRegisteredInLims({
      id: 'notebook-workspace::portable-notebook-id',
      name: 'Before',
      packagePath: join(workspaceRoot, 'Before'),
      workspaceId: 7,
    });
    const before = (
      await state.lims!.queryEntities({ id: 'notebook-workspace::portable-notebook-id' })
    )[0];
    await state.lims!.updateEntity({ id: before.id, fields: { retained: 'Local metadata' } });

    await ensureNotebookRegisteredInLims({
      id: before.id,
      name: 'After',
      packagePath: join(workspaceRoot, 'experiments', 'After'),
      workspaceId: 7,
    });

    const [after] = await state.lims!.queryEntities({ id: before.id });
    expect(after).toMatchObject({
      id: before.id,
      registryId: before.registryId,
      kind: 'notebook',
      name: 'After',
      workspaceId: 7,
      fields: {
        packagePath: join(workspaceRoot, 'experiments', 'After'),
        retained: 'Local metadata',
      },
      tombstone: false,
    });
    expect(after.eventSeq).toBeGreaterThan(before.eventSeq!);
    const historySize = state.db!.prepare('SELECT COUNT(*) AS count FROM lims_audit').get();
    await ensureNotebookRegisteredInLims({
      id: before.id,
      name: 'After',
      packagePath: join(workspaceRoot, 'experiments', 'After'),
      workspaceId: 7,
    });
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual(
      historySize
    );
  });

  it('keeps an archived notebook hidden when its file projection refreshes', async () => {
    await ensureNotebookRegisteredInLims({
      id: 'notebook-workspace::archived-notebook',
      name: 'Before',
      packagePath: join(workspaceRoot, 'Before'),
      workspaceId: 7,
    });
    const archived = await state.lims!.archiveEntity({
      id: 'notebook-workspace::archived-notebook',
    });

    await ensureNotebookRegisteredInLims({
      id: archived.id,
      name: 'Archived After',
      packagePath: join(workspaceRoot, 'After'),
      workspaceId: 7,
    });

    expect(await state.lims!.queryEntities({ id: archived.id })).toEqual([]);
    const [after] = await state.lims!.queryEntities({ id: archived.id, includeArchived: true });
    expect(after).toMatchObject({
      id: archived.id,
      name: 'Archived After',
      tombstone: true,
      archivedAt: archived.archivedAt,
      fields: { packagePath: join(workspaceRoot, 'After') },
      registrationStatus: archived.registrationStatus,
    });
  });

  it('rejects a stale refresh instead of overwriting a later Registry update', async () => {
    await ensureNotebookRegisteredInLims({
      id: 'notebook-workspace::race-notebook',
      name: 'Before',
      packagePath: join(workspaceRoot, 'Before'),
      workspaceId: 7,
    });
    const [before] = await state.lims!.queryEntities({ id: 'notebook-workspace::race-notebook' });
    await state.lims!.updateEntity({ id: before.id, name: 'Later update' });

    await expect(
      state.lims!.updateEntity({
        id: before.id,
        name: 'Stale refresh',
        fields: { packagePath: join(workspaceRoot, 'Stale') },
        actor: 'workspace-reconcile',
        expectedEventSeq: before.eventSeq!,
      })
    ).rejects.toThrow(/version|stale|changed|refresh/i);
    expect((await state.lims!.queryEntities({ id: before.id }))[0].name).toBe('Later update');
  });
});
