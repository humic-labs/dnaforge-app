import {
  type UserMessage,
  userMessageWithValues,
  userMessageValue,
  toUserMessage,
  userMessage,
} from '@waypoint/user-messages';
import { AISettingsBoundary } from '../ai/public/AISettingsBoundary';
import { AgentPresentationSettings } from './AgentPresentationSettings';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AGENT_TRANSPORT_LABELS } from '../ai/public/agent-cli-labels';
import {
  buildAssistantRouteOptions,
  DEFAULT_CLI_PERMISSION_MODE,
  getActiveAssistantRoute,
  getAssistantRouteReadinessLabel,
  shortenModelName,
} from '../ai/public/assistant-routes';
import {
  getCliAssistantHostDescriptors,
  getDirectApiHostDescriptor,
  getEffectiveHostedRouteReadiness,
  type AssistantHostId,
} from '../ai/public/assistant-hosts';
import { CliModelPicker } from '../ai/public/CliModelPicker';
import {
  getCliReasoningEffortOptions,
  getCliPersonalityOptions,
  getCliServiceTierOptions,
  normalizeCliPersonalityForModel,
  normalizeCliReasoningEffortForModel,
  normalizeCliServiceTierForModel,
} from '../ai/public/cli-host-capabilities';
import { getDetectedCliDefaultModel, getDetectedCliModels } from '../ai/public/cli-model-catalog';
import { CliInstallInstructions } from '../ai/public/CliInstallInstructions';
import { getAllProviderMetas } from '../ai/public/providers';
import {
  DEFAULT_CLI_REASONING_EFFORTS,
  MAX_ADDITIONAL_AGENT_INSTRUCTIONS_LENGTH,
  useAISettingsStore,
  type CustomCliHarnessDefinition,
} from '../ai/public/settings';
import { useAgentCliAuthFlow } from '../ai/public/hooks/useAgentCliAuthFlow';
import { useAuthStore } from '../../stores/auth-store';
import {
  platform,
  type AgentCliModelCapabilityShape,
  type AgentScheduleRecordShape,
  type AgentCliModelReasoningEffort,
  type AgentAuthResultShape,
  type AgentAuthStatus,
  type AgentSdkDetectionShape,
  type AgentTransport,
} from '../../platform';
import {
  AGENT_GRANT_SCOPE_OPTIONS,
  DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES,
  createApiKeyAgentGrant,
  getAgentGrantStoreSnapshot,
  getInitialAgentGrantStoreSnapshot,
  revokeAgentGrant,
  type AgentGrant,
  type AgentGrantKind,
  type AgentGrantStoreSnapshot,
} from '../agent-grants/public/store';
import {
  CheckIcon,
  ChevronRotatableIcon,
  CopyIcon,
  PlusIcon,
  TrashIcon,
} from '../../components/icons/glyphs';
import { AgentExtensionsPanel } from './AgentExtensionsPanel';
import { DefaultRouteButton } from './DefaultRouteButton';
import { DnaforgeAgentHostRow } from './DnaforgeAgentHostRow';
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_FORM_GRID_CLASS,
  SETTINGS_FORM_LONE_FIELD_SPAN_CLASS,
  SETTINGS_FORM_WIDTH_CLASS,
  SETTINGS_DANGER_BUTTON_CLASS,
  SETTINGS_PRIMARY_BUTTON_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SETTINGS_SPLIT_PANEL_CLASS,
  SETTINGS_SPLIT_PANEL_EDITOR_CLASS,
  SETTINGS_SPLIT_PANEL_LIST_CLASS,
  SETTINGS_SURFACE_CLASS,
  SETTINGS_TEXTAREA_CLASS,
  settingsSplitPanelTabClass,
  SettingsSelect,
} from '../../components/SettingsSubsection';
import {
  AGENT_PERMISSION_PICKERS,
  parseAgentPermissions,
  permissionFamilyForTransport,
  resolveAgentPermissions,
  type AgentPermissionCatalog,
  type AgentPermissions,
} from '../../shared/agent-permissions';
import { AlwaysAllowList } from './AlwaysAllowList';

export type AgentIntegrationsPanelProps = Record<string, never>;
export interface AssistantHostSettingsContentProps {
  focusHostId?: AssistantHostId | null;
  directApiSettings?: (isHostActive: boolean) => ReactNode;
}

type SelectedAssistantHost = string;

function isAgentTransport(value: string): value is AgentTransport {
  return value === 'codex-sdk' || value === 'claude-agent-sdk' || value === 'grok-acp';
}

const SHOW_AGENT_DEV_GRANTS = import.meta.env.VITE_SHOW_AGENT_DEV_GRANTS === 'true';

const AGENT_GRANT_KIND_LABELS: Record<AgentGrantKind, string> = {
  'in-app': 'App assistant',
  'stdio-mcp': 'Local MCP client',
  'http-api-key': 'External access key',
};

const AGENT_GRANT_SCOPE_LABELS = new Map(
  AGENT_GRANT_SCOPE_OPTIONS.map((scope) => [scope.value, scope.label])
);

function getAgentTransportDetection(
  detection: AgentSdkDetectionShape | null,
  transport: AgentTransport
) {
  if (!detection) return null;
  if (transport === 'codex-sdk') return detection.codex;
  if (transport === 'grok-acp') return detection.grok;
  return detection.claudeCode;
}

function AgentCliModelControls({
  transport,
  model,
  reasoningEffort,
  serviceTier,
  personality,
  defaultModel,
  availableModels,
  codexAuthMode,
  onModelChange,
  onReasoningEffortChange,
  onServiceTierChange,
  onPersonalityChange,
}: {
  transport: AgentTransport;
  model: string | null;
  reasoningEffort: AgentCliModelReasoningEffort | null;
  serviceTier?: string | null;
  personality?: string | null;
  defaultModel: string | null;
  availableModels?: readonly AgentCliModelCapabilityShape[];
  codexAuthMode?: 'chatgpt' | 'apikey' | null;
  onModelChange: (transport: AgentTransport, model: string | null) => Promise<void>;
  onReasoningEffortChange: (
    transport: AgentTransport,
    effort: AgentCliModelReasoningEffort | null
  ) => Promise<void>;
  onServiceTierChange: (transport: AgentTransport, serviceTier: string | null) => Promise<void>;
  onPersonalityChange: (transport: AgentTransport, personality: string | null) => Promise<void>;
}) {
  const selectedModel = model ?? defaultModel;
  const effortOptions = getCliReasoningEffortOptions(transport, selectedModel, availableModels);
  const selectedEffort = normalizeCliReasoningEffortForModel(
    reasoningEffort,
    selectedModel,
    availableModels ?? [],
    DEFAULT_CLI_REASONING_EFFORTS[transport],
    transport
  );
  const serviceTierOptions = getCliServiceTierOptions(selectedModel, availableModels ?? []);
  const selectedServiceTier = normalizeCliServiceTierForModel(
    serviceTier,
    selectedModel,
    availableModels ?? []
  );
  const personalityOptions = getCliPersonalityOptions(
    transport,
    selectedModel,
    availableModels ?? []
  );
  const selectedPersonality = normalizeCliPersonalityForModel(
    personality,
    transport,
    selectedModel,
    availableModels ?? []
  );
  useEffect(() => {
    if (selectedEffort === reasoningEffort) return;
    void onReasoningEffortChange(transport, selectedEffort).catch((error) => {
      console.error('[AgentIntegrationsPanel] Failed to normalize CLI effort:', error);
    });
  }, [onReasoningEffortChange, reasoningEffort, selectedEffort, transport]);

  useEffect(() => {
    if (!availableModels?.length) return;
    if (selectedServiceTier === serviceTier) return;
    void onServiceTierChange(transport, selectedServiceTier).catch((error) => {
      console.error('[AgentIntegrationsPanel] Failed to normalize CLI service tier:', error);
    });
  }, [availableModels, onServiceTierChange, selectedServiceTier, serviceTier, transport]);

  useEffect(() => {
    if (!availableModels?.length) return;
    if (selectedPersonality === personality) return;
    void onPersonalityChange(transport, selectedPersonality).catch((error) => {
      console.error('[AgentIntegrationsPanel] Failed to normalize CLI personality:', error);
    });
  }, [availableModels, onPersonalityChange, personality, selectedPersonality, transport]);

  const saveModel = useCallback(
    (nextTransport: AgentTransport, nextModel: string | null) => {
      onModelChange(nextTransport, nextModel).catch((error) => {
        console.error('[AgentIntegrationsPanel] Failed to save CLI model:', error);
      });
    },
    [onModelChange]
  );

  const saveReasoningEffort = useCallback(
    (next: AgentCliModelReasoningEffort) => {
      onReasoningEffortChange(transport, next).catch((error) => {
        console.error('[AgentIntegrationsPanel] Failed to save CLI effort:', error);
      });
    },
    [onReasoningEffortChange, transport]
  );

  return (
    <section
      aria-label={`${AGENT_TRANSPORT_LABELS[transport]} model settings`}
      className={`contents ${SETTINGS_FORM_LONE_FIELD_SPAN_CLASS}`}
      data-testid={`agent-cli-model-settings-${transport}`}
    >
      <div className="grid min-w-0 gap-1.5" data-testid={`agent-cli-setting-${transport}-model`}>
        <span className="text-xs font-medium text-fg-muted">Model</span>
        <CliModelPicker
          transport={transport}
          model={model}
          onModelChange={saveModel}
          selectTestId={`agent-cli-model-${transport}`}
          customInputTestId={`agent-cli-model-custom-${transport}`}
          defaultModel={defaultModel}
          codexAuthMode={codexAuthMode}
          availableModels={availableModels}
          containerClassName="min-w-0"
          customInputPlacement="replace-select"
          ariaLabel={`${AGENT_TRANSPORT_LABELS[transport]} default model`}
          appearance="settings"
        />
      </div>
      {selectedEffort && effortOptions.length > 0 && (
        <label
          className="grid min-w-0 gap-1.5"
          data-testid={`agent-cli-setting-${transport}-effort`}
        >
          <span className="text-xs font-medium text-fg-muted">Effort</span>
          <SettingsSelect
            value={selectedEffort}
            onValueChange={(next) => saveReasoningEffort(next as AgentCliModelReasoningEffort)}
            testId={`agent-cli-effort-${transport}`}
            ariaLabel={`${AGENT_TRANSPORT_LABELS[transport]} effort`}
            options={effortOptions}
          />
        </label>
      )}
      {serviceTierOptions.length > 0 && (
        <label
          className="grid min-w-0 gap-1.5"
          data-testid={`agent-cli-setting-${transport}-speed`}
        >
          <span className="text-xs font-medium text-fg-muted">Speed</span>
          <SettingsSelect
            value={selectedServiceTier ?? ''}
            onValueChange={(next) => {
              onServiceTierChange(transport, next || null).catch((error) => {
                console.error('[AgentIntegrationsPanel] Failed to save CLI service tier:', error);
              });
            }}
            testId={`agent-cli-service-tier-${transport}`}
            ariaLabel={`${AGENT_TRANSPORT_LABELS[transport]} speed`}
            options={serviceTierOptions.map((option) => ({
              value: option.value,
              label: option.value ? option.label : 'Standard',
            }))}
          />
        </label>
      )}
      {personalityOptions.length > 0 && (
        <label
          className="grid min-w-0 gap-1.5"
          data-testid={`agent-cli-setting-${transport}-style`}
        >
          <span className="text-xs font-medium text-fg-muted">Style</span>
          <SettingsSelect
            value={selectedPersonality ?? ''}
            onValueChange={(next) => {
              onPersonalityChange(transport, next || null).catch((error) => {
                console.error('[AgentIntegrationsPanel] Failed to save CLI personality:', error);
              });
            }}
            testId={`agent-cli-personality-${transport}`}
            ariaLabel={`${AGENT_TRANSPORT_LABELS[transport]} style`}
            options={personalityOptions.map((option) => ({
              value: option.value,
              label: option.value ? option.label : 'Provider default',
            }))}
          />
        </label>
      )}
    </section>
  );
}

