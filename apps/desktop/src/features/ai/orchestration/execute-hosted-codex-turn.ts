import { isUserMessageKey, withUserMessage } from '@waypoint/user-messages';
import { chatInterruptionReason } from './chat-runtime';
import { isReferenceCreationTool } from '../references/constants';
import { getEntityReferencesByIds } from '../../../db/entity-references';
import { hostedCodexStoppedAnswer } from '../../../shared/hosted-codex-stopped-answer';
import type {
  HostedCodexTurnEvent,
  HostedCodexTurnResult,
  HostedCodexTurnStartRequest,
} from '../../../shared/hosted-codex-ipc';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import type { HostedCodexBridge } from '../hosted-gateway';
import { buildHostedCodexTurnInput } from '../prompts/hosted-codex-prompt';
import { writeMolecularTrialSentPromptSnapshot } from '../molecular-prompt-trials';
import { reprojectInlineTextDocument } from '../references/inline/document';
import { createInlineReferenceSession } from '../references/inline/session';
import { blocksToMessages, createdAtAfter } from './chat-projections';
import { setConversationState, type ChatStoreGet, type ChatStoreSet } from './chat-runtime';
import { EMPTY_CONV_STATE } from './chat-store-types';
import type { ChatMessage } from './chat-types';
import { referenceCompletionFallback } from './reference-completion';
import type {
  FinishChatTurn,
  QueueMaterializedEntityReference,
  QueueProposedEntityReference,
  QueueTerminalMessage,
} from './turn-execution';
import type { ResolvedAgentPermissions } from '../../../shared/agent-permissions';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class HostedCodexTurnExecutionError extends Error {
  constructor(
    readonly code: Extract<HostedCodexTurnResult, { ok: false }>['code'],
    message: string,
    userMessageKey?: unknown
  ) {
    super(message);
    this.name = 'HostedCodexTurnExecutionError';
    withUserMessage(
      this,
      code === 'response_stream_disconnected'
        ? 'assistant.connectionInterrupted'
        : isUserMessageKey(userMessageKey)
          ? userMessageKey
          : 'assistant.failed'
    );
  }
}

export interface ExecuteHostedCodexTurnOptions {
  readonly bridge: HostedCodexBridge;
  readonly set: ChatStoreSet;
  readonly get: ChatStoreGet;
  readonly conversationId: string;
  readonly turnId: string;
  readonly tier: 'auto' | 'deep';
  readonly permissions: ResolvedAgentPermissions;
  readonly folders: WorkspaceFolder[];
  readonly expandedMessages: readonly ChatMessage[];
  readonly currentUserMessageId: string;
  readonly stagedReferenceIds: readonly string[];
  readonly allowedExistingReferenceIds: readonly string[];
  readonly workspaceScope: string | null;
  readonly isWorkspaceScopeCurrent: () => boolean;
  readonly workspacePath: string | null;
  readonly additionalAgentInstructions?: string;
  readonly controller: AbortController;
  readonly queueTerminalMessage: QueueTerminalMessage;
  readonly queueProposedEntityReference: QueueProposedEntityReference;
  readonly queueMaterializedEntityReference: QueueMaterializedEntityReference;
  readonly finishTurn: FinishChatTurn;
}

function sameTurn(event: HostedCodexTurnEvent, request: HostedCodexTurnStartRequest): boolean {
  return (
    event.workflowId === request.workflowId &&
    event.runId === request.runId &&
    event.turnId === request.turnId
  );
}

