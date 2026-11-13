import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOSTED_RESPONSES_MAX_TOOLS } from '@waypoint/hosted-ai-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { createAgentStateCapsuleTable, AgentStateCapsuleStore } from './agent-state-capsule';
import type { ResolvedCodexAppServerBinary } from './app-server-binary';
import { hostedCodexToolWireName, hostedCodexWireInputSchema } from './dynamic-tool-catalog';
import {
  HOSTED_CODEX_RESERVED_TOOLS,
  runHostedTurnAfterStartupBarrier,
  startHostedSession,
  type HostedSession,
} from './hosted-session';
import { HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS } from './responses-wire';
import { buildHostedProviderToolCatalog } from './hosted-tool-discovery';
import type { ResponsesRequestSizeTrace, ResponsesTransportTrace } from './responses-server';
import { appendHostedCodexTurnJournal } from './turn-journal';
import { checkOriginalAssembly } from '../../../../../e2e/electron/helpers/original-assembly-acceptance';

const BINARY: ResolvedCodexAppServerBinary = {
  path: '/pinned/codex-app-server',
  version: '0.148.0',
  versionOutput: 'codex-app-server 0.148.0',
  triple: 'aarch64-apple-darwin',
  packageVersion: '0.9.0',
  sha256: 'a'.repeat(64),
};

let roots: string[] = [];
let sessions: HostedSession[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hosted-session-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const session of sessions) await session.close().catch(() => undefined);
  sessions = [];
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

function fakeSpawn(
  behavior: {
    readonly throwOnSpawn?: Error;
    readonly silent?: boolean;
    readonly completeTurn?: boolean;
  } = {}
) {
  const state = {
    killed: [] as string[],
    env: null as NodeJS.ProcessEnv | null,
    requests: [] as { method: unknown; params: unknown }[],
    completeTurn: (): void => {},
    exitChild: (): void => {},
  };
  const spawn = ((command: string, args: readonly string[], opts: Record<string, unknown>) => {
    if (behavior.throwOnSpawn) throw behavior.throwOnSpawn;
    state.env = opts.env as NodeJS.ProcessEnv;
    state.exitChild = () => exit.emit('exit', 1, null);
    const stdout = new EventEmitter();
    const exit = new EventEmitter();
    state.completeTurn = () => {
      stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-1',
              delta: 'done',
            },
          })}\n${JSON.stringify({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', status: 'completed' },
            },
          })}\n`,
          'utf8'
        )
      );
    };
    return {
      stdin: {
        write: (chunk: string) => {
          if (behavior.silent) return;
          const message = JSON.parse(chunk) as Record<string, unknown>;
          state.requests.push({ method: message.method, params: message.params });
          const result =
            message.method === 'thread/start'
              ? { thread: { id: 'thread-1' } }
              : message.method === 'turn/start'
                ? { turn: { id: 'turn-1' } }
                : message.method === 'turn/interrupt'
                  ? {}
                  : {
                      userAgent: 'dnaforge/0.148.0',
                      codexHome: (state.env ?? {}).CODEX_HOME,
                      platformFamily: 'unix',
                      platformOs: 'macos',
                    };
          queueMicrotask(() => {
            stdout.emit(
              'data',
              Buffer.from(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: message.id,
                  result,
                })}\n`,
                'utf8'
              )
            );
            if (behavior.completeTurn && message.method === 'turn/start') {
              state.completeTurn();
            }
          });
        },
      },
      stdout,
      on: (event: 'exit', listener: () => void) => void exit.on(event, listener),
      kill: (signal = 'SIGTERM') => void state.killed.push(String(signal)),
      __exit: () => exit.emit('exit', 1, null),
    } as never;
  }) as never;
  return { spawn, state };
}

function store(): AgentStateCapsuleStore {
  const db = createTestDb();
  createAgentStateCapsuleTable(db);
  return new AgentStateCapsuleStore(db);
}

async function start(
  overrides: Partial<Parameters<typeof startHostedSession>[0]> = {}
): Promise<{ session: HostedSession; state: ReturnType<typeof fakeSpawn>['state']; dir: string }> {
  const dir = root();
  const spawned = overrides.spawn
    ? { spawn: overrides.spawn, state: fakeSpawn().state }
    : fakeSpawn();
  const session = await startHostedSession({
    binary: BINARY,
    rootDir: dir,
    runId: 'run-1',
    model: 'gpt-5-codex',
    store: store(),
    step: () => (async function* () {})(),
    spawn: spawned.spawn,
    ...overrides,
  });
  sessions.push(session);
  return { session, state: spawned.state, dir };
}

