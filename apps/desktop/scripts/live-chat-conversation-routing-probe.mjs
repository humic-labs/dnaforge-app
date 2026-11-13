#!/usr/bin/env node

import { createRequire } from 'node:module';
import { exit } from 'node:process';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9230';
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const options = {
    cdpUrl: process.env.CHAT_CONVERSATION_ROUTING_PROBE_CDP_URL ?? DEFAULT_CDP_URL,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cdp') {
      options.cdpUrl = argv[(i += 1)];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  pnpm --dir apps/desktop run probe:chat-routing:live
  node apps/desktop/scripts/live-chat-conversation-routing-probe.mjs [--cdp ${DEFAULT_CDP_URL}]
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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const failures = [];
  const canvasStore = window.__canvasStore;
  const chatStore = window.__chatStore;

  if (!canvasStore?.getState) failures.push('window.__canvasStore is missing.');
  if (!chatStore?.getState) failures.push('window.__chatStore is missing.');
  if (failures.length > 0) {
    return JSON.stringify({ ok: false, failures });
  }

  const canvasState = canvasStore.getState();
  const chatState = chatStore.getState();
  if (chatState.isLoading || chatState.isStreaming) {
    return JSON.stringify({
      ok: false,
      skipped: true,
      failures: ['A chat turn is currently running; refusing to disturb live state.'],
    });
  }

  const canvasSnapshot = {
    panels: structuredClone(canvasState.panels),
    layout: structuredClone(canvasState.layout),
    focusedPanelId: canvasState.focusedPanelId,
    oversizeScanComplete: canvasState.oversizeScanComplete,
  };
  const chatSnapshot = {
    messages: chatState.messages,
    turns: chatState.turns,
    activeTurnId: chatState.activeTurnId,
    conversations: chatState.conversations,
    currentConversationId: chatState.currentConversationId,
    isLoading: chatState.isLoading,
    isStreaming: chatState.isStreaming,
    streamingBlocks: chatState.streamingBlocks,
    error: chatState.error,
    pendingMessage: chatState.pendingMessage,
    _convStates: new Map(chatState._convStates),
    sendMessage: chatState.sendMessage,
    stopGeneration: chatState.stopGeneration,
  };

  const marker = `live-route-invariant-${Date.now()}`;
  const visibleConvId = `${marker}-visible`;
  const otherConvId = `${marker}-other`;
  const capturedSends = [];

  async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await sleep(50);
    }
    return null;
  }

  try {
    canvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: `${marker}-legacy-tab`,
              type: 'chat',
              entityId: 'agent-trace-cli-conversation',
              label: 'Legacy Chat',
            },
          ],
          activeTabId: `${marker}-legacy-tab`,
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    const migrated = canvasStore.getState().openChatTab();
    const migratedTab = canvasStore.getState().panels.main.tabs[0];
    if (migrated.tabId !== `${marker}-legacy-tab`) {
      failures.push('Legacy chat tab was not reused during migration.');
    }
    if (migrated.conversationId === 'agent-trace-cli-conversation') {
      failures.push('Legacy sentinel remained the conversation ID.');
    }
    if (migratedTab.entityId !== migrated.conversationId) {
      failures.push('Migrated tab entityId does not match returned conversationId.');
    }

    canvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: `${marker}-visible-tab`,
              type: 'chat',
              entityId: visibleConvId,
              label: 'Visible Chat',
            },
          ],
          activeTabId: `${marker}-visible-tab`,
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    chatStore.setState({
      messages: [],
      turns: {},
      activeTurnId: null,
      conversations: [],
      currentConversationId: null,
      isLoading: false,
      isStreaming: false,
      streamingBlocks: [],
      error: null,
      pendingMessage: null,
      _convStates: new Map(),
      sendMessage: async (...args) => {
        capturedSends.push(args);
      },
    });

    const visibleMounted = await waitFor(() =>
      document.querySelector('[data-testid="chat-composer"]')
    );
    if (!visibleMounted) failures.push('Temporary visible chat tab did not mount.');

    chatStore
      .getState()
      .setPendingMessage({ conversationId: otherConvId, content: `${marker}-wrong` });
    await sleep(250);
    if (capturedSends.length !== 0) {
      failures.push('Visible chat stole a pending prompt for a different conversation.');
    }
    if (chatStore.getState().pendingMessage?.conversationId !== otherConvId) {
      failures.push('Mismatched pending prompt was unexpectedly cleared.');
    }

    chatStore
      .getState()
      .setPendingMessage({ conversationId: visibleConvId, content: `${marker}-right` });
    const captured = await waitFor(() => capturedSends.length > 0 && capturedSends[0]);
    if (!captured) {
      failures.push('Visible chat did not consume its matching pending prompt.');
    } else {
      if (captured[0] !== `${marker}-right`) {
        failures.push(`sendMessage content mismatch: ${captured[0]}`);
      }
      if (captured[2] !== visibleConvId) {
        failures.push(`sendMessage conversationId mismatch: ${captured[2]}`);
      }
    }
    if (chatStore.getState().pendingMessage !== null) {
      failures.push('Matching pending prompt was not cleared.');
    }

    const activePanel = canvasStore.getState().panels.main;
    const activeTab = activePanel.tabs.find((tab) => tab.id === activePanel.activeTabId);
    if (activeTab?.entityId !== visibleConvId) {
      failures.push('Active chat tab entityId drifted from visible conversation ID.');
    }

    return JSON.stringify({
      ok: failures.length === 0,
      url: location.href,
      legacyMigration: {
        returnedConversationId: migrated.conversationId,
        tabEntityId: migratedTab.entityId,
      },
      pendingSend: captured
        ? {
            content: captured[0],
            workspacePath: captured[1],
            conversationId: captured[2],
          }
        : null,
      failures,
    });
  } finally {
    chatStore.setState({
      messages: chatSnapshot.messages,
      turns: chatSnapshot.turns,
      activeTurnId: chatSnapshot.activeTurnId,
      conversations: chatSnapshot.conversations,
      currentConversationId: chatSnapshot.currentConversationId,
      isLoading: chatSnapshot.isLoading,
      isStreaming: chatSnapshot.isStreaming,
      streamingBlocks: chatSnapshot.streamingBlocks,
      error: chatSnapshot.error,
      pendingMessage: chatSnapshot.pendingMessage,
      _convStates: chatSnapshot._convStates,
      sendMessage: chatSnapshot.sendMessage,
      stopGeneration: chatSnapshot.stopGeneration,
    });
    canvasStore.setState(canvasSnapshot);
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

main().catch((error) => {
  console.error(error);
  exit(1);
});
