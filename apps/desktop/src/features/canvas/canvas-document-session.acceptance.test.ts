import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migratePersistedCanvasState, partializeCanvasState, useCanvasStore } from './store';
import { resolveTabEditor } from './tab-editor';
import { projectTabStripTab } from './tab-menu-presentation';
import { saveTargetForTab } from './artifact-document-lifecycle';
import type { SequenceDocumentRef } from '../../shared/managed-sequence-document';
import type { Tab, TabType } from './types';

type Identity =
  | { type: 'sequence'; sequenceDocument: SequenceDocumentRef }
  | { type: Exclude<TabType, 'sequence'>; entityId: string };
type IdentityCommands = {
  retargetTab: (
    panelId: string,
    tabId: string,
    identity: Identity,
    updates?: { label?: string }
  ) => void;
  setSequenceAssemblyEdit: (panelId: string, tabId: string, designId: string | null) => void;
};

const catalog = { kind: 'catalog-sequence', entityId: 'sequence-fixture' } as const;
const variants: Array<[string, Omit<Tab, 'id'>, string, string]> = [
  [
    'ordinary sequence',
    { type: 'sequence', entityId: catalog.entityId, sequenceDocument: catalog, label: 'Sequence' },
    'sequence',
    'sequence-document',
  ],
  [
    'indexed ordinary reference',
    {
      type: 'sequence',
      entityId: catalog.entityId,
      sequenceDocument: catalog,
      label: 'Indexed catalog',
      loadStatus: 'indexed-pending',
    },
    'sequence',
    'tab',
  ],
  [
    'indexed view reference',
    {
      type: 'sequence',
      entityId: 'view-fixture',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'view-fixture' },
      label: 'View',
      loadStatus: 'indexed',
    },
    'sequence',
    'tab',
  ],
  [
    'assembly edit',
    {
      type: 'sequence',
      entityId: catalog.entityId,
      sequenceDocument: catalog,
      label: 'Assembly edit',
      assemblyEditDesignId: 'design-fixture',
    },
    'design',
    'sequence-document',
  ],
  [
    'standalone design',
    { type: 'design', entityId: 'design-fixture', label: 'Design' },
    'design',
    'tab',
  ],
  ['file', { type: 'file', entityId: '/fixture/raw.dat', label: 'Raw data' }, 'file', 'file'],
  ['text', { type: 'text', entityId: '/fixture/notes.txt', label: 'Notes' }, 'text', 'file'],
  [
    'protein',
    { type: 'protein', entityId: '/fixture/protein.faa', label: 'Protein' },
    'protein',
    'tab',
  ],
  ['notebook', { type: 'page', entityId: 'notebook-fixture', label: 'Notebook' }, 'page', 'page'],
  [
    'structure',
    {
      type: 'structure',
      entityId: '1RBL',
      label: 'Structure',
      initialStructureAttrs: { source: 'pdb', sourceId: '1RBL', label: 'Structure' },
    },
    'structure',
    'file',
  ],
];

function reset() {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    recentlyClosed: [],
    oversizeScanComplete: true,
  });
}

beforeEach(reset);
afterEach(reset);

function tabByEntity(entityId: string): Tab {
  const tab = Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((item) => item.entityId === entityId);
  expect(tab).toBeDefined();
  return tab!;
}

