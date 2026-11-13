import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEmptyConversationState,
  db,
  resetUseChatConversationHarness,
  useChatStore,
} from '../../../test/ai/useChat-harness';

describe('useChat conversation deletion and metadata', () => {
  beforeEach(resetUseChatConversationHarness);

  it('deletes conversation and switches to next', async () => {
    useChatStore.setState({
      currentConversationId: 'c1',
      conversations: [
        {
          id: 'c1',
          title: 'First',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'c2',
          title: 'Second',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      messages: [{ id: 'm1', role: 'user', content: 'test', createdAt: 0 }],
    });

    vi.mocked(db.getMessages).mockResolvedValue([]);

    await act(async () => {
      await useChatStore.getState().deleteConversation('c1');
    });

    const state = useChatStore.getState();
    expect(db.deleteConversation).toHaveBeenCalledWith('c1');
    expect(state.conversations).toHaveLength(1);
    expect(state.currentConversationId).toBe('c2');
  });

  it('sets null ID when deleting last conversation', async () => {
    useChatStore.setState({
      currentConversationId: 'c1',
      conversations: [
        {
          id: 'c1',
          title: 'Only',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      messages: [{ id: 'm1', role: 'user', content: 'test', createdAt: 0 }],
    });

    await act(async () => {
      await useChatStore.getState().deleteConversation('c1');
    });

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it('preserves other-pane drafts and live slices while deletion hydrates its replacement', async () => {
    let resolveReplacementMessages!: (messages: Awaited<ReturnType<typeof db.getMessages>>) => void;
    vi.mocked(db.getMessages).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.getMessages>>>((resolve) => {
          resolveReplacementMessages = resolve;
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
      currentConversationId: 'delete-me',
      conversations: [summary('delete-me'), summary('replacement')],
      _convStates: new Map([['delete-me', createEmptyConversationState()]]),
    });

    const deletion = useChatStore.getState().deleteConversation('delete-me');
    await vi.waitFor(() => expect(db.getMessages).toHaveBeenCalledWith('replacement'));
    const otherPaneState = {
      ...createEmptyConversationState(),
      queuedMessages: [
        {
          id: 'other-queued',
          content: 'Do not drop me',
          workspacePath: '/ws',
          referenceIds: [],
          createdAt: 1,
        },
      ],
    };
    useChatStore.setState((state) => ({
      conversations: [...state.conversations, summary('other-pane')],
      composerDrafts: new Map([
        ...state.composerDrafts,
        ['other-pane', { text: 'Still typing', attachments: [], references: [] }],
      ]),
      _convStates: new Map([...state._convStates, ['other-pane', otherPaneState]]),
    }));
    resolveReplacementMessages([]);
    await deletion;

    const state = useChatStore.getState();
    expect(state.composerDrafts.get('other-pane')?.text).toBe('Still typing');
    expect(state._convStates.get('other-pane')?.queuedMessages[0]?.id).toBe('other-queued');
    expect(state.conversations.map((conversation) => conversation.id)).toContain('other-pane');
  });

  it('does not let a slow deletion reclaim focus from a newer conversation switch', async () => {
    let resolveReplacementMessages!: (messages: Awaited<ReturnType<typeof db.getMessages>>) => void;
    vi.mocked(db.getMessages).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.getMessages>>>((resolve) => {
          resolveReplacementMessages = resolve;
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
      currentConversationId: 'delete-me',
      conversations: [summary('delete-me'), summary('replacement'), summary('new-owner')],
      _convStates: new Map([
        ['delete-me', createEmptyConversationState()],
        ['new-owner', createEmptyConversationState()],
      ]),
    });

    const deletion = useChatStore.getState().deleteConversation('delete-me');
    await vi.waitFor(() => expect(db.getMessages).toHaveBeenCalledWith('replacement'));
    await useChatStore.getState().switchConversation('new-owner');
    resolveReplacementMessages([]);
    const replacement = await deletion;

    expect(replacement).toBe('replacement');
    expect(useChatStore.getState().currentConversationId).toBe('new-owner');
  });

  it('renames conversation', async () => {
    useChatStore.setState({
      conversations: [
        {
          id: 'c1',
          title: 'Old',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    await act(async () => {
      await useChatStore.getState().renameConversation('c1', 'New Title');
    });

    expect(db.updateConversation).toHaveBeenCalledWith('c1', 'New Title');
    expect(useChatStore.getState().conversations[0].title).toBe('New Title');
  });

  it('toggles a conversation pin and immediately restores pinned-first recency order', async () => {
    vi.mocked(db.toggleConversationPinned).mockResolvedValue(true);

    useChatStore.setState({
      conversations: [
        {
          id: 'newer',
          title: 'Newer',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 20,
        },
        {
          id: 'older',
          title: 'Older',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 10,
        },
      ],
    });

    await act(async () => {
      await useChatStore.getState().togglePin('older');
    });

    expect(db.toggleConversationPinned).toHaveBeenCalledWith('older');
    expect(
      useChatStore
        .getState()
        .conversations.map((conversation) => [conversation.id, conversation.pinned])
    ).toEqual([
      ['older', true],
      ['newer', false],
    ]);

    vi.mocked(db.toggleConversationPinned).mockResolvedValueOnce(false);
    await act(async () => {
      await useChatStore.getState().togglePin('older');
    });

    expect(
      useChatStore
        .getState()
        .conversations.map((conversation) => [conversation.id, conversation.pinned])
    ).toEqual([
      ['newer', false],
      ['older', false],
    ]);
  });

  it('clears an error only in its owning conversation slice', () => {
    const ownerA = { ...createEmptyConversationState(), error: 'A failed' };
    const ownerB = { ...createEmptyConversationState(), error: 'B failed' };
    useChatStore.setState({
      currentConversationId: 'owner-b',
      error: 'B failed',
      _convStates: new Map([
        ['owner-a', ownerA],
        ['owner-b', ownerB],
      ]),
    });

    useChatStore.getState().setError(null, 'owner-a');

    const state = useChatStore.getState();
    expect(state._convStates.get('owner-a')?.error).toBeNull();
    expect(state._convStates.get('owner-b')?.error).toBe('B failed');
    expect(state.error).toBe('B failed');
  });

  it('rejects switching to a conversation that is being deleted in another pane', async () => {
    let resolveDelete!: () => void;
    vi.mocked(db.deleteConversation).mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveDelete = resolve))
    );
    useChatStore.setState({
      currentConversationId: 'other',
      conversations: [
        {
          id: 'deleting',
          title: 'Deleting',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    const deletion = useChatStore.getState().deleteConversation('deleting');
    await expect(useChatStore.getState().switchConversation('deleting')).resolves.toBe('stale');
    expect(db.getMessages).not.toHaveBeenCalledWith('deleting');
    resolveDelete();
    await deletion;
  });
});
