/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useHiddenMapIdlePolicy } from '@waypoint/genome-renderer/react';
import {
  SEQUENCE_TAB_RETENTION_BUDGETS,
  sequenceTabRetention,
  TabPortalProvider,
} from '../TabContentPortalManager';
import { useMemoryPressureStore } from '../../../memory-pressure/public';
import { TAB_PORTAL_HOST_ATTACHED_EVENT, TabPortalTarget } from '../TabPortalTarget';
import type { Tab, PanelState } from '../../types';
import { ExplorerWorkspaceSurface } from '../../ExplorerWorkspaceSurface';

const {
  panelContentMapPolicySpy,
  acquireCachedViewerLeaseSpy,
  panelContentRenderSpy,
  panelContentHostSpy,
  panelContentMountSpy,
  panelContentUnmountSpy,
  releaseCachedViewerLeaseSpy,
} = vi.hoisted(() => ({
  acquireCachedViewerLeaseSpy: vi.fn(),
  panelContentRenderSpy: vi.fn(),
  panelContentHostSpy: vi.fn(),

  panelContentMountSpy: vi.fn(),
  panelContentUnmountSpy: vi.fn(),
  releaseCachedViewerLeaseSpy: vi.fn(),
  panelContentMapPolicySpy: vi.fn(),
}));

function mountedEntities(): string[] {
  return panelContentMountSpy.mock.calls.map((c) => c[0] as string);
}

function unmountedEntities(): string[] {
  return panelContentUnmountSpy.mock.calls.map((c) => c[0] as string);
}

function mountCountFor(entityId: string): number {
  return mountedEntities().filter((id) => id === entityId).length;
}

function unmountCountFor(entityId: string): number {
  return unmountedEntities().filter((id) => id === entityId).length;
}

let mockPanels: Record<string, PanelState> = {};
let tabCounter = 0;
let panelCounter = 0;

function resetMockStore() {
  tabCounter = 0;
  panelCounter = 0;
  mockPanels = {
    main: { id: 'main', tabs: [], activeTabId: null },
  };
}

function mockOpenTab(
  panelId: string,
  tabData: { type: string; entityId: string; label: string; indexedGenome?: Tab['indexedGenome'] }
): string {
  tabCounter++;
  const tabId = `tab-${tabCounter.toString().padStart(4, '0')}`;
  const tab: Tab = {
    id: tabId,
    type: tabData.type as Tab['type'],
    entityId: tabData.entityId,
    label: tabData.label,
    ...(tabData.indexedGenome ? { indexedGenome: tabData.indexedGenome } : {}),
  };
  const panel = mockPanels[panelId];
  if (panel) {
    mockPanels = {
      ...mockPanels,
      [panelId]: { ...panel, tabs: [...panel.tabs, tab], activeTabId: tabId },
    };
  }
  return tabId;
}

function indexedTabMarker(chrom: string): Tab['indexedGenome'] {
  return {
    sourcePath: `/workspace/${chrom}.gbff`,
    sourceSizeBytes: 100,
    sourceExt: 'gbff',
    chrom,
  } as Tab['indexedGenome'];
}

function mockSplitPanel(_fromPanelId: string, _direction: string): string {
  panelCounter++;
  const newPanelId = `panel-${panelCounter.toString().padStart(4, '0')}`;
  mockPanels = {
    ...mockPanels,
    [newPanelId]: { id: newPanelId, tabs: [], activeTabId: null },
  };
  return newPanelId;
}

function mockSetActiveTab(panelId: string, tabId: string) {
  const panel = mockPanels[panelId];
  if (panel) {
    mockPanels = {
      ...mockPanels,
      [panelId]: { ...panel, activeTabId: tabId },
    };
  }
}

function mockMoveTab(fromPanelId: string, toPanelId: string, tabId: string) {
  const fromPanel = mockPanels[fromPanelId];
  const toPanel = mockPanels[toPanelId];
  if (!fromPanel || !toPanel) return;

  const tab = fromPanel.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const newFromTabs = fromPanel.tabs.filter((t) => t.id !== tabId);
  mockPanels = {
    ...mockPanels,
    [fromPanelId]: {
      ...fromPanel,
      tabs: newFromTabs,
      activeTabId:
        fromPanel.activeTabId === tabId ? (newFromTabs[0]?.id ?? null) : fromPanel.activeTabId,
    },
    [toPanelId]: {
      ...toPanel,
      tabs: [...toPanel.tabs, tab],
      activeTabId: tabId,
    },
  };
}

