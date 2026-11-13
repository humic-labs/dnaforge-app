const fs = require('node:fs');
const path = require('node:path');

const APP_BUILD_IDENTITY_ARTIFACT = 'app-build-identity.json';
const PACKAGED_APP_BUILD_IDENTITY_ENTRY = `out/main/${APP_BUILD_IDENTITY_ARTIFACT}`;
const KINDS = new Set(['development', 'local', 'release', 'test']);
const UNPROVEN_VERSION_TEXT = 'version unavailable';

function parseAppBuildIdentity(text, source) {
  let identity;
  try {
    identity = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (!identity || typeof identity !== 'object' || !KINDS.has(identity.kind)) {
    throw new Error(`${source} does not identify a desktop build`);
  }
  const versioned = typeof identity.version === 'string' && identity.version.trim() !== '';
  if (!versioned && (identity.kind === 'release' || identity.version !== null)) {
    throw new Error(`${source} has no build version; the build could not prove its identity`);
  }
  return identity;
}

function appBuildVersionText(identity) {
  return identity.version ?? UNPROVEN_VERSION_TEXT;
}

function appBuildIdentityPlugin(identity) {
  const source = `${JSON.stringify(identity, null, 2)}\n`;
  return {
    name: 'app-build-identity-artifact',
    writeBundle(options) {
      const directory = options.dir ?? path.dirname(options.file);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, APP_BUILD_IDENTITY_ARTIFACT), source);
    },
  };
}

function readAppBuildIdentity(mainOutDir) {
  const file = path.join(mainOutDir, APP_BUILD_IDENTITY_ARTIFACT);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing; build the desktop app before generating its notices`);
  }
  return parseAppBuildIdentity(fs.readFileSync(file, 'utf8'), file);
}

function readPackagedAppBuildIdentity(asarPath, { extractFile, resolveEntry = (entry) => entry }) {
  const entry = resolveEntry(PACKAGED_APP_BUILD_IDENTITY_ENTRY);
  return parseAppBuildIdentity(
    extractFile(asarPath, entry).toString('utf8'),
    `${path.basename(asarPath)}:${PACKAGED_APP_BUILD_IDENTITY_ENTRY}`
  );
}

module.exports = {
  APP_BUILD_IDENTITY_ARTIFACT,
  PACKAGED_APP_BUILD_IDENTITY_ENTRY,
  UNPROVEN_VERSION_TEXT,
  appBuildIdentityPlugin,
  appBuildVersionText,
  parseAppBuildIdentity,
  readAppBuildIdentity,
  readPackagedAppBuildIdentity,
};
