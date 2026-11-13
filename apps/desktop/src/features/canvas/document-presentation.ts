import type { TabType } from './types';

export type OpenStrategy =
  | { kind: 'focused' }
  | { kind: 'smart' }
  | { kind: 'panel'; panelId: string };

export type DocumentContentState = 'ready' | 'loading' | 'missing' | 'error';

export type PresentedDocument = {
  status: 'presented';
  tabId: string;
  panelId: string;
  tabType: TabType;
  disposition: 'created' | 'reused';
  content: DocumentContentState;
};

export type DocumentOpenResult =
  | PresentedDocument
  | { status: 'cancelled'; reason: string }
  | { status: 'blocked' | 'unsupported' | 'failed'; message: string };

export const cancelledDocumentOpen = (): DocumentOpenResult => ({
  status: 'cancelled',
  reason: 'The opening request was cancelled.',
});

export function presentedTabId(result: DocumentOpenResult): string | null {
  return result.status === 'presented' ? result.tabId : null;
}
