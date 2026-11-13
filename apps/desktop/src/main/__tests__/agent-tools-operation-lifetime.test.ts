import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const state = vi.hoisted(() => ({
  onCall: undefined as undefined | ((payload: never) => void),
  onCancel: undefined as undefined | ((payload: never) => void),
  respond: undefined as undefined | ((id: string, response: unknown) => void),
  handler: vi.fn(),
  audits: [] as Array<Record<string, unknown>>,
}));
vi.mock('../ipc/database', () => ({ getDb: vi.fn() }));

vi.mock('../registered-project-authority', () => ({
  createRegisteredProjectAuthority: () => ({
    folders: () => [
      { path: '/workspace', name: 'Registered workspace', addedAt: 0, pinned: false },
    ],
  }),
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter(), BrowserWindow: vi.fn() };
});
vi.mock('../agent-grants', () => ({
  IN_APP_CHAT_AGENT_IDENTITY: 'test-agent',
  mintInAppChatGrant: (options: object) => ({ ...options, agentIdentityId: 'test-agent' }),
}));
vi.mock('../agent-caller', () => ({
  resolveCurrentAgentCaller: async () => ({
    agentIdentityId: 'test-agent',
    effectiveCapabilities: ['write-workspace'],
  }),
}));
vi.mock('../renderer-ui-observation', () => ({}));
vi.mock('../agent-sdk/turn-workspace-provenance', () => ({ recordCompletedToolCall: vi.fn() }));
vi.mock('../../stores/workspaceStore', () => ({
  getCurrentWorkspaceScope: () => '/workspace',
  workspaceScopeFromState: ({ folders }: { folders: unknown[] }) =>
    folders.length ? '/workspace' : null,
  useWorkspaceStore: { getState: () => ({ folders: [{ path: '/workspace' }] }) },
}));
vi.mock('../../features/agent-bridge/domain-state-snapshot', () => ({
  captureDomainStateSnapshot: () => ({ workspace_path: '/workspace' }),
}));
vi.mock('../../features/agent-bridge/renderer-resource', () => ({}));
vi.mock('../../features/agent-bridge/renderer-tools', () => ({
  getAllowedRendererTool: () => ({
    name: 'controlled_write',
    effects: ['write-workspace'],
    required_capabilities: ['write-workspace'],
    inputSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
    execution: { kind: 'custom', handler: state.handler },
  }),
  executeRendererToolDefinition: (
    definition: { execution: { handler: (args: unknown, context: unknown) => unknown } },
    args: unknown,
    context: unknown
  ) => definition.execution.handler(args, context),
  resolveRendererToolAuthorization: () => ({
    requiredCapabilities: ['write-workspace'],
    requiresWorkspace: true,
  }),
}));

import { ipcMain } from 'electron';
import { startAgentToolsBridge, cancelRendererToolCallsForTurn } from '../agent-tools-bridge';
import { installRendererAgentBridge } from '../../features/agent-bridge/install-renderer-agent-bridge';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  ipcMain.removeAllListeners();
  state.audits.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function setup(cancelable = true, turnId = 'test-turn') {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (String(url).includes('/mcp/renderer-audit')) {
      state.audits.push(JSON.parse(String(init?.body)));
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, audit_id: `audit-${state.audits.length}` }),
      });
    }
    return realFetch(url, init);
  });
  vi.stubGlobal('window', {
    electronAPI: {
      config: { getApiUrl: async () => 'http://audit.invalid' },
      agentTools: {
        onCall: (callback: typeof state.onCall) => {
          state.onCall = callback;
          return () => {};
        },
        onCancel: (callback: typeof state.onCancel) => {
          state.onCancel = callback;
          return () => {};
        },
        respond: (id: string, response: unknown) =>
          ipcMain.emit(`agent-tools:response:${id}`, { sender: webContents }, response),
      },
    },
  });
  const dispose = installRendererAgentBridge();
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn((channel: string, payload: never) => {
      if (channel === 'agent-tools:call') state.onCall?.(payload);
      if (channel === 'agent-tools:cancel') state.onCancel?.(payload);
    }),
  });
  const server = await startAgentToolsBridge({ isDestroyed: () => false, webContents } as never, {
    sessionToken: 'test-session',
    capabilities: ['write-workspace'],
    timeoutMs: 30,
  });
  cleanups.push(dispose, () => server.close());
  const headers = {
    'Content-Type': 'application/json',
    'X-DNAForge-Session': 'test-session',
    'X-DNAForge-Agent-Identity': 'test-agent',
    'X-DNAForge-Agent-Capabilities': 'write-workspace',
    'X-DNAForge-Turn-Id': turnId,
    'X-DNAForge-Cancelable': String(cancelable),
  };
  const call = (args: unknown = {}) =>
    fetch(`${server.url}/__tools/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool_name: 'controlled_write', args, action_id: 'test-action' }),
    }).then((response) => response.json());
  const lookup = () =>
    fetch(`${server.url}/__tools/result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action_id: 'test-action' }),
    }).then((response) => response.json());
  return { call, lookup, server, webContents, headers, dispose };
}

