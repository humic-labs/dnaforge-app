import { createHash, randomUUID } from 'node:crypto';
import { constants, statSync, accessSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  BENCHLING_MIGRATION_BUNDLE_VERSION,
  BENCHLING_MIGRATION_CONTRACT_VERSION,
  BENCHLING_MIGRATION_PROJECTION_VERSION,
  type MigrationRun,
} from '../../shared/benchling-migration';
import { NATIVE_WORKSPACE_MANIFEST_PATH } from '../../shared/native-workspace-manifest';
import { workspaceScopeKey } from '../../shared/workspace-scoped-identity';
import { isGitRepo, resolveHeadCommit } from '../workspace-git';
import {
  tryAcquireWorkspaceMutationShared,
  waitForWorkspaceMutationShared,
  workspaceMutationRootIdentity,
  assertWorkspaceMutationLease,
} from '../workspace-sync-mutation-lease';
import { mergeMigrationLocalIgnore } from './migration-local-ignore';
import { openWorkspaceMigrationStore } from './store';

export type MigrationWorkspaceBinding = Readonly<{
  workspaceDbId: number;
  repoUuid: string | null;
  projectionScopeId: string;
  workspacePath: string;
  displayName: string;
  durability:
    | Readonly<{ kind: 'managed_git'; headCommit: string }>
    | Readonly<{ kind: 'local_filesystem' }>;
}>;

type Release = () => void;

export async function acquireEligibleMigrationWorkspace(
  db: Database.Database,
  workspaceDbId: number,
  options: {
    waitForAvailability?: boolean;
    signal?: AbortSignal;
    assertCanWait?: (rootIdentity: string) => void;
  } = {}
): Promise<
  Readonly<{ binding: MigrationWorkspaceBinding; release: Release; assertCurrent: () => void }>
> {
  options.signal?.throwIfAborted();
  const row = db
    .prepare(
      `SELECT id, name, path, repo_uuid, archived_at, trashed_at
         FROM workspaces
        WHERE id = ?`
    )
    .get(workspaceDbId) as
    | {
        id: number;
        name: string;
        path: string;
        repo_uuid: string | null;
        archived_at: number | null;
        trashed_at: number | null;
      }
    | undefined;
  if (!row || row.archived_at !== null || row.trashed_at !== null) {
    throw new Error('workspace_unavailable');
  }
  let directoryIdentity: { dev: number; ino: number };
  try {
    const info = await stat(row.path);
    directoryIdentity = { dev: info.dev, ino: info.ino };
    if (!info.isDirectory()) throw new Error('workspace_unavailable');
    await access(row.path, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error('workspace_unavailable');
  }
  const rootIdentity = workspaceMutationRootIdentity(row.path);
  options.signal?.throwIfAborted();
  options.assertCanWait?.(rootIdentity);
  const release = options.waitForAvailability
    ? await waitForWorkspaceMutationShared(row.path, { signal: options.signal })
    : tryAcquireWorkspaceMutationShared(row.path);
  if (!release) throw new Error('workspace_busy');
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    const current = db
      .prepare(
        'SELECT id, name, path, repo_uuid, archived_at, trashed_at FROM workspaces WHERE id = ?'
      )
      .get(workspaceDbId) as typeof row | undefined;
    if (
      !current ||
      current.id !== row.id ||
      current.path !== row.path ||
      current.repo_uuid !== row.repo_uuid ||
      current.archived_at !== null ||
      current.trashed_at !== null ||
      workspaceMutationRootIdentity(current.path) !== rootIdentity
    )
      throw new Error('workspace_unavailable');
    const info = statSync(current.path);
    if (
      !info.isDirectory() ||
      info.dev !== directoryIdentity.dev ||
      info.ino !== directoryIdentity.ino
    ) {
      throw new Error('workspace_unavailable');
    }
    accessSync(current.path, constants.R_OK | constants.W_OK);
    options.assertCanWait?.(rootIdentity);
    assertWorkspaceMutationLease(release, current.path);
    return current;
  };
  try {
    const current = assertCurrent();
    const projectionScopeId = workspaceScopeKey(current.repo_uuid, current.id);
    if (!projectionScopeId) throw new Error('workspace_unavailable');
    const headCommit = isGitRepo(current.path) ? await resolveHeadCommit(current.path) : null;
    assertCurrent();
    return {
      binding: {
        workspaceDbId: current.id,
        repoUuid: current.repo_uuid,
        projectionScopeId,
        workspacePath: current.path,
        displayName: current.name,
        durability: headCommit ? { kind: 'managed_git', headCommit } : { kind: 'local_filesystem' },
      },
      release,
      assertCurrent,
    };
  } catch (error) {
    release();
    throw error;
  }
}

