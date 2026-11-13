#!/usr/bin/env node

import { createRequire } from 'node:module';
import { exit } from 'node:process';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9230';
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const options = {
    cdpUrl: process.env.AGENT_SESSION_SMOKE_CDP_URL ?? DEFAULT_CDP_URL,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cdp') {
      options.cdpUrl = argv[(i += 1)];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  pnpm --dir apps/desktop run probe:agent-session:live
  node apps/desktop/scripts/live-agent-session-smoke.mjs [--cdp ${DEFAULT_CDP_URL}]
`);
      exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

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

function onSocket(socket, event, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(event, handler);
  } else {
    socket.on(event, handler);
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return response.json();
}

async function findPageTarget(cdpUrl) {
  const targets = await fetchJson(`${cdpUrl.replace(/\/$/, '')}/json/list`);
  const page = targets.find(
    (target) =>
      target.type === 'page' &&
      target.webSocketDebuggerUrl &&
      String(target.url ?? '').includes('localhost:')
  );
  if (!page) throw new Error(`No Electron page target found at ${cdpUrl}/json/list`);
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
    const WebSocketImpl = getWebSocketImpl();
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

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error('CDP socket is not open');
    }
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    this.socket?.close();
  }
}

async function runInPage(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(${browserProbe.toString()})()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  if (result.result.type !== 'string') {
    throw new Error(`Unexpected probe result type: ${result.result.type}`);
  }
  return JSON.parse(result.result.value);
}

async function browserProbe() {
  const api = window.electronAPI;
  const hasAgentSession = Boolean(
    api?.agentSession?.start &&
    api?.agentSession?.cancel &&
    api?.agentSession?.get &&
    api?.agentSession?.onEvent
  );
  const failures = [];

  if (!hasAgentSession) {
    failures.push('window.electronAPI.agentSession is missing.');
    return JSON.stringify({
      ok: false,
      title: document.title,
      url: location.href,
      hasAgentSession,
      failures,
    });
  }

  const missing = await api.agentSession.get('missing_live_agent_session');
  if (missing !== null) {
    failures.push('agentSession:get should return null for a missing session.');
  }

  const legacyReject = await api.agentSession.start({
    sessionId: 'live_invalid_permission',
    provider: 'codex-sdk',
    permissionMode: 'native-cli',
    prompt: 'hello',
    cwd: '/tmp',
    workspaceGrounding: 'required',
  });
  if (
    legacyReject?.ok !== false ||
    !String(legacyReject.error ?? '').includes('concrete authorityProfileId')
  ) {
    failures.push('legacy permissionMode start request was not rejected at IPC boundary.');
  }

  const unsupportedProfileReject = await api.agentSession.start({
    sessionId: 'live_unimplemented_read_only',
    provider: 'codex-sdk',
    authorityProfileId: 'codex-sdk:native-read-only',
    prompt: 'do not call a model',
    cwd: '/tmp',
    workspaceGrounding: 'required',
  });
  if (
    unsupportedProfileReject?.ok !== false ||
    !String(unsupportedProfileReject.error ?? '').includes('runtime permission mapping')
  ) {
    failures.push('unimplemented concrete authority profile did not fail before provider start.');
  }

  const tables = await api.db.select(
    `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('agent_sessions', 'agent_trace_events', 'agent_output_artifacts')
      ORDER BY name
    `
  );
  const tableNames = tables.map((row) => row.name);
  for (const required of ['agent_output_artifacts', 'agent_sessions', 'agent_trace_events']) {
    if (!tableNames.includes(required)) failures.push(`missing SQLite table ${required}`);
  }

  const latestSessions = await api.db.select(
    `
      SELECT id, provider, authority_profile_id, status, cwd, terminal_reason
      FROM agent_sessions
      ORDER BY started_at DESC
      LIMIT 5
    `
  );

  return JSON.stringify({
    ok: failures.length === 0,
    title: document.title,
    url: location.href,
    hasAgentSession,
    missing,
    legacyReject,
    unsupportedProfileReject,
    tableNames,
    latestSessions,
    failures,
  });
}

async function main() {
  const options = parseArgs(process.argv);
  const page = await findPageTarget(options.cdpUrl);
  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    const result = await runInPage(client);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) exit(1);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  exit(1);
});
