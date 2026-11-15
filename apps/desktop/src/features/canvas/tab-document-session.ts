import type { Tab, TabType } from './types';
import type { SequenceDocumentRef } from '../../shared/managed-sequence-document';

export type TabDocumentSession =
  | { kind: 'sequence'; editor: 'sequence' | 'indexed'; document?: SequenceDocumentRef }
  | { kind: 'sequence-assembly'; designId: string }
  | { kind: 'design'; designId: string }
  | { kind: Exclude<TabType, 'sequence' | 'design'> };

type SessionInput = Pick<
  Tab,
  | 'type'
  | 'entityId'
  | 'sequenceDocument'
  | 'assemblyEditDesignId'
  | 'indexedGenome'
  | 'loadStatus'
  | 'trackView'
>;

export function classifyTabSession(tab: SessionInput): TabDocumentSession {
  if (tab.type === 'sequence') {
    if (tab.assemblyEditDesignId)
      return { kind: 'sequence-assembly', designId: tab.assemblyEditDesignId };
    const indexed = Boolean(
      tab.trackView ||
      tab.indexedGenome ||
      tab.sequenceDocument?.kind === 'indexed-sequence' ||
      tab.loadStatus === 'indexed-pending' ||
      tab.loadStatus === 'indexed' ||
      tab.loadStatus === 'indexed-error'
    );
    return {
      kind: 'sequence',
      editor: indexed ? 'indexed' : 'sequence',
      document: tab.sequenceDocument,
    };
  }
  if (tab.type === 'design') return { kind: 'design', designId: tab.entityId };
  return { kind: tab.type };
}
