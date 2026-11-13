import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockSetProvider, mockSetApiKey, mockAddCustomProvider } = vi.hoisted(() => ({
  mockSetProvider: vi.fn(),
  mockSetApiKey: vi.fn().mockResolvedValue(undefined),
  mockAddCustomProvider: vi.fn().mockResolvedValue('custom:lab-gateway-test'),
}));

vi.mock('../../db', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../features/ai/settings', () => ({
  useAISettingsStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      provider: 'openai',
      model: 'gpt-4o',
      agentTransport: 'codex-sdk',
      providerStatuses: {
        anthropic: { isConfigured: false, keySource: 'none' },
        openai: { isConfigured: true, keySource: 'keyring' },
      },
      providerModels: {
        anthropic: { fetchStatus: 'idle', models: [] },
        openai: { fetchStatus: 'success', models: ['gpt-4o'] },
      },
      providerCredentialNames: {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'LAB_OPENAI_API_KEY',
      },
      customProviders: [],
      keyringError: null,
      setProvider: mockSetProvider,
      setModel: vi.fn(),
      setApiKey: mockSetApiKey,
      deleteApiKey: vi.fn(),
      retryFetchModels: vi.fn(),
      refreshProviderStatuses: vi.fn(),
      addCustomProvider: mockAddCustomProvider,
      updateCustomProvider: vi.fn(),
      removeCustomProvider: vi.fn(),
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../../features/ai/providers', () => {
  const PROVIDERS = [
    {
      name: 'anthropic',
      label: 'Anthropic',
      defaultModel: 'claude-sonnet-4-6',
      credential: {
        kind: 'api-key',
        label: 'API key',
        keyringAccount: 'anthropic_api_key',
        envVar: 'ANTHROPIC_API_KEY',
        placeholder: 'Paste an Anthropic API key',
        storageLabel: 'OS keychain',
      },
      modelFactory: { adapter: 'anthropic' },
      modelDiscovery: { adapter: 'anthropic' },
    },
    {
      name: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-4o',
      credential: {
        kind: 'api-key',
        label: 'API key',
        keyringAccount: 'openai_api_key',
        envVar: 'OPENAI_API_KEY',
        placeholder: 'Paste an OpenAI API key',
        storageLabel: 'OS keychain',
      },
      modelFactory: { adapter: 'openai' },
      modelDiscovery: {
        adapter: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        providerLabel: 'OpenAI',
        modelFilter: 'chat',
      },
    },
  ];
  return {
    PROVIDERS,
    getAllProviderMetas: () => PROVIDERS,
  };
});

vi.mock('../../features/agent-integrations', () => ({
  ExternalMcpRegistrationIssues: () => null,
  AgentExtensionsPanel: ({ view = 'overview' }: { view?: 'overview' | 'skills' }) => (
    <div data-testid={`mock-agent-extensions-${view}`}>Mock agent extensions</div>
  ),
  AssistantHostSettingsContent: ({
    focusHostId,
    directApiSettings,
  }: {
    focusHostId?: string | null;
    directApiSettings?: (isHostActive: boolean) => ReactNode;
  }) => (
    <div data-testid="mock-assistant-host-settings">
      <button type="button">Mock assistant host settings</button>
      {focusHostId === 'direct-api' ? (
        <div tabIndex={-1} data-testid="assistant-host-tab-direct-api">
          Direct API
        </div>
      ) : focusHostId === 'claude-code' ? (
        <div tabIndex={-1} data-testid="assistant-host-row-claude-agent-sdk">
          Claude Code
        </div>
      ) : (
        <div tabIndex={-1} data-testid="assistant-host-row-codex-sdk">
          Codex CLI
        </div>
      )}
      {focusHostId == null || focusHostId === 'direct-api' ? directApiSettings?.(false) : null}
    </div>
  ),
  ToolAccessSettingsContent: () => (
    <div data-testid="mock-tool-access-settings">Mock tool access settings</div>
  ),
}));

vi.mock('../../shared/context/DarkModeContext', () => ({
  useDarkMode: vi.fn(() => ({
    themeMode: 'system',
    setThemeMode: vi.fn(),
    persistence: { revision: 0, phase: 'saved' },
    retryPersistence: vi.fn(),
  })),
}));

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: vi.fn(() => ({
    folders: [],
  })),
}));

