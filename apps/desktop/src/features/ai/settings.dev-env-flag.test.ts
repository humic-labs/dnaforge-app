import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

async function loadSettingsWithDevEnvKeys({
  enabled,
  openaiKey,
}: {
  enabled: boolean;
  openaiKey: string;
}) {
  vi.resetModules();
  vi.stubGlobal('__ENABLE_DEV_AI_ENV_KEYS__', enabled);
  vi.stubGlobal('__DEV_ANTHROPIC_API_KEY__', '');
  vi.stubGlobal('__DEV_OPENAI_API_KEY__', openaiKey);
  vi.stubGlobal('__DEV_GOOGLE_API_KEY__', '');
  vi.stubGlobal('__DEV_XAI_API_KEY__', '');
  vi.stubGlobal('__DEV_DEEPSEEK_API_KEY__', '');

  const mockPlatform = {
    keyring: {
      getPassword: vi.fn().mockResolvedValue(null),
      hasPassword: vi.fn().mockResolvedValue(false),
      setPassword: vi.fn().mockResolvedValue(undefined),
      deletePassword: vi.fn().mockResolvedValue(undefined),
    },
  };
  const getSetting = vi.fn().mockResolvedValue(null);
  const setSetting = vi.fn().mockResolvedValue(undefined);
  const fetchProviderModels = vi.fn().mockResolvedValue({ models: [], error: null });

  vi.doMock('../../platform', () => ({
    platform: () => mockPlatform,
    initPlatform: vi.fn().mockResolvedValue(mockPlatform),
  }));
  vi.doMock('../../db', () => ({
    getSetting,
    setSetting,
  }));
  vi.doMock('./modelDiscovery', () => ({
    fetchProviderModels,
  }));

  const settings = await import('./settings');
  return { ...settings, mockPlatform, getSetting, setSetting, fetchProviderModels };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../../platform');
  vi.doUnmock('../../db');
  vi.doUnmock('./modelDiscovery');
});

describe('AI settings dev env key import flag', () => {
  it('ignores injected shell API keys unless the explicit dev flag is enabled', async () => {
    const key = 'sk-openai-realish-dev-key-1234567890';
    const { DEV_AI_ENV_KEYS_ENABLED, KEYRING_SERVICE, useAISettingsStore, mockPlatform } =
      await loadSettingsWithDevEnvKeys({ enabled: false, openaiKey: key });

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(DEV_AI_ENV_KEYS_ENABLED).toBe(false);
    expect(useAISettingsStore.getState().providerStatuses.openai).toEqual({
      isConfigured: false,
      keySource: 'none',
    });

    await expect(useAISettingsStore.getState().getApiKey('openai')).resolves.toBeNull();
    expect(mockPlatform.keyring.getPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'openai_api_key'
    );
  });

  it('uses injected shell API keys only when the explicit dev flag is enabled', async () => {
    const key = 'sk-openai-realish-dev-key-1234567890';
    const { DEV_AI_ENV_KEYS_ENABLED, useAISettingsStore, mockPlatform } =
      await loadSettingsWithDevEnvKeys({ enabled: true, openaiKey: key });

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(DEV_AI_ENV_KEYS_ENABLED).toBe(true);
    expect(useAISettingsStore.getState().providerStatuses.openai).toEqual({
      isConfigured: true,
      keySource: 'env',
    });

    await expect(useAISettingsStore.getState().getApiKey('openai')).resolves.toBe(key);
    expect(mockPlatform.keyring.getPassword).not.toHaveBeenCalled();
  });
});
