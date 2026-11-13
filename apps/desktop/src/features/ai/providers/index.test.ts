import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createModel,
  createModelFromProviderMeta,
  PROVIDERS,
  filterRetiredProviderModels,
  getDefaultModel,
  getAllProviderMetas,
  getCustomProviderDefinitions,
  getProviderMeta,
  isProviderModelRetired,
  normalizeGoogleToolSchema,
  replaceCustomProviderDefinitions,
  type ProviderMeta,
} from './index';

const { googleDoGenerate } = vi.hoisted(() => ({
  googleDoGenerate: vi.fn(async (params: unknown) => params),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => {
    const provider = (modelId: string) => ({
      modelId,
      provider: 'anthropic.messages',
    });
    provider.languageModel = provider;
    return provider;
  }),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const provider = (modelId: string) => ({
      modelId,
      provider: 'openai.chat',
    });
    provider.languageModel = provider;
    return provider;
  }),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => {
    const provider = (modelId: string) => ({
      specificationVersion: 'v3' as const,
      modelId,
      provider: 'google.generative-ai',
      supportedUrls: {},
      doGenerate: googleDoGenerate,
      doStream: vi.fn(),
    });
    provider.languageModel = provider;
    return provider;
  }),
}));

vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn(() => {
    const provider = (modelId: string) => ({
      modelId,
      provider: 'xai.chat',
    });
    provider.languageModel = provider;
    return provider;
  }),
}));

vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: vi.fn(() => {
    const provider = (modelId: string) => ({
      modelId,
      provider: 'deepseek.chat',
    });
    provider.languageModel = provider;
    return provider;
  }),
}));

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createDeepSeek } from '@ai-sdk/deepseek';

function modelId(model: unknown): string {
  return (model as { modelId: string }).modelId;
}

beforeEach(() => {
  vi.clearAllMocks();
  googleDoGenerate.mockClear();
  replaceCustomProviderDefinitions([]);
});

