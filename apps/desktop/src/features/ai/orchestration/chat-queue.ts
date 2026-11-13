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
  setConversationState,
  type ChatStoreGet,
  type ChatStoreSet,
} from './chat-runtime';
import { runChatTurn } from './run-chat-turn';

const activeQueueDrains = new Set<string>();
const advanceThroughTargets = new Map<string, string>();
type SubmissionEffects = Pick<ChatSendOptions, 'onStarted' | 'onNotStarted'> & {
  routeFallback?: Extract<AssistantSendRouteResolution, { status: 'fallback' }>;
};
const conversationSubmissions = new Map<string, Map<string, SubmissionEffects>>();

function takeSubmissionEffects(
  conversationId: string,
  messageId: string
): SubmissionEffects | undefined {
  const submissions = conversationSubmissions.get(conversationId);
  const effects = submissions?.get(messageId);
  submissions?.delete(messageId);
  if (submissions?.size === 0) conversationSubmissions.delete(conversationId);
  return effects;
}

export function disposeConversationQueue(conversationId: string): void {
  conversationSubmissions.delete(conversationId);
  advanceThroughTargets.delete(conversationId);
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
  onInitialHeadSettled?: (accepted: boolean) => void
): Promise<void> {
  if (activeQueueDrains.has(conversationId)) return;
  activeQueueDrains.add(conversationId);
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
        advanceThroughTargets.delete(conversationId);
        settleInitialHead(false);
        return;
      }

      const keepVisibleUntilAccepted = true;

      const userMessageCountBefore = before.messages.filter(
        (message) => message.role === 'user'
      ).length;
      const onAccepted = (): void => {
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
        if (advanceThroughTargets.has(conversationId)) {
          const targetId = advanceThroughTargets.get(conversationId);
          if (!targetId) return;
          if (next.id === targetId) {
            advanceThroughTargets.delete(conversationId);
            return;
          }
          cancelChatGeneration(conversationId, 'queue_advance');
        }
      };
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
          capabilitySelection: next.capabilitySelection,
          attachments: next.attachments,
        }
      );

      const after = get()._convStates.get(conversationId) ?? EMPTY_CONV_STATE;
      const userMessagesAfter = after.messages.filter((message) => message.role === 'user');
      const accepted =
        userMessagesAfter.length > userMessageCountBefore &&
        userMessagesAfter.some((message) => message.id === next.id);
      settleInitialHead(accepted);

      if (!accepted) {
        takeSubmissionEffects(conversationId, next.id);
        advanceThroughTargets.delete(conversationId);
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
        advanceThroughTargets.delete(conversationId);
        return;
      }

      preserveOnPreconditionFailure = true;
    }
  } finally {
    settleInitialHead(false);
    activeQueueDrains.delete(conversationId);
    const remainingTarget = advanceThroughTargets.get(conversationId);
    const remainingQueue = get()._convStates.get(conversationId)?.queuedMessages ?? [];
    if (remainingTarget && !remainingQueue.some((message) => message.id === remainingTarget)) {
      advanceThroughTargets.delete(conversationId);
    }
  }
}

export function submitChatMessage(
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
    activeQueueDrains.has(resolvedConversationId) ||
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
    ...(options?.capabilitySelection
      ? { capabilitySelection: { ...options.capabilitySelection } }
      : {}),
    createdAt: Date.now(),
  };
  const submissions =
    conversationSubmissions.get(resolvedConversationId) ?? new Map<string, SubmissionEffects>();
  submissions.set(item.id, {
    onStarted: options?.onStarted,
    onNotStarted: options?.onNotStarted,
    ...(routeResolution.status === 'fallback' ? { routeFallback: routeResolution } : {}),
  });
  conversationSubmissions.set(resolvedConversationId, submissions);

  setConversationState(set, resolvedConversationId, (state) => ({
    queuedMessages: [...state.queuedMessages, item],
  }));

  if (
    activeQueueDrains.has(resolvedConversationId) ||
    isChatSendClaimed(resolvedConversationId) ||
    previous.isLoading
  ) {
    return Promise.resolve('accepted');
  }

  if (previous.queuedMessages.length > 0) {
    void drainConversationQueue(set, get, resolvedConversationId, true);
    return Promise.resolve('accepted');
  }

  return new Promise<'accepted' | 'rejected'>((resolve) => {
    void drainConversationQueue(
      set,
      get,
      resolvedConversationId,
      wasAlreadyQueuedOrRunning,
      (accepted) => resolve(accepted ? 'accepted' : 'rejected')
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
    setConversationState(set, resolvedConversationId, () => ({
      isLoading: false,
      isStreaming: false,
      streamingBlocks: [],
    }));
  }
  if (conversation.queuedMessages.length > 0) {
    void drainConversationQueue(set, get, resolvedConversationId, true);
    return;
  }
  setConversationState(set, resolvedConversationId, () => ({
    isLoading: false,
    isStreaming: false,
    streamingBlocks: [],
  }));
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

  advanceThroughTargets.set(resolvedConversationId, targetMessageId);
  const hasActiveIteration =
    activeQueueDrains.has(resolvedConversationId) ||
    conversation.isLoading ||
    isChatSendClaimed(resolvedConversationId);
  if (hasActiveIteration && cancelChatGeneration(resolvedConversationId, 'queue_advance')) return;

  if (conversation.isLoading || conversation.isStreaming) {
    setConversationState(set, resolvedConversationId, () => ({
      isLoading: false,
      isStreaming: false,
      streamingBlocks: [],
    }));
  }
  void drainConversationQueue(set, get, resolvedConversationId, true);
}