describe('renderer operation ownership across the real shared boundary', () => {
  it('retains a deadline-expired operation through confirmed pre-write cancellation', async () => {
    const release = deferred();
    let writes = 0;
    state.handler.mockImplementation(async (_args, context) => {
      await release.promise;
      if (context.abortSignal.aborted) throw new Error('Canceled before write');
      writes += 1;
      return { saved: true };
    });
    const { call, lookup } = await setup();
    expect(await call()).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_PENDING', retriable: false },
    });
    const stopCount = cancelRendererToolCallsForTurn('test-turn');
    expect([0, 1]).toContain(stopCount);
    release.resolve();
    await expect
      .poll(lookup)
      .toMatchObject({ ok: false, error: { code: 'CANCELED' }, audit_id: 'audit-2' });
    expect(writes).toBe(0);
    expect(cancelRendererToolCallsForTurn('test-turn')).toBe(0);
    expect(ipcMain.eventNames()).toEqual([]);
    expect(state.audits.map((audit) => audit.status)).toEqual(['accepted', 'failed']);
  });

  it('keeps committed noncancelable work and reuses its action without a second write', async () => {
    const release = deferred();
    let writes = 0;
    state.handler.mockImplementation(async () => {
      writes += 1;
      await release.promise;
      return { saved: true, writes };
    });
    const { call, lookup, webContents } = await setup(false);
    expect(await call()).toMatchObject({ error: { code: 'OPERATION_PENDING' } });
    expect(cancelRendererToolCallsForTurn('test-turn')).toBe(0);
    expect(await call()).toMatchObject({ error: { code: 'OPERATION_PENDING' } });
    expect(writes).toBe(1);
    release.resolve();
    await expect.poll(lookup).toMatchObject({ ok: true, result: { saved: true, writes: 1 } });
    expect(await call()).toMatchObject({ ok: true, result: { writes: 1 } });
    expect(
      webContents.send.mock.calls.filter(([channel]) => channel === 'agent-tools:cancel')
    ).toHaveLength(0);
    expect(state.audits.map((audit) => audit.status)).toEqual(['accepted', 'completed']);
  });

  it('main-owned calls wait for the actual outcome after Stop and the response deadline', async () => {
    const release = deferred();
    state.handler.mockImplementation(async () => {
      await release.promise;
      return { committed: true };
    });
    const { server } = await setup();
    let settled = false;
    const result = server
      .callTool({
        actionId: 'hosted-action',
        turnId: 'test-turn',
        toolName: 'controlled_write',
        args: {},
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await new Promise((done) => setTimeout(done, 60));
    expect(cancelRendererToolCallsForTurn('test-turn')).toBe(1);
    expect(settled).toBe(false);
    expect(
      ipcMain.eventNames().filter((name) => String(name).startsWith('agent-tools:response:'))
    ).toHaveLength(1);
    release.resolve();
    expect(await result).toMatchObject({ ok: true, result: { committed: true } });
    expect(
      ipcMain.eventNames().filter((name) => String(name).startsWith('agent-tools:response:'))
    ).toHaveLength(0);
  });

  it('surfaces non-retriable uncertainty when the renderer is lost after Stop', async () => {
    const release = deferred();
    state.handler.mockImplementation(async () => {
      await release.promise;
      return { committed: true };
    });
    const { server, webContents } = await setup();
    const result = server.callTool({
      actionId: 'lost-after-stop-action',
      turnId: 'test-turn',
      toolName: 'controlled_write',
      args: {},
    });
    await vi.waitFor(() => expect(state.handler).toHaveBeenCalledTimes(1));
    expect(cancelRendererToolCallsForTurn('test-turn')).toBe(1);
    webContents.emit('render-process-gone');
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'OUTCOME_UNRESOLVED',
        retriable: false,
        details: {
          actionId: 'lost-after-stop-action',
          stateMayHaveChanged: true,
        },
      },
    });
    expect(
      ipcMain.eventNames().filter((name) => String(name).startsWith('agent-tools:response:'))
    ).toHaveLength(0);
    release.resolve();
  });
  it('tracks calls without a turn and confirms deadline cancellation', async () => {
    const release = deferred();
    state.handler.mockImplementation(async (_args, context) => {
      await release.promise;
      if (context.abortSignal.aborted) throw new Error('Stopped');
      return { saved: true };
    });
    const { call, lookup } = await setup(true, '');
    expect(await call()).toMatchObject({ error: { code: 'OPERATION_PENDING' } });
    release.resolve();
    await expect.poll(lookup).toMatchObject({ error: { code: 'CANCELED' } });
    expect(ipcMain.eventNames()).toEqual([]);
  });

  it('retains uncertainty on renderer loss and rejects replay of the original action', async () => {
    const release = deferred();
    state.handler.mockImplementation(async () => {
      await release.promise;
      return { saved: true };
    });
    const { call, lookup, webContents } = await setup(false);
    expect(await call()).toMatchObject({ error: { code: 'OPERATION_PENDING' } });
    webContents.emit('render-process-gone');
    expect(await lookup()).toMatchObject({
      error: { code: 'OUTCOME_UNRESOLVED', retriable: false },
    });
    expect(await call()).toMatchObject({ error: { code: 'OUTCOME_UNRESOLVED' } });
    expect(
      webContents.send.mock.calls.filter(([channel]) => channel === 'agent-tools:call')
    ).toHaveLength(1);
    expect(ipcMain.eventNames()).toEqual([]);
    release.resolve();
  });

  it('binds action reuse and result lookup to the original request, identity and scope', async () => {
    state.handler.mockResolvedValue({ saved: true });
    const { call, server, headers } = await setup(false);
    expect(await call()).toMatchObject({ ok: true });
    expect(await call({ different: true })).toMatchObject({ error: { code: 'ACTION_CONFLICT' } });
    for (const change of [
      { 'X-DNAForge-Agent-Identity': 'another-agent' },
      { 'X-DNAForge-Agent-Capabilities': '' },
    ]) {
      const response = await fetch(`${server.url}/__tools/result`, {
        method: 'POST',
        headers: { ...headers, ...change },
        body: JSON.stringify({ action_id: 'test-action' }),
      }).then((response) => response.json());
      expect(response).toMatchObject({ error: { code: 'OUTCOME_UNRESOLVED', retriable: false } });
    }
    expect(state.handler).toHaveBeenCalledTimes(1);
  });

  it('uninstall retains cancellation delivery and does not abort declared noncancelable work', async () => {
    const release = deferred();
    let signal: AbortSignal | undefined;
    state.handler.mockImplementation(async (_args, context) => {
      signal = context.abortSignal;
      await release.promise;
      return { saved: true };
    });
    const { call, lookup, dispose } = await setup(false);
    expect(await call()).toMatchObject({ error: { code: 'OPERATION_PENDING' } });
    dispose();
    expect(signal?.aborted).toBe(false);
    release.resolve();
    await expect.poll(lookup).toMatchObject({ ok: true });
  });

  it('does not advertise a canceled write with committed effects as safe to repeat', async () => {
    const release = deferred();
    let writes = 0;
    state.handler.mockImplementation(async (_args, context) => {
      writes += 1;
      await release.promise;
      context.abortSignal.throwIfAborted();
      return { saved: true };
    });
    const { call, lookup } = await setup();
    expect(await call()).toMatchObject({ error: { code: 'OPERATION_PENDING' } });
    expect(writes).toBe(1);
    release.resolve();
    await expect.poll(lookup).toMatchObject({
      error: { code: 'CANCELED', retriable: false, details: { stateMayHaveChanged: true } },
    });
  });

  it('refuses new dispatch when the bounded ownership registry is full', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      state.handler.mockResolvedValue({ saved: true });
      const { server } = await setup();
      for (let index = 0; index < 256; index += 1) {
        expect(
          await server.callTool({
            actionId: `capacity-${index}`,
            turnId: 'capacity-turn',
            toolName: 'controlled_write',
            args: {},
          })
        ).toMatchObject({ ok: true });
      }
      expect(
        await server.callTool({
          actionId: 'overflow',
          turnId: 'capacity-turn',
          toolName: 'controlled_write',
          args: {},
        })
      ).toMatchObject({
        error: {
          code: 'OPERATION_CAPACITY',
          retriable: false,
          details: { stateMayHaveChanged: false },
        },
      });
      expect(state.handler).toHaveBeenCalledTimes(256);
      expect(ipcMain.eventNames()).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });
});
