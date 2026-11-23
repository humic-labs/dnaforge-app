   
                                             
   

import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { openDocument } from '../../document-opening/public/open-document';
import { z } from 'zod';
import { useCanvasStore } from '../../canvas/public/store';
import { openSequenceDocument } from '../../document-opening/public/compat';
import { resolveSequenceDocumentById } from '../../sequence/public/sequence-document-repository';
import { parseLocatorPath } from '../references/resolver';
import { resolveMultiRootPath } from './path-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { openTabSchema, type OpenTabInput } from './open-tab-schema';
import { looksLikeWorkspacePath } from '../../../shared/resolve-entity-path';
import { isMolecularDocumentFile, isTypedDocumentCandidate } from '../../../shared/document-availability';
import { checkDocumentOpen } from '../../document-opening/public/availability';
import { findWorkspaceRootForPath } from '../../../db/workspace-catalog';
import { userMessage } from '@waypoint/user-messages';

export { openTabSchema, type OpenTabInput } from './open-tab-schema';

export type LLMTabType =
  | 'sequence'
  | 'page'
  | 'design'
  | 'file'
  | 'structure'
  | 'protein'
  | 'pdf'
  | 'scientific-document';

function validateEntityId(entityId: string): string | null {
  if (!entityId || !entityId.trim()) return 'entityId cannot be empty';
  if (entityId.includes('..')) return 'entityId cannot contain path traversal (..)';
  if (entityId.length > 500) return 'entityId is too long (max 500 characters)';
  return null;
}

const FILE_BASED_TYPES = ['file', 'structure', 'pdf', 'scientific-document'];

