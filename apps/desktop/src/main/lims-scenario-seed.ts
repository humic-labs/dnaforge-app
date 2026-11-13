import { isScenarioMutationRequested } from '../shared/scenario-mutation';
import type Database from 'better-sqlite3';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { isPathInsideBoundary } from '../shared/path-boundary';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import { withLimsScenarioSeedContext } from './lims-scenario-context';
import { isDisposableScenarioProfileAuthorized } from './scenario-profile';
import { commitAllIfDirty, initManagedRepo } from './workspace-git';

export type LimsScenarioDataset = 'demo' | 'mock' | 'starter' | 'practice';

export async function seedLimsScenarioWithOwnedFixtures<T>(input: {
  db: Database.Database;
  dataset: LimsScenarioDataset;
  runDatabase: <R>(operation: () => R) => R;
  seed: () => T;
}): Promise<T> {
  const profilePath = app.getPath('userData');
  if (!isDisposableScenarioProfileAuthorized(profilePath)) {
    throw new Error(
      'Registry fixture copies require an approved disposable LIMS scenario profile.'
    );
  }
  const managedRoot = join(profilePath, 'managed-workspaces');
  await mkdir(managedRoot, { recursive: true });
  const canonicalRoot = await realpath(managedRoot);
  if (!isPathInsideBoundary(canonicalRoot, await realpath(profilePath))) {
    throw new Error('Scenario workspace storage is outside its approved temporary profile.');
  }
  const key = `developer-registry-scenario-workspace:${input.dataset}`;
  const existing = input.runDatabase(() =>
    input.db
      .prepare(
        `SELECT w.id, w.path, w.repo_uuid FROM workspaces w JOIN settings s ON s.value=w.repo_uuid WHERE s.key=?`
      )
      .get(key)
  ) as { id: number; path: string; repo_uuid: string } | undefined;
  let uuid: string;
  let repoPath: string;
  const createdAt = Date.now();
  if (existing) {
    uuid = existing.repo_uuid;
    repoPath = await realpath(existing.path);
    if (!isPathInsideBoundary(repoPath, canonicalRoot) || !existsSync(join(repoPath, '.git'))) {
      throw new Error('The saved Registry scenario project is no longer owned by this profile.');
    }
    const marker: unknown = JSON.parse(
      readFileSync(join(repoPath, MANAGED_WORKSPACE_MARKER), 'utf8')
    );
    if (
      !marker ||
      typeof marker !== 'object' ||
      !('workspaceUuid' in marker) ||
      marker.workspaceUuid !== uuid
    ) {
      throw new Error('Registry scenario workspace identity does not match its stored owner.');
    }
  } else {
    uuid = randomUUID();
    const container = join(canonicalRoot, uuid);
    await mkdir(container, { recursive: false, mode: 0o700 });
    repoPath = join(container, 'repo');
    try {
      await mkdir(repoPath, { recursive: false, mode: 0o700 });
      await writeFile(
        join(repoPath, MANAGED_WORKSPACE_MARKER),
        `${JSON.stringify(
          {
            schema: 1,
            workspaceUuid: uuid,
            originPath: null,
            importedAt: createdAt,
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      await initManagedRepo(repoPath);
      await commitAllIfDirty(repoPath, 'Create Registry scenario project');
    } catch (error) {
      await rm(container, { recursive: true, force: true });
      throw error;
    }
  }
  const createdFiles = new Set<string>();
  try {
    return input.runDatabase(() =>
      input.db.transaction(() => {
        if (!existing) {
          input.db
            .prepare(
              `INSERT INTO workspaces(name,path,repo_uuid,origin_path,created_at,last_opened_at)
           VALUES(?,?,?,NULL,?,?)`
            )
            .run(`Registry ${input.dataset} scenario`, repoPath, uuid, createdAt, createdAt);
          input.db
            .prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)`)
            .run(key, uuid, createdAt);
        }
        const row = input.db
          .prepare('SELECT id FROM workspaces WHERE repo_uuid=? AND path=?')
          .get(uuid, repoPath) as { id: number } | undefined;
        if (!row) throw new Error('Registry scenario workspace registration failed.');
        return withLimsScenarioSeedContext(
          input.db,
          { workspaceId: row.id, repoPath, createdFiles },
          input.seed
        );
      })()
    );
  } catch (error) {
    if (!existing) {
      await rm(join(canonicalRoot, uuid), { recursive: true, force: true });
    } else {
      for (const file of createdFiles) {
        if (isPathInsideBoundary(file, repoPath) && relative(repoPath, file))
          await rm(file, { force: true });
      }
    }
    throw error;
  }
}

function isLimsScenarioMutationAllowed(): boolean {
  return (
    isScenarioMutationRequested(process.argv, process.env) &&
    isDisposableScenarioProfileAuthorized(app.getPath('userData'))
  );
}

export function assertLimsScenarioMutationAllowed(operation: string): void {
  if (isLimsScenarioMutationAllowed()) return;
  throw new Error(
    `${operation} requires a disposable LIMS scenario profile. ` +
      'Request scenario mutation without --user-data-dir for a fresh temporary profile, ' +
      'or use an initially empty directory inside the OS temporary directory.'
  );
}
