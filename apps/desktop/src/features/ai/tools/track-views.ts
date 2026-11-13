import type { TrackViewCommand } from '@waypoint/domain-services';
import { platform } from '../../../platform';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { trackViewToolRequestSchema } from '../../../shared/track-view-commands';
import { emitRegistryChanged } from '../../../shared/registry-events';
import { projectSavedTrackView, TRACK_VIEW_LIBRARY_CHANGED } from '../../sequence/public/track-view-library';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { resultTool, toolFailure } from '../../agent-bridge/public/tool-result';

export function createTrackViewsTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: 'List available reference assemblies, inspect a saved Track View, or create a native saved Track View from an explicit reference and BigWig/BigBed sources. No open reference tab or UI interaction is required. Paths are grounded in the selected project; URLs must be public HTTP(S). Creation validates every source before publishing. Supply a unique requestId and reuse it unchanged after an uncertain response. Coordinates are zero-based half-open on the named chromosome. Returns a stable documentId and file path; use app_views open to show the saved view.',
    inputSchema: trackViewToolRequestSchema,
    execute: async (input: TrackViewCommand, options) => {
      if (options.abortSignal?.aborted) return toolFailure({ code: 'CANCELLED', error: 'Track View command was cancelled before submission.', retriable: true, stateChanged: false, partialEffects: [] });
      try {
        let request = input;
        if (input.operation !== 'references') {
          const selected = resolveExplicitProjectRoot(folders, input.project);
          if (!selected) return toolFailure({ code: 'PROJECT_NOT_FOUND', error: 'Choose an exact project available to this caller.', retriable: false, stateChanged: false, partialEffects: [] });
          request = { ...input, project: selected.path };
        }
        const result = await platform().trackViews.command(request);
        if (result.operation === 'create') {
          try {
            await projectSavedTrackView(await platform().trackViews.read(result.path));
            emitRegistryChanged();
            window.dispatchEvent(new Event(TRACK_VIEW_LIBRARY_CHANGED));
            useWorkspaceStore.getState().bumpFileTreeRefresh();
          } catch {
            result.warning = 'The native view was saved, but its workspace catalog could not be refreshed. Open the returned file path.';
          }
        }
        return result;
      } catch (error) {
        return toolFailure({ code: 'TRACK_VIEW_COMMAND_FAILED', error: error instanceof Error ? error.message : String(error),
          retriable: false, stateChanged: input.operation === 'create' ? 'unknown' : false,
          partialEffects: input.operation === 'create' ? ['Reference or source caches may have been prepared. Inspect the destination or retry the identical requestId before starting another creation.'] : [] });
      }
    },
  });
}
