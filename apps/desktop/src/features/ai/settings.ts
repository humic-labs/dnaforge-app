import { withUserMessage } from '@waypoint/user-messages';
import { create } from 'zustand';
import { getSetting, setSetting as writeSetting } from '../../db';
import {
  platform,
  type AgentCliPathOverridesShape,
  type AgentCliModelReasoningEffort,
  type AgentCliModelPersonality,
  type AgentAuthResultShape,
  type AgentSdkDetectionShape,
  type AgentTransport,
} from '../../platform';
import {
  parseAgentPermissions,
  type AgentPermissionCatalog,
  type AgentPermissions,
} from '../../shared/agent-permissions';
import { readPermissionCatalog } from './permission-catalog';
import { observeModelPreference } from './preference-telemetry';
import {
  PROVIDERS,
  createCustomProviderId,
  filterRetiredProviderModels,
  getAllProviderMetas,
  getCustomProviderDefinitions,
  getDefaultModel,
  getProviderMeta,
  isRegisteredProviderName,
  isProviderModelRetired,
  normalizeCustomProviderDefinition,
  replaceCustomProviderDefinitions,
  type CustomProviderDefinition,
  type CustomProviderName,
  type ProviderName,
} from './providers';
import { fetchProviderModels } from './modelDiscovery';
import {
  DEFAULT_CLI_PERMISSION_MODE,
  normalizeAssistantRoute,
  restoreRegisteredAssistantRoute,
  type AssistantRouteSelection,
} from './assistant-routes';
import {
  parseRememberedAssistantRoute,
  serializeRememberedAssistantRoute,
} from './assistant-route-memory';
import { getHostedRouteReadiness, type HostedRouteReadiness } from './hosted-gateway';
import { hostedAiEnabledInThisBuild } from './assistant-hosts';
import { getCliSupportedReasoningEfforts } from './cli-host-capabilities';
import { KEYRING_SERVICE } from '../../shared/keyring-service';
import {
  createCustomCliHarnessId,
  normalizeCustomCliHarnessDefinition,
  replaceCustomCliHarnessDefinitions,
  type CustomCliHarnessDefinition,
  type CustomCliHarnessInput,
  type CustomCliHarnessUpdate,
} from './custom-cli-harnesses';

export type {
  CustomCliHarnessDefinition,
  CustomCliHarnessInput,
  CustomCliHarnessUpdate,
} from './custom-cli-harnesses';

export { KEYRING_SERVICE };

async function setSetting(
  key: string,
  value: string,
  observation?: { route: AssistantRouteSelection; operationId: string }
): Promise<void> {
  try {
    await writeSetting(key, value);
  } catch (error) {
    if (
      key === 'ai_provider' ||
      key === 'ai_model' ||
      key === 'ai_agent_transport' ||
      key === 'ai_assistant_route' ||
      key.startsWith('ai_cli_model_')
    ) {
      observeModelPreference(
        observation?.route ?? null,
        'persist',
        'failed',
        'persist-failed',
        observation?.operationId
      );
    }
    throw error;
  }
}

async function keyringHas(service: string, name: string): Promise<boolean> {
  return platform().keyring.hasPassword(service, name);
}

async function keyringGet(service: string, name: string): Promise<string | null> {
  return platform().keyring.getPassword(service, name);
}

async function keyringSet(service: string, name: string, password: string): Promise<void> {
  return platform().keyring.setPassword(service, name, password);
}

async function keyringDelete(service: string, name: string): Promise<void> {
  return platform().keyring.deletePassword(service, name);
}

declare const __ENABLE_DEV_AI_ENV_KEYS__: boolean;
declare const __DEV_ANTHROPIC_API_KEY__: string;
declare const __DEV_OPENAI_API_KEY__: string;
declare const __DEV_GOOGLE_API_KEY__: string;
declare const __DEV_XAI_API_KEY__: string;
declare const __DEV_DEEPSEEK_API_KEY__: string;

export function looksLikeRealKey(key: string): boolean {
  if (key.length < 10) return false;
  const lower = key.toLowerCase();
  return !lower.includes('your-') && !lower.includes('paste-') && !lower.includes('-here');
}

function readDevDefinedKey(read: () => string): string | null {
  try {
    const key = read();
    return typeof key === 'string' && looksLikeRealKey(key) ? key : null;
  } catch {
    return null;
  }
}

function isDevAIEnvKeyImportEnabled(): boolean {
  try {
    return typeof __ENABLE_DEV_AI_ENV_KEYS__ !== 'undefined' && __ENABLE_DEV_AI_ENV_KEYS__ === true;
  } catch {
    return false;
  }
}

export const DEV_AI_ENV_KEYS_ENABLED = isDevAIEnvKeyImportEnabled();

const DEV_ENV_KEY_VALUES: Record<string, string | undefined> = DEV_AI_ENV_KEYS_ENABLED
  ? {
      ANTHROPIC_API_KEY: readDevDefinedKey(() => __DEV_ANTHROPIC_API_KEY__) ?? undefined,
      OPENAI_API_KEY: readDevDefinedKey(() => __DEV_OPENAI_API_KEY__) ?? undefined,
      GOOGLE_API_KEY: readDevDefinedKey(() => __DEV_GOOGLE_API_KEY__) ?? undefined,
      XAI_API_KEY: readDevDefinedKey(() => __DEV_XAI_API_KEY__) ?? undefined,
      DEEPSEEK_API_KEY: readDevDefinedKey(() => __DEV_DEEPSEEK_API_KEY__) ?? undefined,
    }
  : {};

const DEV_ENV_KEYS: Partial<Record<ProviderName, string>> = Object.fromEntries(
  PROVIDERS.flatMap((provider) => {
    const key = DEV_ENV_KEY_VALUES[provider.credential.envVar];
    return key ? [[provider.name, key]] : [];
  })
) as Partial<Record<ProviderName, string>>;

if (import.meta.env.DEV && DEV_AI_ENV_KEYS_ENABLED) {
  const loaded = Object.keys(DEV_ENV_KEYS);
  if (loaded.length > 0) {
    console.log(`[AI Settings] Dev env keys loaded: ${loaded.join(', ')}`);
  } else {
    console.warn('[AI Settings] Dev env key import is enabled, but no usable keys were found.');
  }
}

const VALID_AGENT_TRANSPORTS = new Set<string>(['claude-agent-sdk', 'codex-sdk', 'grok-acp']);
const VALID_CLI_REASONING_EFFORTS = new Set<string>([
  ...getCliSupportedReasoningEfforts('codex-sdk'),
  ...getCliSupportedReasoningEfforts('claude-agent-sdk'),
  ...getCliSupportedReasoningEfforts('grok-acp'),
]);
const VALID_CLI_REASONING_EFFORTS_BY_TRANSPORT: Record<AgentTransport, Set<string>> = {
  'codex-sdk': new Set(getCliSupportedReasoningEfforts('codex-sdk')),
  'claude-agent-sdk': new Set(getCliSupportedReasoningEfforts('claude-agent-sdk')),
  'grok-acp': new Set(getCliSupportedReasoningEfforts('grok-acp')),
};
const ASSISTANT_ROUTE_SETTING_KEY = 'ai_assistant_route';
const CUSTOM_PROVIDERS_SETTING_KEY = 'ai_custom_providers_v1';
const CUSTOM_CLI_HARNESSES_SETTING_KEY = 'ai_custom_cli_harnesses_v1';
const AGENT_PERMISSIONS_SETTING_KEY = 'ai_agent_permissions';
const ADDITIONAL_AGENT_INSTRUCTIONS_SETTING_KEY = 'ai_additional_agent_instructions';
export const MAX_ADDITIONAL_AGENT_INSTRUCTIONS_LENGTH = 16_000;
const AGENT_TRANSPORTS: readonly AgentTransport[] = ['codex-sdk', 'claude-agent-sdk', 'grok-acp'];

