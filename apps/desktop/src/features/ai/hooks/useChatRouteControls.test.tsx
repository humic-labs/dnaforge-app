import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useChatRouteControls } from './useChatRouteControls';
import { ConfirmDialogHost } from '../../../components/ConfirmDialogHost';
import { useConfirmDialogStore } from '../../../components/confirm-dialog-store';

const { mockAISettingsState, mockAuthState, mockDesktopAuthBridge } = vi.hoisted(() => ({
  mockAISettingsState: {
    assistantRoute: null as unknown,
    isConfigured: true,
    provider: 'openai',
    model: 'gpt-4o',
    agentTransport: null as unknown,
    agentDetection: null as unknown,
    agentDetectError: null as string | null,
    hostedRouteReadiness: 'ready' as 'ready' | 'checking' | 'needs-login' | 'gateway-unavailable',
    providerStatuses: {
      anthropic: { isConfigured: true },
      openai: { isConfigured: true },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    },
    providerModels: {
      anthropic: { models: [] },
      openai: { models: ['gpt-4o'] },
      google: { models: [] },
      xai: { models: [] },
      deepseek: { models: [] },
    },
    cliModelSettings: {
      'codex-sdk': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
      'claude-agent-sdk': {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        personality: null,
      },
      'grok-acp': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
    },
    setAssistantRoute: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setCliModel: vi.fn().mockResolvedValue(undefined),
    setCliReasoningEffort: vi.fn().mockResolvedValue(undefined),
    setCliServiceTier: vi.fn().mockResolvedValue(undefined),
    setCliPersonality: vi.fn().mockResolvedValue(undefined),
    refreshProviderStatuses: vi.fn().mockResolvedValue(undefined),
    refreshAgentDetection: vi.fn().mockResolvedValue(null),
    refreshHostedRouteReadiness: vi.fn().mockResolvedValue(undefined),
  },
  mockAuthState: {
    hydrated: true,
    state: { status: 'signed-in' as const },
    startSignIn: vi.fn().mockResolvedValue(undefined),
  },
  mockDesktopAuthBridge: { available: true },
}));

vi.mock('../settings', () => ({
  DEFAULT_CLI_REASONING_EFFORTS: {
    'codex-sdk': 'high',
    'claude-agent-sdk': 'high',
    'grok-acp': 'high',
  },
  useAISettingsStore: vi.fn(() => mockAISettingsState),
}));

vi.mock('../../../stores/auth-store', () => ({
  useAuthStore: vi.fn(() => mockAuthState),
  hasDesktopAuthBridge: vi.fn(() => mockDesktopAuthBridge.available),
}));

vi.mock('./useAgentCliAuthFlow', () => ({
  useAgentCliAuthFlow: vi.fn(() => ({
    authenticatingTransport: null,
    authResult: null,
    authLog: {},
    runAgentAuth: vi.fn(),
  })),
}));

