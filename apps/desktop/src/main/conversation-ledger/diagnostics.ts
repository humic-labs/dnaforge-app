import type Database from 'better-sqlite3';
import {
  readLiveMessagesFromSQLite,
  runConversationLedgerProjectionParity,
  type ConversationLedgerEventReader,
  type ConversationLedgerParityConversationResult,
  type ConversationLedgerParityReport,
} from './parity';

const DEFAULT_PARITY_DIAGNOSTIC_LIMIT = 100;

export interface ConversationLedgerParityDiagnosticsOptions {
  reader: ConversationLedgerEventReader;
  db: Database.Database;
  conversationIds?: string[];
  limit?: number;
  now?: () => string;
}

export interface ConversationLedgerParityDiagnosticsReport extends ConversationLedgerParityReport {
  generated_at: string;
  requested_conversation_count: number;
}

function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PARITY_DIAGNOSTIC_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function listConversationIdsForLedgerParity(
  db: Database.Database,
  options: { limit?: number } = {}
): string[] {
  const limit = normalizeLimit(options.limit);
  if (limit === 0) return [];

  const rows = db
    .prepare(
      `SELECT c.id
       FROM conversations c
       WHERE EXISTS (
         SELECT 1
         FROM messages m
         WHERE m.conversation_id = c.id
       )
       ORDER BY c.updated_at DESC, c.id ASC
       LIMIT ?`
    )
    .all(limit) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

export async function runConversationLedgerParityDiagnostics(
  options: ConversationLedgerParityDiagnosticsOptions
): Promise<ConversationLedgerParityDiagnosticsReport> {
  const conversationIds =
    options.conversationIds ??
    listConversationIdsForLedgerParity(options.db, { limit: options.limit });
  const results: ConversationLedgerParityConversationResult[] = [];

  for (const conversationId of conversationIds) {
    let liveCount = 0;
    try {
      const liveMessages = readLiveMessagesFromSQLite(options.db, conversationId);
      liveCount = liveMessages.length;
      const report = await runConversationLedgerProjectionParity({
        reader: options.reader,
        conversations: [
          {
            conversation_id: conversationId,
            live_messages: liveMessages,
          },
        ],
      });
      results.push(report.results[0]);
    } catch (error) {
      results.push({
        conversation_id: conversationId,
        ok: false,
        projected_count: 0,
        live_count: liveCount,
        mismatches: [`${conversationId}: ledger parity diagnostic failed: ${errorMessage(error)}`],
        projection: { conversation_id: conversationId, messages: [] },
      });
    }
  }

  return {
    ok: results.every((result) => result.ok),
    checked_conversation_count: results.length,
    requested_conversation_count: conversationIds.length,
    generated_at: options.now?.() ?? new Date().toISOString(),
    results,
  };
}
