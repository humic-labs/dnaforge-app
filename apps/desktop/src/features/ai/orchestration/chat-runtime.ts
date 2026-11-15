import {
  EMPTY_CONV_STATE,
  type ChatActions,
  type ChatState,
  type ConversationState,
} from './chat-store-types';
import {
  conversationExecution,
  claimConversationExecution,
  resetConversationExecutionsForTests,
  type ChatCancellationReason,
} from './conversation-execution';
export type { ChatCancellationReason } from './conversation-execution';

export type ChatStore = ChatState & ChatActions;
export type ChatStoreGet = () => ChatStore;
export type ChatStoreSet = (
  patch: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>)
) => void;

let activeConversationSelectionVersion = 0;

export function beginActiveConversationSelection(): number {
  activeConversationSelectionVersion += 1;
  return activeConversationSelectionVersion;
}

export function isLatestActiveConversationSelection(version: number): boolean {
  return version === activeConversationSelectionVersion;
}

export function markChatConversationDeleted(conversationId: string): void {
  conversationExecution(conversationId).markDeleted();
}

export function unmarkChatConversationDeleted(conversationId: string): void {
  conversationExecution(conversationId).restoreAfterRejectedDelete();
}

export function isChatConversationDeleted(conversationId: string): boolean {
  return conversationExecution(conversationId).isDeleted;
}

export function resetDeletedChatConversationsForTests(): void {
  resetConversationExecutionsForTests();
}

export function claimChatSend(key: string, conversationId = key) {
  return claimConversationExecution(key, conversationId);
}

export function isChatSendClaimed(key: string): boolean {
  return conversationExecution(key).isClaimed;
}

export function registerChatAbortController(
  conversationId: string,
  controller: AbortController
): void {
  conversationExecution(conversationId).attachController(controller);
}

export function cancelChatGeneration(
  conversationId: string,
  reason: ChatCancellationReason = 'unknown'
): boolean {
  return conversationExecution(conversationId).cancel(reason);
}

export function releaseChatAbortController(conversationId: string): void {
  conversationExecution(conversationId).detachController();
}

export function projectChatExecution(set: ChatStoreSet, conversationId: string): void {
  setConversationState(set, conversationId, () =>
    conversationExecution(conversationId).projection()
  );
}

export function chatProviderPhase(
  set: ChatStoreSet,
  conversationId: string,
  controller: AbortController,
  phase: 'streaming' | 'settling'
): void {
  setConversationState(set, conversationId, () => {
    const owner = conversationExecution(conversationId);
    return owner.providerPhase(controller, phase) ? owner.projection() : {};
  });
}

export function recoverOrphanedChatExecution(set: ChatStoreSet, conversationId: string): void {
  setConversationState(set, conversationId, () =>
    conversationExecution(conversationId).isClaimed
      ? {}
      : { isLoading: false, isStreaming: false, streamingBlocks: [] }
  );
}

function deriveExecutionProjection(
  conversationId: string,
  state: ConversationState
): ConversationState {
  const owner = conversationExecution(conversationId);
  const projection = owner.projection();
  return owner.isClaimed && projection.isLoading ? { ...state, ...projection } : state;
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
    next = deriveExecutionProjection(convId, next);
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
    if (isChatConversationDeleted(convId)) return {};
    const previous = { ...EMPTY_CONV_STATE, ...(state._convStates.get(convId) ?? {}) };
    const next = deriveExecutionProjection(convId, { ...previous, ...updater(previous) });
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
