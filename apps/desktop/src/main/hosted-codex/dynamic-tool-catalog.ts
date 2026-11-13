import { createHash } from 'node:crypto';
import {
  HOSTED_NATIVE_TOOL_DEFINITIONS,
  hostedResponsesFunctionWireName,
} from '@waypoint/hosted-ai-contract';

import rendererToolManifest from '../../../../../packages/core/agent-tools/renderer-tool-manifest.json';

export type ToolEffect = 'read-only' | 'ui-bound' | 'mutating' | 'external-submit';

export interface HostedCodexTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effects: readonly ToolEffect[];
  readonly requiresWorkspace: boolean;
}

export interface HostedCodexToolCatalog {
  readonly tools: readonly HostedCodexTool[];
  readonly digest: string;
}

export const DENIED_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'shell',
  'local_shell',
  'exec_command',
  'apply_patch',
  'write_file',
  'edit_file',
  'web_search',
  'browser',
  'mcp',
  'mcp_call',
  'subagent',
  'task',
  'plugin',
  'skill',
  'memory',
  'view_image',
  'update_plan',
  'request_user_input',
]);

export class HostedCodexToolCatalogError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HostedCodexToolCatalogError';
  }
}

export function hostedCodexToolWireName(canonicalName: string): string {
  return hostedResponsesFunctionWireName(canonicalName);
}

export function hostedCodexCanonicalToolName(
  tools: readonly HostedCodexTool[],
  wireName: string
): string | null {
  for (const tool of tools) {
    if (hostedCodexToolWireName(tool.name) === wireName) return tool.name;
  }
  return null;
}

export function hostedCodexWireInputSchema(
  schema: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const normalized = normalizeSchemaNode(schema);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new HostedCodexToolCatalogError(
      'invalid_wire_schema',
      'a Hosted Codex tool input schema must normalize to an object'
    );
  }
  return normalized as Readonly<Record<string, unknown>>;
}

const CODEX_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'integer',
  'object',
  'array',
  'null',
]);

function normalizeSchemaNode(value: unknown): unknown {
  if (typeof value === 'boolean') return { type: 'string' };
  if (Array.isArray(value)) return value.map(normalizeSchemaNode);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Readonly<Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  const normalizedType = normalizeSchemaType(source.type);
  const hasComposition = ['anyOf', 'oneOf', 'allOf'].some((key) => key in source);
  let schemaType = normalizedType;

  if (schemaType === undefined && !('$ref' in source) && !hasComposition) {
    if ('properties' in source || 'required' in source || 'additionalProperties' in source) {
      schemaType = 'object';
    } else if ('items' in source || 'prefixItems' in source) {
      schemaType = 'array';
    } else if ('enum' in source || 'const' in source || 'format' in source) {
      schemaType = 'string';
    } else if (
      ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].some(
        (key) => key in source
      )
    ) {
      schemaType = 'number';
    } else {
      return {};
    }
  }

  if (typeof source.$ref === 'string') result.$ref = source.$ref;
  if (schemaType !== undefined) result.type = schemaType;
  if (typeof source.description === 'string') result.description = source.description;
  if (typeof source.encrypted === 'boolean') result.encrypted = source.encrypted;
  if (Array.isArray(source.enum)) result.enum = structuredClone(source.enum);
  else if ('const' in source) result.enum = [structuredClone(source.const)];
  if (Array.isArray(source.items)) {
    result.items = { anyOf: source.items.map(normalizeSchemaNode) };
    const tupleDescription = `Items must follow these schemas in order: ${JSON.stringify(source.items)}.`;
    result.description =
      typeof result.description === 'string'
        ? `${result.description}\n${tupleDescription}`
        : tupleDescription;
  } else if ('items' in source) {
    result.items = normalizeSchemaNode(source.items);
  }
  if (source.properties !== null && typeof source.properties === 'object') {
    result.properties = Object.fromEntries(
      Object.entries(source.properties as Readonly<Record<string, unknown>>).map(([key, child]) => [
        key,
        normalizeSchemaNode(child),
      ])
    );
  }
  if (Array.isArray(source.required)) result.required = structuredClone(source.required);
  if (typeof source.additionalProperties === 'boolean') {
    result.additionalProperties = source.additionalProperties;
  } else if (
    source.additionalProperties !== null &&
    typeof source.additionalProperties === 'object'
  ) {
    result.additionalProperties = normalizeSchemaNode(source.additionalProperties);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(source[key])) result[key] = source[key].map(normalizeSchemaNode);
  }
  for (const key of ['$defs', 'definitions'] as const) {
    if (source[key] !== null && typeof source[key] === 'object') {
      result[key] = Object.fromEntries(
        Object.entries(source[key] as Readonly<Record<string, unknown>>).map(([name, child]) => [
          name,
          normalizeSchemaNode(child),
        ])
      );
    }
  }

  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  if (types.includes('object') && !('properties' in result)) result.properties = {};
  if (types.includes('array') && !('items' in result)) result.items = { type: 'string' };
  return result;
}

