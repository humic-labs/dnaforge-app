import {
  beginProjectLifecycle,
  bindProjectLifecycle,
  captureProjectLifecycle,
} from './workspace-telemetry';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { isExampleWorkspaceEntry } from './example-workspace-identity';
import type { WorkspaceLibraryEntry } from './workspace-library';
import type { ProjectEditFolder } from './project-edit-folders';

export function restoreActiveProjects(entries: readonly WorkspaceLibraryEntry[]): void {
  for (const entry of entries) {
    if (
      entry.rootState ||
      entry.archivedAt != null ||
      entry.trashedAt != null ||
      isExampleWorkspaceEntry(entry)
    ) {
      continue;
    }
    const lifecycle = beginRestorationObservation(entry.repoPath, entry.access === 'reference');
    const name = entry.name.trim();
    useWorkspaceStore.getState().addFolder(entry.repoPath, name, {
      pinned: entry.access === 'reference',
    });
    if (name) useWorkspaceStore.getState().renameFolder(entry.repoPath, name);
    finishRestorationObservation(entry.repoPath, lifecycle);
    if (
      entry.access === 'reference' &&
      useWorkspaceStore
        .getState()
        .folders.some((folder) => folder.path === entry.repoPath && !folder.pinned)
    ) {
      useWorkspaceStore.setState((state) => ({
        folders: state.folders.map((folder) =>
          folder.path === entry.repoPath && !folder.pinned ? { ...folder, pinned: true } : folder
        ),
      }));
    }
  }
}

export function restoreRegisteredActiveProjects(entries: readonly ProjectEditFolder[]): void {
  for (const entry of entries) {
    if (entry.rootState || entry.lifecycle !== 'active' || (!entry.repoUuid && entry.pinned))
      continue;
    if (isExampleWorkspaceEntry({ originPath: entry.originPath ?? null })) continue;
    const lifecycle = beginRestorationObservation(entry.path, Boolean(entry.pinned));
    const name = entry.name?.trim();
    useWorkspaceStore.getState().addFolder(entry.path, name, { pinned: entry.pinned });
    if (name) useWorkspaceStore.getState().renameFolder(entry.path, name);
    finishRestorationObservation(entry.path, lifecycle);
    useWorkspaceStore.setState((state) => {
      const folder = state.folders.find((folder) => folder.path === entry.path);
      if (Boolean(folder?.pinned) === Boolean(entry.pinned)) return state;
      return {
        folders: state.folders.map((folder) =>
          folder.path === entry.path ? { ...folder, pinned: entry.pinned } : folder
        ),
      };
    });
  }
  void useWorkspaceStore.getState().acceptMountedWorkspaceSelection();
}

function beginRestorationObservation(path: string, reference: boolean) {
  if (captureProjectLifecycle(path)) return undefined;
  const lifecycle = beginProjectLifecycle({
    source: 'restore',
    mode: 'restore',
    intent: 'unknown',
  });
  lifecycle.authority(reference ? 'reference' : 'writable');
  lifecycle.phase('registered');
  bindProjectLifecycle(path, lifecycle);
  return lifecycle;
}

function finishRestorationObservation(
  path: string,
  lifecycle: ReturnType<typeof beginRestorationObservation>
): void {
  useWorkspaceStore.setState((state) => {
    const folder = state.folders.find((folder) => folder.path === path);
    if (!folder || folder.mountRequest !== undefined) return state;
    return {
      folders: state.folders.map((folder) =>
        folder.path === path ? { ...folder, mountRequest: 0 } : folder
      ),
    };
  });
  lifecycle?.phase('mounted');
  lifecycle?.phase('restored');
}
