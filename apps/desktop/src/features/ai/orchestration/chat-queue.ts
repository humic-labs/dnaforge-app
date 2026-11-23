import { isDesktopRuntime } from '../../../utils/environment';
import { persistQueuedMessage } from '../../../db/chat-message-queue';
import { captureCliModelSettings } from './cli-turn-model';
import {
  toUserMessage,
  userMessage,
  withUserMessage,
  userMessagePayload,
  userMessageValue,
} from '@waypoint/user-messages';
import {
  buildAssistantTurnRouteSnapshot,
  getAssistantRouteReadiness,
  getAssistantRouteReadinessLabel,
  type AssistantRouteSelection,
  type AssistantTurnRouteSnapshot,
} from '../assistant-routes';
import {
  resolveAssistantSendRoute,
  type AssistantSendRouteResolution,
} from '../assistant-send-route';
import { announceAssistantRouteFallback } from './assistant-route-fallback-notice';
import { getEffectiveHostedRouteReadiness } from '../assistant-hosts';
import { useAISettingsStore } from '../settings';
import { useAuthStore } from '../../../stores/auth-store';
import {
  EMPTY_CONV_STATE,
  createEmptyConversationState,
  type ChatSendOptions,
  type QueuedChatMessage,
} from './chat-store-types';
import {
  beginActiveConversationSelection,
  cancelChatGeneration,
  isChatConversationDeleted,
  isChatSendClaimed,
  replaceConversationState,
  recoverOrphanedChatExecution,
  setConversationState,
  type ChatStoreGet,
  type ChatStoreSet,
} from './chat-runtime';
import { runChatTurn } from './run-chat-turn';

import { conversationExecution } from './conversation-execution';

const pendingFirstMessages = new Map<string, Promise<boolean>>();

function takeSubmissionEffects(conversationId: string, messageId: string) {
  return conversationExecution(conversationId).takeSubmission(messageId);
}

export function disposeConversationQueue(conversationId: string): void {
  conversationExecution(conversationId).disposeQueue();
}

function resolveSubmissionConversationId(
  set: ChatStoreSet,
  get: ChatStoreGet,
  conversationId?: string | null,
  activateConversation = false
): string {
  const existingId = conversationId?.trim() || get().currentConversationId;
  if (existingId) {
    const conversationState = get()._convStates.get(existingId) ?? createEmptyConversationState();
    const selectionVersion = activateConversation ? beginActiveConversationSelection() : undefined;
    replaceConversationState(set, existingId, conversationState, {
      activate: activateConversation,
      selectionVersion,
    });
    return existingId;
  }

  const nextId = crypto.randomUUID();
  const conversationState = createEmptyConversationState();
  const selectionVersion = activateConversation ? beginActiveConversationSelection() : undefined;
  replaceConversationState(set, nextId, conversationState, {
    activate: activateConversation,
    selectionVersion,
  });
  return nextId;
}

