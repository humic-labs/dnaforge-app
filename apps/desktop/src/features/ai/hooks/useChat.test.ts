import { userMessage } from '@waypoint/user-messages';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEmptyConversationState,
  db,
  resetUseChatConversationHarness,
  useChatStore,
} from '../../../test/ai/useChat-harness';
import {
  beginActiveConversationSelection,
  replaceConversationState,
} from '../orchestration/chat-runtime';

function actionDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function persistedHistoryRow(id: string, title = id, pinned = 0, updatedAt = 1) {
  return {
    id,
    title,
    pinned,
    workspace_path: `/${id}`,
    provider: null,
    model: null,
    created_at: 1,
    updated_at: updatedAt,
  };
}

describe('useChat history read ownership  H3)', () => {
  beforeEach(() => {
    resetUseChatConversationHarness();
    vi.mocked(db.getConversationHistory).mockReset().mockResolvedValue([]);
    vi.mocked(db.updateConversation).mockReset().mockResolvedValue(undefined);
    vi.mocked(db.toggleConversationPinned).mockReset().mockResolvedValue(true);
    vi.mocked(db.deleteConversation).mockReset().mockResolvedValue(undefined);
  });

  it('owns history idle/loading/ready separately from streaming and retains the active pane and draft', async () => {
    const read = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory).mockReturnValueOnce(read.promise);
    const draft = { text: 'Private unsent draft', attachments: [], references: [] };
    useChatStore.setState({
      currentConversationId: 'visible-pane',
      composerDrafts: new Map([['visible-pane', draft]]),
    });
    const before = useChatStore.getState();
    expect(before.conversationHistoryRead).toEqual({ status: 'idle', hasLoaded: false });
    const pending = before.loadConversations();
    expect(useChatStore.getState().conversationHistoryRead).toEqual({
      status: 'loading',
      hasLoaded: false,
    });
    expect(useChatStore.getState().isLoading).toBe(before.isLoading);
    expect(useChatStore.getState().currentConversationId).toBe('visible-pane');
    read.resolve([persistedHistoryRow('other-workspace')]);
    await pending;
    const state = useChatStore.getState();
    expect(state.conversationHistoryRead).toEqual({ status: 'ready', hasLoaded: true });
    expect(state.currentConversationId).toBe('visible-pane');
    expect(state.composerDrafts.get('visible-pane')).toBe(draft);
    expect(state.messages).toBe(before.messages);
    expect(state._convStates).toBe(before._convStates);
    expect(db.getConversationHistory).toHaveBeenCalledWith();
  });

  it('propagates the actual first-read rejection without claiming a confirmed empty list or storing private error text', async () => {
    const failure = new Error('private native history diagnostic');
    vi.mocked(db.getConversationHistory).mockRejectedValueOnce(failure);
    await expect(useChatStore.getState().loadConversations()).rejects.toBe(failure);
    expect(useChatStore.getState().conversationHistoryRead).toEqual({
      status: 'error',
      hasLoaded: false,
    });
    expect(useChatStore.getState().conversations).toEqual([]);
    expect(useChatStore.getState().error).toBeNull();
    expect(JSON.stringify(useChatStore.getState().conversationHistoryRead)).not.toContain(
      failure.message
    );
  });

  it('retains confirmed rows and pin/activity order after refresh failure and recovers through the real read action', async () => {
    const saved = [
      persistedHistoryRow('unpinned-new', 'New', 0, 30),
      persistedHistoryRow('pinned-old', 'Pinned', 1, 10),
    ];
    vi.mocked(db.getConversationHistory).mockResolvedValueOnce(saved);
    await useChatStore.getState().loadConversations();
    const rows = useChatStore.getState().conversations;
    vi.mocked(db.getConversationHistory).mockRejectedValueOnce(new Error('refresh refused'));
    await expect(useChatStore.getState().loadConversations()).rejects.toThrow('refresh refused');
    expect(useChatStore.getState().conversationHistoryRead).toEqual({
      status: 'error',
      hasLoaded: true,
    });
    expect(useChatStore.getState().conversations).toBe(rows);
    expect(rows.map((c) => c.id)).toEqual(['pinned-old', 'unpinned-new']);
    vi.mocked(db.getConversationHistory).mockResolvedValueOnce([
      ...saved,
      persistedHistoryRow('arrived', 'Arrived', 0, 50),
    ]);
    await useChatStore.getState().loadConversations();
    expect(useChatStore.getState().conversationHistoryRead).toEqual({
      status: 'ready',
      hasLoaded: true,
    });
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual([
      'pinned-old',
      'arrived',
      'unpinned-new',
    ]);
  });

  it('does not let an older success replace a newer success or its read status', async () => {
    const old = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([persistedHistoryRow('new')]);
    const pending = useChatStore.getState().loadConversations();
    await useChatStore.getState().loadConversations();
    const ready = useChatStore.getState().conversationHistoryRead;
    old.resolve([persistedHistoryRow('old')]);
    await pending;
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['new']);
    expect(useChatStore.getState().conversationHistoryRead).toBe(ready);
  });

  it('propagates an older failure only to its caller after a newer success', async () => {
    const old = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([persistedHistoryRow('new')]);
    const pending = useChatStore.getState().loadConversations();
    const failure = new Error('obsolete read refusal');
    const rejected = expect(pending).rejects.toBe(failure);
    await useChatStore.getState().loadConversations();
    const ready = useChatStore.getState().conversationHistoryRead;
    old.reject(failure);
    await rejected;
    expect(useChatStore.getState().conversationHistoryRead).toBe(ready);
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['new']);
  });

  it('cannot clear a newer error or claim successful empty from an older success', async () => {
    const old = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory)
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error('current refused'));
    const pending = useChatStore.getState().loadConversations();
    await expect(useChatStore.getState().loadConversations()).rejects.toThrow('current refused');
    const failed = useChatStore.getState().conversationHistoryRead;
    old.resolve([persistedHistoryRow('obsolete')]);
    await pending;
    expect(useChatStore.getState().conversationHistoryRead).toBe(failed);
    expect(failed).toEqual({ status: 'error', hasLoaded: false });
    expect(useChatStore.getState().conversations).toEqual([]);
  });

  it('does not resettle the latest error when an older error arrives', async () => {
    const old = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory)
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error('latest refusal'));
    const pending = useChatStore.getState().loadConversations();
    const rejected = expect(pending).rejects.toThrow('older refusal');
    await expect(useChatStore.getState().loadConversations()).rejects.toThrow('latest refusal');
    const failed = useChatStore.getState().conversationHistoryRead;
    old.reject(new Error('older refusal'));
    await rejected;
    expect(useChatStore.getState().conversationHistoryRead).toBe(failed);
  });

  it('keeps the current read loading when an obsolete success returns first', async () => {
    const a = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    const b = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const first = useChatStore.getState().loadConversations();
    const second = useChatStore.getState().loadConversations();
    a.resolve([persistedHistoryRow('old')]);
    await first;
    expect(useChatStore.getState().conversationHistoryRead).toEqual({
      status: 'loading',
      hasLoaded: false,
    });
    expect(useChatStore.getState().conversations).toEqual([]);
    b.resolve([]);
    await second;
    expect(useChatStore.getState().conversationHistoryRead).toEqual({
      status: 'ready',
      hasLoaded: true,
    });
  });

  it('merges a delayed read without undoing acknowledged New, Rename, Pin, Delete or a newer pane/draft', async () => {
    const saved = ['a', 'b', 'c'].map((id) => persistedHistoryRow(id));
    vi.mocked(db.getConversationHistory).mockResolvedValueOnce(saved);
    await useChatStore.getState().loadConversations();
    useChatStore.setState({
      currentConversationId: 'b',
      _convStates: new Map([['b', createEmptyConversationState()]]),
      composerDrafts: new Map([
        ['b', { text: 'Retained B draft', attachments: [], references: [] }],
      ]),
    });
    const read = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory).mockReturnValueOnce(read.promise);
    const pending = useChatStore.getState().loadConversations();
    await useChatStore.getState().renameConversation('b', 'Manual B');
    await useChatStore.getState().togglePin('c');
    await useChatStore.getState().deleteConversation('a');
    const created = await useChatStore
      .getState()
      .newConversation('/new', { force: true, sourceConversationId: null });
    const before = useChatStore.getState();
    read.resolve(saved);
    await pending;
    const state = useChatStore.getState();
    expect(state.conversations.some((c) => c.id === 'a')).toBe(false);
    expect(state.conversations.find((c) => c.id === 'b')?.title).toBe('Manual B');
    expect(state.conversations.find((c) => c.id === 'c')?.pinned).toBe(true);
    expect(state.conversations.some((c) => c.id === created)).toBe(true);
    expect(state.currentConversationId).toBe(created);
    expect(state.composerDrafts).toBe(before.composerDrafts);
    expect(state.messages).toBe(before.messages);
    expect(state._convStates).toBe(before._convStates);
  });

  it('excludes a tombstoned loaded row that was first created after this read started', async () => {
    const read = actionDeferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory).mockReturnValueOnce(read.promise);
    const pending = useChatStore.getState().loadConversations();
    const created = await useChatStore
      .getState()
      .newConversation(null, { force: true, sourceConversationId: null });
    await db.addMessage({
      id: 'synthetic-durable-message',
      conversation_id: created,
      turn_id: null,
      role: 'user',
      content: 'Synthetic persisted history row',
      tool_name: null,
      tool_call_id: null,
      created_at: 1,
    });
    await useChatStore.getState().deleteConversation(created);
    read.resolve([persistedHistoryRow(created)]);
    await pending;
    expect(useChatStore.getState().conversations).toEqual([]);
    expect(useChatStore.getState()._convStates.has(created)).toBe(false);
    expect(useChatStore.getState().conversationHistoryRead).toEqual({
      status: 'ready',
      hasLoaded: true,
    });
  });

  it('retains the existing pending-delete projection if a successful refresh precedes a rejected delete', async () => {
    const saved = persistedHistoryRow('delete-read-a', 'Confirmed A');
    vi.mocked(db.getConversationHistory).mockResolvedValue([saved]);
    await useChatStore.getState().loadConversations();
    const deletion = actionDeferred<void>();
    vi.mocked(db.deleteConversation).mockReturnValueOnce(deletion.promise);
    const pending = useChatStore.getState().deleteConversation('delete-read-a');
    const rejected = expect(pending).rejects.toThrow('delete refused');
    await useChatStore.getState().loadConversations();
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['delete-read-a']);
    deletion.reject(new Error('delete refused'));
    await rejected;
    expect(useChatStore.getState().conversations.map((c) => c.title)).toEqual(['Confirmed A']);
    expect(useChatStore.getState().conversationHistoryRead).toEqual({
      status: 'ready',
      hasLoaded: true,
    });
  });
});

