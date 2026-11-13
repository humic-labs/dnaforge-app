import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted<{
  db: Database.Database | undefined;
  readGate:
    | { path: string; reached: () => void; release: Promise<void>; skipReads?: number }
    | undefined;
  demoteAfterRenameTo: string | undefined;
}>(() => ({ db: undefined, readGate: undefined, demoteAfterRenameTo: undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const gate = host.readGate;
      if (gate && args[0] === gate.path) {
        if (gate.skipReads) gate.skipReads -= 1;
        else {
          host.readGate = undefined;
          gate.reached();
          await gate.release;
        }
      }
      return actual.readFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (args[1] === host.demoteAfterRenameTo) {
        host.demoteAfterRenameTo = undefined;
        updateWorkspaceSyncAccessRecord(host.db!, {
          workspaceId: 7,
          role: 'viewer',
          source: 'direct',
          nowMs: 2,
        });
      }
    },
  };
});
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return {
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    app: {
      getPath: (kind: string) =>
        kind === 'home' ? tmpdir() : join(tmpdir(), 'notebook-permission-unit-appdata'),
      getVersion: () => 'test',
      on: vi.fn(),
    },
    BrowserWindow: class extends EventEmitter {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
    },
    dialog: { showErrorBox: vi.fn() },
  };
});
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./database', () => ({ getDb: () => host.db }));

import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { registerFilesystemHandlers } from './filesystem';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';
import { publishNotebookPackageV2InMain } from '../notebook-package-authority';
import { updateWorkspaceSyncAccessRecord } from '../workspace-sync-access-record';
import { notebookPackagePaths, buildNotebookPackageDocument } from '../../db/notebook-package';
import type { SerializablePublishNotebookPackageInput } from '../../shared/notebook-package-ipc';

const sender = Object.assign(new BrowserWindow(), {
  webContents: Object.assign(new EventEmitter(), {
    id: 963,
    mainFrame: { url: 'file:///fixture/index.html' },
    getURL: () => 'file:///fixture/index.html',
    isDestroyed: () => false,
    send: vi.fn(),
  }),
}).webContents;
const event = () =>
  ({
    sender,
    senderFrame: sender.mainFrame,
    type: 'frame',
    frameId: 0,
    processId: 0,
    preventDefault: vi.fn(),
    defaultPrevented: false,
  }) satisfies IpcMainInvokeEvent;
const content = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
let root: string;
let packageRoot: string;
let baseline: string;

async function snapshot(directory = packageRoot): Promise<Array<{ path: string; hash: string }>> {
  const result: Array<{ path: string; hash: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await snapshot(path)));
    else
      result.push({
        path: relative(packageRoot, path),
        hash: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function handler(channel: string) {
  const found = new Map(vi.mocked(ipcMain.handle).mock.calls).get(channel);
  if (!found) throw new Error(`Missing actual native handler ${channel}`);
  return found;
}

async function input(): Promise<SerializablePublishNotebookPackageInput> {
  return {
    workspaceRoot: root,
    packageRoot,
    id: 'notebook-1',
    title: 'Notebook',
    content: content('edited body'),
    sourceShape: 'v2-package',
    existingMetadataRaw: await readFile(notebookPackagePaths(packageRoot).metaPath, 'utf8'),
    expectedCanonicalFingerprint: baseline,
    expectedProjectionContent: content('original body'),
  };
}

function pauseRead(path: string, skipReads = 0) {
  let releaseRead = () => {};
  let reachedRead = () => {};
  const reached = new Promise<void>((resolve) => {
    reachedRead = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  host.readGate = { path, reached: reachedRead, release, skipReads };
  return { reached, release: () => releaseRead() };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'viewer-notebook-publication-')));
  packageRoot = join(root, 'Notebook');
  host.db = createTestDb();
  ensureSchema(host.db, ':memory:');
  host.db
    .prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,'Notebook owner',?,'notebook-project',1)"
    )
    .run(root);
  const seeded = await publishNotebookPackageV2InMain({
    workspaceRoot: root,
    packageRoot,
    id: 'notebook-1',
    title: 'Notebook',
    content: content('original body'),
    sourceShape: 'new-package',
  });
  baseline = seeded.canonicalFingerprint;
  host.db
    .prepare(
      `INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,access_source,shared_with_others,created_at,updated_at)
    VALUES(7,'notebook-project','account','remote',0,'viewer','direct',1,1,1)`
    )
    .run();
  vi.mocked(ipcMain.handle).mockClear();
  registerFilesystemHandlers();
});
afterEach(async () => {
  host.readGate = undefined;
  host.demoteAfterRenameTo = undefined;
  host.db?.close();
  await rm(root, { recursive: true, force: true });
});

