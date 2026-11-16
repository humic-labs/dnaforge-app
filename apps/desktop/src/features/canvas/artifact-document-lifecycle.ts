import { tableDocumentReferenceFromKey } from '../../shared/table-document-reference';
import { classifyTabSession } from './tab-document-session';
import { documentLifecycle } from '../../shared/document-lifecycle';
import { TAB_DOCUMENT_LIFECYCLES } from '../../shared/tab-kind';
import type { SaveDocumentTarget } from '../../shared/save-document-events';
import type { ArtifactDocumentContext, EditableArtifactKind, Tab } from './types';

export type { ArtifactDocumentContext, EditableArtifactKind };

export interface ArtifactDocumentCloseRequest {
  panelId: string;
  tabIds: string[];
}

export function isEphemeralArtifactDraft(tab: Tab): boolean {
  return tab.artifactDocument?.persistence === 'draft';
}

export function shouldRememberClosedTab(tab: Tab): boolean {
  return !isEphemeralArtifactDraft(tab) && !tab.openingTrackViewPath;
}

export function saveTargetForTab(tab: Tab): SaveDocumentTarget {
  const session = classifyTabSession(tab);
  if (
    tab.artifactDocument ||
    tab.type === 'record' ||
    tab.type === 'design' ||
    tab.type === 'protein'
  )
    return { kind: 'tab', tabId: tab.id };
  if (tab.type === 'page') return { kind: 'page', pageId: tab.entityId };
  const table =
    tab.type === 'table'
      ? (tab.tableDocument ?? tableDocumentReferenceFromKey(tab.entityId))
      : null;
  if (table?.backing.kind === 'notebook-inline' && table.binding.kind === 'current')
    return { kind: 'page', pageId: table.backing.notebookDocumentId };
  if (tab.type === 'sequence') {
    if (session.kind === 'sequence' && session.editor === 'indexed')
      return { kind: 'tab', tabId: tab.id };
    return { kind: 'sequence-document', documentId: tab.entityId };
  }
  return { kind: 'file', filePath: tab.entityId };
}

export function requestTabsClose(panelId: string, tabIds: readonly string[]): void {
  const uniqueTabIds = [...new Set(tabIds)];
  if (uniqueTabIds.length === 0) return;
  window.dispatchEvent(
    new CustomEvent('artifact-document-close-request', {
      detail: { panelId, tabIds: uniqueTabIds },
    })
  );
}

export function requestTabClose(panelId: string, tabId: string): void {
  requestTabsClose(panelId, [tabId]);
}

export function announceArtifactDraftDiscard(tabId: string): void {
  void documentLifecycle.discard({ kind: 'tab', tabId }, tabId);
}

declare global {
  interface WindowEventMap {
    'artifact-document-close-request': CustomEvent<ArtifactDocumentCloseRequest>;
  }
}

export function isTabDirty(tab: Tab): boolean {
  if (TAB_DOCUMENT_LIFECYCLES[tab.type] === 'read-only') return false;
  return documentLifecycle.dirty(saveTargetForTab(tab), tab.id) ?? Boolean(tab.isDirty);
}
