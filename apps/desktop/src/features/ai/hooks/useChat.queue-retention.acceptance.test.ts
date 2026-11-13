import { setImmediate as yieldTurn } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyConversationState,
  db,
  resetUseChatConversationHarness,
  useChatStore,
} from '../../../test/ai/useChat-harness';

setFlagsFromString('--expose_gc');
const collect: () => void = runInNewContext('gc');

function installConversations(...ids: string[]) {
  useChatStore.setState({
    currentConversationId: ids[0],
    conversations: ids.map((id) => ({
      id,
      title: id,
      workspacePath: '/workspace',
      pinned: false,
      provider: null,
      model: null,
      createdAt: 0,
      updatedAt: 0,
    })),
    _convStates: new Map(
      ids.map((id) => [id, { ...createEmptyConversationState(), isLoading: true }])
    ),
  });
}

async function queueCallbacks(conversationId: string, called: string[]) {
  const onStarted = () => {
    called.push(`${conversationId}:started`);
  };
  const onNotStarted = () => {
    called.push(`${conversationId}:not-started`);
  };
  const references = [new WeakRef(onStarted), new WeakRef(onNotStarted)];
  expect(
    await useChatStore
      .getState()
      .sendMessage('queued tail', '/workspace', conversationId, [], { onStarted, onNotStarted })
  ).toBe('accepted');
  return references;
}

async function sweep() {
  const collectibleControl = new WeakRef({ control: 'unowned callback fixture' });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await yieldTurn();
    collect();
  }
  expect(
    collectibleControl.deref(),
    'the isolated collection control must be collectible'
  ).toBeUndefined();
}

describe(' conversation callback lifetime', () => {
  beforeEach(() => {
    resetUseChatConversationHarness();
    vi.mocked(db.deleteConversation).mockResolvedValue(undefined);
  });

  it('releases deleted conversation tail callbacks and retains another conversation callbacks', async () => {
    const called: string[] = [];
    installConversations('deleted-owner', 'retained-owner');
    const deleted = await queueCallbacks('deleted-owner', called);
    const retained = await queueCallbacks('retained-owner', called);
    await useChatStore.getState().deleteConversation('deleted-owner');
    expect(db.deleteConversation).toHaveBeenCalledWith('deleted-owner');
    await sweep();
    expect(deleted.map((reference) => reference.deref())).toEqual([undefined, undefined]);
    expect(retained.every((reference) => typeof reference.deref() === 'function')).toBe(true);
    expect(called).toEqual([]);
    await useChatStore.getState().deleteConversation('retained-owner');
  });

  it('retains queued callbacks when durable deletion fails', async () => {
    const called: string[] = [];
    installConversations('failed-delete-owner');
    const retained = await queueCallbacks('failed-delete-owner', called);
    const failure = new Error('conversation deletion refused');
    vi.mocked(db.deleteConversation).mockRejectedValueOnce(failure);
    await expect(useChatStore.getState().deleteConversation('failed-delete-owner')).rejects.toBe(
      failure
    );
    await sweep();
    expect(retained.every((reference) => typeof reference.deref() === 'function')).toBe(true);
    expect(called).toEqual([]);
    await useChatStore.getState().deleteConversation('failed-delete-owner');
  });
});
