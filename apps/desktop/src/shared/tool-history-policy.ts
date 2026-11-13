import rendererToolManifest from '../../../../packages/core/agent-tools/renderer-tool-manifest.json';

export type ToolHistoryMode = 'inspect-only' | 'reactivate';
export type ToolHistoryHandler = 'open-tab' | 'highlight-range';

export interface InspectOnlyToolHistoryPolicy {
  mode: 'inspect-only';
}

export interface ReactivateToolHistoryPolicy {
  mode: 'reactivate';
  handler: ToolHistoryHandler;
  label: string;
}

export type ToolHistoryPolicy = InspectOnlyToolHistoryPolicy | ReactivateToolHistoryPolicy;

type RawHistoryPolicy = {
  defaultMode?: unknown;
  tools?: Record<string, { mode?: unknown; handler?: unknown; label?: unknown }>;
};

const REACTIVATION_HANDLERS = new Set<ToolHistoryHandler>(['open-tab', 'highlight-range']);
const manifest = rendererToolManifest as typeof rendererToolManifest & {
  historyPolicy?: RawHistoryPolicy;
};

export function toolHistoryPolicy(toolName: string): ToolHistoryPolicy {
  const raw = manifest.historyPolicy?.tools?.[toolName];
  if (
    raw?.mode === 'reactivate' &&
    typeof raw.handler === 'string' &&
    REACTIVATION_HANDLERS.has(raw.handler as ToolHistoryHandler) &&
    typeof raw.label === 'string' &&
    raw.label.trim().length > 0
  ) {
    return {
      mode: 'reactivate',
      handler: raw.handler as ToolHistoryHandler,
      label: raw.label,
    };
  }
  return { mode: 'inspect-only' };
}

export function isHistoryReactivatableTool(toolName: string): boolean {
  return toolHistoryPolicy(toolName).mode === 'reactivate';
}

export function validateToolHistoryPolicy(): string[] {
  const errors: string[] = [];
  const knownTools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  if (manifest.historyPolicy?.defaultMode !== 'inspect-only') {
    errors.push('historyPolicy.defaultMode must be inspect-only');
  }
  for (const [toolName, raw] of Object.entries(manifest.historyPolicy?.tools ?? {})) {
    const tool = knownTools.get(toolName);
    if (!tool) errors.push(`unknown history tool: ${toolName}`);
    if (tool && !tool.effects.includes('ui-bound')) {
      errors.push(`${toolName}: reactivation is limited to ui-bound tools`);
    }
    if (raw.mode !== 'reactivate') errors.push(`${toolName}: mode must be reactivate`);
    if (
      typeof raw.handler !== 'string' ||
      !REACTIVATION_HANDLERS.has(raw.handler as ToolHistoryHandler)
    ) {
      errors.push(`${toolName}: unknown history handler`);
    }
    if (typeof raw.label !== 'string' || raw.label.trim().length === 0) {
      errors.push(`${toolName}: label is required`);
    }
  }
  return errors;
}

const historyPolicyErrors = validateToolHistoryPolicy();
if (historyPolicyErrors.length > 0) {
  throw new Error(`Invalid renderer tool history policy:\n${historyPolicyErrors.join('\n')}`);
}
