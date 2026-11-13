import { describe, expect, it } from 'vitest';
import {
  buildAssistantTurnRouteSnapshot,
  getActiveAssistantRoute,
  getAssistantRouteReadiness,
  isAssistantRouteConfigured,
  isAssistantRouteUnresolved,
  pickDefaultAssistantRoute,
  restoreRegisteredAssistantRoute,
  type AssistantRouteSelection,
  type AssistantRouteState,
} from './assistant-routes';
import {
  createDefaultAssistantHostDescriptors,
  type AssistantHostDescriptor,
} from './assistant-hosts';
import type { AgentSdkDetectionShape } from '../../platform';

type CodexDetection = AgentSdkDetectionShape['codex'];
type ClaudeDetection = AgentSdkDetectionShape['claudeCode'];

function codex(overrides: Partial<CodexDetection> = {}): CodexDetection {
  return {
    cli: 'installed',
    path: '/usr/local/bin/codex',
    auth: 'authenticated',
    defaultModel: 'gpt-5.5',
    authMode: 'chatgpt',
    authFilePresent: true,
    ...overrides,
  };
}

function claude(overrides: Partial<ClaudeDetection> = {}): ClaudeDetection {
  return {
    cli: 'installed',
    path: '/usr/local/bin/claude',
    auth: 'authenticated',
    defaultModel: 'claude-fable-5[1m]',
    keychainEntryPresent: true,
    credentialsFilePresent: null,
    ...overrides,
  };
}

function stateWith(detection: AgentSdkDetectionShape | null): AssistantRouteState {
  return {
    assistantRoute: null,
    hostedRouteReadiness: 'gateway-unavailable',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    agentTransport: null,
    agentDetection: detection,
    providerStatuses: {
      anthropic: { isConfigured: true },
      openai: { isConfigured: true },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    },
    providerModels: {
      anthropic: { models: ['claude-sonnet-4-6'] },
      openai: { models: ['gpt-4o'] },
      google: { models: [] },
      xai: { models: [] },
      deepseek: { models: [] },
    },
  };
}

function restoreExtensionRoute(
  kind: 'orchestrator' | 'team',
  id: string
): (candidate: unknown) => AssistantRouteSelection | null {
  return (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const value = candidate as Record<string, unknown>;
    if (value.kind !== kind || value.id !== id) return null;
    return kind === 'orchestrator' ? { kind: 'orchestrator', id } : { kind: 'team', id };
  };
}

