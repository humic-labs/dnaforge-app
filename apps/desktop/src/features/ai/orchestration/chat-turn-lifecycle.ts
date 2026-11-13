import { isReferenceCreationTool } from '../references/constants';
import { commitChatTurnTerminalState, type DBChatTurnStatus } from '../../../db';
import { isChatConversationDeleted, setConversationState, type ChatStoreSet } from './chat-runtime';
import type { ChatMessage } from './chat-types';
import { createTurnReductionState, reduceTurnEvent } from './turn-reducer';
import type {
  FinishChatTurn,
  QueueTerminalMessage,
  TrackShadowLedgerAppend,
} from './turn-execution';
import type { ChatEntityReferenceIpcRow } from '../../../shared/chat-turn-ipc';
import {
  collectCreatedArtifactClaims,
  prepareAgentArtifactDelivery,
  sanitizeAssistantArtifactMetadata,
  type ArtifactDeliveryDependencies,
} from './artifact-delivery';
import { claimsCompletedBiologyArtifact } from './assistant-artifact-prose';

const DEFAULT_SHADOW_LEDGER_FLUSH_TIMEOUT_MS = 750;
const REFERENCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function completedCreateReferenceId(message: ChatMessage): string | null {
  if (message.role !== 'tool' || !isReferenceCreationTool(message.toolName)) return null;
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (
      !isRecord(parsed) ||
      parsed.isError === true ||
      !isRecord(parsed.output) ||
      parsed.output.ok === false
    )
      return null;
    if (typeof parsed.output.error === 'string' && parsed.output.error.trim().length > 0)
      return null;
    const referenceId = parsed.output.referenceId;
    return typeof referenceId === 'string' && REFERENCE_ID_PATTERN.test(referenceId)
      ? referenceId
      : null;
  } catch {
    return null;
  }
}

type TerminalLedgerAppender = (
  status: DBChatTurnStatus,
  terminalReason: string,
  error: string | null,
  completedAt: number
) => void;

export interface MaterializedTurnLedgerPayload {
  schema_version: 1;
  status: DBChatTurnStatus;
  terminal_reason: string;
  error: string | null;
  completed_at: number;
  messages: Array<{
    message: {
      id: string;
      role: ChatMessage['role'];
      content: string;
      tool_name: string | null;
      tool_call_id: string | null;
      created_at: number;
    };
    reference_ids: string[];
  }>;
  proposed_entity_references: ChatEntityReferenceIpcRow[];
  entity_references: ChatEntityReferenceIpcRow[];
}

type MaterializedLedgerAppender = (
  payload: MaterializedTurnLedgerPayload,
  completedAt: number
) => void;

export interface CreateChatTurnLifecycleOptions {
  set: ChatStoreSet;
  conversationId: string;
  turnId: string;
  commitTerminalState?: typeof commitChatTurnTerminalState;
  now?: () => number;
  shadowLedgerFlushTimeoutMs?: number;
  artifactDeliveryDependencies?: ArtifactDeliveryDependencies;
}

export interface ChatTurnLifecycle {
  queueTerminalMessage: QueueTerminalMessage;
  queueProposedEntityReference(row: ChatEntityReferenceIpcRow): void;
  queueMaterializedEntityReference(row: ChatEntityReferenceIpcRow): void;
  trackShadowLedgerAppend: TrackShadowLedgerAppend;
  setTerminalLedgerAppender(appender: TerminalLedgerAppender | null): void;
  setMaterializedLedgerAppender(appender: MaterializedLedgerAppender | null): void;
  finishTurn: FinishChatTurn;
}

