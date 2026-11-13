import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockOpenDocument, mockResolveDocument } = vi.hoisted(() => ({
  mockOpenDocument: vi.fn(),
  mockResolveDocument: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: { stat: async () => ({ isFile: true, isDirectory: false }) } }),
}));
vi.mock('../../document-opening/compat', () => ({
  openSequenceDocument: mockOpenDocument,
}));
vi.mock('../../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: mockResolveDocument,
}));
import { openTabOutputSchema, openTabTool, createOpenTabTool as uncheckedcreateOpenTabTool } from './open-tab';
import { useCanvasStore } from '../../canvas/store';
import { resetCanvasStore, mockUUID, execTool } from './test-helpers';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';

mockUUID();

beforeEach(() => {
  resetCanvasStore();
  mockResolveDocument.mockReset();
  mockOpenDocument.mockReset();
  mockResolveDocument.mockImplementation(async (documentId: string) => ({
    documentId,
    sourcePath: `/private/${documentId}.gb`,
    ref: { kind: 'catalog-sequence', entityId: documentId },
  }));
  mockOpenDocument.mockImplementation(async (ref: any, options: any) =>
    useCanvasStore.getState().openTab(options.strategy.panelId, {
      type: 'sequence',
      entityId: ref.kind === 'managed-sequence' ? ref.packageId : ref.entityId,
      sequenceDocument: ref,
      label: options.label,
    })
  );
});