async function drainConversationQueue(
  set: ChatStoreSet,
  get: ChatStoreGet,
  conversationId: string,
  preserveInitialHeadOnPreconditionFailure: boolean,
  onInitialHeadSettled?: (accepted: boolean) => void,
  onInitialMessageSaved?: () => void
): Promise<void> {
  const releaseDrain = conversationExecution(conversationId).beginDrain();
  if (!releaseDrain) return;
  let preserveOnPreconditionFailure = preserveInitialHeadOnPreconditionFailure;
  let initialHeadSettled = false;
  const settleInitialHead = (accepted: boolean): void => {
    if (initialHeadSettled) return;
    initialHeadSettled = true;
    onInitialHeadSettled?.(accepted);
  };

  try {
    for (;;) {
      const before = get()._convStates.get(conversationId) ?? EMPTY_CONV_STATE;
      const next = before.queuedMessages[0];
      if (!next) return;
      if (!next.routeSelection || !next.routeSnapshot) {
        const error = userMessage('assistant.queuedRouteMissing');
        takeSubmissionEffects(conversationId, next.id)?.onNotStarted?.(error);
        conversationExecution(conversationId).clearAdvance();
        settleInitialHead(false);
        return;
      }

      const keepVisibleUntilAccepted = true;

      const userMessageCountBefore = before.messages.filter(
        (message) => message.role === 'user'
      ).length;
      const onAccepted = (): void => {
        if (!initialHeadSettled) onInitialMessageSaved?.();
        const effects = takeSubmissionEffects(conversationId, next.id);
        if (effects?.routeFallback) announceAssistantRouteFallback(effects.routeFallback);
        const onStarted = effects?.onStarted;
        if (onStarted) {
          try {
            onStarted(conversationId);
          } catch (error) {
            console.error('[Chat] onStarted callback failed after durable turn creation:', error);
          }
        }
        if (conversationExecution(conversationId).target) {
          const targetId = conversationExecution(conversationId).target;
          if (!targetId) return;
          if (next.id === targetId) {
            conversationExecution(conversationId).clearAdvance();
            return;
          }
          cancelChatGeneration(conversationId, 'queue_advance');
        }
      };
      try {
        await runChatTurn(
          set,
          get,
          next.content,
          next.workspacePath,
          conversationId,
          next.referenceIds,
          {
            activateConversation: false,
            userMessageId: next.id,
            removeVisibleQueueRowOnAccept: keepVisibleUntilAccepted,
            onUserMessageAccepted: onAccepted,
            onNotStarted: (error) => {
              const onNotStarted = takeSubmissionEffects(conversationId, next.id)?.onNotStarted;
              if (onNotStarted) {
                onNotStarted(error);
              } else {
                setConversationState(set, conversationId, () => ({ error }));
              }
            },
            routeSelection: next.routeSelection,
            routeSnapshot: next.routeSnapshot,
            cliModelSettings: next.cliModelSettings,
            capabilitySelection: next.capabilitySelection,
            attachments: next.attachments,
          }
        );
      } catch (error) {
        setConversationState(set, conversationId, () => ({
          error: toUserMessage(error, 'assistant.failed'),
        }));
        conversationExecution(conversationId).clearAdvance();
        settleInitialHead(
          get()
            ._convStates.get(conversationId)
            ?.messages.some((message) => message.id === next.id) ?? false
        );
        return;
      }

      const after = get()._convStates.get(conversationId) ?? EMPTY_CONV_STATE;
      const userMessagesAfter = after.messages.filter((message) => message.role === 'user');
      const accepted =
        userMessagesAfter.length > userMessageCountBefore &&
        userMessagesAfter.some((message) => message.id === next.id);
      settleInitialHead(accepted);

      if (!accepted) {
        takeSubmissionEffects(conversationId, next.id);
        conversationExecution(conversationId).clearAdvance();
        if (!preserveOnPreconditionFailure) {
          setConversationState(set, conversationId, (previous) => ({
            queuedMessages: previous.queuedMessages.filter((message) => message.id !== next.id),
          }));
        }
        return;
      }

      const acceptedMessage = userMessagesAfter.find((message) => message.id === next.id);
      const terminalStatus = acceptedMessage?.turnId
        ? after.turns[acceptedMessage.turnId]?.status
        : null;
      if (terminalStatus === 'failed' || terminalStatus === 'cancelled') {
        conversationExecution(conversationId).clearAdvance();
        return;
      }

      preserveOnPreconditionFailure = true;
    }
  } finally {
    settleInitialHead(false);
    releaseDrain();
    const remainingTarget = conversationExecution(conversationId).target;
    const remainingQueue = get()._convStates.get(conversationId)?.queuedMessages ?? [];
    if (remainingTarget && !remainingQueue.some((message) => message.id === remainingTarget)) {
      conversationExecution(conversationId).clearAdvance();
    }
  }
}

