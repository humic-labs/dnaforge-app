import { app } from 'electron';
import { spawn } from 'node:child_process';
import { constants, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import { resolveCanonicalPath } from '../ipc/path-allowlist';
import { projectProtectedPaths } from '../project-filesystem-authority';
import { assertWorkspaceWriteAllowed } from '../workspace-write-admission';
import { nodeAwareSpawn } from './cli-layout';
import {
  AGENT_SEATBELT_BASE_POLICY,
  AGENT_SEATBELT_PLATFORM_POLICY,
} from './agent-seatbelt-policy';
import { resolveAmbientGrokAuthPath } from './subprocess-env';

export class AgentProcessConfinementError extends Error {
  readonly code = 'AGENT_PROCESS_CONFINEMENT_UNAVAILABLE';

  constructor(message: string) {
    super(`The agent cannot start because filesystem protection is unavailable: ${message}`);
    this.name = 'AgentProcessConfinementError';
  }
}

export interface ConfinedAgentProcessLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface AgentProcessConfinement {
  readonly cwd: string;
  readonly scratchRoot: string;
  wrap(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv
  ): ConfinedAgentProcessLaunch;
  executable(command: string, env: NodeJS.ProcessEnv): { path: string; env: NodeJS.ProcessEnv };
  spawn(options: SpawnOptions): SpawnedProcess;
  dispose(): void;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function overlaps(left: string, right: string): boolean {
  return isPathInsideBoundary(left, right) || isPathInsideBoundary(right, left);
}

export async function prepareAgentProcessConfinement(input: {
  cwd: string;
  writableRoots?: readonly string[];
  scratchRoot: string;
  privateRoot: string;
  protectedRoots: readonly string[];
  readRoots?: readonly string[];
  readOnlyRoots?: readonly string[];
  runtimeWritableRoots?: readonly string[];
  restrictReads?: boolean;
  resolveExecutable?: () => Promise<string>;
  platform?: NodeJS.Platform;
}): Promise<AgentProcessConfinement> {
  if ((input.platform ?? process.platform) !== 'darwin')
    throw new AgentProcessConfinementError('this platform has no qualified process sandbox.');
  const paths = [
    input.cwd,
    input.scratchRoot,
    input.privateRoot,
    ...(input.writableRoots ?? []),
    ...(input.readRoots ?? []),
    ...(input.runtimeWritableRoots ?? []),
    ...(input.readOnlyRoots ?? []),
    ...input.protectedRoots,
  ];
  if (paths.some((path) => !isAbsolute(path) || path.includes('\0')))
    throw new AgentProcessConfinementError('a filesystem boundary is not an absolute path.');
  const [cwd, scratchRoot, privateRoot, ...canonicalPaths] = await Promise.all(
    paths.map((path) => resolveCanonicalPath(path))
  );
  const canonical = new Map(paths.slice(3).map((path, index) => [path, canonicalPaths[index]]));
  const writableRoots = [
    scratchRoot,
    ...(input.writableRoots ?? []).map((path) => canonical.get(path)!),
    ...(input.runtimeWritableRoots ?? []).map((path) => canonical.get(path)!),
  ];
  if (writableRoots.some((root) => overlaps(root, privateRoot)))
    throw new AgentProcessConfinementError('the private policy overlaps an agent-writable folder.');
  let executable: string;
  try {
    executable = await (input.resolveExecutable?.() ?? Promise.resolve('/usr/bin/sandbox-exec'));
    if (executable !== '/usr/bin/sandbox-exec')
      throw new Error('the process sandbox must be the macOS system executable');
    await access(executable, constants.X_OK);
  } catch (cause) {
    throw new AgentProcessConfinementError(
      `the system sandbox could not be verified (${cause instanceof Error ? cause.message : String(cause)}).`
    );
  }
  const systemReadRoots = input.restrictReads
    ? [
        '/System',
        '/usr',
        '/bin',
        '/sbin',
        '/Library/Apple',
        '/private/etc',
        '/private/var/db',
        '/dev',
      ]
    : ['/'];
  const entries = new Map<string, string>(systemReadRoots.map((root) => [root, 'read']));
  for (const root of input.readRoots ?? []) entries.set(canonical.get(root)!, 'read');
  for (const root of writableRoots) entries.set(root, 'write');
  for (const root of input.readOnlyRoots ?? []) {
    entries.set(canonical.get(root)!, 'read');
    entries.set(resolve(root), 'read');
  }
  for (const root of input.protectedRoots) entries.set(canonical.get(root)!, 'deny');
  entries.set(privateRoot, 'deny');
  const strictRoots = new Set([
    scratchRoot,
    ...(input.writableRoots ?? []).map((root) => canonical.get(root)!),
  ]);
  const policy = [
    AGENT_SEATBELT_BASE_POLICY,
    ...(input.restrictReads ? [AGENT_SEATBELT_PLATFORM_POLICY] : []),
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-bind (local ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
    '(allow system-socket (socket-domain AF_UNIX))',
    `(allow network-bind (local unix-socket (subpath ${JSON.stringify(scratchRoot)})))`,
    `(allow network-outbound (remote unix-socket (subpath ${JSON.stringify(scratchRoot)})))`,
    '(deny system-fcntl (fcntl-command 80 110))',
  ];
  for (const [root, mode] of entries) {
    if (mode === 'deny') continue;
    const filters = [`(subpath ${JSON.stringify(root)})`];
    for (const [excluded] of entries) {
      if (excluded === root || !isPathInsideBoundary(excluded, root)) continue;
      filters.push(`(require-not (literal ${JSON.stringify(excluded)}))`);
      filters.push(`(require-not (subpath ${JSON.stringify(excluded)}))`);
    }
    const readFilter = `(require-all ${filters.join(' ')})`;
    policy.push(`(allow file-read* file-map-executable file-test-existence ${readFilter})`);
    if (mode !== 'write') continue;
    if (strictRoots.has(root)) filters.push(`(require-not (literal ${JSON.stringify(root)}))`);
    policy.push(`(allow file-write* (require-all ${filters.join(' ')}))`);
  }
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const policyDirectory = mkdtempSync(join(privateRoot, 'launch-'));
  const policyPath = join(policyDirectory, 'policy.sbpl');
  writeFileSync(policyPath, policy.join('\n'), { mode: 0o400, flag: 'wx' });
  let disposed = false;
  let wrappers = 0;
  const wrap: AgentProcessConfinement['wrap'] = (command, args, env) => {
    if (disposed) throw new AgentProcessConfinementError('the process policy has expired.');
    if (!isAbsolute(command))
      throw new AgentProcessConfinementError('the runtime executable must be an absolute path.');
    return {
      command: executable,
      args: ['-f', policyPath, command, ...args],
      env: { ...env, TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot },
    };
  };
  return {
    cwd,
    scratchRoot,
    wrap,
    executable: (command, env) => {
      const invocation = wrap(command, [], env);
      const path = join(policyDirectory, `runtime-${++wrappers}`);
      writeFileSync(
        path,
        `#!/bin/sh\nexec ${[invocation.command, ...invocation.args].map(quote).join(' ')} "$@"\n`,
        { mode: 0o500, flag: 'wx' }
      );
      return { path, env: invocation.env };
    },
    spawn: (options) => {
      const runtime =
        options.command === 'node'
          ? {
              file: process.execPath,
              args: options.args,
              env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
            }
          : nodeAwareSpawn(options.command, options.args, options.env);
      const invocation = wrap(runtime.file, runtime.args, runtime.env);
      return spawn(invocation.command, invocation.args, {
        cwd,
        env: invocation.env,
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      rmSync(policyDirectory, { recursive: true, force: true });
    },
  };
}

export async function prepareManagedAgentProcessConfinement(input: {
  provider: 'claude' | 'codex' | 'grok';
  cwd?: string | null;
  writableRoots?: readonly string[];
  purpose?: 'probe' | 'chat';
  env: NodeJS.ProcessEnv;
  authorityReadPaths?: readonly string[];
  runtimeExecutable?: string;
}): Promise<AgentProcessConfinement> {
  const { getDb } = await import('../ipc/database');
  const db = getDb();
  const appData = await resolveCanonicalPath(app.getPath('userData'));
  const appScratchRoot = await resolveCanonicalPath(join(appData, 'cli-scratch'));
  const scratchRoot = mkdtempSync(join(await resolveCanonicalPath(tmpdir()), 'df-'));
  try {
    const rows = db.prepare('SELECT path FROM workspaces WHERE path IS NOT NULL').all() as Array<{
      path: string;
    }>;
    const roots = [
      ...new Set(await Promise.all(rows.map((row) => resolveCanonicalPath(row.path)))),
    ];
    const cwd =
      input.purpose === 'chat' && input.cwd ? await resolveCanonicalPath(input.cwd) : scratchRoot;
    const isAppScratchCwd = isPathInsideBoundary(cwd, appScratchRoot);
    if (!roots.includes(cwd) && cwd !== scratchRoot && !isAppScratchCwd)
      throw new AgentProcessConfinementError('the working folder has no registered project owner.');
    const requestedRoots =
      input.purpose === 'chat' ? [...new Set([cwd, ...(input.writableRoots ?? [])])] : [];
    const writableRoots: string[] = [];
    const readRoots: string[] = [];
    for (const requested of requestedRoots) {
      const root = await resolveCanonicalPath(requested);
      if (root === cwd && (root === scratchRoot || isAppScratchCwd)) {
        writableRoots.push(root);
        continue;
      }
      if (!roots.includes(root))
        throw new AgentProcessConfinementError(
          'a requested folder has no registered project owner.'
        );
      readRoots.push(root);
      try {
        assertWorkspaceWriteAllowed(db, [root]);
        writableRoots.push(root);
      } catch (cause) {
        if (
          !(cause instanceof Error) ||
          !/WORKSPACE_READ_ONLY|WORKSPACE_INACTIVE/u.test(cause.message)
        )
          throw cause;
      }
    }
    const home = input.env.HOME?.trim() || homedir();
    const providerHome =
      input.provider === 'claude'
        ? input.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
        : input.provider === 'codex'
          ? input.env.CODEX_HOME?.trim() || join(home, '.codex')
          : process.env.GROK_HOME?.trim() || join(home, '.grok');
    const runtimeWritableRoots =
      input.provider === 'claude'
        ? [providerHome, join(home, '.claude.json')]
        : input.provider === 'codex'
          ? [providerHome]
          : [providerHome];
    const readOnlyRoots = [
      ...[
        'config.toml',
        'requirements.toml',
        'settings.json',
        'settings.local.json',
        'hooks',
        'plugins',
      ].map((name) => join(providerHome, name)),
      ...(input.provider === 'claude' ? [join(home, '.claude.json')] : []),
    ];
    if (input.provider === 'grok') {
      const authPath = resolveAmbientGrokAuthPath({
        userHome: home,
        ambientGrokHome: process.env.GROK_HOME,
        ambientAuthPath: process.env.GROK_AUTH_PATH,
      });
      if (
        !isPathInsideBoundary(
          await resolveCanonicalPath(authPath),
          await resolveCanonicalPath(providerHome)
        )
      )
        runtimeWritableRoots.push(authPath);
    }
    if (input.runtimeExecutable) {
      if (!isAbsolute(input.runtimeExecutable))
        throw new AgentProcessConfinementError('the runtime executable must be an absolute path.');
      const installed = await resolveCanonicalPath(input.runtimeExecutable);
      if (roots.some((root) => isPathInsideBoundary(installed, root)))
        throw new AgentProcessConfinementError(
          'the agent executable belongs to a writable project.'
        );
      const canonicalHome = await resolveCanonicalPath(providerHome);
      for (const executablePath of [resolve(input.runtimeExecutable), installed]) {
        for (const root of [resolve(providerHome), canonicalHome]) {
          if (!isPathInsideBoundary(executablePath, root)) continue;
          const directory = relative(root, executablePath).split('/')[0];
          if (directory) readOnlyRoots.push(join(root, directory));
        }
      }
    }
    const appCode = await resolveCanonicalPath(app.getAppPath());
    for (const root of writableRoots) {
      if (overlaps(root, appCode) || isPathInsideBoundary(appData, root))
        throw new AgentProcessConfinementError(
          'a writable project overlaps protected application storage.'
        );
    }
    for (const runtimeRoot of runtimeWritableRoots) {
      const canonical = await resolveCanonicalPath(runtimeRoot);
      if ([appData, appCode, ...roots].some((root) => overlaps(canonical, root)))
        throw new AgentProcessConfinementError(
          'the provider session folder overlaps protected app or project storage.'
        );
    }
    const confinement = await prepareAgentProcessConfinement({
      cwd,
      writableRoots,
      scratchRoot,
      privateRoot: join(appData, 'agent-process-policies'),
      protectedRoots: [
        appData,
        ...roots.filter((root) => !readRoots.includes(root)),
        ...roots.flatMap(projectProtectedPaths),
      ],
      readRoots: [...readRoots, ...(input.authorityReadPaths ?? [])],
      readOnlyRoots,
      runtimeWritableRoots,
    });
    return {
      ...confinement,
      dispose: () => {
        confinement.dispose();
        rmSync(scratchRoot, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    rmSync(scratchRoot, { recursive: true, force: true });
    throw cause;
  }
}
