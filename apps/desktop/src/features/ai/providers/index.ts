import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3FunctionTool } from '@ai-sdk/provider';

export type BuiltInProviderName = 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek';
export type CustomProviderName = `custom:${string}`;
export type ProviderName = BuiltInProviderName | CustomProviderName;

export interface CustomProviderDefinition {
  id: CustomProviderName;
  label: string;
  baseUrl: string;
  defaultModel: string;
}

export type ProviderModelFactory =
  | { adapter: 'anthropic' }
  | { adapter: 'openai' }
  | { adapter: 'google' }
  | { adapter: 'xai' }
  | { adapter: 'deepseek' }
  | { adapter: 'openai-compatible'; baseUrl: string };

export type OpenAICompatibleModelFilter = 'chat' | 'none';

export type ProviderModelDiscovery =
  | { adapter: 'anthropic' }
  | { adapter: 'google' }
  | {
      adapter: 'openai-compatible';
      baseUrl: string;
      providerLabel: string;
      modelFilter: OpenAICompatibleModelFilter;
    };

export interface ProviderCredentialMeta {
  kind: 'api-key';
  label: string;
  keyringAccount: string;
  envVar: string;
  placeholder: string;
  storageLabel: string;
}

export interface ProviderMeta {
  name: ProviderName;
  label: string;
  defaultModel: string;
  retiredModels?: string[];
  credential: ProviderCredentialMeta;
  modelFactory: ProviderModelFactory;
  modelDiscovery: ProviderModelDiscovery;
}

function describeSchemaValues(values: readonly unknown[]): string {
  return values
    .map((value) => (typeof value === 'string' ? JSON.stringify(value) : String(value)))
    .join(', ');
}

function appendSchemaGuidance(schema: Record<string, unknown>, guidance: string): void {
  const description = typeof schema.description === 'string' ? schema.description.trim() : '';
  schema.description = description ? `${description} ${guidance}` : guidance;
}

function normalizeGoogleSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeGoogleSchemaValue);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeGoogleSchemaValue(child)])
  );
  const enumValues = normalized.enum;
  if (Array.isArray(enumValues) && enumValues.some((entry) => typeof entry !== 'string')) {
    delete normalized.enum;
    appendSchemaGuidance(normalized, `Allowed values: ${describeSchemaValues(enumValues)}.`);
  }

  if ('const' in normalized && typeof normalized.const !== 'string') {
    const constValue = normalized.const;
    delete normalized.const;
    appendSchemaGuidance(normalized, `Required value: ${String(constValue)}.`);
  }

  return normalized;
}

export function normalizeGoogleToolSchema(
  schema: LanguageModelV3FunctionTool['inputSchema']
): LanguageModelV3FunctionTool['inputSchema'] {
  return normalizeGoogleSchemaValue(schema) as LanguageModelV3FunctionTool['inputSchema'];
}

const googleToolSchemaMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }) => ({
    ...params,
    tools: params.tools?.map((tool) =>
      tool.type === 'function'
        ? { ...tool, inputSchema: normalizeGoogleToolSchema(tool.inputSchema) }
        : tool
    ),
  }),
};

function apiKeyCredential(
  provider: ProviderName,
  envVar: string,
  placeholder: string
): ProviderCredentialMeta {
  return {
    kind: 'api-key',
    label: 'API key',
    keyringAccount: `${provider}_api_key`,
    envVar,
    placeholder,
    storageLabel: 'OS keychain',
  };
}

export const PROVIDERS: ProviderMeta[] = [
  {
    name: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-6',
    retiredModels: ['claude-fable-5', 'claude-sonnet-4-20250514'],
    credential: apiKeyCredential('anthropic', 'ANTHROPIC_API_KEY', 'Paste an Anthropic API key'),
    modelFactory: { adapter: 'anthropic' },
    modelDiscovery: { adapter: 'anthropic' },
  },
  {
    name: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o',
    credential: apiKeyCredential('openai', 'OPENAI_API_KEY', 'Paste an OpenAI API key'),
    modelFactory: { adapter: 'openai' },
    modelDiscovery: {
      adapter: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      providerLabel: 'OpenAI',
      modelFilter: 'chat',
    },
  },
  {
    name: 'google',
    label: 'Google',
    defaultModel: 'gemini-3.5-flash',
    retiredModels: ['gemini-2.0-flash', 'gemini-3-pro-preview'],
    credential: apiKeyCredential('google', 'GOOGLE_API_KEY', 'Paste a Google API key'),
    modelFactory: { adapter: 'google' },
    modelDiscovery: { adapter: 'google' },
  },
  {
    name: 'xai',
    label: 'xAI',
    defaultModel: 'grok-4.3',
    credential: apiKeyCredential('xai', 'XAI_API_KEY', 'Paste an xAI API key'),
    modelFactory: { adapter: 'xai' },
    modelDiscovery: {
      adapter: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      providerLabel: 'xAI',
      modelFilter: 'chat',
    },
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    credential: apiKeyCredential('deepseek', 'DEEPSEEK_API_KEY', 'Paste a DeepSeek API key'),
    modelFactory: { adapter: 'deepseek' },
    modelDiscovery: {
      adapter: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      providerLabel: 'DeepSeek',
      modelFilter: 'none',
    },
  },
];

