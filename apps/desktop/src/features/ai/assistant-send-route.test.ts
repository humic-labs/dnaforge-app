import { describe, expect, it } from 'vitest';
import {
  describeAssistantRouteFallback,
  describePendingAssistantRouteFallback,
  resolveAssistantSendRoute,
  type AssistantSendRouteResolution,
} from './assistant-send-route';
import type { AssistantRouteSelection, AssistantRouteState } from './assistant-routes';
import { createDefaultAssistantHostDescriptors } from './assistant-hosts';
import type { AgentSdkDetectionShape } from '../../platform';

type CodexDetection = AgentSdkDetectionShape['codex'];
type ClaudeDetection = AgentSdkDetectionShape['claudeCode'];

const CORE = createDefaultAssistantHostDescriptors(false);
const WITH_HOSTED = createDefaultAssistantHostDescriptors(true);

const CLAUDE_ROUTE: AssistantRouteSelection = {
  kind: 'cli',
  transport: 'claude-agent-sdk',
  permissionMode: 'native-cli',
};
const CODEX_ROUTE: AssistantRouteSelection = {
  kind: 'cli',
  transport: 'codex-sdk',
  permissionMode: 'native-cli',
};

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

function detection(
  codexDetection: CodexDetection,
  claudeDetection: ClaudeDetection
): AgentSdkDetectionShape {
  return {
    codex: codexDetection,
    claudeCode: claudeDetection,
    grok: { cli: 'missing', path: null, auth: 'unknown', defaultModel: null },
  } as AgentSdkDetectionShape;
}

function state(overrides: Partial<AssistantRouteState> = {}): AssistantRouteState {
  return {
    assistantRoute: null,
    hostedRouteReadiness: 'gateway-unavailable',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    agentTransport: null,
    agentDetection: detection(codex(), claude()),
    providerStatuses: {
      anthropic: { isConfigured: false },
      openai: { isConfigured: false },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    },
    providerModels: {
      anthropic: { models: [] },
      openai: { models: [] },
      google: { models: [] },
      xai: { models: [] },
      deepseek: { models: [] },
    },
    ...overrides,
  };
}

function fallback(
  resolution: AssistantSendRouteResolution
): Extract<AssistantSendRouteResolution, { status: 'fallback' }> {
  if (resolution.status !== 'fallback') {
    throw new Error(`expected fallback, got ${resolution.status}`);
  }
  return resolution;
}

