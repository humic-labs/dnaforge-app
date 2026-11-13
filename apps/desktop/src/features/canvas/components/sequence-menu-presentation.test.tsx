/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandScopeProvider } from '../../../commands';
import { useCanvasStore } from '../store';
import { TabContextMenu } from './TabContextMenu';
import { TabBarContextMenu } from './TabBarContextMenu';

vi.mock('../../../db/workspace-catalog', () => ({
  getCurrentCatalogFileForEntity: vi.fn(async () => null),
}));

describe('context menus across the real canvas-store boundary', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      recentlyClosed: [],
    });
  });

  it.each(['tab', 'tabbar'] as const)(
    '%s merge menu receives the admitted sequence name',
    async (kind) => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', { type: 'text', entityId: 'notes', label: 'Notes' });
      const other = store.splitPanel('main', 'horizontal');
      store.openTab(other, {
        type: 'sequence',
        entityId: 'sequence-test',
        label: 'pBR322 Follow-up.gb',
        sequenceDocument: { kind: 'catalog-sequence', entityId: 'sequence-test' },
      });
      render(
        <CommandScopeProvider>
          {kind === 'tab' ? (
            <TabContextMenu
              position={{ x: 0, y: 0 }}
              panelId="main"
              tabId={tabId}
              onClose={() => {}}
            />
          ) : (
            <TabBarContextMenu position={{ x: 0, y: 0 }} panelId="main" onClose={() => {}} />
          )}
        </CommandScopeProvider>
      );
      await act(async () => {});
      fireEvent.focus(
        screen.getByRole('button', {
          name: kind === 'tab' ? 'Merge pane with...' : 'Merge tabs with...',
        })
      );
      expect(screen.getAllByRole('menu')[0]).toHaveTextContent('pBR322 Follow-up');
      expect(screen.getAllByRole('menu')[0]).not.toHaveTextContent('.gb');
      await act(async () =>
        store.updateTabByEntityId('sequence-test', { label: 'pBR322.v2.fasta.gz' })
      );
      expect(screen.getAllByRole('menu')[0]).toHaveTextContent('pBR322.v2');
      expect(screen.getAllByRole('menu')[0]).not.toHaveTextContent('.fasta.gz');
    }
  );
});
