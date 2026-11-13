const fs = require('node:fs');
const path = require('node:path');
const { default: prepareOpenDataLoaderRuntime } = require('./prepare-opendataloader-runtime.cjs');
const {
  appBuildVersionText,
  readAppBuildIdentity,
} = require('./lib/app-build-identity-artifact.cjs');
const { CHROMIUM_LICENSES_FILE, NOTICES_FILE } = require('./third-party-coverage.cjs');

const RESOURCES = path.resolve(__dirname, '..', 'resources');
const MAIN_OUT = path.resolve(__dirname, '..', 'out', 'main');

function packagesNotices(config) {
  return (config?.extraResources ?? []).some((entry) =>
    (typeof entry === 'string' ? entry : (entry?.from ?? '')).endsWith(NOTICES_FILE)
  );
}

exports.default = async function beforePack(context) {
  await prepareOpenDataLoaderRuntime(context);
  if (!packagesNotices(context.packager.config)) return;
  const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  fs.copyFileSync(
    path.join(electronDist, CHROMIUM_LICENSES_FILE),
    path.join(RESOURCES, CHROMIUM_LICENSES_FILE)
  );
  const identity = readAppBuildIdentity(MAIN_OUT);
  const { writeThirdPartyNotices } = await import('./generate-third-party-notices.mjs');
  const { destination, bytes } = writeThirdPartyNotices({
    appVersion: appBuildVersionText(identity),
  });
  console.log(`[before-pack] wrote ${path.basename(destination)} (${bytes} bytes)`);
};
