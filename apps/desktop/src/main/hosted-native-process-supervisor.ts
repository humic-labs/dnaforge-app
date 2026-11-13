import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

export type HostedNativeProcessState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'termination_unconfirmed';

export interface HostedNativeProcessResult {
  readonly process_id: string;
  readonly status: HostedNativeProcessState;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number | null;
  readonly truncated: boolean;
}

export interface HostedNativeProcessLaunch {
  readonly shell: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly release: () => void;
}

interface OwnedProcess {
  readonly handle: string;
  readonly ownerId: number;
  readonly turnBindingToken: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly closed: Promise<void>;
  state: HostedNativeProcessState;
  stdout: Buffer[];
  stderr: Buffer[];
  outputBytes: number;
  exitCode: number | null;
  truncated: boolean;
  detachListeners: () => void;
}

interface HostedNativeProcessSupervisorOptions {
  readonly idGenerator?: () => string;
  readonly outputByteLimit?: number;
  readonly stopGraceMs?: number;
  readonly maxProcessHandles?: number;
  readonly platform?: NodeJS.Platform;
  readonly terminateProcessTree?: HostedNativeProcessTreeTerminator;
}

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const DEFAULT_STOP_GRACE_MS = 500;
const MAX_PROCESS_HANDLES = 32;

type HostedNativeChildProcess = ChildProcessByStdio<null, Readable, Readable>;
type HostedNativeProcessTreeTerminator = (
  child: HostedNativeChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform
) => void;

export class HostedNativeProcessNotStartedError extends Error {
  constructor() {
    super('Stopped before the native process started.');
    this.name = 'HostedNativeProcessNotStartedError';
  }
}

export class HostedNativeProcessTerminationUnconfirmedError extends Error {
  readonly code = 'PROCESS_TERMINATION_UNCONFIRMED';

  constructor(readonly processId: string) {
    super(`Native process termination could not be confirmed: ${processId}`);
    this.name = 'HostedNativeProcessTerminationUnconfirmedError';
  }
}

