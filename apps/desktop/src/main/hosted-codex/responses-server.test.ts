import net from 'node:net';
import os from 'node:os';
import {
  HOSTED_REQUEST_SIZE_WARNING_BYTES,
  MAX_HOSTED_WHOLE_REQUEST_BYTES,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';
import { describe, expect, it, afterEach } from 'vitest';

import { buildHostedCodexTurnInput } from '../../features/ai/prompts/hosted-codex-prompt';

import {
  buildHostedCodexToolCatalog,
  hostedCodexToolWireName,
  hostedCodexWireInputSchema,
} from './dynamic-tool-catalog';
import { HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS, ResponsesWireError } from './responses-wire';
import {
  HostedCodexStreamFailure,
  ResponsesStepFailure,
  startResponsesServer,
  type ResponsesRequestSizeTrace,
  type ResponsesServer,
  type ResponsesTransportTrace,
  type ResponsesServerOptions,
  type ResponsesStepDiagnostics,
} from './responses-server';
import type { HostedToolInventoryCounts } from './tool-inventory-observation';

const tools = buildHostedCodexToolCatalog().tools;
const firstTool = tools[0]!;
const dottedTool = tools.find((tool) => tool.name.includes('.'))!;

let server: ResponsesServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function* silentStep(): AsyncGenerator<never, void, unknown> {}

interface StartOptions {
  readonly step?: ResponsesServerOptions['step'];
  readonly maxRequestBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly onTransportTrace?: (trace: ResponsesTransportTrace) => void;
  readonly onRequestSizeTrace?: (trace: ResponsesRequestSizeTrace) => void;
}

async function start(options: StartOptions = {}): Promise<ResponsesServer> {
  server = await startResponsesServer({
    model: 'gpt-5-codex',
    tools,
    step: options.step ?? (() => silentStep()),
    maxRequestBytes: options.maxRequestBytes,
    requestTimeoutMs: options.requestTimeoutMs,
    onTransportTrace: options.onTransportTrace,
    onRequestSizeTrace: options.onRequestSizeTrace,
  });
  return server;
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'gpt-5-codex',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    stream: true,
    store: false,
    tools: tools.map((tool) => ({
      type: 'function',
      name: hostedCodexToolWireName(tool.name),
      description: tool.description,
      strict: false,
      parameters: hostedCodexWireInputSchema(tool.inputSchema),
    })),
    ...overrides,
  });
}

