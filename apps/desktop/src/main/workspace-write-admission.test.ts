/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  root: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  app: {
    getPath: (name: string) => (name === 'home' ? state.root : join(state.root, name)),
    on: vi.fn(),
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('./ipc/database', async (original) => ({
  ...(await original<object>()),
  getDb: () => state.db!,
}));

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { registerFilesystemHandlers } from './ipc/filesystem';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { withDeclaredRendererWorkspaceMutation } from './ipc/workspace-mutation-authority';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationWaiterCountForTest,
} from './workspace-sync-mutation-lease';

let project = '';
let target = '';
const sender = Object.assign(new EventEmitter(), { id: 18819, isDestroyed: () => false });

beforeAll(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'dnaforge-entity-write-'));
});
afterAll(async () => {
  await rm(state.root, { recursive: true, force: true });
});
beforeEach(async () => {
  project = await mkdtemp(join(state.root, 'project-'));
  target = join(project, 'document.txt');
  await writeFile(target, 'retained contents');
  state.db = createTestDb();
  ensureSchema(state.db, ':memory:');
  state.db
    .prepare('INSERT INTO workspaces(id,name,path,created_at,access_mode) VALUES(1,?,?,1,?)')
    .run('Project', project, 'writable');
  state.handlers.clear();
  registerFilesystemHandlers();
});

afterEach(async () => {
  state.db?.close();
  state.db = null;
  await rm(project, { recursive: true, force: true });
  await rm(join(state.root, 'alias'), { force: true });
});

describe('native workspace write admission', () => {
  it.each(['reference', 'archived', 'trashed'] as const)(
    'refuses actual generic filesystem writes for a %s owner and retains bytes',
    async (stateName) => {
      if (stateName === 'reference')
        state.db!.prepare("UPDATE workspaces SET access_mode='reference'").run();
      else
        state
          .db!.prepare(
            `UPDATE workspaces SET ${stateName === 'archived' ? 'archived_at' : 'trashed_at'}=3`
          )
          .run();
      await expect(
        Promise.resolve(state.handlers.get('fs:writeTextFile')!({ sender }, target, 'replacement'))
      ).rejects.toThrow(/WORKSPACE_READ_ONLY|WORKSPACE_INACTIVE/);
      expect(await readFile(target, 'utf8')).toBe('retained contents');
      expect(await state.handlers.get('fs:readTextFile')!({ sender }, target)).toBe(
        'retained contents'
      );
    }
  );

  it('applies the same owner refusal to native sequence publication', async () => {
    state.db!.prepare("UPDATE workspaces SET access_mode='reference'").run();
    await expect(
      Promise.resolve(
        state.handlers.get('fs:saveSequenceDocument')!(
          { sender },
          { documentId: 'sequence-id', sourcePath: target }
        )
      )
    ).rejects.toThrow(/WORKSPACE_READ_ONLY/);
    expect(await readFile(target, 'utf8')).toBe('retained contents');
  });

  it('resolves aliases and refuses a nested writable row from overriding a reference parent', async () => {
    const alias = join(state.root, 'alias');
    await symlink(project, alias);
    state.db!.prepare("UPDATE workspaces SET access_mode='reference'").run();
    state
      .db!.prepare('INSERT INTO workspaces(id,name,path,created_at,access_mode) VALUES(2,?,?,1,?)')
      .run('Nested', join(project, 'nested'), 'writable');
    expect(() => assertWorkspaceWriteAllowed(state.db!, [join(alias, 'document.txt')])).toThrow(
      /WORKSPACE_READ_ONLY/
    );
    expect(() =>
      assertWorkspaceWriteAllowed(state.db!, [join(project, 'nested', 'document.txt')])
    ).toThrow(/WORKSPACE_READ_ONLY/);
  });

  it('rechecks access after waiting for the project lease before any actual write', async () => {
    const release = await acquireWorkspaceSyncMutationLease(project);
    const write = withDeclaredRendererWorkspaceMutation({
      db: state.db!,
      ownerId: sender.id,
      workspaceRoot: project,
      mutationPaths: [target],
      fileWrite: true,
      operation: () => writeFile(target, 'replacement'),
    });
    const settled = write.then(
      () => null,
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(project)).toBe(1));
    state.db!.prepare("UPDATE workspaces SET access_mode='reference'").run();
    release();
    expect(await settled).toMatchObject({
      message: expect.stringContaining('WORKSPACE_READ_ONLY'),
    });
    expect(await readFile(target, 'utf8')).toBe('retained contents');
  });

  it('allows the actual generic write for an active writable project', async () => {
    await state.handlers.get('fs:writeTextFile')!({ sender }, target, 'replacement');
    expect(await readFile(target, 'utf8')).toBe('replacement');
  });
});

