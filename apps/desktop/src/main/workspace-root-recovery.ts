import type Database from 'better-sqlite3';
import { accessSync, constants, lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import type {
  RelinkWorkspaceRootRequest,
  RelinkWorkspaceRootResult,
  WorkspaceRootStatus,
} from '../shared/workspace-root-recovery';
import { rebindWorkspaceRootInDb } from './dev-profile-workspace-path-migration';

function rootState(path: string): WorkspaceRootStatus['state'] {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unavailable';
    accessSync(path, constants.R_OK | constants.X_OK);
    return 'available';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
  }
}

export function listWorkspaceRootStatus(db: Database.Database): WorkspaceRootStatus[] {
  return (db.prepare('SELECT path FROM workspaces').all() as Array<{ path: string }>).map(
    ({ path }) => ({ repoPath: path, state: rootState(path) })
  );
}

export function relinkWorkspaceRoot(
  db: Database.Database,
  request: RelinkWorkspaceRootRequest
): RelinkWorkspaceRootResult {
  return db.transaction((): RelinkWorkspaceRootResult => {
    const workspace = db
      .prepare('SELECT id, path, repo_uuid, origin_path FROM workspaces WHERE path = ?')
      .get(request.repoPath) as
      | { id: number; path: string; repo_uuid: string | null; origin_path: string | null }
      | undefined;
    if (!workspace?.repo_uuid) return { status: 'rejected', reason: 'identity-unavailable' };
    if (rootState(workspace.path) !== 'missing')
      return { status: 'rejected', reason: 'source-present' };
    if (
      db.prepare('SELECT id FROM compute_jobs WHERE workspace_root = ? LIMIT 1').get(workspace.path)
    )
      return { status: 'rejected', reason: 'compute-dependency' };
    if (
      db
        .prepare(
          "SELECT id FROM workspace_sync_renderer_deliveries WHERE workspace_id = ? AND state <> 'succeeded' LIMIT 1"
        )
        .get(workspace.id)
    )
      return { status: 'rejected', reason: 'pending-sync-delivery' };
    if (!isAbsolute(request.selectedPath)) return { status: 'rejected', reason: 'invalid-target' };
    let selectedPath: string;
    let selectedIdentity: Stats;
    try {
      if (rootState(request.selectedPath) !== 'available')
        return { status: 'rejected', reason: 'invalid-target' };
      selectedPath = realpathSync(request.selectedPath);
      selectedIdentity = lstatSync(selectedPath);
      const markerPath = join(selectedPath, MANAGED_WORKSPACE_MARKER);
      const markerStat = lstatSync(markerPath);
      const gitStat = lstatSync(join(selectedPath, '.git'));
      if (
        !markerStat.isFile() ||
        markerStat.isSymbolicLink() ||
        markerStat.size > 64 * 1024 ||
        !gitStat.isDirectory() ||
        gitStat.isSymbolicLink()
      )
        return { status: 'rejected', reason: 'invalid-target' };
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
        schema?: unknown;
        workspaceUuid?: unknown;
      };
      if (marker.schema !== 1 || marker.workspaceUuid !== workspace.repo_uuid)
        return { status: 'rejected', reason: 'identity-mismatch' };
    } catch {
      return { status: 'rejected', reason: 'invalid-target' };
    }
    const others = db
      .prepare('SELECT id, path FROM workspaces WHERE id <> ?')
      .all(workspace.id) as Array<{ id: number; path: string }>;
    if (
      others.some((row) => {
        try {
          return realpathSync(row.path) === selectedPath;
        } catch {
          return resolve(row.path) === selectedPath;
        }
      })
    )
      return { status: 'rejected', reason: 'path-conflict' };
    rebindWorkspaceRootInDb(db, { ...workspace, repo_uuid: workspace.repo_uuid }, selectedPath);
    const currentIdentity = lstatSync(selectedPath);
    if (
      currentIdentity.dev !== selectedIdentity.dev ||
      currentIdentity.ino !== selectedIdentity.ino ||
      rootState(workspace.path) !== 'missing'
    )
      throw new Error('The project folder changed during recovery. No records were changed.');
    return { status: 'relinked', workspaceId: workspace.id, repoPath: selectedPath };
  })();
}