describe("useChatRouteControls — no-conversation usage (Home's call shape)", () => {
  beforeEach(() => {
    mockAISettingsState.provider = 'openai';
    mockAISettingsState.model = 'gpt-4o';
    mockAISettingsState.assistantRoute = null;
    mockAISettingsState.agentTransport = null;
    mockAISettingsState.agentDetection = null;
    mockAISettingsState.agentDetectError = null;
    mockAISettingsState.hostedRouteReadiness = 'ready';
    mockAISettingsState.providerStatuses.openai.isConfigured = true;
    mockAISettingsState.providerStatuses.anthropic.isConfigured = true;
    mockAISettingsState.providerModels.openai.models = ['gpt-4o'];
    mockAISettingsState.cliModelSettings = {
      'codex-sdk': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
      'claude-agent-sdk': {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        personality: null,
      },
      'grok-acp': { model: null, reasoningEffort: null, serviceTier: null, personality: null },
    };
    mockAISettingsState.setAssistantRoute.mockClear();
    mockAISettingsState.setModel.mockClear();
    mockAISettingsState.setCliModel.mockClear();
    mockAISettingsState.setCliReasoningEffort.mockClear();
    mockAISettingsState.setCliServiceTier.mockClear();
    mockAISettingsState.setCliPersonality.mockClear();
    mockAISettingsState.refreshHostedRouteReadiness.mockReset();
    mockAISettingsState.refreshHostedRouteReadiness.mockResolvedValue(undefined);
    mockAuthState.hydrated = true;
    mockAuthState.state = { status: 'signed-in' };
    mockAuthState.startSignIn.mockClear();
    mockDesktopAuthBridge.available = true;
  });

  afterEach(() => {
    useConfirmDialogStore.getState().resolveCurrent(false);
  });

  it('does not throw when called with no activeTurn/isLoading/isOpen (all defaults)', () => {
    const { result } = renderHook(() => useChatRouteControls({}));
    expect(result.current.activeAssistantRoute).toBeDefined();
  });

  it('flags a provider route needing configuration and renders the Add API key prompt', () => {
    mockAISettingsState.assistantRoute = { kind: 'provider', provider: 'openai', model: 'gpt-4o' };
    mockAISettingsState.providerStatuses.openai.isConfigured = false;
    const { result } = renderHook(() => useChatRouteControls({}));
    expect(result.current.activeDirectApiNeedsKey).toBe(true);
    expect(result.current.activeRouteNeedsConfiguration).toBe(true);
    render(<>{result.current.renderRouteConfigurationPrompt()}</>);
    expect(screen.getByTestId('chat-direct-api-key-warning')).toBeInTheDocument();
    mockAISettingsState.providerStatuses.openai.isConfigured = true;
    mockAISettingsState.assistantRoute = null;
  });

  it('uses a ready DNAForge agent immediately before CLI detection settles', () => {
    const { result } = renderHook(() => useChatRouteControls({}));

    expect(result.current.activeAssistantRoute).toEqual({ kind: 'hosted', tier: 'auto' });
    expect(result.current.activeRouteChecking).toBe(false);
    expect(result.current.activeRouteNeedsConfiguration).toBe(false);
    expect(result.current.activeRouteSendBlocked).toBe(false);
  });

  it('keeps desktop-only routes out of the hosted browser, including a stale CLI selection', () => {
    const previousRuntime = document.documentElement.dataset.dnaforgeRuntime;
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.hostedRouteReadiness = 'ready';

    try {
      function Harness() {
        const routeControls = useChatRouteControls({});
        return <>{routeControls.renderAssistantRouteSelector()}</>;
      }

      const { result } = renderHook(() => useChatRouteControls({}));
      expect(result.current.activeAssistantRoute).toEqual({ kind: 'hosted', tier: 'auto' });

      render(<Harness />);
      fireEvent.click(screen.getByTestId('model-selector-button'));
      const menu = screen.getByTestId('chat-assistant-route-menu');
      expect(menu).toHaveTextContent('Auto');
      expect(menu).toHaveTextContent('Deep');
      expect(menu.querySelector('[data-testid*="codex-cli"]')).not.toBeInTheDocument();
      expect(menu.querySelector('[data-testid*="claude-code"]')).not.toBeInTheDocument();
      expect(menu.querySelector('[data-testid*="grok-cli"]')).not.toBeInTheDocument();
      expect(menu.querySelector('[data-testid*="direct-api"]')).not.toBeInTheDocument();
    } finally {
      if (previousRuntime === undefined) {
        delete document.documentElement.dataset.dnaforgeRuntime;
      } else {
        document.documentElement.dataset.dnaforgeRuntime = previousRuntime;
      }
    }
  });

  it.each(['checking', 'gateway-unavailable'] as const)(
    'keeps Hosted choices discoverable in a browser while %s and blocks sending',
    (readiness) => {
      const previousRuntime = document.documentElement.dataset.dnaforgeRuntime;
      document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
      mockAISettingsState.hostedRouteReadiness = readiness;

      try {
        const { result } = renderHook(() => useChatRouteControls({}));
        expect(result.current.activeAssistantRoute).toEqual({ kind: 'hosted', tier: 'auto' });
        expect(result.current.activeRouteSendBlocked).toBe(true);

        render(
          <>
            {result.current.renderAssistantRouteSelector()}
            {result.current.renderRouteConfigurationPrompt()}
            {result.current.renderRouteCheckingStatus()}
          </>
        );
        fireEvent.click(screen.getByTestId('model-selector-button'));
        const menu = screen.getByTestId('chat-assistant-route-menu');
        expect(
          menu.querySelectorAll(
            '[data-testid^="chat-assistant-route-option-"]:not([data-testid$="-configure"])'
          )
        ).toHaveLength(2);
        expect(screen.queryByTestId('chat-route-unavailable-warning')).not.toBeInTheDocument();
        if (readiness === 'checking') {
          expect(screen.getByTestId('chat-route-checking-status')).toBeInTheDocument();
          expect(screen.queryByTestId('chat-hosted-unavailable-warning')).not.toBeInTheDocument();
        } else {
          expect(screen.getByTestId('chat-hosted-unavailable-warning')).toHaveTextContent(
            'Hosted gateway unreachable'
          );
          expect(screen.queryByTestId('chat-route-checking-status')).not.toBeInTheDocument();
          fireEvent.click(screen.getByTestId('chat-hosted-unavailable-warning'));
          expect(result.current.activeRouteSendBlocked).toBe(true);
        }
      } finally {
        if (previousRuntime === undefined) delete document.documentElement.dataset.dnaforgeRuntime;
        else document.documentElement.dataset.dnaforgeRuntime = previousRuntime;
      }
    }
  );

  it('keeps secondary browser AI configuration in the Hosted-only modal', () => {
    const previousRuntime = document.documentElement.dataset.dnaforgeRuntime;
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    mockAISettingsState.hostedRouteReadiness = 'gateway-unavailable';
    const desktopConfigure = vi.fn();
    const desktopSources = vi.fn();
    try {
      function Harness() {
        const controls = useChatRouteControls({
          onConfigureHost: desktopConfigure,
          onOpenAssistantSources: desktopSources,
        });
        return (
          <>
            {controls.renderAssistantRouteSelector()}
            {controls.renderConnectAiModal()}
          </>
        );
      }
      render(<Harness />);
      for (const entry of ['Configure Auto', 'AI settings...']) {
        fireEvent.click(screen.getByTestId('model-selector-button'));
        fireEvent.click(screen.getByRole('menuitem', { name: entry, exact: true }));
        expect(screen.getByTestId('connect-ai-hosted-section')).toBeInTheDocument();
        expect(screen.queryByTestId('connect-ai-cli-codex-sdk')).not.toBeInTheDocument();
        expect(screen.queryByTestId('connect-ai-provider-openai')).not.toBeInTheDocument();
        fireEvent.click(screen.getByTestId('connect-ai-close'));
      }
      expect(desktopConfigure).not.toHaveBeenCalled();
      expect(desktopSources).not.toHaveBeenCalled();
    } finally {
      if (previousRuntime === undefined) delete document.documentElement.dataset.dnaforgeRuntime;
      else document.documentElement.dataset.dnaforgeRuntime = previousRuntime;
    }
  });

  it('reports pending route discovery as checking, not as a missing API key', () => {
    mockAISettingsState.assistantRoute = null;
    mockAISettingsState.agentDetection = null;
    mockAISettingsState.hostedRouteReadiness = 'checking';
    const { result } = renderHook(() => useChatRouteControls({}));
    expect(result.current.activeRouteChecking).toBe(true);
    expect(result.current.activeDirectApiNeedsKey).toBe(false);
    expect(result.current.activeRouteNeedsConfiguration).toBe(false);
    expect(result.current.activeRouteSendBlocked).toBe(true);
  });

  it('falls back to Direct API configuration when initial CLI detection fails', () => {
    mockAISettingsState.assistantRoute = null;
    mockAISettingsState.agentDetection = null;
    mockAISettingsState.agentDetectError = 'detector unavailable';
    mockAISettingsState.hostedRouteReadiness = 'gateway-unavailable';
    mockAISettingsState.providerStatuses.anthropic.isConfigured = false;
    mockAISettingsState.providerStatuses.openai.isConfigured = false;

    const { result } = renderHook(() => useChatRouteControls({}));

    expect(result.current.activeRouteChecking).toBe(false);
    expect(result.current.activeDirectApiNeedsKey).toBe(true);
    expect(result.current.activeRouteNeedsConfiguration).toBe(true);
    expect(result.current.activeRouteSendBlocked).toBe(true);
    mockAISettingsState.providerStatuses.anthropic.isConfigured = true;
  });

  it('renders model controls for the active provider route', () => {
    mockAISettingsState.assistantRoute = { kind: 'provider', provider: 'openai', model: 'gpt-4o' };
    const { result } = renderHook(() => useChatRouteControls({}));
    render(<>{result.current.renderModelControls()}</>);
    expect(screen.getByTestId('chat-model-controls')).toBeInTheDocument();
  });

  it('keeps model and reasoning visible and moves secondary controls into a drill-down menu', () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.cliModelSettings['codex-sdk'] = {
      model: 'gpt-6-astra',
      reasoningEffort: 'ultra',
      serviceTier: null,
      personality: null,
    };
    mockAISettingsState.agentDetection = {
      codex: {
        cli: 'installed',
        path: '/usr/local/bin/codex',
        auth: 'authenticated',
        defaultModel: 'gpt-6-astra',
        authMode: 'chatgpt',
        authFilePresent: true,
        models: [
          {
            id: 'gpt-6-astra',
            displayName: 'GPT-6 Astra',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            defaultReasoningEffort: 'medium',
            serviceTiers: [{ id: 'priority', label: 'Fast' }],
            supportsPersonality: true,
            defaultServiceTier: null,
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
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: false,
        credentialsFilePresent: false,
        models: [],
      },
      grok: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        availableModels: [],
        models: [],
      },
    };

    const { result } = renderHook(() => useChatRouteControls({}));
    render(<>{result.current.renderModelControls()}</>);

    expect(screen.getByTestId('chat-cli-model-select')).toHaveTextContent('GPT-6 Astra');
    expect(screen.getByTestId('chat-cli-effort-select')).toHaveAttribute('data-value', 'ultra');
    expect(screen.queryByTestId('chat-cli-service-tier-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-cli-personality-select')).not.toBeInTheDocument();

    const more = screen.getByTestId('chat-cli-secondary-options');
    expect(more).toHaveAccessibleName('More Codex CLI model options');
    expect(more).toHaveClass('wp-menu-trigger');
    expect(more).toHaveAttribute('data-menu-density', 'compact');
    expect(more).toHaveAttribute('data-icon-only', 'true');
    expect(more.querySelector('.wp-menu-icon svg')).not.toBeNull();
    fireEvent.click(more);
    const speed = screen.getByTestId('chat-cli-secondary-options-speed');
    expect(speed).toHaveTextContent('Speed');
    expect(speed).toHaveTextContent('Standard (provider default)');
    expect(screen.getByTestId('chat-cli-secondary-options-style')).toHaveTextContent(
      'Provider default style'
    );
    fireEvent.keyDown(speed, { key: 'ArrowRight' });
    expect(screen.getByRole('menu', { name: 'More Codex CLI model options' })).toBeInTheDocument();
    expect(screen.getByTestId('chat-cli-secondary-options-speed')).toBeInTheDocument();
    expect(screen.getByTestId('chat-cli-secondary-options-style')).toBeInTheDocument();
    expect(screen.getByTestId('chat-cli-secondary-options-submenu')).toHaveAccessibleName(
      'Speed options'
    );
    expect(screen.queryByRole('menuitem', { name: /back/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-cli-secondary-options-style'));
    expect(screen.getByTestId('chat-cli-secondary-options-submenu')).toHaveAccessibleName(
      'Style options'
    );
    fireEvent.click(screen.getByTestId('chat-cli-personality-select-option-pragmatic'));
    expect(mockAISettingsState.setCliPersonality).toHaveBeenCalledWith('codex-sdk', 'pragmatic');

    fireEvent.click(more);
    fireEvent.click(screen.getByTestId('chat-cli-secondary-options-speed'));
    fireEvent.click(screen.getByTestId('chat-cli-service-tier-select-option-priority'));
    expect(mockAISettingsState.setCliServiceTier).toHaveBeenCalledWith('codex-sdk', 'priority');
  });

  it('does not erase a saved speed choice while model discovery is temporarily empty', async () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.cliModelSettings['codex-sdk'] = {
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      personality: 'pragmatic',
    };
    mockAISettingsState.agentDetection = {
      codex: {
        cli: 'installed',
        path: '/usr/local/bin/codex',
        auth: 'authenticated',
        defaultModel: 'gpt-6-astra',
        authMode: 'chatgpt',
        authFilePresent: true,
        models: [],
      },
      claudeCode: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: false,
        credentialsFilePresent: false,
        models: [],
      },
      grok: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        availableModels: [],
        models: [],
      },
    };

    renderHook(() => useChatRouteControls({}));

    await waitFor(() => expect(mockAISettingsState.refreshAgentDetection).toHaveBeenCalled());
    expect(mockAISettingsState.setCliServiceTier).not.toHaveBeenCalled();
    expect(mockAISettingsState.setCliPersonality).not.toHaveBeenCalled();
  });

  it('shows an explicit retry state instead of a one-option Claude picker when proof is absent', () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentDetection = {
      codex: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        authMode: null,
        authFilePresent: false,
        models: [],
      },
      claudeCode: {
        cli: 'installed',
        path: '/usr/local/bin/claude',
        auth: 'authenticated',
        defaultModel: 'sonnet',
        keychainEntryPresent: true,
        credentialsFilePresent: true,
        models: [],
      },
      grok: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        availableModels: [],
        models: [],
      },
    };

    const { result } = renderHook(() => useChatRouteControls({}));
    render(<>{result.current.renderModelControls()}</>);

    const retry = screen.getByTestId('chat-cli-model-discovery-error');
    expect(retry).toHaveTextContent('Models unavailable');
    expect(retry).toHaveAccessibleName('Retry Claude Code model discovery');
    expect(screen.queryByTestId('chat-cli-model-select')).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(mockAISettingsState.refreshAgentDetection).toHaveBeenCalled();
  });

  it('exposes Claude fast mode and runtime output styles in the same secondary menu', () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.cliModelSettings['claude-agent-sdk'] = {
      model: 'claude-opus-4-7',
      reasoningEffort: 'max',
      serviceTier: null,
      personality: null,
    };
    mockAISettingsState.agentDetection = {
      codex: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        authMode: null,
        authFilePresent: false,
        models: [],
      },
      claudeCode: {
        cli: 'installed',
        path: '/usr/local/bin/claude',
        auth: 'authenticated',
        defaultModel: 'claude-opus-4-7',
        keychainEntryPresent: true,
        credentialsFilePresent: true,
        models: [
          {
            id: 'claude-opus-4-7',
            displayName: 'Claude Opus 4.7',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            serviceTiers: [{ id: 'fast', label: 'Fast' }],
            styles: [
              { id: 'concise', label: 'Concise' },
              { id: 'explanatory', label: 'Explanatory' },
            ],
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
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        availableModels: [],
        models: [],
      },
    };

    const { result } = renderHook(() => useChatRouteControls({}));
    render(<>{result.current.renderModelControls()}</>);
    fireEvent.click(screen.getByTestId('chat-cli-secondary-options'));
    fireEvent.click(screen.getByTestId('chat-cli-secondary-options-speed'));
    fireEvent.click(screen.getByTestId('chat-cli-service-tier-select-option-fast'));
    expect(mockAISettingsState.setCliServiceTier).toHaveBeenCalledWith('claude-agent-sdk', 'fast');

    fireEvent.click(screen.getByTestId('chat-cli-secondary-options'));
    fireEvent.click(screen.getByTestId('chat-cli-secondary-options-style'));
    fireEvent.click(screen.getByTestId('chat-cli-personality-select-option-explanatory'));
    expect(mockAISettingsState.setCliPersonality).toHaveBeenCalledWith(
      'claude-agent-sdk',
      'explanatory'
    );
  });

  it('shows and changes the model on the registry-resolved Direct API route', () => {
    mockAISettingsState.hostedRouteReadiness = 'gateway-unavailable';
    mockAISettingsState.agentDetectError = 'detector unavailable';
    mockAISettingsState.provider = 'anthropic';
    mockAISettingsState.model = 'claude-sonnet-4-20250514';
    mockAISettingsState.providerStatuses.anthropic.isConfigured = false;
    mockAISettingsState.providerStatuses.openai.isConfigured = true;
    mockAISettingsState.providerModels.openai.models = ['gpt-4o', 'gpt-5.5'];

    const { result } = renderHook(() => useChatRouteControls({}));
    render(<>{result.current.renderModelControls()}</>);

    const modelPicker = screen.getByTestId('chat-model-version-select');
    expect(modelPicker).toHaveAttribute('data-value', 'gpt-4o');
    fireEvent.click(modelPicker);
    fireEvent.click(screen.getByTestId('chat-model-version-select-option-gpt-5.5'));

    expect(mockAISettingsState.setAssistantRoute).toHaveBeenCalledWith({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-5.5',
    });
    expect(mockAISettingsState.setModel).not.toHaveBeenCalled();
  });

  it('refreshes Hosted availability only after desktop auth hydration settles', async () => {
    mockAuthState.hydrated = false;
    mockAuthState.state = { status: 'signed-out' };
    mockAISettingsState.refreshHostedRouteReadiness.mockClear();

    const { rerender } = renderHook(() => useChatRouteControls({ isOpen: true }));
    expect(mockAISettingsState.refreshHostedRouteReadiness).not.toHaveBeenCalled();

    mockAuthState.hydrated = true;
    mockAuthState.state = { status: 'signed-in' };
    rerender();

    await waitFor(() => {
      expect(mockAISettingsState.refreshHostedRouteReadiness).toHaveBeenCalledTimes(1);
    });
  });

  it('re-polls Hosted availability when the composer becomes visible after auth has settled', async () => {
    mockAuthState.hydrated = true;
    mockAuthState.state = { status: 'signed-in' };
    mockAISettingsState.refreshHostedRouteReadiness.mockClear();

    const { rerender } = renderHook(({ isOpen }) => useChatRouteControls({ isOpen }), {
      initialProps: { isOpen: false },
    });
    await waitFor(() => {
      expect(mockAISettingsState.refreshHostedRouteReadiness).toHaveBeenCalled();
    });
    mockAISettingsState.refreshHostedRouteReadiness.mockClear();

    rerender({ isOpen: true });
    await waitFor(() => {
      expect(mockAISettingsState.refreshHostedRouteReadiness).toHaveBeenCalledTimes(1);
    });
  });

  it('re-polls Hosted availability before treating a signed-in picker as Sign in required', async () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.hostedRouteReadiness = 'needs-login';
    mockAISettingsState.setAssistantRoute.mockClear();
    mockAuthState.hydrated = true;
    mockAuthState.state = { status: 'signed-in' };
    mockAuthState.startSignIn.mockClear();
    mockAISettingsState.refreshHostedRouteReadiness.mockImplementation(async () => {
      mockAISettingsState.hostedRouteReadiness = 'ready';
      return 'ready';
    });

    function Harness() {
      const routeControls = useChatRouteControls({ isOpen: true });
      return (
        <>
          {routeControls.renderAssistantRouteSelector()}
          <ConfirmDialogHost />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('model-selector-button'));
    fireEvent.click(screen.getByTestId('chat-assistant-route-option-dnaforge-hosted-auto'));

    await waitFor(() => {
      expect(mockAISettingsState.refreshHostedRouteReadiness).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockAISettingsState.setAssistantRoute).toHaveBeenCalledWith({
        kind: 'hosted',
        tier: 'auto',
      });
    });
    expect(mockAuthState.startSignIn).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: 'Sign in to use Hosted AI' })
    ).not.toBeInTheDocument();
  });

  it('does not start sign-in for a signed-in account when Hosted stays unready after refresh', async () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.hostedRouteReadiness = 'needs-login';
    mockAISettingsState.setAssistantRoute.mockClear();
    mockAuthState.hydrated = true;
    mockAuthState.state = { status: 'signed-in' };
    mockAuthState.startSignIn.mockClear();
    mockAISettingsState.refreshHostedRouteReadiness.mockResolvedValue('gateway-unavailable');

    function Harness() {
      const routeControls = useChatRouteControls({ isOpen: true });
      return (
        <>
          {routeControls.renderAssistantRouteSelector()}
          <ConfirmDialogHost />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('model-selector-button'));
    fireEvent.click(screen.getByTestId('chat-assistant-route-option-dnaforge-hosted-auto'));

    await waitFor(() => {
      expect(mockAISettingsState.refreshHostedRouteReadiness).toHaveBeenCalled();
    });
    expect(mockAISettingsState.setAssistantRoute).not.toHaveBeenCalled();
    expect(mockAuthState.startSignIn).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: 'Sign in to use Hosted AI' })
    ).not.toBeInTheDocument();
  });

  it('resolves Hosted availability in a browser host with no desktop auth bridge', async () => {
    mockAuthState.hydrated = false;
    mockAuthState.state = { status: 'signed-out' };
    mockDesktopAuthBridge.available = false;
    mockAISettingsState.refreshHostedRouteReadiness.mockClear();

    renderHook(() => useChatRouteControls({ isOpen: true }));

    await waitFor(() => {
      expect(mockAISettingsState.refreshHostedRouteReadiness).toHaveBeenCalledTimes(1);
    });

    mockDesktopAuthBridge.available = true;
    mockAuthState.hydrated = true;
  });

  it('gives a known signed-out account priority over a cached Hosted outage', () => {
    mockAISettingsState.assistantRoute = { kind: 'hosted', tier: 'auto' };
    mockAISettingsState.hostedRouteReadiness = 'gateway-unavailable';
    mockAuthState.hydrated = true;
    mockAuthState.state = { status: 'signed-out' };

    const { result } = renderHook(() => useChatRouteControls({}));

    expect(result.current.activeHostedNeedsLogin).toBe(true);
    expect(result.current.activeHostedUnavailable).toBe(true);
    expect(result.current.activeRouteNeedsConfiguration).toBe(true);

    mockAISettingsState.assistantRoute = null;
    mockAISettingsState.hostedRouteReadiness = 'ready';
    mockAuthState.state = { status: 'signed-in' };
  });

  it('keeps Hosted sign-in actionable after the auth start request fails', () => {
    mockAISettingsState.assistantRoute = { kind: 'hosted', tier: 'auto' };
    mockAISettingsState.hostedRouteReadiness = 'gateway-unavailable';
    mockAuthState.hydrated = true;
    mockAuthState.state = {
      status: 'error',
      reason: 'start_failed',
      message: 'Could not start sign-in (HTTP 503). Try again.',
    };

    const { result } = renderHook(() => useChatRouteControls({}));

    expect(result.current.activeHostedNeedsLogin).toBe(true);
    render(<>{result.current.renderAssistantRouteSelector()}</>);
    fireEvent.click(screen.getByTestId('model-selector-button'));
    expect(
      screen.getByTestId('chat-assistant-route-option-dnaforge-hosted-auto')
    ).toHaveTextContent('Sign in required');

    mockAISettingsState.assistantRoute = null;
    mockAISettingsState.hostedRouteReadiness = 'ready';
    mockAuthState.state = { status: 'signed-in' };
  });

  it('opens the Hosted sign-in prompt and starts auth only after confirmation', async () => {
    mockAISettingsState.assistantRoute = null;
    mockAISettingsState.hostedRouteReadiness = 'gateway-unavailable';
    mockAISettingsState.setAssistantRoute.mockClear();
    mockAuthState.hydrated = true;
    mockAuthState.state = { status: 'signed-out' };
    mockAuthState.startSignIn.mockClear();

    function Harness() {
      const routeControls = useChatRouteControls({});
      return (
        <>
          {routeControls.renderAssistantRouteSelector()}
          <ConfirmDialogHost />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('model-selector-button'));
    fireEvent.click(screen.getByTestId('chat-assistant-route-option-dnaforge-hosted-auto'));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Sign in to use Hosted AI' })).toBeInTheDocument();
    });
    expect(
      screen.getByText('Hosted AI requires a DNAForge account. Sign in to continue.')
    ).toBeInTheDocument();
    expect(mockAISettingsState.setAssistantRoute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(mockAuthState.startSignIn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('model-selector-button'));
    fireEvent.click(screen.getByTestId('chat-assistant-route-option-dnaforge-hosted-auto'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(mockAuthState.startSignIn).toHaveBeenCalledTimes(1));
    expect(mockAISettingsState.setAssistantRoute).toHaveBeenCalledWith({
      kind: 'hosted',
      tier: 'auto',
    });

    mockAISettingsState.hostedRouteReadiness = 'ready';
    mockAuthState.state = { status: 'signed-in' };
  });

  it('records the clicked Hosted tier before sign-in opens, and keeps it if sign-in is declined', async () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.hostedRouteReadiness = 'needs-login';
    mockAISettingsState.setAssistantRoute.mockClear();
    mockAuthState.hydrated = true;
    mockAuthState.state = { status: 'signed-out' };
    mockAuthState.startSignIn.mockClear();
    mockAISettingsState.refreshHostedRouteReadiness.mockResolvedValue('needs-login');

    let recordedRoute = false;
    mockAISettingsState.setAssistantRoute.mockImplementation(async (selection: unknown) => {
      recordedRoute = true;
      expect(selection).toEqual({ kind: 'hosted', tier: 'deep' });
    });
    mockAuthState.startSignIn.mockImplementation(async () => {
      expect(recordedRoute).toBe(true);
    });

    function Harness() {
      const routeControls = useChatRouteControls({});
      return (
        <>
          {routeControls.renderAssistantRouteSelector()}
          <ConfirmDialogHost />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId('model-selector-button'));
    fireEvent.click(screen.getByTestId('chat-assistant-route-option-dnaforge-hosted-deep'));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Sign in to use Hosted AI' })).toBeInTheDocument();
    });
    expect(mockAISettingsState.setAssistantRoute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(mockAISettingsState.setAssistantRoute).not.toHaveBeenCalled();
    expect(mockAuthState.startSignIn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('model-selector-button'));
    fireEvent.click(screen.getByTestId('chat-assistant-route-option-dnaforge-hosted-deep'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(mockAuthState.startSignIn).toHaveBeenCalledTimes(1));
    expect(mockAISettingsState.setAssistantRoute).toHaveBeenCalledTimes(1);
    expect(mockAISettingsState.setAssistantRoute).toHaveBeenCalledWith({
      kind: 'hosted',
      tier: 'deep',
    });
  });

  it('opens the Connect-AI modal when the Add API key prompt is clicked, closes on request', () => {
    mockAISettingsState.assistantRoute = { kind: 'provider', provider: 'openai', model: 'gpt-4o' };
    mockAISettingsState.providerStatuses.openai.isConfigured = false;
    function Harness() {
      const routeControls = useChatRouteControls({});
      return (
        <>
          {routeControls.renderRouteConfigurationPrompt()}
          {routeControls.renderConnectAiModal()}
        </>
      );
    }

    render(<Harness />);
    expect(screen.queryByTestId('connect-ai-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-direct-api-key-warning'));
    expect(screen.getByTestId('connect-ai-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/close/i));
    expect(screen.queryByTestId('connect-ai-modal')).not.toBeInTheDocument();

    mockAISettingsState.providerStatuses.openai.isConfigured = true;
    mockAISettingsState.assistantRoute = null;
  });
});
