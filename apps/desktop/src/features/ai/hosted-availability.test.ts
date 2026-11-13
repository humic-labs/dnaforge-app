import { describe, expect, it } from 'vitest';

import {
  HOSTED_ASSISTANT_ROUTE_KIND,
  isHostedAssistantRouteAvailable,
  isHostedRouteBlockedBySignIn,
  isHostedRouteOptionReady,
  selectHostedAssistantRouteOptions,
} from './hosted-availability';

function option(kind: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `${kind}-host`,
    hostId: `${kind}-host`,
    selection: { kind },
    category: 'api',
    label: kind,
    detail: '',
    sourceLabel: '',
    settingLabel: '',
    configured: true,
    active: false,
    readiness: 'ready',
    readinessLabel: null,
    ...over,
  };
}

describe('hosted assistant-route availability', () => {
  it('reports UNAVAILABLE for the route set that ships on dev today', () => {
    const devRoutes = [option('provider'), option('cli'), option('orchestrator'), option('team')];

    expect(isHostedAssistantRouteAvailable(devRoutes)).toBe(false);
    expect(selectHostedAssistantRouteOptions(devRoutes)).toEqual([]);
  });

  it('reports AVAILABLE as soon as the registry exposes a hosted route  landing)', () => {
    const withHosted = [
      option('provider'),
      option(HOSTED_ASSISTANT_ROUTE_KIND, { id: 'hosted-auto', label: 'Auto' }),
      option('cli'),
    ];

    expect(isHostedAssistantRouteAvailable(withHosted)).toBe(true);
  });

  it('returns EVERY hosted route, in registry order, with the selection intact', () => {
    const auto = option(HOSTED_ASSISTANT_ROUTE_KIND, {
      id: 'hosted-auto',
      label: 'Auto',
      selection: { kind: HOSTED_ASSISTANT_ROUTE_KIND, tier: 'auto' },
    });
    const deep = option(HOSTED_ASSISTANT_ROUTE_KIND, {
      id: 'hosted-deep',
      label: 'Deep',
      selection: { kind: HOSTED_ASSISTANT_ROUTE_KIND, tier: 'deep' },
    });

    const hosted = selectHostedAssistantRouteOptions([
      option('provider'),
      auto,
      deep,
      option('cli'),
    ]);

    expect(hosted.map((o) => o.id)).toEqual(['hosted-auto', 'hosted-deep']);
    expect(hosted[0]?.selection).toBe(auto.selection);
    expect(hosted[1]?.selection).toBe(deep.selection);
  });

  it('does not mistake a provider route whose id merely contains "hosted"', () => {
    const decoys = [
      option('provider', { id: 'hosted-looking-provider', label: 'DNAForge Hosted (not really)' }),
      option('cli', { id: 'self-hosted-cli' }),
    ];

    expect(isHostedAssistantRouteAvailable(decoys)).toBe(false);
  });

  it('treats an empty registry as unavailable rather than throwing', () => {
    expect(isHostedAssistantRouteAvailable([])).toBe(false);
    expect(selectHostedAssistantRouteOptions([])).toEqual([]);
  });

  describe('readiness', () => {
    it('is ready only for the exact ready state', () => {
      expect(isHostedRouteOptionReady(option(HOSTED_ASSISTANT_ROUTE_KIND))).toBe(true);
    });

    it.each([
      'needs-login',
      'gateway-unavailable',
      'checking',
      'needs-key',
      'key-error',
      'missing',
    ])('is NOT ready for readiness=%s', (readiness) => {
      expect(isHostedRouteOptionReady(option(HOSTED_ASSISTANT_ROUTE_KIND, { readiness }))).toBe(
        false
      );
    });

    it.each([
      ['needs-login', true],
      ['allowance-exhausted', false],
      ['needs-acceptance', false],
      ['gateway-unavailable', false],
      ['checking', false],
      ['ready', false],
    ] as const)('sign-in is the fix for readiness=%s → %s', (readiness, expected) => {
      expect(isHostedRouteBlockedBySignIn(option(HOSTED_ASSISTANT_ROUTE_KIND, { readiness }))).toBe(
        expected
      );
    });

    it('is NOT ready for an unknown future readiness value (fails closed)', () => {
      expect(
        isHostedRouteOptionReady(
          option(HOSTED_ASSISTANT_ROUTE_KIND, { readiness: 'quota-exhausted' })
        )
      ).toBe(false);
    });
  });
});