describe('pickDefaultAssistantRoute — tiered first-run default', () => {
  it('prefers the native agent after sign-in even when other hosts are ready', () => {
    const state = {
      ...stateWith({ codex: codex(), claudeCode: claude() }),
      hostedRouteReadiness: 'ready' as const,
    };
    expect(pickDefaultAssistantRoute(state)).toEqual({ kind: 'hosted', tier: 'auto' });
    expect(isAssistantRouteUnresolved(state)).toBe(false);
  });
  it('preserves an explicitly selected host when the native agent becomes ready', () => {
    const state = {
      ...stateWith({ codex: codex(), claudeCode: claude() }),
      hostedRouteReadiness: 'ready' as const,
      assistantRoute: {
        kind: 'provider' as const,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    };
    expect(getActiveAssistantRoute(state)).toEqual(state.assistantRoute);
  });
  it('can identify a registered ready route while an earlier pending route keeps send unresolved', () => {
    const state = stateWith(null);

    expect(pickDefaultAssistantRoute(state)).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(isAssistantRouteUnresolved(state)).toBe(true);
  });

  it('tier 1: prefers a CLI that is installed AND authenticated', () => {
    const state = stateWith({
      codex: codex({ cli: 'missing', path: null, auth: 'unauthenticated' }),
      claudeCode: claude(),
    });

    expect(pickDefaultAssistantRoute(state)).toEqual({
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('tier 1 beats tier 2 even when the unauthenticated CLI is listed first', () => {
    const state = stateWith({
      codex: codex({ auth: 'unauthenticated', authFilePresent: false }),
      claudeCode: claude(),
    });

    expect(pickDefaultAssistantRoute(state)).toEqual({
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('a ready registered route beats an installed-but-unauthenticated route', () => {
    const state = stateWith({
      codex: codex({ auth: 'unauthenticated', authFilePresent: false }),
      claudeCode: claude({ cli: 'missing', path: null, auth: 'unauthenticated' }),
    });

    expect(pickDefaultAssistantRoute(state)).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('uses registry order when all usable routes require setup', () => {
    const state = stateWith({
      codex: codex({ auth: 'unauthenticated', authFilePresent: false }),
      claudeCode: claude({ cli: 'missing', path: null, auth: 'unauthenticated' }),
    });
    state.providerStatuses = Object.fromEntries(
      Object.keys(state.providerStatuses).map((provider) => [provider, { isConfigured: false }])
    ) as AssistantRouteState['providerStatuses'];

    expect(pickDefaultAssistantRoute(state)).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('selects the next ready registry entry when no CLI is installed', () => {
    const state = stateWith({
      codex: codex({ cli: 'missing', path: null, auth: 'unauthenticated' }),
      claudeCode: claude({ cli: 'missing', path: null, auth: 'unauthenticated' }),
    });

    expect(pickDefaultAssistantRoute(state)).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('uses a configured provider instead of the unconfigured provider projection', () => {
    const state = stateWith({
      codex: codex({ cli: 'missing', path: null, auth: 'unauthenticated' }),
      claudeCode: claude({ cli: 'missing', path: null, auth: 'unauthenticated' }),
    });
    state.providerStatuses = {
      anthropic: { isConfigured: false },
      openai: { isConfigured: true },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    };

    expect(pickDefaultAssistantRoute(state)).toEqual({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('is deterministic when two CLIs tie at the same tier', () => {
    const state = stateWith({ codex: codex(), claudeCode: claude() });

    expect(pickDefaultAssistantRoute(state)).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
    expect(pickDefaultAssistantRoute(state)).toEqual(pickDefaultAssistantRoute(state));
  });

  it('does not select a registered route until the registry supplies an executor', () => {
    const descriptor: AssistantHostDescriptor = {
      id: 'future-router',
      kind: 'router',
      label: 'Future router',
      detail: 'Synthetic registry route',
      description: 'Proves first-run selection does not require a named built-in host.',
      optionCategory: 'future',
      target: { kind: 'orchestrator', id: 'future-router' },
      createSelection: () => ({ kind: 'orchestrator', id: 'future-router' }),
      restoreSelection: restoreExtensionRoute('orchestrator', 'future-router'),
      capabilities: {
        modelSelection: 'none',
        supportsEffort: false,
        supportsPermissionMode: false,
        supportsToolCalls: true,
        supportsFileWrites: true,
      },
    };

    expect(pickDefaultAssistantRoute(stateWith(null), [descriptor])).toBeNull();
  });
});

describe('restoreRegisteredAssistantRoute — registry-owned validation', () => {
  const builtInDescriptors = createDefaultAssistantHostDescriptors(true);
  const descriptors: AssistantHostDescriptor[] = [
    {
      id: 'future-router',
      kind: 'router',
      label: 'Future router',
      detail: 'Synthetic registry route',
      description: 'Synthetic route for memory restoration.',
      optionCategory: 'future',
      target: { kind: 'orchestrator', id: 'future-router' },
      createSelection: () => ({ kind: 'orchestrator', id: 'future-router' }),
      restoreSelection: restoreExtensionRoute('orchestrator', 'future-router'),
      capabilities: {
        modelSelection: 'none',
        supportsEffort: false,
        supportsPermissionMode: false,
        supportsToolCalls: true,
        supportsFileWrites: true,
      },
    },
    {
      id: 'future-team',
      kind: 'team',
      label: 'Future team',
      detail: 'Synthetic registered team',
      description: 'Synthetic route for memory restoration.',
      optionCategory: 'future',
      target: { kind: 'team', id: 'future-team' },
      createSelection: () => ({ kind: 'team', id: 'future-team' }),
      restoreSelection: restoreExtensionRoute('team', 'future-team'),
      capabilities: {
        modelSelection: 'none',
        supportsEffort: false,
        supportsPermissionMode: false,
        supportsToolCalls: true,
        supportsFileWrites: true,
      },
    },
  ];

  it.each([
    { kind: 'orchestrator' as const, id: 'future-router' },
    { kind: 'team' as const, id: 'future-team' },
  ])('restores registered $kind selections without a product-host branch', (route) => {
    expect(restoreRegisteredAssistantRoute(route, descriptors)).toEqual(route);
  });

  it('rejects a well-formed route that is not present in the registry', () => {
    expect(
      restoreRegisteredAssistantRoute({ kind: 'orchestrator', id: 'retired-router' }, descriptors)
    ).toBeNull();
  });

  it.each([
    { kind: 'provider', provider: 'retired-provider', model: 'model-a' },
    { kind: 'provider', provider: 'anthropic', model: '   ' },
    { kind: 'cli', transport: 'retired-cli' },
    { kind: 'cli', transport: 'codex-sdk', permissionMode: 'unrestricted' },
    { kind: 'hosted', tier: 'retired-tier' },
  ])('rejects an invalid registered-route payload: $kind', (candidate) => {
    expect(restoreRegisteredAssistantRoute(candidate, builtInDescriptors)).toBeNull();
  });

  it.each([
    {
      candidate: { kind: 'provider', provider: 'anthropic', model: '  claude-sonnet-4-6  ' },
      expected: { kind: 'provider', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    },
    {
      candidate: { kind: 'cli', transport: 'codex-sdk' },
      expected: { kind: 'cli', transport: 'codex-sdk', permissionMode: 'native-cli' },
    },
    {
      candidate: { kind: 'hosted', tier: 'auto' },
      expected: { kind: 'hosted', tier: 'auto' },
    },
  ])('restores and normalizes a valid $candidate.kind route', ({ candidate, expected }) => {
    expect(restoreRegisteredAssistantRoute(candidate, builtInDescriptors)).toEqual(expected);
  });

  it('fails closed when a registered route has no executor yet', () => {
    expect(() =>
      buildAssistantTurnRouteSnapshot({ kind: 'orchestrator', id: 'future-router' }, descriptors)
    ).toThrow('does not have an executor');
  });

  it('treats a mismatched executor as unavailable at readiness and snapshot boundaries', () => {
    const baseDescriptor = descriptors[0];
    if (!baseDescriptor) throw new Error('expected a synthetic router descriptor');
    const mismatchedDescriptor: AssistantHostDescriptor = {
      ...baseDescriptor,
      executor: 'direct-api',
    };
    const route = { kind: 'orchestrator' as const, id: 'future-router' };
    const state = stateWith(null);

    expect(getAssistantRouteReadiness(route, state, [mismatchedDescriptor])).toBe('unavailable');
    expect(isAssistantRouteConfigured(route, state, [mismatchedDescriptor])).toBe(false);
    expect(() => buildAssistantTurnRouteSnapshot(route, [mismatchedDescriptor])).toThrow(
      'rejected route'
    );
  });
});

describe('getActiveAssistantRoute — precedence', () => {
  it('fails closed when no registered host owns the stored or legacy route', () => {
    const state: AssistantRouteState = {
      ...stateWith({ codex: codex(), claudeCode: claude() }),
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
      agentTransport: 'codex-sdk',
    };

    expect(getActiveAssistantRoute(state, true, [])).toBeNull();
    expect(isAssistantRouteUnresolved(state, [])).toBe(false);
  });

  it('a stored user choice outranks the computed default', () => {
    const state: AssistantRouteState = {
      ...stateWith({ codex: codex(), claudeCode: claude() }),
      assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
    };

    expect(getActiveAssistantRoute(state)).toEqual({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('the legacy stored transport outranks the computed default', () => {
    const state: AssistantRouteState = {
      ...stateWith({ codex: codex(), claudeCode: claude() }),
      agentTransport: 'claude-agent-sdk',
    };

    expect(getActiveAssistantRoute(state)).toEqual({
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('derives the computed default from the current registry state', () => {
    const state: AssistantRouteState = {
      ...stateWith({ codex: codex(), claudeCode: claude() }),
    };

    expect(getActiveAssistantRoute(state)).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('uses the next registered ready route when earlier routes remain pending', () => {
    expect(getActiveAssistantRoute(stateWith(null))).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });
});

describe('isAssistantRouteUnresolved — the pre-detection window', () => {
  it('is unresolved before detection reports, when nothing was ever chosen', () => {
    expect(isAssistantRouteUnresolved(stateWith(null))).toBe(true);
  });

  it('is resolved once detection reports', () => {
    expect(isAssistantRouteUnresolved(stateWith({ codex: codex(), claudeCode: claude() }))).toBe(
      false
    );
  });

  it('is resolved to the Direct API fallback when the first detection attempt fails', () => {
    expect(
      isAssistantRouteUnresolved({
        ...stateWith(null),
        agentDetectError: 'detector unavailable',
      })
    ).toBe(false);
  });

  it('is resolved when the user has an explicit stored route, detection or not', () => {
    expect(
      isAssistantRouteUnresolved({
        ...stateWith(null),
        assistantRoute: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
      })
    ).toBe(false);
  });

  it('is resolved when a legacy stored transport names the route', () => {
    expect(isAssistantRouteUnresolved({ ...stateWith(null), agentTransport: 'codex-sdk' })).toBe(
      false
    );
  });
});