function runtimeDirs(dir: string): string[] {
  try {
    return readdirSync(path.join(dir, 'hosted-codex-runtime'));
  } catch {
    return [];
  }
}

describe('startHostedSession', () => {
  it('carries actual projection counts through the existing main trace/journal to fixed acceptance', async () => {
    const responseStreams: ResponsesTransportTrace[] = [];
    const requestSizes: ResponsesRequestSizeTrace[] = [];
    const { session, state, dir } = await start({
      onTransportTrace: (trace) => responseStreams.push(trace),
      onRequestSizeTrace: (trace) => requestSizes.push(trace),
    });
    await session.driver.send('Register the synthetic inventory observation');
    const thread = state.requests.find((request) => request.method === 'thread/start');
    const params = thread?.params;
    if (
      !params ||
      typeof params !== 'object' ||
      !('dynamicTools' in params) ||
      !Array.isArray(params.dynamicTools)
    )
      throw new Error('Thread registration was not observed');
    const registeredChildDefinitionCount =
      params.dynamicTools.length + Object.keys(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS).length;
    expect(registeredChildDefinitionCount).toBeGreaterThan(0);
    const offered = buildHostedProviderToolCatalog(session.catalog).tools.map((tool) => ({
      type: 'function',
      name: hostedCodexToolWireName(tool.name),
      description: tool.description,
      strict: false,
      parameters: hostedCodexWireInputSchema(tool.inputSchema),
    }));
    session.turn.beginProviderStep();
    const response = await fetch(`${session.endpoint.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.endpoint.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        input: [{ type: 'message', role: 'user', content: 'PRIVATE UNIT PROMPT' }],
        stream: true,
        store: false,
        tools: offered,
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(responseStreams).toHaveLength(1);
    expect(responseStreams[0].toolInventory).toMatchObject({
      status: 'observed',
      requestSequence: 0,
      authorizationCatalogDefinitionCount: session.catalog.tools.length,
      registeredChildDefinitionCount,
      childOfferedDefinitionCount: offered.length,
      gatewayBaseDefinitionCount: offered.length - 1,
      gatewayForwardedDefinitionCount: offered.length - 1,
      retainedDefinitionCount: 0,
      acceptedDiscoveryPageCount: 0,
    });
    const journal = await appendHostedCodexTurnJournal({
      userDataRoot: dir,
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      gateway: {
        gatewayOrigin: 'https://unit.invalid',
        catalogVersion: null,
        rateCardVersion: null,
        reservationIds: [],
        usageEventIds: [],
        workflowRunId: null,
        workflowStepId: null,
        completedToolCallIds: [],
        providerAttempts: 1,
        terminalError: null,
      },
      artifact: {
        desktopSourceCommit: null,
        appServerVersion: BINARY.version,
        appServerSha256: BINARY.sha256,
        appServerTarget: BINARY.triple,
      },
      transport: {
        responseStreams,
        requestSizes,
        childFailure: null,
        toolInventorySummary: { ...session.getToolInventorySummary(), status: 'observed' },
      },
      outcome: 'completed',
      answer: '',
    });
    expect(JSON.stringify(journal.transport)).not.toContain('PRIVATE UNIT PROMPT');
    const result = checkOriginalAssembly({
      journal,
      turns: [
        {
          id: 'turn-1',
          conversation_id: 'conversation-1',
          route_kind: 'hosted',
          host_id: 'unit',
          provider: null,
          model: null,
          transport: null,
          authority_profile_id: null,
          permission_mode: null,
          route_snapshot_json: '{}',
          status: 'completed',
          terminal_reason: 'completed',
          error: null,
          started_at: 1,
          completed_at: 2,
        },
      ],
    });
    expect(result.recordedJourney.checks).toContainEqual({
      criterion: 'catalog-definition-and-retained-projection-ceilings',
      status: 'PASS',
    });
    expect(result.parentComplete).toBe(false);
  });
  it('keeps the full execution catalog while bounding the actual thread registration', async () => {
    const { session, state } = await start({
      allowEffects: ['read-only', 'ui-bound', 'mutating'],
    });
    await session.driver.send('inspect available actions');
    const thread = state.requests.find((request) => request.method === 'thread/start');
    const dynamicTools = (thread?.params as { dynamicTools: unknown[] }).dynamicTools;
    const toolCount =
      dynamicTools.length + Object.keys(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS).length;
    expect(toolCount).toBe(17);
    expect(session.catalog.tools.length).toBeGreaterThan(dynamicTools.length);

    expect(toolCount).toBeLessThanOrEqual(HOSTED_RESPONSES_MAX_TOOLS);
    expect(HOSTED_CODEX_RESERVED_TOOLS).toContain('operations.variant-source-preparation.start');
    expect(HOSTED_CODEX_RESERVED_TOOLS).toEqual(
      expect.arrayContaining([
        'add_indexed_bigwig_url',
        'set_indexed_current_view',
        'compute.listProviders',
        'compute.listTools',
        'compute.getSchema',
        'compute.validate',
        'compute.estimate',
        'compute.submit',
        'compute.status',
        'compute.cancel',
        'compute.importResult',
        'close_tab',
      ])
    );
    const hostedToolNames = session.catalog.tools.map((tool) => tool.name);
    expect(hostedToolNames).toEqual(
      expect.arrayContaining(['compose_indexed_track_view', 'configure_indexed_track'])
    );
    expect(hostedToolNames).not.toEqual(expect.arrayContaining([...HOSTED_CODEX_RESERVED_TOOLS]));
  });

  describe('startup Stop barrier', () => {
    it('stops without entering the turn loop when Stop wins the startup race', async () => {
      const stop = vi.fn().mockResolvedValue(undefined);
      const runTurn = vi.fn().mockResolvedValue({ outcome: 'completed', text: 'must not run' });

      await expect(
        runHostedTurnAfterStartupBarrier({ stop }, () => true, runTurn)
      ).resolves.toEqual({ outcome: 'stopped', text: '' });
      expect(stop).toHaveBeenCalledOnce();
      expect(runTurn).not.toHaveBeenCalled();
    });

    it('enters the turn loop before a later Stop can win the startup race', async () => {
      const stop = vi.fn().mockResolvedValue(undefined);
      let turnEntered = false;
      const runTurn = vi.fn(() => {
        turnEntered = true;
        return Promise.resolve({ outcome: 'completed' as const, text: 'done' });
      });

      const result = runHostedTurnAfterStartupBarrier({ stop }, () => false, runTurn);
      expect(turnEntered).toBe(true);

      await expect(result).resolves.toEqual({ outcome: 'completed', text: 'done' });
      expect(stop).not.toHaveBeenCalled();
      expect(runTurn).toHaveBeenCalledOnce();
    });
  });

  describe('what the child is told', () => {
    it('admits the same private catalog model that the production launcher configures', async () => {
      const { session } = await start();
      const response = await fetch(`${session.endpoint.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.endpoint.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5-codex',
          input: [{ type: 'message', role: 'user', content: 'hello' }],
          stream: true,
          store: false,
          tools: buildHostedProviderToolCatalog(session.catalog).tools.map((tool) => ({
            type: 'function',
            name: hostedCodexToolWireName(tool.name),
            description: tool.description,
            strict: false,
            parameters: hostedCodexWireInputSchema(tool.inputSchema),
          })),
        }),
      });

      expect(response.status).toBe(200);
      await response.text();
    });

    it('routes the child to the endpoint through its private provider config', async () => {
      const { session, state, dir } = await start();
      const env = state.env ?? {};
      expect(env.OPENAI_API_KEY).toBe(session.endpoint.bearerToken);
      expect(env).not.toHaveProperty('OPENAI_BASE_URL');

      const runtime = runtimeDirs(dir);
      expect(runtime).toHaveLength(1);
      const config = readFileSync(
        path.join(dir, 'hosted-codex-runtime', runtime[0], 'codex-home', 'config.toml'),
        'utf8'
      );
      expect(config).toContain(`base_url = "${session.endpoint.baseUrl}/v1"`);
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('request_max_retries = 0');
      expect(config).toContain('stream_max_retries = 0');
    });

    it('still refuses to inherit the host environment', async () => {
      const { session, state } = await start({
        hostEnv: { PATH: '/usr/bin', OPENAI_API_KEY: 'the-users-real-key', HOME: '/Users/someone' },
      });
      const env = state.env ?? {};
      expect(env).not.toHaveProperty('PATH');
      expect(env.HOME).toBe(session.appServer.isolation.codexHome);
      expect(env.HOME).not.toBe('/Users/someone');
      expect(env.OPENAI_API_KEY).toBe(session.endpoint.bearerToken);
    });

    it('points the child at loopback', async () => {
      const { session } = await start();
      expect(session.endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe('ordering', () => {
    it('is listening before the child is launched', async () => {
      const reachable: boolean[] = [];
      const probe = fakeSpawn();
      const spawn = ((command: string, args: readonly string[], opts: Record<string, unknown>) => {
        const env = opts.env as NodeJS.ProcessEnv;
        reachable.push(typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0);
        return (probe.spawn as unknown as (...a: unknown[]) => unknown)(
          command,
          args,
          opts
        ) as never;
      }) as never;
      await start({ spawn });
      expect(reachable).toEqual([true]);
    });
  });

  describe('lifetime', () => {
    it('leaves nothing running when the child fails to start', async () => {
      const dir = root();
      const { spawn } = fakeSpawn({ throwOnSpawn: new Error('ENOENT') });
      let started: HostedSession['endpoint'] | null = null;
      await expect(
        startHostedSession({
          binary: BINARY,
          rootDir: dir,
          runId: 'run-x',
          model: 'gpt-5-codex',
          store: store(),
          step: () => (async function* () {})(),
          spawn,
          onEndpointStarted: (endpoint) => {
            started = endpoint;
          },
        })
      ).rejects.toThrow();
      expect(runtimeDirs(dir)).toEqual([]);

      const endpoint = started as HostedSession['endpoint'] | null;
      expect(endpoint).not.toBeNull();
      const net = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(endpoint!.port, '127.0.0.1', () => probe.close(() => resolve()));
      });
    });

    it('releases the port, the child, and the directory when it closes', async () => {
      const { session, state, dir } = await start();
      const { port } = session.endpoint;
      await session.close();
      expect(state.killed.length).toBeGreaterThanOrEqual(1);
      expect(runtimeDirs(dir)).toEqual([]);
      const net = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
      });
    });

    it('releases the endpoint when the child dies on its own', async () => {
      const { session, state } = await start();
      const { port } = session.endpoint;
      state.exitChild();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const net = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
      });
    });

    it('is safe to close twice', async () => {
      const { session } = await start();
      await session.close();
      await expect(session.close()).resolves.toBeUndefined();
    });
  });

  describe('stopping', () => {
    it('stops the turn and the child together', async () => {
      const { session, state } = await start();
      await session.stop();
      expect(session.turn.stopRequested).toBe(true);
      expect(state.killed.length).toBeGreaterThanOrEqual(1);
    });

    it('refuses to start a step once stopped', async () => {
      const { session } = await start();
      await session.stop();
      expect(() => session.turn.beginProviderStep()).toThrow();
    });
  });

  it('records the run durably from the first action', async () => {
    const capsules = store();
    const { session } = await start({ store: capsules });
    session.turn.beginProviderStep();
    const active = capsules.readActive('run-1');
    expect(active?.runId).toBe('run-1');
  });

  it('charges child-executed calls against the turn tool-call budget', async () => {
    const capsules = store();
    const { session } = await start({
      store: capsules,
      step: () =>
        (async function* () {
          yield {
            v: 2 as const,
            seq: 1,
            requestId: 'child-tool-request',
            runId: 'run-1',
            turnId: 'child-tool-turn',
            stepSequence: 0,
            event: 'child_tool_call' as const,
            toolCallId: 'child-tool-call-1',
            name: 'exec_command',
            input: { cmd: 'pwd' },
          };
        })(),
    });

    const response = await fetch(`${session.endpoint.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.endpoint.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        input: [{ type: 'message', role: 'user', content: 'Run pwd.' }],
        stream: true,
        store: false,
        tools: buildHostedProviderToolCatalog(session.catalog).tools.map((tool) => ({
          type: 'function',
          name: hostedCodexToolWireName(tool.name),
          description: tool.description,
          strict: false,
          parameters: hostedCodexWireInputSchema(tool.inputSchema),
        })),
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(capsules.readActive('run-1')?.budget.toolCalls).toBe(1);
  });

  it('owns the production call site that runs one real App Server turn', async () => {
    const spawned = fakeSpawn({ completeTurn: true });
    const { session } = await start({ spawn: spawned.spawn });

    const result = await session.runTurn({
      message: 'inspect the workspace',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });

    expect(result).toEqual({ outcome: 'completed', text: 'done' });
    expect(spawned.state.requests.map((request) => request.method)).toEqual([
      'initialize',
      'thread/start',
      'turn/start',
    ]);
  });

  it('adopts the precharged first provider request instead of counting it twice', async () => {
    const capsules = store();
    const spawned = fakeSpawn();
    const { session } = await start({ store: capsules, spawn: spawned.spawn });

    const turn = session.runTurn({
      message: 'inspect the workspace',
      execute: async () => ({ outcome: 'applied', output: null }),
      approve: async () => 'approved',
    });
    await vi.waitFor(() =>
      expect(spawned.state.requests.some((request) => request.method === 'turn/start')).toBe(true)
    );

    const response = await fetch(`${session.endpoint.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.endpoint.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        input: [{ type: 'message', role: 'user', content: 'inspect the workspace' }],
        stream: true,
        store: false,
        tools: buildHostedProviderToolCatalog(session.catalog).tools.map((tool) => ({
          type: 'function',
          name: hostedCodexToolWireName(tool.name),
          description: tool.description,
          strict: false,
          parameters: hostedCodexWireInputSchema(tool.inputSchema),
        })),
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    spawned.state.completeTurn();

    await expect(turn).resolves.toEqual({ outcome: 'completed', text: 'done' });
    expect(capsules.readActive('run-1')?.budget.providerAttempts).toBe(1);
  });

  it('settles a precharged provider step when the Responses consumer disconnects', async () => {
    const capsules = store();
    let sourceUnwound!: () => void;
    const unwound = new Promise<void>((resolve) => {
      sourceUnwound = resolve;
    });
    const { session } = await start({
      store: capsules,
      step: () =>
        (async function* () {
          try {
            yield {
              v: 2 as const,
              seq: 1,
              requestId: 'disconnect-request',
              runId: 'run-1',
              turnId: 'disconnect-turn',
              stepSequence: 0,
              event: 'accepted' as const,
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              tier: 'auto' as const,
              catalogVersion: '1.0.0',
              rateCardVersion: '1.0.0',
            };
            yield {
              v: 2 as const,
              seq: 2,
              requestId: 'disconnect-request',
              runId: 'run-1',
              turnId: 'disconnect-turn',
              stepSequence: 0,
              event: 'text_delta' as const,
              delta: 'x'.repeat(16 * 1024 * 1024),
            };
            await new Promise(() => {});
          } finally {
            sourceUnwound();
          }
        })(),
    });
    session.turn.beginProviderStep();
    const response = await fetch(`${session.endpoint.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.endpoint.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        input: [{ type: 'message', role: 'user', content: 'disconnect' }],
        stream: true,
        store: false,
        tools: buildHostedProviderToolCatalog(session.catalog).tools.map((tool) => ({
          type: 'function',
          name: hostedCodexToolWireName(tool.name),
          description: tool.description,
          strict: false,
          parameters: hostedCodexWireInputSchema(tool.inputSchema),
        })),
      }),
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader!.read();
    await reader!.cancel();
    await expect(
      Promise.race([
        unwound.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ])
    ).resolves.toBe(true);
    expect(() => session.turn.beginProviderStep()).toThrow(/gateway's to retry/);
  });

  it('surfaces the handshake failure rather than a half-started session', async () => {
    const dir = root();
    const { spawn } = fakeSpawn({ silent: true });
    await expect(
      startHostedSession({
        binary: BINARY,
        rootDir: dir,
        runId: 'run-y',
        model: 'gpt-5-codex',
        store: store(),
        step: () => (async function* () {})(),
        spawn,
        handshakeTimeoutMs: 200,
      })
    ).rejects.toThrow();
    expect(runtimeDirs(dir)).toEqual([]);
  });
});
