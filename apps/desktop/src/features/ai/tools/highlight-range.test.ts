import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockOpenSequenceDocument, mockResolveSequenceDocument } = vi.hoisted(() => ({
  mockOpenSequenceDocument: vi.fn(),
  mockResolveSequenceDocument: vi.fn(),
}));

vi.mock('../../document-opening/compat', () => ({
  openSequenceDocument: mockOpenSequenceDocument,
}));
vi.mock('../../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: mockResolveSequenceDocument,
}));
import { highlightRangeOutputSchema, createHighlightRangeTool as uncheckedcreateHighlightRangeTool } from './highlight-range';
import { useCanvasStore } from '../../canvas/store';
import { resetCanvasStore, mockUUID, execTool } from './test-helpers';
import type { Tab } from '../../canvas/types';

type HighlightResult =
  | {
      ok: true;
      opened?: true;
      degraded?: 'single-highlight-viewer';
      regionCount?: number;
      highlightedRegion?: { start: number; end: number };
      note?: string;
      resolved: { panelId: string; tabId: string; range: { start: number; end: number } };
    }
  | { ok: false; code: string; error: string };

mockUUID();

beforeEach(() => {
  resetCanvasStore();
  mockResolveSequenceDocument.mockReset().mockImplementation(async (documentId: string) => ({
    documentId,
    sourcePath: `/private/${documentId}.gb`,
    ref: { kind: 'catalog-sequence', entityId: documentId },
    name: 'pUC19',
  }));
  mockOpenSequenceDocument.mockReset().mockImplementation(async (ref, options) =>
    useCanvasStore.getState().openTab(options.strategy.panelId, {
      type: 'sequence',
      entityId: ref.entityId,
      sequenceDocument: ref,
      label: options.label,
    })
  );
});

const SEQ_DOCUMENT_ID = 'catalog-puc19';

function tabsInPanel(panelId: string): Tab[] {
  return useCanvasStore.getState().panels[panelId]?.tabs ?? [];
}

