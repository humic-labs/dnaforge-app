import { buildAgentExecutionInstructions } from './agent-execution-instructions';
import { readAgentPresentationPreferences } from '../agent-presentation-preferences';
import { chatInterruptionReason } from './chat-runtime';
import {
  userMessage,
  type UserMessage,
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { getProviderMeta } from '../providers';
import { validateModelSelection } from '../../../shared/cli-model-selection';
import {
  createChatTurnWithUserMessage,
  createConversation,
  getChatTurns,
  getConversation,
  getMessages,
  getMessageAttachmentsForMessages,
  getStructuredOutputsForConversation,
  updateConversationTitleIfUnchanged,
  updateConversationRoute,
} from '../../../db';
import { platform } from '../../../platform';
import type { AgentCliModelReasoningEffort, AgentCliPermissionMode } from '../../../platform';
import {
  useWorkspaceStore,
  workspaceScopeFromState,
  type WorkspaceFolder,
} from '../../../stores/workspaceStore';
import { isHostedBrowserRuntime } from '../../../utils/environment';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import {
  buildAssistantTurnRouteSnapshot,
  type AssistantRouteSelection,
  type AssistantTurnRouteSnapshot,
} from '../assistant-routes';
import {
  resolveAssistantSendRoute,
  type AssistantSendRouteResolution,
} from '../assistant-send-route';
import { announceAssistantRouteFallback } from './assistant-route-fallback-notice';
import { useAISettingsStore } from '../settings';
import { readPermissionCatalog } from '../permission-catalog';
import { getCustomCliHarnessDefinition } from '../custom-cli-harnesses';
import {
  blocksToMessages,
  createdAtAfter,
  dbConversationToSummary,
  dbMessageToChatMessage,
  dbTurnsToSummaryMap,
  attachPersistedChatMetadata,
} from './chat-projections';
import { mergeHydratedConversationState } from './chat-conversation-state';
import {
  claimChatSend,
  isChatConversationDeleted,
  registerChatAbortController,
  replaceConversationState,
  releaseChatAbortController,
  setConversationState,
  type ChatStoreGet,
  type ChatStoreSet,
} from './chat-runtime';
import {
  EMPTY_CONV_STATE,
  type ChatSendOptions,
  type ChatTurnSummary,
  type ConversationState,
} from './chat-store-types';
import type { ChatMessage } from './chat-types';
import { recoverInterruptedChatTurns } from './chat-turn-repository';
import { createChatTurnLifecycle, type ChatTurnLifecycle } from './chat-turn-lifecycle';
import { assembleTurnModelMessages } from './assemble-turn-context';
import { executeCliTurn } from './execute-cli-turn';
import { executeHostedTurn, HostedStopTerminalError } from './execute-hosted-turn';
import { CHAT_TURN_MATERIALIZED_EVENT } from '../../../shared/conversation-ledger-ipc';
import { createCliTranscriptAccumulator, materializeCliToolBlocks } from '../transports/cli';
import { hostedTurnEventType } from '../transports/hosted';
import { hostedCodexBridge, prepareHostedCodexContribution } from '../hosted-gateway';
import { executeHostedCodexTurn, HostedCodexTurnExecutionError } from './execute-hosted-codex-turn';
import type { AgentCapabilityControl } from '../../../shared/agent-capability-controls';
import { requireFreshMolecularTrialConversation } from '../molecular-trial-admission';
import { readMolecularPromptTrial } from '../molecular-prompt-trials';
import { chatPermissions, withPermissions } from './chat-permissions';
import {
  generateCliConversationTitle,
  generateHostedConversationTitle,
  generateProviderConversationTitle,
} from './conversation-title';

const DEFAULT_CLI_PERMISSION_MODE: AgentCliPermissionMode = 'native-cli';
const HOSTED_UNTYPED_FAILURE_MESSAGE =
  'DNAForge AI is unavailable right now. Please try again shortly.';

type RunChatTurnOptions = ChatSendOptions & {
  readonly userMessageId?: string;
  readonly removeVisibleQueueRowOnAccept?: boolean;
  readonly onUserMessageAccepted?: () => void;
  readonly routeSelection?: AssistantRouteSelection;
  readonly routeSnapshot?: AssistantTurnRouteSnapshot;
};

function providerResponseMessage(responseBody: unknown): string | null {
  if (typeof responseBody !== 'string') return null;
  const trimmed = responseBody.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 1_500);
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        const nestedMessage = (error as Record<string, unknown>).message;
        if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
          return nestedMessage.trim().slice(0, 1_500);
        }
      }
      for (const field of ['message', 'detail'] as const) {
        const value = record[field];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 1_500);
      }
    }
  } catch {}
  return trimmed.slice(0, 1_500);
}

