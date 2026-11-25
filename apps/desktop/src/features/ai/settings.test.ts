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
    agentSdk: {
      detect: vi.fn().mockResolvedValue({
        codex: {
          cli: 'installed',
          path: '/usr/local/bin/codex',
          auth: 'authenticated',
          defaultModel: 'gpt-5.5',
          authMode: 'chatgpt',
          authFilePresent: true,
        },
        claudeCode: {
          cli: 'installed',
          path: '/usr/local/bin/claude',
          auth: 'authenticated',
          defaultModel: 'claude-fable-5[1m]',
          keychainEntryPresent: true,
          credentialsFilePresent: null,
        },
      }),
    },
  },
}));

vi.mock('../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

vi.mock('../../db', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

const mockFetchProviderModels = vi.fn().mockResolvedValue({ models: [], error: null });
vi.mock('./modelDiscovery', () => ({
  fetchProviderModels: (...args: unknown[]) => mockFetchProviderModels(...args),
}));

import { getSetting, setSetting } from '../../db';

import { useAISettingsStore, KEYRING_SERVICE, looksLikeRealKey } from './settings';
import type { ProviderStatus, ProviderModelState } from './settings';
import { getDefaultModel, getProviderMeta, replaceCustomProviderDefinitions } from './providers';
import { replaceCustomCliHarnessDefinitions } from './custom-cli-harnesses';

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

const DEFAULT_CREDENTIAL_NAMES = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

const DEFAULT_CLI_MODEL_SETTINGS = {
  'codex-sdk': { model: null, reasoningEffort: 'high', serviceTier: null, personality: null },
  'claude-agent-sdk': {
    model: null,
    reasoningEffort: 'high',
    serviceTier: null,
    personality: null,
  },
  'grok-acp': { model: null, reasoningEffort: 'high', serviceTier: null, personality: null },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  replaceCustomProviderDefinitions([]);
  replaceCustomCliHarnessDefinitions([]);
  vi.mocked(getSetting).mockResolvedValue(null);
  vi.mocked(setSetting).mockResolvedValue(undefined);
  mockPlatform.agentSdk.detect.mockResolvedValue({
    codex: {
      cli: 'installed',
      path: '/usr/local/bin/codex',
      auth: 'authenticated',
      defaultModel: 'gpt-5.5',
      authMode: 'chatgpt',
      authFilePresent: true,
    },
    claudeCode: {
      cli: 'installed',
      path: '/usr/local/bin/claude',
      auth: 'authenticated',
      defaultModel: 'claude-fable-5[1m]',
      keychainEntryPresent: true,
      credentialsFilePresent: null,
    },
  });
  mockFetchProviderModels.mockReset().mockResolvedValue({ models: [], error: null });
  useAISettingsStore.setState({
    assistantRoute: null,
    provider: 'anthropic',
    model: getDefaultModel('anthropic'),
    agentTransport: null,
    isConfigured: false,
    providerStatuses: { ...DEFAULT_STATUSES } as any,
    providerModels: defaultProviderModels() as any,
    providerCredentialNames: { ...DEFAULT_CREDENTIAL_NAMES } as any,
    customProviders: [],
    customCliHarnesses: [],
    cliExecutablePathOverrides: {},
    cliModelSettings: { ...DEFAULT_CLI_MODEL_SETTINGS } as any,
    agentPermissions: {},
    additionalAgentInstructions: '',
    agentDetection: null,
    agentDetectError: null,
    isLoading: false,
    keyringError: null,
  });
});

describe('agent permission words', () => {
  it('leaves every agent on its own CLI default when nothing was chosen', async () => {
    vi.mocked(getSetting).mockResolvedValue(null);

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().agentPermissions).toEqual({});
  });

  it('loads well-formed persisted words and drops a malformed set', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === 'ai_agent_permissions' ? JSON.stringify({ claude: 'plan', grok: 'auto' }) : null
    );
    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });
    expect(useAISettingsStore.getState().agentPermissions).toEqual({
      claude: 'plan',
      grok: 'auto',
    });

    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === 'ai_agent_permissions' ? JSON.stringify({ claude: '--full' }) : null
    );
    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });
    expect(useAISettingsStore.getState().agentPermissions).toEqual({});
  });

  it('merges and persists a word chosen for one agent', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setAgentPermissions({ claude: 'acceptEdits' });
      await useAISettingsStore.getState().setAgentPermissions({ codex: ':read-only' });
    });

    expect(useAISettingsStore.getState().agentPermissions).toEqual({
      claude: 'acceptEdits',
      codex: ':read-only',
    });
    expect(setSetting).toHaveBeenLastCalledWith(
      'ai_agent_permissions',
      JSON.stringify({ claude: 'acceptEdits', codex: ':read-only' })
    );
  });
});

