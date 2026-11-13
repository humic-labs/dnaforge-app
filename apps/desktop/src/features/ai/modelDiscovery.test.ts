import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/environment', () => ({
  isBrowserOnly: vi.fn().mockReturnValue(true),
}));

import { fetchModelsFromProviderMeta, fetchProviderModels } from './modelDiscovery';
import { getProviderMeta, replaceCustomProviderDefinitions, type ProviderMeta } from './providers';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  replaceCustomProviderDefinitions([]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchResponse(body: unknown, status = 200, statusText = 'OK') {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as Response);
}

describe('fetchProviderModels', () => {
  describe('anthropic', () => {
    it('fetches and returns sorted model IDs', async () => {
      mockFetchResponse({
        data: [
          { id: 'claude-fable-5' },
          { id: 'claude-sonnet-4-6' },
          { id: 'claude-haiku-4-5-20251001' },
        ],
      });

      const result = await fetchProviderModels('anthropic', 'sk-ant-key');

      expect(result.error).toBeNull();
      expect(result.models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);

      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(call[0]).toBe('https://api.anthropic.com/v1/models');
      expect((call[1]?.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-key');
      expect((call[1]?.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    });

    it('returns error on HTTP failure', async () => {
      mockFetchResponse({}, 401, 'Unauthorized');

      const result = await fetchProviderModels('anthropic', 'bad-key');

      expect(result.models).toEqual([]);
      expect(result.error).toContain('401');
    });
  });

  describe('openai', () => {
    it('fetches, filters non-chat models, and sorts', async () => {
      mockFetchResponse({
        data: [
          { id: 'gpt-4o' },
          { id: 'gpt-4o-mini' },
          { id: 'text-embedding-3-small' },
          { id: 'dall-e-3' },
          { id: 'tts-1' },
          { id: 'whisper-1' },
          { id: 'babbage-002' },
          { id: 'davinci-002' },
          { id: 'ft:gpt-4o:custom' },
          { id: 'omni-moderation-latest' },
          { id: 'o1-preview' },
        ],
      });

      const result = await fetchProviderModels('openai', 'sk-openai');

      expect(result.error).toBeNull();
      expect(result.models).toEqual(['gpt-4o', 'gpt-4o-mini', 'o1-preview']);
    });

    it('uses Bearer authorization', async () => {
      mockFetchResponse({ data: [{ id: 'gpt-4o' }] });

      await fetchProviderModels('openai', 'sk-openai');

      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(call[0]).toBe('https://api.openai.com/v1/models');
      expect((call[1]?.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer sk-openai'
      );
    });

    it('can fetch models from a descriptor-provided OpenAI-compatible base URL', async () => {
      mockFetchResponse({
        data: [{ id: 'example-chat' }, { id: 'text-embedding-example' }],
      });
      const descriptorProvider: ProviderMeta = {
        ...getProviderMeta('openai'),
        modelDiscovery: {
          adapter: 'openai-compatible',
          baseUrl: 'https://models.example.test/v2/',
          providerLabel: 'Example Compatible',
          modelFilter: 'none',
        },
      };

      const result = await fetchModelsFromProviderMeta(descriptorProvider, 'sk-compatible');

      expect(result.error).toBeNull();
      expect(result.models).toEqual(['example-chat', 'text-embedding-example']);

      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(call[0]).toBe('https://models.example.test/v2/models');
      expect((call[1]?.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer sk-compatible'
      );
    });

    it('discovers models through a registered custom endpoint', async () => {
      replaceCustomProviderDefinitions([
        {
          id: 'custom:lab-gateway',
          label: 'Lab gateway',
          baseUrl: 'http://127.0.0.1:11434/v1/',
          defaultModel: 'lab-model',
        },
      ]);
      mockFetchResponse({ data: [{ id: 'lab-model' }, { id: 'lab-model-fast' }] });

      const result = await fetchProviderModels('custom:lab-gateway', 'lab-key');

      expect(result).toEqual({ models: ['lab-model', 'lab-model-fast'], error: null });
      expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
        'http://127.0.0.1:11434/v1/models'
      );
    });

    it('returns error on HTTP failure', async () => {
      mockFetchResponse({}, 403, 'Forbidden');

      const result = await fetchProviderModels('openai', 'bad-key');

      expect(result.models).toEqual([]);
      expect(result.error).toContain('403');
    });
  });

  describe('google', () => {
    it('filters by generateContent and strips models/ prefix', async () => {
      mockFetchResponse({
        models: [
          {
            name: 'models/gemini-2.0-flash',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/gemini-2.5-flash',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/gemini-3.5-flash',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/gemini-1.5-pro',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/text-embedding-004',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      });

      const result = await fetchProviderModels('google', 'google-key');

      expect(result.error).toBeNull();
      expect(result.models).toEqual(['gemini-1.5-pro', 'gemini-2.5-flash', 'gemini-3.5-flash']);
      expect(result.models).not.toContain('gemini-2.0-flash');
      expect(result.models).not.toContain('text-embedding-004');
    });

    it('passes API key as header, not query param', async () => {
      mockFetchResponse({ models: [] });

      await fetchProviderModels('google', 'google-key');

      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(call[0]).not.toContain('key=');
      const headers = (call[1] as any)?.headers;
      expect(headers?.['x-goog-api-key']).toBe('google-key');
    });

    it('returns error on HTTP failure', async () => {
      mockFetchResponse({}, 400, 'Bad Request');

      const result = await fetchProviderModels('google', 'bad-key');

      expect(result.models).toEqual([]);
      expect(result.error).toContain('400');
    });
  });

  describe('xai', () => {
    it('fetches and filters like OpenAI', async () => {
      mockFetchResponse({
        data: [{ id: 'grok-3' }, { id: 'grok-3-mini' }, { id: 'text-embedding-v1' }],
      });

      const result = await fetchProviderModels('xai', 'xai-key');

      expect(result.error).toBeNull();
      expect(result.models).toEqual(['grok-3', 'grok-3-mini']);
    });

    it('uses xAI base URL', async () => {
      mockFetchResponse({ data: [] });

      await fetchProviderModels('xai', 'xai-key');

      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(call[0]).toBe('https://api.x.ai/v1/models');
    });
  });

  describe('deepseek', () => {
    it('fetches and returns sorted model IDs', async () => {
      mockFetchResponse({
        data: [{ id: 'deepseek-chat' }, { id: 'deepseek-coder' }],
      });

      const result = await fetchProviderModels('deepseek', 'ds-key');

      expect(result.error).toBeNull();
      expect(result.models).toEqual(['deepseek-chat', 'deepseek-coder']);
    });

    it('uses DeepSeek base URL', async () => {
      mockFetchResponse({ data: [] });

      await fetchProviderModels('deepseek', 'ds-key');

      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(call[0]).toBe('https://api.deepseek.com/models');
    });
  });

  describe('network errors', () => {
    it('catches fetch exceptions and returns error', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('Failed to fetch'));

      const result = await fetchProviderModels('anthropic', 'key');

      expect(result.models).toEqual([]);
      expect(result.error).toContain('Network error');
      expect(result.error).toContain('Failed to fetch');
    });

    it('handles non-Error thrown values', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValueOnce('connection refused');

      const result = await fetchProviderModels('openai', 'key');

      expect(result.models).toEqual([]);
      expect(result.error).toContain('Network error');
    });
  });
});