describe('resolveAssistantSendRoute', () => {
  it('sends through the stored route whenever it is ready', () => {
    expect(resolveAssistantSendRoute(state({ assistantRoute: CLAUDE_ROUTE }), false, CORE)).toEqual(
      { status: 'selected', route: CLAUDE_ROUTE }
    );
  });

  it('falls back to the best READY route when the stored route is signed out', () => {
    const resolution = resolveAssistantSendRoute(
      state({
        assistantRoute: CLAUDE_ROUTE,
        agentDetection: detection(codex(), claude({ auth: 'unauthenticated' })),
      }),
      false,
      CORE
    );
    expect(resolution).toEqual({
      status: 'fallback',
      route: CODEX_ROUTE,
      preferred: CLAUDE_ROUTE,
      preferredReadiness: 'needs-login',
    });
  });

  it('falls back when the stored CLI is not installed', () => {
    const resolution = fallback(
      resolveAssistantSendRoute(
        state({
          assistantRoute: CODEX_ROUTE,
          agentDetection: detection(codex({ cli: 'missing', auth: 'unknown' }), claude()),
        }),
        false,
        CORE
      )
    );
    expect(resolution.route).toEqual(CLAUDE_ROUTE);
    expect(resolution.preferredReadiness).toBe('missing');
  });

  it('falls back from a Direct API route with no key, and keeps registry order', () => {
    const resolution = fallback(
      resolveAssistantSendRoute(
        state({
          assistantRoute: { kind: 'provider', provider: 'anthropic', model: 'claude-sonnet-4-6' },
        }),
        false,
        CORE
      )
    );
    expect(resolution.route).toEqual(CODEX_ROUTE);
    expect(resolution.preferredReadiness).toBe('needs-key');
  });

  it('never falls back to a route that itself needs setup', () => {
    expect(
      resolveAssistantSendRoute(
        state({
          assistantRoute: CLAUDE_ROUTE,
          agentDetection: detection(
            codex({ auth: 'unauthenticated' }),
            claude({ auth: 'unauthenticated' })
          ),
        }),
        false,
        CORE
      )
    ).toEqual({ status: 'blocked', preferred: CLAUDE_ROUTE });
  });

  it('keeps the existing behavior while the stored route is still being checked', () => {
    expect(
      resolveAssistantSendRoute(
        state({ assistantRoute: CLAUDE_ROUTE, agentDetection: null }),
        false,
        CORE
      )
    ).toEqual({ status: 'selected', route: CLAUDE_ROUTE });
  });

  it('does not fall back while a route ranked ahead of the ready ones is still checking', () => {
    const resolution = resolveAssistantSendRoute(
      state({
        assistantRoute: { kind: 'provider', provider: 'anthropic', model: 'claude-sonnet-4-6' },
        agentDetection: null,
      }),
      false,
      CORE
    );
    expect(resolution).toEqual({ status: 'unresolved' });
  });

  it('does not fall back from a Hosted route whose readiness is still being checked', () => {
    const hosted: AssistantRouteSelection = { kind: 'hosted', tier: 'auto' };
    expect(
      resolveAssistantSendRoute(
        state({ assistantRoute: hosted, hostedRouteReadiness: 'checking' }),
        true,
        WITH_HOSTED
      )
    ).toEqual({ status: 'blocked', preferred: hosted });
  });

  it('falls back from an unavailable Hosted route to a ready CLI', () => {
    const resolution = fallback(
      resolveAssistantSendRoute(
        state({
          assistantRoute: { kind: 'hosted', tier: 'auto' },
          hostedRouteReadiness: 'gateway-unavailable',
        }),
        true,
        WITH_HOSTED
      )
    );
    expect(resolution.route).toEqual(CODEX_ROUTE);
    expect(resolution.preferredReadiness).toBe('gateway-unavailable');
  });

  it('is still "unresolved" for a first-run profile whose routes are being checked', () => {
    expect(resolveAssistantSendRoute(state({ agentDetection: null }), false, CORE)).toEqual({
      status: 'unresolved',
    });
  });

  it('sends a never-chosen profile through the computed default without a fallback notice', () => {
    expect(
      resolveAssistantSendRoute(
        state({ agentDetection: detection(codex({ auth: 'unauthenticated' }), claude()) }),
        false,
        CORE
      )
    ).toEqual({ status: 'selected', route: CLAUDE_ROUTE });
  });
});

describe('fallback notice text', () => {
  it('names both routes and the provider the message went to', () => {
    const resolution = fallback(
      resolveAssistantSendRoute(
        state({
          assistantRoute: CLAUDE_ROUTE,
          agentDetection: detection(codex(), claude({ auth: 'unauthenticated' })),
        }),
        false,
        CORE
      )
    );
    expect(describeAssistantRouteFallback(resolution)).toBe(
      'Claude Code is signed out — sent with Codex CLI (OpenAI)'
    );
    expect(describePendingAssistantRouteFallback(resolution)).toBe(
      'Claude Code is signed out — will send with Codex CLI (OpenAI)'
    );
  });

  it('describes Direct API, Hosted, and missing-CLI reasons in plain words', () => {
    expect(
      describeAssistantRouteFallback({
        status: 'fallback',
        preferred: { kind: 'provider', provider: 'anthropic', model: 'claude-sonnet-4-6' },
        preferredReadiness: 'needs-key',
        route: CLAUDE_ROUTE,
      })
    ).toBe('Anthropic API has no API key — sent with Claude Code (Anthropic)');
    expect(
      describeAssistantRouteFallback({
        status: 'fallback',
        preferred: { kind: 'hosted', tier: 'auto' },
        preferredReadiness: 'gateway-unavailable',
        route: { kind: 'provider', provider: 'openai', model: 'gpt-5.5' },
      })
    ).toBe(
      'DNAForge AI is unavailable (hosted gateway unreachable) — sent with OpenAI API (gpt-5.5)'
    );
    expect(
      describeAssistantRouteFallback({
        status: 'fallback',
        preferred: CODEX_ROUTE,
        preferredReadiness: 'missing',
        route: { kind: 'hosted', tier: 'deep' },
      })
    ).toBe('Codex CLI is not installed — sent with DNAForge AI (Deep)');
  });
});
