import gitReadWorkerAssetPath from '../../../resources/git-read-worker.cjs?asset';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { STERILE_GIT_READ_RUNTIME, type SterileGitReadRuntime } from './git-read-executor';
import {
  GIT_READ_CONFIG_ARGS,
  GIT_READ_MAX_BUFFER,
  GIT_READ_MAX_METADATA_BUFFER,
} from './git-read-policy';
import type { GitReadExecutionControl } from './git-read-request-owner';
import { createMutableSubprocessEnvironment } from './sterile-subprocess-environment';

const HELPER_NULL_EXIT_CODE = 3;
const HELPER_TREE_KILL_GRACE_MS = 4_000;
function workerPath(override?: string): string {
  if (override) return override;
  return typeof gitReadWorkerAssetPath === 'string' && gitReadWorkerAssetPath.length > 0
    ? gitReadWorkerAssetPath
    : resolve(process.cwd(), 'resources', 'git-read-worker.cjs');
}

function helperLaunch(input: {
  readonly errorPrefix: string;
  readonly guardianExecutable?: string;
  readonly workerScriptPath?: string;
}): { readonly executable: string; readonly args: readonly string[]; readonly detached: boolean } {
  const script = workerPath(input.workerScriptPath);
  if (process.platform !== 'win32') {
    return { executable: process.execPath, args: [script], detached: true };
  }
  if (!input.guardianExecutable?.trim()) {
    throw new Error(
      `[${input.errorPrefix}] Windows Git process guardian is unavailable; no subprocess was started.`
    );
  }
  return {
    executable: input.guardianExecutable,
    args: ['--owner-pid', String(process.pid), '--', process.execPath, script],
    detached: false,
  };
}

export async function readGitHeadFromAllowedRoots(input: {
  readonly filePath: string;
  readonly allowedRoots: readonly string[];
  readonly errorPrefix: string;
  readonly control: GitReadExecutionControl;
  readonly runtime?: SterileGitReadRuntime;
  readonly guardianExecutable?: string;
  readonly workerScriptPath?: string;
}): Promise<string | null> {
  const runtime = input.runtime ?? STERILE_GIT_READ_RUNTIME;
  const launch = helperLaunch(input);
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'dnaforge-git-read-'));
  const payload = JSON.stringify({
    filePath: input.filePath,
    allowedRoots: input.allowedRoots,
    gitExecutable: runtime.executable,
    gitArgumentPrefix: runtime.argumentPrefix,
    gitConfigArgs: GIT_READ_CONFIG_ARGS,
    metadataMaxBuffer: GIT_READ_MAX_METADATA_BUFFER,
    contentMaxBuffer: GIT_READ_MAX_BUFFER,
    snapshotRoot,
  });

  return new Promise<string | null>((resolvePromise, rejectPromise) => {
    const child = spawn(launch.executable, [...launch.args], {
      env: createMutableSubprocessEnvironment(runtime.environment, { ELECTRON_RUN_AS_NODE: '1' }),
      detached: launch.detached,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | null = null;
    let settled = false;
    let helperHardKillTimer: NodeJS.Timeout | null = null;

    const processGroupIsAlive = (groupId: number): boolean => {
      try {
        process.kill(-groupId, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    const drainPosixHelperProcessGroup = async (): Promise<void> => {
      if (process.platform === 'win32' || !child.pid || !processGroupIsAlive(child.pid)) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (!processGroupIsAlive(child.pid)) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      if (processGroupIsAlive(child.pid)) {
        throw new Error(`Git helper process group ${String(child.pid)} did not terminate.`);
      }
    };
    const killHelperTree = (signal: NodeJS.Signals): boolean => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch {
          if (child.exitCode !== null || child.signalCode !== null) return false;
          return child.kill(signal);
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) return false;
      return child.kill(signal);
    };
    const ownedHelper = {
      get exitCode(): number | null {
        return child.exitCode;
      },
      get signalCode(): NodeJS.Signals | null {
        return child.signalCode;
      },
      kill: killHelperTree,
      once: child.once.bind(child),
      removeListener: child.removeListener.bind(child),
    };
    const clearOwnership = (): void => {
      input.control.signal.removeEventListener('abort', requestHelperCancellation);
      if (helperHardKillTimer) clearTimeout(helperHardKillTimer);
      helperHardKillTimer = null;
    };
    const requestHelperCancellation = (): void => {
      killHelperTree('SIGTERM');
      if (helperHardKillTimer) return;
      helperHardKillTimer = setTimeout(() => killHelperTree('SIGKILL'), HELPER_TREE_KILL_GRACE_MS);
      helperHardKillTimer.unref?.();
    };

    input.control.bindProcess(ownedHelper);
    input.control.signal.addEventListener('abort', requestHelperCancellation, { once: true });
    if (input.control.signal.aborted) requestHelperCancellation();

    if (!child.stdin || !child.stdout || !child.stderr) {
      failure = new Error(`[${input.errorPrefix}] Git read helper pipes are unavailable.`);
      requestHelperCancellation();
    } else {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > GIT_READ_MAX_BUFFER) {
          failure ??= new Error(`[${input.errorPrefix}] Git read stdout exceeded its byte limit.`);
          requestHelperCancellation();
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > GIT_READ_MAX_METADATA_BUFFER) {
          failure ??= new Error(`[${input.errorPrefix}] Git read stderr exceeded its byte limit.`);
          requestHelperCancellation();
          return;
        }
        stderrChunks.push(chunk);
      });
      child.stdin.on('error', (error: Error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (input.control.signal.aborted && (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED')) {
          return;
        }
        failure ??= new Error(
          `[${input.errorPrefix}] Git read helper stdin failed: ${error.message}`
        );
        requestHelperCancellation();
      });
      child.stdin.write(`${payload}\n`);
    }

    child.once('error', (error: Error) => {
      failure ??= new Error(`[${input.errorPrefix}] ${error.message}`);
      requestHelperCancellation();
    });
    child.once('close', async (code) => {
      if (settled) return;
      settled = true;
      clearOwnership();
      child.stdin?.destroy();
      try {
        await drainPosixHelperProcessGroup();
      } catch (error) {
        failure ??= new Error(
          `[${input.errorPrefix}] ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (failure) {
        rejectPromise(failure);
        return;
      }
      if (code === 0) {
        resolvePromise(Buffer.concat(stdoutChunks).toString('utf8'));
        return;
      }
      if (code === HELPER_NULL_EXIT_CODE) {
        resolvePromise(null);
        return;
      }
      const detail = Buffer.concat(stderrChunks).toString('utf8').trim();
      rejectPromise(
        new Error(`[${input.errorPrefix}] ${detail || `Git read helper exited ${String(code)}`}`)
      );
    });
  }).finally(async () => {
    await rm(snapshotRoot, { recursive: true, force: true });
  });
}
