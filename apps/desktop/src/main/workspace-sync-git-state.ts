import { managedGitStatus } from './workspace-git/native';
import { isWorkspaceSyncOperationalPath } from './workspace-sync-paths';

export async function hasWorkspaceSyncWorkingChanges(repoPath: string): Promise<boolean> {
  return (await managedGitStatus(repoPath)).some(
    (row) => row.staged || !isWorkspaceSyncOperationalPath(row.path)
  );
}
