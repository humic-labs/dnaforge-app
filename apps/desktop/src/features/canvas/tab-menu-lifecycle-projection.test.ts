import { describe, expect, it } from 'vitest';
import { documentLifecycle } from '../../shared/document-lifecycle';
import { projectTabMenuPanels, projectTabStripTab } from './tab-menu-presentation';
import type { Tab } from './types';

describe('tab dirty presentation', () => {
  it.each([true, false])('uses the document owner when dirty is %s', (dirty) => {
    const tab: Tab = {
      id: 'protein-tab',
      type: 'protein',
      entityId: 'protein-document',
      label: 'Protein',
      isDirty: !dirty,
    };
    const registration = documentLifecycle.register({
      readRevision: () => 1,
      target: { kind: 'tab', tabId: tab.id },
      tabId: tab.id,
      isDirty: () => dirty,
      save: async () => true,
    });
    try {
      const menu = projectTabMenuPanels({
        main: { id: 'main', activeTabId: tab.id, tabs: [tab] },
      });
      expect(menu.main.tabs[0].isDirty).toBe(dirty);
      expect(projectTabStripTab(tab).isDirty).toBe(dirty);
      expect(menu.main.tabs[0]).not.toHaveProperty('entityId');
    } finally {
      registration.release();
    }
  });
});