function productionContinuationBody(): string {
  const readToolNames = ['get_workspace', 'list_files', 'get_sequence', 'get_moclo_kit'];
  const selected = readToolNames.map((name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`production Hosted catalog is missing ${name}`);
    return tool;
  });
  const toolHistory: Record<string, unknown>[] = [];
  for (let index = 0; index < 26; index += 1) {
    const tool = selected[index % selected.length]!;
    const callId = `fixture-call-${String(index + 1).padStart(2, '0')}`;
    toolHistory.push(
      {
        type: 'function_call',
        call_id: callId,
        name: hostedCodexToolWireName(tool.name),
        arguments: JSON.stringify({ fixtureIndex: index + 1 }),
      },
      {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ fixture: 'synthetic-read-result', value: index + 1 }),
      }
    );
  }
  const capturedHistoryBytes = 128_729;
  const beforePadding = Buffer.byteLength(JSON.stringify(toolHistory), 'utf8');
  const finalOutput = toolHistory.at(-1) as { output: string };
  finalOutput.output += 'x'.repeat(capturedHistoryBytes - beforePadding);
  expect(Buffer.byteLength(JSON.stringify(toolHistory), 'utf8')).toBe(capturedHistoryBytes);

  const turnInput = buildHostedCodexTurnInput({
    folders: [{ name: 'Synthetic workspace', path: '/fixture/workspace', addedAt: 1 }],
    messages: [
      {
        id: 'fixture-user-message',
        role: 'user',
        content: 'Summarize the inspected synthetic workspace.',
        createdAt: 1,
      },
    ],
    currentUserMessageId: 'fixture-user-message',
    hasWorkspace: true,
  });

  const request = {
    model: 'gpt-5-codex',
    instructions: turnInput.developerInstructions,
    input: [{ type: 'message', role: 'user', content: turnInput.userMessage }, ...toolHistory],
    reasoning: { effort: 'medium', summary: 'auto' },
    prompt_cache_key: 'fixture-thread-fixture',
    include: ['reasoning.encrypted_content'],
    parallel_tool_calls: true,
    client_metadata: { fixture: 'fixture' },
    stream: true,
    store: false,
    tools: [
      ...tools.map((tool) => ({
        type: 'function',
        name: hostedCodexToolWireName(tool.name),
        description: tool.description,
        strict: false,
        parameters: hostedCodexWireInputSchema(tool.inputSchema),
      })),
      structuredClone(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS.request_user_input!),
    ],
  };

  const capturedWholeRequestLowerBound = 276_383;
  const beforeIncidentPadding = Buffer.byteLength(JSON.stringify(request), 'utf8');
  expect(beforeIncidentPadding).toBeLessThan(capturedWholeRequestLowerBound);
  finalOutput.output += 'x'.repeat(capturedWholeRequestLowerBound - beforeIncidentPadding);
  const serialized = JSON.stringify(request);
  expect(Buffer.byteLength(serialized, 'utf8')).toBe(capturedWholeRequestLowerBound);
  return serialized;
}

