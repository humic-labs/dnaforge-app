import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentCliModelCapabilityShape,
  AgentCliModelReasoningEffort,
} from '../../shared/agent-runtime-ipc';

type ClaudeModelInfoLike = Omit<ModelInfo, 'supportedEffortLevels'> & {
  supportedEffortLevels?: readonly string[];
};

const REASONING_EFFORTS = new Set<AgentCliModelReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

function effort(value: unknown): AgentCliModelReasoningEffort | null {
  return typeof value === 'string' && REASONING_EFFORTS.has(value as AgentCliModelReasoningEffort)
    ? (value as AgentCliModelReasoningEffort)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function claudeDisplayName(model: ClaudeModelInfoLike): string | null {
  const displayName = text(model.displayName);
  if (!displayName) return null;
  const description = text(model.description);
  if (!description) return displayName;

  const descriptionLead = description.split(/\s+·\s+/u, 1)[0]?.trim();
  const describedFamily = descriptionLead?.match(/^[\p{L}\p{N}._-]+/u)?.[0];
  const describedVersion =
    describedFamily && /^\s+\d/u.test(descriptionLead!.slice(describedFamily.length))
      ? descriptionLead!.replace(/\s+with\s+(.+\bcontext)$/iu, ' ($1)')
      : null;

  if (/^default\b/iu.test(displayName)) {
    const currentModel = description.match(/\bcurrently\s+(.+)\)\s*(?:·|$)/iu)?.[1]?.trim();
    return currentModel
      ? `Default — ${currentModel}`
      : describedVersion
        ? `Default — ${describedVersion}`
        : displayName;
  }

  const family = displayName.match(/^[\p{L}\p{N}._-]+/u)?.[0];
  if (
    !family ||
    !descriptionLead ||
    descriptionLead.slice(0, family.length).toLocaleLowerCase() !== family.toLocaleLowerCase() ||
    !/^\s+\d/u.test(descriptionLead.slice(family.length))
  ) {
    return displayName;
  }

  return describedVersion ?? displayName;
}

function mapCodexModel(value: unknown): AgentCliModelCapabilityShape | null {
  const model = record(value);
  const id = text(model?.id) ?? text(model?.model);
  const displayName = text(model?.displayName) ?? id;
  if (!id || !displayName || model?.hidden === true) return null;
  const reasoningEfforts = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((option) => {
        const parsed = effort(record(option)?.reasoningEffort);
        return parsed ? [parsed] : [];
      })
    : [];
  const defaultReasoningEffort = effort(model?.defaultReasoningEffort);
  const serviceTiers = Array.isArray(model?.serviceTiers)
    ? model.serviceTiers.flatMap((value) => {
        const tier = record(value);
        const tierId = text(tier?.id);
        const label = text(tier?.name);
        if (!tierId || !label) return [];
        const description = text(tier?.description);
        return [{ id: tierId, label, ...(description ? { description } : {}) }];
      })
    : [];
  return {
    id,
    displayName,
    ...(text(model?.description) ? { description: text(model?.description)! } : {}),
    reasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(Array.isArray(model?.inputModalities)
      ? {
          inputModalities: model.inputModalities.filter(
            (item): item is string => typeof item === 'string'
          ),
        }
      : {}),
    supportsPersonality: model?.supportsPersonality === true,
    serviceTiers,
    defaultServiceTier: text(model?.defaultServiceTier),
    isDefault: model?.isDefault === true,
  };
}

