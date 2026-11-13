import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: {
    keyring: {
      getPassword: vi.fn().mockResolvedValue(null),
      hasPassword: vi.fn().mockResolvedValue(false),
      setPassword: vi.fn().mockResolvedValue(undefined),
      deletePassword: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

vi.mock('../../../../db', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

import { getSetting } from '../../../../db';
import { useAISettingsStore } from '../../settings';
import type { ProviderModelState, ProviderStatus } from '../../settings';
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

const PROVIDER_ORDER: ProviderName[] = ['anthropic', 'openai', 'google', 'xai', 'deepseek'];
const keysMap = Object.fromEntries(PROVIDER_CONFIGS.map((c) => [c.name, c.key]));
const firstAvailable = PROVIDER_CONFIGS.find((c) => c.key !== null);

const DEFAULT_STATUSES: Record<string, ProviderStatus> = {
  anthropic: { isConfigured: false, keySource: 'none' },
  openai: { isConfigured: false, keySource: 'none' },
  google: { isConfigured: false, keySource: 'none' },
  xai: { isConfigured: false, keySource: 'none' },
  deepseek: { isConfigured: false, keySource: 'none' },
};

const DEFAULT_MODEL_STATE: ProviderModelState = {
  models: [],
  fetchStatus: 'idle',
  fetchError: null,
};

function defaultProviderModels(): Record<string, ProviderModelState> {
  return {
    anthropic: { ...DEFAULT_MODEL_STATE },
    openai: { ...DEFAULT_MODEL_STATE },
    google: { ...DEFAULT_MODEL_STATE },
    xai: { ...DEFAULT_MODEL_STATE },
    deepseek: { ...DEFAULT_MODEL_STATE },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAISettingsStore.setState({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    isConfigured: false,
    providerStatuses: { ...DEFAULT_STATUSES } as any,
    providerModels: defaultProviderModels() as any,
    isLoading: false,
    keyringError: null,
  });
});

async function waitForFetchComplete(provider: ProviderName, timeoutMs = 25000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = useAISettingsStore.getState().providerModels[provider];
    if (state.fetchStatus === 'success' || state.fetchStatus === 'error') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${provider} fetch to complete`);
}

describe('Settings Store + Real API', () => {
  for (const config of PROVIDER_CONFIGS) {
    describe(config.name, () => {
      it.skipIf(!config.key)('fetchModels populates real models', async () => {
        useAISettingsStore.setState({
          providerStatuses: {
            ...DEFAULT_STATUSES,
            [config.name]: { isConfigured: true, keySource: 'keyring' },
          } as any,
        });

        mockPlatform.keyring.getPassword.mockResolvedValueOnce(config.key);

        await act(async () => {
          await useAISettingsStore.getState().fetchModels(config.name);
        });

        await waitForFetchComplete(config.name);

        const { providerModels } = useAISettingsStore.getState();
        expect(providerModels[config.name].fetchStatus).toBe('success');
        expect(providerModels[config.name].models.length).toBeGreaterThan(0);
        expect(providerModels[config.name].models).toContain(config.knownModel);
        expect(providerModels[config.name].fetchError).toBeNull();
      });

      it.skipIf(!config.key)('retryFetchModels recovers from error state', async () => {
        useAISettingsStore.setState({
          providerStatuses: {
            ...DEFAULT_STATUSES,
            [config.name]: { isConfigured: true, keySource: 'keyring' },
          } as any,
          providerModels: {
            ...defaultProviderModels(),
            [config.name]: { models: [], fetchStatus: 'error', fetchError: 'Previous error' },
          } as any,
        });

        mockPlatform.keyring.getPassword.mockResolvedValueOnce(config.key);

        await act(async () => {
          await useAISettingsStore.getState().retryFetchModels(config.name);
        });

        await waitForFetchComplete(config.name);

        const { providerModels } = useAISettingsStore.getState();
        expect(providerModels[config.name].fetchStatus).toBe('success');
        expect(providerModels[config.name].models.length).toBeGreaterThan(0);
      });

      it.skipIf(!config.key)('fetchModels with invalid key sets error state', async () => {
        useAISettingsStore.setState({
          providerStatuses: {
            ...DEFAULT_STATUSES,
            [config.name]: { isConfigured: true, keySource: 'keyring' },
          } as any,
        });

        mockPlatform.keyring.getPassword.mockResolvedValueOnce('invalid-key-xxx');

        await act(async () => {
          await useAISettingsStore.getState().fetchModels(config.name);
        });

        await waitForFetchComplete(config.name);

        const { providerModels } = useAISettingsStore.getState();
        expect(providerModels[config.name].fetchStatus).toBe('error');
        expect(providerModels[config.name].fetchError).toBeTruthy();
        expect(providerModels[config.name].models).toEqual([]);
      });
    });
  }

  it.skipIf(!firstAvailable)('initialize + fetchModels full flow', async () => {
    const provider = firstAvailable!;

    vi.mocked(getSetting).mockResolvedValueOnce(provider.name);
    vi.mocked(getSetting).mockResolvedValueOnce(null);

    for (const name of PROVIDER_ORDER) {
      mockPlatform.keyring.hasPassword.mockResolvedValueOnce(Boolean(keysMap[name]));
    }

    vi.mocked(getSetting).mockResolvedValue(null);

    for (const name of PROVIDER_ORDER) {
      if (keysMap[name]) {
        mockPlatform.keyring.getPassword.mockResolvedValueOnce(keysMap[name]);
      }
    }

    await act(async () => {
      await useAISettingsStore.getState().initialize();
      await useAISettingsStore.getState().refreshProviderStatuses();
    });

    await waitForFetchComplete(provider.name);

    const state = useAISettingsStore.getState();
    expect(state.provider).toBe(provider.name);
    expect(state.isConfigured).toBe(true);
    expect(state.providerModels[provider.name].fetchStatus).toBe('success');
    expect(state.providerModels[provider.name].models.length).toBeGreaterThan(0);
  });
});
