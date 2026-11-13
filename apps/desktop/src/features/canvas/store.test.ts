import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { migratePersistedCanvasState, partializeCanvasState, useCanvasStore } from './store';
import type { LayoutNode, Tab, TabType, RecentlyClosedTab } from './types';
import type { Structure3dAttrs } from '../page/embeds/structure3d/types';
import type {
  IndexedGenomeDataTrackState,
  IndexedGenomeUcscTrackState,
} from '../../shared/indexed-genome';
import {
  consumeSequenceTabCloseGesture,
  registerSequenceTabCloseAbortController,
  SEQUENCE_TAB_CLOSE_COMMITTED_EVENT,
  type SequenceTabCloseCommittedDetail,
} from '../../shared/tab-close-gesture';

let uuidCounter = 0;
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
  uuidCounter++;
  return `panel-${uuidCounter.toString().padStart(4, '0')}-0000-0000-0000-000000000000`;
});

function resetStore() {
  uuidCounter = 0;
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        tabs: [],
        activeTabId: null,
      },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    recentlyClosed: [],
  });
}

function logicalSequenceId(seed: string): string {
  if (seed.startsWith('sequence-document')) return seed;
  return `sequence-document:${seed.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function createTab(overrides: Partial<Omit<Tab, 'id'>> = {}): Omit<Tab, 'id'> {
  const type = overrides.type || 'sequence';
  const seed = overrides.entityId || `sequence-${Date.now()}`;
  if (type === 'sequence') {
    const entityId = logicalSequenceId(seed);
    return {
      ...overrides,
      type,
      entityId,
      label: overrides.label || 'Test Tab',
      sequenceDocument: { kind: 'catalog-sequence', entityId } as const,
    };
  }
  return { ...overrides, type, entityId: seed, label: overrides.label || 'Test Tab' };
}

const INITIAL_STRUCTURE_ATTRS: Structure3dAttrs = {
  source: 'pdb',
  sourceId: '1RBL',
  label: 'Rubisco',
  representation: 'cartoon',
  colorMode: 'chain',
};

describe('sequence presentation at the canvas boundary', () => {
  beforeEach(resetStore);

  it('stores a display name before any header, tooltip or context menu can read the tab', () => {
    const tabId = useCanvasStore.getState().openTab(
      'main',
      createTab({
        label: 'pBR322 Follow-up.gb',
        sourceFileName: 'physical-import.gb',
      })
    );
    const tab = useCanvasStore.getState().panels.main.tabs.find((item) => item.id === tabId)!;
    expect(tab.label).toBe('pBR322 Follow-up');
  });

  it('normalizes both update routes, including every pane containing the document', () => {
    const store = useCanvasStore.getState();
    const first = store.openTab('main', createTab({ entityId: 'shared', label: 'Original.gb' }));
    const other = store.splitPanel('main', 'horizontal');
    store.openTab(other, createTab({ entityId: 'shared', label: 'Original.gb' }));
    store.updateTab('main', first, { label: 'Updated.genbank' });
    expect(useCanvasStore.getState().panels.main.tabs[0].label).toBe('Updated');
    store.updateTabByEntityId(logicalSequenceId('shared'), { label: 'Renamed.fasta.gz' });
    const names = Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
      panel.tabs.map((tab) => tab.label)
    );
    expect(names).toEqual(['Renamed', 'Renamed']);
  });

  it.each([1, 7])(
    'repairs persisted version %s filename labels before restoring the UI',
    (version) => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ label: 'Placeholder' }));
      const state = partializeCanvasState(useCanvasStore.getState());
      state.panels.main.tabs[0].label = 'Restored.GBK';
      const restored = migratePersistedCanvasState(state, version);
      expect(restored.panels.main.tabs[0].label).toBe('Restored');
    }
  );

  it('admits older recently closed labels when reopening a sequence', () => {
    const store = useCanvasStore.getState();
    const id = store.openTab('main', createTab({ label: 'Sequence' }));
    store.closeTab('main', id);
    useCanvasStore.getState().recentlyClosed[0].tab.label = 'Reopened.gb';
    store.reopenLastClosedTab();
    expect(useCanvasStore.getState().panels.main.tabs[0].label).toBe('Reopened');
  });

  it('preserves meaningful dots and names of other document types', () => {
    const store = useCanvasStore.getState();
    store.openTab('main', createTab({ label: 'pUC19.v2' }));
    store.openTab('main', createTab({ type: 'text', label: 'notes.txt' }));
    expect(useCanvasStore.getState().panels.main.tabs.map((tab) => tab.label)).toEqual([
      'pUC19.v2',
      'notes.txt',
    ]);
  });

  it('admits the existing label when a tab becomes a sequence without a new label', () => {
    const store = useCanvasStore.getState();
    const entityId = logicalSequenceId('promoted');
    const id = store.openTab('main', createTab({ type: 'text', entityId, label: 'Promoted.gb' }));
    store.updateTab('main', id, {
      type: 'sequence',
      sequenceDocument: { kind: 'catalog-sequence', entityId },
    });
    expect(useCanvasStore.getState().panels.main.tabs[0].label).toBe('Promoted');
  });
});

describe('useCanvasStore', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('applyOversizeScan ', () => {
    it('does not apply an old locator scan to a retargeted tab with the same id', () => {
      const store = useCanvasStore.getState();
      const id = store.openTab(
        'main',
        createTab({ type: 'file', entityId: '/synthetic/old.txt', loadStatus: 'pending' })
      );
      const scanned = {
        ...useCanvasStore.getState().panels.main.tabs[0],
        loadStatus: 'missing' as const,
      };
      store.updateTab('main', id, {
        entityId: '/synthetic/current.txt',
        loadStatus: 'loaded',
        fileSizeBytes: 42,
      });
      const current = useCanvasStore.getState().panels.main.tabs[0];
      store.openTab('main', createTab({ type: 'text', entityId: '/synthetic/newly-opened.txt' }));
      store.applyOversizeScan({ main: [scanned] });
      expect(useCanvasStore.getState().panels.main.tabs[0]).toBe(current);
      expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
        entityId: '/synthetic/current.txt',
        loadStatus: 'loaded',
        fileSizeBytes: 42,
      });
      expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(2);
    });

    it('preserves a new managed-package locator while an older same-document scan completes', () => {
      const store = useCanvasStore.getState();
      const id = store.openTab('main', {
        type: 'sequence',
        entityId: 'sequence-document:package',
        label: 'Synthetic',
        loadStatus: 'pending',
        sequenceDocument: {
          kind: 'managed-sequence',
          packageId: 'sequence-document:package',
          packageRoot: '/synthetic/old-package',
        },
      });
      const scanned = {
        ...useCanvasStore.getState().panels.main.tabs[0],
        loadStatus: 'missing' as const,
      };
      store.updateTab('main', id, {
        sequenceDocument: {
          kind: 'managed-sequence',
          packageId: 'sequence-document:package',
          packageRoot: '/synthetic/current-package',
        },
      });
      const current = useCanvasStore.getState().panels.main.tabs[0];
      store.applyOversizeScan({ main: [scanned] });
      expect(useCanvasStore.getState().panels.main.tabs[0]).toBe(current);
      expect(current.loadStatus).toBe('pending');
    });

    it('replaces tabs in named panels and flips oversizeScanComplete', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ entityId: '/tmp/a.gb', label: 'a' }));
      store.openTab('main', createTab({ entityId: '/tmp/b.gb', label: 'b' }));

      const before = useCanvasStore.getState().panels.main.tabs;
      useCanvasStore.setState({ oversizeScanComplete: false });
      expect(useCanvasStore.getState().oversizeScanComplete).toBe(false);

      useCanvasStore.getState().applyOversizeScan({
        main: [
          { ...before[0], loadStatus: 'loaded', fileSizeBytes: 100 },
          { ...before[1], loadStatus: 'deferred-oversized', fileSizeBytes: 300_000_000 },
        ],
      });

      const after = useCanvasStore.getState();
      expect(after.oversizeScanComplete).toBe(true);
      expect(after.panels.main.tabs[0].loadStatus).toBe('loaded');
      expect(after.panels.main.tabs[1].loadStatus).toBe('deferred-oversized');
      expect(after.panels.main.tabs[1].fileSizeBytes).toBe(300_000_000);
    });

    it('ignores panel ids that no longer exist (stale scan results)', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ entityId: '/tmp/a.gb' }));
      const before = useCanvasStore.getState().panels.main.tabs;

      useCanvasStore.setState({ oversizeScanComplete: false });
      useCanvasStore.getState().applyOversizeScan({
        nonexistent: [{ ...before[0], id: 'phantom', loadStatus: 'loaded' }],
      });

      const after = useCanvasStore.getState();
      expect(after.panels.main.tabs).toEqual(before);
      expect(after.oversizeScanComplete).toBe(true);
      expect(after.panels.nonexistent).toBeUndefined();
    });
  });

  describe('collectPanelIds behavior', () => {
    describe('via joinAllPanels', () => {
      it('collects panels in layout order (left-to-right)', () => {
        const store = useCanvasStore.getState();

        const panel2Id = store.splitPanel('main', 'vertical');
        store.openTab('main', createTab({ label: 'Tab 1' }));
        store.openTab(panel2Id, createTab({ label: 'Tab 2' }));

        store.joinAllPanels();

        const state = useCanvasStore.getState();
        expect(Object.keys(state.panels)).toHaveLength(1);
        expect(state.panels['main'].tabs).toHaveLength(2);
        expect(state.panels['main'].tabs[0].label).toBe('Tab 1');
        expect(state.panels['main'].tabs[1].label).toBe('Tab 2');
      });

      it('handles deeply nested layouts', () => {
        const store = useCanvasStore.getState();

        const panel2Id = store.splitPanel('main', 'vertical');
        const panel3Id = store.splitPanel(panel2Id, 'horizontal');

        store.openTab('main', createTab({ label: 'Tab 1' }));
        store.openTab(panel2Id, createTab({ label: 'Tab 2' }));
        store.openTab(panel3Id, createTab({ label: 'Tab 3' }));

        store.joinAllPanels();

        const state = useCanvasStore.getState();
        expect(state.panels['main'].tabs).toHaveLength(3);
      });
    });

    describe('via openWithSmartPlacement', () => {
      it('places chat in leftmost panel', () => {
        const store = useCanvasStore.getState();

        const panel2Id = store.splitPanel('main', 'vertical');

        store.openWithSmartPlacement('chat', 'conv-1', 'Chat');

        const state = useCanvasStore.getState();
        expect(state.panels['main'].tabs).toHaveLength(1);
        expect(state.panels[panel2Id].tabs).toHaveLength(0);
      });

      it('places sequences in rightmost panel', () => {
        const store = useCanvasStore.getState();

        const panel2Id = store.splitPanel('main', 'vertical');

        const documentId = logicalSequenceId('/path/seq.gb');
        store.openWithSmartPlacement('sequence', documentId, 'My Sequence', undefined, {
          sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
        });

        const state = useCanvasStore.getState();
        expect(state.panels['main'].tabs).toHaveLength(0);
        expect(state.panels[panel2Id].tabs).toHaveLength(1);
      });

      it('places files in rightmost panel', () => {
        const store = useCanvasStore.getState();

        const panel2Id = store.splitPanel('main', 'vertical');

        store.openWithSmartPlacement('file', '/path/data.txt', 'Data File');

        const state = useCanvasStore.getState();
        expect(state.panels['main'].tabs).toHaveLength(0);
        expect(state.panels[panel2Id].tabs).toHaveLength(1);
      });
    });

    describe('cycle detection', () => {
      it.skip('handles corrupted circular layout gracefully without crashing', () => {});
    });

    describe('depth limit', () => {
      it('handles excessively deep layouts gracefully without crashing', () => {
        let node: LayoutNode = { type: 'panel', panelId: 'main' };
        for (let i = 0; i < 105; i++) {
          node = {
            type: 'split',
            direction: 'vertical',
            children: [node, { type: 'panel', panelId: `deep-${i}` }],
            sizes: [50, 50],
          };
        }

        useCanvasStore.setState({
          panels: { main: { id: 'main', tabs: [], activeTabId: null } },
          layout: node,
          focusedPanelId: 'main',
        });

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const store = useCanvasStore.getState();
        expect(() => store.joinAllPanels()).not.toThrow();

        expect(store.reset).toBeDefined();

        consoleSpy.mockRestore();
      });
    });
  });

  describe('agentContentPlacement', () => {
    it('uses the focused content panel when no chat is open', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ type: 'page', entityId: 'human-notes' }));

      expect(store.agentContentPlacement()).toEqual({
        targetPanelId: 'main',
        workingPanelId: 'main',
      });
      expect(Object.keys(useCanvasStore.getState().panels)).toEqual(['main']);
    });

    it('uses the exact initiating chat panel when multiple conversations are open', () => {
      const store = useCanvasStore.getState();
      const secondPanelId = store.splitPanel('main', 'vertical');
      store.openTab('main', createTab({ type: 'chat', entityId: 'conversation-1' }));
      store.openTab(secondPanelId, createTab({ type: 'chat', entityId: 'conversation-2' }));

      const placement = store.agentContentPlacement(secondPanelId);

      expect(placement).toEqual({
        workingPanelId: secondPanelId,
        targetPanelId: 'main',
        createdPanelId: undefined,
      });
    });

    it('splits beside an explicit sole chat panel', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ type: 'chat', entityId: 'conversation-1' }));

      const placement = store.agentContentPlacement('main');

      expect(placement.workingPanelId).toBe('main');
      expect(placement.targetPanelId).not.toBe('main');
      expect(placement.createdPanelId).toBe(placement.targetPanelId);
      expect(Object.keys(useCanvasStore.getState().panels)).toHaveLength(2);
    });
  });

  describe('openInOppositePanel', () => {
    it('returns rollback metadata for an asynchronously acknowledged handoff', () => {
      const result = useCanvasStore
        .getState()
        .openInOppositePanelDetailed('main', 'structure', 'view:1', 'Structure', {
          source: 'pdb',
          sourceId: 'RCSB:1ABC:ENTRY',
        });

      expect(result).toMatchObject({
        createdTab: true,
        createdPanelId: expect.any(String),
        targetPanelId: expect.any(String),
        tabId: expect.any(String),
      });
      expect(result?.targetPanelId).not.toBe('main');
      expect(result?.createdPanelId).toBe(result?.targetPanelId);
    });

    it('returns null for stale panel ID', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const store = useCanvasStore.getState();

      const result = store.openInOppositePanel(
        'non-existent-panel',
        'sequence',
        '/path/seq.gb',
        'Test'
      );

      expect(result).toBeNull();

      consoleSpy.mockRestore();
    });

    it('splits single panel and opens in new panel', () => {
      const store = useCanvasStore.getState();

      expect(Object.keys(useCanvasStore.getState().panels)).toHaveLength(1);

      const tabId = store.openInOppositePanel('main', 'file', '/path/file.txt', 'File Tab');

      expect(tabId).not.toBeNull();

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(2);

      expect(state.panels['main'].tabs).toHaveLength(0);
      expect(state.focusedPanelId).not.toBe('main');
    });

    it('opens in existing opposite panel when split exists', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');

      const tabId = store.openInOppositePanel('main', 'file', '/path/file.txt', 'File Tab');

      expect(tabId).not.toBeNull();

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(0);
      expect(state.panels[panel2Id].tabs).toHaveLength(1);
      expect(state.focusedPanelId).toBe(panel2Id);
    });

    it('stores initial structure attrs on a structure tab opened in the opposite panel', () => {
      const store = useCanvasStore.getState();
      const panel2Id = store.splitPanel('main', 'vertical');

      const tabId = store.openInOppositePanel(
        'main',
        'structure',
        'structure:rcsb:1RBL:all',
        'Rubisco',
        INITIAL_STRUCTURE_ATTRS
      );

      const state = useCanvasStore.getState();
      const tab = state.panels[panel2Id].tabs.find((candidate) => candidate.id === tabId);
      expect(tab?.initialStructureAttrs).toEqual(INITIAL_STRUCTURE_ATTRS);
    });

    it('opens in opposite of second panel correctly', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');

      const tabId = store.openInOppositePanel(panel2Id, 'file', '/path/file.txt', 'File Tab');

      expect(tabId).not.toBeNull();

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(1);
      expect(state.panels[panel2Id].tabs).toHaveLength(0);
    });
  });

  describe('splitPanel', () => {
    it('creates a new panel with horizontal split', () => {
      const store = useCanvasStore.getState();

      const newPanelId = store.splitPanel('main', 'horizontal');

      expect(newPanelId).toBeTruthy();

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(2);
      expect(state.panels[newPanelId]).toBeDefined();
      expect(state.panels[newPanelId].tabs).toEqual([]);
      expect(state.panels[newPanelId].activeTabId).toBeNull();
    });

    it('creates a new panel with vertical split', () => {
      const store = useCanvasStore.getState();

      store.splitPanel('main', 'vertical');

      const state = useCanvasStore.getState();
      expect(state.layout.type).toBe('split');
      if (state.layout.type === 'split') {
        expect(state.layout.direction).toBe('vertical');
        expect(state.layout.sizes).toEqual([50, 50]);
      }
    });

    it('focuses the new panel after split', () => {
      const store = useCanvasStore.getState();

      const newPanelId = store.splitPanel('main', 'horizontal');

      const state = useCanvasStore.getState();
      expect(state.focusedPanelId).toBe(newPanelId);
    });

    it('creates correct layout tree structure', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');

      const state = useCanvasStore.getState();
      expect(state.layout).toEqual({
        type: 'split',
        direction: 'vertical',
        children: [
          { type: 'panel', panelId: 'main' },
          { type: 'panel', panelId: panel2Id },
        ],
        sizes: [50, 50],
      });
    });

    it('handles nested splits correctly', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      store.splitPanel(panel2Id, 'horizontal');

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(3);

      expect(state.layout.type).toBe('split');
      if (state.layout.type === 'split') {
        expect(state.layout.children[0]).toEqual({ type: 'panel', panelId: 'main' });
        expect(state.layout.children[1].type).toBe('split');
      }
    });
  });

  describe('closePanel', () => {
    it('cannot close the last panel', () => {
      const store = useCanvasStore.getState();

      store.closePanel('main');

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
      expect(state.panels['main']).toBeDefined();
    });

    it('closes panel and updates layout', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      expect(Object.keys(useCanvasStore.getState().panels)).toHaveLength(2);

      store.closePanel(panel2Id);

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
      expect(state.panels[panel2Id]).toBeUndefined();
      expect(state.layout).toEqual({ type: 'panel', panelId: 'main' });
    });

    it('updates focused panel when closing focused panel', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      expect(useCanvasStore.getState().focusedPanelId).toBe(panel2Id);

      store.closePanel(panel2Id);

      const state = useCanvasStore.getState();
      expect(state.focusedPanelId).toBe('main');
    });

    it('preserves focused panel when closing different panel', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      store.focusPanel('main');

      store.closePanel(panel2Id);

      const state = useCanvasStore.getState();
      expect(state.focusedPanelId).toBe('main');
    });

    it('redistributes sizes when closing middle panel', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      const panel3Id = store.splitPanel(panel2Id, 'vertical');

      store.closePanel(panel2Id);

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(2);
      expect(state.panels['main']).toBeDefined();
      expect(state.panels[panel3Id]).toBeDefined();
    });

    it('aborts active Git reads only for sequence tabs discarded with the panel', () => {
      const store = useCanvasStore.getState();
      const preservedTabId = store.openTab('main', createTab({ entityId: '/preserved.gb' }));
      const panel2Id = store.splitPanel('main', 'vertical');
      const removedTabId = store.openTab(panel2Id, createTab({ entityId: '/removed.gb' }));
      const preservedController = new AbortController();
      const removedController = new AbortController();
      const releasePreserved = registerSequenceTabCloseAbortController(
        preservedTabId,
        preservedController
      );
      const releaseRemoved = registerSequenceTabCloseAbortController(
        removedTabId,
        removedController
      );

      store.closePanel(panel2Id);

      const closeReason = consumeSequenceTabCloseGesture(removedTabId);
      expect(removedController.signal.reason).toEqual(closeReason);
      expect(preservedController.signal.aborted).toBe(false);
      releasePreserved();
      releaseRemoved();
    });
  });

  describe('openTab', () => {
    it('creates a new tab and activates it', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab('main', createTab({ label: 'Test' }));

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(1);
      expect(state.panels['main'].tabs[0].id).toBe(tabId);
      expect(state.panels['main'].activeTabId).toBe(tabId);
    });

    it('reuses existing tab with same type and entityId', () => {
      const store = useCanvasStore.getState();

      const tab1Id = store.openTab(
        'main',
        createTab({ type: 'sequence', entityId: '/path/seq.gb' })
      );
      const tab2Id = store.openTab(
        'main',
        createTab({ type: 'sequence', entityId: '/path/seq.gb' })
      );

      expect(tab1Id).toBe(tab2Id);

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(1);
    });

    it('refreshes initial structure attrs when reusing an existing structure tab', () => {
      const store = useCanvasStore.getState();
      const firstId = store.openTab('main', {
        type: 'structure',
        entityId: 'structure:rcsb:1RBL:all',
        label: 'Rubisco',
        initialStructureAttrs: INITIAL_STRUCTURE_ATTRS,
      });
      const updatedAttrs: Structure3dAttrs = {
        ...INITIAL_STRUCTURE_ATTRS,
        title: 'Updated Rubisco',
      };

      const secondId = store.openTab('main', {
        type: 'structure',
        entityId: 'structure:rcsb:1RBL:all',
        label: 'Rubisco',
        initialStructureAttrs: updatedAttrs,
      });

      expect(secondId).toBe(firstId);
      expect(useCanvasStore.getState().panels.main.tabs[0].initialStructureAttrs).toEqual(
        updatedAttrs
      );
    });

    it('creates separate tabs for different entityIds', () => {
      const store = useCanvasStore.getState();

      store.openTab('main', createTab({ type: 'sequence', entityId: '/path/seq1.gb' }));
      store.openTab('main', createTab({ type: 'sequence', entityId: '/path/seq2.gb' }));

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(2);
    });

    it('returns empty string for non-existent panel', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab('non-existent', createTab());

      expect(tabId).toBe('');
    });
  });

  describe('closeTab', () => {
    it('removes the tab from panel', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab('main', createTab());
      store.closeTab('main', tabId);

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(0);
    });

    it('publishes one exact sequence close token only when the store removes the tab', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', createTab());
      const committed = vi.fn<(event: Event) => void>();
      window.addEventListener(SEQUENCE_TAB_CLOSE_COMMITTED_EVENT, committed);

      store.closeTab('main', tabId);

      const reason = consumeSequenceTabCloseGesture(tabId);
      expect(reason).toEqual(expect.objectContaining({ kind: 'tab-close' }));
      expect(committed).toHaveBeenCalledOnce();
      const event = committed.mock.calls[0]?.[0] as CustomEvent<SequenceTabCloseCommittedDetail>;
      expect(event.detail).toEqual({
        tabId,
        closeGestureToken: reason?.closeGestureToken,
        activeAbortControllerCount: 0,
      });
      expect(consumeSequenceTabCloseGesture(tabId)).toBeUndefined();

      window.removeEventListener(SEQUENCE_TAB_CLOSE_COMMITTED_EVENT, committed);
    });

    it('activates adjacent tab when closing active tab', () => {
      const store = useCanvasStore.getState();

      store.openTab('main', createTab({ entityId: '/path/1.gb' }));
      const tab2Id = store.openTab('main', createTab({ entityId: '/path/2.gb' }));
      const tab3Id = store.openTab('main', createTab({ entityId: '/path/3.gb' }));

      store.closeTab('main', tab3Id);

      const state = useCanvasStore.getState();
      expect(state.panels['main'].activeTabId).toBe(tab2Id);
    });

    it('closes empty panel automatically (VS Code behavior)', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      const tabId = store.openTab(panel2Id, createTab());

      expect(Object.keys(useCanvasStore.getState().panels)).toHaveLength(2);

      store.closeTab(panel2Id, tabId);

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
      expect(state.panels[panel2Id]).toBeUndefined();
    });

    it('keeps last panel even when empty', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab('main', createTab());
      store.closeTab('main', tabId);

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
      expect(state.panels['main'].tabs).toHaveLength(0);
    });

    it('does not place a discarded artifact draft in reopen history', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab(
        'main',
        createTab({
          type: 'primer',
          entityId: 'primer-draft:1',
          artifactDocument: {
            kind: 'primer',
            persistence: 'draft',
            workspaceRoot: '/workspace',
            destinationPath: '/workspace/oligos',
          },
        })
      );

      store.closeTab('main', tabId);

      expect(useCanvasStore.getState().recentlyClosed).toEqual([]);
    });
  });

  describe('artifact draft persistence', () => {
    it('retains saved molecular working settings without duplicating coordinate bytes', () => {
      const attrs: Structure3dAttrs = {
        source: 'file',
        sourceId: 'original molecular coordinates',
        coordinateSha256: 'a'.repeat(64),
        cameraSnapshot: 'working camera',
        molViewSpec: 'working scene',
      };
      useCanvasStore.getState().openTab(
        'main',
        createTab({
          type: 'structure',
          entityId: 'saved-view:one',
          molecularViewReferenceId: 'canonical-reference',
          initialStructureAttrs: attrs,
        })
      );
      const tab = partializeCanvasState(useCanvasStore.getState()).panels.main.tabs[0];
      expect(tab.molecularViewReferenceId).toBe('canonical-reference');
      expect(tab.initialStructureAttrs).toEqual({
        source: 'file',
        coordinateSha256: attrs.coordinateSha256,
        cameraSnapshot: 'working camera',
        molViewSpec: 'working scene',
      });
      expect(useCanvasStore.getState().panels.main.tabs[0].initialStructureAttrs).toBe(attrs);
    });

    it('excludes every ephemeral artifact draft from persisted canvas state', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ type: 'text', entityId: '/workspace/kept.txt' }));
      store.openTab(
        'main',
        createTab({
          type: 'design',
          entityId: 'assembly-draft:1',
          artifactDocument: {
            kind: 'assembly',
            persistence: 'draft',
            workspaceRoot: '/workspace',
            destinationPath: '/workspace/assemblies',
          },
        })
      );

      const persisted = partializeCanvasState(useCanvasStore.getState());

      expect(persisted.panels.main.tabs.map((tab) => tab.entityId)).toEqual([
        '/workspace/kept.txt',
      ]);
    });

    it('drops legacy unsaved primer/protein tabs and upgrades a saved primer editor', () => {
      const migrated = migratePersistedCanvasState(
        {
          panels: {
            main: {
              id: 'main',
              activeTabId: 'primer-unsaved',
              tabs: [
                {
                  id: 'primer-unsaved',
                  type: 'primer',
                  entityId: 'primer-draft:1',
                  label: 'Untitled Primer',
                  primerDraft: {
                    workspaceRoot: '/workspace',
                    destinationPath: '/workspace/oligos',
                  },
                },
                {
                  id: 'protein-unsaved',
                  type: 'protein',
                  entityId: 'protein-draft:1',
                  label: 'Untitled Protein',
                  proteinDraft: {
                    workspaceRoot: '/workspace',
                    destinationPath: '/workspace/proteins',
                  },
                },
                {
                  id: 'primer-saved',
                  type: 'primer',
                  entityId: '/workspace/oligos/P1.primer.json',
                  label: 'P1',
                  primerDraft: {
                    workspaceRoot: '/workspace',
                    destinationPath: '/workspace/oligos',
                    artifactPath: '/workspace/oligos/P1.primer.json',
                  },
                },
              ],
            },
          },
          layout: { type: 'panel', panelId: 'main' },
          focusedPanelId: 'main',
        },
        5
      );

      expect(migrated.panels.main.tabs).toHaveLength(1);
      expect(migrated.panels.main.tabs[0]).toMatchObject({
        id: 'primer-saved',
        artifactDocument: { kind: 'primer', persistence: 'persisted' },
      });
      expect(migrated.panels.main.activeTabId).toBe('primer-saved');
    });
  });

  describe('reopenLastClosedTab ', () => {
    it('records a closed tab and restores it (same entity, same panel, active)', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', createTab({ entityId: '/a.gb', label: 'A' }));
      store.closeTab('main', tabId);

      expect(useCanvasStore.getState().recentlyClosed).toHaveLength(1);
      expect(useCanvasStore.getState().panels['main'].tabs).toHaveLength(0);

      store.reopenLastClosedTab();

      const panel = useCanvasStore.getState().panels['main'];
      expect(panel.tabs).toHaveLength(1);
      expect(panel.tabs[0].entityId).toBe(logicalSequenceId('/a.gb'));
      expect(panel.tabs[0].label).toBe('A');
      expect(panel.activeTabId).toBe(panel.tabs[0].id);
      expect(useCanvasStore.getState().recentlyClosed).toHaveLength(0);
    });

    it('invalidates cached file state when reopening a local table tab', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab(
        'main',
        createTab({ type: 'table', entityId: '/tmp/quoted-notes.csv', label: 'quoted-notes.csv' })
      );
      store.updateTab('main', tabId, { loadStatus: 'loaded', fileSizeBytes: 8_192 });
      store.closeTab('main', tabId);

      store.reopenLastClosedTab();

      const restored = useCanvasStore.getState().panels.main.tabs[0];
      expect(restored).toMatchObject({
        type: 'table',
        entityId: '/tmp/quoted-notes.csv',
        loadStatus: 'pending',
      });
      expect(restored.fileSizeBytes).toBeUndefined();
    });

    it('restores at the original index among surviving tabs', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ entityId: '/a.gb', label: 'A' }));
      const bId = store.openTab('main', createTab({ entityId: '/b.gb', label: 'B' }));
      store.openTab('main', createTab({ entityId: '/c.gb', label: 'C' }));

      store.closeTab('main', bId);
      store.reopenLastClosedTab();

      const labels = useCanvasStore.getState().panels['main'].tabs.map((t) => t.label);
      expect(labels).toEqual(['A', 'B', 'C']);
    });

    it('walks the LIFO stack on repeated calls', () => {
      const store = useCanvasStore.getState();
      const aId = store.openTab('main', createTab({ entityId: '/a.gb', label: 'A' }));
      const bId = store.openTab('main', createTab({ entityId: '/b.gb', label: 'B' }));

      store.closeTab('main', aId);
      store.closeTab('main', bId);

      store.reopenLastClosedTab();
      expect(useCanvasStore.getState().panels['main'].tabs.map((t) => t.entityId)).toEqual([
        logicalSequenceId('/b.gb'),
      ]);
      store.reopenLastClosedTab();
      expect(useCanvasStore.getState().panels['main'].tabs.map((t) => t.entityId)).toEqual([
        logicalSequenceId('/a.gb'),
        logicalSequenceId('/b.gb'),
      ]);
      expect(useCanvasStore.getState().recentlyClosed).toHaveLength(0);
    });

    it('preserves the closed tab view state on reopen', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', createTab({ entityId: '/a.gb' }));
      store.setTabViewState('main', tabId, { sequenceViewMode: '1d' });

      store.closeTab('main', tabId);
      store.reopenLastClosedTab();

      const restored = useCanvasStore.getState().panels['main'].tabs[0];
      expect(restored.viewState?.sequenceViewMode).toBe('1d');
    });

    it('restores into a panel that has a different active tab, stealing active focus', () => {
      const store = useCanvasStore.getState();
      const aId = store.openTab('main', createTab({ entityId: '/a.gb', label: 'A' }));
      const bId = store.openTab('main', createTab({ entityId: '/b.gb', label: 'B' }));
      store.closeTab('main', aId);
      expect(useCanvasStore.getState().panels['main'].activeTabId).toBe(bId);

      store.reopenLastClosedTab();

      const panel = useCanvasStore.getState().panels['main'];
      expect(panel.tabs.map((t) => t.entityId)).toEqual([
        logicalSequenceId('/a.gb'),
        logicalSequenceId('/b.gb'),
      ]);
      expect(panel.activeTabId).toBe(panel.tabs[0].id);
      expect(panel.tabs.some((t) => t.id === bId)).toBe(true);
    });

    it('is a no-op when the history is empty', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ entityId: '/a.gb' }));
      const before = useCanvasStore.getState().panels['main'].tabs.length;

      store.reopenLastClosedTab();

      expect(useCanvasStore.getState().panels['main'].tabs).toHaveLength(before);
    });

    it('activates the existing tab instead of duplicating when the entity is reopened', () => {
      const store = useCanvasStore.getState();
      const aId = store.openTab('main', createTab({ type: 'page', entityId: 'X', label: 'X' }));
      store.closeTab('main', aId);

      const a2Id = store.openTab('main', createTab({ type: 'page', entityId: 'X', label: 'X' }));

      store.reopenLastClosedTab();

      const tabs = useCanvasStore.getState().panels['main'].tabs;
      expect(tabs.filter((t) => t.entityId === 'X')).toHaveLength(1);
      expect(useCanvasStore.getState().panels['main'].activeTabId).toBe(a2Id);
      expect(useCanvasStore.getState().recentlyClosed).toHaveLength(0);
    });

    it('falls back to a surviving panel when the original panel was closed', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ entityId: '/main.gb', label: 'Main' }));
      const panel2Id = store.splitPanel('main', 'vertical');
      const bId = store.openTab(panel2Id, createTab({ entityId: '/b.gb', label: 'B' }));

      store.closeTab(panel2Id, bId);
      expect(useCanvasStore.getState().panels[panel2Id]).toBeUndefined();

      store.reopenLastClosedTab();

      const allTabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
      expect(allTabs.some((t) => t.entityId === logicalSequenceId('/b.gb'))).toBe(true);
    });

    it('caps the history at 20 entries (drops the oldest)', () => {
      const store = useCanvasStore.getState();
      for (let i = 0; i < 25; i++) {
        const id = store.openTab('main', createTab({ entityId: `/f${i}.gb`, label: `F${i}` }));
        store.closeTab('main', id);
      }
      const history = useCanvasStore.getState().recentlyClosed;
      expect(history).toHaveLength(20);
      expect(history[history.length - 1].tab.entityId).toBe(logicalSequenceId('/f24.gb'));
      expect(history.some((e) => e.tab.entityId === logicalSequenceId('/f0.gb'))).toBe(false);
    });

    it('records tabs removed by bulk closes (closeAllTabs is recoverable)', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ entityId: '/a.gb', label: 'A' }));
      store.openTab('main', createTab({ entityId: '/b.gb', label: 'B' }));
      store.openTab('main', createTab({ entityId: '/c.gb', label: 'C' }));

      store.closeAllTabs('main');
      expect(useCanvasStore.getState().panels['main'].tabs).toHaveLength(0);
      expect(useCanvasStore.getState().recentlyClosed).toHaveLength(3);

      store.reopenLastClosedTab();
      store.reopenLastClosedTab();
      store.reopenLastClosedTab();

      const entities = useCanvasStore
        .getState()
        .panels['main'].tabs.map((t) => t.entityId)
        .sort();
      expect(entities).toEqual(['/a.gb', '/b.gb', '/c.gb'].map(logicalSequenceId).sort());
    });

    it('records tabs removed by closeOtherTabs and closeTabsToRight', () => {
      const store = useCanvasStore.getState();
      const aId = store.openTab('main', createTab({ entityId: '/a.gb' }));
      store.openTab('main', createTab({ entityId: '/b.gb' }));
      store.openTab('main', createTab({ entityId: '/c.gb' }));

      store.closeOtherTabs('main', aId);
      expect(
        useCanvasStore
          .getState()
          .recentlyClosed.map((e) => e.tab.entityId)
          .sort()
      ).toEqual(['/b.gb', '/c.gb'].map(logicalSequenceId).sort());
    });
  });

  describe('closeActiveTab ', () => {
    it('closes the active tab in the focused panel', () => {
      const store = useCanvasStore.getState();
      store.openTab('main', createTab({ entityId: '/a.gb' }));
      const bId = store.openTab('main', createTab({ entityId: '/b.gb' }));
      store.closeActiveTab();
      const panel = useCanvasStore.getState().panels['main'];
      expect(panel.tabs.map((t) => t.id)).not.toContain(bId);
      expect(panel.tabs).toHaveLength(1);
    });

    it('is a no-op when no tab is active (never throws, never quits)', () => {
      const store = useCanvasStore.getState();
      expect(() => store.closeActiveTab()).not.toThrow();
      expect(useCanvasStore.getState().panels['main'].tabs).toHaveLength(0);
    });
  });

  describe('recentlyClosed ephemeral-field safety ', () => {
    const persistedBlob = {
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    };

    it.each([0, 1, 2, 3])(
      'migration from version %i yields a state with recentlyClosed: []',
      (version) => {
        const migrated = migratePersistedCanvasState(persistedBlob, version);
        expect(migrated.recentlyClosed).toEqual([]);
      }
    );

    it('close + reopen never throw on a state built without recentlyClosed', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', createTab({ entityId: '/x.gb' }));
      useCanvasStore.setState({ recentlyClosed: undefined as unknown as RecentlyClosedTab[] });

      expect(() => useCanvasStore.getState().closeTab('main', tabId)).not.toThrow();
      expect(useCanvasStore.getState().recentlyClosed).toHaveLength(1);
      expect(() => useCanvasStore.getState().reopenLastClosedTab()).not.toThrow();
      expect(useCanvasStore.getState().panels['main'].tabs.map((t) => t.entityId)).toContain(
        logicalSequenceId('/x.gb')
      );
    });
  });

  describe('moveTab', () => {
    it('moves tab between panels', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      store.openTab('main', createTab({ entityId: '/path/staying.gb' }));
      const tabId = store.openTab('main', createTab({ entityId: '/path/moving.gb' }));

      store.moveTab('main', panel2Id, tabId);

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(1);
      expect(state.panels[panel2Id].tabs).toHaveLength(1);
      expect(state.panels[panel2Id].tabs[0].id).toBe(tabId);
    });

    it('activates moved tab in target panel', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      const tabId = store.openTab('main', createTab());

      store.moveTab('main', panel2Id, tabId);

      const state = useCanvasStore.getState();
      expect(state.panels[panel2Id].activeTabId).toBe(tabId);
    });

    it('closes source panel if emptied (VS Code behavior)', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      const tabId = store.openTab(panel2Id, createTab());

      store.moveTab(panel2Id, 'main', tabId);

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
      expect(state.panels[panel2Id]).toBeUndefined();
    });

    it('does nothing when moving to same panel', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab('main', createTab());

      store.moveTab('main', 'main', tabId);

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(1);
    });
  });

  describe('bulk tab operations', () => {
    function expectBulkCloseAborts(
      tabId: string,
      close: () => void,
      preservedTabId?: string
    ): void {
      const controller = new AbortController();
      const release = registerSequenceTabCloseAbortController(tabId, controller);
      const preservedController = preservedTabId ? new AbortController() : null;
      const releasePreserved =
        preservedTabId && preservedController
          ? registerSequenceTabCloseAbortController(preservedTabId, preservedController)
          : null;

      close();

      const closeReason = consumeSequenceTabCloseGesture(tabId);
      expect(closeReason).toEqual(expect.objectContaining({ kind: 'tab-close' }));
      expect(controller.signal.reason).toEqual(closeReason);
      expect(preservedController?.signal.aborted ?? false).toBe(false);
      release();
      releasePreserved?.();
    }

    describe('closeOtherTabs', () => {
      it('keeps only the specified tab', () => {
        const store = useCanvasStore.getState();

        store.openTab('main', createTab({ entityId: '/path/1.gb' }));
        const keepTabId = store.openTab('main', createTab({ entityId: '/path/2.gb' }));
        store.openTab('main', createTab({ entityId: '/path/3.gb' }));

        store.closeOtherTabs('main', keepTabId);

        const state = useCanvasStore.getState();
        expect(state.panels['main'].tabs).toHaveLength(1);
        expect(state.panels['main'].tabs[0].id).toBe(keepTabId);
      });

      it('aborts an active Git read for each removed sequence tab', () => {
        const store = useCanvasStore.getState();
        const keepTabId = store.openTab('main', createTab({ entityId: '/path/keep.gb' }));
        const removedTabId = store.openTab('main', createTab({ entityId: '/path/remove.gb' }));

        expectBulkCloseAborts(
          removedTabId,
          () => store.closeOtherTabs('main', keepTabId),
          keepTabId
        );
      });
    });

    describe('closeTabsToRight', () => {
      it('closes all tabs to the right of specified tab', () => {
        const store = useCanvasStore.getState();

        const tab1Id = store.openTab('main', createTab({ entityId: '/path/1.gb' }));
        const tab2Id = store.openTab('main', createTab({ entityId: '/path/2.gb' }));
        store.openTab('main', createTab({ entityId: '/path/3.gb' }));

        store.closeTabsToRight('main', tab2Id);

        const state = useCanvasStore.getState();
        expect(state.panels['main'].tabs).toHaveLength(2);
        expect(state.panels['main'].tabs.map((t) => t.id)).toEqual([tab1Id, tab2Id]);
      });

      it('aborts an active Git read for each sequence tab removed to the right', () => {
        const store = useCanvasStore.getState();
        const keepTabId = store.openTab('main', createTab({ entityId: '/path/keep.gb' }));
        const removedTabId = store.openTab('main', createTab({ entityId: '/path/remove.gb' }));

        expectBulkCloseAborts(
          removedTabId,
          () => store.closeTabsToRight('main', keepTabId),
          keepTabId
        );
      });
    });

    describe('closeSavedTabs', () => {
      it('aborts an active Git read for each clean sequence tab it removes', () => {
        const store = useCanvasStore.getState();
        const keptTabId = store.openTab(
          'main',
          createTab({ entityId: '/path/dirty.gb', isDirty: true })
        );
        const removedTabId = store.openTab(
          'main',
          createTab({ entityId: '/path/saved.gb', isDirty: false })
        );

        expectBulkCloseAborts(removedTabId, () => store.closeSavedTabs('main'), keptTabId);
      });
    });

    describe('closeAllTabs', () => {
      it('closes panel if not the last one', () => {
        const store = useCanvasStore.getState();

        const panel2Id = store.splitPanel('main', 'vertical');
        store.openTab(panel2Id, createTab());

        store.closeAllTabs(panel2Id);

        const state = useCanvasStore.getState();
        expect(Object.keys(state.panels)).toHaveLength(1);
        expect(state.panels[panel2Id]).toBeUndefined();
      });

      it('clears tabs but keeps last panel', () => {
        const store = useCanvasStore.getState();

        store.openTab('main', createTab({ entityId: '/path/1.gb' }));
        store.openTab('main', createTab({ entityId: '/path/2.gb' }));

        store.closeAllTabs('main');

        const state = useCanvasStore.getState();
        expect(Object.keys(state.panels)).toHaveLength(1);
        expect(state.panels['main'].tabs).toHaveLength(0);
      });

      it('aborts an active Git read for each sequence tab it removes', () => {
        const store = useCanvasStore.getState();
        const removedTabId = store.openTab('main', createTab({ entityId: '/path/remove.gb' }));

        expectBulkCloseAborts(removedTabId, () => store.closeAllTabs('main'));
      });
    });
  });

  describe('edge cases', () => {
    it('preserves document descriptors through move/reorder/split/merge and deliberate reopen', () => {
      const store = useCanvasStore.getState();
      const first = store.openTab(
        'main',
        createTab({ type: 'file', entityId: '/synthetic/first.txt' })
      );
      const second = store.openTab(
        'main',
        createTab({ type: 'table', entityId: '/synthetic/second.csv' })
      );
      const sequence = store.openTab(
        'main',
        createTab({ entityId: 'sequence-document:synthetic' })
      );
      const sequenceDescriptor = useCanvasStore
        .getState()
        .panels.main.tabs.find((tab) => tab.id === sequence);
      const right = store.splitPanel('main', 'vertical');
      store.moveTabAtIndex('main', right, first, 0);
      store.setActiveTab('main', second);
      store.reorderTab('main', sequence, 0);
      expect(useCanvasStore.getState().panels.main.activeTabId).toBe(second);
      store.moveTab('main', right, sequence);
      expect(useCanvasStore.getState().panels[right].tabs.find((tab) => tab.id === sequence)).toBe(
        sequenceDescriptor
      );
      store.mergePanels(right, 'main');
      expect(Object.keys(useCanvasStore.getState().panels)).toEqual(['main']);
      expect(useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id)).toEqual([
        second,
        first,
        sequence,
      ]);
      expect(useCanvasStore.getState().panels.main.activeTabId).toBe(second);
      expect(useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === sequence)).toBe(
        sequenceDescriptor
      );
      store.closeTab('main', first);
      store.reopenLastClosedTab();
      const current = useCanvasStore.getState();
      const reopened = current.panels.main.tabs.find(
        (tab) => tab.entityId === '/synthetic/first.txt'
      );
      expect(reopened).toMatchObject({ type: 'file', loadStatus: 'pending' });
      expect(reopened?.id).not.toBe(first);
      expect(current.panels.main.activeTabId).toBe(reopened?.id);
      const durable = partializeCanvasState(current);
      expect(durable).not.toHaveProperty('recentlyClosed');
      const migrated = migratePersistedCanvasState(durable, 8);
      expect(migrated.panels.main.tabs.map((tab) => tab.entityId)).toEqual([
        '/synthetic/second.csv',
        '/synthetic/first.txt',
        'sequence-document:synthetic',
      ]);
      expect(migrated.panels.main.activeTabId).toBe(reopened?.id);
    });

    it('refuses an absent tab without publishing an impossible active tab or focus change', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab(
        'main',
        createTab({ type: 'text', entityId: '/synthetic/existing.txt' })
      );
      const other = store.splitPanel('main', 'vertical');
      const before = useCanvasStore.getState();
      store.setActiveTab('main', 'absent-tab');
      expect(useCanvasStore.getState()).toBe(before);
      expect(useCanvasStore.getState().panels.main.activeTabId).toBe(tabId);
      expect(useCanvasStore.getState().focusedPanelId).toBe(other);
    });

    it('keeps same-active selection inert while allowing deliberate focus of an existing tab', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab(
        'main',
        createTab({ type: 'text', entityId: '/synthetic/existing.txt' })
      );
      store.focusPanel('main');
      const before = useCanvasStore.getState();
      store.setActiveTab('main', tabId);
      expect(useCanvasStore.getState()).toBe(before);
      store.splitPanel('main', 'vertical');
      store.setActiveTab('main', tabId);
      expect(useCanvasStore.getState().focusedPanelId).toBe('main');
      expect(useCanvasStore.getState().panels.main.activeTabId).toBe(tabId);
    });

    it('handles operations on non-existent panels gracefully', () => {
      const store = useCanvasStore.getState();

      store.closeTab('non-existent', 'tab-id');
      store.setActiveTab('non-existent', 'tab-id');
      store.updateTab('non-existent', 'tab-id', { label: 'New' });
      store.closeOtherTabs('non-existent', 'tab-id');

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
    });

    it('preserves panels reference when updateTab is a no-op ', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', createTab({ entityId: '/p/x.gb', label: 'X' }));
      store.updateTab('main', tabId, { isDirty: true });
      const before = useCanvasStore.getState().panels;
      store.updateTab('main', tabId, { isDirty: true });
      const after = useCanvasStore.getState().panels;
      expect(after).toBe(before);
    });

    it('still rebuilds panels when at least one updateTab key changes ', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', createTab({ entityId: '/p/y.gb', label: 'Y' }));
      const before = useCanvasStore.getState().panels;
      store.updateTab('main', tabId, { isDirty: true, label: 'Y2' });
      const after = useCanvasStore.getState().panels;
      expect(after).not.toBe(before);
      const tab = after['main'].tabs.find((t) => t.id === tabId);
      expect(tab?.label).toBe('Y2');
      expect(tab?.isDirty).toBe(true);
    });

    it('keeps the unified data-track registry authoritative over stale UCSC updates', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', createTab({ entityId: '/p/reference.fa' }));
      const baseIndexedState = {
        sourcePath: '/p/reference.fa',
        sourceExt: 'fa',
        chrom: 'chr1',
      };
      const canonicalTracks: IndexedGenomeDataTrackState[] = [];
      const staleLegacyTracks: IndexedGenomeUcscTrackState[] = [];

      store.updateTab('main', tabId, {
        indexedGenome: { ...baseIndexedState, dataTracks: canonicalTracks },
      });
      store.updateTab('main', tabId, {
        indexedGenome: { ...baseIndexedState, ucscTracks: staleLegacyTracks },
      });

      const indexedGenome = useCanvasStore.getState().panels.main.tabs[0]?.indexedGenome;
      expect(indexedGenome?.dataTracks).toBe(canonicalTracks);
      expect(indexedGenome?.dataTracks).not.toBe(staleLegacyTracks);
      expect(indexedGenome?.ucscTracks).toBeUndefined();
    });

    it('handles reorderTab correctly', () => {
      const store = useCanvasStore.getState();

      const tab1Id = store.openTab('main', createTab({ entityId: '/path/1.gb', label: 'Tab 1' }));
      const tab2Id = store.openTab('main', createTab({ entityId: '/path/2.gb', label: 'Tab 2' }));
      const tab3Id = store.openTab('main', createTab({ entityId: '/path/3.gb', label: 'Tab 3' }));

      store.reorderTab('main', tab3Id, 0);

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs.map((t) => t.id)).toEqual([tab3Id, tab1Id, tab2Id]);
    });

    it('findTab returns correct location', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      const tabId = store.openTab(
        panel2Id,
        createTab({ type: 'sequence', entityId: '/path/seq.gb' })
      );

      const result = store.findTab('sequence', logicalSequenceId('/path/seq.gb'));

      expect(result).toEqual({ panelId: panel2Id, tabId });
    });

    it('findTab returns null for non-existent tab', () => {
      const store = useCanvasStore.getState();

      const result = store.findTab('sequence', '/non-existent/path.gb');

      expect(result).toBeNull();
    });

    it('closeTabByTypeAndEntity closes correct tab', () => {
      const store = useCanvasStore.getState();

      store.openTab('main', createTab({ type: 'file', entityId: '/path/file.txt' }));
      store.openTab('main', createTab({ type: 'sequence', entityId: '/path/seq.gb' }));

      store.closeTabByTypeAndEntity('sequence', logicalSequenceId('/path/seq.gb'));

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(1);
      expect(state.panels['main'].tabs[0].type).toBe('file');
    });

    it('promoteTabToSequence converts the same tab and does not open another', () => {
      const store = useCanvasStore.getState();
      const designTabId = store.openTab(
        'main',
        createTab({ type: 'design', entityId: 'design-1', label: 'Construct' })
      );
      store.openTab('main', createTab({ type: 'sequence', entityId: '/old.gb', label: 'Other' }));

      const promotedId = store.promoteTabToSequence({
        fromType: 'design',
        fromEntityId: 'design-1',
        sequenceEntityId: 'sequence-document-construct',
        sequenceDocument: {
          kind: 'catalog-sequence',
          entityId: 'sequence-document-construct',
        },
        label: 'Construct',
      });

      const tabs = useCanvasStore.getState().panels.main.tabs;
      expect(promotedId).toBe(designTabId);
      expect(tabs).toHaveLength(2);
      expect(tabs.find((tab) => tab.id === designTabId)).toMatchObject({
        type: 'sequence',
        entityId: 'sequence-document-construct',
        label: 'Construct',
      });
      expect(store.findTab('design', 'design-1')).toBeNull();
      expect(useCanvasStore.getState().panels.main.activeTabId).toBe(designTabId);
    });

    it('promoteTabToSequence closes a duplicate sequence tab for the same product', () => {
      const store = useCanvasStore.getState();
      const designTabId = store.openTab(
        'main',
        createTab({ type: 'design', entityId: 'design-1', label: 'Construct' })
      );
      store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: 'sequence-document-construct',
          label: 'Already open',
        })
      );

      expect(
        store.promoteTabToSequence({
          fromType: 'design',
          fromEntityId: 'design-1',
          sequenceEntityId: 'sequence-document-construct',
          sequenceDocument: {
            kind: 'catalog-sequence',
            entityId: 'sequence-document-construct',
          },
          label: 'Construct',
        })
      ).toBe(designTabId);

      const tabs = useCanvasStore.getState().panels.main.tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        id: designTabId,
        type: 'sequence',
        entityId: 'sequence-document-construct',
      });
    });

    it('promoteTabToSequence is a no-op when the source tab is not open', () => {
      const store = useCanvasStore.getState();
      expect(
        store.promoteTabToSequence({
          fromType: 'design',
          fromEntityId: 'missing',
          sequenceEntityId: 'sequence-document-construct',
          sequenceDocument: {
            kind: 'catalog-sequence',
            entityId: 'sequence-document-construct',
          },
          label: 'Construct',
        })
      ).toBeNull();
      expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
    });

    it('promoteTabToDesign is the inverse conversion on the same tab', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab(
        'main',
        createTab({ type: 'sequence', entityId: '/assemblies/construct.gb', label: 'Construct' })
      );

      expect(
        store.promoteTabToDesign({
          fromType: 'sequence',
          fromEntityId: logicalSequenceId('/assemblies/construct.gb'),
          designEntityId: 'draft-reopened',
          label: 'Construct',
        })
      ).toBe(tabId);

      expect(useCanvasStore.getState().panels.main.tabs).toEqual([
        expect.objectContaining({
          id: tabId,
          type: 'design',
          entityId: 'draft-reopened',
        }),
      ]);
      expect(store.findTab('sequence', logicalSequenceId('/assemblies/construct.gb'))).toBeNull();
    });
  });

  describe('splitAndMoveTab', () => {
    it('splits panel and moves tab in one operation', () => {
      const store = useCanvasStore.getState();

      store.openTab('main', createTab({ entityId: '/path/staying.gb', label: 'Staying Tab' }));
      const movingTabId = store.openTab(
        'main',
        createTab({ entityId: '/path/moving.gb', label: 'Moving Tab' })
      );

      expect(useCanvasStore.getState().panels['main'].tabs).toHaveLength(2);

      store.splitAndMoveTab('main', 'right', 'main', movingTabId);

      const state = useCanvasStore.getState();
      const panelKeys = Object.keys(state.panels);

      expect(panelKeys).toHaveLength(2);

      expect(state.panels['main'].tabs).toHaveLength(1);
      expect(state.panels['main'].tabs[0].label).toBe('Staying Tab');
    });

    it('prevents splitting when tab is only one in panel', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab('main', createTab());

      store.splitAndMoveTab('main', 'right', 'main', tabId);

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
    });
  });

  describe('mergePanels', () => {
    it('merges tabs from source to target panel', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      store.openTab('main', createTab({ label: 'Main Tab' }));
      store.openTab(panel2Id, createTab({ label: 'Panel2 Tab' }));

      store.mergePanels(panel2Id, 'main');

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
      expect(state.panels['main'].tabs).toHaveLength(2);
    });

    it('does nothing when merging panel into itself', () => {
      const store = useCanvasStore.getState();

      store.openTab('main', createTab());

      store.mergePanels('main', 'main');

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(1);
    });
  });

  describe('reset', () => {
    it('resets to default state', () => {
      const store = useCanvasStore.getState();

      store.splitPanel('main', 'vertical');
      store.openTab('main', createTab());

      store.reset();

      const state = useCanvasStore.getState();
      expect(Object.keys(state.panels)).toHaveLength(1);
      expect(state.panels['main'].tabs).toHaveLength(0);
      expect(state.layout).toEqual({ type: 'panel', panelId: 'main' });
      expect(state.focusedPanelId).toBe('main');
    });
  });

  describe('openChatTab', () => {
    it('creates a new chat tab with generated conversation ID', () => {
      const store = useCanvasStore.getState();

      const result = store.openChatTab();

      expect(result.tabId).toBeTruthy();
      expect(result.conversationId).toBeTruthy();
      expect(result.isNew).toBe(true);

      const state = useCanvasStore.getState();
      const mainPanel = state.panels['main'];
      expect(mainPanel.tabs).toHaveLength(1);
      expect(mainPanel.tabs[0].type).toBe('chat');
      expect(mainPanel.tabs[0].entityId).toBe(result.conversationId);
    });

    it('focuses existing chat tab instead of creating new one', () => {
      const store = useCanvasStore.getState();

      const first = store.openChatTab();
      expect(first.isNew).toBe(true);

      store.openTab('main', createTab({ type: 'sequence', entityId: '/path/seq.gb' }));

      const second = store.openChatTab();

      expect(second.tabId).toBe(first.tabId);
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.isNew).toBe(false);

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(2);
      expect(state.panels['main'].activeTabId).toBe(first.tabId);
    });

    it('migrates legacy agent trace chat tab IDs instead of reusing them', () => {
      const store = useCanvasStore.getState();
      const legacyTabId = store.openTab('main', {
        type: 'chat',
        entityId: 'agent-trace-cli-conversation',
        label: 'Chat',
      });

      const result = store.openChatTab();

      expect(result.tabId).toBe(legacyTabId);
      expect(result.conversationId).not.toBe('agent-trace-cli-conversation');
      expect(result.isNew).toBe(true);

      const state = useCanvasStore.getState();
      const migratedTab = state.panels['main'].tabs.find((tab) => tab.id === legacyTabId);
      expect(migratedTab?.entityId).toBe(result.conversationId);
      expect(state.panels['main'].activeTabId).toBe(legacyTabId);
    });

    it('opens chat in leftmost panel when split layout exists', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');

      const result = store.openChatTab();

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs).toHaveLength(1);
      expect(state.panels['main'].tabs[0].id).toBe(result.tabId);
      expect(state.panels[panel2Id].tabs).toHaveLength(0);
    });

    it('creates chat tab with default label "New Chat"', () => {
      const store = useCanvasStore.getState();

      store.openChatTab();

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs[0].label).toBe('New Chat');
    });

    it('allows opening a specific conversation ID', () => {
      const store = useCanvasStore.getState();

      const result = store.openChatTab('existing-conv-123');

      expect(result.conversationId).toBe('existing-conv-123');
      expect(result.isNew).toBe(true);

      const state = useCanvasStore.getState();
      expect(state.panels['main'].tabs[0].entityId).toBe('existing-conv-123');
    });

    it('focuses existing tab when opening same conversation ID', () => {
      const store = useCanvasStore.getState();

      const first = store.openChatTab('conv-abc');

      store.openTab('main', createTab({ type: 'file', entityId: '/path/file.txt' }));

      const second = store.openChatTab('conv-abc');

      expect(second.tabId).toBe(first.tabId);
      expect(second.isNew).toBe(false);
    });
  });

  describe('retargetChatTab', () => {
    it('rewrites an existing chat tab entityId instead of opening a new tab (no proliferation)', () => {
      const store = useCanvasStore.getState();
      const first = store.openChatTab('conv-current');
      expect(useCanvasStore.getState().panels['main'].tabs).toHaveLength(1);

      const result = store.retargetChatTab('conv-older');

      expect(result.tabId).toBe(first.tabId);
      expect(result.conversationId).toBe('conv-older');
      expect(result.isNew).toBe(false);

      const tabs = useCanvasStore.getState().panels['main'].tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0].type).toBe('chat');
      expect(tabs[0].entityId).toBe('conv-older');
      expect(useCanvasStore.getState().panels['main'].activeTabId).toBe(first.tabId);
    });

    it('focuses the existing tab when it already shows the target conversation', () => {
      const store = useCanvasStore.getState();
      const first = store.openChatTab('conv-x');
      store.openTab('main', createTab({ type: 'file', entityId: '/path/f.txt' }));

      const result = store.retargetChatTab('conv-x');

      expect(result.tabId).toBe(first.tabId);
      expect(result.isNew).toBe(false);
      const tabs = useCanvasStore.getState().panels['main'].tabs;
      expect(tabs.filter((t) => t.type === 'chat')).toHaveLength(1);
      expect(useCanvasStore.getState().panels['main'].activeTabId).toBe(first.tabId);
    });

    it('creates a chat tab when none exists at all', () => {
      const store = useCanvasStore.getState();
      expect(useCanvasStore.getState().panels['main'].tabs).toHaveLength(0);

      const result = store.retargetChatTab('conv-fresh');

      expect(result.conversationId).toBe('conv-fresh');
      const tabs = useCanvasStore.getState().panels['main'].tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0].type).toBe('chat');
      expect(tabs[0].entityId).toBe('conv-fresh');
    });

    it('prefers the focused panel chat tab in a split layout', () => {
      const store = useCanvasStore.getState();
      const mainChat = store.openChatTab('conv-main');
      const panel2 = store.splitPanel('main', 'vertical');
      const panel2Chat = store.openTab(panel2, {
        type: 'chat',
        entityId: 'conv-panel2',
        label: 'Chat 2',
      });
      store.focusPanel(panel2);

      const result = store.retargetChatTab('conv-target');

      expect(result.tabId).toBe(panel2Chat);
      expect(
        useCanvasStore.getState().panels[panel2].tabs.find((t) => t.id === panel2Chat)?.entityId
      ).toBe('conv-target');
      expect(
        useCanvasStore.getState().panels['main'].tabs.find((t) => t.id === mainChat.tabId)?.entityId
      ).toBe('conv-main');
    });
  });

  describe('retargetChatTabOpposite', () => {
    it('splits a sole source pane and moves the reused chat beside the invoking content', () => {
      const store = useCanvasStore.getState();
      const chat = store.openChatTab('conv-current');
      const sequenceTabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/workspace/protein.gb',
          label: 'protein.gb',
        })
      );
      store.setActiveTab('main', sequenceTabId);
      store.focusPanel('main');

      const result = store.retargetChatTabOpposite('main', 'conv-target');
      const state = useCanvasStore.getState();

      expect(Object.keys(state.panels)).toHaveLength(2);
      expect(result.panelId).not.toBe('main');
      expect(result.tabId).toBe(chat.tabId);
      expect(state.panels.main.tabs.map((tab) => tab.id)).toContain(sequenceTabId);
      expect(state.panels.main.tabs.map((tab) => tab.id)).not.toContain(chat.tabId);
      expect(state.panels[result.panelId].tabs.find((tab) => tab.id === chat.tabId)?.entityId).toBe(
        'conv-target'
      );
      expect(state.panels[result.panelId].activeTabId).toBe(chat.tabId);
      expect(state.focusedPanelId).toBe(result.panelId);
    });

    it('uses the existing opposite pane without creating a third pane', () => {
      const store = useCanvasStore.getState();
      const sourceSequence = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/workspace/protein.gb',
          label: 'protein.gb',
        })
      );
      const oppositePanelId = store.splitPanel('main', 'vertical');
      store.openTab(oppositePanelId, {
        type: 'file',
        entityId: '/workspace/notes.md',
        label: 'notes.md',
      });
      const chat = store.openTab('main', {
        type: 'chat',
        entityId: 'conv-current',
        label: 'Chat',
      });
      store.setActiveTab('main', sourceSequence);
      store.focusPanel('main');

      const result = store.retargetChatTabOpposite('main', 'conv-target');
      const state = useCanvasStore.getState();

      expect(Object.keys(state.panels)).toHaveLength(2);
      expect(result.panelId).toBe(oppositePanelId);
      expect(result.tabId).toBe(chat);
      expect(state.panels[oppositePanelId].tabs.find((tab) => tab.id === chat)?.entityId).toBe(
        'conv-target'
      );
      expect(state.focusedPanelId).toBe(oppositePanelId);
    });
  });

  describe('pendingViewState', () => {
    it('passes pendingViewState to opened tab', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: 'test.gb',
          label: 'Test',
          pendingViewState: { scrollPosition: 500, selectedFeature: { name: 'GFP' } },
        })
      );

      const state = useCanvasStore.getState();
      const tab = state.panels['main'].tabs.find((t) => t.id === tabId);
      expect(tab?.pendingViewState).toEqual({
        scrollPosition: 500,
        selectedFeature: { name: 'GFP' },
      });
    });

    it('clearPendingViewState removes pendingViewState from tab', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: 'test.gb',
          label: 'Test',
          pendingViewState: { scrollPosition: 500 },
        })
      );

      store.clearPendingViewState('main', tabId);

      const state = useCanvasStore.getState();
      const tab = state.panels['main'].tabs.find((t) => t.id === tabId);
      expect(tab?.pendingViewState).toBeUndefined();
    });
  });

  describe('tab viewState', () => {
    it('tab can be created with initial viewState', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/path/seq.gb',
          label: 'Test Sequence',
          viewState: {
            virtualDigestEnzyme: 'BsaI',
            digestPanelExpanded: true,
          },
        })
      );

      const state = useCanvasStore.getState();
      const tab = state.panels['main'].tabs.find((t) => t.id === tabId);

      expect(tab?.viewState).toEqual({
        virtualDigestEnzyme: 'BsaI',
        digestPanelExpanded: true,
      });
    });

    it('setTabViewState updates viewState for existing tab', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/path/seq.gb',
          label: 'Test Sequence',
        })
      );

      let state = useCanvasStore.getState();
      let tab = state.panels['main'].tabs.find((t) => t.id === tabId);
      expect(tab?.viewState).toBeUndefined();

      store.setTabViewState('main', tabId, {
        virtualDigestEnzyme: 'BsmBI',
        digestPanelExpanded: false,
      });

      state = useCanvasStore.getState();
      tab = state.panels['main'].tabs.find((t) => t.id === tabId);
      expect(tab?.viewState).toEqual({
        virtualDigestEnzyme: 'BsmBI',
        digestPanelExpanded: false,
      });
    });

    it('setTabViewState merges with existing viewState', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/path/seq.gb',
          label: 'Test Sequence',
          viewState: {
            virtualDigestEnzyme: 'BsaI',
            digestPanelExpanded: true,
          },
        })
      );

      store.setTabViewState('main', tabId, {
        digestPanelExpanded: false,
      });

      const state = useCanvasStore.getState();
      const tab = state.panels['main'].tabs.find((t) => t.id === tabId);

      expect(tab?.viewState).toEqual({
        virtualDigestEnzyme: 'BsaI',
        digestPanelExpanded: false,
      });
    });

    it('setTabViewState publishes only actual changes during repeated topology input', () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab(
        'main',
        createTab({
          viewState: { sequenceMapShape: 'circular', sequenceViewportCenterBp: 1200 },
        })
      );
      const initial = useCanvasStore.getState();
      const changed = vi.fn();
      const unsubscribe = useCanvasStore.subscribe(changed);
      try {
        for (let sample = 0; sample < 80; sample++) {
          store.setTabViewState('main', tabId, { sequenceMapShape: 'circular' });
        }
        store.setTabViewState('main', tabId, {});
        store.setTabViewState('main', 'missing-tab', { sequenceMapShape: 'linear' });
        expect(changed).not.toHaveBeenCalled();
        expect(useCanvasStore.getState()).toBe(initial);
        store.setTabViewState('main', tabId, { sequenceMapShape: 'linear' });
        expect(changed).toHaveBeenCalledTimes(1);
        const tab = useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)!;
        expect(tab.viewState).toEqual({
          sequenceMapShape: 'linear',
          sequenceViewportCenterBp: 1200,
        });
        store.setTabViewState('main', tabId, { selection: undefined });
        expect(
          Object.hasOwn(
            useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)!.viewState!,
            'selection'
          )
        ).toBe(true);
        expect(changed).toHaveBeenCalledTimes(2);
        store.setTabViewState('main', tabId, { selection: undefined });
        expect(changed).toHaveBeenCalledTimes(2);
      } finally {
        unsubscribe();
      }
    });

    it('viewState persists across store operations', () => {
      const store = useCanvasStore.getState();

      const tabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/path/seq.gb',
          label: 'Test Sequence',
          viewState: { virtualDigestEnzyme: 'BsaI' },
        })
      );

      store.updateTab('main', tabId, { label: 'Renamed Sequence' });

      const state = useCanvasStore.getState();
      const tab = state.panels['main'].tabs.find((t) => t.id === tabId);

      expect(tab?.label).toBe('Renamed Sequence');
      expect(tab?.viewState).toEqual({ virtualDigestEnzyme: 'BsaI' });
    });

    it('viewState is preserved when moving tab between panels', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');

      store.openTab('main', createTab({ entityId: '/path/other.gb' }));
      const tabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/path/seq.gb',
          label: 'Test Sequence',
          viewState: { virtualDigestEnzyme: 'BsaI' },
        })
      );

      store.moveTab('main', panel2Id, tabId);

      const state = useCanvasStore.getState();
      const tab = state.panels[panel2Id].tabs.find((t) => t.id === tabId);

      expect(tab?.viewState).toEqual({ virtualDigestEnzyme: 'BsaI' });
    });

    it('sequence viewport position and zoom remain scoped to the moved tab', () => {
      const store = useCanvasStore.getState();

      const panel2Id = store.splitPanel('main', 'vertical');
      const firstTabId = store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/path/first.gb',
          label: 'First Sequence',
          viewState: { sequenceViewportCenterBp: 250, sequenceViewportZoomLevel: 75 },
        })
      );
      store.openTab(
        'main',
        createTab({
          type: 'sequence',
          entityId: '/path/second.gb',
          label: 'Second Sequence',
          viewState: { sequenceViewportCenterBp: 900, sequenceViewportZoomLevel: 125 },
        })
      );

      store.moveTab('main', panel2Id, firstTabId);

      const state = useCanvasStore.getState();
      const movedTab = state.panels[panel2Id].tabs.find((t) => t.id === firstTabId);
      const remainingTab = state.panels.main.tabs.find(
        (t) => t.entityId === logicalSequenceId('/path/second.gb')
      );

      expect(movedTab?.viewState).toEqual({
        sequenceViewportCenterBp: 250,
        sequenceViewportZoomLevel: 75,
      });
      expect(remainingTab?.viewState).toEqual({
        sequenceViewportCenterBp: 900,
        sequenceViewportZoomLevel: 125,
      });
    });
  });

  describe('persist migration', () => {
    it('removes legacy References tabs because References is a permanent tool', () => {
      const migrated = migratePersistedCanvasState(
        {
          panels: {
            main: {
              id: 'main',
              tabs: [
                {
                  id: 'reference-library-tab',
                  type: 'reference-library',
                  entityId: 'reference-library',
                  label: 'References',
                },
                {
                  id: 'sequence-1',
                  type: 'sequence',
                  entityId: 'assembly:grch38',
                  label: 'GRCh38',
                },
              ],
              activeTabId: 'reference-library-tab',
            },
          },
          layout: { type: 'panel', panelId: 'main' },
          focusedPanelId: 'main',
        },
        6
      );

      expect(migrated.panels.main.tabs.map((tab) => tab.type)).toEqual(['sequence']);
      expect(migrated.panels.main.activeTabId).toBe('sequence-1');
    });

    it('filters legacy assembly-panel tabs and reconciles activeTabId', () => {
      const migrated = migratePersistedCanvasState(
        {
          panels: {
            main: {
              id: 'main',
              tabs: [
                {
                  id: 'assembly-1',
                  type: 'assembly-panel',
                  entityId: 'design-1',
                  label: 'Assembly: Design 1',
                },
                {
                  id: 'sequence-1',
                  type: 'sequence',
                  entityId: '/tmp/a.gb',
                  label: 'A',
                },
              ],
              activeTabId: 'assembly-1',
            },
          },
          layout: { type: 'panel', panelId: 'main' },
          focusedPanelId: 'main',
        },
        1
      );

      expect(migrated.panels.main.tabs.map((tab) => tab.type)).toEqual(['sequence']);
      expect(migrated.panels.main.activeTabId).toBe('sequence-1');
    });

    it('opens the parent design when a legacy assembly-panel was the only tab', () => {
      const migrated = migratePersistedCanvasState(
        {
          panels: {
            main: {
              id: 'main',
              tabs: [
                {
                  id: 'assembly-1',
                  type: 'assembly-panel',
                  entityId: 'design-1',
                  label: 'Assembly: Design 1',
                },
              ],
              activeTabId: 'assembly-1',
            },
          },
          layout: { type: 'panel', panelId: 'main' },
          focusedPanelId: 'main',
        },
        1
      );

      expect(migrated.panels.main.tabs).toEqual([
        {
          id: 'assembly-1-design',
          type: 'design',
          entityId: 'design-1',
          label: 'Design 1',
          viewState: undefined,
        },
      ]);
      expect(migrated.panels.main.activeTabId).toBe('assembly-1-design');
    });

    it('preserves every legacy assembly-panel tab when a panel only had assembly tabs', () => {
      const migrated = migratePersistedCanvasState(
        {
          panels: {
            main: {
              id: 'main',
              tabs: [
                {
                  id: 'assembly-1',
                  type: 'assembly-panel',
                  entityId: 'design-1',
                  label: 'Assembly: Design 1',
                },
                {
                  id: 'assembly-2',
                  type: 'assembly-panel',
                  entityId: 'design-2',
                  label: 'Assembly: Design 2',
                },
                {
                  id: 'assembly-3',
                  type: 'assembly-panel',
                  entityId: 'design-3',
                  label: 'Assembly: Design 3',
                },
              ],
              activeTabId: 'assembly-2',
            },
          },
          layout: { type: 'panel', panelId: 'main' },
          focusedPanelId: 'main',
        },
        1
      );

      expect(migrated.panels.main.tabs).toEqual([
        expect.objectContaining({
          id: 'assembly-1-design',
          type: 'design',
          entityId: 'design-1',
          label: 'Design 1',
        }),
        expect.objectContaining({
          id: 'assembly-2-design',
          type: 'design',
          entityId: 'design-2',
          label: 'Design 2',
        }),
        expect.objectContaining({
          id: 'assembly-3-design',
          type: 'design',
          entityId: 'design-3',
          label: 'Design 3',
        }),
      ]);
      expect(migrated.panels.main.tabs).toHaveLength(3);
      expect(
        migrated.panels.main.tabs.some((tab) => tab.id === migrated.panels.main.activeTabId)
      ).toBe(true);
    });

    it('repairs focusedPanelId after pruning empty panels', () => {
      const migrated = migratePersistedCanvasState(
        {
          panels: {
            left: {
              id: 'left',
              tabs: [{ id: 'seq-1', type: 'sequence', entityId: '/tmp/a.gb', label: 'A' }],
              activeTabId: 'seq-1',
            },
            right: {
              id: 'right',
              tabs: [],
              activeTabId: null,
            },
          },
          layout: {
            type: 'split',
            direction: 'vertical',
            children: [
              { type: 'panel', panelId: 'left' },
              { type: 'panel', panelId: 'right' },
            ],
            sizes: [50, 50],
          },
          focusedPanelId: 'right',
        },
        1
      );

      expect(Object.keys(migrated.panels)).toEqual(['left']);
      expect(migrated.focusedPanelId).toBe('left');
      expect(migrated.layout).toEqual({ type: 'panel', panelId: 'left' });
    });
  });
});
