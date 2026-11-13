import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ALLOWED_POSIX_ENV = Object.freeze(['LANG', 'LC_ALL', 'TZ'] as const);

const ALLOWED_WINDOWS_ENV = Object.freeze([
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const);

export interface CodexRuntimeIsolation {
  readonly codexHome: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dispose: () => void;
}

export class CodexRuntimeIsolationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CodexRuntimeIsolationError';
  }
}

export function buildCodexRuntimeEnv(options: {
  readonly codexHome: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const hostEnv = options.hostEnv ?? process.env;
  const platform = options.platform ?? (process.platform as NodeJS.Platform);
  const absolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (!absolute(options.codexHome)) {
    throw new CodexRuntimeIsolationError(
      'relative_codex_home',
      'the isolated Codex home must be an absolute path'
    );
  }

  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: options.codexHome,
    HOME: options.codexHome,
  };

  const names =
    platform === 'win32' ? [...ALLOWED_POSIX_ENV, ...ALLOWED_WINDOWS_ENV] : ALLOWED_POSIX_ENV;
  const hostEntries = Object.entries(hostEnv);
  for (const name of names) {
    const match = hostEntries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (typeof match?.[1] === 'string' && match[1].length > 0) env[name] = match[1];
  }
  if (platform === 'win32') {
    env.USERPROFILE = options.codexHome;
  }
  return env;
}

export function createCodexRuntimeIsolation(options: {
  readonly rootDir: string;
  readonly runId?: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly configToml?: string;
}): CodexRuntimeIsolation {
  if (!path.isAbsolute(options.rootDir)) {
    throw new CodexRuntimeIsolationError(
      'relative_root',
      'the isolation root must be an absolute path'
    );
  }
  const runId = options.runId ?? randomUUID();
  const base = path.join(options.rootDir, 'hosted-codex-runtime', runId);
  const codexHome = path.join(base, 'codex-home');
  const cwd = path.join(base, 'workdir');

  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(codexHome, 'config.toml'), options.configToml ?? '', { mode: 0o600 });

  return {
    codexHome,
    cwd,
    env: buildCodexRuntimeEnv({
      codexHome,
      hostEnv: options.hostEnv,
      platform: options.platform,
    }),
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

export function assertCodexRuntimeIsolation(
  isolation: CodexRuntimeIsolation,
  expectedCodexHomeFiles: readonly string[] = ['config.toml']
): void {
  const homeEntries = readdirSync(isolation.codexHome);
  const actual = [...homeEntries].sort();
  const expected = [...expectedCodexHomeFiles].sort();
  if (actual.join('\u0000') !== expected.join('\u0000')) {
    throw new CodexRuntimeIsolationError(
      'polluted_codex_home',
      `the isolated Codex home contains an unexpected file set: found ${actual.join(', ')}`
    );
  }
  if (readdirSync(isolation.cwd).length > 0) {
    throw new CodexRuntimeIsolationError(
      'polluted_runtime_cwd',
      'the private runtime directory must be empty so no repository content reaches the prompt'
    );
  }
}
