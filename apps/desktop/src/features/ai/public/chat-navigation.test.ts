import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  canvas: {
    focusedPanelId: 'main',
    panels: {
      main: {
        activeTabId: 'source-tab',
        tabs: [{ id: 'source-tab', type: 'chat', entityId: 'unsaved-source' }],
      },
    },
    retargetChatTab: vi.fn(),
  },
  chat: {
    currentConversationId: 'unsaved-source',
    switchConversation: vi.fn(),
  },
}));

vi.mock('../../canvas/store', () => ({ useCanvasStore: { getState: () => state.canvas } }));
vi.mock('../hooks/useChat', () => ({ useChatStore: { getState: () => state.chat } }));

import { beginAIChatNavigation, resumeAIConversation } from './chat-navigation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function resume(conversationId = 'saved-chat', isCurrent = () => true) {
  return resumeAIConversation({ conversationId, workspacePath: '/project', isCurrent });
}

describe('saved conversation navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginAIChatNavigation();
    state.canvas.focusedPanelId = 'main';
    state.canvas.panels.main.activeTabId = 'source-tab';
    state.canvas.panels.main.tabs = [
      { id: 'source-tab', type: 'chat', entityId: 'unsaved-source' },
    ];
    state.chat.currentConversationId = 'unsaved-source';
    state.chat.switchConversation.mockImplementation(async (id: string) => {
      state.chat.currentConversationId = id;
      return 'applied';
    });
  });

  it('materializes the visible source draft through the store before retargeting', async () => {
    await expect(resume()).resolves.toBe('opened');
    expect(state.chat.switchConversation).toHaveBeenCalledWith('saved-chat', {
      sourceConversationId: 'unsaved-source',
      workspacePath: '/project',
    });
    expect(state.canvas.retargetChatTab).toHaveBeenCalledWith('saved-chat');
  });

  it('leaves a newer conversation selected when an older read returns late', async () => {
    const oldRead = deferred<'available'>();
    state.chat.switchConversation.mockImplementationOnce(() => oldRead.promise);
    const oldNavigation = resume('older-chat');
    await vi.waitFor(() => expect(state.chat.switchConversation).toHaveBeenCalledTimes(1));
    await expect(resume('newer-chat')).resolves.toBe('opened');
    oldRead.resolve('available');
    await expect(oldNavigation).resolves.toBe('superseded');
    expect(state.canvas.retargetChatTab.mock.calls).toEqual([['newer-chat']]);
  });

  it('does not open a conversation after its sidebar unmounts', async () => {
    const read = deferred<'applied'>();
    let current = true;
    state.chat.switchConversation.mockImplementationOnce(() => read.promise);
    const navigation = resume('saved-chat', () => current);
    await vi.waitFor(() => expect(state.chat.switchConversation).toHaveBeenCalledTimes(1));
    current = false;
    state.chat.currentConversationId = 'saved-chat';
    read.resolve('applied');
    await expect(navigation).resolves.toBe('superseded');
    expect(state.canvas.retargetChatTab).not.toHaveBeenCalled();
  });

  it('does not replace a tab the user selected while history was loading', async () => {
    const read = deferred<'applied'>();
    state.chat.switchConversation.mockImplementationOnce(() => read.promise);
    const navigation = resume();
    await vi.waitFor(() => expect(state.chat.switchConversation).toHaveBeenCalledTimes(1));
    state.canvas.panels.main.activeTabId = 'document-tab';
    state.canvas.panels.main.tabs.push({
      id: 'document-tab',
      type: 'file',
      entityId: '/project/readme.md',
    });
    state.chat.currentConversationId = 'saved-chat';
    read.resolve('applied');
    await expect(navigation).resolves.toBe('superseded');
    expect(state.canvas.retargetChatTab).not.toHaveBeenCalled();
  });

  it('lets a new-chat or ordinary chat entry supersede a pending saved-chat read', async () => {
    const read = deferred<'applied'>();
    state.chat.switchConversation.mockImplementationOnce(() => read.promise);
    const navigation = resume();
    await vi.waitFor(() => expect(state.chat.switchConversation).toHaveBeenCalledTimes(1));
    beginAIChatNavigation();
    state.chat.currentConversationId = 'saved-chat';
    read.resolve('applied');
    await expect(navigation).resolves.toBe('superseded');
    expect(state.canvas.retargetChatTab).not.toHaveBeenCalled();
  });

  it('does not retarget a deleted conversation', async () => {
    state.chat.switchConversation.mockResolvedValueOnce('stale');
    await expect(resume()).resolves.toBe('stale');
    expect(state.canvas.retargetChatTab).not.toHaveBeenCalled();
  });

  it('suppresses errors from a closed surface but preserves a current read failure', async () => {
    const read = deferred<'applied'>();
    let current = true;
    state.chat.switchConversation.mockImplementationOnce(() => read.promise);
    const navigation = resume('saved-chat', () => current);
    await vi.waitFor(() => expect(state.chat.switchConversation).toHaveBeenCalledTimes(1));
    current = false;
    read.reject(new Error('read failed'));
    await expect(navigation).resolves.toBe('superseded');
    state.chat.switchConversation.mockRejectedValueOnce(new Error('current read failed'));
    await expect(resume()).rejects.toThrow('current read failed');
  });
});
