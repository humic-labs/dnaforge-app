export const WORKSPACE_FILES_CHANGED_EVENT = 'waypoint:workspace-files-changed';

export interface WorkspaceFilesChangedDetail {
  path?: string | null;
  workspaceRoot?: string | null;
  workspaceRoots?: string[];
  revealPath?: string | null;
  revealPaths?: string[];
  createdNewWorkspace?: boolean;
  createdWorkspaceName?: string | null;
}
