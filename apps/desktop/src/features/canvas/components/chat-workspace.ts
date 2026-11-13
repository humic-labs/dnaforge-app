import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveMountedProjectRoot } from '../../../shared/project-root-selection';

export function resolveChatWorkspacePath(
  workspacePath: string | null,
  workspaceFolders: WorkspaceFolder[]
): string | null {
  return resolveMountedProjectRoot(workspaceFolders, workspacePath)?.path ?? null;
}
