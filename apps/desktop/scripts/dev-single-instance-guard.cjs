#!/usr/bin/env node

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  applyDevLaunchTarget,
  parseDevLaunchTarget,
  readHostedHumanCampaignContract,
  renderedDevLaunchTarget,
  validateHostedStagingReadiness,
} = require('./dev-launch-profile.cjs');
const { configureBackgroundElectronLaunch } = require('./background-electron-launch.cjs');
const { prepareDevelopmentApplication } = require('./dev-app-runtime.cjs');
const { inspectNativeBuild } = require('./dev-native-build-cache.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '../..');

const WORKTREE_IDENTITY_VARS = Object.freeze([
  'DESKTOP_DEV_PORT',
  'DESKTOP_HMR_PORT',
  'API_PORT',
  'VITE_API_URL',
  'DESKTOP_DEBUG_PORT',
  'DEV_PORT',
  'WEB_DEV_PORT',
  'WAYPOINT_WEB_BASE_URL',
  'VITE_CLIENT_LOG_PATH',
]);
const IDENTITY_MISMATCH_TOKEN = 'ELECTRON_DEV_IDENTITY_MISMATCH';
const IDENTITY_CHECK_URL = pathToFileURL(
  path.join(REPO_ROOT, 'scripts/check-worktree-port-identity.mjs')
).href;
const RUNTIME_SOURCE_DIRS = [
  path.join(APP_DIR, 'src/main'),
  path.join(APP_DIR, 'src/preload'),
  path.join(APP_DIR, 'src/shared'),
];
const RUNTIME_SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const RUNTIME_STALE_TOLERANCE_MS = 1000;
const BUILD_ASSERT_FALLBACK_PORT = 1420;
const WINDOWS_GIT_READ_GUARDIAN = 'dna-process-guardian-x86_64-pc-windows-msvc.exe';
let activeLaunch = null;

function startupTimeoutMs() {
  const value = Number(process.env.DNAFORGE_DEV_STARTUP_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 600000;
}

function readEnvFile(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    const raw = trimmed
      .slice(trimmed.indexOf('=') + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    values[key] = raw;
  }
  return values;
}

function applyWorktreeIdentity(target, appEnv, rootEnv) {
  for (const key of WORKTREE_IDENTITY_VARS) {
    const declared = appEnv[key] ?? rootEnv[key];
    if (declared !== undefined) target[key] = declared;
  }
  return target;
}

function fileIdentityValue(key, { appDir = APP_DIR, repoRoot = REPO_ROOT } = {}) {
  const appEnv = readEnvFile(path.join(appDir, '.env.local'));
  const rootEnv = readEnvFile(path.join(repoRoot, '.env.local'));
  return appEnv[key] ?? rootEnv[key];
}

function envValue(key, { env = process.env, appDir = APP_DIR, repoRoot = REPO_ROOT } = {}) {
  const appEnv = readEnvFile(path.join(appDir, '.env.local'));
  const rootEnv = readEnvFile(path.join(repoRoot, '.env.local'));
  if (WORKTREE_IDENTITY_VARS.includes(key)) {
    return appEnv[key] ?? rootEnv[key] ?? env[key];
  }
  return env[key] ?? appEnv[key] ?? rootEnv[key];
}

function devChildEnv({
  env = process.env,
  appDir = APP_DIR,
  repoRoot = REPO_ROOT,
  launchTarget = null,
  platform = process.platform,
  electronBinary,
} = {}) {
  const appEnv = readEnvFile(path.join(appDir, '.env.local'));
  const rootEnv = readEnvFile(path.join(repoRoot, '.env.local'));
  const merged = applyWorktreeIdentity({ ...rootEnv, ...appEnv, ...env }, appEnv, rootEnv);
  delete merged.NO_COLOR;

  if (appEnv.VITE_API_URL === undefined && rootEnv.VITE_API_URL === undefined) {
    const fileApiPort = appEnv.API_PORT ?? rootEnv.API_PORT;
    if (fileApiPort) {
      merged.VITE_API_URL = `http://127.0.0.1:${fileApiPort}`;
    } else if (!merged.VITE_API_URL) {
      if (merged.API_PORT) merged.VITE_API_URL = `http://127.0.0.1:${merged.API_PORT}`;
      else delete merged.VITE_API_URL;
    }
  }
  const renderer = Number.parseInt(merged.DESKTOP_DEV_PORT ?? '', 10);
  if (Number.isInteger(renderer)) {
    merged.DESKTOP_DEBUG_PORT = String(desktopDebugPort(renderer, { appDir, repoRoot }));
  } else {
    delete merged.DESKTOP_DEBUG_PORT;
  }
  if (launchTarget === null) {
    merged.DNAFORGE_DEV_TARGET = 'unmanaged';
    merged.VITE_DNAFORGE_DEV_TARGET = 'unmanaged';
  }
  return configureBackgroundElectronLaunch(
    applyDevLaunchTarget(merged, launchTarget),
    platform,
    electronBinary,
    appDir
  );
}

let identityCheckModulePromise;

function loadIdentityCheck() {
  identityCheckModulePromise ??= import(IDENTITY_CHECK_URL);
  return identityCheckModulePromise;
}

async function assertWorktreeIdentity({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  const { checkWorktreePortIdentity } = await loadIdentityCheck();
  const verdict = checkWorktreePortIdentity({ repoRoot, env });
  if (!verdict.ok) {
    const error = new Error(verdict.message);
    error.code = 'WORKTREE_PORT_IDENTITY';
    throw error;
  }
  return verdict;
}

function parseRequiredDesktopDevPort(raw) {
  if (!/^\d+$/.test(raw ?? '')) {
    throw new Error(
      'DESKTOP_DEV_PORT is required and must be an integer. Refusing to default to port 1420 because that can launch against the installed app profile.'
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('DESKTOP_DEV_PORT must be an integer between 1 and 65535.');
  }
  return parsed;
}

function resolveDesktopDevPort(raw, { allowBuildFallback = false } = {}) {
  if (allowBuildFallback && (raw === undefined || raw === '')) {
    return BUILD_ASSERT_FALLBACK_PORT;
  }
  return parseRequiredDesktopDevPort(raw);
}

function desktopDevPort(options) {
  return resolveDesktopDevPort(envValue('DESKTOP_DEV_PORT'), options);
}

function desktopDebugPort(rendererPort, options = {}) {
  const fromFile = fileIdentityValue('DESKTOP_DEBUG_PORT', options);
  const parsed = Number.parseInt(fromFile ?? '', 10);
  if (Number.isInteger(parsed)) return parsed;
  return rendererPort >= 1421 ? rendererPort + 7800 : 9223;
}

function portFromEnv(key) {
  const parsed = Number.parseInt(envValue(key) ?? '', 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function uvicornSidecarPids(apiPort) {
  if (!apiPort) return [];
  try {
    const out = execFileSync('pgrep', ['-f', `uvicorn src.main:app --port ${apiPort}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Array.from(
      new Set(
        out
          .split(/\r?\n/)
          .map((s) => Number.parseInt(s, 10))
          .filter(Number.isInteger)
      )
    );
  } catch {
    return [];
  }
}

function sidecarAllPids(apiPort) {
  if (!apiPort) return [];
  return Array.from(new Set([...listenerPids(apiPort), ...uvicornSidecarPids(apiPort)]));
}

function httpGet(url, timeoutMs = 750) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({ ok: false, status: 0, body: '', error });
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get(parsed, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ ok: true, status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => {
      resolve({ ok: false, status: 0, body: '', error });
    });
  });
}

async function firstHealthyHttpGet(urls, timeoutMs = 750) {
  const seen = new Set();
  const uniqueUrls = urls.filter((url) => {
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });

  let lastResult = { ok: false, status: 0, body: '' };
  for (const url of uniqueUrls) {
    const result = await httpGet(url, timeoutMs);
    if (result.ok && result.status >= 200 && result.status < 500) {
      return { ...result, url };
    }
    lastResult = { ...result, url };
  }

  return lastResult;
}

function listenerPids(port) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Array.from(
      new Set(
        output
          .split(/\r?\n/)
          .filter((line) => line.startsWith('p'))
          .map((line) => Number.parseInt(line.slice(1), 10))
          .filter(Number.isInteger)
      )
    );
  } catch {
    return [];
  }
}

function tcpPortAcceptsConnections(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (acceptsConnections) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(acceptsConnections);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function processCwd(pid) {
  try {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split(/\r?\n/)
      .find((line) => line.startsWith('n'))
      ?.slice(1);
  } catch {
    return undefined;
  }
}

let linuxClockTicksPerSecond;

function processStartTimeMs(pid) {
  if (process.platform === 'linux') {
    try {
      if (linuxClockTicksPerSecond === undefined) {
        const ticks = Number(
          execFileSync('getconf', ['CLK_TCK'], {
            encoding: 'utf8',
            timeout: 1000,
            killSignal: 'SIGKILL',
          }).trim()
        );
        if (!Number.isFinite(ticks) || ticks <= 0) throw new Error('Invalid process clock rate');
        linuxClockTicksPerSecond = ticks;
      }
      const before = Date.now();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const endOfName = stat.lastIndexOf(')');
      if (endOfName < 0) throw new Error('Invalid process stat');
      const startTicks = Number(
        stat
          .slice(endOfName + 1)
          .trim()
          .split(/\s+/)[19]
      );
      const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
      const observedAt = (before + Date.now()) / 2;
      if (
        !Number.isSafeInteger(startTicks) ||
        startTicks < 0 ||
        !Number.isFinite(uptime) ||
        uptime < 0
      ) {
        throw new Error('Invalid process uptime');
      }
      return observedAt - (uptime - startTicks / linuxClockTicksPerSecond) * 1000;
    } catch {}
  }
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = Date.parse(output);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRuntimeSourceFile(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  const basename = path.basename(filePath);
  if (!RUNTIME_SOURCE_EXTENSIONS.has(path.extname(filePath))) return false;
  if (normalized.includes('/__tests__/')) return false;
  if (normalized.includes('/test/')) return false;
  if (/[.-](test|spec)\.[cm]?[jt]sx?$/.test(basename)) return false;
  return true;
}

function newestRuntimeSourceMtime(sourceDirs = RUNTIME_SOURCE_DIRS) {
  let newest;

  function visit(directoryPath) {
    let entries;
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out')
          continue;
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !isRuntimeSourceFile(entryPath)) continue;

      const stat = fs.statSync(entryPath);
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { path: entryPath, mtimeMs: stat.mtimeMs };
      }
    }
  }

  for (const sourceDir of sourceDirs) {
    visit(sourceDir);
  }

  return newest;
}

function evaluateRuntimeSourceFreshness({
  debugPids = [],
  newestSource = newestRuntimeSourceMtime(),
  getProcessStartTimeMs = processStartTimeMs,
  staleToleranceMs = RUNTIME_STALE_TOLERANCE_MS,
} = {}) {
  const processStarts = debugPids
    .map((pid) => ({ pid, startMs: getProcessStartTimeMs(pid) }))
    .filter((entry) => Number.isFinite(entry.startMs));

  if (!newestSource || processStarts.length === 0) {
    return { stale: false, newestSource, processStarts, staleToleranceMs };
  }

  const oldestProcessStart = processStarts.reduce((oldest, entry) =>
    entry.startMs < oldest.startMs ? entry : oldest
  );
  const stale = newestSource.mtimeMs > oldestProcessStart.startMs + staleToleranceMs;
  return {
    stale,
    newestSource,
    oldestProcessStart,
    processStarts,
    staleToleranceMs,
  };
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidsToExit(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidIsAlive(pid))) return true;
    await sleep(150);
  }
  return pids.every((pid) => !pidIsAlive(pid));
}

function expectedRendererUrls(rendererPort) {
  return [
    `http://localhost:${rendererPort}/`,
    `http://127.0.0.1:${rendererPort}/`,
    `http://[::1]:${rendererPort}/`,
  ];
}

function rendererProbeUrls(rendererPort, targetPage) {
  return [targetPage?.url, ...expectedRendererUrls(rendererPort)].filter(
    (url) => typeof url === 'string' && url.length > 0
  );
}

async function probe(rendererPort, debugPort) {
  const cdpList = await httpGet(`http://127.0.0.1:${debugPort}/json/list`);
  const debugPids = listenerPids(debugPort);
  const rendererPids = listenerPids(rendererPort);

  let pages = [];
  if (cdpList.ok) {
    try {
      pages = JSON.parse(cdpList.body);
    } catch {
      pages = [];
    }
  }

  const expectedUrls = expectedRendererUrls(rendererPort);
  const targetPage = pages.find(
    (page) =>
      page?.type === 'page' &&
      typeof page.url === 'string' &&
      expectedUrls.some((url) => page.url === url || page.url.startsWith(`${url}?`))
  );

  const renderer = await firstHealthyHttpGet(rendererProbeUrls(rendererPort, targetPage));
  const rendererHealthy = renderer.ok && renderer.status >= 200 && renderer.status < 500;
  const cdpHealthy = cdpList.ok && Array.isArray(pages);
  const devLaunchTarget = rendererHealthy ? renderedDevLaunchTarget(renderer.body) : null;

  if (cdpHealthy && targetPage && rendererHealthy) {
    const runtimeFreshness = evaluateRuntimeSourceFreshness({ debugPids });
    if (runtimeFreshness.stale) {
      return {
        kind: 'stale-runtime',
        rendererPort,
        debugPort,
        debugPids,
        rendererPids,
        targetPage,
        devLaunchTarget,
        runtimeFreshness,
      };
    }
    return {
      kind: 'healthy',
      rendererPort,
      debugPort,
      debugPids,
      rendererPids,
      targetPage,
      devLaunchTarget,
    };
  }
  if (cdpHealthy && targetPage && !rendererHealthy) {
    return {
      kind: 'stale-renderer',
      rendererPort,
      debugPort,
      debugPids,
      rendererPids,
      targetPage,
      devLaunchTarget,
    };
  }
  if (debugPids.length > 0 && !cdpHealthy) {
    return { kind: 'stale-debug-port', rendererPort, debugPort, debugPids, rendererPids };
  }
  if (cdpHealthy && !targetPage) {
    return { kind: 'debug-port-conflict', rendererPort, debugPort, debugPids, rendererPids, pages };
  }
  if (rendererHealthy) {
    return { kind: 'renderer-only', rendererPort, debugPort, debugPids, rendererPids };
  }
  return { kind: 'not-running', rendererPort, debugPort, debugPids, rendererPids };
}

function printState(state) {
  const debugPidText = state.debugPids.length ? state.debugPids.join(', ') : 'none';
  const rendererPidText = state.rendererPids.length ? state.rendererPids.join(', ') : 'none';
  const rendererUrl = state.targetPage?.url
    ? `${new URL(state.targetPage.url).origin}/`
    : `http://localhost:${state.rendererPort}/`;
  console.log(`Desktop renderer: ${rendererUrl}`);
  console.log(`DevTools/CDP:     http://127.0.0.1:${state.debugPort}/json/list`);
  console.log(`Electron PID(s):  ${debugPidText}`);
  console.log(`Renderer PID(s):  ${rendererPidText}`);
  console.log(`Launch target:    ${state.devLaunchTarget ?? 'unknown'}`);
  if (state.runtimeFreshness?.stale) {
    const newest = state.runtimeFreshness.newestSource;
    const oldest = state.runtimeFreshness.oldestProcessStart;
    const relativeSource = newest?.path ? path.relative(REPO_ROOT, newest.path) : 'unknown';
    const sourceTime = newest?.mtimeMs ? new Date(newest.mtimeMs).toISOString() : 'unknown';
    const processTime = oldest?.startMs ? new Date(oldest.startMs).toISOString() : 'unknown';
    console.log(`Newest runtime source: ${relativeSource} (${sourceTime})`);
    console.log(`Oldest Electron start: PID ${oldest?.pid ?? 'unknown'} (${processTime})`);
  }
}

function envLocalIsDangling(envPath) {
  try {
    const st = fs.lstatSync(envPath);
    return st.isSymbolicLink() && !fs.existsSync(envPath);
  } catch {
    return false;
  }
}

function inheritedIdentityKeys(env = process.env) {
  return WORKTREE_IDENTITY_VARS.filter((key) => {
    const value = env[key];
    return value !== undefined && value !== '';
  });
}

function inheritedUnsafeDanglingIdentityKeys(env = process.env) {
  return inheritedIdentityKeys(env).filter(
    (key) =>
      key === 'DESKTOP_DEV_PORT' ||
      key === 'DESKTOP_HMR_PORT' ||
      key === 'DESKTOP_DEBUG_PORT' ||
      key === 'API_PORT'
  );
}

function ensureAppEnvLocal({
  appDir = APP_DIR,
  repoRoot = REPO_ROOT,
  allowExampleCopy = false,
} = {}) {
  const envPath = path.join(appDir, '.env.local');
  const rootEnv = path.join(repoRoot, '.env.local');
  const examplePath = path.join(appDir, '.env.local.example');
  const relativeRoot = path.relative(appDir, rootEnv) || '../../.env.local';

  let st = null;
  try {
    st = fs.lstatSync(envPath);
  } catch {
    st = null;
  }
  const dangling = Boolean(st?.isSymbolicLink() && !fs.existsSync(envPath));
  if (st && !dangling) return null;

  const canReplace = fs.existsSync(rootEnv) || (allowExampleCopy && fs.existsSync(examplePath));

  if (dangling && !canReplace) return null;

  if (dangling) fs.unlinkSync(envPath);

  if (fs.existsSync(rootEnv)) {
    fs.symlinkSync(relativeRoot, envPath);
    return envPath;
  }

  if (allowExampleCopy && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    return envPath;
  }
  return null;
}

function runStartPreflight(
  launchTarget,
  { appDir = APP_DIR, repoRoot = REPO_ROOT, env = process.env, execute = execFileSync } = {}
) {
  execute(process.execPath, [path.join(appDir, 'scripts', 'prepare-opendataloader-runtime.cjs')], {
    cwd: appDir,
    env: devChildEnv({ launchTarget, appDir, repoRoot, env }),
    stdio: 'inherit',
    timeout: Math.max(
      1,
      Math.min(
        Number(env.DNAFORGE_DEV_STARTUP_TIMEOUT_MS) || 120000,
        activeLaunch ? activeLaunch.startedAt + startupTimeoutMs() - Date.now() : Infinity
      )
    ),
    killSignal: 'SIGKILL',
  });
}

function reportIdentityFailure(error, env = process.env) {
  console.log(IDENTITY_MISMATCH_TOKEN);
  console.error(IDENTITY_MISMATCH_TOKEN);
  for (const key of WORKTREE_IDENTITY_VARS) {
    const inherited = env[key];
    if (!inherited) continue;
    const port = Number.parseInt(inherited, 10);
    if (!Number.isInteger(port)) continue;
    const pids = listenerPids(port);
    if (!pids.length) continue;
    const cwds = pids.map((pid) => processCwd(pid)).filter(Boolean);
    console.error(
      `  inherited ${key}=${inherited} still bound by PIDs ${pids.join(', ')}` +
        (cwds.length ? ` cwd=${cwds.join('; ')}` : '')
    );
  }
  console.error(`[worktree-port-identity] ${error.message}`);
  console.error(
    "unset + this worktree's `dev:stop` will not touch those inherited-port processes. Stop them from the worktree that owns them (`npm run dev:stop` there). Do not kill the sidecar PID alone — its reloader can respawn it (BAD_SESSION)."
  );
}

async function runHostedStagingReadinessPreflight(launchTarget, get = httpGet) {
  if (launchTarget === null) return null;
  const readyUrl = new URL('/readyz', `${launchTarget.gatewayOrigin}/`).toString();
  const response = await get(readyUrl, 10_000);
  if (!response.ok || response.status !== 200) {
    throw new Error(
      `Hosted staging readiness rejected: ${readyUrl} returned HTTP ${response.status || 'unreachable'}.`
    );
  }
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error('Hosted staging readiness rejected: response was not valid JSON.');
  }
  const summary = validateHostedStagingReadiness(
    payload,
    readHostedHumanCampaignContract(REPO_ROOT)
  );
  console.log('HOSTED_STAGING_PREFLIGHT_PASS');
  console.log(`Gateway SHA:      ${summary.deployedGitSha}`);
  console.log(`Campaign:         ${summary.campaignId}`);
  console.log(`Catalog:          ${summary.catalogVersion}`);
  return summary;
}

function assertRequestedLaunchTarget(requested, running) {
  if (requested === null || running === requested.name) return;
  throw new Error(
    `ELECTRON_DEV_TARGET_MISMATCH: requested ${requested.name}, running ${running ?? 'unknown'}. ` +
      'No process was killed. Stop this worktree with npm run dev:stop, then run the requested launcher again.'
  );
}

function ensureWindowsGitReadGuardian({
  platform = process.platform,
  appDir = APP_DIR,
  guardianPath = path.join(appDir, 'resources', 'helpers', WINDOWS_GIT_READ_GUARDIAN),
  pathExists = fs.existsSync,
  execute = execFileSync,
  build,
} = {}) {
  const runBuild =
    build ??
    (() =>
      execute(
        process.execPath,
        [path.join(appDir, 'scripts', 'build-helpers.cjs'), 'dna-process-guardian'],
        {
          cwd: appDir,
          stdio: 'inherit',
        }
      ));
  if (platform !== 'win32') return null;

  runBuild();
  if (!pathExists(guardianPath)) {
    throw new Error(
      `Windows Git process guardian build completed without creating ${guardianPath}.`
    );
  }
  return guardianPath;
}

function electronViteDevArguments(env, { reuseNativeBuild = false } = {}) {
  const command = ['exec', 'electron-vite', 'dev'];
  if (reuseNativeBuild) command.push('--rendererOnly');
  if (!env.ELECTRON_CLI_ARGS) return command;
  let args;
  try {
    args = JSON.parse(env.ELECTRON_CLI_ARGS);
  } catch {
    throw new Error('ELECTRON_CLI_ARGS must be a JSON array of strings.');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('ELECTRON_CLI_ARGS must be a JSON array of strings.');
  }
  return args.length > 0 ? [...command, '--', ...args] : command;
}

function ensureBundledGitRuntime({
  appDir = APP_DIR,
  execute = execFileSync,
  timeoutMs = 120000,
} = {}) {
  const provisioner = path.join(appDir, 'scripts', 'ensure-dugite-git.cjs');
  execute(process.execPath, [provisioner], {
    cwd: appDir,
    stdio: 'inherit',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  return provisioner;
}

async function readStartupAcknowledgement(targetPage, debugPort, timeoutMs = 700) {
  if (!targetPage?.webSocketDebuggerUrl) return null;
  const url = new URL(targetPage.webSocketDebuggerUrl);
  if (
    url.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    Number(url.port) !== debugPort
  )
    return null;
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      socket = new WebSocket(url);
    } catch {
      finish(null);
      return;
    }
    socket.addEventListener('error', () => finish(null));
    socket.addEventListener('close', () => finish(null));
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: 'window.electronAPI?.startup?.getState?.() ?? null',
            awaitPromise: true,
            returnByValue: true,
          },
        })
      )
    );
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id === 1) finish(message.result?.result?.value ?? null);
      } catch {
        finish(null);
      }
    });
  });
}

