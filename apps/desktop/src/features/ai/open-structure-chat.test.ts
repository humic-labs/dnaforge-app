/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/public/store';
import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';

const { createReference, chatState, readConversation } = vi.hoisted(() => ({
  createReference: vi.fn(),
  chatState: vi.fn(),
  readConversation: vi.fn(),
}));

vi.mock('../../db/entity-references', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../db/entity-references')>();
  return { ...original, createEntityReference: createReference };
});
vi.mock('./hooks/useChat', () => ({ useChatStore: { getState: chatState } }));
vi.mock('../../db', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../db')>();
  return { ...original, getConversation: readConversation };
});

import { prepareEntityReferenceRow } from '../../db/entity-references';
import { openStructureChat } from './open-structure-chat';

const VIEW_ID = 'view:protein-exploration';
const WORKSPACE = '/test/protein-project';
const state = {
  conversations: [] as Array<{ id: string; workspacePath: string | null }>,
  composerDrafts: new Map(),
  pendingDraft: null as null | {
    conversationId: string;
    references: ReturnType<typeof prepareEntityReferenceRow>[];
  },
  newConversation: vi.fn(),
  switchConversation: vi.fn(),
  setPendingDraft: vi.fn(),
  sendMessage: vi.fn(),
};

function sourceTab() {
  const attrs = {
    source: 'pdb' as const,
    sourceId: '1FS0',
    pdbId: '1FS0',
    label: 'Trypsin',
    structureViewIdentity: { schemaVersion: 1 as const, structureViewId: VIEW_ID, bindingId: null },
  };
  useStructure3dStore.getState().registerStructure(VIEW_ID, attrs, 'Trypsin');
  return useCanvasStore.getState().openTab('main', {
    type: 'structure',
    entityId: VIEW_ID,
    label: 'Trypsin',
    initialStructureAttrs: attrs,
  });
}

describe('protein structure chat handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    });
    useStructure3dStore.setState({ expandedStructures: {}, interactionState: {} });
    useWorkspaceStore.setState({
      folders: [{ path: WORKSPACE, name: 'Protein project', addedAt: 0 }],
    });
    state.conversations = [];
    state.composerDrafts = new Map();
    state.pendingDraft = null;
    state.newConversation.mockImplementation(async () => {
      state.conversations.push({ id: 'structure-chat', workspacePath: WORKSPACE });
      return 'structure-chat';
    });
    state.switchConversation.mockResolvedValue('applied');
    readConversation.mockResolvedValue(null);
    state.setPendingDraft.mockImplementation((draft) => {
      state.pendingDraft = draft;
    });
    chatState.mockReturnValue(state);
    createReference.mockImplementation(async (params) => prepareEntityReferenceRow(params));
  });

  it('stages the exact whole-view reference in a chat beside the invoking tab without sending', async () => {
    const tabId = sourceTab();
    const result = await openStructureChat({ structureViewId: VIEW_ID });
    const canvas = useCanvasStore.getState();
    expect(Object.keys(canvas.panels)).toHaveLength(2);
    expect(canvas.panels.main.activeTabId).toBe(tabId);
    expect(result.panelId).not.toBe('main');
    expect(canvas.panels[result.panelId].activeTabId).toBe(result.tabId);
    expect(canvas.layout).toMatchObject({
      type: 'split',
      direction: 'vertical',
      children: [
        { type: 'panel', panelId: result.panelId },
        { type: 'panel', panelId: 'main' },
      ],
      sizes: [50, 50],
    });
    expect(createReference).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'structure',
        locator: `entity://structure/${VIEW_ID}`,
        displayLabel: 'Trypsin',
        data: null,
        deepLinkParams: null,
        workspaceRootPath: WORKSPACE,
      })
    );
    expect(state.pendingDraft?.references).toHaveLength(1);
    expect(state.sendMessage).not.toHaveBeenCalled();
  });

  it('reuses the adjacent chat and its existing context chip on repeated exploration', async () => {
    sourceTab();
    const first = await openStructureChat({ structureViewId: VIEW_ID });
    const second = await openStructureChat({ structureViewId: VIEW_ID });
    expect(second.conversationId).toBe(first.conversationId);
    expect(Object.keys(useCanvasStore.getState().panels)).toHaveLength(2);
    expect(state.newConversation).toHaveBeenCalledTimes(1);
    expect(createReference).toHaveBeenCalledTimes(1);
    expect(state.pendingDraft?.references).toHaveLength(1);
  });

  it('reuses a persisted empty adjacent chat omitted from the history list', async () => {
    sourceTab();
    const first = await openStructureChat({ structureViewId: VIEW_ID });
    state.conversations = [];
    readConversation.mockResolvedValue({ id: first.conversationId, workspace_path: WORKSPACE });
    const second = await openStructureChat({ structureViewId: VIEW_ID });
    expect(readConversation).toHaveBeenCalledWith(first.conversationId);
    expect(second.conversationId).toBe(first.conversationId);
    expect(state.newConversation).toHaveBeenCalledTimes(1);
    expect(createReference).toHaveBeenCalledTimes(1);
  });

  it('does not retarget an existing chat from another workspace', async () => {
    sourceTab();
    const opposite = useCanvasStore.getState().splitPanel('main', 'vertical');
    useCanvasStore.getState().openTab(opposite, {
      type: 'chat',
      entityId: 'other-project-chat',
      label: 'Other project',
    });
    state.conversations.push({ id: 'other-project-chat', workspacePath: '/other-project' });
    await openStructureChat({ structureViewId: VIEW_ID });
    expect(state.newConversation).toHaveBeenCalledWith(
      WORKSPACE,
      expect.objectContaining({ force: true })
    );
    expect(state.switchConversation).not.toHaveBeenCalledWith('other-project-chat');
    expect(state.pendingDraft?.conversationId).toBe('structure-chat');
  });

  it('rejects a stale structure view before creating a reference or changing panes', async () => {
    await expect(openStructureChat({ structureViewId: 'closed-view' })).rejects.toThrow();
    expect(createReference).not.toHaveBeenCalled();
    expect(state.newConversation).not.toHaveBeenCalled();
    expect(Object.keys(useCanvasStore.getState().panels)).toHaveLength(1);
  });

  it('does not stage or present chat when the source closes during reference persistence', async () => {
    const tabId = sourceTab();
    createReference.mockImplementation(async (params) => {
      useCanvasStore.getState().closeTab('main', tabId);
      return prepareEntityReferenceRow(params);
    });
    await expect(openStructureChat({ structureViewId: VIEW_ID })).rejects.toThrow();
    expect(state.setPendingDraft).not.toHaveBeenCalled();
    expect(Object.keys(useCanvasStore.getState().panels)).toHaveLength(1);
  });
});
