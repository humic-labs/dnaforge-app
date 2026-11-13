import type { WorkspaceFolder } from '../../stores/workspaceStore';

export function openWorkspaceFolders(folders: WorkspaceFolder[]): WorkspaceFolder[] {
  return folders.filter((folder) => !folder.pinned);
}

export function openWorkspaceCount(folders: WorkspaceFolder[]): number {
  return openWorkspaceFolders(folders).length;
}

export function removalWouldLeaveNoWorkspace(
  folders: WorkspaceFolder[],
  targetPath: string
): boolean {
  return openWorkspaceFolders(folders).every((folder) => folder.path === targetPath);
}
