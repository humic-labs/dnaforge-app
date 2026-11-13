const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { notarize } = require('@electron/notarize');
const { validateAppleEnv, isStaplerNetworkFailure } = require('./lib/notarize-helpers.cjs');

function restapleAfterNetworkFailure(appPath, { attempts = 6, delayMs = 30_000, spawn = spawnSync, sleep } = {}) {
  const wait = sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (let attempt = 1; ; attempt += 1) {
    wait(delayMs * attempt);
    const result = spawn('xcrun', ['stapler', 'staple', '-v', path.basename(appPath)], {
      cwd: path.dirname(appPath),
      encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) return;
    if (attempt >= attempts || !isStaplerNetworkFailure(output)) {
      throw new Error(`Failed to staple your application with code: ${result.status}\n\n${output.trim()}`);
    }
    console.error(`stapler lost its connection to Apple (attempt ${attempt}/${attempts}); retrying`);
  }
}

async function notarizeApp({ appPath, env = process.env }) {
  if (!appPath) {
    throw new Error('notarizeApp: appPath is required');
  }
  const { appleId, appleIdPassword, teamId } = validateAppleEnv(env);
  console.log(`Notarizing ${appPath} ...`);
  try {
    await notarize({ appPath, appleId, appleIdPassword, teamId });
  } catch (err) {
    const message = String(err?.message || err);
    if (!(message.startsWith('Failed to staple') && isStaplerNetworkFailure(message))) {
      throw new Error(`Notarization failed for ${appPath}: ${message}`);
    }
    console.error('Apple accepted the app, but stapling lost its connection; retrying the staple');
    try {
      restapleAfterNetworkFailure(appPath);
    } catch (stapleErr) {
      throw new Error(`Notarization failed for ${appPath}: ${stapleErr.message || stapleErr}`);
    }
  }
  console.log(`Notarization complete for ${appPath}`);
}

module.exports = { notarizeApp, restapleAfterNetworkFailure };

if (require.main === module) {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('usage: node scripts/notarize-app.cjs <path/to/App.app>');
    process.exit(2);
  }
  notarizeApp({ appPath }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
