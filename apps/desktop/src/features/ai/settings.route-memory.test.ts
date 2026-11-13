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
      detect: vi.fn(),
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

vi.mock('./modelDiscovery', () => ({
  fetchProviderModels: vi.fn().mockResolvedValue({ models: [], error: null }),
}));

vi.mock('./hosted-gateway', () => ({
  getHostedRouteReadiness: vi.fn().mockResolvedValue('gateway-unavailable'),
}));

import { getSetting, setSetting } from '../../db';
import { getHostedRouteReadiness } from './hosted-gateway';
import { useAISettingsStore } from './settings';
import { getActiveAssistantRoute, type AssistantRouteSelection } from './assistant-routes';

const ROUTE_KEY = 'ai_assistant_route';

function detection(
  codexAuth: 'authenticated' | 'unauthenticated',
  claudeCli: 'installed' | 'missing'
) {
  return {
    codex: {
      cli: 'installed' as const,
      path: '/usr/local/bin/codex',
      auth: codexAuth,
      defaultModel: 'gpt-5.5',
      authMode: 'chatgpt' as const,
      authFilePresent: codexAuth === 'authenticated',
    },
    claudeCode: {
      cli: claudeCli,
      path: claudeCli === 'installed' ? '/usr/local/bin/claude' : null,
      auth: 'unauthenticated' as const,
      defaultModel: 'claude-fable-5[1m]',
      keychainEntryPresent: false,
      credentialsFilePresent: null,
    },
  };
}

function lastWrite(key: string): string | undefined {
  const calls = vi.mocked(setSetting).mock.calls.filter(([writtenKey]) => writtenKey === key);
  return calls.length > 0 ? (calls[calls.length - 1][1] as string) : undefined;
}

function lastRememberedSelection(): unknown {
  const raw = lastWrite(ROUTE_KEY);
  if (!raw) return undefined;
  return (JSON.parse(raw) as { version: number; selection: unknown }).selection;
}

