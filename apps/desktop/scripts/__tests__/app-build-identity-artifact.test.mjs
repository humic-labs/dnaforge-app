import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import artifact from '../lib/app-build-identity-artifact.cjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const IDENTITY = {
  kind: 'release',
  version: '0.9.17',
  sourceReleaseVersion: '0.9.17',
  sourceCommit: 'a'.repeat(40),
  sourceModified: false,
};

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'app-build-identity-'));
  return Promise.resolve(run(directory)).finally(() =>
    rmSync(directory, { recursive: true, force: true })
  );
}

test('the build writes its identity beside the main bundle', () =>
  withTemporaryDirectory((root) => {
    const plugin = artifact.appBuildIdentityPlugin(IDENTITY);
    plugin.writeBundle({ dir: path.join(root, 'out', 'main') });
    plugin.writeBundle({ dir: path.join(root, 'out', 'main') });
    assert.deepEqual(artifact.readAppBuildIdentity(path.join(root, 'out', 'main')), IDENTITY);
    plugin.writeBundle({ file: path.join(root, 'single', 'index.js') });
    assert.deepEqual(artifact.readAppBuildIdentity(path.join(root, 'single')), IDENTITY);
  }));

test('a release identity must carry its version; other builds may say it is unproven', () => {
  assert.deepEqual(artifact.parseAppBuildIdentity(JSON.stringify(IDENTITY), 'x'), IDENTITY);
  assert.throws(
    () => artifact.parseAppBuildIdentity(JSON.stringify({ ...IDENTITY, version: null }), 'x'),
    /x has no build version/
  );
  const tagless = artifact.parseAppBuildIdentity(
    JSON.stringify({ ...IDENTITY, kind: 'local', version: null }),
    'x'
  );
  assert.equal(artifact.appBuildVersionText(tagless), 'version unavailable');
  assert.equal(artifact.appBuildVersionText(IDENTITY), '0.9.17');
  assert.throws(
    () =>
      artifact.parseAppBuildIdentity(
        JSON.stringify({ ...IDENTITY, kind: 'local', version: '' }),
        'x'
      ),
    /x has no build version/
  );
  assert.throws(
    () => artifact.parseAppBuildIdentity(JSON.stringify({ ...IDENTITY, kind: 'unknown' }), 'x'),
    /does not identify a desktop build/
  );
  assert.throws(() => artifact.parseAppBuildIdentity('{', 'x'), /x is not valid JSON/);
});

test('the identity is read from the build output, and its absence stops notices generation', () =>
  withTemporaryDirectory((root) => {
    assert.throws(
      () => artifact.readAppBuildIdentity(root),
      /app-build-identity\.json is missing; build the desktop app before generating its notices/
    );
    writeFileSync(path.join(root, 'app-build-identity.json'), JSON.stringify(IDENTITY));
    assert.equal(artifact.readAppBuildIdentity(root).version, '0.9.17');
  }));

test('the packaged identity is read from inside app.asar', () =>
  withTemporaryDirectory(async (root) => {
    const app = path.join(root, 'app');
    mkdirSync(path.join(app, 'out', 'main'), { recursive: true });
    writeFileSync(
      path.join(app, 'out', 'main', 'app-build-identity.json'),
      JSON.stringify(IDENTITY)
    );
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version: '0.9.3' }));
    const archive = path.join(root, 'app.asar');
    await asar.createPackage(app, archive);
    const identity = artifact.readPackagedAppBuildIdentity(archive, {
      extractFile: asar.extractFile,
    });
    assert.equal(identity.version, '0.9.17');
    assert.equal(artifact.PACKAGED_APP_BUILD_IDENTITY_ENTRY, 'out/main/app-build-identity.json');
  }));
