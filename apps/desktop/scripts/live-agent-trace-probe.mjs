#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cwd, exit } from 'node:process';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9230';
const VALID_TRANSPORTS = new Set(['codex-sdk', 'claude-agent-sdk']);
const require = createRequire(import.meta.url);

function getWebSocketImpl() {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  try {
    return require('ws');
  } catch {
    throw new Error(
      'No WebSocket implementation available. Install ws or run on Node with WebSocket.'
    );
  }
}

const WebSocketImpl = getWebSocketImpl();
const WS_OPEN = WebSocketImpl.OPEN ?? 1;

function onSocket(socket, event, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(event, handler);
  } else {
    socket.on(event, handler);
  }
}

function parseArgs(argv) {
  const options = {
    cdpUrl: process.env.AGENT_TRACE_PROBE_CDP_URL ?? DEFAULT_CDP_URL,
    workspacePath: process.env.AGENT_TRACE_PROBE_WORKSPACE ?? cwd(),
    transports: ['codex-sdk', 'claude-agent-sdk'],
    includeStop: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    } else if (arg === '--cdp') {
      options.cdpUrl = argv[(i += 1)];
    } else if (arg === '--workspace') {
      options.workspacePath = argv[(i += 1)];
    } else if (arg === '--transport') {
      const transport = argv[(i += 1)];
      if (!VALID_TRANSPORTS.has(transport)) {
        throw new Error(`Unsupported transport: ${transport}`);
      }
      options.transports = [transport];
    } else if (arg === '--all') {
      options.transports = ['codex-sdk', 'claude-agent-sdk'];
    } else if (arg === '--skip-stop') {
      options.includeStop = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node apps/desktop/scripts/live-agent-trace-probe.mjs [options]

Options:
  --cdp <url>          CDP base URL. Default: ${DEFAULT_CDP_URL}
  --workspace <path>   Workspace cwd passed to native CLI chat turns.
  --transport <name>   codex-sdk or claude-agent-sdk. Default: both.
  --all                Probe both supported CLI transports.
  --skip-stop          Run completion probe only.
`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function findPageTarget(cdpUrl) {
  const targets = await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/list`);
  const page = targets.find(
    (target) =>
      target.type === 'page' &&
      target.webSocketDebuggerUrl &&
      !String(target.url ?? '').startsWith('devtools://')
  );
  if (!page) {
    throw new Error(`No Electron page target found at ${cdpUrl}/json/list`);
  }
  return page;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocketImpl(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to CDP')), 10000);
      onSocket(this.socket, 'open', () => {
        clearTimeout(timeout);
        resolve();
      });
      onSocket(this.socket, 'error', (event) => {
        clearTimeout(timeout);
        reject(new Error(`CDP WebSocket error: ${event.message ?? 'unknown'}`));
      });
    });
    onSocket(this.socket, 'close', () => {
      this.rejectPending(new Error('CDP socket closed before the probe completed.'));
    });
    onSocket(this.socket, 'error', (event) => {
      this.rejectPending(new Error(`CDP WebSocket error: ${event.message ?? 'unknown'}`));
    });
    onSocket(this.socket, 'message', (message) => {
      const payload = JSON.parse(String(message.data ?? message));
      if (!payload.id) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
      } else {
        pending.resolve(payload.result);
      }
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new Error('CDP socket is not open');
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.socket?.close();
  }
}

async function runInPage(client, options) {
  const expression = `(${browserProbe.toString()})(${JSON.stringify(options)})`;
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 90000,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  if (result.result.type !== 'string') {
    throw new Error(`Unexpected probe result type: ${result.result.type}`);
  }
  return JSON.parse(result.result.value);
}

