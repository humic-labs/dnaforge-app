import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { installAnalyticsFirehose } from '../../lib/analytics-firehose';
import { __resetAgentGrantsForTests } from '../agent-grants/public/store';
import { AgentIntegrationsPanel, type AgentIntegrationsPanelProps } from './AgentIntegrationsPanel';
import type { AgentCliModelCapabilityShape, AgentSdkDetectionShape } from '../../platform';

const {
  mockAISettingsState,
  mockSetAssistantRoute,
  mockAgentSdkDetect,
  mockRefreshAgentDetection,
  mockRefreshHostedRouteReadiness,
  mockAgentSdkQuery,
  mockAgentSdkAuthenticate,
  mockAgentSdkOnAuthEvent,
  mockListSchedules,
  mockCancelSchedule,
  mockAuthStoreState,
  authEventHandlers,
} = vi.hoisted(() => ({
  mockAISettingsState: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    assistantRoute: null as any,
    agentTransport: null as any,
    providerStatuses: {
      anthropic: { isConfigured: false, keySource: 'none' },
      openai: { isConfigured: false, keySource: 'none' },
    },
    providerModels: {
      anthropic: { fetchStatus: 'idle', fetchError: null, models: [] },
      openai: { fetchStatus: 'idle', fetchError: null, models: [] },
    },
    cliModelSettings: {
      'codex-sdk': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
      'claude-agent-sdk': {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        personality: null,
      },
    },
    customCliHarnesses: [] as Array<{
      id: string;
      label: string;
      transport: 'codex-sdk' | 'claude-agent-sdk' | 'grok-acp';
      executablePath: string;
      model: string | null;
      reasoningEffort: string | null;
      serviceTier: string | null;
      personality: string | null;
    }>,
    cliExecutablePathOverrides: {} as Partial<
      Record<'codex-sdk' | 'claude-agent-sdk' | 'grok-acp', string>
    >,
    hostedRouteReadiness: 'gateway-unavailable' as 'checking' | 'ready' | 'gateway-unavailable',
    agentPermissions: {} as Record<string, string>,
    permissionCatalog: {
      defaults: { claude: 'bypassPermissions', grok: 'auto', codex: ':danger-full-access' },
      options: {
        claude: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'].map(
          (value) => ({ value, label: value })
        ),
        grok: ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'].map(
          (value) => ({ value, label: value })
        ),
        codex: [
          { value: ':read-only', label: 'Read Only' },
          { value: ':workspace', label: 'Default' },
          { value: ':danger-full-access', label: 'Full Access' },
        ],
      },
    } as {
      defaults: Record<string, string>;
      options: Record<string, { value: string; label: string }[]>;
    } | null,
    loadPermissionCatalog: vi.fn().mockResolvedValue(undefined),
    additionalAgentInstructions: '',
    agentDetection: null as any,
    agentDetectError: null as string | null,
    keyringError: null,
    setProvider: vi.fn(),
    setModel: vi.fn(),
    setApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    retryFetchModels: vi.fn(),
    setCliModel: vi.fn().mockResolvedValue(undefined),
    setCliReasoningEffort: vi.fn().mockResolvedValue(undefined),
    setCliServiceTier: vi.fn().mockResolvedValue(undefined),
    setCliPersonality: vi.fn().mockResolvedValue(undefined),
    setCliExecutablePathOverride: vi.fn().mockResolvedValue(undefined),
    setAgentPermissions: vi.fn().mockResolvedValue(undefined),
    addCustomCliHarness: vi.fn().mockResolvedValue('custom-cli-lab-codex'),
    updateCustomCliHarness: vi.fn().mockResolvedValue(undefined),
    removeCustomCliHarness: vi.fn().mockResolvedValue(undefined),
    setAdditionalAgentInstructions: vi.fn().mockResolvedValue(undefined),
    refreshProviderStatuses: vi.fn(),
  },
  mockSetAssistantRoute: vi.fn().mockResolvedValue(undefined),
  mockAgentSdkDetect: vi.fn(),
  mockRefreshAgentDetection: vi.fn(),
  mockRefreshHostedRouteReadiness: vi.fn().mockResolvedValue('ready'),
  mockAgentSdkQuery: vi.fn(),
  mockAgentSdkAuthenticate: vi.fn(),
  mockAgentSdkOnAuthEvent: vi.fn((callback: (payload: unknown) => void) => {
    authEventHandlers.push(callback);
    return () => {
      const index = authEventHandlers.indexOf(callback);
      if (index >= 0) authEventHandlers.splice(index, 1);
    };
  }),
  mockListSchedules: vi.fn(),
  mockCancelSchedule: vi.fn(),
  mockAuthStoreState: {
    state: { status: 'signed-in' } as {
      status: string;
      session?: { desktopSessionId: string };
    },
    hydrated: true,
  },
  authEventHandlers: [] as Array<(payload: unknown) => void>,
}));

vi.mock('../ai/settings', () => ({
  MAX_ADDITIONAL_AGENT_INSTRUCTIONS_LENGTH: 16_000,
  DEFAULT_CLI_REASONING_EFFORTS: {
    'codex-sdk': 'high',
    'claude-agent-sdk': 'high',
    'grok-acp': 'high',
  },
  useAISettingsStore: vi.fn(() => ({
    ...mockAISettingsState,
    setAssistantRoute: mockSetAssistantRoute,
    refreshAgentDetection: mockRefreshAgentDetection,
    refreshHostedRouteReadiness: mockRefreshHostedRouteReadiness,
  })),
}));

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: vi.fn(() => mockAuthStoreState),
}));

vi.mock('../../platform', () => ({
  platform: vi.fn(() => ({
    window: { setZoomLevel: vi.fn() },
    agentSdk: {
      detect: mockAgentSdkDetect,
      authenticate: mockAgentSdkAuthenticate,
      onAuthEvent: mockAgentSdkOnAuthEvent,
      query: mockAgentSdkQuery,
    },
    agentSession: {
      listSchedules: mockListSchedules,
      cancelSchedule: mockCancelSchedule,
    },
    fs: {
      exists: vi.fn().mockResolvedValue(true),
    },
    agentCapabilities: {
      listManaged: vi.fn().mockResolvedValue({ commands: [], skills: [], memory: [] }),
      discover: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        snapshotId: 'settings-test',
        provider: 'codex-sdk',
        providerVersion: null,
        accountFingerprint: null,
        workspaceFingerprint: null,
        capturedAt: 1,
        controls: [],
      }),
      saveCommand: vi.fn().mockResolvedValue({ ok: true }),
      removeCommand: vi.fn().mockResolvedValue({ ok: true }),
      saveMemory: vi.fn().mockResolvedValue({ ok: true }),
      removeMemory: vi.fn().mockResolvedValue({ ok: true }),
      resetProviderMemory: vi.fn().mockResolvedValue({ ok: true }),
      removeProviderPlugin: vi.fn().mockResolvedValue({ ok: true }),
    },
  })),
}));

async function flushMountEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderPanel(props: AgentIntegrationsPanelProps = {}) {
  render(<AgentIntegrationsPanel {...props} />);
  await flushMountEffects();
}

function defaultAgentDetection() {
  return {
    codex: {
      cli: 'installed',
      path: '/usr/local/bin/codex',
      auth: 'authenticated',
      defaultModel: 'gpt-5.5',
      authMode: 'chatgpt',
      authFilePresent: true,
      models: [] as AgentCliModelCapabilityShape[],
    },
    claudeCode: {
      cli: 'missing',
      path: null,
      auth: 'unauthenticated',
      defaultModel: null,
      keychainEntryPresent: false,
      credentialsFilePresent: false,
    },
  };
}

function claudeAuthenticatedDetection() {
  return {
    ...defaultAgentDetection(),
    claudeCode: {
      cli: 'installed',
      path: '/usr/local/bin/claude',
      auth: 'authenticated',
      defaultModel: 'claude-fable-5[1m]',
      keychainEntryPresent: true,
      credentialsFilePresent: null,
    },
  };
}

function claudeUnauthenticatedDetection() {
  return {
    ...defaultAgentDetection(),
    claudeCode: {
      cli: 'installed',
      path: '/usr/local/bin/claude',
      auth: 'unauthenticated',
      defaultModel: 'claude-fable-5[1m]',
      keychainEntryPresent: false,
      credentialsFilePresent: null,
    },
  };
}

