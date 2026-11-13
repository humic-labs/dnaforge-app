export type ConversationLedgerSourceShape =
  | 'app:chat'
  | 'provider:vercel'
  | 'hosted:router'
  | 'cli:claude-agent'
  | 'cli:codex'
  | 'cli:grok'
  | 'system';

export const CHAT_TURN_MATERIALIZED_EVENT = 'chat.turn-materialized';

export interface ConversationLedgerAppendInputShape {
  conversation_id: string;
  turn_id?: string | null;
  source: ConversationLedgerSourceShape;
  provider: string | null;
  model: string | null;
  stream_event_type: string;
  payload: unknown;
  block_id?: string | null;
  call_id?: string | null;
  item_id?: string | null;
  created_at?: string;
}

export interface ConversationLedgerEventShape {
  schema_version: number;
  event_id: string;
  event_seq: number;
  conversation_id: string;
  turn_id: string | null;
  source: ConversationLedgerSourceShape;
  provider: string | null;
  model: string | null;
  stream_event_type: string;
  block_id: string | null;
  call_id: string | null;
  item_id: string | null;
  payload: unknown;
  created_at: string;
}

export interface ConversationLedgerAppendResultShape {
  ok: boolean;
  event: ConversationLedgerEventShape | null;
}

export type ConversationLedgerUnlinkResultShape = { ok: true } | { ok: false; error: string };
