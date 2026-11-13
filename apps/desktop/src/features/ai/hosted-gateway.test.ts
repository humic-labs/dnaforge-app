import type { ContributionPolicy } from '@waypoint/hosted-ai-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHostedRouteReadiness, getHostedContributionSettings } from './hosted-gateway';

const policy = {
  hosted_authorized: false,
} as ContributionPolicy;

function installBridge(result: unknown): ReturnType<typeof vi.fn> {
  const prepareContribution = vi.fn().mockResolvedValue(result);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { hostedAi: { prepareContribution } },
  });
  return prepareContribution;
}

describe('getHostedContributionSettings', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });
  it.each([undefined, 'joined', 'withdrawn'] as const)(
    'returns current policy for the explicit %s request',
    async (choice) => {
      const prepareContribution = installBridge({
        ok: true,
        started: false,
        policy,
        receipt: null,
      });
      await expect(getHostedContributionSettings(choice)).resolves.toEqual({ ok: true, policy });
      expect(prepareContribution).toHaveBeenCalledWith({
        surface: 'settings',
        ...(choice ? { choice } : {}),
      });
    }
  );
  it('keeps a gate failure visible to inline Settings', async () => {
    installBridge({ ok: false, code: 'signed_out', message: 'Sign in to use DNAForge AI.' });
    await expect(getHostedContributionSettings()).resolves.toEqual({
      ok: false,
      error: 'Sign in to use DNAForge AI.',
    });
  });
});

describe('getHostedRouteReadiness', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it.each([
    [{ ok: true, available: true, gatewayOrigin: 'https://gateway.example' }, 'ready'],
    [
      {
        ok: true,
        available: false,
        reason: 'sign_in_required',
        gatewayOrigin: 'https://gateway.example',
      },
      'needs-login',
    ],
    [
      {
        ok: true,
        available: false,
        reason: 'gateway_paused',
        gatewayOrigin: 'https://gateway.example',
      },
      'gateway-paused',
    ],
    [
      {
        ok: true,
        available: false,
        reason: 'account_not_enabled',
        gatewayOrigin: 'https://gateway.example',
      },
      'account-not-enabled',
    ],
    [
      {
        ok: true,
        available: false,
        reason: 'workflow_unavailable',
        gatewayOrigin: 'https://gateway.example',
      },
      'workflow-unavailable',
    ],
    [
      {
        ok: true,
        available: false,
        reason: 'provider_unavailable',
        gatewayOrigin: 'https://gateway.example',
      },
      'provider-unavailable',
    ],
    [
      {
        ok: true,
        available: false,
        reason: 'gateway_not_ready',
        gatewayOrigin: 'https://gateway.example',
      },
      'gateway-not-ready',
    ],
    [
      {
        ok: true,
        available: false,
        reason: 'browser_agent_unavailable',
        gatewayOrigin: 'https://gateway.example',
      },
      'browser-agent-unavailable',
    ],
    [
      {
        ok: false,
        code: 'signed_out',
        message: 'Sign in.',
        gatewayOrigin: 'https://gateway.example',
      },
      'needs-login',
    ],
    [
      { ok: false, code: 'not_configured', message: 'Missing.', gatewayOrigin: null },
      'not-configured',
    ],
    [
      {
        ok: false,
        code: 'gateway_unavailable',
        message: 'Offline.',
        gatewayOrigin: 'https://gateway.example',
      },
      'gateway-unavailable',
    ],
    [
      {
        ok: false,
        code: 'invalid_response',
        message: 'Invalid.',
        gatewayOrigin: 'https://gateway.example',
      },
      'invalid-response',
    ],
  ] as const)('maps %j to %s', async (result, expected) => {
    const getRouteAvailability = vi.fn().mockResolvedValue(result);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { hostedAi: { getRouteAvailability } },
    });

    await expect(getHostedRouteReadiness()).resolves.toBe(expected);
  });

  it('distinguishes a missing desktop bridge from a remote outage', async () => {
    await expect(getHostedRouteReadiness()).resolves.toBe('bridge-unavailable');
  });
});
