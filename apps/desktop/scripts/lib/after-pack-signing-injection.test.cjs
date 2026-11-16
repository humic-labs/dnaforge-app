const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = process.env.DNAFORGE_SIGNING_PUBLIC_ROOT ?? path.resolve(__dirname, '../../../..');
const sourceFile = path.join(root, 'apps/desktop/scripts/after-pack.cjs');

function afterPackFixture({ sources = [{ file: 'helper' }], install } = {}) {
  const calls = { handoff: [], staged: [], finished: [], cli: [], status: [], metadata: [] };
  const dependencies = {
    'node:path': path,
    'builder-util': { Arch: { 1: 'x64', 3: 'arm64' } },
    './lib/desktop-cli.cjs': { stageDesktopCli: (value) => calls.cli.push(value) },
    './dedup-dugite.cjs': { default: async (value) => calls.finished.push(value) },
    './lib/app-owned-tool-sources.cjs': { collectAppOwnedToolSources: () => sources },
    './lib/app-owned-signing-handoff.cjs': {
      installSigningHandoff: async (value) => {
        calls.handoff.push(value);
        if (install) return install(value);
      },
    },
    './update-status-packaging.cjs': {
      buildMacUpdateStatusHelper: (...value) => calls.status.push(value),
    },
    './lib/mac-helper-metadata.cjs': {
      relocateMacHelperMetadata: (value) => calls.metadata.push(value),
    },
    './lib/macos-vulkan-loader.cjs': {
      stageMacosVulkanLoader: (value) => calls.staged.push(value),
    },
  };
  const module = { exports: {} };
  const load = new vm.Script(
    `(function(require, module, exports, __dirname, __filename, process) {\n${readFileSync(sourceFile, 'utf8')}\n})`,
    { filename: sourceFile }
  ).runInThisContext();
  load(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected build dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
    path.dirname(sourceFile),
    sourceFile,
    { env: {} }
  );
  const context = {
    electronPlatformName: 'darwin',
    appOutDir: '/fixture/output',
    arch: 3,
    packager: { appInfo: { productFilename: 'DNAForge', macBundleIdentifier: 'com.fixture.app' } },
  };
  return { afterPack: module.exports.default, context, calls, sources };
}

test('public afterPack forwards an explicit publisher inspector without loading private policy', async () => {
  const f = afterPackFixture();
  const inspectSigningPublisher = () => {
    throw Error('Inspection is deferred to the existing signer');
  };
  await f.afterPack(f.context, { inspectSigningPublisher });
  assert.equal(f.calls.handoff.length, 1);
  const actual = f.calls.handoff[0];
  assert.equal(actual.inspect, inspectSigningPublisher);
  assert.equal(actual.packager, f.context.packager);
  assert.equal(actual.sources, f.sources);
  assert.equal(actual.appPath, '/fixture/output/DNAForge.app');
  assert.equal(actual.bundleIdentifier, 'com.fixture.app');
  assert.equal(f.calls.finished[0], f.context);
});

test('public afterPack propagates the exact supplied inspector failure', async () => {
  const failure = new Error('fixture publisher policy refused the helper');
  const inspectSigningPublisher = () => {
    throw failure;
  };
  const f = afterPackFixture({ install: (options) => options.inspect('/fixture/helper') });
  await assert.rejects(
    f.afterPack(f.context, { inspectSigningPublisher }),
    (error) => error === failure
  );
});

test('ordinary afterPack calls preserve the existing default handoff owner', async () => {
  const f = afterPackFixture();
  await f.afterPack(f.context);
  assert.equal(f.calls.handoff.length, 1);
  assert.equal(f.calls.handoff[0].inspect, undefined);
  assert.equal(f.calls.staged.length, 1);
  assert.equal(f.calls.metadata.length, 1);
});

test('non-Mac and empty-source packaging never installs a signing handoff', async () => {
  const inspectSigningPublisher = () => {
    throw Error('Unexpected inspection');
  };
  const windows = afterPackFixture();
  windows.context.electronPlatformName = 'win32';
  await windows.afterPack(windows.context, { inspectSigningPublisher });
  assert.equal(windows.calls.handoff.length, 0);
  assert.equal(windows.calls.staged.length, 0);
  const empty = afterPackFixture({ sources: [] });
  await empty.afterPack(empty.context, { inspectSigningPublisher });
  assert.equal(empty.calls.handoff.length, 0);
});
