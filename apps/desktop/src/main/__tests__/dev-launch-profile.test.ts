import { describe, expect, it } from 'vitest';
import { PACKAGED_AUTH_RELEASE_A_ORIGIN } from '../../shared/hosted-ai-build-policy';

const {
  HOSTED_STAGING_PROFILE,
  applyDevLaunchTarget,
  parseDevLaunchTarget,
  validateHostedStagingReadiness,
} = require('../../../scripts/dev-launch-profile.cjs') as {
  HOSTED_STAGING_PROFILE: {
    name: string;
    webBaseUrl: string;
    gatewayOrigin: string;
  };
  applyDevLaunchTarget: (
    env: NodeJS.ProcessEnv,
    target: { name: string; webBaseUrl: string; gatewayOrigin: string } | null
  ) => NodeJS.ProcessEnv;
  parseDevLaunchTarget: (
    args: readonly string[]
  ) => { name: string; webBaseUrl: string; gatewayOrigin: string } | null;
  validateHostedStagingReadiness: (
    payload: unknown,
    expectedCampaign: {
      maxProviderStarts: number;
      reservationCeilingMicrousd: number;
    }
  ) => {
    deployedGitSha: string;
    campaignId: string;
    catalogVersion: string;
  };
};

const humanCampaign = {
  maxProviderStarts: 64,
  reservationCeilingMicrousd: 10_000_000,
};

function readyPayload(): Record<string, unknown> {
  return {
    status: 'ready',
    environment: 'staging',
    runtimeEnvironment: 'staging',
    mode: 'canary',
    trafficEnabled: true,
    qualificationTrafficEnabled: false,
    catalogVersion: 'staging-catalog-v1',
    deployedGitSha: 'a'.repeat(40),
    canary: {
      campaignId: `fixture-human64-${'a'.repeat(40)}`,
      maxProviderStarts: 64,
      reservationCeilingMicrousd: 10_000_000,
      maxProviderStreamAttempts: 1,
    },
    checks: {
      configuration: true,
      database: true,
      provider: true,
      launchState: 'active',
      maintenance: {
        ready: true,
        recovery: true,
        retention: true,
        deletion: true,
      },
    },
    reason: null,
  };
}