function nestedErrorMessage(value: unknown, seen: Set<object> = new Set(), depth = 0): string {
  if (depth > 4) return '';
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);

  const record = value as Record<string, unknown>;
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  for (const field of ['message', 'detail'] as const) {
    const message = record[field];
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  for (const field of ['error', 'cause', 'lastError'] as const) {
    const message = nestedErrorMessage(record[field], seen, depth + 1);
    if (message) return message;
  }
  if (Array.isArray(record.errors)) {
    for (const candidate of [...record.errors].reverse()) {
      const message = nestedErrorMessage(candidate, seen, depth + 1);
      if (message) return message;
    }
  }
  if (typeof record.name === 'string' && record.name.trim()) {
    return `Provider request failed (${record.name.trim()}).`;
  }
  return '';
}

function chatTurnErrorMessage(error: unknown): string {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const statusCode =
    typeof record?.statusCode === 'number' && Number.isInteger(record.statusCode)
      ? record.statusCode
      : null;
  const responseMessage = providerResponseMessage(record?.responseBody);
  const directMessage = nestedErrorMessage(error);
  const detail = responseMessage || directMessage;
  if (statusCode !== null) {
    return detail
      ? `HTTP ${statusCode}: ${detail}`
      : `HTTP ${statusCode}: Provider request failed.`;
  }
  return detail || 'An error occurred';
}

