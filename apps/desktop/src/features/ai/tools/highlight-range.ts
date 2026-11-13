   
                                                                              
  
                                                                                
                                                                              
                                                                        
                                          
   

import { resultTool, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { useCanvasStore } from '../../canvas/public/store';
import { primerBindingToViewState } from '../../sequence/public/primer-binding-viewstate';
import type { TabViewState } from '../../canvas/public/types';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { openSequenceDocument } from '../../document-opening/public/compat';
import { resolveSequenceDocumentById } from '../../sequence/public/sequence-document-repository';
import { looksLikeWorkspacePath } from '../../../shared/resolve-entity-path';
import {
  highlightRangeSchema,
  type HighlightRangeInput,
  type HighlightRegionInput,
} from './highlight-range-schema';

export { highlightRangeSchema, type HighlightRangeInput } from './highlight-range-schema';

function validateDocumentId(documentId: string): string | null {
  if (!documentId || !documentId.trim()) return 'document ID cannot be empty';
  if (documentId.length > 500) return 'document ID is too long (max 500 characters)';
  if (looksLikeWorkspacePath(documentId)) {
    return 'A physical sequence path is deprecated; provide the stable document ID.';
  }
  return null;
}

   
                                                                           
                                                                       
                                                                              
                                     
   
function buildRangeViewState(start: number, end: number, wraps?: boolean): TabViewState {
  const base = primerBindingToViewState(start, end);
  return {
    scrollPosition: base.scrollPosition,
    highlightRange: {
      ...base.highlightRange!,
      ...(wraps != null ? { wraps } : {}),
    },
                                                                                
                                                              
    sequenceNavigationRequestId: Date.now(),
  };
}

   
                                                                                 
                                                                                 
                                                
   
async function applyHighlight(
  documentId: string,
  start: number,
  end: number,
  wraps: boolean | undefined,
  folders: WorkspaceFolder[]
): Promise<
  { panelId: string; tabId: string; opened: boolean } | { code: 'NO_PANEL'; error: string }
> {
  const viewState = buildRangeViewState(start, end, wraps);
  const store = useCanvasStore.getState();
  const sequenceTabIdsBeforeOpen = new Set(
    Object.values(store.panels)
      .flatMap((panel) => panel.tabs)
      .filter((tab) => tab.type === 'sequence')
      .map((tab) => tab.id)
  );

  const existing = store.findTab('sequence', documentId);
  if (existing) {
    store.focusPanel(existing.panelId);
    store.setActiveTab(existing.panelId, existing.tabId);
    store.setTabViewState(existing.panelId, existing.tabId, viewState);
    return { panelId: existing.panelId, tabId: existing.tabId, opened: false };
  }

                                                                                
                                   
  const panelIds = Object.keys(store.panels);
  const chatPanelId = panelIds.find((id) => store.panels[id].tabs.some((t) => t.type === 'chat'));
  let panelId = panelIds.find((id) => id !== chatPanelId) ?? panelIds[0];
  if (!panelId) {
    return { code: 'NO_PANEL', error: 'No canvas panel is available to open the sequence.' };
  }
  if (panelIds.length === 1 && chatPanelId) {
    panelId = store.splitPanel(chatPanelId, 'vertical');
  }

  const resolved = await resolveSequenceDocumentById(
    documentId,
    folders.map((folder) => folder.path)
  ).catch(() => null);
  if (!resolved) {
    return { code: 'NO_PANEL', error: 'The sequence document is no longer available.' };
  }
  const tabId = await openSequenceDocument(resolved.ref, {
    label: resolved.name ?? 'Sequence',
    strategy: { kind: 'panel', panelId },
    sourceSurface: 'unknown',
  });
  if (!tabId) {
    return { code: 'NO_PANEL', error: 'The sequence could not be opened.' };
  }
  const located = Object.entries(useCanvasStore.getState().panels).find(([, panel]) =>
    panel.tabs.some((tab) => tab.id === tabId)
  );
  if (!located) {
    return { code: 'NO_PANEL', error: 'The opened sequence tab could not be located.' };
  }
  const [resolvedPanelId] = located;
  useCanvasStore.getState().setTabViewState(resolvedPanelId, tabId, viewState);
  return {
    panelId: resolvedPanelId,
    tabId,
    opened: !sequenceTabIdsBeforeOpen.has(tabId),
  };
}

function validateForwardRange(
  start: number,
  end: number,
  wraps: boolean | undefined
): { code: 'INVALID_RANGE'; error: string } | null {
                                                                                  
                                                            
  if (!wraps && end < start) {
    return {
      code: 'INVALID_RANGE',
      error:
        `end (${end}) must be >= start (${start}) for a non-wrapping range. ` +
        'Pass wraps: true to highlight a range that crosses the origin of a circular sequence.',
    };
  }
  return null;
}

   
                                                                             
                                                                         
   
export async function highlightRangeInCanvas(
  { documentId, start, end, wraps, regions }: HighlightRangeInput,
  folders: WorkspaceFolder[]
) {
  const documentIdError = validateDocumentId(documentId);
  if (documentIdError) {
    return { ok: false as const, code: 'INVALID_PATH' as const, error: documentIdError };
  }

                                                                            
                                                                            
                                                                          
                                                                       
  if (Array.isArray(regions) && regions.length > 0) {
    const valid = regions.filter(
      (r): r is HighlightRegionInput => typeof r?.start === 'number' && typeof r?.end === 'number'
    );
    if (valid.length === 0) {
      return {
        ok: false as const,
        code: 'INVALID_RANGE' as const,
        error: 'regions was empty or carried no {start,end} coordinates.',
      };
    }
    const rangeError = validateForwardRange(valid[0].start, valid[0].end, valid[0].wraps);
    if (rangeError) return { ok: false as const, ...rangeError };

    const first = valid[0];
    const applied = await applyHighlight(documentId, first.start, first.end, first.wraps, folders);
    if ('code' in applied) {
      return { ok: false as const, code: applied.code, error: applied.error };
    }

                                                                         
                                                               
    if (valid.length === 1) {
      return {
        ok: true as const,
        ...(applied.opened ? { opened: true as const } : {}),
        resolved: {
          panelId: applied.panelId,
          tabId: applied.tabId,
          range: { start: first.start, end: first.end },
        },
      };
    }
    return {
      ok: true as const,
      ...(applied.opened ? { opened: true as const } : {}),
      degraded: 'single-highlight-viewer' as const,
      regionCount: valid.length,
      highlightedRegion: { start: first.start, end: first.end },
      note:
        `Highlighted the FIRST of ${valid.length} disjoint regions; the sequence viewer ` +
        'shows one range at a time. The other regions were NOT highlighted (and no single ' +
        'span covering the gaps was drawn).',
      resolved: {
        panelId: applied.panelId,
        tabId: applied.tabId,
        range: { start: first.start, end: first.end },
      },
    };
  }

                                                                            
  if (typeof start !== 'number' || typeof end !== 'number') {
    return {
      ok: false as const,
      code: 'INVALID_RANGE' as const,
      error: 'Provide start and end (1-indexed inclusive), or a regions array.',
    };
  }
  const rangeError = validateForwardRange(start, end, wraps);
  if (rangeError) return { ok: false as const, ...rangeError };

  const applied = await applyHighlight(documentId, start, end, wraps, folders);
  if ('code' in applied) {
    return { ok: false as const, code: applied.code, error: applied.error };
  }

  return {
    ok: true as const,
    ...(applied.opened ? { opened: true as const } : {}),
    resolved: {
      panelId: applied.panelId,
      tabId: applied.tabId,
      range: { start, end },
    },
  };
}

const highlightedRangeSchema = z.object({start: z.number().int().positive(), end: z.number().int().positive()});
export const highlightRangeOutputSchema = z.object({
  ok: z.literal(true), opened: z.literal(true).optional(),
  resolved: z.object({panelId: z.string(), tabId: z.string(), range: highlightedRangeSchema}),
  degraded: z.literal('single-highlight-viewer').optional(), regionCount: z.number().int().positive().optional(),
  highlightedRegion: highlightedRangeSchema.optional(), note: z.string().optional(),
});

export function createHighlightRangeTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Highlight a specific coordinate range in an open sequence viewer. ' +
      'Coordinates are 1-indexed and inclusive (GenBank convention). Call this ' +
      'whenever your answer refers to a specific span, feature, or region so the ' +
      'user sees the exact bases highlighted. For a DISJOINT selection (descriptor ' +
      'measured.disjoint:true) pass the regions array, not a single span. If the ' +
      'sequence is not open, it opens beside the chat and highlights once it ' +
      'mounts. Use coordinates from a reference chip or from find_features / ' +
      'get_sequence — never invent them.',
    inputSchema: highlightRangeSchema as z.ZodTypeAny,
    execute: async (input: HighlightRangeInput) => {
      const result = await highlightRangeInCanvas(input, folders);
      if (!result.ok) return {...result, ...toolFailure({code: result.code, error: result.error, retriable: false, stateChanged: 'unknown', partialEffects: []})};
      return result;
    },
  });
}
