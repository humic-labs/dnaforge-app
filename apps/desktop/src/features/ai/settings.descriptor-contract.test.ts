import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

const descriptorProviders = [
  {
    name: 'anthropic',
    label: 'Anthropic Test',
    defaultModel: 'descriptor-anthropic-default',
    credential: {
      kind: 'api-key',
      label: 'Access token',
      keyringAccount: 'descriptor/accounts/anthropic',
      envVar: 'ANTHROPIC_DESCRIPTOR_KEY',
      placeholder: 'Paste descriptor Anthropic token',
      storageLabel: 'Descriptor vault',
    },
  },
  {
    name: 'openai',
    label: 'OpenAI Test',
    defaultModel: 'descriptor-openai-default',
    credential: {
      kind: 'api-key',
      label: 'Access token',
      keyringAccount: 'descriptor/accounts/openai',
      envVar: 'OPENAI_DESCRIPTOR_KEY',
      placeholder: 'Paste descriptor OpenAI token',
      storageLabel: 'Descriptor vault',
    },
  },
] as const;

type MockedProviderName = (typeof descriptorProviders)[number]['name'];

function getMockedProviderMeta(providerName: MockedProviderName) {
  const meta = descriptorProviders.find((provider) => provider.name === providerName);
  if (!meta) throw new Error(`Missing mocked provider ${providerName}`);
  return meta;
}

async function loadDescriptorBackedSettings() {
  vi.resetModules();

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
  vi.doMock('./providers', () => ({
    PROVIDERS: descriptorProviders,
    getAllProviderMetas: () => descriptorProviders,
    getCustomProviderDefinitions: () => [],
    replaceCustomProviderDefinitions: vi.fn(),
    normalizeCustomProviderDefinition: (definition: unknown) => definition,
    createCustomProviderId: () => 'custom:test-endpoint',
    isRegisteredProviderName: (providerName: string) =>
      descriptorProviders.some((provider) => provider.name === providerName),
    getProviderMeta: getMockedProviderMeta,
    getDefaultModel: (providerName: MockedProviderName) =>
      getMockedProviderMeta(providerName).defaultModel,
    isProviderModelRetired: vi.fn(() => false),
    filterRetiredProviderModels: vi.fn(
      (_providerName: MockedProviderName, models: string[]) => models
    ),
  }));

  const settings = await import('./settings');
  return { ...settings, mockPlatform, getSetting, setSetting, fetchProviderModels };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../platform');
  vi.doUnmock('../../db');
  vi.doUnmock('./modelDiscovery');
  vi.doUnmock('./providers');
});

describe('AI settings provider descriptor contract', () => {
  it('builds provider status state from provider descriptors, not a hard-coded provider list', async () => {
    const { useAISettingsStore, mockPlatform, KEYRING_SERVICE } =
      await loadDescriptorBackedSettings();

    mockPlatform.keyring.hasPassword.mockImplementation(
      async (_service, account) => account === 'descriptor/accounts/openai'
    );
    mockPlatform.keyring.getPassword.mockImplementation(async (_service, account) =>
      account === 'descriptor/accounts/openai' ? 'sk-openai-descriptor' : null
    );

    await act(async () => {
      await useAISettingsStore.getState().initialize();
      await useAISettingsStore.getState().refreshProviderStatuses();
    });

    expect(Object.keys(useAISettingsStore.getState().providerStatuses).sort()).toEqual([
      'anthropic',
      'openai',
    ]);
    expect(useAISettingsStore.getState().providerStatuses).toMatchObject({
      anthropic: { isConfigured: false, keySource: 'none' },
      openai: { isConfigured: true, keySource: 'keyring' },
    });
    expect(mockPlatform.keyring.hasPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'descriptor/accounts/anthropic'
    );
    expect(mockPlatform.keyring.hasPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'descriptor/accounts/openai'
    );
    expect(mockPlatform.keyring.hasPassword).not.toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'openai_api_key'
    );
  });

  it('uses descriptor keyring accounts for get, set, and delete', async () => {
    const { useAISettingsStore, mockPlatform, KEYRING_SERVICE } =
      await loadDescriptorBackedSettings();

    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-from-descriptor-account');

    await expect(useAISettingsStore.getState().getApiKey('openai')).resolves.toBe(
      'sk-from-descriptor-account'
    );
    expect(mockPlatform.keyring.getPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'descriptor/accounts/openai'
    );

    await act(async () => {
      await useAISettingsStore.getState().setApiKey('openai', 'sk-new-descriptor-key');
    });
    expect(mockPlatform.keyring.setPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'descriptor/accounts/openai',
      'sk-new-descriptor-key'
    );

    await act(async () => {
      await useAISettingsStore.getState().deleteApiKey('openai');
    });
    expect(mockPlatform.keyring.deletePassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'descriptor/accounts/openai'
    );
  });

  it('uses descriptor env vars as default secret names and persists custom names', async () => {
    const { useAISettingsStore, getSetting, setSetting } = await loadDescriptorBackedSettings();

    getSetting.mockImplementation(async (key: string) =>
      key === 'ai_provider_secret_name_openai' ? 'LAB_DESCRIPTOR_OPENAI_KEY' : null
    );

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().providerCredentialNames).toMatchObject({
      anthropic: 'ANTHROPIC_DESCRIPTOR_KEY',
      openai: 'LAB_DESCRIPTOR_OPENAI_KEY',
    });

    await act(async () => {
      await useAISettingsStore
        .getState()
        .setApiKey('openai', 'sk-new-descriptor-key', 'CUSTOM_DESCRIPTOR_OPENAI_KEY');
    });

    expect(setSetting).toHaveBeenCalledWith(
      'ai_provider_secret_name_openai',
      'CUSTOM_DESCRIPTOR_OPENAI_KEY'
    );
    expect(useAISettingsStore.getState().providerCredentialNames.openai).toBe(
      'CUSTOM_DESCRIPTOR_OPENAI_KEY'
    );
  });

  it('uses descriptor default models when switching providers', async () => {
    const { useAISettingsStore } = await loadDescriptorBackedSettings();

    await act(async () => {
      await useAISettingsStore.getState().setProvider('openai');
    });

    expect(useAISettingsStore.getState()).toMatchObject({
      provider: 'openai',
      model: 'descriptor-openai-default',
      assistantRoute: {
        kind: 'provider',
        provider: 'openai',
        model: 'descriptor-openai-default',
      },
    });
  });
});
