import { handleGroup } from '../../shared/ipc-contract';

import { appendConversationLedgerShadowEvent, unlinkConversationLedgerShadow } from './writer';
import type { ConversationLedgerAppendInput, ConversationLedgerSource } from './envelope';
import { conversationLedgerContract } from '../../shared/ipc/conversation-ledger.contract';

function isSource(value: unknown): value is ConversationLedgerSource {
  return (
    value === 'app:chat' ||
    value === 'provider:vercel' ||
    value === 'hosted:router' ||
    value === 'cli:claude-agent' ||
    value === 'cli:codex' ||
    value === 'cli:grok' ||
    value === 'system'
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sanitizeAppendInput(value: unknown): ConversationLedgerAppendInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('conversationLedger:appendEvent requires an object.');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.conversation_id !== 'string' || raw.conversation_id.length === 0) {
    throw new Error('conversationLedger:appendEvent requires conversation_id.');
  }
  if (!isSource(raw.source)) {
    throw new Error('conversationLedger:appendEvent requires a supported source.');
  }
  if (typeof raw.stream_event_type !== 'string' || raw.stream_event_type.length === 0) {
    throw new Error('conversationLedger:appendEvent requires stream_event_type.');
  }
  return {
    conversation_id: raw.conversation_id,
    turn_id: optionalString(raw.turn_id),
    source: raw.source,
    provider: optionalString(raw.provider),
    model: optionalString(raw.model),
    stream_event_type: raw.stream_event_type,
    payload: raw.payload,
    block_id: optionalString(raw.block_id),
    call_id: optionalString(raw.call_id),
    item_id: optionalString(raw.item_id),
    created_at: optionalString(raw.created_at) ?? undefined,
  };
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function registerConversationLedgerHandlers(): void {
  handleGroup(conversationLedgerContract, {
    appendEvent: async (_event, input: unknown) => {
      const sanitized = sanitizeAppendInput(input);
      const appended = await appendConversationLedgerShadowEvent(sanitized);
      return { ok: appended !== null, event: appended };
    },
    unlinkConversation: async (_event, conversationId: unknown) => {
      if (!validConversationId(conversationId)) {
        return { ok: false, error: 'conversationLedger:unlinkConversation requires a valid id.' };
      }
      await unlinkConversationLedgerShadow(conversationId);
      return { ok: true };
    },
  });
}
