import {
  EMPTY_CONV_STATE,
  type ChatActions,
  type ChatState,
  type ConversationState,
} from './chat-store-types';
import { createConversationSendLease } from './send-lease';

export type ChatStore = ChatState & ChatActions;
export type ChatStoreGet = () => ChatStore;
export type ChatStoreSet = (
  patch: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>)
) => void;

const abortControllers = new Map<string, AbortController>();
export type ChatCancellationReason =
  | 'user_stop'
  | 'queue_advance'
  | 'conversation_deleted'
  | 'unknown';
const pendingCancellationRequests = new Map<string, ChatCancellationReason>();
const deletedConversationIds = new Set<string>();
const chatSendLease = createConversationSendLease();
let activeConversationSelectionVersion = 0;

export function beginActiveConversationSelection(): number {
  activeConversationSelectionVersion += 1;
  return activeConversationSelectionVersion;
}

export function isLatestActiveConversationSelection(version: number): boolean {
  return version === activeConversationSelectionVersion;
}

export function markChatConversationDeleted(conversationId: string): void {
  deletedConversationIds.add(conversationId);
}

export function unmarkChatConversationDeleted(conversationId: string): void {
  deletedConversationIds.delete(conversationId);
}

export function isChatConversationDeleted(conversationId: string): boolean {
  return deletedConversationIds.has(conversationId);
}

export function resetDeletedChatConversationsForTests(): void {
  deletedConversationIds.clear();
}

export function claimChatSend(key: string) {
  return chatSendLease.tryAcquire(key);
}

export function isChatSendClaimed(key: string): boolean {
  return chatSendLease.isClaimed(key);
}

export function registerChatAbortController(
  conversationId: string,
  controller: AbortController
): void {
  abortControllers.set(conversationId, controller);
  const pendingReason = pendingCancellationRequests.get(conversationId);
  pendingCancellationRequests.delete(conversationId);
  if (deletedConversationIds.has(conversationId) || pendingReason) {
    controller.abort(
      deletedConversationIds.has(conversationId) ? 'conversation_deleted' : pendingReason
    );
  }
}

export function cancelChatGeneration(
  conversationId: string,
  reason: ChatCancellationReason = 'unknown'
): boolean {
  const controller = abortControllers.get(conversationId);
  if (!controller) {
    if (!chatSendLease.isClaimed(conversationId)) return false;
    pendingCancellationRequests.set(conversationId, reason);
    return true;
  }
  controller.abort(reason);
  return true;
}

export function releaseChatAbortController(conversationId: string): void {
  abortControllers.delete(conversationId);
  pendingCancellationRequests.delete(conversationId);
}

function activeConversationProjection(next: ConversationState): Partial<ChatStore> {
  return {
    messages: next.messages,
    turns: next.turns,
    activeTurnId: next.activeTurnId,
    streamingBlocks: next.streamingBlocks,
    isLoading: next.isLoading,
    isStreaming: next.isStreaming,
    error: next.error,
    queuedMessages: next.queuedMessages,
  };
}

export function replaceConversationState(
  set: ChatStoreSet,
  convId: string,
  next: ConversationState,
  options: {
    activate?: boolean;
    selectionVersion?: number;
    installIfSelectionWasSuperseded?: boolean;
  } = {}
): boolean {
  let shouldActivate = options.activate === true;
  if (options.activate) {
    if (
      options.selectionVersion !== undefined &&
      !isLatestActiveConversationSelection(options.selectionVersion)
    ) {
      if (!options.installIfSelectionWasSuperseded) return false;
      shouldActivate = false;
    }
    if (options.selectionVersion === undefined) {
      beginActiveConversationSelection();
    }
  }
  set((state) => {
    const states = new Map(state._convStates);
    states.set(convId, next);
    const isActive = shouldActivate || state.currentConversationId === convId;
    return {
      _convStates: states,
      ...(shouldActivate ? { currentConversationId: convId } : {}),
      ...(isActive ? activeConversationProjection(next) : {}),
    };
  });
  return shouldActivate;
}

export function clearActiveConversationState(set: ChatStoreSet, selectionVersion: number): boolean {
  if (!isLatestActiveConversationSelection(selectionVersion)) return false;
  set({
    currentConversationId: null,
    ...activeConversationProjection(EMPTY_CONV_STATE),
  });
  return true;
}

export function clearConversationIfActive(set: ChatStoreSet, conversationId: string): boolean {
  let cleared = false;
  set((state) => {
    if (state.currentConversationId !== conversationId) return {};
    cleared = true;
    return {
      currentConversationId: null,
      ...activeConversationProjection(EMPTY_CONV_STATE),
    };
  });
  return cleared;
}

export function setConversationState(
  set: ChatStoreSet,
  convId: string,
  updater: (previous: ConversationState) => Partial<ConversationState>
): void {
  set((state) => {
    if (deletedConversationIds.has(convId)) return {};
    const previous = { ...EMPTY_CONV_STATE, ...(state._convStates.get(convId) ?? {}) };
    const next = { ...previous, ...updater(previous) };
    const states = new Map(state._convStates);
    states.set(convId, next);
    const isActive = state.currentConversationId === convId;
    return {
      _convStates: states,
      ...(isActive ? activeConversationProjection(next) : {}),
    };
  });
}

export function chatInterruptionReason(signal: AbortSignal): string {
  switch (signal.reason) {
    case 'user_stop':
      return 'Stopped by user.';
    case 'queue_advance':
      return 'Stopped for a queued follow-up.';
    case 'conversation_deleted':
      return 'Conversation deleted.';
    default:
      return 'Agent turn interrupted.';
  }
}
