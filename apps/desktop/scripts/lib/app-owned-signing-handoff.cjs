const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');
const { helperMetadataDirectory } = require('./mac-helper-metadata.cjs');

const HANDOFF_FILE = 'app-owned-tools.signing.json';
const HANDOFF_SCHEMA = 'dnaforge.app-owned-tools-signing.v1';
const ownerLock = require('../../../../.ci/app-owned-signing-owner.lock.json');
const installed = new WeakMap();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const plainName = (name) =>
  typeof name === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) &&
  !['.', '..'].includes(name);

function assertSigningOwnerContract() {
  const owner = require.resolve('app-builder-lib/out/codeSign/macCodeSign.js');
  const ownerRequire = createRequire(owner);
  if (
    require('app-builder-lib/package.json').version !== ownerLock.appBuilderVersion ||
    ownerRequire('@electron/osx-sign/package.json').version !== ownerLock.osxSignVersion
  ) {
    throw new Error(
      'The package signing owner changed; review the before-seal compatibility boundary.'
    );
  }
  for (const [name, entry] of Object.entries(ownerLock.files)) {
    const file =
      name === 'osxSign' ? ownerRequire.resolve(entry.module) : require.resolve(entry.module);
    if (sha256(fs.readFileSync(file)) !== entry.sha256) {
      throw new Error(
        `The ${name} signing-owner implementation changed; before-seal recording is unqualified.`
      );
    }
  }
}

function regularBytes(file, limit = 64 * 1024 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.size > limit)
    throw new Error(`Not a bounded regular signing input: ${file}`);
  return fs.readFileSync(file);
}

function inspectPublisher(file, policy, commands = { execFileSync, spawnSync }) {
  commands.execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], {
    stdio: 'pipe',
    timeout: 10000,
  });
  const probe = commands.spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', file], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (probe.status !== 0 || probe.error)
    throw new Error(`Cannot inspect the package signer's output: ${file}`);
  const text = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  for (const mode of Object.keys(policy.MACOS_SIGNERS)) {
    try {
      const identity = policy.verifyCodesignMetadata(text, mode);
      commands.execFileSync(
        '/usr/bin/codesign',
        ['--verify', '--strict', '-R', `=${policy.developerIdRequirement(mode)}`, file],
        { stdio: 'pipe', timeout: 10000 }
      );
      return { mode, ...identity, publisherVerified: true };
    } catch {}
  }
  if (/^Signature=adhoc$/m.test(text) && /^TeamIdentifier=not set$/m.test(text)) {
    return { mode: 'ad-hoc', authority: null, teamId: null, publisherVerified: false };
  }
  throw new Error(`The signed helper has no recognized package publisher: ${file}`);
}

function sourceSnapshot(appPath, source) {
  if (
    !plainName(source.file) ||
    !plainName(source.sourceReceiptFile) ||
    !/^[0-9a-f]{64}$/.test(source.sourceBuildSha256)
  ) {
    throw new Error('Invalid app-owned tool source descriptor.');
  }
  const helpers = path.join(appPath, 'Contents', 'Helpers');
  const file = path.join(helpers, source.file);
  const bytes = regularBytes(file);
  if (sha256(bytes) !== source.sourceBuildSha256)
    throw new Error(`Unsigned source receipt mismatch: ${source.file}`);
  const receiptFile = path.join(helperMetadataDirectory(appPath), source.sourceReceiptFile);
  const receipt = regularBytes(receiptFile, 256 * 1024);
  return {
    ...source,
    path: file,
    bytes,
    mode: fs.statSync(file).mode & 0o777,
    receiptPath: receiptFile,
    sourceReceiptSha256: sha256(receipt),
  };
}

