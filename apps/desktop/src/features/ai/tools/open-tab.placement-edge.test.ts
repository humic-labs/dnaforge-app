import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../document-opening/compat', () => ({
  openSequenceDocument: vi.fn(),
}));
vi.mock('../../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: vi.fn(async (documentId: string) => ({
    documentId,
    sourcePath: `/private/${documentId}.gb`,
    ref: { kind: 'catalog-sequence', entityId: documentId },
  })),
}));

vi.mock('../../document-opening/open-document', () => ({ openDocument: vi.fn() }));
import { openDocument } from '../../document-opening/open-document';

import { openTabTool } from './open-tab';
import { openSequenceDocument } from '../../document-opening/compat';
import { useCanvasStore } from '../../canvas/store';
import { resetCanvasStore, mockUUID, execTool } from './test-helpers';

mockUUID();
const mockOpenSequenceDocument = vi.mocked(openSequenceDocument);

beforeEach(() => {
  resetCanvasStore();
  mockOpenSequenceDocument.mockReset();
  vi.mocked(openDocument).mockReset();
});

describe('open_tab sequence placement edge cases', () => {
  it('reuses an already-open sequence in a NON-adjacent panel (no duplicate)', async () => {
    const store = useCanvasStore.getState();
    const seqTabId = store.openTab('main', {
      type: 'sequence',
      entityId: 'catalog-plasmid',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'catalog-plasmid' },
      label: 'Plasmid',
    });
    const mid = store.splitPanel('main', 'vertical');
    store.openTab(mid, { type: 'page', entityId: 'page-1', label: 'Notes' });
    const right = store.splitPanel(mid, 'vertical');
    store.openTab(right, { type: 'chat', entityId: 'conv-1', label: 'Chat' });

    const result = await execTool<{ tabId: string; error?: string }>(openTabTool, {
      type: 'sequence',
      entityId: 'catalog-plasmid',
      label: 'Plasmid',
    });

    const s = useCanvasStore.getState();
    expect(mockOpenSequenceDocument).not.toHaveBeenCalled();
    expect(result.tabId).toBe(seqTabId);
    const seqTabs = Object.values(s.panels)
      .flatMap((p) => p.tabs)
      .filter((t) => t.type === 'sequence' && t.entityId === 'catalog-plasmid');
    expect(seqTabs).toHaveLength(1);
    expect(s.panels['main'].tabs.some((t) => t.id === seqTabId)).toBe(true);
    expect(Object.keys(s.panels)).toHaveLength(3);
    expect(s.focusedPanelId).toBe(right);
  });

  it('rolls back a freshly-split panel when the open is cancelled/blocked', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conv-1', label: 'Chat' });
    mockOpenSequenceDocument.mockResolvedValue(null);

    const result = await execTool<{ tabId: string; error?: string }>(openTabTool, {
      type: 'sequence',
      entityId: 'catalog-huge',
      label: 'Huge',
    });

    const s = useCanvasStore.getState();
    expect(mockOpenSequenceDocument).toHaveBeenCalledTimes(1);
    expect(result.tabId).toBe('');
    expect(result.error).toMatch(/too large|unavailable/i);
    expect(Object.keys(s.panels)).toHaveLength(1);
    expect(s.panels['main'].tabs.map((t) => t.type)).toEqual(['chat']);
  });

  it.each(['sequence', 'structure'] as const)('keeps user content added while a %s open is pending', async (type) => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conv-1', label: 'Chat' });
    let destination: string | undefined;
    const addUserContent = (panelId: string) => {
      destination = panelId;
      store.openTab(panelId, { type: 'page', entityId: 'user-notes', label: 'Notes' });
    };
    mockOpenSequenceDocument.mockImplementation(async (_ref, options) => {
      if (options.strategy?.kind !== 'panel') throw new Error('Expected named placement');
      addUserContent(options.strategy.panelId);
      return null;
    });
    vi.mocked(openDocument).mockImplementation(async (request) => {
      if (request.placement?.kind !== 'panel') throw new Error('Expected named placement');
      addUserContent(request.placement.panelId);
      return { status: 'blocked', message: 'Too large' };
    });
    const result = await execTool<{ tabId: string; error?: string }>(openTabTool, {
      type, entityId: type === 'sequence' ? 'catalog-large' : '/workspace/large.pdb', label: 'Large',
    });
    expect(result.tabId).toBe('');
    expect(destination).toBeDefined();
    expect(useCanvasStore.getState().panels[destination!]?.tabs.map((tab) => tab.entityId)).toEqual(['user-notes']);
  });

  it('keeps the created panel when the open succeeds', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conv-1', label: 'Chat' });
    mockOpenSequenceDocument.mockImplementation(async (ref: any, options: any) =>
      useCanvasStore.getState().openTab(options.strategy.panelId, {
        type: 'sequence',
        entityId: ref.entityId,
        sequenceDocument: ref,
        label: options.label,
      })
    );

    const result = await execTool<{ tabId: string; error?: string }>(openTabTool, {
      type: 'sequence',
      entityId: 'catalog-ok',
      label: 'OK',
    });

    const s = useCanvasStore.getState();
    expect(result.tabId).toBeTruthy();
    expect(result.error).toBeUndefined();
    expect(Object.keys(s.panels)).toHaveLength(2);
    expect(s.panels['main'].tabs.map((t) => t.type)).toEqual(['chat']);
    expect(s.focusedPanelId).toBe('main');
  });
});
