import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_AGENT_PERMISSIONS } from '../shared/agent-permissions';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { HostedAiNativeToolRequest } from '../shared/hosted-ai-gateway-ipc';
import { isPathInsideBoundary } from '../shared/path-boundary';
import { canonicalizePath } from './agent-sdk/tool-permission-policy';
import {
  HostedNativeToolBroker,
  HostedNativeToolAuthorizationError,
  HostedNativeToolDeclinedError,
  HostedNativeToolStoppedError,
  hostedNativeScratchSegment,
} from './hosted-native-tool-broker';
import {
  HostedNativeProcessSupervisor,
  hostedNativeShellInvocation,
  hostedNativeProcessEnvironment,
  HostedNativeProcessTerminationUnconfirmedError,
} from './hosted-native-process-supervisor';
import { runHostedNativeRegexWorkerJob } from './hosted-native-regex-worker-job';

const binding = {
  turnBindingToken: 'binding-token',
  workflowId: 'conversation-1',
  runId: 'turn-1',
  turnId: 'turn-1',
};

describe('HostedNativeToolBroker', () => {
  let root: string;
  let workspace: string;
  let scratchBase: string;
  let trash: string;
  let confirmation: ReturnType<typeof vi.fn>;
  let authorizeTurn: ReturnType<typeof vi.fn>;
  let fetchWeb: ReturnType<typeof vi.fn>;
  let withSafeWritablePaths: ReturnType<typeof vi.fn>;
  let workspacePath: string | null;
  let broker: HostedNativeToolBroker;
  let sequence: number;

  const request = (
    toolName: string,
    input: Record<string, unknown>,
    operationId = `operation-${++sequence}`,
    shellSupervision: HostedAiNativeToolRequest['shellSupervision'] = 'destructive-only'
  ): HostedAiNativeToolRequest => ({
    ...binding,
    operationId,
    toolName,
    input,
    shellSupervision,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hosted-native-tools-'));
    workspace = join(root, 'workspace');
    scratchBase = join(root, 'scratch');
    trash = join(root, 'trash');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(scratchBase, { recursive: true }),
      mkdir(trash, { recursive: true }),
    ]);
    confirmation = vi.fn(async () => 'once' as const);
    authorizeTurn = vi.fn(async () => ({ workspacePath }));
    fetchWeb = vi.fn(async (url: string) => ({
      url,
      title: 'Example',
      content: 'Fetched public content',
      content_type: 'text/plain',
      truncated: false,
    }));
    workspacePath = workspace;
    sequence = 0;
    let processSequence = 0;
    withSafeWritablePaths = vi.fn(async (paths, operation) =>
      operation(
        paths.map((path: string) => {
          const canonical = canonicalizePath(path);
          if (!isPathInsideBoundary(canonical, canonicalizePath(root))) {
            throw new Error('Path access denied.');
          }
          return canonical;
        })
      )
    );
    broker = new HostedNativeToolBroker({
      authorizeTurn,
      prepareShellProcess: async ({ command }) => ({
        ...hostedNativeShellInvocation(process.platform, command),
        env: hostedNativeProcessEnvironment(),
        release: () => undefined,
      }),
      confirmDestructiveFile: async (_ownerId, prompt, signal) => confirmation(prompt, signal),
      resolveSafePath: async (path) => {
        const canonical = canonicalizePath(path);
        if (!isPathInsideBoundary(canonical, canonicalizePath(root))) {
          throw new Error('Path access denied.');
        }
        return canonical;
      },
      resolveSafeWritablePath: async (path) => {
        const canonical = canonicalizePath(path);
        if (!isPathInsideBoundary(canonical, canonicalizePath(root))) {
          throw new Error('Path access denied.');
        }
        return canonical;
      },
      withSafeWritablePaths,
      trashPath: async (path) => rename(path, join(trash, `${Date.now()}-${basename(path)}`)),
      scratchBase,
      idGenerator: () => `receipt-${++sequence}`,
      processSupervisor: new HostedNativeProcessSupervisor({
        idGenerator: () => `process-${++processSequence}`,
        stopGraceMs: 50,
      }),
      fetchWeb,
      searchText: async (job) => runHostedNativeRegexWorkerJob(job),
    });
  });

  afterEach(async () => {
    await broker.cancelOwner(7);
    await rm(root, { recursive: true, force: true });
  });

  it('creates and reads a workspace file without interrupting, but confirms an overwrite', async () => {
    const path = join(workspace, 'notes.txt');
    const canonicalPath = canonicalizePath(path);
    await expect(
      broker.execute(7, request('Write', { file_path: path, content: 'first\nsecond' }))
    ).resolves.toMatchObject({
      output: {
        path: canonicalPath,
        bytes_written: 12,
        pre_write_existed: false,
        created: true,
        observed_byte_count: 12,
        observed_content_sha256: '4252f8d56b4bb236d0b1bc95a1202e392ca84ce0644bf628398fbb9517287da8',
      },
    });
    expect(confirmation).not.toHaveBeenCalled();

    await expect(
      broker.execute(7, request('Read', { file_path: 'notes.txt', offset: 1, limit: 1 }))
    ).resolves.toMatchObject({
      output: {
        path: canonicalPath,
        content: 'second',
        start_line: 2,
        total_lines: 2,
        truncated: false,
      },
    });

    await expect(
      broker.execute(7, request('Write', { file_path: path, content: 'replacement' }))
    ).resolves.toMatchObject({
      output: {
        path: canonicalPath,
        pre_write_existed: true,
        created: false,
        observed_byte_count: 11,
        observed_content_sha256: '95713e9cbdd1dfcb2d4080c2537f418d43ca0da25f0d7d6631f4f7c97b89dc47',
      },
    });
    expect(confirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Write',
        operation: 'Overwrite file',
        resolvedPath: canonicalPath,
        conversationId: binding.workflowId,
      }),
      expect.any(AbortSignal)
    );
    await expect(readFile(path, 'utf8')).resolves.toBe('replacement');
    expect(authorizeTurn).toHaveBeenCalledWith(7, binding);
  });

  it('describes a relative Write with the exact resolved path before a gateway claim', async () => {
    await expect(
      broker.describeApproval(
        7,
        request('Write', {
          file_path: 'fixture-sealed-case.txt',
          content: 'sealed-case sealed case\n',
        })
      )
    ).resolves.toMatchObject({
      conversationId: binding.workflowId,
      toolName: 'Write',
      operation: 'Create file',
      resolvedPath: canonicalizePath(join(workspace, 'fixture-sealed-case.txt')),
    });
    expect(withSafeWritablePaths).toHaveBeenCalledWith(
      [canonicalizePath(join(workspace, 'fixture-sealed-case.txt'))],
      expect.any(Function)
    );
    await expect(
      stat(join(scratchBase, hostedNativeScratchSegment(binding.turnBindingToken)))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('describes the exact shell command and workspace before a gateway claim', async () => {
    await expect(
      broker.describeApproval(7, request('Bash', { command: 'mkdir results' }))
    ).resolves.toMatchObject({
      conversationId: binding.workflowId,
      toolName: 'Bash',
      operation: 'Run file-changing shell command',
      resolvedPath: canonicalizePath(workspace),
      command: 'mkdir results',
      risk: 'mutating',
    });
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('rejects an out-of-scope writable target before approval or a gateway claim', async () => {
    const outsidePath = join(root, 'outside.txt');

    await expect(
      broker.describeApproval(
        7,
        request('Write', { file_path: outsidePath, content: 'must not be written' })
      )
    ).rejects.toThrow(/bound workspace or turn scratch/i);
    await expect(readFile(outsidePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('preflights Edit existence and exact replacement uniqueness before approval', async () => {
    const path = join(workspace, 'edit-preflight.txt');

    await expect(
      broker.describeApproval(
        7,
        request('Edit', { file_path: path, old_string: 'alpha', new_string: 'beta' })
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(path, 'alpha alpha');
    await expect(
      broker.describeApproval(
        7,
        request('Edit', { file_path: path, old_string: 'alpha', new_string: 'beta' })
      )
    ).rejects.toThrow(/not unique/i);
    await expect(readFile(path, 'utf8')).resolves.toBe('alpha alpha');
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('preflights source and target existence policy for Move and Delete', async () => {
    const source = join(workspace, 'missing-source.txt');
    const destination = join(workspace, 'destination.txt');

    await expect(
      broker.describeApproval(
        7,
        request('Move', { source_path: source, destination_path: destination })
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(source, 'source');
    await writeFile(destination, 'destination');
    await expect(
      broker.describeApproval(
        7,
        request('Move', { source_path: source, destination_path: destination })
      )
    ).rejects.toThrow(/destination already exists/i);
    await expect(
      broker.describeApproval(7, request('Delete', { path: join(workspace, 'missing.txt') }))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(source, 'utf8')).resolves.toBe('source');
    await expect(readFile(destination, 'utf8')).resolves.toBe('destination');
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('preflights notebook cell and process ownership before approval', async () => {
    const notebookPath = join(workspace, 'preflight.ipynb');
    await writeFile(
      notebookPath,
      JSON.stringify({
        cells: [{ id: 'known', cell_type: 'code', metadata: {}, source: '1 + 1' }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      })
    );

    await expect(
      broker.describeApproval(
        7,
        request('NotebookEdit', {
          notebook_path: notebookPath,
          cell_id: 'missing',
          new_source: '2 + 2',
        })
      )
    ).rejects.toThrow(/cell was not found/i);
    await expect(
      broker.describeApproval(7, request('ProcessStop', { process_id: 'not-owned' }))
    ).rejects.toThrow(/not owned by this AI turn/i);
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('rejects invalid native mutation arguments before approval or a gateway claim', async () => {
    await expect(broker.describeApproval(7, request('Bash', { command: '' }))).rejects.toThrow(
      /command is invalid/i
    );
    await expect(
      broker.describeApproval(7, request('MultiEdit', { file_path: 'notes.txt', edits: [] }))
    ).rejects.toThrow(/edits is invalid/i);
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('does not overwrite a file created after a new-file Write was classified', async () => {
    const path = join(workspace, 'classification-race.txt');
    authorizeTurn.mockResolvedValueOnce({ workspacePath }).mockImplementationOnce(async () => {
      await writeFile(path, 'created by another actor');
      return { workspacePath };
    });

    await expect(
      broker.execute(7, request('Write', { file_path: path, content: 'hosted write' }))
    ).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(path, 'utf8')).resolves.toBe('created by another actor');
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('denies a path outside the bound workspace before any approval or local effect', async () => {
    const outsidePath = join(root, 'outside.txt');
    await writeFile(outsidePath, 'outside');

    await expect(broker.execute(7, request('Read', { file_path: outsidePath }))).rejects.toThrow(
      /bound workspace or turn scratch/i
    );
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('keeps a workspace-free turn inside its exact per-turn scratch directory', async () => {
    workspacePath = null;

    await expect(
      broker.execute(7, request('Write', { file_path: 'notes.txt', content: 'scratch' }))
    ).resolves.toMatchObject({
      output: {
        path: canonicalizePath(
          join(scratchBase, hostedNativeScratchSegment(binding.turnBindingToken), 'notes.txt')
        ),
      },
    });
  });

  it('removes the exact per-turn scratch directory when the binding is released', async () => {
    workspacePath = null;
    const scratchRoot = join(scratchBase, hostedNativeScratchSegment(binding.turnBindingToken));
    await broker.execute(7, request('Write', { file_path: 'notes.txt', content: 'scratch' }));
    await expect(stat(join(scratchRoot, 'notes.txt'))).resolves.toBeDefined();

    await broker.cancelTurnBinding(binding.turnBindingToken);

    await expect(stat(scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')(
    'retains turn scratch and reports failure while native termination is unconfirmed',
    async () => {
      workspacePath = null;
      let processSequence = 0;
      const terminateProcessTree = vi.fn();
      broker = new HostedNativeToolBroker({
        authorizeTurn,
        prepareShellProcess: async ({ command }) => ({
          ...hostedNativeShellInvocation(process.platform, command),
          env: hostedNativeProcessEnvironment(),
          release: () => undefined,
        }),
        confirmDestructiveFile: async (_ownerId, prompt, signal) => confirmation(prompt, signal),
        resolveSafePath: async (path) => canonicalizePath(path),
        resolveSafeWritablePath: async (path) => canonicalizePath(path),
        withSafeWritablePaths: async (paths, operation) =>
          operation(paths.map((path) => canonicalizePath(path))),
        trashPath: async (path) => rename(path, join(trash, `${Date.now()}-${basename(path)}`)),
        scratchBase,
        idGenerator: () => `receipt-${++sequence}`,
        processSupervisor: new HostedNativeProcessSupervisor({
          idGenerator: () => `wedged-process-${++processSequence}`,
          maxProcessHandles: 1,
          stopGraceMs: 5,
          terminateProcessTree,
        }),
        fetchWeb,
        searchText: async (job) => runHostedNativeRegexWorkerJob(job),
      });
      const scratchRoot = join(scratchBase, hostedNativeScratchSegment(binding.turnBindingToken));
      await broker.execute(
        7,
        request('ProcessStart', { command: 'sleep 0.06' }, undefined, 'auto')
      );

      await expect(broker.cancelTurnBinding(binding.turnBindingToken)).rejects.toBeInstanceOf(
        HostedNativeProcessTerminationUnconfirmedError
      );
      await expect(stat(scratchRoot)).resolves.toBeDefined();

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      await expect(
        broker.waitForTurnBindingCleanup(binding.turnBindingToken)
      ).resolves.toBeUndefined();
      await expect(stat(scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'bounds app shutdown when a native process never confirms close',
    async () => {
      workspacePath = null;
      let wedgedPid: number | undefined;
      broker = new HostedNativeToolBroker({
        authorizeTurn,
        prepareShellProcess: async ({ command }) => ({
          ...hostedNativeShellInvocation(process.platform, command),
          env: hostedNativeProcessEnvironment(),
          release: () => undefined,
        }),
        confirmDestructiveFile: async (_ownerId, prompt, signal) => confirmation(prompt, signal),
        resolveSafePath: async (path) => canonicalizePath(path),
        resolveSafeWritablePath: async (path) => canonicalizePath(path),
        withSafeWritablePaths: async (paths, operation) =>
          operation(paths.map((path) => canonicalizePath(path))),
        trashPath: async (path) => rename(path, join(trash, `${Date.now()}-${basename(path)}`)),
        scratchBase,
        idGenerator: () => `receipt-${++sequence}`,
        processSupervisor: new HostedNativeProcessSupervisor({
          idGenerator: () => 'wedged-process',
          stopGraceMs: 5,
          terminateProcessTree: (child) => {
            wedgedPid = child.pid;
          },
        }),
        shutdownDrainMs: 20,
        fetchWeb,
        searchText: async (job) => runHostedNativeRegexWorkerJob(job),
      });
      await broker.execute(7, request('ProcessStart', { command: 'sleep 60' }, undefined, 'auto'));

      let outcome: 'shutdown' | 'deadline';
      try {
        outcome = await Promise.race([
          broker.shutdown().then(() => 'shutdown' as const),
          new Promise<'deadline'>((resolvePromise) =>
            setTimeout(() => resolvePromise('deadline'), 250)
          ),
        ]);
      } finally {
        if (wedgedPid) {
          try {
            process.kill(-wedgedPid, 'SIGKILL');
          } catch {}
        }
      }

      expect(outcome).toBe('shutdown');
      await broker.waitForTurnBindingCleanup(binding.turnBindingToken);
    }
  );

  it('removes every known scratch directory when its renderer owner closes', async () => {
    workspacePath = null;
    const scratchRoot = join(scratchBase, hostedNativeScratchSegment(binding.turnBindingToken));
    await broker.execute(7, request('Write', { file_path: 'notes.txt', content: 'scratch' }));
    await expect(stat(join(scratchRoot, 'notes.txt'))).resolves.toBeDefined();

    await broker.cancelOwner(7);

    await expect(stat(scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fetches public web content without a destructive-operation prompt', async () => {
    await expect(
      broker.execute(
        7,
        request('WebFetch', {
          url: 'https://example.com/article',
          prompt: 'Extract the main result.',
        })
      )
    ).resolves.toMatchObject({
      output: {
        url: 'https://example.com/article',
        content: 'Fetched public content',
      },
    });
    expect(fetchWeb).toHaveBeenCalledWith('https://example.com/article', expect.any(AbortSignal));
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('searches bounded file text through the native Grep capability', async () => {
    await Promise.all([
      writeFile(join(workspace, 'one.txt'), 'Alpha\nbeta\nalpha two'),
      writeFile(join(workspace, 'two.txt'), 'alpha three'),
    ]);

    await expect(
      broker.execute(
        7,
        request('Grep', {
          pattern: 'alpha',
          path: workspace,
          glob: '*.txt',
          case_sensitive: false,
          limit: 2,
        })
      )
    ).resolves.toMatchObject({
      output: {
        root: canonicalizePath(workspace),
        matches: [
          { path: expect.stringMatching(/one\.txt$/), line: 1, text: 'Alpha' },
          { path: expect.stringMatching(/one\.txt$/), line: 3, text: 'alpha two' },
        ],
        truncated: true,
      },
    });
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('reads Jupyter cells semantically and edits one exact cell through the shared policy', async () => {
    const path = join(workspace, 'analysis.ipynb');
    await writeFile(
      path,
      JSON.stringify({
        cells: [
          {
            id: 'intro-cell',
            cell_type: 'markdown',
            metadata: {},
            source: ['# Original\n', 'Context'],
          },
          {
            id: 'code-cell',
            cell_type: 'code',
            metadata: {},
            execution_count: 1,
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['old\n'] }],
            source: ['print("old")'],
          },
        ],
        metadata: { kernelspec: { name: 'python3' } },
        nbformat: 4,
        nbformat_minor: 5,
      })
    );
    await chmod(path, 0o640);

    await expect(broker.execute(7, request('Read', { file_path: path }))).resolves.toMatchObject({
      output: {
        path: canonicalizePath(path),
        notebook: true,
        cells: [
          { id: 'intro-cell', cell_type: 'markdown', source: '# Original\nContext' },
          { id: 'code-cell', cell_type: 'code', source: 'print("old")' },
        ],
      },
    });

    await expect(
      broker.execute(
        7,
        request('NotebookEdit', {
          notebook_path: path,
          cell_id: 'code-cell',
          new_source: 'print("new")',
          edit_mode: 'replace',
        })
      )
    ).resolves.toMatchObject({
      output: { path: canonicalizePath(path), cell_id: 'code-cell', edit_mode: 'replace' },
    });
    expect(confirmation).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'NotebookEdit', resolvedPath: canonicalizePath(path) }),
      expect.any(AbortSignal)
    );
    const updated = JSON.parse(await readFile(path, 'utf8')) as {
      cells: Array<Record<string, unknown>>;
    };
    expect(updated.cells[1]).toMatchObject({
      id: 'code-cell',
      cell_type: 'code',
      source: 'print("new")',
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['old\n'] }],
    });
    expect((await stat(path)).mode & 0o777).toBe(0o640);

    const inserted = await broker.execute(
      7,
      request('NotebookEdit', {
        notebook_path: path,
        cell_id: 'intro-cell',
        new_source: 'Inserted context',
        cell_type: 'markdown',
        edit_mode: 'insert',
      })
    );
    const insertedId = (inserted.output as { cell_id: string }).cell_id;
    expect(insertedId).toEqual(expect.any(String));
    await broker.execute(
      7,
      request('NotebookEdit', {
        notebook_path: path,
        cell_id: insertedId,
        new_source: '',
        edit_mode: 'delete',
      })
    );
    const afterDelete = JSON.parse(await readFile(path, 'utf8')) as {
      cells: Array<Record<string, unknown>>;
    };
    expect(afterDelete.cells.map((cell) => cell.id)).toEqual(['intro-cell', 'code-cell']);
  });

  it('maintains exact turn-scoped planning tasks without a destructive-operation prompt', async () => {
    const created = await broker.execute(
      7,
      request('TaskCreate', {
        subject: 'Inspect construct',
        description: 'Read the construct and summarize its annotations.',
        activeForm: 'Inspecting construct',
      })
    );
    expect(created.output).toMatchObject({
      task: { id: expect.any(String), subject: 'Inspect construct' },
    });
    const taskId = (created.output as { task: { id: string } }).task.id;

    await expect(
      broker.execute(7, request('TaskUpdate', { taskId, status: 'in_progress' }))
    ).resolves.toMatchObject({
      output: {
        success: true,
        taskId,
        statusChange: { from: 'pending', to: 'in_progress' },
      },
    });
    await expect(broker.execute(7, request('TaskGet', { taskId }))).resolves.toMatchObject({
      output: { task: { id: taskId, subject: 'Inspect construct', status: 'in_progress' } },
    });
    await expect(broker.execute(7, request('TaskList', {}))).resolves.toMatchObject({
      output: { tasks: [{ id: taskId, status: 'in_progress' }] },
    });
    expect(confirmation).not.toHaveBeenCalled();

    await broker.cancelTurnBinding(binding.turnBindingToken);
    await expect(
      broker.execute(7, {
        ...request('TaskGet', { taskId }),
        turnBindingToken: 'replacement-binding-token',
      })
    ).rejects.toThrow(/not found/i);
  });

  it('does not partly update a planning task when a dependency is invalid', async () => {
    const created = await broker.execute(
      7,
      request('TaskCreate', { subject: 'Original', description: 'Original description.' })
    );
    const taskId = (created.output as { task: { id: string } }).task.id;

    await expect(
      broker.execute(
        7,
        request('TaskUpdate', {
          taskId,
          subject: 'Must not stick',
          addBlocks: ['missing-task'],
        })
      )
    ).rejects.toThrow(/not found/i);
    await expect(broker.execute(7, request('TaskGet', { taskId }))).resolves.toMatchObject({
      output: { task: { subject: 'Original' } },
    });
  });

  it('does not let one owner or turn read another turn planning task', async () => {
    const created = await broker.execute(
      7,
      request('TaskCreate', { subject: 'Private plan', description: 'Bound to one turn.' })
    );
    const taskId = (created.output as { task: { id: string } }).task.id;

    await expect(
      broker.execute(8, request('TaskGet', { taskId }, 'other-owner-operation'))
    ).rejects.toThrow(/not found/i);
  });

  it('performs no local effect when the exact turn authority is refused', async () => {
    const path = join(workspace, 'never-created.txt');
    authorizeTurn.mockRejectedValueOnce(new Error('account changed'));

    await expect(
      broker.execute(7, request('Write', { file_path: path, content: 'blocked' }))
    ).rejects.toBeInstanceOf(HostedNativeToolAuthorizationError);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('creates an empty file because empty content is a valid exact write', async () => {
    const path = join(workspace, 'empty.txt');

    await expect(
      broker.execute(7, request('Write', { file_path: path, content: '' }))
    ).resolves.toMatchObject({ output: { bytes_written: 0 } });
    await expect(readFile(path, 'utf8')).resolves.toBe('');
  });

  it('does not retarget an approved write when a symlink changes during confirmation', async () => {
    const firstDirectory = join(workspace, 'first');
    const secondDirectory = join(workspace, 'second');
    const link = join(workspace, 'current');
    await Promise.all([
      mkdir(firstDirectory, { recursive: true }),
      mkdir(secondDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(firstDirectory, 'target.txt'), 'first-before'),
      writeFile(join(secondDirectory, 'target.txt'), 'second-before'),
      symlink(firstDirectory, link, 'dir'),
    ]);
    let answer!: (choice: 'once' | 'deny') => void;
    confirmation.mockImplementationOnce(
      () => new Promise<'once' | 'deny'>((resolveConfirmation) => (answer = resolveConfirmation))
    );

    const pending = broker.execute(
      7,
      request('Write', { file_path: join(link, 'target.txt'), content: 'approved-write' })
    );
    await vi.waitFor(() => expect(confirmation).toHaveBeenCalledOnce());
    await unlink(link);
    await symlink(secondDirectory, link, 'dir');
    answer('once');

    await expect(pending).resolves.toMatchObject({
      output: { path: canonicalizePath(join(firstDirectory, 'target.txt')) },
    });
    await expect(readFile(join(firstDirectory, 'target.txt'), 'utf8')).resolves.toBe(
      'approved-write'
    );
    await expect(readFile(join(secondDirectory, 'target.txt'), 'utf8')).resolves.toBe(
      'second-before'
    );
  });

  it('overwrites without asking under Full Access, and asks only before overwrites under Read Only', async () => {
    const existing = join(workspace, 'full.txt');
    await writeFile(existing, 'before');
    await broker.execute(7, {
      ...request('Write', { file_path: existing, content: 'after' }, undefined, 'auto'),
      permissions: { ...BUILT_IN_AGENT_PERMISSIONS, codex: ':danger-full-access' },
    });
    expect(confirmation).not.toHaveBeenCalled();
    await expect(readFile(existing, 'utf8')).resolves.toBe('after');

    await broker.execute(7, {
      ...request('Write', { file_path: join(workspace, 'new.txt'), content: 'x' }),
      permissions: { ...BUILT_IN_AGENT_PERMISSIONS, codex: ':read-only' },
    });
    expect(confirmation).not.toHaveBeenCalled();
    await expect(readFile(join(workspace, 'new.txt'), 'utf8')).resolves.toBe('x');

    await broker.execute(7, {
      ...request('Write', { file_path: existing, content: 'again' }),
      permissions: { ...BUILT_IN_AGENT_PERMISSIONS, codex: ':read-only' },
    });
    expect(confirmation).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Write' }),
      expect.any(AbortSignal)
    );
  });

  it('declines an exact destructive write without a side effect', async () => {
    const path = join(workspace, 'keep.txt');
    await writeFile(path, 'keep me');
    confirmation.mockResolvedValueOnce('deny');

    await expect(
      broker.execute(
        7,
        request('Edit', { file_path: path, old_string: 'keep', new_string: 'lose' })
      )
    ).rejects.toBeInstanceOf(HostedNativeToolDeclinedError);
    await expect(readFile(path, 'utf8')).resolves.toBe('keep me');
  });

  it('reports the exact number of replace-all edits', async () => {
    const path = join(workspace, 'replace-all.txt');
    await writeFile(path, 'alpha beta alpha');

    await expect(
      broker.execute(
        7,
        request('Edit', {
          file_path: path,
          old_string: 'alpha',
          new_string: 'delta',
          replace_all: true,
        })
      )
    ).resolves.toMatchObject({ output: { replacements: 2 } });
  });

  it('rechecks Stop after an approval wait and before the file effect', async () => {
    const path = join(workspace, 'stop.txt');
    await writeFile(path, 'before');
    confirmation.mockImplementationOnce(
      (_prompt, signal: AbortSignal) =>
        new Promise<'once' | 'deny'>((resolveConfirmation) => {
          signal.addEventListener('abort', () => resolveConfirmation('deny'), { once: true });
        })
    );
    const pending = broker.execute(
      7,
      request('Write', { file_path: path, content: 'after' }, 'operation-stop')
    );
    await vi.waitFor(() => expect(confirmation).toHaveBeenCalledOnce());
    await expect(broker.cancel(7, 'operation-stop')).resolves.toBe(true);

    await expect(pending).rejects.toBeInstanceOf(HostedNativeToolStoppedError);
    await expect(readFile(path, 'utf8')).resolves.toBe('before');
  });

  it('applies ordered edits, moves, and recoverably trashes paths under the shared policy', async () => {
    const source = join(workspace, 'source.txt');
    const destination = join(workspace, 'destination.txt');
    await writeFile(source, 'alpha beta alpha');
    await broker.execute(
      7,
      request('MultiEdit', {
        file_path: source,
        edits: [
          { old_string: 'beta', new_string: 'gamma' },
          { old_string: 'alpha', new_string: 'delta', replace_all: true },
        ],
      })
    );
    await expect(readFile(source, 'utf8')).resolves.toBe('delta gamma delta');
    await broker.execute(
      7,
      request('Move', { source_path: source, destination_path: destination })
    );
    await broker.execute(7, request('Delete', { path: destination }));
    await expect(readFile(destination, 'utf8')).rejects.toThrow();
    expect(confirmation).toHaveBeenCalledTimes(3);
  });

  it('refuses shell execution when native confinement has not been supplied', async () => {
    const unconfined = new HostedNativeToolBroker({
      authorizeTurn,
      confirmDestructiveFile: async () => 'once' as const,
      resolveSafePath: async (path) => canonicalizePath(path),
      resolveSafeWritablePath: async (path) => canonicalizePath(path),
      withSafeWritablePaths,
      trashPath: async () => undefined,
      scratchBase,
      fetchWeb,
    });
    try {
      await expect(
        unconfined.execute(7, request('Bash', { command: 'printf denied' }, undefined, 'auto'))
      ).rejects.toThrow(/no verified filesystem sandbox.*No command was started/);
      await expect(
        unconfined.execute(7, request('ProcessStart', { command: 'sleep 10' }, undefined, 'auto'))
      ).rejects.toThrow(/no verified filesystem sandbox.*No command was started/);
    } finally {
      await unconfined.cancelOwner(7);
    }
  });

  it('runs bounded foreground commands with the selected shared shell-supervision policy', async () => {
    const result = await broker.execute(
      7,
      request('Bash', { command: "printf 'hello'", timeout_ms: 5_000 }, undefined, 'always')
    );
    expect(result.output).toMatchObject({ status: 'completed', stdout: 'hello', exit_code: 0 });
    expect(confirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        operation: 'Run shell command',
        resolvedPath: canonicalizePath(workspace),
        command: "printf 'hello'",
      }),
      expect.any(AbortSignal)
    );

    confirmation.mockClear();
    await broker.execute(
      7,
      request('ProcessStart', { command: 'rm -f missing.txt' }, undefined, 'destructive-only')
    );
    expect(confirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'ProcessStart',
        operation: 'Delete files',
        resolvedPath: canonicalizePath(workspace),
        command: 'rm -f missing.txt',
      }),
      expect.any(AbortSignal)
    );
  });

  it.skipIf(process.platform === 'win32')(
    'returns a content-free relative before/after diff for managed shell effects',
    async () => {
      const result = await broker.execute(
        7,
        request(
          'Bash',
          { command: "mkdir -p constructs && printf 'ATGCGT' > constructs/named.gb" },
          undefined,
          'auto'
        )
      );
      expect(result.output).toMatchObject({
        status: 'completed',
        workspace_diff: expect.arrayContaining([
          expect.objectContaining({
            path: 'constructs/named.gb',
            operation: 'create',
            after: { byte_count: 6, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          }),
        ]),
      });
      expect(JSON.stringify(result.output)).not.toContain(workspace);
    }
  );

  it('owns background processes by opaque handle and stops them without exposing a PID', async () => {
    workspacePath = null;
    const started = await broker.execute(
      7,
      request('ProcessStart', { command: "printf 'started'; sleep 10" }, undefined, 'auto')
    );
    expect(started.output).toMatchObject({ process_id: 'process-1', status: 'running' });
    expect(started.output).not.toHaveProperty('pid');
    const status = await broker.execute(7, request('ProcessStatus', { process_id: 'process-1' }));
    expect(status.output).toMatchObject({ process_id: 'process-1', status: 'running' });
    const stopped = await broker.execute(7, request('ProcessStop', { process_id: 'process-1' }));
    expect(stopped.output).toMatchObject({ process_id: 'process-1', status: 'stopped' });
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('rejects an unowned process handle', async () => {
    workspacePath = null;
    await broker.execute(7, request('ProcessStart', { command: 'sleep 10' }));
    await expect(
      broker.execute(8, request('ProcessStatus', { process_id: 'process-1' }))
    ).rejects.toThrow(/not owned/i);
  });

  it('derives an opaque collision-resistant scratch segment from the exact turn token', () => {
    expect(hostedNativeScratchSegment('binding-token')).toBe(
      'turn-9685c515c11eb187d8393b9146488ae9'
    );
    expect(hostedNativeScratchSegment('binding-token')).not.toContain('binding-token');
    expect(hostedNativeScratchSegment('other-binding-token')).not.toBe(
      hostedNativeScratchSegment('binding-token')
    );
  });
});
