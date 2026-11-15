import { platform } from '../platform';
import type {
  ChatTurnIpcStatus,
  CommitChatTurnTerminalStateRequest,
  CommitChatTurnTerminalStateResult,
  CreateChatTurnWithUserMessageRequest,
} from '../shared/chat-turn-ipc';
import {
  isAgentAttachmentManifest,
  type AgentAttachmentManifest,
} from '../shared/agent-attachments';
import type { AgentStructuredOutputReceipt } from '../shared/agent-structured-output';
export { getSetting, setSetting } from './settings';
export { db } from './connection';

export function getConnection(): ReturnType<typeof platform>['db'] {
  return platform().db;
}

export interface DBConversation {
  id: string;
  title: string;
  workspace_path: string | null;
  pinned: number;
  provider: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
}

export interface DBMessage {
  id: string;
  conversation_id: string;
  turn_id?: string | null;
  role: 'user' | 'assistant' | 'tool' | 'activity';
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  created_at: number;
}

export type DBChatTurnStatus = ChatTurnIpcStatus;

export interface DBChatTurn {
  id: string;
  conversation_id: string;
  route_kind: string;
  host_id: string;
  provider: string | null;
  model: string | null;
  transport: string | null;
  authority_profile_id: string | null;
  permission_mode: string | null;
  route_snapshot_json: string;
  status: DBChatTurnStatus;
  terminal_reason: string | null;
  error: string | null;
  started_at: number;
  completed_at: number | null;
}

export async function createConversation(
  id: string,
  title: string,
  workspacePath: string | null,
  provider?: string | null,
  model?: string | null
): Promise<DBConversation> {
  const sqlite = platform().db;
  const now = Date.now();
  await sqlite.execute(
    `INSERT INTO conversations (id, title, workspace_path, pinned, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, workspacePath, 0, provider ?? null, model ?? null, now, now]
  );
  return {
    id,
    title,
    workspace_path: workspacePath,
    pinned: 0,
    provider: provider ?? null,
    model: model ?? null,
    created_at: now,
    updated_at: now,
  };
}

export async function getConversations(workspacePath: string | null): Promise<DBConversation[]> {
  const sqlite = platform().db;

  if (workspacePath) {
    return sqlite.select<DBConversation[]>(
      `SELECT * FROM conversations WHERE workspace_path = ? ORDER BY pinned DESC, updated_at DESC`,
      [workspacePath]
    );
  }
  return sqlite.select<DBConversation[]>(
    `SELECT * FROM conversations WHERE workspace_path IS NULL ORDER BY pinned DESC, updated_at DESC`
  );
}

export async function getConversationHistory(): Promise<DBConversation[]> {
  const sqlite = platform().db;

  return sqlite.select<DBConversation[]>(
    `SELECT c.*
       FROM conversations c
      WHERE EXISTS (
        SELECT 1
          FROM messages m
         WHERE m.conversation_id = c.id
      )
      ORDER BY c.pinned DESC, c.updated_at DESC`
  );
}

export async function getConversation(id: string): Promise<DBConversation | null> {
  const sqlite = platform().db;
  const result = await sqlite.select<DBConversation[]>(`SELECT * FROM conversations WHERE id = ?`, [
    id,
  ]);
  return result.length > 0 ? result[0] : null;
}

export type ConversationRowWriteResult = {
  status: 'updated' | 'missing' | 'not_applied' | 'not_attested';
};

export async function updateConversationWithResult(
  id: string,
  title: string
): Promise<ConversationRowWriteResult> {
  const result = await platform().db.execute(
    `UPDATE conversations SET title = ?, title_locked = 1, updated_at = ? WHERE id = ?`,
    [title, Date.now(), id]
  );
  return {
    status:
      result?.changes === 1 ? 'updated' : result?.changes === 0 ? 'not_applied' : 'not_attested',
  };
}
export async function updateConversation(id: string, title: string): Promise<void> {
  await updateConversationWithResult(id, title);
}

export async function updateConversationTitleIfUnchanged(
  id: string,
  expectedTitle: string,
  title: string
): Promise<boolean> {
  const result = await platform().db.execute(
    `UPDATE conversations SET title = ? WHERE id = ? AND title = ? AND title_locked = 0`,
    [title, id, expectedTitle]
  );
  return result.changes === 1;
}

export async function updateConversationRoute(
  id: string,
  provider: string | null,
  model: string | null
): Promise<void> {
  const sqlite = platform().db;
  await sqlite.execute(
    `UPDATE conversations SET provider = ?, model = ?, updated_at = ? WHERE id = ?`,
    [provider, model, Date.now(), id]
  );
}

export async function deleteConversation(id: string): Promise<void> {
  const sqlite = platform().db;
  if (typeof sqlite.deleteConversation !== 'function') {
    throw new Error('Atomic conversation deletion is not available on this platform bridge.');
  }
  await sqlite.deleteConversation(id);
  await platform()
    .conversationLedger.unlinkConversation(id)
    .catch((error) =>
      console.warn('[ConversationLedger] Best-effort shadow unlink failed:', error)
    );
}

export async function toggleConversationPinnedWithResult(
  id: string
): Promise<ConversationRowWriteResult & { pinned: boolean }> {
  const sqlite = platform().db;
  const rows = await sqlite.select<{ pinned: number }[]>(
    `SELECT pinned FROM conversations WHERE id = ?`,
    [id]
  );
  if (rows.length === 0) return { status: 'missing', pinned: false };
  const newPinned = rows[0].pinned === 1 ? 0 : 1;
  const result = await sqlite.execute(`UPDATE conversations SET pinned = ? WHERE id = ?`, [
    newPinned,
    id,
  ]);
  return {
    status:
      result?.changes === 1 ? 'updated' : result?.changes === 0 ? 'not_applied' : 'not_attested',
    pinned: newPinned === 1,
  };
}
export async function toggleConversationPinned(id: string): Promise<boolean> {
  return (await toggleConversationPinnedWithResult(id)).pinned;
}

export async function addMessage(message: DBMessage): Promise<void> {
  const sqlite = platform().db;
  await sqlite.execute(
    `INSERT INTO messages (id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.conversation_id,
      message.turn_id ?? null,
      message.role,
      message.content,
      message.tool_name,
      message.tool_call_id,
      message.created_at,
    ]
  );

  await sqlite.execute(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [
    Date.now(),
    message.conversation_id,
  ]);
}

