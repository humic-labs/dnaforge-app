import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockState,
  mockGetState,
  mockSetApiKey,
  mockFetchModels,
  mockSetAssistantRoute,
  mockRunAgentAuth,
  mockFetchProviderModels,
} = vi.hoisted(() => {
  const setApiKey = vi.fn().mockResolvedValue(undefined);
  const fetchModels = vi.fn().mockResolvedValue(undefined);
  const setAssistantRoute = vi.fn().mockResolvedValue(undefined);
  const refreshAgentDetection = vi.fn().mockResolvedValue(null);
  const installedCli = {
    cli: 'installed' as const,
    path: '/x/claude',
    auth: 'authenticated' as const,
    defaultModel: null,
    keychainEntryPresent: null,
    credentialsFilePresent: null,
  };
  const state = {
    providerStatuses: {
      anthropic: { isConfigured: false },
      openai: { isConfigured: false },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    },
    providerModels: { openai: { models: ['gpt-4o-2024-11', 'gpt-4o-mini'] } },
    agentDetection: {
      claudeCode: { ...installedCli },
      codex: { ...installedCli, path: '/x/codex' },
      grok: {
        cli: 'installed' as const,
        path: '/x/grok',
        auth: 'authenticated' as const,
        defaultModel: null,
      },
    },
    setApiKey,
    fetchModels,
    setAssistantRoute,
    refreshAgentDetection,
  };
  return {
    mockState: state,
    mockGetState: vi.fn(() => state),
    mockSetApiKey: setApiKey,
    mockFetchModels: fetchModels,
    mockSetAssistantRoute: setAssistantRoute,
    mockRunAgentAuth: vi
      .fn()
      .mockResolvedValue({ ok: true, status: 'completed', transport: 'claude-agent-sdk' }),
    mockFetchProviderModels: vi
      .fn()
      .mockResolvedValue({ models: ['gpt-4o-2024-11', 'gpt-4o-mini'], error: null }),
  };
});

vi.mock('../../features/ai/settings', () => {
  const useAISettingsStore = vi.fn(() => mockState);
  (useAISettingsStore as unknown as { getState: unknown }).getState = mockGetState;
  return { useAISettingsStore };
});

vi.mock('../../features/ai/hooks/useAgentCliAuthFlow', () => ({
  useAgentCliAuthFlow: () => ({
    authenticatingTransport: null,
    authResult: null,
    runAgentAuth: mockRunAgentAuth,
  }),
}));

vi.mock('../../features/ai/modelDiscovery', () => ({
  fetchProviderModels: mockFetchProviderModels,
}));

import { ConnectAiModal } from './ConnectAiModal';
import { getDefaultModel } from '../../features/ai/providers';

