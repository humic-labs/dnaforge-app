import { chatInterruptionReason } from './chat-runtime';
import { PROVIDER_INPUT_REFUSALS } from './refused-provider-input';
import { UserMessageError } from '@waypoint/user-messages';
import type {
  AgentCliModelPersonality,
  AgentCliModelReasoningEffort,
  AgentCliPermissionMode,
  AgentTransport,
} from '../../../platform';
import {
  dnaforgeSupervision,
  permissionFamilyForTransport,
  type ResolvedAgentPermissions,
} from '../../../shared/agent-permissions';
import { platform } from '../../../platform';
import { registerMolecularHydrogenRequest } from '../molecular-hydrogen-request';
import { presentCliReferencesInline } from './cli-reference-presentation';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { getEntityReferencesByIds, type DBEntityReference } from '../../../db/entity-references';
import { getCliAuthorityProfileId } from '../assistant-routes';
import {
  reconcileCliWorkspaceChanges,
  scanWorkspaceFiles,
  type WorkspaceFileSnapshot,
} from '../cli-workspace-reconcile';
import { buildAgentSdkContinuationPrompt, buildAgentSdkPrompt } from '../prompts/cli-prompt';
import {
  readMolecularPromptTrial,
  writeMolecularTrialSentPromptSnapshot,
} from '../molecular-prompt-trials';
import type { ProteinExperimentWorkersApi } from '../../../shared/protein-experiment-workers';
import { REF_TOKEN_PATTERN } from '../references/constants';
import { DEFAULT_CLI_REASONING_EFFORTS } from '../settings';
import {
  createCliTranscriptAccumulator,
  isCliTranscriptTraceEvent,
  materializeCliToolBlocks,
  type CliTranscriptAccumulator,
} from '../transports/cli';
import { blocksToMessages, createdAtAfter, hasMaterializedAssistantText } from './chat-projections';
import { chatProviderPhase, setConversationState, type ChatStoreSet } from './chat-runtime';
import type { ChatMessage } from './chat-types';
import { referenceCompletionFallback } from './reference-completion';
import type { FinishChatTurn, QueueTerminalMessage } from './turn-execution';
import type {
  QueueMaterializedEntityReference,
  QueueProposedEntityReference,
} from './turn-execution';
import { createInlineReferenceSession } from '../references/inline/session';
import type { FinalizedInlineTextBlock } from '../references/inline/session';
import type {
  AgentCapabilityControl,
  AgentCapabilitySelection,
} from '../../../shared/agent-capability-controls';
import type { AgentAttachmentManifest } from '../../../shared/agent-attachments';
import { agentChatFilesRoot } from '../../../shared/agent-chat-files';
import { getUserFolders, registerAgentChatFilesRoot } from '../../workspace/public/path-resolve';

export interface ExecuteCliTurnOptions {
  set: ChatStoreSet;
  conversationId: string;
  turnId: string;
  transport: AgentTransport;
  binaryPathOverride?: string;
  permissionMode: AgentCliPermissionMode;
  permissions: ResolvedAgentPermissions;
  additionalAgentInstructions?: string;
  cliModelSettings?: {
    model: string | null;
    reasoningEffort: AgentCliModelReasoningEffort | null;
    serviceTier?: string | null;
    personality?: AgentCliModelPersonality | null;
  };
  folders: WorkspaceFolder[];
  expandedMessages: ChatMessage[];
  content: string;
  stagedReferenceIds: string[];
  allowedExistingReferenceIds: string[];
  workspaceScope: string | null;
  isWorkspaceScopeCurrent: () => boolean;
  workspacePath: string | null;
  controller: AbortController;
  transcript?: CliTranscriptAccumulator;
  queueTerminalMessage: QueueTerminalMessage;
  queueProposedEntityReference: QueueProposedEntityReference;
  queueMaterializedEntityReference: QueueMaterializedEntityReference;
  capability?: AgentCapabilityControl | null;
  capabilitySelection?: AgentCapabilitySelection;
  attachments?: AgentAttachmentManifest[];
  finishTurn: FinishChatTurn;
}