export async function createChatTurnWithUserMessage(
  input: CreateChatTurnWithUserMessageRequest
): Promise<void> {
  const sqlite = platform().db;
  if (typeof sqlite.createChatTurnWithUserMessage !== 'function') {
    throw new Error('Atomic chat-turn creation is not available on this platform bridge.');
  }
  await sqlite.createChatTurnWithUserMessage(input satisfies CreateChatTurnWithUserMessageRequest);
}

export async function commitChatTurnTerminalState(
  input: CommitChatTurnTerminalStateRequest
): Promise<CommitChatTurnTerminalStateResult> {
  const commit = platform().db.commitChatTurnTerminalState;
  if (typeof commit !== 'function') {
    throw new Error('Atomic terminal chat-turn persistence is not available on this platform.');
  }
  return commit(input);
}

export async function updateChatTurnStatus(
  id: string,
  status: DBChatTurnStatus,
  options: {
    terminalReason?: string | null;
    error?: string | null;
    completedAt?: number | null;
  } = {}
): Promise<void> {
  const sqlite = platform().db;
  const completedAt =
    options.completedAt !== undefined
      ? options.completedAt
      : status === 'running'
        ? null
        : Date.now();
  await sqlite.execute(
    `UPDATE chat_turns
     SET status = ?, terminal_reason = ?, error = ?, completed_at = ?
     WHERE id = ?`,
    [status, options.terminalReason ?? null, options.error ?? null, completedAt, id]
  );
}

export async function getChatTurns(conversationId: string): Promise<DBChatTurn[]> {
  const sqlite = platform().db;
  return sqlite.select<DBChatTurn[]>(
    `SELECT * FROM chat_turns WHERE conversation_id = ? ORDER BY started_at ASC`,
    [conversationId]
  );
}

export async function getMessages(conversationId: string): Promise<DBMessage[]> {
  const sqlite = platform().db;

  return sqlite.select<DBMessage[]>(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    [conversationId]
  );
}

export async function getRecentMessages(conversationId: string, limit = 3): Promise<DBMessage[]> {
  const sqlite = platform().db;
  return sqlite.select<DBMessage[]>(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    [conversationId, limit]
  );
}

export async function deleteMessage(id: string): Promise<void> {
  const sqlite = platform().db;
  if (typeof sqlite.deleteMessage !== 'function') {
    throw new Error('Atomic message deletion is not available on this platform bridge.');
  }
  await sqlite.deleteMessage(id);
}

export async function setMessageReferences(
  messageId: string,
  referenceIds: string[]
): Promise<void> {
  const sqlite = platform().db;
  await sqlite.execute(`DELETE FROM message_references WHERE message_id = ?`, [messageId]);
  for (let i = 0; i < referenceIds.length; i++) {
    await sqlite.execute(
      `INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)`,
      [messageId, referenceIds[i], i]
    );
  }
}

export async function getMessageReferences(messageId: string): Promise<string[]> {
  const sqlite = platform().db;
  const rows = await sqlite.select<{ reference_id: string }[]>(
    `SELECT reference_id FROM message_references WHERE message_id = ? ORDER BY position ASC`,
    [messageId]
  );
  return rows.map((row) => row.reference_id);
}

export async function getMessageReferencesForMessages(
  messageIds: string[]
): Promise<Map<string, string[]>> {
  const uniqueIds = [...new Set(messageIds)];
  const result = new Map(uniqueIds.map((messageId) => [messageId, [] as string[]]));
  if (uniqueIds.length === 0) return result;

  const sqlite = platform().db;
  const chunkSize = 400;
  for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
    const chunk = uniqueIds.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await sqlite.select<Array<{ message_id: string; reference_id: string }>>(
      `SELECT message_id, reference_id
       FROM message_references
       WHERE message_id IN (${placeholders})
       ORDER BY message_id ASC, position ASC`,
      chunk
    );
    for (const row of rows) {
      result.get(row.message_id)?.push(row.reference_id);
    }
  }
  return result;
}