async function rendererCommand(targetPage, debugPort, method, params = {}, timeoutMs = 1000) {
  const url = new URL(targetPage.webSocketDebuggerUrl);
  if (
    url.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    Number(url.port) !== debugPort
  )
    throw new Error('Renderer debugger identity differs');
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error('Renderer debugger deadline exceeded')),
      timeoutMs
    );
    try {
      socket = new WebSocket(url);
      socket.addEventListener('error', () => finish(new Error('Renderer debugger disconnected')));
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id !== 1) return;
          if (message.error || message.result?.exceptionDetails)
            finish(new Error('Renderer debugger command failed'));
          else finish(null, message.result);
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function rendererRuntimeState(state, timeoutMs = 1000) {
  const result = await rendererCommand(
    state.targetPage,
    state.debugPort,
    'Runtime.evaluate',
    {
      expression:
        '(async () => ({ startup: await window.electronAPI?.startup?.getState?.(), runtime: await window.electronAPI?.runtime?.getProvenance?.(), build: window.__WAYPOINT_RENDERER_BUILD__ }))()',
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs
  );
  return result?.result?.value;
}

async function recoverOwnedRenderer(state, launchTarget) {
  const startedAt = Date.now();
  const deadline = startedAt + startupTimeoutMs();
  const env = devChildEnv({ launchTarget });
  const nativeBuild = inspectNativeBuild({ appDir: APP_DIR, repoRoot: REPO_ROOT, env });
  if (!nativeBuild.reusable || !nativeBuild.nativeInputsCompatible) {
    console.log(`ELECTRON_DEV_RENDERER_RECOVERY_UNAVAILABLE ${nativeBuild.reason}`);
    return false;
  }
  let previous;
  try {
    previous = await rendererRuntimeState(state);
    const runtime = previous?.runtime;
    const apiPort = portFromEnv('API_PORT');
    const apiPids = apiPort ? listenerPids(apiPort) : [];
    const ownedCwd = (pid) => {
      const cwd = processCwd(pid);
      return cwd && (cwd === REPO_ROOT || cwd.startsWith(REPO_ROOT + path.sep));
    };
    const api = new URL(runtime?.apiUrl);
    if (
      !previous?.startup?.loadId ||
      runtime?.kind !== 'electron-main' ||
      state.debugPids.length !== 1 ||
      state.debugPids[0] !== runtime.pid ||
      !ownedCwd(runtime.pid) ||
      fs.realpathSync(runtime.projectRoot) !== REPO_ROOT ||
      fs.realpathSync(runtime.appPath) !== APP_DIR ||
      Number(runtime.desktopDevPort) !== state.rendererPort ||
      Number(runtime.desktopHmrPort) !== portFromEnv('DESKTOP_HMR_PORT') ||
      runtime.buildSourceFingerprint !== nativeBuild.buildSourceFingerprint ||
      runtime.sidecarSourceFingerprint !== nativeBuild.sidecarSourceFingerprint ||
      !Number.isInteger(runtime.sidecarPid) ||
      !apiPids.includes(runtime.sidecarPid) ||
      !ownedCwd(runtime.sidecarPid) ||
      api.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) ||
      Number(api.port) !== apiPort
    )
      throw new Error('Native or sidecar ownership and compilation identity differs');
    if (state.rendererPids.length || listenerPids(portFromEnv('DESKTOP_HMR_PORT')).length)
      throw new Error('Renderer or HMR port is already owned by a process');
  } catch (error) {
    console.log(`ELECTRON_DEV_RENDERER_RECOVERY_UNAVAILABLE ${error.message}`);
    return false;
  }
  console.log(
    `ELECTRON_DEV_STARTING ${JSON.stringify({
      phase: 'renderer-recovery',
      startedAt,
      nativePid: previous.runtime.pid,
      sidecarPid: previous.runtime.sidecarPid,
      compiledSourceCommit: nativeBuild.compiledSourceCommit,
    })}`
  );
  const logPath = path.join(APP_DIR, '.cache/renderer-recovery.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(APP_DIR, 'scripts/dev-renderer-server.cjs')], {
      cwd: APP_DIR,
      env,
      detached: true,
      stdio: ['ignore', log, log, 'ipc'],
    });
  } finally {
    fs.closeSync(log);
  }
  let expected;
  let lastProbe;
  let lastRenderer;
  let lastRendererError;
  let probeCount = 0;
  const recoveryTimings = {};
  try {
    expected = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Renderer server startup deadline exceeded')),
        Math.max(1, deadline - Date.now())
      );
      const finish = (error, value) => {
        clearTimeout(timer);
        child.removeListener('message', message);
        child.removeListener('error', failed);
        child.removeListener('exit', exited);
        if (error) reject(error);
        else resolve(value);
      };
      const failed = (error) => finish(error);
      const exited = () => finish(new Error('Renderer server exited before listening'));
      const message = (value) => {
        if (value?.kind === 'renderer-failed') finish(new Error(value.reason));
        if (
          value?.kind === 'renderer-listening' &&
          value.pid === child.pid &&
          /^[a-f0-9]{40}$/.test(value.sourceCommit) &&
          /^[a-f0-9]{64}$/.test(value.sourceFingerprint)
        )
          finish(null, value);
      };
      child.on('message', message);
      child.once('error', failed);
      child.once('exit', exited);
    });
    recoveryTimings.listeningMs = Date.now() - startedAt;
    await rendererCommand(
      state.targetPage,
      state.debugPort,
      'Page.reload',
      {},
      Math.max(1, Math.min(2000, deadline - Date.now()))
    );
    recoveryTimings.reloadMs = Date.now() - startedAt;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Replacement renderer exited');
      probeCount += 1;
      const current = await probe(state.rendererPort, state.debugPort);
      lastProbe = {
        kind: current.kind,
        debugPids: current.debugPids,
        rendererPids: current.rendererPids,
        runtimeFreshness: current.runtimeFreshness,
      };
      if (current.kind === 'healthy') {
        const observed = await rendererRuntimeState(
          current,
          Math.max(1, Math.min(1000, deadline - Date.now()))
        ).catch((error) => {
          lastRendererError = { reason: error.message, elapsedMs: Date.now() - startedAt };
          return null;
        });
        if (observed) lastRenderer = {
          loadId: observed.startup?.loadId,
          pageLoaded: observed.startup?.pageLoaded,
          shellReady: observed.startup?.shellReady,
          nativePid: observed.runtime?.pid,
          sidecarPid: observed.runtime?.sidecarPid,
          sourceCommit: observed.build?.sourceCommit,
          sourceFingerprint: observed.build?.sourceFingerprint,
        };
        if (
          observed?.startup?.pageLoaded === true &&
          observed.startup.shellReady === true &&
          observed.startup.loadId &&
          observed.startup.loadId !== previous.startup.loadId &&
          observed.runtime?.pid === previous.runtime.pid &&
          observed.runtime.sidecarPid === previous.runtime.sidecarPid &&
          observed.build?.sourceCommit === expected.sourceCommit &&
          observed.build.sourceFingerprint === expected.sourceFingerprint
        ) {
          assertRequestedLaunchTarget(launchTarget, current.devLaunchTarget);
          const finalBuild = inspectNativeBuild({ appDir: APP_DIR, repoRoot: REPO_ROOT, env });
          if (!finalBuild.nativeInputsCompatible || finalBuild.source !== nativeBuild.source)
            throw new Error('Source changed while recovering the renderer');
          child.disconnect();
          child.unref();
          console.log(
            `ELECTRON_DEV_READY ${JSON.stringify({
              ready: true,
              reason: 'Owned renderer recovered without rebuilding native code',
              rendererPort: state.rendererPort,
              debugPort: state.debugPort,
              nativePid: previous.runtime.pid,
              sidecarPid: previous.runtime.sidecarPid,
              rendererPid: child.pid,
              loadId: observed.startup.loadId,
              compiledSourceCommit: nativeBuild.compiledSourceCommit,
              rendererSourceCommit: expected.sourceCommit,
              elapsedMs: Date.now() - startedAt,
            })}`
          );
          return true;
        }
      }
      await sleep(Math.max(1, Math.min(100, deadline - Date.now())));
    }
    throw new Error('Renderer recovery deadline exceeded without a new current-source ready load');
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null)
      await terminatePids([child.pid], true, 2000);
    console.error(
      `ELECTRON_DEV_START_FAILED ${JSON.stringify({
        ready: false,
        reason: error.message,
        phase: 'renderer-recovery',
        logPath,
        nativePid: previous.runtime.pid,
        sidecarPid: previous.runtime.sidecarPid,
        elapsedMs: Date.now() - startedAt,
        expectedRenderer: expected,
        lastProbe,
        lastRenderer,
        lastRendererError,
        probeCount,
        recoveryTimings,
      })}`
    );
    process.exitCode = 2;
    return true;
  }
}

