import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { projectHistoryAgentRequestSchema } from '../../../shared/project-history';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { executeProjectHistory } from '../../workspace/public/project-history';

export const projectHistorySchema = projectHistoryAgentRequestSchema;

export const PROJECT_HISTORY_DESCRIPTION =
  'Inspect project HEAD, changed files and actual native Git staging. Stage or unstage exact inspected paths, then commit exactly the staged selection. Inspect first and pass expectedRevision unchanged. Native packages are whole selection units. Commits refuse unrelated staged content. Save-all stages and commits the current inspected project changes. Initialize enables native tracking for an untracked project. Working file bytes are preserved by stage, unstage and commit. No branch changes, working-file reset or arbitrary Git command is available.';

export function createProjectHistoryTool(folders: readonly WorkspaceFolder[]) {
  return resultTool({
    description: PROJECT_HISTORY_DESCRIPTION,
    inputSchema: projectHistorySchema,
    execute: async ({ project, operation }, { abortSignal }) => {
      let attempted = false;
      try {
        const target = resolveExplicitProjectRoot(folders, project);
        if (!target)
          return toolFailure({
            code: 'PROJECT_NOT_FOUND',
            error: 'Choose an exact mounted project.',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          });
        if (operation.kind !== 'inspect' && target.pinned)
          return toolFailure({
            code: 'PROJECT_NOT_WRITABLE',
            error: 'This project is readonly.',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          });
        attempted = operation.kind !== 'inspect';
        const result = await executeProjectHistory(target.path, operation, abortSignal);
        if (result.status === 'failed')
          return toolFailure({
            code: result.code,
            error: result.error,
            retriable: false,
            stateChanged: result.stateChanged,
            partialEffects: result.stateChanged ? [result] : [],
          });
        return toolSuccess(result);
      } catch (error) {
        return toolFailure({
          code: 'PROJECT_HISTORY_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: attempted ? 'unknown' : false,
          partialEffects: [],
        });
      }
    },
  });
}
