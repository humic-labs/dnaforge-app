import type { ConversationLedgerEvent } from './envelope';
import type { JsonSafeValue } from './serialize';
import { CHAT_TURN_MATERIALIZED_EVENT } from '../../shared/conversation-ledger-ipc';
import type { ChatEntityReferenceIpcRow } from '../../shared/chat-turn-ipc';
import { isHistoryReactivatableTool } from '../../shared/tool-history-policy';
import {
  reconcileTraceToolCalls,
  shouldReplaceTraceLifecycle,
  type TraceToolCallLifecycle,
} from '../../shared/cli-trace-lifecycle';

export type ProjectedLedgerRole = 'user' | 'assistant' | 'tool' | 'activity';

export interface ProjectedLedgerMessage {
  conversation_id: string;
  turn_id: string | null;
  role: ProjectedLedgerRole;
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  first_event_seq: number;
  last_event_seq: number;
  message_id?: string;
  reference_ids?: string[];
}

export interface ProjectedLedgerConversation {
  conversation_id: string;
  messages: ProjectedLedgerMessage[];
  entity_references?: ChatEntityReferenceIpcRow[];
}

export interface LiveMessageComparable {
  role: ProjectedLedgerRole;
  content: string;
  tool_name?: string | null;
  tool_call_id?: string | null;
}

export interface ProjectionParityResult {
  ok: boolean;
  mismatches: string[];
}

interface TurnAccumulator {
  conversationId: string;
  turnId: string | null;
  messages: ProjectedLedgerMessage[];
  pendingProviderText: string;
  pendingProviderTextStartSeq: number | null;
  pendingProviderTextLastSeq: number | null;
  cliAssistantIndexes: Map<string, number>;
  cliActivityIndexes: Map<string, number>;
  cliTracePayloads: Map<string, Record<string, unknown>>;
  cliToolRequests: Map<
    string,
    { name: string; input: unknown; providerItemId: string | null; firstEventSeq: number }
  >;
  cliCompletedHistoryCalls: Set<string>;
  materialized: boolean;
  entityReferences: Map<string, ChatEntityReferenceIpcRow>;
}

const DIAGNOSTIC_TRACE_KINDS = new Set(['assistant_text', 'lifecycle', 'result', 'unknown']);
const DIAGNOSTIC_PROVIDER_EVENTS = new Set(['thread.started', 'turn.started', 'turn.completed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: JsonSafeValue | undefined): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return [];
}

function asNumberArray(value: unknown): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) return [value];
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is number => typeof item === 'number' && Number.isFinite(item)
    );
  }
  return [];
}

function turnKey(event: ConversationLedgerEvent): string {
  return `${event.conversation_id}\u0000${event.turn_id ?? ''}`;
}

function getTurn(
  turns: Map<string, TurnAccumulator>,
  event: ConversationLedgerEvent
): TurnAccumulator {
  const key = turnKey(event);
  const existing = turns.get(key);
  if (existing) return existing;
  const created: TurnAccumulator = {
    conversationId: event.conversation_id,
    turnId: event.turn_id,
    messages: [],
    pendingProviderText: '',
    pendingProviderTextStartSeq: null,
    pendingProviderTextLastSeq: null,
    cliAssistantIndexes: new Map(),
    cliActivityIndexes: new Map(),
    cliTracePayloads: new Map(),
    cliToolRequests: new Map(),
    cliCompletedHistoryCalls: new Set(),
    materialized: false,
    entityReferences: new Map(),
  };
  turns.set(key, created);
  return created;
}

function pushMessage(turn: TurnAccumulator, message: ProjectedLedgerMessage): void {
  turn.messages.push(message);
}

function flushProviderText(turn: TurnAccumulator, eventSeq: number): void {
  if (!turn.pendingProviderText) return;
  pushMessage(turn, {
    conversation_id: turn.conversationId,
    turn_id: turn.turnId,
    role: 'assistant',
    content: turn.pendingProviderText,
    tool_name: null,
    tool_call_id: null,
    first_event_seq: turn.pendingProviderTextStartSeq ?? eventSeq,
    last_event_seq: turn.pendingProviderTextLastSeq ?? eventSeq,
  });
  turn.pendingProviderText = '';
  turn.pendingProviderTextStartSeq = null;
  turn.pendingProviderTextLastSeq = null;
}

