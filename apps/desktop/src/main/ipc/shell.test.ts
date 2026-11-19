import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { shell } from 'electron';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GIT_READ_MAX_PATH_CODE_UNITS, GIT_READ_MAX_QUEUED } from './git-read-policy';
import { runWorkspaceFileTrash } from '../workspace-file-trash';
import type { ProjectHistoryResult } from '../../shared/project-history';

const databaseHost = vi.hoisted(() => ({ db: null as Database.Database | null }));
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const clipboardWriteText = vi.hoisted(() => vi.fn());
const mockReadGitHeadFromAllowedRoots = vi.hoisted(() => vi.fn());
const mockResolveGitReadWorkerPath = vi.hoisted(() => vi.fn(() => '/test/git-read-worker.cjs'));
const mockResolveGitReadProcessGuardian = vi.hoisted(() =>
  vi.fn(() => 'C:\\test\\dna-process-guardian.exe')
);
const TEST_ALLOWED_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'shell-project-admission-')));
const TEST_REPO_ROOT = resolve(TEST_ALLOWED_ROOT, 'repo');
const TEST_OTHER_ROOT = resolve(TEST_ALLOWED_ROOT, 'x');
let projectDb: Database.Database;

beforeAll(() => {
  projectDb = createTestDb();
  ensureSchema(projectDb, ':memory:');
  mkdirSync(TEST_REPO_ROOT);
  mkdirSync(TEST_OTHER_ROOT);
});

async function openTestProject(root: string, db: Database.Database) {
  const { resolveProjectRootInMain } = await import('../project-filesystem-authority');
  await resolveProjectRootInMain(
    { path: root },
    { db, managedRootDir: join(TEST_ALLOWED_ROOT, 'managed-workspaces') }
  );
}

beforeEach(async () => {
  databaseHost.db = projectDb;
  await openTestProject(TEST_REPO_ROOT, projectDb);
  await openTestProject(TEST_OTHER_ROOT, projectDb);
});

afterAll(() => {
  databaseHost.db = null;
  projectDb.close();
  rmSync(TEST_ALLOWED_ROOT, { recursive: true, force: true });
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
  clipboard: { writeText: clipboardWriteText },
  shell: { showItemInFolder: vi.fn(), trashItem: vi.fn() },
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/app'),
    getVersion: vi.fn(() => 'test'),
    getPath: vi.fn(() =>
      process.platform === 'win32'
        ? 'C:\\tmp\\dnaforge-test-app-data'
        : process.platform === 'darwin'
          ? '/private/tmp/dnaforge-test-app-data'
          : '/tmp/dnaforge-test-app-data'
    ),
  },
}));

