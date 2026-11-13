import rendererToolManifest from '../../../../../packages/core/agent-tools/renderer-tool-manifest.json';

interface ManifestTool {
  name?: unknown;
  requiresWorkspace?: unknown;
  effects?: unknown;
  workspaceGrounding?: unknown;
  inputSchema?: {
    properties?: Record<string, unknown>;
  };
}

const CANONICAL_WORKSPACE_TOOL = 'list_files';

export function requiredWorkspaceToolNames(): string[] {
  const tools = (rendererToolManifest as { tools?: ManifestTool[] }).tools ?? [];
  const names = tools
    .filter(
      (tool) =>
        tool.requiresWorkspace === true &&
        Array.isArray(tool.effects) &&
        tool.effects.includes('read-only')
    )
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

  if (!names.includes(CANONICAL_WORKSPACE_TOOL)) {
    throw new Error(
      `renderer-tool-manifest.json does not mark "${CANONICAL_WORKSPACE_TOOL}" as ` +
        'requiresWorkspace. The DNAForge tool-liveness proof would be vacuous. ' +
        'Restore the flag rather than weakening the proof.'
    );
  }
  return names;
}

export function workspaceGroundingToolNames(): string[] {
  const tools = (rendererToolManifest as { tools?: ManifestTool[] }).tools ?? [];
  return tools
    .filter((tool) => groundingMode(tool) !== null)
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

type WorkspaceGroundingMode =
  | 'always'
  | 'when-ref-id'
  | 'when-existing-reference'
  | 'when-workspace-file';

function groundingMode(tool: ManifestTool): WorkspaceGroundingMode | null {
  if (!Array.isArray(tool.effects)) return null;
  const effects = new Set(tool.effects);
  const pureReadOnly =
    effects.has('read-only') && !effects.has('mutating') && !effects.has('ui-bound');

  if (tool.workspaceGrounding === 'when-existing-reference') {
    return 'when-existing-reference';
  }
  if (!pureReadOnly) return null;
  if (tool.workspaceGrounding === 'none') return null;
  if (
    tool.workspaceGrounding === 'always' ||
    tool.workspaceGrounding === 'when-ref-id' ||
    tool.workspaceGrounding === 'when-workspace-file'
  ) {
    return tool.workspaceGrounding;
  }
  throw new Error(
    `Read-only renderer tool "${String(tool.name)}" is missing a valid workspaceGrounding ` +
      'declaration in renderer-tool-manifest.json.'
  );
}

export function toolCallGroundsWorkspace(toolName: string, rawArgs: unknown): boolean {
  const tools = (rendererToolManifest as { tools?: ManifestTool[] }).tools ?? [];
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) return false;

  const mode = groundingMode(tool);
  if (mode === 'always') return true;
  if (rawArgs === null || typeof rawArgs !== 'object') return false;

  if (mode === 'when-workspace-file') {
    const path = (rawArgs as Record<string, unknown>).path;
    return typeof path === 'string' && path.trim().length > 0 && !path.startsWith('skill://');
  }

  if (mode === 'when-existing-reference') {
    const selection = (rawArgs as Record<string, unknown>).selection;
    if (selection === null || typeof selection !== 'object') return false;
    const staged = selection as Record<string, unknown>;
    return (
      staged.kind === 'existing_reference' &&
      typeof staged.referenceId === 'string' &&
      staged.referenceId.trim().length > 0
    );
  }

  if (mode !== 'when-ref-id') return false;

  const refId = (rawArgs as Record<string, unknown>).refId;
  return typeof refId === 'string' && refId.trim().length > 0;
}