describe('highlight_range tool', () => {
  it('converts 1-indexed input to a 0-indexed highlightRange (10..20 → 9..19)', async () => {
    const store = useCanvasStore.getState();
    const tabId = store.openTab('main', {
      type: 'sequence',
      entityId: SEQ_DOCUMENT_ID,
      sequenceDocument: { kind: 'catalog-sequence', entityId: SEQ_DOCUMENT_ID },
      label: 'pUC19',
    });

    const tool = createHighlightRangeTool([]);
    const result = await execTool<HighlightResult>(tool, {
      documentId: SEQ_DOCUMENT_ID,
      start: 10,
      end: 20,
    });

    expect(result.ok).toBe(true);
    const tab = tabsInPanel('main').find((t) => t.id === tabId)!;
                                                              
    expect(tab.viewState?.highlightRange).toEqual({ start: 9, end: 19 });
                                      
    expect(tab.viewState?.scrollPosition).toBe(10);
                                                        
    expect(tab.viewState?.sequenceNavigationRequestId).toBeTruthy();
  });

  it('targets the correct panel/tab when the sequence is already open', async () => {
    const store = useCanvasStore.getState();
                                                       
    store.openTab('main', { type: 'chat', entityId: 'conv-1', label: 'Chat' });
    const rightId = store.splitPanel('main', 'vertical');
    const seqTabId = store.openTab(rightId, {
      type: 'sequence',
      entityId: SEQ_DOCUMENT_ID,
      sequenceDocument: { kind: 'catalog-sequence', entityId: SEQ_DOCUMENT_ID },
      label: 'pUC19',
    });

    const tool = createHighlightRangeTool([]);
    const result = await execTool<HighlightResult>(tool, {
      documentId: SEQ_DOCUMENT_ID,
      start: 5,
      end: 12,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.opened).toBeUndefined();
      expect(result.resolved.panelId).toBe(rightId);
      expect(result.resolved.tabId).toBe(seqTabId);
      expect(result.resolved.range).toEqual({ start: 5, end: 12 });
    }
                                                                         
    expect(tabsInPanel(rightId)).toHaveLength(1);
    const tab = tabsInPanel(rightId).find((t) => t.id === seqTabId)!;
    expect(tab.viewState?.highlightRange).toEqual({ start: 4, end: 11 });
  });

  it('opens the logical sequence document and applies the view state when it is not open', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conv-1', label: 'Chat' });

    const tool = createHighlightRangeTool([]);
    const result = await execTool<HighlightResult>(tool, {
      documentId: SEQ_DOCUMENT_ID,
      start: 100,
      end: 150,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.opened).toBe(true);
    }

                                                                       
                                                               
    const allTabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    const seqTab = allTabs.find(
      (t) => t.type === 'sequence' && t.entityId === SEQ_DOCUMENT_ID
    )!;
    expect(seqTab).toBeDefined();
    expect(seqTab.viewState?.highlightRange).toEqual({ start: 99, end: 149 });
    expect(mockResolveSequenceDocument).toHaveBeenCalledWith(SEQ_DOCUMENT_ID, []);
                                             
    expect(tabsInPanel('main').map((t) => t.type)).toEqual(['chat']);
  });

  it('returns INVALID_RANGE when end < start and the range does not wrap', async () => {
    const tool = createHighlightRangeTool([]);
    const result = await execTool<HighlightResult>(tool, {
      documentId: SEQ_DOCUMENT_ID,
      start: 20,
      end: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_RANGE');
      expect(result.error).toMatch(/start/i);
    }
                          
    const allTabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(0);
  });

  it('allows a wrapping range (start > end) and carries the wraps flag', async () => {
    const store = useCanvasStore.getState();
    const tabId = store.openTab('main', {
      type: 'sequence',
      entityId: SEQ_DOCUMENT_ID,
      sequenceDocument: { kind: 'catalog-sequence', entityId: SEQ_DOCUMENT_ID },
      label: 'pUC19',
    });

    const tool = createHighlightRangeTool([]);
    const result = await execTool<HighlightResult>(tool, {
      documentId: SEQ_DOCUMENT_ID,
      start: 2600,
      end: 10,
      wraps: true,
    });

    expect(result.ok).toBe(true);
    const tab = tabsInPanel('main').find((t) => t.id === tabId)!;
    expect(tab.viewState?.highlightRange).toEqual({ start: 2599, end: 9, wraps: true });
  });

  it('returns INVALID_PATH for an empty document ID', async () => {
    const tool = createHighlightRangeTool([]);
    const result = await execTool<HighlightResult>(tool, {
      documentId: '   ',
      start: 1,
      end: 5,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_PATH');
    }
  });

                                                                                
  describe('disjoint regions', () => {
    it('highlights the FIRST of N disjoint regions and reports it degraded (NOT min..max)', async () => {
      const store = useCanvasStore.getState();
      const tabId = store.openTab('main', {
        type: 'sequence',
        entityId: SEQ_DOCUMENT_ID,
        sequenceDocument: { kind: 'catalog-sequence', entityId: SEQ_DOCUMENT_ID },
        label: 'pUC19',
      });

      const tool = createHighlightRangeTool([]);
                                                                              
      const result = await execTool<HighlightResult>(tool, {
        documentId: SEQ_DOCUMENT_ID,
        regions: [
          { start: 191, end: 193 },
          { start: 206, end: 208 },
          { start: 227, end: 229 },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.degraded).toBe('single-highlight-viewer');
        expect(result.regionCount).toBe(3);
        expect(result.highlightedRegion).toEqual({ start: 191, end: 193 });
        expect(result.resolved.range).toEqual({ start: 191, end: 193 });
        expect(result.note).toMatch(/disjoint/i);
      }

                                                                                
                                                             
      const tab = tabsInPanel('main').find((t) => t.id === tabId)!;
      expect(tab.viewState?.highlightRange).toEqual({ start: 190, end: 192 });
    });

    it('treats a single-entry regions array as an ordinary highlight (no degrade flag)', async () => {
      const store = useCanvasStore.getState();
      store.openTab('main', {
        type: 'sequence',
        entityId: SEQ_DOCUMENT_ID,
        sequenceDocument: { kind: 'catalog-sequence', entityId: SEQ_DOCUMENT_ID },
        label: 'pUC19',
      });

      const tool = createHighlightRangeTool([]);
      const result = await execTool<HighlightResult>(tool, {
        documentId: SEQ_DOCUMENT_ID,
        regions: [{ start: 206, end: 208 }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.degraded).toBeUndefined();
        expect(result.resolved.range).toEqual({ start: 206, end: 208 });
      }
    });

    it('returns INVALID_RANGE when neither start/end nor regions are provided', async () => {
      const tool = createHighlightRangeTool([]);
      const result = await execTool<HighlightResult>(tool, { documentId: SEQ_DOCUMENT_ID });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_RANGE');
    });
  });
});

import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
const createHighlightRangeTool = checkedToolFactory(uncheckedcreateHighlightRangeTool, highlightRangeOutputSchema);
