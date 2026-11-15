import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  db,
  mockTextStream,
  resetUseChatConversationHarness,
  streamText,
  useChatStore,
} from '../../../test/ai/useChat-harness';
import { runChatTurn } from './run-chat-turn';
import { isChatSendClaimed } from './chat-runtime';

describe('conversation execution settlement', () => {
  beforeEach(resetUseChatConversationHarness);

  it('does not recreate a deleted active conversation when a provider completes late', async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const result = mockTextStream('Late deleted answer');
    const original = result.fullStream;
    result.fullStream = {
      async *[Symbol.asyncIterator]() {
        await delayed;
        yield* original;
      },
    } as typeof result.fullStream;
    vi.mocked(streamText).mockReturnValue(result as never);
    const conversationId = 'delete-active';
    const sending = runChatTurn(useChatStore.setState, useChatStore.getState, 'First turn', null, conversationId);
    await vi.waitFor(() => expect(streamText).toHaveBeenCalledOnce());
    await useChatStore.getState().deleteConversation(conversationId);
    release();
    await sending;
    expect(db.deleteConversation).toHaveBeenCalledWith(conversationId);
    expect(useChatStore.getState()._convStates.has(conversationId)).toBe(false);
    expect(db.commitChatTurnTerminalState).not.toHaveBeenCalled();
    expect(isChatSendClaimed(conversationId)).toBe(false);
  });

  it('retains the active execution when every terminal database commit fails', async () => {
    vi.mocked(streamText).mockReturnValue(mockTextStream('Finished response') as never);
    vi.mocked(db.commitChatTurnTerminalState).mockRejectedValue(new Error('Terminal disk write failed'));
    const conversationId = 'terminal-write-failure';
    await expect(runChatTurn(
      useChatStore.setState,
      useChatStore.getState,
      'Explain this sequence',
      null,
      conversationId
    )).rejects.toThrow('Terminal disk write failed');
    const conversation = useChatStore.getState()._convStates.get(conversationId)!;
    expect(conversation.activeTurnId).not.toBeNull();
    expect(conversation.turns[conversation.activeTurnId!].status).toBe('running');
    expect(conversation.isLoading).toBe(true);
    expect(conversation.isStreaming).toBe(false);
    expect(isChatSendClaimed(conversationId)).toBe(true);
    await expect(runChatTurn(
      useChatStore.setState,
      useChatStore.getState,
      'Do not overlap the uncommitted turn',
      null,
      conversationId
    )).resolves.toBe('not_started');
    expect(streamText).toHaveBeenCalledTimes(1);
  });
});