describe('assistant route persistence ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(setSetting).mockResolvedValue(undefined);
    vi.mocked(getHostedRouteReadiness).mockResolvedValue('gateway-unavailable');
    mockPlatform.agentSdk.detect.mockResolvedValue(detection('authenticated', 'installed'));
    useAISettingsStore.setState({ assistantRoute: null });
  });

  it('persists a CLI route under the authoritative key', async () => {
    await act(async () => {
      await useAISettingsStore
        .getState()
        .setAssistantRoute({ kind: 'cli', transport: 'codex-sdk' });
    });

    expect(lastRememberedSelection()).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('does not replace an explicit CLI route when an API key is saved', async () => {
    await act(async () => {
      await useAISettingsStore
        .getState()
        .setAssistantRoute({ kind: 'cli', transport: 'codex-sdk' });
    });
    vi.mocked(setSetting).mockClear();

    await act(async () => {
      await useAISettingsStore.getState().setApiKey('anthropic', 'new-api-key');
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
    expect(setSetting).not.toHaveBeenCalledWith('ai_agent_transport', '');
    expect(setSetting).not.toHaveBeenCalledWith(ROUTE_KEY, expect.any(String));
  });

  it('rejects a selection that no current registry descriptor owns', async () => {
    await expect(
      useAISettingsStore
        .getState()
        .setAssistantRoute({ kind: 'orchestrator', id: 'retired-router' })
    ).rejects.toThrow('not registered');

    expect(useAISettingsStore.getState().assistantRoute).toBeNull();
    expect(setSetting).not.toHaveBeenCalledWith(ROUTE_KEY, expect.any(String));
  });

  it('leaves the route unset when the user has never chosen one', async () => {
    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toBeNull();
  });

  it('still honours a legacy stored transport when no route was written', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === 'ai_agent_transport' ? 'claude-agent-sdk' : null
    );

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('treats a legacy stored provider as an explicit Direct API choice', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === 'ai_provider') return 'openai';
      if (key === 'ai_model') return 'gpt-4o';
      return null;
    });

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('does not fabricate a provider route from an invalid legacy provider value', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === 'ai_provider' ? 'retired-provider' : null
    );

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toBeNull();
  });

  it('restores the versioned canonical route on the next launch', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === ROUTE_KEY
        ? JSON.stringify({
            version: 1,
            selection: {
              kind: 'cli',
              transport: 'codex-sdk',
              permissionMode: 'native-cli',
            },
          })
        : null
    );

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('restores the pre-envelope raw route through the same registry decoder', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === ROUTE_KEY
        ? JSON.stringify({ kind: 'cli', transport: 'codex-sdk', permissionMode: 'native-cli' })
        : null
    );

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('does not revive legacy mirrors when a canonical route is no longer registered', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === ROUTE_KEY) {
        return JSON.stringify({
          version: 1,
          selection: { kind: 'orchestrator', id: 'retired-router' },
        });
      }
      if (key === 'ai_agent_transport') return 'codex-sdk';
      if (key === 'ai_provider') return 'openai';
      if (key === 'ai_model') return 'gpt-4o';
      return null;
    });

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toBeNull();
  });

  it('never leaves the authoritative key behind a legacy mirror when two switches race', async () => {
    await act(async () => {
      const first = useAISettingsStore
        .getState()
        .setAssistantRoute({ kind: 'cli', transport: 'claude-agent-sdk' });
      const second = useAISettingsStore
        .getState()
        .setAssistantRoute({ kind: 'cli', transport: 'codex-sdk' });
      await Promise.all([first, second]);
    });

    const persistedRoute = lastRememberedSelection() as {
      kind: 'cli';
      transport: string;
      permissionMode: string;
    };
    const persistedTransport = lastWrite('ai_agent_transport');

    expect(persistedRoute.transport).toBe(persistedTransport);
    expect(useAISettingsStore.getState().assistantRoute).toEqual(persistedRoute);
  });

  it('serializes canonical writes so a slower superseded choice cannot finish last', async () => {
    const persisted = new Map<string, string>();
    let releaseFirstCanonical: (() => void) | null = null;
    let markFirstCanonicalStarted: (() => void) | null = null;
    const firstCanonicalStarted = new Promise<void>((resolve) => {
      markFirstCanonicalStarted = resolve;
    });
    const holdFirstCanonical = new Promise<void>((resolve) => {
      releaseFirstCanonical = resolve;
    });

    vi.mocked(setSetting).mockImplementation(async (key: string, value: string) => {
      if (key === ROUTE_KEY) {
        const selection = (JSON.parse(value) as { selection: AssistantRouteSelection }).selection;
        if (selection.kind === 'cli' && selection.transport === 'claude-agent-sdk') {
          markFirstCanonicalStarted?.();
          await holdFirstCanonical;
        }
      }
      persisted.set(key, value);
    });

    const first = useAISettingsStore
      .getState()
      .setAssistantRoute({ kind: 'cli', transport: 'claude-agent-sdk' });
    await firstCanonicalStarted;
    const second = useAISettingsStore
      .getState()
      .setAssistantRoute({ kind: 'cli', transport: 'codex-sdk' });
    releaseFirstCanonical?.();
    await Promise.all([first, second]);

    const canonical = JSON.parse(persisted.get(ROUTE_KEY) ?? '{}') as {
      selection?: AssistantRouteSelection;
    };
    expect(canonical.selection).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('keeps the authoritative key in step with the mirrors when switching to Direct API', async () => {
    await act(async () => {
      const first = useAISettingsStore
        .getState()
        .setAssistantRoute({ kind: 'cli', transport: 'codex-sdk' });
      const second = useAISettingsStore
        .getState()
        .setAssistantRoute({ kind: 'provider', provider: 'openai', model: 'gpt-4o' });
      await Promise.all([first, second]);
    });

    const persistedRoute = lastRememberedSelection() as AssistantRouteSelection;
    expect(persistedRoute).toEqual(useAISettingsStore.getState().assistantRoute);
    if (persistedRoute.kind === 'provider') {
      expect(lastWrite('ai_agent_transport')).toBe('');
      expect(lastWrite('ai_provider')).toBe(persistedRoute.provider);
    }
  });

  it('remembers a Hosted tier chosen before sign-in and restores it next launch', async () => {
    useAISettingsStore.setState({
      hostedRouteReadiness: 'needs-login',
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
      agentTransport: 'codex-sdk',
      isConfigured: true,
    });

    await act(async () => {
      await useAISettingsStore.getState().setAssistantRoute({ kind: 'hosted', tier: 'deep' });
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'hosted',
      tier: 'deep',
    });
    expect(useAISettingsStore.getState().agentTransport).toBeNull();
    expect(useAISettingsStore.getState().isConfigured).toBe(false);
    expect(lastRememberedSelection()).toEqual({ kind: 'hosted', tier: 'deep' });

    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === ROUTE_KEY) return lastWrite(ROUTE_KEY) ?? null;
      if (key === 'ai_agent_transport') return lastWrite('ai_agent_transport') ?? null;
      return null;
    });
    useAISettingsStore.setState({
      assistantRoute: null,
      agentTransport: 'codex-sdk',
      agentDetection: detection('authenticated', 'installed'),
    });

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'hosted',
      tier: 'deep',
    });
    expect(getActiveAssistantRoute(useAISettingsStore.getState())).toEqual({
      kind: 'hosted',
      tier: 'deep',
    });
  });
});

