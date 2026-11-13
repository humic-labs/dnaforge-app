#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { exit } from 'node:process';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9230';
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const options = {
    cdpUrl: process.env.AGENT_ACTIVITY_HISTORY_PROBE_CDP_URL ?? DEFAULT_CDP_URL,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cdp') {
      options.cdpUrl = argv[(i += 1)];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  pnpm --dir apps/desktop run probe:agent-activity-history:live
  node apps/desktop/scripts/live-agent-activity-history-probe.mjs [--cdp ${DEFAULT_CDP_URL}]
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
  const conversationId = `live-agent-activity-${randomUUID()}`;
  const result = await client.send('Runtime.evaluate', {
    expression: `(${browserProbe.toString()})(${JSON.stringify(conversationId)})`,
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

async function browserProbe(conversationId) {
  const api = window.electronAPI;
  const chatStore = window.__chatStore;
  const canvasStore = window.__canvasStore;
  const failures = [];

  if (!api?.db?.execute || !api?.db?.select) failures.push('window.electronAPI.db is missing.');
  if (!chatStore?.getState) failures.push('window.__chatStore is missing.');
  if (!canvasStore?.getState) failures.push('window.__canvasStore is missing.');
  if (failures.length > 0) {
    return JSON.stringify({ ok: false, conversationId, failures });
  }

  const now = Date.now();
  const activityMarker = 'live-probe-persisted-command';
  const firstAssistantMarker = 'live-probe-first-assistant-text';
  const finalAssistantMarker = 'live-probe-final-assistant-text';
  const turnId = `${conversationId}-turn`;
  const activityContent = JSON.stringify({
    type: 'agent.activity',
    version: 1,
    event: {
      transport: 'codex-sdk',
      sequence: 0,
      receivedAt: new Date(now).toISOString(),
      providerEventType: 'item.completed',
      providerItemType: 'command_execution',
      providerItemId: 'live-probe-cmd',
      raw: {},
      display: {
        kind: 'command',
        title: 'Ran command',
        status: 'completed',
        text: activityMarker,
      },
      versions: { sdkVersion: null, cliVersion: null },
    },
  });

  async function cleanup() {
    canvasStore.getState().closeTabByTypeAndEntity?.('chat', conversationId);
    await api.db.execute('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
    await api.db.execute('DELETE FROM chat_turns WHERE conversation_id = ?', [conversationId]);
    await api.db.execute('DELETE FROM conversations WHERE id = ?', [conversationId]);
  }

  async function waitFor(predicate, timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  try {
    await cleanup();
    await api.db.execute(
      `
        INSERT INTO conversations
          (id, title, workspace_path, pinned, provider, model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [conversationId, 'Live persisted activity probe', null, 0, 'codex-sdk', 'codex-sdk', now, now]
    );
    await api.db.execute(
      `
        INSERT INTO chat_turns
          (
            id, conversation_id, route_kind, host_id, provider, model, transport,
            authority_profile_id, permission_mode, route_snapshot_json, status,
            terminal_reason, error, started_at, completed_at
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        turnId,
        conversationId,
        'cli',
        'codex-cli',
        null,
        null,
        'codex-sdk',
        'codex-sdk:app-supervised',
        'app-supervised',
        JSON.stringify({
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'app-supervised',
        }),
        'completed',
        'completed',
        null,
        now,
        now + 3,
      ]
    );
    await api.db.execute(
      `
        INSERT INTO messages
          (id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [`${conversationId}-user`, conversationId, turnId, 'user', 'Probe question', null, null, now]
    );
    await api.db.execute(
      `
        INSERT INTO messages
          (id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        `${conversationId}-assistant-1`,
        conversationId,
        turnId,
        'assistant',
        firstAssistantMarker,
        null,
        null,
        now + 1,
      ]
    );
    await api.db.execute(
      `
        INSERT INTO messages
          (id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        `${conversationId}-activity`,
        conversationId,
        turnId,
        'activity',
        activityContent,
        null,
        null,
        now + 2,
      ]
    );
    await api.db.execute(
      `
        INSERT INTO messages
          (id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        `${conversationId}-assistant`,
        conversationId,
        turnId,
        'assistant',
        finalAssistantMarker,
        null,
        null,
        now + 3,
      ]
    );

    canvasStore.getState().openChatTab(conversationId);
    await chatStore.getState().loadConversations();
    await chatStore.getState().switchConversation(conversationId);

    const traceRow = await waitFor(() => {
      const rows = [...document.querySelectorAll('[data-testid="agent-trace-row"]')];
      return rows.find((row) => row.textContent?.includes(activityMarker)) ?? null;
    });
    const assistantMessage = await waitFor(() => {
      const rows = [...document.querySelectorAll('[data-testid="assistant-message"]')];
      return rows.find((row) => row.textContent?.includes(finalAssistantMarker)) ?? null;
    });
    const attribution = await waitFor(() => {
      const rows = [...document.querySelectorAll('[data-testid="chat-turn-attribution"]')];
      return rows.find((row) => row.textContent?.includes('Codex CLI')) ?? null;
    });
    const bodyText = document.body.textContent ?? '';
    const firstAssistantIndex = bodyText.indexOf(firstAssistantMarker);
    const activityIndex = bodyText.indexOf(activityMarker);
    const finalAssistantIndex = bodyText.indexOf(finalAssistantMarker);
    const protocolLeak = document.body.textContent?.includes('thread.started') ?? false;
    const roles = chatStore.getState().messages.map((message) => message.role);

    if (!traceRow) failures.push('Persisted activity row did not render in FullChatView.');
    if (!assistantMessage) failures.push('Persisted final assistant answer did not render.');
    if (!attribution) failures.push('Persisted chat turn route attribution did not render.');
    if (attribution && !attribution.textContent?.includes('DNAForge supervised')) {
      failures.push(`Unexpected turn attribution text: ${attribution.textContent}`);
    }
    if (
      firstAssistantIndex === -1 ||
      activityIndex === -1 ||
      finalAssistantIndex === -1 ||
      !(firstAssistantIndex < activityIndex && activityIndex < finalAssistantIndex)
    ) {
      failures.push('Persisted assistant/activity rows did not render in interleaved order.');
    }
    if (protocolLeak) failures.push('Diagnostic protocol event leaked into visible chat text.');
    if (roles.join(',') !== 'user,assistant,activity,assistant') {
      failures.push(`Unexpected loaded chat roles: ${roles.join(',')}`);
    }

    return JSON.stringify({
      ok: failures.length === 0,
      conversationId,
      url: location.href,
      title: document.title,
      roles,
      traceText: traceRow?.textContent ?? null,
      attributionText: attribution?.textContent ?? null,
      assistantText: assistantMessage?.textContent ?? null,
      failures,
    });
  } finally {
    await cleanup();
  }
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