describe('Hosted development launch profile', () => {
  it('selects one immutable staging authority pair', () => {
    expect(parseDevLaunchTarget(['--target=hosted-staging'])).toBe(HOSTED_STAGING_PROFILE);
    expect(HOSTED_STAGING_PROFILE).toEqual({
      name: 'hosted-staging',
      webBaseUrl: 'https://staging.dnaforge.com',
      gatewayOrigin: 'https://hosted-ai-gateway-staging.up.railway.app',
    });
    expect(Object.isFrozen(HOSTED_STAGING_PROFILE)).toBe(true);
  });

  it('keeps ordinary development profile-free', () => {
    expect(parseDevLaunchTarget([])).toBeNull();
  });

  it('pairs ordinary development with the real account service and Hosted gateway', () => {
    expect(applyDevLaunchTarget({ DESKTOP_DEV_PORT: '1606' }, null)).toMatchObject({
      DESKTOP_DEV_PORT: '1606',
      WAYPOINT_WEB_BASE_URL: PACKAGED_AUTH_RELEASE_A_ORIGIN,
      DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://hosted-ai.dnaforge.com',
    });
  });

  it.each(['https://dnaforge.com/', 'https://www.dnaforge.com'])(
    'pairs an explicit real-account origin %s with its Hosted gateway',
    (origin) => {
      expect(applyDevLaunchTarget({ WAYPOINT_WEB_BASE_URL: origin }, null)).toMatchObject({
        WAYPOINT_WEB_BASE_URL: origin,
        DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://hosted-ai.dnaforge.com',
      });
    }
  );

  it.each([
    { WAYPOINT_WEB_BASE_URL: 'http://localhost:3108' },
    { WAYPOINT_WEB_BASE_URL: 'https://staging.dnaforge.com' },
    { WAYPOINT_WEB_BASE_URL: 'https://dnaforge.com/accounts' },
    { WAYPOINT_WEB_BASE_URL: 'invalid' },
    { WAYPOINT_TEST: '1' },
    { NODE_ENV: 'test' },
    { DNAFORGE_RELEASE_B_HOSTED: 'sealed-release-authority' },
    { DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://gateway.example.test' },
  ])('preserves explicit authority and isolated test launches: %j', (env) => {
    expect(applyDevLaunchTarget(env, null)).toEqual(env);
  });

  it('rejects unknown, repeated, and fake local targets', () => {
    expect(() => parseDevLaunchTarget(['--target=production'])).toThrow(
      /unknown development launch target/i
    );
    expect(() =>
      parseDevLaunchTarget(['--target=hosted-staging', '--target=hosted-staging'])
    ).toThrow(/exactly one development launch target/i);
    expect(() => parseDevLaunchTarget(['--target=hosted-local'])).toThrow(
      /local Hosted gateway is not implemented/i
    );
  });

  it('applies the staging authorities after worktree identity values', () => {
    const result = applyDevLaunchTarget(
      {
        DESKTOP_DEV_PORT: '1426',
        API_PORT: '8006',
        WAYPOINT_WEB_BASE_URL: 'http://localhost:3105',
        DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://wrong.example.test',
      },
      HOSTED_STAGING_PROFILE
    );

    expect(result).toMatchObject({
      DESKTOP_DEV_PORT: '1426',
      API_PORT: '8006',
      WAYPOINT_WEB_BASE_URL: 'https://staging.dnaforge.com',
      DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://hosted-ai-gateway-staging.up.railway.app',
      DNAFORGE_DEV_TARGET: 'hosted-staging',
      VITE_DNAFORGE_DEV_TARGET: 'hosted-staging',
    });
  });

  it('accepts only an active healthy bounded staging human campaign', () => {
    expect(validateHostedStagingReadiness(readyPayload(), humanCampaign)).toEqual({
      deployedGitSha: 'a'.repeat(40),
      campaignId: `fixture-human64-${'a'.repeat(40)}`,
      catalogVersion: 'staging-catalog-v1',
    });
  });

  it.each([
    ['wrong environment', { environment: 'production' }],
    ['wrong runtime environment', { runtimeEnvironment: 'production' }],
    ['not ready', { status: 'not_ready' }],
    ['wrong mode', { mode: 'qualification' }],
    ['traffic disabled', { trafficEnabled: false }],
    ['qualification traffic enabled', { qualificationTrafficEnabled: true }],
    ['missing catalog', { catalogVersion: '' }],
    ['invalid SHA', { deployedGitSha: 'short' }],
  ])('rejects %s', (_label, replacement) => {
    expect(() =>
      validateHostedStagingReadiness({ ...readyPayload(), ...replacement }, humanCampaign)
    ).toThrow(/Hosted staging readiness rejected/i);
  });

  it.each([
    ['configuration', false],
    ['database', false],
    ['provider', false],
    ['launchState', 'paused'],
  ])('rejects an unhealthy %s check', (name, value) => {
    const payload = readyPayload();
    payload.checks = { ...(payload.checks as Record<string, unknown>), [name]: value };
    expect(() => validateHostedStagingReadiness(payload, humanCampaign)).toThrow(
      /Hosted staging readiness rejected/i
    );
  });

  it.each(['ready', 'recovery', 'retention', 'deletion'])(
    'rejects an unhealthy maintenance %s check',
    (name) => {
      const payload = readyPayload();
      const checks = payload.checks as Record<string, unknown>;
      checks.maintenance = {
        ...(checks.maintenance as Record<string, unknown>),
        [name]: false,
      };
      expect(() => validateHostedStagingReadiness(payload, humanCampaign)).toThrow(
        /Hosted staging readiness rejected/i
      );
    }
  );

  it('rejects campaign identity, start, spend, and retry drift', () => {
    for (const replacement of [
      { campaignId: '' },
      { maxProviderStarts: 6 },
      { reservationCeilingMicrousd: 1_000_000 },
      { maxProviderStreamAttempts: 2 },
    ]) {
      const payload = readyPayload();
      payload.canary = { ...(payload.canary as Record<string, unknown>), ...replacement };
      expect(() => validateHostedStagingReadiness(payload, humanCampaign)).toThrow(
        /Hosted staging readiness rejected/i
      );
    }
  });
});
