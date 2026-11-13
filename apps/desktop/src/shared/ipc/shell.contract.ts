import { defineGroup, event, invoke } from './contract';
import type { WorkspaceFileTrashRequest, WorkspaceFileTrashResult } from '../workspace-file-trash';
import type { ProjectHistoryRequest, ProjectHistoryResult } from '../project-history';

export const shellContract = defineGroup('shell', {
  revealItemInDir: invoke<[path: string], void>(),
  trashItem: invoke<[path: string, mutationToken?: string], void>(),
  fileTrash: invoke<[request: WorkspaceFileTrashRequest], WorkspaceFileTrashResult>(),
  projectHistory: invoke<[request: ProjectHistoryRequest], ProjectHistoryResult>(),
  onProjectHistoryChanged: event<[workspaceRoot: string]>().channel('shell:projectHistoryChanged'),
  execute: invoke<
    [program: string, args: string[], cwd: string, mutationToken?: string],
    { stdout: string; stderr: string; code: number }
  >(),
  readGitHead: invoke<[filePath: string, requestId: string], string | null>(),
  cancelGitRead: invoke<[requestId: string, closeGestureToken?: string], boolean>(),
});
