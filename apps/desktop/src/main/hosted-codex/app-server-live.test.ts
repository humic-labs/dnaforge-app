import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HOSTED_TOOL_DISCOVERY_NAME,
  hostedResponsesFunctionWireName,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';
import type { AcceptedResponsesRequest } from './responses-wire';

import { createTestDb } from '../__tests__/test-db';
import { createAgentStateCapsuleTable, AgentStateCapsuleStore } from './agent-state-capsule';
import { resolveCodexAppServerBinary } from './app-server-binary';
import { launchAppServer, type LaunchedAppServer } from './app-server-launcher';
import { PINNED_PROTOCOL_NOTIFICATIONS } from './app-server-protocol';
import { startHostedSession, type HostedSession } from './hosted-session';
import { buildHostedProviderConfig, HOSTED_API_KEY_ENV } from './hosted-provider-config';
import { createSupervisorDriver } from './supervisor-driver';
import {
  buildHostedCodexToolCatalog,
  hostedCodexToolWireName,
  hostedCodexWireInputSchema,
} from './dynamic-tool-catalog';

const IS_DARWIN_ARM64 = process.platform === 'darwin' && process.arch === 'arm64';

describe.skipIf(!IS_DARWIN_ARM64)('real Codex App Server session', () => {
  let launched: LaunchedAppServer | null = null;
  let hosted: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await hosted?.appServer.supervisor.shutdownAndWait();
    await hosted?.close();
    hosted = null;
    await launched?.supervisor.shutdownAndWait();
    launched?.dispose();
    launched = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  async function launch(
    extra: { configToml?: string; injectedEnv?: Record<string, string> } = {}
  ): Promise<LaunchedAppServer> {
    root = mkdtempSync(path.join(os.tmpdir(), 'codex-live-'));
    launched = await launchAppServer({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'live-1',
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      ...extra,
    });
    return launched;
  }

  interface StubGateway {
    readonly server: Server;
    readonly baseUrl: string;
    readonly requests: { path: string; method: string; authorization: string }[];
  }

  async function startStubGateway(): Promise<StubGateway> {
    const requests: StubGateway['requests'] = [];
    const server = createServer((req, res) => {
      requests.push({
        path: req.url ?? '',
        method: req.method ?? '',
        authorization: req.headers.authorization ?? '',
      });
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end('{"error":{"message":"stub gateway"}}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
  }

  it('completes the handshake against the real binary', async () => {
    const session = await launch();
    expect(session.supervisor.isTerminated).toBe(false);
  }, 60_000);

  it('runs the child inside the private Codex home', async () => {
    const session = await launch();
    const started = (await session.supervisor.request('thread/start', {})) as {
      thread?: { path?: string };
    };
    expect(started.thread?.path ?? '').toContain(session.isolation.codexHome);
  }, 60_000);

  it('survives every notification a real session emits', async () => {
    const session = await launch();
    await session.supervisor.request('thread/start', {});
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(session.supervisor.isTerminated).toBe(false);
    const arrived = session.supervisor.receivedNotifications().map((entry) => entry.method);
    expect(arrived.length).toBeGreaterThan(0);
    const unexpected = arrived.filter((method) => !PINNED_PROTOCOL_NOTIFICATIONS.includes(method));
    expect(unexpected).toEqual([]);
  }, 60_000);

  it('loads the private Hosted model catalog instead of bundled fallback metadata', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'codex-live-catalog-'));
    launched = await launchAppServer({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'live-catalog',
      hostedProviderBaseUrl: 'http://127.0.0.1:49152/v1',
      injectedEnv: { OPENAI_API_KEY: 'non-secret-loopback-fixture' },
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
    });
    const listed = (await launched.supervisor.request('model/list', {
      includeHidden: true,
    })) as { data?: Array<{ id?: string; model?: string; displayName?: string }> };

    expect(listed.data).toEqual([
      expect.objectContaining({
        id: 'gpt-5-codex',
        model: 'gpt-5-codex',
        displayName: 'DNAForge Hosted',
      }),
    ]);
  }, 60_000);

  it('accepts every canonical application tool schema in the pinned App Server', async () => {
    const session = await launch();
    const catalog = buildHostedCodexToolCatalog({
      allowEffects: ['read-only', 'ui-bound', 'mutating', 'external-submit'],
    });
    const started = (await session.supervisor.request('thread/start', {
      dynamicTools: catalog.tools.map((tool) => ({
        name: hostedCodexToolWireName(tool.name),
        description: tool.description,
        inputSchema: hostedCodexWireInputSchema(tool.inputSchema),
      })),
    })) as { thread?: { id?: string } };
    expect(started.thread?.id).toEqual(expect.any(String));
    expect(session.supervisor.isTerminated).toBe(false);
  }, 60_000);

  it('continues a real App Server turn after a dynamic tool result', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'codex-live-tool-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const requests: unknown[] = [];
    let step = 0;

    hosted = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'live-tool',
      model: 'gpt-5-codex',
      store: new AgentStateCapsuleStore(db),
      step: (request) => {
        requests.push(request);
        step += 1;
        return step === 1 ? toolStep() : answerStep();
      },
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
    });

    const executed: string[] = [];
    const result = await hosted.runTurn({
      message: 'Inspect the workspace and report the file.',
      execute: async (tool) => {
        executed.push(tool.name);
        return { outcome: 'applied', output: { files: ['pUC19.gb'] } };
      },
      approve: async () => 'approved',
      idleTimeoutMs: 10_000,
    });

    expect(requests).toHaveLength(2);
    expect(executed).toEqual(['get_workspace']);
    expect(result).toEqual({ outcome: 'completed', text: 'Found pUC19.gb.' });
  }, 60_000);

  it('continues legacy-gateway discovery through a signed canonical action and preserves its history', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'codex-live-discovery-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const requests: AcceptedResponsesRequest[] = [];
    hosted = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'live-tool',
      model: 'gpt-5-codex',
      store: new AgentStateCapsuleStore(db),
      allowEffects: ['read-only', 'mutating', 'ui-bound'],
      step: (request) => {
        requests.push(request);
        if (requests.length === 3) {
          const offered = (request.forwarded.tools as Array<{ name: string }>).map((t) => t.name);
          expect(offered).toContain('create_design');
          expect(offered).toContain('get_workspace');
        }
        return legacyDiscoveryStep(requests.length);
      },
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
    });
    const executed: unknown[] = [];
    const result = await hosted.runTurn({
      message: 'Discover and create the requested design.',
      approve: async () => 'approved',
      execute: async (_tool, request) => {
        executed.push(request);
        return { outcome: 'applied', output: { designId: 'persisted-design' } };
      },
      idleTimeoutMs: 10_000,
    });
    expect(result).toMatchObject({ outcome: 'completed', text: 'Saved design.' });
    expect(requests).toHaveLength(4);
    const names = requests.map((request) =>
      (request.forwarded.tools as Array<{ name: string }>).map((tool) => tool.name)
    );
    expect(names[0]).not.toContain('create_design');
    expect(names[1]).toContain('create_design');
    expect(
      names.every(
        (page) => !page.includes(hostedResponsesFunctionWireName('dnaforge_execute_tool'))
      )
    ).toBe(true);
    expect(executed).toEqual([
      expect.objectContaining({
        callId: 'call-create-design',
        name: 'create_design',
        input: { name: 'Owned design' },
      }),
    ]);
    expect(requests[3].forwarded.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call-create-design',
          name: 'create_design',
          arguments: '{"name":"Owned design"}',
        }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call-create-design' }),
      ])
    );
  }, 60_000);

  it('starts a real turn through the driver the loop uses', async () => {
    const session = await launch();
    const driver = createSupervisorDriver({ supervisor: session.supervisor });
    const seen: string[] = [];
    driver.onNotification((notification) => seen.push(notification.method));
    driver.onServerRequest(() => undefined);

    await driver.send('say hello');

    expect(driver.threadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(session.supervisor.isTerminated).toBe(false);

    for (const method of seen) {
      expect(PINNED_PROTOCOL_NOTIFICATIONS, method).toContain(method);
    }
  }, 60_000);

  it('reports the version from the artifact rather than from the handshake', () => {
    const binary = resolveCodexAppServerBinary();
    expect(binary.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(binary.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  describe('reaching the Hosted gateway', () => {
    let gateway: StubGateway | null = null;

    afterEach(async () => {
      await launched?.supervisor.shutdownAndWait();
      launched?.dispose();
      launched = null;
      const open = gateway;
      gateway = null;
      if (open) {
        await new Promise<void>((resolve, reject) => {
          open.server.close((error) => (error ? reject(error) : resolve()));
          open.server.closeAllConnections();
        });
      }
    });

    it('sends the turn to the gateway over the wire the gateway serves', async () => {
      gateway = await startStubGateway();
      const bearer = 'live-bearer-token';
      const session = await launch({
        configToml: buildHostedProviderConfig({ baseUrl: gateway.baseUrl, model: 'gpt-5-codex' }),
        injectedEnv: { [HOSTED_API_KEY_ENV]: bearer },
      });
      const driver = createSupervisorDriver({ supervisor: session.supervisor });
      driver.onServerRequest((request) => request.refuse('not under test'));

      await driver.send('say hello');
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      expect(gateway.requests.length).toBeGreaterThan(0);
      const [first] = gateway.requests;
      expect(first.method).toBe('POST');
      expect(first.path).toBe('/v1/responses');
      expect(first.authorization).toBe(`Bearer ${bearer}`);
    }, 90_000);

    it('leaves the gateway as the only thing that decides to spend', async () => {
      gateway = await startStubGateway();
      const session = await launch({
        configToml: buildHostedProviderConfig({ baseUrl: gateway.baseUrl, model: 'gpt-5-codex' }),
        injectedEnv: { [HOSTED_API_KEY_ENV]: 'live-bearer-token' },
      });
      const driver = createSupervisorDriver({ supervisor: session.supervisor });
      driver.onServerRequest((request) => request.refuse('not under test'));

      await driver.send('say hello');
      await new Promise((resolve) => setTimeout(resolve, 10_000));

      expect(gateway.requests).toHaveLength(1);
    }, 90_000);
  });
});

const RESERVATION_ID = '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e';

function baseEvent(
  seq: number,
  stepSequence: number
): {
  readonly v: 2;
  readonly seq: number;
  readonly requestId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly stepSequence: number;
} {
  return {
    v: 2,
    seq,
    requestId: `request-${stepSequence}`,
    runId: 'live-tool',
    turnId: 'turn-live-tool',
    stepSequence,
  };
}

function finishEvent(seq: number, stepSequence: number, unified: 'tool-calls' | 'stop') {
  return {
    ...baseEvent(seq, stepSequence),
    event: 'finish' as const,
    reservationId: RESERVATION_ID,
    usageEventId: null,
    outcome: 'completed' as const,
    usage: {
      status: 'reported' as const,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
    finishReason: { unified, raw: unified },
    workflowTrace: null,
    researchContributionNotice: null,
  };
}

async function* toolStep(): AsyncGenerator<HostedStreamEvent> {
  yield {
    ...baseEvent(1, 1),
    event: 'accepted',
    reservationId: RESERVATION_ID,
    tier: 'auto',
    catalogVersion: '1.0.0',
    rateCardVersion: '1.0.0',
  };
  yield {
    ...baseEvent(2, 1),
    event: 'reasoning_continuation',
    itemId: 'rs_provider_empty_summary',
    encryptedContent: 'encrypted-provider-reasoning',
  };
  yield {
    ...baseEvent(3, 1),
    event: 'tool_call',
    toolCallId: 'call-get-workspace',
    name: 'get_workspace',
    input: {},
    ticket: {
      token: 'ticketpayload.ticketsignature',
      expiresAt: '2026-08-20T00:00:00.000Z',
      providerCallId: 'call-get-workspace',
      toolName: 'get_workspace',
      requiresUserApproval: false,
    },
  };
  yield finishEvent(4, 1, 'tool-calls');
}

async function* answerStep(): AsyncGenerator<HostedStreamEvent> {
  yield {
    ...baseEvent(1, 2),
    event: 'accepted',
    reservationId: RESERVATION_ID,
    tier: 'auto',
    catalogVersion: '1.0.0',
    rateCardVersion: '1.0.0',
  };
  yield { ...baseEvent(2, 2), event: 'text_delta', delta: 'Found pUC19.gb.' };
  yield finishEvent(3, 2, 'stop');
}

async function* legacyDiscoveryStep(step: number): AsyncGenerator<HostedStreamEvent> {
  yield {
    ...baseEvent(1, step),
    event: 'accepted',
    reservationId: RESERVATION_ID,
    tier: 'auto',
    catalogVersion: '1.0.0',
    rateCardVersion: '1.0.0',
  };
  if (step === 1) {
    yield {
      ...baseEvent(2, step),
      event: 'child_tool_call',
      toolCallId: 'call-discovery',
      name: hostedResponsesFunctionWireName(HOSTED_TOOL_DISCOVERY_NAME),
      input: { query: 'create_design' },
    };
  } else if (step === 2) {
    yield {
      ...baseEvent(2, step),
      event: 'child_tool_call',
      toolCallId: 'call-discovery-second-page',
      name: hostedResponsesFunctionWireName(HOSTED_TOOL_DISCOVERY_NAME),
      input: { query: 'get_workspace' },
    };
  } else if (step === 3) {
    yield {
      ...baseEvent(2, step),
      event: 'tool_call',
      toolCallId: 'call-create-design',
      name: 'create_design',
      input: { name: 'Owned design' },
      ticket: {
        token: 'ticketpayload.ticketsignature',
        expiresAt: '2099-01-01T00:00:00.000Z',
        providerCallId: 'call-create-design',
        toolName: 'create_design',
        requiresUserApproval: true,
      },
    };
  } else {
    yield { ...baseEvent(2, step), event: 'text_delta', delta: 'Saved design.' };
  }
  yield finishEvent(3, step, step < 4 ? 'tool-calls' : 'stop');
}