export type CliTurnDisposition = 'completed' | 'stopped';

const CLI_TRACE_COMPLETION_TIMEOUT_MS = 15_000;

export function projectCapabilityInvocation(
  transport: AgentTransport,
  capability: AgentCapabilityControl,
  content: string
): string {
  if (capability.provider !== transport) {
    throw new Error('Selected capability belongs to a different CLI provider.');
  }
  const marker =
    capability.kind === 'skill' && capability.source?.startsWith('dnaforge-skill:')
      ? null
      : capability.kind === 'skill' && transport === 'codex-sdk'
        ? `$${capability.nativeId}`
        : capability.kind === 'skill' && transport === 'grok-acp'
          ? `/${capability.nativeId}`
          : capability.kind === 'command' || capability.kind === 'custom-command'
            ? `/${capability.nativeId}`
            : null;
  if (capability.kind === 'memory' || capability.kind === 'plugin') return content;
  if (capability.kind === 'structured-output') return content;
  if (capability.kind === 'skill' && capability.source?.startsWith('dnaforge-skill:')) {
    return content;
  }
  if (!marker) throw new Error(`Capability kind ${capability.kind} is not turn-invocable.`);
  const trimmed = content.trim();
  if (trimmed === marker || trimmed.startsWith(`${marker} `)) return trimmed;
  return trimmed ? `${marker} ${trimmed}` : marker;
}

export function projectCapabilityIntoLatestUserMessage(
  transport: AgentTransport,
  capability: AgentCapabilityControl,
  messages: readonly ChatMessage[]
): ChatMessage[] {
  let projected = false;
  return [...messages]
    .reverse()
    .map((message) => {
      if (projected || message.role !== 'user') return message;
      projected = true;
      return {
        ...message,
        content: projectCapabilityInvocation(transport, capability, message.content),
      };
    })
    .reverse();
}