describe('canvas document session acceptance', () => {
  it.each(variants)(
    'preserves %s identity and selection across split, move, close and reopen',
    (_name, input, editor, saveKind) => {
      const store = useCanvasStore.getState();
      const id = store.openTab('main', input);
      const right = store.splitPanel('main', 'horizontal');
      store.moveTab('main', right, id);
      expect(tabByEntity(input.entityId)).toMatchObject({ ...input, id });
      store.closeTab(right, id);
      store.reopenLastClosedTab();
      const reopened = tabByEntity(input.entityId);
      expect(reopened.type).toBe(input.type);
      expect(reopened.sequenceDocument).toEqual(input.sequenceDocument);
      expect(resolveTabEditor(reopened).type).toBe(editor);
      expect(saveTargetForTab(reopened).kind).toBe(saveKind);
    }
  );

  it.each([1, 7])(
    'round-trips old version %s records while preserving existing editor-session persistence policy',
    (version) => {
      const tabs = variants.map(([_name, input], index) => ({ ...input, id: `tab-${index}` }));
      useCanvasStore.setState({ panels: { main: { id: 'main', tabs, activeTabId: 'tab-0' } } });
      const saved = partializeCanvasState(useCanvasStore.getState());
      const restored = migratePersistedCanvasState(JSON.parse(JSON.stringify(saved)), version);
      expect(restored.panels.main.tabs).toHaveLength(variants.length);
      for (const [index, [_name, input, editor, saveKind]] of variants.entries()) {
        const tab = restored.panels.main.tabs[index];
        expect(tab.entityId).toBe(input.entityId);
        expect(tab.sequenceDocument).toEqual(input.sequenceDocument);
        expect(resolveTabEditor(tab).type).toBe(input.assemblyEditDesignId ? 'sequence' : editor);
        expect(tab.assemblyEditDesignId).toBeUndefined();
        expect(saveTargetForTab(tab).kind).toBe(saveKind);
      }
    }
  );

  it('uses the same indexed classification for pending ordinary references and the save owner', () => {
    const tab = { ...variants[1][1], id: 'pending-indexed' };
    expect(saveTargetForTab(tab)).toEqual({ kind: 'tab', tabId: tab.id });
    expect(projectTabStripTab(tab).isIndexedSequence).toBe(true);
    expect(tab.sequenceDocument).toEqual(catalog);
  });

  it('changes identity only through an explicit complete identity command', () => {
    const store = useCanvasStore.getState() as ReturnType<typeof useCanvasStore.getState> &
      IdentityCommands;
    const id = store.openTab('main', { type: 'file', entityId: '/fixture/old.txt', label: 'Old' });
    const before = tabByEntity('/fixture/old.txt');
    expect(() =>
      store.updateTab('main', id, { entityId: '/fixture/partial.txt' } as never)
    ).toThrow();
    expect(tabByEntity('/fixture/old.txt')).toEqual(before);
    store.retargetTab(
      'main',
      id,
      { type: 'sequence', sequenceDocument: catalog },
      { label: 'Sequence' }
    );
    expect(tabByEntity(catalog.entityId)).toMatchObject({
      id,
      type: 'sequence',
      sequenceDocument: catalog,
    });
    store.setSequenceAssemblyEdit('main', id, 'design-fixture');
    expect(resolveTabEditor(tabByEntity(catalog.entityId))).toEqual({
      type: 'design',
      designId: 'design-fixture',
      packageOwned: true,
    });
    store.setSequenceAssemblyEdit('main', id, null);
    expect(resolveTabEditor(tabByEntity(catalog.entityId)).type).toBe('sequence');
    store.retargetTab('main', id, { type: 'text', entityId: '/fixture/new.txt' });
    const file = tabByEntity('/fixture/new.txt');
    expect(file.sequenceDocument).toBeUndefined();
    expect(file.assemblyEditDesignId).toBeUndefined();
    expect(saveTargetForTab(file)).toEqual({ kind: 'file', filePath: '/fixture/new.txt' });
  });

  it('rejects incompatible identity fields before adding a tab', () => {
    const store = useCanvasStore.getState();
    expect(() =>
      store.openTab('main', {
        type: 'file',
        entityId: '/fixture/invalid',
        label: 'Invalid',
        sequenceDocument: catalog,
      })
    ).toThrow();
    expect(() =>
      store.openTab('main', {
        type: 'sequence',
        entityId: 'mismatch',
        label: 'Invalid',
        sequenceDocument: catalog,
      })
    ).toThrow();
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });
});
