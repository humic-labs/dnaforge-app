import { toOptionalUserMessage, type UserMessage } from '@waypoint/user-messages';
import { beginHistoryObservation } from '../../../lib/chat-history-telemetry';
import type { HistoryDetails, HistoryObservation } from '../../../shared/chat-history-telemetry';

import { create } from 'zustand';
import {
  createConversation,
  getConversationHistory,
  getMessages,
  getChatTurns,
  getMessageAttachmentsForMessages,
  getStructuredOutputsForConversation,
  deleteConversation as dbDeleteConversation,
  updateConversationWithResult,
  toggleConversationPinnedWithResult,
} from '../../../db';
import { recoverInterruptedChatTurns } from '../orchestration/chat-turn-repository';
export type { ChatMessage, ContentBlock } from '../orchestration/chat-types';
import {
  EMPTY_CONV_STATE,
  createEmptyConversationState,
  type AskAiInlineChat,
  type ChatActions,
  type ChatState,
  type ConversationState,
  type PendingChatMessage,
  type PendingAskAiPicker,
  type PendingChatDraft,
} from '../orchestration/chat-store-types';
export {
  EMPTY_CONV_STATE,
  type AskAiInlineChat,
  type ChatTurnSummary,
  type ConversationState,
  type ConversationSummary,
  type ConversationHistoryReadState,
  type PendingAskAiPicker,
  type PendingChatDraft,
  type PendingChatMessage,
  type QueuedChatMessage,
} from '../orchestration/chat-store-types';
export { inferInitialDirectToolStep } from '../orchestration/tool-policy';
export {
  expandReferences,
  expandReferencesFromIds,
  serializeReferenceCoords,
  serializeReferenceDescriptorFence,
  serializeSelectionHandle,
} from '../orchestration/reference-context';
export { convertToModelMessages } from '../orchestration/model-messages';
export { buildAgentSdkPrompt } from '../prompts/cli-prompt';
import {
  dbConversationToSummary,
  dbMessageToChatMessage,
  dbTurnsToSummaryMap,
  attachPersistedChatMetadata,
} from '../orchestration/chat-projections';
import {
  beginActiveConversationSelection,
  cancelChatGeneration,
  clearActiveConversationState,
  clearConversationIfActive,
  isChatConversationDeleted,
  markChatConversationDeleted,
  replaceConversationState,
  setConversationState,
  type ChatStoreGet,
  type ChatStoreSet,
  unmarkChatConversationDeleted,
} from '../orchestration/chat-runtime';
import {
  advanceChatQueueThrough,
  disposeConversationQueue,
  stopChatGeneration,
  submitChatMessage,
} from '../orchestration/chat-queue';
import { mergeHydratedConversationState } from '../orchestration/chat-conversation-state';
import { repairHistoricalArtifactDelivery } from '../orchestration/artifact-delivery';
import {
  mergeLoadedConversationSummaries,
  orderConversationSummaries,
} from '../orchestration/chat-conversation-list';

function normalizePendingChatMessage(
  message: PendingChatMessage | string | null
): PendingChatMessage | null {
  if (message === null) return null;
  if (typeof message === 'string') {
    return { content: message };
  }
  return message;
}

let conversationListLoadSequence = 0;
const placeholderMaterializations = new Map<string, Promise<string | null>>();
const newConversationOperations = new Map<string, Promise<string>>();
const conversationHydrationOperations = new Map<string, Promise<ConversationState>>();

const conversationRenameOperations = new Map<string, Promise<void>>();
const conversationPinOperations = new Map<string, Promise<void>>();