const mockGitExec = vi.fn(
  async (_args: string[], _cwd: string, _options?: { maxBuffer: number }) => ({
    exitCode: 0,
    stdout: 'git version 2.53.0\n',
    stderr: '',
  })
);
vi.mock('../workspace-git/native', () => ({
  executeManagedGitProcess: async (cwd: string, args: string[], options: { maxBuffer: number }) => {
    const result = await mockGitExec(args, cwd, options);
    if (result.exitCode !== 0)
      throw Object.assign(new Error(result.stderr), {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    return result;
  },
}));
vi.mock('./git-read-path-canonicalizer', () => ({
  readGitHeadFromAllowedRoots: mockReadGitHeadFromAllowedRoots,
}));
vi.mock('./git-read-process-guardian', () => ({
  resolveGitReadWorkerPath: mockResolveGitReadWorkerPath,
  resolveGitReadProcessGuardian: mockResolveGitReadProcessGuardian,
}));
vi.mock('./database', () => ({
  getDb: () =>
    databaseHost.db ?? {
      prepare: () => ({ all: () => [] }),
    },
}));
vi.mock('../features/native-documents', () => ({
  nativeDocuments: {
    workspaceCommands: { runHistory: vi.fn() },
    fileDocuments: {
      assertClean: vi.fn(async () => {}),
      withCleanPaths: vi.fn(async (_paths: readonly string[], operation: () => Promise<unknown>) =>
        operation()
      ),
    },
  },
}));

async function getExecuteHandler() {
  const { registerShellHandlers } = await import('./shell');
  registerShellHandlers();
  const handler = ipcHandlers.get('shell:execute');
  if (!handler) throw new Error('shell:execute handler not registered');
  return handler;
}

async function getShellHandler(channel: string) {
  const { registerShellHandlers } = await import('./shell');
  registerShellHandlers();
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`${channel} handler not registered`);
  return handler;
}

function gitReadEvent(senderId = 41) {
  return {
    sender: {
      id: senderId,
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
    },
  };
}

describe('shell:projectHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const reply: ProjectHistoryResult = {
    status: 'failed',
    operation: 'inspect',
    code: 'CONTROLLED_RESULT',
    error: 'Controlled command response',
    stateChanged: false,
    paths: [],
  };

  it('delegates inspection to the native history owner without a write lease', async () => {
    const { nativeDocuments } = await import('../features/native-documents');
    const history = vi
      .spyOn(nativeDocuments.workspaceCommands, 'runHistory')
      .mockResolvedValue(reply);
    const handler = await getShellHandler('shell:projectHistory');
    expect(
      await handler(gitReadEvent(), {
        workspaceRoot: TEST_REPO_ROOT,
        operation: { kind: 'inspect' },
      })
    ).toEqual(reply);
    expect(history).toHaveBeenCalledWith({
      workspaceRoot: TEST_REPO_ROOT,
      operation: { kind: 'inspect', offset: 0, limit: 100 },
    });
  });

  it('keeps history changes behind the requesting renderer mutation owner', async () => {
    const { nativeDocuments } = await import('../features/native-documents');
    const authority = await import('./workspace-mutation-authority');
    const mutation = vi
      .spyOn(authority, 'withDeclaredRendererWorkspaceMutation')
      .mockImplementation(async (request) => request.operation());
    vi.spyOn(nativeDocuments.workspaceCommands, 'runHistory').mockImplementation(
      async (_request, lease) => {
        if (!lease) throw new Error('A renderer write must supply its mutation lease.');
        return lease(async () => reply);
      }
    );
    const handler = await getShellHandler('shell:projectHistory');
    const request = {
      workspaceRoot: TEST_REPO_ROOT,
      mutationToken: 'fixture-token',
      operation: {
        kind: 'stage',
        expectedRevision: `project-history-v1:${'a'.repeat(64)}`,
        paths: ['file.txt'],
      },
    };
    expect(await handler(gitReadEvent(73), request)).toEqual(reply);
    expect(mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 73,
        workspaceRoot: TEST_REPO_ROOT,
        mutationPaths: [TEST_REPO_ROOT],
        mutationToken: 'fixture-token',
      })
    );
  });

  it('rejects an undeclared history operation before invoking the owner', async () => {
    const { nativeDocuments } = await import('../features/native-documents');
    const history = vi.spyOn(nativeDocuments.workspaceCommands, 'runHistory');
    const handler = await getShellHandler('shell:projectHistory');
    await expect(
      handler(gitReadEvent(), {
        workspaceRoot: TEST_REPO_ROOT,
        operation: { kind: 'undeclared' },
      })
    ).rejects.toThrow();
    expect(history).not.toHaveBeenCalled();
  });
});

