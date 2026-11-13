import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';

const { resolveCurrentAgentCaller } = vi.hoisted(() => ({
  resolveCurrentAgentCaller: vi.fn(async () => ({
    agentIdentityId: 'current-bound-agent',
    effectiveCapabilities: ['read-workspace'],
  })),
}));

vi.mock('../agent-caller', () => ({ resolveCurrentAgentCaller }));

const { mockIpcMain, ipcEvents } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const ipcEvents = {
    once(channel: string, listener: (...args: unknown[]) => void) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void) {
      listeners.get(channel)?.delete(listener);
    },
    removeAllListeners() {
      listeners.clear();
    },
    emit(channel: string, sender: unknown, ...args: unknown[]) {
      const channelListeners = listeners.get(channel);
      if (!channelListeners) return;
      for (const listener of [...channelListeners]) {
        channelListeners.delete(listener);
        listener({ sender }, ...args);
      }
    },
  };
  return {
    ipcEvents,
    mockIpcMain: {
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        ipcEvents.once(channel, listener);
      }),
      once: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        ipcEvents.once(channel, listener);
      }),
      removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        ipcEvents.removeListener(channel, listener);
      }),
    },
  };
});

describe('external access observation bridge authority', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  const receipt = () => ({
    feature_area: 'tool_usage',
    operation_id: 'd074758d-23bb-4b5c-b77d-6c75009cdf38',
    occurred_at_ms: 1792507388419,
    access_stage: 'request_outcome',
    access_result: 'refused',
    access_client: 'script',
    access_transport: 'http',
    access_scope_class: 'read',
    access_expiry_class: 'none',
    access_authority: 'committed_action',
    access_execution: 'not_observed',
    access_usefulness: 'not_attested',
  });
  const start = async (source: () => string | null) => {
    const { startAgentToolsBridge } = await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge(
      {
        isDestroyed: () => false,
        webContents: Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false }),
      } as never,
      { sessionToken: 'bridge-token', observationSessionToken: source }
    );
    servers.push(server);
    return server;
  };
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Session': 'bridge-token',
        'X-DNAForge-Sidecar-Session': 'generation-one',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  afterEach(async () => {
    const { bindExternalAccessObservationSink } = await import('../external-access-observation');
    bindExternalAccessObservationSink(null);
    await Promise.all(servers.splice(0).map((server) => server.close()));
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('requires both private credentials and the current ready generation on the real HTTP server', async () => {
    let source: string | null = 'generation-one';
    const server = await start(() => source);
    const { bindExternalAccessObservationSink } = await import('../external-access-observation');
    const sink = vi.fn(() => true);
    bindExternalAccessObservationSink(sink);
    const url = `${server.url}/__external-access/observe`;
    expect((await post(url, receipt(), { 'X-DNAForge-Session': 'foreign' })).status).toBe(401);
    expect((await post(url, receipt(), { 'X-DNAForge-Session': 'é'.repeat(12) })).status).toBe(401);
    source = null;
    expect((await post(url, receipt())).status).toBe(401);
    source = 'generation-two';
    expect((await post(url, receipt())).status).toBe(401);
    expect(sink).not.toHaveBeenCalled();
    const accepted = await post(url, receipt(), { 'X-DNAForge-Sidecar-Session': 'generation-two' });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ ok: true, emitted: true });
    expect(sink).toHaveBeenCalledExactlyOnceWith(receipt());
  });

  it('rejects browser/query/raw-field/semantic substitutions before the sink', async () => {
    const server = await start(() => 'generation-one');
    const { bindExternalAccessObservationSink } = await import('../external-access-observation');
    const sink = vi.fn(() => true);
    bindExternalAccessObservationSink(sink);
    const url = `${server.url}/__external-access/observe`;
    expect((await post(url, receipt(), { Origin: 'http://127.0.0.1:1420' })).status).toBe(403);
    expect((await post(`${url}?key=must-never-be-observation-data`, receipt())).status).toBe(403);
    for (const invalid of [
      { ...receipt(), apiKey: 'nonfunctional-private-sentinel' },
      { ...receipt(), access_client: 'private client label' },
      { ...receipt(), access_stage: 'request_admitted', access_result: 'allowed' },
      { ...receipt(), operation_id: '019c6e27-e55b-73d1-87d8-4e01f1f75043' },
    ]) {
      const response = await post(url, invalid);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('nonfunctional-private-sentinel');
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it('refuses an old generation that becomes stale while its actual HTTP body is arriving', async () => {
    let source = 'generation-one';
    const current = vi.fn(() => source);
    const server = await start(current);
    const { bindExternalAccessObservationSink } = await import('../external-access-observation');
    const sink = vi.fn(() => true);
    bindExternalAccessObservationSink(sink);
    const payload = JSON.stringify(receipt());
    let finish = () => {};
    const status = new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${server.url}/__external-access/observe`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-DNAForge-Session': 'bridge-token',
            'X-DNAForge-Sidecar-Session': 'generation-one',
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      req.once('error', reject);
      finish = () => req.end(payload.slice(5));
      req.write(payload.slice(0, 5));
    });
    try {
      await vi.waitFor(() => expect(current).toHaveBeenCalledOnce());
      source = 'generation-two';
    } finally {
      finish();
    }
    expect(await status).toBe(401);
    expect(current).toHaveBeenCalledTimes(2);
    expect(sink).not.toHaveBeenCalled();
  });

  it('returns local delivery truth and never replays a consent-refused observation', async () => {
    const server = await start(() => 'generation-one');
    const { bindExternalAccessObservationSink } = await import('../external-access-observation');
    const sink = vi.fn(() => false);
    bindExternalAccessObservationSink(sink);
    const url = `${server.url}/__external-access/observe`;
    await expect((await post(url, receipt())).json()).resolves.toEqual({
      ok: true,
      emitted: false,
    });
    sink.mockReturnValue(true);
    expect(sink).toHaveBeenCalledTimes(1);
    await expect((await post(url, receipt())).json()).resolves.toEqual({ ok: true, emitted: true });
    expect(sink).toHaveBeenCalledTimes(2);
  });
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  BrowserWindow: vi.fn(),
}));

describe('agent tools bridge cancellation', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    ipcEvents.removeAllListeners();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('routes scoped protein annotations to their owned renderer without admitting other tools', async () => {
    const sends: Array<{ channel: string; payload: unknown }> = [];
    const mainContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      isDestroyed: () => false,
    });
    const worker = Object.assign(new EventEmitter(), {
      send: vi.fn((channel: string, payload: unknown) => sends.push({ channel, payload })),
      isDestroyed: () => false,
    });
    const { startAgentToolsBridge } = await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge(
      { isDestroyed: () => false, webContents: mainContents } as never,
      {
        capabilities: ['read-workspace'],
        resolveRendererTarget: (turnId) =>
          turnId === 'isolated-turn' ? (worker as never) : undefined,
      }
    );
    servers.push(server);
    const args = { source: 'protein-mcp', operation: 'annotations', pdbId: '1ABC', chain: 'B' };
    const pending = server.callTool({
      turnId: 'isolated-turn',
      toolName: 'protein_get_context',
      args,
      actionId: 'scoped-annotation',
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    const payload = sends[0].payload as { requestId: string };
    expect(payload).toMatchObject({
      turnId: 'isolated-turn',
      agentCapabilities: ['read-workspace'],
      request: { tool_name: 'protein_get_context', args, agent_identity: 'current-bound-agent' },
    });
    ipcEvents.emit(`agent-tools:response:${payload.requestId}`, worker, {
      ok: true,
      result: { annotations: [] },
      audit_id: 'scoped-annotation-audit',
    });
    await expect(pending).resolves.toMatchObject({ ok: true, audit_id: 'scoped-annotation-audit' });
    await expect(
      server.callTool({
        turnId: 'isolated-turn',
        toolName: 'get_workspace',
        args: {},
        actionId: 'outside-tool',
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'OUTSIDE_EXPERIMENT_CONTEXT' } });
    expect(sends).toHaveLength(1);
    expect(mainContents.send).not.toHaveBeenCalled();
  });

  it('settles pending calls and closes its server after the window is destroyed', async () => {
    let destroyed = false;
    const webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      isDestroyed: () => destroyed,
    });
    const mainWindow = {
      isDestroyed: () => destroyed,
      get webContents() {
        if (destroyed) throw new TypeError('Object has been destroyed');
        return webContents;
      },
    };
    const { startAgentToolsBridge } = await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge(mainWindow as never, {
      sessionToken: 'renderer-session-token',
      capabilities: ['read-workspace'],
    });
    servers.push(server);
    const pending = server.callTool({
      actionId: 'action-destroyed-window',
      turnId: 'turn-destroyed-window',
      toolName: 'get_workspace',
      args: {},
    });
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalledOnce());
    try {
      destroyed = true;
      webContents.emit('destroyed');
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'OUTCOME_UNRESOLVED', retriable: false },
      });
      await server.close();
      servers.splice(servers.indexOf(server), 1);
      expect(webContents.eventNames()).toEqual([]);
      await expect(fetch(server.url)).rejects.toThrow();
      expect(webContents.send).toHaveBeenCalledOnce();
    } finally {
      destroyed = false;
    }
  });

  it('forwards private sidecar authority outside public renderer arguments', async () => {
    const sends: Array<{ channel: string; payload: unknown }> = [];
    const mainWindow = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => sends.push({ channel, payload })),
      },
    };
    const { startAgentToolsBridge } = await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge(mainWindow as never, {
      sessionToken: 'renderer-session-token',
      capabilities: ['*'],
      timeoutMs: 10_000,
    });
    servers.push(server);
    const trustedContext = { schema: 'dnaforge.managed-annotation-authority.v1' };
    const responsePromise = fetch(`${server.url}/__tools/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Session': 'renderer-session-token',
        'X-DNAForge-Agent-Identity': 'agent-1',
        'X-DNAForge-Bound-Workspace': 'folders:["/lab"]',
        'X-DNAForge-Agent-Capabilities': JSON.stringify([
          'operations.read',
          'read-workspace',
          'read-sequences',
        ]),
      },
      body: JSON.stringify({
        tool_name: 'operations.annotation.inspect',
        args: { operationId: 'operation-1', targetDocumentId: 'sequence-1' },
        action_id: 'action-managed-1',
        trusted_context: trustedContext,
      }),
    }).then((response) => response.json());

    await vi.waitFor(() => {
      expect(sends.some((send) => send.channel === 'agent-tools:call')).toBe(true);
    });
    const callPayload = sends.find((send) => send.channel === 'agent-tools:call')?.payload as {
      requestId: string;
      request: { args: unknown };
      trustedContext?: unknown;
    };
    expect(callPayload.trustedContext).toEqual(trustedContext);
    expect(callPayload).toMatchObject({ boundWorkspaceId: 'folders:["/lab"]' });
    expect(callPayload.request.args).not.toHaveProperty('trusted_context');
    const finalResponse = { ok: true, result: { applicable: true }, audit_id: 'audit-1' };
    ipcEvents.emit(
      `agent-tools:response:${callPayload.requestId}`,
      mainWindow.webContents,
      finalResponse
    );
    await expect(responsePromise).resolves.toEqual(finalResponse);
  });

  it.each(
    [false, true].flatMap((minimized) =>
      [
        { toolName: 'get_workspace', rejected: false },
        { toolName: 'create_primer', rejected: false },
        { toolName: 'create_primer', rejected: true },
      ].map((request) => ({ ...request, minimized }))
    )
  )(
    'preserves focus and minimized=$minimized for $toolName rejected=$rejected',
    async ({ minimized, toolName, rejected }) => {
      const sends: Array<{ channel: string; payload: unknown }> = [];
      const mainWindow = {
        isDestroyed: () => false,
        isMinimized: () => minimized,
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        webContents: {
          send: vi.fn((channel: string, payload: unknown) => sends.push({ channel, payload })),
        },
      };
      const { startAgentToolsBridge } = await import('../agent-tools-bridge');
      const server = await startAgentToolsBridge(mainWindow as never, {
        sessionToken: 'renderer-session-token',
        capabilities: ['read-workspace'],
        timeoutMs: 10_000,
      });
      servers.push(server);
      const responsePromise = fetch(`${server.url}/__tools/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DNAForge-Session': 'renderer-session-token',
          'X-DNAForge-Agent-Identity': 'agent_stdio_external',
          'X-DNAForge-Agent-Capabilities': 'read-workspace',
        },
        body: JSON.stringify({ tool_name: toolName, args: {}, action_id: 'action-1' }),
      }).then((response) => response.json());

      await vi.waitFor(() => expect(sends).toHaveLength(1));
      expect(mainWindow.restore).not.toHaveBeenCalled();
      expect(mainWindow.show).not.toHaveBeenCalled();
      expect(mainWindow.focus).not.toHaveBeenCalled();
      const payload = sends[0]?.payload as { requestId: string };
      ipcEvents.emit(`agent-tools:response:${payload.requestId}`, mainWindow.webContents, {
        ...(rejected
          ? {
              ok: false,
              error: {
                code: 'PERMISSION_DENIED',
                message: 'Missing edit-primers.',
                retriable: false,
              },
            }
          : { ok: true, result: {} }),
        audit_id: 'audit-1',
      });
      expect(await responsePromise).toMatchObject({ ok: !rejected });
      expect(mainWindow.restore).not.toHaveBeenCalled();
      expect(mainWindow.show).not.toHaveBeenCalled();
      expect(mainWindow.focus).not.toHaveBeenCalled();
    }
  );

  it('cancels active renderer tool calls for the matching CLI turn id without waiting for timeout', async () => {
    const sends: Array<{ channel: string; payload: unknown }> = [];
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => {
          sends.push({ channel, payload });
        }),
      },
    };

    const { cancelRendererToolCallsForTurn, startAgentToolsBridge } =
      await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge(mainWindow as never, {
      sessionToken: 'renderer-session-token',
      capabilities: ['read-workspace'],
      timeoutMs: 10_000,
    });
    servers.push(server);

    const responsePromise = fetch(`${server.url}/__tools/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Session': 'renderer-session-token',
        'X-DNAForge-Agent-Identity': 'agent-1',
        'X-DNAForge-Agent-Capabilities': 'read-workspace',
        'X-DNAForge-Turn-Id': 'turn-main-1',
        'X-DNAForge-Cancelable': 'true',
      },
      body: JSON.stringify({
        tool_name: 'get_workspace',
        args: {},
        action_id: 'action-1',
      }),
    }).then((response) => response.json());

    await vi.waitFor(() => {
      expect(sends.some((send) => send.channel === 'agent-tools:call')).toBe(true);
    });
    const callPayload = sends.find((send) => send.channel === 'agent-tools:call')?.payload as {
      requestId?: string;
      turnId?: string;
    };
    expect(callPayload).toMatchObject({ turnId: 'turn-main-1' });

    expect(cancelRendererToolCallsForTurn('turn-main-1')).toBe(1);

    const finalResponse = {
      ok: false,
      error: { code: 'CANCELED', message: 'Canceled before execution', retriable: true },
      audit_id: 'canceled-audit',
    };
    ipcEvents.emit(
      `agent-tools:response:${callPayload.requestId}`,
      mainWindow.webContents,
      finalResponse
    );
    await expect(responsePromise).resolves.toEqual(finalResponse);
    expect(sends).toContainEqual({
      channel: 'agent-tools:cancel',
      payload: {
        requestId: callPayload.requestId,
        turnId: 'turn-main-1',
      },
    });
  });

  it('marks only the main-owned callTool path for local renderer auditing', async () => {
    const sends: Array<{ channel: string; payload: unknown }> = [];
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => sends.push({ channel, payload })),
      },
    };
    const { startAgentToolsBridge } = await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge(mainWindow as never, {
      sessionToken: 'renderer-session-token',
      capabilities: ['*'],
    });
    servers.push(server);

    const responsePromise = server.callTool({
      turnId: 'turn-hosted-1',
      toolName: 'get_workspace',
      args: {},
      actionId: 'action-hosted-1',
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    const payload = sends[0].payload as { requestId: string };
    expect(payload).toMatchObject({
      auditMode: 'local',
      turnId: 'turn-hosted-1',
      agentCapabilities: ['read-workspace'],
      request: {
        tool_name: 'get_workspace',
        action_id: 'action-hosted-1',
        agent_identity: 'current-bound-agent',
      },
    });
    ipcEvents.emit(`agent-tools:response:${payload.requestId}`, mainWindow.webContents, {
      ok: true,
      result: { workspace: 'ok' },
      audit_id: 'audit-local',
    });
    await expect(responsePromise).resolves.toMatchObject({ ok: true, audit_id: 'audit-local' });
  });

  it('does not send a main-owned tool to the renderer when its current grant is revoked', async () => {
    const send = vi.fn();
    const { startAgentToolsBridge } = await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge(
      {
        isDestroyed: () => false,
        webContents: { send },
      } as never,
      { capabilities: ['read-workspace'], timeoutMs: 20 }
    );
    servers.push(server);
    resolveCurrentAgentCaller.mockRejectedValueOnce(
      Object.assign(new Error('Grant revoked.'), {
        code: 'GRANT_REVOKED',
        retriable: false,
      })
    );
    await expect(
      server.callTool({
        turnId: 'revoked-turn',
        toolName: 'get_workspace',
        args: {},
        actionId: 'revoked-action',
      })
    ).rejects.toMatchObject({ code: 'GRANT_REVOKED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('stops a main-owned tool while its authority request is pending', async () => {
    const send = vi.fn();
    let resolveCaller!: (caller: {
      agentIdentityId: string;
      effectiveCapabilities: string[];
    }) => void;
    resolveCurrentAgentCaller.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCaller = resolve;
        })
    );
    const { startAgentToolsBridge, cancelRendererToolCallsForTurn } =
      await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge({
      isDestroyed: () => false,
      webContents: { send },
    } as never);
    servers.push(server);
    const pending = server.callTool({
      turnId: 'pending-turn',
      toolName: 'get_workspace',
      args: {},
      actionId: 'pending-action',
    });
    expect(cancelRendererToolCallsForTurn('pending-turn')).toBe(1);
    resolveCaller({ agentIdentityId: 'bound', effectiveCapabilities: ['read-workspace'] });
    await expect(pending).rejects.toMatchObject({ code: 'STOP_REQUESTED' });
    expect(send).not.toHaveBeenCalled();
    expect(cancelRendererToolCallsForTurn('pending-turn')).toBe(0);
  });
});