function loadPersistedConversationState(id: string): Promise<ConversationState> {
  const inFlight = conversationHydrationOperations.get(id);
  if (inFlight) return inFlight;

  const operation = (async (): Promise<ConversationState> => {
    const persistedMessages = await getMessages(id);
    const [attachmentMap, structuredOutputs] = await Promise.all([
      getMessageAttachmentsForMessages(persistedMessages.map((message) => message.id)),
      getStructuredOutputsForConversation(id),
    ]);
    const messages = await repairHistoricalArtifactDelivery(
      attachPersistedChatMetadata(
        persistedMessages.map(dbMessageToChatMessage),
        attachmentMap,
        structuredOutputs
      )
    );
    const turns = dbTurnsToSummaryMap(
      await recoverInterruptedChatTurns(id, await getChatTurns(id))
    );
    const latestTurn = Object.values(turns).reduce<(typeof turns)[string] | null>(
      (latest, turn) => (!latest || turn.startedAt >= latest.startedAt ? turn : latest),
      null
    );
    return {
      messages,
      turns,
      activeTurnId: Object.values(turns).find((turn) => turn.status === 'running')?.id ?? null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error:
        latestTurn?.status === 'failed'
          ? toOptionalUserMessage(latestTurn.error, 'assistant.failed')
          : null,
      queuedMessages: [],
    };
  })().finally(() => {
    if (conversationHydrationOperations.get(id) === operation) {
      conversationHydrationOperations.delete(id);
    }
  });
  conversationHydrationOperations.set(id, operation);
  return operation;
}

function materializePlaceholderDraft(
  set: ChatStoreSet,
  get: ChatStoreGet,
  sourceConversationId: string | null | undefined,
  workspacePath: string | null
): Promise<string | null> {
  if (!sourceConversationId) return Promise.resolve(null);
  const current = get();
  const sourceDraft = current.composerDrafts.get(sourceConversationId);
  const sourceIsPlaceholder =
    sourceDraft !== undefined &&
    !current.conversations.some((conversation) => conversation.id === sourceConversationId);
  if (!sourceIsPlaceholder) return Promise.resolve(sourceConversationId);

  const inFlight = placeholderMaterializations.get(sourceConversationId);
  if (inFlight) return inFlight;

  const operation = (async (): Promise<string> => {
    const preserved = await createConversation(
      crypto.randomUUID(),
      'New conversation',
      workspacePath
    );
    set((state) => {
      const latestDraft = state.composerDrafts.get(sourceConversationId);
      const composerDrafts = new Map(state.composerDrafts);
      composerDrafts.delete(sourceConversationId);
      if (latestDraft !== undefined) composerDrafts.set(preserved.id, latestDraft);

      const convStates = new Map(state._convStates);
      const placeholderState = convStates.get(sourceConversationId);
      convStates.delete(sourceConversationId);
      convStates.set(preserved.id, placeholderState ?? createEmptyConversationState());
      return {
        conversations: state.conversations.some((conversation) => conversation.id === preserved.id)
          ? state.conversations
          : [dbConversationToSummary(preserved), ...state.conversations],
        composerDrafts,
        _convStates: convStates,
      };
    });
    return preserved.id;
  })().finally(() => {
    if (placeholderMaterializations.get(sourceConversationId) === operation) {
      placeholderMaterializations.delete(sourceConversationId);
    }
  });
  placeholderMaterializations.set(sourceConversationId, operation);
  return operation;
}

