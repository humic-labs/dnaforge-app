import type Database from 'better-sqlite3';
import type { CommitChatTurnTerminalStateRequest } from '../../shared/chat-turn-ipc';
import {
  ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
  putAnalyticsOutboxEvent,
} from '../analytics-outbox';
import {
  buildLocalAiTurnFinished,
  localAiTurnFinishedEventId,
  type LocalAiTurnTerminalInput,
} from './terminal-telemetry';

export const PENDING_NATIVE_CHAT_METRICS = '_native_chat_completion_metrics_v1:';

export function deferNativeChatMetrics(
  db: Database.Database,
  input: LocalAiTurnTerminalInput,
  now: number
): boolean {
  if (input.status !== 'completed' || input.provider === 'grok-acp' || !input.actionId)
    return false;
  const result = db
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
    SELECT ?, ?, ? FROM chat_turns t JOIN agent_sessions s ON s.turn_id = t.id
    WHERE s.id = ? AND t.id = ? AND s.conversation_id = t.conversation_id
      AND t.status = 'running' AND t.transport = s.provider AND t.route_kind = 'cli'`
    )
    .run(
      PENDING_NATIVE_CHAT_METRICS + input.sessionId,
      JSON.stringify({
        durationMs: input.durationMs,
        toolCallCount: input.toolCallCount,
        completedWorkspaceToolCount: input.completedWorkspaceToolCount,
      }),
      now,
      input.sessionId,
      input.actionId
    );
  return result.changes === 1;
}

export function settleNativeChatMetrics(
  db: Database.Database,
  request: CommitChatTurnTerminalStateRequest
): void {
  const rows = db
    .prepare(
      `SELECT s.id, s.provider, s.completed_at, s.telemetry_continuation,
      s.telemetry_had_workspace_context, m.value
    FROM agent_sessions s JOIN settings m ON m.key = ? || s.id
    WHERE s.turn_id = ? AND s.conversation_id = ?`
    )
    .all(PENDING_NATIVE_CHAT_METRICS, request.turn_id, request.conversation_id) as Array<{
    id: string;
    provider: 'claude-agent-sdk' | 'codex-sdk';
    completed_at: number;
    telemetry_continuation: number;
    telemetry_had_workspace_context: number;
    value: string;
  }>;
  for (const row of rows) {
    const metrics = JSON.parse(row.value) as Pick<
      LocalAiTurnTerminalInput,
      'durationMs' | 'toolCallCount' | 'completedWorkspaceToolCount'
    >;
    const reply =
      request.status === 'completed'
        ? request.messages.findLast((entry) => entry.message.role === 'assistant')?.message.content
        : undefined;
    const properties = buildLocalAiTurnFinished({
      sessionId: row.id,
      provider: row.provider,
      status: 'completed',
      actionId: request.turn_id,
      durationMs: metrics.durationMs,
      toolCallCount: metrics.toolCallCount,
      completedWorkspaceToolCount: metrics.completedWorkspaceToolCount,
      visibleAssistantText: reply?.trim() === '(no text)' ? '' : (reply ?? ''),
      hadWorkspaceContext: row.telemetry_had_workspace_context === 1,
      continuation: row.telemetry_continuation === 1,
    });
    putAnalyticsOutboxEvent(db, {
      eventId: localAiTurnFinishedEventId(row.id),
      eventName: 'ai_turn_finished',
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'ai_turn_terminal',
      referenceId: row.id,
      properties,
      createdAtMs: row.completed_at,
    });
    db.prepare('DELETE FROM settings WHERE key = ?').run(PENDING_NATIVE_CHAT_METRICS + row.id);
  }
}
