import { normalizeWorkspaceTimestamp } from '../../shared/workspace-access';
export { normalizeWorkspaceTimestamp } from '../../shared/workspace-access';
import { platform } from '../../platform';
import { TRASH_RETENTION_MS } from '../../shared/workspace-git-types';
import type { WorkspaceAccess } from '../../shared/workspace-access';

export { TRASH_RETENTION_MS };

export interface WorkspaceLibraryEntry {
  repoUuid: string | null;
  name: string;
  repoPath: string;
  originPath: string | null;
  lastOpenedAt: number | null;
  archivedAt: number | null;
  trashedAt: number | null;
  access?: WorkspaceAccess;
  rootState?: 'missing' | 'unavailable';
}

interface WorkspaceRow {
  id: number;
  repo_uuid: string | null;
  name: string;
  path: string;
  origin_path: string | null;
  created_at: number;
  last_opened_at: number | null;
  archived_at: number | null;
  trashed_at: number | null;
  access_mode?: WorkspaceAccess;
}

function toEntry(row: WorkspaceRow): WorkspaceLibraryEntry {
  return {
    repoUuid: row.repo_uuid ?? null,
    name: row.name,
    repoPath: row.path,
    originPath: row.origin_path,
    lastOpenedAt: normalizeWorkspaceTimestamp(row.last_opened_at),
    archivedAt: normalizeWorkspaceTimestamp(row.archived_at),
    trashedAt: normalizeWorkspaceTimestamp(row.trashed_at),
    ...(row.access_mode === 'reference' ? { access: 'reference' as const } : {}),
  };
}

async function repairWorkspaceLifecycleTimestamps(rows: WorkspaceRow[]): Promise<WorkspaceRow[]> {
  let changed = false;
  for (const row of rows) {
    if (
      [row.created_at, row.last_opened_at, row.archived_at, row.trashed_at].some(
        (value) => normalizeWorkspaceTimestamp(value) !== value && value != null
      )
    ) {
      await platform().db.ensureWorkspaceOwner(row.path);
      changed = true;
    }
  }
  return changed ? platform().db.select<WorkspaceRow[]>('SELECT * FROM workspaces') : rows;
}

export function trashDaysRemaining(trashedAt: number | null, now = Date.now()): number {
  if (trashedAt == null) return Infinity;
  return Math.max(0, Math.ceil((trashedAt + TRASH_RETENTION_MS - now) / (24 * 60 * 60 * 1000)));
}

export async function listWorkspaceLibrary(): Promise<{
  active: WorkspaceLibraryEntry[];
  archived: WorkspaceLibraryEntry[];
  trashed: WorkspaceLibraryEntry[];
}> {
  const [rawRows, incompleteRestores, rootStatus] = await Promise.all([
    platform().db.select<WorkspaceRow[]>(`SELECT * FROM workspaces`),
    platform().db.select<Array<{ workspace_id: number; status: string }>>(
      `SELECT workspace_id, status FROM workspace_sync_restore_locks`
    ),
    platform().workspace.rootStatus(),
  ]);
  const rootStates = new Map(rootStatus.map((root) => [root.repoPath, root.state]));
  const rows = await repairWorkspaceLifecycleTimestamps(rawRows);
  const incompleteWorkspaceIds = new Set(
    incompleteRestores.filter((row) => row.status !== 'completed').map((row) => row.workspace_id)
  );
  const managed = rows
    .filter(
      (row) =>
        (row.repo_uuid != null || row.access_mode !== 'reference') &&
        !incompleteWorkspaceIds.has(row.id)
    )
    .sort(
      (a, b) =>
        (normalizeWorkspaceTimestamp(b.last_opened_at) ?? 0) -
          (normalizeWorkspaceTimestamp(a.last_opened_at) ?? 0) || a.name.localeCompare(b.name)
    );
  const active: WorkspaceLibraryEntry[] = [];
  const archived: WorkspaceLibraryEntry[] = [];
  const trashed: WorkspaceLibraryEntry[] = [];
  for (const row of managed) {
    const state = rootStates.get(row.path);
    const entry = toEntry(row);
    if (state === 'missing' || state === 'unavailable') entry.rootState = state;
    if (row.trashed_at != null) trashed.push(entry);
    else if (row.archived_at != null) archived.push(entry);
    else active.push(entry);
  }
  return { active, archived, trashed };
}

export async function archiveWorkspace(repoUuid: string): Promise<number> {
  return (await platform().workspace.transitionLifecycle({ action: 'archive-by-uuid', repoUuid }))
    .changed;
}

export async function archiveWorkspaceByPath(repoPath: string): Promise<number> {
  return (await platform().workspace.transitionLifecycle({ action: 'archive-by-path', repoPath }))
    .changed;
}

export async function renameWorkspaceByPath(repoPath: string, name: string): Promise<number> {
  return (await platform().workspace.rename({ repoPath, name })).changed;
}

export async function trashWorkspaceByPath(repoPath: string): Promise<number> {
  return (await platform().workspace.transitionLifecycle({ action: 'trash-by-path', repoPath }))
    .changed;
}

export async function restoreFromTrash(project: string | WorkspaceLibraryEntry): Promise<number> {
  return (
    await platform().workspace.transitionLifecycle(
      typeof project === 'string'
        ? { action: 'restore-trash-by-uuid', repoUuid: project }
        : { action: 'restore-trash-by-path', repoPath: project.repoPath }
    )
  ).changed;
}

export async function restoreWorkspace(project: string | WorkspaceLibraryEntry): Promise<number> {
  return (
    await platform().workspace.transitionLifecycle(
      typeof project === 'string'
        ? { action: 'restore-archive-by-uuid', repoUuid: project }
        : { action: 'restore-archive-by-path', repoPath: project.repoPath }
    )
  ).changed;
}