function allHostsReadyDetection(): AgentSdkDetectionShape {
  return {
    codex: {
      cli: 'installed',
      path: '/usr/local/bin/codex',
      auth: 'authenticated',
      defaultModel: 'gpt-5.5',
      authMode: 'chatgpt',
      authFilePresent: true,
      models: [
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
          serviceTiers: [{ id: 'priority', label: 'Fast' }],
          supportsPersonality: false,
          isDefault: true,
        },
      ],
      modelCatalog: {
        status: 'complete',
        source: 'codex-app-server',
        executablePath: '/usr/local/bin/codex',
        observedModelCount: 1,
        error: null,
      },
    },
    claudeCode: {
      cli: 'installed',
      path: '/usr/local/bin/claude',
      auth: 'authenticated',
      defaultModel: 'claude-opus-5-5',
      keychainEntryPresent: true,
      credentialsFilePresent: null,
      models: [
        {
          id: 'claude-opus-5-5',
          displayName: 'Opus 5.5',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
          serviceTiers: [{ id: 'fast', label: 'Fast' }],
          styles: [
            { id: 'concise', label: 'Concise' },
            { id: 'explanatory', label: 'Explanatory' },
          ],
          defaultStyle: 'concise',
          isDefault: true,
        },
      ],
      modelCatalog: {
        status: 'complete',
        source: 'claude-sdk-initialization',
        executablePath: '/usr/local/bin/claude',
        observedModelCount: 1,
        error: null,
      },
    },
    grok: {
      cli: 'installed',
      path: '/usr/local/bin/grok',
      auth: 'authenticated',
      defaultModel: 'grok-4.7',
      models: [
        {
          id: 'grok-4.7',
          displayName: 'Grok 4.7',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
          isDefault: true,
        },
      ],
      modelCatalog: {
        status: 'complete',
        source: 'grok-acp-initialization',
        executablePath: '/usr/local/bin/grok',
        observedModelCount: 1,
        error: null,
      },
    },
  };
}

