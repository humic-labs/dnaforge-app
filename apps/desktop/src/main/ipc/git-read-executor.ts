import { execFile } from 'node:child_process';

import {
  resolveEmbeddedGitDir,
  resolveGitBinary,
  resolveGitExecPath,
  setupEnvironment,
} from 'dugite';

import type { GitReadExecutionControl } from './git-read-request-owner';
import { GIT_READ_CONFIG_ARGS, GIT_READ_ENV } from './git-read-policy';
import {
  createMutableSubprocessEnvironment,
  createSterileOsEnvironment,
} from './sterile-subprocess-environment';

export interface SterileGitReadRuntime {
  readonly executable: string;
  readonly argumentPrefix: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function createSterileGitReadRuntime(
  ambientEnvironment: NodeJS.ProcessEnv = process.env
): SterileGitReadRuntime {
  const embeddedGitDirectory = resolveEmbeddedGitDir();
  const embeddedGitExecPath = resolveGitExecPath(embeddedGitDirectory, '');
  const runtime = setupEnvironment(
    {
      ...GIT_READ_ENV,
      LOCAL_GIT_DIRECTORY: embeddedGitDirectory,
      GIT_EXEC_PATH: embeddedGitExecPath,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
    createSterileOsEnvironment(ambientEnvironment)
  );
  return {
    executable: resolveGitBinary(embeddedGitDirectory),
    argumentPrefix: Object.freeze([]),
    environment: Object.freeze(runtime.env),
  };
}

export const STERILE_GIT_READ_RUNTIME = createSterileGitReadRuntime();

export async function executeOwnedGitRead(input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly maxBuffer: number;
  readonly control: GitReadExecutionControl;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      STERILE_GIT_READ_RUNTIME.executable,
      [...STERILE_GIT_READ_RUNTIME.argumentPrefix, ...GIT_READ_CONFIG_ARGS, ...input.args],
      {
        cwd: input.cwd,
        encoding: 'utf8',
        env: createMutableSubprocessEnvironment(STERILE_GIT_READ_RUNTIME.environment),
        maxBuffer: input.maxBuffer,
        signal: input.control.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error || typeof error.code === 'number') {
          resolve({ stdout, stderr, exitCode: typeof error?.code === 'number' ? error.code : 0 });
          return;
        }
        reject(error);
      }
    );
    input.control.bindProcess(child);
  });
}
