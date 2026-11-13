import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore, migratePersistedCanvasState } from './store';
import { isKnownTabType, TAB_TYPES } from './types';

function singlePanel() {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
}

describe('unknown tab types are rejected at the boundary', () => {
  beforeEach(singlePanel);

  it('refuses an object where the tab type belongs, naming the caller mistake', () => {
    expect(() =>
      useCanvasStore.getState().openTab('main', {
        type: { type: 'sequence', title: 'chrMT', filePath: '/ws/chrMT.gb' },
        entityId: 'doc-1',
        label: 'chrMT',
      } as never)
    ).toThrow(/Unknown tab type.*openTab takes \(panelId/s);
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('refuses an unknown string type', () => {
    expect(() =>
      useCanvasStore.getState().openTab('main', {
        type: 'spreadsheet' as never,
        entityId: 'doc-1',
        label: 'x',
      })
    ).toThrow(/Unknown tab type/);
  });

  it('still accepts every published tab type', () => {
    for (const type of TAB_TYPES) {
      expect(isKnownTabType(type)).toBe(true);
    }
    expect(isKnownTabType('nope')).toBe(false);
    expect(isKnownTabType({})).toBe(false);
    expect(isKnownTabType(undefined)).toBe(false);
  });
});

describe('a damaged persisted layout self-heals', () => {
  it('drops unrenderable tabs on rehydration and repairs the active tab', () => {
    const persisted = {
      panels: {
        main: {
          id: 'main',
          activeTabId: 'junk',
          tabs: [
            { id: 'junk', type: { type: 'sequence' }, entityId: 'x', label: 'x' },
            { id: 'good', type: 'text', entityId: '/ws/a.txt', label: 'a.txt' },
          ],
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    };

    const state = migratePersistedCanvasState(persisted, 6);

    expect(state.panels.main.tabs.map((t) => t.id)).toEqual(['good']);
    expect(state.panels.main.activeTabId).toBe('good');
  });

  it('leaves a clean layout untouched', () => {
    const persisted = {
      panels: {
        main: {
          id: 'main',
          activeTabId: 'good',
          tabs: [{ id: 'good', type: 'text', entityId: '/ws/a.txt', label: 'a.txt' }],
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    };
    const state = migratePersistedCanvasState(persisted, 6);
    expect(state.panels.main.tabs).toHaveLength(1);
    expect(state.panels.main.activeTabId).toBe('good');
  });
});