describe('shell:execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('routes git through the confined owner and maps the process result', async () => {
    const handler = await getExecuteHandler();
    const cwd = TEST_REPO_ROOT;
    const result = (await handler({}, 'git', ['status', '--porcelain'], cwd)) as {
      stdout: string;
      stderr: string;
      code: number;
    };
    expect(mockGitExec).toHaveBeenCalledWith(
      ['--no-optional-locks', 'status', '--porcelain'],
      cwd,
      expect.objectContaining({ maxBuffer: expect.any(Number) })
    );
    expect(result).toEqual({ stdout: 'git version 2.53.0\n', stderr: '', code: 0 });
  });

  it('propagates a non-zero git exit code', async () => {
    mockGitExec.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'fatal: not a repo\n' });
    const handler = await getExecuteHandler();
    const result = (await handler(
      {},
      'git',
      ['rev-parse', '--git-dir'],
      `${TEST_ALLOWED_ROOT}/x`
    )) as {
      code: number;
    };
    expect(result.code).toBe(128);
  });

  it('rejects a non-allowlisted program without running anything', async () => {
    const handler = await getExecuteHandler();
    await expect(handler({}, 'rm', ['-rf', '/'], TEST_ALLOWED_ROOT)).rejects.toThrow(
      'Program not allowed'
    );
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it('routes commits through the confined owner', async () => {
    const handler = await getExecuteHandler();
    await handler({}, 'git', ['commit', '-m', 'x'], TEST_REPO_ROOT);
    expect(mockGitExec).toHaveBeenCalledWith(
      ['commit', '-m', 'x'],
      TEST_REPO_ROOT,
      expect.objectContaining({ maxBuffer: expect.any(Number) })
    );
  });

  it('retries a commit with an app identity when Git has no configured author', async () => {
    mockGitExec
      .mockResolvedValueOnce({
        exitCode: 128,
        stdout: '',
        stderr: 'Author identity unknown\nfatal: unable to auto-detect email address',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'committed', stderr: '' });
    const handler = await getExecuteHandler();
    const result = await handler(
      {},
      'git',
      ['commit', '-m', 'Save oligo', '--', 'gaga.primer.json'],
      TEST_REPO_ROOT
    );
    expect(result).toEqual({ code: 0, stdout: 'committed', stderr: '' });
    expect(mockGitExec).toHaveBeenCalledTimes(2);
    expect(mockGitExec).toHaveBeenLastCalledWith(
      [
        '-c',
        'user.name=DNAForge',
        '-c',
        'user.email=workspace@dnaforge.local',
        'commit',
        '-m',
        'Save oligo',
        '--',
        'gaga.primer.json',
      ],
      TEST_REPO_ROOT,
      expect.objectContaining({ maxBuffer: expect.any(Number) })
    );
  });

  it('preserves a configured Git identity without a retry', async () => {
    const handler = await getExecuteHandler();
    await handler({}, 'git', ['commit', '-m', 'Save oligo'], TEST_REPO_ROOT);
    expect(mockGitExec).toHaveBeenCalledTimes(1);
    expect(mockGitExec.mock.calls[0][0]).not.toContain('user.name=DNAForge');
  });

  it('does not retry unrelated commit failures with a different identity', async () => {
    mockGitExec.mockResolvedValueOnce({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: index.lock exists',
    });
    const handler = await getExecuteHandler();
    expect(await handler({}, 'git', ['commit', '-m', 'Save oligo'], TEST_REPO_ROOT)).toEqual({
      code: 128,
      stdout: '',
      stderr: 'fatal: index.lock exists',
    });
    expect(mockGitExec).toHaveBeenCalledTimes(1);
  });

  it('rejects git config/transport escape-hatch args (RCE vectors) without running git', async () => {
    const handler = await getExecuteHandler();
    for (const bad of [
      ['-c', 'core.pager=evil', 'log'],
      ['ext::sh -c id'],
      ['--upload-pack=evil'],
    ]) {
      await expect(handler({}, 'git', bad, `${TEST_ALLOWED_ROOT}/repo`)).rejects.toThrow(
        'disallowed git argument'
      );
    }
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it('rejects git commands and operands that can mutate outside the leased cwd', async () => {
    const handler = await getExecuteHandler();
    for (const bad of [
      ['init', `${TEST_ALLOWED_ROOT}/other`],
      ['clone', 'https://example.invalid/repo.git', `${TEST_ALLOWED_ROOT}/other`],
      ['archive', `--output=${TEST_ALLOWED_ROOT}/outside.zip`, 'HEAD'],
      ['config', 'core.worktree', `${TEST_ALLOWED_ROOT}/other`],
      ['add', '--', '../outside.txt'],
    ]) {
      await expect(handler({}, 'git', bad, `${TEST_ALLOWED_ROOT}/repo`)).rejects.toThrow(
        /outside the workspace command contract|escapes cwd/
      );
    }
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it('allows the narrowly scoped DevPanel identity configuration', async () => {
    const handler = await getExecuteHandler();
    await handler(
      {},
      'git',
      ['config', 'user.name', 'DNAForge Dev Scenario'],
      `${TEST_ALLOWED_ROOT}/repo`
    );
    expect(mockGitExec).toHaveBeenCalledOnce();
  });

  it('caps git output with an explicit maxBuffer', async () => {
    const handler = await getExecuteHandler();
    const cwd = TEST_REPO_ROOT;
    await handler({}, 'git', ['log', '--oneline', '-10'], cwd);
    expect(mockGitExec).toHaveBeenCalledWith(
      ['--no-optional-locks', 'log', '--oneline', '-10'],
      cwd,
      expect.objectContaining({ maxBuffer: expect.any(Number) })
    );
  });

  it('allows the exact read-only history forms used by the workspace UI', async () => {
    const handler = await getExecuteHandler();
    const cwd = `${TEST_ALLOWED_ROOT}/repo`;
    const format = '%H%x00%s%x00%aI%x00%ar';
    const recentFormat = '%x01%H%x00%aI%x00%ar';

    await handler(
      {},
      'git',
      ['log', `--format=${format}`, '--follow', '-20', '--', 'pUC19.gb'],
      cwd
    );
    await handler(
      {},
      'git',
      ['log', `--format=${recentFormat}`, '--name-only', '-30', '--', '.'],
      cwd
    );
    await handler(
      {},
      'git',
      ['log', '--all', '--follow', '--diff-filter=R', '--format=%H', '-1', '--', 'pUC19.gb'],
      cwd
    );
    await handler(
      {},
      'git',
      ['diff-tree', '--no-commit-id', '-r', '--diff-filter=R', '-M', 'a'.repeat(40)],
      cwd
    );

    expect(mockGitExec).toHaveBeenCalledTimes(4);
  });

  it('keeps history path operands inside the workspace', async () => {
    const handler = await getExecuteHandler();
    const cwd = `${TEST_ALLOWED_ROOT}/repo`;

    await expect(
      handler({}, 'git', ['log', '--format=%H', '--follow', '-20', '--', '../outside.gb'], cwd)
    ).rejects.toThrow('escapes cwd');
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it('validates the git cwd through the shared path allowlist', async () => {
    const handler = await getExecuteHandler();
    await expect(handler({}, 'git', ['status'], '/etc')).rejects.toThrow('Path access denied');
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it('maps a thrown dugite error (missing/unspawnable git) to a non-zero result, not a raw rejection', async () => {
    mockGitExec.mockRejectedValueOnce(
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    );
    const handler = await getExecuteHandler();
    const result = (await handler({}, 'git', ['status'], `${TEST_ALLOWED_ROOT}/repo`)) as {
      code: number;
      stderr: string;
    };
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('ENOENT');
  });
});

describe('shell:readGitHead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadGitHeadFromAllowedRoots.mockReset();
    ipcHandlers.clear();
    mockReadGitHeadFromAllowedRoots.mockImplementation(
      async ({ filePath }: { filePath: string }) => {
        if (filePath === '/etc/blocked.gb') throw new Error('Path access denied');
        return 'LOCUS baseline\n';
      }
    );
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('delegates one owned read transaction and publishes lifecycle settlement', async () => {
    const repo = `${TEST_ALLOWED_ROOT}/repo`;
    const filePath = `${repo}/sequence.gb`;
    const read = await getShellHandler('shell:readGitHead');

    await expect(
      read(gitReadEvent(), filePath, '10000000-0000-4000-8000-000000000001')
    ).resolves.toBe('LOCUS baseline\n');
    expect(mockReadGitHeadFromAllowedRoots).toHaveBeenCalledOnce();
    expect(mockReadGitHeadFromAllowedRoots).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath,
        allowedRoots: expect.arrayContaining([TEST_REPO_ROOT]),
        errorPrefix: 'shell:readGitHead file',
        control: {
          signal: expect.any(AbortSignal),
          bindProcess: expect.any(Function),
        },
        workerScriptPath: '/test/git-read-worker.cjs',
        guardianExecutable: 'C:\\test\\dna-process-guardian.exe',
      })
    );
    expect(mockResolveGitReadWorkerPath).toHaveBeenCalledWith('/app');
    expect(mockResolveGitReadProcessGuardian).toHaveBeenCalledWith(
      expect.objectContaining({ appPath: '/app', isPackaged: false })
    );

    const snapshot = await getShellHandler('shell:getGitReadLifecycleSnapshot');
    await expect(snapshot({})).resolves.toMatchObject({
      active: 0,
      started: 1,
      settled: 1,
      maxActive: 1,
      maxQueued: GIT_READ_MAX_QUEUED,
    });
  });

  it('waits for owner admission before performing path validation or filesystem work', async () => {
    const repo = `${TEST_ALLOWED_ROOT}/repo`;
    const filePath = `${repo}/sequence.gb`;
    let resolveFirstRead: (value: string | null) => void = () => undefined;
    mockReadGitHeadFromAllowedRoots.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRead = resolve;
        })
    );
    const read = await getShellHandler('shell:readGitHead');

    const first = read(gitReadEvent(), filePath, '10000000-0000-4000-8000-000000000001');
    let secondSettled = false;
    const second = Promise.resolve(
      read(gitReadEvent(), '/etc/blocked.gb', '10000000-0000-4000-8000-000000000002')
    ).finally(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => expect(mockReadGitHeadFromAllowedRoots).toHaveBeenCalledTimes(1));

    expect(secondSettled).toBe(false);

    resolveFirstRead('LOCUS baseline\n');
    await expect(first).resolves.toBe('LOCUS baseline\n');
    await expect(second).rejects.toThrow('Path access denied');
    expect(mockReadGitHeadFromAllowedRoots).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized renderer paths before owner admission or retained work', async () => {
    const read = await getShellHandler('shell:readGitHead');
    const oversizedPath = `/${'x'.repeat(GIT_READ_MAX_PATH_CODE_UNITS)}`;

    await expect(
      read(gitReadEvent(), oversizedPath, '10000000-0000-4000-8000-000000000001')
    ).rejects.toThrow('invalid or too large');
    expect(mockReadGitHeadFromAllowedRoots).not.toHaveBeenCalled();

    const snapshot = await getShellHandler('shell:getGitReadLifecycleSnapshot');
    await expect(snapshot({})).resolves.toMatchObject({ active: 0, queued: 0, started: 0 });
  });

  it('rejects malformed cancellation identities before touching an owner', async () => {
    const cancel = await getShellHandler('shell:cancelGitRead');
    await expect(cancel(gitReadEvent(), 'not-a-request-id')).rejects.toThrow(
      'GIT_READ_INVALID_REQUEST_ID'
    );
    await expect(
      cancel(gitReadEvent(), '10000000-0000-4000-8000-000000000001', 'not-a-close-gesture-id')
    ).rejects.toThrow('GIT_READ_INVALID_CLOSE_GESTURE_TOKEN');
  });
});

describe('clipboard:writeText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('writes renderer text through Electron native clipboard', async () => {
    const { registerShellHandlers } = await import('./shell');
    registerShellHandlers();
    const handler = ipcHandlers.get('clipboard:writeText');
    if (!handler) throw new Error('clipboard:writeText handler not registered');

    await handler({}, 'https://dnaforge.com/share/share-token');

    expect(clipboardWriteText).toHaveBeenCalledWith('https://dnaforge.com/share/share-token');
  });

  it('waits for the native clipboard write before acknowledging the renderer', async () => {
    const { registerShellHandlers } = await import('./shell');
    registerShellHandlers();
    const handler = ipcHandlers.get('clipboard:writeText');
    if (!handler) throw new Error('clipboard:writeText handler not registered');
    let release: () => void = () => {};
    clipboardWriteText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    let acknowledged = false;
    const writing = Promise.resolve(handler({}, 'ssh "test-host"')).then(() => {
      acknowledged = true;
    });
    try {
      await Promise.resolve();
      expect(acknowledged).toBe(false);
    } finally {
      release();
      await writing;
    }
    expect(acknowledged).toBe(true);
  });

  it('rejects non-text and oversized clipboard payloads', async () => {
    const { registerShellHandlers } = await import('./shell');
    registerShellHandlers();
    const handler = ipcHandlers.get('clipboard:writeText');
    if (!handler) throw new Error('clipboard:writeText handler not registered');

    await expect(handler({}, 42)).rejects.toThrow('must be a string');
    await expect(handler({}, 'x'.repeat(1_000_001))).rejects.toThrow('too large');
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });
});