describe('native managed project structure authority', () => {
  async function managedProject() {
    await rm(project, { recursive: true, force: true });
    const uuid = randomUUID();
    project = join(state.root, 'userData', 'managed-workspaces', uuid, 'repo');
    target = join(project, 'document.txt');
    await mkdir(join(project, '.git'), { recursive: true });
    await writeFile(target, 'retained contents');
    await writeFile(join(project, '.git', 'config'), 'retained git identity');
    await writeFile(
      join(project, '.dnaforge-workspace.json'),
      JSON.stringify({ schema: 1, workspaceUuid: uuid, originPath: null, importedAt: 1 })
    );
    state
      .db!.prepare('UPDATE workspaces SET path = ?, repo_uuid = ? WHERE id = 1')
      .run(project, uuid);
  }

  it('refuses generic directory creation in the app-owned managed project parent', async () => {
    await managedProject();
    const attempted = join(dirname(dirname(project)), 'forged-project', 'repo');
    await expect(
      Promise.resolve(state.handlers.get('fs:mkdir')!({ sender }, attempted, { recursive: true }))
    ).rejects.toThrow(/PROJECT|managed|project/i);
    await expect(access(attempted)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('retained contents');
  });

  it('refuses a generic rename of the registered managed project root', async () => {
    await managedProject();
    const attempted = join(dirname(project), 'replacement-root');
    await expect(
      Promise.resolve(state.handlers.get('fs:rename')!({ sender }, project, attempted))
    ).rejects.toThrow(/PROJECT|managed|project/i);
    await expect(access(attempted)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('retained contents');
    expect(state.db!.prepare('SELECT path FROM workspaces WHERE id = 1').get()).toEqual({
      path: project,
    });
  });

  it.each(['.dnaforge-workspace.json', '.git/config'])(
    'refuses generic writes to project identity metadata %s',
    async (relativePath) => {
      await managedProject();
      const metadata = join(project, relativePath);
      const before = await readFile(metadata, 'utf8');
      await expect(
        Promise.resolve(
          state.handlers.get('fs:writeTextFile')!({ sender }, metadata, 'forged identity')
        )
      ).rejects.toThrow(/PROJECT|managed|project/i);
      expect(await readFile(metadata, 'utf8')).toBe(before);
    }
  );

  it('applies the metadata refusal through a symlink alias', async () => {
    await managedProject();
    const alias = join(state.root, 'alias');
    await symlink(project, alias);
    const metadata = join(project, '.dnaforge-workspace.json');
    const before = await readFile(metadata, 'utf8');
    await expect(
      Promise.resolve(
        state.handlers.get('fs:writeTextFile')!(
          { sender },
          join(alias, '.dnaforge-workspace.json'),
          'forged identity'
        )
      )
    ).rejects.toThrow(/PROJECT|managed|project/i);
    expect(await readFile(metadata, 'utf8')).toBe(before);
  });

  it('allows ordinary folders and generic content writes inside the registered project', async () => {
    await managedProject();
    const contents = join(project, 'Experiments');
    await state.handlers.get('fs:mkdir')!({ sender }, contents);
    const report = join(contents, 'results.txt');
    await state.handlers.get('fs:writeTextFile')!({ sender }, report, 'Scientific results.');
    expect(await readFile(report, 'utf8')).toBe('Scientific results.');
    expect(await readFile(target, 'utf8')).toBe('retained contents');
  });
});
