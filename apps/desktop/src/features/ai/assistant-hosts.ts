import { userMessage, type UserMessage } from '@waypoint/user-messages';
import type {
  AgentCliModelReasoningEffort,
  AgentSdkDetectionShape,
  AgentTransport,
} from '../../platform';
import type { CliPermissionMode } from '../../shared/agent-authority';
import { AGENT_TRANSPORT_LABELS } from './agent-cli-labels';
import { getAllProviderMetas, type ProviderName } from './providers';
import type { HostedRouteReadiness } from './hosted-gateway';
import { isValidCustomCliHarnessId } from './custom-cli-harnesses';

export type AssistantHostId = string;

export type AssistantHostKind =
  | 'cli-agent'
  | 'api-host'
  | 'hosted-gateway'
  | 'router'
  | 'editor-agent'
  | 'orchestrator'
  | 'team';

export type AssistantHostOptionCategory = 'cli' | 'api' | 'hosted' | 'future';

export type AssistantHostModelControl = 'none' | 'dynamic' | 'static';

export interface AssistantHostCapabilities {
  modelSelection: AssistantHostModelControl;
  supportsEffort: boolean;
  supportsPermissionMode: boolean;
  supportsToolCalls: boolean;
  supportsFileWrites: boolean;
}

export type AssistantHostRouteTarget =
  | { kind: 'cli'; transport: AgentTransport }
  | { kind: 'direct-api' }
  | { kind: 'hosted'; tier: 'auto' | 'deep' }
  | { kind: 'orchestrator'; id: string }
  | { kind: 'team'; id: string };

export type AssistantHostRouteSelection =
  | { kind: 'provider'; provider: ProviderName; model: string }
  | {
      kind: 'cli';
      transport: AgentTransport;
      permissionMode?: CliPermissionMode;
      customHarnessId?: string;
    }
  | { kind: 'hosted'; tier: 'auto' | 'deep' }
  | { kind: 'orchestrator'; id: string }
  | { kind: 'team'; id: string };

export interface AssistantRouteState {
  assistantRoute?: AssistantHostRouteSelection | null;
  provider: ProviderName;
  model: string;
  agentTransport: AgentTransport | null;
  providerStatuses?: Record<ProviderName, { isConfigured: boolean }>;
  providerModels?: Record<
    ProviderName,
    {
      models: string[];
      fetchStatus?: 'idle' | 'loading' | 'success' | 'error';
      fetchError?: string | null;
    }
  >;
  agentDetection?: AgentSdkDetectionShape | null;
  agentDetectError?: string | null;
  availableAgentTransports?: readonly AgentTransport[];
  cliModelSettings?: Record<
    AgentTransport,
    {
      model: string | null;
      reasoningEffort: AgentCliModelReasoningEffort | null;
    }
  >;
  hostedRouteReadiness?: HostedRouteReadiness;
}

export function getEffectiveHostedRouteReadiness(
  readiness: HostedRouteReadiness,
  authHydrated: boolean,
  authStatus: string
): HostedRouteReadiness {
  return authHydrated && (authStatus === 'signed-out' || authStatus === 'error')
    ? 'needs-login'
    : readiness;
}

export type AssistantHostExecutor = 'direct-api' | 'cli' | 'hosted';

export type RestoreAssistantHostSelection = (
  candidate: unknown
) => AssistantHostRouteSelection | null;

export type CreateAssistantHostSelection = (
  state: AssistantRouteState,
  activeSelection: AssistantHostRouteSelection
) => AssistantHostRouteSelection | null;

export interface AssistantHostDescriptor {
  id: AssistantHostId;
  kind: AssistantHostKind;
  label: string;
  detail: UserMessage;
  description: string;
  optionCategory: AssistantHostOptionCategory;
  target: AssistantHostRouteTarget;
  capabilities: AssistantHostCapabilities;
  createSelection: CreateAssistantHostSelection;
  restoreSelection?: RestoreAssistantHostSelection;
  executor?: AssistantHostExecutor;
}

export type CliAssistantHostDescriptor = AssistantHostDescriptor & {
  target: { kind: 'cli'; transport: AgentTransport };
};

export const DEFAULT_ASSISTANT_CLI_PERMISSION_MODE: CliPermissionMode = 'native-cli';