describe('createModel', () => {
  it('creates Anthropic model with valid API key and browser-access header', async () => {
    const model = await createModel('anthropic', 'sk-ant-test-key');

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'sk-ant-test-key',
      fetch: globalThis.fetch,
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    expect(model).toBeDefined();
    expect(modelId(model)).toBe(getDefaultModel('anthropic'));
  });

  it('creates OpenAI model with valid API key', async () => {
    const model = await createModel('openai', 'sk-test-key');

    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-test-key', fetch: globalThis.fetch });
    expect(modelId(model)).toBe(getDefaultModel('openai'));
  });

  it('can create an OpenAI-compatible model from descriptor adapter config', () => {
    const descriptorProvider: ProviderMeta = {
      ...getProviderMeta('openai'),
      defaultModel: 'custom-compatible-default',
      modelFactory: {
        adapter: 'openai-compatible',
        baseUrl: 'https://models.example.test/v1',
      },
    };

    const model = createModelFromProviderMeta(descriptorProvider, 'sk-compatible-key');

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-compatible-key',
      fetch: globalThis.fetch,
      baseURL: 'https://models.example.test/v1',
    });
    expect(modelId(model)).toBe('custom-compatible-default');
  });

  it('creates models through a registered custom OpenAI-compatible endpoint', async () => {
    replaceCustomProviderDefinitions([
      {
        id: 'custom:lab-gateway',
        label: 'Lab gateway',
        baseUrl: 'https://models.example.test/v1/',
        defaultModel: 'lab-model',
      },
    ]);

    const model = await createModel('custom:lab-gateway', 'lab-api-key');

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'lab-api-key',
      fetch: globalThis.fetch,
      baseURL: 'https://models.example.test/v1',
    });
    expect(modelId(model)).toBe('lab-model');
  });

  it('creates Google model with valid API key', async () => {
    const model = await createModel('google', 'AIza-test-key');

    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'AIza-test-key',
      fetch: globalThis.fetch,
    });
    expect(modelId(model)).toBe(getDefaultModel('google'));
  });

  it('normalizes unsupported numeric enums before Google receives the shared tools', async () => {
    const model = await createModel('google', 'AIza-test-key');

    await model.doGenerate({
      prompt: [],
      tools: [
        {
          type: 'function',
          name: 'add_primer_binding',
          inputSchema: {
            type: 'object',
            properties: {
              strand: { type: 'integer', enum: [1, -1] },
            },
          },
        },
      ],
    });

    expect(googleDoGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            name: 'add_primer_binding',
            inputSchema: {
              type: 'object',
              properties: {
                strand: {
                  type: 'integer',
                  description: 'Allowed values: 1, -1.',
                },
              },
            },
          }),
        ],
      })
    );
  });

  it('creates xAI model with valid API key', async () => {
    const model = await createModel('xai', 'xai-test-key');

    expect(createXai).toHaveBeenCalledWith({ apiKey: 'xai-test-key', fetch: globalThis.fetch });
    expect(modelId(model)).toBe(getDefaultModel('xai'));
  });

  it('creates DeepSeek model with valid API key', async () => {
    const model = await createModel('deepseek', 'ds-test-key');

    expect(createDeepSeek).toHaveBeenCalledWith({ apiKey: 'ds-test-key', fetch: globalThis.fetch });
    expect(modelId(model)).toBe(getDefaultModel('deepseek'));
  });

  it('passes native fetch to all providers', async () => {
    await createModel('anthropic', 'sk-key');
    expect(createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: globalThis.fetch })
    );

    await createModel('openai', 'sk-key');
    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ fetch: globalThis.fetch }));

    await createModel('google', 'sk-key');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: globalThis.fetch })
    );
  });

  it('sets anthropic-dangerous-direct-browser-access header for Anthropic', async () => {
    await createModel('anthropic', 'sk-key');
    expect(createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      })
    );
  });

  it('throws error on missing API key', async () => {
    await expect(createModel('anthropic', '')).rejects.toThrow(/api key/i);
    await expect(createModel('anthropic', '   ')).rejects.toThrow(/api key/i);
  });

  it('accepts custom model ID override', async () => {
    const customModelId = ['claude', 'opus', '4', '20250514'].join('-');
    const model = await createModel('anthropic', 'test-api-key', customModelId);
    expect(modelId(model)).toBe(customModelId);
  });

  it('uses default model when modelId is empty or whitespace', async () => {
    const m1 = await createModel('anthropic', 'sk-key', '');
    expect(modelId(m1)).toBe(getDefaultModel('anthropic'));

    const m2 = await createModel('anthropic', 'sk-key', '   ');
    expect(modelId(m2)).toBe(getDefaultModel('anthropic'));
  });

  it('wraps SDK initialization errors with provider context', async () => {
    vi.mocked(createAnthropic).mockImplementationOnce(() => {
      throw new Error('Invalid API key format');
    });

    await expect(createModel('anthropic', 'bad-key')).rejects.toThrow(
      /Failed to initialize anthropic provider.*Invalid API key format/
    );
  });
});

describe('normalizeGoogleToolSchema', () => {
  it('removes numeric enums Google rejects while preserving the exact constraint as guidance', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        strand: {
          type: 'integer' as const,
          enum: [1, -1],
          description: 'Primer binding strand.',
        },
      },
    };

    expect(normalizeGoogleToolSchema(schema)).toEqual({
      type: 'object',
      properties: {
        strand: {
          type: 'integer',
          description: 'Primer binding strand. Allowed values: 1, -1.',
        },
      },
    });
    expect(schema.properties.strand.enum).toEqual([1, -1]);
  });

  it('leaves string enums unchanged', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        direction: { type: 'string' as const, enum: ['forward', 'reverse'] },
      },
    };

    expect(normalizeGoogleToolSchema(schema)).toEqual(schema);
  });
});

