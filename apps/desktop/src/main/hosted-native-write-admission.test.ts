import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { HostedNativeToolBroker, hostedNativeScratchSegment } from './hosted-native-tool-broker';
import { withHostedNativeWritablePaths } from './hosted-native-write-admission';
import { assertSafePath, assertSafeWritablePath } from './ipc/path-allowlist';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationWaiterCountForTest,
} from './workspace-sync-mutation-lease';
import type { HostedAiNativeToolRequest } from '../shared/hosted-ai-gateway-ipc';

const appPaths = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) =>
      key === 'userData' ? join(appPaths.root, 'app-data') : appPaths.root,
    getVersion: () => 'test',
  },
}));
let db: Database.Database;
let base: string;
let root: string;
let workspace: string;
let scratch: string;
let broker: HostedNativeToolBroker;
let sequence = 0;
const binding = {
  turnBindingToken: 'write-boundary-turn',
  workflowId: 'workflow',
  runId: 'run',
  turnId: 'turn',
};
function request(toolName: string, input: Record<string, unknown>): HostedAiNativeToolRequest {
  return {
    ...binding,
    operationId: `operation-${++sequence}`,
    toolName,
    input,
    shellSupervision: 'destructive-only',
  };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hosted-native-admission-')));
  appPaths.root = base;
  await mkdir(join(base, 'app-data'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(join(base, 'case-'));
  workspace = join(root, 'workspace');
  scratch = join(root, 'scratch');
  await mkdir(workspace);
  await mkdir(scratch);
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run(
    'Project',
    workspace
  );
  broker = new HostedNativeToolBroker({
    authorizeTurn: async () => ({ workspacePath: workspace }),
    confirmDestructiveFile: async () => 'once',
    resolveSafePath: assertSafePath,
    resolveSafeWritablePath: assertSafeWritablePath,
    withSafeWritablePaths: (paths, operation) =>
      withHostedNativeWritablePaths(db, paths, operation),
    trashPath: (path) => rename(path, path + '.trashed'),
    scratchBase: scratch,
    fetchWeb: async () => {
      throw new Error('No network');
    },
  });
});
afterEach(async () => {
  await broker.cancelOwner(7);
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe('Hosted native workspace write admission', () => {
  it.each(['reference', 'archived', 'trashed'] as const)(
    'retains actual bytes when %s project writes are requested',
    async (classification) => {
      const file = join(workspace, 'retained.txt');
      await writeFile(file, 'original');
      if (classification === 'reference')
        db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
      else
        db.prepare(
          `UPDATE workspaces SET ${classification === 'archived' ? 'archived_at' : 'trashed_at'}=1 WHERE id=7`
        ).run();
      const result = await Promise.allSettled([
        broker.execute(7, request('Write', { file_path: file, content: 'unauthorized' })),
      ]);
      expect({ status: result[0].status, retained: await readFile(file, 'utf8') }).toEqual({
        status: 'rejected',
        retained: 'original',
      });
      if (result[0].status === 'rejected')
        expect(String(result[0].reason)).toMatch(/WORKSPACE_READ_ONLY|WORKSPACE_INACTIVE/);
      await expect(broker.execute(7, request('Read', { file_path: file }))).resolves.toMatchObject({
        output: { content: 'original' },
      });
    }
  );

  it('keeps writable project and scratch operations available', async () => {
    const file = join(workspace, 'created.txt');
    await broker.execute(7, request('Write', { file_path: file, content: 'allowed' }));
    expect(await readFile(file, 'utf8')).toBe('allowed');
    const scratchRoot = join(scratch, hostedNativeScratchSegment(binding.turnBindingToken));
    await broker.execute(
      7,
      request('Write', { file_path: join(scratchRoot, 'calculation.txt'), content: 'scratch' })
    );
    expect(await readFile(join(scratchRoot, 'calculation.txt'), 'utf8')).toBe('scratch');
  });

  it('revalidates project access after a queued workspace mutation acquires its lease', async () => {
    const file = join(workspace, 'retained.txt');
    await writeFile(file, 'original');
    const release = await acquireWorkspaceSyncMutationLease(workspace);
    const pending = broker.execute(
      7,
      request('Write', { file_path: file, content: 'queued mutation' })
    );
    try {
      await vi.waitFor(
        () => expect(workspaceMutationWaiterCountForTest(workspace)).toBeGreaterThan(0),
        { timeout: 1000 }
      );
      db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    } finally {
      release();
    }
    await expect(pending).rejects.toThrow(/WORKSPACE_READ_ONLY/);
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('refuses writable-cwd moves into a protected nested project and follows canonical aliases', async () => {
    const nested = join(workspace, 'reference');
    await mkdir(nested);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,access_mode,created_at) VALUES(8,'Reference',?,'reference',1)"
    ).run(nested);
    const source = join(workspace, 'source.txt');
    await writeFile(source, 'retained');
    await expect(
      broker.execute(
        7,
        request('Move', { source_path: source, destination_path: join(nested, 'destination.txt') })
      )
    ).rejects.toThrow(/WORKSPACE_READ_ONLY/);
    expect(await readFile(source, 'utf8')).toBe('retained');
    const alias = join(workspace, 'reference-alias');
    await symlink(nested, alias);
    await expect(
      broker.execute(
        7,
        request('Write', { file_path: join(alias, 'denied.txt'), content: 'denied' })
      )
    ).rejects.toThrow(/WORKSPACE_READ_ONLY/);
  });
});
