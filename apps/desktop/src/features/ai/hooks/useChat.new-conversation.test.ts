import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEmptyConversationState,
  db,
  resetUseChatConversationHarness,
  useChatStore,
} from '../../../test/ai/useChat-harness';

describe('useChat new-conversation draft lifecycle', () => {
  beforeEach(resetUseChatConversationHarness);

  it('creates new conversation', async () => {
    vi.mocked(db.createConversation).mockResolvedValue({
      id: 'new-conv',
      title: 'New conversation',
      workspace_path: '/ws',
      pinned: 0,
      provider: null,
      model: null,
      created_at: 0,
      updated_at: 0,
    });

    await act(async () => {
      await useChatStore.getState().newConversation('/ws');
    });

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('new-conv');
    expect(state.messages).toEqual([]);
  });

  it('reuses the current conversation when it is already empty', async () => {
    useChatStore.setState({
      currentConversationId: 'empty-conv',
      conversations: [
        {
          id: 'empty-conv',
          title: 'New conversation',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      messages: [],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      queuedMessages: [],
      _convStates: new Map([['empty-conv', createEmptyConversationState()]]),
    });

    let conversationId = '';
    await act(async () => {
      conversationId = await useChatStore.getState().newConversation('/ws');
    });

    expect(conversationId).toBe('empty-conv');
    expect(db.createConversation).not.toHaveBeenCalled();
    expect(useChatStore.getState().conversations).toHaveLength(1);
  });

  it('creates a new conversation when an empty chat has a visible draft', async () => {
    vi.mocked(db.createConversation).mockResolvedValue({
      id: 'draft-conv',
      title: 'New conversation',
      workspace_path: '/ws',
      pinned: 0,
      provider: null,
      model: null,
      created_at: 0,
      updated_at: 0,
    });
    useChatStore.setState({
      currentConversationId: 'empty-conv',
      conversations: [
        {
          id: 'empty-conv',
          title: 'New conversation',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      messages: [],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      queuedMessages: [],
      composerDrafts: new Map([
        ['empty-conv', { text: 'Unsent question', attachments: [], references: [] }],
      ]),
      _convStates: new Map([['empty-conv', createEmptyConversationState()]]),
    });

    const conversationId = await useChatStore.getState().newConversation('/ws');

    expect(conversationId).toBe('draft-conv');
    expect(db.createConversation).toHaveBeenCalledTimes(1);
  });

  it('treats an explicit null source as no source instead of materializing the active draft', async () => {
    vi.mocked(db.createConversation).mockResolvedValue({
      id: 'blank-after-delete',
      title: 'New conversation',
      workspace_path: '/ws',
      pinned: 0,
      provider: null,
      model: null,
      created_at: 0,
      updated_at: 0,
    });
    useChatStore.setState({
      currentConversationId: 'deleted-source',
      conversations: [],
      composerDrafts: new Map([
        ['deleted-source', { text: 'Do not materialize this', attachments: [], references: [] }],
      ]),
    });

    const conversationId = await useChatStore.getState().newConversation('/ws', {
      force: true,
      sourceConversationId: null,
    });

    expect(conversationId).toBe('blank-after-delete');
    expect(db.createConversation).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().composerDrafts.get('deleted-source')?.text).toBe(
      'Do not materialize this'
    );
  });

  it('materializes a placeholder draft before opening its blank destination', async () => {
    vi.mocked(db.createConversation)
      .mockResolvedValueOnce({
        id: 'preserved-draft-conv',
        title: 'New conversation',
        workspace_path: '/ws',
        pinned: 0,
        provider: null,
        model: null,
        created_at: 0,
        updated_at: 0,
      })
      .mockResolvedValueOnce({
        id: 'blank-destination-conv',
        title: 'New conversation',
        workspace_path: '/ws',
        pinned: 0,
        provider: null,
        model: null,
        created_at: 1,
        updated_at: 1,
      });
    const placeholderDraft = {
      text: 'Keep all of this',
      attachments: [
        { id: 'file-1', name: 'notes.txt', path: '/ws/notes.txt', size: 5, content: 'notes' },
      ],
      references: [
        {
          id: 'ref-1',
          entity_type: 'sequence',
          display_label: 'Selected region',
          locator: '/ws/example.gb',
          deep_link_params: null,
          data: null,
          source: 'test',
          status: 'created',
          workspace_scope: '/ws',
          created_at: 1,
          updated_at: 1,
        },
      ],
    };

    useChatStore.setState({
      currentConversationId: 'placeholder-conv',
      conversations: [],
      composerDrafts: new Map([['placeholder-conv', placeholderDraft]]),
    });

    const conversationId = await useChatStore.getState().newConversation('/ws', {
      sourceConversationId: 'placeholder-conv',
    });

    expect(conversationId).toBe('blank-destination-conv');
    expect(useChatStore.getState().composerDrafts.get('preserved-draft-conv')).toEqual(
      placeholderDraft
    );
    expect(useChatStore.getState().composerDrafts.has('placeholder-conv')).toBe(false);
    expect(useChatStore.getState().composerDrafts.has(conversationId)).toBe(false);
    expect(useChatStore.getState().conversations.map((conversation) => conversation.id)).toEqual([
      'blank-destination-conv',
      'preserved-draft-conv',
    ]);
  });

  it('materializes a placeholder draft before switching directly to history', async () => {
    vi.mocked(db.createConversation).mockResolvedValue({
      id: 'preserved-draft-conv',
      title: 'New conversation',
      workspace_path: '/ws',
      pinned: 0,
      provider: null,
      model: null,
      created_at: 0,
      updated_at: 0,
    });
    const placeholderDraft = {
      text: 'Do not orphan this draft',
      attachments: [],
      references: [],
    };
    useChatStore.setState({
      currentConversationId: 'placeholder-conv',
      conversations: [
        {
          id: 'history-conv',
          title: 'Earlier chat',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      composerDrafts: new Map([['placeholder-conv', placeholderDraft]]),
      _convStates: new Map([['placeholder-conv', createEmptyConversationState()]]),
    });

    await useChatStore.getState().switchConversation('history-conv', {
      sourceConversationId: 'placeholder-conv',
      workspacePath: '/ws',
    });

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('history-conv');
    expect(state.composerDrafts.get('preserved-draft-conv')).toEqual(placeholderDraft);
    expect(state.composerDrafts.has('placeholder-conv')).toBe(false);
    expect(state.conversations.map((conversation) => conversation.id)).toContain(
      'preserved-draft-conv'
    );
  });

  it('materializes one durable draft row across overlapping history switches', async () => {
    let resolveMaterialization!: (
      conversation: Awaited<ReturnType<typeof db.createConversation>>
    ) => void;
    vi.mocked(db.createConversation).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.createConversation>>>((resolve) => {
          resolveMaterialization = resolve;
        })
    );
    const summary = (id: string) => ({
      id,
      title: id,
      workspacePath: '/ws',
      pinned: false,
      provider: null,
      model: null,
      createdAt: 0,
      updatedAt: 0,
    });
    useChatStore.setState({
      currentConversationId: 'placeholder-conv',
      conversations: [summary('history-b'), summary('history-c')],
      composerDrafts: new Map([
        ['placeholder-conv', { text: 'Keep once', attachments: [], references: [] }],
      ]),
      _convStates: new Map([['placeholder-conv', createEmptyConversationState()]]),
    });

    const first = useChatStore.getState().switchConversation('history-b', {
      sourceConversationId: 'placeholder-conv',
      workspacePath: '/ws',
    });
    const second = useChatStore.getState().switchConversation('history-c', {
      sourceConversationId: 'placeholder-conv',
      workspacePath: '/ws',
    });
    expect(db.createConversation).toHaveBeenCalledTimes(1);
    resolveMaterialization({
      id: 'preserved-draft-conv',
      title: 'New conversation',
      workspace_path: '/ws',
      pinned: 0,
      provider: null,
      model: null,
      created_at: 0,
      updated_at: 0,
    });
    await Promise.all([first, second]);

    const state = useChatStore.getState();
    expect(db.createConversation).toHaveBeenCalledTimes(1);
    expect(state.currentConversationId).toBe('history-c');
    expect(
      state.conversations.filter((conversation) => conversation.id === 'preserved-draft-conv')
    ).toHaveLength(1);
    expect(state.composerDrafts.get('preserved-draft-conv')?.text).toBe('Keep once');
  });

  it('does not let a slow New operation reclaim the chat after a later Switch', async () => {
    let resolveNew!: (conversation: Awaited<ReturnType<typeof db.createConversation>>) => void;
    vi.mocked(db.createConversation).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.createConversation>>>((resolve) => {
          resolveNew = resolve;
        })
    );
    const summary = (id: string) => ({
      id,
      title: id,
      workspacePath: '/ws',
      pinned: false,
      provider: null,
      model: null,
      createdAt: 0,
      updatedAt: 0,
    });
    useChatStore.setState({
      currentConversationId: 'history-a',
      conversations: [summary('history-a'), summary('history-b')],
      _convStates: new Map([
        ['history-a', createEmptyConversationState()],
        ['history-b', createEmptyConversationState()],
      ]),
    });

    const slowNew = useChatStore.getState().newConversation('/ws', {
      force: true,
      sourceConversationId: 'history-a',
    });
    await useChatStore.getState().switchConversation('history-b');
    resolveNew({
      id: 'late-blank',
      title: 'New conversation',
      workspace_path: '/ws',
      pinned: 0,
      provider: null,
      model: null,
      created_at: 1,
      updated_at: 1,
    });
    await slowNew;

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('history-b');
    expect(state.conversations.map((conversation) => conversation.id)).toContain('late-blank');
  });

  it('coalesces overlapping New requests from shortcut and history entry points', async () => {
    let resolveNew!: (conversation: Awaited<ReturnType<typeof db.createConversation>>) => void;
    vi.mocked(db.createConversation).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.createConversation>>>((resolve) => {
          resolveNew = resolve;
        })
    );
    useChatStore.setState({
      currentConversationId: 'source',
      conversations: [
        {
          id: 'source',
          title: 'Source',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      _convStates: new Map([
        [
          'source',
          {
            ...createEmptyConversationState(),
            messages: [{ id: 'existing', role: 'user', content: 'Existing', createdAt: 1 }],
          },
        ],
      ]),
    });

    const shortcutNew = useChatStore.getState().newConversation('/ws', {
      sourceConversationId: 'source',
    });
    const historyNew = useChatStore.getState().newConversation('/ws', {
      sourceConversationId: 'source',
    });
    await vi.waitFor(() => expect(db.createConversation).toHaveBeenCalledTimes(1));
    resolveNew({
      id: 'single-blank',
      title: 'New conversation',
      workspace_path: '/ws',
      pinned: 0,
      provider: null,
      model: null,
      created_at: 2,
      updated_at: 2,
    });

    await expect(Promise.all([shortcutNew, historyNew])).resolves.toEqual([
      'single-blank',
      'single-blank',
    ]);
    expect(db.createConversation).toHaveBeenCalledTimes(1);
    expect(
      useChatStore
        .getState()
        .conversations.filter((conversation) => conversation.id === 'single-blank')
    ).toHaveLength(1);
  });

  it('creates a new conversation when the empty chat belongs to another workspace', async () => {
    vi.mocked(db.createConversation).mockResolvedValue({
      id: 'other-workspace-conv',
      title: 'New conversation',
      workspace_path: '/new-workspace',
      pinned: 0,
      provider: null,
      model: null,
      created_at: 0,
      updated_at: 0,
    });
    useChatStore.setState({
      currentConversationId: 'empty-conv',
      conversations: [
        {
          id: 'empty-conv',
          title: 'New conversation',
          workspacePath: '/old-workspace',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      messages: [],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      queuedMessages: [],
      _convStates: new Map([['empty-conv', createEmptyConversationState()]]),
    });

    const conversationId = await useChatStore.getState().newConversation('/new-workspace');

    expect(conversationId).toBe('other-workspace-conv');
    expect(db.createConversation).toHaveBeenCalledTimes(1);
  });
});