function seedActionHistory() {
  useChatStore.setState({
    currentConversationId: 'action-b',
    conversations: [
      {
        id: 'action-b',
        title: 'Confirmed B',
        workspacePath: '/b',
        pinned: false,
        provider: null,
        model: null,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 'action-a',
        title: 'Confirmed A',
        workspacePath: '/a',
        pinned: false,
        provider: null,
        model: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    _convStates: new Map([
      ['action-a', createEmptyConversationState()],
      ['action-b', createEmptyConversationState()],
    ]),
  });
}

describe('useChat ordered history actions  H2)', () => {
  beforeEach(() => {
    resetUseChatConversationHarness();
    vi.mocked(db.updateConversation).mockReset().mockResolvedValue(undefined);
    vi.mocked(db.toggleConversationPinned).mockReset().mockResolvedValue(true);
    vi.mocked(db.deleteConversation).mockReset().mockResolvedValue(undefined);
    seedActionHistory();
  });

  it('propagates the actual rename rejection, preserves confirmed state, and permits explicit retry', async () => {
    const failure = new Error('synthetic native rename failure');
    vi.mocked(db.updateConversation).mockRejectedValueOnce(failure);
    await expect(useChatStore.getState().renameConversation('action-a', 'Intended A')).rejects.toBe(
      failure
    );
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-a')?.title).toBe(
      'Confirmed A'
    );
    await useChatStore.getState().renameConversation('action-a', 'Intended A');
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-a')?.title).toBe(
      'Intended A'
    );
    expect(db.updateConversation).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().currentConversationId).toBe('action-b');
  });

  it('orders accepted same-row rename writes while another row remains independent', async () => {
    const first = actionDeferred<void>();
    vi.mocked(db.updateConversation).mockImplementation((id, title) =>
      id === 'action-a' && title === 'A first' ? first.promise : Promise.resolve()
    );
    const a1 = useChatStore.getState().renameConversation('action-a', 'A first');
    const a2 = useChatStore.getState().renameConversation('action-a', 'A second');
    await useChatStore.getState().renameConversation('action-b', 'B independent');
    expect(vi.mocked(db.updateConversation).mock.calls).toEqual([
      ['action-a', 'A first'],
      ['action-b', 'B independent'],
    ]);
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-b')?.title).toBe(
      'B independent'
    );
    first.resolve();
    await Promise.all([a1, a2]);
    expect(vi.mocked(db.updateConversation).mock.calls.at(-1)).toEqual(['action-a', 'A second']);
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-a')?.title).toBe(
      'A second'
    );
  });

  it('serializes two accepted surface callers around the real lower read-before-write shape', async () => {
    const gate = actionDeferred<void>();
    const nativePins = new Map([
      ['action-a', false],
      ['action-b', false],
    ]);
    let first = true;
    vi.mocked(db.toggleConversationPinned).mockImplementation(async (id) => {
      const pinnedAtRead = nativePins.get(id) ?? false;
      if (id === 'action-a' && first) {
        first = false;
        await gate.promise;
      }
      nativePins.set(id, !pinnedAtRead);
      return !pinnedAtRead;
    });
    const surfaceA = useChatStore.getState().togglePin;
    const surfaceB = useChatStore.getState().togglePin;
    const a1 = surfaceA('action-a');
    const a2 = surfaceB('action-a');
    await surfaceB('action-b');
    expect(vi.mocked(db.toggleConversationPinned).mock.calls).toEqual([['action-a'], ['action-b']]);
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-a')?.pinned).toBe(
      false
    );
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-b')?.pinned).toBe(
      true
    );
    gate.resolve();
    await Promise.all([a1, a2]);
    expect(nativePins.get('action-a')).toBe(false);
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-a')?.pinned).toBe(
      false
    );
    expect(db.toggleConversationPinned).toHaveBeenCalledTimes(3);
    expect(useChatStore.getState().currentConversationId).toBe('action-b');
  });

  it('returns a pin failure to its caller and releases the next accepted action without implicit retry', async () => {
    const gate = actionDeferred<boolean>();
    const failure = new Error('synthetic native pin failure');
    vi.mocked(db.toggleConversationPinned)
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(true);
    const first = useChatStore.getState().togglePin('action-a');
    const rejected = expect(first).rejects.toBe(failure);
    const second = useChatStore.getState().togglePin('action-a');
    expect(db.toggleConversationPinned).toHaveBeenCalledOnce();
    gate.reject(failure);
    await rejected;
    await second;
    expect(db.toggleConversationPinned).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-a')?.pinned).toBe(
      true
    );
  });

  it('preserves confirmed pin state after refusal and permits an explicit retry', async () => {
    const failure = new Error('synthetic native pin refusal');
    vi.mocked(db.toggleConversationPinned).mockRejectedValueOnce(failure);
    await expect(useChatStore.getState().togglePin('action-a')).rejects.toBe(failure);
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-a')?.pinned).toBe(
      false
    );
    await useChatStore.getState().togglePin('action-a');
    expect(useChatStore.getState().conversations.find((c) => c.id === 'action-a')?.pinned).toBe(
      true
    );
    expect(db.toggleConversationPinned).toHaveBeenCalledTimes(2);
  });

  it('publishes a completed pin from fresh state without undoing another row rename', async () => {
    const gate = actionDeferred<boolean>();
    vi.mocked(db.toggleConversationPinned).mockReturnValueOnce(gate.promise);
    const pin = useChatStore.getState().togglePin('action-a');
    await useChatStore.getState().renameConversation('action-b', 'Later B');
    gate.resolve(true);
    await pin;
    expect(
      useChatStore.getState().conversations.map((c) => [c.id, c.title, c.pinned, c.workspacePath])
    ).toEqual([
      ['action-a', 'Confirmed A', true, '/a'],
      ['action-b', 'Later B', false, '/b'],
    ]);
  });

  it('does not resurrect a deleted row or start its queued pin after delayed native writes return', async () => {
    const renameGate = actionDeferred<void>();
    const pinGate = actionDeferred<boolean>();
    vi.mocked(db.updateConversation).mockReturnValueOnce(renameGate.promise);
    vi.mocked(db.toggleConversationPinned).mockReturnValueOnce(pinGate.promise);
    const rename = useChatStore.getState().renameConversation('action-a', 'Deleted A');
    const pin = useChatStore.getState().togglePin('action-a');
    const queuedPin = useChatStore.getState().togglePin('action-a');
    await useChatStore.getState().deleteConversation('action-a');
    renameGate.resolve();
    pinGate.resolve(true);
    await Promise.all([rename, pin, queuedPin]);
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['action-b']);
    expect(useChatStore.getState()._convStates.has('action-a')).toBe(false);
    expect(useChatStore.getState().currentConversationId).toBe('action-b');
    expect(db.toggleConversationPinned).toHaveBeenCalledOnce();
  });
});

