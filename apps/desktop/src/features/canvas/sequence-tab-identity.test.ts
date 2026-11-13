import { beforeEach, describe, expect, it } from 'vitest';
import { migratePersistedCanvasState, useCanvasStore } from './store';
import { useSequenceStore } from '../sequence/store';

function resetCanvas(): void {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
    recentlyClosed: [],
  });
}

describe('sequence tab identity boundary', () => {
  beforeEach(resetCanvas);

  it('removes the legacy References tab while preserving unsaved genome views', () => {
    const migrated = migratePersistedCanvasState(
      {
        panels: {
          main: {
            id: 'main',
            activeTabId: 'library',
            tabs: [
              {
                id: 'library',
                entityId: 'references',
                type: 'reference-library',
                label: 'References',
              },
              {
                id: 'view',
                entityId: 'assembly:grch38',
                type: 'sequence',
                label: 'Human',
                isDirty: true,
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
    expect(migrated.panels.main.tabs[0]).toMatchObject({ id: 'view', isDirty: true });
    expect(migrated.panels.main.activeTabId).toBe('view');
  });

  it.each(['/projects/demo/pUC19.gb', 'sequences/pUC19.gb', 'pUC19.gb', 'C:\\demo\\pUC19.gb'])(
    'rejects a physical sequence locator as application identity: %s',
    (entityId) => {
      expect(() =>
        useCanvasStore.getState().openTab('main', {
          type: 'sequence',
          entityId,
          label: 'pUC19',
        })
      ).toThrow(/logical document ID/);
      expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
    }
  );

  it('accepts a catalog ID only when it agrees with the document reference', () => {
    const sequenceDocument = { kind: 'catalog-sequence', entityId: 'catalog-sequence-42' } as const;
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'catalog-sequence-42',
      label: 'pUC19',
      sequenceDocument,
    });

    expect(tabId).not.toBe('');
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      entityId: 'catalog-sequence-42',
      sequenceDocument,
    });
  });

  it('rejects a logical ID that disagrees with its document reference', () => {
    expect(() =>
      useCanvasStore.getState().openTab('main', {
        type: 'sequence',
        entityId: 'wrong-id',
        label: 'pUC19',
        sequenceDocument: { kind: 'catalog-sequence', entityId: 'catalog-sequence-42' },
      })
    ).toThrow(/does not match/);
  });

  it('removes legacy path-keyed sequence tabs during persistence migration', () => {
    const migrated = migratePersistedCanvasState(
      {
        panels: {
          main: {
            id: 'main',
            tabs: [
              { id: 'legacy', type: 'sequence', entityId: '/old/pUC19.gb', label: 'pUC19' },
              { id: 'chat', type: 'chat', entityId: 'conversation-1', label: 'Chat' },
            ],
            activeTabId: 'legacy',
          },
        },
        layout: { type: 'panel', panelId: 'main' },
        focusedPanelId: 'main',
        oversizeScanComplete: true,
        recentlyClosed: [],
      },
      4
    );

    expect(migrated.panels.main.tabs.map((tab) => tab.id)).toEqual(['chat']);
    expect(migrated.panels.main.activeTabId).toBe('chat');
  });

  it('repairs legacy assembly tabs and removes unresolved logical sequence descriptors', () => {
    const migrated = migratePersistedCanvasState(
      {
        panels: {
          main: {
            id: 'main',
            tabs: [
              {
                id: 'assembly',
                type: 'sequence',
                entityId: 'assembly:zmB73v5',
                label: 'Z. mays B73 (NAM-5.0)',
              },
              {
                id: 'unresolved',
                type: 'sequence',
                entityId: 'legacy-logical-id',
                label: 'Unresolved sequence',
              },
              { id: 'chat', type: 'chat', entityId: 'conversation-1', label: 'Chat' },
            ],
            activeTabId: 'assembly',
          },
        },
        layout: { type: 'panel', panelId: 'main' },
        focusedPanelId: 'main',
        oversizeScanComplete: true,
        recentlyClosed: [],
      },
      3
    );

    expect(migrated.panels.main.tabs.map((tab) => tab.id)).toEqual(['assembly', 'chat']);
    expect(migrated.panels.main.tabs[0]).toMatchObject({
      entityId: 'assembly:zmB73v5',
      sequenceDocument: {
        kind: 'indexed-sequence',
        documentId: 'assembly:zmB73v5',
      },
    });
    expect(migrated.panels.main.activeTabId).toBe('assembly');
  });

  it('replaces a parser-supplied file identity at the sequence cache boundary', () => {
    useSequenceStore.getState().setSequence('catalog-sequence-42', {
      id: '/projects/demo/pUC19.gb',
      name: 'pUC19',
      sequence: 'ACGT',
      length: 4,
      annotations: [],
    });

    expect(useSequenceStore.getState().sequences['catalog-sequence-42']?.id).toBe(
      'catalog-sequence-42'
    );
    expect(useSequenceStore.getState().sequences['/projects/demo/pUC19.gb']).toBeUndefined();
  });
});