describe('PROVIDERS', () => {
  it('exports provider metadata for all supported providers', () => {
    expect(PROVIDERS).toHaveLength(5);

    const names = PROVIDERS.map((p) => p.name);
    expect(names).toContain('anthropic');
    expect(names).toContain('openai');
    expect(names).toContain('google');
    expect(names).toContain('xai');
    expect(names).toContain('deepseek');
  });

  it('each provider has name, label, defaultModel, credential metadata, and adapter metadata', () => {
    for (const provider of PROVIDERS) {
      expect(provider.name).toBeTruthy();
      expect(provider.label).toBeTruthy();
      expect(provider.defaultModel).toBeTruthy();
      expect(provider.credential.kind).toBe('api-key');
      expect(provider.credential.label).toBeTruthy();
      expect(provider.credential.envVar).toMatch(/_API_KEY$/);
      expect(provider.credential.keyringAccount).toBe(`${provider.name}_api_key`);
      expect(provider.credential.placeholder).toContain('API key');
      expect(provider.credential.storageLabel).toBeTruthy();
      expect(provider.modelFactory.adapter).toBeTruthy();
      expect(provider.modelDiscovery.adapter).toBeTruthy();
    }
  });

  it('declares OpenAI-compatible discovery where providers expose compatible model APIs', () => {
    expect(getProviderMeta('openai').modelDiscovery).toMatchObject({
      adapter: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      providerLabel: 'OpenAI',
      modelFilter: 'chat',
    });
    expect(getProviderMeta('xai').modelDiscovery).toMatchObject({
      adapter: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      providerLabel: 'xAI',
      modelFilter: 'chat',
    });
    expect(getProviderMeta('deepseek').modelDiscovery).toMatchObject({
      adapter: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      providerLabel: 'DeepSeek',
      modelFilter: 'none',
    });
  });

  it('uses unique keyring accounts and env bindings for provider credentials', () => {
    const keyringAccounts = new Set(
      PROVIDERS.map((provider) => provider.credential.keyringAccount)
    );
    const envVars = new Set(PROVIDERS.map((provider) => provider.credential.envVar));

    expect(keyringAccounts.size).toBe(PROVIDERS.length);
    expect(envVars.size).toBe(PROVIDERS.length);
  });

  it('returns provider metadata by provider name', () => {
    expect(getProviderMeta('openai').label).toBe('OpenAI');
    expect(getProviderMeta('openai').credential.envVar).toBe('OPENAI_API_KEY');
  });

  it('registers sanitized custom endpoints without mutating the built-in registry', () => {
    replaceCustomProviderDefinitions([
      {
        id: 'custom:internal',
        label: ' Internal models ',
        baseUrl: 'http://127.0.0.1:11434/v1/',
        defaultModel: ' local-model ',
      },
    ]);

    expect(PROVIDERS).toHaveLength(5);
    expect(getCustomProviderDefinitions()).toEqual([
      {
        id: 'custom:internal',
        label: 'Internal models',
        baseUrl: 'http://127.0.0.1:11434/v1',
        defaultModel: 'local-model',
      },
    ]);
    expect(getAllProviderMetas().map((provider) => provider.name)).toContain('custom:internal');
    expect(getProviderMeta('custom:internal')).toMatchObject({
      label: 'Internal models',
      defaultModel: 'local-model',
      modelFactory: {
        adapter: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
    });
  });

  it('tracks provider-specific retired models outside the chat runtime', () => {
    expect(getDefaultModel('anthropic')).toBe('claude-sonnet-4-6');
    expect(isProviderModelRetired('anthropic', 'claude-fable-5')).toBe(true);
    expect(isProviderModelRetired('anthropic', 'claude-sonnet-4-20250514')).toBe(true);
    expect(
      filterRetiredProviderModels('anthropic', [
        'claude-fable-5',
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-6',
      ])
    ).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);

    expect(getDefaultModel('google')).toBe('gemini-3.5-flash');
    expect(isProviderModelRetired('google', 'gemini-2.0-flash')).toBe(true);
    expect(isProviderModelRetired('google', 'gemini-3.5-flash')).toBe(false);
    expect(filterRetiredProviderModels('google', ['gemini-2.0-flash', 'gemini-3.5-flash'])).toEqual(
      ['gemini-3.5-flash']
    );
  });
});
