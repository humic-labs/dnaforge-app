import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { commitChatTurnTerminalStateInDb } from '../ipc/database';
import { NATIVE_REPLY_UNAVAILABLE } from '../../shared/chat-turn-ipc';
import {
  claimsCompletedBiologyArtifact,
  sanitizeAssistantArtifactMetadata,
} from '../../features/ai/orchestration/assistant-artifact-prose';

type NativeProvider = 'claude-agent-sdk' | 'codex-sdk';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function completedCodexItem(
  db: Database.Database,
  sessionId: string,
  sequence: number,
  threadId: unknown,
  turnId: unknown
): unknown {
  if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId)
    return null;
  const items = db
    .prepare(
      `
    SELECT json_extract(render_snapshot_json, '$.raw.appServer.params.item.text')
      FROM agent_trace_events
     WHERE session_id = ? AND provider = 'codex-sdk' AND sequence < ? AND event_type = 'item.completed'
       AND json_valid(render_snapshot_json)
       AND json_extract(render_snapshot_json, '$.raw.appServer.method') = 'item/completed'
       AND json_extract(render_snapshot_json, '$.raw.appServer.params.threadId') = ?
       AND json_extract(render_snapshot_json, '$.raw.appServer.params.turnId') = ?
       AND json_extract(render_snapshot_json, '$.raw.appServer.params.item.type') = 'agentMessage'
       AND json_extract(render_snapshot_json, '$.raw.appServer.params.item.phase') = 'final_answer'
     LIMIT 2`
    )
    .pluck()
    .all(sessionId, sequence, threadId, turnId);
  return items.length === 1 ? items[0] : null;
}

function finalReply(
  db: Database.Database,
  provider: NativeProvider,
  sessionId: string,
  terminal: { render_snapshot_json: string; sequence: number }
): string | null {
  let event: unknown;
  try {
    event = JSON.parse(terminal.render_snapshot_json);
  } catch {
    return null;
  }
  const trace = record(event);
  if (trace?.transport !== provider || trace.terminal !== 'completed') return null;
  const raw = record(trace.raw);
  let text: unknown;
  if (provider === 'claude-agent-sdk') {
    if (
      raw?.type !== 'result' ||
      raw.subtype !== 'success' ||
      raw.is_error !== false ||
      (raw.stop_reason != null &&
        raw.stop_reason !== 'end_turn' &&
        raw.stop_reason !== 'stop_sequence')
    )
      return null;
    text = raw.result;
  } else {
    const notification = record(raw?.appServer);
    const params = record(notification?.params);
    const turn = record(params?.turn);
    if (
      notification?.method !== 'turn/completed' ||
      turn?.status !== 'completed' ||
      turn.error ||
      !Array.isArray(turn.items)
    )
      return null;
    const answers = turn.items
      .map(record)
      .filter((item) => item?.type === 'agentMessage' && item.phase === 'final_answer');
    if (turn.items.length === 0) {
      text = completedCodexItem(db, sessionId, terminal.sequence, params?.threadId, turn.id);
    } else if (answers.length === 1) {
      text = answers[0]?.text;
    }
  }
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    text.includes('[REDACTED]') ||
    text.trim() === '(no text)'
  )
    return null;
  const content = sanitizeAssistantArtifactMetadata(text);
  if (!content) return null;
  return claimsCompletedBiologyArtifact(content)
    ? content + '\n\nNo saved artifact could be verified for the completion claim above.'
    : content;
}

export function recoverCompletedNativeChatTurns(db: Database.Database, now: number): void {
  const turns = db
    .prepare(
      `
    SELECT t.id, t.conversation_id, s.id AS session_id, s.provider, s.completed_at
    FROM chat_turns t JOIN agent_sessions s ON s.turn_id = t.id
    WHERE t.status = 'running' AND t.terminal_reason IS NULL AND t.route_kind = 'cli'
      AND s.conversation_id = t.conversation_id AND s.provider = t.transport
      AND s.provider IN ('claude-agent-sdk', 'codex-sdk')
      AND s.status = 'completed' AND s.completed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agent_sessions other WHERE other.turn_id = t.id AND other.id != s.id)
  `
    )
    .all() as Array<{
    id: string;
    conversation_id: string;
    session_id: string;
    provider: NativeProvider;
    completed_at: number;
  }>;
  for (const turn of turns) {
    const terminal = db
      .prepare(
        `SELECT render_snapshot_json, sequence FROM agent_trace_events
      WHERE session_id = ? AND provider = ? AND terminal IS NOT NULL
      ORDER BY sequence DESC LIMIT 1`
      )
      .get(turn.session_id, turn.provider) as
      | { render_snapshot_json: string; sequence: number }
      | undefined;
    const content = terminal ? finalReply(db, turn.provider, turn.session_id, terminal) : null;
    commitChatTurnTerminalStateInDb(
      db,
      {
        turn_id: turn.id,
        conversation_id: turn.conversation_id,
        completed_at: turn.completed_at,
        status: content ? 'completed' : 'interrupted',
        terminal_reason: content ? 'completed' : NATIVE_REPLY_UNAVAILABLE,
        error: null,
        messages: content
          ? [
              {
                message: {
                  id: randomUUID(),
                  turn_id: turn.id,
                  conversation_id: turn.conversation_id,
                  role: 'assistant',
                  content,
                  created_at: turn.completed_at,
                  tool_name: null,
                  tool_call_id: null,
                },
                reference_ids: [],
              },
            ]
          : [],
      },
      () => now
    );
  }
}