describe('open_tab tool', () => {
  it('opens sequence tab with valid parameters', async () => {
    const result = await execTool<{ tabId: string; error?: string }>(
      openTabTool,
      { type: 'sequence', entityId: 'catalog-test', label: 'Test' },
    );

    expect(result.tabId).toBeTruthy();
    expect(result.error).toBeUndefined();
                                                                           
    const state = useCanvasStore.getState();
    const allTabs = Object.values(state.panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(1);
    expect(allTabs[0].type).toBe('sequence');
  });

  it('opens page tab with valid parameters', async () => {
    const result = await execTool<{ tabId: string }>(
      openTabTool,
      { type: 'page', entityId: 'page-123', label: 'My Page' },
    );

    expect(result.tabId).toBeTruthy();
  });

  it('opens protein tab keyed by LIMS entity id , not a file path', async () => {
    const result = await execTool<{ tabId: string }>(
      openTabTool,
      { type: 'protein', entityId: 'uuid-protein-1', label: 'GFP' },
    );

    expect(result.tabId).toBeTruthy();
    const state = useCanvasStore.getState();
    const allTabs = Object.values(state.panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(1);
    expect(allTabs[0].type).toBe('protein');
                                                                                    
    expect(allTabs[0].entityId).toBe('uuid-protein-1');
  });

  it('rejects empty entityId for file-based types', async () => {
    const result = await execTool<{ error?: string }>(
      openTabTool,
      { type: 'sequence', entityId: '', label: 'Test' },
    );

    expect(result.error).toMatch(/empty/i);
  });

  it('rejects path traversal in entityId', async () => {
    const result = await execTool<{ error?: string }>(
      openTabTool,
      { type: 'file', entityId: '../../../etc/passwd', label: 'Hack' },
    );

    expect(result.error).toMatch(/path traversal/i);
  });

  it('rejects a physical sequence path instead of creating path-backed state', async () => {
    const result = await execTool<{ error?: string }>(openTabTool, {
      type: 'sequence',
      entityId: '/workspace/pUC19.gb',
      label: 'pUC19',
    });

    expect(result.error).toMatch(/physical sequence paths are deprecated/i);
    expect(mockResolveDocument).not.toHaveBeenCalled();
  });

  it('rejects very long entityId', async () => {
    const result = await execTool<{ error?: string }>(
      openTabTool,
      { type: 'sequence', entityId: 'a'.repeat(501), label: 'Test' },
    );

    expect(result.error).toMatch(/too long/i);
  });

  it('allows page/design type without file validation', async () => {
                                                                   
    const result = await execTool<{ tabId: string; error?: string }>(
      openTabTool,
      { type: 'page', entityId: '/some/id/path', label: 'Page' },
    );

    expect(result.error).toBeUndefined();
    expect(result.tabId).toBeTruthy();
  });

                                                                              
                                                               
  it('opens content in the adjacent panel, reusing it (chat on the left)', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conv-1', label: 'Chat' });
    const rightId = store.splitPanel('main', 'vertical');
    store.openTab(rightId, {
      type: 'sequence',
      entityId: 'catalog-plasmid',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'catalog-plasmid' },
      label: 'Plasmid',
    });

    await execTool(openTabTool, { type: 'design', entityId: 'design-1', label: 'Assembly' });

    const s = useCanvasStore.getState();
    expect(Object.keys(s.panels)).toHaveLength(2);               
    expect(s.panels['main'].tabs.map((t) => t.type)).toEqual(['chat']);                            
    expect(s.panels[rightId].tabs.map((t) => t.type)).toContain('design');                        
    expect(s.focusedPanelId).toBe('main');                                        
  });

  it('opens content in the adjacent panel (chat on the right)', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', {
      type: 'sequence',
      entityId: 'catalog-plasmid',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'catalog-plasmid' },
      label: 'Plasmid',
    });
    const rightId = store.splitPanel('main', 'vertical');
    store.openTab(rightId, { type: 'chat', entityId: 'conv-1', label: 'Chat' });

    await execTool(openTabTool, { type: 'design', entityId: 'design-1', label: 'Assembly' });

    const s = useCanvasStore.getState();
    expect(Object.keys(s.panels)).toHaveLength(2);
    expect(s.panels[rightId].tabs.map((t) => t.type)).toEqual(['chat']);                  
    expect(s.panels['main'].tabs.map((t) => t.type)).toContain('design');                         
    expect(s.focusedPanelId).toBe(rightId);                                     
  });

  it('creates one adjacent panel when chat is the only panel', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conv-1', label: 'Chat' });

    await execTool(openTabTool, { type: 'design', entityId: 'design-1', label: 'Assembly' });

    const s = useCanvasStore.getState();
    expect(Object.keys(s.panels)).toHaveLength(2);                        
    expect(s.panels['main'].tabs.map((t) => t.type)).toEqual(['chat']);                        
    const other = Object.values(s.panels).find((p) => p.id !== 'main')!;
    expect(other.tabs.map((t) => t.type)).toContain('design');
    expect(s.focusedPanelId).toBe('main');
  });

  it('reuses the content panel across multiple opens (no pane-creation gore)', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conv-1', label: 'Chat' });

    await execTool(openTabTool, { type: 'design', entityId: 'design-1', label: 'A' });
    await execTool(openTabTool, { type: 'page', entityId: 'page-1', label: 'B' });

    const s = useCanvasStore.getState();
    expect(Object.keys(s.panels)).toHaveLength(2);                                       
    const content = Object.values(s.panels).find((p) => p.id !== 'main')!;
    expect(content.tabs.map((t) => t.type).sort()).toEqual(['design', 'page']);
  });
});

