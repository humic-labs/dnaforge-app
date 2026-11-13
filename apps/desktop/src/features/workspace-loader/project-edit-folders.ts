import { type ProjectSharedEditAccess } from './project-shared-edit-access';
import { platform } from '../../platform';
import { isDesktopRuntime, isHostedBrowserRuntime } from '../../utils/environment';
import {
  normalizePathForBoundary,
  resolveContainingPathBoundary,
} from '../../shared/path-boundary';
import type { WorkspaceFolder } from '../../stores/workspaceStore';

export type ProjectEditFolder = Pick<WorkspaceFolder, 'path' | 'pinned'> &
  Partial<Pick<WorkspaceFolder, 'name'>> & {
    lifecycle?: 'active' | 'archived' | 'trashed' | 'restoring';
    repoUuid?: string | null;
    originPath?: string | null;
    sharedEditAccess?: ProjectSharedEditAccess;

    editAvailability?: 'checking' | 'unavailable';
    rootState?: 'missing' | 'unavailable';
  };

export async function listProjectEditFolders(
  options: { includeSharedAccess?: boolean } = {}
): Promise<ProjectEditFolder[]> {
  const [rows, restores, bindings, rootStatus] = await Promise.all([
    platform().db.select<
      {
        id: number;
        name: string;
        path: string;
        access_mode?: string;
        archived_at: number | null;
        trashed_at: number | null;
        repo_uuid: string | null;
        origin_path: string | null;
      }[]
    >('SELECT * FROM workspaces'),
    platform().db.select<{ workspace_id: number; status: string }[]>(
      'SELECT workspace_id, status FROM workspace_sync_restore_locks'
    ),
    options.includeSharedAccess === false
      ? []
      : platform().db.select<
          { workspace_id: number; workspace_uuid: string; access_role: string | null }[]
        >('SELECT workspace_id, workspace_uuid, access_role FROM workspace_sync_bindings'),
    isDesktopRuntime() && !isHostedBrowserRuntime() ? platform().workspace.rootStatus() : [],
  ]);
  const unavailableRoots = new Map(
    rootStatus
      .filter((root) => root.state !== 'available')
      .map((root) => [root.repoPath, root.state as 'missing' | 'unavailable'])
  );
  const incomplete = new Set(
    restores
      .filter((restore) => restore.status !== 'completed')
      .map((restore) => restore.workspace_id)
  );
  const accessByWorkspace = new Map(bindings.map((binding) => [binding.workspace_id, binding]));
  const folders: ProjectEditFolder[] = rows.map((row) => ({
    path: row.path,
    ...(unavailableRoots.has(row.path) ? { rootState: unavailableRoots.get(row.path) } : {}),
    name: row.name,
    pinned: row.access_mode === 'reference',
    repoUuid: row.repo_uuid,
    ...(options.includeSharedAccess === false
      ? {}
      : {
          sharedEditAccess: projectedSharedAccess({
            repo_uuid: row.repo_uuid,
            binding_uuid: accessByWorkspace.get(row.id)?.workspace_uuid,
            shared_role: accessByWorkspace.get(row.id)?.access_role,
          }),
        }),
    originPath: row.origin_path,
    lifecycle:
      row.trashed_at != null
        ? 'trashed'
        : row.archived_at != null
          ? 'archived'
          : incomplete.has(row.id)
            ? 'restoring'
            : 'active',
  }));
  return folders;
}

export function mergeProjectEditFolders(
  registered: readonly ProjectEditFolder[],
  mounted: readonly ProjectEditFolder[]
): ProjectEditFolder[] {
  const known = new Set(registered.map((folder) => normalizePathForBoundary(folder.path)));
  return [
    ...registered,
    ...mounted.filter((folder) => !known.has(normalizePathForBoundary(folder.path))),
  ];
}

export function projectPathIsReadOnly(
  path: string,
  folders: readonly ProjectEditFolder[]
): boolean {
  const owner = resolveContainingPathBoundary(folders, path);
  if (owner.status === 'ambiguous') return true;
  if (owner.status === 'none') return false;
  return (
    owner.entry.rootState !== undefined ||
    owner.entry.editAvailability !== undefined ||
    owner.entry.sharedEditAccess?.kind === 'checking' ||
    owner.entry.sharedEditAccess?.kind === 'unavailable' ||
    (owner.entry.sharedEditAccess?.kind === 'ready' &&
      owner.entry.sharedEditAccess.role === 'viewer') ||
    Boolean(owner.entry.pinned) ||
    (owner.entry.lifecycle !== undefined && owner.entry.lifecycle !== 'active')
  );
}

function projectedSharedAccess(row: {
  repo_uuid: string | null;
  binding_uuid?: string | null;
  shared_role?: string | null;
}): ProjectSharedEditAccess {
  if (row.binding_uuid == null) return { kind: 'ready', role: null };
  if (!row.repo_uuid || row.binding_uuid !== row.repo_uuid) return { kind: 'unavailable' };
  switch (row.shared_role) {
    case null:
      return { kind: 'ready', role: 'owner' };
    case 'viewer':
    case 'editor':
    case 'manager':
    case 'owner':
      return { kind: 'ready', role: row.shared_role };
    default:
      return { kind: 'unavailable' };
  }
}
