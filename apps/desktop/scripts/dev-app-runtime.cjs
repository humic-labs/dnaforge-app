const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { automationUserDataPath } = require('../src/main/automation-profile.cjs');

const DEVELOPMENT_BOOTSTRAP_SOURCES = [
  ...['dev-app-entry.mjs', 'dev-app-bootstrap.mjs'].map((name) =>
    path.join(__dirname, 'lib', name)
  ),
  path.join(__dirname, '../src/main', 'automation-profile.cjs'),
  path.join(__dirname, '../src/main', 'noninteractive-keychain.cjs'),
];

const ENVIRONMENT_KEYS = [
  'DNAFORGE_AUTOMATION_CONTEXT',
  'DNAFORGE_DATA_CONFINEMENT_REQUIRED',
  'DNAFORGE_BACKGROUND_WINDOW',
  'DNAFORGE_BACKGROUND_LAUNCH_SAFE',
  'DNAFORGE_ALLOW_SCENARIO_MUTATION',
  'DNAFORGE_DEV_TARGET',
  'VITE_DNAFORGE_DEV_TARGET',
  'DESKTOP_DEV_PORT',
  'DESKTOP_HMR_PORT',
  'DESKTOP_DEBUG_PORT',
  'API_PORT',
  'NODE_ENV',
];

function developmentApplicationIdentity(appDirectory, rendererPort) {
  const port = Number(rendererPort);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== String(rendererPort)
  ) {
    throw new Error('A canonical desktop port is required for the development application.');
  }
  const id = createHash('sha256').update(path.resolve(appDirectory)).digest('hex').slice(0, 16);
  return {
    scheme: `dnaforge-dev-${port}`,
    bundleId: `com.dnaforge.development.${id}`,
    displayName: `DNAForge Dev :${port}`,
  };
}

function developmentApplicationPlist(original, identity) {
  return {
    ...original,
    CFBundleIdentifier: identity.bundleId,
    CFBundleName: identity.displayName,
    CFBundleDisplayName: identity.displayName,
    CFBundleURLTypes: [
      { CFBundleURLName: identity.bundleId, CFBundleURLSchemes: [identity.scheme, 'dnaforge-dev'] },
    ],
  };
}

function developmentEnvironment(env) {
  return Object.fromEntries(
    ENVIRONMENT_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, String(env[key])]]))
  );
}

function writeRuntimeConfiguration(file, configuration) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(configuration, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function sameContents(left, right) {
  const a = fs.lstatSync(left);
  const b = fs.lstatSync(right);
  if (a.isSymbolicLink() || b.isSymbolicLink()) {
    return (
      a.isSymbolicLink() && b.isSymbolicLink() && fs.readlinkSync(left) === fs.readlinkSync(right)
    );
  }
  if (a.isDirectory() || b.isDirectory()) {
    if (!a.isDirectory() || !b.isDirectory()) return false;
    const names = fs.readdirSync(left).sort();
    if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(right).sort())) return false;
    return names.every((name) => sameContents(path.join(left, name), path.join(right, name)));
  }
  if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
  const first = fs.openSync(left, 'r');
  const second = fs.openSync(right, 'r');
  try {
    const x = Buffer.alloc(65536);
    const y = Buffer.alloc(65536);
    let count;
    do {
      count = fs.readSync(first, x, 0, x.length, null);
      if (
        fs.readSync(second, y, 0, y.length, null) !== count ||
        !x.subarray(0, count).equals(y.subarray(0, count))
      )
        return false;
    } while (count);
    return true;
  } finally {
    fs.closeSync(first);
    fs.closeSync(second);
  }
}

function normalizeFrameworkLinks(bundle, backupRoot) {
  const frameworks = path.join(bundle, 'Contents/Frameworks');
  for (const name of fs.readdirSync(frameworks)) {
    if (!name.endsWith('.framework')) continue;
    const framework = path.join(frameworks, name);
    const versions = path.join(framework, 'Versions');
    if (!fs.existsSync(versions)) continue;
    const candidates = fs.readdirSync(versions).filter((version) => version !== 'Current');
    if (candidates.length !== 1) throw new Error(`Ambiguous framework versions: ${name}`);
    const version = candidates[0];
    const backup = path.join(backupRoot, name);
    fs.mkdirSync(backup, { recursive: true });
    const replace = (file, target, canonical, savedName) => {
      if (fs.lstatSync(file, { throwIfNoEntry: false })) {
        if (fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === target) return;
        if (!sameContents(file, canonical)) throw new Error(`Framework copies differ: ${file}`);
        fs.renameSync(file, path.join(backup, savedName));
      }
      fs.symlinkSync(target, file);
    };
    const canonical = path.join(versions, version);
    replace(path.join(versions, 'Current'), version, canonical, 'Current');
    for (const entry of fs.readdirSync(canonical)) {
      replace(
        path.join(framework, entry),
        `Versions/Current/${entry}`,
        path.join(canonical, entry),
        entry
      );
    }
  }
}