describe('open_tab multi-root path normalization', () => {
  const singleFolder: WorkspaceFolder[] = [
    { name: 'project', path: '/Users/me/project', addedAt: 1 },
  ];

  const multiFolder: WorkspaceFolder[] = [
    { name: 'Lab Data', path: '/Users/me/Lab Data', addedAt: 1 },
    { name: 'References', path: '/Users/me/References', addedAt: 2 },
  ];

  it('resolves a generic file to an absolute path in a multi-root project', async () => {
    const tool = createOpenTabTool(multiFolder);
    const result = await execTool<{ tabId: string }>(
      tool,
      { type: 'file', entityId: 'Lab Data/sample.txt', label: 'sample.txt' },
    );

    expect(result.tabId).toBeTruthy();
    const tabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
                                                      
    expect(tabs[0].entityId).toBe('/Users/me/Lab Data/sample.txt');
  });

  it('never resolves a sequence path into a tab ID', async () => {
    const tool = createOpenTabTool(multiFolder);
    const result = await execTool<{ tabId: string }>(
      tool,
      { type: 'sequence', entityId: 'Lab Data/plasmids/pUC19.gb', label: 'pUC19.gb' },
    );

    expect(result.tabId).toBe('');
    expect((result as { error?: string }).error).toMatch(/deprecated/i);
    const tabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(tabs).toHaveLength(0);
  });

  it('resolves a generic file to an absolute path in a single-root project', async () => {
    const tool = createOpenTabTool(singleFolder);
    const result = await execTool<{ tabId: string }>(
      tool,
      { type: 'file', entityId: 'sample.txt', label: 'sample.txt' },
    );

    expect(result.tabId).toBeTruthy();
    const tabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(tabs[0].entityId).toBe('/Users/me/project/sample.txt');
  });

  it('opens a native protocol as a scientific document beside the chat', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conversation-1', label: 'Chat' });
    const tool = createOpenTabTool(singleFolder);

    const result = await execTool<{ tabId: string }>(tool, {
      type: 'scientific-document',
      entityId: 'protocols/paper.dnaforge-protocol.json',
      label: 'Paper protocol',
    });

    expect(result.tabId).toBeTruthy();
    const state = useCanvasStore.getState();
    expect(Object.keys(state.panels)).toHaveLength(2);
    expect(state.panels.main.tabs.map((tab) => tab.type)).toEqual(['chat']);
    const contentPanel = Object.values(state.panels).find((panel) => panel.id !== 'main');
    expect(contentPanel?.tabs).toEqual([
      expect.objectContaining({
        type: 'scientific-document',
        entityId: '/Users/me/project/protocols/paper.dnaforge-protocol.json',
      }),
    ]);
    expect(state.focusedPanelId).toBe('main');
  });

  it('opens a literal PDF beside the chat and resolves its workspace path', async () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'chat', entityId: 'conversation-1', label: 'Chat' });
    const tool = createOpenTabTool(singleFolder);

    const result = await execTool<{ tabId: string }>(tool, {
      type: 'pdf',
      entityId: 'papers/source-paper.pdf',
      label: 'Source paper',
    });

    expect(result.tabId).toBeTruthy();
    const state = useCanvasStore.getState();
    expect(Object.keys(state.panels)).toHaveLength(2);
    expect(state.panels.main.tabs.map((tab) => tab.type)).toEqual(['chat']);
    const contentPanel = Object.values(state.panels).find((panel) => panel.id !== 'main');
    expect(contentPanel?.tabs).toEqual([
      expect.objectContaining({
        type: 'pdf',
        entityId: '/Users/me/project/papers/source-paper.pdf',
      }),
    ]);
    expect(state.focusedPanelId).toBe('main');
  });

  it('rejects a git sequence locator because it still encodes a path', async () => {
    const tool = createOpenTabTool(singleFolder);
    const result = await execTool<{ tabId: string }>(
      tool,
      { type: 'sequence', entityId: 'git://project/sample.fasta', label: 'sample.fasta' },
    );

    expect(result.tabId).toBe('');
  });

  it('rejects an entity URI that still contains a sequence path', async () => {
    const tool = createOpenTabTool(singleFolder);
    const result = await execTool<{ tabId: string }>(
      tool,
      { type: 'sequence', entityId: 'entity://sequence/sample.fasta', label: 'sample.fasta' },
    );

    expect(result.tabId).toBe('');
  });

  it('rejects a multi-root sequence locator instead of normalizing it', async () => {
    const tool = createOpenTabTool(multiFolder);
    const result = await execTool<{ tabId: string }>(
      tool,
      { type: 'sequence', entityId: 'git://Lab Data/sample.fasta', label: 'sample.fasta' },
    );

    expect(result.tabId).toBe('');
  });

  it('does not strip folder prefix for page/design types', async () => {
    const tool = createOpenTabTool(multiFolder);
    const result = await execTool<{ tabId: string }>(
      tool,
      { type: 'page', entityId: 'Lab Data/some-page-id', label: 'Page' },
    );

    expect(result.tabId).toBeTruthy();
    const tabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
                                                            
    expect(tabs[0].entityId).toBe('Lab Data/some-page-id');
  });
});

import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
const createOpenTabTool = checkedToolFactory(uncheckedcreateOpenTabTool, openTabOutputSchema);
