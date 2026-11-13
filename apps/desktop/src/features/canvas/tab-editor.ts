import type { Tab, TabType } from './types';

export type TabEditor =
  | { type: 'design'; designId: string; packageOwned: boolean }
  | { type: Exclude<TabType, 'design'> };

export function resolveTabEditor(
  tab: Pick<Tab, 'type' | 'entityId' | 'assemblyEditDesignId'>
): TabEditor {
  if (tab.type === 'sequence' && tab.assemblyEditDesignId) {
    return { type: 'design', designId: tab.assemblyEditDesignId, packageOwned: true };
  }
  if (tab.type === 'design') {
    return { type: 'design', designId: tab.entityId, packageOwned: false };
  }
  return { type: tab.type };
}
