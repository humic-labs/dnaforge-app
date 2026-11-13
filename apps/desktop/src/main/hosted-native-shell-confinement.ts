import type Database from 'better-sqlite3';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readlink, realpath } from 'node:fs/promises';
import { app } from 'electron';
import { isPathInsideBoundary } from '../shared/path-boundary';
import { QUICK_LOOK_PACKAGE_STORE_DIRECTORY } from '../shared/file-associations';
import type { HostedNativeProcessLaunch } from './hosted-native-process-supervisor';
import type { ResolvedCodexAppServerBinary } from './hosted-codex/app-server-binary';
import {
  prepareAgentProcessConfinement,
  type AgentProcessConfinement,
} from './agent-sdk/agent-process-confinement';
import { hostedNativeProcessEnvironment } from './hosted-native-process-supervisor';
import { resolveReferenceAssetCacheRoot } from './reference-assets/reference-asset-cache-root';
import { assertSafePath, assertSafeWritablePath, resolveCanonicalPath } from './ipc/path-allowlist';
import { acquireQuickLookRendererMutationLease } from './workspace-git';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { projectProtectedPaths } from './project-filesystem-authority';
import {
  waitForWorkspaceMutationShared,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';

export interface HostedNativeShellRequest {
  readonly command: string;
  readonly cwd: string;
  readonly workspacePath: string | null;
  readonly scratchRoot: string;
  readonly signal: AbortSignal;
}

export class HostedNativeShellConfinementError extends Error {
  readonly code = 'HOSTED_NATIVE_SHELL_CONFINEMENT_UNAVAILABLE';
  constructor(message: string) {
    super(`Hosted shell commands are unavailable: ${message} No command was started.`);
    this.name = 'HostedNativeShellConfinementError';
  }
}

const execFileAsync = promisify(execFile);
let developerRuntimeRoot: Promise<string | null> | null = null;

async function runtimeReadRoots(binary: ResolvedCodexAppServerBinary): Promise<string[]> {
  developerRuntimeRoot ??= execFileAsync('/usr/bin/xcode-select', ['-p'], {
    encoding: 'utf8',
    timeout: 5000,
  })
    .then(({ stdout }) => {
      const path = stdout.trim();
      return isAbsolute(path) ? resolveCanonicalPath(path) : null;
    })
    .catch(() => null);
  const developer = await developerRuntimeRoot;
  return Promise.all(
    [
      '/opt/homebrew',
      '/usr/local',
      resolve(dirname(binary.path), '..'),
      ...(developer ? [developer] : []),
    ].map((path) => resolveCanonicalPath(path))
  );
}

async function runtimeExecutablePath(readRoots: readonly string[]): Promise<string> {
  const source = hostedNativeProcessEnvironment().PATH ?? '/usr/bin:/bin';
  const executablePath: string[] = [];
  for (const entry of source.split(':')) {
    executablePath.push(entry);
    if (!isAbsolute(entry)) continue;
    for (const name of ['python3', 'node']) {
      try {
        const target = resolve(entry, await readlink(join(entry, name)));
        const executable = await realpath(target);
        if (readRoots.some((root) => isPathInsideBoundary(executable, root)))
          executablePath.push(await realpath(dirname(target)));
      } catch (error) {
        if (!['ENOENT', 'EINVAL', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
    }
  }
  return [...new Set(executablePath)].join(':');
}

function workspaceIsWritable(db: Database.Database, root: string): boolean {
  try {
    assertWorkspaceWriteAllowed(db, [root]);
    return true;
  } catch (error) {
    if (error instanceof Error && /WORKSPACE_READ_ONLY|WORKSPACE_INACTIVE/u.test(error.message))
      return false;
    throw error;
  }
}

export async function prepareHostedNativeShellLaunch(input: {
  readonly db: Database.Database;
  readonly request: HostedNativeShellRequest;
  readonly privateRoot: string;
  readonly resolveBinary: () => Promise<ResolvedCodexAppServerBinary>;
  readonly platform?: NodeJS.Platform;
}): Promise<HostedNativeProcessLaunch> {
  if ((input.platform ?? process.platform) !== 'darwin')
    throw new HostedNativeShellConfinementError(
      'filesystem confinement is not qualified on this platform. Use native file tools'
    );
  if (input.request.signal.aborted)
    throw new HostedNativeShellConfinementError('the operation was stopped');
  let binary: ResolvedCodexAppServerBinary;
  try {
    binary = await input.resolveBinary();
  } catch (error) {
    throw new HostedNativeShellConfinementError(
      `the bundled sandbox launcher could not be verified (${error instanceof Error ? error.message : 'verification failed'})`
    );
  }
  const scratchRoot = await assertSafeWritablePath(input.request.scratchRoot, {
    requireAbsolute: true,
  });
  const workspacePath = input.request.workspacePath
    ? await assertSafePath(input.request.workspacePath, { requireAbsolute: true })
    : null;
  const cwd = await realpath(input.request.cwd);
  if (cwd !== (workspacePath ?? scratchRoot))
    throw new HostedNativeShellConfinementError(
      'the working directory differs from its bound project'
    );
  function nestedProjectRoots(): string[] {
    const currentRows = input.db
      .prepare('SELECT path FROM workspaces WHERE path IS NOT NULL')
      .all() as Array<{ path: string }>;
    const paths = currentRows.map((row) => workspaceMutationRootIdentity(row.path));
    if (workspacePath && paths.filter((path) => path === workspacePath).length !== 1)
      throw new HostedNativeShellConfinementError(
        'the bound project owner is missing or ambiguous'
      );
    return workspacePath
      ? [
          ...new Set(
            paths.filter(
              (path) => path !== workspacePath && isPathInsideBoundary(path, workspacePath)
            )
          ),
        ].sort()
      : [];
  }
  const nestedRoots = nestedProjectRoots();
  const releases: Array<() => void> = [];
  let confinement: AgentProcessConfinement | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      confinement?.dispose();
    } finally {
      for (const close of releases.reverse()) close();
    }
  };
  try {
    const canonicalWritableRoots = [scratchRoot];
    if (workspacePath && workspaceIsWritable(input.db, workspacePath))
      canonicalWritableRoots.push(
        await assertSafeWritablePath(workspacePath, { requireAbsolute: true })
      );
    releases.push(acquireQuickLookRendererMutationLease(canonicalWritableRoots));
    for (const root of [...new Set(workspacePath ? [workspacePath, ...nestedRoots] : [])].sort())
      releases.push(await waitForWorkspaceMutationShared(root, { signal: input.request.signal }));
    if (input.request.signal.aborted)
      throw new HostedNativeShellConfinementError('the operation was stopped');
    const currentNestedRoots = nestedProjectRoots();
    if (currentNestedRoots.join('\0') !== [...nestedRoots].sort().join('\0'))
      throw new HostedNativeShellConfinementError(
        'project ownership changed while waiting; retry the command'
      );
    assertWorkspaceWriteAllowed(input.db, [scratchRoot]);
    const writableRoots = [await assertSafeWritablePath(scratchRoot, { requireAbsolute: true })];
    if (workspacePath && workspaceIsWritable(input.db, workspacePath))
      writableRoots.push(await assertSafeWritablePath(workspacePath, { requireAbsolute: true }));
    const privateRoot = await resolveCanonicalPath(input.privateRoot);
    if (writableRoots.some((root) => isPathInsideBoundary(privateRoot, root)))
      throw new HostedNativeShellConfinementError(
        'the policy directory overlaps a model-writable project'
      );
    const deniedRoots = [
      ...new Set([
        ...(workspacePath ? projectProtectedPaths(workspacePath) : []),
        ...(
          input.db.prepare('SELECT path FROM workspaces WHERE path IS NOT NULL').all() as Array<{
            path: string;
          }>
        )
          .map((row) => workspaceMutationRootIdentity(row.path))
          .filter((root) => root !== workspacePath && !isPathInsideBoundary(scratchRoot, root)),
        privateRoot,
        await resolveCanonicalPath(
          resolveReferenceAssetCacheRoot({ appDataRoot: app.getPath('appData'), env: process.env })
        ),
        await resolveCanonicalPath(
          join(app.getPath('userData'), QUICK_LOOK_PACKAGE_STORE_DIRECTORY)
        ),
      ]),
    ];
    const runtimeRoots = await runtimeReadRoots(binary);
    const executablePath = await runtimeExecutablePath(runtimeRoots);
    confinement = await prepareAgentProcessConfinement({
      cwd,
      writableRoots,
      scratchRoot,
      privateRoot,
      readRoots: [...runtimeRoots, ...(workspacePath ? [workspacePath] : [])],
      protectedRoots: deniedRoots,
      restrictReads: true,
    });
    const launch = confinement.wrap('/bin/sh', ['-c', input.request.command], {
      ...hostedNativeProcessEnvironment(),
      PATH: executablePath,
      HOME: scratchRoot,
      TMPDIR: scratchRoot,
    });
    return {
      shell: launch.command,
      args: launch.args,
      env: launch.env as Record<string, string>,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