export interface CliModelSettings {
  model: string | null;
  reasoningEffort: AgentCliModelReasoningEffort | null;
  serviceTier?: string | null;
  personality?: AgentCliModelPersonality | null;
}

export type CliModelSettingsByTransport = Record<AgentTransport, CliModelSettings>;

export const DEFAULT_CLI_REASONING_EFFORTS: Record<AgentTransport, AgentCliModelReasoningEffort> = {
  'codex-sdk': 'high',
  'claude-agent-sdk': 'high',
  'grok-acp': 'high',
};

export const DEFAULT_CLI_MODEL_SETTINGS: CliModelSettingsByTransport = {
  'codex-sdk': {
    model: null,
    reasoningEffort: DEFAULT_CLI_REASONING_EFFORTS['codex-sdk'],
    serviceTier: null,
    personality: null,
  },
  'claude-agent-sdk': {
    model: null,
    reasoningEffort: DEFAULT_CLI_REASONING_EFFORTS['claude-agent-sdk'],
    serviceTier: null,
    personality: null,
  },
  'grok-acp': {
    model: null,
    reasoningEffort: DEFAULT_CLI_REASONING_EFFORTS['grok-acp'],
    serviceTier: null,
    personality: null,
  },
};

function isValidProvider(name: string): name is ProviderName {
  return isRegisteredProviderName(name);
}

function isValidAgentTransport(value: string): value is AgentTransport {
  return VALID_AGENT_TRANSPORTS.has(value);
}

function isValidCliReasoningEffort(value: string): value is AgentCliModelReasoningEffort {
  return VALID_CLI_REASONING_EFFORTS.has(value);
}

function isValidCliReasoningEffortForTransport(
  transport: AgentTransport,
  value: string
): value is AgentCliModelReasoningEffort {
  return (
    isValidCliReasoningEffort(value) &&
    VALID_CLI_REASONING_EFFORTS_BY_TRANSPORT[transport].has(value)
  );
}

function cliModelSettingKey(transport: AgentTransport): string {
  return `ai_cli_${transport}_model`;
}

function cliReasoningEffortSettingKey(transport: AgentTransport): string {
  return `ai_cli_${transport}_reasoning_effort`;
}

function cliServiceTierSettingKey(transport: AgentTransport): string {
  return `ai_cli_${transport}_service_tier`;
}

function cliPersonalitySettingKey(transport: AgentTransport): string {
  return `ai_cli_${transport}_personality`;
}

function cliExecutablePathSettingKey(transport: AgentTransport): string {
  return `ai_cli_${transport}_executable_path`;
}

export function isAbsoluteCliExecutablePath(value: string): boolean {
  const path = value.trim();
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.includes('\0') &&
    (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\'))
  );
}