describe('AgentIntegrationsPanel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAISettingsState.assistantRoute = null;
    const initialDetection = defaultAgentDetection();
    mockAISettingsState.agentDetection = initialDetection;
    mockAISettingsState.agentDetectError = null;
    mockAgentSdkDetect.mockResolvedValue(initialDetection);
    mockRefreshAgentDetection.mockImplementation(async () => {
      try {
        const detection = await mockAgentSdkDetect();
        mockAISettingsState.agentDetection = detection;
        mockAISettingsState.agentDetectError = null;
        return detection;
      } catch (error) {
        mockAISettingsState.agentDetectError =
          error instanceof Error ? error.message : String(error);
        return null;
      }
    });
    mockAgentSdkQuery.mockResolvedValue({
      transport: 'codex-sdk',
      ok: true,
      text: 'ok',
      durationMs: 20,
    });
    mockListSchedules.mockResolvedValue([]);
    mockCancelSchedule.mockResolvedValue({ ok: true, schedule: null });
    mockAgentSdkAuthenticate.mockResolvedValue({
      authId: 'auth-1',
      transport: 'codex-sdk',
      ok: true,
      status: 'completed',
      command: ['/usr/local/bin/codex', 'login'],
      output: '',
      durationMs: 20,
      detection: {
        codex: {
          cli: 'installed',
          path: '/usr/local/bin/codex',
          auth: 'authenticated',
          defaultModel: 'gpt-5.5',
          authMode: 'chatgpt',
          authFilePresent: true,
        },
        claudeCode: {
          cli: 'missing',
          path: null,
          auth: 'unauthenticated',
          defaultModel: null,
          keychainEntryPresent: false,
          credentialsFilePresent: false,
        },
      },
    });
    authEventHandlers.length = 0;
    mockAISettingsState.assistantRoute = null;
    mockAISettingsState.agentTransport = null;
    mockAISettingsState.cliModelSettings = {
      'codex-sdk': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
      'claude-agent-sdk': {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        personality: null,
      },
    };
    mockAISettingsState.customCliHarnesses = [];
    mockAISettingsState.cliExecutablePathOverrides = {};
    mockAISettingsState.hostedRouteReadiness = 'gateway-unavailable';
    mockAuthStoreState.state = { status: 'signed-in' };
    mockAuthStoreState.hydrated = true;
    mockAISettingsState.agentPermissions = {};
    mockAISettingsState.additionalAgentInstructions = '';
    localStorage.clear();
    __resetAgentGrantsForTests();
  });

  it(': shows OS-specific install commands for a missing CLI, and hides the picker + sign-in', async () => {
    await renderPanel();
    const assistantSection = await screen.findByTestId('agent-integrations-section-cli');
    const chooser = within(assistantSection).getByRole('tablist', { name: 'Assistant hosts' });

    fireEvent.click(within(chooser).getByRole('tab', { name: /Claude Code/ }));
    const claudeRow = within(assistantSection).getByTestId('assistant-host-row-claude-agent-sdk');

    const installBox = within(claudeRow).getByTestId('cli-install-instructions-claude-agent-sdk');
    expect(installBox).toBeInTheDocument();
    expect(
      within(claudeRow).getByTestId('cli-install-command-claude-agent-sdk').textContent
    ).toContain('claude.ai/install.sh');
    expect(
      within(claudeRow).getByTestId('cli-install-recheck-claude-agent-sdk')
    ).toBeInTheDocument();

    expect(
      within(claudeRow).queryByTestId('agent-cli-auth-claude-agent-sdk')
    ).not.toBeInTheDocument();
    expect(
      within(claudeRow).queryByTestId('agent-cli-use-claude-agent-sdk')
    ).not.toBeInTheDocument();

    fireEvent.click(within(chooser).getByRole('tab', { name: /Codex CLI/ }));
    const codexRow = within(assistantSection).getByTestId('assistant-host-row-codex-sdk');
    expect(
      within(codexRow).queryByTestId('cli-install-instructions-codex-sdk')
    ).not.toBeInTheDocument();
  });

  it("edits each installed agent's own default permission words", async () => {
    const detection = claudeAuthenticatedDetection();
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);
    await renderPanel();

    const preferences = await screen.findByTestId('agent-host-preferences');
    expect(preferences).toBeVisible();
    expect(preferences).toHaveClass('w-full');
    expect(preferences).not.toHaveClass('max-w-3xl');
    expect(screen.queryByText('Behavior & automation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-behavior-settings')).not.toBeInTheDocument();
    expect(within(preferences).queryByText('Shell approvals')).not.toBeInTheDocument();

    const codexRow = await screen.findByTestId('assistant-host-row-codex-sdk');
    expect(within(codexRow).queryByText('On request (Codex CLI)')).toBeNull();
    expect(
      within(codexRow).getByRole('combobox', { name: 'Codex permissions for new chats' })
    ).toHaveAttribute('data-value', ':danger-full-access');
    fireEvent.click(screen.getByRole('tab', { name: /Claude Code/ }));
    const claudeRow = await screen.findByTestId('assistant-host-row-claude-agent-sdk');
    const trigger = within(claudeRow).getByRole('combobox', {
      name: 'Claude permission mode for new chats',
    });
    expect(trigger).toHaveAttribute('data-value', 'bypassPermissions');
    fireEvent.click(trigger);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'plan' }));
    await waitFor(() => {
      expect(mockAISettingsState.setAgentPermissions).toHaveBeenCalledWith({ claude: 'plan' });
    });
    expect(screen.queryByTestId('scheduled-agent-tasks')).not.toBeInTheDocument();
  });

  it('shows native Claude schedules and cancels one from the app-owned UI', async () => {
    mockListSchedules
      .mockResolvedValueOnce([
        {
          id: 'claude-agent-sdk:cron_1',
          nativeId: 'cron_1',
          kind: 'cron',
          provider: 'claude-agent-sdk',
          sessionId: 'session_1',
          conversationId: 'conversation_1',
          providerConversationId: 'native_session_1',
          cwd: '/workspace',
          prompt: 'Check whether the import finished.',
          cron: '*/5 * * * *',
          humanSchedule: 'Every 5 minutes',
          recurring: true,
          durable: true,
          scheduledFor: null,
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      .mockResolvedValueOnce([]);

    await renderPanel();

    expect(screen.queryByTestId('scheduled-agent-tasks')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Claude Code/ }));
    const section = await screen.findByTestId('scheduled-agent-tasks');
    expect(within(section).getByText('Every 5 minutes')).toBeInTheDocument();
    expect(within(section).getByText('Check whether the import finished.')).toBeInTheDocument();
    expect(within(section).getByText('Recurring · survives restarts')).toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(mockCancelSchedule).toHaveBeenCalledWith('claude-agent-sdk:cron_1');
      expect(screen.queryByTestId('scheduled-agent-tasks')).not.toBeInTheDocument();
    });
  });

  it('edits and saves additional instructions shared by every assistant route', async () => {
    mockAISettingsState.additionalAgentInstructions = 'Start concise.';
    await renderPanel();

    const input = await screen.findByTestId('agent-additional-instructions');
    expect(input).toHaveClass('bg-black/[0.04]', 'dark:bg-white/[0.055]');
    expect(input).not.toHaveClass('bg-bg-muted/70');
    expect(input).toHaveValue('Start concise.');
    fireEvent.change(input, { target: { value: 'Discard this draft.' } });
    expect(screen.getByTestId('cancel-agent-additional-instructions')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-agent-additional-instructions'));
    expect(input).toHaveValue('Start concise.');
    fireEvent.change(input, { target: { value: 'Explain each assumption.' } });
    fireEvent.click(screen.getByTestId('save-agent-additional-instructions'));

    await waitFor(() => {
      expect(mockAISettingsState.setAdditionalAgentInstructions).toHaveBeenCalledWith(
        'Explain each assumption.'
      );
    });
  });

  it('shows assistant hosts and compact external access in one AI surface', async () => {
    await renderPanel();

    const panel = await screen.findByTestId('agent-integrations-panel');
    const assistantSection = within(panel).getByTestId('agent-integrations-section-cli');
    const grantSection = within(panel).getByTestId('agent-integrations-section-grants');
    expect(within(panel).getByRole('heading', { name: 'Assistant' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Host' })).toBeInTheDocument();
    expect(
      within(panel).getByRole('heading', { name: 'External Tool Access' })
    ).toBeInTheDocument();
    const hostChooser = within(assistantSection).getByRole('tablist', {
      name: 'Assistant hosts',
    });
    expect(within(hostChooser).getAllByRole('tab')).toHaveLength(5);
    expect(within(hostChooser).getAllByRole('tab')[0]).toHaveTextContent('DNAForge agent');
    expect(within(grantSection).getByTestId('agent-grants-list-shell')).not.toHaveClass(
      'border-border/30',
      'border-y',
      'border-t'
    );
    expect(within(hostChooser).getByText('Direct API')).toBeInTheDocument();
    expect(within(hostChooser).getByText('Codex CLI')).toBeInTheDocument();
    expect(within(hostChooser).getByText('Claude Code')).toBeInTheDocument();
    expect(
      within(assistantSection).queryByText('Changes apply to the next message.')
    ).not.toBeInTheDocument();
    expect(
      within(assistantSection).queryByText(
        'Choose where chat runs. Changes apply to the next message.'
      )
    ).not.toBeInTheDocument();
    expect(
      within(assistantSection).queryByRole('button', { name: 'Test' })
    ).not.toBeInTheDocument();
    expect(within(assistantSection).queryByText('Testing...')).not.toBeInTheDocument();
    expect(within(assistantSection).queryByText(/Connection ok/)).not.toBeInTheDocument();
    expect(within(assistantSection).queryByText(/Connection failed/)).not.toBeInTheDocument();
    const activeCodexRow = within(assistantSection).getByTestId('assistant-host-row-codex-sdk');
    expect(activeCodexRow).toHaveAttribute('aria-current', 'true');
    expect(within(activeCodexRow).queryByText('active', { exact: true })).not.toBeInTheDocument();
    const activeCodexTab = within(hostChooser).getByRole('tab', { name: /Codex CLI/ });
    expect(activeCodexTab).toHaveTextContent('Ready');
    expect(within(activeCodexTab).getByText('active')).toBeInTheDocument();
    expect(activeCodexTab).toHaveAttribute('aria-selected', 'true');
    expect(within(assistantSection).queryByTestId('assistant-host-row-direct-api')).toBeNull();
    expect(
      within(assistantSection).queryByText('Command-line assistant hosts')
    ).not.toBeInTheDocument();
    expect(within(grantSection).getByText('2 external callers')).toBeInTheDocument();
    expect(
      within(grantSection).queryByText(
        'Keys for scripts and external agents—not for chat or model billing.'
      )
    ).not.toBeInTheDocument();
    expect(
      within(grantSection).queryByRole('button', { name: 'Create script key' })
    ).not.toBeInTheDocument();
    fireEvent.click(within(grantSection).getByTestId('agent-grant-script-options'));
    expect(within(grantSection).getByRole('button', { name: 'Create script key' })).toBeEnabled();
    expect(
      within(grantSection).queryByRole('button', { name: 'Create API key' })
    ).not.toBeInTheDocument();
    expect(within(grantSection).queryByText('DNAForge chat')).not.toBeInTheDocument();
    expect(within(grantSection).getByText('MCP stdio bridge')).toBeInTheDocument();
    expect(within(grantSection).getByText('Bench script key')).toBeInTheDocument();
    expect(within(panel).queryByText('AI Assistant')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Assistant host')).not.toBeInTheDocument();
    expect(within(grantSection).queryByText('Tool callers')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Provider keys')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Assistant Hosts and Tool Access')).not.toBeInTheDocument();
    expect(
      within(panel).queryByText(/Subscription and CLI login are not available/)
    ).not.toBeInTheDocument();
    expect(within(panel).queryByText('Auth flow')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Connect AI')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Use a provider API key')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Use a subscription or CLI login')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Manage assistant connections and tool access.')).toBeNull();
    expect(within(panel).queryByText(/CLI login pays for model calls/)).toBeNull();
    expect(within(panel).queryByRole('list', { name: 'AI connection options' })).toBeNull();
    expect(within(grantSection).queryByText('Who can use DNAForge tools')).not.toBeInTheDocument();
    expect(within(grantSection).queryByText('External API keys')).not.toBeInTheDocument();
    expect(within(grantSection).queryByText('Local MCP connections')).not.toBeInTheDocument();
    expect(
      within(grantSection).queryByText(/These permissions control local DNAForge tool access/)
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole('heading', { name: 'AI Model Providers' })
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole('heading', { name: 'Agent Access and Integrations' })
    ).not.toBeInTheDocument();
  });

  it('uses one runtime chooser and renders only the selected host editor', async () => {
    const detection = claudeAuthenticatedDetection();
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const chooser = within(section).getByRole('tablist', { name: 'Assistant hosts' });
    expect(within(chooser).getByRole('tab', { name: /Codex CLI/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(within(section).getByTestId('assistant-host-row-codex-sdk')).toBeInTheDocument();
    expect(
      within(section).queryByTestId('assistant-host-row-claude-agent-sdk')
    ).not.toBeInTheDocument();

    fireEvent.click(within(chooser).getByRole('tab', { name: /Claude Code/ }));
    expect(within(section).getByTestId('assistant-host-row-claude-agent-sdk')).toBeInTheDocument();
    expect(within(section).queryByTestId('assistant-host-row-codex-sdk')).not.toBeInTheDocument();
  });

  it(': each host offers a one-word Default button, and the current default is shown, not clickable', async () => {
    const detection = claudeAuthenticatedDetection();
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);
    mockAISettingsState.assistantRoute = null;

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    expect(screen.queryByRole('combobox', { name: 'Default model' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Use for new chats|Automatic/)).not.toBeInTheDocument();
    const codexDefault = within(section).getByTestId('agent-cli-use-codex-sdk');
    expect(codexDefault).toHaveTextContent(/^Default$/);
    expect(codexDefault).toBeDisabled();
    expect(codexDefault).toHaveAttribute('aria-pressed', 'true');

    const chooser = within(section).getByRole('tablist', { name: 'Assistant hosts' });
    fireEvent.click(within(chooser).getByRole('tab', { name: /Claude Code/ }));
    const claudeDefault = within(section).getByTestId('agent-cli-use-claude-agent-sdk');
    expect(claudeDefault).toHaveTextContent(/^Set as default$/);
    expect(claudeDefault).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(claudeDefault);
    expect(mockSetAssistantRoute).toHaveBeenCalledWith({
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('adds a named custom harness with an explicit compatibility contract', async () => {
    await renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Add harness' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Harness name' }), {
      target: { value: 'Lab Codex' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Executable path' }), {
      target: { value: '/opt/lab/bin/codex' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save harness' }));

    await waitFor(() => {
      expect(mockAISettingsState.addCustomCliHarness).toHaveBeenCalledWith({
        label: 'Lab Codex',
        transport: 'codex-sdk',
        executablePath: '/opt/lab/bin/codex',
      });
    });
  });

  it('keeps host navigation on the left and gives every editor a restrained hierarchy', async () => {
    const detection = allHostsReadyDetection();
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const shell = within(section).getByTestId('assistant-host-shell');
    const chooser = within(section).getByRole('tablist', { name: 'Assistant hosts' });
    expect(shell).toHaveClass('grid-cols-[13rem_minmax(0,1fr)]');
    expect(shell).toHaveClass('h-[24rem]');
    expect(shell).not.toHaveClass('min-h-56');
    expect(shell).toHaveClass('bg-black/[0.025]', 'dark:bg-white/[0.035]');
    expect(shell).not.toHaveClass('bg-bg-subtle/50');
    expect(shell).not.toHaveClass('border-y');
    expect(chooser).toHaveClass('flex-col');
    expect(chooser).toHaveClass('p-0');
    expect(chooser).not.toHaveClass('p-2', 'gap-0.5');
    expect(chooser).not.toHaveClass('overflow-x-auto', 'border-b');

    const hosts = [
      { label: 'Codex CLI', transport: 'codex-sdk', supported: ['model', 'effort', 'speed'] },
      {
        label: 'Claude Code',
        transport: 'claude-agent-sdk',
        supported: ['model', 'effort', 'speed', 'style'],
      },
      { label: 'Grok Build', transport: 'grok-acp', supported: ['model', 'effort'] },
    ] as const;

    for (const host of hosts) {
      const tab = within(chooser).getByRole('tab', { name: new RegExp(host.label) });
      expect(tab).toHaveClass('border-l-2');
      expect(tab).not.toHaveClass('border-b-2');
      fireEvent.click(tab);
      expect(tab).toHaveClass('border-accent', 'bg-bg');
      const editor = within(section).getByTestId('assistant-host-editor');
      expect(editor).toHaveClass('h-[24rem]', 'overflow-y-auto');
      expect(editor).not.toHaveClass('border-l');
      expect(editor).not.toHaveClass('min-h-56');
      expect(within(editor).getByTestId(`assistant-host-title-${host.transport}`)).toHaveClass(
        'text-lg',
        'font-semibold'
      );
      expect(
        within(editor).queryByTestId(`assistant-host-description-${host.transport}`)
      ).toBeNull();
      const settings = within(section).getByTestId(`agent-cli-model-settings-${host.transport}`);
      expect(settings).toHaveClass('contents');
      expect(settings).not.toHaveClass('border-t');
      expect(within(editor).queryByText('Chat defaults')).not.toBeInTheDocument();
      for (const setting of ['model', 'effort', 'speed', 'style'] as const) {
        const field = within(settings).queryByTestId(
          `agent-cli-setting-${host.transport}-${setting}`
        );
        if ((host.supported as readonly string[]).includes(setting)) {
          expect(field).toBeVisible();
        } else {
          expect(field).toBeNull();
        }
      }
      expect(
        within(editor).queryByRole('combobox', { name: `${host.label} shell approvals` })
      ).not.toBeInTheDocument();
    }
  });

  it('opens the requested host editor for Settings deep links', async () => {
    const detection = claudeAuthenticatedDetection();
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);
    const { AssistantHostSettingsContent } = await import('./AgentIntegrationsPanel');

    render(<AssistantHostSettingsContent focusHostId="claude-code" />);
    await flushMountEffects();

    const chooser = await screen.findByRole('tablist', { name: 'Assistant hosts' });
    expect(within(chooser).getByRole('tab', { name: /Claude Code/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('assistant-host-row-claude-agent-sdk')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-host-row-codex-sdk')).not.toBeInTheDocument();
  });

  it('shows the registry-selected configured Direct API provider rather than a stale legacy provider', async () => {
    mockAISettingsState.agentDetection = {
      codex: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        authMode: null,
        authFilePresent: false,
      },
      claudeCode: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: false,
        credentialsFilePresent: false,
      },
    };
    mockAISettingsState.provider = 'anthropic';
    mockAISettingsState.model = 'claude-sonnet-4-20250514';
    mockAISettingsState.providerStatuses = {
      anthropic: { isConfigured: false, keySource: 'none' },
      openai: { isConfigured: true, keySource: 'keyring' },
    };
    mockAISettingsState.providerModels = {
      anthropic: { fetchStatus: 'idle', fetchError: null, models: [] },
      openai: { fetchStatus: 'success', fetchError: null, models: ['gpt-5.5'] },
    };

    await renderPanel();

    const directApiRow = await screen.findByTestId('assistant-host-row-direct-api');
    expect(directApiRow).toHaveAttribute('aria-current', 'true');
    expect(within(directApiRow).getByText('OpenAI / gpt-5.5')).toBeInTheDocument();
    expect(within(directApiRow).queryByText(/Anthropic/)).not.toBeInTheDocument();
  });

  it('does not mark Direct API active when the shared resolver selects a ready Hosted route', async () => {
    mockAISettingsState.agentDetection = {
      codex: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        authMode: null,
        authFilePresent: false,
      },
      claudeCode: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: false,
        credentialsFilePresent: false,
      },
    };
    mockAISettingsState.providerStatuses = {
      anthropic: { isConfigured: false, keySource: 'none' },
      openai: { isConfigured: false, keySource: 'none' },
    };
    mockAISettingsState.hostedRouteReadiness = 'ready';

    await renderPanel();

    const chooser = await screen.findByRole('tablist', { name: 'Assistant hosts' });
    expect(within(chooser).getByRole('tab', { name: /Direct API/ })).not.toHaveTextContent(
      'Active'
    );
    expect(within(chooser).getByRole('tab', { name: /DNAForge agent/ })).toHaveTextContent('Ready');
  });

  it('uses signed-out desktop auth when resolving the same fresh-profile route as chat', async () => {
    mockAISettingsState.agentDetection = {
      codex: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        authMode: null,
        authFilePresent: false,
      },
      claudeCode: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: false,
        credentialsFilePresent: false,
      },
    };
    mockAISettingsState.providerStatuses = {
      anthropic: { isConfigured: false, keySource: 'none' },
      openai: { isConfigured: false, keySource: 'none' },
    };
    mockAISettingsState.hostedRouteReadiness = 'ready';
    mockAuthStoreState.state = { status: 'signed-out' };

    await renderPanel();

    const chooser = await screen.findByRole('tablist', { name: 'Assistant hosts' });
    expect(within(chooser).getAllByRole('tab')[0]).toHaveTextContent('DNAForge agent');
    expect(within(chooser).getByRole('tab', { name: /Direct API/ })).not.toHaveTextContent(
      'active'
    );
    expect(screen.getByTestId('dnaforge-agent-host')).toHaveTextContent('Sign in');
  });

  it('refreshes the native Host status after same-account reauthentication with chat closed', async () => {
    mockAuthStoreState.state = {
      status: 'signed-in',
      session: { desktopSessionId: 'old-session' },
    };
    const { AssistantHostSettingsContent } = await import('./AgentIntegrationsPanel');
    const { rerender } = render(<AssistantHostSettingsContent />);
    await flushMountEffects();
    expect(mockRefreshHostedRouteReadiness).toHaveBeenCalledTimes(1);

    mockAuthStoreState.state = {
      status: 'signed-in',
      session: { desktopSessionId: 'new-session' },
    };
    rerender(<AssistantHostSettingsContent />);
    await flushMountEffects();
    expect(mockRefreshHostedRouteReadiness).toHaveBeenCalledTimes(2);
  });

  it('lets users choose Codex CLI as the built-in assistant source', async () => {
    mockAISettingsState.assistantRoute = {
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    };
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const chooser = within(section).getByRole('tablist', { name: 'Assistant hosts' });
    fireEvent.click(within(chooser).getByRole('tab', { name: /Codex CLI/ }));
    expect(within(section).queryByText(/Uses your local Codex login/)).not.toBeInTheDocument();
    expect(within(section).queryByText(/CLI auth: ChatGPT login/)).not.toBeInTheDocument();
    expect(within(section).queryByText(/auth: chatgpt/)).not.toBeInTheDocument();

    fireEvent.click(within(section).getByTestId('agent-cli-use-codex-sdk'));

    await waitFor(() => {
      expect(mockSetAssistantRoute).toHaveBeenCalledWith({
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      });
    });
  });

  it('lets a built-in harness use and reset an explicit executable path', async () => {
    mockAISettingsState.cliExecutablePathOverrides = {
      'codex-sdk': '/opt/lab/bin/codex',
    };
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const input = within(section).getByRole('textbox', { name: 'Codex CLI executable path' });
    expect(input).toHaveValue('/opt/lab/bin/codex');
    fireEvent.click(within(section).getByTestId('agent-cli-executable-find-codex-sdk'));
    await waitFor(() => {
      expect(mockRefreshAgentDetection).toHaveBeenCalled();
    });

    fireEvent.change(input, { target: { value: '/srv/agents/codex' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(mockAISettingsState.setCliExecutablePathOverride).toHaveBeenCalledWith(
        'codex-sdk',
        '/srv/agents/codex'
      );
    });

    fireEvent.click(within(section).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => {
      expect(mockAISettingsState.setCliExecutablePathOverride).toHaveBeenCalledWith(
        'codex-sdk',
        null
      );
    });
  });

  it('passes a built-in executable override to the vendor sign-in flow', async () => {
    mockAISettingsState.cliExecutablePathOverrides = {
      'codex-sdk': '/opt/lab/bin/codex',
    };
    const detection = defaultAgentDetection();
    detection.codex.auth = 'unauthenticated';
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    fireEvent.click(within(section).getByTestId('agent-cli-auth-codex-sdk'));
    await waitFor(() => {
      expect(mockAgentSdkAuthenticate).toHaveBeenCalledWith(
        'codex-sdk',
        expect.objectContaining({ binaryPathOverride: '/opt/lab/bin/codex' })
      );
    });
  });

  it('saves per-model Codex model, effort, and speed settings from the host row', async () => {
    const detection = defaultAgentDetection();
    detection.codex.authMode = 'apikey';
    detection.codex.defaultModel = 'gpt-5.5';
    detection.codex.models = [
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [{ id: 'priority', label: 'Fast' }],
        supportsPersonality: true,
        defaultServiceTier: null,
        isDefault: true,
      },
      {
        id: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [{ id: 'priority', label: 'Fast' }],
        supportsPersonality: true,
        defaultServiceTier: null,
        isDefault: false,
      },
    ];
    detection.codex.modelCatalog = {
      status: 'complete',
      source: 'codex-app-server',
      executablePath: '/usr/local/bin/codex',
      observedModelCount: 2,
      error: null,
    };
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const codexRow = within(section).getByTestId('assistant-host-row-codex-sdk');
    expect(within(codexRow).getByText('Model')).toBeInTheDocument();
    expect(within(codexRow).getByText('Effort')).toBeInTheDocument();
    expect(within(codexRow).getByText('Speed')).toBeInTheDocument();
    expect(within(codexRow).getByText('Style')).toBeInTheDocument();
    const codexModel = within(section).getByTestId('agent-cli-model-codex-sdk');
    fireEvent.click(codexModel);

    fireEvent.click(screen.getByTestId('agent-cli-model-codex-sdk-option-gpt-5-codex'));
    fireEvent.click(within(section).getByTestId('agent-cli-effort-codex-sdk'));
    fireEvent.click(screen.getByRole('option', { name: 'High' }));
    fireEvent.click(within(section).getByTestId('agent-cli-service-tier-codex-sdk'));
    fireEvent.click(screen.getByRole('option', { name: 'Fast' }));
    fireEvent.click(within(section).getByTestId('agent-cli-personality-codex-sdk'));
    fireEvent.click(screen.getByRole('option', { name: 'Friendly' }));

    await waitFor(() => {
      expect(mockAISettingsState.setCliModel).toHaveBeenCalledWith('codex-sdk', 'gpt-5-codex');
      expect(mockAISettingsState.setCliReasoningEffort).toHaveBeenCalledWith('codex-sdk', 'high');
      expect(mockAISettingsState.setCliServiceTier).toHaveBeenCalledWith('codex-sdk', 'priority');
      expect(mockAISettingsState.setCliPersonality).toHaveBeenCalledWith('codex-sdk', 'friendly');
    });
  });

  it('keeps a saved Codex speed when the live model catalog is temporarily empty', async () => {
    const detection = defaultAgentDetection();
    detection.codex.defaultModel = 'gpt-6-astra';
    detection.codex.models = [];
    mockAISettingsState.agentDetection = detection;
    mockAISettingsState.cliModelSettings['codex-sdk'] = {
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      personality: 'friendly',
    };
    mockAgentSdkDetect.mockResolvedValue(detection);

    await renderPanel();

    expect(screen.queryByTestId('agent-cli-service-tier-codex-sdk')).not.toBeInTheDocument();
    expect(mockAISettingsState.setCliServiceTier).not.toHaveBeenCalled();
    expect(mockAISettingsState.setCliPersonality).not.toHaveBeenCalled();
  });

  it('fails closed instead of showing a one-row Settings picker after catalog discovery fails', async () => {
    const detection = claudeAuthenticatedDetection();
    detection.claudeCode.models = [];
    detection.claudeCode.modelCatalog = {
      status: 'failed',
      source: 'claude-sdk-initialization',
      executablePath: '/usr/local/bin/claude',
      observedModelCount: 0,
      error: 'Claude model discovery timed out.',
    };
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);

    await renderPanel();

    const chooser = await screen.findByRole('tablist', { name: 'Assistant hosts' });
    fireEvent.click(within(chooser).getByRole('tab', { name: /Claude Code/ }));
    expect(screen.queryByTestId('agent-cli-model-claude-agent-sdk')).not.toBeInTheDocument();
    const retry = screen.getByTestId('agent-cli-model-discovery-error-claude-agent-sdk');
    expect(retry).toHaveTextContent('Models unavailable · Retry');
    fireEvent.click(retry);
    expect(mockRefreshAgentDetection).toHaveBeenCalled();
  });

  it('shows Claude Code as a first-class local CLI route', async () => {
    const detection = claudeAuthenticatedDetection();
    mockAISettingsState.agentDetection = detection;
    mockAgentSdkDetect.mockResolvedValue(detection);

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const chooser = within(section).getByRole('tablist', { name: 'Assistant hosts' });
    fireEvent.click(within(chooser).getByRole('tab', { name: /Claude Code/ }));
    expect(
      within(section).queryByText(/Uses your local Claude Code subscription login/)
    ).not.toBeInTheDocument();
    fireEvent.click(within(section).getByTestId('agent-cli-use-claude-agent-sdk'));

    await waitFor(() => {
      expect(mockSetAssistantRoute).toHaveBeenCalledWith({
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      });
    });
  });

  it('keeps the active chip compact so the Claude Code label stays visible', async () => {
    const detection = claudeAuthenticatedDetection();
    mockAISettingsState.agentDetection = detection;
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'claude-agent-sdk';
    mockAgentSdkDetect.mockResolvedValue(detection);

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const chooser = within(section).getByRole('tablist', { name: 'Assistant hosts' });
    const claudeTab = within(chooser).getByRole('tab', { name: /Claude Code/ });

    expect(within(claudeTab).getByText('Claude Code', { exact: true })).toBeInTheDocument();
    expect(within(claudeTab).getByText('active', { exact: true })).toBeInTheDocument();
    expect(within(claudeTab).queryByText('Claude Code active')).not.toBeInTheDocument();
  });

  it('launches Claude Code sign-in from the app and refreshes detection after success', async () => {
    const initialDetection = claudeUnauthenticatedDetection();
    const successDetection = claudeAuthenticatedDetection();
    mockAISettingsState.agentDetection = initialDetection;
    mockAgentSdkDetect
      .mockResolvedValueOnce(initialDetection)
      .mockResolvedValueOnce(successDetection);
    mockAgentSdkAuthenticate.mockImplementationOnce(async (_transport, options) => {
      authEventHandlers.forEach((handler) =>
        handler({
          authId: options.authId,
          event: {
            authId: options.authId,
            transport: 'claude-agent-sdk',
            stream: 'stdout',
            text: 'Open the browser to finish Claude Code sign-in.\\n',
            receivedAt: '2026-06-03T00:00:00.000Z',
          },
        })
      );
      return {
        authId: options.authId,
        transport: 'claude-agent-sdk',
        ok: true,
        status: 'completed',
        command: ['/usr/local/bin/claude', 'auth', 'login', '--claudeai'],
        output: '',
        durationMs: 30,
        detection: successDetection,
      };
    });

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const chooser = within(section).getByRole('tablist', { name: 'Assistant hosts' });
    fireEvent.click(within(chooser).getByRole('tab', { name: /Claude Code/ }));
    fireEvent.click(within(section).getByTestId('agent-cli-auth-claude-agent-sdk'));

    await waitFor(() => {
      expect(mockAgentSdkAuthenticate).toHaveBeenCalledWith(
        'claude-agent-sdk',
        expect.objectContaining({
          authId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          ),
        })
      );
    });
    expect(
      await within(section).findByTestId('agent-cli-auth-log-claude-agent-sdk')
    ).toHaveTextContent('Open the browser to finish Claude Code sign-in.');
    expect(
      await within(section).findByTestId('agent-cli-auth-result-claude-agent-sdk')
    ).toHaveTextContent('Sign-in complete');
    await waitFor(() => {
      expect(within(section).getByTestId('agent-cli-use-claude-agent-sdk')).toBeEnabled();
    });
    expect(mockAgentSdkAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('does not expose CLI permission modes in the normal host settings row', async () => {
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-cli');
    const activeCodexRow = within(section).getByTestId('assistant-host-row-codex-sdk');
    expect(activeCodexRow).toHaveAttribute('aria-current', 'true');
    expect(within(activeCodexRow).queryByText('active', { exact: true })).not.toBeInTheDocument();
    const chooser = within(section).getByRole('tablist', { name: 'Assistant hosts' });
    const activeCodexTab = within(chooser).getByRole('tab', { name: /Codex CLI/ });
    expect(within(activeCodexTab).getByText('active')).toBeInTheDocument();
    expect(activeCodexTab).toHaveAttribute('aria-selected', 'true');
    expect(within(section).queryByTestId('assistant-host-row-direct-api')).toBeNull();
    expect(within(section).queryByTestId('agent-cli-permission-mode-codex-sdk')).toBeNull();
    expect(within(activeCodexRow).queryByText('DNAForge-only tools')).not.toBeInTheDocument();
    expect(within(activeCodexRow).queryByText('Local CLI tools')).not.toBeInTheDocument();
  });

  it('shows a pending store state instead of fixture grants when the real grant store is not connected', async () => {
    const grants = await import('../agent-grants/store');
    grants.__resetAgentGrantsForTests([], 'pending');
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    expect(within(section).getByText('Access history is not available yet.')).toBeInTheDocument();
    expect(within(section).queryByText('In-app Strider')).not.toBeInTheDocument();
    expect(within(section).queryByText('MCP stdio bridge')).not.toBeInTheDocument();
    expect(within(section).queryByText('Bench script key')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'New API key' })).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Create key' })).not.toBeInTheDocument();
    fireEvent.click(within(section).getByTestId('agent-grant-script-options'));
    expect(within(section).getByRole('button', { name: 'Create script key' })).toBeDisabled();
  });

  it('presents active grants as concise rows with type, usage, scopes, and actions', async () => {
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    expect(screen.getByRole('heading', { name: 'Assistant' })).toBeInTheDocument();
    expect(within(section).queryByText('Tool callers')).not.toBeInTheDocument();
    expect(within(section).getByText('Dev sample data')).toBeInTheDocument();
    expect(within(section).queryByText('In-app Strider')).not.toBeInTheDocument();

    expect(within(section).queryByText('DNAForge chat')).not.toBeInTheDocument();
    expect(within(section).queryByText('App assistant')).not.toBeInTheDocument();
    expect(within(section).queryByText('System')).not.toBeInTheDocument();
    expect(
      within(section).queryByRole('button', {
        name: /Remove external access for DNAForge chat/,
      })
    ).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'New API key' })).not.toBeInTheDocument();
    fireEvent.click(within(section).getByTestId('agent-grant-script-options'));
    expect(within(section).getByRole('button', { name: 'Create script key' })).toBeEnabled();

    const externalKeyRow = within(section)
      .getByText('Bench script key')
      .closest('[data-testid^="agent-grant-row-"]');
    if (!externalKeyRow) throw new Error('External key row was not rendered.');
    expect(within(externalKeyRow).getByText('External access key')).toBeInTheDocument();
    expect(within(externalKeyRow).getByText('Last used')).toBeInTheDocument();
    expect(within(externalKeyRow).getByText('Never')).toBeInTheDocument();
    expect(within(externalKeyRow).getByText('2 scopes')).toBeInTheDocument();
    expect(within(externalKeyRow).getByText('Fetch annotations')).toBeInTheDocument();
    expect(
      within(externalKeyRow).getByRole('button', {
        name: 'Remove external access for Bench script key',
      })
    ).toBeEnabled();
  });

  it('shows local MCP connections as normal active access rows', async () => {
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    expect(within(section).queryByText('Local MCP connections')).not.toBeInTheDocument();
    const mcpRow = within(section)
      .getByText('MCP stdio bridge')
      .closest('[data-testid^="agent-grant-row-"]');
    if (!mcpRow) throw new Error('MCP row was not rendered.');
    expect(within(mcpRow).getByText('Local MCP client')).toBeInTheDocument();
    expect(within(mcpRow).getByText('Claude Code 2.1.0')).toBeInTheDocument();
    expect(within(mcpRow).getByText('/Users/researcher/plasmids')).toBeInTheDocument();
    expect(within(mcpRow).getByText('Completed · get_workspace')).toBeInTheDocument();
    expect(within(mcpRow).getByText('3 scopes')).toBeInTheDocument();
    expect(within(mcpRow).getByText('Read workspace')).toBeInTheDocument();
    expect(within(mcpRow).getByText('Read sequences')).toBeInTheDocument();
    expect(within(mcpRow).getByText('Fetch annotations')).toBeInTheDocument();
    expect(
      within(section).getByRole('button', { name: 'Remove external access for MCP stdio bridge' })
    ).toBeEnabled();
  });

  it('hides development and test callers unless the explicit dev grant flag is enabled', async () => {
    const grants = await import('../agent-grants/store');
    grants.__resetAgentGrantsForTests([
      {
        id: 'agent_in_app_strider',
        label: 'In-app Strider',
        kind: 'in-app',
        origin: 'app',
        isDevelopment: false,
        scopes: ['read-workspace'],
        createdAt: '2026-05-26T15:04:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
      {
        id: 'dna114-live-mcp-e2e',
        label: ' E2E',
        kind: 'stdio-mcp',
        origin: 'dev-test',
        isDevelopment: true,
        scopes: ['*'],
        createdAt: '2026-05-26T14:10:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ]);

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    expect(within(section).queryByText('0 external callers')).not.toBeInTheDocument();
    expect(within(section).getByText(/Development and test callers: 1 hidden/)).toBeInTheDocument();
    expect(within(section).queryByText('DNAForge chat')).not.toBeInTheDocument();
    expect(within(section).getByText('No app or script access to review.')).toBeInTheDocument();
    expect(within(section).queryByText('DNA-114 E2E')).not.toBeInTheDocument();
    expect(within(section).queryByText('Dev/test')).not.toBeInTheDocument();
  });

  it('renders wildcard MCP scopes as a readable all-scopes grant', async () => {
    const grants = await import('../agent-grants/store');
    grants.__resetAgentGrantsForTests([
      {
        id: 'agent_stdio_all_scopes',
        label: 'Local all-tools bridge',
        kind: 'stdio-mcp',
        scopes: ['*'],
        createdAt: '2026-05-26T14:10:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ]);
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    const mcpRow = within(section)
      .getByText('Local all-tools bridge')
      .closest('[data-testid^="agent-grant-row-"]');
    if (!mcpRow) throw new Error('Wildcard MCP row was not rendered.');
    expect(within(mcpRow).getByText('Local MCP client')).toBeInTheDocument();
    expect(within(mcpRow).getAllByText('All scopes')).toHaveLength(2);
    expect(within(mcpRow).queryByText('*')).not.toBeInTheDocument();
  });

  it('keeps external-key creation visible when only MCP external access exists', async () => {
    const grants = await import('../agent-grants/store');
    grants.__resetAgentGrantsForTests([
      {
        id: 'agent_in_app_strider',
        label: 'In-app Strider',
        kind: 'in-app',
        scopes: ['read-workspace'],
        createdAt: '2026-05-26T15:04:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
      {
        id: 'agent_stdio_bridge',
        label: 'MCP stdio bridge',
        kind: 'stdio-mcp',
        scopes: ['read-workspace'],
        createdAt: '2026-05-26T14:10:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ]);
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    fireEvent.click(within(section).getByTestId('agent-grant-script-options'));
    expect(within(section).getByRole('button', { name: 'Create script key' })).toBeEnabled();
    expect(within(section).getByText('1 external caller')).toBeInTheDocument();
    expect(within(section).queryByText('No external API keys.')).not.toBeInTheDocument();
    expect(within(section).getByText('MCP stdio bridge')).toBeInTheDocument();
    expect(within(section).queryByText('Bench script key')).not.toBeInTheDocument();
  });

  it('creates a new external access key with every supported permission and shows the one-time key', async () => {
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    fireEvent.click(within(section).getByTestId('agent-grant-script-options'));
    fireEvent.click(within(section).getByRole('button', { name: 'Create script key' }));
    fireEvent.change(within(section).getByLabelText('Script key name'), {
      target: { value: 'Nightly import job' },
    });

    expect(within(section).getAllByText('Read workspace').length).toBeGreaterThan(0);
    expect(within(section).getAllByText('Read sequences').length).toBeGreaterThan(0);
    expect(within(section).getAllByText('Fetch annotations').length).toBeGreaterThan(0);
    expect(within(section).getAllByText('Resolve biological IDs').length).toBeGreaterThan(0);
    expect(within(section).getAllByText('Fetch structures').length).toBeGreaterThan(0);
    fireEvent.click(within(section).getByRole('button', { name: 'Scopes' }));
    expect(within(section).getByLabelText('Write workspace')).toBeChecked();
    expect(within(section).getByLabelText('Modify settings')).toBeChecked();
    expect(within(section).getByLabelText('Run homology searches')).toBeChecked();
    expect(within(section).getByLabelText('Download external datasets')).toBeChecked();
    expect(within(section).getByLabelText('Calculate primer Tm externally')).toBeChecked();

    fireEvent.click(within(section).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(within(section).getByText('Script key created')).toBeInTheDocument();
    });
    expect(within(section).getByTestId('agent-grant-created-key')).toHaveTextContent(
      /^dna_mock_[A-Za-z0-9]+$/
    );
    expect(section).not.toHaveTextContent(/For external DNAForge tool calls/);
    const newGrant = within(section)
      .getByText('Nightly import job')
      .closest('[data-testid^="agent-grant-row-"]');
    if (!newGrant) throw new Error('New grant row was not rendered.');
    expect(within(newGrant).getByText('External access key')).toBeInTheDocument();
    expect(within(newGrant).getByText('Read workspace')).toBeInTheDocument();
    expect(within(newGrant).getByText('Write workspace')).toBeInTheDocument();
    const grants = await import('../agent-grants/store');
    const createdGrant = grants
      .listActiveAgentGrants()
      .find((grant) => grant.label === 'Nightly import job');
    expect(createdGrant?.scopes).toEqual(grants.DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES);
    expect(
      within(newGrant).getByText(`${grants.DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES.length} scopes`)
    ).toBeInTheDocument();
  });

  it('excludes the rendered credential section from manual analytics before content or event getters', async () => {
    await renderPanel();
    const section = await screen.findByTestId('agent-integrations-section-grants');
    fireEvent.click(within(section).getByTestId('agent-grant-script-options'));
    fireEvent.click(within(section).getByRole('button', { name: 'Create script key' }));
    fireEvent.change(within(section).getByLabelText('Script key name'), {
      target: { value: 'Nonfunctional privacy fixture' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Create' }));
    const key = await within(section).findByTestId('agent-grant-created-key');
    expect(key).toHaveTextContent(/^dna_mock_[A-Za-z0-9]+$/);
    expect(section).toHaveAttribute('data-analytics-block');
    expect(section).toHaveAttribute('data-ph-mask');
    expect(section).toHaveAttribute('data-ph-no-capture');
    expect(section).toHaveClass('ph-no-capture');

    const aggregateParent = section.parentElement;
    const keyText = key.firstChild;
    if (!aggregateParent || !keyText) throw new Error('Credential DOM was not rendered.');
    const sentinel = 'NONFUNCTIONAL_CREDENTIAL_SENTINEL_F27';
    const child = document.createElement('span');
    child.textContent = sentinel;
    key.appendChild(child);
    const publicControl = document.createElement('button');
    publicControl.dataset.testid = 'f27-public-firehose-control';
    publicControl.textContent = 'Open';
    document.body.appendChild(publicControl);

    const capture = vi.fn();
    const now = vi.fn(() => 5_000);
    const privateRead = vi.fn();
    const restoreGetters: Array<() => void> = [];
    const watchGetter = (target: object, property: string, value: unknown) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      Object.defineProperty(target, property, {
        configurable: true,
        get: () => {
          privateRead(property);
          return value;
        },
      });
      restoreGetters.push(() => {
        if (descriptor) Object.defineProperty(target, property, descriptor);
        else Reflect.deleteProperty(target, property);
      });
    };
    const markers = ['data-analytics-block', 'data-ph-mask', 'data-ph-no-capture'];
    const originalAttributes = [...markers, 'class'].map(
      (name) => [name, section.getAttribute(name)] as const
    );
    const uninstall = installAnalyticsFirehose({ capture, now });
    const eventTypes = [
      'click',
      'auxclick',
      'contextmenu',
      'keydown',
      'focusin',
      'wheel',
      'dragstart',
      'drop',
    ];
    const stopAfterFirehose = (event: Event) => event.stopImmediatePropagation();
    for (const type of eventTypes) {
      window.addEventListener(type, stopAfterFirehose, { capture: true });
    }
    try {
      fireEvent.click(publicControl);
      expect(capture).toHaveBeenCalledExactlyOnceWith(
        'interaction_observed',
        expect.objectContaining({
          target_test_id: 'f27-public-firehose-control',
        })
      );
      capture.mockClear();
      now.mockClear();
      for (const node of [aggregateParent, section, key, child, keyText]) {
        watchGetter(node, 'textContent', sentinel);
        watchGetter(node, 'ariaLabel', sentinel);
        watchGetter(node, 'title', sentinel);
      }

      for (const target of [aggregateParent, section, key, child, keyText]) {
        const events = [
          new MouseEvent('click', { bubbles: true, composed: true }),
          new MouseEvent('auxclick', { bubbles: true, composed: true }),
          new MouseEvent('contextmenu', { bubbles: true, composed: true }),
          new KeyboardEvent('keydown', { bubbles: true, composed: true }),
          new FocusEvent('focusin', { bubbles: true, composed: true }),
          new WheelEvent('wheel', { bubbles: true, composed: true }),
          new Event('dragstart', { bubbles: true, composed: true }),
          new Event('drop', { bubbles: true, composed: true }),
        ];
        for (const event of events) {
          if (event instanceof MouseEvent) watchGetter(event, 'clientX', 27);
          if (event instanceof KeyboardEvent) {
            watchGetter(event, 'key', sentinel);
            watchGetter(event, 'code', sentinel);
            watchGetter(event, 'repeat', true);
          }
          if (event instanceof WheelEvent) watchGetter(event, 'deltaY', 27);
          fireEvent(target, event);
          expect(privateRead, event.type).not.toHaveBeenCalled();
          expect(now, event.type).not.toHaveBeenCalled();
          expect(capture, event.type).not.toHaveBeenCalled();
        }
      }

      const composed = new MouseEvent('click', { bubbles: true, composed: true });
      Object.defineProperty(composed, 'composedPath', {
        value: () => [publicControl, key, section, window],
      });
      watchGetter(composed, 'clientX', 27);
      fireEvent(publicControl, composed);
      expect(privateRead).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();

      for (const marker of markers) section.removeAttribute(marker);
      section.classList.remove('ph-no-capture');
      fireEvent.click(key);
      expect(privateRead).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledExactlyOnceWith(
        'interaction_observed',
        expect.objectContaining({
          target_test_id: 'agent-grant-created-key',
        })
      );
      expect(capture.mock.calls[0][1]).not.toHaveProperty('target_text');
      expect(capture.mock.calls[0][1]).not.toHaveProperty('target_label');
    } finally {
      uninstall();
      for (const type of eventTypes) {
        window.removeEventListener(type, stopAfterFirehose, { capture: true });
      }
      for (const restore of restoreGetters.reverse()) restore();
      for (const [name, value] of originalAttributes) {
        if (value === null) section.removeAttribute(name);
        else section.setAttribute(name, value);
      }
      child.remove();
      publicControl.remove();
    }
  });

  it('lets advanced users customize external access key permissions', async () => {
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    fireEvent.click(within(section).getByTestId('agent-grant-script-options'));
    fireEvent.click(within(section).getByRole('button', { name: 'Create script key' }));
    fireEvent.change(within(section).getByLabelText('Script key name'), {
      target: { value: 'Workspace writer' },
    });

    fireEvent.click(within(section).getByRole('button', { name: 'Scopes' }));
    fireEvent.click(within(section).getByLabelText('Download external datasets'));
    fireEvent.click(within(section).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(within(section).getByText('Script key created')).toBeInTheDocument();
    });

    const newGrant = within(section)
      .getByText('Workspace writer')
      .closest('[data-testid^="agent-grant-row-"]');
    if (!newGrant) throw new Error('Customized grant row was not rendered.');
    expect(within(newGrant).getByText('Write workspace')).toBeInTheDocument();
    expect(within(newGrant).queryByText('Download external datasets')).not.toBeInTheDocument();
  });

  it('revokes an active grant from the list', async () => {
    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    fireEvent.click(
      within(section).getByRole('button', { name: 'Remove external access for Bench script key' })
    );

    await waitFor(() => {
      expect(within(section).queryByText('Bench script key')).not.toBeInTheDocument();
    });
    expect(within(section).queryByTestId('agent-grants-error')).not.toBeInTheDocument();
  });

  it('loads the next bounded page of external callers on request', async () => {
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:8124');
    const firstGrant = {
      id: 'agent_http_newer',
      label: 'Newer caller',
      kind: 'http-api-key',
      origin: 'tool-key',
      isDevelopment: false,
      scopes: ['read-workspace'],
      createdAt: '2026-09-08T12:00:00Z',
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    };
    const secondGrant = {
      ...firstGrant,
      id: 'agent_http_older',
      label: 'Older caller',
      createdAt: '2026-09-08T11:00:00Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            grants: [firstGrant],
            hiddenDevelopmentGrantCount: 0,
            hasMore: true,
            nextCursor: 'MQ',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            grants: [secondGrant],
            hiddenDevelopmentGrantCount: 0,
            hasMore: false,
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    const grants = await import('../agent-grants/store');
    grants.__resetAgentGrantsForTests([], 'connected');

    await renderPanel();

    const section = await screen.findByTestId('agent-integrations-section-grants');
    expect(await within(section).findByText('Newer caller')).toBeInTheDocument();
    expect(within(section).queryByText('Older caller')).not.toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Load more callers' }));

    expect(await within(section).findByText('Older caller')).toBeInTheDocument();
    expect(within(section).getByText('Newer caller')).toBeInTheDocument();
    expect(
      within(section).queryByRole('button', { name: 'Load more callers' })
    ).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:8124/agent-grants?includeDevTest=false',
      'http://127.0.0.1:8124/agent-grants?includeDevTest=false&cursor=MQ',
    ]);
  });

  async function revealCopyFixture() {
    const { ToolAccessSettingsContent } = await import('./AgentIntegrationsPanel');
    const view = render(<ToolAccessSettingsContent />);
    await flushMountEffects();
    const section = await screen.findByTestId('agent-integrations-section-grants');
    fireEvent.click(within(section).getByTestId('agent-grant-script-options'));
    fireEvent.click(within(section).getByRole('button', { name: 'Create script key' }));
    fireEvent.change(within(section).getByLabelText('Script key name'), {
      target: { value: 'F27 nonfunctional clipboard fixture' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Create' }));
    const key = await within(section).findByTestId('agent-grant-created-key');
    const value = key.textContent!;
    expect(value).toMatch(/^dna_mock_[A-Za-z0-9]+$/);
    const grants = await import('../agent-grants/store');
    return { ...view, section, key, value, grants, count: grants.listActiveAgentGrants().length };
  }

  function replaceClipboardForTest(writeText?: (value: string) => Promise<void>) {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: writeText ? { writeText } : undefined,
    });
    return () => {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    };
  }

  it('acknowledges the same one-time key only after a controlled fulfilled copy, including hide/show', async () => {
    let finish!: () => void;
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const restore = replaceClipboardForTest(write);
    try {
      const { section, value, grants, count } = await revealCopyFixture();
      let copy = within(section).getByRole('button', { name: 'Copy external access key' });
      fireEvent.click(copy);
      expect(copy).toBeDisabled();
      expect(copy).toHaveAttribute('aria-busy', 'true');
      expect(copy).toHaveAttribute('title', 'Copying key…');
      expect(within(section).queryByText('Key copied.')).not.toBeInTheDocument();
      fireEvent.click(copy);
      expect(write).toHaveBeenCalledTimes(1);
      fireEvent.click(within(section).getByRole('button', { name: 'Hide script access' }));
      expect(within(section).queryByTestId('agent-grant-created-key')).not.toBeInTheDocument();
      fireEvent.click(within(section).getByRole('button', { name: 'Script access' }));
      copy = within(section).getByRole('button', { name: 'Copy external access key' });
      expect(copy).toBeDisabled();
      expect(within(section).getByTestId('agent-grant-created-key')).toHaveTextContent(value);
      await act(async () => {
        finish();
      });
      expect(copy).toBeEnabled();
      expect(copy).toHaveAttribute('title', 'Key copied');
      expect(within(section).getByText('Key copied.')).toHaveAttribute('role', 'status');
      expect(write).toHaveBeenCalledWith(value);
      expect(grants.listActiveAgentGrants()).toHaveLength(count);
    } finally {
      restore();
    }
  });

  it.each(['rejected', 'unsupported'] as const)(
    'retains the same reveal and an explicit retry after %s clipboard access',
    async (kind) => {
      const rejected = vi.fn(async () => {
        throw new Error('NONFUNCTIONAL_CLIPBOARD_REFUSAL');
      });
      const restore = replaceClipboardForTest(kind === 'rejected' ? rejected : undefined);
      try {
        const { section, key, value, grants, count } = await revealCopyFixture();
        const copy = within(section).getByRole('button', { name: 'Copy external access key' });
        fireEvent.click(copy);
        expect(await within(section).findByRole('alert')).toHaveTextContent(
          'Could not copy the key'
        );
        expect(section).not.toHaveTextContent('NONFUNCTIONAL_CLIPBOARD_REFUSAL');
        expect(copy).toBeEnabled();
        expect(copy).toHaveAttribute('title', 'Retry copy');
        expect(within(section).queryByText('Key copied.')).not.toBeInTheDocument();
        expect(key).toHaveTextContent(value);
        expect(grants.listActiveAgentGrants()).toHaveLength(count);
        const retry = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: retry },
        });
        fireEvent.click(copy);
        await waitFor(() => expect(copy).toHaveAttribute('title', 'Key copied'));
        expect(retry).toHaveBeenCalledExactlyOnceWith(value);
        expect(key).toHaveTextContent(value);
        expect(grants.listActiveAgentGrants()).toHaveLength(count);
      } finally {
        restore();
      }
    }
  );

  it('does not let an older write acknowledge or unlock a newer one-time key copy', async () => {
    let oldFinish!: () => void;
    let newFinish!: () => void;
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          oldFinish = resolve;
        })
    );
    const second = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          newFinish = resolve;
        })
    );
    const restore = replaceClipboardForTest(first);
    try {
      const { section, value: oldValue, grants, count } = await revealCopyFixture();
      fireEvent.click(within(section).getByRole('button', { name: 'Copy external access key' }));
      fireEvent.click(within(section).getByRole('button', { name: 'Create script key' }));
      expect(within(section).queryByTestId('agent-grant-created-key')).not.toBeInTheDocument();
      fireEvent.change(within(section).getByLabelText('Script key name'), {
        target: { value: 'F27 second fixture' },
      });
      fireEvent.click(within(section).getByRole('button', { name: 'Create' }));
      const key = await within(section).findByTestId('agent-grant-created-key');
      const newValue = key.textContent!;
      expect(newValue).not.toBe(oldValue);
      expect(grants.listActiveAgentGrants()).toHaveLength(count + 1);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: second },
      });
      const copy = within(section).getByRole('button', { name: 'Copy external access key' });
      fireEvent.click(copy);
      await act(async () => {
        oldFinish();
      });
      expect(copy).toBeDisabled();
      expect(copy).toHaveAttribute('title', 'Copying key…');
      expect(within(section).queryByText('Key copied.')).not.toBeInTheDocument();
      expect(key).toHaveTextContent(newValue);
      await act(async () => {
        newFinish();
      });
      expect(copy).toHaveAttribute('title', 'Key copied');
      expect(first).toHaveBeenCalledExactlyOnceWith(oldValue);
      expect(second).toHaveBeenCalledExactlyOnceWith(newValue);
      expect(grants.listActiveAgentGrants()).toHaveLength(count + 1);
    } finally {
      restore();
    }
  });

  it('does not redisplay a one-time key after unmount and a delayed write completion', async () => {
    let finish!: () => void;
    const restore = replaceClipboardForTest(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    try {
      const { section, unmount, grants, count } = await revealCopyFixture();
      fireEvent.click(within(section).getByRole('button', { name: 'Copy external access key' }));
      unmount();
      await act(async () => {
        finish();
      });
      const { ToolAccessSettingsContent } = await import('./AgentIntegrationsPanel');
      render(<ToolAccessSettingsContent />);
      await flushMountEffects();
      const remounted = await screen.findByTestId('agent-integrations-section-grants');
      fireEvent.click(within(remounted).getByTestId('agent-grant-script-options'));
      expect(within(remounted).queryByTestId('agent-grant-created-key')).not.toBeInTheDocument();
      expect(within(remounted).queryByText('Key copied.')).not.toBeInTheDocument();
      expect(grants.listActiveAgentGrants()).toHaveLength(count);
    } finally {
      restore();
    }
  });
});
