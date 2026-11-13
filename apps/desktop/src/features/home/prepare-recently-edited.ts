import { registerWorkspaceFile } from '../../db/workspace-catalog';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';
import { useWorkspaceStore, type WorkspaceFolder } from '../../stores/workspaceStore';
import { refreshRecentlyEdited } from './recently-edited';

type MountedWorkspaceFolder = Pick<WorkspaceFolder, 'path' | 'name' | 'addedAt' | 'pinned'>;

export function mountedWorkspaceAccessKey(
  folders: readonly Pick<WorkspaceFolder, 'path' | 'pinned'>[]
): string {
  return JSON.stringify(
    folders
      .map((folder) => [folder.path, folder.pinned ? 'reference' : 'writable'] as const)
      .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
  );
}

export async function prepareRecentlyEditedForMountedWorkspaces(
  folders: readonly MountedWorkspaceFolder[]
): Promise<void> {
  await Promise.all(
    folders
      .filter((folder) => !isDeveloperImportSourcePath(folder.path))
      .map(async (folder) => {
        try {
          await registerWorkspaceFile({
            path: folder.path,
            name: folder.name,
            entityType: 'folder',
            fileKind: 'folder',
            workspaceRoot: folder.path,
            workspaceAccess: folder.pinned ? 'reference' : 'writable',
            metadata: {
              discoveredFrom: 'workspace-store',
              pinned: folder.pinned ?? false,
              addedAt: folder.addedAt,
            },
          });
        } finally {
          useWorkspaceStore.getState().bumpFileTreeRefresh();
        }
      })
  );

  await refreshRecentlyEdited(50);
}

export function enqueueRecentlyEditedPreparation(
  previous: Promise<void>,
  folders: readonly MountedWorkspaceFolder[]
): Promise<void> {
  return previous
    .catch(() => undefined)
    .then(() => prepareRecentlyEditedForMountedWorkspaces(folders));
}