function terminateNativeProcessTree(
  child: HostedNativeChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform
): void {
  if (platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  if (child.pid) process.kill(-child.pid, signal);
  else child.kill(signal);
}

export function hostedNativeProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const exact = new Set([
    'PATH',
    'Path',
    'HOME',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'TERM',
    'COLORTERM',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (exact.has(name) || name.startsWith('LC_')) result[name] = value;
  }
  return result;
}

export function hostedNativeShellInvocation(
  platform: NodeJS.Platform,
  command: string,
  windowsComspec = process.env.COMSPEC
): { readonly shell: string; readonly args: readonly string[] } {
  return platform === 'win32'
    ? { shell: windowsComspec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { shell: '/bin/sh', args: ['-c', command] };
}

export class HostedNativeProcessSupervisor {
  private readonly processes = new Map<string, OwnedProcess>();
  private readonly idGenerator: () => string;
  private readonly outputByteLimit: number;
  private readonly stopGraceMs: number;
  private readonly maxProcessHandles: number;
  private readonly platform: NodeJS.Platform;
  private readonly terminateProcessTree: HostedNativeProcessTreeTerminator;

  constructor(options: HostedNativeProcessSupervisorOptions = {}) {
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.outputByteLimit = Math.min(
      Math.max(1, options.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT),
      DEFAULT_OUTPUT_BYTE_LIMIT
    );
    this.stopGraceMs = Math.max(0, options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    this.maxProcessHandles = Math.min(
      Math.max(1, options.maxProcessHandles ?? MAX_PROCESS_HANDLES),
      MAX_PROCESS_HANDLES
    );
    this.platform = options.platform ?? process.platform;
    this.terminateProcessTree = options.terminateProcessTree ?? terminateNativeProcessTree;
  }

  start(
    ownerId: number,
    turnBindingToken: string,
    command: string,
    cwd: string,
    launch?: HostedNativeProcessLaunch
  ): HostedNativeProcessResult {
    try {
      this.pruneTerminalProcessesForCapacity();
      if (this.processes.size >= this.maxProcessHandles) {
        throw new Error('The native process limit has been reached.');
      }
      const handle = this.idGenerator();
      if (!handle || handle.length > 256 || this.processes.has(handle)) {
        throw new Error('Could not create a native process handle.');
      }
      const invocation = launch ?? hostedNativeShellInvocation(this.platform, command);
      const child = spawn(invocation.shell, [...invocation.args], {
        cwd,
        env: launch?.env ?? hostedNativeProcessEnvironment(),
        detached: this.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let settleClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        settleClosed = resolve;
      });
      const owned: OwnedProcess = {
        handle,
        ownerId,
        turnBindingToken,
        child,
        closed,
        state: 'running',
        stdout: [],
        stderr: [],
        outputBytes: 0,
        exitCode: null,
        truncated: false,
        detachListeners: () => undefined,
      };
      const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const available = Math.max(0, this.outputByteLimit - owned.outputBytes);
        if (available === 0) {
          owned.truncated = true;
          return;
        }
        const accepted = chunk.subarray(0, available);
        owned[stream].push(accepted);
        owned.outputBytes += accepted.byteLength;
        if (chunk.byteLength > available) owned.truncated = true;
      };
      const onStdout = (chunk: Buffer): void => append('stdout', chunk);
      const onStderr = (chunk: Buffer): void => append('stderr', chunk);
      const onError = (error: Error): void => {
        append('stderr', Buffer.from(`${owned.stderr.length > 0 ? '\n' : ''}${error.message}`));
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        owned.exitCode = code;
        if (owned.state === 'termination_unconfirmed') {
          owned.state = 'failed';
        } else if (owned.state !== 'stopped') {
          owned.state = code === 0 && signal === null ? 'completed' : 'failed';
        }
        try {
          launch?.release();
        } catch (error) {
          owned.state = 'failed';
          append(
            'stderr',
            Buffer.from(
              `Native process cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`
            )
          );
        } finally {
          settleClosed();
        }
      };
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.once('error', onError);
      child.once('close', onClose);
      owned.detachListeners = () => {
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        child.off('error', onError);
        child.off('close', onClose);
      };
      this.processes.set(handle, owned);
      return this.snapshot(owned);
    } catch (error) {
      launch?.release();
      throw error;
    }
  }

  async run(
    ownerId: number,
    turnBindingToken: string,
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
    launch?: HostedNativeProcessLaunch
  ): Promise<HostedNativeProcessResult> {
    if (signal.aborted) {
      launch?.release();
      throw new HostedNativeProcessNotStartedError();
    }
    const started = this.start(ownerId, turnBindingToken, command, cwd, launch);
    const owned = this.requireOwned(ownerId, turnBindingToken, started.process_id);
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const interrupted = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      abortListener = resolve;
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', abortListener, { once: true });
    });
    const completed = await Promise.race([
      owned.closed.then(() => true),
      interrupted.then(() => false),
    ]);
    if (timer) clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (!completed) await this.stopOwned(owned);
    const result = this.snapshot(owned);
    this.processes.delete(owned.handle);
    return result;
  }

  status(ownerId: number, turnBindingToken: string, handle: string): HostedNativeProcessResult {
    return this.snapshot(this.requireOwned(ownerId, turnBindingToken, handle));
  }

  async stop(
    ownerId: number,
    turnBindingToken: string,
    handle: string
  ): Promise<HostedNativeProcessResult> {
    const owned = this.requireOwned(ownerId, turnBindingToken, handle);
    await this.stopOwned(owned);
    return this.snapshot(owned);
  }

  async cancelOwner(ownerId: number): Promise<void> {
    await this.stopMatching((owned) => owned.ownerId === ownerId);
  }

  async cancelTurnBinding(turnBindingToken: string): Promise<void> {
    await this.stopMatching((owned) => owned.turnBindingToken === turnBindingToken);
  }

  async waitForTurnBindingClosed(turnBindingToken: string): Promise<void> {
    const matches = [...this.processes.values()].filter(
      (owned) => owned.turnBindingToken === turnBindingToken
    );
    await Promise.all(matches.map((owned) => owned.closed));
    for (const owned of matches) {
      if (owned.state !== 'running' && owned.state !== 'termination_unconfirmed') {
        this.processes.delete(owned.handle);
      }
    }
  }

  private requireOwned(ownerId: number, token: string, handle: string): OwnedProcess {
    const owned = this.processes.get(handle);
    if (!owned || owned.ownerId !== ownerId || owned.turnBindingToken !== token) {
      throw new Error('The native process handle is not owned by this AI turn.');
    }
    return owned;
  }

  private async stopMatching(predicate: (owned: OwnedProcess) => boolean): Promise<void> {
    const matches = [...this.processes.values()].filter(predicate);
    const results = await Promise.allSettled(matches.map((owned) => this.stopOwned(owned)));
    for (const owned of matches) {
      if (owned.state !== 'running' && owned.state !== 'termination_unconfirmed') {
        this.processes.delete(owned.handle);
      }
    }
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failed) {
      const reason: unknown = failed.reason;
      throw reason;
    }
  }

  private pruneTerminalProcessesForCapacity(): void {
    if (this.processes.size < this.maxProcessHandles) return;
    for (const [handle, owned] of this.processes) {
      if (owned.state === 'running' || owned.state === 'termination_unconfirmed') continue;
      this.processes.delete(handle);
      if (this.processes.size < this.maxProcessHandles) return;
    }
  }

  private async stopOwned(owned: OwnedProcess): Promise<void> {
    if (owned.state !== 'running' && owned.state !== 'termination_unconfirmed') return;
    owned.state = 'stopped';
    this.kill(owned, 'SIGTERM');
    const exited = await this.waitForClose(owned);
    if (!exited) {
      this.kill(owned, 'SIGKILL');
      if (!(await this.waitForClose(owned))) {
        owned.state = 'termination_unconfirmed';
        throw new HostedNativeProcessTerminationUnconfirmedError(owned.handle);
      }
    }
  }

  private async waitForClose(owned: OwnedProcess): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        owned.closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.stopGraceMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private kill(owned: OwnedProcess, signal: NodeJS.Signals): void {
    try {
      this.terminateProcessTree(owned.child, signal, this.platform);
    } catch {}
  }

  private snapshot(owned: OwnedProcess): HostedNativeProcessResult {
    return {
      process_id: owned.handle,
      status: owned.state,
      stdout: Buffer.concat(owned.stdout).toString('utf8'),
      stderr: Buffer.concat(owned.stderr).toString('utf8'),
      exit_code: owned.exitCode,
      truncated: owned.truncated,
    };
  }
}