function writeDevelopmentBootstrap(bootstrap) {
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.writeFileSync(
    path.join(bootstrap, 'package.json'),
    JSON.stringify({
      name: 'dnaforge-development-entry',
      type: 'module',
      main: 'scripts/lib/dev-app-entry.mjs',
    })
  );
  for (const source of DEVELOPMENT_BOOTSTRAP_SOURCES) {
    const destination = path.join(bootstrap, path.relative(path.resolve(__dirname, '..'), source));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

async function prepareDevelopmentApplication({
  appDirectory,
  electronBinary,
  env,
  platform = process.platform,
  timeoutMs = 120000,
}) {
  if (platform !== 'darwin' || env.NODE_ENV === 'test') return { electronBinary, env: {} };
  const deadline = Date.now() + timeoutMs;
  const commandOptions = (options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error('Development app preparation exceeded the startup deadline');
    return { ...options, timeout: remaining, killSignal: 'SIGKILL' };
  };
  const identity = developmentApplicationIdentity(appDirectory, env.DESKTOP_DEV_PORT);
  const originalBundle = path.resolve(path.dirname(electronBinary), '../..');
  const originalArchive = path.join(originalBundle, 'Contents/Resources/default_app.asar');
  const digest = createHash('sha256');
  digest.update(fs.readFileSync(__filename));
  digest.update(fs.readFileSync(path.join(originalBundle, 'Contents/Info.plist')));
  digest.update(fs.readFileSync(originalArchive));
  for (const source of DEVELOPMENT_BOOTSTRAP_SOURCES) digest.update(fs.readFileSync(source));
  digest.update(JSON.stringify(identity));
  const fingerprint = digest.digest('hex').slice(0, 24);
  const nativeIdentity = { ...identity, bundleId: `${identity.bundleId}.${fingerprint}` };
  const cacheRoot = path.join(appDirectory, '.cache/dnaforge-dev-runtime');
  const versionDirectory = path.join(cacheRoot, fingerprint);
  const bundle = path.join(versionDirectory, 'Electron.app');
  const ready = path.join(versionDirectory, 'ready.json');
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(ready)) {
    const staging = fs.mkdtempSync(path.join(cacheRoot, 'preparing-'));
    const stagingBundle = path.join(staging, 'Electron.app');
    fs.cpSync(originalBundle, stagingBundle, {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    });
    normalizeFrameworkLinks(stagingBundle, path.join(staging, 'original-framework-layout'));
    const resources = path.join(stagingBundle, 'Contents/Resources');
    fs.renameSync(
      path.join(resources, 'default_app.asar'),
      path.join(resources, 'dnaforge-original-default-app.asar')
    );
    const bootstrap = path.join(staging, 'bootstrap');
    writeDevelopmentBootstrap(bootstrap);
    await require('@electron/asar').createPackage(
      bootstrap,
      path.join(resources, 'default_app.asar')
    );
    const plistPath = path.join(stagingBundle, 'Contents/Info.plist');
    const originalPlist = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
        encoding: 'utf8',
        ...commandOptions(),
      })
    );
    const plistInput = path.join(staging, 'Info.json');
    fs.writeFileSync(
      plistInput,
      JSON.stringify(developmentApplicationPlist(originalPlist, nativeIdentity))
    );
    execFileSync(
      '/usr/bin/plutil',
      ['-convert', 'binary1', '-o', plistPath, plistInput],
      commandOptions()
    );
    execFileSync(
      '/usr/bin/codesign',
      ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags', stagingBundle],
      commandOptions({ stdio: 'pipe' })
    );
    execFileSync(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', stagingBundle],
      commandOptions({
        stdio: 'pipe',
      })
    );
    fs.writeFileSync(
      path.join(staging, 'ready.json'),
      JSON.stringify({ fingerprint, ...nativeIdentity })
    );
    try {
      fs.renameSync(staging, versionDirectory);
    } catch (error) {
      if (!fs.existsSync(ready)) throw error;
    }
  }

  const configPath = path.join(cacheRoot, 'runtime.json');
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {}
  const executable = path.join(bundle, 'Contents/MacOS/Electron');
  const automationProfile = automationUserDataPath([], env, appDirectory);
  const configuration = {
    schemaVersion: 1,
    appDirectory: path.resolve(appDirectory),
    entry: path.join(path.resolve(appDirectory), 'out/main/index.js'),
    electronBinary: executable,
    scheme: identity.scheme,
    environment: developmentEnvironment(env),
    ...(automationProfile
      ? { userDataDir: automationProfile }
      : previous?.appDirectory === path.resolve(appDirectory) && previous.userDataDir
        ? { userDataDir: previous.userDataDir }
        : {}),
  };
  writeRuntimeConfiguration(configPath, configuration);
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', bundle],
    commandOptions({ stdio: 'pipe' })
  );
  return {
    electronBinary: executable,
    env: { DNAFORGE_DEV_RUNTIME_CONFIG: configPath, DNAFORGE_DEV_ENTITY_SCHEME: identity.scheme },
  };
}

module.exports = {
  developmentApplicationIdentity,
  developmentApplicationPlist,
  developmentEnvironment,
  normalizeFrameworkLinks,
  writeDevelopmentBootstrap,
  prepareDevelopmentApplication,
};
