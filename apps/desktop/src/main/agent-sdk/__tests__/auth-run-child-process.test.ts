import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SpawnCall {
  command: string;
  args: readonly string[];
  opts: { cwd?: string; windowsHide?: boolean; env?: NodeJS.ProcessEnv };
}
const spawnCalls: SpawnCall[] = [];

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const spawnMock = vi.fn((command: string, args: readonly string[], opts: SpawnCall['opts']) => {
  spawnCalls.push({ command, args, opts });
  const child = makeFakeChild();
  queueMicrotask(() => child.emit('close', 0));
  return child;
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: vi.fn(),
  default: { spawn: spawnMock, execFile: vi.fn() },
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => '/home/tester' },
    homedir: () => '/home/tester',
  };
});

const PROCESS_EXEC_PATH = process.execPath;

describe('runChildProcess  login spawn hardening)', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnMock.mockClear();
  });
  afterEach(() => vi.resetModules());

  it('spawns a native binary directly, in the home dir, with windowsHide', async () => {
    const { runChildProcess } = await import('../auth');
    await runChildProcess(
      'C:\\Users\\user\\.local\\bin\\claude.exe',
      ['auth', 'login', '--claudeai'],
      {
        timeoutMs: 1000,
        onOutput: () => {},
      }
    );

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.command).toBe('C:\\Users\\user\\.local\\bin\\claude.exe');
    expect(call.args).toEqual(['auth', 'login', '--claudeai']);
    expect(call.opts.cwd).toBe('/home/tester');
    expect(call.opts.windowsHide).toBe(true);
  });

  it('runs a cli.js entrypoint via the node runtime (ELECTRON_RUN_AS_NODE), not raw', async () => {
    const { runChildProcess } = await import('../auth');
    const cliJs =
      'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    await runChildProcess(cliJs, ['auth', 'login', '--claudeai'], {
      timeoutMs: 1000,
      env: { FOO: 'bar' },
      onOutput: () => {},
    });

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.command).toBe(PROCESS_EXEC_PATH);
    expect(call.args).toEqual([cliJs, 'auth', 'login', '--claudeai']);
    expect(call.opts.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(call.opts.env?.FOO).toBe('bar');
    expect(call.opts.cwd).toBe('/home/tester');
    expect(call.opts.windowsHide).toBe(true);
  });
});