vi.mock('../../platform', () => ({
  platform: vi.fn(() => ({
    window: {
      setZoomLevel: vi.fn(async (factor: number) => ({ status: 'applied' as const, factor })),
    },
    fileAssociations: {
      queryHandlers: vi.fn().mockResolvedValue([
        {
          familyId: 'genbank',
          state: 'other',
          handlerName: 'SnapGene',
          handlerPath: null,
          defaultAction: 'instructions',
          detail: null,
        },
        {
          familyId: 'snapgene',
          state: 'none',
          handlerName: null,
          handlerPath: null,
          defaultAction: 'instructions',
          detail: null,
        },
      ]),
    },
  })),
}));

vi.mock('../../utils/environment', () => ({
  isBrowserOnly: vi.fn(() => true),
  isDesktopRuntime: vi.fn(() => false),
  isHostedBrowserRuntime: vi.fn(() => false),
}));

vi.mock('../../features/ai/hooks/useChatRouteControls', () => ({
  useChatRouteControls: vi.fn(() => ({
    renderAssistantRouteSelector: () => (
      <button type="button" data-testid="mock-hosted-route-picker">
        Hosted Auto and Deep
      </button>
    ),
    renderRouteCheckingStatus: () => null,
    renderRouteConfigurationPrompt: () => (
      <button type="button" data-testid="mock-hosted-unavailable">
        Hosted AI unavailable
      </button>
    ),
    renderConnectAiModal: () => <div data-testid="mock-hosted-connect-modal" />,
  })),
}));