describe('shared notebook content authority through real IPC and publishers', () => {
  it('refuses viewer content publication with sync disabled without changing canonical bytes', async () => {
    const before = await snapshot();
    await expect(handler('fs:publishNotebookPackageV2')(event(), await input())).rejects.toThrow(
      /shared project is view only/i
    );
    expect(await snapshot()).toEqual(before);
  });
  it('refuses viewer rename preparation without writing a journal', async () => {
    const before = await snapshot();
    await expect(
      handler('fs:prepareNotebookPackageRename')(event(), {
        workspaceRoot: root,
        packageRoot,
        nextPackageRoot: join(root, 'Renamed'),
        title: 'Renamed',
        expectedCanonicalFingerprint: baseline,
      })
    ).rejects.toThrow(/shared project is view only/i);
    expect(await snapshot()).toEqual(before);
  });
  it('allows an offline editor to publish the same captured draft after promotion', async () => {
    const captured = await input();
    await expect(handler('fs:publishNotebookPackageV2')(event(), captured)).rejects.toThrow(
      /view only/i
    );
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const result = await handler('fs:publishNotebookPackageV2')(event(), captured);
    expect(result).toMatchObject({
      changed: true,
      metadata: { id: 'notebook-1', formatVersion: 2 },
    });
    expect(await readFile(notebookPackagePaths(packageRoot).markdownPath, 'utf8')).toContain(
      'edited body'
    );
  });
  it('rechecks a demoted role after waiting for the owning workspace lease', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const before = await snapshot();
    const release = await acquireWorkspaceMutationShared(root);
    const pending = handler('fs:publishNotebookPackageV2')(event(), await input());
    const outcome = Promise.resolve(pending).then(
      (value) => ({ kind: 'accepted', value }),
      (error) => ({ kind: 'refused', message: String(error) })
    );
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBe(1));
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
      release();
      expect(await outcome).toMatchObject({
        kind: 'refused',
        message: expect.stringContaining('This shared project is view only.'),
      });
      expect(await snapshot()).toEqual(before);
    } finally {
      release();
      await outcome;
    }
  });
  it.each(['publication', 'rename preparation'])(
    'refuses %s after a canonical server role refresh during publisher I/O',
    async (operation) => {
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
      const request = await input();
      const before = await snapshot();
      const gate = pauseRead(notebookPackagePaths(packageRoot).markdownPath);
      const pending =
        operation === 'publication'
          ? handler('fs:publishNotebookPackageV2')(event(), request)
          : handler('fs:prepareNotebookPackageRename')(event(), {
              workspaceRoot: root,
              packageRoot,
              nextPackageRoot: join(root, 'Renamed'),
              title: 'Renamed',
              expectedCanonicalFingerprint: baseline,
            });
      const outcome = Promise.resolve(pending).then(
        (value) => ({ kind: 'accepted', value }),
        (error) => ({ kind: 'refused', message: String(error) })
      );
      try {
        await gate.reached;
        expect(
          updateWorkspaceSyncAccessRecord(host.db!, {
            workspaceId: 7,
            role: 'viewer',
            source: 'direct',
            nowMs: 2,
          })
        ).toBe(true);
        gate.release();
        expect(await outcome).toMatchObject({
          kind: 'refused',
          message: expect.stringContaining('This shared project is view only.'),
        });
        expect(await snapshot()).toEqual(before);
      } finally {
        gate.release();
        await outcome;
      }
    }
  );
  it('rechecks current permission at the low-level canonical publication barrier', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const request = await input();
    const paths = notebookPackagePaths(packageRoot);
    const beforeMarkdown = await readFile(paths.markdownPath, 'utf8');
    const beforeMetadata = await readFile(paths.metaPath, 'utf8');
    const gate = pauseRead(paths.markdownPath, 1);
    const outcome = Promise.resolve(handler('fs:publishNotebookPackageV2')(event(), request)).then(
      (value) => ({ kind: 'accepted', value }),
      (error) => ({ kind: 'refused', message: String(error) })
    );
    try {
      await gate.reached;
      updateWorkspaceSyncAccessRecord(host.db!, {
        workspaceId: 7,
        role: 'viewer',
        source: 'direct',
        nowMs: 2,
      });
      gate.release();
      expect(await outcome).toMatchObject({
        kind: 'refused',
        message: expect.stringContaining('This shared project is view only.'),
      });
      expect(await readFile(paths.markdownPath, 'utf8')).toBe(beforeMarkdown);
      expect(await readFile(paths.metaPath, 'utf8')).toBe(beforeMetadata);
    } finally {
      gate.release();
      await outcome;
    }
  });
  it.each(['publication', 'rename preparation'])(
    'acknowledges committed %s and finishes its package after a later demotion',
    async (operation) => {
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
      const request = await input();
      const paths = notebookPackagePaths(packageRoot);
      host.demoteAfterRenameTo =
        operation === 'publication' ? paths.markdownPath : paths.renameJournalPath;
      if (operation === 'publication') {
        expect(await handler('fs:publishNotebookPackageV2')(event(), request)).toMatchObject({
          changed: true,
        });
        expect(await readFile(paths.markdownPath, 'utf8')).toContain('edited body');
        expect(JSON.parse(await readFile(paths.migrationJournalPath, 'utf8'))).toMatchObject({
          state: 'complete',
        });
      } else {
        await expect(
          handler('fs:prepareNotebookPackageRename')(event(), {
            workspaceRoot: root,
            packageRoot,
            nextPackageRoot: join(root, 'Renamed'),
            title: 'Renamed',
            expectedCanonicalFingerprint: baseline,
          })
        ).resolves.toBeUndefined();
        expect(JSON.parse(await readFile(paths.renameJournalPath, 'utf8'))).toMatchObject({
          state: 'prepared',
        });
        expect(await readFile(paths.markdownPath, 'utf8')).toContain('original body');
      }
      expect(host.demoteAfterRenameTo).toBeUndefined();
      expect(
        host
          .db!.prepare('SELECT access_role FROM workspace_sync_bindings WHERE workspace_id=7')
          .get()
      ).toEqual({ access_role: 'viewer' });
      expect((await snapshot()).some((file) => /dnaforge-(tmp|stage)/.test(file.path))).toBe(false);
    }
  );
  it('allows offline editor rename preparation', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    await handler('fs:prepareNotebookPackageRename')(event(), {
      workspaceRoot: root,
      packageRoot,
      nextPackageRoot: join(root, 'Renamed'),
      title: 'Renamed',
      expectedCanonicalFingerprint: baseline,
    });
    expect(
      JSON.parse(await readFile(notebookPackagePaths(packageRoot).renameJournalPath, 'utf8'))
    ).toMatchObject({ state: 'prepared', title: 'Renamed' });
  });
  it('preserves source content when a viewer reads a legacy package through checked migration', async () => {
    const paths = notebookPackagePaths(packageRoot);
    const legacy = buildNotebookPackageDocument({
      id: 'notebook-1',
      title: 'Notebook',
      content: content('original body'),
    });
    await writeFile(paths.metaPath, JSON.stringify(legacy));
    const migrated = await handler('fs:migrateNotebookPackageAtPath')(event(), {
      workspaceRoot: root,
      packageRoot,
    });
    expect(migrated).toMatchObject({
      metadata: { id: 'notebook-1', formatVersion: 2, migration: { fromFormatVersion: 1 } },
      parsed: { content: content('original body') },
    });
    expect(await readFile(paths.markdownPath, 'utf8')).toContain('original body');
    expect(
      host.db!.prepare('SELECT access_role,enabled FROM workspace_sync_bindings').all()
    ).toEqual([{ access_role: 'viewer', enabled: 0 }]);
  });
  it('leaves current-format viewer migration reads available without new publication', async () => {
    const before = await snapshot();
    await expect(
      handler('fs:migrateNotebookPackageAtPath')(event(), { workspaceRoot: root, packageRoot })
    ).resolves.toBeNull();
    expect(await snapshot()).toEqual(before);
  });
  it('leaves checked viewer rename recovery available when no rename is pending', async () => {
    const before = await snapshot();
    await expect(
      handler('fs:recoverNotebookPackageRenameIfNeeded')(event(), {
        workspaceRoot: root,
        packageRoot,
      })
    ).resolves.toBeNull();
    expect(await snapshot()).toEqual(before);
  });
});