export function createChatTurnLifecycle({
  set,
  conversationId,
  turnId,
  commitTerminalState = commitChatTurnTerminalState,
  now = Date.now,
  shadowLedgerFlushTimeoutMs = DEFAULT_SHADOW_LEDGER_FLUSH_TIMEOUT_MS,
  artifactDeliveryDependencies,
}: CreateChatTurnLifecycleOptions): ChatTurnLifecycle {
  let reductionState = reduceTurnEvent(createTurnReductionState(turnId), {
    turnId,
    sequence: 0,
    kind: 'running',
  });
  let eventSequence = 0;
  let terminalLedgerAppender: TerminalLedgerAppender | null = null;
  let materializedLedgerAppender: MaterializedLedgerAppender | null = null;
  const pendingMessages: Array<{ message: ChatMessage; referenceIds: string[] }> = [];
  const proposedEntityReferences = new Map<string, ChatEntityReferenceIpcRow>();
  const materializedEntityReferences = new Map<string, ChatEntityReferenceIpcRow>();
  const shadowLedgerAppends: Promise<unknown>[] = [];
  let shadowLedgerFlushIndex = 0;

  const queueTerminalMessage: QueueTerminalMessage = (message, referenceIds) => {
    if (reductionState.terminalSequence !== null) return;
    let resolvedReferenceIds = referenceIds;
    if (resolvedReferenceIds === undefined && message.role === 'tool') {
      const referenceId = completedCreateReferenceId(message);
      resolvedReferenceIds = referenceId ? [referenceId] : [];
    }
    pendingMessages.push({
      message,
      referenceIds: [...new Set(resolvedReferenceIds ?? [])],
    });
  };

  const trackShadowLedgerAppend: TrackShadowLedgerAppend = (pending, label) => {
    shadowLedgerAppends.push(
      pending.catch((error) =>
        console.warn(`[ConversationLedger] ${label} shadow append failed:`, error)
      )
    );
  };

  const queueMaterializedEntityReference = (row: ChatEntityReferenceIpcRow): void => {
    if (reductionState.terminalSequence !== null) return;
    const existing = materializedEntityReferences.get(row.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
      throw new Error('Conflicting materialized entity reference rows share an ID.');
    }
    materializedEntityReferences.set(row.id, row);
  };

  const queueProposedEntityReference = (row: ChatEntityReferenceIpcRow): void => {
    if (reductionState.terminalSequence !== null) return;
    const existing = proposedEntityReferences.get(row.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
      throw new Error('Conflicting proposed entity reference rows share an ID.');
    }
    proposedEntityReferences.set(row.id, row);
    queueMaterializedEntityReference(row);
  };

  const flushShadowLedgerAppends = async () => {
    const pending = shadowLedgerAppends.slice(shadowLedgerFlushIndex);
    shadowLedgerFlushIndex = shadowLedgerAppends.length;
    if (pending.length === 0) return;
    let timedOut = false;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, shadowLedgerFlushTimeoutMs);
      }),
    ]);
    if (timedOut) {
      console.warn('[ConversationLedger] Shadow append flush timed out; continuing chat turn.');
    }
  };

  const finishTurn: FinishChatTurn = async (status, terminalReason, error = null) => {
    if (isChatConversationDeleted(conversationId)) return;
    const nextReductionState = reduceTurnEvent(reductionState, {
      turnId,
      sequence: ++eventSequence,
      kind: status,
    });
    if (nextReductionState === reductionState) return;
    const artifactClaims = collectCreatedArtifactClaims(
      pendingMessages.map(({ message }) => message)
    );
    const unsupportedCompletionClaim =
      artifactClaims.length === 0 &&
      pendingMessages.some(
        ({ message }) =>
          message.role === 'assistant' && claimsCompletedBiologyArtifact(message.content)
      );
    const delivery = await prepareAgentArtifactDelivery(
      artifactClaims,
      artifactDeliveryDependencies
    );
    delivery.references.forEach(queueProposedEntityReference);
    const deliveredReferenceIds = delivery.references.map((reference) => reference.id);
    const artifactIds = new Set(artifactClaims.map((claim) => claim.id.toLowerCase()));
    const terminalEntries = pendingMessages.map(({ message, referenceIds }) => ({
      message:
        message.role === 'assistant'
          ? { ...message, content: sanitizeAssistantArtifactMetadata(message.content, artifactIds) }
          : message,
      referenceIds: [...referenceIds],
    }));
    let finalAssistantIndex = -1;
    for (let index = terminalEntries.length - 1; index >= 0; index -= 1) {
      if (terminalEntries[index].message.role === 'assistant') {
        finalAssistantIndex = index;
        break;
      }
    }
    if (finalAssistantIndex < 0 && artifactClaims.length > 0) {
      terminalEntries.push({
        message: {
          id: crypto.randomUUID(),
          turnId,
          role: 'assistant',
          content: 'Saved artifacts are attached below.',
          createdAt: Date.now(),
        },
        referenceIds: [],
      });
      finalAssistantIndex = terminalEntries.length - 1;
    }
    if (finalAssistantIndex >= 0) {
      const finalEntry = terminalEntries[finalAssistantIndex];
      finalEntry.referenceIds = [
        ...new Set([...finalEntry.referenceIds, ...deliveredReferenceIds]),
      ];
      if (delivery.failedClaims.length > 0 || unsupportedCompletionClaim) {
        const warning =
          delivery.failedClaims.length > 0
            ? `Saved artifact links could not be verified for: ${delivery.failedClaims.map((claim) => claim.label).join(', ')}. Those artifact claims remain unverified.`
            : 'No saved artifact could be verified for the completion claim above.';
        finalEntry.message = {
          ...finalEntry.message,
          content: [finalEntry.message.content, warning].filter(Boolean).join('\n\n'),
        };
      }
    }
    const completedAt = now();
    const terminalMessages = terminalEntries.map(({ message, referenceIds }) => ({
      message: {
        id: message.id,
        conversation_id: conversationId,
        turn_id: turnId,
        role: message.role,
        content: message.content,
        tool_name: message.toolName ?? null,
        tool_call_id: message.toolCallId ?? null,
        created_at: message.createdAt,
      },
      reference_ids: referenceIds,
    }));
    const proposedReferences = [...proposedEntityReferences.values()];
    const commit = await commitTerminalState({
      turn_id: turnId,
      conversation_id: conversationId,
      status,
      terminal_reason: terminalReason,
      error,
      completed_at: completedAt,
      messages: terminalMessages,
      proposed_entity_references: proposedReferences,
    });
    if (!commit.committed) return;

    reductionState = nextReductionState;
    try {
      materializedLedgerAppender?.(
        {
          schema_version: 1,
          status,
          terminal_reason: terminalReason,
          error,
          completed_at: completedAt,
          messages: terminalMessages.map(({ message, reference_ids }) => ({
            message: {
              id: message.id,
              role: message.role as ChatMessage['role'],
              content: message.content,
              tool_name: message.tool_name,
              tool_call_id: message.tool_call_id,
              created_at: message.created_at,
            },
            reference_ids,
          })),
          proposed_entity_references: proposedReferences,
          entity_references: [...materializedEntityReferences.values()],
        },
        completedAt
      );
    } catch (ledgerError) {
      console.warn('[ConversationLedger] Materialized turn append failed:', ledgerError);
    }
    pendingMessages.length = 0;
    proposedEntityReferences.clear();
    materializedEntityReferences.clear();
    terminalLedgerAppender?.(status, terminalReason, error, completedAt);
    setConversationState(set, conversationId, (previous) => {
      const existingTurn = previous.turns[turnId];
      if (!existingTurn) return {};
      const updatedById = new Map(
        terminalEntries.map(({ message, referenceIds }) => [
          message.id,
          { ...message, referenceIds },
        ])
      );
      const existingMessageIds = new Set(previous.messages.map((message) => message.id));
      return {
        messages: [
          ...previous.messages.map((message) => updatedById.get(message.id) ?? message),
          ...[...updatedById.values()].filter((message) => !existingMessageIds.has(message.id)),
        ],
        turns: {
          ...previous.turns,
          [turnId]: {
            ...existingTurn,
            status,
            terminalReason,
            error,
            completedAt,
          },
        },
        activeTurnId: previous.activeTurnId === turnId ? null : previous.activeTurnId,
      };
    });
    await flushShadowLedgerAppends();
  };

  return {
    queueTerminalMessage,
    queueProposedEntityReference,
    queueMaterializedEntityReference,
    trackShadowLedgerAppend,
    setTerminalLedgerAppender(appender) {
      terminalLedgerAppender = appender;
    },
    setMaterializedLedgerAppender(appender) {
      materializedLedgerAppender = appender;
    },
    finishTurn,
  };
}
