import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  normalizeAbsolutePath,
  resolveWorkspacePath,
  resolveProjectFilePath,
} from '../../shared/workspace-file-path';
export {
  normalizePath,
  normalizeAbsolutePath,
  resolveWorkspacePath,
} from '../../shared/workspace-file-path';
import {
  isAbsolutePathLike,
  isPathInsideBoundary,
  pathRelativeToBoundary,
} from '../../shared/path-boundary';
import { AGENT_CHAT_FILES_LABEL } from '../../shared/agent-chat-files';

let agentChatFilesRoot: string | null = null;

export function registerAgentChatFilesRoot(path: string | null): void {
  agentChatFilesRoot = path ? normalizeAbsolutePath(path) : null;
}

function resolveAgentChatFile(inputPath: string): ResolvedMultiRootPath | null {
  if (!agentChatFilesRoot || !isAbsolutePathLike(inputPath)) return null;
  const absolutePath = normalizeAbsolutePath(inputPath);
  if (!isPathInsideBoundary(absolutePath, agentChatFilesRoot)) return null;
  return {
    folder: { path: agentChatFilesRoot, name: AGENT_CHAT_FILES_LABEL, addedAt: 0 },
    absolutePath,
    relativePath: pathRelativeToBoundary(absolutePath, agentChatFilesRoot) ?? '',
  };
}

export interface ResolvedMultiRootPath {
  folder: WorkspaceFolder;
  absolutePath: string;
  relativePath: string;
}

export function getUserFolders(folders: WorkspaceFolder[]): WorkspaceFolder[] {
  return folders.filter((f) => !f.pinned);
}

export const NO_WORKSPACE_TOOL_MESSAGE =
  'No project is open. Ask the user to open a project before using this tool.';

export function hasNoUserWorkspace(folders: WorkspaceFolder[]): boolean {
  return getUserFolders(folders).length === 0;
}

export function resolveMultiRootPath(
  folders: WorkspaceFolder[],
  inputPath: string
): ResolvedMultiRootPath {
  if (folders.length === 0) {
    const chatFile = resolveAgentChatFile(inputPath);
    if (chatFile) return chatFile;
    const { activeWorkspaceFile } = useWorkspaceStore.getState();
    console.warn(
      '[workspace-path] resolveMultiRootPath: folders is empty, activeWorkspaceFile =',
      activeWorkspaceFile
    );
    if (activeWorkspaceFile) {
      const workspaceRoot = activeWorkspaceFile.replace(/\/[^/]+\.waypoint-workspace$/, '');
      const syntheticFolder: WorkspaceFolder = {
        path: workspaceRoot,
        name: workspaceRoot.split('/').pop() || 'workspace',
        addedAt: 0,
      };
      const absolutePath =
        !inputPath || inputPath === '.'
          ? workspaceRoot
          : resolveWorkspacePath(workspaceRoot, inputPath);
      const relativePath = !inputPath || inputPath === '.' ? '' : inputPath;
      return { folder: syntheticFolder, absolutePath, relativePath };
    }
    throw new Error(
      'No project folders are available. Please open a project before using file tools.'
    );
  }

  try {
    return resolveProjectFilePath(folders, inputPath);
  } catch (error) {
    if (isAbsolutePathLike(inputPath)) {
      const chatFile = resolveAgentChatFile(inputPath);
      if (chatFile) return chatFile;
    }
    throw error;
  }
}
