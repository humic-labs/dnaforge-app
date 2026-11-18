import { platform } from '../platform';
import { stripTrailingSep } from '../shared/path-boundary';
import { useWorkspaceStore } from '../stores/workspaceStore';

export function installProtocolPackageChanges(): () => void {
  return platform().protocols.onChanged((change) => {
    const store = useWorkspaceStore.getState();
    if (
      store.folders.some(
        (folder) => stripTrailingSep(folder.path) === stripTrailingSep(change.workspaceRoot)
      )
    )
      store.bumpFileTreeRefresh();
  });
}
