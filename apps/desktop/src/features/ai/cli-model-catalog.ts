import type {
  AgentCliModelCapabilityShape,
  AgentSdkDetectionShape,
  AgentTransport,
} from '../../platform';
import { isCodexModelSupportedForAuth, type CodexAuthMode } from '../../shared/codex-model-support';

export const CLI_MODEL_CATALOG_VERSION = 4;
export const CLI_DEFAULT_MODEL_SELECT_VALUE = '__cli_default__';
export const CLI_CUSTOM_MODEL_SELECT_VALUE = '__custom_cli_model__';

export interface CliModelCatalogOption {
  value: string;
  label: string;
  description?: string;
}

type RuntimeModelOption = Pick<AgentCliModelCapabilityShape, 'id' | 'displayName' | 'description'>;

export const CLI_MODEL_CATALOG: Record<AgentTransport, readonly CliModelCatalogOption[]> = {
  'codex-sdk': [],
  'claude-agent-sdk': [],
  'grok-acp': [],
};

export function getCliModelCatalogOptions(
  transport: AgentTransport,
  codexAuthMode?: CodexAuthMode,
  runtimeModels: readonly RuntimeModelOption[] = []
): readonly CliModelCatalogOption[] {
  if (runtimeModels.length > 0) {
    const seen = new Set<string>();
    return runtimeModels.flatMap((model) => {
      if (!model.id.trim() || seen.has(model.id)) return [];
      seen.add(model.id);
      return [
        {
          value: model.id,
          label: model.displayName,
          ...(model.description ? { description: model.description } : {}),
        },
      ];
    });
  }
  const options = CLI_MODEL_CATALOG[transport];
  return transport === 'codex-sdk'
    ? options.filter((option) => isCodexModelSupportedForAuth(option.value, codexAuthMode))
    : options;
}

export function getCliModelCatalogOption(
  transport: AgentTransport,
  model: string | null | undefined,
  codexAuthMode?: CodexAuthMode,
  runtimeModels: readonly RuntimeModelOption[] = []
): CliModelCatalogOption | null {
  if (!model) return null;
  return (
    getCliModelCatalogOptions(transport, codexAuthMode, runtimeModels).find(
      (option) => option.value === model
    ) ?? null
  );
}

export function isCliModelInCatalog(
  transport: AgentTransport,
  model: string | null | undefined,
  codexAuthMode?: CodexAuthMode,
  runtimeModels: readonly RuntimeModelOption[] = []
): boolean {
  return !!getCliModelCatalogOption(transport, model, codexAuthMode, runtimeModels);
}

export function getCliModelSelectValue(
  transport: AgentTransport,
  model: string | null | undefined,
  codexAuthMode?: CodexAuthMode,
  runtimeModels: readonly RuntimeModelOption[] = []
): string {
  if (!model) return CLI_DEFAULT_MODEL_SELECT_VALUE;
  return isCliModelInCatalog(transport, model, codexAuthMode, runtimeModels)
    ? model
    : CLI_CUSTOM_MODEL_SELECT_VALUE;
}

export function getCliModelDisplayLabel(
  transport: AgentTransport,
  model: string | null | undefined,
  codexAuthMode?: CodexAuthMode,
  runtimeModels: readonly RuntimeModelOption[] = []
): string {
  if (!model) return 'Provider default model';
  return getCliModelCatalogOption(transport, model, codexAuthMode, runtimeModels)?.label ?? model;
}

export function getDetectedCliDefaultModel(
  detection: AgentSdkDetectionShape | null | undefined,
  transport: AgentTransport
): string | null {
  if (transport === 'codex-sdk') return detection?.codex?.defaultModel ?? null;
  if (transport === 'grok-acp') return detection?.grok?.defaultModel ?? null;
  return detection?.claudeCode?.defaultModel ?? null;
}

export function getDetectedCliModels(
  detection: AgentSdkDetectionShape | null | undefined,
  transport: AgentTransport
): readonly AgentCliModelCapabilityShape[] {
  if (transport === 'codex-sdk') return detection?.codex?.models ?? [];
  if (transport === 'grok-acp') return detection?.grok?.models ?? [];
  return detection?.claudeCode?.models ?? [];
}

export function getCliDefaultModelDisplayLabel(
  transport: AgentTransport,
  defaultModel: string | null | undefined,
  codexAuthMode?: CodexAuthMode,
  runtimeModels: readonly RuntimeModelOption[] = []
): string {
  return defaultModel
    ? getCliModelDisplayLabel(transport, defaultModel, codexAuthMode, runtimeModels)
    : 'Provider default model';
}