describe('SettingsPanel — Privacy section', () => {
  let getSetting: ReturnType<typeof vi.fn>;
  let setSetting: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    await import('../HostedContributionSettings');
    await import('../SettingsPanel');
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    const { isHostedBrowserRuntime } = await import('../../utils/environment');
    vi.mocked(isHostedBrowserRuntime).mockReturnValue(false);
    localStorage.clear();
    const dbMod = await import('../../db');
    getSetting = vi.mocked(dbMod.getSetting);
    setSetting = vi.mocked(dbMod.setSetting);

    getSetting.mockResolvedValue(null);

    const colorSchemeMod = await import('../../features/design/color-scheme-store');
    colorSchemeMod.useAssemblyColorSchemeStore.setState({ assemblyColorScheme: 'tailwind' });
    const { useWorkspaceStore } = await import('../../stores/workspaceStore');
    vi.mocked(useWorkspaceStore).mockImplementation(() => ({ folders: [] }));
  });

  it('searches by synonym and focuses the actual setting without changing its value', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'zoom' } });
    const result = screen.getByRole('button', { name: /Appearance.*Display Scale/ });
    expect(result).toHaveTextContent('This device');
    fireEvent.click(result);
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('data-settings-target', 'display-scale')
    );
    expect(screen.getByTestId('display-scale-select')).toBeDisabled();
    expect(screen.getByTestId('settings-nav-appearance')).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(screen.getByTestId('settings-scope')).toHaveTextContent('This device');
    expect(search).toHaveValue('');
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('handles no matches, keyboard selection and existing disabled controls', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'no-such-setting' } });
    expect(screen.getByText('No settings found.')).toBeVisible();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    fireEvent.change(search, { target: { value: 'word wrap' } });
    expect(screen.getByRole('button', { name: /Editor.*Word Wrap/ })).toHaveTextContent(
      'Not available yet'
    );
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('data-settings-target', 'word-wrap')
    );
    expect(screen.getByRole('switch', { name: 'Word Wrap' })).toBeDisabled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('can search after opening Settings through an existing focus entry point', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel focusTarget="api-keys" />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    await waitFor(() =>
      expect(screen.getByTestId('settings-api-keys-config')).toContainElement(
        document.activeElement as HTMLElement
      )
    );
    fireEvent.change(search, { target: { value: 'zoom' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /Appearance.*Display Scale/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('data-settings-target', 'display-scale')
    );
    expect(screen.getByTestId('display-scale-select')).toBeDisabled();
    expect(screen.getByTestId('settings-nav-appearance')).toHaveAttribute(
      'aria-current',
      'location'
    );
  });

  it('renders the usage analytics switch beside the Privacy Policy link', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);
    const privacySection = screen.getByTestId('settings-section-privacy');
    const policyLink = screen.getByRole('link', { name: 'Read our Privacy Policy' });

    expect(privacySection).toContainElement(policyLink);
    expect(privacySection).toHaveAttribute('aria-label', 'Privacy');
    expect(policyLink).toHaveAttribute('href', 'https://dnaforge.com/privacy');
    expect(
      within(privacySection).getByRole('switch', {
        name: 'Share usage analytics and crash reports',
      })
    ).toBeInTheDocument();
    expect(privacySection).toHaveTextContent(/never which key/i);
    expect(screen.queryByTestId('bind-earlier-activity')).not.toBeInTheDocument();
  });

  it('shows migration navigation only when the migration section is available', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    const { rerender } = render(<SettingsPanel />);
    expect(screen.queryByTestId('settings-nav-migrations')).not.toBeInTheDocument();

    rerender(
      <SettingsPanel
        migrationSettings={{
          sources: [],
          activeMigration: null,
          history: [],
          historyError: null,
        }}
      />
    );
    expect(screen.getByTestId('settings-nav-migrations')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-migrations')).toBeInTheDocument();
  });

  it('keeps unavailable extension packages out of the default Settings navigation', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    expect(screen.queryByTestId('settings-nav-extensions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-extensions')).not.toBeInTheDocument();
  });

  it('uses Hosted controls without mounting desktop integrations in browser AI settings', async () => {
    const { isHostedBrowserRuntime } = await import('../../utils/environment');
    vi.mocked(isHostedBrowserRuntime).mockReturnValue(true);
    const { SettingsPanel } = await import('../SettingsPanel');
    const { useChatRouteControls } = await import('../../features/ai/hooks/useChatRouteControls');
    render(<SettingsPanel focusTarget="assistant-host:codex-cli" />);

    const aiSection = screen.getByTestId('settings-section-ai');
    expect(within(aiSection).getByTestId('settings-ai-hosted')).toBeInTheDocument();
    expect(within(aiSection).getByTestId('mock-hosted-route-picker')).toBeInTheDocument();
    expect(within(aiSection).getByTestId('mock-hosted-unavailable')).toBeInTheDocument();
    expect(within(aiSection).getByTestId('mock-hosted-connect-modal')).toBeInTheDocument();
    expect(useChatRouteControls).toHaveBeenCalledWith({});
    expect(within(aiSection).queryByTestId('mock-assistant-host-settings')).not.toBeInTheDocument();
    expect(
      within(aiSection).queryByTestId('settings-ai-agent-capabilities')
    ).not.toBeInTheDocument();
    expect(within(aiSection).queryByTestId('settings-ai-tool-access')).not.toBeInTheDocument();
  });

  it('has host and access decisions without an external-agent setup section', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);
    fireEvent.click(screen.getByTestId('settings-nav-ai'));
    expect(screen.getByTestId('settings-ai-host')).toBeInTheDocument();
    expect(screen.getByTestId('settings-ai-tool-access')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-ai-connect-agents')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-connect-agents')).not.toBeInTheDocument();
    expect(screen.queryByText('Other AI apps')).not.toBeInTheDocument();
  });

  it('renders Direct API providers inside Host without a duplicate settings subsection', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    expect(screen.getByTestId('settings-panel')).toHaveClass('overflow-hidden');
    expect(screen.getByTestId('settings-content')).toHaveClass('box-content', 'max-w-[760px]');
    expect(screen.getByTestId('settings-nav')).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav-ai')).toHaveTextContent('AI');
    expect(screen.getByTestId('settings-section-ai')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-ai')).not.toHaveClass(
      'border-t',
      'border-border-hover'
    );
    expect(screen.getByTestId('settings-section-ai')).toHaveAccessibleName('AI');
    expect(screen.getByTestId('settings-section-ai')).not.toHaveClass('grid');
    expect(
      within(screen.getByTestId('settings-section-ai')).getByRole('heading', { name: 'AI' })
    ).toBeVisible();
    const subsectionHeadings = [
      ['settings-ai-host', 'Host'],
      ['settings-ai-agent-capabilities', 'Skills'],
      ['settings-ai-tool-access', 'App permissions'],
    ] as const;
    for (const [testId, name] of subsectionHeadings) {
      const subsection = screen.getByTestId(testId);
      const heading = within(subsection).getByRole('heading', { name });
      expect(heading).toHaveClass('text-xl', 'font-semibold', 'tracking-tight');
      expect(heading).not.toHaveClass('text-sm');
      expect(heading.nextElementSibling).toBeNull();
    }
    expect(screen.queryByTestId('settings-scope')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Skills, prompt shortcuts, and saved context.')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Assistant routing, model access, and tool grants.')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Select the execution host for new messages/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Configure model providers that DNAForge calls directly.')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Keys stay in the OS keychain.')).not.toBeInTheDocument();
    expect(screen.queryByText('No providers yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/Environment-provided keys/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Review access used by other AI apps/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-assistant')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-assistant-host-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-ai-research-contribution')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Review or change whether your Hosted AI activity can be used to improve DNAForge and our work with research partners.'
      )
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Manage Hosted AI participation' })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-api-keys')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-ai-direct-api')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-api-keys-config')).toBeInTheDocument();
    expect(screen.queryByText('Search provider registry')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-direct-api-providers')).toBeInTheDocument();
    expect(screen.getByTestId('settings-direct-api-shell')).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Direct API providers' })).toBeInTheDocument();
    expect(screen.getByTestId('settings-direct-api-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('direct-api-provider-anthropic')).not.toBeInTheDocument();
    expect(screen.getByTestId('direct-api-provider-openai')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /OpenAI/ })).toHaveTextContent('Ready');
    expect(
      within(screen.getByTestId('settings-direct-api-providers')).queryByText('Active')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set as default', exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default', exact: true }));
    expect(mockSetProvider).toHaveBeenCalledWith('openai');
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeInTheDocument();
    expect(screen.queryByText('1 configured')).not.toBeInTheDocument();
    expect(screen.queryByText('No Direct API providers configured.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-api-provider-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provider-radio-anthropic')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(screen.getByTestId('direct-api-provider-picker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OpenAI' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add custom OpenAI-compatible endpoint' })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-tool-access')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-ai-tool-access')).toBeInTheDocument();
    expect(screen.getByTestId('mock-tool-access-settings')).toBeInTheDocument();
    expect(screen.queryByText('AI Assistant')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant host')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Model Providers')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant Hosts and Tool Access')).not.toBeInTheDocument();
    expect(screen.queryByText('Provider keys')).not.toBeInTheDocument();
    expect(screen.queryByText('Choose where new chat turns run.')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Provider API keys and model defaults used only by the Direct API assistant host.'
      )
    ).not.toBeInTheDocument();
  });

  it('keeps capabilities inline with the rest of AI settings', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    expect(screen.getByTestId('settings-scroll-container')).toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('mock-agent-extensions-overview')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-ai')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-skills-drawer')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Skills' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Capabilities' })).not.toBeInTheDocument();
  });

  it('opens File Handling from navigation and format search using real section content', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    fireEvent.click(screen.getByTestId('settings-nav-file-handling'));
    expect(await screen.findByTestId('file-handler-status-genbank')).toHaveTextContent(
      'Default: SnapGene'
    );
    expect(screen.getByTestId('settings-scope')).toHaveTextContent('This device');
    fireEvent.click(screen.getByTestId('settings-nav-appearance'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'gbff' },
    });
    fireEvent.click(screen.getByRole('button', { name: /File Handling.*File Handling/ }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'File Handling' })).toHaveFocus()
    );
    expect(screen.getByTestId('settings-nav-file-handling')).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(screen.getByTestId('file-handler-preview-genbank')).toBeEnabled();
  });

  it('does not expose desktop File Handling in the hosted web runtime', async () => {
    const { isHostedBrowserRuntime } = await import('../../utils/environment');
    vi.mocked(isHostedBrowserRuntime).mockReturnValue(true);
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    expect(screen.queryByTestId('settings-nav-file-handling')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-file-handling')).not.toBeInTheDocument();
    expect(screen.queryByText('File Handling')).not.toBeInTheDocument();
  });

  it('adds a provider credential without changing the active assistant route', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic' }));
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: 'sk-ant-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => {
      expect(mockSetApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-test');
    });
    expect(mockSetProvider).not.toHaveBeenCalled();
  });

  it('opens key maintenance for an existing provider without changing the active route', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    expect(screen.getByLabelText('OpenAI API key')).toBeInTheDocument();

    expect(mockSetProvider).not.toHaveBeenCalled();
  });

  it('adds a custom OpenAI-compatible endpoint with its model and key', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add custom OpenAI-compatible endpoint' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider name' }), {
      target: { value: 'Lab gateway' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider base URL' }), {
      target: { value: 'https://models.example.test/v1' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider model' }), {
      target: { value: 'lab-model' },
    });
    fireEvent.change(screen.getByLabelText('Provider API key'), {
      target: { value: 'lab-api-key' },
    });
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Add custom endpoint' })).getByRole('button', {
        name: 'Add endpoint',
      })
    );

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith(
        {
          label: 'Lab gateway',
          baseUrl: 'https://models.example.test/v1',
          defaultModel: 'lab-model',
        },
        'lab-api-key'
      );
    });
  });

  it('marks a settings section current when its nav item is clicked', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);
    fireEvent.click(screen.getByTestId('settings-nav-appearance'));
    expect(screen.getByTestId('settings-nav-appearance')).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(screen.getByTestId('settings-nav-ai')).not.toHaveAttribute('aria-current');
    expect(screen.queryByTestId('settings-nav-privacy')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Privacy' })).toBeNull();
  });

  it('marks Shortcuts current when that nav item is clicked', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);
    fireEvent.click(screen.getByTestId('settings-nav-shortcuts'));
    expect(screen.getByTestId('settings-nav-shortcuts')).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(screen.queryByTestId('settings-nav-release-notes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release Notes' })).toBeNull();
    expect(screen.queryByTestId('settings-nav-privacy')).toBeNull();
  });

  it('puts release notes on About', async () => {
    const onOpenReleaseNotes = vi.fn();
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel onOpenReleaseNotes={onOpenReleaseNotes} />);

    fireEvent.click(screen.getByTestId('settings-nav-about'));

    const about = screen.getByTestId('settings-section-about');
    expect(about).toHaveTextContent('Build information unavailable');
    expect(about).not.toHaveTextContent(/Currently running v|released \d/);
    expect(about).not.toHaveTextContent('Version, build, and what changed.');
    expect(screen.getByRole('heading', { name: 'About' })).toBeVisible();
    expect(about).toContainElement(screen.getByRole('link', { name: 'Read our Privacy Policy' }));
    fireEvent.click(screen.getByTestId('settings-open-release-notes'));
    expect(onOpenReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['api-keys', 'settings-api-keys-config'],
    ['assistant-host:claude-code', 'assistant-host-row-claude-agent-sdk'],
    ['primer-tm', 'settings-section-primer-tm'],
  ] as const)(
    'clears an active search when opening the %s destination',
    async (focusTarget, targetId) => {
      const onFocusTargetHandled = vi.fn();
      const { SettingsPanel } = await import('../SettingsPanel');
      const { rerender } = render(<SettingsPanel onFocusTargetHandled={onFocusTargetHandled} />);
      const search = screen.getByRole('searchbox', { name: 'Search settings' });
      fireEvent.change(search, { target: { value: 'theme' } });
      expect(screen.getByRole('list', { name: 'Settings search results' })).toBeVisible();

      rerender(
        <SettingsPanel focusTarget={focusTarget} onFocusTargetHandled={onFocusTargetHandled} />
      );

      await waitFor(() => expect(onFocusTargetHandled).toHaveBeenCalledTimes(1));
      expect(search).toHaveValue('');
      const target = screen.getByTestId(targetId);
      expect(target).toBeVisible();
      expect(target).toContainElement(document.activeElement as HTMLElement);
    }
  );

  it('opens and focuses nested Direct API controls when invoked for key configuration', async () => {
    const scrollIntoView = vi.fn();
    const onFocusTargetHandled = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel focusTarget="api-keys" onFocusTargetHandled={onFocusTargetHandled} />);

    expect(screen.getByTestId('settings-api-keys-config')).toBeInTheDocument();
    await waitFor(() => expect(onFocusTargetHandled).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('settings-api-keys-config')).toContainElement(
      document.activeElement as HTMLElement
    );
  });

  it('scrolls to assistant host settings when Settings is opened for host management', async () => {
    const scrollIntoView = vi.fn();
    const onFocusTargetHandled = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel focusTarget="assistant" onFocusTargetHandled={onFocusTargetHandled} />);

    expect(screen.getByTestId('settings-ai-host')).toBeInTheDocument();
    await waitFor(() => expect(onFocusTargetHandled).toHaveBeenCalledTimes(1));
  });

  it('focuses a specific CLI host row when Settings is opened from a host configure action', async () => {
    const scrollIntoView = vi.fn();
    const onFocusTargetHandled = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { SettingsPanel } = await import('../SettingsPanel');
    render(
      <SettingsPanel
        focusTarget="assistant-host:claude-code"
        onFocusTargetHandled={onFocusTargetHandled}
      />
    );

    const claudeRow = screen.getByTestId('assistant-host-row-claude-agent-sdk');
    await waitFor(() => expect(claudeRow).toHaveFocus());
    expect(onFocusTargetHandled).toHaveBeenCalledTimes(1);
  });

  it('should expose the assembly fragment color scheme selector in Appearance settings', async () => {
    const colorSchemeMod = await import('../../features/design/color-scheme-store');
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    expect(screen.getByTestId('settings-section-appearance')).toBeInTheDocument();
    expect(screen.getByTestId('assembly-color-scheme-picker')).toBeInTheDocument();
    expect(screen.getByTestId('assembly-color-scheme-tailwind')).toHaveTextContent('Tailwind');
    expect(screen.getByTestId('assembly-color-scheme-radix')).toHaveTextContent('Radix');
    expect(screen.getByTestId('assembly-color-scheme-carbon')).toHaveTextContent('Carbon');
    expect(screen.getByTestId('assembly-color-scheme-category10')).toHaveTextContent('Category 10');
    expect(screen.queryByTestId('assembly-color-scheme-soft')).not.toBeInTheDocument();
    expect(screen.queryByText(/Crisp, saturated UI colors/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Tailwind CSS')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('assembly-color-scheme-carbon'));

    expect(colorSchemeMod.useAssemblyColorSchemeStore.getState().assemblyColorScheme).toBe(
      'carbon'
    );
    expect(screen.getByTestId('assembly-color-scheme-carbon')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('moves the WebGL performance override into Appearance settings', async () => {
    getSetting.mockImplementation(async (key: string) => {
      if (key === 'sequence_webgl_performance_preference') return 'stability';
      return null;
    });
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    const select = await screen.findByTestId('webgl-performance-preference-select');
    expect(select).toHaveAttribute('data-value', 'stability');

    fireEvent.click(select);
    fireEvent.click(screen.getByRole('option', { name: 'Auto' }));

    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith('sequence_webgl_performance_preference', 'auto');
    });
  });

  it('keeps settings toggle descriptions and switch knobs aligned', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    const toggleDescription = screen.getByText('Minimize animations');
    expect(toggleDescription).toHaveClass('max-w-2xl');
    expect(toggleDescription.closest('div.grid')).toHaveClass('sm:grid-cols-[minmax(0,1fr)_auto]');
    expect(toggleDescription.closest('div.grid')).not.toHaveClass(
      'sm:grid-cols-[minmax(150px,220px)_minmax(0,1fr)]'
    );

    const toggle = toggleDescription.closest('div.grid')!.querySelector('[role="switch"]')!;
    const knob = toggle.querySelector('span')!;
    expect(toggle).toHaveClass('inline-flex', 'items-center', 'p-0.5');
    expect(knob).toHaveClass('translate-x-0');
    expect(knob).not.toHaveAttribute('style');
  });

  it('lists every open project in Workspace settings', async () => {
    const { useWorkspaceStore } = await import('../../stores/workspaceStore');
    vi.mocked(useWorkspaceStore).mockImplementation(() => ({
      folders: [
        { path: '/Users/scientist/projects/acme', name: 'Acme', addedAt: 1 },
        { path: '/Users/scientist/projects/beta', name: 'Beta', addedAt: 2, pinned: true },
      ],
    }));
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel onChangeWorkspace={() => undefined} />);
    fireEvent.click(screen.getByTestId('settings-nav-workspace'));
    expect(screen.queryByText('Projects open in this window.')).not.toBeInTheDocument();
    const projects = screen.getAllByTestId('settings-workspace-project');
    expect(projects).toHaveLength(2);
    expect(projects[0]).toHaveTextContent('Acme');
    expect(projects[0]).toHaveTextContent('~/projects/acme');
    expect(projects[1]).toHaveTextContent('Beta');
    expect(projects[1]).toHaveTextContent('Reference');
    expect(screen.getByTestId('change-workspace-button')).toHaveTextContent('Import project');
    expect(screen.queryByText('No workspace selected')).toBeNull();
    expect(screen.queryByText('Select Workspace')).toBeNull();
    expect(screen.queryByText('Add Folder')).toBeNull();
  });

  it('shows an empty workspace when no projects are open', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel onChangeWorkspace={() => undefined} />);
    fireEvent.click(screen.getByTestId('settings-nav-workspace'));
    expect(screen.getByTestId('settings-workspace-empty')).toHaveTextContent('No open projects.');
    expect(screen.getByTestId('change-workspace-button')).toHaveTextContent('Import project');
  });

  it('keeps About free of marketing copy', async () => {
    const { SettingsPanel } = await import('../SettingsPanel');
    render(<SettingsPanel />);

    expect(screen.getByTestId('settings-about-version')).toBeInTheDocument();
    expect(screen.getByText('Build information unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/scientific coordination platform/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI-native workflows/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/local-first architecture/i)).not.toBeInTheDocument();
  });
});