async function post(
  target: ResponsesServer,
  init: { body?: string; headers?: Record<string, string>; path?: string; method?: string } = {}
): Promise<Response> {
  return fetch(`${target.baseUrl}${init.path ?? '/v1/responses'}`, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${target.bearerToken}`,
      ...init.headers,
    },
    body: init.body ?? validBody(),
  });
}

describe('startResponsesServer', () => {
  describe('request-bound inventory observations', () => {
    const counts: HostedToolInventoryCounts = {
      projectionSequence: 0,
      authorizationCatalogDefinitionCount: 300,
      registeredChildDefinitionCount: 17,
      childOfferedDefinitionCount: 17,
      gatewayBaseDefinitionCount: 16,
      gatewayForwardedDefinitionCount: 16,
      retainedDefinitionCount: 0,
      maxRetainedDefinitionCount: 0,
      acceptedDiscoveryPageCount: 0,
      lastAcceptedDiscoveryPageDefinitionCount: 0,
      maxAcceptedDiscoveryPageDefinitionCount: 0,
    };
    it('binds to the real HTTP sequence even when a prior request was refused', async () => {
      const traces: ResponsesTransportTrace[] = [];
      const started = await start({
        onTransportTrace: (trace) => traces.push(trace),
        step: (_request, diagnostics) => {
          diagnostics.observeToolInventory(counts);
          return silentStep();
        },
      });
      const refused = await post(started, { body: validBody({ store: true }) });
      expect(refused.status).toBe(400);
      await refused.text();
      const accepted = await post(started);
      await accepted.text();
      expect(accepted.status).toBe(200);
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        responseSequence: 0,
        requestSequence: 1,
        toolInventory: { ...counts, status: 'observed', requestSequence: 1 },
      });
      expect(JSON.stringify(traces[0].toolInventory)).not.toContain('hello');
    });
    it('does not let a closed request observer supply counts for the next request', async () => {
      const traces: ResponsesTransportTrace[] = [];
      let stale: ResponsesStepDiagnostics | undefined;
      const started = await start({
        onTransportTrace: (trace) => traces.push(trace),
        step: (_request, diagnostics) => {
          if (stale) stale.observeToolInventory(counts);
          else stale = diagnostics;
          return silentStep();
        },
      });
      for (let index = 0; index < 2; index++) {
        const response = await post(started);
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(traces.map((trace) => trace.toolInventory)).toEqual([
        { status: 'incomplete' },
        { status: 'incomplete' },
      ]);
      expect(traces.map((trace) => trace.requestSequence)).toEqual([0, 1]);
    });
    it('records conflicting duplicate diagnostics as invalid while preserving the response', async () => {
      const traces: ResponsesTransportTrace[] = [];
      const started = await start({
        onTransportTrace: (trace) => traces.push(trace),
        step: (_request, diagnostics) => {
          diagnostics.observeToolInventory(counts);
          diagnostics.observeToolInventory({ ...counts, retainedDefinitionCount: 1 });
          return silentStep();
        },
      });
      const response = await post(started);
      expect(response.status).toBe(200);
      await response.text();
      expect(traces[0].toolInventory).toEqual({ status: 'invalid' });
    });
    it('isolates malformed diagnostic getters from the provider and error path', async () => {
      const traces: ResponsesTransportTrace[] = [];
      const bad = Object.defineProperty({ ...counts }, 'retainedDefinitionCount', {
        enumerable: true,
        get: () => {
          throw new Error('PRIVATE diagnostic error');
        },
      });
      const started = await start({
        onTransportTrace: (trace) => traces.push(trace),
        step: (_request, diagnostics) => {
          diagnostics.observeToolInventory(bad);
          return silentStep();
        },
      });
      const response = await post(started);
      expect(response.status).toBe(200);
      await response.text();
      expect(traces[0].toolInventory).toEqual({ status: 'invalid' });
      expect(JSON.stringify(traces)).not.toContain('PRIVATE');
    });
  });
  describe('binding', () => {
    it('listens on loopback and never a routable address', async () => {
      const started = await start();
      expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(started.port).toBeGreaterThan(0);
    });

    it('mints a token long enough not to be guessed, and a different one each time', async () => {
      const first = await start();
      const firstToken = first.bearerToken;
      await first.close();
      const second = await start();
      expect(firstToken).not.toBe(second.bearerToken);
      expect(second.bearerToken.length).toBeGreaterThanOrEqual(32);
    });

    it("is unreachable on this host's other addresses", async () => {
      const started = await start();
      const routable = Object.values(os.networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .find((entry) => entry.family === 'IPv4' && !entry.internal);
      if (!routable) {
        expect(started.address).toBe('127.0.0.1');
        return;
      }
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ port: started.port, host: routable.address });
        const settle = (value: boolean) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(3_000, () => settle(false));
        socket.on('connect', () => settle(true));
        socket.on('error', () => settle(false));
      });
      expect(reachable).toBe(false);
      expect(started.address).toBe('127.0.0.1');
    });

    it('closes connections that are still open when it shuts down', async () => {
      const started = await start({
        step: () =>
          (async function* () {
            await new Promise(() => {});
            yield undefined as never;
          })(),
      });
      const socketEnded = new Promise<boolean>((resolve) => {
        const socket = net.connect(started.port, '127.0.0.1', () => {
          const body = validBody();
          socket.write(
            `POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
              `Authorization: Bearer ${started.bearerToken}\r\n` +
              `Content-Type: application/json\r\n` +
              `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
          );
        });
        const giveUp = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 8_000);
        const settle = (value: boolean) => {
          clearTimeout(giveUp);
          socket.destroy();
          resolve(value);
        };
        socket.on('close', () => settle(true));
        socket.on('end', () => settle(true));
        socket.on('error', () => settle(true));
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await started.close();
      server = undefined;
      expect(await socketEnded).toBe(true);
    }, 15_000);

    it('releases the port when closed', async () => {
      const started = await start();
      const { port } = started;
      await started.close();
      server = undefined;
      const reused = await startResponsesServer({
        model: 'gpt-5-codex',
        tools,
        step: () => silentStep(),
        port,
      });
      expect(reused.port).toBe(port);
      await reused.close();
    });

    it('is safe to close twice', async () => {
      const started = await start();
      await started.close();
      await expect(started.close()).resolves.toBeUndefined();
      server = undefined;
    });
  });

  describe('admission', () => {
    it('accepts the request the launched child is expected to make', async () => {
      const started = await start();
      const response = await post(started);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      await response.text();
    });

    it('refuses a request with no bearer', async () => {
      const started = await start();
      const response = await fetch(`${started.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validBody(),
      });
      expect(response.status).toBe(401);
      await response.text();
    });

    it('refuses a wrong bearer', async () => {
      const started = await start();
      const response = await post(started, { headers: { authorization: 'Bearer nope' } });
      expect(response.status).toBe(401);
      await response.text();
    });

    it.each([
      ['POST', '/v1/chat/completions'],
      ['POST', '/'],
    ])('refuses %s %s', async (method, path) => {
      const started = await start();
      const response = await post(started, { method, path, body: validBody() });
      expect(response.status).toBe(404);
      await response.text();
    });

    it.each(['GET', 'DELETE', 'PUT'])('refuses %s on the served route', async (method) => {
      const started = await start();
      const response = await fetch(`${started.baseUrl}/v1/responses`, {
        method,
        headers: { authorization: `Bearer ${started.bearerToken}` },
      });
      expect(response.status).toBe(404);
      await response.text();
    });

    it.each([
      ['store true', { store: true }],
      ['wrong model', { model: 'gpt-4o' }],
      ['unknown field', { previous_response_id: 'r1' }],
    ])('refuses %s with a client error', async (_label, override) => {
      const started = await start();
      const response = await post(started, { body: validBody(override) });
      expect(response.status).toBe(400);
      await response.text();
    });

    it('refuses an unauthorized tool', async () => {
      const started = await start();
      const response = await post(started, {
        body: validBody({ tools: [{ type: 'function', name: 'exfiltrate', parameters: {} }] }),
      });
      expect(response.status).toBe(400);
      await response.text();
    });

    it('names the refusal without describing the runtime behind it', async () => {
      const started = await start();
      const response = await post(started, { body: validBody({ store: true }) });
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      expect(payload.error?.code).toBe('store_not_disabled');
      const text = JSON.stringify(payload);
      expect(text).not.toContain(started.bearerToken);
      expect(text).not.toMatch(/\/Users\/|127\.0\.0\.1|:\d{4,5}/);
    });
  });

  describe('socket limits', () => {
    it('carries the production catalog, full instructions, and 26-call regression fixture with headroom', async () => {
      const sizeTraces: ResponsesRequestSizeTrace[] = [];
      let gatewayAttempts = 0;
      const started = await start({
        onRequestSizeTrace: (trace) => sizeTraces.push(trace),
        step: () => {
          gatewayAttempts += 1;
          return silentStep();
        },
      });
      const body = productionContinuationBody();
      const measuredBytes = Buffer.byteLength(body, 'utf8');

      const response = await post(started, { body });
      await response.text();

      expect(response.status).toBe(200);
      expect(gatewayAttempts).toBe(1);
      expect(measuredBytes).toBeGreaterThan(262_144);
      expect(MAX_HOSTED_WHOLE_REQUEST_BYTES - measuredBytes).toBeGreaterThan(1024 * 1024);
      expect(measuredBytes).toBeLessThan(HOSTED_REQUEST_SIZE_WARNING_BYTES);
      expect(sizeTraces).toEqual([
        {
          requestSequence: 0,
          phase: 'initial',
          measuredBytes,
          warningBytes: HOSTED_REQUEST_SIZE_WARNING_BYTES,
          maximumBytes: MAX_HOSTED_WHOLE_REQUEST_BYTES,
          threshold: 'normal',
          disposition: 'accepted',
          gatewayAttempted: true,
        },
      ]);
      expect(JSON.stringify(sizeTraces)).not.toContain('synthetic-read-result');
    });

    it('records a typed continuation rejection without attempting or duplicating gateway work', async () => {
      const sizeTraces: ResponsesRequestSizeTrace[] = [];
      let gatewayAttempts = 0;
      const started = await start({
        maxRequestBytes: 160_000,
        onRequestSizeTrace: (trace) => sizeTraces.push(trace),
        step: () => {
          gatewayAttempts += 1;
          return silentStep();
        },
      });
      const first = await post(started, { body: validBody() });
      await first.text();
      const oversizedBody = validBody({ padding: 'x'.repeat(200_000) });
      const oversized = await post(started, { body: oversizedBody });
      await oversized.text();

      expect(oversized.status).toBe(413);
      expect(gatewayAttempts).toBe(1);
      expect(sizeTraces.at(-1)).toEqual({
        requestSequence: 1,
        phase: 'continuation',
        measuredBytes: Buffer.byteLength(oversizedBody, 'utf8'),
        warningBytes: 120_000,
        maximumBytes: 160_000,
        threshold: 'maximum',
        disposition: 'rejected',
        gatewayAttempted: false,
      });
    });

    it('marks an accepted request after the warning threshold without retaining content', async () => {
      const sizeTraces: ResponsesRequestSizeTrace[] = [];
      const body = validBody();
      const measuredBytes = Buffer.byteLength(body, 'utf8');
      const maximumBytes = measuredBytes + 1;
      const started = await start({
        maxRequestBytes: maximumBytes,
        onRequestSizeTrace: (trace) => sizeTraces.push(trace),
      });

      const response = await post(started, { body });
      await response.text();

      expect(response.status).toBe(200);
      expect(sizeTraces).toEqual([
        {
          requestSequence: 0,
          phase: 'initial',
          measuredBytes,
          warningBytes: Math.floor((maximumBytes * 3) / 4),
          maximumBytes,
          threshold: 'warning',
          disposition: 'accepted',
          gatewayAttempted: true,
        },
      ]);
      expect(JSON.stringify(sizeTraces)).not.toContain('hello');
    });

    it('refuses an oversized body as it arrives rather than after buffering it', async () => {
      const started = await start({ maxRequestBytes: 2_048 });
      const response = await post(started, {
        body: validBody({ padding: 'x'.repeat(8_192) }),
      }).catch((error: Error) => error);
      if (response instanceof Error) {
        expect(response.message.length).toBeGreaterThan(0);
      } else {
        expect(response.status).toBe(413);
        await response.text();
      }
    });

    it('refuses an oversized body that never declares its length', async () => {
      const started = await start({ maxRequestBytes: 4_096 });
      const outcome = await new Promise<'refused' | 'accepted'>((resolve) => {
        const socket = net.connect(started.port, '127.0.0.1', () => {
          socket.write(
            `POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
              `Authorization: Bearer ${started.bearerToken}\r\n` +
              `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`
          );
          const chunk = 'x'.repeat(1_024);
          let sent = 0;
          const pump = (): void => {
            if (sent > 64_000 || socket.destroyed || socket.writableEnded) return;
            sent += chunk.length;
            socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`, () => setTimeout(pump, 1));
          };
          pump();
        });
        let received = '';
        socket.on('data', (data) => {
          received += data.toString('utf8');
        });
        const giveUp = setTimeout(() => {
          socket.destroy();
          resolve(received.includes(' 413 ') ? 'refused' : 'accepted');
        }, 6_000);
        const settle = () => {
          clearTimeout(giveUp);
          socket.destroy();
          resolve(received.includes(' 200 ') ? 'accepted' : 'refused');
        };
        socket.on('close', settle);
        socket.on('error', settle);
      });
      expect(outcome).toBe('refused');
    }, 15_000);

    it('refuses a declared oversize before the body is sent at all', async () => {
      const started = await start({ maxRequestBytes: 4_096, requestTimeoutMs: 8_000 });
      const answered = await new Promise<string>((resolve) => {
        const socket = net.connect(started.port, '127.0.0.1', () => {
          socket.write(
            `POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
              `Authorization: Bearer ${started.bearerToken}\r\n` +
              `Content-Type: application/json\r\nContent-Length: 5000000\r\n\r\n`
          );
        });
        let received = '';
        socket.on('data', (data) => {
          received += data.toString('utf8');
        });
        const giveUp = setTimeout(() => {
          socket.destroy();
          resolve(received);
        }, 2_000);
        const settle = () => {
          clearTimeout(giveUp);
          socket.destroy();
          resolve(received);
        };
        socket.on('close', settle);
        socket.on('error', settle);
      });
      expect(answered).toContain(' 413 ');
    }, 15_000);

    it('unwinds a backpressured gateway step when the client disconnects', async () => {
      let entered!: () => void;
      let unwound!: () => void;
      const stepEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const stepUnwound = new Promise<void>((resolve) => {
        unwound = resolve;
      });
      const started = await start({
        step: () =>
          (async function* (): AsyncGenerator<HostedStreamEvent> {
            try {
              yield {
                v: 2,
                seq: 1,
                requestId: 'backpressure-request',
                runId: 'backpressure-run',
                turnId: 'backpressure-turn',
                stepSequence: 0,
                event: 'accepted',
                reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
                tier: 'auto',
                catalogVersion: '1.0.0',
                rateCardVersion: '1.0.0',
              };
              entered();
              yield {
                v: 2,
                seq: 2,
                requestId: 'backpressure-request',
                runId: 'backpressure-run',
                turnId: 'backpressure-turn',
                stepSequence: 0,
                event: 'text_delta',
                delta: 'x'.repeat(16 * 1024 * 1024),
              };
              await new Promise(() => {});
            } finally {
              unwound();
            }
          })(),
      });
      const socket = net.connect(started.port, '127.0.0.1', () => {
        const body = validBody();
        socket.write(
          `POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
            `Authorization: Bearer ${started.bearerToken}\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
        );
      });
      await stepEntered;
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.destroy();
      const didUnwind = await Promise.race([
        stepUnwound.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(didUnwind).toBe(true);
    }, 10_000);

    it('defaults its cap to the wire contract limit', async () => {
      const started = await start();
      expect(started.maxRequestBytes).toBe(MAX_HOSTED_WHOLE_REQUEST_BYTES);
    });

    it('does not let an idle connection pin the process', async () => {
      const started = await start({ requestTimeoutMs: 500 });
      const closedOnItsOwn = await new Promise<boolean>((resolve) => {
        const socket = net.connect(started.port, '127.0.0.1', () => {
          socket.write(
            'POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\n'
          );
        });
        const giveUp = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 8_000);
        const settle = (value: boolean) => {
          clearTimeout(giveUp);
          socket.destroy();
          resolve(value);
        };
        socket.on('close', () => settle(true));
        socket.on('end', () => settle(true));
        socket.on('error', () => settle(true));
      });
      expect(closedOnItsOwn).toBe(true);
    }, 15_000);
  });

  describe('streaming', () => {
    it('encodes a canonical dotted DNAForge tool name exactly once', async () => {
      const started = await start({
        step: () =>
          (async function* (): AsyncGenerator<HostedStreamEvent> {
            yield {
              v: 2,
              seq: 1,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'accepted',
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              tier: 'auto',
              catalogVersion: '1.0.0',
              rateCardVersion: '1.0.0',
            };
            yield {
              v: 2,
              seq: 2,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'tool_call',
              toolCallId: 'call-dotted',
              name: dottedTool.name,
              input: {},
              ticket: {
                token: 'header.signature',
                expiresAt: '2099-01-01T00:00:00.000Z',
                providerCallId: 'call-dotted',
                toolName: dottedTool.name,
                requiresUserApproval: false,
              },
            };
            yield {
              v: 2,
              seq: 3,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'finish',
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              usageEventId: null,
              outcome: 'completed',
              usage: {
                status: 'reported',
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                reasoningTokens: null,
              },
              finishReason: { unified: 'tool-calls', raw: 'tool_call' },
              workflowTrace: null,
              researchContributionNotice: null,
            };
          })(),
      });
      const response = await post(started);
      const body = await response.text();
      const wireName = hostedCodexToolWireName(dottedTool.name);

      expect(body).toContain(`\"name\":\"${wireName}\"`);
      expect(body).not.toContain(`\"name\":\"${hostedCodexToolWireName(wireName)}\"`);
    });

    it('streams the gateway events as Responses SSE', async () => {
      const started = await start({
        step: () =>
          (async function* (): AsyncGenerator<HostedStreamEvent> {
            yield {
              v: 2,
              seq: 1,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'accepted',
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              tier: 'auto',
              catalogVersion: '1.0.0',
              rateCardVersion: '1.0.0',
            };
            yield {
              v: 2,
              seq: 2,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'text_delta',
              delta: 'hi',
            };
            yield {
              v: 2,
              seq: 3,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'finish',
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              usageEventId: null,
              outcome: 'completed',
              usage: {
                status: 'reported',
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                reasoningTokens: null,
              },
              finishReason: { unified: 'stop', raw: 'stop' },
              workflowTrace: null,
              researchContributionNotice: null,
            };
          })(),
      });
      const response = await post(started);
      const body = await response.text();
      expect(body).toContain('event: response.created');
      expect(body).toContain('event: response.output_text.delta');
      expect(body).toContain('event: response.completed');
      expect(body.endsWith('\n\n')).toBe(true);
    });

    it('does not cut a turn whose first token takes longer than the request bound', async () => {
      const started = await start({
        requestTimeoutMs: 400,
        step: () =>
          (async function* (): AsyncGenerator<HostedStreamEvent> {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            yield {
              v: 2,
              seq: 1,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'accepted',
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              tier: 'auto',
              catalogVersion: '1.0.0',
              rateCardVersion: '1.0.0',
            };
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            yield {
              v: 2,
              seq: 2,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'finish',
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              usageEventId: null,
              outcome: 'completed',
              usage: {
                status: 'reported',
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                reasoningTokens: null,
              },
              finishReason: { unified: 'stop', raw: 'stop' },
              workflowTrace: null,
              researchContributionNotice: null,
            };
          })(),
      });
      const response = await post(started);
      const body = await response.text();
      expect(body).toContain('event: response.created');
      expect(body).toContain('event: response.completed');
    }, 20_000);

    it('stops the stream when the gateway breaks its own contract', async () => {
      const traces: ResponsesTransportTrace[] = [];
      const privateDelta = 'PRIVATE PROVIDER DELTA SENTINEL';
      const started = await start({
        onTransportTrace: (trace) => traces.push(trace),
        step: () =>
          (async function* (): AsyncGenerator<HostedStreamEvent> {
            yield {
              v: 2,
              seq: 1,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'text_delta',
              delta: privateDelta,
            };
          })(),
      });
      const response = await post(started);
      const body = await response.text();
      expect(body).not.toContain(privateDelta);
      expect(body).toContain('event: error');
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        gatewayEventTotal: 1,
        responsesEventTotal: 1,
        outcome: 'translation_error',
        errorCode: 'stream_event_before_accepted',
        gatewayEvents: [
          {
            type: 'text_delta',
            fields: {
              delta: { type: 'string', utf8Bytes: Buffer.byteLength(privateDelta) },
            },
          },
        ],
        responsesEvents: [{ type: 'error' }],
      });
      expect(JSON.stringify(traces)).not.toContain(privateDelta);
    });

    it.each([
      'gateway_not_configured',
      'gateway_signed_out',
      'gateway_invalid_request',
      'gateway_request_too_large',
      'gateway_paused',
      'gateway_allowance_exhausted',
      'gateway_rate_limited',
      'gateway_provider_exposure_reconciliation_required',
      'gateway_allowance_or_policy_rejected',
      'gateway_unavailable',
    ] as const)(
      'preserves bounded gateway admission failure %s in the transport trace',
      async (code) => {
        const traces: ResponsesTransportTrace[] = [];
        const started = await start({
          onTransportTrace: (trace) => traces.push(trace),
          step: () => {
            throw new ResponsesStepFailure(code);
          },
        });

        const response = await post(started);
        const body = await response.text();

        expect(body).toContain('event: error');
        expect(body).not.toContain('unresolved_provider_exposure_pending');
        expect(traces).toHaveLength(1);
        expect(traces[0]).toMatchObject({
          gatewayEventTotal: 0,
          responsesEventTotal: 1,
          outcome: 'step_error',
          errorCode: code,
        });
        expect(body).toContain(
          `data: ${JSON.stringify({
            type: 'error',
            code,
            message: 'the turn could not be completed',
            param: null,
          })}`
        );
        expect(body).not.toContain('PRIVATE GATEWAY REFUSAL SENTINEL');
      }
    );

    it('preserves a bounded gateway transport rejection after streaming starts', async () => {
      const traces: ResponsesTransportTrace[] = [];
      const started = await start({
        onTransportTrace: (trace) => traces.push(trace),
        step: () =>
          (async function* (): AsyncGenerator<HostedStreamEvent> {
            yield {
              v: 2,
              seq: 1,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'accepted',
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              tier: 'auto',
              catalogVersion: '1.0.0',
              rateCardVersion: '1.0.0',
            };
            throw new HostedCodexStreamFailure(
              'gateway_unavailable',
              'PRIVATE TRANSPORT FAILURE SENTINEL'
            );
          })(),
      });

      const response = await post(started);
      const body = await response.text();

      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        gatewayEventTotal: 1,
        responsesEventTotal: 3,
        outcome: 'step_error',
        errorCode: 'gateway_unavailable',
      });
      expect(body).toContain('event: error');
      expect(body).toContain('"code":"gateway_unavailable"');
      expect(body).not.toContain('stream_failed');
      expect(body).not.toContain('PRIVATE TRANSPORT FAILURE SENTINEL');
      expect(JSON.stringify(traces)).not.toContain('PRIVATE TRANSPORT FAILURE SENTINEL');
    });

    it('fails locally before exposing a function call when provider continuity is missing', async () => {
      const started = await start({
        step: () =>
          (async function* (): AsyncGenerator<HostedStreamEvent> {
            yield {
              v: 2,
              seq: 1,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'accepted',
              reservationId: '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e',
              tier: 'auto',
              catalogVersion: '1.0.0',
              rateCardVersion: '1.0.0',
            };
            yield {
              v: 2,
              seq: 2,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'reasoning_delta',
              summary: true,
              delta: 'Inspecting the workspace.',
            };
            yield {
              v: 2,
              seq: 3,
              requestId: 'r',
              runId: 'run',
              turnId: 't',
              stepSequence: 1,
              event: 'child_tool_call',
              toolCallId: 'call-1',
              name: 'exec_command',
              input: { cmd: 'pwd' },
            };
          })(),
      });

      const response = await post(started);
      const body = await response.text();

      expect(body).toContain('event: error');
      expect(body).toContain('stream_provider_continuity_missing');
      expect(body).not.toContain('response.function_call_arguments');
      expect(body).not.toContain('"type":"function_call"');
    });

    it('reports a gateway that fails before emitting anything', async () => {
      const started = await start({
        step: () =>
          (async function* () {
            throw new Error('gateway refused admission');
            // eslint-disable-next-line no-unreachable
            yield undefined as never;
          })(),
      });
      const response = await post(started);
      const body = await response.text();
      expect(body).toContain('event: error');
      expect(body).not.toContain('gateway refused admission');
    });
  });
});
