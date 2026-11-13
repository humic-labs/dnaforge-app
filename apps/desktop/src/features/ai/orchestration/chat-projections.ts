import type { DBChatTurn, DBConversation, DBMessage } from '../../../db';
import { encodeAgentActivityMessage } from '../agent-activity-message';
import type { ChatMessage, ContentBlock } from './chat-types';
import type { ChatTurnSummary, ConversationSummary } from './chat-store-types';
import type { AgentAttachmentManifest } from '../../../shared/agent-attachments';
import type { AgentStructuredOutputReceipt } from '../../../shared/agent-structured-output';
export function dbMessageToChatMessage(msg: DBMessage): ChatMessage {
  return {
    id: msg.id,
    turnId: msg.turn_id ?? null,
    role: msg.role as ChatMessage['role'],
    content: msg.content,
    toolName: msg.tool_name ?? undefined,
    toolCallId: msg.tool_call_id ?? undefined,
    createdAt: msg.created_at,
  };
}

export function attachPersistedChatMetadata(
  messages: ChatMessage[],
  attachments: ReadonlyMap<string, AgentAttachmentManifest[]>,
  structuredOutputs: ReadonlyMap<string, AgentStructuredOutputReceipt>
): ChatMessage[] {
  const lastAssistantByTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.turnId) {
      lastAssistantByTurn.set(message.turnId, index);
    }
  });
  return messages.map((message, index) => {
    const messageAttachments = attachments.get(message.id);
    const structuredOutput =
      message.turnId && lastAssistantByTurn.get(message.turnId) === index
        ? structuredOutputs.get(message.turnId)
        : undefined;
    return {
      ...message,
      ...(messageAttachments?.length ? { attachments: messageAttachments } : {}),
      ...(structuredOutput ? { structuredOutput } : {}),
    };
  });
}

export function dbConversationToSummary(conv: DBConversation): ConversationSummary {
  return {
    id: conv.id,
    title: conv.title,
    workspacePath: conv.workspace_path,
    pinned: conv.pinned === 1,
    provider: conv.provider,
    model: conv.model,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
  };
}

export function dbTurnToSummary(turn: DBChatTurn): ChatTurnSummary {
  return {
    id: turn.id,
    conversationId: turn.conversation_id,
    routeKind: turn.route_kind,
    hostId: turn.host_id,
    provider: turn.provider,
    model: turn.model,
    transport: turn.transport,
    authorityProfileId: turn.authority_profile_id,
    permissionMode: turn.permission_mode,
    routeSnapshotJson: turn.route_snapshot_json,
    status: turn.status,
    terminalReason: turn.terminal_reason,
    error: turn.error,
    startedAt: turn.started_at,
    completedAt: turn.completed_at,
  };
}

export function dbTurnsToSummaryMap(turns: DBChatTurn[]): Record<string, ChatTurnSummary> {
  return Object.fromEntries(turns.map((turn) => [turn.id, dbTurnToSummary(turn)]));
}

export function blocksToMessages(blocks: ContentBlock[], turnId?: string | null): ChatMessage[] {
  const newMessages: ChatMessage[] = [];
  const baseCreatedAt = Date.now();
  let createdAtOffset = 0;
  const nextCreatedAt = () => baseCreatedAt + createdAtOffset++;
  for (const block of blocks) {
    if (block.type === 'tool') {
      newMessages.push({
        ...block.message,
        turnId: block.message.turnId ?? turnId ?? null,
        createdAt: nextCreatedAt(),
      });
    } else if (block.type === 'ref') {
      newMessages.push({
        ...block.message,
        turnId: block.message.turnId ?? turnId ?? null,
        createdAt: nextCreatedAt(),
      });
    } else if ((block.type === 'text' || block.type === 'assistant_text') && block.content) {
      newMessages.push({
        id: crypto.randomUUID(),
        turnId: turnId ?? null,
        role: 'assistant',
        content: block.content,
        createdAt: nextCreatedAt(),
        document: block.document,
        referenceIds: block.referenceIds,
      });
    } else if (block.type === 'trace') {
      newMessages.push({
        id: crypto.randomUUID(),
        turnId: turnId ?? null,
        role: 'activity',
        content: encodeAgentActivityMessage(block.event),
        createdAt: nextCreatedAt(),
      });
    }
  }
  return newMessages;
}

export function createdAtAfter(messages: ChatMessage[]): number {
  const now = Date.now();
  const latest = messages.reduce((max, msg) => Math.max(max, msg.createdAt), 0);
  return latest >= now ? latest + 1 : now;
}

export function hasMaterializedAssistantText(messages: ChatMessage[], finalText: string): boolean {
  const normalizeForComparison = (value: string): string => value.trim().replace(/\s+/g, ' ');
  const normalizedFinalText = normalizeForComparison(finalText);
  if (!normalizedFinalText) return false;

  const assistantParts = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.trim())
    .filter(Boolean);

  return (
    assistantParts.some((part) => normalizeForComparison(part) === normalizedFinalText) ||
    normalizeForComparison(assistantParts.join('\n')) === normalizedFinalText
  );
}
