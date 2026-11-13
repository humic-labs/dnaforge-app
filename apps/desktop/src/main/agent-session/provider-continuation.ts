import type Database from 'better-sqlite3';

import type { AgentProvider } from './types';

export interface ProviderContinuationLookup {
  conversationId: string | null;
  turnId: string | null;
  provider: AgentProvider;
}

export function findProviderContinuation(
  db: Database.Database,
  input: ProviderContinuationLookup
): string | null {
  if (!input.conversationId || !input.turnId) return null;

  const row = db
    .prepare(
      `
        WITH current_turn AS (
          SELECT rowid AS current_rowid
          FROM chat_turns
          WHERE id = ? AND conversation_id = ?
        ),
        previous_turn AS (
          SELECT turn.id, turn.route_kind, turn.transport, turn.status
          FROM chat_turns AS turn, current_turn AS current
          WHERE turn.conversation_id = ?
            AND turn.rowid < current.current_rowid
          ORDER BY turn.rowid DESC
          LIMIT 1
        )
        SELECT session.provider_conversation_id AS provider_conversation_id
        FROM previous_turn AS turn
        JOIN agent_sessions AS session ON session.turn_id = turn.id
        WHERE turn.route_kind = 'cli'
          AND turn.transport = ?
          AND turn.status IN ('completed', 'stopped', 'cancelled', 'interrupted')
          AND session.conversation_id = ?
          AND session.provider = ?
          AND session.status IN ('completed', 'stop_requested', 'cancelled', 'interrupted')
          AND session.provider_conversation_id IS NOT NULL
          AND length(trim(session.provider_conversation_id)) > 0
        ORDER BY session.started_at DESC, session.rowid DESC
        LIMIT 1
      `
    )
    .get(
      input.turnId,
      input.conversationId,
      input.conversationId,
      input.provider,
      input.conversationId,
      input.provider
    ) as { provider_conversation_id: string } | undefined;

  return row?.provider_conversation_id.trim() || null;
}