export async function getMessageAttachmentsForMessages(
  messageIds: string[]
): Promise<Map<string, AgentAttachmentManifest[]>> {
  const uniqueIds = [...new Set(messageIds)];
  const result = new Map(
    uniqueIds.map((messageId) => [messageId, [] as AgentAttachmentManifest[]])
  );
  if (uniqueIds.length === 0) return result;

  const sqlite = platform().db;
  const chunkSize = 400;
  for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
    const chunk = uniqueIds.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await sqlite.select<
      Array<{
        message_id: string;
        attachment_id: string;
        name: string;
        media_type: string;
        size: number;
        sha256: string;
        kind: 'text';
      }>
    >(
      `SELECT message_id, attachment_id, name, media_type, size, sha256, kind
       FROM message_attachments
       WHERE message_id IN (${placeholders})
       ORDER BY message_id ASC, position ASC`,
      chunk
    );
    for (const row of rows) {
      const attachment: AgentAttachmentManifest = {
        id: row.attachment_id,
        name: row.name,
        mediaType: row.media_type,
        size: row.size,
        sha256: row.sha256,
        kind: row.kind,
      };
      if (isAgentAttachmentManifest(attachment)) result.get(row.message_id)?.push(attachment);
    }
  }
  return result;
}

export async function getStructuredOutputsForConversation(
  conversationId: string
): Promise<Map<string, AgentStructuredOutputReceipt>> {
  const rows = await platform().db.select<
    Array<{
      turn_id: string;
      schema_json: string;
      raw_result: string;
      validation_status: 'valid' | 'invalid';
      parsed_json: string | null;
      validation_error: string | null;
      artifact_id: string;
      created_at: number;
    }>
  >(
    `SELECT output.*
     FROM agent_structured_outputs output
     JOIN chat_turns turn ON turn.id = output.turn_id
     WHERE turn.conversation_id = ?`,
    [conversationId]
  );
  const result = new Map<string, AgentStructuredOutputReceipt>();
  for (const row of rows) {
    try {
      result.set(row.turn_id, {
        turnId: row.turn_id,
        schema: JSON.parse(row.schema_json) as Record<string, unknown>,
        rawResult: row.raw_result,
        status: row.validation_status,
        parsed: row.parsed_json === null ? null : (JSON.parse(row.parsed_json) as unknown),
        validationError: row.validation_error,
        artifactId: row.artifact_id,
        createdAt: row.created_at,
      });
    } catch {}
  }
  return result;
}

export interface DBSequence {
  id: number;

  document_id: string;
  file_id: number;
  name: string;
  description: string | null;
  length: number;
  sequence_type: string | null;
  circular: number;
  sequence: string | null;
}

export interface DBPrimerSummary {
  id: string;
  catalog_number: string | null;
  name: string;
  sequence: string;
  length: number;
  created_at: number;
  updated_at: number;
}

export async function searchSequences(query: string, limit: number = 10): Promise<DBSequence[]> {
  const sqlite = platform().db;
  if (!query.trim()) {
    return sqlite.select<DBSequence[]>(`SELECT * FROM sequences ORDER BY id DESC LIMIT ?`, [limit]);
  }
  return sqlite.select<DBSequence[]>(
    `SELECT * FROM sequences WHERE name LIKE ? ORDER BY name LIMIT ?`,
    [`%${query}%`, limit]
  );
}

export async function getSequences(limit: number = 100): Promise<DBSequence[]> {
  const sqlite = platform().db;
  return sqlite.select<DBSequence[]>(`SELECT * FROM sequences ORDER BY name LIMIT ?`, [limit]);
}

export async function getSequenceWithPath(
  id: number
): Promise<(DBSequence & { file_path: string }) | null> {
  const sqlite = platform().db;
  const result = await sqlite.select<(DBSequence & { file_path: string })[]>(
    `SELECT s.*, f.path as file_path
     FROM sequences s
     JOIN indexed_files f ON s.file_id = f.id
     WHERE s.id = ?`,
    [id]
  );
  return result.length > 0 ? result[0] : null;
}

export async function searchPrimers(query: string, limit: number = 10): Promise<DBPrimerSummary[]> {
  const sqlite = platform().db;
  const trimmed = query.trim();
  if (!trimmed) {
    return getPrimers(limit);
  }
  const like = `%${trimmed}%`;
  return sqlite.select<DBPrimerSummary[]>(
    `SELECT id, catalog_number, name, sequence, length, created_at, updated_at
     FROM primers
     WHERE name LIKE ? OR sequence LIKE ? OR catalog_number LIKE ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [like, like, like, limit]
  );
}

export async function getPrimers(limit: number = 100): Promise<DBPrimerSummary[]> {
  const sqlite = platform().db;
  return sqlite.select<DBPrimerSummary[]>(
    `SELECT id, catalog_number, name, sequence, length, created_at, updated_at
     FROM primers
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit]
  );
}

export * from './schema';
export * from './sequence-identity';
export * from './workspace-catalog';
export * from './project-memory-projection';