async function waitForDevReady({ child, startedAt, rendererPort, debugPort }) {
  const timeoutMs = startupTimeoutMs();
  const deadline = startedAt + timeoutMs;
  let state = { debugPids: [], rendererPids: [] };
  const outcome = (ready, reason, startup) => ({
    ready,
    reason,
    rendererPort,
    debugPort,
    debugPids: state.debugPids,
    rendererPids: state.rendererPids,
    childPid: child?.pid ?? null,
    elapsedMs: Date.now() - startedAt,
    ...(startup ? { loadId: startup.loadId } : {}),
  });
  while (Date.now() < deadline) {
    if (child?.startError) return outcome(false, `Launcher child failed: ${child.startError}`);
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      return outcome(false, `Launcher child exited: ${child.exitCode ?? child.signalCode}`);
    }
    state = await probe(rendererPort, debugPort);
    if (state.kind === 'healthy') {
      const startup = await readStartupAcknowledgement(
        state.targetPage,
        debugPort,
        Math.max(1, Math.min(700, deadline - Date.now()))
      );
      if (
        startup?.pageLoaded === true &&
        startup.shellReady === true &&
        typeof startup.loadId === 'string' &&
        startup.loadId.length > 0
      ) {
        return outcome(true, 'Current renderer shell acknowledged ready', startup);
      }
    }
    await sleep(Math.max(1, Math.min(100, deadline - Date.now())));
  }
  return outcome(
    false,
    `Startup deadline exceeded without a ready shell (${state.kind ?? 'unknown'})`
  );
}