async function browserProbe(options) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visibleKinds = new Set([
    'command',
    'error',
    'file_change',
    'permission_denial',
    'reasoning',
    'todo',
    'tool',
    'web_search',
  ]);
  const protocolLabels = new Set([
    'thread.started',
    'turn.started',
    'turn.completed',
    'assistant_text',
    'Turn completed',
  ]);

  function traceSummary(traces) {
    return traces.map((payload) => ({
      queryId: payload.queryId,
      transport: payload.event?.transport,
      sequence: payload.event?.sequence,
      providerEventType: payload.event?.providerEventType,
      providerItemType: payload.event?.providerItemType,
      providerItemId: payload.event?.providerItemId,
      display: payload.event?.display,
      terminal: payload.event?.terminal,
    }));
  }

  function visibleRows(traces) {
    return traceSummary(traces).filter((trace) => {
      const display = trace.display ?? {};
      if (display.visibility === 'diagnostic') return false;
      if (display.visibility === 'chat') return true;
      return visibleKinds.has(display.kind);
    });
  }

  function assertNoProtocolRows(rows) {
    return rows.every(
      (row) =>
        !protocolLabels.has(row.providerEventType) &&
        !protocolLabels.has(row.display?.title) &&
        !protocolLabels.has(row.display?.kind)
    );
  }

  function transportReady(detection, transport) {
    if (transport === 'codex-sdk') {
      return detection.codex?.cli === 'installed' && detection.codex?.auth === 'authenticated';
    }
    if (transport === 'claude-agent-sdk') {
      return detection.claudeCode?.cli === 'installed';
    }
    return false;
  }

  async function runCompletion(api, transport) {
    const queryId = `live-completion-${transport}-${Date.now()}`;
    const traces = [];
    const unsubscribe = api.agentSdk.onTraceEvent((payload) => {
      if (payload?.queryId === queryId) traces.push(payload);
    });
    try {
      const result = await api.agentSdk.query(
        transport,
        [
          'Live DNAForge agent trace probe.',
          'Run a harmless local command if your native CLI tools are available: pwd.',
          'Then reply with exactly: live-trace-complete.',
          'Do not reveal hidden private chain-of-thought.',
        ].join('\n'),
        {
          purpose: 'chat',
          cwd: options.workspacePath,
          queryId,
          emitTrace: true,
          permissionMode: 'native-cli',
        }
      );
      const rows = visibleRows(traces);
      return {
        kind: 'completion',
        transport,
        queryId,
        result,
        visibleRows: rows,
        traceCount: traces.length,
        assertions: {
          resultOk: result?.ok === true,
          hasVisibleActivity: rows.length > 0,
          noProtocolRows: assertNoProtocolRows(rows),
          finalTextMentionsMarker: String(result?.text ?? '').includes('live-trace-complete'),
        },
      };
    } finally {
      unsubscribe();
    }
  }

  async function runStop(api, transport) {
    const queryId = `live-stop-${transport}-${Date.now()}`;
    const traces = [];
    const unsubscribe = api.agentSdk.onTraceEvent((payload) => {
      if (payload?.queryId === queryId) traces.push(payload);
    });
    try {
      const queryPromise = api.agentSdk.query(
        transport,
        [
          'Live DNAForge stop propagation probe.',
          'Run a harmless local command if your native CLI tools are available: pwd.',
          'After the command finishes, reply with exactly: live-stop-final-marker.',
        ].join('\n'),
        {
          purpose: 'chat',
          cwd: options.workspacePath,
          queryId,
          emitTrace: true,
          permissionMode: 'native-cli',
        }
      );

      const providerActionRows = (rows) =>
        rows.filter((row) =>
          transport === 'claude-agent-sdk'
            ? row.display?.kind === 'tool'
            : row.display?.kind === 'command'
        );
      const waitUntil = Date.now() + (transport === 'claude-agent-sdk' ? 40000 : 20000);
      while (Date.now() < waitUntil && providerActionRows(visibleRows(traces)).length === 0) {
        await sleep(100);
      }
      const rowsBeforeCancel = visibleRows(traces);
      const sawProviderActionBeforeStop = providerActionRows(rowsBeforeCancel).length > 0;
      const cancelResult = await api.agentSdk.cancelQuery(queryId);
      const result = await Promise.race([
        queryPromise,
        sleep(45000).then(() => ({
          ok: false,
          text: '',
          error: 'Timed out waiting for stopped query result.',
          stopState: 'failed',
        })),
      ]);
      await sleep(2500);
      const serialized = JSON.stringify({ result, traces: traceSummary(traces) });
      const rows = visibleRows(traces);
      return {
        kind: 'stop',
        transport,
        queryId,
        cancelResult,
        result,
        visibleRows: rows,
        traceCount: traces.length,
        assertions: {
          sawActivityBeforeStop: rowsBeforeCancel.length > 0,
          sawProviderActionBeforeStop,
          cancelAccepted: cancelResult?.ok === true,
          terminalIsStopRequested: result?.stopState === 'stop_requested' || result?.ok === false,
          noLateFinalMarker: !serialized.includes('live-stop-final-marker'),
          noProtocolRows: assertNoProtocolRows(rows),
        },
      };
    } finally {
      unsubscribe();
    }
  }

  const api = window.electronAPI;
  if (!api?.agentSdk) {
    return JSON.stringify({
      ok: false,
      error: 'window.electronAPI.agentSdk is not available in the Electron page.',
    });
  }

  const detection = await api.agentSdk.detect();
  const runs = [];
  for (const transport of options.transports) {
    if (!transportReady(detection, transport)) {
      runs.push({
        transport,
        skipped: true,
        reason: 'CLI missing or unauthenticated',
      });
      continue;
    }
    runs.push(await runCompletion(api, transport));
    if (options.includeStop) {
      runs.push(await runStop(api, transport));
    }
  }

  const failures = runs.filter(
    (run) => !run.skipped && Object.values(run.assertions ?? {}).some((value) => value !== true)
  );
  return JSON.stringify({
    ok: failures.length === 0,
    detection,
    workspacePath: options.workspacePath,
    runs,
    failures,
  });
}