export async function collectCodexModelCatalog(
  request: (method: string, params: unknown) => Promise<unknown>
): Promise<AgentCliModelCapabilityShape[]> {
  const models: AgentCliModelCapabilityShape[] = [];
  const seenModels = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const raw = record(await request('model/list', { cursor, limit: 100, includeHidden: false }));
    if (
      !raw ||
      !Array.isArray(raw.data) ||
      !(raw.nextCursor == null || typeof raw.nextCursor === 'string')
    ) {
      throw new Error('Codex model catalog response is invalid. Retry model discovery.');
    }
    const data = raw.data;
    for (const item of data) {
      const model = mapCodexModel(item);
      if (record(item)?.hidden === true) continue;
      if (!model) throw new Error('Codex model catalog contains an invalid model.');
      if (seenModels.has(model.id))
        throw new Error('Codex model catalog contains a duplicate model id.');
      seenModels.add(model.id);
      models.push(model);
    }
    const nextCursor = text(raw?.nextCursor);
    if (!nextCursor) return models;
    if (seenCursors.has(nextCursor)) throw new Error('Codex model catalog repeated a page cursor.');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error('Codex model catalog is incomplete after 20 pages. Retry model discovery.');
}

export function mapClaudeModelCatalog(
  models: readonly ClaudeModelInfoLike[],
  options: {
    outputStyles?: readonly string[];
    defaultStyle?: string | null;
  } = {}
): AgentCliModelCapabilityShape[] {
  const styles = [...new Set(options.outputStyles ?? [])].flatMap((value) => {
    const id = text(value);
    if (!id) return [];
    return [{ id, label: id[0].toUpperCase() + id.slice(1).replace(/[-_]+/g, ' ') }];
  });
  return models.flatMap((model) => {
    const id = text(model.value);
    const displayName = claudeDisplayName(model);
    if (!id || !displayName) return [];
    const reasoningEfforts = (model.supportedEffortLevels ?? []).flatMap((value) => {
      const parsed = effort(value);
      return parsed ? [parsed] : [];
    });
    return [
      {
        id,
        displayName,
        ...(text(model.description) ? { description: text(model.description)! } : {}),
        reasoningEfforts,
        ...(model.supportsFastMode
          ? {
              serviceTiers: [
                { id: 'fast', label: 'Fast', description: 'Lower-latency Claude mode' },
              ],
              defaultServiceTier: null,
            }
          : {}),
        ...(styles.length > 0
          ? {
              styles,
              defaultStyle: text(options.defaultStyle),
            }
          : {}),
        isDefault: id === 'default',
      },
    ];
  });
}

export function mapGrokAcpModelCatalog(value: unknown): AgentCliModelCapabilityShape[] {
  const root = record(value);
  const rootMeta = record(root?._meta);
  const state =
    record(rootMeta?.modelState) ?? record(root?.models) ?? record(root?.modelState) ?? root;
  const availableModels = Array.isArray(state?.availableModels) ? state.availableModels : [];
  const currentModelId = text(state?.currentModelId);

  return availableModels.flatMap((candidate) => {
    const model = record(candidate);
    const id = text(model?.modelId) ?? text(model?.id);
    if (!id) return [];
    const metadata = record(model?._meta);
    const reasoningEfforts = Array.isArray(metadata?.reasoningEfforts)
      ? metadata.reasoningEfforts.flatMap((candidate) => {
          const option = record(candidate);
          const parsed = effort(option?.value) ?? effort(option?.id);
          return parsed ? [parsed] : [];
        })
      : [];
    const markedDefaultReasoningEffort = Array.isArray(metadata?.reasoningEfforts)
      ? metadata.reasoningEfforts.find((candidate) => record(candidate)?.default === true)
      : undefined;
    const defaultReasoningEffort =
      effort(record(markedDefaultReasoningEffort)?.value) ??
      effort(record(markedDefaultReasoningEffort)?.id) ??
      effort(metadata?.reasoningEffort);
    const description = text(model?.description);
    return [
      {
        id,
        displayName: text(model?.name) ?? id,
        ...(description ? { description } : {}),
        reasoningEfforts,
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        isDefault: id === currentModelId,
      },
    ];
  });
}

export function mapGrokModelCatalog(modelIds: readonly string[]): AgentCliModelCapabilityShape[] {
  return [...new Set(modelIds.map((model) => model.trim()).filter(Boolean))].map((id) => ({
    id,
    displayName: id,
    reasoningEfforts: [],
  }));
}

export { validateModelSelection } from '../../shared/cli-model-selection';
