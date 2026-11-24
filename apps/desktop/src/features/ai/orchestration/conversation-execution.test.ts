import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ConversationExecution,
  conversationExecution,
  resetConversationExecutionsForTests,
} from './conversation-execution';
import { createEmptyConversationState } from './chat-store-types';
import { setConversationState, type ChatStore, type ChatStoreSet } from './chat-runtime';

describe('conversation execution authority', () => {
  beforeEach(resetConversationExecutionsForTests);

  it('holds the claim until durable settlement and ignores a stale release', () => {
    const owner = new ConversationExecution();
    const first = owner.claim()!;
    owner.attachController(new AbortController());
    first.acceptTurn('first');
    first.release();
    expect(owner.claim()).toBeNull();
    expect(owner.projection()).toEqual({
      isLoading: true,
      isStreaming: false,
      activeTurnId: 'first',
    });
    owner.committed('first');
    first.release();
    const second = owner.claim()!;
    first.release();
    expect(second.isCurrent()).toBe(true);
  });

  it('rejects a provider event from the previous controller', () => {
    const owner = new ConversationExecution();
    const first = owner.claim()!;
    const stale = new AbortController();
    owner.attachController(stale);
    first.release();
    const second = owner.claim()!;
    const current = new AbortController();
    owner.attachController(current);
    second.acceptTurn('second');
    expect(owner.providerPhase(stale, 'streaming')).toBe(false);
    expect(owner.providerPhase(current, 'streaming')).toBe(true);
    expect(owner.projection()).toEqual({
      isLoading: true,
      isStreaming: true,
      activeTurnId: 'second',
    });
  });

  it('carries a pre-registration stop only within its own claim', () => {
    const owner = new ConversationExecution();
    const first = owner.claim()!;
    expect(owner.cancel('user_stop')).toBe(true);
    const controller = new AbortController();
    owner.attachController(controller);
    expect(controller.signal.reason).toBe('user_stop');
    first.release();
    owner.claim();
    const next = new AbortController();
    owner.attachController(next);
    expect(next.signal.aborted).toBe(false);
  });

  it('keeps queue drain ownership and advancement local to a conversation', () => {
    const first = new ConversationExecution();
    const second = new ConversationExecution();
    const release = first.beginDrain()!;
    expect(first.beginDrain()).toBeNull();
    expect(second.beginDrain()).not.toBeNull();
    first.requestAdvance('message-2');
    expect(second.target).toBeNull();
    release();
    first.beginDrain();
    release();
    expect(first.isDraining).toBe(true);
  });

  it('settles first-message waiters only for their own conversation and submission', async () => {
    const owner = new ConversationExecution();
    const other = new ConversationExecution();
    const accepted = owner.beginFirstMessage();
    const first = owner.pendingFirstMessage;
    accepted(true);
    await expect(first).resolves.toBe(true);
    expect(owner.pendingFirstMessage).toBeUndefined();

    const rejected = owner.beginFirstMessage();
    const second = owner.pendingFirstMessage;
    const otherAccepted = other.beginFirstMessage();
    const otherWaiter = other.pendingFirstMessage;
    accepted(true);
    expect(owner.pendingFirstMessage).toBe(second);
    owner.markDeleted();
    owner.restoreAfterRejectedDelete();
    expect(owner.pendingFirstMessage).toBe(second);
    owner.disposeQueue();
    rejected(true);
    await expect(second).resolves.toBe(false);
    expect(owner.pendingFirstMessage).toBeUndefined();
    expect(other.pendingFirstMessage).toBe(otherWaiter);
    otherAccepted(true);
    await expect(otherWaiter).resolves.toBe(true);
  });

  it('derives active flags even when a caller submits an inconsistent projection', () => {
    const owner = conversationExecution('conversation');
    const claim = owner.claim()!;
    const controller = new AbortController();
    owner.attachController(controller);
    claim.acceptTurn('turn');
    owner.providerPhase(controller, 'streaming');
    let state = {
      currentConversationId: 'conversation',
      _convStates: new Map([['conversation', createEmptyConversationState()]]),
    } as ChatStore;
    const set: ChatStoreSet = (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    setConversationState(set, 'conversation', () => ({
      isLoading: false,
      isStreaming: false,
      activeTurnId: 'wrong',
    }));
    expect(state).toMatchObject({ isLoading: true, isStreaming: true, activeTurnId: 'turn' });
    expect(state._convStates.get('conversation')).toMatchObject({
      isLoading: true,
      isStreaming: true,
      activeTurnId: 'turn',
    });
  });

  it('routes provider phase changes and queue ownership through the shared owner', () => {
    const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
    for (const name of [
      'execute-cli-turn.ts',
      'execute-hosted-turn.ts',
      'execute-hosted-codex-turn.ts',
    ]) {
      expect(source(name)).not.toMatch(/is(?:Streaming|Loading):\s*(?:true|false)/);
      expect(source(name)).toContain('chatProviderPhase(');
    }
    expect(source('chat-queue.ts')).not.toMatch(/(?:const|let)\s+\w+\s*=\s*new (?:Set|Map)/);
    expect(source('run-chat-turn.ts')).toContain('callbacksOpen && sendClaim.isCurrent()');
  });
});
