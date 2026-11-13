import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const appSource = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appSource, '../..');
const require = createRequire(import.meta.url);
const { inspectNativeBuild, recordNativeBuild, nativeBuildCachePlugin } = require(
  join(project, 'apps/desktop/scripts/dev-native-build-cache.cjs')
);
const { createElectronModuleGraph } = await import(
  pathToFileURL(join(appSource, 'scripts/lib/electron-module-graph.ts'))
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function put(root, file, value) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

async function fixture(t) {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dna4154-renderer-native-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const appDir = join(repoRoot, 'apps/desktop');
  put(repoRoot, 'package.json', { name: 'native-reuse-fixture', private: true, type: 'module' });
  put(repoRoot, '.gitignore', 'node_modules/\nout/\n.cache/\n');
  put(repoRoot, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  put(repoRoot, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/**'\n");
  put(appDir, 'package.json', { name: '@fixture/desktop', private: true, type: 'module' });
  put(
    appDir,
    'electron.vite.config.ts',
    "import { createHash } from 'node:crypto';\nimport { execFileSync } from 'node:child_process';\nimport { readFileSync } from 'node:fs';\nimport { createRequire } from 'node:module';\nimport { fileURLToPath } from 'node:url';\nconst root = fileURLToPath(new URL('../..', import.meta.url));\nconst require = createRequire(import.meta.url);\nconst sourceCommit = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();\nconst nativeFiles = ['src/main/index.js', 'src/main/worker.js', 'src/shared/native.js', 'src/preload/index.js', '../../packages/core/native-fixture/src/index.js'];\nconst fingerprint = createHash('sha256').update(JSON.stringify(nativeFiles.map(file => [file, readFileSync(new URL(file, import.meta.url), 'utf8')]))).digest('hex');\nconst sidecar = require('../../scripts/sidecar-build-receipt.cjs').computeSidecarSourceHash(root).sourceHash;\nconst nativeDefines = { __WAYPOINT_BUILD_SOURCE_FINGERPRINT__: JSON.stringify(fingerprint), __WAYPOINT_SIDECAR_SOURCE_FINGERPRINT__: JSON.stringify(sidecar), __DNAFORGE_APP_BUILD__: JSON.stringify({ sourceCommit }) };\nconst rendererFingerprint = createHash('sha256').update(readFileSync(new URL('src/renderer/App.js', import.meta.url))).digest('hex');\nexport default { main: { define: nativeDefines }, preload: { define: nativeDefines }, renderer: { root: fileURLToPath(new URL('src/renderer', import.meta.url)), define: { __WAYPOINT_BUILD_SOURCE_FINGERPRINT__: JSON.stringify(rendererFingerprint), __DNAFORGE_APP_BUILD__: JSON.stringify({ sourceCommit }) }, server: { host: '127.0.0.1', port: Number(process.env.DESKTOP_DEV_PORT) || 1591, strictPort: true, hmr: { host: '127.0.0.1', port: Number(process.env.DESKTOP_HMR_PORT) || 1592 } } } };\n"
  );
  put(appDir, 'tsconfig.json', { compilerOptions: { target: 'ES2022' } });
  put(appDir, '.env.local', 'DESKTOP_DEV_PORT=1591\nAPI_PORT=8012\n');
  put(
    appDir,
    'src/main/index.js',
    "import { worker } from './worker.js'; import { native } from '@fixture/native'; export const value = worker + native;\n"
  );
  put(
    appDir,
    'src/main/worker.js',
    "import { shared } from '../shared/native.js'; export const worker = 'worker-' + shared;\n"
  );
  put(
    appDir,
    'src/preload/index.js',
    "import { shared } from '../shared/native.js'; globalThis.fixtureNative = shared;\n"
  );
  put(appDir, 'src/shared/native.js', "export const shared = 'shared';\n");
  put(appDir, 'src/renderer/App.js', "export const title = 'renderer one';\n");
  put(repoRoot, 'packages/core/native-fixture/package.json', {
    name: '@fixture/native',
    type: 'module',
    exports: './src/index.js',
  });
  put(
    repoRoot,
    'packages/core/native-fixture/src/index.js',
    "export const native = 'native-package';\n"
  );
  mkdirSync(join(appDir, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(
    join(repoRoot, 'packages/core/native-fixture'),
    join(appDir, 'node_modules/@fixture/native'),
    'dir'
  );
  for (const name of ['electron', 'electron-vite', 'vite']) {
    const metadata = readFileSync(join(project, 'node_modules', name, 'package.json'));
    put(appDir, `node_modules/${name}/package.json`, metadata.toString());
  }
  const sidecarInputs = JSON.parse(
    readFileSync(join(project, 'apps/api/src/sidecar-source-inputs.json'), 'utf8')
  );
  const sidecarDirectories = new Set([
    'apps/api/src',
    'packages/core/agent-tools',
    'packages/core/compute-endpoints/manifests',
    'packages/annotation/src',
  ]);
  for (const file of sidecarInputs.paths) {
    if (sidecarDirectories.has(file)) put(repoRoot, `${file}/fixture.py`, 'fixture = True\n');
    else if (file.startsWith('scripts/') || file.startsWith('.ci/'))
      put(repoRoot, file, readFileSync(join(project, file), 'utf8'));
    else put(repoRoot, file, 'fixture = true\n');
  }
  put(repoRoot, 'apps/api/src/sidecar-source-inputs.json', sidecarInputs);
  for (const file of ['dev-native-build-cache.cjs', 'lib/electron-module-graph.ts'])
    put(appDir, `scripts/${file}`, readFileSync(join(appSource, 'scripts', file), 'utf8'));
  const git = (...args) =>
    execFileSync(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repoRoot, ...args],
      { encoding: 'utf8', stdio: 'pipe' }
    );
  git('init', '--quiet');
  const commit = (message) => {
    git('add', '.');
    git(
      '-c',
      'user.name=Native Reuse Contract',
      '-c',
      'user.email=native-reuse@example.invalid',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      message
    );
  };
  commit('initial fixture');
  const nativeFiles = [
    'src/main/index.js',
    'src/main/worker.js',
    'src/shared/native.js',
    'src/preload/index.js',
    '../../packages/core/native-fixture/src/index.js',
  ];
  const nativeFingerprint = sha(
    JSON.stringify(nativeFiles.map((file) => [file, readFileSync(join(appDir, file), 'utf8')]))
  );
  const sidecarFingerprint = require(
    join(repoRoot, 'scripts/sidecar-build-receipt.cjs')
  ).computeSidecarSourceHash(repoRoot).sourceHash;
  const define = {
    __WAYPOINT_BUILD_SOURCE_FINGERPRINT__: JSON.stringify(nativeFingerprint),
    __WAYPOINT_SIDECAR_SOURCE_FINGERPRINT__: JSON.stringify(sidecarFingerprint),
    __DNAFORGE_APP_BUILD__: JSON.stringify({ sourceCommit: git('rev-parse', 'HEAD').trim() }),
  };
  const moduleGraph = createElectronModuleGraph({
    repoRoot,
    outDir: join(appDir, 'out/module-graph'),
    mode: 'development',
  });
  for (const target of ['main', 'preload'])
    await build({
      configFile: false,
      root: appDir,
      mode: 'development',
      logLevel: 'silent',
      define,
      plugins: [
        moduleGraph(target),
        ...(target === 'preload' ? [nativeBuildCachePlugin({ appDir, repoRoot })] : []),
      ],
      build: {
        outDir: join(appDir, 'out', target),
        minify: false,
        emptyOutDir: true,
        lib: {
          entry: join(appDir, 'src', target, 'index.js'),
          formats: ['es'],
          fileName: () => 'index.js',
        },
      },
    });
  const env = { NODE_ENV: 'development', DESKTOP_DEV_PORT: '1591', API_PORT: '8012' };
  recordNativeBuild({ appDir, repoRoot, env });
  return {
    repoRoot,
    appDir,
    env,
    commit,
    compiledSourceCommit: git('rev-parse', 'HEAD').trim(),
    inspect: () => inspectNativeBuild({ appDir, repoRoot, env }),
  };
}

test('renderer-only source edits and commits preserve the real compiled native build', async (t) => {
  const f = await fixture(t);
  assert.equal(f.inspect().reusable, true);
  const before = ['main', 'preload'].map((target) =>
    sha(readFileSync(join(f.appDir, 'out', target, 'index.js')))
  );
  put(f.appDir, 'src/renderer/App.js', "export const title = 'renderer two';\n");
  const dirty = f.inspect();
  f.commit('renderer-only fixture edit');
  const committed = f.inspect();
  const after = ['main', 'preload'].map((target) =>
    sha(readFileSync(join(f.appDir, 'out', target, 'index.js')))
  );
  console.log(
    JSON.stringify({
      kind: 'real-vite-native-outputs-after-renderer-edit',
      dirty,
      committed,
      before,
      after,
    })
  );
  assert.deepEqual(after, before);
  assert.equal(
    dirty.reusable,
    true,
    `Renderer-only edit invalidated unchanged native outputs: ${dirty.reason}`
  );
  assert.equal(
    committed.reusable,
    true,
    `Renderer-only commit invalidated unchanged native outputs: ${committed.reason}`
  );
  assert.equal(dirty.nativeInputsCompatible, true);
  assert.equal(committed.nativeInputsCompatible, true);
  assert.equal(dirty.compiledSourceCommit, f.compiledSourceCommit);
  assert.equal(committed.compiledSourceCommit, f.compiledSourceCommit);
});

test('compiled native cache still rejects changed native inputs and invalid build artifacts', async (t) => {
  const f = await fixture(t);
  const controls = [
    ['imported main worker', join(f.appDir, 'src/main/worker.js')],
    ['shared main and preload input', join(f.appDir, 'src/shared/native.js')],
    ['imported workspace package', join(f.repoRoot, 'packages/core/native-fixture/src/index.js')],
    ['Electron build configuration', join(f.appDir, 'electron.vite.config.ts')],
    ['installed native build tool', join(f.appDir, 'node_modules/vite/package.json')],
    ['compiled main output', join(f.appDir, 'out/main/index.js')],
  ];
  for (const [name, file] of controls) {
    const original = readFileSync(file);
    try {
      writeFileSync(file, Buffer.concat([original, Buffer.from('\nchanged native dependency\n')]));
      const observation = f.inspect();
      assert.equal(
        observation.reusable,
        false,
        `${name} incorrectly reused: ${JSON.stringify(observation)}`
      );
    } finally {
      writeFileSync(file, original);
    }
    assert.equal(f.inspect().reusable, true, `${name} did not restore exact initial inputs`);
  }
  const changedEnv = inspectNativeBuild({
    appDir: f.appDir,
    repoRoot: f.repoRoot,
    env: { ...f.env, VITE_BUILD_CHANNEL: 'changed' },
  });
  assert.equal(changedEnv.reusable, false, 'Changed compile environment reused native build');
  const cacheFile = join(f.appDir, '.cache/dev-native-build.json');
  const cache = readFileSync(cacheFile);
  rmSync(cacheFile);
  assert.equal(f.inspect().reusable, false, 'Missing cache receipt reused native build');
  writeFileSync(cacheFile, cache);
  const legacy = JSON.parse(cache);
  legacy.schema = 'dnaforge.dev-native-build.legacy';
  writeFileSync(cacheFile, JSON.stringify(legacy));
  assert.equal(f.inspect().reusable, false, 'Legacy cache receipt reused native build');
  writeFileSync(cacheFile, cache);
  assert.equal(f.inspect().reusable, true, 'Exact original native cache was not reusable');
});

test('development builds expose the real main and preload import graph', async (t) => {
  const f = await fixture(t);
  for (const [target, expected] of [
    [
      'main',
      [
        'apps/desktop/src/main/index.js',
        'apps/desktop/src/main/worker.js',
        'apps/desktop/src/shared/native.js',
        'packages/core/native-fixture/src/index.js',
      ],
    ],
    ['preload', ['apps/desktop/src/preload/index.js', 'apps/desktop/src/shared/native.js']],
  ]) {
    const graphPath = join(f.appDir, 'out/module-graph', `${target}.json`);
    let graph;
    try {
      graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    } catch (error) {
      assert.fail(
        `Normal development build did not emit its ${target} module graph: ${error.message}`
      );
    }
    assert.equal(graph.target, target);
    assert.equal(graph.mode, 'development');
    for (const file of expected)
      assert.ok(
        graph.modules.includes(file),
        `Compiled ${target} input absent from real graph: ${file}`
      );
    assert.ok(!graph.modules.includes('apps/desktop/src/renderer/App.js'));
  }
});
