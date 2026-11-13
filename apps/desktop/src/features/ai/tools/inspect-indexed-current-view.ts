import { indexedViewToolFailure } from './genome-tool-results';
   
                                                                              
                                                                          
                         
   

import {
  resultTool,
  toolSuccess,
  toolFailure,
  type ToolFailure,
} from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { useCanvasStore } from '../../canvas/public/store';
import {
  hasIndexedLiveViewportReader,
  readIndexedLiveViewport,
} from '../../sequence/public/indexed-live-viewport';
import {
  findOpenIndexedTab,
  projectIndexedCurrentView,
  type IndexedCurrentViewSnapshot,
} from './indexed-current-view';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import { indexedTrackSnapshot, type IndexedTrackSnapshot } from './configure-indexed-track';

export const inspectIndexedCurrentViewSchema = z.object({}).strict();

export type InspectIndexedCurrentViewInput = z.infer<typeof inspectIndexedCurrentViewSchema>;

export type InspectIndexedCurrentViewResult =
  | (IndexedCurrentViewSnapshot & { tracks: IndexedTrackSnapshot[] })
  | ToolFailure;

export function createInspectIndexedCurrentViewTool() {
  return resultTool({
    description:
      'Read the currently open indexed genome view. start0 0 is real. ' +
      'Unknown coordinates are omitted rather than coerced to 0. ' +
      'Returns every track with its complete common and type-specific presentation settings. ' +
      'Returns NO_INDEXED_VIEW when no indexed tab is open.',
    inputSchema: inspectIndexedCurrentViewSchema as z.ZodTypeAny,
    execute: async (
      _input: InspectIndexedCurrentViewInput,
      options?: { abortSignal?: AbortSignal }
    ): Promise<InspectIndexedCurrentViewResult> => {
      try {
        if (options?.abortSignal?.aborted) {
          return indexedViewToolFailure({
            error: 'CANCELLED',
            message: 'The indexed current-view read was cancelled.',
          });
        }
        const found = findOpenIndexedTab(useCanvasStore.getState());
        if (!found) {
          return indexedViewToolFailure({
            error: 'NO_INDEXED_VIEW',
            message: 'No indexed genome tab is open.',
          });
        }
        const live = readIndexedLiveViewport(found.tab.id);
        const liveForTab = live
          ? { chrom: live.chrom, start0: live.start0, end0: live.end0 }
          : hasIndexedLiveViewportReader(found.tab.id)
            ? null
            : undefined;
        const projected = projectIndexedCurrentView(found.tab, liveForTab);
        if (!projected.ok) return indexedViewToolFailure(projected);
        return toolSuccess({
          ...projected,
          tracks: useLaneContractStore
            .getState()
            .lanesForOwner(found.tab.id)
            .map(indexedTrackSnapshot),
        });
      } catch (error) {
        return toolFailure({
          code: 'INDEXED_VIEW_READ_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }
    },
  });
}
