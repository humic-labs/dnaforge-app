
const REQUIRED_ENV = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

function validateAppleEnv(env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Notarization requires: ${missing.join(', ')}. Set these env vars before notarizing.`
    );
  }
  return {
    appleId: env.APPLE_ID,
    appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: env.APPLE_TEAM_ID,
  };
}

function decideAfterSignNotarize(context, env) {
  if (!context || context.electronPlatformName !== 'darwin') {
    return { skip: true, reason: 'not macOS' };
  }
  if (env.WAYPOINT_SKIP_NOTARIZE === '1') {
    return {
      skip: true,
      reason:
        'WAYPOINT_SKIP_NOTARIZE=1 (local --dir build; a --dir bundle has no DMG ' +
        'to staple and would launch as "damaged")',
    };
  }
  if (!env.APPLE_ID) {
    return { skip: true, reason: 'no APPLE_ID configured' };
  }
  return { skip: false };
}

function isStaplerNetworkFailure(output) {
  return /NSURLErrorDomain Code=-10(01|05|09)\b|network connection was lost|request timed out/i.test(
    String(output)
  );
}

module.exports = { REQUIRED_ENV, validateAppleEnv, decideAfterSignNotarize, isStaplerNetworkFailure };