function printRun(run) {
  if (run.skipped) {
    console.log(`- ${run.transport}: skipped (${run.reason})`);
    return;
  }
  const assertionSummary = Object.entries(run.assertions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  console.log(
    `- ${run.transport} ${run.kind}: ok=${Object.values(run.assertions).every(Boolean)} traces=${run.traceCount} rows=${run.visibleRows.length} ${assertionSummary}`
  );
  if (run.visibleRows.length > 0) {
    const rows = run.visibleRows
      .slice(0, 5)
      .map((row) => `${row.display?.kind}:${row.display?.title}:${row.display?.status ?? ''}`)
      .join(' | ');
    console.log(`  rows: ${rows}`);
  }
  if (run.result?.error) console.log(`  error: ${run.result.error}`);
  if (run.result?.text) console.log(`  text: ${JSON.stringify(run.result.text).slice(0, 500)}`);
}

async function main() {
  const options = parseArgs(process.argv);
  const runId = randomUUID();
  console.log(`[live-agent-trace-probe] run=${runId}`);
  console.log(`[live-agent-trace-probe] cdp=${options.cdpUrl}`);
  console.log(`[live-agent-trace-probe] workspace=${options.workspacePath}`);

  const target = await findPageTarget(options.cdpUrl);
  console.log(`[live-agent-trace-probe] target=${target.title || target.url}`);

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    const report = await runInPage(client, options);
    console.log('[live-agent-trace-probe] detection:', JSON.stringify(report.detection, null, 2));
    for (const run of report.runs ?? []) printRun(run);
    if (!report.ok) {
      console.error('[live-agent-trace-probe] failures:', JSON.stringify(report.failures, null, 2));
      exit(1);
    }
    console.log('[live-agent-trace-probe] ok=true');
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error('[live-agent-trace-probe] fatal:', err);
  exit(2);
});