describe('ConnectAiModal — provider-first connect (Connect-AI Slice A1)', () => {
  beforeEach(() => {
    mockSetApiKey.mockClear();
    mockFetchModels.mockClear();
    mockSetAssistantRoute.mockClear();
    mockRunAgentAuth.mockClear();
    mockFetchProviderModels.mockClear();
    mockFetchProviderModels.mockResolvedValue({
      models: ['gpt-4o-2024-11', 'gpt-4o-mini'],
      error: null,
    });
    mockState.agentDetection = {
      claudeCode: {
        cli: 'installed',
        path: '/x/claude',
        auth: 'authenticated',
        defaultModel: null,
        keychainEntryPresent: null,
        credentialsFilePresent: null,
      },
      codex: {
        cli: 'installed',
        path: '/x/codex',
        auth: 'authenticated',
        defaultModel: null,
        keychainEntryPresent: null,
        credentialsFilePresent: null,
      },
      grok: {
        cli: 'installed',
        path: '/x/grok',
        auth: 'authenticated',
        defaultModel: null,
      },
    };
    mockGetState.mockReturnValue(mockState);
  });

  it('opens to a provider grid with both a subscription lane and an API-key lane', () => {
    render(<ConnectAiModal open onClose={() => {}} />);
    expect(screen.getByTestId('connect-ai-modal')).toBeInTheDocument();
    expect(screen.getByText('Use a subscription')).toBeInTheDocument();
    expect(screen.getByText('Use an API key')).toBeInTheDocument();
    expect(screen.getByTestId('connect-ai-cli-claude-agent-sdk')).toBeInTheDocument();
    expect(screen.getByTestId('connect-ai-cli-grok-acp')).toBeInTheDocument();
    expect(screen.getByTestId('connect-ai-provider-openai')).toBeInTheDocument();
    expect(screen.getByTestId('connect-ai-provider-anthropic')).toBeInTheDocument();
  });

  it('pick provider → connect key → VALIDATES via live discovery, then saves, selects the discovered model, closes', async () => {
    const onClose = vi.fn();
    render(<ConnectAiModal open onClose={onClose} />);

    fireEvent.click(screen.getByTestId('connect-ai-provider-openai'));
    fireEvent.change(screen.getByTestId('connect-ai-key-input'), { target: { value: 'sk-abc' } });
    fireEvent.click(screen.getByTestId('connect-ai-key-save'));

    await waitFor(() => expect(mockFetchProviderModels).toHaveBeenCalledWith('openai', 'sk-abc'));
    expect(mockSetApiKey).toHaveBeenCalledWith('openai', 'sk-abc');
    expect(mockSetAssistantRoute).toHaveBeenCalledWith({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o-2024-11',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('INVALID key: shows the discovery error, never saves, never selects, never closes (no false "Connected")', async () => {
    const onClose = vi.fn();
    mockFetchProviderModels.mockResolvedValue({
      models: [],
      error: 'OpenAI API error: 401 Unauthorized',
    });
    render(<ConnectAiModal open onClose={onClose} />);

    fireEvent.click(screen.getByTestId('connect-ai-provider-openai'));
    fireEvent.change(screen.getByTestId('connect-ai-key-input'), { target: { value: 'sk-bad' } });
    fireEvent.click(screen.getByTestId('connect-ai-key-save'));

    await waitFor(() =>
      expect(screen.getByTestId('connect-ai-error')).toHaveTextContent(/401|did/i)
    );
    expect(mockFetchProviderModels).toHaveBeenCalledWith('openai', 'sk-bad');
    expect(mockSetApiKey).not.toHaveBeenCalled();
    expect(mockSetAssistantRoute).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('empty key shows an error and does not save or validate', () => {
    render(<ConnectAiModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('connect-ai-provider-openai'));
    fireEvent.click(screen.getByTestId('connect-ai-key-save'));
    expect(screen.getByTestId('connect-ai-error')).toBeInTheDocument();
    expect(mockSetApiKey).not.toHaveBeenCalled();
    expect(mockFetchProviderModels).not.toHaveBeenCalled();
  });

  it('subscription lane: when the CLI is NOT installed, shows install instructions, NOT a dead-end Sign-in button', () => {
    mockState.agentDetection = {
      claudeCode: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: null,
        credentialsFilePresent: null,
        searchedDirs: ['/usr/bin', '/usr/local/bin'],
      },
      codex: {
        cli: 'installed',
        path: '/x/codex',
        auth: 'authenticated',
        defaultModel: null,
        keychainEntryPresent: null,
        credentialsFilePresent: null,
      },
      grok: {
        cli: 'installed',
        path: '/x/grok',
        auth: 'authenticated',
        defaultModel: null,
      },
    };
    render(<ConnectAiModal open onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('connect-ai-cli-claude-agent-sdk'));

    expect(screen.getByTestId('cli-install-instructions-claude-agent-sdk')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-ai-cli-signin')).not.toBeInTheDocument();
  });

  it('a subscription sign-in selects the CLI route on success', async () => {
    const onClose = vi.fn();
    render(<ConnectAiModal open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('connect-ai-cli-claude-agent-sdk'));
    fireEvent.click(screen.getByTestId('connect-ai-cli-signin'));

    await waitFor(() => expect(mockRunAgentAuth).toHaveBeenCalledWith('claude-agent-sdk'));
    expect(mockSetAssistantRoute).toHaveBeenCalledWith({
      kind: 'cli',
      transport: 'claude-agent-sdk',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('signs in and selects the official Grok ACP route', async () => {
    const onClose = vi.fn();
    mockRunAgentAuth.mockResolvedValue({
      ok: true,
      status: 'completed',
      transport: 'grok-acp',
    });
    render(<ConnectAiModal open onClose={onClose} />);

    fireEvent.click(screen.getByTestId('connect-ai-cli-grok-acp'));
    fireEvent.click(screen.getByTestId('connect-ai-cli-signin'));

    await waitFor(() => expect(mockRunAgentAuth).toHaveBeenCalledWith('grok-acp'));
    expect(mockSetAssistantRoute).toHaveBeenCalledWith({
      kind: 'cli',
      transport: 'grok-acp',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('routes to the provider DEFAULT model, not the alphabetical models[0]', async () => {
    const preferred = getDefaultModel('anthropic');
    mockFetchProviderModels.mockResolvedValue({
      models: ['aaa-old-cheap-model', preferred].sort(),
      error: null,
    });
    const onClose = vi.fn();
    render(<ConnectAiModal open onClose={onClose} />);

    fireEvent.click(screen.getByTestId('connect-ai-provider-anthropic'));
    fireEvent.change(screen.getByTestId('connect-ai-key-input'), { target: { value: 'sk-ant' } });
    fireEvent.click(screen.getByTestId('connect-ai-key-save'));

    await waitFor(() => expect(mockSetAssistantRoute).toHaveBeenCalled());
    expect(mockSetAssistantRoute).toHaveBeenCalledWith({
      kind: 'provider',
      provider: 'anthropic',
      model: preferred,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('discovery that THROWS shows the error, never saves/selects/closes', async () => {
    const onClose = vi.fn();
    mockFetchProviderModels.mockRejectedValue(new Error('network down'));
    render(<ConnectAiModal open onClose={onClose} />);

    fireEvent.click(screen.getByTestId('connect-ai-provider-openai'));
    fireEvent.change(screen.getByTestId('connect-ai-key-input'), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByTestId('connect-ai-key-save'));

    await waitFor(() =>
      expect(screen.getByTestId('connect-ai-error')).toHaveTextContent(
        userMessage('failure.could-not-connect')
      )
    );
    expect(mockSetApiKey).not.toHaveBeenCalled();
    expect(mockSetAssistantRoute).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a FAILED CLI sign-in shows the error, never selects the route, never closes', async () => {
    const onClose = vi.fn();
    mockRunAgentAuth.mockResolvedValue({
      ok: false,
      status: 'failed',
      transport: 'claude-agent-sdk',
      error: 'login failed',
    });
    render(<ConnectAiModal open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('connect-ai-cli-claude-agent-sdk'));
    fireEvent.click(screen.getByTestId('connect-ai-cli-signin'));

    await waitFor(() =>
      expect(screen.getByTestId('connect-ai-error')).toHaveTextContent(
        userMessage('failure.sign-in-did-not-complete-try-again')
      )
    );
    expect(mockSetAssistantRoute).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('CLI lane while detection is UNRESOLVED shows "Checking…", not a Sign-in button that would error', () => {
    mockState.agentDetection = undefined as unknown as typeof mockState.agentDetection;
    render(<ConnectAiModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('connect-ai-cli-claude-agent-sdk'));

    expect(screen.getByTestId('connect-ai-cli-checking')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-ai-cli-signin')).not.toBeInTheDocument();
  });

  it('a key validated AFTER the modal is dismissed is NOT persisted (stale-resolve guard)', async () => {
    const onClose = vi.fn();
    let resolveDiscovery: (v: { models: string[]; error: string | null }) => void = () => {};
    mockFetchProviderModels.mockImplementation(
      () =>
        new Promise((res) => {
          resolveDiscovery = res;
        })
    );
    const { rerender } = render(<ConnectAiModal open onClose={onClose} />);
    fireEvent.click(screen.getByTestId('connect-ai-provider-openai'));
    fireEvent.change(screen.getByTestId('connect-ai-key-input'), { target: { value: 'sk-late' } });
    fireEvent.click(screen.getByTestId('connect-ai-key-save'));

    rerender(<ConnectAiModal open={false} onClose={onClose} />);
    resolveDiscovery({ models: ['gpt-4o-2024-11'], error: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSetApiKey).not.toHaveBeenCalled();
    expect(mockSetAssistantRoute).not.toHaveBeenCalled();
  });
});