describe('first-run route default ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(setSetting).mockResolvedValue(undefined);
    useAISettingsStore.setState({ assistantRoute: null });
  });

  it('adopts an authenticated CLI once detection reports', async () => {
    mockPlatform.agentSdk.detect.mockResolvedValue(detection('authenticated', 'missing'));

    await act(async () => {
      await useAISettingsStore.getState().refreshAgentDetection();
    });

    expect(getActiveAssistantRoute(useAISettingsStore.getState())).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('prefers DNAForge agent sign-in when no host is authenticated', async () => {
    useAISettingsStore.setState({ hostedRouteReadiness: 'needs-login' });
    mockPlatform.agentSdk.detect.mockResolvedValue(detection('unauthenticated', 'missing'));

    await act(async () => {
      await useAISettingsStore.getState().refreshAgentDetection();
    });

    expect(getActiveAssistantRoute(useAISettingsStore.getState())).toEqual({
      kind: 'hosted',
      tier: 'auto',
    });
  });

  it('does not overwrite a route the user actually chose', async () => {
    useAISettingsStore.setState({
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
    });

    await act(async () => {
      await useAISettingsStore.getState().refreshAgentDetection();
    });

    expect(useAISettingsStore.getState().assistantRoute).toEqual({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('the whole store snapshot resolves to the default, so the send path agrees with the picker', async () => {
    mockPlatform.agentSdk.detect.mockResolvedValue(detection('authenticated', 'missing'));

    await act(async () => {
      await useAISettingsStore.getState().refreshAgentDetection();
    });

    expect(getActiveAssistantRoute(useAISettingsStore.getState())).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('lets the newest detection win when two overlap', async () => {
    let releaseSlow: (() => void) | null = null;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    mockPlatform.agentSdk.detect
      .mockImplementationOnce(async () => {
        await slow;
        return detection('unauthenticated', 'missing');
      })
      .mockImplementationOnce(async () => detection('authenticated', 'missing'));

    await act(async () => {
      const first = useAISettingsStore.getState().refreshAgentDetection();
      const second = useAISettingsStore.getState().refreshAgentDetection();
      await second;
      releaseSlow?.();
      await first;
    });

    expect(useAISettingsStore.getState().agentDetection?.codex.auth).toBe('authenticated');
  });

  it('lets the newest Hosted readiness probe win when two overlap', async () => {
    let releaseSlow: (() => void) | null = null;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    let probeCount = 0;
    vi.mocked(getHostedRouteReadiness).mockImplementation(async () => {
      probeCount += 1;
      if (probeCount === 1) {
        await slow;
        return 'ready';
      }
      return 'gateway-unavailable';
    });

    await act(async () => {
      const first = useAISettingsStore.getState().refreshHostedRouteReadiness();
      const second = useAISettingsStore.getState().refreshHostedRouteReadiness();
      await second;
      releaseSlow?.();
      await first;
    });

    expect(useAISettingsStore.getState().hostedRouteReadiness).toBe('gateway-unavailable');
  });

  it('never writes the computed default to storage', async () => {
    await act(async () => {
      await useAISettingsStore.getState().refreshAgentDetection();
    });

    expect(lastWrite(ROUTE_KEY)).toBeUndefined();
  });

  it('reads an empty stored route as "never chosen", even when legacy route keys remain', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === ROUTE_KEY) return '';
      if (key === 'ai_provider') return 'openai';
      if (key === 'ai_model') return 'gpt-4o';
      if (key === 'ai_agent_transport') return 'claude-agent-sdk';
      return null;
    });

    await act(async () => {
      await useAISettingsStore.getState().initialize();
    });

    expect(useAISettingsStore.getState().assistantRoute).toBeNull();
    expect(useAISettingsStore.getState().agentTransport).toBeNull();
  });
});