async function waitForMolecularTab(tabId: string, signal?: AbortSignal): Promise<string | undefined> {
  const { describeStructureOpen } = await import('../../agent-bridge/structure-tools');
  const deadline = Date.now() + 10_000;
  while (!signal?.aborted && Date.now() < deadline) {
    const state = await describeStructureOpen(tabId).catch(() => null);
    if (state?.viewerStatus === 'active') return;
    if (!state || state.viewerStatus === 'error')
      return state?.stateError ?? userMessage('document.readScene');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return signal?.aborted
    ? 'Document opening was cancelled.'
    : userMessage('structure.failed');
}

   
                                                                    
                                                                         
                                                                      
                                                                          
                       
   
function normalizeEntityId(rawEntityId: string, type: string, folders: WorkspaceFolder[]): string {
                                                                 
  let entityId = parseLocatorPath(rawEntityId);

                                                   
  if (FILE_BASED_TYPES.includes(type) && folders.length > 0) {
    try {
      const resolved = resolveMultiRootPath(folders, entityId);
      entityId = resolved.absolutePath;
    } catch {
                                                                                   
    }
  }

  return entityId;
}

   
                                                                             
                                                                         
   
export async function openTabInCanvas(
  { type, entityId: rawEntityId, label }: OpenTabInput,
  folders: WorkspaceFolder[],
  options: { signal?: AbortSignal } = {}
): Promise<{ tabId: string; error?: string }> {
  if (options.signal?.aborted) return { tabId: '', error: 'Document opening was cancelled.' };
  const entityId = normalizeEntityId(rawEntityId, type, folders);

                                                                        
  if (FILE_BASED_TYPES.includes(type) || type === 'sequence') {
    const validationError = validateEntityId(entityId);
    if (validationError) {
      return { tabId: '', error: validationError };
    }
  }

  const store = useCanvasStore.getState();

                                                                             
                                                                          
                                                                           
                                                                           
                                                
  if (type === 'sequence') {
    if (looksLikeWorkspacePath(entityId)) {
      return {
        tabId: '',
        error: 'Physical sequence paths are deprecated; use the stable sequence document ID.',
      };
    }
    const existing = store.findTab('sequence', entityId);
    if (existing) {
      const workingPanelId = store.focusedPanelId;
      store.focusPanel(existing.panelId);
      store.setActiveTab(existing.panelId, existing.tabId);
      if (workingPanelId) store.focusPanel(workingPanelId);
      return { tabId: existing.tabId };
    }
    const resolved = await resolveSequenceDocumentById(
      entityId,
      folders.map((folder) => folder.path)
    ).catch(() => null);
    if (!resolved) {
      return { tabId: '', error: 'The sequence document is no longer available.' };
    }
    if (resolved.ref.kind === 'managed-sequence') {
      const path = resolved.ref.packageRoot;
      const availability = await checkDocumentOpen({
        workspaceRoot: findWorkspaceRootForPath(folders, path) ?? undefined,
        path,
        package: true,
      });
      if (availability.state === 'blocked') return { tabId: '', error: availability.reason };
    }

                                                                                
                                                                           
    const { targetPanelId, workingPanelId, createdPanelId } = store.agentContentPlacement();
    const tabId = await openSequenceDocument(resolved.ref, {
      label: label || resolved.name || entityId,
      strategy: { kind: 'panel', panelId: targetPanelId },
      sourceSurface: 'unknown',
      signal: options.signal,
    });
    store.focusPanel(workingPanelId);
    if (!tabId) {
                                                                            
                                                                         
                                                             
      if (createdPanelId && useCanvasStore.getState().panels[createdPanelId]?.tabs.length === 0) store.closePanel(createdPanelId);
      return { tabId: '', error: 'File too large or unavailable' };
    }
    return { tabId };
  }

  const molecularFile = FILE_BASED_TYPES.includes(type) && isMolecularDocumentFile(entityId);
  const fileTarget = FILE_BASED_TYPES.includes(type);
  const reuseWithoutRead = !fileTarget || !isTypedDocumentCandidate(entityId);
  const existing = reuseWithoutRead ? store.findTab(type, entityId) : undefined;
  if (existing) {
    store.setActiveTab(existing.panelId, existing.tabId);
    const working = Object.values(store.panels).find((panel) => panel.tabs.some((tab) => tab.type === 'chat'));
    if (working) store.focusPanel(working.id);
    return { tabId: existing.tabId };
  }
  const { targetPanelId, workingPanelId, createdPanelId } = store.agentContentPlacement();
  const result = await openDocument({
    target: FILE_BASED_TYPES.includes(type)
      ? { kind: 'file', path: entityId, tabType: type }
      : { kind: 'record', tabType: type, entityId },
    label, placement: { kind: 'panel', panelId: targetPanelId }, source: 'unknown',
    signal: options.signal,
  });
  store.focusPanel(workingPanelId);
  if (result.status === 'presented') {
    if (molecularFile) {
      const error = await waitForMolecularTab(result.tabId, options.signal);
      if (error) return { tabId: '', error };
    }
    return { tabId: result.tabId };
  }
  if (createdPanelId && useCanvasStore.getState().panels[createdPanelId]?.tabs.length === 0) store.closePanel(createdPanelId);
  return { tabId: '', error: 'message' in result ? result.message : result.reason };
}

export const openTabOutputSchema = z.object({ok: z.literal(true), tabId: z.string().min(1)});

export function createOpenTabTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Open a sequence, page, design, protein, literal PDF, scientific document, or other content in the canvas. ' +
      'For sequences, pass the stable document ID returned by sequence import or discovery tools, never a file path. ' +
      'Content opens in the panel beside the chat automatically (reusing it if ' +
      'one is already there), so the chat stays visible — you never need to ' +
      'split or manage panes.',
    inputSchema: openTabSchema as z.ZodTypeAny,
    execute: async (input: OpenTabInput) => {
      const result = await openTabInCanvas(input, folders);
      if (result.error) return {...result, ...toolFailure({code: 'OPEN_TAB_FAILED', error: result.error, retriable: false, stateChanged: 'unknown', partialEffects: []})};
      return toolSuccess({tabId: result.tabId});
    },
  });
}

                                                                             
export const openTabTool = createOpenTabTool([]);
