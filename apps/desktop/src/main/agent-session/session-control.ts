import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ForkConversationInput {
  conversationId: string;
  now?: () => number;
  idGenerator?: () => string;
}

export function forkConversation(
  db: Database.Database,
  input: ForkConversationInput
): { conversationId: string; parentConversationId: string } {
  const source = db
    .prepare(
      `SELECT title, workspace_path, provider, model
         FROM conversations
        WHERE id = ?`
    )
    .get(input.conversationId) as
    | {
        title: string;
        workspace_path: string | null;
        provider: string | null;
        model: string | null;
      }
    | undefined;
  if (!source) throw new Error('The conversation to fork no longer exists.');

  const idGenerator = input.idGenerator ?? randomUUID;
  const conversationId = idGenerator();
  const createdAt = (input.now ?? Date.now)();
  const messages = db
    .prepare(
      `SELECT id, role, content, tool_name, tool_call_id, turn_id, created_at
         FROM messages
        WHERE conversation_id = ?
        ORDER BY rowid`
    )
    .all(input.conversationId) as Array<{
    id: string;
    role: string;
    content: string;
    tool_name: string | null;
    tool_call_id: string | null;
    turn_id: string | null;
    created_at: number;
  }>;
  const structuredTurns = db
    .prepare(
      `SELECT turn.id, turn.route_kind, turn.host_id, turn.provider, turn.model,
              turn.transport, turn.authority_profile_id, turn.permission_mode,
              turn.route_snapshot_json, turn.status, turn.terminal_reason,
              turn.error, turn.started_at, turn.completed_at,
              output.schema_json, output.raw_result, output.validation_status,
              output.parsed_json, output.validation_error, output.artifact_id,
              output.created_at AS output_created_at
         FROM chat_turns turn
         JOIN agent_structured_outputs output ON output.turn_id = turn.id
        WHERE turn.conversation_id = ?
        ORDER BY turn.started_at, turn.id`
    )
    .all(input.conversationId) as Array<{
    id: string;
    route_kind: string;
    host_id: string;
    provider: string | null;
    model: string | null;
    transport: string | null;
    authority_profile_id: string | null;
    permission_mode: string | null;
    route_snapshot_json: string;
    status: string;
    terminal_reason: string | null;
    error: string | null;
    started_at: number;
    completed_at: number | null;
    schema_json: string;
    raw_result: string;
    validation_status: 'valid' | 'invalid';
    parsed_json: string | null;
    validation_error: string | null;
    artifact_id: string;
    output_created_at: number;
  }>;
  const runningTurn = db
    .prepare(
      `SELECT 1
         FROM chat_turns
        WHERE conversation_id = ? AND status = 'running'
        LIMIT 1`
    )
    .get(input.conversationId);
  if (runningTurn) throw new Error('Pause the active turn before forking this conversation.');

  db.transaction(() => {
    db.prepare(
      `INSERT INTO conversations (
         id, title, workspace_path, pinned, provider, model, created_at, updated_at
       ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(
      conversationId,
      `${source.title} (fork)`.slice(0, 160),
      source.workspace_path,
      source.provider,
      source.model,
      createdAt,
      createdAt
    );
    const forkedTurnIds = new Map<string, string>();
    const insertTurn = db.prepare(
      `INSERT INTO chat_turns (
         id, conversation_id, route_kind, host_id, provider, model, transport,
         authority_profile_id, permission_mode, route_snapshot_json, status,
         terminal_reason, error, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertStructuredOutput = db.prepare(
      `INSERT INTO agent_structured_outputs (
         turn_id, schema_json, raw_result, validation_status, parsed_json,
         validation_error, artifact_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const turn of structuredTurns) {
      const nextTurnId = idGenerator();
      forkedTurnIds.set(turn.id, nextTurnId);
      insertTurn.run(
        nextTurnId,
        conversationId,
        turn.route_kind,
        turn.host_id,
        turn.provider,
        turn.model,
        turn.transport,
        turn.authority_profile_id,
        turn.permission_mode,
        turn.route_snapshot_json,
        turn.status,
        turn.terminal_reason,
        turn.error,
        turn.started_at,
        turn.completed_at
      );
      insertStructuredOutput.run(
        nextTurnId,
        turn.schema_json,
        turn.raw_result,
        turn.validation_status,
        turn.parsed_json,
        turn.validation_error,
        turn.artifact_id,
        turn.output_created_at
      );
    }
    const insertMessage = db.prepare(
      `INSERT INTO messages (
         id, conversation_id, role, content, tool_name, tool_call_id, turn_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const copyReferences = db.prepare(
      `INSERT INTO message_references (message_id, reference_id, position)
       SELECT ?, reference_id, position FROM message_references WHERE message_id = ?`
    );
    const copyAttachments = db.prepare(
      `INSERT INTO message_attachments (
         message_id, attachment_id, position, name, media_type, size, sha256, kind
       )
       SELECT ?, attachment_id, position, name, media_type, size, sha256, kind
       FROM message_attachments WHERE message_id = ?`
    );
    for (const message of messages) {
      const nextMessageId = idGenerator();
      insertMessage.run(
        nextMessageId,
        conversationId,
        message.role,
        message.content,
        message.tool_name,
        message.tool_call_id,
        message.turn_id ? (forkedTurnIds.get(message.turn_id) ?? null) : null,
        message.created_at
      );
      copyReferences.run(nextMessageId, message.id);
      copyAttachments.run(nextMessageId, message.id);
    }
    db.prepare(
      `INSERT INTO conversation_lineage (
         conversation_id, parent_conversation_id, relation, created_at
       ) VALUES (?, ?, 'fork', ?)`
    ).run(conversationId, input.conversationId, createdAt);
  })();

  return { conversationId, parentConversationId: input.conversationId };
}
