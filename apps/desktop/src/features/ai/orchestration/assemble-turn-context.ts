import type { ModelMessage } from 'ai';
import { getMessageReferencesForMessages } from '../../../db';
import { convertToModelMessages } from './model-messages';
import { expandReferences, expandReferencesFromIds } from './reference-context';
import type { ChatMessage } from './chat-types';

export interface AssembleTurnModelMessagesOptions {
  messages: ChatMessage[];
  currentUserMessageId: string;
  stagedReferenceIds: string[];
  workspacePath: string | null;
}

export interface AssembledTurnContext {
  expandedMessages: ChatMessage[];
  modelMessages: ModelMessage[];
  exposedReferenceIds: string[];
}

export async function assembleTurnModelMessages({
  messages,
  currentUserMessageId,
  stagedReferenceIds,
  workspacePath,
}: AssembleTurnModelMessagesOptions): Promise<AssembledTurnContext> {
  const persistedMessageIds = messages.map((message) => message.id);
  const referenceIdsByMessage = await getMessageReferencesForMessages(persistedMessageIds).catch(
    () => new Map<string, string[]>()
  );
  const exposedReferenceIds = new Set(stagedReferenceIds);
  for (const ids of referenceIdsByMessage.values()) {
    for (const id of ids) exposedReferenceIds.add(id);
  }
  const expandedMessages = await Promise.all(
    messages.map(async (message) => {
      if (message.role !== 'user') return message;
      const structuredReferenceIds =
        message.id === currentUserMessageId && stagedReferenceIds.length > 0
          ? stagedReferenceIds
          : (referenceIdsByMessage.get(message.id) ?? []);
      if (structuredReferenceIds.length > 0) {
        return {
          ...message,
          content: await expandReferencesFromIds(message.content, structuredReferenceIds),
        };
      }
      if (message.content.includes('[[ref:')) {
        return {
          ...message,
          content: await expandReferences(message.content, workspacePath),
        };
      }
      return message;
    })
  );
  return {
    expandedMessages,
    modelMessages: convertToModelMessages(expandedMessages),
    exposedReferenceIds: [...exposedReferenceIds],
  };
}