export async function submitChatMessage(
  set: ChatStoreSet,
  get: ChatStoreGet,
  content: string,
  workspacePath: string | null,
  conversationId?: string | null,
  referenceIds?: string[],
  options?: ChatSendOptions
): Promise<'accepted' | 'rejected'> {
  let routeSelection: AssistantRouteSelection;
  let routeSnapshot: AssistantTurnRouteSnapshot;
  let cliModelSettings: QueuedChatMessage['cliModelSettings'];
  let routeResolution: AssistantSendRouteResolution;
  try {
    const settings = useAISettingsStore.getState();
    const auth = useAuthStore.getState();
    const routeState = {
      ...settings,
      hostedRouteReadiness: getEffectiveHostedRouteReadiness(
        settings.hostedRouteReadiness,
        auth.hydrated,
        auth.state.status
      ),
    };
    routeResolution = resolveAssistantSendRoute(routeState);
    if (routeResolution.status === 'unresolved') {
      throw withUserMessage(
        new Error('Assistant route discovery is pending.'),
        'failure.still-checking-available-ai-routes-try-again-in-a-moment'
      );
    }
    if (routeResolution.status === 'blocked') {
      const preferred = routeResolution.preferred;
      if (!preferred) {
        throw withUserMessage(
          new Error('No executable AI route is available in this build.'),
          'assistant.routeUnavailable'
        );
      }
      if (preferred.kind === 'hosted') {
        const readiness = getAssistantRouteReadiness(preferred, routeState);
        const label =
          getAssistantRouteReadinessLabel(readiness) ?? userMessage('assistant.unavailable');
        throw withUserMessage(
          new Error(`Hosted route readiness: ${readiness}`),
          userMessagePayload('assistant.hostedNotReady', { reason: userMessageValue(label) })
        );
      }
      throw withUserMessage(
        new Error('The selected AI route is not configured or ready.'),
        'assistant.routeNotReady'
      );
    }
    routeSelection = routeResolution.route;
    routeSnapshot = buildAssistantTurnRouteSnapshot(routeSelection);
    cliModelSettings = captureCliModelSettings(routeSelection, settings.cliModelSettings);
  } catch (error) {
    const message = toUserMessage(error, 'assistant.failed');
    if (options?.onNotStarted) {
      options.onNotStarted(message);
    } else {
      set({ error: message });
    }
    return Promise.resolve('rejected');
  }

  const resolvedConversationId = resolveSubmissionConversationId(
    set,
    get,
    conversationId,
    options?.activateConversation === true
  );
  if (isChatConversationDeleted(resolvedConversationId)) {
    return Promise.resolve('rejected');
  }
  const previous = {
    ...EMPTY_CONV_STATE,
    ...(get()._convStates.get(resolvedConversationId) ?? {}),
  };
  const wasAlreadyQueuedOrRunning =
    conversationExecution(resolvedConversationId).isDraining ||
    isChatSendClaimed(resolvedConversationId) ||
    previous.isLoading ||
    previous.queuedMessages.length > 0;
  const item: QueuedChatMessage = {
    id: crypto.randomUUID(),
    content,
    workspacePath,
    referenceIds: [...(referenceIds ?? [])],
    displayInThreadWhilePending: !wasAlreadyQueuedOrRunning,
    ...(options?.attachments
      ? { attachments: options.attachments.map((item) => ({ ...item })) }
      : {}),
    routeSelection,
    routeSnapshot,
    cliModelSettings,
    ...(options?.capabilitySelection
      ? { capabilitySelection: { ...options.capabilitySelection } }
      : {}),
    createdAt: Date.now(),
  };
  if (wasAlreadyQueuedOrRunning && isDesktopRuntime()) {
    try {
      const firstMessage = pendingFirstMessages.get(resolvedConversationId);
      if (firstMessage && !get().conversations.some((row) => row.id === resolvedConversationId)) {
        if (!(await firstMessage)) throw new Error('The conversation could not be saved.');
      }
      if (isChatConversationDeleted(resolvedConversationId)) return 'rejected';
      await persistQueuedMessage(resolvedConversationId, item);
    } catch (cause) {
      const error = toUserMessage(cause, 'assistant.failed');
      if (options?.onNotStarted) options.onNotStarted(error);
      else setConversationState(set, resolvedConversationId, () => ({ error }));
      return 'rejected';
    }
    if (isChatConversationDeleted(resolvedConversationId)) return 'rejected';
  }
  conversationExecution(resolvedConversationId).submitted(item.id, {
    onStarted: options?.onStarted,
    onNotStarted: options?.onNotStarted,
    ...(routeResolution.status === 'fallback' ? { routeFallback: routeResolution } : {}),
  });

  setConversationState(set, resolvedConversationId, (state) => ({
    queuedMessages: [...state.queuedMessages, item],
  }));

  if (
    conversationExecution(resolvedConversationId).isDraining ||
    isChatSendClaimed(resolvedConversationId) ||
    get()._convStates.get(resolvedConversationId)?.isLoading
  ) {
    return Promise.resolve('accepted');
  }

  if (wasAlreadyQueuedOrRunning) {
    void drainConversationQueue(set, get, resolvedConversationId, true);
    return Promise.resolve('accepted');
  }

  let settleFirst!: (accepted: boolean) => void;
  const firstMessage = new Promise<boolean>((resolve) => {
    settleFirst = resolve;
  });
  pendingFirstMessages.set(resolvedConversationId, firstMessage);
  const releaseFirst = (accepted: boolean) => {
    if (pendingFirstMessages.get(resolvedConversationId) === firstMessage) {
      pendingFirstMessages.delete(resolvedConversationId);
    }
    settleFirst(accepted);
  };
  return new Promise<'accepted' | 'rejected'>((resolve) => {
    void drainConversationQueue(
      set,
      get,
      resolvedConversationId,
      false,
      (accepted) => {
        releaseFirst(accepted);
        resolve(accepted ? 'accepted' : 'rejected');
      },
      () => releaseFirst(true)
    );
  });
}

