import { spawnSync } from 'node:child_process';
import { constants as fsConstants, accessSync } from 'node:fs';
import { resolveGitBinary } from 'dugite';

export type BundledGitExecution = Readonly<{
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stdout: string;
  stderr: string;
}>;

export type BundledGitReadinessDependencies = Readonly<{
  resolveBinary?: () => string;
  assertExecutable?: (binaryPath: string) => void;
  execute?: (binaryPath: string) => BundledGitExecution;
}>;

export class BundledGitRuntimeError extends Error {
  readonly code: 'BUNDLED_GIT_MISSING' | 'BUNDLED_GIT_EXECUTION' | 'BUNDLED_GIT_VERSION';

  constructor(
    code: 'BUNDLED_GIT_MISSING' | 'BUNDLED_GIT_EXECUTION' | 'BUNDLED_GIT_VERSION',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'BundledGitRuntimeError';
    this.code = code;
  }
}

function executeVersion(binaryPath: string): BundledGitExecution {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function assertBundledGitRuntimeReady(
  dependencies: BundledGitReadinessDependencies = {}
): Readonly<{ binaryPath: string; version: string }> {
  const binaryPath = (dependencies.resolveBinary ?? (() => resolveGitBinary('')))();
  try {
    (dependencies.assertExecutable ?? ((target) => accessSync(target, fsConstants.X_OK)))(
      binaryPath
    );
  } catch (cause) {
    throw new BundledGitRuntimeError(
      'BUNDLED_GIT_MISSING',
      `DNAForge's bundled Git runtime is missing or not executable at ${binaryPath}. ` +
        'Reinstall DNAForge, or run node apps/desktop/scripts/ensure-dugite-git.cjs in a source checkout.',
      { cause }
    );
  }

  const result = (dependencies.execute ?? executeVersion)(binaryPath);
  if (result.error || result.signal || result.status !== 0) {
    throw new BundledGitRuntimeError(
      'BUNDLED_GIT_EXECUTION',
      `DNAForge's bundled Git runtime could not start: ${
        result.error?.message || result.signal || result.stderr.trim() || `exit ${result.status}`
      }`
    );
  }
  const version = result.stdout.trim();
  if (!/^git version \d+\.\d+/u.test(version)) {
    throw new BundledGitRuntimeError(
      'BUNDLED_GIT_VERSION',
      `DNAForge's bundled Git runtime returned an invalid version response: ${version || '<empty>'}`
    );
  }
  return { binaryPath, version };
}