async function stopNewLaunchProcesses(child, startedAt, outcome) {
  const ports = [
    outcome.rendererPort,
    outcome.debugPort,
    portFromEnv('DESKTOP_HMR_PORT'),
    portFromEnv('API_PORT'),
  ].filter(Number.isInteger);
  const candidates = new Set([child.pid, ...ports.flatMap(listenerPids)]);
  if (process.platform !== 'win32') {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const descendants = new Set([child.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows)
        if (descendants.has(parent) && !descendants.has(pid)) {
          descendants.add(pid);
          changed = true;
        }
    }
    for (const pid of descendants) candidates.add(pid);
  }
  const owned = [...candidates].filter((pid) => {
    if (pid === child.pid) return pidIsAlive(pid);
    const started = processStartTimeMs(pid);
    const cwd = processCwd(pid);
    return (
      started !== undefined &&
      started >= startedAt - 1000 &&
      cwd &&
      (cwd === REPO_ROOT || cwd.startsWith(REPO_ROOT + path.sep))
    );
  });
  await terminatePids(owned, true);
}

function currentNativeDiagnostics(startedAt, applicationRoot) {
  try {
    const cache = path.join(APP_DIR, '.cache/dnaforge-dev-runtime');
    const metadataPath = path.join(cache, 'last-launch.json');
    if (fs.statSync(metadataPath).size > 65536) return null;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const launchTime = Date.parse(metadata.startedAt);
    if (
      !Number.isFinite(launchTime) ||
      launchTime < startedAt ||
      launchTime > Date.now() ||
      metadata.applicationRoot !== applicationRoot ||
      !Number.isInteger(metadata.launcherPid) ||
      metadata.launcherPid <= 0 ||
      metadata.stdout === metadata.stderr
    )
      return null;
    const launches = fs.realpathSync(path.join(cache, 'launches'));
    const streams = {};
    for (const name of ['stdout', 'stderr']) {
      const file = metadata[name];
      if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
      const actual = fs.realpathSync(file);
      const stat = fs.statSync(actual);
      if (!actual.startsWith(launches + path.sep) || !stat.isFile()) return null;
      streams[name] = file;
      streams[`${name}Bytes`] = stat.size;
    }
    return {
      metadataPath,
      applicationRoot,
      launcherPid: metadata.launcherPid,
      startedAt: metadata.startedAt,
      observedAt: new Date().toISOString(),
      ...streams,
    };
  } catch {
    return null;
  }
}

