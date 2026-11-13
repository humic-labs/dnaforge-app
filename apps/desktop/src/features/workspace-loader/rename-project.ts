import { toUserMessage } from '@waypoint/user-messages';
export type RenameProjectOutcome = 'cancelled' | 'unchanged' | 'renamed' | 'failed' | 'not-managed';

export interface RenameProjectDeps {
  promptForName: (currentName: string) => Promise<string | null>;
  rename: (repoPath: string, name: string) => Promise<number>;
  renameMountedFolder: (repoPath: string, name: string) => void;
  refreshLibrary: () => Promise<void>;
  toast: (message: string, tone: 'error' | 'warning') => void;
}

export async function renameProject(
  input: { repoPath: string; currentName: string },
  deps: RenameProjectDeps
): Promise<RenameProjectOutcome> {
  const nextName = await deps.promptForName(input.currentName);
  if (nextName === null) return 'cancelled';
  if (nextName === input.currentName) return 'unchanged';

  let changed = 0;
  try {
    changed = await deps.rename(input.repoPath, nextName);
  } catch (err) {
    deps.toast(toUserMessage(err, 'operation.failed'), 'error');
    return 'failed';
  }
  if (changed === 0) {
    deps.toast(
      `Couldn't rename "${input.currentName}" — it isn't an active managed project.`,
      'warning'
    );
    return 'not-managed';
  }
  deps.renameMountedFolder(input.repoPath, nextName);
  await deps.refreshLibrary();
  return 'renamed';
}
