import { managedGitStatus } from './workspace-git/native';
import { isWorkspaceSyncOperationalPath } from './workspace-sync-paths';

const GIT_FILEPATH_BATCH_SIZE = 256;

export async function hasWorkspaceSyncWorkingChanges(
  repoPath: string,
  forceInclude: readonly string[] = []
): Promise<boolean> {
  const affectsSync = (row: { path: string; staged: boolean }) =>
    row.staged || !isWorkspaceSyncOperationalPath(row.path);
  if ((await managedGitStatus(repoPath)).some(affectsSync)) return true;
  for (let start = 0; start < forceInclude.length; start += GIT_FILEPATH_BATCH_SIZE) {
    if (
      (
        await managedGitStatus(
          repoPath,
          forceInclude.slice(start, start + GIT_FILEPATH_BATCH_SIZE),
          true
        )
      ).some(affectsSync)
    )
      return true;
  }
  return false;
}