function getAgentAuthLabel(status: AgentAuthStatus | 'loading'): string {
  if (status === 'authenticated') return 'Ready';
  if (status === 'unauthenticated') return 'Not signed in';
  if (status === 'loading') return 'Checking';
  return 'Detected';
}

function formatExternalGrantCount(count: number): string {
  return `${count} external ${count === 1 ? 'caller' : 'callers'}`;
}

function getAgentGrantScopeLabel(scope: string): UserMessage {
  if (scope === '*') return userMessage('permissions.allScopes');
  return AGENT_GRANT_SCOPE_LABELS.get(scope) ?? userMessage('permissions.additional');
}

function getAgentGrantDisplayLabel(grant: AgentGrant): string {
  return grant.kind === 'in-app' ? 'DNAForge chat' : grant.label;
}

function formatLastUsed(lastUsedAt: string | null): string {
  return formatAgentGrantDate(lastUsedAt, 'Never');
}

function formatExpiresAt(expiresAt: string | null): string {
  return formatAgentGrantDate(expiresAt, 'No expiry');
}

function formatScopeSummary(scopes: readonly string[]): string {
  if (scopes.includes('*')) return 'All scopes';
  const count = scopes.length;
  return `${count} ${count === 1 ? 'scope' : 'scopes'}`;
}

function formatCallStatus(status: string): string {
  return status
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function formatAgentGrantDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatScheduleTiming(schedule: AgentScheduleRecordShape): string {
  if (schedule.scheduledFor !== null) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(schedule.scheduledFor));
  }
  return schedule.humanSchedule;
}