let customProviderDefinitions: CustomProviderDefinition[] = [];

function normalizeCustomProviderUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Endpoint must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Endpoint must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Put credentials in the API key field, not in the endpoint URL.');
  }
  if (url.search || url.hash) {
    throw new Error('Endpoint cannot include a query string or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function normalizeCustomProviderDefinition(
  definition: CustomProviderDefinition
): CustomProviderDefinition {
  const id = definition.id.trim() as CustomProviderName;
  const label = definition.label.trim();
  const defaultModel = definition.defaultModel.trim();
  if (!/^custom:[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) {
    throw new Error('Custom provider ID is invalid.');
  }
  if (!label || label.length > 80) {
    throw new Error('Provider name must be between 1 and 80 characters.');
  }
  if (!defaultModel || defaultModel.length > 160) {
    throw new Error('Model must be between 1 and 160 characters.');
  }
  return {
    id,
    label,
    baseUrl: normalizeCustomProviderUrl(definition.baseUrl),
    defaultModel,
  };
}

export function createCustomProviderId(label: string): CustomProviderName {
  const slug =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'endpoint';
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36);
  return `custom:${slug}-${suffix}`;
}

export function replaceCustomProviderDefinitions(
  definitions: readonly CustomProviderDefinition[]
): void {
  const normalized = definitions.map(normalizeCustomProviderDefinition);
  const ids = new Set<ProviderName>(PROVIDERS.map((provider) => provider.name));
  for (const definition of normalized) {
    if (ids.has(definition.id)) throw new Error(`Duplicate provider ID "${definition.id}".`);
    ids.add(definition.id);
  }
  customProviderDefinitions = normalized;
}

export function getCustomProviderDefinitions(): CustomProviderDefinition[] {
  return customProviderDefinitions.map((definition) => ({ ...definition }));
}

function customProviderMeta(definition: CustomProviderDefinition): ProviderMeta {
  const envName = `${definition.label.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`;
  return {
    name: definition.id,
    label: definition.label,
    defaultModel: definition.defaultModel,
    credential: apiKeyCredential(
      definition.id,
      envName,
      `Paste the API key for ${definition.label}`
    ),
    modelFactory: { adapter: 'openai-compatible', baseUrl: definition.baseUrl },
    modelDiscovery: {
      adapter: 'openai-compatible',
      baseUrl: definition.baseUrl,
      providerLabel: definition.label,
      modelFilter: 'none',
    },
  };
}

export function getAllProviderMetas(): ProviderMeta[] {
  return [...PROVIDERS, ...customProviderDefinitions.map(customProviderMeta)];
}

export function isRegisteredProviderName(value: string): value is ProviderName {
  return getAllProviderMetas().some((provider) => provider.name === value);
}

export function getProviderMeta(providerName: ProviderName): ProviderMeta {
  const meta = getAllProviderMetas().find((provider) => provider.name === providerName);
  if (!meta) throw new Error(`No metadata for provider "${providerName}"`);
  return meta;
}

export function getDefaultModel(providerName: ProviderName): string {
  return getProviderMeta(providerName).defaultModel;
}

export function isProviderModelRetired(providerName: ProviderName, model: string): boolean {
  return getProviderMeta(providerName).retiredModels?.includes(model) ?? false;
}

export function filterRetiredProviderModels(
  providerName: ProviderName,
  models: string[]
): string[] {
  const retiredModels = getProviderMeta(providerName).retiredModels;
  if (!retiredModels?.length) return models;
  const retired = new Set(retiredModels);
  return models.filter((model) => !retired.has(model));
}

export function createModelFromProviderMeta(
  provider: ProviderMeta,
  apiKey: string,
  modelId?: string
): LanguageModel {
  if (!apiKey || !apiKey.trim()) {
    throw new Error(`API key is required for provider "${provider.name}"`);
  }

  const model = modelId && modelId.trim() ? modelId : provider.defaultModel;
  const fetch = globalThis.fetch;

  try {
    switch (provider.modelFactory.adapter) {
      case 'anthropic':
        return createAnthropic({
          apiKey,
          fetch,
          headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
        })(model);
      case 'openai':
        return createOpenAI({ apiKey, fetch })(model);
      case 'google':
        return wrapLanguageModel({
          model: createGoogleGenerativeAI({ apiKey, fetch })(model),
          middleware: googleToolSchemaMiddleware,
        });
      case 'xai':
        return createXai({ apiKey, fetch })(model);
      case 'deepseek':
        return createDeepSeek({ apiKey, fetch })(model);
      case 'openai-compatible':
        return createOpenAI({
          apiKey,
          fetch,
          baseURL: provider.modelFactory.baseUrl,
        })(model);
      default: {
        const _exhaustive: never = provider.modelFactory;
        throw new Error(`Unhandled provider model factory: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to initialize ${provider.name} provider (model: ${model}): ${message}`);
  }
}

export async function createModel(
  providerName: ProviderName,
  apiKey: string,
  modelId?: string
): Promise<LanguageModel> {
  return createModelFromProviderMeta(getProviderMeta(providerName), apiKey, modelId);
}
