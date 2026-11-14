import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runPileupPerformanceJourney } from './lib/pileup-performance-journey.mjs';
import { classifyPileupPerformance } from './lib/pileup-performance.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(appDir, '.env.local');
const timeoutMs = Number(process.env.RUN_FROM_SOURCE_TIMEOUT_MS) || 600_000;

function readSettings() {
  assert.ok(
    existsSync(envPath),
    'apps/desktop/.env.local is missing. Copy apps/desktop/.env.local.example to it first.'
  );
  const settings = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (match) settings[match[1]] = match[2].trim();
  }
  const devPort = Number(settings.DESKTOP_DEV_PORT);
  const apiPort = Number(settings.API_PORT);
  assert.ok(Number.isInteger(devPort) && devPort > 0, 'DESKTOP_DEV_PORT is not set');
  assert.ok(Number.isInteger(apiPort) && apiPort > 0, 'API_PORT is not set');
  const explicitDebugPort = Number(settings.DESKTOP_DEBUG_PORT);
  const debugPort =
    Number.isInteger(explicitDebugPort) && explicitDebugPort > 0
      ? explicitDebugPort
      : devPort >= 1421
        ? devPort + 7800
        : 9223;
  return { devPort, apiPort, debugPort };
}

async function getJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function getStatus(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status;
  } catch {
    return 0;
  }
}

function evaluateInPage(webSocketUrl, expression) {
  return new Promise((resolve) => {
    const socket = new WebSocket(webSocketUrl);
    const finish = (value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        resolve(value);
        return;
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 5000);
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        })
      );
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === 1) finish(message.result?.result?.value ?? null);
    });
    socket.addEventListener('error', () => finish(null));
  });
}

async function readStartup({ devPort, debugPort }) {
  const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
  if (!Array.isArray(targets)) return null;
  const page = targets.find(
    (target) =>
      target.type === 'page' &&
      typeof target.webSocketDebuggerUrl === 'string' &&
      new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${devPort}/`, 'u').test(target.url ?? '')
  );
  if (!page) return null;
  const raw = await evaluateInPage(
    page.webSocketDebuggerUrl,
    'Promise.resolve(window.electronAPI?.startup?.getState?.()).then((state) => JSON.stringify({ state: state ?? null, title: document.title }))'
  );
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function stopStack() {
  spawnSync('pnpm', ['run', 'dev', '--', '--stop'], {
    cwd: appDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: 120_000,
  });
}

const ports = readSettings();
const output = [];
const child = spawn('pnpm', ['run', 'dev'], {
  cwd: appDir,
  env: {
    ...process.env,
    DNAFORGE_BACKGROUND_WINDOW: process.env.DNAFORGE_BACKGROUND_WINDOW ?? '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    const text = String(chunk);
    output.push(text);
    process.stdout.write(text);
  });
}

const startedAt = Date.now();
let startup = null;
let sidecar = 0;
let failure = null;
let pileupPerformance = null;
let evidenceDirectory = null;
try {
  for (;;) {
    if (exited) {
      failure = `The dev launcher exited before the app was up (code ${exited.code}, signal ${exited.signal}).`;
      break;
    }
    startup = await readStartup(ports);
    sidecar = await getStatus(`http://127.0.0.1:${ports.apiPort}/health`);
    if (startup?.state?.pageLoaded === true && startup.state.shellReady === true && sidecar === 200)
      break;
    if (Date.now() - startedAt > timeoutMs) {
      failure = `The app was not up after ${Math.round(timeoutMs / 1000)} s.`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!failure) {
    evidenceDirectory = process.env.PILEUP_PERFORMANCE_OUTPUT
      ? path.resolve(process.env.PILEUP_PERFORMANCE_OUTPUT)
      : await mkdtemp(path.join(tmpdir(), 'dnaforge-pileup-performance-'));
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${ports.debugPort}`);
    try {
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) =>
          new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${ports.devPort}/`, 'u').test(
            candidate.url()
          )
        );
      assert.ok(page, 'The source-started desktop renderer is missing.');
      const report = await runPileupPerformanceJourney({
        page,
        output: evidenceDirectory,
        apiPort: ports.apiPort,
      });
      pileupPerformance = classifyPileupPerformance(report);
      await writeFile(
        path.join(evidenceDirectory, 'pileup-performance-result.json'),
        JSON.stringify(pileupPerformance, null, 2)
      );
      console.log(`PILEUP_PERFORMANCE ${JSON.stringify(pileupPerformance)}`);
      if (pileupPerformance.status !== 'pass')
        failure = 'The dense saved-pileup performance journey did not pass.';
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  stopStack();
  if (!exited) child.kill('SIGTERM');
}

const seconds = Math.round((Date.now() - startedAt) / 1000);
const summary = JSON.stringify({
  seconds,
  window: startup?.state ?? null,
  title: startup?.title ?? null,
  sidecarHealthStatus: sidecar,
  pileupPerformanceStatus: pileupPerformance?.status ?? null,
  evidenceDirectory,
});
if (failure) {
  console.error(`RUN_FROM_SOURCE_FAILED ${failure} ${summary}`);
  process.exit(1);
}
console.log(`RUN_FROM_SOURCE_OK ${summary}`);
process.exit(0);
