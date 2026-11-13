import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchModels, settings, platformMock } = vi.hoisted(() => ({
  fetchModels: vi.fn(),
  settings: new Map<string, string>(),
  platformMock: {
    keyring: {
      getPassword: vi.fn().mockResolvedValue('model-picker-test-key'),
      hasPassword: vi.fn().mockResolvedValue(true),
      setPassword: vi.fn().mockResolvedValue(undefined),
      deletePassword: vi.fn().mockResolvedValue(undefined),
    },
    agentSdk: { detect: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../../platform', () => ({
  platform: () => platformMock,
  initPlatform: vi.fn().mockResolvedValue(platformMock),
}));
vi.mock('../../db', () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings.set(key, value);
  }),
}));
vi.mock('./modelDiscovery', () => ({
  fetchProviderModels: fetchModels,
}));

import { useAISettingsStore } from './settings';

describe(' explicit model intent', () => {
  beforeEach(() => {
    settings.clear();
    vi.clearAllMocks();
    useAISettingsStore.setState({
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'router/research' },
      provider: 'openai',
      model: 'router/research',
      agentTransport: null,
      providerStatuses: {
        ...useAISettingsStore.getState().providerStatuses,
        openai: { isConfigured: true, keySource: 'keyring' },
      },
      providerModels: {
        ...useAISettingsStore.getState().providerModels,
        openai: { models: [], fetchStatus: 'idle', fetchError: null },
      },
    });
    fetchModels.mockResolvedValue({ models: ['gpt-4o', 'gpt-4o-mini'], error: null });
  });

  it('retains a manually chosen router when a refreshed catalog omits it', async () => {
    await useAISettingsStore.getState().setModel('router/research');
    await useAISettingsStore.getState().fetchModels('openai');
    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'provider',
      provider: 'openai',
      model: 'router/research',
    });
    expect(JSON.parse(settings.get('ai_assistant_route') ?? 'null')).toEqual({
      version: 1,
      selection: { kind: 'provider', provider: 'openai', model: 'router/research' },
    });
  });

  it('restores the canonical route when a prior interrupted switch left stale mirrors', async () => {
    settings.set('ai_provider', 'anthropic');
    settings.set('ai_model', 'claude-sonnet-4-6');
    settings.set(
      'ai_assistant_route',
      JSON.stringify({
        version: 1,
        selection: { kind: 'provider', provider: 'openai', model: 'router/research' },
      })
    );
    await useAISettingsStore.getState().initialize();
    expect(useAISettingsStore.getState()).toMatchObject({
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'router/research' },
      provider: 'openai',
      model: 'router/research',
    });
  });
});
