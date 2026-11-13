import { chatInterruptionReason } from './chat-runtime';
import { isReferenceCreationTool } from '../references/constants';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { stepCountIs, streamText, type LanguageModel, type ModelMessage } from 'ai';
import { getEntityReferencesByIds } from '../../../db/entity-references';
import { platform } from '../../../platform';
import type { ConversationLedgerSourceShape } from '../../../shared/conversation-ledger-ipc';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { createModel, type ProviderName } from '../providers';
import { buildSystemPrompt } from '../prompts/system-prompt';
import { writeMolecularTrialSentPromptSnapshot } from '../molecular-prompt-trials';
import { registerMolecularHydrogenRequest } from '../molecular-hydrogen-request';
import {
  consumeHostedStream,
  hostedStreamEventType,
  jsonSafeForIpc,
  type HostedToolResultPart,
} from '../transports/hosted';
import { blocksToMessages, createdAtAfter } from './chat-projections';
import { setConversationState, type ChatStoreGet, type ChatStoreSet } from './chat-runtime';
import { EMPTY_CONV_STATE } from './chat-store-types';
import type { ChatMessage } from './chat-types';
import { inferInitialDirectToolStep, type DirectToolName } from './tool-policy';
import {
  createHostedPolicyTools,
  toCanonicalHostedToolName,
  toHostedProviderToolName,
  type HostedNativeToolExecutor,
} from './hosted-policy-tools';
import {
  isHostedToolExecutionDenied,
  isHostedToolExecutionFailure,
} from './hosted-tool-execution-results';
import type { HostedToolApprovalAuthority } from '../hosted/tool-approval-authority';
import type {
  FinishChatTurn,
  QueueMaterializedEntityReference,
  QueueProposedEntityReference,
  QueueTerminalMessage,
  TrackShadowLedgerAppend,
} from './turn-execution';
import { createInlineReferenceSession } from '../references/inline/session';
import { ASSISTANT_ROUTE_CAPABILITIES } from '../assistant-route-capabilities';
import { createStreamProjectionCoalescer } from './stream-projection-coalescer';
import { referenceCompletionFallback } from './reference-completion';

const MAX_TOOL_STEPS = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function visibleToolError(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    const error = (value as { error?: unknown }).error;
    if (typeof error === 'string' && error) return error;
  }
  return typeof value === 'string' && value ? value : 'Unknown error';
}

export function projectHostedToolResult(toolPart: HostedToolResultPart): {
  input: unknown;
  output: unknown;
  isError: boolean;
} {
  if (toolPart.type === 'tool-error') {
    return {
      input: toolPart.input,
      output: { error: visibleToolError(toolPart.error) },
      isError: true,
    };
  }
  const output = toolPart.output;
  if (isHostedToolExecutionDenied(output)) {
    return {
      input: toolPart.input,
      output: { error: output.reason },
      isError: true,
    };
  }
  if (isHostedToolExecutionFailure(output)) {
    return {
      input: toolPart.input,
      output: { error: visibleToolError(output) },
      isError: true,
    };
  }
  return { input: toolPart.input, output, isError: false };
}

type HostedInitialToolStep = {
  toolChoice: 'required' | { type: 'tool'; toolName: string };
  activeTools?: string[];
};

function completedNonMolecularReferenceStep({
  steps,
}: {
  steps: readonly { toolCalls: readonly { toolName: string; input?: unknown }[] }[];
}): boolean {
  return (
    steps[steps.length - 1]?.toolCalls.some((call) => {
      if (call.toolName !== 'create_reference' || !call.input || typeof call.input !== 'object')
        return false;
      const type = (call.input as Record<string, unknown>).entityType;
      return typeof type === 'string' && type !== 'structure';
    }) ?? false
  );
}

export function prepareHostedAgentStep(
  stepNumber: number,
  initialToolStep: HostedInitialToolStep | undefined
) {
  if (stepNumber >= MAX_TOOL_STEPS - 1) {
    return { activeTools: [], toolChoice: 'none' as const };
  }
  return stepNumber === 0 ? initialToolStep : undefined;
}

export interface ExecuteHostedTurnOptions {
  set: ChatStoreSet;
  get: ChatStoreGet;
  conversationId: string;
  turnId: string;
  provider?: ProviderName;
  modelName?: string;
  apiKey?: string;
  modelInjection?: HostedTurnModelInjection;
  serverToolApprovalAuthority?: HostedToolApprovalAuthority;
  nativeToolExecutor?: HostedNativeToolExecutor;
  folders: WorkspaceFolder[];
  modelMessages: ModelMessage[];
  content: string;
  allowedExistingReferenceIds: string[];
  workspaceScope: string | null;
  isWorkspaceScopeCurrent: () => boolean;
  workspacePath: string | null;
  additionalAgentInstructions?: string;
  controller: AbortController;
  queueTerminalMessage: QueueTerminalMessage;
  queueProposedEntityReference: QueueProposedEntityReference;
  queueMaterializedEntityReference: QueueMaterializedEntityReference;
  finishTurn: FinishChatTurn;
  trackShadowLedgerAppend: TrackShadowLedgerAppend;
  onStopped?: () => Promise<void>;
}