describe('registered primer raw shell refusal', () => {
  let root: string;
  let path: string;
  let db: Database.Database;
  const primerId = '10000000-0000-4000-8000-000000000044';
  beforeEach(async () => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    mockGitExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mkdirSync(TEST_ALLOWED_ROOT, { recursive: true });
    root = mkdtempSync(join(TEST_ALLOWED_ROOT, 'primer-shell-'));
    mkdirSync(join(root, '.git'));
    path = join(root, 'retained.primer.json');
    writeFileSync(path, 'retained bytes');
    db = createTestDb();
    ensureSchema(db, ':memory:');
    databaseHost.db = db;
    db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES(7,'Primer home',?,1)").run(
      root
    );
    await openTestProject(root, db);
    db.prepare(
      `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
      VALUES(?,'primer','Registered primer',?,'file','active',7,1,1)`
    ).run(primerId, `file://${path}`);
    db.prepare(
      `INSERT INTO catalog_entity_files
      (id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at)
      VALUES(?,?,7,?,'retained.primer.json','primer-artifact','current',1,1)`
    ).run(randomUUID(), primerId, path);

    db.prepare(
      `INSERT INTO org_registry_local_records
      (org_id,account_id,entity_id,client_id,workspace_id,workspace_uuid,home_workspace_id,
      kind,local_schema_revision_id,authority_kind,schema_id,schema_revision_id,
      claim_mutation_id,claim_source_revision,claim_local_event_seq,created_at,updated_at)
      VALUES(?,?,?,?,7,?,?,'oligo',?,'primer_artifact',?,?,?,?,1,1,1)`
    ).run(
      randomUUID(),
      randomUUID(),
      primerId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      'a'.repeat(64)
    );
  });
  afterEach(() => {
    databaseHost.db = null;
    db.close();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it.each([false, true])(
    'refuses Trash with an existing renderer token=%s before calling the OS',
    async (tokenized) => {
      const event = gitReadEvent(812);
      const handler = await getShellHandler('shell:trashItem');
      const { workspaceMutationCapabilities } = await import('./workspace-mutation-capability');
      const { acquireWorkspaceMutationShared, workspaceMutationRootIdentity } =
        await import('../workspace-sync-mutation-lease');
      const token = tokenized
        ? workspaceMutationCapabilities.issue(
            event.sender.id,
            workspaceMutationRootIdentity(root),
            await acquireWorkspaceMutationShared(root)
          )
        : undefined;
      const before = db.prepare('SELECT * FROM org_registry_local_records').all();
      try {
        await expect(handler(event, path, token)).rejects.toThrow(
          /registered with an organization/
        );
        expect(shell.trashItem).not.toHaveBeenCalled();
        expect(readFileSync(path, 'utf8')).toBe('retained bytes');
        expect(db.prepare('SELECT * FROM org_registry_local_records').all()).toEqual(before);
      } finally {
        if (token) workspaceMutationCapabilities.release(token, event.sender.id);
      }
    }
  );

  it('refuses checkout of the registered file but retains ordinary Git status and commit', async () => {
    const handler = await getExecuteHandler();
    const event = gitReadEvent(813);
    await expect(
      handler(event, 'git', ['checkout', '--', 'retained.primer.json'], root)
    ).rejects.toThrow(/registered with an organization/);
    expect(mockGitExec).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe('retained bytes');
    await handler(event, 'git', ['status', '--porcelain'], root);
    await handler(
      event,
      'git',
      ['commit', '-m', 'Keep normal history', '--', 'retained.primer.json'],
      root
    );
    expect(mockGitExec).toHaveBeenCalledTimes(2);
  });

  it('project Trash refuses a registered primer before bytes or registry rows change', async () => {
    const handler = await getShellHandler('shell:fileTrash');
    const before = db.prepare('SELECT * FROM org_registry_local_records').all();
    const inspection = await runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path });
    if (inspection.kind !== 'inspect') throw new Error('Expected source inspection');
    expect(
      await handler(gitReadEvent(814), {
        kind: 'trash',
        workspaceRoot: root,
        path,
        expectedRevision: inspection.source.revision,
      })
    ).toMatchObject({
      kind: 'failed',
      stateChanged: false,
      error: expect.stringMatching(/registered with an organization/),
    });
    expect(readFileSync(path, 'utf8')).toBe('retained bytes');
    expect(db.prepare('SELECT * FROM org_registry_local_records').all()).toEqual(before);
    expect(await runWorkspaceFileTrash({ kind: 'list', workspaceRoot: root })).toMatchObject({
      entries: [],
      errors: [],
    });
  });

  it.each(['restore', 'purge'] as const)(
    'project Trash %s refuses legacy registered payload changes',
    async (kind) => {
      const inspection = await runWorkspaceFileTrash({
        kind: 'inspect',
        workspaceRoot: root,
        path,
      });
      if (inspection.kind !== 'inspect') throw new Error('Expected source inspection');
      const entryId = randomUUID();
      const dir = join(root, '.git', 'dnaforge-file-trash', entryId);
      mkdirSync(dir, { recursive: true });
      const { workspaceMoveTreeDigest } = await import('../workspace-file-trash');
      const contentDigest = await workspaceMoveTreeDigest(path);
      const { renameSync, realpathSync } = await import('node:fs');
      renameSync(path, join(dir, 'payload'));
      writeFileSync(
        join(dir, 'record.json'),
        JSON.stringify({
          schema: 'dnaforge.file-trash.v1',
          id: entryId,
          workspaceRoot: realpathSync(root),
          originalPath: inspection.source.path,
          trashedAt: new Date().toISOString(),
          type: 'file',
          contentDigest,
        })
      );
      const listed = await runWorkspaceFileTrash({ kind: 'list', workspaceRoot: root });
      if (listed.kind !== 'list' || listed.entries.length !== 1)
        throw Error(JSON.stringify(listed));
      const legacy = { entry: listed.entries[0] };
      const handler = await getShellHandler('shell:fileTrash');
      const before = db.prepare('SELECT * FROM org_registry_local_records').all();
      expect(
        await handler(gitReadEvent(815), {
          kind,
          workspaceRoot: root,
          entryId: legacy.entry.id,
          expectedRevision: legacy.entry.revision,
        })
      ).toMatchObject({
        kind: 'failed',
        stateChanged: false,
        error: expect.stringMatching(/registered with an organization/),
      });
      expect(existsSync(path)).toBe(false);
      expect(
        readFileSync(join(root, '.git', 'dnaforge-file-trash', legacy.entry.id, 'payload'), 'utf8')
      ).toBe('retained bytes');
      expect(await runWorkspaceFileTrash({ kind: 'list', workspaceRoot: root })).toMatchObject({
        entries: [legacy.entry],
        errors: [],
      });
      expect(db.prepare('SELECT * FROM org_registry_local_records').all()).toEqual(before);
    }
  );

  it.each(['file', 'parent'] as const)(
    'refuses to move the registered raw file or its %s ancestor before creating a Trash entry',
    async (target) => {
      const event = gitReadEvent(819);
      const handler = await getShellHandler('shell:fileTrash');
      const osTrash = await getShellHandler('shell:trashItem');
      const directory = join(root, 'Catalogued');
      const localPath = join(directory, 'saved.txt');
      const localId = randomUUID();
      mkdirSync(directory);
      writeFileSync(localPath, 'local entity bytes');
      db.prepare(
        `INSERT INTO catalog_entities
        (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
        VALUES(?,'file','Local record',?,'file','active',7,1,1)`
      ).run(localId, `file://${localPath}`);
      db.prepare(
        `INSERT INTO catalog_entity_files
        (id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at)
        VALUES(?,?,7,?,'Catalogued/saved.txt','text','current',1,1)`
      ).run(randomUUID(), localId, localPath);
      const item = target === 'file' ? localPath : directory;
      await expect(osTrash(event, item)).rejects.toThrow('SAVED_ENTITY_CONTENT');
      expect(shell.trashItem).not.toHaveBeenCalled();
      const inspected = await runWorkspaceFileTrash({
        kind: 'inspect',
        workspaceRoot: root,
        path: item,
      });
      if (inspected.kind !== 'inspect') throw new Error('Expected source inspection');
      const moved = (await handler(event, {
        kind: 'trash',
        workspaceRoot: root,
        path: item,
        expectedRevision: inspected.source.revision,
      })) as Awaited<ReturnType<typeof runWorkspaceFileTrash>>;
      expect(moved).toMatchObject({
        kind: 'failed',
        code: 'SAVED_ENTITY_CONTENT',
        stateChanged: false,
      });
      expect(readFileSync(localPath, 'utf8')).toBe('local entity bytes');
      expect(await handler(event, { kind: 'list', workspaceRoot: root })).toMatchObject({
        entries: [],
      });
    }
  );

  it.each(['primer', 'folder'] as const)(
    'refuses project and system Trash for an unindexed native %s',
    async (kind) => {
      const target = join(root, kind === 'primer' ? 'Saved.primer.json' : 'Ordinary');
      const file = kind === 'primer' ? target : join(target, 'Nested', '.forge', 'notebook.json');
      if (kind === 'folder') mkdirSync(join(target, 'Nested', '.forge'), { recursive: true });
      writeFileSync(file, '{"id":"saved-stable-id"}');
      const event = gitReadEvent(851);
      const handler = await getShellHandler('shell:fileTrash');
      const osTrash = await getShellHandler('shell:trashItem');
      const inspected = await runWorkspaceFileTrash({
        kind: 'inspect',
        workspaceRoot: root,
        path: target,
      });
      if (inspected.kind !== 'inspect') throw new Error('Expected source');
      await expect(
        handler(event, {
          kind: 'trash',
          workspaceRoot: root,
          path: target,
          expectedRevision: inspected.source.revision,
        })
      ).resolves.toMatchObject({
        kind: 'failed',
        code: 'SAVED_ENTITY_CONTENT',
        stateChanged: false,
      });
      await expect(osTrash(event, target)).rejects.toThrow('SAVED_ENTITY_CONTENT');
      expect(shell.trashItem).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe('{"id":"saved-stable-id"}');
      expect(await handler(event, { kind: 'list', workspaceRoot: root })).toMatchObject({
        entries: [],
        errors: [],
      });
    }
  );
  it('protects an absolute catalog binding with no project owner from system Trash', async () => {
    const outside = mkdtempSync(join(TEST_OTHER_ROOT, 'global-file-'));
    try {
      const path = join(outside, 'registered.txt');
      writeFileSync(path, 'global entity bytes');
      db.prepare(
        `INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at)
        VALUES(?,'file','Unscoped registration',?,'file','active',1,1)`
      ).run(randomUUID(), `file://${path}`);
      const osTrash = await getShellHandler('shell:trashItem');
      await expect(osTrash(gitReadEvent(821), path)).rejects.toThrow('SAVED_ENTITY_CONTENT');
      expect(shell.trashItem).not.toHaveBeenCalled();
      expect(readFileSync(path, 'utf8')).toBe('global entity bytes');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('retains old Trash receipts without a deletion eligibility record', async () => {
    const path = join(root, 'older.txt');
    writeFileSync(path, 'legacy');
    const inspected = await runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path });
    if (inspected.kind !== 'inspect') throw new Error('Expected inspection');
    const moved = await runWorkspaceFileTrash(
      {
        kind: 'trash',
        workspaceRoot: root,
        path,
        expectedRevision: inspected.source.revision,
      },
      undefined,
      undefined,
      undefined,
      () => false
    );
    if (moved.kind !== 'trash') throw new Error('Expected Trash receipt');
    const journalPath = join(root, '.git', 'dnaforge-file-trash', moved.entry.id, 'record.json');
    const { purgeEligible, ...legacyRecord } = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(purgeEligible).toBe(true);
    writeFileSync(
      journalPath,
      JSON.stringify({ ...legacyRecord, schema: 'dnaforge.file-trash.v1' })
    );
    const listed = await runWorkspaceFileTrash({ kind: 'list', workspaceRoot: root });
    if (listed.kind !== 'list' || listed.entries.length !== 1)
      throw new Error('Expected legacy receipt');
    const handler = await getShellHandler('shell:fileTrash');
    const entry = {
      workspaceRoot: root,
      entryId: moved.entry.id,
      expectedRevision: listed.entries[0].revision,
    };
    expect(await handler(gitReadEvent(820), { kind: 'purge', ...entry })).toMatchObject({
      kind: 'failed',
      code: 'RETENTION_UNVERIFIED',
      stateChanged: false,
    });
    expect(await handler(gitReadEvent(820), { kind: 'restore', ...entry })).toMatchObject({
      kind: 'restore',
    });
    expect(readFileSync(path, 'utf8')).toBe('legacy');
  });

  it('project Trash keeps ordinary trash, restore and purge available beside a registered primer', async () => {
    const handler = await getShellHandler('shell:fileTrash');
    const event = gitReadEvent(816);
    const ordinary = join(root, 'notes.txt');
    const before = db.prepare('SELECT * FROM org_registry_local_records').all();
    writeFileSync(ordinary, 'ordinary retained bytes');
    for (const kind of ['restore', 'purge'] as const) {
      const inspection = await runWorkspaceFileTrash({
        kind: 'inspect',
        workspaceRoot: root,
        path: ordinary,
      });
      if (inspection.kind !== 'inspect') throw new Error('Expected ordinary source inspection');
      expect(
        await handler(event, {
          kind: 'trash',
          workspaceRoot: root,
          path: ordinary,
          expectedRevision: inspection.source.revision,
        })
      ).toMatchObject({ kind: 'trash', changed: true });
      expect(existsSync(ordinary)).toBe(false);
      const listed = await runWorkspaceFileTrash({ kind: 'list', workspaceRoot: root });
      if (listed.kind !== 'list') throw new Error('Expected ordinary Trash listing');
      expect(listed.entries).toHaveLength(1);
      expect(listed.errors).toEqual([]);
      const entry = listed.entries[0];
      expect(
        await handler(event, {
          kind,
          workspaceRoot: root,
          entryId: entry.id,
          expectedRevision: entry.revision,
        })
      ).toMatchObject({ kind, changed: true });
      if (kind === 'restore')
        expect(readFileSync(ordinary, 'utf8')).toBe('ordinary retained bytes');
      else expect(existsSync(ordinary)).toBe(false);
    }
    expect(readFileSync(path, 'utf8')).toBe('retained bytes');
    expect(db.prepare('SELECT * FROM org_registry_local_records').all()).toEqual(before);
  });
});
