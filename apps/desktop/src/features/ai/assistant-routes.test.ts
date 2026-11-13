import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAssistantRouteOptions,
  getActiveAssistantRoute,
  getAssistantHostIdForRoute,
  getAssistantRouteDetail,
  getAssistantRouteReadiness,
  getCliAuthorityProfileId,
  getAssistantRouteLabel,
  isAssistantRouteConfigured,
  isAssistantRouteSendBlocked,
  buildAssistantTurnRouteSnapshot,
  type AssistantRouteState,
} from './assistant-routes';
import { getEffectiveHostedRouteReadiness, type AssistantHostDescriptor } from './assistant-hosts';
import { replaceCustomCliHarnessDefinitions } from './custom-cli-harnesses';

afterEach(() => replaceCustomCliHarnessDefinitions([]));

const baseState: AssistantRouteState = {
  assistantRoute: null,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  agentTransport: null,
  agentDetection: {
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
  },
  providerStatuses: {
    anthropic: { isConfigured: true },
    openai: { isConfigured: true },
    google: { isConfigured: false },
    xai: { isConfigured: false },
    deepseek: { isConfigured: false },
  },
  providerModels: {
    anthropic: { models: ['claude-sonnet-4-6'] },
    openai: { models: ['gpt-4o', 'gpt-4o-mini'] },
    google: { models: [] },
    xai: { models: [] },
    deepseek: { models: [] },
  },
};

it('advertises and snapshots a configured custom CLI harness as its own route', () => {
  replaceCustomCliHarnessDefinitions([
    {
      id: 'custom-cli-lab-codex',
      label: 'Lab Codex',
      transport: 'codex-sdk',
      executablePath: '/opt/lab/bin/codex',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      serviceTier: null,
      personality: null,
    },
  ]);
  const selection = {
    kind: 'cli' as const,
    transport: 'codex-sdk' as const,
    permissionMode: 'native-cli' as const,
    customHarnessId: 'custom-cli-lab-codex',
  };
  const state = { ...baseState, assistantRoute: selection };

  expect(buildAssistantRouteOptions(state)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'custom-cli-lab-codex',
        label: 'Lab Codex',
        selection,
        configured: true,
        active: true,
      }),
    ])
  );
  expect(buildAssistantTurnRouteSnapshot(selection)).toMatchObject({
    hostId: 'custom-cli-lab-codex',
    transport: 'codex-sdk',
    customHarnessId: 'custom-cli-lab-codex',
  });
});

