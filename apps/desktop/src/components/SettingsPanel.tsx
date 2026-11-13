import { Button, Notice } from './ui';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import {
  RegistrySettingsContent,
  type RegistrySettingsTab,
} from '../features/lims/public/RegistrySettingsContent';
import {
  OrganizationRegistrationSettings,
  useOrganizationRegistrySchemaSources,
} from '../features/auth/public/registry-settings';
import { TerminalSettingsSection } from '../features/terminal/TerminalSettingsSection';
import { AppearanceSection } from './AppearanceSettingsSection';
import { useComputeStore } from '../features/compute/store';
import { SettingsSearch } from './SettingsSearch';
import {
  SETTINGS_SECTIONS,
  searchSettings,
  settingsRowProps,
  settingsSubsectionProps,
  type SettingsNavId,
  type SettingsSectionMeta,
  type SettingsSearchResult,
} from './settings-catalog';
import { AISettingsBoundary } from '../features/ai/AISettingsBoundary';
import { ComputeIntegrationsSection } from '../features/compute';

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useSettingsStore } from '../features/junction-workbench/settings';
import { PrimerCalculatorDrawer } from '../features/design/components/PrimerCalculatorDrawer';
import { useAISettingsStore } from '../features/ai/settings';
import { useChatRouteControls } from '../features/ai/hooks/useChatRouteControls';
import type { KeySource, ProviderStatus, ProviderModelState } from '../features/ai/settings';
import {
  PROVIDERS,
  getAllProviderMetas,
  type CustomProviderDefinition,
  type CustomProviderName,
  type ProviderMeta,
  type ProviderName,
} from '../features/ai/providers';
import { safeFocus } from '../shared/utils/safeFocus';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { KeyboardShortcutReference } from '../keyboard/KeyboardShortcutReference';
import { isHostedBrowserRuntime } from '../utils/environment';
import { AboutSettingsSection } from './AboutSettingsSection';
import {
  AgentExtensionsPanel,
  AssistantHostSettingsContent,
  ExternalMcpRegistrationIssues,
  ToolAccessSettingsContent,
} from '../features/agent-integrations';
import { DefaultRouteButton } from '../features/agent-integrations/DefaultRouteButton';
import type { AssistantHostId } from '../features/ai/assistant-hosts';
import { XIcon } from './icons';
import { MigrationSettingsContent, type MigrationSettingsView } from '../features/migrations';
import { FileHandlingSettings } from '../features/file-associations/FileHandlingSettings';
import { useAuthStore } from '../stores/auth-store';
import { AccountSettingsContent } from '../features/auth/AccountSettingsContent';
import { HostedContributionSettings } from './HostedContributionSettings';
import { OrganizationSettingsContent } from '../features/auth/OrganizationSettingsContent';
import {
  SETTINGS_CONTENT_WIDTH_CLASS,
  SETTINGS_DANGER_BUTTON_CLASS,
  SETTINGS_FIELD_CLASS,
  SETTINGS_FORM_GRID_CLASS,
  SETTINGS_FORM_WIDTH_CLASS,
  SETTINGS_PRIMARY_BUTTON_CLASS,
  SETTINGS_READONLY_FIELD_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SETTINGS_SPLIT_PANEL_EDITOR_CLASS,
  SETTINGS_SPLIT_PANEL_LIST_CLASS,
  SETTINGS_SPLIT_PANEL_CLASS,
  SETTINGS_SURFACE_CLASS,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSubsection,
  SettingsToggle,
  settingsSplitPanelTabClass,
} from './SettingsSubsection';
import {
  useOrganizationSettings,
  type OrganizationSettingsSection,
} from '../features/auth/useOrganizationSettings';

const DEFAULT_PROVIDER_STATUS: ProviderStatus = { isConfigured: false, keySource: 'none' };
const DEFAULT_PROVIDER_MODEL_STATE: ProviderModelState = {
  models: [],
  fetchStatus: 'idle',
  fetchError: null,
};

function StatusBadge({
  keySource,
  modelState,
  providerName,
}: {
  keySource: KeySource;
  modelState: ProviderModelState;
  providerName: ProviderName;
}) {
  if (keySource !== 'keyring') return null;

  const status =
    modelState.fetchStatus === 'loading'
      ? {
          label: 'Checking',
          title: 'Checking provider key',
          className: 'bg-warning/10 text-warning',
          icon: 'dot',
        }
      : modelState.fetchStatus === 'error'
        ? {
            label: 'Check failed',
            title: modelState.fetchError ?? 'Provider key check failed',
            className: 'bg-error/10 text-error',
            icon: 'x',
          }
        : modelState.fetchStatus === 'success'
          ? {
              label: 'Ready',
              title: 'Provider key check passed',
              className: 'bg-success/10 text-success',
              icon: 'check',
            }
          : {
              label: 'Keychain',
              title: 'Saved in the OS keychain',
              className: 'bg-success/10 text-success',
              icon: 'check',
            };

  return (
    <span
      data-testid={`direct-api-secret-status-${providerName}`}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] ${status.className}`}
      title={status.title}
    >
      {status.icon === 'x' ? (
        <XIcon className="h-2.5 w-2.5 flex-shrink-0" />
      ) : status.icon === 'dot' ? (
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current" />
      ) : (
        <svg
          className="flex-shrink-0"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      <span className="truncate">{status.label}</span>
    </span>
  );
}

export function ModelTextInput({
  model,
  defaultModel,
  onModelChange,
}: {
  model: string;
  defaultModel: string;
  onModelChange: (model: string) => void;
}) {
  const [draft, setDraft] = useState(model);
  useEffect(() => {
    setDraft(model);
  }, [model]);

  const commitDraft = () => {
    if (draft.trim() && draft.trim() !== model) onModelChange(draft.trim());
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitDraft}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitDraft();
      }}
      placeholder={defaultModel}
      data-testid="model-input"
      className={SETTINGS_FIELD_CLASS}
    />
  );
}

export function ModelPicker({
  model,
  modelState,
  status,
  defaultModel,
  onModelChange,
  onRetryFetch,
}: {
  model: string;
  modelState: ProviderModelState;
  status: ProviderStatus;
  defaultModel: string;
  onModelChange: (model: string) => void;
  onRetryFetch: () => void;
}) {
  if (!status.isConfigured) {
    return (
      <SettingsSelect
        disabled
        value="unavailable"
        options={[{ value: 'unavailable', label: 'Enter API key to see models' }]}
        onValueChange={() => {}}
        ariaLabel="Model"
        testId="model-input"
      />
    );
  }

  if (modelState.fetchStatus === 'loading') {
    return (
      <SettingsSelect
        disabled
        value="loading"
        options={[{ value: 'loading', label: 'Loading models…' }]}
        onValueChange={() => {}}
        ariaLabel="Model"
        testId="model-input"
      />
    );
  }

  if (modelState.fetchStatus === 'error') {
    return (
      <div className="min-w-0 space-y-1.5">
        <Notice
          tone="error"
          actions={
            <Button variant="link" onClick={onRetryFetch} data-testid="model-retry-button">
              Retry
            </Button>
          }
        >
          {modelState.fetchError}
        </Notice>
        <ModelTextInput model={model} defaultModel={defaultModel} onModelChange={onModelChange} />
      </div>
    );
  }

  if (modelState.fetchStatus === 'success' && modelState.models.length > 0) {
    return (
      <SettingsSelect
        value={model}
        onValueChange={onModelChange}
        options={Array.from(new Set([model, ...modelState.models]))
          .filter(Boolean)
          .map((value) => ({ value, label: value }))}
        ariaLabel="Model"
        testId="model-input"
      />
    );
  }

  if (modelState.fetchStatus === 'success' && modelState.models.length === 0) {
    return (
      <div className="min-w-0 space-y-1.5">
        <span className="block truncate whitespace-nowrap text-xs text-fg-muted">
          No models returned
        </span>
        <ModelTextInput model={model} defaultModel={defaultModel} onModelChange={onModelChange} />
      </div>
    );
  }

  return <ModelTextInput model={model} defaultModel={defaultModel} onModelChange={onModelChange} />;
}

function DirectApiKeyEditor({
  meta,
  onSave,
  onCancel,
}: {
  meta: ProviderMeta;
  onSave: (apiKey: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className={`mt-4 flex items-end gap-2 ${SETTINGS_FORM_WIDTH_CLASS}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!apiKey.trim()) return;
        setSaving(true);
        setError(null);
        void onSave(apiKey.trim())
          .catch((cause) => {
            setError(toUserMessage(cause, 'failure.could-not-save-api-key'));
          })
          .finally(() => setSaving(false));
      }}
    >
      <label className="min-w-0 flex-1 text-xs font-medium text-fg">
        API key
        <input
          type="password"
          aria-label={`${meta.label} API key`}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={meta.credential.placeholder}
          data-analytics-credential
          autoComplete="off"
          className={`${SETTINGS_FIELD_CLASS} mt-1.5 font-mono`}
          autoFocus
        />
        {error ? (
          <span className="mt-1 block text-xs text-error">
            {toUserMessage(error, 'operation.failed')}
          </span>
        ) : null}
      </label>
      <button
        type="button"
        onClick={onCancel}
        disabled={saving}
        className={SETTINGS_SECONDARY_BUTTON_CLASS}
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={saving || !apiKey.trim()}
        className={SETTINGS_PRIMARY_BUTTON_CLASS}
      >
        {saving ? 'Saving…' : 'Save key'}
      </button>
    </form>
  );
}