export const useChatStore = create<ChatState & ChatActions>((set, get) => ({
  messages: [],
  turns: {},
  activeTurnId: null,
  conversations: [],
  conversationHistoryRead: { status: 'idle', hasLoaded: false },
  currentConversationId: null,
  isLoading: false,
  isStreaming: false,
  streamingBlocks: [],
  error: null,
  queuedMessages: [],
  pendingMessage: null,
  pendingDraft: null,
  composerDrafts: new Map(),
  pendingAskAiPicker: null,
  askAiInlineChat: null,
  _convStates: new Map<string, ConversationState>(),

  sendMessage: (content, workspacePath, conversationId, referenceIds, options) =>
    submitChatMessage(set, get, content, workspacePath, conversationId, referenceIds, options),

  stopGeneration: (conversationId) => stopChatGeneration(set, get, conversationId),
  advanceQueueThrough: (targetMessageId, conversationId) =>
    advanceChatQueueThrough(set, get, targetMessageId, conversationId),

  loadConversations: async (history) => {
    const observed = history ?? beginHistoryObservation('list', 'store');
    const requestSequence = ++conversationListLoadSequence;
    const idsAtRequestStart = new Set(get().conversations.map((conversation) => conversation.id));
    set((state) => ({
      conversationHistoryRead: { ...state.conversationHistoryRead, status: 'loading' },
    }));
    let dbConversations: Awaited<ReturnType<typeof getConversationHistory>>;
    try {
      dbConversations = await getConversationHistory();
    } catch (error) {
      if (requestSequence === conversationListLoadSequence) {
        set((state) => ({
          conversationHistoryRead: { ...state.conversationHistoryRead, status: 'error' },
        }));
      }
      observed.store({
        phase: 'error',
        result: 'read_rejected',
        authority: 'loaded_titles',
        freshness:
          requestSequence !== conversationListLoadSequence
            ? 'superseded'
            : get().conversationHistoryRead.hasLoaded
              ? 'cached'
              : 'unavailable',
      });

      throw error;
    }
    if (requestSequence !== conversationListLoadSequence) {
      observed.store({ phase: 'cancelled', result: 'superseded', freshness: 'superseded' });
      return;
    }
    try {
      const loaded = dbConversations.map(dbConversationToSummary);
      set((state) => {
        const latestIds = new Set(state.conversations.map((conversation) => conversation.id));
        return {
          conversationHistoryRead: { status: 'ready', hasLoaded: true },
          conversations: mergeLoadedConversationSummaries({
            loaded,
            latest: state.conversations,
            idsAtRequestStart,
            deletedIds: new Set(
              [...idsAtRequestStart, ...loaded.map((conversation) => conversation.id)].filter(
                (id) => isChatConversationDeleted(id) && !latestIds.has(id)
              )
            ),
          }),
        };
      });
      const count = get().conversations.length;
      observed.store({
        result: count === 0 ? 'loaded_empty' : 'loaded_rows',
        authority: 'loaded_titles',
        freshness: 'current',
        matches: count === 0 ? 'zero' : count === 1 ? 'one' : 'many',
      });
    } catch (error) {
      observed.store({
        phase: 'error',
        result: 'read_returned_projection_failed',
        authority: 'loaded_titles',
      });
      throw error;
    }
  },

  switchConversation: async (id, options) => {
    const observed = options?.history ?? beginHistoryObservation('resume', 'store');
    try {
      if (isChatConversationDeleted(id)) {
        observed.store({ phase: 'refused', result: 'tombstoned' });
        return 'stale';
      }
      const selectionVersion = beginActiveConversationSelection();
      await materializePlaceholderDraft(
        set,
        get,
        options?.sourceConversationId,
        options?.workspacePath ?? null
      );
      if (isChatConversationDeleted(id)) {
        observed.store({ phase: 'refused', result: 'tombstoned' });
        return 'stale';
      }
      const existing = get()._convStates.get(id);
      if (existing) {
        const existingState = { ...EMPTY_CONV_STATE, ...existing };
        const applied = replaceConversationState(set, id, existingState, {
          activate: true,
          selectionVersion,
          installIfSelectionWasSuperseded: true,
        });
        const live = existing.isLoading || existing.isStreaming;
        observed.store({
          result: live ? 'live_available' : 'cached_available',
          authority: 'keyed_state',
          availability: live ? 'live' : 'cached',
          freshness: applied ? 'current' : 'superseded',
        });
        if (!applied) return 'available';
      } else {
        const hydratedState = await loadPersistedConversationState(id);
        if (isChatConversationDeleted(id)) {
          observed.store({ phase: 'refused', result: 'tombstoned' });
          return 'stale';
        }
        const selectedState = mergeHydratedConversationState(
          hydratedState,
          get()._convStates.get(id)
        );
        const applied = replaceConversationState(set, id, selectedState, {
          activate: true,
          selectionVersion,
          installIfSelectionWasSuperseded: true,
        });
        observed.store({
          result: 'persisted_available',
          authority: 'keyed_state',
          availability: 'persisted',
          freshness: applied ? 'current' : 'superseded',
        });
        if (!applied) return 'available';
      }
      return 'applied';
    } catch (error) {
      observed.store({ phase: 'error', result: 'hydration_rejected', freshness: 'unavailable' });
      throw error;
    }
  },

  hydrateConversation: async (id: string, history?: HistoryObservation) => {
    const observed = history ?? beginHistoryObservation('hydrate', 'store');
    if (isChatConversationDeleted(id)) {
      observed.store({ phase: 'refused', result: 'tombstoned' });
      return;
    }
    const existing = get()._convStates.get(id);
    if (existing) {
      observed.store({
        result: 'already_available',
        authority: 'keyed_state',
        availability: existing.isLoading || existing.isStreaming ? 'live' : 'cached',
      });
      return;
    }
    try {
      const hydratedState = await loadPersistedConversationState(id);
      if (isChatConversationDeleted(id)) {
        observed.store({ phase: 'refused', result: 'tombstoned' });
        return;
      }
      const selectedState = mergeHydratedConversationState(
        hydratedState,
        get()._convStates.get(id)
      );

      replaceConversationState(set, id, selectedState);
      observed.store({
        result: 'persisted_available',
        authority: 'keyed_state',
        availability: 'persisted',
      });
    } catch (error) {
      observed.store({ phase: 'error', result: 'hydration_rejected', freshness: 'unavailable' });
      throw error;
    }
  },

  deleteConversation: async (id: string, history?: HistoryObservation) => {
    const observed = history ?? beginHistoryObservation('delete', 'store');
    let replacement: HistoryDetails['replacement'] = 'none';
    let availability: HistoryDetails['availability'] = 'unknown';
    const selectionVersion = beginActiveConversationSelection();

    markChatConversationDeleted(id);
    cancelChatGeneration(id, 'conversation_deleted');
    try {
      await dbDeleteConversation(id);
      disposeConversationQueue(id);
    } catch (error) {
      unmarkChatConversationDeleted(id);
      observed.store({
        phase: 'error',
        result: 'delete_rejected',
        authority: 'sqlite_return',
        freshness: 'unavailable',
      });
      throw error;
    }

    try {
      const replacementId =
        get().conversations.find(
          (conversation) => conversation.id !== id && !isChatConversationDeleted(conversation.id)
        )?.id ?? null;
      let hydratedReplacement: ConversationState | null = null;
      if (replacementId && get()._convStates.get(replacementId)) {
        replacement = 'keyed_available';
        availability = 'cached';
      }
      if (replacementId && !get()._convStates.get(replacementId)) {
        try {
          hydratedReplacement = await loadPersistedConversationState(replacementId);
          replacement = 'persisted_available';
          availability = 'persisted';
        } catch (error) {
          console.error('[Chat] Failed to hydrate replacement after deletion:', error);
          hydratedReplacement = createEmptyConversationState();
          replacement = 'read_failed_placeholder';
          availability = 'placeholder';
        }
      }

      let replacementState: ConversationState | null = null;
      if (replacementId) {
        replacementState = mergeHydratedConversationState(
          hydratedReplacement ?? createEmptyConversationState(),
          get()._convStates.get(replacementId)
        );
        replaceConversationState(set, replacementId, replacementState, {
          activate: get().currentConversationId === id,
          selectionVersion,
          installIfSelectionWasSuperseded: true,
        });
      } else if (get().currentConversationId === id) {
        if (!clearActiveConversationState(set, selectionVersion)) {
          clearConversationIfActive(set, id);
        }
      }

      set((state) => {
        const conversations = state.conversations.filter((conversation) => conversation.id !== id);
        const composerDrafts = new Map(state.composerDrafts);
        composerDrafts.delete(id);
        const states = new Map(state._convStates);
        states.delete(id);

        return { conversations, composerDrafts, _convStates: states };
      });

      observed.store({
        result: 'delete_returned',
        authority: 'sqlite_return',
        replacement,
        availability,
        shadow: 'NOT_ATTESTED',
      });
      return replacementId;
    } catch (error) {
      observed.store({
        phase: 'error',
        result: 'delete_returned_recovery_failed',
        authority: 'sqlite_return',
        replacement,
        availability,
      });
      throw error;
    }
  },

  newConversation: async (workspacePath, options) => {
    const sourceConversationId =
      options?.sourceConversationId === undefined
        ? get().currentConversationId
        : options.sourceConversationId;
    const operationKey = JSON.stringify([
      sourceConversationId,
      workspacePath,
      options?.force === true,
    ]);
    const inFlight = newConversationOperations.get(operationKey);
    if (inFlight) {
      if (!options?.history) return inFlight;
      try {
        const id = await inFlight;
        options.history.store(
          isChatConversationDeleted(id)
            ? { phase: 'refused', result: 'tombstoned', authority: 'not_attested' }
            : {
                result: 'joined_existing',
                authority: 'not_attested',
                availability: get()._convStates.has(id) ? 'keyed' : 'unknown',
              }
        );
        return id;
      } catch (error) {
        options.history.store({
          phase: 'error',
          result: 'create_rejected',
          authority: 'not_attested',
        });
        throw error;
      }
    }
    const observed = options?.history ?? beginHistoryObservation('new', 'store');

    const operation = (async (): Promise<string> => {
      let creationReturned = false;
      try {
        const selectionVersion = beginActiveConversationSelection();
        let current = get();
        const materializedSourceId = await materializePlaceholderDraft(
          set,
          get,
          sourceConversationId,
          workspacePath
        );
        current = get();

        const candidateConversationId = materializedSourceId ?? current.currentConversationId;
        if (!options?.force && candidateConversationId) {
          const currentConversation = current.conversations.find(
            (conversation) => conversation.id === candidateConversationId
          );
          const currentState = current._convStates.get(candidateConversationId) ?? {
            ...EMPTY_CONV_STATE,
            messages: current.messages,
            turns: current.turns,
            activeTurnId: current.activeTurnId,
            streamingBlocks: current.streamingBlocks,
            isLoading: current.isLoading,
            isStreaming: current.isStreaming,
            error: current.error,
            queuedMessages: current.queuedMessages,
          };
          const currentChatIsEmpty =
            currentConversation !== undefined &&
            currentConversation.workspacePath === workspacePath &&
            !current.composerDrafts.has(candidateConversationId) &&
            currentState.messages.length === 0 &&
            currentState.queuedMessages.length === 0 &&
            !currentState.isLoading &&
            !currentState.isStreaming &&
            currentState.activeTurnId === null;
          if (currentChatIsEmpty) {
            observed.store({
              result: 'new_reused',
              authority: 'keyed_state',
              availability: 'cached',
            });
            return candidateConversationId;
          }
        }

        const conv = await createConversation(
          crypto.randomUUID(),
          'New conversation',
          workspacePath
        );
        creationReturned = true;
        const convState: ConversationState = createEmptyConversationState();
        set((state) => {
          const conversations = state.conversations.some(
            (conversation) => conversation.id === conv.id
          )
            ? state.conversations
            : [dbConversationToSummary(conv), ...state.conversations];
          return { conversations };
        });
        replaceConversationState(set, conv.id, convState, {
          activate: true,
          selectionVersion,
          installIfSelectionWasSuperseded: true,
        });
        observed.store({
          result: 'new_created',
          authority: 'sqlite_return',
          availability: 'cached',
        });
        return conv.id;
      } catch (error) {
        observed.store({
          phase: 'error',
          result: creationReturned ? 'create_returned_projection_failed' : 'create_rejected',
          authority: creationReturned ? 'sqlite_return' : 'not_attested',
          freshness: 'unavailable',
        });
        throw error;
      }
    })().finally(() => {
      if (newConversationOperations.get(operationKey) === operation) {
        newConversationOperations.delete(operationKey);
      }
    });
    newConversationOperations.set(operationKey, operation);
    return operation;
  },

  renameConversation: (id: string, title: string, history?: HistoryObservation) => {
    const observed = history ?? beginHistoryObservation('rename', 'store');
    const rename = async () => {
      let writeReturned = false;
      if (isChatConversationDeleted(id)) {
        observed.store({ phase: 'refused', result: 'tombstoned' });
        return;
      }
      try {
        const receipt = await updateConversationWithResult(id, title);
        writeReturned = true;
        if (receipt.status === 'missing') {
          observed.store({
            phase: 'refused',
            result: 'row_missing',
            authority: 'sqlite_return',
            freshness: 'unavailable',
          });
          return;
        }
        if (receipt.status === 'not_applied') {
          observed.store({
            phase: 'refused',
            result: 'row_not_applied',
            authority: 'sqlite_changes',
          });
          return;
        }
        const retired = isChatConversationDeleted(id);
        if (retired) {
          observed.store({
            result: receipt.status === 'updated' ? 'row_updated' : 'native_write_returned',
            authority: receipt.status === 'updated' ? 'sqlite_changes' : 'sqlite_return',
            freshness: 'superseded',
          });
          return;
        }
        set((state) => ({
          conversations: state.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
        }));
        observed.store({
          result: receipt.status === 'updated' ? 'row_updated' : 'native_write_returned',
          authority: receipt.status === 'updated' ? 'sqlite_changes' : 'sqlite_return',
          freshness: isChatConversationDeleted(id) ? 'superseded' : 'current',
        });
      } catch (error) {
        observed.store({
          phase: 'error',
          result: writeReturned ? 'write_returned_projection_failed' : 'native_write_rejected',
          authority: writeReturned ? 'sqlite_return' : 'not_attested',
          freshness: 'unavailable',
        });
        throw error;
      }
    };
    const previous = conversationRenameOperations.get(id);
    const operation = (previous ? previous.then(rename, rename) : rename()).finally(() => {
      if (conversationRenameOperations.get(id) === operation)
        conversationRenameOperations.delete(id);
    });
    conversationRenameOperations.set(id, operation);
    return operation;
  },

  togglePin: (id: string, history?: HistoryObservation) => {
    const observed = history ?? beginHistoryObservation('row_pin', 'store');
    const toggle = async () => {
      let writeReturned = false;
      if (isChatConversationDeleted(id)) {
        observed.store({ phase: 'refused', result: 'tombstoned' });
        return;
      }
      try {
        const receipt = await toggleConversationPinnedWithResult(id);
        writeReturned = true;
        if (receipt.status === 'missing') {
          observed.store({
            phase: 'refused',
            result: 'row_missing',
            authority: 'sqlite_return',
            freshness: 'unavailable',
          });
          return;
        }
        if (receipt.status === 'not_applied') {
          observed.store({
            phase: 'refused',
            result: 'row_not_applied',
            authority: 'sqlite_changes',
          });
          return;
        }
        const retired = isChatConversationDeleted(id);
        if (retired) {
          observed.store({
            result: receipt.status === 'updated' ? 'row_updated' : 'native_write_returned',
            authority: receipt.status === 'updated' ? 'sqlite_changes' : 'sqlite_return',
            freshness: 'superseded',
            pinState:
              receipt.status === 'updated' ? (receipt.pinned ? 'pinned' : 'unpinned') : 'unknown',
          });
          return;
        }
        set((state) => ({
          conversations: orderConversationSummaries(
            state.conversations.map((c) => (c.id === id ? { ...c, pinned: receipt.pinned } : c))
          ),
        }));
        observed.store({
          result: receipt.status === 'updated' ? 'row_updated' : 'native_write_returned',
          authority: receipt.status === 'updated' ? 'sqlite_changes' : 'sqlite_return',
          freshness: isChatConversationDeleted(id) ? 'superseded' : 'current',
          pinState:
            receipt.status === 'updated' ? (receipt.pinned ? 'pinned' : 'unpinned') : 'unknown',
        });
      } catch (error) {
        observed.store({
          phase: 'error',
          result: writeReturned ? 'write_returned_projection_failed' : 'native_write_rejected',
          authority: writeReturned ? 'sqlite_return' : 'not_attested',
          freshness: 'unavailable',
        });
        throw error;
      }
    };
    const previous = conversationPinOperations.get(id);
    const operation = (previous ? previous.then(toggle, toggle) : toggle()).finally(() => {
      if (conversationPinOperations.get(id) === operation) conversationPinOperations.delete(id);
    });
    conversationPinOperations.set(id, operation);
    return operation;
  },

  setPendingMessage: (message: PendingChatMessage | string | null) => {
    set({ pendingMessage: normalizePendingChatMessage(message) });
  },

  setPendingDraft: (draft: PendingChatDraft | null) => set({ pendingDraft: draft }),

  setComposerDraft: (conversationId, draft) =>
    set((state) => {
      const composerDrafts = new Map(state.composerDrafts);
      if (
        !draft ||
        (draft.text.length === 0 && draft.attachments.length === 0 && draft.references.length === 0)
      ) {
        composerDrafts.delete(conversationId);
      } else {
        composerDrafts.set(conversationId, draft);
      }
      return { composerDrafts };
    }),

  setPendingAskAiPicker: (picker: PendingAskAiPicker | null) => set({ pendingAskAiPicker: picker }),

  setAskAiInlineChat: (inline: AskAiInlineChat | null) => set({ askAiInlineChat: inline }),

  setError: (error: UserMessage | null, conversationId?: string | null) => {
    if (conversationId) {
      setConversationState(set, conversationId, () => ({ error }));
      return;
    }
    set({ error });
  },
}));
