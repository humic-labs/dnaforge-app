import type { ConversationSummary } from './chat-store-types';

interface MergeLoadedConversationSummariesOptions {
  loaded: ConversationSummary[];
  latest: ConversationSummary[];
  idsAtRequestStart: ReadonlySet<string>;
  deletedIds?: ReadonlySet<string>;
}

export function orderConversationSummaries(
  conversations: readonly ConversationSummary[]
): ConversationSummary[] {
  return conversations
    .map((conversation, index) => ({ conversation, index }))
    .sort((left, right) => {
      if (left.conversation.pinned !== right.conversation.pinned) {
        return left.conversation.pinned ? -1 : 1;
      }
      return right.conversation.updatedAt - left.conversation.updatedAt || left.index - right.index;
    })
    .map(({ conversation }) => conversation);
}

export function mergeLoadedConversationSummaries({
  loaded,
  latest,
  idsAtRequestStart,
  deletedIds = new Set<string>(),
}: MergeLoadedConversationSummariesOptions): ConversationSummary[] {
  const latestById = new Map(latest.map((conversation) => [conversation.id, conversation]));
  const locallyDeletedIds = new Set([...idsAtRequestStart].filter((id) => !latestById.has(id)));
  const merged = loaded
    .filter(
      (conversation) => !deletedIds.has(conversation.id) && !locallyDeletedIds.has(conversation.id)
    )
    .map((conversation) => latestById.get(conversation.id) ?? conversation);
  const mergedIds = new Set(merged.map((conversation) => conversation.id));

  for (const conversation of latest) {
    if (
      !mergedIds.has(conversation.id) &&
      !idsAtRequestStart.has(conversation.id) &&
      !deletedIds.has(conversation.id)
    ) {
      merged.unshift(conversation);
      mergedIds.add(conversation.id);
    }
  }
  return orderConversationSummaries(merged);
}
