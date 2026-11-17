import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runPileupPerformanceJourney } from './lib/pileup-performance-journey.mjs';
import { classifyPileupPerformance } from './lib/pileup-performance.mjs';
import { createPileupNativeTrace } from './lib/pileup-native-trace.mjs';
import developmentGuard from './dev-single-instance-guard.cjs';

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
    await mkdir(evidenceDirectory, { recursive: true });
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${ports.debugPort}`);
    const diagnosticEvents = [];
    const diagnosticErrors = [];
    let diagnosticSession;
    let actionTracingContext;
    let runtimeApplicationRoot;
    const instrumentation =
      process.env.PILEUP_PERFORMANCE_DIAGNOSTICS === '1' || process.env.RUNNER_DEBUG === '1'
        ? {
            qualification: false,
            cpuSamplingIntervalUs: 1000,
            tracePhases: ['cold-open-4000bp', 'zoom-26612bp'],
            traceStartup: 'after-fixture-admission-before-cold-open',
            traceCategories: ['CPU', 'GC', 'GPU', 'compositor'],
            networkScope: 'whole-journey',
            actionabilityScope: 'whole-journey-call-log-only',
          }
        : null;
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
      let nativeTrace;
      if (instrumentation) {
        if (process.platform === 'darwin') {
          try {
            const runtime = await page.evaluate(() => window.electronAPI.runtime.getProvenance());
            runtimeApplicationRoot = path.resolve(path.dirname(runtime.execPath), '../..');
          } catch (error) {
            diagnosticErrors.push({ method: 'native-launch-identity', error: String(error) });
          }
        }
        await writeFile(
          path.join(evidenceDirectory, 'instrumentation.json'),
          JSON.stringify(instrumentation, null, 2)
        );
        try {
          const context = page.context();
          await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
          actionTracingContext = context;
          diagnosticSession = await page.context().newCDPSession(page);
          diagnosticSession.on(
            'Network.requestWillBeSent',
            ({ requestId, timestamp, wallTime, request, type }) => {
              diagnosticEvents.push({
                event: 'request',
                requestId,
                timestamp,
                wallTime,
                url: request.url,
                method: request.method,
                type,
              });
            }
          );
          diagnosticSession.on('Network.responseReceived', ({ requestId, timestamp, response }) => {
            diagnosticEvents.push({
              event: 'response',
              requestId,
              timestamp,
              url: response.url,
              status: response.status,
              protocol: response.protocol,
              timing: response.timing,
              connectionReused: response.connectionReused,
              fromDiskCache: response.fromDiskCache,
            });
          });
          diagnosticSession.on(
            'Network.loadingFinished',
            ({ requestId, timestamp, encodedDataLength }) => {
              diagnosticEvents.push({ event: 'finished', requestId, timestamp, encodedDataLength });
            }
          );
          diagnosticSession.on(
            'Network.loadingFailed',
            ({ requestId, timestamp, errorText, canceled }) => {
              diagnosticEvents.push({ event: 'failed', requestId, timestamp, errorText, canceled });
            }
          );
          await diagnosticSession.send('Network.enable');
          const trace = createPileupNativeTrace({
            output: path.join(evidenceDirectory, 'diagnostic'),
            diagnosticOnly: true,
          });
          nativeTrace = Object.fromEntries(
            ['beginJourney', 'start', 'stop', 'finishJourney'].map((method) => [
              method,
              async (input) => {
                try {
                  return await trace[method](input);
                } catch (error) {
                  diagnosticErrors.push({ phase: input.label, method, error: String(error) });
                  return null;
                }
              },
            ])
          );
        } catch (error) {
          diagnosticErrors.push({ method: 'setup', error: String(error) });
        }
      }
      const report = await runPileupPerformanceJourney({
        page,
        output: evidenceDirectory,
        apiPort: ports.apiPort,
        nativeTrace,
      });
      if (instrumentation) {
        report.diagnostics.instrumentation = instrumentation;
        await writeFile(
          path.join(evidenceDirectory, 'pileup-performance-journey.json'),
          JSON.stringify(report, null, 2)
        );
      }
      pileupPerformance = {
        ...classifyPileupPerformance(report),
        ...(instrumentation ? { qualification: false, diagnosticOnly: true } : {}),
      };
      await writeFile(
        path.join(evidenceDirectory, 'pileup-performance-result.json'),
        JSON.stringify(pileupPerformance, null, 2)
      );
      console.log(`PILEUP_PERFORMANCE ${JSON.stringify(pileupPerformance)}`);
      if (pileupPerformance.status !== 'pass')
        failure = 'The dense saved-pileup performance journey did not pass.';
    } finally {
      if (instrumentation) {
        if (actionTracingContext)
          await actionTracingContext.tracing
            .stop({ path: path.join(evidenceDirectory, 'playwright-actions.trace.zip') })
            .catch((error) => {
              diagnosticErrors.push({ method: 'action-trace-stop', error: String(error) });
            });
        try {
          if (diagnosticSession)
            await diagnosticSession.detach().catch((error) => {
              diagnosticErrors.push({ method: 'detach', error: String(error) });
            });
          await writeFile(
            path.join(evidenceDirectory, 'network.json'),
            JSON.stringify(diagnosticEvents, null, 2)
          );
          if (runtimeApplicationRoot) {
            try {
              const native = developmentGuard.currentNativeDiagnostics(
                startedAt,
                runtimeApplicationRoot
              );
              assert.ok(native, 'The current background launch has no owned native logs.');
              const directory = path.join(evidenceDirectory, 'native-launch');
              await mkdir(directory, { recursive: true });
              await Promise.all([
                copyFile(native.metadataPath, path.join(directory, 'launch.json')),
                copyFile(native.stdout, path.join(directory, 'stdout.log')),
                copyFile(native.stderr, path.join(directory, 'stderr.log')),
              ]);
              await writeFile(
                path.join(directory, 'capture.json'),
                JSON.stringify(native, null, 2)
              );
            } catch (error) {
              diagnosticErrors.push({ method: 'native-launch-capture', error: String(error) });
            }
          }
          await writeFile(
            path.join(evidenceDirectory, 'diagnostic-errors.json'),
            JSON.stringify(diagnosticErrors, null, 2)
          );
        } catch (error) {
          console.error(`PILEUP_DIAGNOSTIC_FAILED ${String(error)}`);
        }
      }
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
