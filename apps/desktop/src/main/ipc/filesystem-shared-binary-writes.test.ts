import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted<{
  db: Database.Database | undefined;
  temporaryWriteGate:
    | { prefix: string; reached: (path: string) => void; release: Promise<void> }
    | undefined;
  demoteAfterLinkTo: string | undefined;
}>(() => ({ db: undefined, temporaryWriteGate: undefined, demoteAfterLinkTo: undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const afterWrite = async (path: unknown) => {
    const gate = host.temporaryWriteGate;
    if (gate && typeof path === 'string' && path.startsWith(gate.prefix)) {
      host.temporaryWriteGate = undefined;
      gate.reached(path);
      await gate.release;
    }
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...content: Parameters<typeof handle.writeFile>) => {
        await writeFile(...content);
        await afterWrite(args[0]);
      };
      return handle;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      await afterWrite(args[0]);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      if (args[1] === host.demoteAfterLinkTo) {
        host.demoteAfterLinkTo = undefined;
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
        kind === 'home' ? tmpdir() : join(tmpdir(), 'binary-permission-unit-appdata'),
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
import { updateWorkspaceSyncAccessRecord } from '../workspace-sync-access-record';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';

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

let root: string;
const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
function invoke() {
  const fn = new Map(vi.mocked(ipcMain.handle).mock.calls).get('fs:writeWorkspaceBinaryFileAtomic');
  if (!fn) throw new Error('Missing actual binary workspace publication handler');
  return fn(event(), {
    workspaceRoot: root,
    path: join(root, 'incoming', 'sample.bin'),
    content: bytes,
    artifactNoun: 'binary input',
  });
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'shared-binary-publication-')));
  host.db = createTestDb();
  ensureSchema(host.db, ':memory:');
  host.db
    .prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,'Binary owner',?,'binary-project',1)"
    )
    .run(root);
  host.db
    .prepare(
      `INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,access_source,shared_with_others,created_at,updated_at)
    VALUES(7,'binary-project','account','remote',0,'viewer','direct',1,1,1)`
    )
    .run();
  vi.mocked(ipcMain.handle).mockClear();
  registerFilesystemHandlers();
});
afterEach(async () => {
  host.temporaryWriteGate = undefined;
  host.demoteAfterLinkTo = undefined;
  host.db?.close();
  await rm(root, { recursive: true, force: true });
});
describe('shared binary workspace write authority through actual IPC and atomic publisher', () => {
  it.each([0, 1])(
    'refuses viewer binary writes with sync=%s before creating directories or files',
    async (enabled) => {
      host.db!.prepare('UPDATE workspace_sync_bindings SET enabled=?').run(enabled);
      const before = await readdir(root);
      expect(await invoke()).toMatchObject({
        ok: false,
        error: {
          code: 'SHARED_PROJECT_VIEW_ONLY',
          message: expect.stringContaining('This shared project is view only.'),
          partialEffects: [],
        },
      });
      expect(await readdir(root)).toEqual(before);
    }
  );
  it('permits the same binary input after offline editor promotion', async () => {
    expect(await invoke()).toMatchObject({ ok: false });
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const result = await invoke();
    expect(result).toMatchObject({
      ok: true,
      result: {
        path: join(root, 'incoming', 'sample.bin'),
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      },
    });
    expect(await readFile(join(root, 'incoming', 'sample.bin'))).toEqual(Buffer.from(bytes));
  });
  it('refuses a role demoted while the binary write waits for its workspace lease', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const before = await readdir(root);
    const release = await acquireWorkspaceMutationShared(root);
    const pending = invoke();
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBe(1));
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
      release();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: 'SHARED_PROJECT_VIEW_ONLY', partialEffects: [] },
      });
      expect(await readdir(root)).toEqual(before);
    } finally {
      release();
      await pending;
    }
  });
  it('keeps unshared offline binary publication available', async () => {
    host.db!.prepare('DELETE FROM workspace_sync_bindings').run();
    expect(await invoke()).toMatchObject({ ok: true });
    expect(await readFile(join(root, 'incoming', 'sample.bin'))).toEqual(Buffer.from(bytes));
  });
  it('refuses publication after a server role refresh during the completed temporary write', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const directory = join(root, 'incoming');
    await mkdir(directory);
    let releaseWrite = () => {};
    let reachedWrite = (_path: string) => {};
    const reached = new Promise<string>((resolve) => {
      reachedWrite = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    host.temporaryWriteGate = {
      prefix: join(directory, 'sample.bin.tmp-'),
      reached: reachedWrite,
      release,
    };
    const pending = invoke();
    try {
      const temporaryPath = await reached;
      expect(await readFile(temporaryPath)).toEqual(Buffer.from(bytes));
      expect(
        updateWorkspaceSyncAccessRecord(host.db!, {
          workspaceId: 7,
          role: 'viewer',
          source: 'direct',
          nowMs: 2,
        })
      ).toBe(true);
      releaseWrite();
      expect({ response: await pending, files: await readdir(directory) }).toMatchObject({
        response: {
          ok: false,
          error: {
            message: expect.stringContaining('This shared project is view only.'),
            partialEffects: [],
          },
        },
        files: [],
      });
    } finally {
      releaseWrite();
      await pending;
    }
  });
  it('acknowledges the exact binary commit when the server demotes its owner after linking', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const path = join(root, 'incoming', 'sample.bin');
    host.demoteAfterLinkTo = path;
    expect(await invoke()).toMatchObject({
      ok: true,
      result: { path, contentHash: createHash('sha256').update(bytes).digest('hex') },
    });
    expect(host.demoteAfterLinkTo).toBeUndefined();
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
    expect(await readdir(join(root, 'incoming'))).toEqual(['sample.bin']);
    expect(
      host.db!.prepare('SELECT access_role FROM workspace_sync_bindings WHERE workspace_id=7').get()
    ).toEqual({ access_role: 'viewer' });
  });
});

it('retains a standalone selection on its first native file write before any catalog projection exists', async () => {
  host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
  const { createSavedResidueSelectionDocument, serializeSavedResidueSelectionDocument } =
    await import('@waypoint/workspace-editor/saved-residue-selection');
  const { restoreSavedFileSource } = await import('../saved-file-sources');
  const document = createSavedResidueSelectionDocument({
    id: 'selection:stored',
    name: 'Selection',
    color: '#238854',
    revisionId: 'selection:r1',
    createdAt: '2026-01-01T00:00:00Z',
    actor: { kind: 'user' },
    members: [
      {
        id: 'member1',
        scope: { kind: 'polymer' },
        selection: {
          target: {
            moleculeId: 'protein:example',
            moleculeKind: 'protein',
            coordinateSystem: 'residue',
            intervals: [{ start: 0, end: 1 }],
          },
        },
        polymerRevision: {
          moleculeId: 'protein:example',
          moleculeKind: 'protein',
          sequenceDigestSha256: 'example',
        },
      },
    ],
  });
  const content = serializeSavedResidueSelectionDocument(document);
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(
    'fs:writeWorkspaceTextFileAtomic'
  )!;
  const path = join(root, 'new.wpselection.json');
  const saved = await handler(event(), { workspaceRoot: root, path, content, mode: 'create' });
  expect(saved).toMatchObject({ ok: true });
  expect(
    host.db!.prepare('SELECT count(*) FROM catalog_entity_files WHERE path=?').pluck().get(path)
  ).toBe(0);
  await rm(path);
  await restoreSavedFileSource(host.db!, {
    workspaceId: 7,
    entityId: document.id,
    destination: path,
  });
  expect(await readFile(path, 'utf8')).toBe(content);
});
