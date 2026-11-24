import { platform } from '../platform';
import { isDesktopRuntime } from '../utils/environment';
import type { QueuedChatMessage } from '../features/ai/orchestration/chat-store-types';

export async function persistQueuedMessage(conversationId: string, message: QueuedChatMessage) {
  const result = await platform().db.execute(
    'INSERT INTO chat_message_queue (id, conversation_id, payload) VALUES (?, ?, ?)',
    [message.id, conversationId, JSON.stringify(message)]
  );
  if (result.changes !== 1) throw new Error('The queued message was not saved.');
}

export async function loadQueuedMessages(conversationId: string): Promise<QueuedChatMessage[]> {
  if (!isDesktopRuntime()) return [];
  const rows = await platform().db.select<{ payload: string }[]>(
    `SELECT q.payload FROM chat_message_queue q
     WHERE q.conversation_id = ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = q.id)
     ORDER BY q.rowid`,
    [conversationId]
  );
  return rows.map(({ payload }) => JSON.parse(payload) as QueuedChatMessage);
}
