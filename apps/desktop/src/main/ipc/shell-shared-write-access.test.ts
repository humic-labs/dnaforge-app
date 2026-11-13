import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  git: vi.fn(async (..._args: unknown[]) => ({ exitCode: 0, stdout: 'result', stderr: '' })),
  trash: vi.fn(),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false, on: vi.fn() },
    clipboard: { writeText: vi.fn() },
    shell: { showItemInFolder: vi.fn(), trashItem: host.trash },
    BrowserWindow: class extends EventEmitter {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
    },
  };
});
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../workspace-git/native', async (original) => ({
  ...(await original<typeof import('../workspace-git/native')>()),
  executeManagedGitProcess: async (cwd: string, args: string[], options: unknown) => {
    const result = await host.git(args, cwd, options);
    if (result.exitCode !== 0)
      throw Object.assign(new Error(result.stderr), {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    return result;
  },
}));
vi.mock('./database', () => ({ getDb: () => host.db }));
vi.mock('./path-allowlist', () => ({
  assertSafePath: async (path: string) => path,
  getAllowedRoots: () => ['/tmp'],
  withSafeWritablePath: async (path: string, operation: (path: string) => Promise<unknown>) =>
    operation(path),
}));

import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';
import { registerShellHandlers } from './shell';
import { installNativeDocumentTestProfile } from '../__tests__/native-document-profile-fixture';

installNativeDocumentTestProfile();

let root: string;
let marker: string;
const sender = Object.assign(new BrowserWindow(), {
  webContents: Object.assign(new EventEmitter(), {
    id: 986,
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

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'shared-shell-authority-')));
  marker = join(root, 'notes.txt');
  await writeFile(marker, 'original');
  host.db = createTestDb();
  ensureSchema(host.db, ':memory:');
  host.db
    .prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES (7,'Owner',?,'project',1)"
    )
    .run(root);
  host.db
    .prepare(
      `INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,
    remote_workspace_id,enabled,access_role,access_source,shared_with_others,created_at,updated_at)
    VALUES(7,'project','account','remote',0,'viewer','direct',1,1,1)`
    )
    .run();
  host.git.mockClear();
  host.trash.mockReset();
  host.trash.mockImplementation((path: string) => rm(path));
  vi.mocked(ipcMain.handle).mockClear();
  registerShellHandlers();
});
afterEach(async () => {
  host.db?.close();
  await rm(root, { recursive: true, force: true });
});
function handler(channel: string) {
  const value = new Map(vi.mocked(ipcMain.handle).mock.calls).get(channel);
  if (!value) throw new Error(`Missing actual native handler ${channel}`);
  return value;
}

const mutations = [
  ['init'],
  ['config', 'user.name', 'Fixture'],
  ['checkout', '--', 'notes.txt'],
  ['add', '--', 'notes.txt'],
  ['commit', '-m', 'Fixture'],
] as const;

describe('shared role at actual shell IPC mutation owners', () => {
  it('refuses viewer trash before the operating-system adapter removes bytes', async () => {
    await expect(handler('shell:trashItem')(event(), marker)).rejects.toThrow(
      /shared project is view only/i
    );
    expect(host.trash).not.toHaveBeenCalled();
    expect(await readFile(marker, 'utf8')).toBe('original');
  });
  it.each(mutations)('refuses viewer Git %s before the bundled program starts', async (...args) => {
    await expect(handler('shell:execute')(event(), 'git', args, root)).rejects.toThrow(
      /shared project is view only/i
    );
    expect(host.git).not.toHaveBeenCalled();
    expect(await readFile(marker, 'utf8')).toBe('original');
  });
});

describe('shell reads and valid content access', () => {
  it.each(mutations)('starts the same Git %s request after editor promotion', async (...args) => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    await expect(handler('shell:execute')(event(), 'git', args, root)).resolves.toMatchObject({
      code: 0,
    });
    expect(host.git).toHaveBeenCalledTimes(1);
  });
  it('permits the same trash request after editor promotion', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    await handler('shell:trashItem')(event(), marker);
    expect(host.trash).toHaveBeenCalledTimes(1);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['--version'],
    ['status', '--porcelain'],
    ['log', '--oneline', '-10'],
    ['show', 'HEAD'],
    ['diff', '--stat'],
    ['rev-parse', 'HEAD'],
    ['ls-files', '--full-name', '--', 'notes.txt'],
  ])('keeps viewer Git %s reads available without optional index writes', async (...args) => {
    await expect(handler('shell:execute')(event(), 'git', args, root)).resolves.toMatchObject({
      code: 0,
    });
    expect(host.git).toHaveBeenCalledWith(
      expect.arrayContaining(['--no-optional-locks']),
      root,
      expect.any(Object)
    );
  });
  it('rechecks demotion while a trash request waits for the real workspace lease', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const release = await acquireWorkspaceSyncMutationLease(root);
    const pending = handler('shell:trashItem')(event(), marker);
    const refused = expect(pending).rejects.toThrow(/shared project is view only/i);
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBe(1));
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
    } finally {
      release();
    }
    await refused;
    expect(host.trash).not.toHaveBeenCalled();
    expect(await readFile(marker, 'utf8')).toBe('original');
  });
  it('does not start an author-identity retry after access changes', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    host.git.mockImplementationOnce(async () => {
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
      return { exitCode: 128, stdout: '', stderr: 'Author identity unknown' };
    });
    await expect(
      handler('shell:execute')(event(), 'git', ['commit', '-m', 'Fixture'], root)
    ).resolves.toMatchObject({ code: 127 });
    expect(host.git).toHaveBeenCalledTimes(1);
  });
  it('keeps ordinary unshared project mutations available', async () => {
    host.db!.prepare('DELETE FROM workspace_sync_bindings').run();
    await expect(
      handler('shell:execute')(event(), 'git', ['add', '--', 'notes.txt'], root)
    ).resolves.toMatchObject({ code: 0 });
    expect(host.git).toHaveBeenCalledTimes(1);
  });
});

describe('committed project ownership classification', () => {
  it('does not treat uncommitted project removal as an unmanaged path', async () => {
    host.db!.exec('BEGIN');
    host.db!.prepare('DELETE FROM workspaces WHERE id=7').run();
    try {
      await expect(
        handler('shell:execute')(event(), 'git', ['add', '--', 'notes.txt'], root)
      ).rejects.toThrow(/committed|transaction|database/i);
    } finally {
      host.db!.exec('ROLLBACK');
    }
    expect(await readFile(marker, 'utf8')).toBe('original');
  });
});

describe('read-only Git replica coordination', () => {
  it('waits for replica installation without requiring viewer write access', async () => {
    const release = await acquireWorkspaceSyncMutationLease(root);
    const pending = handler('shell:execute')(event(), 'git', ['status', '--porcelain'], root);
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBe(1));
      expect(host.git).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await expect(pending).resolves.toMatchObject({ code: 0 });
  });
});
