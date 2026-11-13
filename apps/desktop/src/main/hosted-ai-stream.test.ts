import { describe, expect, it, vi } from 'vitest';
import {
  encodeHostedSseEvent,
  HOSTED_SSE_MAX_FRAME_BYTES,
  HOSTED_SSE_MAX_RESPONSE_BYTES,
  type HostedGenerateRequest,
  type HostedResponsesRequest,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';
import { HostedAiStreamManager, packagedQualificationFaultProfile } from './hosted-ai-stream';

const request: HostedGenerateRequest = {
  version: 2,
  tier: 'auto',
  workflowId: 'conversation-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  messages: [
    { role: 'system', parts: [{ type: 'text', text: 'Use DNAForge tools.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Inspect the workspace.' }] },
  ],
  toolNames: ['get_workspace'],
  traceContext: { source: 'desktop_chat', workspaceOpen: true, stagedReferenceIds: [] },
};

const responsesRequest: HostedResponsesRequest = {
  version: 2,
  tier: 'auto',
  workflowId: 'conversation-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  input: [{ type: 'message', role: 'user', content: 'Inspect the workspace.' }],
  tools: [{ type: 'function', name: 'exec_command' }],
  traceContext: { source: 'desktop_chat', workspaceOpen: true, stagedReferenceIds: [] },
};

const turnBindingToken = 'turn-binding-token-1';

const accepted: HostedStreamEvent = {
  v: 2,
  seq: 0,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  event: 'accepted',
  reservationId: '00000000-0000-4000-8000-000000000001',
  tier: 'auto',
  catalogVersion: 'catalog-1',
  rateCardVersion: 'rate-1',
};
const finish: HostedStreamEvent = {
  v: 2,
  seq: 1,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  event: 'finish',
  reservationId: '00000000-0000-4000-8000-000000000001',
  usageEventId: '00000000-0000-4000-8000-000000000002',
  outcome: 'completed',
  usage: {
    status: 'reported',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  finishReason: { unified: 'stop', raw: 'stop' },
  workflowTrace: null,
  researchContributionNotice: null,
};
const delta: HostedStreamEvent = {
  v: 2,
  seq: 1,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  event: 'text_delta',
  delta: 'MARKER',
};
const finishAfterDelta: HostedStreamEvent = { ...finish, seq: 2 };
const toolCall: HostedStreamEvent = {
  v: 2,
  seq: 1,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  event: 'tool_call',
  toolCallId: 'call-1',
  name: 'get_workspace',
  input: {},
  ticket: {
    token: 'payload.signature',
    expiresAt: '2026-08-13T20:00:00.000Z',
    providerCallId: 'call-1',
    toolName: 'get_workspace',
    requiresUserApproval: false,
  },
};
const completedAfterTool: HostedStreamEvent = { ...finish, seq: 2 };
const reconciliationAfterTool: HostedStreamEvent = {
  ...finish,
  seq: 2,
  outcome: 'reconciliation_required',
  usageEventId: null,
};

function sseResponse(events: HostedStreamEvent[]): Response {
  const bytes = new TextEncoder().encode(events.map(encodeHostedSseEvent).join(''));
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
        controller.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
  );
}

function controlledSseResponse(): {
  readonly response: Response;
  readonly enqueue: (...events: HostedStreamEvent[]) => void;
  readonly enqueueRaw: (wire: string) => void;
  readonly close: () => void;
} {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
  );
  return {
    response,
    enqueue: (...events) => {
      streamController?.enqueue(
        new TextEncoder().encode(events.map(encodeHostedSseEvent).join(''))
      );
    },
    enqueueRaw: (wire) => {
      streamController?.enqueue(new TextEncoder().encode(wire));
    },
    close: () => streamController?.close(),
  };
}

function rawSseResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('HostedAiStreamManager', () => {
  it.each(['generate', 'responses'] as const)(
    'carries only main-owned actor metadata on the actual %s request',
    async (route) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => sseResponse([accepted, finish]));
      const manager = new HostedAiStreamManager({
        resolveUrl: () => new URL('https://gateway.example'),
        authorizeTurn: vi.fn(async () => ({
          accountId: 'account-1',
          desktopSessionId: 'session-1',
          accessToken: 'secret-desktop-token',
          accessTokenExpiresAt: '2026-10-29T00:00:00Z',
          refreshToken: 'refresh-token',
          channel: 'dev',
          updatedAt: 0,
        })),
        resolveTelemetryActor: () => ({
          telemetryActor: 'ci',
          ciRunId: '40641437342',
          appVersion: '0.9.18',
          buildTag: 'v0.9.18',
          releaseChannel: 'prod',
          actorAssertion: 'signed-runtime-assertion',
        }),
        fetch,
        emit: vi.fn(),
      });
      await expect(
        manager.start(7, {
          clientRequestId: 'request-1',
          idempotencyKey: 'idempotency-1',
          turnBindingToken,
          route,
          request: route === 'responses' ? responsesRequest : request,
        })
      ).resolves.toEqual({ ok: true });
      const init = fetch.mock.calls[0]?.[1];
      expect(
        JSON.parse(new Headers(init?.headers).get('x-dnaforge-telemetry-actor') ?? '{}')
      ).toEqual({
        actor: 'ci',
        ciRunId: '40641437342',
        appVersion: '0.9.18',
        buildTag: 'v0.9.18',
        releaseChannel: 'prod',
        assertion: 'signed-runtime-assertion',
      });
      expect(JSON.parse(String(init?.body))).toEqual(
        route === 'responses' ? responsesRequest : request
      );
    }
  );

  it('keeps AI available when optional main actor resolution fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => sseResponse([accepted, finish]));
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: vi.fn(async () => ({
        accountId: 'account-1',
        desktopSessionId: 'session-1',
        accessToken: 'secret-desktop-token',
        accessTokenExpiresAt: '2026-10-29T00:00:00Z',
        refreshToken: 'refresh-token',
        channel: 'dev',
        updatedAt: 0,
      })),
      resolveTelemetryActor: () => {
        throw new Error('optional metadata unavailable');
      },
      fetch,
      emit: vi.fn(),
    });
    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        request,
      })
    ).resolves.toEqual({ ok: true });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('x-dnaforge-telemetry-actor')).toBe(
      false
    );
  });

  it('reads one bounded main-process qualification profile without exposing it in IPC', () => {
    expect(packagedQualificationFaultProfile(['app', '--other'])).toBeNull();
    expect(
      packagedQualificationFaultProfile([
        'app',
        '--dnaforge-hosted-qualification-fault-profile=provider_failure',
      ])
    ).toBe('provider_failure');
    expect(() =>
      packagedQualificationFaultProfile([
        '--dnaforge-hosted-qualification-fault-profile=provider_failure',
        '--dnaforge-hosted-qualification-fault-profile=retry_once_before_output',
      ])
    ).toThrow('invalid_hosted_qualification_fault_profile_argument');
  });

  it('keeps auth in main and forwards a validated structured SSE sequence', async () => {
    const emit = vi.fn();
    const fetch = vi.fn(async () => sseResponse([accepted, finish]));
    const authorizeTurn = vi.fn(async () => ({ accessToken: 'secret-desktop-token' }) as never);
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn,
      fetch,
      emit,
    });

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        request,
      })
    ).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));

    expect(authorizeTurn).toHaveBeenCalledTimes(1);
    expect(authorizeTurn).toHaveBeenCalledWith(7, turnBindingToken, {
      workflowId: 'conversation-1',
      runId: 'run-1',
      turnId: 'turn-1',
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://gateway.example/v1/hosted/generate'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: expect.objectContaining({
          authorization: 'Bearer secret-desktop-token',
          accept: 'text/event-stream',
          'idempotency-key': 'idempotency-1',
          'x-request-id': 'request-1',
        }),
        body: JSON.stringify(request),
      })
    );
    expect(emit).toHaveBeenNthCalledWith(1, 7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: accepted,
    });
    expect(emit).toHaveBeenNthCalledWith(2, 7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: finish,
    });
  });

  it('selects the Responses route only for a validated v3 request', async () => {
    const fetch = vi.fn(async () => sseResponse([accepted, finish]));
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: vi.fn(async () => ({ accessToken: 'secret-desktop-token' }) as never),
      fetch,
      emit: vi.fn(),
      qualificationFaultProfile: 'provider_failure',
    });

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        route: 'responses',
        request: responsesRequest,
      })
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://gateway.example/v1/hosted/responses'),
      expect.objectContaining({
        body: JSON.stringify(responsesRequest),
        headers: expect.objectContaining({
          'x-dnaforge-hosted-qualification-fault-profile': 'provider_failure',
        }),
      })
    );
  });

  it('retries lost and transient start failures with the same provider idempotency identity', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response('temporary edge failure', { status: 502 }))
      .mockResolvedValueOnce(sseResponse([accepted, finish]));
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch,
      emit: vi.fn(),
    });

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        route: 'responses',
        request: responsesRequest,
      })
    ).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
    expect(fetch.mock.calls[2]).toEqual(fetch.mock.calls[0]);
  });

  it('does not retry the semantic gateway-paused response', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'gateway_paused' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
    );
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch,
      emit: vi.fn(),
    });

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        route: 'responses',
        request: responsesRequest,
      })
    ).resolves.toMatchObject({ ok: false, code: 'gateway_paused' });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lets Stop win during transient-start backoff', async () => {
    const fetch = vi.fn(async () => new Response('temporary edge failure', { status: 502 }));
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch,
      emit: vi.fn(),
    });

    const start = manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      route: 'responses',
      request: responsesRequest,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(manager.cancel(7, 'request-1')).toEqual({ ok: true });

    await expect(start).resolves.toMatchObject({ ok: false, code: 'gateway_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed renderer input before auth or network access', async () => {
    const fetch = vi.fn();
    const authorizeTurn = vi.fn();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn,
      fetch,
      emit: vi.fn(),
    });
    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        request: { ...request, unknown: true },
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    expect(authorizeTurn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unknown top-level key even when the legacy route is omitted', async () => {
    const fetch = vi.fn();
    const authorizeTurn = vi.fn();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn,
      fetch,
      emit: vi.fn(),
    });

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        request,
        unexpectedRouteHint: 'responses',
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    expect(authorizeTurn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['account', 'desktop session'] as const)(
    'prevents provider egress when %s authority refuses the turn binding',
    async () => {
      const fetch = vi.fn();
      const authorizeTurn = vi.fn(async () => {
        throw new Error('The signed-in authority changed.');
      });
      const manager = new HostedAiStreamManager({
        resolveUrl: () => new URL('https://gateway.example'),
        authorizeTurn,
        fetch,
        emit: vi.fn(),
      });

      await expect(
        manager.start(7, {
          clientRequestId: 'request-1',
          idempotencyKey: 'idempotency-1',
          turnBindingToken,
          request,
        })
      ).resolves.toMatchObject({ ok: false, code: 'signed_out' });

      expect(authorizeTurn).toHaveBeenCalledWith(7, turnBindingToken, {
        workflowId: 'conversation-1',
        runId: 'run-1',
        turnId: 'turn-1',
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('cancels only the owning renderer request and forwards AbortSignal to fetch', async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch,
      emit: vi.fn(),
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    expect(manager.cancel(8, 'request-1')).toEqual({ ok: false });
    expect(signal?.aborted).toBe(false);
    expect(manager.cancel(7, 'request-1')).toEqual({ ok: true });
    expect(signal?.aborted).toBe(true);
  });

  it('reserves ownership before session lookup so Stop prevents provider egress and releases the id', async () => {
    const firstSession = deferred<never>();
    const fetch = vi.fn(async () => sseResponse([accepted, finish]));
    const authorizeTurn = vi
      .fn()
      .mockImplementationOnce(() => firstSession.promise)
      .mockResolvedValue({ accessToken: 'secret-desktop-token' } as never);
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn,
      fetch,
      emit: vi.fn(),
    });

    const pendingStart = manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });
    expect(authorizeTurn).toHaveBeenCalledTimes(1);
    expect(manager.cancel(7, 'request-1')).toEqual({ ok: true });

    firstSession.resolve({ accessToken: 'stale-secret-token' } as never);
    await expect(pendingStart).resolves.toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-2',
        turnBindingToken,
        request,
      })
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('prevents provider egress when the owning renderer closes during session lookup', async () => {
    const firstSession = deferred<never>();
    const fetch = vi.fn(async () => sseResponse([accepted, finish]));
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: () => firstSession.promise,
      fetch,
      emit: vi.fn(),
    });

    const pendingStart = manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });
    manager.cancelOwner(7);

    firstSession.resolve({ accessToken: 'stale-secret-token' } as never);
    await expect(pendingStart).resolves.toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let a canceled pending start erase replacement ownership', async () => {
    const firstSession = deferred<never>();
    const replacementStream = controlledSseResponse();
    const authorizeTurn = vi
      .fn()
      .mockImplementationOnce(() => firstSession.promise)
      .mockResolvedValue({ accessToken: 'replacement-secret-token' } as never);
    const fetch = vi.fn(async () => replacementStream.response);
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn,
      fetch,
      emit: vi.fn(),
    });

    const staleStart = manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });
    manager.cancelOwner(7);
    await expect(
      manager.start(8, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-2',
        turnBindingToken,
        request,
      })
    ).resolves.toEqual({ ok: true });

    firstSession.resolve({ accessToken: 'stale-secret-token' } as never);
    await expect(staleStart).resolves.toMatchObject({ ok: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(manager.cancel(7, 'request-1')).toEqual({ ok: false });
    expect(manager.cancel(8, 'request-1')).toEqual({ ok: true });
  });

  it('allows only one concurrent start to own a client request id', async () => {
    const firstSession = deferred<never>();
    const fetch = vi.fn(async () => sseResponse([accepted, finish]));
    const authorizeTurn = vi.fn(() => firstSession.promise);
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn,
      fetch,
      emit: vi.fn(),
    });

    const firstStart = manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });
    await expect(
      manager.start(8, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-2',
        turnBindingToken,
        request,
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    expect(authorizeTurn).toHaveBeenCalledTimes(1);

    firstSession.resolve({ accessToken: 'secret-desktop-token' } as never);
    await expect(firstStart).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'URL lookup failure', scenario: 'url_failure', expectedCode: 'gateway_unavailable' },
    {
      label: 'missing gateway configuration',
      scenario: 'not_configured',
      expectedCode: 'not_configured',
    },
    { label: 'missing session', scenario: 'signed_out', expectedCode: 'signed_out' },
    { label: 'network failure', scenario: 'network_failure', expectedCode: 'gateway_unavailable' },
    { label: 'gateway refusal', scenario: 'gateway_refusal', expectedCode: 'allowance_exhausted' },
    {
      label: 'invalid response stream',
      scenario: 'invalid_stream',
      expectedCode: 'gateway_unavailable',
    },
  ] as const)('releases the request id after $label', async ({ scenario, expectedCode }) => {
    let failFirst = true;
    const manager = new HostedAiStreamManager({
      resolveUrl: () => {
        if (failFirst && scenario === 'url_failure') throw new Error('lookup failed');
        if (failFirst && scenario === 'not_configured') return null;
        return new URL('https://gateway.example');
      },
      authorizeTurn: async () => {
        if (failFirst && scenario === 'signed_out') throw new Error('turn authority refused');
        return { accessToken: 'secret-desktop-token' } as never;
      },
      fetch: async () => {
        if (failFirst && scenario === 'network_failure') throw new Error('network failed');
        if (failFirst && scenario === 'gateway_refusal') {
          return new Response(JSON.stringify({ error: 'allowance_exhausted' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (failFirst && scenario === 'invalid_stream') {
          return new Response('not an event stream', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return sseResponse([accepted, finish]);
      },
      emit: vi.fn(),
    });

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        request,
      })
    ).resolves.toMatchObject({ ok: false, code: expectedCode });

    failFirst = false;
    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-2',
        turnBindingToken,
        request,
      })
    ).resolves.toEqual({ ok: true });
  });

  it('preserves the unresolved provider exposure refusal as a distinct start failure', async () => {
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'unresolved_provider_exposure_pending',
              message: 'private gateway detail',
              requestId: 'private-request-id',
              retryable: false,
            },
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }
        ),
      emit: vi.fn(),
    });

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        request,
      })
    ).resolves.toEqual({
      ok: false,
      code: 'provider_exposure_reconciliation_required',
      message:
        'Earlier AI provider charges are still being reconciled. Contact DNAForge support before retrying.',
    });
  });

  it('maps a gateway HTTP 413 to a non-outage request-size failure without retrying', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'request_too_large' }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        })
    );
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch,
      emit: vi.fn(),
    });

    await expect(
      manager.start(7, {
        clientRequestId: 'request-1',
        idempotencyKey: 'idempotency-1',
        turnBindingToken,
        request,
      })
    ).resolves.toEqual({
      ok: false,
      code: 'request_too_large',
      message: 'This response accumulated more context than DNAForge AI can send safely.',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('collapses an unknown 409 body into a content-free policy refusal', async () => {
    const sentinel = 'PRIVATE GATEWAY REFUSAL SENTINEL';
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'private_database_refusal',
              message: sentinel,
              requestId: 'private-request-id',
              retryable: false,
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        ),
      emit: vi.fn(),
    });

    const result = await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });
    expect(result).toEqual({
      ok: false,
      code: 'allowance_or_policy_rejected',
      message: 'DNAForge AI cannot run this workflow right now.',
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('fails closed when the gateway stream drifts in sequence or correlation', async () => {
    const emit = vi.fn();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () => sseResponse([accepted, { ...finish, seq: 2 }]),
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(7, {
        clientRequestId: 'request-1',
        kind: 'transport_error',
        message: 'DNAForge AI returned an invalid event stream.',
      })
    );
  });

  it('rejects an event after the terminal marker in the same decoded frame', async () => {
    const emit = vi.fn();
    const stream = controlledSseResponse();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () => stream.response,
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    stream.enqueue(accepted, finish, {
      v: 2,
      seq: 2,
      requestId: 'request-1',
      runId: 'run-1',
      turnId: 'turn-1',
      stepSequence: 0,
      event: 'text_delta',
      delta: 'must not be accepted after finish',
    });
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(7, {
        clientRequestId: 'request-1',
        kind: 'transport_error',
        message: 'DNAForge AI returned an invalid event stream.',
      })
    );
    expect(emit).not.toHaveBeenCalledWith(7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: finish,
    });
  });

  it('quarantines tool calls and rejects reconciliation-required settlement', async () => {
    const emit = vi.fn();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () => sseResponse([accepted, toolCall, reconciliationAfterTool]),
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(7, {
        clientRequestId: 'request-1',
        kind: 'transport_error',
        message: 'DNAForge AI returned an invalid event stream.',
      })
    );
    expect(emit).not.toHaveBeenCalledWith(7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: toolCall,
    });
    expect(emit).not.toHaveBeenCalledWith(7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: reconciliationAfterTool,
    });
  });

  it('releases no quarantined tool call or terminal when same-frame trailing bytes are invalid', async () => {
    const emit = vi.fn();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () =>
        rawSseResponse([
          new TextEncoder().encode(
            `${[accepted, toolCall, completedAfterTool]
              .map(encodeHostedSseEvent)
              .join('')}data: not-json\n\n`
          ),
        ]),
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(7, {
        clientRequestId: 'request-1',
        kind: 'transport_error',
        message: 'DNAForge AI returned an invalid event stream.',
      })
    );
    expect(emit).not.toHaveBeenCalledWith(7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: toolCall,
    });
    expect(emit).not.toHaveBeenCalledWith(7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: completedAfterTool,
    });
  });

  it('commits accepted, tool, text, and finish at the validated terminal frame without waiting for EOF', async () => {
    const stream = controlledSseResponse();
    const emit = vi.fn();
    const textAfterTool: HostedStreamEvent = {
      ...delta,
      seq: 2,
      delta: 'text after tool',
    };
    const finishAfterToolAndText: HostedStreamEvent = { ...finish, seq: 3 };
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () => stream.response,
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    stream.enqueue(accepted, toolCall, textAfterTool, finishAfterToolAndText);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(4));
    expect(emit).toHaveBeenNthCalledWith(2, 7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: toolCall,
    });
    expect(emit).toHaveBeenNthCalledWith(3, 7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: textAfterTool,
    });
    expect(emit).toHaveBeenNthCalledWith(4, 7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: finishAfterToolAndText,
    });
  });

  it('uses fatal UTF-8 decoding and never exposes a terminal after invalid bytes', async () => {
    const encoder = new TextEncoder();
    const wire = encoder.encode(
      [accepted, delta, finishAfterDelta].map(encodeHostedSseEvent).join('')
    );
    const marker = encoder.encode('MARKER');
    const markerStart = wire.findIndex((value, index) =>
      marker.every((markerByte, offset) => wire[index + offset] === markerByte)
    );
    expect(markerStart).toBeGreaterThan(-1);
    wire[markerStart] = 0xff;

    const emit = vi.fn();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () => rawSseResponse([wire]),
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    expect(emit).toHaveBeenNthCalledWith(1, 7, {
      clientRequestId: 'request-1',
      kind: 'transport_error',
      message: 'DNAForge AI returned an invalid event stream.',
    });
  });

  it('flushes fatal UTF-8 state at the terminal frame and withholds it on an incomplete code point', async () => {
    const emit = vi.fn();
    const completeWire = new TextEncoder().encode(
      [accepted, finish].map(encodeHostedSseEvent).join('')
    );
    const malformedWire = new Uint8Array(completeWire.length + 2);
    malformedWire.set(completeWire);
    malformedWire.set([0xe2, 0x82], completeWire.length);
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () => rawSseResponse([malformedWire]),
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(7, {
        clientRequestId: 'request-1',
        kind: 'transport_error',
        message: 'DNAForge AI returned an invalid event stream.',
      })
    );
    expect(emit).toHaveBeenCalledWith(7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: accepted,
    });
    expect(emit).not.toHaveBeenCalledWith(7, {
      clientRequestId: 'request-1',
      kind: 'event',
      event: finish,
    });
  });

  it('fails with transport_error only when aggregate response bytes exceed the limit', async () => {
    const frame = `:${'x'.repeat(HOSTED_SSE_MAX_FRAME_BYTES - 1)}\n\n`;
    const bytes = new TextEncoder().encode(frame.repeat(5));
    expect(bytes.byteLength).toBeGreaterThan(HOSTED_SSE_MAX_RESPONSE_BYTES);

    const emit = vi.fn();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () => rawSseResponse([bytes]),
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    expect(emit).toHaveBeenNthCalledWith(1, 7, {
      clientRequestId: 'request-1',
      kind: 'transport_error',
      message: 'DNAForge AI returned an invalid event stream.',
    });
  });

  it('fails with transport_error only on delimiter-free frame growth beyond the frame limit', async () => {
    const bytes = new TextEncoder().encode('x'.repeat(HOSTED_SSE_MAX_FRAME_BYTES + 1));
    expect(bytes.byteLength).toBeLessThan(HOSTED_SSE_MAX_RESPONSE_BYTES);

    const emit = vi.fn();
    const manager = new HostedAiStreamManager({
      resolveUrl: () => new URL('https://gateway.example'),
      authorizeTurn: async () => ({ accessToken: 'secret-desktop-token' }) as never,
      fetch: async () => rawSseResponse([bytes]),
      emit,
    });
    await manager.start(7, {
      clientRequestId: 'request-1',
      idempotencyKey: 'idempotency-1',
      turnBindingToken,
      request,
    });

    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    expect(emit).toHaveBeenNthCalledWith(1, 7, {
      clientRequestId: 'request-1',
      kind: 'transport_error',
      message: 'DNAForge AI returned an invalid event stream.',
    });
  });
});
