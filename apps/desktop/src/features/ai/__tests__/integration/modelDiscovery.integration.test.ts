import { describe, it, expect, vi } from 'vitest';

import { fetchProviderModels } from '../../modelDiscovery';
import { getTestApiKey } from './keychain-helper';
import type { ProviderName } from '../../providers';

interface ProviderTestConfig {
  name: ProviderName;
  knownModel: string;
  key: string | null;
}

const PROVIDER_CONFIGS: ProviderTestConfig[] = [
  { name: 'anthropic', knownModel: 'claude-sonnet-4-6', key: getTestApiKey('anthropic') },
  { name: 'openai', knownModel: 'gpt-4o', key: getTestApiKey('openai') },
  { name: 'google', knownModel: 'gemini-3.5-flash', key: getTestApiKey('google') },
  { name: 'xai', knownModel: 'grok-4.3', key: getTestApiKey('xai') },
  { name: 'deepseek', knownModel: 'deepseek-chat', key: getTestApiKey('deepseek') },
];

const available = PROVIDER_CONFIGS.filter((c) => c.key !== null).map((c) => c.name);
console.log(
  `Integration test keys available: ${available.length > 0 ? available.join(', ') : 'NONE (all tests will skip)'}`
);

for (const config of PROVIDER_CONFIGS) {
  describe(config.name, () => {
    it.skipIf(!config.key)('returns non-empty model list', async () => {
      const result = await fetchProviderModels(config.name, config.key!);

      expect(result.error).toBeNull();
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models).toContain(config.knownModel);
    });

    it.skipIf(!config.key)('models are sorted alphabetically', async () => {
      const result = await fetchProviderModels(config.name, config.key!);

      expect(result.error).toBeNull();
      const sorted = [...result.models].sort();
      expect(result.models).toEqual(sorted);
    });

    it.skipIf(!config.key)('returns proper error for invalid key', async () => {
      const result = await fetchProviderModels(config.name, 'invalid-key-xxx');

      expect(result.models).toEqual([]);
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/\b(400|401|403|404)\b|Unauthorized|PERMISSION_DENIED|invalid/i);
    });
  });
}

describe('malformed response handling', () => {
  it('returns descriptive error for unexpected response format', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ unexpected: true }),
    } as Response);

    try {
      const result = await fetchProviderModels('anthropic', 'fake-key');

      expect(result.models).toEqual([]);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('Unexpected');
      expect(result.error).not.toMatch(/^Network error/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