describe('agent tools bridge resource read', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    ipcEvents.removeAllListeners();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('dispatches /__resources/read to the renderer and returns its response', async () => {
    const sends: Array<{ channel: string; payload: unknown }> = [];
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => {
          sends.push({ channel, payload });
        }),
      },
    };

    const { startAgentToolsBridge } = await import('../agent-tools-bridge');
    const { openWorkspaceProvenanceForTurn } =
      await import('../agent-sdk/turn-workspace-provenance');
    openWorkspaceProvenanceForTurn('turn-resource-1');
    const server = await startAgentToolsBridge(mainWindow as never, {
      sessionToken: 'renderer-session-token',
      capabilities: ['read-workspace'],
      timeoutMs: 10_000,
    });
    servers.push(server);

    const responsePromise = fetch(`${server.url}/__resources/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Session': 'renderer-session-token',
        'X-DNAForge-Agent-Identity': 'local-in-app-chat',
        'X-DNAForge-Agent-Capabilities': JSON.stringify(['read-workspace']),
        'X-DNAForge-Turn-Id': 'turn-resource-1',
      },
      body: JSON.stringify({ reference_id: 'ref-123' }),
    }).then((response) => response.json());

    await vi.waitFor(() => {
      expect(sends.some((send) => send.channel === 'agent-tools:read-resource')).toBe(true);
    });
    const readPayload = sends.find((send) => send.channel === 'agent-tools:read-resource')
      ?.payload as Record<string, unknown>;
    expect(readPayload).toMatchObject({
      referenceId: 'ref-123',
      turnId: 'turn-resource-1',
      sessionToken: 'renderer-session-token',
      expectedSessionToken: 'renderer-session-token',
      agentIdentity: 'local-in-app-chat',
      agentCapabilities: ['read-workspace'],
    });
    expect(typeof readPayload.requestId).toBe('string');

    ipcEvents.emit(
      `agent-tools:resource-response:${readPayload.requestId}`,
      mainWindow.webContents,
      {
        ok: true,
        reference: { id: 'ref-123', data: { kind: 'sequence_region' } },
      }
    );

    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      reference: { id: 'ref-123', data: { kind: 'sequence_region' } },
    });
    const { workspaceProvenanceForTurn } = await import('../agent-sdk/turn-workspace-provenance');
    expect(workspaceProvenanceForTurn('turn-resource-1')).toMatchObject({
      grounded: true,
      completedWorkspaceResources: ['waypoint://selection/ref-123'],
    });
  });

  it('rejects /__resources/read with 401 on a bad session token', async () => {
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };

    const { startAgentToolsBridge } = await import('../agent-tools-bridge');
    const server = await startAgentToolsBridge(mainWindow as never, {
      sessionToken: 'renderer-session-token',
      capabilities: ['read-workspace'],
      timeoutMs: 10_000,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/__resources/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Session': 'wrong-token',
      },
      body: JSON.stringify({ reference_id: 'ref-123' }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'BAD_SESSION' },
    });
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
  });
});