export interface HostedTurnLedgerIdentity {
  readonly source: ConversationLedgerSourceShape;
  readonly provider: string;
  readonly model: string;
}

export interface HostedTurnModelInjection {
  readonly model: LanguageModelV3;
  readonly ledgerIdentity: {
    readonly source: 'hosted:router';
    readonly provider: 'dnaforge-hosted';
    readonly model: `hosted:${string}`;
  };
}

export interface ResolveHostedTurnModelOptions {
  readonly provider?: ProviderName;
  readonly modelName?: string;
  readonly apiKey?: string;
  readonly modelInjection?: HostedTurnModelInjection;
}

export async function resolveHostedTurnModel({
  provider,
  modelName,
  apiKey,
  modelInjection,
}: ResolveHostedTurnModelOptions): Promise<{
  readonly model: LanguageModel;
  readonly ledgerIdentity: HostedTurnLedgerIdentity;
}> {
  if (modelInjection) {
    const { model, ledgerIdentity } = modelInjection;
    if (
      model.specificationVersion !== 'v3' ||
      model.provider !== 'dnaforge-hosted' ||
      !model.modelId.startsWith('hosted:') ||
      ledgerIdentity.source !== 'hosted:router' ||
      ledgerIdentity.provider !== model.provider ||
      ledgerIdentity.model !== model.modelId
    ) {
      throw new Error('The Hosted ledger identity does not match the injected model.');
    }
    return {
      model,
      ledgerIdentity: {
        source: 'hosted:router',
        provider: 'dnaforge-hosted',
        model: model.modelId,
      },
    };
  }
  if (!provider || !modelName || !apiKey) {
    throw new Error(
      'A provider, model, and API key are required without a Hosted model injection.'
    );
  }
  return {
    model: await createModel(provider, apiKey, modelName),
    ledgerIdentity: {
      source: 'provider:vercel',
      provider,
      model: modelName,
    },
  };
}

export type HostedTurnDisposition = 'completed' | 'stopped';

