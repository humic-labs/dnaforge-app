const fs = require('node:fs');
const path = require('node:path');

const HOSTED_STAGING_PROFILE = Object.freeze({
  name: 'hosted-staging',
  webBaseUrl: 'https://staging.dnaforge.com',
  gatewayOrigin: 'https://hosted-ai-gateway-staging.up.railway.app',
});

const REAL_ACCOUNT_SERVICES = Object.freeze({
  webBaseUrl: 'https://dnaforge.com',
  gatewayOrigin: 'https://hosted-ai.dnaforge.com',
});

const TARGET_PREFIX = '--target=';
const SHA_40 = /^[0-9a-f]{40}$/u;

function parseDevLaunchTarget(args) {
  const requested = args.filter((argument) => argument.startsWith(TARGET_PREFIX));
  if (requested.length === 0) return null;
  if (requested.length !== 1) {
    throw new Error('Specify exactly one development launch target.');
  }

  const name = requested[0].slice(TARGET_PREFIX.length);
  if (name === HOSTED_STAGING_PROFILE.name) return HOSTED_STAGING_PROFILE;
  if (name === 'hosted-local') {
    throw new Error(
      'A local Hosted gateway is not implemented. The gateway accepts only staging or production authority.'
    );
  }
  throw new Error(`Unknown development launch target: ${name || '(empty)'}.`);
}

function applyDevLaunchTarget(env, target) {
  if (target === null) {
    if (
      env.WAYPOINT_TEST === '1' ||
      env.NODE_ENV === 'test' ||
      env.DNAFORGE_RELEASE_B_HOSTED?.trim() ||
      env.DNAFORGE_HOSTED_AI_GATEWAY_URL?.trim()
    ) {
      return { ...env };
    }
    const authOverride = env.WAYPOINT_WEB_BASE_URL?.trim();
    if (authOverride) {
      let authUrl;
      try {
        authUrl = new URL(authOverride);
      } catch {
        return { ...env };
      }
      if (
        authUrl.protocol !== 'https:' ||
        !['dnaforge.com', 'www.dnaforge.com'].includes(authUrl.hostname) ||
        authUrl.port ||
        authUrl.username ||
        authUrl.password ||
        authUrl.pathname !== '/' ||
        authUrl.search ||
        authUrl.hash
      ) {
        return { ...env };
      }
    }
    return {
      ...env,
      WAYPOINT_WEB_BASE_URL: authOverride || REAL_ACCOUNT_SERVICES.webBaseUrl,
      DNAFORGE_HOSTED_AI_GATEWAY_URL: REAL_ACCOUNT_SERVICES.gatewayOrigin,
    };
  }
  if (target !== HOSTED_STAGING_PROFILE) {
    throw new Error('Refusing an unrecognized development launch profile.');
  }
  return {
    ...env,
    WAYPOINT_WEB_BASE_URL: target.webBaseUrl,
    DNAFORGE_HOSTED_AI_GATEWAY_URL: target.gatewayOrigin,
    DNAFORGE_DEV_TARGET: target.name,
    VITE_DNAFORGE_DEV_TARGET: target.name,
  };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectReadiness(reason) {
  throw new Error(`Hosted staging readiness rejected: ${reason}.`);
}

function validateHostedStagingReadiness(payload, expectedCampaign) {
  if (!isRecord(payload)) rejectReadiness('response is not an object');
  if (payload.status !== 'ready') rejectReadiness('status is not ready');
  if (payload.environment !== 'staging') rejectReadiness('authority environment is not staging');
  if (payload.runtimeEnvironment !== 'staging') {
    rejectReadiness('runtime environment is not staging');
  }
  if (payload.mode !== 'canary') rejectReadiness('gateway is not in canary mode');
  if (payload.trafficEnabled !== true) rejectReadiness('human traffic is disabled');
  if (payload.qualificationTrafficEnabled !== false) {
    rejectReadiness('qualification traffic is not disabled');
  }
  if (typeof payload.catalogVersion !== 'string' || payload.catalogVersion.length === 0) {
    rejectReadiness('catalog version is missing');
  }
  if (typeof payload.deployedGitSha !== 'string' || !SHA_40.test(payload.deployedGitSha)) {
    rejectReadiness('deployed Git SHA is invalid');
  }

  if (!isRecord(payload.checks)) rejectReadiness('checks are missing');
  if (payload.checks.configuration !== true) rejectReadiness('configuration check failed');
  if (payload.checks.database !== true) rejectReadiness('database check failed');
  if (payload.checks.provider !== true) rejectReadiness('provider check failed');
  if (payload.checks.launchState !== 'active') rejectReadiness('launch state is not active');
  if (!isRecord(payload.checks.maintenance)) rejectReadiness('maintenance checks are missing');
  for (const name of ['ready', 'recovery', 'retention', 'deletion']) {
    if (payload.checks.maintenance[name] !== true) {
      rejectReadiness(`maintenance ${name} check failed`);
    }
  }

  if (!isRecord(payload.canary)) rejectReadiness('campaign details are missing');
  if (typeof payload.canary.campaignId !== 'string' || payload.canary.campaignId.length === 0) {
    rejectReadiness('campaign id is missing');
  }
  if (payload.canary.maxProviderStarts !== expectedCampaign.maxProviderStarts) {
    rejectReadiness('campaign provider-start limit does not match the checked-in contract');
  }
  if (payload.canary.reservationCeilingMicrousd !== expectedCampaign.reservationCeilingMicrousd) {
    rejectReadiness('campaign spend limit does not match the checked-in contract');
  }
  if (payload.canary.maxProviderStreamAttempts !== 1) {
    rejectReadiness('provider stream attempts are not exactly one');
  }

  return {
    deployedGitSha: payload.deployedGitSha,
    campaignId: payload.canary.campaignId,
    catalogVersion: payload.catalogVersion,
  };
}

function readHostedHumanCampaignContract(repoRoot) {
  const contractPath = path.join(repoRoot, '.ci', 'hosted-codex-harness-qualification.json');
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read the checked-in Hosted campaign contract: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
  const liveCanary = contract?.liveCanary;
  const maxProviderStarts = liveCanary?.humanCampaignMaxProviderStarts;
  const reservationCeilingMicrousd = liveCanary?.humanCampaignReservationCeilingMicrousd;
  if (
    !Number.isSafeInteger(maxProviderStarts) ||
    maxProviderStarts < 1 ||
    !Number.isSafeInteger(reservationCeilingMicrousd) ||
    reservationCeilingMicrousd < 1
  ) {
    throw new Error('The checked-in Hosted human campaign contract is invalid.');
  }
  return { maxProviderStarts, reservationCeilingMicrousd };
}

function renderedDevLaunchTarget(html) {
  if (typeof html !== 'string') return null;
  const match = html.match(
    /<meta\s+name=["']dnaforge-dev-target["']\s+content=["']([^"']*)["']\s*\/?>/iu
  );
  if (!match) return null;
  return match[1] || null;
}

module.exports = {
  HOSTED_STAGING_PROFILE,
  applyDevLaunchTarget,
  parseDevLaunchTarget,
  readHostedHumanCampaignContract,
  renderedDevLaunchTarget,
  validateHostedStagingReadiness,
};
