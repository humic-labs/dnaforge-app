import type { Tab, TabType } from './types';
import { classifyTabSession } from './tab-document-session';

export type TabEditor =
  | { type: 'design'; designId: string; packageOwned: boolean }
  | { type: Exclude<TabType, 'design'> };

export function resolveTabEditor(
  tab: Pick<Tab, 'type' | 'entityId' | 'assemblyEditDesignId'>
): TabEditor {
  const session = classifyTabSession(tab);
  if (session.kind === 'sequence-assembly') {
    return { type: 'design', designId: session.designId, packageOwned: true };
  }
  if (session.kind === 'design') {
    return { type: 'design', designId: session.designId, packageOwned: false };
  }
  return { type: session.kind };
}