function mockCloseTab(panelId: string, tabId: string) {
  const panel = mockPanels[panelId];
  if (!panel) return;

  const newTabs = panel.tabs.filter((t) => t.id !== tabId);
  mockPanels = {
    ...mockPanels,
    [panelId]: {
      ...panel,
      tabs: newTabs,
      activeTabId: panel.activeTabId === tabId ? (newTabs[0]?.id ?? null) : panel.activeTabId,
    },
  };
}

vi.mock('../../store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => {
      const state = {
        panels: mockPanels,
        openTab: mockOpenTab,
        splitPanel: mockSplitPanel,
        setActiveTab: mockSetActiveTab,
        moveTab: mockMoveTab,
        closeTab: mockCloseTab,
      };
      return selector(state);
    },
    {
      getState: () => ({
        panels: mockPanels,
        openTab: mockOpenTab,
        splitPanel: mockSplitPanel,
        setActiveTab: mockSetActiveTab,
        moveTab: mockMoveTab,
        closeTab: mockCloseTab,
      }),
      setState: (partial: Record<string, unknown>) => {
        if (partial.panels) mockPanels = partial.panels as Record<string, PanelState>;
      },
    }
  ),
}));

vi.mock('../PanelContent', async () => {
  const { useEffect, memo } = await vi.importActual<typeof import('react')>('react');

  const PanelContentMock = ({
    tab,
    panelId,
  }: {
    tab: { entityId: string; type: string } | null;
    panelId: string;
  }) => {
    const mountedEntityId = tab?.entityId ?? null;
    const mapPolicy = useHiddenMapIdlePolicy('bounded-lru');
    useEffect(() => {
      if (!mountedEntityId) return;
      panelContentMountSpy(mountedEntityId);
      return () => {
        panelContentUnmountSpy(mountedEntityId);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- instance lifecycle, not value tracking
    }, []);

    if (!tab) return null;
    panelContentRenderSpy(tab.entityId, tab.type);
    panelContentHostSpy(tab.entityId, panelId);
    panelContentMapPolicySpy(tab.entityId, mapPolicy);
    return (
      <div data-testid={`panel-content-${tab.entityId}`} data-panel-id={panelId}>
        Content: {tab.entityId}
      </div>
    );
  };
  return { PanelContent: memo(PanelContentMock) };
});

vi.mock('../../../memory-pressure/use-memory-pressure-monitoring', () => ({
  useMemoryPressureMonitoring: () => {},
}));

function setPressure(level: 'normal' | 'moderate' | 'critical'): void {
  act(() => {
    useMemoryPressureStore.setState({ level, source: 'forced', sampledAt: Date.now() });
  });
}

vi.mock('../../../../shared/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../page/embeds/structure3d/molstar/cache', () => ({
  acquireCachedViewerLease: acquireCachedViewerLeaseSpy,
  getPaneRendererHostCacheKey: (rendererHostId: string) => `pane-cache:${rendererHostId}`,
  releaseCachedViewerLease: releaseCachedViewerLeaseSpy,
}));

function getActiveTab(panelId: string): Tab | null {
  const panel = mockPanels[panelId];
  if (!panel?.activeTabId) return null;
  return panel.tabs.find((t) => t.id === panel.activeTabId) ?? null;
}

describe('TabPortalProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockStore();
    sequenceTabRetention.clear();
    useMemoryPressureStore.setState({ level: 'normal', source: 'forced', sampledAt: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('updates the saved document address without replacing its live tab host or remounting content', () => {
    const originalId = 'structure-input:3tyg';
    const documentId = 'molecular-document:scope::e3a5cce3-97ec-4bf7-810e-cbc870f57bc4';
    const tabId = mockOpenTab('main', {
      type: 'structure',
      entityId: originalId,
      label: '3TYG',
    });
    const tree = () => (
      <TabPortalProvider>
        <TabPortalTarget tab={getActiveTab('main')} />
      </TabPortalProvider>
    );
    const view = render(tree());
    const host = screen.getByTestId(`tab-content-container-${originalId}`);
    expect(mountCountFor(originalId)).toBe(1);
    const panel = mockPanels.main;
    mockPanels = {
      ...mockPanels,
      main: {
        ...panel,
        tabs: panel.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, entityId: documentId, label: 'Attached 3TYG glycans' } : tab
        ),
      },
    };

    view.rerender(tree());

    expect(screen.getByTestId(`tab-content-container-${documentId}`)).toBe(host);
    expect(screen.queryByTestId(`tab-content-container-${originalId}`)).not.toBeInTheDocument();
    expect(host).toContainElement(screen.getByTestId(`panel-content-${documentId}`));
    expect(panelContentMountSpy).toHaveBeenCalledTimes(1);
    expect(panelContentUnmountSpy).not.toHaveBeenCalled();
  });

  describe('portal content eligibility', () => {
    it('renders active sequence content across panels', () => {
      const panel2Id = mockSplitPanel('main', 'vertical');
      mockOpenTab('main', { type: 'sequence', entityId: 'verify-1', label: 'Verify 1' });
      mockOpenTab(panel2Id, { type: 'sequence', entityId: 'verify-2', label: 'Verify 2' });

      render(
        <TabPortalProvider>
          <div data-testid="panel-1">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
          <div data-testid="panel-2">
            <TabPortalTarget tab={getActiveTab(panel2Id)} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-verify-1')).toBeInTheDocument();
      expect(screen.getByTestId('panel-content-verify-2')).toBeInTheDocument();
    });

    it('keeps a recently used inactive sequence tab mounted outside the visible DOM ', () => {
      mockOpenTab('main', { type: 'sequence', entityId: 'verify-1', label: 'Verify 1' });
      const tree = () => (
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );
      const view = render(tree());

      mockOpenTab('main', { type: 'sequence', entityId: 'verify-2', label: 'Verify 2' });
      view.rerender(tree());

      const panelArea = screen.getByTestId('panel-area');
      expect(panelArea).toContainElement(screen.getByTestId('panel-content-verify-2'));

      expect(mountCountFor('verify-1')).toBe(1);
      expect(panelArea).not.toContainElement(screen.queryByTestId('panel-content-verify-1'));

      expect(panelContentMapPolicySpy).toHaveBeenCalledWith('verify-1', 'host-retained');
    });

    it('keeps inactive INDEXED sequence tabs mounted  task #6 — tab cache)', () => {
      mockOpenTab('main', {
        type: 'sequence',
        entityId: 'chr11.gbff',
        label: 'chr11',
        indexedGenome: indexedTabMarker('chr11'),
      });
      mockOpenTab('main', {
        type: 'sequence',
        entityId: 'chr22.gbff',
        label: 'chr22',
        indexedGenome: indexedTabMarker('chr22'),
      });

      render(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-chr22.gbff')).toBeInTheDocument();

      expect(panelContentRenderSpy).toHaveBeenCalledWith('chr22.gbff', 'sequence');
      expect(panelContentRenderSpy).toHaveBeenCalledWith('chr11.gbff', 'sequence');
    });

    it('keeps the eight most recently used sequence tabs and unmounts the ninth-oldest ', () => {
      expect(SEQUENCE_TAB_RETENTION_BUDGETS).toEqual({ normal: 8, moderate: 4, critical: 1 });
      const ids: string[] = [];
      for (let i = 1; i <= 8; i += 1) {
        ids.push(mockOpenTab('main', { type: 'sequence', entityId: `seq-${i}`, label: `S${i}` }));
      }
      const view = render(
        <TabPortalProvider>
          <TabPortalTarget tab={getActiveTab('main')} />
        </TabPortalProvider>
      );

      for (const id of ids) {
        act(() => mockSetActiveTab('main', id));
        view.rerender(
          <TabPortalProvider>
            <TabPortalTarget tab={getActiveTab('main')} />
          </TabPortalProvider>
        );
      }
      expect(unmountedEntities()).toEqual([]);

      act(() => mockSetActiveTab('main', ids[0]));
      view.rerender(
        <TabPortalProvider>
          <TabPortalTarget tab={getActiveTab('main')} />
        </TabPortalProvider>
      );
      mockOpenTab('main', { type: 'sequence', entityId: 'seq-9', label: 'S9' });
      view.rerender(
        <TabPortalProvider>
          <TabPortalTarget tab={getActiveTab('main')} />
        </TabPortalProvider>
      );

      expect(unmountedEntities()).toEqual(['seq-2']);
      expect(mountCountFor('seq-9')).toBe(1);
      expect(mountCountFor('seq-1')).toBe(1);
    });

    it('shrinks to four under moderate pressure and to the visible tab under critical', () => {
      const ids: string[] = [];
      for (let i = 1; i <= 6; i += 1) {
        ids.push(mockOpenTab('main', { type: 'sequence', entityId: `seq-${i}`, label: `S${i}` }));
      }
      const view = render(
        <TabPortalProvider>
          <TabPortalTarget tab={getActiveTab('main')} />
        </TabPortalProvider>
      );
      for (const id of ids) {
        act(() => mockSetActiveTab('main', id));
        view.rerender(
          <TabPortalProvider>
            <TabPortalTarget tab={getActiveTab('main')} />
          </TabPortalProvider>
        );
      }
      expect(unmountedEntities()).toEqual([]);

      setPressure('moderate');
      expect(unmountedEntities().sort()).toEqual(['seq-1', 'seq-2']);

      setPressure('critical');
      expect(unmountedEntities().sort()).toEqual(['seq-1', 'seq-2', 'seq-3', 'seq-4', 'seq-5']);
      expect(screen.getByTestId('panel-content-seq-6')).toBeInTheDocument();

      vi.clearAllMocks();
      setPressure('normal');
      expect(mountedEntities()).toEqual([]);
    });

    it('does not remount a retained sequence tab when switching back to it', () => {
      const first = mockOpenTab('main', { type: 'sequence', entityId: 'pUC19.gb', label: 'pUC19' });
      const second = mockOpenTab('main', {
        type: 'sequence',
        entityId: 'pUC18.gb',
        label: 'pUC18',
      });
      const view = render(
        <TabPortalProvider>
          <TabPortalTarget tab={getActiveTab('main')} />
        </TabPortalProvider>
      );
      for (const id of [first, second, first, second, first]) {
        act(() => mockSetActiveTab('main', id));
        view.rerender(
          <TabPortalProvider>
            <TabPortalTarget tab={getActiveTab('main')} />
          </TabPortalProvider>
        );
      }
      expect(mountCountFor('pUC19.gb')).toBe(1);
      expect(mountCountFor('pUC18.gb')).toBe(1);
      expect(unmountedEntities()).toEqual([]);
    });

    it('does not apply the sequence budget or map policy to other tab types', () => {
      mockOpenTab('main', { type: 'text', entityId: 'notes-1', label: 'Notes' });
      render(
        <TabPortalProvider>
          <TabPortalTarget tab={getActiveTab('main')} />
        </TabPortalProvider>
      );
      expect(panelContentMapPolicySpy).toHaveBeenCalledWith('notes-1', 'bounded-lru');
    });

    it('keeps inactive non-sequence tab content mounted outside the visible DOM', () => {
      mockOpenTab('main', { type: 'text', entityId: 'notes-1', label: 'Notes' });
      mockOpenTab('main', { type: 'sequence', entityId: 'verify-2', label: 'Verify 2' });

      render(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      const panelArea = screen.getByTestId('panel-area');
      expect(panelArea).toContainElement(screen.getByTestId('panel-content-verify-2'));

      expect(screen.queryByTestId('panel-content-notes-1')).not.toBeInTheDocument();
      expect(panelContentRenderSpy).toHaveBeenCalledWith('notes-1', 'text');
    });

    it('unmounts inactive structure tabs and gives the active structure the pane host identity', () => {
      mockOpenTab('main', { type: 'structure', entityId: 'fun12.cif', label: 'FUN12' });
      mockOpenTab('main', { type: 'structure', entityId: '1fs0.pdb', label: '1FS0' });

      render(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-1fs0.pdb')).toHaveAttribute('data-panel-id', 'main');
      expect(screen.queryByTestId('panel-content-fun12.cif')).not.toBeInTheDocument();
      expect(panelContentRenderSpy).not.toHaveBeenCalledWith('fun12.cif', 'structure');
      expect(panelContentHostSpy).toHaveBeenCalledWith('1fs0.pdb', 'main');
    });

    it('suspends the selected structure when another workspace surface takes over and restores its tab', () => {
      const tabId = mockOpenTab('main', {
        type: 'structure',
        entityId: '1fs0.pdb',
        label: '1FS0',
      });
      const workspace = (takeoverActive: boolean) => (
        <ExplorerWorkspaceSurface
          takeoverActive={takeoverActive}
          emptyFilesHomeActive={false}
          explorerInset={0}
        >
          <TabPortalProvider>
            <TabPortalTarget tab={getActiveTab('main')} />
          </TabPortalProvider>
        </ExplorerWorkspaceSurface>
      );
      const { rerender } = render(workspace(false));
      expect(screen.getByTestId('panel-content-1fs0.pdb')).toBeInTheDocument();
      expect(mountCountFor('1fs0.pdb')).toBe(1);

      rerender(workspace(true));
      expect(screen.getByTestId('explorer-workspace-surface')).toHaveAttribute(
        'aria-hidden',
        'true'
      );
      expect(unmountCountFor('1fs0.pdb')).toBe(1);
      expect(screen.queryByTestId('panel-content-1fs0.pdb')).not.toBeInTheDocument();
      expect(getActiveTab('main')?.id).toBe(tabId);
      expect(releaseCachedViewerLeaseSpy).not.toHaveBeenCalled();

      rerender(workspace(false));
      expect(screen.getByTestId('panel-content-1fs0.pdb')).toBeInTheDocument();
      expect(getActiveTab('main')?.id).toBe(tabId);
      expect(mountCountFor('1fs0.pdb')).toBe(2);
      expect(acquireCachedViewerLeaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseCachedViewerLeaseSpy).not.toHaveBeenCalled();
    });

    it('assigns distinct renderer host identities to structures visible in two panes', () => {
      const secondPanelId = mockSplitPanel('main', 'vertical');
      mockOpenTab('main', { type: 'structure', entityId: 'fun12.cif', label: 'FUN12' });
      mockOpenTab(secondPanelId, { type: 'structure', entityId: '1fs0.pdb', label: '1FS0' });

      render(
        <TabPortalProvider>
          <div data-testid="panel-1">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
          <div data-testid="panel-2">
            <TabPortalTarget tab={getActiveTab(secondPanelId)} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-fun12.cif')).toHaveAttribute(
        'data-panel-id',
        'main'
      );
      expect(screen.getByTestId('panel-content-1fs0.pdb')).toHaveAttribute(
        'data-panel-id',
        secondPanelId
      );
      expect(panelContentHostSpy).toHaveBeenCalledWith('fun12.cif', 'main');
      expect(panelContentHostSpy).toHaveBeenCalledWith('1fs0.pdb', secondPanelId);
    });
  });

  describe('tab switching and movement', () => {
    it('keeps the pane renderer lease while switching from a structure to a text tab', () => {
      const structureTabId = mockOpenTab('main', {
        type: 'structure',
        entityId: 'fun12.cif',
        label: 'FUN12',
      });
      const textTabId = mockOpenTab('main', {
        type: 'text',
        entityId: 'notes.md',
        label: 'Notes',
      });

      const { rerender, unmount } = render(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(acquireCachedViewerLeaseSpy).toHaveBeenCalledTimes(1);
      expect(acquireCachedViewerLeaseSpy).toHaveBeenCalledWith('pane-cache:pane:main');
      expect(releaseCachedViewerLeaseSpy).not.toHaveBeenCalled();

      act(() => {
        mockSetActiveTab('main', structureTabId);
      });
      rerender(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );
      act(() => {
        mockSetActiveTab('main', textTabId);
      });
      rerender(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(acquireCachedViewerLeaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseCachedViewerLeaseSpy).not.toHaveBeenCalled();

      unmount();
      expect(releaseCachedViewerLeaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseCachedViewerLeaseSpy).toHaveBeenCalledWith('pane-cache:pane:main');
    });

    it('shows sequence content when switching the active tab', () => {
      mockOpenTab('main', { type: 'sequence', entityId: 'verify-1', label: 'Verify 1' });
      mockOpenTab('main', { type: 'sequence', entityId: 'verify-2', label: 'Verify 2' });

      const { rerender } = render(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-verify-2')).toBeInTheDocument();

      act(() => {
        const tab1Id = mockPanels['main'].tabs[0].id;
        mockSetActiveTab('main', tab1Id);
      });

      rerender(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-verify-1')).toBeInTheDocument();
    });

    it('does not remount indexed sequence tabs when switching back to them  task #6)', () => {
      mockOpenTab('main', {
        type: 'sequence',
        entityId: 'chr11.gbff',
        label: 'chr11',
        indexedGenome: indexedTabMarker('chr11'),
      });
      mockOpenTab('main', {
        type: 'sequence',
        entityId: 'chr22.gbff',
        label: 'chr22',
        indexedGenome: indexedTabMarker('chr22'),
      });

      const { rerender } = render(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(panelContentRenderSpy).toHaveBeenCalledWith('chr11.gbff', 'sequence');
      expect(panelContentRenderSpy).toHaveBeenCalledWith('chr22.gbff', 'sequence');

      const initialChr11Mounts = mountCountFor('chr11.gbff');
      expect(initialChr11Mounts).toBe(1);

      act(() => {
        const chr11Id = mockPanels['main'].tabs.find((t) => t.entityId === 'chr11.gbff')?.id;
        if (chr11Id) mockSetActiveTab('main', chr11Id);
      });
      rerender(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );
      expect(screen.getByTestId('panel-content-chr11.gbff')).toBeInTheDocument();

      act(() => {
        const chr22Id = mockPanels['main'].tabs.find((t) => t.entityId === 'chr22.gbff')?.id;
        if (chr22Id) mockSetActiveTab('main', chr22Id);
      });
      rerender(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );
      expect(screen.getByTestId('panel-content-chr22.gbff')).toBeInTheDocument();

      expect(mountCountFor('chr11.gbff')).toBe(initialChr11Mounts);
      expect(unmountCountFor('chr11.gbff')).toBe(0);
    });

    it('shows moved sequence tab content in its destination panel', () => {
      const panel2Id = mockSplitPanel('main', 'vertical');

      mockOpenTab('main', { type: 'sequence', entityId: 'verify-stay', label: 'Stay' });
      const movingTabId = mockOpenTab('main', {
        type: 'sequence',
        entityId: 'verify-move',
        label: 'Move',
      });

      const { rerender } = render(
        <TabPortalProvider>
          <div data-testid="panel-1">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
          <div data-testid="panel-2">
            <TabPortalTarget tab={getActiveTab(panel2Id)} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-verify-move')).toBeInTheDocument();

      act(() => {
        mockMoveTab('main', panel2Id, movingTabId);
      });

      rerender(
        <TabPortalProvider>
          <div data-testid="panel-1">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
          <div data-testid="panel-2">
            <TabPortalTarget tab={getActiveTab(panel2Id)} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-verify-stay')).toBeInTheDocument();
      expect(screen.getByTestId('panel-content-verify-move')).toBeInTheDocument();
    });

    it('emits a host-attached event when a tab portal moves between panels', () => {
      const panel2Id = mockSplitPanel('main', 'vertical');
      mockOpenTab('main', { type: 'text', entityId: 'verify-stay', label: 'Stay' });
      const movingTabId = mockOpenTab('main', {
        type: 'sequence',
        entityId: 'verify-move',
        label: 'Move',
      });
      const attachedTabIds: Array<string | null> = [];
      const onAttached = (event: Event) => {
        attachedTabIds.push((event as CustomEvent<{ tabId: string | null }>).detail.tabId);
      };
      window.addEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, onAttached);

      const { rerender } = render(
        <TabPortalProvider>
          <div data-testid="panel-1">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
          <div data-testid="panel-2">
            <TabPortalTarget tab={getActiveTab(panel2Id)} />
          </div>
        </TabPortalProvider>
      );
      attachedTabIds.length = 0;

      act(() => {
        mockMoveTab('main', panel2Id, movingTabId);
      });

      rerender(
        <TabPortalProvider>
          <div data-testid="panel-1">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
          <div data-testid="panel-2">
            <TabPortalTarget tab={getActiveTab(panel2Id)} />
          </div>
        </TabPortalProvider>
      );

      expect(attachedTabIds).toContain(movingTabId);
      window.removeEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, onAttached);
    });
  });

  describe('tab lifecycle', () => {
    it('mounts new tab content when tab is opened', () => {
      const { rerender } = render(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.queryByTestId('panel-content-verify-new')).not.toBeInTheDocument();

      act(() => {
        mockOpenTab('main', { type: 'sequence', entityId: 'verify-new', label: 'New' });
      });

      rerender(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-verify-new')).toBeInTheDocument();
    });

    it('unmounts tab content when tab is closed', () => {
      const tabId = mockOpenTab('main', {
        type: 'sequence',
        entityId: 'verify-close',
        label: 'Close Me',
      });

      const { rerender } = render(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.getByTestId('panel-content-verify-close')).toBeInTheDocument();

      act(() => {
        mockCloseTab('main', tabId);
      });

      rerender(
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );

      expect(screen.queryByTestId('panel-content-verify-close')).not.toBeInTheDocument();
    });
  });

  describe('close fan-out ', () => {
    function openTextTabs(panelId: string, names: string[]): string[] {
      return names.map((n) => mockOpenTab(panelId, { type: 'text', entityId: n, label: n }));
    }

    function tree() {
      return (
        <TabPortalProvider>
          <div data-testid="panel-area">
            <TabPortalTarget tab={getActiveTab('main')} />
          </div>
        </TabPortalProvider>
      );
    }

    it('does not remount later tabs when a middle tab is closed', () => {
      const ids = openTextTabs('main', ['doc-a', 'doc-b', 'doc-c', 'doc-d', 'doc-e', 'doc-f']);
      const { rerender } = render(tree());

      expect(mountedEntities().sort()).toEqual([
        'doc-a',
        'doc-b',
        'doc-c',
        'doc-d',
        'doc-e',
        'doc-f',
      ]);
      panelContentMountSpy.mockClear();
      panelContentUnmountSpy.mockClear();

      act(() => {
        mockCloseTab('main', ids[2]);
      });
      rerender(tree());

      expect(unmountedEntities().sort()).toEqual(['doc-c']);
      expect(mountedEntities()).toEqual([]);
    });

    it('closing the LAST tab shifts nothing and remounts nothing (control)', () => {
      const ids = openTextTabs('main', ['doc-a', 'doc-b', 'doc-c']);
      const { rerender } = render(tree());
      panelContentMountSpy.mockClear();
      panelContentUnmountSpy.mockClear();

      act(() => {
        mockCloseTab('main', ids[2]);
      });
      rerender(tree());

      expect(unmountedEntities()).toEqual(['doc-c']);
      expect(mountedEntities()).toEqual([]);
    });

    it('closing the FIRST tab does not remount any of the tabs after it', () => {
      const ids = openTextTabs('main', ['doc-a', 'doc-b', 'doc-c', 'doc-d']);
      const { rerender } = render(tree());
      panelContentMountSpy.mockClear();
      panelContentUnmountSpy.mockClear();

      act(() => {
        mockCloseTab('main', ids[0]);
      });
      rerender(tree());

      expect(unmountedEntities()).toEqual(['doc-a']);
      expect(mountedEntities()).toEqual([]);
    });

    it('hands surviving tabs identical props, so a memoized PanelContent skips them', () => {
      const ids = openTextTabs('main', ['doc-a', 'doc-b', 'doc-c', 'doc-d', 'doc-e', 'doc-f']);
      const { rerender } = render(tree());
      panelContentRenderSpy.mockClear();

      act(() => {
        mockCloseTab('main', ids[2]);
      });
      rerender(tree());

      expect(panelContentRenderSpy.mock.calls.map((c) => c[0])).toEqual([]);
    });

    it('closing a tab in an earlier panel does not remount tabs in a later panel', () => {
      const mainIds = openTextTabs('main', ['main-a', 'main-b']);
      const otherPanelId = mockSplitPanel('main', 'vertical');
      openTextTabs(otherPanelId, ['other-a', 'other-b']);

      const { rerender } = render(tree());
      panelContentMountSpy.mockClear();
      panelContentUnmountSpy.mockClear();

      act(() => {
        mockCloseTab('main', mainIds[0]);
      });
      rerender(tree());

      expect(unmountedEntities()).toEqual(['main-a']);
      expect(mountedEntities()).toEqual([]);
    });
  });
});

describe('TabPortalTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('displays placeholder when no active tab', () => {
    render(
      <TabPortalProvider>
        <TabPortalTarget tab={null} />
      </TabPortalProvider>
    );

    const target = screen.getByTestId('tab-portal-target');
    expect(target).toBeInTheDocument();
    expect(target).toBeEmptyDOMElement();
  });

  it('projects active tab content into the portal target', () => {
    const tabId = mockOpenTab('main', {
      type: 'sequence',
      entityId: 'verify-portal',
      label: 'Portal Test',
    });
    const activeTab = mockPanels['main'].tabs.find((t) => t.id === tabId)!;

    render(
      <TabPortalProvider>
        <div data-testid="panel-area">
          <TabPortalTarget tab={activeTab} />
        </div>
      </TabPortalProvider>
    );

    const panelArea = screen.getByTestId('panel-area');
    const content = screen.getByTestId('panel-content-verify-portal');

    expect(panelArea).toContainElement(content);
  });

  it('switches displayed content when active tab changes', () => {
    mockOpenTab('main', { type: 'sequence', entityId: 'verify-1', label: 'Tab 1' });
    mockOpenTab('main', { type: 'sequence', entityId: 'verify-2', label: 'Tab 2' });

    const { rerender } = render(
      <TabPortalProvider>
        <div data-testid="panel-area">
          <TabPortalTarget tab={getActiveTab('main')} />
        </div>
      </TabPortalProvider>
    );

    let panelArea = screen.getByTestId('panel-area');
    expect(panelArea).toContainElement(screen.getByTestId('panel-content-verify-2'));

    act(() => {
      const tab1Id = mockPanels['main'].tabs[0].id;
      mockSetActiveTab('main', tab1Id);
    });

    rerender(
      <TabPortalProvider>
        <div data-testid="panel-area">
          <TabPortalTarget tab={getActiveTab('main')} />
        </div>
      </TabPortalProvider>
    );

    panelArea = screen.getByTestId('panel-area');
    expect(panelArea).toContainElement(screen.getByTestId('panel-content-verify-1'));
  });

  it('notifies mounted tab content before its portal host is detached by a layout change', () => {
    mockOpenTab('main', { type: 'chat', entityId: 'historical-chat', label: 'Chat' });
    const activeTab = getActiveTab('main');
    const { rerender } = render(
      <TabPortalProvider>
        <TabPortalTarget key="single-pane" tab={activeTab} />
      </TabPortalProvider>
    );
    const content = screen.getByTestId('panel-content-historical-chat');
    const host = content.parentElement!;
    const detached = vi.fn(() => {
      expect(host.isConnected).toBe(true);
      expect(host.parentElement).toHaveAttribute('data-testid', 'tab-portal-target');
    });
    host.addEventListener('waypoint:tab-portal-host-detaching', detached);

    rerender(
      <TabPortalProvider>
        <TabPortalTarget key="split-pane" tab={activeTab} />
      </TabPortalProvider>
    );

    expect(detached).toHaveBeenCalledOnce();
    expect(screen.getByTestId('panel-content-historical-chat')).toBe(content);
    expect(host.isConnected).toBe(true);
    expect(unmountCountFor('historical-chat')).toBe(0);
  });
});

describe('render-path logging ', () => {
  it('writes nothing to the console when the provider re-renders', () => {
    mockOpenTab('main', { type: 'sequence', entityId: 'log-probe', label: 'Log Probe' });

    const buildTree = () => (
      <TabPortalProvider>
        <div data-testid="panel-area">
          <TabPortalTarget tab={getActiveTab('main')} />
        </div>
      </TabPortalProvider>
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { rerender } = render(buildTree());

      logSpy.mockClear();

      rerender(buildTree());
      rerender(buildTree());

      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
