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

function finalReply(provider: NativeProvider, snapshot: string): string | null {
  let event: unknown;
  try {
    event = JSON.parse(snapshot);
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
    const turn = record(record(notification?.params)?.turn);
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
    if (answers.length !== 1) return null;
    text = answers[0]?.text;
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
        `SELECT render_snapshot_json FROM agent_trace_events
      WHERE session_id = ? AND provider = ? AND terminal IS NOT NULL
      ORDER BY sequence DESC LIMIT 1`
      )
      .pluck()
      .get(turn.session_id, turn.provider);
    const content = typeof terminal === 'string' ? finalReply(turn.provider, terminal) : null;
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