export function ScheduledAgentTasks() {
  const [schedules, setSchedules] = useState<AgentScheduleRecordShape[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSchedules(await platform().agentSession.listSchedules());
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.could-not-load-scheduled-tasks'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cancel = useCallback(
    async (schedule: AgentScheduleRecordShape) => {
      setCancellingId(schedule.id);
      setError(null);
      try {
        const result = await platform().agentSession.cancelSchedule(schedule.id);
        if (!result.ok) throw new Error(result.error ?? 'Claude did not cancel the task.');
        await refresh();
      } catch (cause) {
        setError(toUserMessage(cause, 'failure.could-not-cancel-the-scheduled-task'));
      } finally {
        setCancellingId(null);
      }
    },
    [refresh]
  );

  if (loading || schedules.length === 0) return null;

  return (
    <section
      aria-labelledby="scheduled-agent-tasks-heading"
      data-testid="scheduled-agent-tasks"
      className="pt-1"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 id="scheduled-agent-tasks-heading" className="text-sm font-medium text-fg">
            Scheduled tasks
          </h4>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className={`${SETTINGS_SECONDARY_BUTTON_CLASS} px-2 py-1 text-[11px]`}
        >
          Refresh
        </button>
      </div>
      <ul className="mt-2 space-y-2">
        {schedules.map((schedule) => (
          <li
            key={schedule.id}
            data-testid={`scheduled-agent-task-${schedule.id}`}
            className={`flex items-start justify-between gap-3 rounded-md px-3 py-3 ${SETTINGS_SURFACE_CLASS}`}
          >
            <div className="min-w-0">
              <p className="text-xs font-medium text-fg">{formatScheduleTiming(schedule)}</p>
              <p className="mt-0.5 break-words text-[11px] leading-4 text-fg-muted">
                {schedule.prompt || 'Continue the native Claude session.'}
              </p>
              <p className="mt-1 text-[10px] text-fg-subtle">
                {schedule.recurring ? 'Recurring' : 'One time'}
                {schedule.durable ? ' · survives restarts' : ''}
              </p>
            </div>
            <button
              type="button"
              disabled={cancellingId === schedule.id || schedule.status === 'cancelling'}
              onClick={() => void cancel(schedule)}
              className={`${SETTINGS_DANGER_BUTTON_CLASS} px-2 py-1 text-[11px]`}
            >
              {cancellingId === schedule.id || schedule.status === 'cancelling'
                ? 'Cancelling…'
                : 'Cancel'}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-[11px] leading-4 text-error">
          {toUserMessage(error, 'assistant.failed')}
        </p>
      )}
    </section>
  );
}

function StandardCliExecutablePathControl({
  transport,
  detectedPath,
  override,
  onRecheck,
  onChange,
}: {
  transport: AgentTransport;
  detectedPath: string | null;
  override?: string;
  onRecheck: () => Promise<unknown> | void;
  onChange: (transport: AgentTransport, executablePath: string | null) => Promise<void>;
}) {
  const effectivePath = override ?? detectedPath ?? '';
  const [draft, setDraft] = useState(effectivePath);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.trim() !== effectivePath;
  const valid = looksLikeAbsoluteExecutablePath(draft);
  const label = AGENT_TRANSPORT_LABELS[transport];

  useEffect(() => {
    setDraft(effectivePath);
  }, [effectivePath]);

  const save = async (path: string) => {
    const normalized = path.trim();
    if (!looksLikeAbsoluteExecutablePath(normalized)) {
      setError(userMessage('failure.choose-an-absolute-executable-path'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onChange(transport, normalized);
    } catch (reason) {
      setError(toUserMessage(reason, 'assistant.failed'));
    } finally {
      setSaving(false);
    }
  };

  const chooseExecutable = async () => {
    const selected = await platform().dialog.open({ title: `Choose ${label} executable` });
    if (typeof selected !== 'string') return;
    setDraft(selected);
    await save(selected);
  };

  const reset = async () => {
    setSaving(true);
    setError(null);
    try {
      await onChange(transport, null);
    } catch (reason) {
      setError(toUserMessage(reason, 'assistant.failed'));
    } finally {
      setSaving(false);
    }
  };

  const findAutomatically = async () => {
    setSearching(true);
    setError(null);
    try {
      await onRecheck();
    } catch (reason) {
      setError(toUserMessage(reason, 'assistant.failed'));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="min-w-0 sm:col-span-2" data-testid={`agent-cli-executable-${transport}`}>
      <label
        htmlFor={`agent-cli-executable-path-${transport}`}
        className="mb-1 block text-xs font-medium text-fg"
      >
        Executable
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          id={`agent-cli-executable-path-${transport}`}
          aria-label={`${label} executable path`}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && dirty && valid && !saving && !searching) void save(draft);
          }}
          placeholder="No executable detected"
          className={`${SETTINGS_FIELD_CLASS} min-w-[12rem] flex-1 font-mono text-xs`}
        />
        {dirty ? (
          <button
            type="button"
            disabled={!valid || saving || searching}
            onClick={() => void save(draft)}
            className={SETTINGS_PRIMARY_BUTTON_CLASS}
          >
            {saving ? 'Saving…' : 'Apply'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={saving || searching}
          onClick={() => void findAutomatically()}
          className={SETTINGS_SECONDARY_BUTTON_CLASS}
          data-testid={`agent-cli-executable-find-${transport}`}
        >
          {searching ? 'Searching…' : 'Find automatically'}
        </button>
        <button
          type="button"
          disabled={saving || searching}
          onClick={() => void chooseExecutable()}
          className={SETTINGS_SECONDARY_BUTTON_CLASS}
        >
          Choose…
        </button>
        {override ? (
          <button
            type="button"
            disabled={saving || searching}
            onClick={() => void reset()}
            className={SETTINGS_SECONDARY_BUTTON_CLASS}
          >
            Reset to default
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {toUserMessage(error, 'assistant.failed')}
        </p>
      ) : null}
    </div>
  );
}

function AgentCliSignInRow({
  title,
  transport,
  detection,
  isActive,
  authenticating,
  authResult,
  authLog,
  onSignIn,
  onUse,
  onRecheck,
  installOS,
  modelSettings,
  onModelChange,
  onReasoningEffortChange,
  onServiceTierChange,
  onPersonalityChange,
  permissionCatalog,
  permissions,
  onPermissionsChange,
  binaryPathOverride,
  onExecutablePathChange,
}: {
  title: string;
  transport: AgentTransport;
  detection: AgentSdkDetectionShape | null;
  isActive: boolean;
  authenticating: boolean;
  authResult: AgentAuthResultShape | null;
  authLog: readonly string[];
  onSignIn: (transport: AgentTransport, binaryPathOverride?: string) => void;
  onUse: (transport: AgentTransport) => void;
  onRecheck: () => Promise<unknown> | void;
  installOS: string;
  modelSettings: {
    model: string | null;
    reasoningEffort: AgentCliModelReasoningEffort | null;
    serviceTier?: string | null;
    personality?: string | null;
  };
  onModelChange: (transport: AgentTransport, model: string | null) => Promise<void>;
  onReasoningEffortChange: (
    transport: AgentTransport,
    effort: AgentCliModelReasoningEffort | null
  ) => Promise<void>;
  onServiceTierChange: (transport: AgentTransport, serviceTier: string | null) => Promise<void>;
  onPersonalityChange: (transport: AgentTransport, personality: string | null) => Promise<void>;
  permissionCatalog: AgentPermissionCatalog | null;
  permissions: AgentPermissions;
  onPermissionsChange: (permissions: AgentPermissions) => Promise<void>;
  binaryPathOverride?: string;
  onExecutablePathChange: (
    transport: AgentTransport,
    executablePath: string | null
  ) => Promise<void>;
}) {
  const transportDetection = getAgentTransportDetection(detection, transport);
  const status: AgentAuthStatus | 'loading' = transportDetection
    ? transportDetection.auth
    : 'loading';
  const installed = transportDetection?.cli === 'installed';
  const codexAuthMode =
    transport === 'codex-sdk' && transportDetection && 'authMode' in transportDetection
      ? transportDetection.authMode
      : null;
  const authResultForRow = authResult?.transport === transport ? authResult : null;
  const canUse = installed && status === 'authenticated' && !isActive;
  const canSignIn = installed && !authenticating;
  const runtimeModels = getDetectedCliModels(detection, transport);
  const modelCatalog = transportDetection?.modelCatalog;
  const modelCatalogFailed =
    installed &&
    (modelCatalog?.status !== 'complete' ||
      modelCatalog.observedModelCount < 1 ||
      modelCatalog.observedModelCount !== runtimeModels.length);

  return (
    <div
      aria-current={isActive ? 'true' : undefined}
      tabIndex={-1}
      className="min-w-0 py-4 pl-5"
      data-testid={`assistant-host-row-${transport}`}
    >
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0 flex-1">
          <div
            className="text-lg font-semibold tracking-tight text-fg"
            data-testid={`assistant-host-title-${transport}`}
          >
            {title}
          </div>
        </div>
        {installed && (
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {status !== 'authenticated' && (
              <button
                type="button"
                onClick={() => onSignIn(transport, binaryPathOverride)}
                disabled={!canSignIn}
                className={SETTINGS_SECONDARY_BUTTON_CLASS}
                data-testid={`agent-cli-auth-${transport}`}
              >
                {authenticating ? 'Signing in...' : 'Sign in'}
              </button>
            )}
            <DefaultRouteButton
              isDefault={isActive}
              disabled={!canUse}
              onClick={() => onUse(transport)}
              testId={`agent-cli-use-${transport}`}
            />
          </div>
        )}
      </div>
      <div
        className={`mt-2 gap-x-3 gap-y-3 ${SETTINGS_FORM_GRID_CLASS} ${SETTINGS_FORM_WIDTH_CLASS}`}
        data-testid={`agent-cli-fields-${transport}`}
      >
        <StandardCliExecutablePathControl
          transport={transport}
          detectedPath={transportDetection?.path ?? null}
          override={binaryPathOverride}
          onRecheck={onRecheck}
          onChange={onExecutablePathChange}
        />
        {transportDetection == null ? null : !installed ? (
          <CliInstallInstructions
            transport={transport}
            os={installOS}
            searchedDirs={transportDetection.searchedDirs}
            onRecheck={onRecheck}
          />
        ) : modelCatalogFailed ? (
          <button
            type="button"
            className={`${SETTINGS_DANGER_BUTTON_CLASS} mt-3`}
            title={
              modelCatalog?.error != null
                ? toUserMessage(modelCatalog?.error, 'assistant.failed')
                : userMessageWithValues('notice.value-model-discovery-failed', {
                    value0: userMessageValue(title),
                  })
            }
            aria-label={`Retry ${title} model discovery`}
            data-testid={`agent-cli-model-discovery-error-${transport}`}
            onClick={() => void onRecheck()}
          >
            Models unavailable · Retry
          </button>
        ) : (
          <AgentCliModelControls
            transport={transport}
            model={modelSettings.model}
            reasoningEffort={modelSettings.reasoningEffort}
            serviceTier={modelSettings.serviceTier}
            personality={modelSettings.personality}
            defaultModel={getDetectedCliDefaultModel(detection, transport)}
            availableModels={runtimeModels}
            codexAuthMode={transport === 'codex-sdk' ? codexAuthMode : undefined}
            onModelChange={onModelChange}
            onReasoningEffortChange={onReasoningEffortChange}
            onServiceTierChange={onServiceTierChange}
            onPersonalityChange={onPersonalityChange}
          />
        )}
        {installed && permissionCatalog
          ? AGENT_PERMISSION_PICKERS[permissionFamilyForTransport(transport)].map((picker) => (
              <div
                key={picker.key}
                className="grid min-w-0 gap-1.5"
                data-testid={`agent-permissions-${transport}-${picker.key}`}
              >
                <span className="text-xs font-medium text-fg-muted">
                  {picker.label} for new chats
                </span>
                <SettingsSelect
                  value={resolveAgentPermissions(permissionCatalog, permissions)[picker.key]}
                  onValueChange={(next) => {
                    const patch = parseAgentPermissions({ [picker.key]: next });
                    if (!patch) return;
                    void onPermissionsChange(patch).catch((error) => {
                      console.error('[AgentIntegrationsPanel] Failed to save permissions:', error);
                    });
                  }}
                  options={permissionCatalog.options[picker.key].map((choice) => ({
                    value: choice.value,
                    label: choice.label,
                    ...(choice.description ? { description: choice.description } : {}),
                  }))}
                  ariaLabel={`${picker.label} for new chats`}
                  testId={`agent-permissions-${transport}-${picker.key}-select`}
                  containerClassName="w-full"
                />
              </div>
            ))
          : null}
      </div>
      {transport === 'claude-agent-sdk' ? (
        <div className={`mt-4 ${SETTINGS_FORM_WIDTH_CLASS}`}>
          <ScheduledAgentTasks />
        </div>
      ) : null}
      {authResultForRow && (
        <div
          className={`mt-2 text-[11px] leading-4 ${
            authResultForRow.ok ? 'text-success' : 'text-error'
          }`}
          data-testid={`agent-cli-auth-result-${transport}`}
        >
          {authResultForRow.ok
            ? userMessage('notice.sign-in-complete-this-cli-is-ready-to-use')
            : authResultForRow.error != null
              ? toUserMessage(authResultForRow.error, 'failure.unknown-error')
              : userMessage('notice.unknown-error')}
        </div>
      )}
      {(authenticating || authLog.length > 0) && (
        <div
          className={`mt-2 max-h-20 overflow-auto rounded-md px-3 py-2 font-mono text-[10px] leading-4 text-fg-muted ${SETTINGS_SURFACE_CLASS}`}
          data-testid={`agent-cli-auth-log-${transport}`}
        >
          {(authLog.length > 0 ? authLog : ['Waiting for the CLI sign-in flow...'])
            .slice(-8)
            .map((line, index) => (
              <div key={`${transport}-auth-${index}`} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function DirectApiHostRow({
  providerLabel,
  model,
  configured,
  configuredProviderCount,
  isActive,
  onUse,
}: {
  providerLabel: string;
  model: string;
  configured: boolean;
  configuredProviderCount: number;
  isActive: boolean;
  onUse: () => void;
}) {
  const canUse = configured && !isActive;
  const host = getDirectApiHostDescriptor();

  return (
    <div
      aria-current={isActive ? 'true' : undefined}
      tabIndex={-1}
      className="min-w-0 py-5 pl-6"
      data-testid="assistant-host-row-direct-api"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div
            className="text-lg font-semibold tracking-tight text-fg"
            data-testid="assistant-host-title-direct-api"
          >
            {host?.label ?? 'Direct API'}
          </div>
        </div>
        {isActive || canUse ? (
          <DefaultRouteButton
            isDefault={isActive}
            onClick={onUse}
            testId="agent-host-use-direct-api"
          />
        ) : null}
      </div>
      <div className="mt-6">
        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
          Current model
        </div>
        <div
          className={`mt-2 ${configured ? 'text-base font-medium text-fg' : 'text-sm text-fg-muted'}`}
        >
          {configured
            ? `${providerLabel} / ${shortenModelName(model)}`
            : 'Add a provider API key in Direct API below.'}
        </div>
        {configured && configuredProviderCount > 1 && (
          <div className="mt-1 text-xs text-fg-subtle">
            {configuredProviderCount} providers configured
          </div>
        )}
      </div>
    </div>
  );
}

type CustomHarnessAvailability = 'checking' | 'ready' | 'missing';

function looksLikeAbsoluteExecutablePath(value: string): boolean {
  const path = value.trim();
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function CustomHarnessForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: {
    label: string;
    transport: AgentTransport;
    executablePath: string;
  }) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [transport, setTransport] = useState<AgentTransport>('codex-sdk');
  const [executablePath, setExecutablePath] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = label.trim().length > 0 && looksLikeAbsoluteExecutablePath(executablePath);

  const chooseExecutable = async () => {
    const selected = await platform().dialog.open({ title: 'Choose harness executable' });
    if (typeof selected === 'string') setExecutablePath(selected);
  };

  return (
    <form
      className="min-w-0 py-5 pl-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || saving) return;
        setSaving(true);
        setError(null);
        void onCreate({
          label: label.trim(),
          transport,
          executablePath: executablePath.trim(),
        })
          .catch((reason) => {
            setError(toUserMessage(reason, 'failure.could-not-save-this-harness'));
          })
          .finally(() => setSaving(false));
      }}
    >
      <h4 className="text-lg font-semibold tracking-tight text-fg">Add harness</h4>
      <div className={`mt-5 grid gap-4 ${SETTINGS_FORM_WIDTH_CLASS}`}>
        <label className="grid gap-1.5 text-xs font-medium text-fg">
          Harness name
          <input
            autoFocus
            aria-label="Harness name"
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            placeholder="Lab Codex"
            className={SETTINGS_FIELD_CLASS}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-fg">
          Compatibility
          <SettingsSelect
            value={transport}
            onValueChange={(value) => setTransport(value as AgentTransport)}
            ariaLabel="Harness compatibility"
            options={[
              { value: 'codex-sdk', label: 'Codex CLI' },
              { value: 'claude-agent-sdk', label: 'Claude Code' },
              { value: 'grok-acp', label: 'Grok Build' },
            ]}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-fg">
          Executable path
          <span className="flex gap-2">
            <input
              aria-label="Executable path"
              value={executablePath}
              onChange={(event) => setExecutablePath(event.currentTarget.value)}
              placeholder="/opt/lab/bin/codex"
              className={SETTINGS_FIELD_CLASS}
            />
            <button
              type="button"
              onClick={() => void chooseExecutable()}
              className={SETTINGS_SECONDARY_BUTTON_CLASS}
            >
              Choose…
            </button>
          </span>
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {toUserMessage(error, 'assistant.failed')}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button type="submit" disabled={!valid || saving} className={SETTINGS_PRIMARY_BUTTON_CLASS}>
          {saving ? 'Saving…' : 'Save harness'}
        </button>
        <button type="button" onClick={onCancel} className={SETTINGS_SECONDARY_BUTTON_CLASS}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CustomCliHarnessEditor({
  harness,
  detection,
  availability,
  isActive,
  onUse,
  onUpdate,
  onRemove,
}: {
  harness: CustomCliHarnessDefinition;
  detection: AgentSdkDetectionShape | null;
  availability: CustomHarnessAvailability;
  isActive: boolean;
  onUse: () => void;
  onUpdate: (update: Partial<Omit<CustomCliHarnessDefinition, 'id'>>) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [label, setLabel] = useState(harness.label);
  const [executablePath, setExecutablePath] = useState(harness.executablePath);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = label.trim() !== harness.label || executablePath.trim() !== harness.executablePath;
  const runtimeModels = getDetectedCliModels(detection, harness.transport);
  const transportDetection = getAgentTransportDetection(detection, harness.transport);
  const codexAuthMode =
    harness.transport === 'codex-sdk' && transportDetection && 'authMode' in transportDetection
      ? transportDetection.authMode
      : undefined;
  const compatibilityLabel = AGENT_TRANSPORT_LABELS[harness.transport];
  const status =
    availability === 'checking'
      ? 'Checking'
      : availability === 'ready'
        ? 'Ready'
        : 'Executable not found';

  useEffect(() => {
    setLabel(harness.label);
    setExecutablePath(harness.executablePath);
  }, [harness.executablePath, harness.label]);

  const saveIdentity = async () => {
    if (!dirty || !label.trim() || !looksLikeAbsoluteExecutablePath(executablePath)) return;
    setSaving(true);
    setError(null);
    try {
      await onUpdate({ label: label.trim(), executablePath: executablePath.trim() });
    } catch (reason) {
      setError(toUserMessage(reason, 'failure.could-not-update-this-harness'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-w-0 py-4 pl-5" data-testid={`custom-harness-${harness.id}`}>
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0 flex-1">
          <h4 className="text-lg font-semibold tracking-tight text-fg">{harness.label}</h4>
          <p className="mt-1.5 text-sm text-fg-muted">
            {compatibilityLabel} compatible · {status}
          </p>
        </div>
        <DefaultRouteButton
          isDefault={isActive}
          disabled={availability !== 'ready'}
          onClick={onUse}
          testId={`custom-harness-default-${harness.id}`}
        />
      </div>

      <div className={`mt-3 gap-3 ${SETTINGS_FORM_GRID_CLASS} ${SETTINGS_FORM_WIDTH_CLASS}`}>
        <label className="grid gap-1.5 text-xs font-medium text-fg">
          Name
          <input
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            className={SETTINGS_FIELD_CLASS}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-fg">
          Executable
          <input
            value={executablePath}
            onChange={(event) => setExecutablePath(event.currentTarget.value)}
            className={SETTINGS_FIELD_CLASS}
          />
        </label>
        <AgentCliModelControls
          transport={harness.transport}
          model={harness.model}
          reasoningEffort={harness.reasoningEffort}
          serviceTier={harness.serviceTier}
          personality={harness.personality}
          defaultModel={getDetectedCliDefaultModel(detection, harness.transport)}
          availableModels={runtimeModels}
          codexAuthMode={codexAuthMode}
          onModelChange={async (_transport, model) => onUpdate({ model })}
          onReasoningEffortChange={async (_transport, reasoningEffort) =>
            onUpdate({ reasoningEffort })
          }
          onServiceTierChange={async (_transport, serviceTier) => onUpdate({ serviceTier })}
          onPersonalityChange={async (_transport, personality) => onUpdate({ personality })}
        />
      </div>
      {dirty && (
        <button
          type="button"
          onClick={() => void saveIdentity()}
          disabled={saving || !label.trim() || !looksLikeAbsoluteExecutablePath(executablePath)}
          className={`${SETTINGS_SECONDARY_BUTTON_CLASS} mt-3`}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {toUserMessage(error, 'assistant.failed')}
        </p>
      )}
      <button
        type="button"
        onClick={() => void onRemove()}
        className={`${SETTINGS_DANGER_BUTTON_CLASS} mt-4`}
      >
        Remove harness
      </button>
    </div>
  );
}

export function AssistantHostSettingsContent({
  focusHostId = null,
  directApiSettings,
}: AssistantHostSettingsContentProps = {}) {
  return (
    <AISettingsBoundary>
      <InitializedAssistantHostSettingsContent
        focusHostId={focusHostId}
        directApiSettings={directApiSettings}
      />
    </AISettingsBoundary>
  );
}

function InitializedAssistantHostSettingsContent({
  focusHostId,
  directApiSettings,
}: AssistantHostSettingsContentProps & { focusHostId: AssistantHostId | null }) {
  const { state: authState, hydrated: authHydrated, startSignIn } = useAuthStore();
  const {
    agentTransport,
    assistantRoute,
    provider,
    model,
    providerStatuses,
    providerModels,
    cliModelSettings,
    cliExecutablePathOverrides,
    customCliHarnesses,
    hostedRouteReadiness,
    agentPermissions,
    permissionCatalog,
    loadPermissionCatalog,
    additionalAgentInstructions,
    agentDetection,
    agentDetectError,
    refreshAgentDetection,
    refreshHostedRouteReadiness,
    setAssistantRoute,
    setCliModel,
    setCliReasoningEffort,
    setCliServiceTier,
    setCliPersonality,
    setCliExecutablePathOverride,
    setAgentPermissions,
    setAdditionalAgentInstructions,
    addCustomCliHarness,
    updateCustomCliHarness,
    removeCustomCliHarness,
  } = useAISettingsStore();
  const [instructionDraft, setInstructionDraft] = useState(additionalAgentInstructions);
  useEffect(() => {
    void loadPermissionCatalog();
  }, [loadPermissionCatalog]);
  const [customHarnessAvailability, setCustomHarnessAvailability] = useState<
    Record<string, CustomHarnessAvailability>
  >({});
  const {
    authenticatingTransport,
    authResult: agentAuthResult,
    authLog: agentAuthLog,
    runAgentAuth,
  } = useAgentCliAuthFlow({ refreshAgentDetection });
  const cliHosts = getCliAssistantHostDescriptors();
  const installOS =
    (window as { electronAPI?: { platform?: string } }).electronAPI?.platform ?? 'darwin';
  const routeState = {
    assistantRoute,
    provider,
    model,
    agentTransport,
    providerStatuses,
    providerModels,
    cliModelSettings,
    agentDetection,
    agentDetectError,
    hostedRouteReadiness: getEffectiveHostedRouteReadiness(
      hostedRouteReadiness,
      authHydrated,
      authState.status
    ),
  };
  const activeRoute = getActiveAssistantRoute(routeState);
  const directApiRoute = buildAssistantRouteOptions(routeState).find(
    (option) => option.selection.kind === 'provider'
  )?.selection;
  const activeCustomHarnessId =
    activeRoute?.kind === 'cli' ? (activeRoute.customHarnessId ?? null) : null;
  const activeCliTransport =
    activeRoute?.kind === 'cli' && !activeRoute.customHarnessId ? activeRoute.transport : null;
  const directApiProvider = directApiRoute?.kind === 'provider' ? directApiRoute.provider : null;
  const directApiModel = directApiRoute?.kind === 'provider' ? directApiRoute.model : null;
  const providerMetas = getAllProviderMetas();
  const activeProviderMeta = providerMetas.find((meta) => meta.name === directApiProvider);
  const activeProviderLabel = activeProviderMeta?.label ?? directApiProvider ?? '';
  const activeProviderStatus = directApiProvider ? providerStatuses[directApiProvider] : undefined;
  const configuredProviderCount = providerMetas.filter(
    (meta) => providerStatuses[meta.name]?.isConfigured
  ).length;
  const directApiConfigured = !!activeProviderStatus?.isConfigured;
  const nativeHostReadiness = !authHydrated
    ? 'checking'
    : authState.status !== 'signed-in'
      ? 'needs-login'
      : routeState.hostedRouteReadiness;
  const directApiActive =
    activeRoute?.kind === 'provider' &&
    activeRoute.provider === directApiProvider &&
    activeRoute.model === directApiModel;
  const focusedHost: SelectedAssistantHost | null =
    __DNAFORGE_HOSTED_AI_ENABLED__ &&
    (focusHostId === 'dnaforge-hosted-auto' || focusHostId === 'dnaforge-hosted-deep')
      ? 'dnaforge-agent'
      : customCliHarnesses.some((harness) => harness.id === focusHostId)
        ? focusHostId
        : focusHostId === getDirectApiHostDescriptor()?.id
          ? 'direct-api'
          : (cliHosts.find((host) => host.id === focusHostId)?.target.transport ?? null);
  const [selectedHost, setSelectedHost] = useState<SelectedAssistantHost>(
    focusedHost ??
      activeCustomHarnessId ??
      activeCliTransport ??
      (directApiActive
        ? 'direct-api'
        : activeRoute?.kind === 'hosted' || __DNAFORGE_HOSTED_AI_ENABLED__
          ? 'dnaforge-agent'
          : (agentTransport ?? 'codex-sdk'))
  );
  const selectedCliHost = isAgentTransport(selectedHost)
    ? (cliHosts.find((host) => host.target.transport === selectedHost) ?? null)
    : null;
  const selectedCustomHarness = customCliHarnesses.find((harness) => harness.id === selectedHost);

  useEffect(() => {
    void refreshAgentDetection();
  }, [refreshAgentDetection]);

  const hostedSessionId =
    authState.status === 'signed-in' ? authState.session?.desktopSessionId : null;
  useEffect(() => {
    if (!__DNAFORGE_HOSTED_AI_ENABLED__ || !authHydrated) return;
    if (authState.status !== 'signed-in' && authState.status !== 'signed-out') return;
    void refreshHostedRouteReadiness();
  }, [authHydrated, authState.status, hostedSessionId, refreshHostedRouteReadiness]);

  useEffect(() => {
    setInstructionDraft(additionalAgentInstructions);
  }, [additionalAgentInstructions]);

  useEffect(() => {
    if (focusedHost) setSelectedHost(focusedHost);
  }, [focusedHost]);

  useEffect(() => {
    let cancelled = false;
    if (customCliHarnesses.length === 0) {
      setCustomHarnessAvailability({});
      return () => {
        cancelled = true;
      };
    }
    setCustomHarnessAvailability((current) =>
      Object.fromEntries(
        customCliHarnesses.map((harness) => [harness.id, current[harness.id] ?? 'checking'])
      )
    );
    void Promise.all(
      customCliHarnesses.map(
        async (harness) => [harness.id, await platform().fs.exists(harness.executablePath)] as const
      )
    ).then((entries) => {
      if (cancelled) return;
      setCustomHarnessAvailability(
        Object.fromEntries(entries.map(([id, exists]) => [id, exists ? 'ready' : 'missing']))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [customCliHarnesses]);

  const useCliRoute = useCallback(
    (transport: AgentTransport) => {
      setSelectedHost(transport);
      setAssistantRoute({
        kind: 'cli',
        transport,
        permissionMode: DEFAULT_CLI_PERMISSION_MODE,
      }).catch((error) => {
        console.error('[AgentIntegrationsPanel] Failed to select CLI route:', error);
      });
    },
    [setAssistantRoute]
  );

  const useDirectApiRoute = useCallback(() => {
    if (!directApiRoute || directApiRoute.kind !== 'provider') return;
    setSelectedHost('direct-api');
    setAssistantRoute(directApiRoute).catch((error) => {
      console.error('[AgentIntegrationsPanel] Failed to select Direct API route:', error);
    });
  }, [directApiRoute, setAssistantRoute]);

  const selectCustomHarnessRoute = useCallback(
    (harness: CustomCliHarnessDefinition) => {
      setSelectedHost(harness.id);
      setAssistantRoute({
        kind: 'cli',
        transport: harness.transport,
        permissionMode: DEFAULT_CLI_PERMISSION_MODE,
        customHarnessId: harness.id,
      }).catch((error) => {
        console.error('[AgentIntegrationsPanel] Failed to select custom harness:', error);
      });
    },
    [setAssistantRoute]
  );

  return (
    <div className="space-y-2" data-testid="agent-integrations-section-cli">
      <div className={`h-[24rem] ${SETTINGS_SPLIT_PANEL_CLASS}`} data-testid="assistant-host-shell">
        <div
          className={`flex min-h-0 min-w-0 flex-col ${selectedHost === 'direct-api' && directApiSettings ? 'border-r border-border' : ''}`}
        >
          <div
            role="tablist"
            aria-label="Assistant hosts"
            className={SETTINGS_SPLIT_PANEL_LIST_CLASS}
            data-testid="assistant-host-list"
          >
            {__DNAFORGE_HOSTED_AI_ENABLED__ && (
              <button
                type="button"
                role="tab"
                id="assistant-host-tab-dnaforge-agent"
                aria-controls="assistant-host-editor"
                aria-selected={selectedHost === 'dnaforge-agent'}
                onClick={() => setSelectedHost('dnaforge-agent')}
                className={settingsSplitPanelTabClass(selectedHost === 'dnaforge-agent')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">DNAForge agent</span>
                  <span
                    className={`mt-1 block text-[11px] ${nativeHostReadiness === 'ready' ? 'text-success' : 'text-fg-subtle'}`}
                  >
                    {nativeHostReadiness === 'ready'
                      ? 'Ready'
                      : getAssistantRouteReadinessLabel(nativeHostReadiness)}
                  </span>
                </span>
                {activeRoute?.kind === 'hosted' && (
                  <span className="ml-2 shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                    active
                  </span>
                )}
              </button>
            )}
            {directApiRoute?.kind === 'provider' && directApiModel && (
              <button
                type="button"
                role="tab"
                id="assistant-host-tab-direct-api"
                aria-controls="assistant-host-editor"
                aria-selected={selectedHost === 'direct-api'}
                onClick={() => setSelectedHost('direct-api')}
                className={settingsSplitPanelTabClass(selectedHost === 'direct-api')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">Direct API</span>
                  <span
                    className={`mt-1 block text-[11px] ${
                      directApiConfigured ? 'text-success' : 'text-warning'
                    }`}
                  >
                    {directApiConfigured ? 'Ready' : 'Needs key'}
                  </span>
                </span>
                {directApiActive ? (
                  <span className="ml-2 shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                    active
                  </span>
                ) : null}
              </button>
            )}
            {cliHosts.map((host) => {
              const transport = host.target.transport;
              const detection = getAgentTransportDetection(agentDetection, transport);
              const installed = detection?.cli === 'installed';
              const status =
                detection == null
                  ? 'Checking'
                  : !installed
                    ? 'Not installed'
                    : getAgentAuthLabel(detection.auth);
              return (
                <button
                  key={host.id}
                  type="button"
                  role="tab"
                  id={`assistant-host-tab-${transport}`}
                  aria-controls="assistant-host-editor"
                  aria-selected={selectedHost === transport}
                  onClick={() => setSelectedHost(transport)}
                  className={settingsSplitPanelTabClass(selectedHost === transport)}
                  data-testid={`assistant-host-tab-${transport}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{host.label}</span>
                    <span
                      className={`mt-1 block text-[11px] ${
                        installed && detection?.auth === 'authenticated'
                          ? 'text-success'
                          : detection?.auth === 'unauthenticated'
                            ? 'text-warning'
                            : 'text-fg-subtle'
                      }`}
                      data-testid={`assistant-host-tab-status-${transport}`}
                    >
                      {status}
                    </span>
                  </span>
                  {activeCliTransport === transport ? (
                    <span className="ml-2 shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                      active
                    </span>
                  ) : null}
                </button>
              );
            })}
            {customCliHarnesses.map((harness) => {
              const availability = customHarnessAvailability[harness.id] ?? 'checking';
              const status =
                availability === 'checking'
                  ? 'Checking'
                  : availability === 'ready'
                    ? 'Ready'
                    : 'Not found';
              return (
                <button
                  key={harness.id}
                  type="button"
                  role="tab"
                  id={`assistant-host-tab-${harness.id}`}
                  aria-controls="assistant-host-editor"
                  aria-selected={selectedHost === harness.id}
                  onClick={() => setSelectedHost(harness.id)}
                  className={settingsSplitPanelTabClass(selectedHost === harness.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{harness.label}</span>
                    <span
                      className={`mt-1 block text-[11px] ${
                        availability === 'ready'
                          ? 'text-success'
                          : availability === 'missing'
                            ? 'text-warning'
                            : 'text-fg-subtle'
                      }`}
                    >
                      {status}
                    </span>
                  </span>
                  {activeCustomHarnessId === harness.id ? (
                    <span className="ml-2 shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                      active
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="shrink-0 p-2">
            <button
              type="button"
              onClick={() => setSelectedHost('new-harness')}
              className={`${SETTINGS_SECONDARY_BUTTON_CLASS} flex w-full items-center justify-center gap-1.5`}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Add harness
            </button>
          </div>
        </div>
        <div
          id="assistant-host-editor"
          role="tabpanel"
          aria-labelledby={
            selectedHost === 'new-harness' ? undefined : `assistant-host-tab-${selectedHost}`
          }
          aria-label={selectedHost === 'new-harness' ? 'Add harness' : undefined}
          className={`h-[24rem] ${selectedHost === 'direct-api' && directApiSettings ? 'min-w-0 overflow-hidden bg-bg' : SETTINGS_SPLIT_PANEL_EDITOR_CLASS}`}
          data-testid="assistant-host-editor"
        >
          {selectedHost === 'dnaforge-agent' && __DNAFORGE_HOSTED_AI_ENABLED__ ? (
            <DnaforgeAgentHostRow
              readiness={nativeHostReadiness}
              activeTier={activeRoute?.kind === 'hosted' ? activeRoute.tier : null}
              onUse={(tier) => setAssistantRoute({ kind: 'hosted', tier })}
              onSignIn={startSignIn}
            />
          ) : selectedHost === 'new-harness' ? (
            <CustomHarnessForm
              onCancel={() =>
                setSelectedHost(activeCustomHarnessId ?? activeCliTransport ?? 'codex-sdk')
              }
              onCreate={async (input) => {
                const id = await addCustomCliHarness(input);
                setSelectedHost(id);
              }}
            />
          ) : selectedHost === 'direct-api' && directApiSettings ? (
            directApiSettings(directApiActive)
          ) : selectedHost === 'direct-api' &&
            directApiRoute?.kind === 'provider' &&
            directApiModel ? (
            <DirectApiHostRow
              providerLabel={activeProviderLabel}
              model={directApiModel}
              configured={directApiConfigured}
              configuredProviderCount={configuredProviderCount}
              isActive={directApiActive}
              onUse={useDirectApiRoute}
            />
          ) : selectedCustomHarness ? (
            <CustomCliHarnessEditor
              harness={selectedCustomHarness}
              detection={agentDetection}
              availability={customHarnessAvailability[selectedCustomHarness.id] ?? 'checking'}
              isActive={activeCustomHarnessId === selectedCustomHarness.id}
              onUse={() => selectCustomHarnessRoute(selectedCustomHarness)}
              onUpdate={(update) => updateCustomCliHarness(selectedCustomHarness.id, update)}
              onRemove={async () => {
                await removeCustomCliHarness(selectedCustomHarness.id);
                setSelectedHost('codex-sdk');
              }}
            />
          ) : selectedCliHost ? (
            <AgentCliSignInRow
              key={selectedCliHost.id}
              title={selectedCliHost.label}
              transport={selectedCliHost.target.transport}
              detection={agentDetection}
              isActive={activeCliTransport === selectedCliHost.target.transport}
              authenticating={authenticatingTransport === selectedCliHost.target.transport}
              authResult={agentAuthResult}
              authLog={agentAuthLog[selectedCliHost.target.transport]}
              onSignIn={runAgentAuth}
              onUse={useCliRoute}
              onRecheck={refreshAgentDetection}
              installOS={installOS}
              modelSettings={
                cliModelSettings?.[selectedCliHost.target.transport] ?? {
                  model: null,
                  reasoningEffort: DEFAULT_CLI_REASONING_EFFORTS[selectedCliHost.target.transport],
                  serviceTier: null,
                  personality: null,
                }
              }
              onModelChange={setCliModel}
              onReasoningEffortChange={setCliReasoningEffort}
              onServiceTierChange={setCliServiceTier}
              onPersonalityChange={setCliPersonality}
              binaryPathOverride={cliExecutablePathOverrides[selectedCliHost.target.transport]}
              onExecutablePathChange={setCliExecutablePathOverride}
              permissionCatalog={permissionCatalog}
              permissions={agentPermissions}
              onPermissionsChange={setAgentPermissions}
            />
          ) : null}
        </div>
      </div>
      {agentDetectError && (
        <div className="px-3 py-2 text-[11px] leading-4 text-warning">
          CLI detection failed: {toUserMessage(agentDetectError, 'assistant.failed')}
        </div>
      )}
      <div
        className={`mt-4 space-y-4 ${SETTINGS_FORM_WIDTH_CLASS}`}
        data-testid="agent-host-preferences"
      >
        <div>
          <label
            htmlFor="agent-additional-instructions"
            className="block text-sm font-medium text-fg"
          >
            Shared instructions
          </label>
          <textarea
            id="agent-additional-instructions"
            value={instructionDraft}
            onChange={(event) => setInstructionDraft(event.currentTarget.value)}
            maxLength={MAX_ADDITIONAL_AGENT_INSTRUCTIONS_LENGTH}
            rows={4}
            placeholder="For example: Keep replies concise and explain unfamiliar biology terms."
            data-testid="agent-additional-instructions"
            className={`${SETTINGS_TEXTAREA_CLASS} mt-2 resize-y`}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-fg-subtle">
              {instructionDraft.length.toLocaleString()} /{' '}
              {MAX_ADDITIONAL_AGENT_INSTRUCTIONS_LENGTH.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              {instructionDraft !== additionalAgentInstructions ? (
                <button
                  type="button"
                  onClick={() => setInstructionDraft(additionalAgentInstructions)}
                  data-testid="cancel-agent-additional-instructions"
                  className={SETTINGS_SECONDARY_BUTTON_CLASS}
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                disabled={instructionDraft === additionalAgentInstructions}
                onClick={() => {
                  setAdditionalAgentInstructions(instructionDraft).catch((error) => {
                    console.error(
                      '[AgentIntegrationsPanel] Failed to save agent instructions:',
                      error
                    );
                  });
                }}
                data-testid="save-agent-additional-instructions"
                className={SETTINGS_PRIMARY_BUTTON_CLASS}
              >
                Save
              </button>
            </div>
          </div>
        </div>
        <AgentPresentationSettings />
        <AlwaysAllowList />
      </div>
    </div>
  );
}

function AgentGrantRow({
  grant,
  revoking,
  onRevoke,
}: {
  grant: AgentGrant;
  revoking: boolean;
  onRevoke: (grantId: string) => void;
}) {
  const displayLabel = getAgentGrantDisplayLabel(grant);
  const canRemove = grant.kind !== 'in-app';
  const visibleScopes = grant.scopes.slice(0, 6);
  const hiddenScopeCount = Math.max(0, grant.scopes.length - visibleScopes.length);

  return (
    <div
      role="row"
      data-testid={`agent-grant-row-${grant.id}`}
      className={`rounded-md px-3 py-2.5 ${SETTINGS_SURFACE_CLASS}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div role="cell" className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-fg-muted dark:bg-white/[0.07]">
              {AGENT_GRANT_KIND_LABELS[grant.kind]}
            </span>
            {grant.isDevelopment === true && (
              <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                Dev/test
              </span>
            )}
            <div className="truncate text-sm font-medium text-fg">{displayLabel}</div>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-muted">
            {grant.clientName && (
              <span>
                Client{' '}
                <span className="text-fg-subtle">
                  {grant.clientName}
                  {grant.clientVersion ? ` ${grant.clientVersion}` : ''}
                </span>
              </span>
            )}
            {grant.boundWorkspace && (
              <span className="max-w-full truncate" title={grant.boundWorkspace}>
                Workspace <span className="text-fg-subtle">{grant.boundWorkspace}</span>
              </span>
            )}
            <span>
              Last used <span className="text-fg-subtle">{formatLastUsed(grant.lastUsedAt)}</span>
            </span>
            {grant.lastCallStatus && (
              <span>
                Last call{' '}
                <span className="text-fg-subtle">
                  {formatCallStatus(grant.lastCallStatus)}
                  {grant.lastToolName ? ` · ${grant.lastToolName}` : ''}
                </span>
              </span>
            )}
            <span>{formatScopeSummary(grant.scopes)}</span>
            {grant.expiresAt && (
              <span>
                Expires <span className="text-fg-subtle">{formatExpiresAt(grant.expiresAt)}</span>
              </span>
            )}
          </div>
        </div>
        {canRemove ? (
          <button
            type="button"
            aria-label={`Remove external access for ${displayLabel}`}
            title="Remove external access"
            disabled={revoking}
            onClick={() => onRevoke(grant.id)}
            className={`${SETTINGS_DANGER_BUTTON_CLASS} inline-flex h-7 flex-shrink-0 items-center gap-1.5 px-2 text-[11px]`}
          >
            <TrashIcon size={13} />
            Remove
          </button>
        ) : (
          <span className="inline-flex h-7 flex-shrink-0 items-center px-2 text-[11px] font-medium text-fg-muted">
            System
          </span>
        )}
      </div>
      {grant.scopes.length > 0 && (
        <div role="cell" className="mt-2">
          <div className="flex flex-wrap gap-1.5">
            {visibleScopes.map((scope) => (
              <span
                key={`${grant.id}-${scope}`}
                title={getAgentGrantScopeLabel(scope)}
                className="max-w-full rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] leading-4 text-fg-muted dark:bg-white/[0.07]"
              >
                {getAgentGrantScopeLabel(scope)}
              </span>
            ))}
            {hiddenScopeCount > 0 && (
              <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] leading-4 text-fg-muted dark:bg-white/[0.07]">
                +{hiddenScopeCount}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ToolAccessSettingsContent() {
  const [storeSnapshot, setStoreSnapshot] = useState<AgentGrantStoreSnapshot>(() =>
    getInitialAgentGrantStoreSnapshot({ includeDevelopment: SHOW_AGENT_DEV_GRANTS })
  );
  const [loadingGrants, setLoadingGrants] = useState(storeSnapshot.source === 'connected');
  const [loadingMoreGrants, setLoadingMoreGrants] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [scriptOptionsOpen, setScriptOptionsOpen] = useState(false);
  const [grantLabel, setGrantLabel] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(
    DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES
  );
  const [customPermissionsOpen, setCustomPermissionsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  const copying = useRef(false);
  const copyRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      copyRequest.current += 1;
      copying.current = false;
    };
  }, []);
  const resetCopy = useCallback(() => {
    copyRequest.current += 1;
    copying.current = false;
    setCopyState('idle');
  }, []);
  const grants = storeSnapshot.grants;
  const externalGrants = grants.filter((grant) => grant.kind !== 'in-app');
  const productGrants = SHOW_AGENT_DEV_GRANTS
    ? externalGrants.filter((grant) => grant.isDevelopment !== true)
    : externalGrants;
  const developmentGrants = SHOW_AGENT_DEV_GRANTS
    ? externalGrants.filter((grant) => grant.isDevelopment === true)
    : [];
  const activeAccessCount = externalGrants.length;
  const grantStorePending = storeSnapshot.source === 'pending';

  const refreshGrants = useCallback(async () => {
    setLoadingGrants(true);
    try {
      setStoreSnapshot(
        await getAgentGrantStoreSnapshot({ includeDevelopment: SHOW_AGENT_DEV_GRANTS })
      );
      setError(null);
    } catch (err) {
      setError(toUserMessage(err, 'failure.failed-to-load-agent-access'));
    } finally {
      setLoadingGrants(false);
    }
  }, []);

  useEffect(() => {
    void refreshGrants();
  }, [refreshGrants]);

  const loadMoreGrants = useCallback(async () => {
    if (!storeSnapshot.nextCursor || loadingMoreGrants) return;
    setLoadingMoreGrants(true);
    setError(null);
    try {
      const nextPage = await getAgentGrantStoreSnapshot({
        includeDevelopment: SHOW_AGENT_DEV_GRANTS,
        cursor: storeSnapshot.nextCursor,
      });
      setStoreSnapshot((current) => {
        const merged = new Map(current.grants.map((grant) => [grant.id, grant]));
        for (const grant of nextPage.grants) merged.set(grant.id, grant);
        return { ...nextPage, grants: [...merged.values()] };
      });
    } catch (err) {
      setError(toUserMessage(err, 'failure.failed-to-load-more-agent-access'));
    } finally {
      setLoadingMoreGrants(false);
    }
  }, [loadingMoreGrants, storeSnapshot.nextCursor]);

  const toggleScope = useCallback((scope: string) => {
    setSelectedScopes((current) =>
      current.includes(scope)
        ? current.filter((candidate) => candidate !== scope)
        : [...current, scope]
    );
  }, []);

  const handleRevoke = useCallback(
    async (grantId: string) => {
      setRevokingId(grantId);
      setError(null);
      try {
        await revokeAgentGrant(grantId);
        setStoreSnapshot((current) => ({
          ...current,
          grants: current.grants.filter((grant) => grant.id !== grantId),
        }));
        await refreshGrants();
      } catch (err) {
        setError(toUserMessage(err, 'failure.failed-to-revoke-grant'));
      } finally {
        setRevokingId(null);
      }
    },
    [refreshGrants]
  );

  const handleCreate = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreating(true);
      resetCopy();
      setError(null);
      try {
        const result = await createApiKeyAgentGrant({
          label: grantLabel,
          scopes: selectedScopes,
        });
        setCreatedKey(result.apiKey);
        setStoreSnapshot((current) => ({
          ...current,
          grants: [result.grant, ...current.grants.filter((grant) => grant.id !== result.grant.id)],
        }));
        setFormOpen(false);
        setGrantLabel('');
        setSelectedScopes(DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES);
        setCustomPermissionsOpen(false);
        await refreshGrants();
      } catch (err) {
        setError(toUserMessage(err, 'failure.failed-to-create-external-access-key'));
      } finally {
        setCreating(false);
      }
    },
    [grantLabel, refreshGrants, resetCopy, selectedScopes]
  );

  const handleCopyCreatedKey = useCallback(async () => {
    if (!createdKey || copying.current) return;
    const request = ++copyRequest.current;
    copying.current = true;
    setCopyState('pending');
    try {
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.writeText !== 'function') {
        throw new Error('Clipboard unavailable');
      }
      await clipboard.writeText(createdKey);
      if (mounted.current && request === copyRequest.current) setCopyState('copied');
    } catch {
      if (mounted.current && request === copyRequest.current) setCopyState('failed');
    } finally {
      if (request === copyRequest.current) copying.current = false;
    }
  }, [createdKey]);

  const canCreate =
    !grantStorePending &&
    !loadingGrants &&
    grantLabel.trim().length > 0 &&
    selectedScopes.length > 0 &&
    !creating;

  return (
    <div
      className="ph-no-capture space-y-2"
      data-testid="agent-integrations-section-grants"
      data-analytics-block
      data-ph-no-capture
      data-ph-mask
    >
      <div>
        <div className="flex items-center justify-between gap-3 pb-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
              {activeAccessCount > 0 && (
                <span title="Loaded active callers; this is not a complete access history.">
                  {formatExternalGrantCount(activeAccessCount)}
                </span>
              )}
              {loadingGrants && <span>Loading...</span>}
              {storeSnapshot.source === 'fixture' && (
                <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                  Dev sample data
                </span>
              )}
              {!SHOW_AGENT_DEV_GRANTS && storeSnapshot.hiddenDevelopmentGrantCount > 0 && (
                <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                  {userMessageWithValues('permissions.hiddenDevelopment', {
                    count: userMessageValue(storeSnapshot.hiddenDevelopmentGrantCount),
                  })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-expanded={scriptOptionsOpen}
            onClick={() => setScriptOptionsOpen((open) => !open)}
            data-testid="agent-grant-script-options"
            className="text-xs text-fg-muted hover:text-fg"
          >
            {scriptOptionsOpen ? 'Hide script access' : 'Script access'}
          </button>
        </div>
        {scriptOptionsOpen && (
          <div className="space-y-2 pb-3">
            {!formOpen && (
              <button
                type="button"
                disabled={grantStorePending || loadingGrants}
                onClick={() => {
                  if (grantStorePending || loadingGrants) return;
                  setFormOpen(true);
                  setSelectedScopes(DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES);
                  setCustomPermissionsOpen(false);
                  setCreatedKey(null);
                  resetCopy();
                  setError(null);
                }}
                className={`${SETTINGS_SECONDARY_BUTTON_CLASS} inline-flex flex-shrink-0 items-center gap-1.5`}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Create script key
              </button>
            )}

            {(createdKey || formOpen) && (
              <div className="space-y-2 py-2">
                {createdKey && (
                  <div className="rounded-md bg-success/10 p-2.5">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-success">Script key created</div>
                        <div className="text-[11px] text-fg-muted">
                          Copy it now. It will not be shown again.
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label="Copy external access key"
                        aria-busy={copyState === 'pending'}
                        disabled={copyState === 'pending'}
                        title={
                          copyState === 'pending'
                            ? 'Copying key…'
                            : copyState === 'copied'
                              ? 'Key copied'
                              : copyState === 'failed'
                                ? 'Retry copy'
                                : 'Copy key'
                        }
                        onClick={() => void handleCopyCreatedKey()}
                        className="flex h-6 w-6 items-center justify-center rounded text-success transition-colors hover:bg-success/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-success/40"
                      >
                        {copyState === 'copied' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                      </button>
                    </div>
                    <code
                      data-testid="agent-grant-created-key"
                      className="block break-all rounded bg-bg px-2 py-1.5 font-mono text-[11px] text-fg"
                    >
                      {createdKey}
                    </code>
                    {copyState === 'pending' && (
                      <span role="status" className="sr-only">
                        Copying key…
                      </span>
                    )}
                    {copyState === 'copied' && (
                      <span role="status" className="sr-only">
                        Key copied.
                      </span>
                    )}
                    {copyState === 'failed' && (
                      <p role="alert" className="mt-2 text-xs text-fg-muted">
                        Could not copy the key. Try again, or select and copy it.
                      </p>
                    )}
                  </div>
                )}

                {formOpen && (
                  <form
                    onSubmit={handleCreate}
                    className={`space-y-3 rounded-md p-3 ${SETTINGS_SURFACE_CLASS}`}
                  >
                    <div>
                      <label
                        htmlFor="agent-grant-label"
                        className="mb-1 block text-xs text-fg-muted"
                      >
                        Script key name
                      </label>
                      <input
                        id="agent-grant-label"
                        type="text"
                        value={grantLabel}
                        placeholder="Nightly import job"
                        onChange={(event) => setGrantLabel(event.target.value)}
                        className={SETTINGS_FIELD_CLASS}
                      />
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {selectedScopes.map((scope) => (
                        <span
                          key={`selected-${scope}`}
                          title={getAgentGrantScopeLabel(scope)}
                          className="max-w-full rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] leading-4 text-fg-muted dark:bg-white/[0.07]"
                        >
                          {getAgentGrantScopeLabel(scope)}
                        </span>
                      ))}
                    </div>
                    <div>
                      <button
                        type="button"
                        aria-expanded={customPermissionsOpen}
                        onClick={() => setCustomPermissionsOpen((open) => !open)}
                        className={`${SETTINGS_SECONDARY_BUTTON_CLASS} inline-flex items-center gap-1.5 px-2 py-1 text-[11px]`}
                      >
                        <ChevronRotatableIcon
                          expanded={customPermissionsOpen}
                          className="h-3 w-3 flex-shrink-0"
                        />
                        Scopes
                      </button>
                    </div>

                    {customPermissionsOpen && (
                      <fieldset>
                        <legend className="mb-2 text-xs text-fg-muted">Permissions</legend>
                        <div className="grid grid-cols-1 gap-2">
                          {AGENT_GRANT_SCOPE_OPTIONS.map((scope) => {
                            const checked = selectedScopes.includes(scope.value);
                            return (
                              <label
                                key={scope.value}
                                className={`flex min-w-0 cursor-pointer gap-2 rounded-md p-2 transition-colors ${
                                  checked
                                    ? 'bg-accent/10'
                                    : 'bg-black/[0.035] hover:bg-black/[0.06] dark:bg-white/[0.045] dark:hover:bg-white/[0.075]'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={scope.label}
                                  checked={checked}
                                  onChange={() => toggleScope(scope.value)}
                                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-accent"
                                />
                                <span className="min-w-0">
                                  <span className="block text-[12px] font-medium text-fg">
                                    {scope.label}
                                  </span>
                                  <span className="block text-[10px] leading-4 text-fg-muted">
                                    {scope.description}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}

                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setFormOpen(false);
                          setGrantLabel('');
                          setSelectedScopes(DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES);
                          setCustomPermissionsOpen(false);
                          setCreatedKey(null);
                          resetCopy();
                        }}
                        className={SETTINGS_SECONDARY_BUTTON_CLASS}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!canCreate}
                        className={SETTINGS_PRIMARY_BUTTON_CLASS}
                      >
                        {creating ? 'Creating...' : 'Create'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        )}

        <div data-testid="agent-grants-list-shell">
          {loadingGrants ? (
            <p role="status" className="py-2 text-xs text-fg-muted">
              Loading access…
            </p>
          ) : grantStorePending ? (
            <p className="py-2 text-xs text-fg-muted">Access history is not available yet.</p>
          ) : externalGrants.length === 0 ? (
            <p className="py-2 text-xs text-fg-muted">No app or script access to review.</p>
          ) : (
            <div role="table" aria-label="External DNAForge tool callers" className="space-y-1.5">
              {productGrants.map((grant) => (
                <AgentGrantRow
                  key={grant.id}
                  grant={grant}
                  revoking={revokingId === grant.id}
                  onRevoke={handleRevoke}
                />
              ))}
              {developmentGrants.length > 0 && (
                <div className="space-y-1.5 pt-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-warning">
                    Development/test callers
                  </div>
                  {developmentGrants.map((grant) => (
                    <AgentGrantRow
                      key={grant.id}
                      grant={grant}
                      revoking={revokingId === grant.id}
                      onRevoke={handleRevoke}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {!grantStorePending && !loadingGrants && (
            <p className="pt-2 text-[11px] text-fg-muted">
              This list shows loaded active callers. It does not show the full access history. Local
              AI app access expires after 12 hours. Script keys have no automatic expiry. Remove
              revokes selected access; local apps can request access again.
            </p>
          )}
          {storeSnapshot.hasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                disabled={loadingMoreGrants}
                onClick={() => void loadMoreGrants()}
                className={SETTINGS_SECONDARY_BUTTON_CLASS}
              >
                {loadingMoreGrants ? 'Loading more...' : 'Load more callers'}
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="agent-grants-error"
          className="rounded-md bg-error/10 px-2.5 py-2 text-xs text-error"
        >
          {toUserMessage(error, 'assistant.failed')}
        </div>
      )}
    </div>
  );
}

export function AgentIntegrationsPanel(_: AgentIntegrationsPanelProps = {}) {
  return (
    <div className="h-full overflow-y-auto" data-testid="agent-integrations-panel">
      <div className="p-4">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-fg">Assistant</h2>
        </div>

        <div className="space-y-4">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-fg">Host</h3>
            <AssistantHostSettingsContent />
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold text-fg">Agent capabilities</h3>
            <AgentExtensionsPanel view="overview" />
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold text-fg">External Tool Access</h3>
            <ToolAccessSettingsContent />
          </section>
        </div>
      </div>
    </div>
  );
}