describe('assistant routes', () => {
  it.each([null, { kind: 'cli' as const, transport: 'codex-sdk' as const }])(
    'keeps unavailable Hosted AI visible in the browser without restoring desktop selection %j',
    (assistantRoute) => {
      const previousRuntime = document.documentElement.dataset.dnaforgeRuntime;
      document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
      const state: AssistantRouteState = {
        ...baseState,
        assistantRoute,
        hostedRouteReadiness: 'gateway-unavailable',
      };
      try {
        const route = getActiveAssistantRoute(state);
        expect(route).toEqual({ kind: 'hosted', tier: 'auto' });
        expect(isAssistantRouteSendBlocked(state)).toBe(true);
        expect(isAssistantRouteConfigured(route!, state)).toBe(false);
        expect(buildAssistantRouteOptions(state)).toEqual([
          expect.objectContaining({ id: 'dnaforge-hosted-auto', active: true, configured: false }),
          expect.objectContaining({ id: 'dnaforge-hosted-deep', active: false, configured: false }),
        ]);
        expect(getActiveAssistantRoute(state, false)).toBeNull();
        expect(getActiveAssistantRoute(state, true, [])).toBeNull();
      } finally {
        if (previousRuntime === undefined) delete document.documentElement.dataset.dnaforgeRuntime;
        else document.documentElement.dataset.dnaforgeRuntime = previousRuntime;
      }
    }
  );

  it('derives host routes from configured CLI and API state', () => {
    const options = buildAssistantRouteOptions(baseState);

    expect(options.map((option) => option.id)).toEqual([
      'dnaforge-hosted-auto',
      'dnaforge-hosted-deep',
      'codex-cli',
      'claude-code',
      'grok-cli',
      'direct-api',
    ]);
    expect(options.find((option) => option.hostId === 'codex-cli')).toMatchObject({
      hostId: 'codex-cli',
      category: 'cli',
      label: 'Codex CLI',
      detail: 'gpt-5.5',
      sourceLabel: 'Local CLI login',
      settingLabel: 'gpt-5.5',
      configured: true,
      active: true,
    });
    expect(options.find((option) => option.hostId === 'claude-code')).toMatchObject({
      hostId: 'claude-code',
      category: 'cli',
      label: 'Claude Code',
      detail: 'claude-fable-5[1m]',
      sourceLabel: 'Local CLI login',
      settingLabel: 'claude-fable-5[1m]',
      configured: true,
      active: false,
    });
    expect(options.find((option) => option.hostId === 'direct-api')).toMatchObject({
      category: 'api',
      label: 'Direct API',
      detail: 'Anthropic / claude-sonnet-4-6',
      sourceLabel: 'Anthropic API',
      settingLabel: 'claude-sonnet-4-6',
      configured: true,
      active: false,
    });
  });

  it('keeps API providers and models behind a single Direct API host option', () => {
    const options = buildAssistantRouteOptions(baseState);

    expect(options.map((option) => option.id)).toContain('direct-api');
    expect(options.map((option) => option.id)).not.toContain('openai');
    expect(options.map((option) => option.id)).not.toContain('gpt-4o-mini');
    expect(options.filter((option) => option.category === 'api')).toHaveLength(1);
    expect(options.find((option) => option.id === 'direct-api')?.selection).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('always exposes distinct Auto and Deep Hosted routes, ready or not', () => {
    const notReady = buildAssistantRouteOptions(baseState);
    expect(notReady.filter((option) => option.category === 'hosted')).toEqual([
      expect.objectContaining({
        id: 'dnaforge-hosted-auto',
        selection: { kind: 'hosted', tier: 'auto' },
        configured: false,
      }),
      expect.objectContaining({
        id: 'dnaforge-hosted-deep',
        selection: { kind: 'hosted', tier: 'deep' },
        configured: false,
      }),
    ]);

    const options = buildAssistantRouteOptions({ ...baseState, hostedRouteReadiness: 'ready' });
    expect(options.filter((option) => option.category === 'hosted')).toEqual([
      expect.objectContaining({
        id: 'dnaforge-hosted-auto',
        selection: { kind: 'hosted', tier: 'auto' },
        configured: true,
        readiness: 'ready',
      }),
      expect.objectContaining({
        id: 'dnaforge-hosted-deep',
        selection: { kind: 'hosted', tier: 'deep' },
        configured: true,
        readiness: 'ready',
      }),
    ]);
  });

  it('asks a signed-out user to sign in without describing the gateway as unavailable', () => {
    const options = buildAssistantRouteOptions({
      ...baseState,
      hostedRouteReadiness: 'needs-login',
    });

    expect(options.filter((option) => option.category === 'hosted')).toEqual([
      expect.objectContaining({
        id: 'dnaforge-hosted-auto',
        readinessLabel: 'Sign in required',
        settingLabel: 'Sign in required',
      }),
      expect.objectContaining({
        id: 'dnaforge-hosted-deep',
        readinessLabel: 'Sign in required',
        settingLabel: 'Sign in required',
      }),
    ]);
  });

  it.each([
    ['not-configured', 'Not configured in this build'],
    ['gateway-paused', 'Hosted AI is paused'],
    ['account-not-enabled', 'Account not enabled'],
    ['workflow-unavailable', 'Hosted workflow unavailable'],
    ['provider-unavailable', 'AI provider unavailable'],
    ['gateway-not-ready', 'Hosted gateway not ready'],
    ['gateway-unavailable', 'Hosted gateway unreachable'],
    ['invalid-response', 'Invalid gateway response'],
    ['bridge-unavailable', 'Desktop bridge unavailable'],
  ] as const)('shows the exact Hosted readiness reason for %s', (readiness, label) => {
    const options = buildAssistantRouteOptions({
      ...baseState,
      hostedRouteReadiness: readiness,
    });

    expect(options.filter((option) => option.category === 'hosted')).toEqual([
      expect.objectContaining({ readinessLabel: label, settingLabel: label }),
      expect.objectContaining({ readinessLabel: label, settingLabel: label }),
    ]);
  });

  it('snapshots a Hosted tier without inventing a provider or model identity', () => {
    expect(buildAssistantTurnRouteSnapshot({ kind: 'hosted', tier: 'deep' })).toEqual({
      routeKind: 'hosted',
      hostId: 'dnaforge-hosted-deep',
      provider: null,
      model: null,
      transport: null,
      authorityProfileId: null,
      permissionMode: null,
      routeSnapshotJson: JSON.stringify({ kind: 'hosted', tier: 'deep' }),
    });
  });

  it('builds an immutable Direct API turn snapshot with queryable scalars and raw route JSON', () => {
    const snapshot = buildAssistantTurnRouteSnapshot({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(snapshot).toEqual({
      routeKind: 'provider',
      hostId: 'direct-api',
      provider: 'openai',
      model: 'gpt-4o-mini',
      transport: null,
      authorityProfileId: null,
      permissionMode: null,
      routeSnapshotJson: JSON.stringify({
        kind: 'provider',
        provider: 'openai',
        model: 'gpt-4o-mini',
      }),
    });
  });

  it('builds an immutable CLI turn snapshot with host and authority attribution', () => {
    const snapshot = buildAssistantTurnRouteSnapshot({
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    });

    expect(snapshot).toEqual({
      routeKind: 'cli',
      hostId: 'claude-code',
      provider: null,
      model: null,
      transport: 'claude-agent-sdk',
      authorityProfileId: 'claude-agent-sdk:native-workspace-write',
      permissionMode: 'native-cli',
      routeSnapshotJson: JSON.stringify({
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      }),
    });
  });

  it('represents an active CLI as the assistant route without dropping provider fallbacks', () => {
    const state: AssistantRouteState = {
      ...baseState,
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'app-supervised',
      },
      agentTransport: 'codex-sdk',
    };

    const active = getActiveAssistantRoute(state);
    const options = buildAssistantRouteOptions(state);

    expect(active).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'app-supervised',
    });
    expect(getAssistantRouteLabel(active)).toBe('Codex CLI');
    expect(getAssistantRouteDetail(active)).toBe('DNAForge-only tools');
    expect(options.map((option) => option.id)).toContain('codex-cli');
    expect(options.map((option) => option.id)).toContain('claude-code');
    expect(options.map((option) => option.id)).toContain('direct-api');
    expect(options.find((option) => option.id === 'codex-cli')).toMatchObject({
      category: 'cli',
      active: true,
    });
  });

  it('falls back from a stale persisted Hosted route when Hosted is disabled in the build', () => {
    expect(
      getActiveAssistantRoute(
        {
          ...baseState,
          assistantRoute: { kind: 'hosted', tier: 'deep' },
          agentTransport: 'codex-sdk',
        },
        false
      )
    ).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('refuses to snapshot a Hosted turn when Hosted is disabled in the build', () => {
    expect(() =>
      buildAssistantTurnRouteSnapshot({ kind: 'hosted', tier: 'auto' }, undefined, false)
    ).toThrow(/not available in this build/i);
  });

  it('uses the active provider route as the Direct API host when API mode is active', () => {
    const options = buildAssistantRouteOptions({
      ...baseState,
      provider: 'openai',
      model: 'gpt-4o',
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
    });

    expect(options.find((option) => option.category === 'api')).toMatchObject({
      id: 'direct-api',
      hostId: 'direct-api',
      label: 'Direct API',
      detail: 'OpenAI / gpt-4o',
      sourceLabel: 'OpenAI API',
      settingLabel: 'gpt-4o',
      configured: true,
      active: true,
    });
  });

  it('keeps Direct API visible but marked unconfigured when the selected provider has no key', () => {
    const options = buildAssistantRouteOptions({
      ...baseState,
      provider: 'google',
      model: 'gemini-3.5-flash',
      assistantRoute: { kind: 'provider', provider: 'google', model: 'gemini-3.5-flash' },
    });

    expect(options.find((option) => option.id === 'direct-api')).toMatchObject({
      id: 'direct-api',
      label: 'Direct API',
      detail: 'Needs API key',
      sourceLabel: 'Google API',
      settingLabel: 'Not configured',
      configured: false,
      active: true,
      selection: { kind: 'provider', provider: 'google', model: 'gemini-3.5-flash' },
    });
  });

  it('surfaces Direct API key validation failure without pretending the key is missing', () => {
    const route = { kind: 'provider' as const, provider: 'openai' as const, model: 'gpt-4o' };
    const state: AssistantRouteState = {
      ...baseState,
      provider: 'openai',
      model: 'gpt-4o',
      assistantRoute: route,
      providerStatuses: {
        ...baseState.providerStatuses,
        openai: { isConfigured: true },
      },
      providerModels: {
        ...baseState.providerModels,
        openai: {
          models: [],
          fetchStatus: 'error',
          fetchError: 'OpenAI API error: 401 Unauthorized',
        },
      },
    };

    const options = buildAssistantRouteOptions(state);

    expect(isAssistantRouteConfigured(route, state)).toBe(true);
    expect(getAssistantRouteReadiness(route, state)).toBe('key-error');
    expect(options.find((option) => option.id === 'direct-api')).toMatchObject({
      id: 'direct-api',
      label: 'Direct API',
      detail: 'Key check failed',
      settingLabel: 'Check failed',
      configured: true,
      readiness: 'key-error',
      readinessLabel: 'Check failed',
    });
  });

  it('keeps native CLI permission mode distinct from app-supervised routes', () => {
    const state: AssistantRouteState = {
      ...baseState,
      assistantRoute: {
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      },
      agentTransport: 'claude-agent-sdk',
    };

    const active = getActiveAssistantRoute(state);
    const options = buildAssistantRouteOptions(state);

    expect(getAssistantRouteDetail(active)).toBe('Local CLI tools');
    expect(options.find((option) => option.id === 'claude-code')).toMatchObject({
      id: 'claude-code',
      category: 'cli',
      active: true,
      detail: 'claude-fable-5[1m]',
      sourceLabel: 'Local CLI login',
      settingLabel: 'claude-fable-5[1m]',
      selection: {
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      },
    });
    expect(options.map((option) => option.id)).toContain('codex-cli');
    expect(
      getCliAuthorityProfileId({
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'native-cli',
      })
    ).toBe('claude-agent-sdk:native-workspace-write');
    expect(
      getCliAuthorityProfileId({
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      })
    ).toBe('codex-sdk:native-workspace-write-dev');
  });

  it('can add a future host through descriptors without picker-specific code', () => {
    const cursorHost = {
      id: 'cursor-composer',
      kind: 'editor-agent',
      label: 'Cursor Composer',
      detail: 'Editor agent host',
      description: 'Uses a configured editor assistant host.',
      optionCategory: 'future',
      target: { kind: 'orchestrator', id: 'cursor-composer' },
      createSelection: () => ({ kind: 'orchestrator', id: 'cursor-composer' }),
      restoreSelection: (candidate: unknown) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
        const value = candidate as Record<string, unknown>;
        return value.kind === 'orchestrator' && value.id === 'cursor-composer'
          ? { kind: 'orchestrator', id: 'cursor-composer' }
          : null;
      },
      capabilities: {
        modelSelection: 'dynamic',
        supportsEffort: false,
        supportsPermissionMode: false,
        supportsToolCalls: true,
        supportsFileWrites: true,
      },
    } satisfies AssistantHostDescriptor;

    const options = buildAssistantRouteOptions(baseState, [cursorHost]);

    expect(options).toEqual([
      {
        id: 'cursor-composer',
        hostId: 'cursor-composer',
        category: 'future',
        label: 'Cursor Composer',
        detail: 'Editor agent host',
        sourceLabel: 'Editor agent host',
        settingLabel: 'Uses a configured editor assistant host.',
        configured: false,
        active: false,
        readiness: 'unavailable',
        readinessLabel: 'Unavailable',
        selection: { kind: 'orchestrator', id: 'cursor-composer' },
      },
    ]);
  });

  it('marks installed but logged-out CLI hosts as needing login', () => {
    const options = buildAssistantRouteOptions({
      ...baseState,
      agentDetection: {
        ...baseState.agentDetection!,
        codex: {
          cli: 'installed',
          path: '/usr/local/bin/codex',
          auth: 'unauthenticated',
          defaultModel: 'gpt-5.5',
          authMode: null,
          authFilePresent: false,
        },
      },
    });

    expect(options.find((option) => option.id === 'codex-cli')).toMatchObject({
      configured: false,
      readiness: 'needs-login',
      readinessLabel: 'Needs login',
      detail: 'Needs login',
      settingLabel: 'Needs login',
    });
    expect(options.find((option) => option.id === 'claude-code')).toMatchObject({
      configured: true,
      readiness: 'ready',
      readinessLabel: null,
    });
  });

  it('blocks known-unready routes while preserving explicit CLI checking behavior', () => {
    const providerNeedsKey: AssistantRouteState = {
      ...baseState,
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
      providerStatuses: {
        ...baseState.providerStatuses!,
        openai: { isConfigured: false },
      },
    };
    const cliNeedsLogin: AssistantRouteState = {
      ...baseState,
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
      agentDetection: {
        ...baseState.agentDetection!,
        codex: {
          cli: 'installed',
          path: '/usr/local/bin/codex',
          auth: 'unauthenticated',
          defaultModel: 'gpt-5.5',
          authMode: null,
          authFilePresent: false,
        },
      },
    };
    const hostedNeedsLogin: AssistantRouteState = {
      ...baseState,
      assistantRoute: { kind: 'hosted', tier: 'auto' },
      hostedRouteReadiness: 'needs-login',
    };
    const explicitCliChecking: AssistantRouteState = {
      ...baseState,
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
      agentDetection: null,
      agentDetectError: null,
    };

    expect(isAssistantRouteSendBlocked(providerNeedsKey)).toBe(true);
    expect(isAssistantRouteSendBlocked(cliNeedsLogin)).toBe(true);
    expect(isAssistantRouteSendBlocked(hostedNeedsLogin)).toBe(true);
    expect(isAssistantRouteSendBlocked(explicitCliChecking)).toBe(false);
  });

  it('lets authoritative signed-out auth override stale Hosted readiness', () => {
    expect(getEffectiveHostedRouteReadiness('ready', true, 'signed-out')).toBe('needs-login');
    expect(getEffectiveHostedRouteReadiness('ready', false, 'signed-out')).toBe('ready');
    expect(getEffectiveHostedRouteReadiness('gateway-unavailable', true, 'signed-in')).toBe(
      'gateway-unavailable'
    );
  });

  it('uses per-CLI model settings as the selected host detail without changing the route kind', () => {
    const options = buildAssistantRouteOptions({
      ...baseState,
      assistantRoute: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
      cliModelSettings: {
        'codex-sdk': { model: 'gpt-5-codex', reasoningEffort: 'high' },
        'claude-agent-sdk': { model: null, reasoningEffort: null },
      },
    });

    expect(options.find((option) => option.id === 'codex-cli')).toMatchObject({
      active: true,
      detail: 'gpt-5-codex / high effort',
      settingLabel: 'gpt-5-codex / high effort',
      sourceLabel: 'Local CLI login',
      selection: {
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
      },
    });
    expect(options.find((option) => option.id === 'direct-api')).toMatchObject({
      label: 'Direct API',
      detail: 'Anthropic / claude-sonnet-4-6',
    });
  });

  it('marks missing CLI hosts as install-required instead of selectable', () => {
    const options = buildAssistantRouteOptions({
      ...baseState,
      agentDetection: {
        ...baseState.agentDetection!,
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

    expect(options.find((option) => option.id === 'claude-code')).toMatchObject({
      configured: false,
      readiness: 'missing',
      readinessLabel: 'Install CLI',
      detail: 'Install CLI',
      settingLabel: 'Install CLI',
    });
  });

  it('maps legacy persisted route selections back to host descriptors', () => {
    expect(
      getAssistantHostIdForRoute({ kind: 'provider', provider: 'openai', model: 'gpt-4o' })
    ).toBe('direct-api');
    expect(
      getAssistantHostIdForRoute({
        kind: 'cli',
        transport: 'claude-agent-sdk',
        permissionMode: 'app-supervised',
      })
    ).toBe('claude-code');
  });
});

it.each(['orchestrator', 'team'] as const)(
  'does not use the internal %s identity as connection wording',
  (kind) => {
    const id = 'b9a0e661-e33a-44c6-9cf2-8169ef026f3b';
    const detail = getAssistantRouteDetail({ kind, id });
    expect(detail).toBe('Assistant connection options.');
    expect(detail).not.toContain(id);
  }
);