function createSigningHandoff({ appPath, bundleIdentifier, sources, inspect }) {
  appPath = path.resolve(appPath);
  const snapshots = sources.map((source) => sourceSnapshot(appPath, source));
  if (new Set(snapshots.map((source) => source.file)).size !== snapshots.length)
    throw new Error('Duplicate app-owned signing source.');
  const byPath = new Map(snapshots.map((source) => [path.resolve(source.path), source]));
  const seen = new Set();
  const attempts = [];
  let finalized = null;
  const destination = path.join(appPath, 'Contents', 'Resources', HANDOFF_FILE);

  function beforeFile(file) {
    const resolved = path.resolve(file);
    const source = byPath.get(resolved);
    if (source) {
      const before = sha256(regularBytes(source.path));
      if (!seen.has(source.file) && before !== source.sourceBuildSha256)
        throw new Error(`Unsigned tool changed before signing: ${source.file}`);
      if (seen.has(source.file)) {
        const temporary = `${source.path}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, source.bytes, { mode: source.mode, flag: 'wx' });
        fs.renameSync(temporary, source.path);
      }
      attempts.push({
        file: source.file,
        inputSha256: source.sourceBuildSha256,
        previousSha256: before,
      });
      seen.add(source.file);
      return;
    }
    if (resolved !== appPath) return;
    if (seen.size !== snapshots.length)
      throw new Error('The signer omitted an app-owned helper before sealing the containing app.');
    const tools = {};
    let publisher = null;
    for (const source of snapshots) {
      if (sha256(regularBytes(source.receiptPath, 256 * 1024)) !== source.sourceReceiptSha256)
        throw new Error(`Unsigned receipt changed during signing: ${source.sourceReceiptFile}`);
      const identity = inspect(source.path);
      if (identity && typeof identity.then === 'function')
        throw new Error('The signing handoff inspector must be synchronous.');
      if (publisher && JSON.stringify(publisher) !== JSON.stringify(identity))
        throw new Error('App-owned helpers were signed by different package authorities.');
      publisher = identity;
      tools[source.file] = {
        sourceBuildSha256: source.sourceBuildSha256,
        sourceReceiptFile: source.sourceReceiptFile,
        sourceReceiptSha256: source.sourceReceiptSha256,
        signedSha256: sha256(regularBytes(source.path)),
      };
    }
    const document = {
      schema: HANDOFF_SCHEMA,
      phase: 'existing-signer-before-containing-app-seal',
      bundleIdentifier,
      packageAuthority: publisher,
      tools,
      attempts: [...attempts],
    };
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, destination);
    finalized = { document, sha256: sha256(bytes) };
  }

  function assertComplete() {
    if (!finalized)
      throw new Error('The signer did not expose the containing app before its resource seal.');
    if (sha256(regularBytes(destination, 256 * 1024)) !== finalized.sha256)
      throw new Error('The package handoff changed after recording.');
    for (const source of snapshots) {
      if (sha256(regularBytes(source.path)) !== finalized.document.tools[source.file].signedSha256)
        throw new Error(`A signed helper changed after the package handoff: ${source.file}`);
      if (sha256(regularBytes(source.receiptPath, 256 * 1024)) !== source.sourceReceiptSha256)
        throw new Error(
          `An unsigned receipt changed after the package handoff: ${source.sourceReceiptFile}`
        );
    }
    return finalized;
  }

  return { beforeFile, assertComplete, destination };
}

async function installSigningHandoff({
  packager,
  appPath,
  bundleIdentifier,
  sources,
  inspect,
  checkOwner = assertSigningOwnerContract,
}) {
  checkOwner();
  if (!inspect) {
    const policy = await import(
      pathToFileURL(path.resolve(__dirname, '../../../../scripts/lib/macos-signing-identity.mjs'))
        .href
    );
    inspect = (file) => inspectPublisher(file, policy);
  }
  if (typeof packager.doSign !== 'function' || packager.doSign.length !== 3)
    throw new Error('The protected package signing boundary changed.');
  let state = installed.get(packager);
  if (!state) {
    state = { original: packager.doSign, apps: new Map() };
    installed.set(packager, state);
    packager.doSign = async function (options, customOptions, identity) {
      const recording = state.apps.get(path.resolve(options.app));
      if (!recording) return state.original.call(this, options, customOptions, identity);
      const original = options.optionsForFile;
      const wrapped = {
        ...options,
        optionsForFile: function (...args) {
          const value = original ? original.apply(this, args) : undefined;
          if (value && typeof value.then === 'function')
            throw new Error('The installed signer requires synchronous per-file options.');
          recording.beforeFile(args[0]);
          return value;
        },
      };
      const result = await state.original.call(this, wrapped, customOptions, identity);
      recording.assertComplete();
      return result;
    };
  }
  const recording = createSigningHandoff({ appPath, bundleIdentifier, sources, inspect });
  state.apps.set(path.resolve(appPath), recording);
  return recording;
}

module.exports = {
  inspectPublisher,
  HANDOFF_FILE,
  HANDOFF_SCHEMA,
  assertSigningOwnerContract,
  createSigningHandoff,
  installSigningHandoff,
};