function normalizeSchemaType(value: unknown): string | readonly string[] | undefined {
  if (typeof value === 'string') return CODEX_SCHEMA_TYPES.has(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const types = value.filter(
    (entry): entry is string => typeof entry === 'string' && CODEX_SCHEMA_TYPES.has(entry)
  );
  return types.length > 0 ? types : undefined;
}

interface ManifestTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  effects?: unknown;
  requiresWorkspace?: unknown;
  exposure?: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function manifestTools(source: unknown): readonly ManifestTool[] {
  const tools = (source as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    throw new HostedCodexToolCatalogError(
      'unreadable_manifest',
      'renderer-tool-manifest.json does not declare a tools array'
    );
  }
  return tools as readonly ManifestTool[];
}

function readEffects(tool: ManifestTool, name: string): readonly ToolEffect[] {
  if (!Array.isArray(tool.effects) || tool.effects.length === 0) {
    throw new HostedCodexToolCatalogError(
      'undeclared_effects',
      `manifest tool "${name}" does not declare its effects`
    );
  }
  for (const effect of tool.effects) {
    if (
      effect !== 'read-only' &&
      effect !== 'ui-bound' &&
      effect !== 'mutating' &&
      effect !== 'external-submit'
    ) {
      throw new HostedCodexToolCatalogError(
        'unknown_effect',
        `manifest tool "${name}" declares unknown effect "${String(effect)}"`
      );
    }
  }
  return tool.effects as readonly ToolEffect[];
}

function readExposure(tool: ManifestTool, name: string): 'shared' | 'mcp-only' {
  const exposure = tool.exposure;
  if (exposure === null || typeof exposure !== 'object' || Array.isArray(exposure)) {
    throw new HostedCodexToolCatalogError(
      'undeclared_exposure',
      `manifest tool "${name}" does not declare its exposure`
    );
  }
  const kind = (exposure as { kind?: unknown }).kind;
  if (kind === 'shared') return kind;
  if (
    kind === 'mcp-only' &&
    typeof (exposure as { reason?: unknown }).reason === 'string' &&
    (exposure as { reason: string }).reason.trim().length > 0
  ) {
    return kind;
  }
  throw new HostedCodexToolCatalogError(
    'invalid_exposure',
    `manifest tool "${name}" declares an invalid exposure`
  );
}

export function buildHostedCodexToolCatalog(
  options: {
    readonly allowEffects?: readonly ToolEffect[];
    readonly omitNames?: readonly string[];
    readonly manifest?: unknown;
  } = {}
): HostedCodexToolCatalog {
  const allowed = new Set<ToolEffect>(options.allowEffects ?? ['read-only']);
  const omitted = new Set(options.omitNames ?? []);
  const tools: HostedCodexTool[] = [];
  const seenNames = new Set<string>();

  const sources: readonly ManifestTool[] = [
    ...manifestTools(options.manifest ?? rendererToolManifest),
    ...HOSTED_NATIVE_TOOL_DEFINITIONS.map((tool) => ({
      ...tool,
      requiresWorkspace: false,
      exposure: { kind: 'shared' as const },
    })),
  ];

  for (const tool of sources) {
    const name = typeof tool.name === 'string' ? tool.name : '';
    if (name.length === 0) {
      throw new HostedCodexToolCatalogError(
        'unnamed_tool',
        'manifest declares a tool with no name'
      );
    }
    if (DENIED_NATIVE_TOOL_NAMES.has(name)) {
      throw new HostedCodexToolCatalogError(
        'denied_native_tool',
        `"${name}" is a Codex-native capability and must never be exposed through this runtime`
      );
    }
    if (seenNames.has(name)) {
      throw new HostedCodexToolCatalogError(
        'duplicate_tool',
        `canonical Hosted tool contract declares "${name}" more than once`
      );
    }
    seenNames.add(name);

    if (readExposure(tool, name) === 'mcp-only') continue;

    const effects = readEffects(tool, name);
    if (!effects.every((effect) => allowed.has(effect))) continue;

    if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
      throw new HostedCodexToolCatalogError(
        'undescribed_tool',
        `manifest tool "${name}" has no description for the model to read`
      );
    }
    if (tool.inputSchema === null || typeof tool.inputSchema !== 'object') {
      throw new HostedCodexToolCatalogError(
        'unschematized_tool',
        `manifest tool "${name}" has no input schema`
      );
    }

    tools.push({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      effects,
      requiresWorkspace: tool.requiresWorkspace === true,
    });
  }

  for (const name of omitted) {
    if (!seenNames.has(name)) {
      throw new HostedCodexToolCatalogError('unknown_tool', `cannot omit unknown tool "${name}"`);
    }
  }
  const exposedTools = tools.filter((tool) => !omitted.has(tool.name));
  exposedTools.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  return {
    tools: exposedTools,
    digest: createHash('sha256').update(canonicalJson(exposedTools), 'utf8').digest('hex'),
  };
}

export function selectHostedCodexTools(
  catalog: HostedCodexToolCatalog,
  requested: readonly string[]
): readonly HostedCodexTool[] {
  const byName = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  return requested.map((name) => {
    const tool = byName.get(name);
    if (!tool) {
      throw new HostedCodexToolCatalogError(
        'unknown_tool',
        `"${name}" is not in this turn's tool catalog`
      );
    }
    return tool;
  });
}
