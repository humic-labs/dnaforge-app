import { platform } from '../platform';
import { useWorkspaceStore } from '../stores/workspaceStore';

export function installNativeNotebookCatalogPublisher(): () => void {
  const locations = new Map<string, string>();
  return platform().notebook.onChanged((snapshot) => {
    const workspace = useWorkspaceStore.getState();
    if (!workspace.folders.some((folder) => folder.path === snapshot.workspaceRoot)) return;
    const location = JSON.stringify([snapshot.workspaceRoot, snapshot.path, snapshot.title]);
    if (locations.get(snapshot.documentId) === location) return;
    locations.set(snapshot.documentId, location);
    workspace.bumpFileTreeRefresh();
  });
}
