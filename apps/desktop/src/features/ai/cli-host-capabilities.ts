import type {
  AgentCliModelCapabilityShape,
  AgentCliModelPersonality,
  AgentCliModelReasoningEffort,
  AgentTransport,
} from '../../platform';

export interface CliReasoningEffortOption {
  value: AgentCliModelReasoningEffort;
  label: string;
}

export interface CliServiceTierOption {
  value: string;
  label: string;
  description?: string;
}

export interface CliPersonalityOption {
  value: AgentCliModelPersonality | '';
  label: string;
}

export interface CliHostCapabilityDescriptor {
  transport: AgentTransport;
  version: 2;
  modelControl: 'catalog-custom';
  defaultReasoningEffort: AgentCliModelReasoningEffort;
  reasoningEfforts: readonly CliReasoningEffortOption[];
  interactionMatrix: 'agent-interaction-matrix-v1';
}

const CODEX_REASONING_EFFORTS: readonly CliReasoningEffortOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
];

const CLAUDE_REASONING_EFFORTS: readonly CliReasoningEffortOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

const GROK_REASONING_EFFORTS: readonly CliReasoningEffortOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

const descriptor = (
  transport: AgentTransport,
  reasoningEfforts: readonly CliReasoningEffortOption[]
): CliHostCapabilityDescriptor => ({
  transport,
  version: 2,
  modelControl: 'catalog-custom',
  defaultReasoningEffort: 'high',
  reasoningEfforts,
  interactionMatrix: 'agent-interaction-matrix-v1',
});

export const CLI_HOST_CAPABILITY_DESCRIPTORS: Record<AgentTransport, CliHostCapabilityDescriptor> =
  {
    'codex-sdk': descriptor('codex-sdk', CODEX_REASONING_EFFORTS),
    'claude-agent-sdk': descriptor('claude-agent-sdk', CLAUDE_REASONING_EFFORTS),
    'grok-acp': descriptor('grok-acp', GROK_REASONING_EFFORTS),
  };

export function getCliHostCapabilityDescriptor(
  transport: AgentTransport
): CliHostCapabilityDescriptor {
  return CLI_HOST_CAPABILITY_DESCRIPTORS[transport];
}

export function getCliReasoningEffortOptions(
  transport: AgentTransport,
  model?: string | null,
  runtimeModels: readonly Pick<
    AgentCliModelCapabilityShape,
    'id' | 'isDefault' | 'reasoningEfforts'
  >[] = []
): readonly CliReasoningEffortOption[] {
  const runtimeModel = model
    ? runtimeModels.find((candidate) => candidate.id === model)
    : runtimeModels.find((candidate) => candidate.isDefault);
  if (runtimeModel) {
    return runtimeModel.reasoningEfforts.map((value) => ({
      value,
      label:
        value === 'xhigh'
          ? 'Extra high'
          : value === 'none'
            ? 'None'
            : value[0].toUpperCase() + value.slice(1),
    }));
  }
  return getCliHostCapabilityDescriptor(transport).reasoningEfforts;
}

export function normalizeCliReasoningEffortForModel(
  effort: AgentCliModelReasoningEffort | null | undefined,
  model: string | null | undefined,
  runtimeModels: readonly Pick<
    AgentCliModelCapabilityShape,
    'id' | 'isDefault' | 'reasoningEfforts' | 'defaultReasoningEffort'
  >[],
  fallback: AgentCliModelReasoningEffort,
  transport: AgentTransport = 'codex-sdk'
): AgentCliModelReasoningEffort | null {
  const options = getCliReasoningEffortOptions(transport, model, runtimeModels).map(
    (option) => option.value
  );
  if (effort && options.includes(effort)) return effort;
  if (options.includes(fallback)) return fallback;
  const runtimeModel = model
    ? runtimeModels.find((candidate) => candidate.id === model)
    : runtimeModels.find((candidate) => candidate.isDefault);
  if (
    runtimeModel?.defaultReasoningEffort &&
    options.includes(runtimeModel.defaultReasoningEffort)
  ) {
    return runtimeModel.defaultReasoningEffort;
  }
  return options[0] ?? (runtimeModel ? null : fallback);
}

export function getCliServiceTierOptions(
  model: string | null | undefined,
  runtimeModels: readonly Pick<AgentCliModelCapabilityShape, 'id' | 'isDefault' | 'serviceTiers'>[]
): readonly CliServiceTierOption[] {
  const runtimeModel = model
    ? runtimeModels.find((candidate) => candidate.id === model)
    : runtimeModels.find((candidate) => candidate.isDefault);
  if (!runtimeModel?.serviceTiers?.length) return [];
  return [
    { value: '', label: 'Standard (provider default)' },
    ...runtimeModel.serviceTiers.map((tier) => ({
      value: tier.id,
      label: tier.label,
      ...(tier.description ? { description: tier.description } : {}),
    })),
  ];
}

export function normalizeCliServiceTierForModel(
  serviceTier: string | null | undefined,
  model: string | null | undefined,
  runtimeModels: readonly Pick<
    AgentCliModelCapabilityShape,
    'id' | 'isDefault' | 'serviceTiers' | 'defaultServiceTier'
  >[]
): string | null {
  const runtimeModel = model
    ? runtimeModels.find((candidate) => candidate.id === model)
    : runtimeModels.find((candidate) => candidate.isDefault);
  const supported = new Set(runtimeModel?.serviceTiers?.map((tier) => tier.id) ?? []);
  if (serviceTier && supported.has(serviceTier)) return serviceTier;
  return null;
}

export function getCliPersonalityOptions(
  transport: AgentTransport,
  model: string | null | undefined,
  runtimeModels: readonly Pick<
    AgentCliModelCapabilityShape,
    'id' | 'isDefault' | 'supportsPersonality' | 'styles' | 'defaultStyle'
  >[]
): readonly CliPersonalityOption[] {
  const runtimeModel = model
    ? runtimeModels.find((candidate) => candidate.id === model)
    : runtimeModels.find((candidate) => candidate.isDefault);
  if (runtimeModel?.styles?.length) {
    const defaultStyleLabel = runtimeModel.defaultStyle
      ? runtimeModel.styles.find((style) => style.id === runtimeModel.defaultStyle)?.label
      : null;
    return [
      {
        value: '',
        label: defaultStyleLabel
          ? `Provider default (${defaultStyleLabel})`
          : 'Provider default style',
      },
      ...runtimeModel.styles.map((style) => ({ value: style.id, label: style.label })),
    ];
  }
  if (transport !== 'codex-sdk') return [];
  if (!runtimeModel?.supportsPersonality) return [];
  return [
    { value: '', label: 'Provider default style' },
    { value: 'friendly', label: 'Friendly' },
    { value: 'pragmatic', label: 'Pragmatic' },
    { value: 'none', label: 'No personality' },
  ];
}

export function normalizeCliPersonalityForModel(
  personality: AgentCliModelPersonality | null | undefined,
  transport: AgentTransport,
  model: string | null | undefined,
  runtimeModels: readonly Pick<
    AgentCliModelCapabilityShape,
    'id' | 'isDefault' | 'supportsPersonality' | 'styles' | 'defaultStyle'
  >[]
): AgentCliModelPersonality | null {
  const options = getCliPersonalityOptions(transport, model, runtimeModels);
  return personality && options.some((option) => option.value === personality) ? personality : null;
}

export function getCliSupportedReasoningEfforts(
  transport: AgentTransport
): readonly AgentCliModelReasoningEffort[] {
  return getCliReasoningEffortOptions(transport).map((option) => option.value);
}