export async function runChatTurn(
  set: ChatStoreSet,
  get: ChatStoreGet,
  content: string,
  workspacePath: string | null,
  conversationId?: string | null,
  referenceIds?: string[],
  options?: RunChatTurnOptions
): Promise<'started' | 'not_started'> {
  const workspaceAtSend = useWorkspaceStore.getState();
  const workspaceIsMounted = workspaceAtSend.folders.some(
    (folder) => folder.path === workspacePath
  );
  let turnWorkspacePath =
    workspacePath && (workspaceIsMounted || workspaceAtSend.lastRemovedFolderPath !== workspacePath)
      ? workspacePath
      : null;
  const requestedConvId = conversationId?.trim() || get().currentConversationId || '';
  if (requestedConvId && isChatConversationDeleted(requestedConvId)) return 'not_started';
  const sendLeaseKey = requestedConvId || `new:${turnWorkspacePath ?? 'workspace-less'}`;
  const sendClaim = claimChatSend(sendLeaseKey);
  if (!sendClaim) return 'not_started';

  const provisionalTurnId = crypto.randomUUID();
  const provisionalConversationId = requestedConvId || crypto.randomUUID();
  const hostedTurnIdentity = {
    workflowId: provisionalConversationId,
    runId: provisionalTurnId,
    turnId: provisionalTurnId,
  };
  let hostedTurnPrepared = false;
  const cancelPreparedHostedTurn = async (): Promise<void> => {
    if (!hostedTurnPrepared) return;
    hostedTurnPrepared = false;
    try {
      await hostedCodexBridge()?.cancelPreparedTurn(hostedTurnIdentity);
    } catch (error) {
      console.error('[Chat] Failed to release a prepared Hosted turn:', error);
    }
  };
  const releasePrestartClaim = () => {
    if (requestedConvId) {
      releaseChatAbortController(requestedConvId);
    }
    sendClaim.release();
  };
  const setNotStartedError = (error: UserMessage) => {
    if (options?.onNotStarted) {
      options.onNotStarted(error);
    } else if (requestedConvId) {
      setConversationState(set, requestedConvId, () => ({ error }));
    } else {
      set({ error });
    }
  };
  const settings = useAISettingsStore.getState();
  const capturedRouteSelection = options?.routeSelection;
  const capturedRouteSnapshot = options?.routeSnapshot;
  if (!!capturedRouteSelection !== !!capturedRouteSnapshot) {
    setNotStartedError(
      userMessage('failure.queued-assistant-route-capture-is-incomplete-submit-the-message-again')
    );
    releasePrestartClaim();
    return 'not_started';
  }
  const uncapturedRouteResolution: AssistantSendRouteResolution | null = capturedRouteSelection
    ? null
    : resolveAssistantSendRoute(settings);
  if (uncapturedRouteResolution?.status === 'unresolved') {
    setNotStartedError(
      userMessage('failure.still-checking-available-ai-routes-try-again-in-a-moment')
    );
    releasePrestartClaim();
    return 'not_started';
  }
  let routeForTurn: AssistantRouteSelection;
  let turnRouteSnapshot: AssistantTurnRouteSnapshot;
  let resolvedCapability: AgentCapabilityControl | null = null;
  try {
    if (capturedRouteSelection && capturedRouteSnapshot) {
      const validatedSnapshot = buildAssistantTurnRouteSnapshot(capturedRouteSelection);
      if (JSON.stringify(validatedSnapshot) !== JSON.stringify(capturedRouteSnapshot)) {
        throw new Error(
          'Queued assistant route capture failed validation. Submit the message again.'
        );
      }
      routeForTurn = capturedRouteSelection;
      turnRouteSnapshot = capturedRouteSnapshot;
    } else {
      const activeRoute =
        uncapturedRouteResolution?.status === 'selected' ||
        uncapturedRouteResolution?.status === 'fallback'
          ? uncapturedRouteResolution.route
          : uncapturedRouteResolution?.status === 'blocked'
            ? uncapturedRouteResolution.preferred
            : null;
      if (!activeRoute) {
        throw new Error('No executable AI route is available in this build.');
      }
      routeForTurn = activeRoute;
      turnRouteSnapshot = buildAssistantTurnRouteSnapshot(routeForTurn);
    }
  } catch (error) {
    setNotStartedError(toUserMessage(error, 'assistant.failed'));
    releasePrestartClaim();
    return 'not_started';
  }
  if (
    routeForTurn.kind === 'cli' &&
    routeForTurn.transport === 'codex-sdk' &&
    !routeForTurn.customHarnessId
  ) {
    const detected = settings.agentDetection?.codex;
    const selection = settings.cliModelSettings?.['codex-sdk'];
    if (detected?.modelCatalog) {
      const models = detected.models ?? [];
      const error: UserMessage | null =
        detected.modelCatalog.status !== 'complete' ||
        detected.modelCatalog.observedModelCount !== models.length
          ? userMessage('assistant.modelsUnavailable')
          : validateModelSelection(models, selection?.model, null, null);
      if (error) {
        setNotStartedError(error);
        releasePrestartClaim();
        return 'not_started';
      }
    }
  }

  let molecularTrialReasoningEffort: AgentCliModelReasoningEffort | undefined;
  try {
    const history = get()._convStates.get(provisionalConversationId);
    await requireFreshMolecularTrialConversation(
      provisionalConversationId,
      content,
      referenceIds?.length ?? 0,
      options?.attachments?.length ?? 0,
      history?.messages.length ?? 0,
      Object.keys(history?.turns ?? {}).length
    );
    const trial = readMolecularPromptTrial(provisionalConversationId);
    if (trial?.execution?.reasoningEffort !== undefined) {
      if (routeForTurn.kind !== 'cli' || routeForTurn.transport !== 'codex-sdk')
        throw new Error('Protein trial reasoning effort overrides require the Codex CLI route.');
      molecularTrialReasoningEffort = trial.execution.reasoningEffort;
    }
  } catch (error) {
    setNotStartedError(toUserMessage(error, 'assistant.failed'));
    releasePrestartClaim();
    return 'not_started';
  }
  if (options?.attachments?.length && routeForTurn.kind !== 'cli') {
    setNotStartedError(
      userMessage('failure.file-attachments-currently-require-a-local-cli-agent-route-choose-clau')
    );
    releasePrestartClaim();
    return 'not_started';
  }
  if (options?.capabilitySelection) {
    if (
      routeForTurn.kind !== 'cli' ||
      routeForTurn.transport !== options.capabilitySelection.provider
    ) {
      setNotStartedError(
        userMessage('failure.the-selected-agent-action-does-not-belong-to-the-active-cli-route')
      );
      releasePrestartClaim();
      return 'not_started';
    }
    try {
      const resolution = await platform().agentCapabilities.resolve(options.capabilitySelection);
      if (!resolution.ok) {
        setNotStartedError(
          resolution.reason === 'stale-snapshot'
            ? userMessage(
                'notice.the-selected-agent-action-is-stale-open-agent-actions-and-choose-it-ag'
              )
            : userMessage('failure.the-selected-agent-action-is-no-longer-available')
        );
        releasePrestartClaim();
        return 'not_started';
      }
      resolvedCapability = resolution.control;
    } catch (error) {
      setNotStartedError(toUserMessage(error, 'assistant.failed'));
      releasePrestartClaim();
      return 'not_started';
    }
  }
  const agentTransport = turnRouteSnapshot.transport;
  const hostedTier = routeForTurn.kind === 'hosted' ? routeForTurn.tier : null;
  const provider = turnRouteSnapshot.provider ?? settings.provider;
  const modelName = turnRouteSnapshot.model ?? settings.model;
  let apiKey: string | null = null;
  let persistedConversation: Awaited<ReturnType<typeof getConversation>> | undefined;
  try {
    if (!agentTransport && !hostedTier) {
      apiKey = await settings.getApiKey(provider);
      if (requestedConvId && isChatConversationDeleted(requestedConvId)) {
        releasePrestartClaim();
        return 'not_started';
      }
      if (!apiKey) {
        setNotStartedError(
          userMessageWithValues('assistant.keyMissing', {
            provider: userMessageValue(getProviderMeta(provider).label),
          })
        );
        releasePrestartClaim();
        return 'not_started';
      }
    }
    if (requestedConvId) {
      persistedConversation = await getConversation(requestedConvId);
      if (isChatConversationDeleted(requestedConvId)) {
        releasePrestartClaim();
        return 'not_started';
      }
      const summary = get().conversations.find(
        (conversation) => conversation.id === requestedConvId
      );
      if (persistedConversation) turnWorkspacePath = persistedConversation.workspace_path;
      else if (summary) turnWorkspacePath = summary.workspacePath;
    }
    if (turnWorkspacePath && !isHostedBrowserRuntime()) {
      const resolve = platform().workspace.resolveRegisteredProject;
      if (!resolve) throw new Error('Registered project authority is unavailable.');
      const project = await resolve(turnWorkspacePath);
      if (!project) throw new Error('The conversation project is unavailable.');
      turnWorkspacePath = project.path;
    }
  } catch (error) {
    setNotStartedError(toUserMessage(error, 'assistant.failed'));
    releasePrestartClaim();
    return 'not_started';
  }
  if (routeForTurn.kind === 'hosted') {
    try {
      const gate = await prepareHostedCodexContribution({
        ...hostedTurnIdentity,
        workspacePath: turnWorkspacePath,
      });
      if (gate.error) {
        const publicError: UserMessage = gate.error;
        setNotStartedError(publicError);
        releasePrestartClaim();
        return 'not_started';
      }
      if (!gate.started) {
        setNotStartedError(
          userMessage(
            'failure.dnaforge-agent-could-not-start-this-message-try-again-or-choose-anothe'
          )
        );
        releasePrestartClaim();
        return 'not_started';
      }
      hostedTurnPrepared = true;
    } catch (error) {
      releasePrestartClaim();
      throw error;
    }
  }

  try {
    useStructure3dStore.getState().clearAgentHighlightGroups();
  } catch (error) {
    await cancelPreparedHostedTurn();
    releasePrestartClaim();
    throw error;
  }
  let controller: AbortController | null = null;
  let convId: string = '';
  let turnId: string | null = null;
  let turnLifecycle: ChatTurnLifecycle | null = null;
  let generateTitle: (() => Promise<string | null>) | null = null;
  const cliTranscript = createCliTranscriptAccumulator();
  const stagedReferenceIds = referenceIds ?? [];
  const queueTerminalMessage: ChatTurnLifecycle['queueTerminalMessage'] = (...args) => {
    turnLifecycle?.queueTerminalMessage(...args);
  };
  const queueProposedEntityReference: ChatTurnLifecycle['queueProposedEntityReference'] = (
    ...args
  ) => {
    turnLifecycle?.queueProposedEntityReference(...args);
  };
  const queueMaterializedEntityReference: ChatTurnLifecycle['queueMaterializedEntityReference'] = (
    ...args
  ) => {
    turnLifecycle?.queueMaterializedEntityReference(...args);
  };
  const trackShadowLedgerAppend: ChatTurnLifecycle['trackShadowLedgerAppend'] = (...args) => {
    turnLifecycle?.trackShadowLedgerAppend(...args);
  };
  const finishTurn: ChatTurnLifecycle['finishTurn'] = async (...args) => {
    if (convId && isChatConversationDeleted(convId)) return;
    await turnLifecycle?.finishTurn(...args);
  };
  try {
    convId = provisionalConversationId;
    const conversationProvider = hostedTier ? 'DNAForge AI' : (agentTransport ?? provider);
    const conversationModel = hostedTier ? hostedTier : (agentTransport ?? modelName);
    const existingConvState = get()._convStates.get(convId);
    const existingSummary = get().conversations.find((conv) => conv.id === convId);
    const installSendConversationState = (next: ConversationState): void => {
      replaceConversationState(set, convId, next);
    };

    const hasLoadedConversationHistory =
      !!existingConvState &&
      (existingConvState.messages.length > 0 ||
        Object.keys(existingConvState.turns).length > 0 ||
        existingConvState.activeTurnId !== null ||
        existingConvState.isLoading);

    if (existingConvState && existingSummary && hasLoadedConversationHistory) {
      const existingState = { ...EMPTY_CONV_STATE, ...existingConvState };
      installSendConversationState(existingState);
    } else {
      let dbConversation =
        persistedConversation === undefined ? await getConversation(convId) : persistedConversation;
      if (isChatConversationDeleted(convId)) return 'not_started';
      const createdNewConversation = !dbConversation;
      if (!dbConversation) {
        dbConversation = await createConversation(
          convId,
          'New conversation',
          turnWorkspacePath,
          conversationProvider,
          conversationModel
        );
      }

      const shouldHydrateHistory = !createdNewConversation && !hasLoadedConversationHistory;
      let messages = existingConvState?.messages ?? [];
      if (shouldHydrateHistory) {
        const persistedMessages = await getMessages(convId);
        const [attachmentMap, structuredOutputs] = await Promise.all([
          getMessageAttachmentsForMessages(persistedMessages.map((message) => message.id)),
          getStructuredOutputsForConversation(convId),
        ]);
        messages = attachPersistedChatMetadata(
          persistedMessages.map(dbMessageToChatMessage),
          attachmentMap,
          structuredOutputs
        );
      }
      const turns = shouldHydrateHistory
        ? dbTurnsToSummaryMap(await recoverInterruptedChatTurns(convId, await getChatTurns(convId)))
        : (existingConvState?.turns ?? {});
      const convState: ConversationState = {
        ...EMPTY_CONV_STATE,
        ...(existingConvState ?? {}),
        messages,
        turns,
        activeTurnId: Object.values(turns).find((turn) => turn.status === 'running')?.id ?? null,
      };
      const conversationSummary = dbConversationToSummary(dbConversation);

      set((state) => {
        if (isChatConversationDeleted(convId)) return {};
        const mergedState = mergeHydratedConversationState(
          convState,
          state._convStates.get(convId)
        );
        const newMap = new Map(state._convStates);
        newMap.set(convId, mergedState);
        const hasSummary = state.conversations.some((conv) => conv.id === convId);
        const isActive = state.currentConversationId === convId;
        return {
          conversations: hasSummary
            ? state.conversations
            : [conversationSummary, ...state.conversations],
          _convStates: newMap,
          ...(isActive
            ? {
                messages: mergedState.messages,
                turns: mergedState.turns,
                activeTurnId: mergedState.activeTurnId,
                streamingBlocks: mergedState.streamingBlocks,
                isLoading: mergedState.isLoading,
                isStreaming: mergedState.isStreaming,
                error: mergedState.error,
                queuedMessages: mergedState.queuedMessages,
              }
            : {}),
        };
      });
      installSendConversationState(get()._convStates.get(convId) ?? convState);
    }

    if (isChatConversationDeleted(convId)) return 'not_started';

    if (get()._convStates.get(convId)?.isLoading) return 'not_started';

    const getConv = () => get()._convStates.get(convId) ?? EMPTY_CONV_STATE;

    controller = new AbortController();
    registerChatAbortController(convId, controller);

    setConversationState(set, convId, () => ({ isLoading: true, error: null }));

    const isFirstMessage = getConv().messages.length === 0;
    if (isFirstMessage && !agentTransport && !hostedTier && apiKey) {
      generateTitle = () =>
        generateProviderConversationTitle({
          provider,
          modelName,
          apiKey,
          userText: content,
        });
    } else if (isFirstMessage && agentTransport && turnRouteSnapshot.authorityProfileId) {
      const customHarness =
        routeForTurn.kind === 'cli' && routeForTurn.customHarnessId
          ? getCustomCliHarnessDefinition(routeForTurn.customHarnessId)
          : null;
      const cliModelSettings = customHarness ?? settings.cliModelSettings?.[agentTransport];
      generateTitle = () =>
        generateCliConversationTitle({
          session: {
            provider: agentTransport,
            authorityProfileId: turnRouteSnapshot.authorityProfileId as string,
            ...(customHarness?.executablePath
              ? { binaryPathOverride: customHarness.executablePath }
              : settings.cliExecutablePathOverrides?.[agentTransport]
                ? { binaryPathOverride: settings.cliExecutablePathOverrides[agentTransport] }
                : {}),
            model: cliModelSettings?.model ?? null,
            modelReasoningEffort: cliModelSettings?.reasoningEffort ?? null,
            modelServiceTier: cliModelSettings?.serviceTier ?? null,
            modelPersonality: cliModelSettings?.personality ?? null,
          },
          userText: content,
        });
    } else if (isFirstMessage && hostedTier) {
      generateTitle = () => generateHostedConversationTitle({ userText: content });
    }

    turnId = provisionalTurnId;
    const userMsg: ChatMessage = {
      id: options?.userMessageId ?? crypto.randomUUID(),
      turnId,
      role: 'user',
      content,
      createdAt: Date.now(),
      ...(options?.attachments?.length
        ? { attachments: options.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
    };

    const turnPermissions = chatPermissions(
      get()._convStates.get(convId),
      await readPermissionCatalog(),
      settings.agentPermissions
    );
    const turnRouteSnapshotJson = withPermissions(
      turnRouteSnapshot.routeSnapshotJson,
      turnPermissions
    );
    await createChatTurnWithUserMessage({
      turn: {
        id: turnId,
        conversation_id: convId,
        route_kind: turnRouteSnapshot.routeKind,
        host_id: turnRouteSnapshot.hostId,
        provider: turnRouteSnapshot.provider,
        model: turnRouteSnapshot.model,
        transport: turnRouteSnapshot.transport,
        authority_profile_id: turnRouteSnapshot.authorityProfileId,
        permission_mode: turnRouteSnapshot.permissionMode,
        route_snapshot_json: turnRouteSnapshotJson,
        status: 'running',
        terminal_reason: null,
        error: null,
        started_at: userMsg.createdAt,
        completed_at: null,
      },
      message: {
        id: userMsg.id,
        conversation_id: convId,
        turn_id: turnId,
        role: 'user',
        content,
        tool_name: null,
        tool_call_id: null,
        created_at: userMsg.createdAt,
      },
      reference_ids: stagedReferenceIds,
      attachment_manifests: userMsg.attachments,
    });
    if (isChatConversationDeleted(convId)) return 'not_started';
    turnLifecycle = createChatTurnLifecycle({
      set,
      conversationId: convId,
      turnId,
    });
    turnLifecycle.setMaterializedLedgerAppender((payload, completedAt) => {
      trackShadowLedgerAppend(
        platform().conversationLedger.appendEvent({
          conversation_id: convId,
          turn_id: turnId,
          source: 'app:chat',
          provider: conversationProvider,
          model: conversationModel,
          stream_event_type: CHAT_TURN_MATERIALIZED_EVENT,
          payload,
          created_at: new Date(completedAt).toISOString(),
        }),
        'Materialized turn'
      );
    });
    if (!agentTransport && !hostedTier) {
      turnLifecycle.setTerminalLedgerAppender((status, terminalReason, error, completedAt) => {
        trackShadowLedgerAppend(
          platform().conversationLedger.appendEvent({
            conversation_id: convId,
            turn_id: turnId,
            source: 'provider:vercel',
            provider,
            model: modelName,
            stream_event_type: hostedTurnEventType(status),
            payload: {
              type: hostedTurnEventType(status),
              status,
              terminal_reason: terminalReason,
              error,
              completed_at: completedAt,
            },
            created_at: new Date(completedAt).toISOString(),
          }),
          'Provider terminal'
        );
      });
    }
    trackShadowLedgerAppend(
      platform().conversationLedger.appendEvent({
        conversation_id: convId,
        turn_id: turnId,
        source: 'app:chat',
        provider: conversationProvider,
        model: conversationModel,
        stream_event_type: 'user-message',
        payload: {
          message: {
            id: userMsg.id,
            role: 'user',
            content,
            created_at: userMsg.createdAt,
          },
          route: turnRouteSnapshot,
          capability: resolvedCapability
            ? {
                id: resolvedCapability.id,
                nativeId: resolvedCapability.nativeId,
                kind: resolvedCapability.kind,
                source: resolvedCapability.source ?? null,
              }
            : null,
        },
        created_at: new Date(userMsg.createdAt).toISOString(),
      }),
      'User'
    );
    setConversationState(set, convId, (prev) => {
      const promotedIndex = options?.removeVisibleQueueRowOnAccept
        ? prev.queuedMessages.findIndex((queued) => queued.id === userMsg.id)
        : -1;
      const queuedMessages =
        promotedIndex < 0
          ? prev.queuedMessages
          : [
              ...prev.queuedMessages.slice(0, promotedIndex),
              ...prev.queuedMessages.slice(promotedIndex + 1),
            ];
      return {
        messages: [...prev.messages, userMsg],
        queuedMessages,
      };
    });
    if (uncapturedRouteResolution) announceAssistantRouteFallback(uncapturedRouteResolution);
    options?.onUserMessageAccepted?.();
    const turnSummary: ChatTurnSummary = {
      id: turnId,
      conversationId: convId,
      routeKind: turnRouteSnapshot.routeKind,
      hostId: turnRouteSnapshot.hostId,
      provider: turnRouteSnapshot.provider,
      model: turnRouteSnapshot.model,
      transport: turnRouteSnapshot.transport,
      authorityProfileId: turnRouteSnapshot.authorityProfileId,
      permissionMode: turnRouteSnapshot.permissionMode,
      routeSnapshotJson: turnRouteSnapshotJson,
      status: 'running',
      terminalReason: null,
      error: null,
      startedAt: userMsg.createdAt,
      completedAt: null,
    };
    setConversationState(set, convId, (prev) => ({
      turns: { ...prev.turns, [turnId as string]: turnSummary },
      activeTurnId: turnId,
    }));

    try {
      options?.onStarted?.(convId);
    } catch (error) {
      console.error('[Chat] onStarted callback failed after durable turn creation:', error);
    }

    if (isFirstMessage && generateTitle) {
      const titleConversationId = convId;
      const titleGenerator = generateTitle;
      void (async () => {
        const generatedTitle = await titleGenerator();
        if (!generatedTitle || isChatConversationDeleted(titleConversationId)) return;
        const updated = await updateConversationTitleIfUnchanged(
          titleConversationId,
          'New conversation',
          generatedTitle
        );
        if (!updated || isChatConversationDeleted(titleConversationId)) return;
        set((current) => ({
          conversations: current.conversations.map((conversation) =>
            conversation.id === titleConversationId && conversation.title === 'New conversation'
              ? { ...conversation, title: generatedTitle }
              : conversation
          ),
        }));
      })().catch(() => console.warn('[Chat] Automatic conversation title was unavailable.'));
    }

    if (controller.signal.aborted) {
      throw new DOMException('Stop requested.', 'AbortError');
    }

    const routeSummary = get().conversations.find((conversation) => conversation.id === convId);
    if (
      routeSummary &&
      (routeSummary.provider !== conversationProvider || routeSummary.model !== conversationModel)
    ) {
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === convId
            ? { ...conversation, provider: conversationProvider, model: conversationModel }
            : conversation
        ),
      }));
      updateConversationRoute(convId, conversationProvider, conversationModel).catch((err) =>
        console.error('[Chat] Failed to update conversation route metadata:', err)
      );
    }

    const { expandedMessages, modelMessages, exposedReferenceIds } =
      await assembleTurnModelMessages({
        messages: getConv().messages,
        currentUserMessageId: userMsg.id,
        stagedReferenceIds,
        workspacePath: turnWorkspacePath,
      });
    let turnExecutionFolders: WorkspaceFolder[];
    if (isHostedBrowserRuntime()) {
      turnExecutionFolders = [...useWorkspaceStore.getState().folders];
    } else {
      const listRegisteredProjects = platform().workspace.listRegisteredProjects;
      if (!listRegisteredProjects) throw new Error('Registered project authority is unavailable.');
      turnExecutionFolders = await listRegisteredProjects();
      if (
        turnWorkspacePath &&
        !turnExecutionFolders.some((folder) => folder.path === turnWorkspacePath)
      )
        throw new Error('The conversation project is unavailable.');
    }
    const inlineReferenceWorkspaceScope = workspaceScopeFromState(useWorkspaceStore.getState());
    const isInlineReferenceWorkspaceScopeCurrent = () =>
      workspaceScopeFromState(useWorkspaceStore.getState()) === inlineReferenceWorkspaceScope;

    if (controller.signal.aborted) {
      throw new DOMException('Stop requested.', 'AbortError');
    }

    const agentPresentationPreferences = readMolecularPromptTrial(convId)
      ? null
      : await readAgentPresentationPreferences();

    if (agentTransport) {
      const folders = turnExecutionFolders;
      const permissionMode: AgentCliPermissionMode =
        turnRouteSnapshot.permissionMode ?? DEFAULT_CLI_PERMISSION_MODE;
      const customHarness =
        routeForTurn.kind === 'cli' && routeForTurn.customHarnessId
          ? getCustomCliHarnessDefinition(routeForTurn.customHarnessId)
          : null;
      const binaryPathOverride =
        customHarness?.executablePath ?? settings.cliExecutablePathOverrides?.[agentTransport];
      const cliModelSettings = customHarness
        ? {
            model: customHarness.model,
            reasoningEffort: customHarness.reasoningEffort,
            serviceTier: customHarness.serviceTier,
            personality: customHarness.personality,
          }
        : settings.cliModelSettings?.[agentTransport];
      await executeCliTurn({
        set,
        conversationId: convId,
        turnId,
        transport: agentTransport,
        ...(binaryPathOverride ? { binaryPathOverride } : {}),
        permissionMode,
        permissions: turnPermissions,
        additionalAgentInstructions: buildAgentExecutionInstructions(
          settings.additionalAgentInstructions,
          agentPresentationPreferences
        ),
        cliModelSettings:
          molecularTrialReasoningEffort === undefined
            ? cliModelSettings
            : {
                ...cliModelSettings,
                model: cliModelSettings?.model ?? null,
                reasoningEffort: molecularTrialReasoningEffort,
              },
        folders,
        expandedMessages,
        content,
        stagedReferenceIds,
        allowedExistingReferenceIds: exposedReferenceIds,
        workspaceScope: inlineReferenceWorkspaceScope,
        isWorkspaceScopeCurrent: isInlineReferenceWorkspaceScopeCurrent,
        workspacePath: turnWorkspacePath,
        controller,
        transcript: cliTranscript,
        queueTerminalMessage,
        queueProposedEntityReference,
        queueMaterializedEntityReference,
        capability: resolvedCapability,
        capabilitySelection: options?.capabilitySelection,
        attachments: userMsg.attachments,
        finishTurn,
      });
      controller = null;
      return 'started';
    }

    if (hostedTier) {
      const fixedBridge = hostedCodexBridge();
      if (!fixedBridge) throw new Error('DNAForge AI is unavailable in this environment.');
      const folders = turnExecutionFolders;
      await executeHostedCodexTurn({
        permissions: turnPermissions,
        bridge: fixedBridge,
        set,
        get,
        conversationId: convId,
        turnId,
        tier: hostedTier,
        folders,
        expandedMessages,
        currentUserMessageId: userMsg.id,
        stagedReferenceIds,
        allowedExistingReferenceIds: exposedReferenceIds,
        workspaceScope: inlineReferenceWorkspaceScope,
        isWorkspaceScopeCurrent: isInlineReferenceWorkspaceScopeCurrent,
        workspacePath: turnWorkspacePath,
        additionalAgentInstructions: buildAgentExecutionInstructions(
          settings.additionalAgentInstructions,
          agentPresentationPreferences
        ),
        controller,
        queueTerminalMessage,
        queueProposedEntityReference,
        queueMaterializedEntityReference,
        finishTurn,
      });
      controller = null;
      return 'started';
    }

    if (!apiKey) {
      console.error('[Chat] sendMessage aborted at model creation: apiKey unexpectedly null');
      setConversationState(set, convId, () => ({
        error: userMessageWithValues('assistant.keyMissing', {
          provider: userMessageValue(getProviderMeta(provider).label),
        }),
      }));
      return 'started';
    }

    const folders = turnExecutionFolders;
    await executeHostedTurn({
      set,
      get,
      conversationId: convId,
      turnId,
      provider,
      modelName,
      apiKey,
      folders,
      modelMessages,
      content,
      allowedExistingReferenceIds: exposedReferenceIds,
      workspaceScope: inlineReferenceWorkspaceScope,
      isWorkspaceScopeCurrent: isInlineReferenceWorkspaceScopeCurrent,
      workspacePath: turnWorkspacePath,
      additionalAgentInstructions: buildAgentExecutionInstructions(
        settings.additionalAgentInstructions,
        agentPresentationPreferences
      ),
      controller,
      queueTerminalMessage,
      queueProposedEntityReference,
      queueMaterializedEntityReference,
      finishTurn,
      trackShadowLedgerAppend,
    });
    controller = null;
    return 'started';
  } catch (err) {
    if (
      !(err instanceof HostedStopTerminalError) &&
      controller?.signal.aborted &&
      convId &&
      turnLifecycle
    ) {
      const activityMessages = blocksToMessages(
        await materializeCliToolBlocks(cliTranscript.blocks, turnId),
        turnId
      );
      cliTranscript.clear();
      const stoppedMsg: ChatMessage = {
        id: crypto.randomUUID(),
        turnId,
        role: 'assistant',
        content: '*[Stopped. Send a follow-up to resume.]*',
        createdAt: createdAtAfter(activityMessages),
      };
      setConversationState(set, convId, (prev) => ({
        messages: [...prev.messages, ...activityMessages, stoppedMsg],
        streamingBlocks: [],
        isStreaming: false,
        error: null,
      }));
      for (const msg of activityMessages) {
        queueTerminalMessage(msg);
      }
      queueTerminalMessage(stoppedMsg);
      await finishTurn('stopped', chatInterruptionReason(controller.signal));
      return 'started';
    }
    const untypedHostedFailure =
      routeForTurn.kind === 'hosted' && !(err instanceof HostedCodexTurnExecutionError);
    const errorMessage = untypedHostedFailure
      ? HOSTED_UNTYPED_FAILURE_MESSAGE
      : chatTurnErrorMessage(err);
    if (convId) {
      const activityMessages = blocksToMessages(
        await materializeCliToolBlocks(cliTranscript.blocks, turnId),
        turnId
      );
      cliTranscript.clear();
      if (activityMessages.length > 0) {
        setConversationState(set, convId, (prev) => ({
          messages: [...prev.messages, ...activityMessages],
          streamingBlocks: [],
          isStreaming: false,
        }));
        for (const msg of activityMessages) {
          queueTerminalMessage(msg);
        }
      }
      await finishTurn(
        'failed',
        err instanceof HostedCodexTurnExecutionError
          ? `hosted:${err.code}`
          : untypedHostedFailure
            ? 'hosted:turn_failed'
            : errorMessage,
        errorMessage
      );
      setConversationState(set, convId, () => ({
        error: toUserMessage(
          err,
          untypedHostedFailure ? 'assistant.hostedUnavailable' : 'assistant.failed'
        ),
      }));
    } else {
      setNotStartedError(
        toUserMessage(
          err,
          untypedHostedFailure ? 'assistant.hostedUnavailable' : 'assistant.failed'
        )
      );
    }
    return turnLifecycle ? 'started' : 'not_started';
  } finally {
    await cancelPreparedHostedTurn();
    if (convId) {
      if (!controller?.signal.aborted) {
        controller?.abort();
      }
      releaseChatAbortController(convId);
      setConversationState(set, convId, () => ({
        isLoading: false,
        isStreaming: false,
        streamingBlocks: [],
      }));
    } else {
      if (requestedConvId) {
        releaseChatAbortController(requestedConvId);
        setConversationState(set, requestedConvId, () => ({
          isLoading: false,
          isStreaming: false,
          streamingBlocks: [],
        }));
      } else {
        set({ isLoading: false, isStreaming: false, streamingBlocks: [] });
      }
    }
    sendClaim.release();
  }
}