function asRecord(candidate: unknown): Record<string, unknown> | null {
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function createCliSelectionRestorer(transport: AgentTransport): RestoreAssistantHostSelection {
  return (candidate) => {
    const value = asRecord(candidate);
    if (!value || value.kind !== 'cli' || value.transport !== transport) return null;
    const permissionMode = value.permissionMode ?? DEFAULT_ASSISTANT_CLI_PERMISSION_MODE;
    if (permissionMode !== 'native-cli' && permissionMode !== 'app-supervised') return null;
    const customHarnessId =
      value.customHarnessId === undefined
        ? undefined
        : isValidCustomCliHarnessId(value.customHarnessId)
          ? value.customHarnessId
          : null;
    if (customHarnessId === null) return null;
    return {
      kind: 'cli',
      transport,
      permissionMode,
      ...(customHarnessId ? { customHarnessId } : {}),
    };
  };
}

function createCliSelection(transport: AgentTransport): CreateAssistantHostSelection {
  return (state, activeSelection) => {
    const transportIsAvailable =
      !state.availableAgentTransports ||
      state.availableAgentTransports.includes(transport) ||
      (activeSelection.kind === 'cli' && activeSelection.transport === transport);
    if (!transportIsAvailable) return null;
    return {
      kind: 'cli',
      transport,
      permissionMode:
        activeSelection.kind === 'cli' && activeSelection.transport === transport
          ? (activeSelection.permissionMode ?? DEFAULT_ASSISTANT_CLI_PERMISSION_MODE)
          : DEFAULT_ASSISTANT_CLI_PERMISSION_MODE,
    };
  };
}

function pickProviderRouteModel(
  state: AssistantRouteState,
  provider: ProviderName,
  defaultModel: string,
  activeSelection: AssistantHostRouteSelection
): string {
  if (activeSelection.kind === 'provider' && activeSelection.provider === provider) {
    return activeSelection.model;
  }
  if (state.provider === provider && state.model) return state.model;
  return state.providerModels?.[provider]?.models[0] ?? defaultModel;
}

const createDirectApiSelection: CreateAssistantHostSelection = (state, activeSelection) => {
  if (state.assistantRoute?.kind === 'provider' && activeSelection.kind === 'provider') {
    return activeSelection;
  }

  const providers = getAllProviderMetas();
  const configuredProvider = providers.find(
    (provider) => state.providerStatuses?.[provider.name]?.isConfigured
  );
  const provider =
    configuredProvider ?? providers.find((candidate) => candidate.name === state.provider);
  if (!provider) return null;
  return {
    kind: 'provider',
    provider: provider.name,
    model: pickProviderRouteModel(state, provider.name, provider.defaultModel, activeSelection),
  };
};

function createHostedSelection(tier: 'auto' | 'deep'): CreateAssistantHostSelection {
  return () => ({ kind: 'hosted', tier });
}

const restoreDirectApiSelection: RestoreAssistantHostSelection = (candidate) => {
  const value = asRecord(candidate);
  if (!value || value.kind !== 'provider') return null;
  const provider = getAllProviderMetas().find((entry) => entry.name === value.provider);
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  return provider && model ? { kind: 'provider', provider: provider.name, model } : null;
};

function createHostedSelectionRestorer(tier: 'auto' | 'deep'): RestoreAssistantHostSelection {
  return (candidate) => {
    const value = asRecord(candidate);
    return value?.kind === 'hosted' && value.tier === tier ? { kind: 'hosted', tier } : null;
  };
}

const CORE_ASSISTANT_HOST_DESCRIPTORS = [
  {
    id: 'codex-cli',
    kind: 'cli-agent',
    label: AGENT_TRANSPORT_LABELS['codex-sdk'],
    detail: userMessage('assistant.host.cli'),
    description: 'Uses your local Codex login with normal CLI tools plus DNAForge app tools.',
    optionCategory: 'cli',
    target: { kind: 'cli', transport: 'codex-sdk' },
    createSelection: createCliSelection('codex-sdk'),
    restoreSelection: createCliSelectionRestorer('codex-sdk'),
    executor: 'cli',
    capabilities: {
      modelSelection: 'dynamic',
      supportsEffort: true,
      supportsPermissionMode: false,
      supportsToolCalls: true,
      supportsFileWrites: true,
    },
  },
  {
    id: 'claude-code',
    kind: 'cli-agent',
    label: AGENT_TRANSPORT_LABELS['claude-agent-sdk'],
    detail: userMessage('assistant.host.cli'),
    description:
      'Uses your local Claude Code subscription login with normal CLI tools plus DNAForge app tools.',
    optionCategory: 'cli',
    target: { kind: 'cli', transport: 'claude-agent-sdk' },
    createSelection: createCliSelection('claude-agent-sdk'),
    restoreSelection: createCliSelectionRestorer('claude-agent-sdk'),
    executor: 'cli',
    capabilities: {
      modelSelection: 'dynamic',
      supportsEffort: true,
      supportsPermissionMode: false,
      supportsToolCalls: true,
      supportsFileWrites: true,
    },
  },
  {
    id: 'grok-cli',
    kind: 'cli-agent',
    label: AGENT_TRANSPORT_LABELS['grok-acp'],
    detail: userMessage('assistant.host.cli'),
    description:
      'Uses your local Grok login through the official ACP backend with DNAForge app tools.',
    optionCategory: 'cli',
    target: { kind: 'cli', transport: 'grok-acp' },
    createSelection: createCliSelection('grok-acp'),
    restoreSelection: createCliSelectionRestorer('grok-acp'),
    executor: 'cli',
    capabilities: {
      modelSelection: 'dynamic',
      supportsEffort: true,
      supportsPermissionMode: false,
      supportsToolCalls: true,
      supportsFileWrites: true,
    },
  },
  {
    id: 'direct-api',
    kind: 'api-host',
    label: 'Direct API',
    detail: userMessage('assistant.host.provider'),
    description: 'Uses DNAForge-stored provider API keys for direct model calls.',
    optionCategory: 'api',
    target: { kind: 'direct-api' },
    createSelection: createDirectApiSelection,
    restoreSelection: restoreDirectApiSelection,
    executor: 'direct-api',
    capabilities: {
      modelSelection: 'dynamic',
      supportsEffort: false,
      supportsPermissionMode: false,
      supportsToolCalls: true,
      supportsFileWrites: false,
    },
  },
] as const satisfies readonly AssistantHostDescriptor[];

const HOSTED_ASSISTANT_HOST_DESCRIPTORS = [
  {
    id: 'dnaforge-hosted-auto',
    kind: 'hosted-gateway',
    label: 'Auto',
    detail: userMessage('assistant.host.everyday'),
    description: 'DNAForge-hosted AI workflow with server-managed routing and allowance.',
    optionCategory: 'hosted',
    target: { kind: 'hosted', tier: 'auto' },
    createSelection: createHostedSelection('auto'),
    restoreSelection: createHostedSelectionRestorer('auto'),
    executor: 'hosted',
    capabilities: {
      modelSelection: 'static',
      supportsEffort: false,
      supportsPermissionMode: false,
      supportsToolCalls: true,
      supportsFileWrites: true,
    },
  },
  {
    id: 'dnaforge-hosted-deep',
    kind: 'hosted-gateway',
    label: 'Deep',
    detail: userMessage('assistant.host.deep'),
    description: 'DNAForge-hosted AI workflow with server-managed routing and allowance.',
    optionCategory: 'hosted',
    target: { kind: 'hosted', tier: 'deep' },
    createSelection: createHostedSelection('deep'),
    restoreSelection: createHostedSelectionRestorer('deep'),
    executor: 'hosted',
    capabilities: {
      modelSelection: 'static',
      supportsEffort: false,
      supportsPermissionMode: false,
      supportsToolCalls: true,
      supportsFileWrites: true,
    },
  },
] as const satisfies readonly AssistantHostDescriptor[];

export function createDefaultAssistantHostDescriptors(
  hostedAiEnabled: boolean
): readonly AssistantHostDescriptor[] {
  return hostedAiEnabled
    ? [...HOSTED_ASSISTANT_HOST_DESCRIPTORS, ...CORE_ASSISTANT_HOST_DESCRIPTORS]
    : CORE_ASSISTANT_HOST_DESCRIPTORS;
}

export function hostedAiEnabledInThisBuild(): boolean {
  return __DNAFORGE_HOSTED_AI_ENABLED__;
}

export const DEFAULT_ASSISTANT_HOST_DESCRIPTORS = createDefaultAssistantHostDescriptors(
  hostedAiEnabledInThisBuild()
);

export function getCliAssistantHostDescriptors(
  descriptors: readonly AssistantHostDescriptor[] = DEFAULT_ASSISTANT_HOST_DESCRIPTORS
): CliAssistantHostDescriptor[] {
  return descriptors.filter(isCliAssistantHostDescriptor);
}

export function getAssistantHostDescriptorForTransport(
  transport: AgentTransport,
  descriptors: readonly AssistantHostDescriptor[] = DEFAULT_ASSISTANT_HOST_DESCRIPTORS
): AssistantHostDescriptor | null {
  return (
    descriptors.find(
      (descriptor) => descriptor.target.kind === 'cli' && descriptor.target.transport === transport
    ) ?? null
  );
}

export function getDirectApiHostDescriptor(
  descriptors: readonly AssistantHostDescriptor[] = DEFAULT_ASSISTANT_HOST_DESCRIPTORS
): AssistantHostDescriptor | null {
  return descriptors.find((descriptor) => descriptor.target.kind === 'direct-api') ?? null;
}

function isCliAssistantHostDescriptor(
  descriptor: AssistantHostDescriptor
): descriptor is CliAssistantHostDescriptor {
  return descriptor.target.kind === 'cli';
}