export function stopChatGeneration(
  set: ChatStoreSet,
  get: ChatStoreGet,
  conversationId?: string | null
): void {
  const resolvedConversationId = conversationId || get().currentConversationId;
  if (!resolvedConversationId) {
    set({ isLoading: false, isStreaming: false });
    return;
  }

  const conversation = get()._convStates.get(resolvedConversationId) ?? EMPTY_CONV_STATE;
  const isActive = conversation.isLoading || isChatSendClaimed(resolvedConversationId);
  if (isActive && cancelChatGeneration(resolvedConversationId, 'user_stop')) {
    return;
  }

  if (conversation.isLoading || conversation.isStreaming) {
    recoverOrphanedChatExecution(set, resolvedConversationId);
  }
  if (conversation.queuedMessages.length > 0) {
    void drainConversationQueue(set, get, resolvedConversationId, true);
    return;
  }
  recoverOrphanedChatExecution(set, resolvedConversationId);
}

export function advanceChatQueueThrough(
  set: ChatStoreSet,
  get: ChatStoreGet,
  targetMessageId: string,
  conversationId?: string | null
): void {
  const resolvedConversationId = conversationId || get().currentConversationId;
  if (!resolvedConversationId || isChatConversationDeleted(resolvedConversationId)) return;

  const conversation = get()._convStates.get(resolvedConversationId) ?? EMPTY_CONV_STATE;
  if (!conversation.queuedMessages.some((message) => message.id === targetMessageId)) return;

  conversationExecution(resolvedConversationId).requestAdvance(targetMessageId);
  const hasActiveIteration =
    conversationExecution(resolvedConversationId).isDraining ||
    conversation.isLoading ||
    isChatSendClaimed(resolvedConversationId);
  if (hasActiveIteration && cancelChatGeneration(resolvedConversationId, 'queue_advance')) return;

  if (conversation.isLoading || conversation.isStreaming) {
    recoverOrphanedChatExecution(set, resolvedConversationId);
  }
  void drainConversationQueue(set, get, resolvedConversationId, true);
}
