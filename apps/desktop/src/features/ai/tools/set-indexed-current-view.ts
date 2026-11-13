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
  waitForIndexedLiveViewport,
  type IndexedLiveViewport,
} from '../../sequence/public/indexed-live-viewport';
import {
  findOpenIndexedTab,
  projectIndexedCurrentView,
  resolveIndexedViewTarget,
  type IndexedCurrentViewSnapshot,
} from './indexed-current-view';

export const setIndexedCurrentViewSchema = z
  .object({
    chrom: z.string().trim().min(1).describe('Chromosome / contig id to show.'),
    start0: z.number().int().min(0).describe('0-based half-open interval start. 0 is real.'),
    end0: z
      .number()
      .int()
      .min(0)
      .describe('0-based half-open interval end. Must be greater than start0.'),
  })
  .strict();

export type SetIndexedCurrentViewInput = z.infer<typeof setIndexedCurrentViewSchema>;

export type SetIndexedCurrentViewResult = IndexedCurrentViewSnapshot | ToolFailure;

type WaitForLiveViewport = typeof waitForIndexedLiveViewport;

let lastViewportCommandId = 0;

function nextViewportCommandId(): number {
  lastViewportCommandId = Math.max(lastViewportCommandId + 1, Date.now());
  return lastViewportCommandId;
}

export function createSetIndexedCurrentViewTool(dependencies?: {
  waitForLiveViewport?: WaitForLiveViewport;
}) {
  const waitForLiveViewport = dependencies?.waitForLiveViewport ?? waitForIndexedLiveViewport;
  return resultTool({
    description:
      'Navigate the currently open indexed genome view to a 0-based half-open interval. ' +
      'start0 0 is real. Chromosome aliases are resolved against the open reference. ' +
      'Returns success only after the mounted viewer reports the requested live camera.',
    inputSchema: setIndexedCurrentViewSchema as z.ZodTypeAny,
    execute: async (
      input: SetIndexedCurrentViewInput,
      options?: { abortSignal?: AbortSignal }
    ): Promise<SetIndexedCurrentViewResult> => {
      let mutationAttempted = false;
      let rollbackConfirmed = false;
      try {
        if (options?.abortSignal?.aborted) {
          return indexedViewToolFailure({
            error: 'CANCELLED',
            message: 'The indexed current-view navigate request was cancelled.',
          });
        }
        if (input.end0 <= input.start0) {
          return indexedViewToolFailure({
            error: 'MALFORMED_INTERVAL',
            message: 'end0 must be greater than start0 (0-based half-open).',
          });
        }
        const store = useCanvasStore.getState();
        const found = findOpenIndexedTab(store);
        if (!found) {
          return indexedViewToolFailure({
            error: 'NO_INDEXED_VIEW',
            message: 'No indexed genome tab is open.',
          });
        }
        const current = found.tab;
        if (!current?.indexedGenome) {
          return indexedViewToolFailure({
            error: 'NO_INDEXED_VIEW',
            message: 'No indexed genome tab is open.',
          });
        }
        const target = resolveIndexedViewTarget(current, input);
        if ('ok' in target) return indexedViewToolFailure(target);
        const previousViewState = current.viewState;
        const previousScope = current.indexedGenome.scope;
        const targetScope = {
          kind: 'locus' as const,
          chrom: target.chrom,
          start: input.start0,
          end: input.end0,
        };
        const commandId = nextViewportCommandId();
        mutationAttempted = true;
        store.updateTab(found.panelId, found.tab.id, {
          indexedGenome: {
            ...current.indexedGenome,
                                                                                  
                                                                                 
                                                                  
            scope: targetScope,
          },
          viewState: {
            ...(current.viewState ?? {}),
            indexedViewport: { start0: input.start0, end0: input.end0 },
            indexedViewportCommand: {
              id: commandId,
              chrom: target.chrom,
              start0: input.start0,
              end0: input.end0,
            },
          },
        });
        const updated = useCanvasStore
          .getState()
          .panels[found.panelId]?.tabs.find((tab) => tab.id === found.tab.id);
        if (!updated) {
          return indexedViewToolFailure(
            {
              error: 'NO_INDEXED_VIEW',
              message: 'The indexed genome tab disappeared after navigation.',
            },
            mutationAttempted && !rollbackConfirmed ? 'unknown' : false
          );
        }
        const live: IndexedLiveViewport | null = await waitForLiveViewport({
          tabId: found.tab.id,
          chrom: target.chrom,
          start0: input.start0,
          end0: input.end0,
          commandId,
          ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
        });
        if (!live) {
          const currentTab = useCanvasStore
            .getState()
            .panels[found.panelId]?.tabs.find((tab) => tab.id === found.tab.id);
          const currentCommand = currentTab?.viewState?.indexedViewportCommand;
                                                                                        
          if (currentTab?.indexedGenome && currentCommand?.id === commandId) {
            const nextViewState = { ...(currentTab.viewState ?? {}) };
            if (previousViewState && 'indexedViewport' in previousViewState) {
              nextViewState.indexedViewport = previousViewState.indexedViewport;
            } else {
              delete nextViewState.indexedViewport;
            }
            if (previousViewState && 'indexedViewportCommand' in previousViewState) {
              nextViewState.indexedViewportCommand = previousViewState.indexedViewportCommand;
            } else {
              delete nextViewState.indexedViewportCommand;
            }

            const currentScope = currentTab.indexedGenome.scope;
            const ownsCurrentScope =
              currentScope?.kind === 'locus' &&
              currentScope.chrom === targetScope.chrom &&
              currentScope.start === targetScope.start &&
              currentScope.end === targetScope.end;
            const nextIndexedGenome = { ...currentTab.indexedGenome };
            if (ownsCurrentScope) {
              if (previousScope) nextIndexedGenome.scope = previousScope;
              else delete nextIndexedGenome.scope;
            }

            useCanvasStore.getState().updateTab(found.panelId, found.tab.id, {
              indexedGenome: nextIndexedGenome,
              viewState: Object.keys(nextViewState).length > 0 ? nextViewState : undefined,
            });
            rollbackConfirmed = true;
          }
          if (options?.abortSignal?.aborted) {
            return indexedViewToolFailure(
              {
                error: 'CANCELLED',
                message: 'The indexed current-view navigate request was cancelled.',
              },
              mutationAttempted && !rollbackConfirmed ? 'unknown' : false
            );
          }
          return indexedViewToolFailure(
            {
              error: 'VIEW_NOT_APPLIED',
              message: 'The mounted indexed viewer did not report the requested camera.',
            },
            mutationAttempted && !rollbackConfirmed ? 'unknown' : false
          );
        }
        const acknowledgedTab = useCanvasStore
          .getState()
          .panels[found.panelId]?.tabs.find((tab) => tab.id === found.tab.id);
        if (acknowledgedTab?.viewState?.indexedViewportCommand?.id === commandId) {
          useCanvasStore.getState().updateTab(found.panelId, found.tab.id, {
            viewState: {
              ...(acknowledgedTab.viewState ?? {}),
                                                                                 
                                                                                
                             
              indexedViewportCommand: null,
            },
          });
        }
        const projected = projectIndexedCurrentView(updated, live);
        return projected.ok
          ? toolSuccess({ ...projected })
          : indexedViewToolFailure(projected, 'unknown');
      } catch (error) {
        return toolFailure({
          code: 'INDEXED_NAVIGATION_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: mutationAttempted && !rollbackConfirmed ? 'unknown' : false,
          partialEffects: [],
        });
      }
    },
  });
}
