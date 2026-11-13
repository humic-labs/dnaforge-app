import {
  filterRetiredProviderModels,
  getProviderMeta,
  type ProviderMeta,
  type ProviderModelDiscovery,
  type ProviderName,
} from './providers';

export interface FetchModelsResult {
  models: string[];
  error: string | null;
}

const OPENAI_EXCLUDE_PREFIXES = [
  'text-embedding-',
  'dall-e-',
  'tts-',
  'whisper-',
  'babbage-',
  'davinci-',
  'curie-',
  'ada-',
  'ft:',
  'omni-moderation-',
];

function isExcludedOpenAIModel(id: string): boolean {
  return OPENAI_EXCLUDE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

async function fetchAnthropic(apiKey: string): Promise<FetchModelsResult> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
  if (!res.ok) {
    return { models: [], error: `Anthropic API error: ${res.status} ${res.statusText}` };
  }
  const json = await res.json();
  const data = json.data as Array<{ id: string }> | undefined;
  if (!Array.isArray(data)) {
    return { models: [], error: 'Unexpected Anthropic API response format' };
  }
  const models = data.map((m) => m.id).sort();
  return { models, error: null };
}

async function fetchOpenAICompatible(
  apiKey: string,
  discovery: Extract<ProviderModelDiscovery, { adapter: 'openai-compatible' }>
): Promise<FetchModelsResult> {
  const baseUrl = discovery.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    return {
      models: [],
      error: `${discovery.providerLabel} API error: ${res.status} ${res.statusText}`,
    };
  }
  const json = await res.json();
  const data = json.data as Array<{ id: string }> | undefined;
  if (!Array.isArray(data)) {
    return { models: [], error: `Unexpected ${discovery.providerLabel} API response format` };
  }
  const models = data
    .map((m) => m.id)
    .filter((id) => discovery.modelFilter !== 'chat' || !isExcludedOpenAIModel(id))
    .sort();
  return { models, error: null };
}

async function fetchGoogle(apiKey: string): Promise<FetchModelsResult> {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!res.ok) {
    return { models: [], error: `Google API error: ${res.status} ${res.statusText}` };
  }
  const json = await res.json();
  const data = json.models as
    | Array<{ name: string; supportedGenerationMethods: string[] }>
    | undefined;
  if (!Array.isArray(data)) {
    return { models: [], error: 'Unexpected Google API response format' };
  }
  const models = data
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .sort();
  return { models, error: null };
}

export async function fetchModelsFromProviderMeta(
  provider: ProviderMeta,
  apiKey: string
): Promise<FetchModelsResult> {
  try {
    let result: FetchModelsResult;
    switch (provider.modelDiscovery.adapter) {
      case 'anthropic':
        result = await fetchAnthropic(apiKey);
        break;
      case 'google':
        result = await fetchGoogle(apiKey);
        break;
      case 'openai-compatible':
        result = await fetchOpenAICompatible(apiKey, provider.modelDiscovery);
        break;
      default: {
        const _exhaustive: never = provider.modelDiscovery;
        return {
          models: [],
          error: `Unknown provider model discovery adapter: ${JSON.stringify(_exhaustive)}`,
        };
      }
    }
    if (result.error) return result;
    return {
      ...result,
      models: filterRetiredProviderModels(provider.name, result.models),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], error: `Network error: ${message}` };
  }
}

export async function fetchProviderModels(
  provider: ProviderName,
  apiKey: string
): Promise<FetchModelsResult> {
  return fetchModelsFromProviderMeta(getProviderMeta(provider), apiKey);
}
