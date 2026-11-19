import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { normalizePathForBoundary } from '../../../shared/path-boundary';
import { useDesignStore } from '../../design/public/store';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  searchWorkspace,
  workspaceSearchAgentResult,
  workspaceSearchSchema,
  WorkspaceSearchError,
} from '../../workspace/public/search-commands';

export { workspaceSearchSchema as searchWorkspaceSchema } from '../../workspace/public/search-commands';

export const SEARCH_WORKSPACE_DESCRIPTION =
  'Search names across the current admitted projects using the same native catalog as workspace Search. Results include exact entity IDs, kinds and owning roots; duplicate names remain distinct. Optional project selects an exact admitted name or root, and types filters supported document kinds. Returns a bounded page and nextCursor; pass the cursor unchanged with the same query and scope. Archived, trashed, missing and unopenable catalog entries are excluded. This reads names and identities, not document bodies, and does not open results.';

export function createSearchWorkspaceTool(folders: readonly WorkspaceFolder[]) {
  const admitted = new Set(folders.map((folder) => normalizePathForBoundary(folder.path)));
  return resultTool({
    description: SEARCH_WORKSPACE_DESCRIPTION,
    inputSchema: workspaceSearchSchema,
    execute: async (input, { abortSignal }) => {
      try {
        const result = await searchWorkspace(
          input,
          () => ({
            projects: useWorkspaceStore
              .getState()
              .folders.filter((folder) => admitted.has(normalizePathForBoundary(folder.path))),
            openLocalDesignIds: Object.keys(useDesignStore.getState().designs),
          }),
          abortSignal
        );
        return toolSuccess(workspaceSearchAgentResult(result));
      } catch (error) {
        return toolFailure({
          code: error instanceof WorkspaceSearchError ? error.code : 'WORKSPACE_SEARCH_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: error instanceof WorkspaceSearchError && error.code === 'SEARCH_SCOPE_CHANGED',
          stateChanged: false,
          partialEffects: [],
        });
      }
    },
  });
}
