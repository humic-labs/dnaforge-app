import type { ConversationState } from './chat-store-types';

export function mergeHydratedConversationState(
  hydrated: ConversationState,
  latest: ConversationState | undefined
): ConversationState {
  if (!latest) return hydrated;

  const hasLiveTranscript =
    latest.messages.length > 0 ||
    Object.keys(latest.turns).length > 0 ||
    latest.activeTurnId !== null ||
    latest.streamingBlocks.length > 0 ||
    latest.isLoading ||
    latest.isStreaming;

  const pending = new Map(hydrated.queuedMessages.map((message) => [message.id, message]));
  for (const message of latest.queuedMessages) pending.set(message.id, message);
  for (const message of latest.messages) pending.delete(message.id);

  return {
    ...hydrated,
    ...latest,
    queuedMessages: [...pending.values()],
    messages: hasLiveTranscript ? latest.messages : hydrated.messages,
    turns: hasLiveTranscript ? latest.turns : hydrated.turns,
    activeTurnId: hasLiveTranscript ? latest.activeTurnId : hydrated.activeTurnId,
    streamingBlocks: hasLiveTranscript ? latest.streamingBlocks : hydrated.streamingBlocks,
    error: hasLiveTranscript ? latest.error : (latest.error ?? hydrated.error),
  };
}
