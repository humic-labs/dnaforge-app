import { randomBytes } from 'node:crypto';
import { CONVERSATION_LEDGER_SCHEMA_VERSION } from './constants';
import { serializeLedgerPayload, type JsonSafeValue } from './serialize';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type ConversationLedgerSource =
  | 'app:chat'
  | 'provider:vercel'
  | 'hosted:router'
  | 'cli:claude-agent'
  | 'cli:codex'
  | 'cli:grok'
  | 'system';

export interface ConversationLedgerAppendInput {
  conversation_id: string;
  turn_id?: string | null;
  source: ConversationLedgerSource;
  provider: string | null;
  model: string | null;
  stream_event_type: string;
  payload: unknown;
  block_id?: string | null;
  call_id?: string | null;
  item_id?: string | null;
  created_at?: string;
}

export interface ConversationLedgerEvent {
  schema_version: typeof CONVERSATION_LEDGER_SCHEMA_VERSION;
  event_id: string;
  event_seq: number;
  conversation_id: string;
  turn_id: string | null;
  source: ConversationLedgerSource;
  provider: string | null;
  model: string | null;
  stream_event_type: string;
  block_id: string | null;
  call_id: string | null;
  item_id: string | null;
  payload: JsonSafeValue;
  created_at: string;
}

function encodeTime(nowMs: number): string {
  let value = Math.max(0, Math.floor(nowMs));
  let output = '';
  for (let i = 0; i < 10; i += 1) {
    output = ULID_ALPHABET[value % 32] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandom(): string {
  const bytes = randomBytes(16);
  let output = '';
  for (let i = 0; i < 16; i += 1) {
    output += ULID_ALPHABET[bytes[i] & 31];
  }
  return output;
}

export function createConversationLedgerEventId(nowMs = Date.now()): string {
  return `${encodeTime(nowMs)}${encodeRandom()}`;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function inferLedgerCorrelationIds(payload: unknown): {
  block_id: string | null;
  call_id: string | null;
  item_id: string | null;
} {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { block_id: null, call_id: null, item_id: null };
  }
  const raw = payload as Record<string, unknown>;
  return {
    block_id:
      stringField(raw.blockId) ??
      stringField(raw.block_id) ??
      stringField(raw.providerItemId) ??
      null,
    call_id:
      stringField(raw.callId) ??
      stringField(raw.call_id) ??
      stringField(raw.toolCallId) ??
      stringField(raw.tool_call_id) ??
      null,
    item_id:
      stringField(raw.itemId) ??
      stringField(raw.item_id) ??
      stringField(raw.providerItemId) ??
      null,
  };
}

export function createConversationLedgerEnvelope(
  input: ConversationLedgerAppendInput,
  assigned: {
    event_id: string;
    event_seq: number;
    created_at: string;
  }
): ConversationLedgerEvent {
  const inferred = inferLedgerCorrelationIds(input.payload);
  return {
    schema_version: CONVERSATION_LEDGER_SCHEMA_VERSION,
    event_id: assigned.event_id,
    event_seq: assigned.event_seq,
    conversation_id: input.conversation_id,
    turn_id: input.turn_id ?? null,
    source: input.source,
    provider: input.provider,
    model: input.model,
    stream_event_type: input.stream_event_type,
    block_id: input.block_id ?? inferred.block_id,
    call_id: input.call_id ?? inferred.call_id,
    item_id: input.item_id ?? inferred.item_id,
    payload: serializeLedgerPayload(input.payload),
    created_at: input.created_at ?? assigned.created_at,
  };
}