export async function executeHostedCodexTurn(
  options: ExecuteHostedCodexTurnOptions
): Promise<'completed' | 'stopped'> {
  const {
    bridge,
    set,
    get,
    conversationId,
    turnId,
    controller,
    queueTerminalMessage,
    queueProposedEntityReference,
    queueMaterializedEntityReference,
    finishTurn,
  } = options;
  const turnInput = buildHostedCodexTurnInput({
    folders: options.folders,
    messages: options.expandedMessages,
    currentUserMessageId: options.currentUserMessageId,
    hasWorkspace: options.workspacePath !== null,
    conversationId,
    ...(options.additionalAgentInstructions
      ? { additionalAgentInstructions: options.additionalAgentInstructions }
      : {}),
  });
  writeMolecularTrialSentPromptSnapshot({
    version: 1,
    conversationId,
    turnId,
    channel: 'hosted-codex-developer',
    prompt: turnInput.developerInstructions,
    additionalAgentInstructions: null,
    capturedAt: Date.now(),
  });
  const request: HostedCodexTurnStartRequest = {
    workflowId: conversationId,
    runId: turnId,
    turnId,
    tier: options.tier,
    developerInstructions: turnInput.developerInstructions,
    userMessage: turnInput.userMessage,
    priorConversationContext: turnInput.priorConversationContext,
    workspaceOpen: options.workspacePath !== null,
    stagedReferenceIds: [...options.stagedReferenceIds],
    permissions: options.permissions,
  };

  setConversationState(set, conversationId, () => ({ isStreaming: true, streamingBlocks: [] }));
  const inlineReferences = createInlineReferenceSession({
    roots: options.folders,
    workspaceScope: options.workspaceScope,
    allowedExistingReferenceIds: [...options.allowedExistingReferenceIds],
    isScopeCurrent: options.isWorkspaceScopeCurrent,
    onDocument: (blockId, document) => {
      setConversationState(set, conversationId, (previous) => ({
        streamingBlocks: previous.streamingBlocks.map((block) =>
          block.type === 'text' && block.id === blockId ? { ...block, document } : block
        ),
      }));
    },
  });
  let textBuffer = '';
  let completeText = '';
  let textBlockIndex = 0;
  let eventChain = Promise.resolve();

  const updateText = (delta: string): void => {
    completeText += delta;
    textBuffer += delta;
    const id = `${turnId}:hosted-codex-text:${textBlockIndex}`;
    const document = inlineReferences.update(id, textBuffer);
    setConversationState(set, conversationId, (previous) => {
      const blocks = [...previous.streamingBlocks];
      const last = blocks[blocks.length - 1];
      if (last?.type === 'text' && last.id === id) {
        blocks[blocks.length - 1] = { type: 'text', id, content: textBuffer, document };
      } else if (textBuffer) {
        blocks.push({ type: 'text', id, content: textBuffer, document });
      }
      return { streamingBlocks: blocks };
    });
  };

  const appendTool = async (
    event: Extract<HostedCodexTurnEvent, { kind: 'tool_completed' }>
  ): Promise<void> => {
    const toolData = { input: event.input, output: event.output, isError: event.isError };
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      turnId,
      role: 'tool',
      content: JSON.stringify(toolData),
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      createdAt: Date.now(),
    };
    if (
      !event.isError &&
      isReferenceCreationTool(event.toolName) &&
      event.output &&
      typeof event.output === 'object' &&
      !Array.isArray(event.output)
    ) {
      const referenceId = (event.output as Record<string, unknown>).referenceId;
      if (typeof referenceId === 'string' && UUID_PATTERN.test(referenceId)) {
        const references = await getEntityReferencesByIds([referenceId]);
        const reference = references[0];
        if (reference) {
          inlineReferences.registerCreatedReference(reference);
          queueMaterializedEntityReference(reference);
          message.content = JSON.stringify({ ...toolData, referenceData: reference });
          setConversationState(set, conversationId, (previous) => ({
            streamingBlocks: [...previous.streamingBlocks, { type: 'ref', reference, message }],
          }));
          textBuffer = '';
          textBlockIndex += 1;
          return;
        }
      }
    }
    setConversationState(set, conversationId, (previous) => ({
      streamingBlocks: [...previous.streamingBlocks, { type: 'tool', message }],
    }));
    textBuffer = '';
    textBlockIndex += 1;
  };

  const unsubscribe = bridge.onTurnEvent((event) => {
    if (!sameTurn(event, request)) return;
    eventChain = eventChain.then(async () => {
      if (event.kind === 'text_delta') updateText(event.delta);
      else await appendTool(event);
    });
  });
  const stop = (): void => {
    void bridge
      .stopTurn({
        workflowId: request.workflowId,
        runId: request.runId,
        turnId: request.turnId,
      })
      .catch(() => undefined);
  };
  controller.signal.addEventListener('abort', stop, { once: true });

  const finalizeMessages = async (cancelled: boolean): Promise<ChatMessage[]> => {
    if (cancelled) inlineReferences.cancel();
    const finalized = await inlineReferences.finalize();
    finalized.proposedRows.forEach(queueProposedEntityReference);
    finalized.referencedRows.forEach(queueMaterializedEntityReference);
    const state = get()._convStates.get(conversationId) ?? EMPTY_CONV_STATE;
    const blocks = state.streamingBlocks.map((block) => {
      if (block.type !== 'text') return block;
      const settled = finalized.blocks.get(block.id);
      return settled
        ? {
            ...block,
            content: settled.content,
            document: settled.document,
            referenceIds: settled.referenceIds,
          }
        : block;
    });
    return blocksToMessages(blocks, turnId);
  };

  const keepPartialMessages = async (): Promise<void> => {
    const messages = await finalizeMessages(true);
    if (messages.length === 0) return;
    setConversationState(set, conversationId, (previous) => ({
      messages: [...previous.messages, ...messages],
      streamingBlocks: [],
      isStreaming: false,
    }));
    messages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
  };

  try {
    const result = await bridge.startTurn(request);
    await eventChain;
    if (!result.ok && !controller.signal.aborted) {
      await keepPartialMessages();
      throw new HostedCodexTurnExecutionError(result.code, result.message, result.userMessageKey);
    }
    if (result.ok && result.text !== completeText) {
      await keepPartialMessages();
      throw new HostedCodexTurnExecutionError(
        'turn_failed',
        'DNAForge AI received an incomplete visible event stream.'
      );
    }
    const stopped = controller.signal.aborted || (result.ok && result.outcome === 'stopped');
    const messages = await finalizeMessages(stopped);
    if (stopped) {
      const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
      if (lastAssistant) {
        lastAssistant.content = hostedCodexStoppedAnswer(lastAssistant.content);
        if (lastAssistant.document) {
          lastAssistant.document = reprojectInlineTextDocument(
            lastAssistant.document,
            lastAssistant.content,
            { streaming: false }
          );
        }
      } else {
        messages.push({
          id: `${turnId}:hosted-codex-stopped`,
          turnId,
          role: 'assistant',
          content: hostedCodexStoppedAnswer(''),
          createdAt: createdAtAfter(messages),
        });
      }
    } else {
      const lastReferenceIndex = messages.reduce(
        (latest, message, index) =>
          message.role === 'tool' && isReferenceCreationTool(message.toolName) ? index : latest,
        -1
      );
      const finalAssistantText = messages
        .slice(lastReferenceIndex + 1)
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content.trim())
        .filter(Boolean)
        .join('\n');
      const fallback = referenceCompletionFallback(messages, finalAssistantText);
      if (fallback && fallback !== finalAssistantText) {
        messages.push({
          id: `${turnId}:hosted-codex-fallback`,
          turnId,
          role: 'assistant',
          content: fallback,
          createdAt: createdAtAfter(messages),
        });
      }
    }
    setConversationState(set, conversationId, (previous) => ({
      messages: [...previous.messages, ...messages],
      streamingBlocks: [],
      isStreaming: false,
      error: null,
    }));
    messages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
    await finishTurn(
      stopped ? 'stopped' : 'completed',
      stopped ? chatInterruptionReason(controller.signal) : 'Completed'
    );
    return stopped ? 'stopped' : 'completed';
  } finally {
    controller.signal.removeEventListener('abort', stop);
    unsubscribe();
  }
}
