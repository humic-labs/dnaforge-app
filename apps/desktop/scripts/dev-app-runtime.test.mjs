import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureDevelopmentEntry } from './lib/dev-app-bootstrap.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const asar = require('@electron/asar');
const {
  developmentApplicationIdentity,
  developmentApplicationPlist,
  developmentEnvironment,
  normalizeFrameworkLinks,
  writeDevelopmentBootstrap,
} = require('./dev-app-runtime.cjs');

function resolveEntryImports(entry) {
  const source = ts.createSourceFile(entry, readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest);
  const imports = source.statements
    .filter((statement) => ts.isImportDeclaration(statement))
    .map((statement) => statement.moduleSpecifier.text)
    .filter((specifier) => specifier.startsWith('.'));
  const requires = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === 'createRequire' &&
      ts.isStringLiteral(node.arguments[0])
    )
      requires.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  imports.push(...requires);
  assert.equal(imports.length, 2);
  return imports.map((specifier) => createRequire(entry).resolve(specifier));
}

test('the source development entry resolves every local import', () => {
  const entry = fileURLToPath(new URL('./lib/dev-app-entry.mjs', import.meta.url));
  resolveEntryImports(entry);
});

test('the development runtime archive preserves resolvable canonical bootstrap sources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dnaforge-bootstrap-imports-'));
  try {
    const bootstrap = join(root, 'bootstrap');
    writeDevelopmentBootstrap(bootstrap);
    const archive = join(root, 'default_app.asar');
    await asar.createPackage(bootstrap, archive);
    const extracted = join(root, 'extracted');
    asar.extractAll(archive, extracted);
    const manifest = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'));
    const entry = resolve(extracted, manifest.main);
    const sourceEntry = fileURLToPath(new URL('./lib/dev-app-entry.mjs', import.meta.url));
    assert.deepEqual(readFileSync(entry), readFileSync(sourceEntry));
    const imports = resolveEntryImports(entry);
    const sourceImports = resolveEntryImports(sourceEntry);
    for (let index = 0; index < imports.length; index++) {
      assert.deepEqual(readFileSync(imports[index]), readFileSync(sourceImports[index]));
      const module = await import(pathToFileURL(imports[index]).href);
      assert(Object.values(module).some((value) => typeof value === 'function'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const app = new EventEmitter();
  const paths = [];
  const switches = [];
  app.commandLine = { appendSwitch: (...args) => switches.push(args) };
  app.setPath = (...args) => paths.push(args);
  return { app, paths, switches };
}

test('automation bootstrap selects its exact private profile before a saved shared profile', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-agent-')));
  try {
    const profile = join(root, 'profile');
    mkdirSync(profile, { mode: 0o700 });
    mkdirSync(join(root, 'tmp'), { mode: 0o700 });
    const context = join(root, 'context.json');
    writeFileSync(
      context,
      JSON.stringify({
        schemaVersion: 1,
        purpose: 'agent-automation',
        id: randomUUID(),
        root,
        workspace: root,
        profile,
      }),
      { mode: 0o600 }
    );
    const f = fixture();
    const argv = ['Electron', configuration.entry];
    const env = { DNAFORGE_AUTOMATION_CONTEXT: context };
    const automationConfiguration = { ...configuration, appDirectory: root };
    configureDevelopmentEntry({
      app: f.app,
      argv,
      env,
      configuration: automationConfiguration,
      configPath: '/owned/runtime.json',
      changeDirectory() {},
    });
    assert.deepEqual(f.paths, [['userData', profile]]);
    assert(argv.includes('--user-data-dir=' + profile));
    assert(!argv.includes('--user-data-dir=' + configuration.userDataDir));
    assert.throws(() =>
      configureDevelopmentEntry({
        app: f.app,
        argv: ['Electron', '--user-data-dir=/unrelated/profile'],
        env,
        configuration: automationConfiguration,
        configPath: '/owned/runtime.json',
        changeDirectory() {},
      })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a task-owned copy restores framework links and retains the copied flattened layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-framework-layout-'));
  try {
    const bundle = join(root, 'Electron.app');
    const framework = join(bundle, 'Contents/Frameworks/Electron Framework.framework');
    const current = join(framework, 'Versions/Current');
    const version = join(framework, 'Versions/A');
    for (const directory of [current, version]) mkdirSync(directory, { recursive: true });
    for (const directory of [current, version, framework])
      writeFileSync(join(directory, 'Electron Framework'), 'canonical framework');
    const backup = join(root, 'retained-layout');
    normalizeFrameworkLinks(bundle, backup);
    assert.equal(lstatSync(current).isSymbolicLink(), true);
    assert.equal(readlinkSync(current), 'A');
    assert.equal(
      readFileSync(join(framework, 'Electron Framework'), 'utf8'),
      'canonical framework'
    );
    assert.equal(
      readFileSync(join(backup, 'Electron Framework.framework/Electron Framework'), 'utf8'),
      'canonical framework'
    );
    assert.equal(
      readFileSync(join(backup, 'Electron Framework.framework/Current/Electron Framework'), 'utf8'),
      'canonical framework'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const configuration = {
  schemaVersion: 1,
  appDirectory: '/owned/desktop',
  entry: '/owned/desktop/out/main/index.js',
  scheme: 'dnaforge-dev-1827',
  environment: { DESKTOP_DEV_PORT: '1827', DNAFORGE_BACKGROUND_WINDOW: '1' },
  userDataDir: '/owned/temporary-scenario-profile',
};

test('development instances have distinct native identities and entity schemes', () => {
  const first = developmentApplicationIdentity('/worktree/first', '1827');
  const second = developmentApplicationIdentity('/worktree/second', '1828');
  assert.notEqual(first.bundleId, second.bundleId);
  assert.notEqual(first.scheme, second.scheme);
  const plist = developmentApplicationPlist({ CFBundleExecutable: 'Electron' }, first);
  assert.equal(plist.CFBundleIdentifier, first.bundleId);
  assert.equal(plist.CFBundleExecutable, 'Electron');
  assert.deepEqual(plist.CFBundleURLTypes[0].CFBundleURLSchemes, [
    'dnaforge-dev-1827',
    'dnaforge-dev',
  ]);
  assert.throws(() => developmentApplicationIdentity('/worktree', '01827'));
  assert.throws(() => developmentApplicationIdentity('/worktree', '65536'));
});

test('the native launch configuration excludes credentials and ambient command overrides', () => {
  const environment = developmentEnvironment({
    DESKTOP_DEV_PORT: '1827',
    DNAFORGE_BACKGROUND_WINDOW: '1',
    DNAFORGE_MCP_API_KEY: 'dummy-key',
    OPENAI_API_KEY: 'dummy-key',
    NODE_OPTIONS: '--require untrusted.js',
    PATH: '/ambient/bin',
  });
  assert.deepEqual(environment, { DESKTOP_DEV_PORT: '1827', DNAFORGE_BACKGROUND_WINDOW: '1' });
});

test('a cold native open restores its saved profile and passes the real application root to the original loader', () => {
  const { app, paths, switches } = fixture();
  const argv = ['/owned/native/Electron'];
  const env = { ELECTRON_RENDERER_URL: 'http://stopped-server/' };
  const directories = [];
  configureDevelopmentEntry({
    app,
    argv,
    env,
    configuration,
    configPath: '/owned/runtime.json',
    changeDirectory: (directory) => directories.push(directory),
  });
  assert.deepEqual(argv, [
    '/owned/native/Electron',
    configuration.appDirectory,
    '--user-data-dir=' + configuration.userDataDir,
  ]);
  assert.deepEqual(paths, [['userData', configuration.userDataDir]]);
  assert.deepEqual(switches, [['user-data-dir', configuration.userDataDir]]);
  assert.equal(env.ELECTRON_RENDERER_URL, undefined);
  assert.equal(env.DNAFORGE_DEV_ENTITY_SCHEME, 'dnaforge-dev-1827');
  assert.deepEqual(directories, [configuration.appDirectory]);
  assert.equal(Object.hasOwn(app, 'isPackaged'), false);
});

test('the guarded Vite launch retains its explicit profile and active renderer URL', () => {
  const { app, paths } = fixture();
  const argv = [
    '/owned/native/Electron',
    configuration.appDirectory,
    '--user-data-dir=/owned/new-profile',
  ];
  const before = [...argv];
  const env = { ELECTRON_RENDERER_URL: 'http://localhost:1827/' };
  configureDevelopmentEntry({
    app,
    argv,
    env,
    configuration,
    configPath: '/owned/runtime.json',
    changeDirectory() {},
  });
  assert.deepEqual(argv, before);
  assert.deepEqual(paths, []);
  assert.equal(env.ELECTRON_RENDERER_URL, 'http://localhost:1827/');
});

test('the Vite directory entry preserves a warm launch when native launch omits its renderer environment', () => {
  const { app, paths } = fixture();
  const argv = [
    '/owned/native/Electron',
    '/owned/desktop/out/main',
    '--user-data-dir=/owned/new-profile',
  ];
  const env = {};
  configureDevelopmentEntry({
    app,
    argv,
    env,
    configuration,
    configPath: '/owned/runtime.json',
    changeDirectory() {},
  });
  assert.equal(argv[1], configuration.appDirectory);
  assert.equal(env.ELECTRON_RENDERER_URL, 'http://localhost:1827/');
  assert.deepEqual(paths, []);
});

test('an actual early URL is forwarded once when the product installs its native listener', async () => {
  const { app } = fixture();
  configureDevelopmentEntry({
    app,
    argv: ['/owned/native/Electron', configuration.entry],
    env: {},
    configuration,
    configPath: '/owned/runtime.json',
    changeDirectory() {},
  });
  const events = [];
  const event = { preventDefault() {} };
  app.emit('open-url', event, 'dnaforge-dev-1827://entity/open?entityId=exact');
  app.on('open-url', (receivedEvent, url) => events.push({ receivedEvent, url }));
  await Promise.resolve();
  assert.deepEqual(events, [
    { receivedEvent: event, url: 'dnaforge-dev-1827://entity/open?entityId=exact' },
  ]);
  assert.equal(app.listenerCount('open-url'), 1);
});

 test('a foreground relative entry remains a warm development launch', () => {
  const { app } = fixture();
  const local = { ...configuration, appDirectory: process.cwd(), entry: join(process.cwd(), 'out/main/index.js') };
  const argv = ['/electron', '.'];
  const env = { ELECTRON_RENDERER_URL: 'http://localhost:1827/' };
  configureDevelopmentEntry({ app, argv, env, configuration: local, configPath: '/owned/runtime.json', changeDirectory() {} });
  assert.equal(argv[1], process.cwd());
  assert.equal(env.ELECTRON_RENDERER_URL, 'http://localhost:1827/');
 });