export async function executeCliTurn({
  set,
  conversationId,
  turnId,
  transport,
  binaryPathOverride,
  permissionMode,
  permissions,
  additionalAgentInstructions,
  cliModelSettings,
  folders,
  expandedMessages,
  content,
  stagedReferenceIds,
  allowedExistingReferenceIds,
  workspaceScope,
  isWorkspaceScopeCurrent,
  workspacePath,
  controller,
  transcript = createCliTranscriptAccumulator(),
  queueTerminalMessage,
  queueProposedEntityReference,
  queueMaterializedEntityReference,
  capability,
  capabilitySelection,
  attachments,
  finishTurn,
}: ExecuteCliTurnOptions): Promise<CliTurnDisposition> {
  chatProviderPhase(set, conversationId, controller, 'streaming');
  setConversationState(set, conversationId, () => ({
    streamingBlocks: [],
  }));
  const inlineReferences = createInlineReferenceSession({
    roots: folders,
    workspaceScope,
    allowedExistingReferenceIds,
    isScopeCurrent: isWorkspaceScopeCurrent,
    onDocument: (blockId, document) => {
      const block = transcript.blocks.find(
        (candidate) => candidate.type === 'assistant_text' && candidate.id === blockId
      );
      if (block?.type === 'assistant_text') block.document = document;
      setConversationState(set, conversationId, () => ({
        streamingBlocks: [...transcript.blocks],
      }));
    },
  });
  let finalizedInlineBlocks = new Map<string, FinalizedInlineTextBlock>();
  const materializeActivity = async (cancelled = false): Promise<ChatMessage[]> => {
    if (cancelled) inlineReferences.cancel();
    const materialized = await materializeCliToolBlocks(transcript.blocks, turnId);
    for (const block of materialized) {
      if (block.type === 'ref') inlineReferences.registerCreatedReference(block.reference);
    }
    const finalized = await inlineReferences.finalize();
    finalizedInlineBlocks = finalized.blocks;
    finalized.proposedRows.forEach(queueProposedEntityReference);
    finalized.referencedRows.forEach(queueMaterializedEntityReference);
    materialized.forEach((block) => {
      if (block.type === 'ref') queueMaterializedEntityReference(block.reference);
    });
    const inlineReferenceIds = new Set(
      [...finalized.blocks.values()].flatMap((block) => block.referenceIds)
    );
    const settledBlocks = presentCliReferencesInline(materialized, inlineReferenceIds).map(
      (block) => {
        if (block.type !== 'assistant_text') return block;
        const settled = finalized.blocks.get(block.id);
        return settled
          ? {
              ...block,
              content: settled.content,
              document: settled.document,
              referenceIds: settled.referenceIds,
            }
          : block;
      }
    );
    const messages = blocksToMessages(settledBlocks, turnId);
    transcript.clear();
    return messages;
  };
  const stopWithActivity = async (): Promise<CliTurnDisposition> => {
    const activityMessages = await materializeActivity(true);
    const stoppedMessage: ChatMessage = {
      id: crypto.randomUUID(),
      turnId,
      role: 'assistant',
      content: '*[Stopped. Send a follow-up to resume.]*',
      createdAt: createdAtAfter(activityMessages),
    };
    chatProviderPhase(set, conversationId, controller, 'settling');
    setConversationState(set, conversationId, (previous) => ({
      messages: [...previous.messages, ...activityMessages, stoppedMessage],
      streamingBlocks: [],
    }));
    activityMessages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
    queueTerminalMessage(stoppedMessage);
    await finishTurn('stopped', chatInterruptionReason(controller.signal));
    return 'stopped';
  };

  if (controller.signal.aborted) return stopWithActivity();
  const resolvedModelSettings = cliModelSettings ?? {
    model: null,
    reasoningEffort: DEFAULT_CLI_REASONING_EFFORTS[transport],
    serviceTier: null,
    personality: null,
  };
  const reasoningEffort = cliModelSettings
    ? resolvedModelSettings.reasoningEffort
    : DEFAULT_CLI_REASONING_EFFORTS[transport];
  const providerMessages = capability
    ? projectCapabilityIntoLatestUserMessage(transport, capability, expandedMessages)
    : [...expandedMessages];

  const workspaceSnapshotBefore: WorkspaceFileSnapshot | null =
    permissionMode === 'native-cli' && workspacePath != null
      ? await scanWorkspaceFiles(workspacePath).catch((error) => {
          console.warn('[Chat] Failed to snapshot workspace before CLI turn:', error);
          return null;
        })
      : null;

  const stagedRefIds =
    stagedReferenceIds.length > 0
      ? stagedReferenceIds
      : content.includes('[[ref:')
        ? [...content.matchAll(new RegExp(REF_TOKEN_PATTERN, 'g'))].map((match) => match[1])
        : [];
  let stagedSelectionRefs: DBEntityReference[] = [];
  if (stagedRefIds.length > 0) {
    stagedSelectionRefs = await getEntityReferencesByIds(stagedRefIds).catch((error) => {
      console.warn('[Chat] Failed to fetch staged selection refs for CLI handles:', error);
      return [] as DBEntityReference[];
    });
  }

  if (controller.signal.aborted) return stopWithActivity();

  const cliQueryId = crypto.randomUUID();
  const clearHydrogenRequest = registerMolecularHydrogenRequest(cliQueryId, content);
  const pendingTraceSequences = new Set<number>();
  let receivedTraceSequence = -1;
  let checkTraceCompletion: (() => void) | null = null;
  const waitForTraceCompletion = (lastTraceSequence: number | undefined): Promise<void> => {
    if (lastTraceSequence === undefined || lastTraceSequence === -1 || controller.signal.aborted)
      return Promise.resolve();
    if (!Number.isSafeInteger(lastTraceSequence) || lastTraceSequence < -1)
      return Promise.reject(new UserMessageError('assistant.trace.activityUnavailable'));
    if (receivedTraceSequence >= lastTraceSequence) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (failure?: Error) => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        checkTraceCompletion = null;
        if (failure) reject(failure);
        else resolve();
      };
      const onAbort = () => finish();
      const timer = setTimeout(
        () => finish(new UserMessageError('assistant.trace.activityUnavailable')),
        CLI_TRACE_COMPLETION_TIMEOUT_MS
      );
      checkTraceCompletion = () => {
        if (controller.signal.aborted || receivedTraceSequence >= lastTraceSequence) finish();
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      checkTraceCompletion();
    });
  };
  const cancelCliQuery = () => {
    platform()
      .agentSession.cancel(cliQueryId)
      .catch((error) => console.error('[Chat] Failed to cancel CLI session:', error));
  };
  controller.signal.addEventListener('abort', cancelCliQuery, { once: true });
  const unsubscribeTrace = platform().agentSession.onEvent((payload) => {
    if (controller.signal.aborted) return;
    if (payload.sessionId !== cliQueryId || payload.type !== 'trace') return;
    const sequence = payload.event.sequence;
    if (Number.isSafeInteger(sequence) && sequence > receivedTraceSequence) {
      pendingTraceSequences.add(sequence);
      while (pendingTraceSequences.delete(receivedTraceSequence + 1)) receivedTraceSequence += 1;
    }
    if (!isCliTranscriptTraceEvent(payload.event)) {
      checkTraceCompletion?.();
      return;
    }
    transcript.append(payload.event);
    for (const block of transcript.blocks) {
      if (block.type !== 'assistant_text') continue;
      block.document = inlineReferences.update(block.id, block.content);
    }
    setConversationState(set, conversationId, () => ({
      streamingBlocks: [...transcript.blocks],
    }));
    checkTraceCompletion?.();
  });

  const shellSupervision = dnaforgeSupervision(
    permissionFamilyForTransport(transport),
    permissions
  ).shellSupervision;
  let result: Awaited<ReturnType<ReturnType<typeof platform>['agentSession']['start']>>;
  try {
    const prompt = buildAgentSdkPrompt(
      folders,
      providerMessages,
      permissionMode,
      workspacePath != null,
      stagedSelectionRefs,
      shellSupervision,
      transport,
      conversationId
    );
    const continuationPrompt = buildAgentSdkContinuationPrompt(
      folders,
      providerMessages,
      permissionMode,
      workspacePath != null,
      stagedSelectionRefs,
      shellSupervision,
      transport,
      conversationId
    );
    writeMolecularTrialSentPromptSnapshot({
      version: 1,
      conversationId,
      turnId,
      bridgeTurnId: cliQueryId,
      agentConfiguration: {
        transport,
        model: resolvedModelSettings.model,
        reasoningEffort,
        serviceTier: resolvedModelSettings.serviceTier ?? null,
        personality: resolvedModelSettings.personality ?? null,
      },
      channel: 'cli-seed',
      prompt,
      continuationPrompt,
      additionalAgentInstructions: additionalAgentInstructions ?? null,
      capturedAt: Date.now(),
    });
    const execution = readMolecularPromptTrial(conversationId)?.execution;
    if (execution) {
      const workerApi = (
        window as Window & {
          electronAPI?: {
            proteinExperimentWorkers?: ProteinExperimentWorkersApi;
          };
        }
      ).electronAPI?.proteinExperimentWorkers;
      if (!workerApi) throw new Error('The experiment worker bridge is unavailable.');
      await workerApi.bind({ jobId: execution.jobId, turnId: cliQueryId });
      if (controller.signal.aborted) return stopWithActivity();
    }
    registerAgentChatFilesRoot(agentChatFilesRoot(await platform().path.appDataDir()));
    result = await platform().agentSession.start({
      sessionId: cliQueryId,
      conversationId,
      turnId,
      provider: transport,
      ...(binaryPathOverride ? { binaryPathOverride } : {}),
      authorityProfileId: getCliAuthorityProfileId({
        kind: 'cli',
        transport,
        permissionMode,
      }),
      prompt,
      continuationPrompt,
      cwd: workspacePath,
      reachRoots: getUserFolders(folders).map(({ path, name }) => ({ path, name })),
      workspaceGrounding: 'not-required',
      toolExposure: 'auto',
      permissions,
      additionalAgentInstructions,
      model: resolvedModelSettings.model,
      modelReasoningEffort: reasoningEffort,
      modelServiceTier: resolvedModelSettings.serviceTier,
      modelPersonality: resolvedModelSettings.personality,
      ...(capabilitySelection ? { capabilitySelection } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });
    await waitForTraceCompletion(result.lastTraceSequence);
  } finally {
    clearHydrogenRequest();
    unsubscribeTrace();
    controller.signal.removeEventListener('abort', cancelCliQuery);
  }

  if (
    permissionMode === 'native-cli' &&
    workspacePath != null &&
    !controller.signal.aborted &&
    result.stopState !== 'stop_requested'
  ) {
    await reconcileCliWorkspaceChanges({
      workspaceRoot: workspacePath,
      before: workspaceSnapshotBefore,
    }).catch((error) => {
      console.warn('[Chat] Failed to reconcile workspace after CLI turn:', error);
    });
  }

  if (!result.ok) {
    if (
      controller.signal.aborted ||
      result.stopState === 'stop_requested' ||
      result.error === 'Stop requested.' ||
      result.error === 'Generation stopped.'
    ) {
      return stopWithActivity();
    }
    const activityMessages = await materializeActivity(true);
    if (activityMessages.length > 0) {
      chatProviderPhase(set, conversationId, controller, 'settling');
      setConversationState(set, conversationId, (previous) => ({
        messages: [...previous.messages, ...activityMessages],
        streamingBlocks: [],
      }));
      activityMessages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
    }
    if (result.providerInputLimit) {
      const refusal = PROVIDER_INPUT_REFUSALS[result.providerInputLimit];
      const error = new UserMessageError(refusal.message);
      await finishTurn('failed', refusal.reason, error.message);
      throw error;
    }
    await finishTurn('failed', result.error || `${transport} failed`, result.error);
    throw new Error(result.error || `${transport} returned no response`);
  }

  if (controller.signal.aborted) return stopWithActivity();

  const rawFinalText = result.text.trim();
  const projectedActivityMessages = blocksToMessages(
    await materializeCliToolBlocks(transcript.blocks, turnId),
    turnId
  );
  const finalText =
    referenceCompletionFallback(projectedActivityMessages, rawFinalText) ?? rawFinalText;
  const finalTextAlreadyMaterialized = hasMaterializedAssistantText(
    projectedActivityMessages,
    finalText
  );
  const finalTextBlockId = `${turnId}:cli-final`;
  if (!finalTextAlreadyMaterialized) inlineReferences.update(finalTextBlockId, finalText);
  let activityMessages = await materializeActivity();
  if (result.structuredOutput && finalTextAlreadyMaterialized) {
    let lastAssistantIndex = -1;
    for (let index = activityMessages.length - 1; index >= 0; index -= 1) {
      if (activityMessages[index].role === 'assistant') {
        lastAssistantIndex = index;
        break;
      }
    }
    if (lastAssistantIndex >= 0) {
      activityMessages = activityMessages.map((message, index) =>
        index === lastAssistantIndex
          ? { ...message, structuredOutput: result.structuredOutput }
          : message
      );
    }
  }
  const finalizedFinalBlock = !finalTextAlreadyMaterialized
    ? finalizedInlineBlocks.get(finalTextBlockId)
    : undefined;
  const assistantMessage: ChatMessage | null = finalTextAlreadyMaterialized
    ? null
    : {
        id: finalTextBlockId,
        turnId,
        role: 'assistant',
        content: finalizedFinalBlock?.content ?? finalText,
        createdAt: createdAtAfter(activityMessages),
        document: finalizedFinalBlock?.document,
        referenceIds: finalizedFinalBlock?.referenceIds,
        structuredOutput: result.structuredOutput,
      };
  chatProviderPhase(set, conversationId, controller, 'settling');
  setConversationState(set, conversationId, (previous) => ({
    messages: [
      ...previous.messages,
      ...activityMessages,
      ...(assistantMessage ? [assistantMessage] : []),
    ],
    streamingBlocks: [],
  }));
  activityMessages.forEach((message) => queueTerminalMessage(message, message.referenceIds));
  if (assistantMessage) queueTerminalMessage(assistantMessage, assistantMessage.referenceIds);
  await finishTurn('completed', 'completed');
  return 'completed';
}