describe('additional agent instructions', () => {
  it('loads and persists the cross-route instruction text', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === 'ai_additional_agent_instructions' ? 'Explain assumptions explicitly.' : null
    );
    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });
    expect(useAISettingsStore.getState().additionalAgentInstructions).toBe(
      'Explain assumptions explicitly.'
    );

    await act(async () => {
      await useAISettingsStore.getState().setAdditionalAgentInstructions('Prefer short answers.');
    });
    expect(setSetting).toHaveBeenCalledWith(
      'ai_additional_agent_instructions',
      'Prefer short answers.'
    );
  });
});

async function initializeAndRefresh() {
  await useAISettingsStore.getState().initialize();
  await useAISettingsStore.getState().refreshProviderStatuses();
}

describe('AI Settings Store', () => {
  it('persists built-in CLI executable overrides, uses them for detection, and resets to auto', async () => {
    await act(async () => {
      await useAISettingsStore
        .getState()
        .setCliExecutablePathOverride('codex-sdk', '/opt/lab/bin/codex');
    });

    expect(useAISettingsStore.getState().cliExecutablePathOverrides).toEqual({
      'codex-sdk': '/opt/lab/bin/codex',
    });
    expect(setSetting).toHaveBeenCalledWith(
      'ai_cli_codex-sdk_executable_path',
      '/opt/lab/bin/codex'
    );
    expect(mockPlatform.agentSdk.detect).toHaveBeenLastCalledWith({
      'codex-sdk': '/opt/lab/bin/codex',
    });

    await act(async () => {
      await useAISettingsStore.getState().setCliExecutablePathOverride('codex-sdk', null);
    });
    expect(useAISettingsStore.getState().cliExecutablePathOverrides).toEqual({});
    expect(setSetting).toHaveBeenCalledWith('ai_cli_codex-sdk_executable_path', '');
    expect(mockPlatform.agentSdk.detect).toHaveBeenLastCalledWith({});
  });

  it('loads only absolute built-in CLI executable overrides', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === 'ai_cli_codex-sdk_executable_path') return '/opt/lab/bin/codex';
      if (key === 'ai_cli_claude-agent-sdk_executable_path') return 'relative/claude';
      return null;
    });

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().cliExecutablePathOverrides).toEqual({
      'codex-sdk': '/opt/lab/bin/codex',
    });
  });

  it('persists a user-defined compatible CLI harness with its own controls', async () => {
    let harnessId = '';
    await act(async () => {
      harnessId = await useAISettingsStore.getState().addCustomCliHarness({
        label: 'Lab Codex',
        transport: 'codex-sdk',
        executablePath: '/opt/lab/bin/codex',
      });
    });

    expect(harnessId).toMatch(/^custom-cli-/);
    expect(useAISettingsStore.getState().customCliHarnesses).toEqual([
      expect.objectContaining({
        id: harnessId,
        label: 'Lab Codex',
        transport: 'codex-sdk',
        executablePath: '/opt/lab/bin/codex',
      }),
    ]);
    expect(setSetting).toHaveBeenCalledWith(
      'ai_custom_cli_harnesses_v1',
      expect.stringContaining('/opt/lab/bin/codex')
    );

    await act(async () => {
      await useAISettingsStore.getState().updateCustomCliHarness(harnessId, {
        model: 'gpt-6-astra',
      });
    });
    expect(useAISettingsStore.getState().customCliHarnesses[0]).toMatchObject({
      model: 'gpt-6-astra',
    });
  });

  it('refreshes and stores CLI authentication detection', async () => {
    const detection = {
      codex: {
        cli: 'installed',
        path: '/usr/local/bin/codex',
        auth: 'authenticated',
        defaultModel: 'gpt-5.5',
        authMode: 'chatgpt',
        authFilePresent: true,
      },
      claudeCode: {
        cli: 'installed',
        path: '/usr/local/bin/claude',
        auth: 'unauthenticated',
        defaultModel: 'claude-fable-5[1m]',
        keychainEntryPresent: false,
        credentialsFilePresent: null,
      },
    };
    mockPlatform.agentSdk.detect.mockResolvedValueOnce(detection);

    let result: unknown;
    await act(async () => {
      result = await useAISettingsStore.getState().refreshAgentDetection();
    });

    expect(mockPlatform.agentSdk.detect).toHaveBeenCalledTimes(1);
    expect(result).toEqual(detection);
    expect(useAISettingsStore.getState().agentDetection).toEqual(detection);
    expect(useAISettingsStore.getState().agentDetectError).toBeNull();
  });

  it('records CLI detection errors without crashing settings', async () => {
    mockPlatform.agentSdk.detect.mockRejectedValueOnce(new Error('detector unavailable'));

    let result: unknown;
    await act(async () => {
      result = await useAISettingsStore.getState().refreshAgentDetection();
    });

    expect(result).toBeNull();
    expect(useAISettingsStore.getState().agentDetectError).toBe('detector unavailable');
  });

  it('persists optional per-CLI model, effort, speed, and personality settings', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setCliModel('codex-sdk', 'gpt-5-codex');
      await useAISettingsStore.getState().setCliReasoningEffort('codex-sdk', 'high');
      await useAISettingsStore.getState().setCliServiceTier('codex-sdk', 'priority');
      await useAISettingsStore.getState().setCliPersonality('codex-sdk', 'pragmatic');
    });

    expect(useAISettingsStore.getState().cliModelSettings['codex-sdk']).toEqual({
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      personality: 'pragmatic',
    });
    expect(setSetting).toHaveBeenCalledWith('ai_cli_codex-sdk_model', 'gpt-5-codex');
    expect(setSetting).toHaveBeenCalledWith('ai_cli_codex-sdk_reasoning_effort', 'high');
    expect(setSetting).toHaveBeenCalledWith('ai_cli_codex-sdk_service_tier', 'priority');
    expect(setSetting).toHaveBeenCalledWith('ai_cli_codex-sdk_personality', 'pragmatic');
  });

  it('persists Claude output style and rejects style for Grok routes', async () => {
    await expect(
      useAISettingsStore.getState().setCliPersonality('claude-agent-sdk', 'explanatory')
    ).resolves.toBeUndefined();
    await expect(
      useAISettingsStore.getState().setCliPersonality('grok-acp', 'pragmatic')
    ).rejects.toThrow(/not supported/);
    expect(setSetting).toHaveBeenCalledWith('ai_cli_claude-agent-sdk_personality', 'explanatory');
  });

  it('stores empty CLI model and an explicit provider-default effort override', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setCliModel('claude-agent-sdk', '  ');
      await useAISettingsStore.getState().setCliReasoningEffort('claude-agent-sdk', null);
    });

    expect(useAISettingsStore.getState().cliModelSettings['claude-agent-sdk']).toEqual({
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      personality: null,
    });
    expect(setSetting).toHaveBeenCalledWith('ai_cli_claude-agent-sdk_model', '');
    expect(setSetting).toHaveBeenCalledWith('ai_cli_claude-agent-sdk_reasoning_effort', '');
  });

  it('loads provider name from SQLite on initialization', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('openai');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-test');

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(getSetting).toHaveBeenCalledWith('ai_provider');
    expect(useAISettingsStore.getState().provider).toBe('openai');
  });

  it('defaults to anthropic when no provider setting exists', async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce(null);

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().provider).toBe('anthropic');
  });

  it('defaults to anthropic when invalid provider stored', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('invalid-provider');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce(null);

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().provider).toBe('anthropic');
  });

  it('loads model name from SQLite on initialization', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('anthropic');
    vi.mocked(getSetting).mockResolvedValueOnce('claude-opus-4-20250514');
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(getSetting).toHaveBeenCalledWith('ai_model');
    expect(useAISettingsStore.getState().model).toBe('claude-opus-4-20250514');
  });

  it('uses provider default model when no model setting exists', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('openai');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().model).toBe('gpt-4o');
  });

  it('gets API key from keyring for active provider', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('anthropic');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    mockPlatform.keyring.hasPassword.mockResolvedValueOnce(true);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-ant-real-key');

    await act(async () => {
      await initializeAndRefresh();
    });

    expect(mockPlatform.keyring.getPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'anthropic_api_key'
    );
    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('sets API key in keyring for specific provider', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setApiKey('anthropic', 'new-key');
    });

    expect(mockPlatform.keyring.setPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'anthropic_api_key',
      'new-key'
    );
  });

  it('persists a custom provider secret name when saving an API key', async () => {
    await act(async () => {
      await useAISettingsStore
        .getState()
        .setApiKey('openai', 'sk-custom-name-key', 'LAB_OPENAI_API_KEY');
    });

    expect(mockPlatform.keyring.setPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'openai_api_key',
      'sk-custom-name-key'
    );
    expect(setSetting).toHaveBeenCalledWith('ai_provider_secret_name_openai', 'LAB_OPENAI_API_KEY');
    expect(useAISettingsStore.getState().providerCredentialNames.openai).toBe('LAB_OPENAI_API_KEY');
  });

  it('loads custom provider secret names from SQLite with descriptor defaults as fallback', async () => {
    vi.mocked(getSetting)
      .mockResolvedValueOnce('openai')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('LAB_OPENAI_API_KEY')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(getSetting).toHaveBeenCalledWith('ai_provider_secret_name_openai');
    expect(useAISettingsStore.getState().providerCredentialNames).toMatchObject({
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'LAB_OPENAI_API_KEY',
    });
  });

  it('persists a custom OpenAI-compatible endpoint and its key as one provider', async () => {
    let providerId = '';
    await act(async () => {
      providerId = await useAISettingsStore.getState().addCustomProvider(
        {
          label: 'Lab gateway',
          baseUrl: 'https://models.example.test/v1/',
          defaultModel: 'lab-model',
        },
        'lab-api-key'
      );
    });

    expect(providerId).toMatch(/^custom:lab-gateway-/);
    expect(getProviderMeta(providerId as `custom:${string}`)).toMatchObject({
      label: 'Lab gateway',
      defaultModel: 'lab-model',
      modelFactory: {
        adapter: 'openai-compatible',
        baseUrl: 'https://models.example.test/v1',
      },
    });
    expect(setSetting).toHaveBeenCalledWith(
      'ai_custom_providers_v1',
      expect.stringContaining('https://models.example.test/v1')
    );
    const provider = providerId as `custom:${string}`;
    const account = getProviderMeta(provider).credential.keyringAccount;
    expect(account).toMatch(/^custom_provider_[A-Za-z0-9_-]+_api_key$/);
    expect(mockPlatform.keyring.setPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      account,
      'lab-api-key'
    );
    expect(
      useAISettingsStore.getState().providerStatuses[providerId as `custom:${string}`]
    ).toEqual({ isConfigured: true, keySource: 'keyring' });

    await act(async () => {
      await useAISettingsStore.getState().getApiKey(provider);
      await useAISettingsStore.getState().setApiKey(provider, 'replacement-key');
      await useAISettingsStore.getState().removeCustomProvider(provider);
    });
    expect(mockPlatform.keyring.getPassword).toHaveBeenCalledWith(KEYRING_SERVICE, account);
    expect(mockPlatform.keyring.setPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      account,
      'replacement-key'
    );
    expect(mockPlatform.keyring.deletePassword).toHaveBeenCalledWith(KEYRING_SERVICE, account);
  });

  it('rejects empty API key', async () => {
    await expect(useAISettingsStore.getState().setApiKey('anthropic', '')).rejects.toThrow(
      /api key/i
    );

    await expect(useAISettingsStore.getState().setApiKey('anthropic', '   ')).rejects.toThrow(
      /api key/i
    );
  });

  it('deletes API key from keyring for specific provider', async () => {
    await act(async () => {
      await useAISettingsStore.getState().deleteApiKey('anthropic');
    });

    expect(mockPlatform.keyring.deletePassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'anthropic_api_key'
    );
  });

  it('reports isConfigured=true when provider and key present', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('anthropic');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    mockPlatform.keyring.hasPassword.mockResolvedValueOnce(true);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    await act(async () => {
      await initializeAndRefresh();
    });

    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('reports isConfigured=false when no API key', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('anthropic');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce(null);

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().isConfigured).toBe(false);
  });

  it('restores a legacy Local CLI choice without weakening shell supervision', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('anthropic');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    vi.mocked(getSetting).mockResolvedValueOnce('codex-sdk');

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(getSetting).toHaveBeenCalledWith('ai_agent_transport');
    expect(getSetting).toHaveBeenCalledWith('ai_assistant_route');
    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
    expect(useAISettingsStore.getState().agentTransport).toBe('codex-sdk');
    expect(useAISettingsStore.getState().agentPermissions).toEqual({});
  });

  it('loads canonical assistant route and lets it override the legacy transport mirror', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('anthropic');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    vi.mocked(getSetting).mockResolvedValueOnce('codex-sdk');
    vi.mocked(getSetting).mockResolvedValueOnce(
      JSON.stringify({
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      })
    );

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    });
    expect(useAISettingsStore.getState().agentTransport).toBe('claude-agent-sdk');
    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('persists selected CLI transport and marks assistant configured', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setAgentTransport('codex-sdk');
    });

    expect(setSetting).toHaveBeenCalledWith('ai_agent_transport', 'codex-sdk');
    expect(setSetting).toHaveBeenCalledWith(
      'ai_assistant_route',
      JSON.stringify({
        version: 1,
        selection: {
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        },
      })
    );
    expect(useAISettingsStore.getState().agentTransport).toBe('codex-sdk');
    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('selects a CLI assistant route through the unified route action', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setAssistantRoute({
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      });
    });

    expect(setSetting).toHaveBeenCalledWith('ai_agent_transport', 'codex-sdk');
    expect(setSetting).toHaveBeenCalledWith(
      'ai_assistant_route',
      JSON.stringify({
        version: 1,
        selection: {
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        },
      })
    );
    expect(useAISettingsStore.getState().agentTransport).toBe('codex-sdk');
    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('selects a provider assistant route and clears CLI transport through one action', async () => {
    useAISettingsStore.setState({
      agentTransport: 'codex-sdk',
      isConfigured: true,
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'env' },
      } as any,
    });

    await act(async () => {
      await useAISettingsStore.getState().setAssistantRoute({
        kind: 'provider',
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
    });

    expect(setSetting).toHaveBeenCalledWith('ai_provider', 'openai');
    expect(setSetting).toHaveBeenCalledWith('ai_agent_transport', '');
    expect(setSetting).toHaveBeenCalledWith('ai_model', 'gpt-4o-mini');
    expect(useAISettingsStore.getState().provider).toBe('openai');
    expect(useAISettingsStore.getState().model).toBe('gpt-4o-mini');
    expect(useAISettingsStore.getState().agentTransport).toBeNull();
    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('persists provider change to SQLite', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setProvider('openai');
    });

    expect(setSetting).toHaveBeenCalledWith('ai_provider', 'openai');
    expect(useAISettingsStore.getState().provider).toBe('openai');
  });

  it('clears CLI transport when switching back to a provider API-key source', async () => {
    useAISettingsStore.setState({ agentTransport: 'codex-sdk', isConfigured: true });

    await act(async () => {
      await useAISettingsStore.getState().setProvider('openai');
    });

    expect(setSetting).toHaveBeenCalledWith('ai_agent_transport', '');
    expect(useAISettingsStore.getState().agentTransport).toBeNull();
    expect(useAISettingsStore.getState().isConfigured).toBe(false);
  });

  it('updates model to provider default when switching providers', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setProvider('google');
    });

    expect(useAISettingsStore.getState().model).toBe('gemini-3.5-flash');
    expect(setSetting).toHaveBeenCalledWith('ai_model', 'gemini-3.5-flash');
  });

  it('persists model change to SQLite', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setModel('gpt-4o-mini');
    });

    expect(setSetting).toHaveBeenCalledWith('ai_model', 'gpt-4o-mini');
    expect(useAISettingsStore.getState().model).toBe('gpt-4o-mini');
  });

  it('updates the active provider route in memory before persistence completes', async () => {
    const write = deferred<void>();
    vi.mocked(setSetting).mockReturnValue(write.promise);
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
      assistantRoute: {
        kind: 'provider',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });

    const switchPromise = useAISettingsStore.getState().setAssistantRoute({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(useAISettingsStore.getState()).toMatchObject({
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o-mini' },
      provider: 'openai',
      model: 'gpt-4o-mini',
      agentTransport: null,
      isConfigured: true,
    });

    write.resolve();
    await act(async () => {
      await switchPromise;
    });
  });

  it('updates the active model in memory before persistence completes', async () => {
    const write = deferred<void>();
    vi.mocked(setSetting).mockReturnValue(write.promise);
    useAISettingsStore.setState({
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
      provider: 'openai',
      model: 'gpt-4o',
    });

    const switchPromise = useAISettingsStore.getState().setModel('gpt-4o-mini');

    expect(useAISettingsStore.getState()).toMatchObject({
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o-mini' },
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    write.resolve();
    await act(async () => {
      await switchPromise;
    });
  });

  it('handles keyring errors gracefully', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('anthropic');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    mockPlatform.keyring.hasPassword.mockRejectedValueOnce(new Error('keyring not available'));

    await act(async () => {
      await initializeAndRefresh();
    });

    expect(useAISettingsStore.getState().isConfigured).toBe(false);
    expect(useAISettingsStore.getState().keyringError).toBeTruthy();
    expect(useAISettingsStore.getState().isLoading).toBe(false);
  });

  it('checks isConfigured after setting API key for current provider', async () => {
    useAISettingsStore.setState({ provider: 'anthropic' });

    await act(async () => {
      await useAISettingsStore.getState().setApiKey('anthropic', 'new-key');
    });

    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('does not update isConfigured when setting key for non-current provider', async () => {
    useAISettingsStore.setState({ provider: 'anthropic', isConfigured: false });

    await act(async () => {
      await useAISettingsStore.getState().setApiKey('openai', 'sk-key');
    });

    expect(useAISettingsStore.getState().isConfigured).toBe(false);
  });

  it('updates isConfigured when switching to provider with key', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });

    await act(async () => {
      await useAISettingsStore.getState().setProvider('openai');
    });

    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('updates isConfigured when switching to provider without key', async () => {
    useAISettingsStore.setState({ isConfigured: true });

    await act(async () => {
      await useAISettingsStore.getState().setProvider('openai');
    });

    expect(useAISettingsStore.getState().isConfigured).toBe(false);
  });

  it('retrieves API key for a specific provider', async () => {
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-openai');

    const key = await useAISettingsStore.getState().getApiKey('openai');

    expect(mockPlatform.keyring.getPassword).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      'openai_api_key'
    );
    expect(key).toBe('sk-openai');
  });

  it('rejects empty model name', async () => {
    await expect(useAISettingsStore.getState().setModel('')).rejects.toThrow(/model/i);

    await expect(useAISettingsStore.getState().setModel('   ')).rejects.toThrow(/model/i);
  });

  it('clears keyringError on successful provider switch', async () => {
    useAISettingsStore.setState({ keyringError: 'previous error' });

    await act(async () => {
      await useAISettingsStore.getState().setProvider('openai');
    });

    expect(useAISettingsStore.getState().keyringError).toBeNull();
  });

  it('last provider switch wins on rapid switching', async () => {
    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    vi.mocked(setSetting)
      .mockReturnValueOnce(firstPromise as any)
      .mockResolvedValue(undefined);

    const p1 = useAISettingsStore.getState().setProvider('anthropic');
    const p2 = useAISettingsStore.getState().setProvider('google');

    await p2;
    resolveFirst!();
    await p1;

    expect(useAISettingsStore.getState().provider).toBe('google');
    expect(useAISettingsStore.getState().isConfigured).toBe(false);
  });

  it('refreshProviderStatuses populates providerStatuses for all providers', async () => {
    vi.mocked(getSetting).mockResolvedValueOnce('anthropic');
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    mockPlatform.keyring.hasPassword.mockResolvedValueOnce(true);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-ant-key');

    await act(async () => {
      await initializeAndRefresh();
    });

    const { providerStatuses } = useAISettingsStore.getState();
    expect(providerStatuses.anthropic).toEqual({ isConfigured: true, keySource: 'keyring' });
    expect(providerStatuses.openai).toEqual({ isConfigured: false, keySource: 'none' });
    expect(providerStatuses.google).toEqual({ isConfigured: false, keySource: 'none' });
    expect(providerStatuses.xai).toEqual({ isConfigured: false, keySource: 'none' });
    expect(providerStatuses.deepseek).toEqual({ isConfigured: false, keySource: 'none' });
  });

  it('refreshProviderStatuses probes presence via hasPassword and never decrypts on a no-key run  Part C)', async () => {
    await act(async () => {
      await useAISettingsStore.getState().refreshProviderStatuses();
    });

    const { providerStatuses } = useAISettingsStore.getState();
    for (const p of Object.values(providerStatuses)) {
      expect(p).toEqual({ isConfigured: false, keySource: 'none' });
    }
    expect(mockPlatform.keyring.hasPassword).toHaveBeenCalled();
    expect(mockPlatform.keyring.getPassword).not.toHaveBeenCalled();
  });

  it('setApiKey updates providerStatuses for that provider', async () => {
    await act(async () => {
      await useAISettingsStore.getState().setApiKey('openai', 'sk-key');
    });

    const { providerStatuses } = useAISettingsStore.getState();
    expect(providerStatuses.openai).toEqual({ isConfigured: true, keySource: 'keyring' });
    expect(providerStatuses.anthropic).toEqual({ isConfigured: false, keySource: 'none' });
  });

  it('deleteApiKey updates providerStatuses for that provider', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });

    await act(async () => {
      await useAISettingsStore.getState().deleteApiKey('openai');
    });

    const { providerStatuses } = useAISettingsStore.getState();
    expect(providerStatuses.openai).toEqual({ isConfigured: false, keySource: 'none' });
  });

  it('setProvider reads isConfigured from cached providerStatuses', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        google: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });

    await act(async () => {
      await useAISettingsStore.getState().setProvider('google');
    });

    expect(useAISettingsStore.getState().isConfigured).toBe(true);
  });

  it('fetchModels sets status to loading then success', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });
    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['gpt-4o', 'gpt-4o-mini'],
      error: null,
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    await act(async () => {
      await useAISettingsStore.getState().fetchModels('openai');
    });

    const { providerModels } = useAISettingsStore.getState();
    expect(providerModels.openai.fetchStatus).toBe('success');
    expect(providerModels.openai.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(providerModels.openai.fetchError).toBeNull();
  });

  it('fetchModels sets status to error on failure', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });
    mockFetchProviderModels.mockResolvedValueOnce({
      models: [],
      error: 'OpenAI API error: 401 Unauthorized',
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('bad-key');

    await act(async () => {
      await useAISettingsStore.getState().fetchModels('openai');
    });

    const { providerModels } = useAISettingsStore.getState();
    expect(providerModels.openai.fetchStatus).toBe('error');
    expect(providerModels.openai.fetchError).toContain('401');
    expect(providerModels.openai.models).toEqual([]);
  });

  it('fetchModels sets error when no API key available', async () => {
    mockPlatform.keyring.getPassword.mockResolvedValueOnce(null);

    await act(async () => {
      await useAISettingsStore.getState().fetchModels('openai');
    });

    const { providerModels } = useAISettingsStore.getState();
    expect(providerModels.openai.fetchStatus).toBe('error');
    expect(providerModels.openai.fetchError).toContain('No API key');
  });

  it('fetchModels caches results to SQLite', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        anthropic: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });
    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['claude-sonnet-4-6'],
      error: null,
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    await act(async () => {
      await useAISettingsStore.getState().fetchModels('anthropic');
    });

    expect(setSetting).toHaveBeenCalledWith(
      'ai_models_cache_anthropic',
      expect.stringContaining('claude-sonnet-4-6')
    );
  });

  it('fetchModels auto-corrects model if not in fetched list', async () => {
    useAISettingsStore.setState({
      provider: 'openai',
      model: 'gpt-3.5-turbo',
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });
    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['gpt-4o', 'gpt-4o-mini'],
      error: null,
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    await act(async () => {
      await useAISettingsStore.getState().fetchModels('openai');
    });

    expect(useAISettingsStore.getState().model).toBe('gpt-4o');
  });

  it('fetchModels auto-corrects retired models and persists the assistant route', async () => {
    useAISettingsStore.setState({
      assistantRoute: { kind: 'provider', provider: 'google', model: 'gemini-2.0-flash' },
      provider: 'google',
      model: 'gemini-2.0-flash',
      providerStatuses: {
        ...DEFAULT_STATUSES,
        google: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });
    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-3.5-flash'],
      error: null,
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('AIza-key');

    await act(async () => {
      await useAISettingsStore.getState().fetchModels('google');
    });

    expect(useAISettingsStore.getState().model).toBe('gemini-3.5-flash');
    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'provider',
      provider: 'google',
      model: 'gemini-3.5-flash',
    });
    expect(setSetting).toHaveBeenCalledWith('ai_model', 'gemini-3.5-flash');
    expect(setSetting).toHaveBeenCalledWith(
      'ai_assistant_route',
      JSON.stringify({
        version: 1,
        selection: { kind: 'provider', provider: 'google', model: 'gemini-3.5-flash' },
      })
    );
  });

  it('fetchModels auto-corrects retired Anthropic models returned by discovery', async () => {
    useAISettingsStore.setState({
      assistantRoute: { kind: 'provider', provider: 'anthropic', model: 'claude-fable-5' },
      provider: 'anthropic',
      model: 'claude-fable-5',
      providerStatuses: {
        ...DEFAULT_STATUSES,
        anthropic: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });
    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['claude-fable-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
      error: null,
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-ant-key');

    await act(async () => {
      await useAISettingsStore.getState().fetchModels('anthropic');
    });

    expect(useAISettingsStore.getState().model).toBe('claude-sonnet-4-6');
    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(setSetting).toHaveBeenCalledWith('ai_model', 'claude-sonnet-4-6');
    expect(setSetting).toHaveBeenCalledWith(
      'ai_assistant_route',
      JSON.stringify({
        version: 1,
        selection: { kind: 'provider', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      })
    );
  });

  it('fetchModels keeps current model if it is in the fetched list', async () => {
    useAISettingsStore.setState({
      provider: 'openai',
      model: 'gpt-4o-mini',
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });
    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['gpt-4o', 'gpt-4o-mini'],
      error: null,
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    await act(async () => {
      await useAISettingsStore.getState().fetchModels('openai');
    });

    expect(useAISettingsStore.getState().model).toBe('gpt-4o-mini');
  });

  it('setApiKey triggers fetchModels for the provider', async () => {
    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['claude-sonnet-4-6'],
      error: null,
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('new-key');

    await act(async () => {
      await useAISettingsStore.getState().setApiKey('anthropic', 'new-key');
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockFetchProviderModels).toHaveBeenCalledWith('anthropic', 'new-key');
  });

  it('refreshProviderStatuses loads model cache from SQLite', async () => {
    const cache = JSON.stringify({ models: ['gpt-4o', 'gpt-4o-mini'], fetchedAt: Date.now() });
    vi.mocked(getSetting)
      .mockResolvedValueOnce('openai')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cache);
    mockPlatform.keyring.hasPassword
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['gpt-4o', 'gpt-4o-mini'],
      error: null,
    });

    await act(async () => {
      await initializeAndRefresh();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const { providerModels } = useAISettingsStore.getState();
    expect(providerModels.openai.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(providerModels.openai.fetchStatus).toBe('success');
  });

  it('retryFetchModels resets state and re-fetches', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
      providerModels: {
        ...defaultProviderModels(),
        openai: { models: [], fetchStatus: 'error', fetchError: 'Previous error' },
      } as any,
    });

    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['gpt-4o'],
      error: null,
    });
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    await act(async () => {
      await useAISettingsStore.getState().retryFetchModels('openai');
    });

    const { providerModels } = useAISettingsStore.getState();
    expect(providerModels.openai.fetchStatus).toBe('success');
    expect(providerModels.openai.models).toEqual(['gpt-4o']);
  });

  it('deleteApiKey clears provider models', async () => {
    useAISettingsStore.setState({
      providerModels: {
        ...defaultProviderModels(),
        openai: { models: ['gpt-4o'], fetchStatus: 'success', fetchError: null },
      } as any,
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });

    await act(async () => {
      await useAISettingsStore.getState().deleteApiKey('openai');
    });

    const { providerModels } = useAISettingsStore.getState();
    expect(providerModels.openai.models).toEqual([]);
    expect(providerModels.openai.fetchStatus).toBe('idle');
  });

  it('setProvider uses fetched models to pick model', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
      providerModels: {
        ...defaultProviderModels(),
        openai: {
          models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview'],
          fetchStatus: 'success',
          fetchError: null,
        },
      } as any,
    });

    await act(async () => {
      await useAISettingsStore.getState().setProvider('openai');
    });

    expect(useAISettingsStore.getState().model).toBe('gpt-4o');
  });

  it('retryFetchModels sets loading directly (no idle flash)', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
      providerModels: {
        ...defaultProviderModels(),
        openai: { models: [], fetchStatus: 'error', fetchError: 'Previous error' },
      } as any,
    });

    let resolveFetch!: (value: { models: string[]; error: null }) => void;
    mockFetchProviderModels.mockReturnValueOnce(
      new Promise((r) => {
        resolveFetch = r;
      })
    );
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    const retryPromise = act(async () => {
      const p = useAISettingsStore.getState().retryFetchModels('openai');
      await new Promise((r) => setTimeout(r, 0));
      expect(useAISettingsStore.getState().providerModels.openai.fetchStatus).toBe('loading');
      resolveFetch({ models: ['gpt-4o'], error: null });
      await p;
    });

    await retryPromise;
  });

  it('refreshProviderStatuses loads stale cache with idle fetchStatus', async () => {
    const staleCache = JSON.stringify({
      models: ['gpt-4o', 'gpt-4o-mini'],
      fetchedAt: Date.now() - 2 * 60 * 60 * 1000,
    });
    vi.mocked(getSetting)
      .mockResolvedValueOnce('openai')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(staleCache);
    mockPlatform.keyring.hasPassword
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    mockFetchProviderModels.mockResolvedValueOnce({
      models: ['gpt-4o', 'gpt-4o-mini'],
      error: null,
    });

    await act(async () => {
      await initializeAndRefresh();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const { providerModels } = useAISettingsStore.getState();
    expect(providerModels.openai.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(providerModels.openai.fetchStatus).toBe('success');
  });

  it('fetchModels aborts if provider deleted during fetch', async () => {
    useAISettingsStore.setState({
      providerStatuses: {
        ...DEFAULT_STATUSES,
        openai: { isConfigured: true, keySource: 'keyring' },
      } as any,
    });

    let resolveFetch!: (value: { models: string[]; error: null }) => void;
    mockFetchProviderModels.mockReturnValueOnce(
      new Promise((r) => {
        resolveFetch = r;
      })
    );
    mockPlatform.keyring.getPassword.mockResolvedValueOnce('sk-key');

    const fetchPromise = act(async () => {
      const p = useAISettingsStore.getState().fetchModels('openai');
      await new Promise((r) => setTimeout(r, 0));
      useAISettingsStore.setState({
        providerStatuses: {
          ...DEFAULT_STATUSES,
          openai: { isConfigured: false, keySource: 'none' },
        } as any,
      });
      resolveFetch({ models: ['gpt-4o'], error: null });
      await p;
    });

    await fetchPromise;

    const { providerModels } = useAISettingsStore.getState();
    expect(providerModels.openai.fetchStatus).toBe('idle');
    expect(providerModels.openai.models).toEqual([]);
  });
});

describe('looksLikeRealKey', () => {
  it('rejects placeholder strings', () => {
    expect(looksLikeRealKey('your-anthropic-key-here')).toBe(false);
    expect(looksLikeRealKey('your-openai-key-here')).toBe(false);
    expect(looksLikeRealKey('paste-your-key-here')).toBe(false);
    expect(looksLikeRealKey('your-xai-key-here')).toBe(false);
  });

  it('rejects short strings', () => {
    expect(looksLikeRealKey('')).toBe(false);
    expect(looksLikeRealKey('abc')).toBe(false);
    expect(looksLikeRealKey('123456789')).toBe(false);
  });

  it('accepts real-looking API keys', () => {
    expect(looksLikeRealKey('sk-ant-api03-abc123def456')).toBe(true);
    expect(looksLikeRealKey('sk-proj-abc123def456ghi789')).toBe(true);
    expect(looksLikeRealKey('AIzaSyABC123DEF456GHI789')).toBe(true);
    expect(looksLikeRealKey('xai-abc123def456ghi789jkl012')).toBe(true);
    expect(looksLikeRealKey('sk-abc123def456ghi789jkl012')).toBe(true);
  });
});

describe('AI settings startup isolation', () => {
  it('shares an in-flight read and distinguishes handled failure from readiness', async () => {
    const pending = deferred<string | null>();
    vi.mocked(getSetting).mockReturnValueOnce(pending.promise);
    const first = useAISettingsStore.getState().initialize();
    const second = useAISettingsStore.getState().initialize();
    expect(useAISettingsStore.getState().initializationStatus).toBe('loading');
    expect(getSetting).toHaveBeenCalledTimes(1);
    pending.reject(new Error('Saved settings unavailable'));
    await Promise.all([first, second]);
    expect(useAISettingsStore.getState()).toMatchObject({
      initializationStatus: 'error',
      isLoading: false,
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    await useAISettingsStore.getState().initialize();
    expect(useAISettingsStore.getState()).toMatchObject({
      initializationStatus: 'ready',
      keyringError: null,
    });
  });
});