describe('useChat conversation history', () => {
  beforeEach(resetUseChatConversationHarness);

  it.each(['failed', 'completed', 'stopped', 'cancelled', 'interrupted'] as const)(
    'restores only the newest failed turn error when the latest turn is %s',
    async (status) => {
      const turn = (id: string, started_at: number, state: typeof status) => ({
        id,
        conversation_id: 'saved-error',
        route_kind: 'hosted',
        host_id: 'dnaforge-hosted-auto',
        provider: null,
        model: null,
        transport: 'responses',
        authority_profile_id: null,
        permission_mode: null,
        route_snapshot_json: '{}',
        status: state,
        terminal_reason: state === 'failed' ? 'hosted:app_server_unavailable' : state,
        error: state === 'failed' ? `Saved failure ${id}` : null,
        started_at,
        completed_at: started_at + 1,
      });
      vi.mocked(db.getChatTurns).mockResolvedValue([
        turn('latest', 200, status),
        turn('old', 100, 'failed'),
      ]);
      vi.mocked(db.getMessages).mockResolvedValue([]);
      await act(async () => {
        await useChatStore.getState().switchConversation('saved-error');
      });
      expect(useChatStore.getState().error).toBe(
        status === 'failed' ? userMessage('assistant.failed') : null
      );
      expect(useChatStore.getState()._convStates.get('saved-error')?.error).toBe(
        status === 'failed' ? userMessage('assistant.failed') : null
      );
    }
  );

  it('loads populated history across workspace boundaries', async () => {
    vi.mocked(db.getConversationHistory).mockResolvedValue([
      {
        id: 'c1',
        title: 'Conv 1',
        workspace_path: '/other-workspace',
        pinned: 0,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        created_at: 1000,
        updated_at: 2000,
      },
      {
        id: 'c2',
        title: 'Conv 2',
        workspace_path: '/ws',
        pinned: 1,
        provider: 'openai',
        model: 'gpt-4o',
        created_at: 1000,
        updated_at: 3000,
      },
    ]);

    await act(async () => {
      await useChatStore.getState().loadConversations();
    });

    expect(useChatStore.getState().conversations).toHaveLength(2);
    expect(db.getConversationHistory).toHaveBeenCalledOnce();
  });

  it('lets the latest app-wide history load win when an earlier SQLite read resolves later', async () => {
    let resolveFirstRead!: (rows: Awaited<ReturnType<typeof db.getConversationHistory>>) => void;
    vi.mocked(db.getConversationHistory)
      .mockImplementationOnce(
        () =>
          new Promise<Awaited<ReturnType<typeof db.getConversationHistory>>>((resolve) => {
            resolveFirstRead = resolve;
          })
      )
      .mockResolvedValueOnce([
        {
          id: 'workspace-b',
          title: 'Workspace B',
          workspace_path: '/b',
          pinned: 0,
          provider: null,
          model: null,
          created_at: 1,
          updated_at: 1,
        },
      ]);

    const firstLoad = useChatStore.getState().loadConversations();
    await useChatStore.getState().loadConversations();
    resolveFirstRead([
      {
        id: 'workspace-a',
        title: 'Workspace A',
        workspace_path: '/a',
        pinned: 0,
        provider: null,
        model: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    await firstLoad;

    expect(useChatStore.getState().conversations.map((conversation) => conversation.id)).toEqual([
      'workspace-b',
    ]);
  });

  it('preserves a locally created conversation when a delayed history load resolves', async () => {
    let resolveHistory!: (rows: Awaited<ReturnType<typeof db.getConversationHistory>>) => void;
    vi.mocked(db.getConversationHistory).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.getConversationHistory>>>((resolve) => {
          resolveHistory = resolve;
        })
    );
    const load = useChatStore.getState().loadConversations();
    useChatStore.setState({
      conversations: [
        {
          id: 'new-local',
          title: 'New local',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });
    resolveHistory([
      {
        id: 'existing-db',
        title: 'Existing DB',
        workspace_path: '/ws',
        pinned: 0,
        provider: null,
        model: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    await load;

    expect(useChatStore.getState().conversations.map((conversation) => conversation.id)).toEqual([
      'new-local',
      'existing-db',
    ]);
  });

  it('loads conversation history on switchConversation', async () => {
    vi.mocked(db.getMessages).mockResolvedValue([
      {
        id: 'm1',
        conversation_id: 'c1',
        turn_id: 'turn-direct-api',
        role: 'user',
        content: 'Hello',
        tool_name: null,
        tool_call_id: null,
        created_at: 1000,
      },
      {
        id: 'm2',
        conversation_id: 'c1',
        turn_id: 'turn-direct-api',
        role: 'assistant',
        content: 'Hi!',
        tool_name: null,
        tool_call_id: null,
        created_at: 2000,
      },
    ]);
    vi.mocked(db.getChatTurns).mockResolvedValue([
      {
        id: 'turn-direct-api',
        conversation_id: 'c1',
        route_kind: 'provider',
        host_id: 'direct-api',
        provider: 'openai',
        model: 'gpt-4o-mini',
        transport: null,
        authority_profile_id: null,
        permission_mode: null,
        route_snapshot_json: JSON.stringify({
          kind: 'provider',
          provider: 'openai',
          model: 'gpt-4o-mini',
        }),
        status: 'completed',
        terminal_reason: 'completed',
        error: null,
        started_at: 1000,
        completed_at: 2500,
      },
    ]);

    useChatStore.setState({
      conversations: [
        {
          id: 'c1',
          title: 'Test',
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
      await useChatStore.getState().switchConversation('c1');
    });

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('c1');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].turnId).toBe('turn-direct-api');
    expect(state.turns['turn-direct-api']).toMatchObject({
      hostId: 'direct-api',
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'completed',
    });
    expect(state.messages[0].content).toBe('Hello');
  });

  it('keeps the previous conversation slice when another split pane becomes active', async () => {
    const left = {
      ...createEmptyConversationState(),
      messages: [{ id: 'left-message', role: 'user' as const, content: 'Left', createdAt: 1 }],
    };
    const right = {
      ...createEmptyConversationState(),
      messages: [{ id: 'right-message', role: 'user' as const, content: 'Right', createdAt: 2 }],
    };
    useChatStore.setState({
      currentConversationId: 'left',
      messages: left.messages,
      conversations: [
        {
          id: 'left',
          title: 'Left',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'right',
          title: 'Right',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      _convStates: new Map([
        ['left', left],
        ['right', right],
      ]),
    });

    await useChatStore.getState().switchConversation('right');

    expect(useChatStore.getState()._convStates.get('left')?.messages).toEqual(left.messages);
    expect(useChatStore.getState()._convStates.get('right')?.messages).toEqual(right.messages);
  });

  it('hydrateConversation loads history into _convStates WITHOUT claiming the global active pointer  #49)', async () => {
    vi.mocked(db.getMessages).mockResolvedValue([
      {
        id: 'm1',
        conversation_id: 'existing-c',
        turn_id: null,
        role: 'user',
        content: 'earlier question',
        tool_name: null,
        tool_call_id: null,
        created_at: 1000,
      },
      {
        id: 'm2',
        conversation_id: 'existing-c',
        turn_id: null,
        role: 'assistant',
        content: 'earlier answer',
        tool_name: null,
        tool_call_id: null,
        created_at: 2000,
      },
    ]);
    vi.mocked(db.getChatTurns).mockResolvedValue([]);

    useChatStore.setState({ currentConversationId: 'active-other' });

    await act(async () => {
      await useChatStore.getState().hydrateConversation('existing-c');
    });

    const state = useChatStore.getState();
    expect(state._convStates.get('existing-c')?.messages.map((m) => m.content)).toEqual([
      'earlier question',
      'earlier answer',
    ]);
    expect(state.currentConversationId).toBe('active-other');
  });

  it('coalesces concurrent hydration of the same cold conversation into one SQLite read', async () => {
    let resolveMessages!: (messages: Awaited<ReturnType<typeof db.getMessages>>) => void;
    vi.mocked(db.getMessages).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.getMessages>>>((resolve) => {
          resolveMessages = resolve;
        })
    );

    const first = useChatStore.getState().hydrateConversation('cold-conversation');
    const second = useChatStore.getState().hydrateConversation('cold-conversation');

    expect(db.getMessages).toHaveBeenCalledTimes(1);
    resolveMessages([]);
    await Promise.all([first, second]);

    expect(db.getChatTurns).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState()._convStates.has('cold-conversation')).toBe(true);
  });

  it('clears a rejected hydration operation so the next mount can retry', async () => {
    vi.mocked(db.getMessages)
      .mockRejectedValueOnce(new Error('transient SQLite failure'))
      .mockResolvedValueOnce([]);

    await expect(useChatStore.getState().hydrateConversation('retry-conversation')).rejects.toThrow(
      'transient SQLite failure'
    );
    await expect(
      useChatStore.getState().hydrateConversation('retry-conversation')
    ).resolves.toBeUndefined();

    expect(db.getMessages).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState()._convStates.has('retry-conversation')).toBe(true);
  });

  it('does not let a slow history switch override a newer selection reserved by another chat action', async () => {
    let resolveMessages!: (messages: Awaited<ReturnType<typeof db.getMessages>>) => void;
    vi.mocked(db.getMessages).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.getMessages>>>((resolve) => {
          resolveMessages = resolve;
        })
    );

    const switching = useChatStore.getState().switchConversation('slow-history');
    await vi.waitFor(() => expect(db.getMessages).toHaveBeenCalledWith('slow-history'));

    const visibleSendState = {
      ...createEmptyConversationState(),
      messages: [
        { id: 'newer-message', role: 'user' as const, content: 'Newer intent', createdAt: 2 },
      ],
    };
    const newerSelection = beginActiveConversationSelection();
    replaceConversationState(useChatStore.setState, 'newer-visible-chat', visibleSendState, {
      activate: true,
      selectionVersion: newerSelection,
    });

    resolveMessages([]);
    await expect(switching).resolves.toBe('available');

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('newer-visible-chat');
    expect(state.messages.map((message) => message.id)).toEqual(['newer-message']);
    expect(state._convStates.has('slow-history')).toBe(true);
  });

  it('hydrates an abandoned running turn as interrupted without dropping partial messages', async () => {
    vi.mocked(db.getMessages).mockResolvedValue([
      {
        id: 'partial-1',
        conversation_id: 'existing-c',
        turn_id: 'turn-running',
        role: 'assistant',
        content: 'Durable partial answer',
        tool_name: null,
        tool_call_id: null,
        created_at: 2000,
      },
    ]);
    vi.mocked(db.getChatTurns).mockResolvedValue([
      {
        id: 'turn-running',
        conversation_id: 'existing-c',
        route_kind: 'provider',
        host_id: 'direct-api',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        transport: null,
        authority_profile_id: null,
        permission_mode: null,
        route_snapshot_json: '{}',
        status: 'running',
        terminal_reason: null,
        error: null,
        started_at: 1000,
        completed_at: null,
      },
    ]);

    await act(async () => {
      await useChatStore.getState().hydrateConversation('existing-c');
    });

    expect(db.commitChatTurnTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({
        turn_id: 'turn-running',
        conversation_id: 'existing-c',
        status: 'interrupted',
        messages: [],
      })
    );
    expect(useChatStore.getState()._convStates.get('existing-c')).toMatchObject({
      messages: [expect.objectContaining({ content: 'Durable partial answer' })],
      turns: {
        'turn-running': expect.objectContaining({ status: 'interrupted' }),
      },
      activeTurnId: null,
    });
  });

  it('hydrateConversation is a no-op when the conversation slice already exists (never clobbers live state)', async () => {
    const live = {
      messages: [
        {
          id: 'live-1',
          role: 'assistant' as const,
          content: 'LIVE streaming content',
          createdAt: 5,
        },
      ],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: true,
      error: null,
    };
    useChatStore.setState({ _convStates: new Map([['live-c', live]]) });
    vi.mocked(db.getMessages).mockResolvedValue([
      {
        id: 'stale',
        conversation_id: 'live-c',
        turn_id: null,
        role: 'user',
        content: 'STALE from DB',
        tool_name: null,
        tool_call_id: null,
        created_at: 1,
      },
    ]);

    await act(async () => {
      await useChatStore.getState().hydrateConversation('live-c');
    });

    expect(useChatStore.getState()._convStates.get('live-c')?.messages[0].content).toBe(
      'LIVE streaming content'
    );
  });

  it('selects live target state that appears while switch history is loading', async () => {
    let resolveMessages!: (messages: Awaited<ReturnType<typeof db.getMessages>>) => void;
    vi.mocked(db.getMessages).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof db.getMessages>>>((resolve) => {
          resolveMessages = resolve;
        })
    );
    useChatStore.setState({
      currentConversationId: 'source',
      conversations: [
        {
          id: 'target',
          title: 'Target',
          workspacePath: '/ws',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    const switching = useChatStore.getState().switchConversation('target');
    await vi.waitFor(() => expect(db.getMessages).toHaveBeenCalledWith('target'));
    const liveTarget = {
      ...createEmptyConversationState(),
      messages: [
        { id: 'live-target-message', role: 'user' as const, content: 'Live', createdAt: 2 },
      ],
      isLoading: true,
    };
    useChatStore.setState((state) => ({
      _convStates: new Map([...state._convStates, ['target', liveTarget]]),
    }));
    resolveMessages([]);
    await switching;

    const state = useChatStore.getState();
    expect(state.currentConversationId).toBe('target');
    expect(state.messages.map((message) => message.id)).toEqual(['live-target-message']);
    expect(state.isLoading).toBe(true);
  });

  it('converts DB messages to Vercel AI SDK format', async () => {
    vi.mocked(db.getMessages).mockResolvedValue([
      {
        id: 'm1',
        conversation_id: 'c1',
        role: 'user',
        content: 'List files',
        tool_name: null,
        tool_call_id: null,
        created_at: 1000,
      },
      {
        id: 'm2',
        conversation_id: 'c1',
        role: 'assistant',
        content: '',
        tool_name: null,
        tool_call_id: null,
        created_at: 2000,
      },
      {
        id: 'm3',
        conversation_id: 'c1',
        role: 'tool',
        content: JSON.stringify({
          input: { path: '.' },
          output: { entries: [] },
          isError: false,
        }),
        tool_name: 'list_files',
        tool_call_id: 'tc-1',
        created_at: 3000,
      },
      {
        id: 'm4',
        conversation_id: 'c1',
        role: 'assistant',
        content: 'No files found.',
        tool_name: null,
        tool_call_id: null,
        created_at: 4000,
      },
    ]);

    useChatStore.setState({
      conversations: [
        {
          id: 'c1',
          title: 'Test',
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
      await useChatStore.getState().switchConversation('c1');
    });

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(4);
    expect(state.messages[2].role).toBe('tool');
    expect(state.messages[2].toolName).toBe('list_files');
  });
});