export class HostedStopTerminalError extends Error {
  constructor(cause: unknown) {
    super('DNAForge AI could not safely close the stopped workflow.');
    this.name = 'HostedStopTerminalError';
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export async function executeHostedTurn({
  set,
  get,
  conversationId,
  turnId,
  provider,
  modelName,
  apiKey,
  modelInjection,
  serverToolApprovalAuthority,
  nativeToolExecutor,
  folders,
  modelMessages,
  content,
  allowedExistingReferenceIds,
  workspaceScope,
  isWorkspaceScopeCurrent,
  workspacePath,
  additionalAgentInstructions,
  controller,
  queueTerminalMessage,
  queueProposedEntityReference,
  queueMaterializedEntityReference,
  finishTurn,
  trackShadowLedgerAppend,
  onStopped,
}: ExecuteHostedTurnOptions): Promise<HostedTurnDisposition> {
  registerMolecularHydrogenRequest(turnId, content);
  if (modelInjection && !serverToolApprovalAuthority) {
    throw new Error('A Hosted model injection requires its server tool approval authority.');
  }
  if (modelInjection && !nativeToolExecutor) {
    throw new Error('A Hosted model injection requires its native tool executor.');
  }
  if (!modelInjection && serverToolApprovalAuthority) {
    throw new Error('Server tool approval authority is only valid for a Hosted model injection.');
  }
  if (!modelInjection && nativeToolExecutor) {
    throw new Error('A native tool executor is only valid for a Hosted model injection.');
  }
  const { model, ledgerIdentity } = await resolveHostedTurnModel({
    provider,
    modelName,
    apiKey,
    modelInjection,
  });
  setConversationState(set, conversationId, () => ({
    isStreaming: true,
    streamingBlocks: [],
  }));

  const tools = createHostedPolicyTools(folders, {
    turnId,
    toolNameFormat: modelInjection ? 'canonical' : 'provider-safe',
    ...(serverToolApprovalAuthority
      ? { serverApprovalAuthority: serverToolApprovalAuthority }
      : {}),
    ...(nativeToolExecutor ? { nativeToolExecutor } : {}),
  });
  const canonicalInitialToolStep = inferInitialDirectToolStep(
    content,
    Object.keys(tools).map(toCanonicalHostedToolName) as DirectToolName[],
    workspacePath != null
  );
  const initialToolStep = canonicalInitialToolStep
    ? {
        toolChoice:
          canonicalInitialToolStep.toolChoice === 'required'
            ? canonicalInitialToolStep.toolChoice
            : {
                ...canonicalInitialToolStep.toolChoice,
                toolName: modelInjection
                  ? canonicalInitialToolStep.toolChoice.toolName
                  : toHostedProviderToolName(canonicalInitialToolStep.toolChoice.toolName),
              },
        ...(canonicalInitialToolStep.activeTools
          ? {
              activeTools: canonicalInitialToolStep.activeTools.map((toolName) =>
                modelInjection ? toolName : toHostedProviderToolName(toolName)
              ),
            }
          : {}),
      }
    : undefined;
  const routeCapabilities = modelInjection
    ? ASSISTANT_ROUTE_CAPABILITIES.hosted
    : ASSISTANT_ROUTE_CAPABILITIES.provider;

  let textBuffer = '';
  let textBlockIndex = 0;
  const currentTextBlockId = () => `${turnId}:hosted-text:${textBlockIndex}`;
  const inlineReferences = createInlineReferenceSession({
    roots: folders,
    workspaceScope,
    allowedExistingReferenceIds,
    isScopeCurrent: isWorkspaceScopeCurrent,
    onDocument: (blockId, document) => {
      setConversationState(set, conversationId, (previous) => ({
        streamingBlocks: previous.streamingBlocks.map((block) =>
          block.type === 'text' && block.id === blockId ? { ...block, document } : block
        ),
      }));
    },
  });

  const updateTextBlock = (text: string) => {
    const id = currentTextBlockId();
    const document = inlineReferences.update(id, text);
    setConversationState(set, conversationId, (previous) => {
      const blocks = [...previous.streamingBlocks];
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock?.type === 'text' && lastBlock.id === id) {
        blocks[blocks.length - 1] = { type: 'text', id, content: text, document };
      } else if (text) {
        blocks.push({ type: 'text', id, content: text, document });
      }
      return { streamingBlocks: blocks };
    });
  };
  const textProjection = createStreamProjectionCoalescer<string>({ commit: updateTextBlock });

  const finalizeInlineBlocks = async (
    blocks: ReturnType<typeof get>['streamingBlocks'],
    cancelled = false
  ) => {
    if (cancelled) inlineReferences.cancel();
    const finalized = await inlineReferences.finalize();
    finalized.proposedRows.forEach(queueProposedEntityReference);
    finalized.referencedRows.forEach(queueMaterializedEntityReference);
    return blocks.map((block) => {
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
  };

  const appendProviderLedgerPart = (part: unknown) => {
    const canonicalPart =
      part &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      typeof (part as { toolName?: unknown }).toolName === 'string'
        ? {
            ...part,
            toolName: toCanonicalHostedToolName((part as { toolName: string }).toolName),
          }
        : part;
    trackShadowLedgerAppend(
      platform().conversationLedger.appendEvent({
        conversation_id: conversationId,
        turn_id: turnId,
        source: ledgerIdentity.source,
        provider: ledgerIdentity.provider,
        model: ledgerIdentity.model,
        stream_event_type: hostedStreamEventType(part),
        payload: jsonSafeForIpc(canonicalPart),
      }),
      'Provider event'
    );
  };

  const emitProviderToolBlock = async (toolPart: HostedToolResultPart) => {
    textProjection.flush();
    const toolData = projectHostedToolResult(toolPart);
    const { isError } = toolData;
    const canonicalToolName = toCanonicalHostedToolName(toolPart.toolName);

    if (!isError && isReferenceCreationTool(canonicalToolName)) {
      const output = toolPart.output as { referenceId?: string } | undefined;
      if (output?.referenceId && UUID_PATTERN.test(output.referenceId)) {
        try {
          const references = await getEntityReferencesByIds([output.referenceId]);
          if (references.length > 0) {
            inlineReferences.registerCreatedReference(references[0]);
            queueMaterializedEntityReference(references[0]);
            const message: ChatMessage = {
              id: crypto.randomUUID(),
              turnId,
              role: 'tool',
              content: JSON.stringify({ ...toolData, referenceData: references[0] }),
              toolName: canonicalToolName,
              toolCallId: toolPart.toolCallId,
              createdAt: Date.now(),
            };
            setConversationState(set, conversationId, (previous) => {
              const blocks = [...previous.streamingBlocks];
              blocks.push({ type: 'ref', reference: references[0], message });
              return { streamingBlocks: blocks };
            });
            textBuffer = '';
            textBlockIndex += 1;
            return;
          }
        } catch (error) {
          console.warn(
            '[Chat] Failed to fetch ref for create_reference, falling back to tool card:',
            error
          );
        }
      }
    }

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      turnId,
      role: 'tool',
      content: JSON.stringify(toolData),
      toolName: canonicalToolName,
      toolCallId: toolPart.toolCallId,
      createdAt: Date.now(),
    };
    setConversationState(set, conversationId, (previous) => {
      const blocks = [...previous.streamingBlocks];
      blocks.push({ type: 'tool', message });
      return { streamingBlocks: blocks };
    });
    textBuffer = '';
    textBlockIndex += 1;
  };

  const systemPrompt = buildSystemPrompt(
    folders,
    workspacePath != null,
    routeCapabilities,
    additionalAgentInstructions,
    conversationId
  );
  writeMolecularTrialSentPromptSnapshot({
    version: 1,
    conversationId,
    turnId,
    channel: 'hosted-system',
    prompt: systemPrompt,
    additionalAgentInstructions: null,
    capturedAt: Date.now(),
  });
  const result = streamText({
    model,
    system: systemPrompt,
    messages: modelMessages,
    tools,
    ...(modelInjection
      ? {
          prepareStep: ({ stepNumber }: { stepNumber: number }) =>
            prepareHostedAgentStep(stepNumber, initialToolStep),
        }
      : initialToolStep
        ? {
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber === 0 ? initialToolStep : undefined,
          }
        : {}),
    stopWhen: routeCapabilities.terminalReferenceFallbackSupported
      ? [stepCountIs(MAX_TOOL_STEPS), completedNonMolecularReferenceStep]
      : stepCountIs(MAX_TOOL_STEPS),
    includeRawChunks: true,
    abortSignal: controller.signal,
  });

  try {
    await consumeHostedStream({
      stream: result.fullStream,
      signal: controller.signal,
      onPart: appendProviderLedgerPart,
      onTool: emitProviderToolBlock,
      onText: (delta) => {
        if (!delta) return;
        textBuffer += delta;
        textProjection.push(textBuffer);
      },
    });
    textProjection.flush();
  } catch (streamError) {
    textProjection.flush();
    if (!controller.signal.aborted) {
      const blocks = get()._convStates.get(conversationId)?.streamingBlocks ?? [];
      const messages = blocksToMessages(await finalizeInlineBlocks(blocks, true), turnId);
      if (messages.length > 0) {
        setConversationState(set, conversationId, (previous) => ({
          messages: [...previous.messages, ...messages],
          streamingBlocks: [],
          isStreaming: false,
        }));
        messages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
      }
      throw streamError;
    }

    const blocks = get()._convStates.get(conversationId)?.streamingBlocks ?? [];
    const messages = blocksToMessages(await finalizeInlineBlocks(blocks, true), turnId);
    try {
      await onStopped?.();
    } catch (error) {
      if (messages.length > 0) {
        setConversationState(set, conversationId, (previous) => ({
          messages: [...previous.messages, ...messages],
          streamingBlocks: [],
          isStreaming: false,
        }));
        messages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
      }
      throw new HostedStopTerminalError(error);
    }
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant) {
      lastAssistant.content += '\n\n*[Stopped. Send a follow-up to resume.]*';
    } else {
      messages.push({
        id: `${turnId}:hosted-stopped`,
        turnId,
        role: 'assistant',
        content: '*[Stopped. Send a follow-up to resume.]*',
        createdAt: createdAtAfter(messages),
      });
    }
    setConversationState(set, conversationId, (previous) => ({
      messages: [...previous.messages, ...messages],
      streamingBlocks: [],
      isStreaming: false,
    }));
    messages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
    await finishTurn('stopped', chatInterruptionReason(controller.signal));
    return 'stopped';
  }

  const state = get()._convStates.get(conversationId) ?? EMPTY_CONV_STATE;
  const messages = blocksToMessages(await finalizeInlineBlocks(state.streamingBlocks), turnId);
  let lastReferenceIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === 'tool' && isReferenceCreationTool(message.toolName))
      lastReferenceIndex = index;
  });
  const finalAssistantText = messages
    .slice(lastReferenceIndex + 1)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n');
  const completionFallback = referenceCompletionFallback(messages, finalAssistantText);
  if (completionFallback && completionFallback !== finalAssistantText) {
    messages.push({
      id: `${turnId}:hosted-fallback`,
      turnId,
      role: 'assistant',
      content: completionFallback,
      createdAt: createdAtAfter(messages),
    });
  }
  setConversationState(set, conversationId, (previous) => ({
    messages: [...previous.messages, ...messages],
    streamingBlocks: [],
    isStreaming: false,
  }));
  messages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
  await finishTurn('completed', 'completed');
  return 'completed';
}
