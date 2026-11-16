import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import {
  existsSync,
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

async function fixture(t, ports) {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dna4154-renderer-native-')));
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
  put(
    appDir,
    '.env.local',
    `DESKTOP_DEV_PORT=${ports.renderer}\nDESKTOP_DEBUG_PORT=${ports.debug}\nDESKTOP_HMR_PORT=${ports.hmr}\nAPI_PORT=${ports.api}\nVITE_API_URL=http://127.0.0.1:${ports.api}\n`
  );
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
  for (const name of ['electron', 'electron-vite', 'vite'])
    symlinkSync(join(project, 'node_modules', name), join(appDir, 'node_modules', name), 'dir');

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
  for (const file of [
    'dev-single-instance-guard.cjs',
    'dev-windows-stack.cjs',
    'dev-launch-profile.cjs',
    'background-electron-launch.cjs',
    'background-window-policy.cjs',
    'dev-app-runtime.cjs',
    'dev-renderer-server.cjs',
  ]) {
    const original = join(appSource, 'scripts', file);
    if (existsSync(original)) put(appDir, `scripts/${file}`, readFileSync(original, 'utf8'));
  }
  put(
    repoRoot,
    'scripts/check-worktree-port-identity.mjs',
    readFileSync(join(project, 'scripts/check-worktree-port-identity.mjs'), 'utf8')
  );
  put(
    appDir,
    'src/renderer/index.html',
    '<!doctype html><meta name="dnaforge-dev-target" content="unmanaged"><div id="root">Replacement renderer fixture</div><script type="module" src="/App.js"></script>'
  );
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
  const env = {
    NODE_ENV: 'development',
    DESKTOP_DEV_PORT: String(ports.renderer),
    DESKTOP_DEBUG_PORT: String(ports.debug),
    DESKTOP_HMR_PORT: String(ports.hmr),
    API_PORT: String(ports.api),
    VITE_API_URL: `http://127.0.0.1:${ports.api}`,
    DNAFORGE_DEV_TARGET: 'unmanaged',
    VITE_DNAFORGE_DEV_TARGET: 'unmanaged',
    WAYPOINT_TEST: '1',
  };
  recordNativeBuild({ appDir, repoRoot, env });
  return {
    repoRoot,
    appDir,
    env,
    commit,
    nativeFingerprint,
    sidecarFingerprint,
    compiledSourceCommit: git('rev-parse', 'HEAD').trim(),
    inspect: () => inspectNativeBuild({ appDir, repoRoot, env }),
  };
}

const childSource =
  "const fs = require('node:fs');\nconst http = require('node:http');\nconst crypto = require('node:crypto');\nconst vm = require('node:vm');\nconst { execFileSync } = require('node:child_process');\nconst [role, configFile] = process.argv.slice(2);\nconst config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));\nconst initial = config();\nconst sockets = new Set();\nconst write = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };\nlet loadId = 'old-native-load';\nlet sourceCommit = initial.compiledSourceCommit;\nlet sourceFingerprint = initial.initialRendererFingerprint;\nlet reloads = 0;\nconst nativeProvenance = () => ({\n  kind: 'electron-main', pid: process.pid, sidecarPid: config().apiPid,\n  cwd: initial.appDir, appPath: initial.appDir, projectRoot: initial.repoRoot,\n  execPath: process.execPath, desktopDevPort: String(initial.ports.renderer),\n  desktopHmrPort: String(initial.ports.hmr), apiUrl: `http://127.0.0.1:${initial.ports.api}`,\n  buildSourceFingerprint: initial.nativeFingerprint,\n  sidecarSourceFingerprint: initial.sidecarFingerprint,\n});\nconst window = {};\nObject.defineProperty(window, '__WAYPOINT_RENDERER_BUILD__', { get: () => ({ appVersion: 'fixture', mode: 'development', sourceCommit, sourceFingerprint }) });\nwindow.electronAPI = {\n  startup: { getState: () => ({ loadId, pageLoaded: true, shellReady: true }) },\n  runtime: { getProvenance: nativeProvenance },\n};\nconst context = vm.createContext({ window, location: { origin: `http://127.0.0.1:${initial.ports.renderer}` }, JSON, Date });\nfunction send(socket, value) {\n  if (socket.destroyed || !socket.writable || socket.writableEnded) return;\n  const payload = Buffer.from(JSON.stringify(value));\n  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);\n  header[0] = 0x81;\n  if (payload.length < 126) header[1] = payload.length;\n  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }\n  socket.write(Buffer.concat([header, payload]));\n}\nconst server = http.createServer((request, response) => {\n  response.setHeader('Content-Type', 'application/json');\n  if (role === 'main') response.end(JSON.stringify([{ id: 'native-product-window', type: 'page', url: `http://127.0.0.1:${initial.ports.renderer}/`, webSocketDebuggerUrl: `ws://127.0.0.1:${initial.ports.debug}/devtools/page/native-product-window` }]));\n  else response.end(JSON.stringify({ role, pid: process.pid, sidecar_source_fingerprint: initial.sidecarFingerprint, status: 'ok' }));\n});\nif (role === 'main') server.on('upgrade', (request, socket) => {\n  sockets.add(socket); socket.once('close', () => sockets.delete(socket));\n  socket.on('error', error => {\n    if (!['ECONNRESET', 'EPIPE', 'ERR_STREAM_WRITE_AFTER_END'].includes(error.code)) throw error;\n    socket.destroy();\n  });\n  const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');\n  socket.write(`HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ${accept}\\r\\n\\r\\n`);\n  let pending = Buffer.alloc(0);\n  socket.on('data', bytes => {\n    pending = Buffer.concat([pending, bytes]);\n    while (pending.length >= 2) {\n      const opcode = pending[0] & 0x0f; const masked = Boolean(pending[1] & 0x80);\n      let length = pending[1] & 0x7f, offset = 2;\n      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }\n      else if (length === 127) { socket.destroy(); return; }\n      if (pending.length < offset + (masked ? 4 : 0) + length) return;\n      const mask = masked ? pending.subarray(offset, offset + 4) : null; if (masked) offset += 4;\n      const payload = Buffer.from(pending.subarray(offset, offset + length)); pending = pending.subarray(offset + length);\n      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];\n      if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }\n      if (opcode !== 1) continue;\n      const message = JSON.parse(payload.toString('utf8'));\n      fs.appendFileSync(initial.requestsFile, JSON.stringify(message) + '\\n');\n      const handle = async () => {\n        if (message.method === 'Page.reload' || message.method === 'Page.navigate') {\n          const response = await fetch(`http://127.0.0.1:${initial.ports.renderer}/`);\n          if (!response.ok) throw Error('Replacement renderer is not serving');\n          const latest = config(); reloads++;\n          if (latest.mode !== 'stale-load') loadId = `new-native-load-${reloads}`;\n          if (latest.mode !== 'stale-source') {\n            sourceCommit = execFileSync('/usr/bin/git', ['-C', initial.repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();\n            sourceFingerprint = crypto.createHash('sha256').update(fs.readFileSync(initial.rendererFile)).digest('hex');\n          }\n          write(initial.reloadFile, { pid: process.pid, loadId, sourceCommit, sourceFingerprint, reloads });\n          return {};\n        }\n        if (message.method === 'Runtime.evaluate') {\n          const value = await vm.runInContext(message.params.expression, context);\n          return { result: { type: value === null ? 'object' : typeof value, value } };\n        }\n        return {};\n      };\n      handle().then(result => send(socket, { id: message.id, result })).catch(error => send(socket, { id: message.id, result: { exceptionDetails: { text: error.message } } }));\n    }\n  });\n});\nconst port = role === 'main' ? initial.ports.debug : initial.ports[role];\nserver.listen(port, '127.0.0.1', () => write(initial.records[role], { pid: process.pid, cwd: process.cwd(), role, port }));\nprocess.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(() => process.exit(0)); });\n";

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(read, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  assert.fail(message);
}
async function runRecovery(t, mode) {
  const ports = {};
  for (const role of ['renderer', 'debug', 'hmr', 'api', 'unrelated'])
    ports[role] = await freePort();
  const children = [];
  let output = '';
  const f = await fixture(t, ports);
  const root = join(f.appDir, '.cache/recovery');
  mkdirSync(root, { recursive: true });
  const script = put(root, 'process.cjs', childSource);
  const configPath = put(root, 'config.json', {});
  const config = {
    mode,
    ports,
    appDir: f.appDir,
    repoRoot: f.repoRoot,
    rendererFile: join(f.appDir, 'src/renderer/App.js'),
    compiledSourceCommit: f.compiledSourceCommit,
    nativeFingerprint: f.nativeFingerprint,
    initialRendererFingerprint: sha(readFileSync(join(f.appDir, 'src/renderer/App.js'))),
    sidecarFingerprint: f.sidecarFingerprint,
    requestsFile: join(root, 'requests.jsonl'),
    reloadFile: join(root, 'reload.json'),
    records: Object.fromEntries(
      ['main', 'api', 'unrelated'].map((role) => [role, join(root, `${role}.json`)])
    ),
  };
  writeFileSync(configPath, JSON.stringify(config));
  t.after(async () => {
    for (const child of children) if (alive(child.pid)) child.kill('SIGTERM');
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? null
          : Promise.race([once(child, 'exit'), delay(500)])
      )
    );
    for (const port of [ports.renderer, ports.hmr]) {
      let pids = [];
      try {
        pids = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number);
      } catch {}
      for (const pid of pids) {
        const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
          encoding: 'utf8',
        })
          .split('\n')
          .find((line) => line.startsWith('n'))
          ?.slice(1);
        assert.equal(cwd, f.appDir, 'Refusing to stop an unowned recovery fixture listener');
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    }
    for (const child of children) if (alive(child.pid)) child.kill('SIGKILL');
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? null
          : Promise.race([once(child, 'exit'), delay(500)])
      )
    );
    rmSync(f.repoRoot, { recursive: true, force: true });
  });
  for (const role of ['api', 'unrelated', 'main']) {
    const cwd =
      role === 'unrelated'
        ? put(f.repoRoot, 'unrelated/.keep', '').replace('/.keep', '')
        : f.appDir;
    const child = spawn(process.execPath, [script, role, configPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stderr.on('data', (bytes) => {
      output += bytes;
    });
    await until(
      () =>
        existsSync(config.records[role]) && JSON.parse(readFileSync(config.records[role], 'utf8')),
      `Fixture ${role} did not start: ${output}`
    );
    if (role === 'api') {
      config.apiPid = child.pid;
      writeFileSync(configPath, JSON.stringify(config));
    }
  }
  const [api, unrelated, native] = children;
  put(f.appDir, 'src/renderer/App.js', "export const title = 'renderer two';\n");
  f.commit('renderer-only edit while native process runs');
  const expectedCommit = execFileSync('/usr/bin/git', ['-C', f.repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(DNAFORGE_|VITE_|WAYPOINT_|POSTHOG_|SENTRY_|TELEMETRY_|DESKTOP_|API_PORT$|NODE_ENV$|DEV_PORT$|WEB_DEV_PORT$)/.test(
        key
      )
    )
      delete env[key];
  Object.assign(env, f.env, { DNAFORGE_DEV_STARTUP_TIMEOUT_MS: '6000' });
  const launcher = spawn(
    process.execPath,
    [join(f.appDir, 'scripts/dev-single-instance-guard.cjs')],
    { cwd: f.appDir, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(launcher);
  launcher.stdout.on('data', (bytes) => {
    output += bytes;
  });
  launcher.stderr.on('data', (bytes) => {
    output += bytes;
  });
  const done = await Promise.race([
    once(launcher, 'exit').then(([code, signal]) => ({ code, signal })),
    delay(10000, undefined, { ref: false }).then(() => ({ timeout: true })),
  ]);
  const fact = {
    mode,
    ...done,
    nativePid: native.pid,
    nativeAlive: alive(native.pid),
    apiPid: api.pid,
    apiAlive: alive(api.pid),
    unrelatedAlive: alive(unrelated.pid),
    expectedCommit,
    output,
  };
  console.log(`DNA4154_RENDERER_RECOVERY ${JSON.stringify(fact)}`);
  assert.equal(fact.nativeAlive, true, output);
  assert.equal(fact.apiAlive, true, output);
  assert.equal(fact.unrelatedAlive, true, output);
  if (mode === 'normal') {
    assert.equal(
      done.code,
      0,
      `Default launcher did not recover only the owned renderer:\n${output}`
    );
    assert.match(output, /ELECTRON_DEV_READY/);
    const reload = JSON.parse(readFileSync(config.reloadFile, 'utf8'));
    assert.notEqual(reload.loadId, 'old-native-load');
    assert.equal(reload.sourceCommit, expectedCommit);
    assert.equal(reload.sourceFingerprint, sha(readFileSync(config.rendererFile)));
  } else {
    assert.equal(
      done.timeout,
      undefined,
      `Recovery did not terminate within its bounded deadline:\n${output}`
    );
    assert.notEqual(done.code, 0, `Stale ${mode} was declared ready:\n${output}`);
    assert.doesNotMatch(output, /ELECTRON_DEV_READY/);
  }
}

test(
  'default launch restores an owned dead renderer after renderer-only commit without replacing native or sidecar',
  { timeout: 16000 },
  async (t) => runRecovery(t, 'normal')
);

test('recovery refuses the previous renderer load acknowledgement', { timeout: 16000 }, async (t) =>
  runRecovery(t, 'stale-load')
);
test('recovery refuses an obsolete renderer source identity', { timeout: 16000 }, async (t) =>
  runRecovery(t, 'stale-source')
);
