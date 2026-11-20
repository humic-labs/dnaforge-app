import {
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
  userMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../shared/components/Button';
import { ConnectComputeProviderChip } from '../../compute';
import {
  ChatComposerNestedOptionsMenu,
  type ChatComposerMenuAction,
  ChatComposerPicker,
  DirectApiModelTextInput,
  TURN_PROVIDER_LABELS,
  TURN_TRANSPORT_LABELS,
} from '../../../components/chat/composer-controls';
import { ConnectAiModal } from '../../../components/chat/ConnectAiModal';
import { selectHostedAssistantRouteOptions } from '../hosted-availability';
import { DEFAULT_CLI_REASONING_EFFORTS, useAISettingsStore } from '../settings';
import {
  buildAssistantRouteOptions,
  getActiveAssistantRoute,
  isAssistantRouteConfigured,
  isAssistantRouteUnresolved,
  getAssistantRouteReadiness,
  getAssistantRouteReadinessLabel,
  type AssistantRouteSelection,
} from '../assistant-routes';
import {
  describePendingAssistantRouteFallback,
  isAssistantSendRouteUsable,
  resolveAssistantSendRoute,
} from '../assistant-send-route';
import {
  getCliReasoningEffortOptions,
  getCliPersonalityOptions,
  getCliServiceTierOptions,
  normalizeCliPersonalityForModel,
  normalizeCliReasoningEffortForModel,
  normalizeCliServiceTierForModel,
} from '../cli-host-capabilities';
import { CliModelPicker } from '../CliModelPicker';
import { getDetectedCliDefaultModel, getDetectedCliModels } from '../cli-model-catalog';
import { useAgentCliAuthFlow } from './useAgentCliAuthFlow';
import { getDefaultModel, type ProviderName } from '../providers';
import { getEffectiveHostedRouteReadiness, type AssistantHostId } from '../assistant-hosts';
import type { AgentCliModelReasoningEffort, AgentTransport } from '../../../platform';
import { AssistantRoutePicker } from '../../../components/AssistantRoutePicker';
import { confirmDialog } from '../../../components/confirm-dialog-store';
import { hasDesktopAuthBridge, useAuthStore } from '../../../stores/auth-store';
import { isHostedBrowserRuntime } from '../../../utils/environment';

export interface ChatRouteControlsOptions {
  onConfigureHost?: (hostId: AssistantHostId) => void;
  onOpenAssistantSources?: () => void;
  isOpen?: boolean;
}

export function useChatRouteControls({
  onConfigureHost,
  onOpenAssistantSources,
  isOpen = true,
}: ChatRouteControlsOptions) {
  const providerStatusRefreshRef = useRef<string | null>(null);
  const { state: authState, hydrated: authHydrated, startSignIn } = useAuthStore();
  const authStatus = authState.status;
  const hostedBrowserRuntime = isHostedBrowserRuntime();

  const {
    assistantRoute,
    isConfigured,
    provider,
    model,
    agentTransport,
    providerStatuses,
    providerModels,
    cliModelSettings,
    cliExecutablePathOverrides,
    agentDetection,
    agentDetectError,
    hostedRouteReadiness,
    setAssistantRoute,
    setCliModel,
    setCliReasoningEffort,
    setCliServiceTier,
    setCliPersonality,
    refreshProviderStatuses,
    refreshAgentDetection,
    refreshHostedRouteReadiness,
  } = useAISettingsStore();

  const effectiveHostedRouteReadiness = getEffectiveHostedRouteReadiness(
    hostedRouteReadiness,
    authHydrated,
    authStatus
  );

  const assistantRouteState = useMemo(
    () => ({
      assistantRoute,
      provider,
      model,
      agentTransport,
      providerStatuses,
      providerModels,
      cliModelSettings,
      agentDetection,
      agentDetectError,
      hostedRouteReadiness: effectiveHostedRouteReadiness,
    }),
    [
      agentDetection,
      agentDetectError,
      agentTransport,
      assistantRoute,
      cliModelSettings,
      model,
      provider,
      providerModels,
      providerStatuses,
      effectiveHostedRouteReadiness,
    ]
  );
  const activeRouteUnresolved = isAssistantRouteUnresolved(assistantRouteState);
  const activeAssistantRoute = useMemo(
    () => getActiveAssistantRoute(assistantRouteState),
    [assistantRouteState]
  );
  const activeAssistantRouteConfigured = useMemo(
    () =>
      activeAssistantRoute
        ? isAssistantRouteConfigured(activeAssistantRoute, assistantRouteState)
        : false,
    [activeAssistantRoute, assistantRouteState]
  );
  const activeRouteReadiness = useMemo(
    () =>
      activeAssistantRoute
        ? getAssistantRouteReadiness(activeAssistantRoute, assistantRouteState)
        : 'unavailable',
    [activeAssistantRoute, assistantRouteState]
  );
  const activeRouteChecking =
    activeRouteUnresolved ||
    (activeAssistantRoute?.kind === 'cli' && activeRouteReadiness === 'checking');
  const activeRouteUnavailable =
    (!activeAssistantRoute && !activeRouteUnresolved) || activeRouteReadiness === 'unavailable';
  const activeDirectApiNeedsKey =
    !activeRouteUnresolved &&
    activeAssistantRoute?.kind === 'provider' &&
    !activeAssistantRouteConfigured;
  const activeCliNeedsLogin =
    activeAssistantRoute?.kind === 'cli' && !activeAssistantRouteConfigured && !activeRouteChecking;
  const activeHostedUnavailable =
    activeAssistantRoute?.kind === 'hosted' &&
    !activeRouteChecking &&
    activeRouteReadiness !== 'ready';
  const activeHostedNeedsLogin =
    activeAssistantRoute?.kind === 'hosted' && activeRouteReadiness === 'needs-login';
  const activeHostedReadinessLabel =
    activeAssistantRoute?.kind === 'hosted'
      ? getAssistantRouteReadinessLabel(activeRouteReadiness)
      : null;
  const activeRouteNeedsConfiguration =
    activeRouteUnavailable ||
    activeDirectApiNeedsKey ||
    activeCliNeedsLogin ||
    activeHostedUnavailable;
  const sendRouteResolution = useMemo(
    () => resolveAssistantSendRoute(assistantRouteState),
    [assistantRouteState]
  );
  const activeRouteSendBlocked = !isAssistantSendRouteUsable(sendRouteResolution);
  const activeRouteFallbackNotice =
    sendRouteResolution.status === 'fallback'
      ? describePendingAssistantRouteFallback(sendRouteResolution)
      : null;
  const {
    authenticatingTransport,
    authResult: agentAuthResult,
    authLog: agentAuthLog,
    runAgentAuth,
  } = useAgentCliAuthFlow({ refreshAgentDetection });
  const assistantRouteOptions = useMemo(
    () => buildAssistantRouteOptions(assistantRouteState),
    [assistantRouteState]
  );
  const hostedRouteOptions = useMemo(
    () => selectHostedAssistantRouteOptions(assistantRouteOptions),
    [assistantRouteOptions]
  );
  const [connectAiOpen, setConnectAiOpen] = useState(false);
  const openActiveRouteConfiguration = useCallback(() => {
    if (!activeAssistantRoute) return;
    if (activeAssistantRoute.kind === 'provider' || activeAssistantRoute.kind === 'hosted') {
      setConnectAiOpen(true);
      return;
    }
    if (activeAssistantRoute.kind === 'cli') {
      runAgentAuth(
        activeAssistantRoute.transport,
        activeAssistantRoute.customHarnessId
          ? undefined
          : cliExecutablePathOverrides?.[activeAssistantRoute.transport]
      ).catch((error) => {
        console.error('[useChatRouteControls] Failed to authenticate CLI host:', error);
      });
    }
  }, [activeAssistantRoute, cliExecutablePathOverrides, runAgentAuth]);
  const selectAssistantRoute = useCallback(
    (selection: AssistantRouteSelection) => {
      setAssistantRoute(selection).catch((error) => {
        console.error('[useChatRouteControls] Failed to switch assistant route:', error);
      });
    },
    [setAssistantRoute]
  );
  const requestHostedSignIn = useCallback(
    (selection: AssistantRouteSelection) => {
      void (async () => {
        const readiness = await refreshHostedRouteReadiness?.();
        if (readiness === 'ready') {
          await setAssistantRoute(selection);
          return;
        }
        if (authStatus === 'signed-in') return;
        const confirmed = await confirmDialog({
          title: userMessage('dialog.sign-in-to-use-hosted-ai'),
          message: userMessage('dialog.hosted-ai-requires-a-dnaforge-account-sign-in-to-continue'),
          confirmLabel: userMessage('dialog.sign-in'),
          cancelLabel: userMessage('dialog.not-now'),
          showCloseButton: true,
        });
        if (!confirmed) return;
        await setAssistantRoute(selection);
        await startSignIn();
      })().catch((error) => {
        console.error('[useChatRouteControls] Failed to start DNAForge sign-in:', error);
      });
    },
    [authStatus, refreshHostedRouteReadiness, setAssistantRoute, startSignIn]
  );
  const selectProviderModel = useCallback(
    (nextModel: string) => {
      if (activeAssistantRoute?.kind !== 'provider') return;
      setAssistantRoute({ ...activeAssistantRoute, model: nextModel }).catch((error) => {
        console.error('[useChatRouteControls] Failed to switch Direct API model:', error);
      });
    },
    [activeAssistantRoute, setAssistantRoute]
  );
  const selectCliModel = useCallback(
    (transport: AgentTransport, nextModel: string | null) => {
      const runtimeModels = getDetectedCliModels(agentDetection, transport);
      const effectiveModel = nextModel ?? getDetectedCliDefaultModel(agentDetection, transport);
      const currentEffort = cliModelSettings?.[transport]?.reasoningEffort;
      const currentTier = cliModelSettings?.[transport]?.serviceTier;
      const currentPersonality = cliModelSettings?.[transport]?.personality;
      const nextEffort = normalizeCliReasoningEffortForModel(
        currentEffort,
        effectiveModel,
        runtimeModels,
        DEFAULT_CLI_REASONING_EFFORTS[transport],
        transport
      );
      const nextTier =
        runtimeModels.length > 0
          ? normalizeCliServiceTierForModel(currentTier, effectiveModel, runtimeModels)
          : currentTier;
      const nextPersonality =
        runtimeModels.length > 0
          ? normalizeCliPersonalityForModel(
              currentPersonality,
              transport,
              effectiveModel,
              runtimeModels
            )
          : currentPersonality;
      Promise.all([
        setCliModel(transport, nextModel),
        nextEffort !== currentEffort
          ? setCliReasoningEffort(transport, nextEffort)
          : Promise.resolve(),
        nextTier !== currentTier
          ? setCliServiceTier(transport, nextTier ?? null)
          : Promise.resolve(),
        nextPersonality !== currentPersonality
          ? setCliPersonality(transport, nextPersonality ?? null)
          : Promise.resolve(),
      ]).catch((error) => {
        console.error('[useChatRouteControls] Failed to switch CLI model override:', error);
      });
    },
    [
      agentDetection,
      cliModelSettings,
      setCliModel,
      setCliPersonality,
      setCliReasoningEffort,
      setCliServiceTier,
    ]
  );
  const selectCliReasoningEffort = useCallback(
    (transport: AgentTransport, effort: AgentCliModelReasoningEffort | null) => {
      setCliReasoningEffort(transport, effort).catch((error) => {
        console.error('[useChatRouteControls] Failed to switch CLI reasoning effort:', error);
      });
    },
    [setCliReasoningEffort]
  );
  const selectCliServiceTier = useCallback(
    (transport: AgentTransport, serviceTier: string | null) => {
      setCliServiceTier(transport, serviceTier).catch((error) => {
        console.error('[useChatRouteControls] Failed to switch CLI service tier:', error);
      });
    },
    [setCliServiceTier]
  );
  const selectCliPersonality = useCallback(
    (transport: AgentTransport, personality: string) => {
      setCliPersonality(transport, personality || null).catch((error) => {
        console.error('[useChatRouteControls] Failed to switch CLI personality:', error);
      });
    },
    [setCliPersonality]
  );

  useEffect(() => {
    if (!agentDetection || !cliModelSettings) return;
    if (hostedBrowserRuntime) return;
    const transports: AgentTransport[] = ['codex-sdk', 'claude-agent-sdk', 'grok-acp'];
    for (const transport of transports) {
      const settings = cliModelSettings[transport] ?? {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        personality: null,
      };
      const models = getDetectedCliModels(agentDetection, transport);
      const selectedModel = settings.model ?? getDetectedCliDefaultModel(agentDetection, transport);
      const normalized = normalizeCliReasoningEffortForModel(
        settings.reasoningEffort,
        selectedModel,
        models,
        DEFAULT_CLI_REASONING_EFFORTS[transport],
        transport
      );
      if (normalized !== settings.reasoningEffort) {
        void setCliReasoningEffort(transport, normalized).catch((error) => {
          console.error('[useChatRouteControls] Failed to normalize CLI reasoning effort:', error);
        });
      }
      if (models.length > 0) {
        const normalizedTier = normalizeCliServiceTierForModel(
          settings.serviceTier,
          selectedModel,
          models
        );
        if (normalizedTier !== settings.serviceTier) {
          void setCliServiceTier(transport, normalizedTier).catch((error) => {
            console.error('[useChatRouteControls] Failed to normalize CLI service tier:', error);
          });
        }
        const normalizedPersonality = normalizeCliPersonalityForModel(
          settings.personality,
          transport,
          selectedModel,
          models
        );
        if (normalizedPersonality !== settings.personality) {
          void setCliPersonality(transport, normalizedPersonality).catch((error) => {
            console.error('[useChatRouteControls] Failed to normalize CLI personality:', error);
          });
        }
      }
    }
  }, [
    agentDetection,
    cliModelSettings,
    hostedBrowserRuntime,
    setCliPersonality,
    setCliReasoningEffort,
    setCliServiceTier,
  ]);

  useEffect(() => {
    if (!isOpen || activeAssistantRoute?.kind !== 'provider') return;
    if (providerStatuses[activeAssistantRoute.provider]?.isConfigured) return;
    const refreshKey = activeAssistantRoute.provider;
    if (providerStatusRefreshRef.current === refreshKey) return;
    providerStatusRefreshRef.current = refreshKey;
    refreshProviderStatuses().catch((error) => {
      console.error('[useChatRouteControls] Failed to refresh provider statuses:', error);
    });
  }, [activeAssistantRoute, isOpen, providerStatuses, refreshProviderStatuses]);

  useEffect(() => {
    if (!isOpen || hostedBrowserRuntime) return;
    void refreshAgentDetection?.();
  }, [hostedBrowserRuntime, isOpen, refreshAgentDetection]);

  useEffect(() => {
    if (!authHydrated && hasDesktopAuthBridge()) return;
    void refreshHostedRouteReadiness?.();
  }, [authHydrated, authStatus, isOpen, refreshHostedRouteReadiness]);

  const renderAssistantRouteSelector = () => {
    if (!activeAssistantRoute || assistantRouteOptions.length === 0) return null;

    return (
      <AssistantRoutePicker
        activeRoute={activeAssistantRoute}
        options={assistantRouteOptions}
        isConfigured={isConfigured}
        onSelect={selectAssistantRoute}
        onHostedSignInRequired={requestHostedSignIn}
        onManageSources={
          hostedBrowserRuntime
            ? () => setConnectAiOpen(true)
            : (onOpenAssistantSources ?? (() => undefined))
        }
        onConfigureHost={hostedBrowserRuntime ? () => setConnectAiOpen(true) : onConfigureHost}
        buttonTestId="model-selector-button"
        menuTestId="chat-assistant-route-menu"
        optionTestIdPrefix="chat-assistant-route-option"
      />
    );
  };

  const renderDirectApiModelControl = (providerName: ProviderName) => {
    const providerLabel = TURN_PROVIDER_LABELS[providerName] ?? providerName;
    const status = providerStatuses[providerName];
    const modelState = providerModels[providerName];
    const configured = !!status?.isConfigured;
    const fetchStatus =
      modelState?.fetchStatus ?? (modelState?.models?.length ? 'success' : 'idle');
    const currentModel =
      activeAssistantRoute?.kind === 'provider' && activeAssistantRoute.provider === providerName
        ? activeAssistantRoute.model
        : getDefaultModel(providerName);
    const modelOptions = Array.from(new Set([currentModel, ...(modelState?.models ?? [])])).filter(
      Boolean
    );

    if (!configured) {
      return (
        <Button
          variant="ghost"
          size="xs"
          disabled
          title={`${providerLabel} needs an API key before model selection is available`}
          data-testid="chat-model-version-disabled"
        >
          Model needs key
        </Button>
      );
    }

    if (fetchStatus === 'loading') {
      return (
        <Button
          variant="ghost"
          size="xs"
          disabled
          title={`Loading ${providerLabel} models`}
          data-testid="chat-model-version-loading"
        >
          Loading models
        </Button>
      );
    }

    if (fetchStatus === 'success' && modelOptions.length > 0) {
      return (
        <ChatComposerPicker
          value={currentModel}
          onChange={selectProviderModel}
          ariaLabel={`${providerLabel} model`}
          title={`${providerLabel} model: ${currentModel}`}
          testId="chat-model-version-select"
          width="standard"
          options={modelOptions.map((modelOption) => ({
            value: modelOption,
            label: modelOption,
          }))}
        />
      );
    }

    return (
      <DirectApiModelTextInput
        model={currentModel}
        defaultModel={getDefaultModel(providerName)}
        title={
          fetchStatus === 'error'
            ? `${providerLabel} model fallback; model discovery failed: ${modelState?.fetchError ?? 'Unknown error'}`
            : `${providerLabel} model`
        }
        onCommit={selectProviderModel}
      />
    );
  };

  const renderCliModelControls = (
    transport: AgentTransport,
    beforeOptionsMenu?: ReactNode,
    menuActions: ChatComposerMenuAction[] = []
  ) => {
    const settings = cliModelSettings?.[transport] ?? {
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      personality: null,
    };
    const defaultModel = getDetectedCliDefaultModel(agentDetection, transport);
    const runtimeModels = getDetectedCliModels(agentDetection, transport);
    const modelCatalog =
      transport === 'codex-sdk'
        ? agentDetection?.codex?.modelCatalog
        : transport === 'grok-acp'
          ? agentDetection?.grok?.modelCatalog
          : agentDetection?.claudeCode?.modelCatalog;
    const modelCatalogFailed =
      modelCatalog?.status !== 'complete' ||
      modelCatalog.observedModelCount < 1 ||
      modelCatalog.observedModelCount !== runtimeModels.length;
    if (modelCatalogFailed) {
      return (
        <div
          className="flex min-w-0 max-w-full flex-wrap items-center gap-1"
          data-testid="chat-cli-model-controls"
          title={
            modelCatalog?.error != null
              ? toUserMessage(modelCatalog?.error, 'assistant.failed')
              : userMessageWithValues('notice.value-model-discovery-failed', {
                  value0: userMessageValue(TURN_TRANSPORT_LABELS[transport]),
                })
          }
        >
          <Button
            variant="ghost"
            size="xs"
            className="text-danger"
            aria-label={`Retry ${TURN_TRANSPORT_LABELS[transport]} model discovery`}
            data-testid="chat-cli-model-discovery-error"
            onClick={() => {
              void refreshAgentDetection().catch((error) => {
                console.error('[useChatRouteControls] Failed to retry CLI model discovery:', error);
              });
            }}
          >
            Models unavailable · Retry
          </Button>
          {beforeOptionsMenu}
          <ChatComposerNestedOptionsMenu
            ariaLabel={`More ${TURN_TRANSPORT_LABELS[transport]} options`}
            testId="chat-cli-secondary-options"
            groups={[]}
            actions={menuActions}
          />
        </div>
      );
    }
    const selectedModel = settings.model ?? defaultModel;
    const effortOptions = getCliReasoningEffortOptions(transport, selectedModel, runtimeModels);
    const selectedEffort = normalizeCliReasoningEffortForModel(
      settings.reasoningEffort,
      selectedModel,
      runtimeModels,
      DEFAULT_CLI_REASONING_EFFORTS[transport],
      transport
    );
    const serviceTierOptions = getCliServiceTierOptions(selectedModel, runtimeModels);
    const selectedServiceTier = normalizeCliServiceTierForModel(
      settings.serviceTier,
      selectedModel,
      runtimeModels
    );
    const personalityOptions = getCliPersonalityOptions(transport, selectedModel, runtimeModels);
    const selectedPersonality = normalizeCliPersonalityForModel(
      settings.personality,
      transport,
      selectedModel,
      runtimeModels
    );

    return (
      <div
        className="flex min-w-0 max-w-full flex-wrap items-center gap-1"
        data-testid="chat-cli-model-controls"
        title={`${TURN_TRANSPORT_LABELS[transport]} model and effort controls`}
      >
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
          <CliModelPicker
            transport={transport}
            model={settings.model}
            onModelChange={selectCliModel}
            onRefreshModels={async () => {
              await refreshAgentDetection();
            }}
            selectTestId="chat-cli-model-select"
            customInputTestId="chat-cli-model-custom-input"
            defaultModel={defaultModel}
            codexAuthMode={
              transport === 'codex-sdk' ? (agentDetection?.codex.authMode ?? null) : undefined
            }
            availableModels={runtimeModels}
            customInputPlacement="replace-select"
            ariaLabel={`${TURN_TRANSPORT_LABELS[transport]} model`}
          />
          {selectedEffort && effortOptions.length > 0 && (
            <ChatComposerPicker
              value={selectedEffort}
              onChange={(nextEffort) => {
                selectCliReasoningEffort(transport, nextEffort as AgentCliModelReasoningEffort);
              }}
              ariaLabel={`${TURN_TRANSPORT_LABELS[transport]} reasoning effort`}
              title={`${TURN_TRANSPORT_LABELS[transport]} reasoning effort: ${selectedEffort}`}
              testId="chat-cli-effort-select"
              width="compact"
              options={effortOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
            />
          )}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
          {beforeOptionsMenu}
          <ChatComposerNestedOptionsMenu
            ariaLabel={`More ${TURN_TRANSPORT_LABELS[transport]} model options`}
            testId="chat-cli-secondary-options"
            actions={menuActions}
            groups={[
              ...(serviceTierOptions.length > 0
                ? [
                    {
                      id: 'speed',
                      label: 'Speed',
                      value: selectedServiceTier ?? '',
                      options: serviceTierOptions.map((option) => ({
                        value: option.value,
                        label: option.label,
                        ...(option.description ? { title: option.description } : {}),
                      })),
                      onChange: (nextTier: string) =>
                        selectCliServiceTier(transport, nextTier || null),
                      optionTestId: 'chat-cli-service-tier-select',
                    },
                  ]
                : []),
              ...(personalityOptions.length > 0
                ? [
                    {
                      id: 'style',
                      label: 'Style',
                      value: selectedPersonality ?? '',
                      options: personalityOptions.map((option) => ({
                        value: option.value,
                        label: option.label,
                      })),
                      onChange: (nextPersonality: string) =>
                        selectCliPersonality(transport, nextPersonality),
                      optionTestId: 'chat-cli-personality-select',
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>
    );
  };

  const renderModelControls = (
    beforeOptionsMenu?: ReactNode,
    menuActions: ChatComposerMenuAction[] = []
  ) => {
    if (!activeAssistantRoute) return null;
    if (activeAssistantRoute.kind === 'provider') {
      return (
        <div
          className="flex min-w-0 max-w-full flex-wrap items-center"
          data-testid="chat-model-controls"
        >
          {renderDirectApiModelControl(activeAssistantRoute.provider)}
          {beforeOptionsMenu}
        </div>
      );
    }

    if (activeAssistantRoute.kind === 'cli') {
      return renderCliModelControls(activeAssistantRoute.transport, beforeOptionsMenu, menuActions);
    }

    return beforeOptionsMenu ?? null;
  };

  const renderRouteConfigurationPrompt = () => {
    if (!activeRouteNeedsConfiguration) return null;
    const isCli = activeAssistantRoute?.kind === 'cli';
    const isHosted = activeAssistantRoute?.kind === 'hosted';
    const cliAuthenticating =
      activeAssistantRoute?.kind === 'cli' &&
      authenticatingTransport === activeAssistantRoute.transport;
    const cliAuthResult =
      activeAssistantRoute?.kind === 'cli' &&
      agentAuthResult?.transport === activeAssistantRoute.transport
        ? agentAuthResult
        : null;
    const cliAuthLog =
      activeAssistantRoute?.kind === 'cli' ? agentAuthLog[activeAssistantRoute.transport] : [];
    const latestCliAuthLog = cliAuthLog[cliAuthLog.length - 1];
    const cliAuthFailed = !!cliAuthResult && !cliAuthResult.ok;

    return (
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={openActiveRouteConfiguration}
          disabled={cliAuthenticating || activeRouteUnavailable}
          className="inline-flex h-7 items-center rounded-md bg-warning/10 px-2 text-[11px] font-medium text-warning transition-colors hover:bg-warning/15 disabled:cursor-not-allowed disabled:opacity-60"
          title={
            isCli
              ? 'Authenticate this CLI host before sending'
              : isHosted
                ? `${activeHostedReadinessLabel ?? 'DNAForge AI is unavailable'}. Choose another route.`
                : activeRouteUnavailable
                  ? 'No AI routes are available in this build'
                  : 'Add a Direct API key here before sending'
          }
          aria-label={
            isCli
              ? 'Authenticate CLI host'
              : isHosted
                ? 'Choose another AI route'
                : activeRouteUnavailable
                  ? 'No AI routes available'
                  : 'Add a Direct API key here'
          }
          data-testid={
            isCli
              ? 'chat-cli-login-warning'
              : isHosted
                ? 'chat-hosted-unavailable-warning'
                : activeRouteUnavailable
                  ? 'chat-route-unavailable-warning'
                  : 'chat-direct-api-key-warning'
          }
        >
          {isCli
            ? cliAuthenticating
              ? 'Authenticating...'
              : 'Authenticate'
            : isHosted
              ? (activeHostedReadinessLabel ?? 'Choose AI route')
              : activeRouteUnavailable
                ? 'No AI route'
                : 'Add API key'}
        </button>
        {isCli && (cliAuthenticating || cliAuthFailed) && (
          <span
            className={`hidden max-w-[11rem] truncate text-[11px] leading-7 sm:inline ${
              cliAuthFailed ? 'text-error' : 'text-fg-subtle'
            }`}
            title={
              cliAuthFailed
                ? cliAuthResult.error != null
                  ? toUserMessage(cliAuthResult.error, 'failure.cli-authentication-failed')
                  : userMessage('notice.cli-authentication-failed')
                : toUserMessage(latestCliAuthLog, 'failure.cli-authentication-failed')
            }
            data-testid="chat-cli-auth-status"
          >
            {cliAuthFailed ? 'Sign-in failed' : (latestCliAuthLog ?? 'Launching sign-in...')}
          </span>
        )}
      </div>
    );
  };

  const renderComputeConnectPrompt = () => <ConnectComputeProviderChip />;

  const renderRouteCheckingStatus = () => {
    if (!activeRouteChecking) return null;
    return (
      <span
        className="inline-flex h-7 items-center rounded-md bg-bg-muted px-2 text-[11px] font-medium text-fg-subtle"
        title={
          activeRouteUnresolved
            ? 'Checking available AI routes before choosing one'
            : 'Checking whether this CLI host is ready before sending'
        }
        data-testid="chat-route-checking-status"
      >
        {activeRouteUnresolved ? 'Choosing AI route…' : 'Checking CLI…'}
      </span>
    );
  };

  const renderConnectAiModal = () => (
    <ConnectAiModal
      open={connectAiOpen}
      onClose={() => setConnectAiOpen(false)}
      hostedRouteOptions={hostedRouteOptions}
      hostedBrowserOnly={hostedBrowserRuntime}
    />
  );

  return {
    activeAssistantRoute,
    activeRouteNeedsConfiguration,
    activeRouteSendBlocked,
    activeRouteFallbackNotice,
    activeRouteUnavailable,
    activeDirectApiNeedsKey,
    activeCliNeedsLogin,
    activeHostedNeedsLogin,
    activeHostedUnavailable,
    activeRouteChecking,
    renderAssistantRouteSelector,
    renderModelControls,
    renderRouteConfigurationPrompt,
    renderRouteCheckingStatus,
    renderComputeConnectPrompt,
    renderConnectAiModal,
  };
}
