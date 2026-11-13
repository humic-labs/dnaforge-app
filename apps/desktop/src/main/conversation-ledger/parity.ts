import type { ConversationLedgerEvent } from './envelope';
import type Database from 'better-sqlite3';
import {
  compareProjectedMessagesToLive,
  projectConversationLedgerEvents,
  type LiveMessageComparable,
  type ProjectedLedgerConversation,
} from './projection';

export interface ConversationLedgerEventReader {
  readEvents(conversationId: string): Promise<ConversationLedgerEvent[]>;
}

export interface ConversationLedgerParityInput {
  conversation_id: string;
  live_messages: LiveMessageComparable[];
}

export interface ConversationLedgerSQLiteMessageRow {
  role: string;
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
}

export interface ConversationLedgerParityConversationResult {
  conversation_id: string;
  ok: boolean;
  projected_count: number;
  live_count: number;
  mismatches: string[];
  projection: ProjectedLedgerConversation;
}

export interface ConversationLedgerParityReport {
  ok: boolean;
  checked_conversation_count: number;
  results: ConversationLedgerParityConversationResult[];
}

function isLiveMessageRole(value: string): value is LiveMessageComparable['role'] {
  return value === 'user' || value === 'assistant' || value === 'tool' || value === 'activity';
}

export function sqliteRowsToLiveMessages(
  rows: ConversationLedgerSQLiteMessageRow[]
): LiveMessageComparable[] {
  return rows
    .filter((row) => isLiveMessageRole(row.role))
    .map((row) => ({
      role: row.role as LiveMessageComparable['role'],
      content: row.content,
      tool_name: row.tool_name,
      tool_call_id: row.tool_call_id,
    }));
}

export function readLiveMessagesFromSQLite(
  db: Database.Database,
  conversationId: string
): LiveMessageComparable[] {
  const rows = db
    .prepare(
      `SELECT role, content, tool_name, tool_call_id
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`
    )
    .all(conversationId) as ConversationLedgerSQLiteMessageRow[];
  return sqliteRowsToLiveMessages(rows);
}

export async function projectConversationFromLedger(
  reader: ConversationLedgerEventReader,
  conversationId: string
): Promise<ProjectedLedgerConversation> {
  const events = await reader.readEvents(conversationId);
  return (
    projectConversationLedgerEvents(events).find(
      (projection) => projection.conversation_id === conversationId
    ) ?? { conversation_id: conversationId, messages: [] }
  );
}

export async function runConversationLedgerProjectionParity(options: {
  reader: ConversationLedgerEventReader;
  conversations: ConversationLedgerParityInput[];
}): Promise<ConversationLedgerParityReport> {
  const results: ConversationLedgerParityConversationResult[] = [];

  for (const input of options.conversations) {
    const projection = await projectConversationFromLedger(options.reader, input.conversation_id);
    const comparison = compareProjectedMessagesToLive(projection.messages, input.live_messages);
    results.push({
      conversation_id: input.conversation_id,
      ok: comparison.ok,
      projected_count: projection.messages.length,
      live_count: input.live_messages.length,
      mismatches: comparison.mismatches.map((mismatch) => `${input.conversation_id}: ${mismatch}`),
      projection,
    });
  }

  return {
    ok: results.every((result) => result.ok),
    checked_conversation_count: results.length,
    results,
  };
}

export async function runConversationLedgerSQLiteProjectionParity(options: {
  reader: ConversationLedgerEventReader;
  db: Database.Database;
  conversationIds: string[];
}): Promise<ConversationLedgerParityReport> {
  return runConversationLedgerProjectionParity({
    reader: options.reader,
    conversations: options.conversationIds.map((conversation_id) => ({
      conversation_id,
      live_messages: readLiveMessagesFromSQLite(options.db, conversation_id),
    })),
  });
}