export async function adoptWorkspaceHistory(input: {
  binding: MigrationWorkspaceBinding;
  now?: () => string;
  appVersion?: string;
  openStore?: (workspacePath: string) => ReturnType<typeof openWorkspaceMigrationStore>;
}): Promise<MigrationRun> {
  const store = (input.openStore ?? openWorkspaceMigrationStore)(input.binding.workspacePath);
  try {
    const existing = store.getRun();
    if (existing) {
      if (
        existing.workspacePath !== input.binding.workspacePath ||
        (existing.workspaceDbId !== undefined &&
          existing.workspaceDbId !== input.binding.workspaceDbId)
      ) {
        throw new Error('Existing migration history belongs to another workspace.');
      }
      const normalized: MigrationRun = {
        ...existing,
        workspaceDbId: input.binding.workspaceDbId,
        repoUuid: input.binding.repoUuid,
        projectionScopeId: input.binding.projectionScopeId,
        workspaceOrigin:
          existing.workspaceOrigin ??
          ({ kind: 'migration_created' } satisfies MigrationRun['workspaceOrigin']),
      };
      store.saveRun(normalized);
      return normalized;
    }
    if (input.binding.durability.kind === 'managed_git') {
      await mergeMigrationLocalIgnore(input.binding.workspacePath);
    }
    const adoptedAt = (input.now ?? (() => new Date().toISOString()))();
    const run: MigrationRun = {
      version: BENCHLING_MIGRATION_CONTRACT_VERSION,
      id: `migration-adopted-${randomUUID()}`,
      workspaceId: input.binding.projectionScopeId,
      workspaceDbId: input.binding.workspaceDbId,
      repoUuid: input.binding.repoUuid,
      projectionScopeId: input.binding.projectionScopeId,
      workspacePath: input.binding.workspacePath,
      displayName: input.binding.displayName,
      workspaceOrigin: {
        kind: 'adopted_existing',
        workspaceDbId: input.binding.workspaceDbId,
      },
      baseline: {
        kind: 'adopted_workspace',
        adoptedAt,
        existingManifestSha256: await existingManifestSha256(input.binding.workspacePath),
      },
      scope: {
        version: BENCHLING_MIGRATION_CONTRACT_VERSION,
        kind: 'file',
        acquisition: 'local_bundle',
        source: {
          id: `adopted-workspace-ws${input.binding.workspaceDbId}`,
          url: `urn:dnaforge:benchling-adopted-workspace:ws${input.binding.workspaceDbId}`,
          objectType: 'folder',
        },
      },
      binding: null,
      state: 'unlocked',
      resumeState: null,
      attempt: 0,
      converterVersions: {
        app: input.appVersion ?? 'test',
        bundle: BENCHLING_MIGRATION_BUNDLE_VERSION,
        projection: BENCHLING_MIGRATION_PROJECTION_VERSION,
      },
      createdAt: adoptedAt,
      updatedAt: adoptedAt,
      startedAt: null,
      unlockedAt: adoptedAt,
      lastError: null,
    };
    store.saveRun(run);
    return run;
  } finally {
    store.close();
  }
}

export function isVisibleMigrationHistoryRun(run: MigrationRun): boolean {
  return !(
    run.baseline?.kind === 'adopted_workspace' &&
    run.localExportArtifact === undefined &&
    run.linkedItemRecovery === undefined
  );
}

async function existingManifestSha256(workspacePath: string): Promise<`sha256:${string}` | null> {
  try {
    const bytes = await readFile(join(workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH));
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}