async function loadCliExecutablePathOverrides(): Promise<AgentCliPathOverridesShape> {
  const entries = await Promise.all(
    AGENT_TRANSPORTS.map(async (transport) => {
      const stored = (await getSetting(cliExecutablePathSettingKey(transport)))?.trim() ?? '';
      return isAbsoluteCliExecutablePath(stored) ? ([transport, stored] as const) : null;
    })
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

async function loadAgentPermissions(): Promise<AgentPermissions> {
  const stored = await getSetting(AGENT_PERMISSIONS_SETTING_KEY);
  if (!stored) return {};
  try {
    return parseAgentPermissions(JSON.parse(stored)) ?? {};
  } catch {
    return {};
  }
}

async function loadPermissionCatalog(): Promise<AgentPermissionCatalog> {
  const catalog = await readPermissionCatalog();
  useAISettingsStore.setState({ permissionCatalog: catalog });
  return catalog;
}

function normalizeCliModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed || null;
}

function normalizeCliServiceTier(serviceTier: string | null | undefined): string | null {
  const trimmed = serviceTier?.trim();
  return trimmed || null;
}

function normalizeCliPersonality(
  personality: string | null | undefined
): AgentCliModelPersonality | null {
  const trimmed = personality?.trim();
  return trimmed && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(trimmed) ? trimmed : null;
}

function normalizeCliReasoningEffort(
  transport: AgentTransport,
  effort: string | null | undefined
): AgentCliModelReasoningEffort | null {
  if (effort === '') return null;
  if (effort == null) return DEFAULT_CLI_REASONING_EFFORTS[transport];
  return isValidCliReasoningEffortForTransport(transport, effort)
    ? effort
    : DEFAULT_CLI_REASONING_EFFORTS[transport];
}

async function loadCliModelSettings(): Promise<CliModelSettingsByTransport> {
  const entries = await Promise.all(
    (Array.from(VALID_AGENT_TRANSPORTS) as AgentTransport[]).map(async (transport) => {
      const model = normalizeCliModel(await getSetting(cliModelSettingKey(transport)));
      const reasoningEffort = normalizeCliReasoningEffort(
        transport,
        await getSetting(cliReasoningEffortSettingKey(transport))
      );
      const serviceTier = normalizeCliServiceTier(
        await getSetting(cliServiceTierSettingKey(transport))
      );
      const personality =
        transport === 'grok-acp'
          ? null
          : normalizeCliPersonality(await getSetting(cliPersonalitySettingKey(transport)));
      return [transport, { model, reasoningEffort, serviceTier, personality }] as const;
    })
  );
  return Object.fromEntries(entries) as CliModelSettingsByTransport;
}

async function loadCustomCliHarnesses(): Promise<CustomCliHarnessDefinition[]> {
  try {
    const stored = await getSetting(CUSTOM_CLI_HARNESSES_SETTING_KEY);
    if (!stored) {
      replaceCustomCliHarnessDefinitions([]);
      return [];
    }
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error('Custom CLI harness settings must be an array.');
    const harnesses = parsed
      .map(normalizeCustomCliHarnessDefinition)
      .filter((entry): entry is CustomCliHarnessDefinition => entry !== null);
    replaceCustomCliHarnessDefinitions(harnesses);
    return harnesses;
  } catch {
    replaceCustomCliHarnessDefinitions([]);
    return [];
  }
}

async function persistCustomCliHarnesses(
  harnesses: readonly CustomCliHarnessDefinition[]
): Promise<void> {
  await setSetting(CUSTOM_CLI_HARNESSES_SETTING_KEY, JSON.stringify(harnesses));
}

function parseAssistantRoute(value: string | null): AssistantRouteSelection | null {
  const route = parseRememberedAssistantRoute(value, restoreRegisteredAssistantRoute);
  if (route?.kind !== 'provider') return route;
  return {
    ...route,
    model: isProviderModelRetired(route.provider, route.model)
      ? getDefaultModel(route.provider)
      : route.model,
  };
}

function serializeAssistantRoute(route: AssistantRouteSelection): string {
  return serializeRememberedAssistantRoute(normalizeAssistantRoute(route));
}

let _assistantRoutePersistenceQueue: Promise<void> = Promise.resolve();

function persistAssistantRoute(
  route: AssistantRouteSelection,
  shouldWrite: () => boolean = () => true
): Promise<boolean> {
  const write = _assistantRoutePersistenceQueue.then(async () => {
    if (!shouldWrite()) return false;
    const operationId = crypto.randomUUID();
    observeModelPreference(route, 'persist', 'started', 'none', operationId);
    await setSetting(ASSISTANT_ROUTE_SETTING_KEY, serializeAssistantRoute(route), {
      route,
      operationId,
    });
    observeModelPreference(route, 'persist', 'succeeded', 'none', operationId);
    return true;
  });
  _assistantRoutePersistenceQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

function keyringUser(provider: ProviderName): string {
  return getProviderMeta(provider).credential.keyringAccount;
}

function formatKeyringError(err: unknown, action: string): string {
  return err instanceof Error ? err.message : `Failed to ${action}`;
}

async function checkProviderKey(provider: ProviderName): Promise<{
  isConfigured: boolean;
  keyringError: string | null;
}> {
  if (DEV_ENV_KEYS[provider]) {
    return { isConfigured: true, keyringError: null };
  }
  try {
    const isConfigured = await keyringHas(KEYRING_SERVICE, keyringUser(provider));
    return { isConfigured, keyringError: null };
  } catch (err) {
    return {
      isConfigured: false,
      keyringError: err instanceof Error ? err.message : 'Keyring unavailable',
    };
  }
}

export type KeySource = 'env' | 'keyring' | 'none';

export interface ProviderStatus {
  isConfigured: boolean;
  keySource: KeySource;
}

export type ModelFetchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface ProviderModelState {
  models: string[];
  fetchStatus: ModelFetchStatus;
  fetchError: string | null;
}

const DEFAULT_MODEL_STATE: ProviderModelState = {
  models: [],
  fetchStatus: 'idle',
  fetchError: null,
};

function providerRecord<T>(
  factory: (provider: ReturnType<typeof getAllProviderMetas>[number]) => T
): Record<ProviderName, T> {
  return Object.fromEntries(
    getAllProviderMetas().map((provider) => [provider.name, factory(provider)])
  ) as Record<ProviderName, T>;
}

const DEFAULT_STATUSES: Record<ProviderName, ProviderStatus> = providerRecord(() => ({
  isConfigured: false,
  keySource: 'none',
}));

function defaultProviderModels(): Record<ProviderName, ProviderModelState> {
  return providerRecord(() => ({ ...DEFAULT_MODEL_STATE }));
}

function defaultProviderCredentialNames(): Record<ProviderName, string> {
  return providerRecord((provider) => provider.credential.envVar);
}

interface ModelCache {
  models: string[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

function modelCacheKey(provider: ProviderName): string {
  return `ai_models_cache_${provider}`;
}

function providerCredentialNameKey(provider: ProviderName): string {
  return `ai_provider_secret_name_${provider}`;
}

function normalizeProviderCredentialName(provider: ProviderName, name?: string): string {
  const trimmed = name?.trim();
  return trimmed || getProviderMeta(provider).credential.envVar;
}

async function loadProviderCredentialNames(): Promise<Record<ProviderName, string>> {
  const names = defaultProviderCredentialNames();
  for (const provider of getAllProviderMetas()) {
    try {
      const storedName = await getSetting(providerCredentialNameKey(provider.name));
      names[provider.name] = normalizeProviderCredentialName(
        provider.name,
        storedName ?? undefined
      );
    } catch {
      names[provider.name] = provider.credential.envVar;
    }
  }
  return names;
}

async function loadCustomProviderDefinitions(): Promise<CustomProviderDefinition[]> {
  const raw = await getSetting(CUSTOM_PROVIDERS_SETTING_KEY);
  if (!raw) {
    replaceCustomProviderDefinitions([]);
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Custom provider setting is not an array.');
    const definitions = parsed.flatMap((candidate) => {
      try {
        return [normalizeCustomProviderDefinition(candidate as CustomProviderDefinition)];
      } catch {
        return [];
      }
    });
    replaceCustomProviderDefinitions(definitions);
    return getCustomProviderDefinitions();
  } catch {
    replaceCustomProviderDefinitions([]);
    return [];
  }
}

async function persistCustomProviderDefinitions(
  definitions: readonly CustomProviderDefinition[]
): Promise<void> {
  await setSetting(CUSTOM_PROVIDERS_SETTING_KEY, JSON.stringify(definitions));
}

export interface CustomProviderInput {
  label: string;
  baseUrl: string;
  defaultModel: string;
}

interface AISettingsState {
  initializationStatus: 'pending' | 'loading' | 'ready' | 'error';
  assistantRoute: AssistantRouteSelection | null;
  provider: ProviderName;
  model: string;
  agentTransport: AgentTransport | null;
  isConfigured: boolean;
  providerStatuses: Record<ProviderName, ProviderStatus>;
  providerModels: Record<ProviderName, ProviderModelState>;
  providerCredentialNames: Record<ProviderName, string>;
  customProviders: CustomProviderDefinition[];
  customCliHarnesses: CustomCliHarnessDefinition[];
  cliExecutablePathOverrides: AgentCliPathOverridesShape;
  cliModelSettings: CliModelSettingsByTransport;
  agentPermissions: AgentPermissions;
  permissionCatalog: AgentPermissionCatalog | null;
  additionalAgentInstructions: string;
  agentDetection: AgentSdkDetectionShape | null;
  agentDetectError: string | null;
  hostedRouteReadiness: HostedRouteReadiness;
  isLoading: boolean;
  keyringError: string | null;

  initialize: () => Promise<void>;
  refreshProviderStatuses: () => Promise<void>;
  refreshAgentDetection: (
    authentication?: AgentAuthResultShape
  ) => Promise<AgentSdkDetectionShape | null>;
  refreshHostedRouteReadiness: () => Promise<HostedRouteReadiness>;
  setProvider: (provider: ProviderName) => Promise<void>;
  setAgentTransport: (transport: AgentTransport | null) => Promise<void>;
  setAssistantRoute: (route: AssistantRouteSelection) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setCliModel: (transport: AgentTransport, model: string | null) => Promise<void>;
  setCliReasoningEffort: (
    transport: AgentTransport,
    effort: AgentCliModelReasoningEffort | null
  ) => Promise<void>;
  setCliServiceTier: (transport: AgentTransport, serviceTier: string | null) => Promise<void>;
  setCliPersonality: (
    transport: AgentTransport,
    personality: AgentCliModelPersonality | null
  ) => Promise<void>;
  setCliExecutablePathOverride: (
    transport: AgentTransport,
    executablePath: string | null
  ) => Promise<void>;
  setAgentPermissions: (permissions: AgentPermissions) => Promise<void>;
  loadPermissionCatalog: () => Promise<AgentPermissionCatalog>;
  setAdditionalAgentInstructions: (instructions: string) => Promise<void>;
  getApiKey: (provider: ProviderName) => Promise<string | null>;
  setApiKey: (provider: ProviderName, key: string, credentialName?: string) => Promise<void>;
  setProviderCredentialName: (provider: ProviderName, credentialName: string) => Promise<void>;
  deleteApiKey: (provider: ProviderName) => Promise<void>;
  fetchModels: (provider: ProviderName) => Promise<void>;
  retryFetchModels: (provider: ProviderName) => Promise<void>;
  addCustomProvider: (input: CustomProviderInput, apiKey: string) => Promise<CustomProviderName>;
  updateCustomProvider: (
    provider: CustomProviderName,
    input: CustomProviderInput,
    apiKey?: string
  ) => Promise<void>;
  removeCustomProvider: (provider: CustomProviderName) => Promise<void>;
  addCustomCliHarness: (input: CustomCliHarnessInput) => Promise<string>;
  updateCustomCliHarness: (id: string, update: CustomCliHarnessUpdate) => Promise<void>;
  removeCustomCliHarness: (id: string) => Promise<void>;
}

function pickBestModel(provider: ProviderName, models: string[], currentModel?: string): string {
  const allowedModels = filterRetiredProviderModels(provider, models);
  if (currentModel && allowedModels.includes(currentModel)) return currentModel;
  const defaultModel = getDefaultModel(provider);
  if (allowedModels.includes(defaultModel)) return defaultModel;
  return allowedModels[0] ?? defaultModel;
}

let _providerRequestId = 0;
let _assistantRouteRequestId = 0;
let _agentDetectionRequestId = 0;
let _hostedRouteReadinessRequestId = 0;

let settingsInitialization: Promise<void> | null = null;

export const useAISettingsStore = create<AISettingsState>((set, get) => ({
  assistantRoute: null,
  provider: 'anthropic',
  model: getDefaultModel('anthropic'),
  agentTransport: null,
  isConfigured: false,
  providerStatuses: { ...DEFAULT_STATUSES },
  providerModels: defaultProviderModels(),
  providerCredentialNames: defaultProviderCredentialNames(),
  customProviders: [],
  customCliHarnesses: [],
  cliExecutablePathOverrides: {},
  cliModelSettings: { ...DEFAULT_CLI_MODEL_SETTINGS },
  agentPermissions: {},
  permissionCatalog: null,
  additionalAgentInstructions: '',
  agentDetection: null,
  agentDetectError: null,
  hostedRouteReadiness: hostedAiEnabledInThisBuild() ? 'checking' : 'not-configured',
  initializationStatus: 'pending',
  isLoading: false,
  keyringError: null,

  initialize: async () => {
    if (settingsInitialization) return settingsInitialization;
    set({ isLoading: true, initializationStatus: 'loading', keyringError: null });
    settingsInitialization = (async () => {
      try {
        const storedProvider = await getSetting('ai_provider');
        const storedModel = await getSetting('ai_model');
        const storedAgentTransport = await getSetting('ai_agent_transport');
        const storedAssistantRouteValue = await getSetting(ASSISTANT_ROUTE_SETTING_KEY);
        const customProviders = await loadCustomProviderDefinitions();
        const customCliHarnesses = await loadCustomCliHarnesses();
        const cliExecutablePathOverrides = await loadCliExecutablePathOverrides();
        const storedProviderIsValid = !!storedProvider && isValidProvider(storedProvider);
        const provider: ProviderName = storedProviderIsValid ? storedProvider : 'anthropic';
        const rawModel = storedModel ?? getDefaultModel(provider);
        const model = isProviderModelRetired(provider, rawModel)
          ? getDefaultModel(provider)
          : rawModel;
        const agentTransport =
          storedAgentTransport && isValidAgentTransport(storedAgentTransport)
            ? storedAgentTransport
            : null;
        const canonicalRouteIsPresent = storedAssistantRouteValue !== null;
        const parsedAssistantRoute = parseAssistantRoute(storedAssistantRouteValue);
        const storedAssistantRoute =
          parsedAssistantRoute?.kind === 'hosted' && !hostedAiEnabledInThisBuild()
            ? null
            : parsedAssistantRoute;
        const providerCredentialNames = await loadProviderCredentialNames();
        const cliModelSettings = await loadCliModelSettings();
        const agentPermissions = await loadAgentPermissions();
        const additionalAgentInstructions = (
          (await getSetting(ADDITIONAL_AGENT_INSTRUCTIONS_SETTING_KEY)) ?? ''
        ).slice(0, MAX_ADDITIONAL_AGENT_INSTRUCTIONS_LENGTH);
        const assistantRoute: AssistantRouteSelection | null = canonicalRouteIsPresent
          ? storedAssistantRoute
          : agentTransport
            ? ({
                kind: 'cli',
                transport: agentTransport,
                permissionMode: DEFAULT_CLI_PERMISSION_MODE,
              } satisfies AssistantRouteSelection)
            : storedProviderIsValid
              ? ({ kind: 'provider', provider, model } satisfies AssistantRouteSelection)
              : null;
        const selectedProvider =
          assistantRoute?.kind === 'provider' ? assistantRoute.provider : provider;
        const selectedModel = assistantRoute?.kind === 'provider' ? assistantRoute.model : model;

        const statuses = providerRecord(() => ({
          isConfigured: false,
          keySource: 'none' as KeySource,
        }));
        for (const p of getAllProviderMetas()) {
          if (DEV_ENV_KEYS[p.name]) {
            statuses[p.name] = { isConfigured: true, keySource: 'env' };
          }
        }

        set({
          assistantRoute,
          provider: selectedProvider,
          model: selectedModel,
          agentTransport: assistantRoute?.kind === 'cli' ? assistantRoute.transport : null,
          isConfigured: assistantRoute?.kind === 'cli' || statuses[selectedProvider].isConfigured,
          providerStatuses: statuses,
          providerCredentialNames,
          providerModels: defaultProviderModels(),
          customProviders,
          customCliHarnesses,
          cliExecutablePathOverrides,
          cliModelSettings,
          agentPermissions,
          additionalAgentInstructions,
          initializationStatus: 'ready',
          isLoading: false,
          keyringError: null,
        });

        const adopted = get();
        const mirrorMismatch =
          assistantRoute?.kind === 'provider' &&
          (assistantRoute.provider !== adopted.provider || assistantRoute.model !== adopted.model);
        const restoreFailure =
          canonicalRouteIsPresent && !assistantRoute
            ? 'restore-invalid'
            : mirrorMismatch
              ? 'presentation-mismatch'
              : 'none';
        observeModelPreference(
          assistantRoute,
          'restore',
          restoreFailure === 'none' ? 'succeeded' : 'failed',
          restoreFailure
        );

        if (!assistantRoute) {
          void get()
            .refreshAgentDetection()
            .catch(() => {});
        }
      } catch (error) {
        console.error('Failed to initialize AI settings:', error);
        set({
          isLoading: false,
          initializationStatus: 'error',
          keyringError: 'Initialization failed',
        });
      }
    })().finally(() => {
      settingsInitialization = null;
    });
    return settingsInitialization;
  },

  refreshProviderStatuses: async () => {
    try {
      const statuses = { ...get().providerStatuses };
      let keyringErr: string | null = null;
      for (const p of getAllProviderMetas()) {
        if (DEV_ENV_KEYS[p.name]) {
          statuses[p.name] = { isConfigured: true, keySource: 'env' };
        } else {
          const { isConfigured, keyringError } = await checkProviderKey(p.name);
          statuses[p.name] = { isConfigured, keySource: isConfigured ? 'keyring' : 'none' };
          if (keyringError && !keyringErr) keyringErr = keyringError;
        }
      }

      const models = defaultProviderModels();
      for (const p of getAllProviderMetas()) {
        if (!statuses[p.name].isConfigured) continue;
        try {
          const cached = await getSetting(modelCacheKey(p.name));
          if (cached) {
            const parsed: ModelCache = JSON.parse(cached);
            if (parsed.models?.length > 0) {
              const isFresh = Date.now() - parsed.fetchedAt <= CACHE_TTL_MS;
              models[p.name] = {
                models: parsed.models,
                fetchStatus: isFresh ? 'success' : 'idle',
                fetchError: null,
              };
            }
          }
        } catch {}
      }

      const { provider } = get();
      const agentTransport = get().agentTransport;
      set({
        isConfigured: !!agentTransport || statuses[provider].isConfigured,
        providerStatuses: statuses,
        providerModels: models,
        keyringError: keyringErr,
      });

      for (const p of getAllProviderMetas()) {
        if (statuses[p.name].isConfigured) {
          get().fetchModels(p.name);
        }
      }
    } catch (error) {
      console.error('Failed to refresh provider statuses:', error);
    }
  },

  refreshAgentDetection: async (authentication) => {
    const requestId = ++_agentDetectionRequestId;
    const confirmed = authentication?.ok ? authentication.detection : undefined;
    if (confirmed) {
      const previous = get().agentDetection;
      set({
        agentDetection: {
          claudeCode: { ...previous?.claudeCode, ...confirmed.claudeCode },
          codex: { ...previous?.codex, ...confirmed.codex },
          grok: { ...previous?.grok, ...confirmed.grok },
        },
        agentDetectError: null,
      });
    }
    const refresh = async () => {
      try {
        const detection = await platform().agentSdk.detect(get().cliExecutablePathOverrides);
        if (requestId !== _agentDetectionRequestId) return detection;
        if (confirmed && authentication) {
          if (authentication.transport === 'claude-agent-sdk')
            detection.claudeCode = { ...detection.claudeCode, ...confirmed.claudeCode };
          else if (authentication.transport === 'codex-sdk')
            detection.codex = { ...detection.codex, ...confirmed.codex };
          else if (authentication.transport === 'grok-acp')
            detection.grok = { ...detection.grok, ...confirmed.grok };
        }
        set({ agentDetection: detection, agentDetectError: null });
        return detection;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (requestId !== _agentDetectionRequestId) return null;
        set({ agentDetectError: message });
        return null;
      }
    };
    if (confirmed) {
      void refresh();
      return get().agentDetection;
    }
    return refresh();
  },

  refreshHostedRouteReadiness: async () => {
    const requestId = ++_hostedRouteReadinessRequestId;
    if (!hostedAiEnabledInThisBuild()) {
      set({ hostedRouteReadiness: 'not-configured' });
      return 'not-configured';
    }
    set({ hostedRouteReadiness: 'checking' });
    const readiness = await getHostedRouteReadiness();
    if (requestId !== _hostedRouteReadinessRequestId) return readiness;
    set((state) => ({
      hostedRouteReadiness: readiness,
      isConfigured:
        state.assistantRoute?.kind === 'hosted'
          ? readiness === 'ready'
          : state.assistantRoute?.kind === 'cli' ||
            state.providerStatuses[state.provider].isConfigured,
    }));
    return readiness;
  },

  setProvider: async (provider: ProviderName) => {
    const requestId = ++_providerRequestId;
    const routeRequestId = ++_assistantRouteRequestId;

    const { providerStatuses, providerModels } = get();
    const status = providerStatuses[provider] ?? DEFAULT_STATUSES.anthropic;
    const modelState = providerModels[provider] ?? DEFAULT_MODEL_STATE;

    const model =
      modelState.models.length > 0
        ? pickBestModel(provider, modelState.models)
        : getDefaultModel(provider);

    if (requestId !== _providerRequestId || routeRequestId !== _assistantRouteRequestId) return;

    const nextRoute: AssistantRouteSelection = { kind: 'provider', provider, model };
    set({
      assistantRoute: nextRoute,
      provider,
      model,
      agentTransport: null,
      isConfigured: status.isConfigured,
      keyringError: null,
    });

    await setSetting('ai_provider', provider);
    if (routeRequestId !== _assistantRouteRequestId) return;
    await setSetting('ai_model', model);
    if (routeRequestId !== _assistantRouteRequestId) return;
    await setSetting('ai_agent_transport', '');
    if (routeRequestId !== _assistantRouteRequestId) return;
    await persistAssistantRoute(nextRoute, () => routeRequestId === _assistantRouteRequestId);

    if (requestId !== _providerRequestId) return;

    if (status.isConfigured && modelState.fetchStatus === 'idle') {
      get().fetchModels(provider);
    }
  },

  setAgentTransport: async (transport: AgentTransport | null) => {
    const routeRequestId = ++_assistantRouteRequestId;
    const assistantRoute: AssistantRouteSelection | null = transport
      ? { kind: 'cli', transport, permissionMode: DEFAULT_CLI_PERMISSION_MODE }
      : { kind: 'provider', provider: get().provider, model: get().model };
    const { provider, providerStatuses } = get();
    set({
      assistantRoute,
      agentTransport: transport,
      isConfigured: !!transport || providerStatuses[provider].isConfigured,
      keyringError: null,
    });
    await setSetting('ai_agent_transport', transport ?? '');
    if (routeRequestId !== _assistantRouteRequestId) return;
    await persistAssistantRoute(assistantRoute, () => routeRequestId === _assistantRouteRequestId);
  },

  setAssistantRoute: async (route: AssistantRouteSelection) => {
    if (route.kind === 'hosted' && !hostedAiEnabledInThisBuild()) {
      throw new Error('DNAForge Hosted AI is not available in this build.');
    }
    const restoredRoute = restoreRegisteredAssistantRoute(route);
    if (!restoredRoute) {
      throw new Error('This assistant route is not registered in the current build.');
    }
    const routeRequestId = ++_assistantRouteRequestId;
    const normalizedRoute = normalizeAssistantRoute(restoredRoute);
    observeModelPreference(normalizedRoute, 'select', 'succeeded');
    if (normalizedRoute.kind === 'cli') {
      set({
        assistantRoute: normalizedRoute,
        agentTransport: normalizedRoute.transport,
        isConfigured: true,
        keyringError: null,
      });
      await setSetting('ai_agent_transport', normalizedRoute.transport);
      if (routeRequestId !== _assistantRouteRequestId) return;
      await persistAssistantRoute(
        normalizedRoute,
        () => routeRequestId === _assistantRouteRequestId
      );
      return;
    }
    if (normalizedRoute.kind === 'provider') {
      const status = get().providerStatuses[normalizedRoute.provider] ?? DEFAULT_STATUSES.anthropic;
      const modelState = get().providerModels[normalizedRoute.provider] ?? DEFAULT_MODEL_STATE;
      const model = isProviderModelRetired(normalizedRoute.provider, normalizedRoute.model)
        ? pickBestModel(normalizedRoute.provider, modelState.models)
        : normalizedRoute.model;
      const nextRoute: AssistantRouteSelection = {
        kind: 'provider',
        provider: normalizedRoute.provider,
        model,
      };
      set({
        assistantRoute: nextRoute,
        provider: normalizedRoute.provider,
        model,
        agentTransport: null,
        isConfigured: status.isConfigured,
        keyringError: null,
      });
      await setSetting('ai_provider', normalizedRoute.provider);
      if (routeRequestId !== _assistantRouteRequestId) return;
      await setSetting('ai_model', model);
      if (routeRequestId !== _assistantRouteRequestId) return;
      await setSetting('ai_agent_transport', '');
      if (routeRequestId !== _assistantRouteRequestId) return;
      await persistAssistantRoute(nextRoute, () => routeRequestId === _assistantRouteRequestId);
      if (routeRequestId !== _assistantRouteRequestId) return;
      if (status.isConfigured && modelState.fetchStatus === 'idle') {
        get().fetchModels(normalizedRoute.provider);
      }
      return;
    }
    if (normalizedRoute.kind === 'hosted') {
      const readiness = get().hostedRouteReadiness;
      set({
        assistantRoute: normalizedRoute,
        agentTransport: null,
        isConfigured: readiness === 'ready',
        keyringError: null,
      });
      await setSetting('ai_agent_transport', '');
      if (routeRequestId !== _assistantRouteRequestId) return;
      await persistAssistantRoute(
        normalizedRoute,
        () => routeRequestId === _assistantRouteRequestId
      );
      return;
    }
    set({
      assistantRoute: normalizedRoute,
      agentTransport: null,
      isConfigured: true,
      keyringError: null,
    });
    await setSetting('ai_agent_transport', '');
    if (routeRequestId !== _assistantRouteRequestId) return;
    await persistAssistantRoute(normalizedRoute, () => routeRequestId === _assistantRouteRequestId);
  },

  setModel: async (model: string) => {
    if (!model || !model.trim()) {
      throw new Error('Model name cannot be empty');
    }
    if (isProviderModelRetired(get().provider, model)) {
      throw new Error(`Model "${model}" is no longer available for ${get().provider}`);
    }
    const routeRequestId = ++_assistantRouteRequestId;
    const route = get().assistantRoute;
    observeModelPreference(
      route,
      'select',
      'succeeded',
      'none',
      undefined,
      get().providerModels[get().provider]?.models.includes(model) ? 'catalog' : 'custom'
    );
    if (route?.kind === 'provider') {
      const nextRoute: AssistantRouteSelection = {
        kind: 'provider',
        provider: get().provider,
        model,
      };
      set({ assistantRoute: nextRoute, model });
      await setSetting('ai_model', model);
      if (routeRequestId !== _assistantRouteRequestId) return;
      await persistAssistantRoute(nextRoute, () => routeRequestId === _assistantRouteRequestId);
      return;
    }
    set({ model });
    await setSetting('ai_model', model);
    if (routeRequestId !== _assistantRouteRequestId) return;
    set({ model });
  },

  setCliModel: async (transport: AgentTransport, model: string | null) => {
    const normalizedModel = normalizeCliModel(model);
    if (model !== null && model !== undefined && model.trim().length > 160) {
      throw new Error('CLI model name is too long');
    }
    const nextSettings: CliModelSettingsByTransport = {
      ...get().cliModelSettings,
      [transport]: {
        ...get().cliModelSettings[transport],
        model: normalizedModel,
      },
    };
    set({ cliModelSettings: nextSettings });
    await setSetting(cliModelSettingKey(transport), normalizedModel ?? '');
  },

  setCliReasoningEffort: async (
    transport: AgentTransport,
    effort: AgentCliModelReasoningEffort | null
  ) => {
    if (effort !== null && !isValidCliReasoningEffortForTransport(transport, effort)) {
      throw new Error(`Unsupported CLI reasoning effort for ${transport}: ${String(effort)}`);
    }
    const normalizedEffort = effort;
    const nextSettings: CliModelSettingsByTransport = {
      ...get().cliModelSettings,
      [transport]: {
        ...get().cliModelSettings[transport],
        reasoningEffort: normalizedEffort,
      },
    };
    set({ cliModelSettings: nextSettings });
    await setSetting(cliReasoningEffortSettingKey(transport), normalizedEffort ?? '');
  },

  setCliServiceTier: async (transport: AgentTransport, serviceTier: string | null) => {
    const normalizedTier = normalizeCliServiceTier(serviceTier);
    if (normalizedTier && normalizedTier.length > 160) {
      throw new Error('CLI service tier name is too long');
    }
    const nextSettings: CliModelSettingsByTransport = {
      ...get().cliModelSettings,
      [transport]: {
        ...get().cliModelSettings[transport],
        serviceTier: normalizedTier,
      },
    };
    set({ cliModelSettings: nextSettings });
    await setSetting(cliServiceTierSettingKey(transport), normalizedTier ?? '');
  },

  setCliPersonality: async (
    transport: AgentTransport,
    personality: AgentCliModelPersonality | null
  ) => {
    if (personality !== null && transport === 'grok-acp') {
      throw new Error(`CLI response style is not supported for ${transport}`);
    }
    const normalizedPersonality = normalizeCliPersonality(personality);
    const nextSettings: CliModelSettingsByTransport = {
      ...get().cliModelSettings,
      [transport]: {
        ...get().cliModelSettings[transport],
        personality: normalizedPersonality,
      },
    };
    set({ cliModelSettings: nextSettings });
    await setSetting(cliPersonalitySettingKey(transport), normalizedPersonality ?? '');
  },

  setAgentPermissions: async (permissions: AgentPermissions) => {
    const next = parseAgentPermissions({ ...get().agentPermissions, ...permissions });
    if (!next) throw new Error('Unsupported agent permission mode.');
    set({ agentPermissions: next });
    await setSetting(AGENT_PERMISSIONS_SETTING_KEY, JSON.stringify(next));
  },

  loadPermissionCatalog,

  setAdditionalAgentInstructions: async (instructions: string) => {
    const normalized = instructions.slice(0, MAX_ADDITIONAL_AGENT_INSTRUCTIONS_LENGTH);
    set({ additionalAgentInstructions: normalized });
    await setSetting(ADDITIONAL_AGENT_INSTRUCTIONS_SETTING_KEY, normalized);
  },

  setCliExecutablePathOverride: async (
    transport: AgentTransport,
    executablePath: string | null
  ) => {
    if (!isValidAgentTransport(transport)) {
      throw new Error(`Unsupported agent transport: ${String(transport)}`);
    }
    const normalized = executablePath?.trim() || null;
    if (normalized && !isAbsoluteCliExecutablePath(normalized)) {
      throw withUserMessage(
        new Error('Choose an absolute executable path.'),
        'failure.choose-an-absolute-executable-path'
      );
    }
    const previous = get().cliExecutablePathOverrides;
    const next = { ...previous };
    if (normalized) next[transport] = normalized;
    else delete next[transport];
    set({ cliExecutablePathOverrides: next });
    try {
      await setSetting(cliExecutablePathSettingKey(transport), normalized ?? '');
    } catch (error) {
      set({ cliExecutablePathOverrides: previous });
      throw error;
    }
    await get().refreshAgentDetection();
  },

  addCustomCliHarness: async (input: CustomCliHarnessInput) => {
    const definition = normalizeCustomCliHarnessDefinition({
      id: createCustomCliHarnessId(input.label),
      ...input,
      model: null,
      reasoningEffort: DEFAULT_CLI_REASONING_EFFORTS[input.transport],
      serviceTier: null,
      personality: null,
    });
    if (!definition) {
      throw new Error('Enter a name, supported compatibility, and executable path.');
    }
    const previous = get().customCliHarnesses;
    const next = [...previous, definition];
    replaceCustomCliHarnessDefinitions(next);
    try {
      await persistCustomCliHarnesses(next);
      set({ customCliHarnesses: next });
    } catch (error) {
      replaceCustomCliHarnessDefinitions(previous);
      throw error;
    }
    return definition.id;
  },

  updateCustomCliHarness: async (id: string, update: CustomCliHarnessUpdate) => {
    const previous = get().customCliHarnesses;
    const index = previous.findIndex((harness) => harness.id === id);
    if (index < 0) throw new Error('Custom CLI harness not found.');
    const definition = normalizeCustomCliHarnessDefinition({ ...previous[index], ...update, id });
    if (!definition) throw new Error('The custom CLI harness settings are invalid.');
    const next = previous.map((harness, candidateIndex) =>
      candidateIndex === index ? definition : harness
    );
    replaceCustomCliHarnessDefinitions(next);
    try {
      await persistCustomCliHarnesses(next);
      set({ customCliHarnesses: next });
    } catch (error) {
      replaceCustomCliHarnessDefinitions(previous);
      throw error;
    }
  },

  removeCustomCliHarness: async (id: string) => {
    const previous = get().customCliHarnesses;
    const next = previous.filter((harness) => harness.id !== id);
    if (next.length === previous.length) return;
    replaceCustomCliHarnessDefinitions(next);
    try {
      await persistCustomCliHarnesses(next);
      const route = get().assistantRoute;
      const removedActiveRoute = route?.kind === 'cli' && route.customHarnessId === id;
      set({
        customCliHarnesses: next,
        ...(removedActiveRoute
          ? { assistantRoute: null, agentTransport: null, isConfigured: false }
          : {}),
      });
      if (removedActiveRoute) {
        await setSetting(ASSISTANT_ROUTE_SETTING_KEY, '');
        await setSetting('ai_agent_transport', '');
      }
    } catch (error) {
      replaceCustomCliHarnessDefinitions(previous);
      throw error;
    }
  },

  getApiKey: async (provider: ProviderName) => {
    const devKey = DEV_ENV_KEYS[provider];
    if (devKey) return devKey;

    try {
      const key = await keyringGet(KEYRING_SERVICE, keyringUser(provider));
      if (get().keyringError) set({ keyringError: null });
      return key;
    } catch (err) {
      console.error('[Settings] Failed to read API key from keyring:', err);
      set({ keyringError: formatKeyringError(err, 'read key from keyring') });
      return null;
    }
  },

  setApiKey: async (provider: ProviderName, key: string, credentialName?: string) => {
    if (!key || !key.trim()) {
      throw new Error('API key cannot be empty');
    }
    const normalizedCredentialName = normalizeProviderCredentialName(provider, credentialName);

    try {
      await keyringSet(KEYRING_SERVICE, keyringUser(provider), key);
    } catch (err) {
      console.error('[Settings] Failed to save API key to keyring:', err);
      set({ keyringError: formatKeyringError(err, 'save key to keyring') });
      throw err;
    }

    await setSetting(providerCredentialNameKey(provider), normalizedCredentialName);

    const { provider: currentProvider, providerStatuses, providerCredentialNames } = get();
    const updates: Partial<AISettingsState> = {
      providerStatuses: {
        ...providerStatuses,
        [provider]: { isConfigured: true, keySource: 'keyring' },
      },
      providerCredentialNames: {
        ...providerCredentialNames,
        [provider]: normalizedCredentialName,
      },
      keyringError: null,
    };
    if (provider === currentProvider) updates.isConfigured = true;
    set(updates);

    get().fetchModels(provider);
  },

  setProviderCredentialName: async (provider: ProviderName, credentialName: string) => {
    const normalizedCredentialName = normalizeProviderCredentialName(provider, credentialName);
    await setSetting(providerCredentialNameKey(provider), normalizedCredentialName);
    set({
      providerCredentialNames: {
        ...get().providerCredentialNames,
        [provider]: normalizedCredentialName,
      },
    });
  },

  deleteApiKey: async (provider: ProviderName) => {
    try {
      await keyringDelete(KEYRING_SERVICE, keyringUser(provider));
    } catch (err) {
      console.error('[Settings] Failed to delete API key from keyring:', err);
      set({ keyringError: formatKeyringError(err, 'delete key from keyring') });
      throw err;
    }

    const { provider: currentProvider, providerStatuses, providerModels } = get();
    const updates: Partial<AISettingsState> = {
      providerStatuses: {
        ...providerStatuses,
        [provider]: { isConfigured: false, keySource: 'none' },
      },
      providerModels: { ...providerModels, [provider]: { ...DEFAULT_MODEL_STATE } },
      keyringError: null,
    };
    if (provider === currentProvider) {
      const route = get().assistantRoute;
      if (route?.kind === 'provider' && route.provider === provider) {
        updates.assistantRoute = { kind: 'provider', provider, model: get().model };
      }
      updates.isConfigured = !!get().agentTransport;
    }
    set(updates);
  },

  fetchModels: async (provider: ProviderName) => {
    const modelState = get().providerModels[provider] ?? DEFAULT_MODEL_STATE;
    if (modelState.fetchStatus === 'loading') return;

    set({
      providerModels: {
        ...get().providerModels,
        [provider]: { ...modelState, fetchStatus: 'loading', fetchError: null },
      },
    });

    await _doFetchModels(provider, get, set);
  },

  retryFetchModels: async (provider: ProviderName) => {
    set({
      providerModels: {
        ...get().providerModels,
        [provider]: { models: [], fetchStatus: 'loading', fetchError: null },
      },
    });

    await _doFetchModels(provider, get, set);
  },

  addCustomProvider: async (input: CustomProviderInput, apiKey: string) => {
    const definition = normalizeCustomProviderDefinition({
      id: createCustomProviderId(input.label),
      ...input,
    });
    const previousDefinitions = get().customProviders;
    const nextDefinitions = [...previousDefinitions, definition];
    replaceCustomProviderDefinitions(nextDefinitions);
    try {
      await persistCustomProviderDefinitions(nextDefinitions);
    } catch (error) {
      replaceCustomProviderDefinitions(previousDefinitions);
      throw error;
    }

    const meta = getProviderMeta(definition.id);
    set((state) => ({
      customProviders: nextDefinitions,
      providerStatuses: {
        ...state.providerStatuses,
        [definition.id]: { isConfigured: false, keySource: 'none' },
      },
      providerModels: {
        ...state.providerModels,
        [definition.id]: { ...DEFAULT_MODEL_STATE },
      },
      providerCredentialNames: {
        ...state.providerCredentialNames,
        [definition.id]: meta.credential.envVar,
      },
    }));
    await get().setApiKey(definition.id, apiKey);
    return definition.id;
  },

  updateCustomProvider: async (
    provider: CustomProviderName,
    input: CustomProviderInput,
    apiKey?: string
  ) => {
    const previousDefinitions = get().customProviders;
    if (!previousDefinitions.some((definition) => definition.id === provider)) {
      throw new Error('Custom provider no longer exists.');
    }
    const updatedDefinition = normalizeCustomProviderDefinition({ id: provider, ...input });
    const nextDefinitions = previousDefinitions.map((definition) =>
      definition.id === provider ? updatedDefinition : definition
    );
    replaceCustomProviderDefinitions(nextDefinitions);
    try {
      await persistCustomProviderDefinitions(nextDefinitions);
    } catch (error) {
      replaceCustomProviderDefinitions(previousDefinitions);
      throw error;
    }

    const meta = getProviderMeta(provider);
    const isCurrentProvider = get().provider === provider;
    set((state) => ({
      customProviders: nextDefinitions,
      providerModels: {
        ...state.providerModels,
        [provider]: { ...DEFAULT_MODEL_STATE },
      },
      providerCredentialNames: {
        ...state.providerCredentialNames,
        [provider]: meta.credential.envVar,
      },
    }));
    if (isCurrentProvider) {
      await get().setAssistantRoute({
        kind: 'provider',
        provider,
        model: updatedDefinition.defaultModel,
      });
    }
    if (apiKey?.trim()) await get().setApiKey(provider, apiKey);
  },

  removeCustomProvider: async (provider: CustomProviderName) => {
    const previousDefinitions = get().customProviders;
    if (!previousDefinitions.some((definition) => definition.id === provider)) return;

    const route = get().assistantRoute;
    if (
      get().provider === provider ||
      (route?.kind === 'provider' && route.provider === provider)
    ) {
      const fallback =
        getAllProviderMetas().find(
          (meta) => meta.name !== provider && get().providerStatuses[meta.name]?.isConfigured
        )?.name ?? 'anthropic';
      await get().setProvider(fallback);
    }
    await get().deleteApiKey(provider);

    const nextDefinitions = previousDefinitions.filter((definition) => definition.id !== provider);
    replaceCustomProviderDefinitions(nextDefinitions);
    try {
      await persistCustomProviderDefinitions(nextDefinitions);
    } catch (error) {
      replaceCustomProviderDefinitions(previousDefinitions);
      throw error;
    }

    set((state) => {
      const providerStatuses = { ...state.providerStatuses };
      const providerModels = { ...state.providerModels };
      const providerCredentialNames = { ...state.providerCredentialNames };
      delete providerStatuses[provider];
      delete providerModels[provider];
      delete providerCredentialNames[provider];
      return {
        customProviders: nextDefinitions,
        providerStatuses,
        providerModels,
        providerCredentialNames,
      };
    });
  },
}));

async function _doFetchModels(
  provider: ProviderName,
  get: () => AISettingsState,
  set: (partial: Partial<AISettingsState>) => void
): Promise<void> {
  const setModelState = (state: ProviderModelState) => {
    set({ providerModels: { ...get().providerModels, [provider]: state } });
  };

  const apiKey = await get().getApiKey(provider);
  if (!apiKey) {
    setModelState({ models: [], fetchStatus: 'error', fetchError: 'No API key available' });
    return;
  }

  const result = await fetchProviderModels(provider, apiKey);

  if (!get().providerStatuses[provider]?.isConfigured) {
    setModelState({ models: [], fetchStatus: 'idle', fetchError: null });
    return;
  }

  if (result.error) {
    setModelState({ models: [], fetchStatus: 'error', fetchError: result.error });
    return;
  }

  try {
    const cache: ModelCache = { models: result.models, fetchedAt: Date.now() };
    await setSetting(modelCacheKey(provider), JSON.stringify(cache));
  } catch {}

  const { provider: currentProvider, model: currentModel, assistantRoute } = get();
  const newModelState: ProviderModelState = {
    models: result.models,
    fetchStatus: 'success',
    fetchError: null,
  };

  const updates: Partial<AISettingsState> = {
    providerModels: { ...get().providerModels, [provider]: newModelState },
  };

  if (provider === currentProvider && result.models.length > 0) {
    const explicitModel =
      assistantRoute?.kind === 'provider' &&
      assistantRoute.provider === provider &&
      assistantRoute.model === currentModel &&
      !isProviderModelRetired(provider, currentModel);
    const bestModel = explicitModel
      ? currentModel
      : pickBestModel(provider, result.models, currentModel);
    if (bestModel !== currentModel) {
      updates.model = bestModel;
      setSetting('ai_model', bestModel).catch(() => {});
      if (assistantRoute?.kind === 'provider' && assistantRoute.provider === provider) {
        const nextRoute: AssistantRouteSelection = { kind: 'provider', provider, model: bestModel };
        const routeRequestId = _assistantRouteRequestId;
        updates.assistantRoute = nextRoute;
        persistAssistantRoute(nextRoute, () => {
          const currentRoute = get().assistantRoute;
          return (
            routeRequestId === _assistantRouteRequestId &&
            currentRoute?.kind === 'provider' &&
            currentRoute.provider === provider
          );
        }).catch(() => {});
      }
    }
  }

  const explicitRoute = assistantRoute?.kind === 'provider' && assistantRoute.provider === provider;
  if (provider === currentProvider) {
    const changedChoice =
      explicitRoute && updates.model !== undefined && updates.model !== assistantRoute.model;
    observeModelPreference(
      assistantRoute,
      'discovery',
      changedChoice ? 'failed' : 'succeeded',
      changedChoice
        ? 'presentation-mismatch'
        : explicitRoute && !result.models.includes(assistantRoute.model)
          ? 'catalog-omitted'
          : 'none',
      undefined,
      result.models.includes(currentModel) ? 'catalog' : 'custom'
    );
  }
  set(updates);
}