function CustomProviderEditor({
  definition,
  onSave,
  onCancel,
}: {
  definition?: CustomProviderDefinition;
  onSave: (
    input: { label: string; baseUrl: string; defaultModel: string },
    apiKey: string
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(definition?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(definition?.baseUrl ?? '');
  const [defaultModel, setDefaultModel] = useState(definition?.defaultModel ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEditing = Boolean(definition);

  return (
    <form
      aria-label={isEditing ? `Edit ${definition?.label}` : 'Add custom endpoint'}
      className={`rounded-md p-4 ${SETTINGS_SURFACE_CLASS}`}
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        void onSave({ label, baseUrl, defaultModel }, apiKey)
          .catch((cause) => {
            setError(toUserMessage(cause, 'failure.could-not-save-the-endpoint'));
          })
          .finally(() => setSaving(false));
      }}
    >
      <div className="mb-4">
        <h4 className="text-sm font-semibold text-fg">
          {isEditing ? 'Edit custom endpoint' : 'Custom endpoint'}
        </h4>
      </div>
      <div className={`gap-4 ${SETTINGS_FORM_GRID_CLASS} ${SETTINGS_FORM_WIDTH_CLASS}`}>
        <label className="text-xs font-medium text-fg">
          Name
          <input
            aria-label="Provider name"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Internal models"
            className={`${SETTINGS_FIELD_CLASS} mt-1.5`}
            required
          />
        </label>
        <label className="text-xs font-medium text-fg">
          Model
          <input
            aria-label="Provider model"
            value={defaultModel}
            onChange={(event) => setDefaultModel(event.target.value)}
            placeholder="model-id"
            className={`${SETTINGS_FIELD_CLASS} mt-1.5 font-mono`}
            required
          />
        </label>
        <label className="text-xs font-medium text-fg sm:col-span-2">
          Base URL
          <input
            type="url"
            aria-label="Provider base URL"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://models.example.com/v1"
            className={`${SETTINGS_FIELD_CLASS} mt-1.5 font-mono`}
            required
          />
        </label>
        <label className="text-xs font-medium text-fg sm:col-span-2">
          API key{isEditing ? ' (leave blank to keep the current key)' : ''}
          <input
            type="password"
            aria-label="Provider API key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={isEditing ? 'Keep current key' : 'Paste API key'}
            data-analytics-credential
            autoComplete="off"
            className={`${SETTINGS_FIELD_CLASS} mt-1.5 font-mono`}
            required={!isEditing}
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-error">
          {toUserMessage(error, 'operation.failed')}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className={SETTINGS_SECONDARY_BUTTON_CLASS}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={
            saving ||
            !label.trim() ||
            !baseUrl.trim() ||
            !defaultModel.trim() ||
            (!isEditing && !apiKey.trim())
          }
          className={SETTINGS_PRIMARY_BUTTON_CLASS}
        >
          {saving ? 'Saving…' : isEditing ? 'Save endpoint' : 'Add endpoint'}
        </button>
      </div>
    </form>
  );
}

function ProviderPicker({
  providers,
  onChoose,
  onChooseCustom,
}: {
  providers: readonly ProviderMeta[];
  onChoose: (name: ProviderName) => void;
  onChooseCustom: () => void;
}) {
  return (
    <div className="min-h-full py-6 pl-6" data-testid="direct-api-provider-picker">
      <h3 className="text-lg font-semibold tracking-tight text-fg">Add provider</h3>
      <div className={`mt-6 grid gap-1 ${SETTINGS_FORM_WIDTH_CLASS}`}>
        {providers.map((meta) => (
          <button
            key={meta.name}
            type="button"
            aria-label={meta.label}
            onClick={() => onChoose(meta.name)}
            className="flex items-center justify-between gap-4 rounded-md px-3 py-3 text-left transition-colors hover:bg-black/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 dark:hover:bg-white/[0.06]"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">{meta.label}</span>
              <span className="mt-0.5 block truncate text-xs text-fg-muted">
                Default model: {meta.defaultModel}
              </span>
            </span>
            <span className="shrink-0 text-xs font-medium text-accent">Add key</span>
          </button>
        ))}
      </div>
      {providers.length === 0 ? (
        <p className="mt-5 text-xs text-fg-subtle">All built-in providers are already added.</p>
      ) : null}
      <button
        type="button"
        onClick={onChooseCustom}
        className="mt-5 text-xs font-medium text-accent hover:underline"
      >
        Add custom OpenAI-compatible endpoint
      </button>
    </div>
  );
}

function DirectApiProviderEditor({
  meta,
  customDefinition,
  status,
  modelState,
  model,
  isActive,
  isHostActive,
  keyEditorOpen,
  keyringError,
  confirmRemove,
  onUse,
  onEditEndpoint,
  onEditKey,
  onDeleteKey,
  onRemoveCustom,
  onCancelKey,
  onSaveKey,
  onModelChange,
  onRetryFetch,
}: {
  meta: ProviderMeta;
  customDefinition?: CustomProviderDefinition;
  status: ProviderStatus;
  modelState: ProviderModelState;
  model: string;
  isActive: boolean;
  isHostActive: boolean;
  keyEditorOpen: boolean;
  keyringError: string | null;
  confirmRemove: boolean;
  onUse: () => void;
  onEditEndpoint?: () => void;
  onEditKey: () => void;
  onDeleteKey: () => void;
  onRemoveCustom?: () => void;
  onCancelKey: () => void;
  onSaveKey: (apiKey: string) => Promise<void>;
  onModelChange: (model: string) => void;
  onRetryFetch: () => void;
}) {
  const endpoint =
    customDefinition?.baseUrl ??
    ('baseUrl' in meta.modelDiscovery ? meta.modelDiscovery.baseUrl : `${meta.label} API`);

  return (
    <section
      className="min-h-full min-w-0 py-6 pl-6"
      data-testid={`direct-api-provider-${meta.name}`}
    >
      {}
      <div className="flex min-w-0 flex-col gap-4">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold tracking-tight text-fg">{meta.label}</h3>
          <p className="mt-1 max-w-2xl truncate text-sm text-fg-muted">{endpoint}</p>
          <div className="mt-2 flex items-center gap-2">
            {status.keySource === 'env' ? (
              <span className="text-xs text-fg-muted">Environment key</span>
            ) : status.isConfigured ? (
              <StatusBadge
                keySource={status.keySource}
                modelState={modelState}
                providerName={meta.name}
              />
            ) : (
              <span className="text-xs text-warning">Needs API key</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status.isConfigured ? (
            <DefaultRouteButton
              isDefault={isActive && isHostActive}
              onClick={onUse}
              testId={`direct-api-provider-default-${meta.name}`}
            />
          ) : null}
          {onEditEndpoint ? (
            <button
              type="button"
              onClick={onEditEndpoint}
              className={SETTINGS_SECONDARY_BUTTON_CLASS}
            >
              Edit endpoint
            </button>
          ) : null}
          {status.keySource !== 'env' ? (
            <button type="button" onClick={onEditKey} className={SETTINGS_SECONDARY_BUTTON_CLASS}>
              {status.isConfigured ? 'Replace key' : 'Add key'}
            </button>
          ) : null}
        </div>
      </div>

      {keyEditorOpen ? (
        <DirectApiKeyEditor meta={meta} onCancel={onCancelKey} onSave={onSaveKey} />
      ) : null}

      {isActive && status.isConfigured ? (
        <div className={`mt-5 ${SETTINGS_FORM_WIDTH_CLASS}`}>
          <label className="text-xs font-medium text-fg">Model</label>
          <div className="mt-1.5">
            <ModelPicker
              model={model}
              defaultModel={meta.defaultModel}
              modelState={modelState}
              status={status}
              onModelChange={onModelChange}
              onRetryFetch={onRetryFetch}
            />
          </div>
        </div>
      ) : status.isConfigured ? (
        <div className={`mt-5 ${SETTINGS_FORM_WIDTH_CLASS}`}>
          <div className="text-xs font-medium text-fg">Current model</div>
          <p className="mt-1.5 text-sm text-fg-muted">{meta.defaultModel}</p>
        </div>
      ) : null}

      {isActive && keyringError ? (
        <p className="mt-3 text-xs text-error">{toUserMessage(keyringError, 'operation.failed')}</p>
      ) : null}

      {}
      {onRemoveCustom ? (
        <div className="mt-6">
          <button type="button" onClick={onRemoveCustom} className={SETTINGS_DANGER_BUTTON_CLASS}>
            {confirmRemove ? 'Confirm remove' : 'Remove'}
          </button>
        </div>
      ) : status.keySource === 'keyring' ? (
        <div className="mt-6">
          <button type="button" onClick={onDeleteKey} className={SETTINGS_DANGER_BUTTON_CLASS}>
            Remove key
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ApiKeysSettingsContent({
  sectionRef,
  isHostActive,
}: {
  sectionRef?: React.Ref<HTMLDivElement>;
  isHostActive: boolean;
}) {
  const {
    provider,
    model,
    providerStatuses,
    providerModels,
    customProviders = [],
    keyringError,
    setProvider,
    setModel,
    setApiKey,
    deleteApiKey,
    retryFetchModels,
    refreshProviderStatuses,
    addCustomProvider,
    updateCustomProvider,
    removeCustomProvider,
  } = useAISettingsStore();
  const [addOpen, setAddOpen] = useState(false);
  const [pendingProviderName, setPendingProviderName] = useState<ProviderName | null>(null);
  const [editingKey, setEditingKey] = useState<ProviderName | null>(null);
  const [customEditor, setCustomEditor] = useState<'new' | CustomProviderName | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<CustomProviderName | null>(null);
  const [selectedProviderName, setSelectedProviderName] = useState<ProviderName | null>(null);

  useEffect(() => {
    refreshProviderStatuses();
  }, [refreshProviderStatuses]);

  const allProviders = useMemo(() => getAllProviderMetas(), [customProviders]);
  const customById = useMemo(
    () => new Map(customProviders.map((definition) => [definition.id, definition])),
    [customProviders]
  );
  const visibleProviders = allProviders.filter(
    (meta) =>
      meta.name.startsWith('custom:') ||
      providerStatuses[meta.name]?.isConfigured ||
      pendingProviderName === meta.name
  );
  const availableBuiltIns = PROVIDERS.filter(
    (meta) => !providerStatuses[meta.name]?.isConfigured && pendingProviderName !== meta.name
  );
  const editingDefinition =
    customEditor && customEditor !== 'new' ? customById.get(customEditor) : undefined;

  const selectedProvider =
    (selectedProviderName && allProviders.find((meta) => meta.name === selectedProviderName)) ||
    (provider && visibleProviders.find((meta) => meta.name === provider)) ||
    visibleProviders[0];
  const selectedProviderStatus = selectedProvider
    ? (providerStatuses[selectedProvider.name] ?? DEFAULT_PROVIDER_STATUS)
    : DEFAULT_PROVIDER_STATUS;
  const selectedProviderModelState = selectedProvider
    ? (providerModels[selectedProvider.name] ?? DEFAULT_PROVIDER_MODEL_STATE)
    : DEFAULT_PROVIDER_MODEL_STATE;
  const selectedCustomDefinition = selectedProvider
    ? customById.get(selectedProvider.name as CustomProviderName)
    : undefined;

  useEffect(() => {
    if (
      selectedProviderName &&
      visibleProviders.some((meta) => meta.name === selectedProviderName)
    ) {
      return;
    }
    setSelectedProviderName(
      (provider && visibleProviders.some((meta) => meta.name === provider) ? provider : null) ??
        visibleProviders[0]?.name ??
        null
    );
  }, [provider, selectedProviderName, visibleProviders]);

  const selectProvider = (name: ProviderName) => {
    setSelectedProviderName(name);
    setEditingKey(null);
    setCustomEditor(null);
    setAddOpen(false);
    setConfirmRemove(null);
  };

  const openAddProvider = () => {
    setAddOpen(true);
    setEditingKey(null);
    setCustomEditor(null);
    setConfirmRemove(null);
  };

  return (
    <div ref={sectionRef} data-testid="settings-api-keys-config" className="h-full min-w-0">
      <div
        className={`h-full ${SETTINGS_SPLIT_PANEL_CLASS}`}
        data-testid="settings-direct-api-shell"
      >
        <div className="flex min-h-0 min-w-0 flex-col">
          <div
            role="tablist"
            aria-label="Direct API providers"
            className={SETTINGS_SPLIT_PANEL_LIST_CLASS}
            data-testid="settings-direct-api-providers"
          >
            {visibleProviders.length === 0 ? (
              <p className="px-3 py-4 text-xs leading-5 text-fg-subtle">
                Add a provider to use your own model key.
              </p>
            ) : (
              visibleProviders.map((meta) => {
                const status = providerStatuses[meta.name] ?? DEFAULT_PROVIDER_STATUS;
                const modelState = providerModels[meta.name] ?? DEFAULT_PROVIDER_MODEL_STATE;
                const isSelected = selectedProvider?.name === meta.name;
                const isActive = isHostActive && provider === meta.name;
                const statusLabel =
                  status.keySource === 'env'
                    ? 'Environment key'
                    : !status.isConfigured
                      ? 'Needs key'
                      : modelState.fetchStatus === 'loading'
                        ? 'Checking'
                        : modelState.fetchStatus === 'error'
                          ? 'Check failed'
                          : 'Ready';
                return (
                  <button
                    key={meta.name}
                    type="button"
                    role="tab"
                    id={`direct-api-tab-${meta.name}`}
                    aria-controls="settings-direct-api-editor"
                    aria-selected={isSelected}
                    onClick={() => selectProvider(meta.name)}
                    className={settingsSplitPanelTabClass(isSelected)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{meta.label}</span>
                      <span
                        className={`mt-1 block text-[11px] ${
                          status.isConfigured && modelState.fetchStatus !== 'error'
                            ? 'text-success'
                            : status.isConfigured
                              ? 'text-error'
                              : 'text-warning'
                        }`}
                      >
                        {statusLabel}
                      </span>
                    </span>
                    {isActive ? (
                      <span className="ml-2 shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                        Active
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <div className="shrink-0 p-2">
            <button
              type="button"
              onClick={openAddProvider}
              aria-expanded={addOpen}
              className={`${SETTINGS_SECONDARY_BUTTON_CLASS} flex w-full items-center justify-center`}
            >
              Add provider
            </button>
          </div>
        </div>

        <div
          id="settings-direct-api-editor"
          role="tabpanel"
          aria-label={addOpen ? 'Add provider' : selectedProvider?.label}
          aria-labelledby={
            addOpen
              ? undefined
              : selectedProvider
                ? `direct-api-tab-${selectedProvider.name}`
                : undefined
          }
          className={`h-full ${SETTINGS_SPLIT_PANEL_EDITOR_CLASS}`}
          data-testid="settings-direct-api-editor"
        >
          {addOpen ? (
            <ProviderPicker
              providers={availableBuiltIns}
              onChoose={(name) => {
                setPendingProviderName(name);
                setEditingKey(name);
                setSelectedProviderName(name);
                setAddOpen(false);
              }}
              onChooseCustom={() => {
                setCustomEditor('new');
                setSelectedProviderName(null);
                setAddOpen(false);
              }}
            />
          ) : customEditor ? (
            <CustomProviderEditor
              key={customEditor}
              definition={editingDefinition}
              onCancel={() => setCustomEditor(null)}
              onSave={async (input, apiKey) => {
                if (customEditor === 'new') {
                  const id = await addCustomProvider(input, apiKey);
                  setSelectedProviderName(id);
                } else {
                  await updateCustomProvider(customEditor, input, apiKey || undefined);
                  setSelectedProviderName(customEditor);
                }
                setCustomEditor(null);
              }}
            />
          ) : selectedProvider ? (
            <DirectApiProviderEditor
              meta={selectedProvider}
              customDefinition={selectedCustomDefinition}
              status={selectedProviderStatus}
              modelState={selectedProviderModelState}
              model={model}
              isActive={provider === selectedProvider.name}
              isHostActive={isHostActive}
              keyEditorOpen={editingKey === selectedProvider.name}
              keyringError={provider === selectedProvider.name ? keyringError : null}
              confirmRemove={confirmRemove === selectedCustomDefinition?.id}
              onUse={() => void setProvider(selectedProvider.name)}
              onEditEndpoint={
                selectedCustomDefinition
                  ? () => setCustomEditor(selectedCustomDefinition.id)
                  : undefined
              }
              onEditKey={() => setEditingKey(selectedProvider.name)}
              onDeleteKey={() => void deleteApiKey(selectedProvider.name)}
              onRemoveCustom={
                selectedCustomDefinition
                  ? () => {
                      if (confirmRemove === selectedCustomDefinition.id) {
                        void removeCustomProvider(selectedCustomDefinition.id);
                        setConfirmRemove(null);
                        setSelectedProviderName(null);
                      } else {
                        setConfirmRemove(selectedCustomDefinition.id);
                      }
                    }
                  : undefined
              }
              onCancelKey={() => {
                setEditingKey(null);
                if (pendingProviderName === selectedProvider.name) setPendingProviderName(null);
              }}
              onSaveKey={async (apiKey) => {
                await setApiKey(selectedProvider.name, apiKey);
                setEditingKey(null);
                setPendingProviderName(null);
              }}
              onModelChange={(nextModel) => void setModel(nextModel)}
              onRetryFetch={() => void retryFetchModels(selectedProvider.name)}
            />
          ) : (
            <div className="grid h-full place-items-center p-8">
              <p className="max-w-xs text-center text-xs leading-5 text-fg-muted">
                Choose a provider to store its key and model settings in this profile.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HostedAISettingsContent({ assistantRef }: { assistantRef?: React.Ref<HTMLDivElement> }) {
  const controls = useChatRouteControls({});
  return (
    <SettingsSubsection title="Hosted AI" testId="settings-ai-hosted" subsectionRef={assistantRef}>
      <div className="flex flex-wrap items-center gap-2">
        {controls.renderAssistantRouteSelector()}
        {controls.renderRouteCheckingStatus()}
        {controls.renderRouteConfigurationPrompt()}
      </div>
      {controls.renderConnectAiModal()}
    </SettingsSubsection>
  );
}

function AISettingsSection({
  sectionRef,
  assistantRef,
  apiKeysRef,
  toolAccessRef,
  conversationId,
  focusedHostId,
}: {
  sectionRef?: React.Ref<HTMLDivElement>;
  assistantRef?: React.Ref<HTMLDivElement>;
  apiKeysRef?: React.Ref<HTMLDivElement>;
  toolAccessRef?: React.Ref<HTMLDivElement>;
  conversationId?: string | null;
  focusedHostId?: AssistantHostId | null;
}) {
  const hostedBrowserRuntime = isHostedBrowserRuntime();
  return (
    <AISettingsBoundary>
      <SettingsSection
        id="settings-ai"
        title={SETTINGS_SECTIONS['ai'].label}
        testId="settings-section-ai"
        sectionRef={sectionRef}
        flushTop
      >
        {hostedBrowserRuntime ? (
          <HostedAISettingsContent assistantRef={assistantRef} />
        ) : (
          <>
            <SettingsSubsection
              {...settingsSubsectionProps('ai-host')}
              testId="settings-ai-host"
              subsectionRef={assistantRef}
            >
              <AssistantHostSettingsContent
                focusHostId={focusedHostId}
                directApiSettings={(isHostActive) => (
                  <ApiKeysSettingsContent sectionRef={apiKeysRef} isHostActive={isHostActive} />
                )}
              />
            </SettingsSubsection>
            <SettingsSubsection
              {...settingsSubsectionProps('ai-skills')}
              testId="settings-ai-agent-capabilities"
            >
              <AgentExtensionsPanel conversationId={conversationId} view="overview" />
            </SettingsSubsection>
            <SettingsSubsection
              {...settingsSubsectionProps('app-permissions')}
              testId="settings-ai-tool-access"
              subsectionRef={toolAccessRef}
            >
              <ExternalMcpRegistrationIssues />
              <ToolAccessSettingsContent />
            </SettingsSubsection>
          </>
        )}
      </SettingsSection>
    </AISettingsBoundary>
  );
}

function displayProjectPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function WorkspaceSection({
  onChangeWorkspace,
  sectionRef,
}: {
  onChangeWorkspace?: () => void;
  sectionRef?: React.Ref<HTMLDivElement>;
}) {
  const { folders } = useWorkspaceStore();

  return (
    <SettingsSection
      id="settings-workspace"
      title={SETTINGS_SECTIONS['workspace'].label}
      testId="settings-section-workspace"
      sectionRef={sectionRef}
      flushTop
    >
      {folders.length === 0 ? (
        <p className="text-sm text-fg-muted" data-testid="settings-workspace-empty">
          No open projects.
        </p>
      ) : (
        <ul
          data-analytics-block
          className="ph-no-capture space-y-2"
          data-testid="settings-workspace-list"
        >
          {folders.map((folder) => (
            <li
              key={folder.path}
              className={`flex items-start justify-between gap-3 rounded-md px-3 py-3 ${SETTINGS_SURFACE_CLASS}`}
              data-testid="settings-workspace-project"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg">{folder.name}</span>
                <span
                  className="mt-0.5 block break-all font-mono text-xs leading-5 text-fg-muted"
                  title={folder.path}
                >
                  {displayProjectPath(folder.path)}
                </span>
              </span>
              {folder.pinned ? (
                <span className="shrink-0 pt-0.5 text-xs text-fg-muted">Reference</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {onChangeWorkspace ? (
        <button
          type="button"
          onClick={onChangeWorkspace}
          data-testid="change-workspace-button"
          className={SETTINGS_SECONDARY_BUTTON_CLASS}
        >
          Import project
        </button>
      ) : null}
    </SettingsSection>
  );
}

function EditorSection({ sectionRef }: { sectionRef?: React.Ref<HTMLDivElement> }) {
  return (
    <SettingsSection
      id="settings-editor"
      title={SETTINGS_SECTIONS['editor'].label}
      testId="settings-section-editor"
      sectionRef={sectionRef}
      flushTop
    >
      <p className="text-xs font-medium text-fg-muted">Coming soon</p>
      <div className="opacity-50 pointer-events-none space-y-4">
        <SettingsRow {...settingsRowProps('font-family')}>
          <div className={`${SETTINGS_READONLY_FIELD_CLASS} flex items-center font-mono`}>
            SF Mono
          </div>
        </SettingsRow>

        <SettingsRow {...settingsRowProps('tab-size')}>
          <SettingsSelect
            disabled
            value="2"
            onValueChange={() => {}}
            options={[
              { value: '2', label: '2 spaces' },
              { value: '4', label: '4 spaces' },
            ]}
            ariaLabel="Tab Size"
          />
        </SettingsRow>

        <SettingsToggle
          {...settingsRowProps('word-wrap')}
          disabledReason={userMessage('settings.notAvailableYet')}
          checked={true}
          onChange={() => {}}
          disabled
        />
      </div>
    </SettingsSection>
  );
}

function KeyboardShortcutsSection({ sectionRef }: { sectionRef?: React.Ref<HTMLDivElement> }) {
  return (
    <SettingsSection
      id="settings-shortcuts"
      title="Keyboard Shortcuts"
      testId="settings-section-shortcuts"
      sectionRef={sectionRef}
      flushTop
    >
      <KeyboardShortcutReference />
    </SettingsSection>
  );
}

interface SettingsPanelProps {
  conversationId?: string | null;
  onChangeWorkspace?: () => void;
  focusTarget?: SettingsPanelFocusTarget | null;
  onFocusTargetHandled?: () => void;

  onOpenReleaseNotes?: (sourceElement?: HTMLElement) => void;
  migrationSettings?: MigrationSettingsView;
}

export type SettingsPanelFocusTarget =
  | 'agent-access'
  | `compute-provider:${string}`
  | 'registry'
  | 'terminal'
  | 'terminal-profiles'
  | 'file-handling'
  | 'usage-analytics'
  | 'api-keys'
  | 'assistant'
  | 'account'
  | 'privacy'
  | 'migrations'
  | 'primer-tm'
  | 'organizations'
  | `assistant-host:${AssistantHostId}`;

function getAssistantHostFocusRowTestId(focusTarget: SettingsPanelFocusTarget): string | null {
  if (!focusTarget.startsWith('assistant-host:')) return null;
  const hostId = focusTarget.slice('assistant-host:'.length);
  if (hostId === 'direct-api') return 'assistant-host-tab-direct-api';
  if (hostId === 'codex-cli') return 'assistant-host-row-codex-sdk';
  if (hostId === 'claude-code') return 'assistant-host-row-claude-agent-sdk';
  if (hostId === 'grok-cli') return 'assistant-host-row-grok-acp';
  return null;
}

function PrimerTmSettingsSection({ sectionRef }: { sectionRef?: React.Ref<HTMLDivElement> }) {
  const tmModel = useSettingsStore((s) => s.tmModel);
  const setTmModel = useSettingsStore((s) => s.setTmModel);
  const primerConcNm = useSettingsStore((s) => s.primerConcNm);
  const setPrimerConcNm = useSettingsStore((s) => s.setPrimerConcNm);
  const tmConditions = useSettingsStore((s) => s.tmConditions);
  const setTmConditions = useSettingsStore((s) => s.setTmConditions);
  const resetPrimerTmSettings = useSettingsStore((s) => s.resetPrimerTmSettings);
  return (
    <SettingsSection
      id="primer-tm"
      title={SETTINGS_SECTIONS['primer-tm'].label}
      testId="settings-section-primer-tm"
      sectionRef={sectionRef}
      flushTop
    >
      <PrimerCalculatorDrawer
        tmModel={tmModel}
        onChangeModel={setTmModel}
        concNm={primerConcNm}
        onChangeConcNm={setPrimerConcNm}
        conditions={tmConditions}
        onChangeConditions={setTmConditions}
        onReset={resetPrimerTmSettings}
      />
    </SettingsSection>
  );
}

function TerminalNavIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </svg>
  );
}

const APP_NAV_ITEMS = [
  { id: 'ai', label: SETTINGS_SECTIONS['ai'].label, icon: SparkIcon },
  { id: 'integrations', label: SETTINGS_SECTIONS['integrations'].label, icon: PlugIcon },
  { id: 'workspace', label: SETTINGS_SECTIONS['workspace'].label, icon: FolderIcon },
  { id: 'file-handling', label: SETTINGS_SECTIONS['file-handling'].label, icon: FolderIcon },
  { id: 'migrations', label: SETTINGS_SECTIONS['migrations'].label, icon: ArrowIcon },
  { id: 'appearance', label: SETTINGS_SECTIONS['appearance'].label, icon: PaletteIcon },
  { id: 'terminal', label: SETTINGS_SECTIONS['terminal'].label, icon: TerminalNavIcon },
  { id: 'editor', label: SETTINGS_SECTIONS['editor'].label, icon: EditNavIcon },
  { id: 'shortcuts', label: SETTINGS_SECTIONS['shortcuts'].label, icon: KeyboardIcon },
  { id: 'about', label: SETTINGS_SECTIONS['about'].label, icon: InfoIcon },
] as const;

const SCIENCE_NAV_ITEMS = [
  { id: 'primer-tm', label: SETTINGS_SECTIONS['primer-tm'].label, icon: ThermometerIcon },
] as const;
function UserIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  );
}
function SparkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M9.2 2.6c.25-.8 1.35-.8 1.6 0l1.05 3.4a2.2 2.2 0 0 0 1.45 1.45l3.4 1.05c.8.25.8 1.35 0 1.6l-3.4 1.05a2.2 2.2 0 0 0-1.45 1.45l-1.05 3.4c-.25.8-1.35.8-1.6 0l-1.05-3.4a2.2 2.2 0 0 0-1.45-1.45l-3.4-1.05c-.8-.25-.8-1.35 0-1.6l3.4-1.05a2.2 2.2 0 0 0 1.45-1.45L9.2 2.6Z" />
      <path d="M17.7 14.2c.16-.5.84-.5 1 0l.45 1.45c.1.32.35.57.67.67l1.45.45c.5.16.5.84 0 1l-1.45.45a1.1 1.1 0 0 0-.67.67l-.45 1.45c-.16.5-.84.5-1 0l-.45-1.45a1.1 1.1 0 0 0-.67-.67l-1.45-.45c-.5-.16-.5-.84 0-1l1.45-.45c.32-.1.57-.35.67-.67l.45-1.45Z" />
    </svg>
  );
}
function PlugIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 01-5 5 5 5 0 01-5-5V8zM12 16v6" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  );
}
function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M7 17L17 7M8 7h9v9" />
    </svg>
  );
}
function PaletteIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M12 3a9 9 0 100 18 2.2 2.2 0 002.2-2.2c0-.8-.4-1.2-.9-1.7-.5-.5-.9-.9-.9-1.7A3.4 3.4 0 0115.8 12 9 9 0 0012 3z" />
      <circle cx="7.5" cy="10" r="1" fill="currentColor" />
      <circle cx="10.5" cy="7.5" r="1" fill="currentColor" />
      <circle cx="14.5" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}
function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6l8-3z" />
    </svg>
  );
}
function EditNavIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
    </svg>
  );
}
function ThermometerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M10 14.5V6.5a2 2 0 114 0v8a3.5 3.5 0 11-4 0z" />
    </svg>
  );
}
function KeyboardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M7 11h.01M11 11h.01M15 11h.01M8 15h8" />
    </svg>
  );
}
function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
function BuildingIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M4 21V5a1 1 0 011-1h8a1 1 0 011 1v16M14 9h5a1 1 0 011 1v11M8 8h2M8 12h2M8 16h2M17 13h1M17 16h1M3 21h18" />
    </svg>
  );
}
function UsersIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0111 0M17 11a3 3 0 10-2.2-5M16.5 19a5.2 5.2 0 00-1.8-3.7" />
    </svg>
  );
}
function ListIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}
function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function isAccountOrOrganizationSection(section: SettingsNavId): boolean {
  return section === 'account' || section === 'privacy' || section.startsWith('organization-');
}

function SettingsNavGroup({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="pt-5 first:pt-0" data-testid={`settings-nav-group-${id}`}>
      <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
        {label}
      </p>
      {children}
    </div>
  );
}

function SettingsNavButton({
  id,
  label,
  icon: Icon,
  active,
  onClick,
}: {
  id: string;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'location' : undefined}
      data-testid={`settings-nav-${id}`}
      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
        active ? 'bg-bg-muted text-fg' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

export function SettingsPanel({
  conversationId,
  onChangeWorkspace,
  focusTarget,
  onFocusTargetHandled,
  onOpenReleaseNotes,
  migrationSettings,
}: SettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDestination, setSearchDestination] = useState<SettingsSearchResult | null>(null);
  const aiRef = useRef<HTMLDivElement>(null);
  const integrationsRef = useRef<HTMLDivElement | null>(null);
  const assistantRef = useRef<HTMLDivElement>(null);
  const apiKeysRef = useRef<HTMLDivElement>(null);
  const toolAccessRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const fileHandlingRef = useRef<HTMLDivElement>(null);
  const migrationsRef = useRef<HTMLDivElement>(null);
  const appearanceRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const primerTmRef = useRef<HTMLDivElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const aboutRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsNavId>('ai');
  const computeProviders = useComputeStore((state) => state.providers);
  const authState = useAuthStore((s) => s.state);
  const signedIn = authState.status === 'signed-in';
  const session = authState.status === 'signed-in' ? authState.session : null;
  const org = useOrganizationSettings({ enabled: signedIn, accountId: session?.accountId ?? null });
  const registrySources = useOrganizationRegistrySchemaSources({
    accountId: session?.accountId ?? null,
    organizations: org.organizations,
    refreshRevision: org.registry?.state.cursor,
  });
  const [registryTab, setRegistryTab] = useState<RegistrySettingsTab>('schemas');
  const setCreatingOrganization = org.setCreating;
  const settingsNavItems = useMemo(
    () =>
      APP_NAV_ITEMS.filter((item) => {
        if ((item.id === 'file-handling' || item.id === 'terminal') && isHostedBrowserRuntime())
          return false;
        if (item.id === 'migrations' && !migrationSettings) return false;
        return true;
      }),
    [migrationSettings]
  );

  const selectSection = useCallback(
    (section: SettingsNavId) => {
      setSearchQuery('');
      setSearchDestination(null);
      setCreatingOrganization(section === 'organization-create');
      setActiveSection(section);
    },
    [setCreatingOrganization]
  );

  useEffect(() => {
    if (signedIn) return;
    setActiveSection((current) => (isAccountOrOrganizationSection(current) ? 'ai' : current));
  }, [signedIn]);

  useEffect(() => {
    if (!focusTarget) return;

    if (focusTarget.startsWith('compute-provider:') || focusTarget === 'agent-access') {
      selectSection(focusTarget === 'agent-access' ? 'ai' : 'integrations');
      const timer = window.setTimeout(() => {
        const target =
          focusTarget === 'agent-access'
            ? toolAccessRef.current
            : integrationsRef.current?.querySelector<HTMLElement>(
                `[data-settings-target="${CSS.escape(`compute-provider-${focusTarget.slice('compute-provider:'.length)}`)}"]`
              );
        target?.scrollIntoView({ block: 'start' });
        safeFocus(target?.querySelector<HTMLElement>('button, input'), { preventScroll: true });
        onFocusTargetHandled?.();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (focusTarget === 'registry') {
      setRegistryTab('schemas');
      selectSection('registry');
      onFocusTargetHandled?.();
      return;
    }

    if (focusTarget === 'terminal' || focusTarget === 'terminal-profiles') {
      if (isHostedBrowserRuntime()) return;
      selectSection('terminal');
      const timer = window.setTimeout(() => {
        const target = panelRef.current?.querySelector<HTMLElement>(
          focusTarget === 'terminal-profiles'
            ? '[data-testid="terminal-settings-profiles"]'
            : '[data-testid="settings-section-terminal"]'
        );
        target?.scrollIntoView({ block: 'start' });
        safeFocus(target?.querySelector<HTMLElement>('button, input, textarea'), {
          preventScroll: true,
        });
        onFocusTargetHandled?.();
      }, 0);
      return () => window.clearTimeout(timer);
    }

    if (focusTarget === 'file-handling') {
      if (isHostedBrowserRuntime()) return;
      selectSection('file-handling');
      const timer = window.setTimeout(() => {
        safeFocus(fileHandlingRef.current?.querySelector<HTMLElement>('button'), {
          preventScroll: true,
        });
        onFocusTargetHandled?.();
      }, 0);
      return () => window.clearTimeout(timer);
    }

    if (focusTarget === 'usage-analytics') {
      if (isHostedBrowserRuntime()) return;
      selectSection('about');
      const timer = window.setTimeout(() => {
        safeFocus(
          aboutRef.current?.querySelector<HTMLElement>(
            '[data-testid="settings-usage-analytics"] [role="switch"]'
          ),
          { preventScroll: true }
        );
        onFocusTargetHandled?.();
      }, 0);
      return () => window.clearTimeout(timer);
    }

    if (focusTarget === 'account' || focusTarget === 'privacy') {
      if (!signedIn) return;
      selectSection(focusTarget);
      onFocusTargetHandled?.();
      return;
    }

    if (focusTarget === 'organizations') {
      if (!org.loaded || org.loading) return;
      selectSection(
        org.organizations.length === 0 ? 'organization-create' : 'organization-general'
      );
      onFocusTargetHandled?.();
      return;
    }

    const sectionForFocus: SettingsNavId =
      focusTarget === 'primer-tm'
        ? 'primer-tm'
        : focusTarget === 'migrations'
          ? 'migrations'
          : 'ai';
    selectSection(sectionForFocus);

    const timer = window.setTimeout(() => {
      if (focusTarget === 'primer-tm') {
        safeFocus(primerTmRef.current?.querySelector<HTMLElement>('button, select, input'), {
          preventScroll: true,
        });
        onFocusTargetHandled?.();
        return;
      }
      if (focusTarget === 'migrations') {
        safeFocus(migrationsRef.current?.querySelector<HTMLElement>('button, select, input'), {
          preventScroll: true,
        });
        onFocusTargetHandled?.();
        return;
      }
      const hostRowTestId = getAssistantHostFocusRowTestId(focusTarget);
      const section = focusTarget === 'api-keys' ? apiKeysRef.current : assistantRef.current;
      const hostRow = hostRowTestId
        ? section?.querySelector<HTMLElement>(`[data-testid="${hostRowTestId}"]`)
        : null;
      if (hostRow) {
        safeFocus(hostRow, { preventScroll: true });
        onFocusTargetHandled?.();
        return;
      }
      const focusTargetElement = section?.querySelector<HTMLElement>('button, input');
      safeFocus(focusTargetElement, { preventScroll: true });
      onFocusTargetHandled?.();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    focusTarget,
    onFocusTargetHandled,
    org.loaded,
    org.loading,
    org.organizations.length,
    selectSection,
    signedIn,
  ]);

  const orgSection: OrganizationSettingsSection | null =
    activeSection === 'organization-create'
      ? 'create'
      : activeSection === 'organization-sync-health'
        ? 'sync-health'
        : activeSection === 'organization-provisioning'
          ? 'provisioning'
          : activeSection === 'organization-members'
            ? 'members'
            : activeSection === 'organization-invitations'
              ? 'invitations'
              : activeSection === 'organization-audit'
                ? 'audit'
                : activeSection === 'organization-general'
                  ? 'general'
                  : null;

  const organizationPermissionsReady =
    org.loaded && !org.loading && org.directory?.orgId === org.selectedOrgId;

  const navigationGroups: Array<{
    id: string;
    label: string;
    items: Array<{
      id: SettingsNavId;
      label: string;
      icon: (props: { className?: string }) => ReactNode;
    }>;
  }> = [
    ...(signedIn
      ? [
          {
            id: 'account',
            label: 'Account',
            items: [
              { id: 'account' as const, label: SETTINGS_SECTIONS['account'].label, icon: UserIcon },
              {
                id: 'privacy' as const,
                label: SETTINGS_SECTIONS['privacy'].label,
                icon: ShieldIcon,
              },
            ],
          },
        ]
      : []),
    { id: 'app', label: 'App', items: settingsNavItems },
    {
      id: 'features',
      label: 'Features',
      items: [{ id: 'registry', label: SETTINGS_SECTIONS.registry.label, icon: ListIcon }],
    },
    { id: 'science', label: 'Science', items: [...SCIENCE_NAV_ITEMS] },
    ...(signedIn
      ? [
          {
            id: 'organization',
            label: 'Organization',
            items: [
              ...(org.organizations.length > 0
                ? [
                    {
                      id: 'organization-general' as const,
                      label: SETTINGS_SECTIONS['organization-general'].label,
                      icon: BuildingIcon,
                    },
                    ...(organizationPermissionsReady && org.selected?.isAdministrator
                      ? [
                          {
                            id: 'organization-sync-health' as const,
                            label: SETTINGS_SECTIONS['organization-sync-health'].label,
                            icon: ArrowIcon,
                          },
                        ]
                      : []),
                    {
                      id: 'organization-members' as const,
                      label: SETTINGS_SECTIONS['organization-members'].label,
                      icon: UsersIcon,
                    },
                    ...(organizationPermissionsReady && org.selected?.isAdministrator
                      ? [
                          {
                            id: 'organization-provisioning' as const,
                            label: SETTINGS_SECTIONS['organization-provisioning'].label,
                            icon: ShieldIcon,
                          },
                        ]
                      : []),
                    ...(organizationPermissionsReady && org.canViewAudit
                      ? [
                          {
                            id: 'organization-audit' as const,
                            label: SETTINGS_SECTIONS['organization-audit'].label,
                            icon: ListIcon,
                          },
                        ]
                      : []),
                  ]
                : []),
              {
                id: 'organization-create' as const,
                label: SETTINGS_SECTIONS['organization-create'].label,
                icon: PlusIcon,
              },
            ],
          },
        ]
      : []),
  ];
  const navigationItems = navigationGroups.flatMap((group) =>
    group.items.map((item) => ({
      ...item,
      group: group.label,
    }))
  );
  const activeSectionAvailable = navigationItems.some((item) => item.id === activeSection);
  useEffect(() => {
    if (!signedIn || !org.loaded || org.loading || !activeSection.startsWith('organization-')) {
      return;
    }

    if (org.selectedOrgId && org.directory?.orgId !== org.selectedOrgId) return;
    if (!activeSectionAvailable) {
      selectSection(org.selectedOrgId ? 'organization-general' : 'organization-create');
    }
  }, [
    signedIn,
    org.loaded,
    org.loading,
    org.selectedOrgId,
    org.directory?.orgId,
    activeSection,
    activeSectionAvailable,
    selectSection,
  ]);
  const permittedSections = navigationItems.map((item) => item.id);
  const searchResults = searchSettings(searchQuery, permittedSections, {
    hostedBrowser: isHostedBrowserRuntime(),
    computeProviders,
  });
  const openSearchResult = (result: SettingsSearchResult) => {
    if (!permittedSections.includes(result.section)) return;
    selectSection(result.section);
    setSearchDestination(result);
  };
  useEffect(() => {
    if (!searchDestination || searchQuery || !activeSectionAvailable) return;
    const section =
      panelRef.current?.querySelector<HTMLElement>(
        `[data-settings-section="${searchDestination.section}"]`
      ) ??
      (searchDestination.section === 'privacy'
        ? panelRef.current?.querySelector<HTMLElement>('#settings-account-privacy')
        : null);
    if (!section) return;
    const target = searchDestination.targetId
      ? Array.from(section.querySelectorAll<HTMLElement>('[data-settings-target]')).find(
          (element) => element.dataset.settingsTarget === searchDestination.targetId
        )
      : section.querySelector<HTMLElement>('h1');
    if (!target) return;
    const control = searchDestination.targetId
      ? target.querySelector<HTMLElement>(
          'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), a[href]'
        )
      : null;
    const focus = control ?? target;
    if (!control) focus.tabIndex = -1;
    target.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    safeFocus(focus, { preventScroll: true });
    target.setAttribute('data-settings-highlight', 'true');
    const timer = window.setTimeout(() => target.removeAttribute('data-settings-highlight'), 2400);
    return () => {
      window.clearTimeout(timer);
      target.removeAttribute('data-settings-highlight');
    };
  }, [searchDestination, searchQuery, activeSectionAvailable, org.loading, org.directory?.orgId]);
  const activeMetadata: SettingsSectionMeta = SETTINGS_SECTIONS[activeSection];
  const selectOrganization = (id: string) => {
    setSearchDestination(null);
    org.selectOrganization(id);
    if (activeSection === 'organization-create') selectSection('organization-general');
  };
  const organizationContext = (compact: boolean) =>
    org.organizations.length > 1 ? (
      <SettingsSelect
        ariaLabel="Organization"
        testId={compact ? 'settings-org-switcher-compact' : 'settings-org-switcher'}
        value={org.selectedOrgId ?? ''}
        disabled={org.busy}
        onValueChange={selectOrganization}
        options={org.organizations.map((item) => ({ value: item.orgId, label: item.displayName }))}
      />
    ) : org.organizations.length === 1 ? (
      <p
        className="truncate px-3 py-1.5 text-sm font-medium text-fg"
        data-testid={compact ? 'settings-org-current-compact' : 'settings-org-current'}
      >
        {org.organizations[0]?.displayName}
      </p>
    ) : null;
  return (
    <div
      ref={panelRef}
      className="flex h-full min-w-0 overflow-hidden bg-bg [&_[data-settings-highlight=true]]:rounded-md [&_[data-settings-highlight=true]]:ring-2 [&_[data-settings-highlight=true]]:ring-accent/40"
      data-testid="settings-panel"
    >
      <aside className="hidden w-60 flex-shrink-0 overflow-y-auto border-r border-border bg-bg-subtle lg:block">
        <div className="px-5 py-5">
          <h2 className="text-lg font-semibold text-fg">Settings</h2>
        </div>
        <nav className="px-2 pb-6" aria-label="Settings sections" data-testid="settings-nav">
          {navigationGroups.map((group) => (
            <SettingsNavGroup key={group.id} id={group.id} label={group.label}>
              {group.id === 'organization' ? organizationContext(false) : null}
              {group.items.map((item) => (
                <SettingsNavButton
                  key={item.id}
                  {...item}
                  active={activeSection === item.id}
                  onClick={() => selectSection(item.id)}
                />
              ))}
            </SettingsNavGroup>
          ))}
        </nav>
      </aside>
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto" data-testid="settings-scroll-container">
          <div
            data-testid="settings-content"
            className={`${SETTINGS_CONTENT_WIDTH_CLASS} px-6 py-7 lg:px-10`}
          >
            <div className="mb-4 space-y-3 lg:hidden" data-testid="settings-compact-navigation">
              <SettingsSelect
                ariaLabel="Settings section"
                testId="settings-section-picker"
                value={activeSection}
                onValueChange={(value) => {
                  const item = navigationItems.find((item) => item.id === value);
                  if (item) selectSection(item.id);
                }}
                options={navigationItems.map((item) => ({
                  value: item.id,
                  label: `${item.group} · ${item.label}`,
                }))}
              />
              {activeSection.startsWith('organization-') ? organizationContext(true) : null}
            </div>

            <SettingsSearch
              query={searchQuery}
              onQueryChange={(query) => {
                setSearchDestination(null);
                setSearchQuery(query);
              }}
              results={searchResults}
              groups={new Map(navigationItems.map((item) => [item.id, item.group]))}
              onSelect={openSearchResult}
            />
            <div hidden={searchQuery.trim().length > 0}>
              {activeSection !== 'privacy' && activeSectionAvailable && activeMetadata.scope ? (
                <div data-testid="settings-scope" className="mb-1 text-xs leading-5 text-fg-muted">
                  <span className="font-medium text-fg-subtle">
                    {activeMetadata.scope}
                    {activeMetadata.scope === 'Organization' && org.selected
                      ? ` · ${org.selected.displayName}`
                      : ''}
                  </span>
                  <p>{activeMetadata.description}</p>
                </div>
              ) : null}
              {activeSection === 'account' && session ? (
                <div data-settings-section="account">
                  <AccountSettingsContent session={session} />
                </div>
              ) : null}
              {activeSection === 'privacy' && signedIn ? (
                <SettingsSection
                  id="settings-account-privacy"
                  title="Privacy"
                  testId="settings-section-account-privacy"
                  flushTop
                >
                  <HostedContributionSettings />
                </SettingsSection>
              ) : null}
              <div data-settings-section="ai" className={activeSection === 'ai' ? '' : 'hidden'}>
                <AISettingsSection
                  sectionRef={aiRef}
                  assistantRef={assistantRef}
                  apiKeysRef={apiKeysRef}
                  toolAccessRef={toolAccessRef}
                  conversationId={conversationId}
                  focusedHostId={
                    focusTarget === 'api-keys'
                      ? 'direct-api'
                      : focusTarget?.startsWith('assistant-host:')
                        ? focusTarget.slice('assistant-host:'.length)
                        : null
                  }
                />
              </div>
              <div
                data-settings-section="integrations"
                className={activeSection === 'integrations' ? '' : 'hidden'}
              >
                <SettingsSection
                  id="integrations"
                  title={SETTINGS_SECTIONS['integrations'].label}
                  testId="settings-section-integrations"
                  sectionRef={integrationsRef}
                  flushTop
                >
                  <ComputeIntegrationsSection />
                </SettingsSection>
              </div>
              <div
                data-settings-section="workspace"
                className={activeSection === 'workspace' ? '' : 'hidden'}
              >
                <WorkspaceSection onChangeWorkspace={onChangeWorkspace} sectionRef={workspaceRef} />
              </div>
              {!isHostedBrowserRuntime() && activeSection === 'file-handling' ? (
                <div data-settings-section="file-handling">
                  <SettingsSection
                    id="file-handling"
                    title={SETTINGS_SECTIONS['file-handling'].label}
                    testId="settings-section-file-handling"
                    sectionRef={fileHandlingRef}
                    flushTop
                  >
                    <FileHandlingSettings />
                  </SettingsSection>
                </div>
              ) : null}
              {migrationSettings ? (
                <div
                  data-settings-section="migrations"
                  className={activeSection === 'migrations' ? '' : 'hidden'}
                >
                  <SettingsSection
                    id="settings-migrations"
                    title={SETTINGS_SECTIONS['migrations'].label}
                    testId="settings-section-migrations"
                    sectionRef={migrationsRef}
                    flushTop
                  >
                    <MigrationSettingsContent view={migrationSettings} />
                  </SettingsSection>
                </div>
              ) : null}
              <div
                data-settings-section="appearance"
                className={activeSection === 'appearance' ? '' : 'hidden'}
              >
                <AppearanceSection sectionRef={appearanceRef} />
              </div>
              {!isHostedBrowserRuntime() && activeSection === 'terminal' ? (
                <div data-settings-section="terminal">
                  <TerminalSettingsSection />
                </div>
              ) : null}
              <div
                data-settings-section="editor"
                className={activeSection === 'editor' ? '' : 'hidden'}
              >
                <EditorSection sectionRef={editorRef} />
              </div>
              <div
                data-settings-section="primer-tm"
                className={activeSection === 'primer-tm' ? '' : 'hidden'}
              >
                <PrimerTmSettingsSection sectionRef={primerTmRef} />
              </div>
              <div
                data-settings-section="shortcuts"
                className={activeSection === 'shortcuts' ? '' : 'hidden'}
              >
                <KeyboardShortcutsSection sectionRef={shortcutsRef} />
              </div>
              <div
                data-settings-section="about"
                className={activeSection === 'about' ? '' : 'hidden'}
              >
                <AboutSettingsSection
                  onOpenReleaseNotes={onOpenReleaseNotes}
                  sectionRef={aboutRef}
                />
              </div>
              {activeSection === 'registry' ? (
                <div data-settings-section="registry">
                  <RegistrySettingsContent
                    key={session?.accountId ?? 'independent'}
                    sources={registrySources.sources}
                    sourceError={registrySources.error}
                    sourceNotice={registrySources.notice}
                    onRetrySources={registrySources.retry}
                    tab={registryTab}
                    onTabChange={setRegistryTab}
                    registration={
                      signedIn ? (
                        org.organizations.length > 0 ? (
                          <div className="space-y-4">
                            <label className="block max-w-sm text-xs font-medium text-fg-muted">
                              Organization
                              <SettingsSelect
                                ariaLabel="Organization for registration"
                                testId="registry-registration-organization"
                                value={org.selectedOrgId ?? ''}
                                disabled={org.busy}
                                onValueChange={selectOrganization}
                                options={org.organizations.map((item) => ({
                                  value: item.orgId,
                                  label: item.displayName,
                                }))}
                              />
                            </label>
                            <OrganizationRegistrationSettings key={org.selectedOrgId} model={org} />
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <p
                              role={org.loading ? 'status' : undefined}
                              className="text-sm text-fg-muted"
                            >
                              {org.loading
                                ? 'Loading organizations…'
                                : org.error
                                  ? 'Organizations could not be loaded. Independent schemas remain available.'
                                  : 'You do not belong to an organization.'}
                            </p>
                            {org.error ? (
                              <button
                                type="button"
                                className={SETTINGS_SECONDARY_BUTTON_CLASS}
                                onClick={() => void org.refreshOrganizations()}
                              >
                                Retry organizations
                              </button>
                            ) : null}
                            {!org.loading && !org.error ? (
                              <button
                                type="button"
                                className={SETTINGS_PRIMARY_BUTTON_CLASS}
                                onClick={() => setActiveSection('organization-create')}
                              >
                                Create organization
                              </button>
                            ) : null}
                          </div>
                        )
                      ) : undefined
                    }
                  />
                </div>
              ) : null}
              {signedIn && orgSection ? (
                <div data-settings-section={activeSection} data-testid="organization-settings">
                  <OrganizationSettingsContent model={org} section={orgSection} />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
