import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { prepareHostedNativeShellLaunch } from './hosted-native-shell-confinement';
import {
  resolveCodexAppServerBinaryAsync,
  verifyCodexAppServerVersion,
  type ResolvedCodexAppServerBinary,
} from './hosted-codex/app-server-binary';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationWaiterCountForTest,
} from './workspace-sync-mutation-lease';
import { HostedNativeToolBroker, hostedNativeScratchSegment } from './hosted-native-tool-broker';
import { withHostedNativeWritablePaths } from './hosted-native-write-admission';
import { assertSafePath, assertSafeWritablePath } from './ipc/path-allowlist';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
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
let other: string;
let scratch: string;
let broker: HostedNativeToolBroker;
let sequence = 0;
let verifiedBinary: Promise<ResolvedCodexAppServerBinary>;
const binding = {
  turnBindingToken: 'shell-boundary-turn',
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
    shellSupervision: 'auto',
  };
}
function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hosted-native-shell-')));
  appPaths.root = base;
  await mkdir(join(base, 'app-data'));
  verifiedBinary = resolveCodexAppServerBinaryAsync({ isPackaged: false }).then(async (binary) => {
    await verifyCodexAppServerVersion(binary);
    return binary;
  });
  await verifiedBinary;
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(join(base, 'case-'));
  workspace = join(root, 'workspace');
  other = join(root, 'reference-project');
  scratch = join(root, 'scratch');
  await mkdir(workspace);
  await mkdir(other);
  await mkdir(scratch);
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run(
    'Writable',
    workspace
  );
  db.prepare(
    "INSERT INTO workspaces(id,name,path,access_mode,created_at) VALUES(8,'Reference',?,'reference',1)"
  ).run(other);
  broker = new HostedNativeToolBroker({
    prepareShellProcess: (request) =>
      prepareHostedNativeShellLaunch({
        db,
        request,
        privateRoot: join(root, 'private-process-policy'),
        resolveBinary: () => verifiedBinary,
      }),
    authorizeTurn: async () => ({ workspacePath: workspace }),
    confirmDestructiveFile: async () => 'once' as const,
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

describe.skipIf(process.platform !== 'darwin')('Hosted native shell filesystem confinement', () => {
  it('preserves project identity against shell and Python writes while allowing scientific content', async () => {
    const marker = join(workspace, '.dnaforge-workspace.json');
    const gitConfig = join(workspace, '.git', 'config');
    await mkdir(join(workspace, '.git'));
    await writeFile(marker, '{"workspaceUuid":"retained-owner"}');
    await writeFile(gitConfig, '[core]\nrepositoryformatversion = 0\n');
    const python = [
      'import pathlib,sys',
      'pathlib.Path("experiment.txt").write_text("permitted-content")',
      'for target in sys.argv[1:]:',
      ' try:',
      '  pathlib.Path(target).write_text("forged-owner")',
      '  print("BYPASS")',
      ' except PermissionError:',
      '  print("DENIED")',
    ].join('\n');
    const result = await broker.execute(
      7,
      request('Bash', {
        command: `python3 -c ${quote(python)} ${quote(marker)} ${quote(gitConfig)}`,
        timeout_ms: 5000,
      })
    );
    expect(await readFile(join(workspace, 'experiment.txt'), 'utf8')).toBe('permitted-content');
    expect(await readFile(marker, 'utf8')).toBe('{"workspaceUuid":"retained-owner"}');
    expect(await readFile(gitConfig, 'utf8')).toBe('[core]\nrepositoryformatversion = 0\n');
    expect((result.output as { stdout: string }).stdout).toBe('DENIED\nDENIED\n');
  });

  it('prevents a writable-cwd shell from changing another reference project by absolute path', async () => {
    const target = join(other, 'retained.txt');
    await writeFile(target, 'original');
    await broker.execute(
      7,
      request('Bash', { command: `printf unauthorized > ${quote(target)}`, timeout_ms: 5000 })
    );
    expect(await readFile(target, 'utf8')).toBe('original');
  });
  it('uses the bundled sandbox for permitted workspace/scratch writes while denying nested and subprocess escapes', async () => {
    const nested = join(workspace, 'nested-reference');
    await mkdir(nested);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,access_mode,created_at) VALUES(9,'Nested',?,'reference',1)"
    ).run(nested);
    const protectedFile = join(nested, 'retained.txt');
    const outside = join(other, 'retained.txt');
    await writeFile(protectedFile, 'nested original');
    await writeFile(outside, 'outside original');
    const python = [
      'import pathlib,sys',
      'pathlib.Path("python-started.txt").write_text("PYTHON_READY")',
      'for operation in ["read", "write"]:',
      ' try:',
      '  path=pathlib.Path(sys.argv[1])',
      '  path.read_text() if operation == "read" else path.write_text("denied")',
      ' except PermissionError:',
      '  print("BLOCKED_"+operation)',
    ].join('\n');
    const command = `printf permitted > allowed.txt; printf denied > ${quote(protectedFile)}; python3 -c ${quote(python)} ${quote(outside)}; printf scratch > "$TMPDIR/result.txt"; cat allowed.txt`;
    const result = await broker.execute(7, request('Bash', { command, timeout_ms: 5000 }));
    expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('permitted');
    expect(await readFile(protectedFile, 'utf8')).toBe('nested original');
    expect(await readFile(outside, 'utf8')).toBe('outside original');
    expect(
      await readFile(
        join(scratch, hostedNativeScratchSegment(binding.turnBindingToken), 'result.txt'),
        'utf8'
      )
    ).toBe('scratch');
    expect(await readFile(join(workspace, 'python-started.txt'), 'utf8')).toBe('PYTHON_READY');
    expect(result.output).toMatchObject({ stdout: 'BLOCKED_read\nBLOCKED_write\npermitted' });
    expect(String((result.output as { stderr: string }).stderr)).toMatch(
      /Operation not permitted|PermissionError/
    );
  });

  it('denies outside-project and native policy reads through the same shell turn scope', async () => {
    const marker = join(other, 'outside-marker.txt');
    await writeFile(marker, 'TASK-OWNED-OUTSIDE-MARKER');
    const result = await broker.execute(
      7,
      request('Bash', {
        command: `cat ${quote(marker)}; cat "$CODEX_HOME/config.toml"`,
        timeout_ms: 5000,
      })
    );
    expect(String((result.output as { stdout: string }).stdout)).not.toContain(
      'TASK-OWNED-OUTSIDE-MARKER'
    );
    expect(String((result.output as { stdout: string }).stdout)).not.toContain(
      '[permissions.dnaforge-native'
    );
    expect(String((result.output as { stderr: string }).stderr)).toMatch(
      /Operation not permitted|Permission denied/
    );
  });

  it('keeps a reference cwd readable without permitting workspace writes', async () => {
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    const file = join(workspace, 'retained.txt');
    await writeFile(file, 'original');
    const result = await broker.execute(
      7,
      request('Bash', {
        command: 'cat retained.txt; printf denied > retained.txt',
        timeout_ms: 5000,
      })
    );
    expect(await readFile(file, 'utf8')).toBe('original');
    expect(result.output).toMatchObject({ stdout: 'original', status: 'failed' });
  });

  it('revalidates access after queue admission and retains the lease through owned process close', async () => {
    const file = join(workspace, 'retained.txt');
    await writeFile(file, 'original');
    const release = await acquireWorkspaceSyncMutationLease(workspace);
    const pending = broker.execute(
      7,
      request('Bash', { command: 'printf denied > retained.txt', timeout_ms: 5000 })
    );
    try {
      await vi.waitFor(() =>
        expect(workspaceMutationWaiterCountForTest(workspace)).toBeGreaterThan(0)
      );
      db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    } finally {
      release();
    }
    await pending;
    expect(await readFile(file, 'utf8')).toBe('original');
    db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=7").run();
    const started = await broker.execute(
      7,
      request('ProcessStart', { command: 'printf started; sleep 30' })
    );
    const id = (started.output as { process_id: string }).process_id;
    let exclusiveAcquired = false;
    const exclusive = acquireWorkspaceSyncMutationLease(workspace).then((close) => {
      exclusiveAcquired = true;
      close();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exclusiveAcquired).toBe(false);
    await broker.execute(7, request('ProcessStop', { process_id: id }));
    await exclusive;
    expect(exclusiveAcquired).toBe(true);
  });

  it('cancels a queued shell launch before starting a process or changing bytes', async () => {
    const file = join(workspace, 'retained.txt');
    await writeFile(file, 'original');
    const release = await acquireWorkspaceSyncMutationLease(workspace);
    const pending = broker.execute(
      7,
      request('Bash', { command: 'printf denied > retained.txt', timeout_ms: 5000 })
    );
    const observed = pending.catch((error: unknown) => error);
    try {
      await vi.waitFor(() =>
        expect(workspaceMutationWaiterCountForTest(workspace)).toBeGreaterThan(0)
      );
      await broker.cancelTurnBinding(binding.turnBindingToken);
      expect(String(await observed)).toMatch(/Stopped before/);
    } finally {
      release();
    }
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('explicitly refuses an unsupported or unverified launcher before any shell process starts', async () => {
    const scratchRoot = join(scratch, hostedNativeScratchSegment(binding.turnBindingToken));
    await mkdir(scratchRoot);
    const input = {
      db,
      request: {
        command: 'printf uncontained',
        cwd: workspace,
        workspacePath: workspace,
        scratchRoot,
        signal: new AbortController().signal,
      },
      privateRoot: join(root, 'private-process-policy'),
      resolveBinary: () => verifiedBinary,
    };
    await expect(prepareHostedNativeShellLaunch({ ...input, platform: 'win32' })).rejects.toThrow(
      /not qualified.*No command was started/
    );
    await expect(
      prepareHostedNativeShellLaunch({
        ...input,
        resolveBinary: async () => {
          throw new Error('digest mismatch');
        },
      })
    ).rejects.toThrow(/could not be verified.*No command was started/);
  });
});