async function startRawDev(launchTarget) {
  const startedAt = Date.now();
  const remaining = () => {
    const value = startedAt + startupTimeoutMs() - Date.now();
    if (value <= 0) throw new Error('Startup deadline exceeded during launch preparation');
    return value;
  };
  activeLaunch = {
    startedAt,
    rendererPort: desktopDevPort(),
    debugPort: desktopDebugPort(desktopDevPort()),
    childPid: null,
  };
  console.log(`ELECTRON_DEV_STARTING ${JSON.stringify({ ...activeLaunch, phase: 'preflight' })}`);
  ensureAppEnvLocal({ allowExampleCopy: true });
  try {
    await assertWorktreeIdentity();
  } catch (error) {
    if (error && error.code === 'WORKTREE_PORT_IDENTITY') {
      reportIdentityFailure(error);
      process.exit(1);
    }
    throw error;
  }

  ensureBundledGitRuntime({ timeoutMs: remaining() });
  ensureWindowsGitReadGuardian();
  remaining();
  runStartPreflight(launchTarget);
  await runHostedStagingReadinessPreflight(launchTarget);
  const initialEnv = devChildEnv({ launchTarget });
  const nativeBuild = inspectNativeBuild({ appDir: APP_DIR, repoRoot: REPO_ROOT, env: initialEnv });
  console.log(
    `Native dev build: ${nativeBuild.reusable ? 'reuse' : 'compile'} (${nativeBuild.reason})`
  );
  const runtime = await prepareDevelopmentApplication({
    appDirectory: APP_DIR,
    electronBinary: require('electron'),
    env: initialEnv,
    timeoutMs: remaining(),
  });
  activeLaunch.applicationRoot = path.resolve(path.dirname(runtime.electronBinary), '../..');
  const childEnv = devChildEnv({
    launchTarget,
    env: {
      ...initialEnv,
      ...runtime.env,
      DNAFORGE_DEV_BUILD_SOURCE_KEY: nativeBuild.source || '',
      DNAFORGE_DEV_BUILD_ENV_KEY: nativeBuild.environment,
    },
    electronBinary: runtime.electronBinary,
  });
  console.log(`Launch target:    ${childEnv.DNAFORGE_DEV_TARGET}`);
  if (launchTarget !== null) {
    console.log(`Web authority:    ${launchTarget.webBaseUrl}`);
    console.log(`Gateway authority: ${launchTarget.gatewayOrigin}`);
  }
  remaining();
  const child = spawn(
    'pnpm',
    electronViteDevArguments(childEnv, { reuseNativeBuild: nativeBuild.reusable }),
    {
      cwd: APP_DIR,
      env: childEnv,
      stdio: 'inherit',

      shell: process.platform === 'win32',
    }
  );
  activeLaunch.childPid = child.pid;
  child.on('error', (error) => {
    child.startError = error.message;
  });
  const outcome = await waitForDevReady({
    child,
    startedAt,
    rendererPort: desktopDevPort(),
    debugPort: desktopDebugPort(desktopDevPort()),
  });
  if (!outcome.ready) {
    const nativeDiagnostics = currentNativeDiagnostics(startedAt, activeLaunch.applicationRoot);
    if (nativeDiagnostics) outcome.nativeDiagnostics = nativeDiagnostics;
  }
  console.log(
    `${outcome.ready ? 'ELECTRON_DEV_READY' : 'ELECTRON_DEV_START_FAILED'} ${JSON.stringify(outcome)}`
  );
  if (!outcome.ready) {
    await stopNewLaunchProcesses(child, startedAt, outcome);
    process.exitCode = 2;
    return;
  }
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

async function terminatePids(pids, force, graceMs = 5000) {
  const live = pids.filter(pidIsAlive);
  if (live.length === 0) return true;

  for (const pid of live) {
    process.kill(pid, 'SIGTERM');
  }
  if (await waitForPidsToExit(live, graceMs)) return true;

  if (!force) return false;
  for (const pid of live.filter(pidIsAlive)) {
    process.kill(pid, 'SIGKILL');
  }
  return waitForPidsToExit(live, 2000);
}

async function stopWorktreeStack(state) {
  const apiPort = portFromEnv('API_PORT');
  const sweep = [
    ['renderer', state.rendererPort],
    ['hmr', portFromEnv('DESKTOP_HMR_PORT')],
    ['debug/CDP', state.debugPort],
    ['sidecar/API', apiPort],
  ].filter(([, port]) => Number.isInteger(port));
  const pidsAt = (port) => (port === apiPort ? sidecarAllPids(port) : listenerPids(port));
  const assertOwned = (pids) => {
    for (const pid of pids.filter(pidIsAlive)) {
      const cwd = processCwd(pid);
      if (!cwd || !(cwd === REPO_ROOT || cwd.startsWith(REPO_ROOT + path.sep))) {
        if (!pidIsAlive(pid)) continue;
        throw new Error(`Refusing to stop PID ${pid}: ownership of ${APP_DIR} is unverified`);
      }
    }
  };
  assertOwned([...new Set([...state.debugPids, ...sweep.flatMap(([, port]) => pidsAt(port))])]);
  console.log('ELECTRON_DEV_STOPPING');
  printState(state);
  const graceMs = state.kind.startsWith('stale-') ? 2000 : 5000;
  if (!(await terminatePids(state.debugPids, true, graceMs))) return false;
  for (const [, port] of sweep) {
    const pids = pidsAt(port).filter(pidIsAlive);
    assertOwned(pids);
    if (!(await terminatePids(pids, true))) throw new Error(`Owned port ${port} did not stop`);
  }
  const bound = [];
  for (const entry of sweep) {
    if (pidsAt(entry[1]).length > 0 || (await tcpPortAcceptsConnections(entry[1])))
      bound.push(entry);
  }
  if (bound.length)
    throw new Error(
      `Worktree teardown incomplete: ${bound.map(([name, port]) => `${name}:${port}`).join(', ')}`
    );
  console.log('ELECTRON_DEV_STOPPED');
  console.log(
    `Freed ports (incl. sidecar — no orphan): ${sweep.map(([, port]) => port).join(', ')}`
  );
  return true;
}

function printHelp() {
  console.log(`Usage: pnpm --dir apps/desktop run dev [-- --status|--restart-stale|--assert-stopped|--force|--target=hosted-staging]

Default behavior:
  - Reuse a healthy Electron dev instance instead of launching a duplicate.
  - Start Electron when nothing is running.
  - Refuse stale locks/stale runtime code and print the exact restart command.
  - Refuse a shell that inherited another worktree's identity vars .
    Prints ELECTRON_DEV_IDENTITY_MISMATCH. Override with
    ALLOW_FOREIGN_DESKTOP_DEV_PORT=1; this worktree's .env.local still wins.
    Inherited DESKTOP_DEBUG_PORT is ignored (file or DESKTOP_DEV_PORT+7800).

Options:
  --status          Print state and exit without starting or killing anything.
                    May materialize a missing, or repair a dangling,
                    apps/desktop/.env.local symlink to a live root file; does
                    not copy .env.local.example.
  --assert-stopped  Fail unless this worktree's dev runtime is fully stopped.
                    Build commands use this so replacing hashed files in out/
                    cannot invalidate a running Electron main process.
  --restart-stale  Stop the verified stale worktree stack, then start. Escalates to
                   SIGKILL if its processes ignore SIGTERM.
  --force          Accepted for compatibility; stale restart already escalates.
  --stop, --down    Cleanly tear down this worktree's WHOLE dev stack — renderer +
                    HMR + Electron + the Python sidecar (API_PORT). Use this instead
                    of killing Electron by port: a port kill that omits the sidecar
                    orphans it, and the next launch can't rebind API_PORT -> the CLI
                    agent's DNAForge tools fail with BAD_SESSION.

Convenience aliases:
  pnpm --dir apps/desktop run dev:status
  pnpm --dir apps/desktop run dev:restart-stale
  pnpm --dir apps/desktop run dev:stop
  pnpm --dir apps/desktop run dev:hosted-staging
  pnpm --dir apps/desktop run dev:hosted-local  # explicit unsupported-local diagnostic
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const launchTarget = parseDevLaunchTarget(argv);
  if (args.has('--help') || args.has('-h')) {
    printHelp();
    return;
  }

  const appEnvPath = path.join(APP_DIR, '.env.local');
  ensureAppEnvLocal();

  if (envLocalIsDangling(appEnvPath)) {
    const inherited = inheritedUnsafeDanglingIdentityKeys();
    if (inherited.length) {
      const error = new Error(
        `apps/desktop/.env.local is a dangling symlink (root .env.local is gone) and this shell still has ${inherited.join(', ')}.\n` +
          'The guard refuses to start, status, or stop so those inherited ports cannot attach to or tear down another worktree.\n' +
          "The dangling link is left in place so a retry refuses the same way. Restore this worktree's .env.local, or unset those variables."
      );
      error.code = 'WORKTREE_PORT_IDENTITY';
      reportIdentityFailure(error);
      process.exit(1);
    }
  }
  try {
    await assertWorktreeIdentity();
  } catch (error) {
    if (error && error.code === 'WORKTREE_PORT_IDENTITY') {
      reportIdentityFailure(error);
      process.exit(1);
    }
    throw error;
  }

  const rendererPort = desktopDevPort({
    allowBuildFallback: args.has('--assert-stopped'),
  });
  const debugPort = desktopDebugPort(rendererPort);
  const state = await probe(rendererPort, debugPort);

  if (args.has('--assert-stopped')) {
    if (state.kind === 'not-running') {
      console.log('ELECTRON_DEV_OUTPUT_AVAILABLE');
      return;
    }
    console.error('ELECTRON_DEV_OUTPUT_IN_USE');
    printState(state);
    console.error(
      'Stop this worktree dev app before building: pnpm --dir apps/desktop run dev:stop'
    );
    process.exit(2);
  }

  if (args.has('--status')) {
    if (state.kind === 'healthy') {
      const startup = await readStartupAcknowledgement(state.targetPage, debugPort);
      if (
        !(
          startup?.pageLoaded === true &&
          startup.shellReady === true &&
          typeof startup.loadId === 'string' &&
          startup.loadId.length > 0
        )
      ) {
        state.kind = 'starting';
      }
    }
    console.log(`ELECTRON_DEV_${state.kind.toUpperCase().replaceAll('-', '_')}`);
    printState(state);
    assertRequestedLaunchTarget(launchTarget, state.devLaunchTarget ?? null);
    return;
  }

  if (args.has('--stop') || args.has('--down')) {
    await stopWorktreeStack(state);
    return;
  }

  if (state.kind === 'healthy') {
    assertRequestedLaunchTarget(launchTarget, state.devLaunchTarget ?? null);
    const outcome = await waitForDevReady({
      child: null,
      startedAt: Date.now(),
      rendererPort,
      debugPort,
    });
    if (!outcome.ready) {
      console.error(`ELECTRON_DEV_START_FAILED ${JSON.stringify(outcome)}`);
      process.exitCode = 2;
      return;
    }
    console.log('ELECTRON_DEV_ATTACHED');
    printState(state);
    console.log('Reusing the already-running Electron window. Do not launch a second copy.');
    console.log(`ELECTRON_DEV_READY ${JSON.stringify(outcome)}`);
    return;
  }

  if (
    state.kind === 'stale-renderer' ||
    state.kind === 'stale-debug-port' ||
    state.kind === 'stale-runtime'
  ) {
    if (state.kind === 'stale-renderer' && (await recoverOwnedRenderer(state, launchTarget)))
      return;
    console.log(`ELECTRON_DEV_${state.kind.toUpperCase().replaceAll('-', '_')}`);
    printState(state);
    for (const pid of state.debugPids) {
      const cwd = processCwd(pid);
      if (cwd) console.log(`Electron PID ${pid} cwd: ${cwd}`);
    }

    if (!args.has('--restart-stale')) {
      console.log(
        '\nThe existing Electron process owns this worktree lock but is not a healthy attach target.'
      );
      console.log('No process was killed and no duplicate app was launched.');
      console.log(
        'To restart this exact stale worktree instance, run:\n  pnpm --dir apps/desktop run dev -- --restart-stale'
      );
      process.exit(2);
    }

    const stopped = await stopWorktreeStack(state);
    if (!stopped) {
      console.error('Owned stale Electron process did not exit after SIGTERM and SIGKILL.');
      process.exit(2);
    }
    await startRawDev(launchTarget);
    return;
  }

  if (state.kind === 'debug-port-conflict' || state.kind === 'renderer-only') {
    console.log(`ELECTRON_DEV_${state.kind.toUpperCase().replaceAll('-', '_')}`);
    printState(state);
    console.log(
      'No duplicate app was launched because the expected dev ports are already occupied.'
    );
    process.exit(2);
  }

  const apiPort = portFromEnv('API_PORT');
  if (apiPort && (await tcpPortAcceptsConnections(apiPort))) {
    console.error('ELECTRON_DEV_API_PORT_CONFLICT');
    console.error(
      `Sidecar/API port 127.0.0.1:${apiPort} already accepts connections before Electron starts.`
    );
    console.error(
      'No app was launched and no process was killed. Stop the worktree that owns this port, or assign this worktree a free API_PORT and matching VITE_API_URL.'
    );
    process.exit(2);
  }

  await startRawDev(launchTarget);
}

if (require.main === module) {
  main().catch((error) => {
    if (activeLaunch) {
      const nativeDiagnostics = currentNativeDiagnostics(
        activeLaunch.startedAt,
        activeLaunch.applicationRoot
      );
      console.error(
        `ELECTRON_DEV_START_FAILED ${JSON.stringify({
          ready: false,
          reason: error.message,
          ...(nativeDiagnostics ? { nativeDiagnostics } : {}),
          rendererPort: activeLaunch.rendererPort,
          debugPort: activeLaunch.debugPort,
          childPid: activeLaunch.childPid,
          debugPids: [],
          rendererPids: [],
          elapsedMs: Date.now() - activeLaunch.startedAt,
        })}`
      );
    }
    console.error('[dev-single-instance-guard] failed:', error);
    process.exit(1);
  });
}

module.exports = {
  IDENTITY_MISMATCH_TOKEN,
  WORKTREE_IDENTITY_VARS,
  applyWorktreeIdentity,
  assertRequestedLaunchTarget,
  assertWorktreeIdentity,
  desktopDebugPort,
  devChildEnv,
  electronViteDevArguments,
  ensureAppEnvLocal,
  envLocalIsDangling,
  inheritedIdentityKeys,
  inheritedUnsafeDanglingIdentityKeys,
  envValue,
  ensureBundledGitRuntime,
  ensureWindowsGitReadGuardian,
  reportIdentityFailure,
  evaluateRuntimeSourceFreshness,
  expectedRendererUrls,
  firstHealthyHttpGet,
  httpGet,
  isRuntimeSourceFile,
  newestRuntimeSourceMtime,
  processStartTimeMs,
  printState,
  parseRequiredDesktopDevPort,
  resolveDesktopDevPort,
  tcpPortAcceptsConnections,
  probe,
  rendererProbeUrls,
  runHostedStagingReadinessPreflight,
  runStartPreflight,
  readStartupAcknowledgement,
  waitForDevReady,
  stopWorktreeStack,
};