function projectUserMessage(event: ConversationLedgerEvent, turn: TurnAccumulator): void {
  const payload = asRecord(event.payload);
  const message = asRecord(payload?.message as JsonSafeValue | undefined);
  const content = asString(message?.content);
  if (content === null) return;
  pushMessage(turn, {
    conversation_id: event.conversation_id,
    turn_id: event.turn_id,
    role: 'user',
    content,
    tool_name: null,
    tool_call_id: null,
    first_event_seq: event.event_seq,
    last_event_seq: event.event_seq,
  });
}

function parseEntityReference(value: unknown): ChatEntityReferenceIpcRow | null {
  if (!isRecord(value)) return null;
  const requiredStrings = [
    'id',
    'entity_type',
    'display_label',
    'locator',
    'source',
    'status',
  ] as const;
  if (requiredStrings.some((key) => typeof value[key] !== 'string')) return null;
  const nullableStrings = [
    'deep_link_params',
    'data',
    'workspace_scope',
    'workspace_root_path',
  ] as const;
  if (
    nullableStrings.some(
      (key) => value[key] !== null && value[key] !== undefined && typeof value[key] !== 'string'
    ) ||
    typeof value.created_at !== 'number' ||
    typeof value.updated_at !== 'number'
  ) {
    return null;
  }
  return {
    id: value.id as string,
    entity_type: value.entity_type as string,
    display_label: value.display_label as string,
    locator: value.locator as string,
    deep_link_params: (value.deep_link_params as string | null | undefined) ?? null,
    data: (value.data as string | null | undefined) ?? null,
    source: value.source as string,
    status: value.status as string,
    workspace_scope: (value.workspace_scope as string | null | undefined) ?? null,
    workspace_root_path: (value.workspace_root_path as string | null | undefined) ?? null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function projectMaterializedTurn(event: ConversationLedgerEvent, turn: TurnAccumulator): void {
  const payload = asRecord(event.payload);
  if (!payload || payload.schema_version !== 1 || !Array.isArray(payload.messages)) return;

  turn.pendingProviderText = '';
  turn.pendingProviderTextStartSeq = null;
  turn.pendingProviderTextLastSeq = null;
  turn.messages = turn.messages.filter((message) => message.role === 'user');
  turn.cliAssistantIndexes.clear();
  turn.cliActivityIndexes.clear();
  turn.cliTracePayloads.clear();
  turn.cliToolRequests.clear();
  turn.cliCompletedHistoryCalls.clear();
  turn.entityReferences.clear();

  for (const value of payload.messages) {
    const entry = asRecord(value as JsonSafeValue);
    const message = asRecord(entry?.message as JsonSafeValue | undefined);
    const messageId = asString(message?.id);
    const role = asString(message?.role);
    const content = asString(message?.content);
    if (
      !messageId ||
      !role ||
      !['assistant', 'tool', 'activity'].includes(role) ||
      content === null
    ) {
      continue;
    }
    pushMessage(turn, {
      conversation_id: event.conversation_id,
      turn_id: event.turn_id,
      role: role as ProjectedLedgerRole,
      content,
      tool_name: asString(message?.tool_name),
      tool_call_id: asString(message?.tool_call_id),
      first_event_seq: event.event_seq,
      last_event_seq: event.event_seq,
      message_id: messageId,
      reference_ids: asStringArray(entry?.reference_ids),
    });
  }

  if (Array.isArray(payload.entity_references)) {
    for (const value of payload.entity_references) {
      const reference = parseEntityReference(value);
      if (reference) turn.entityReferences.set(reference.id, reference);
    }
  }
  turn.materialized = true;
}

function projectProviderEvent(event: ConversationLedgerEvent, turn: TurnAccumulator): void {
  if (turn.materialized) return;
  const payload = asRecord(event.payload);
  if (!payload) return;

  if (event.stream_event_type === 'text-delta') {
    const text = asString(payload.text) ?? asString(payload.delta);
    if (!text) return;
    if (turn.pendingProviderTextStartSeq === null) {
      turn.pendingProviderTextStartSeq = event.event_seq;
    }
    turn.pendingProviderTextLastSeq = event.event_seq;
    turn.pendingProviderText += text;
    return;
  }

  if (event.stream_event_type === 'tool-result') {
    flushProviderText(turn, event.event_seq);
    const toolName = asString(payload.toolName);
    const toolCallId = asString(payload.toolCallId) ?? asString(payload.id);
    if (!toolName || !toolCallId) return;
    pushMessage(turn, {
      conversation_id: event.conversation_id,
      turn_id: event.turn_id,
      role: 'tool',
      content: JSON.stringify({
        input: payload.input ?? null,
        output: payload.output ?? null,
        isError: false,
      }),
      tool_name: toolName,
      tool_call_id: toolCallId,
      first_event_seq: event.event_seq,
      last_event_seq: event.event_seq,
    });
  }
}

function extractCliAssistantText(payload: Record<string, unknown>): string | null {
  const display = asRecord(payload.display as JsonSafeValue | undefined);
  if (display?.kind !== 'assistant_text') return null;
  const raw = asRecord(payload.raw as JsonSafeValue | undefined);
  const item = asRecord(raw?.item as JsonSafeValue | undefined);
  const rawText = asString(item?.text)?.trim();
  if (rawText) return rawText;
  return asString(display.text)?.trim() || null;
}

function isChatVisibleCliEvent(payload: Record<string, unknown>): boolean {
  const display = asRecord(payload.display as JsonSafeValue | undefined);
  if (!display) return false;
  if (display.visibility === 'chat') return true;
  if (display.visibility === 'diagnostic') return false;
  const providerEventType = asString(payload.providerEventType);
  if (providerEventType && DIAGNOSTIC_PROVIDER_EVENTS.has(providerEventType)) return false;
  const kind = asString(display.kind);
  return Boolean(kind && !DIAGNOSTIC_TRACE_KINDS.has(kind));
}

function canonicalCliToolName(name: string): string {
  const prefix = 'mcp__dnaforge__';
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

type ProjectedTraceToolCall = TraceToolCallLifecycle & Record<string, unknown>;

function projectedTraceToolCalls(payload: Record<string, unknown>): ProjectedTraceToolCall[] {
  if (!Array.isArray(payload.toolCalls)) return [];
  return payload.toolCalls.filter((value): value is ProjectedTraceToolCall => {
    if (!isRecord(value)) return false;
    return (
      typeof value.id === 'string' &&
      typeof value.name === 'string' &&
      typeof value.status === 'string' &&
      (value.mcpServer === undefined || typeof value.mcpServer === 'string')
    );
  });
}

function projectCliHistoryTools(
  event: ConversationLedgerEvent,
  payload: Record<string, unknown>,
  turn: TurnAccumulator
): void {
  if (!Array.isArray(payload.toolCalls)) return;
  for (const value of payload.toolCalls) {
    const call = asRecord(value as JsonSafeValue);
    if (!call) continue;
    const callId = asString(call.id);
    const rawName = asString(call.name);
    const mcpServer = asString(call.mcpServer);
    const status = asString(call.status);
    if (!callId || !rawName || mcpServer !== 'dnaforge' || !status) continue;
    const name = canonicalCliToolName(rawName);

    if (status === 'requested' || status === 'running') {
      const prior = turn.cliToolRequests.get(callId);
      const providerItemId = asString(payload.providerItemId);
      const sameProviderItem = Boolean(providerItemId && prior?.providerItemId === providerItemId);
      turn.cliToolRequests.set(callId, {
        name,
        input: call.input ?? prior?.input ?? {},
        providerItemId,
        firstEventSeq: sameProviderItem && prior ? prior.firstEventSeq : event.event_seq,
      });
      continue;
    }
    if (status === 'failed') {
      turn.cliToolRequests.delete(callId);
      continue;
    }
    if (status !== 'completed') continue;
    const request = turn.cliToolRequests.get(callId);
    turn.cliToolRequests.delete(callId);
    if (!isHistoryReactivatableTool(name)) continue;
    if (request && request.name !== name) continue;
    const completionKey = `${name}:${callId}`;
    if (turn.cliCompletedHistoryCalls.has(completionKey)) continue;
    turn.cliCompletedHistoryCalls.add(completionKey);
    const providerItemId = asString(payload.providerItemId);
    const firstEventSeq =
      providerItemId && request?.providerItemId === providerItemId
        ? request.firstEventSeq
        : event.event_seq;
    pushMessage(turn, {
      conversation_id: event.conversation_id,
      turn_id: event.turn_id,
      role: 'tool',
      content: JSON.stringify({
        input: call.input ?? request?.input ?? null,
        output: call.output ?? null,
        isError: false,
      }),
      tool_name: name,
      tool_call_id: callId,
      first_event_seq: firstEventSeq,
      last_event_seq: event.event_seq,
    });
  }
}

function projectCliEvent(event: ConversationLedgerEvent, turn: TurnAccumulator): void {
  if (turn.materialized) return;
  const rawPayload = asRecord(event.payload);
  if (!rawPayload) return;

  const assistantText = extractCliAssistantText(rawPayload);
  if (assistantText) {
    const providerItemId = asString(rawPayload.providerItemId);
    const key = providerItemId ?? `seq:${event.event_seq}`;
    const next: ProjectedLedgerMessage = {
      conversation_id: event.conversation_id,
      turn_id: event.turn_id,
      role: 'assistant',
      content: assistantText,
      tool_name: null,
      tool_call_id: null,
      first_event_seq: event.event_seq,
      last_event_seq: event.event_seq,
    };
    const existingIndex = turn.cliAssistantIndexes.get(key);
    if (existingIndex === undefined) {
      turn.cliAssistantIndexes.set(key, turn.messages.length);
      pushMessage(turn, next);
    } else {
      const previous = turn.messages[existingIndex];
      turn.messages[existingIndex] = {
        ...next,
        first_event_seq: previous.first_event_seq,
      };
    }
    return;
  }

  let payload = rawPayload;
  const providerItemId = asString(payload.providerItemId);
  const transport = asString(payload.transport) ?? 'unknown';
  const traceKey = providerItemId ? `${transport}:${providerItemId}` : null;
  const carriesTranscriptTrace =
    isChatVisibleCliEvent(payload) || projectedTraceToolCalls(payload).length > 0;
  if (traceKey && carriesTranscriptTrace) {
    const previousPayload = turn.cliTracePayloads.get(traceKey);
    if (previousPayload) {
      if (!shouldReplaceTraceLifecycle(previousPayload, payload)) return;
      const toolCalls = reconcileTraceToolCalls(
        projectedTraceToolCalls(previousPayload),
        projectedTraceToolCalls(payload)
      );
      if (toolCalls) payload = { ...payload, toolCalls };
    }
    turn.cliTracePayloads.set(traceKey, payload);
  }

  if (isChatVisibleCliEvent(payload)) {
    const next: ProjectedLedgerMessage = {
      conversation_id: event.conversation_id,
      turn_id: event.turn_id,
      role: 'activity',
      content: JSON.stringify({ type: 'agent.activity', version: 1, event: payload }),
      tool_name: null,
      tool_call_id: null,
      first_event_seq: event.event_seq,
      last_event_seq: event.event_seq,
    };
    const key = traceKey;
    const existingIndex = key ? turn.cliActivityIndexes.get(key) : undefined;
    if (existingIndex === undefined) {
      if (key) turn.cliActivityIndexes.set(key, turn.messages.length);
      pushMessage(turn, next);
    } else {
      const previous = turn.messages[existingIndex];
      turn.messages[existingIndex] = {
        ...next,
        first_event_seq: previous.first_event_seq,
      };
    }
  }
  projectCliHistoryTools(event, payload, turn);
}

function collectSupersededRefs(events: ConversationLedgerEvent[]): {
  eventIds: Set<string>;
  eventSeqs: Set<number>;
} {
  const eventIds = new Set<string>();
  const eventSeqs = new Set<number>();
  for (const event of events) {
    if (
      event.stream_event_type !== 'message.superseded' &&
      event.stream_event_type !== 'message.retracted'
    ) {
      continue;
    }
    const payload = asRecord(event.payload);
    if (!payload) continue;
    for (const id of [
      ...asStringArray(payload.retracted_event_ids),
      ...asStringArray(payload.retracted_event_id),
      ...asStringArray(payload.retracted_message_uuids),
      ...asStringArray(payload.retracted_message_uuid),
      ...asStringArray(payload.supersedes),
    ]) {
      eventIds.add(id);
    }
    for (const seq of [
      ...asNumberArray(payload.retracted_event_seqs),
      ...asNumberArray(payload.retracted_event_seq),
    ]) {
      eventSeqs.add(seq);
    }
  }
  return { eventIds, eventSeqs };
}

export function projectConversationLedgerEvents(
  events: ConversationLedgerEvent[]
): ProjectedLedgerConversation[] {
  const sorted = [...events].sort((a, b) => a.event_seq - b.event_seq);
  const superseded = collectSupersededRefs(sorted);
  const turns = new Map<string, TurnAccumulator>();

  for (const event of sorted) {
    if (superseded.eventIds.has(event.event_id) || superseded.eventSeqs.has(event.event_seq)) {
      continue;
    }
    const turn = getTurn(turns, event);
    if (event.source === 'app:chat' && event.stream_event_type === 'user-message') {
      projectUserMessage(event, turn);
    } else if (
      event.source === 'app:chat' &&
      event.stream_event_type === CHAT_TURN_MATERIALIZED_EVENT
    ) {
      projectMaterializedTurn(event, turn);
    } else if (event.source === 'provider:vercel' || event.source === 'hosted:router') {
      projectProviderEvent(event, turn);
    } else if (
      event.source === 'cli:codex' ||
      event.source === 'cli:claude-agent' ||
      event.source === 'cli:grok'
    ) {
      projectCliEvent(event, turn);
    }
  }

  const byConversation = new Map<
    string,
    { messages: ProjectedLedgerMessage[]; entityReferences: Map<string, ChatEntityReferenceIpcRow> }
  >();
  for (const turn of turns.values()) {
    flushProviderText(turn, turn.pendingProviderTextLastSeq ?? 0);
    const existing: {
      messages: ProjectedLedgerMessage[];
      entityReferences: Map<string, ChatEntityReferenceIpcRow>;
    } = byConversation.get(turn.conversationId) ?? {
      messages: [],
      entityReferences: new Map(),
    };
    existing.messages.push(...turn.messages);
    for (const [id, reference] of turn.entityReferences) {
      existing.entityReferences.set(id, reference);
    }
    byConversation.set(turn.conversationId, existing);
  }

  return [...byConversation.entries()]
    .map(([conversation_id, projection]) => ({
      conversation_id,
      messages: projection.messages.sort((a, b) => a.first_event_seq - b.first_event_seq),
      ...(projection.entityReferences.size > 0
        ? { entity_references: [...projection.entityReferences.values()] }
        : {}),
    }))
    .sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));
}

export function compareProjectedMessagesToLive(
  projected: ProjectedLedgerMessage[],
  live: LiveMessageComparable[]
): ProjectionParityResult {
  const mismatches: string[] = [];
  if (projected.length !== live.length) {
    mismatches.push(`message count ${projected.length} !== ${live.length}`);
  }
  const count = Math.min(projected.length, live.length);
  for (let i = 0; i < count; i += 1) {
    const a = projected[i];
    const b = live[i];
    if (a.role !== b.role) {
      mismatches.push(`message[${i}].role ${a.role} !== ${b.role}`);
    }
    if (a.content !== b.content) {
      mismatches.push(`message[${i}].content differs`);
    }
    if ((a.tool_name ?? null) !== (b.tool_name ?? null)) {
      mismatches.push(`message[${i}].tool_name ${a.tool_name ?? null} !== ${b.tool_name ?? null}`);
    }
    if ((a.tool_call_id ?? null) !== (b.tool_call_id ?? null)) {
      mismatches.push(
        `message[${i}].tool_call_id ${a.tool_call_id ?? null} !== ${b.tool_call_id ?? null}`
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
