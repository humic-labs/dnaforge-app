import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostedBrowserAiBridge, hostedBrowserCodexBridge } from './ai-bridge';
import { hostedPolicy } from '../test/hosted-contribution-fixtures';
import { encodeHostedSseEvent, type HostedStreamEvent } from '@waypoint/hosted-ai-contract';

const turn = { workflowId: 'wf', runId: 'run', turnId: 'turn', workspacePath: '/hosted/ws' };
function respond(body: unknown, status = 200) {
  return { status, json: async () => body };
}

describe('hosted AI browser bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('refuses a signed-out request without inventing a policy or writing a choice', async () => {
    const fetchMock = vi.fn(async () => respond({ error: 'authentication_required' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(hostedBrowserCodexBridge.prepareContribution(turn)).resolves.toMatchObject({
      ok: false,
      code: 'signed_out',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/hosted/browser/contribution-policy',
      expect.objectContaining({ credentials: 'include' })
    );
  });
  it('starts a default-on signed-in turn without an automatic contribution write', async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => respond(hostedPolicy()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(hostedBrowserCodexBridge.prepareContribution(turn)).resolves.toMatchObject({
      ok: true,
      started: true,
      receipt: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });
  it('reads inline settings without changing them', async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => respond(hostedPolicy()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      hostedBrowserAiBridge.prepareContribution({ surface: 'settings' })
    ).resolves.toMatchObject({ ok: true, started: false, receipt: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['joined', 'withdrawn'] as const)(
    'records an explicit %s setting then reloads its current state',
    async (choice) => {
      const initial = hostedPolicy(choice === 'withdrawn');
      const next = {
        ...hostedPolicy(true),
        contribution_choice: choice,
        account_plan_setting: choice === 'joined' ? 'research_contribution' : 'never_corpus',
        plan_authority_basis:
          choice === 'joined' ? 'explicit_contribution_choice' : 'signin_default',
      };
      const receipt = {
        contribution_choice_id: next.contribution_choice_id,
        receipt_choice: choice,
        current_contribution_choice: choice,
        hosted_authorized: true,
        idempotent: false,
        contribution_authority_epoch: 1,
        contribution_choice_policy_generation: next.contribution_policy_generation,
        contribution_policy_generation: next.contribution_policy_generation,
        account_setting_id: next.account_setting_id,
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(respond(initial))
        .mockResolvedValueOnce(respond(receipt))
        .mockResolvedValueOnce(respond(next));
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        hostedBrowserAiBridge.prepareContribution({ surface: 'settings', choice })
      ).resolves.toMatchObject({
        ok: true,
        started: false,
        receipt: { receipt_choice: choice, hosted_authorized: true },
        policy: next,
      });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
        choice,
        idempotency_key: expect.any(String),
        expected_account_setting_id: initial.account_setting_id,
        challenge: { contribution_policy_generation: initial.contribution_policy_generation },
      });
    }
  );
  it('preserves an actionable sign-in recovery reason from the gateway', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond({ available: false, reason: 'sign_in_required' }))
    );
    await expect(hostedBrowserAiBridge.getRouteAvailability()).resolves.toMatchObject({
      ok: true,
      available: false,
      reason: 'sign_in_required',
    });
  });
  it('reports route availability as signed out without a gateway session', async () => {
    const fetchMock = vi.fn(async () => respond({ error: 'authentication_required' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(hostedBrowserAiBridge.getRouteAvailability()).resolves.toMatchObject({
      ok: false,
      code: 'signed_out',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/hosted/route-availability',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it.each([403, 404, 429, 500, 503])(
    'reports HTTP %s as gateway unavailable even if its body claims availability',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => respond({ available: true }, status))
      );
      await expect(hostedBrowserAiBridge.getRouteAvailability()).resolves.toMatchObject({
        ok: false,
        code: 'gateway_unavailable',
      });
    }
  );

  it.each([{}, null, { available: false }, { available: false, reason: 'unknown' }])(
    'reports malformed availability payload %j without inventing a workflow reason',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => respond(body))
      );
      await expect(hostedBrowserAiBridge.getRouteAvailability()).resolves.toMatchObject({
        ok: false,
        code: 'invalid_response',
      });
    }
  );

  it.each([undefined, 'canary'])(
    'streams a browser model turn through the browser-only Responses route with explicit actor %s',
    async (actor) => {
      vi.stubEnv('VITE_DNAFORGE_TELEMETRY_ACTOR', actor);
      const events: HostedStreamEvent[] = [
        {
          v: 2,
          seq: 0,
          requestId: 'request',
          runId: 'run',
          turnId: 'turn',
          stepSequence: 0,
          event: 'accepted',
          reservationId: '00000000-0000-4000-8000-000000000021',
          tier: 'auto',
          catalogVersion: 'catalog-v1',
          rateCardVersion: 'rate-v1',
          workflowTrace: null,
        },
        {
          v: 2,
          seq: 1,
          requestId: 'request',
          runId: 'run',
          turnId: 'turn',
          stepSequence: 0,
          event: 'text_delta',
          delta: 'A bounded browser answer.',
        },
        {
          v: 2,
          seq: 2,
          requestId: 'request',
          runId: 'run',
          turnId: 'turn',
          stepSequence: 0,
          event: 'finish',
          reservationId: '00000000-0000-4000-8000-000000000021',
          usageEventId: null,
          outcome: 'completed',
          usage: {
            status: 'missing',
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          finishReason: { unified: 'stop', raw: 'stop' },
          workflowTrace: null,
          researchContributionNotice: null,
        },
      ];
      const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const actorHeader = new Headers(init?.headers).get('x-dnaforge-telemetry-actor');
        expect(actorHeader === null ? null : JSON.parse(actorHeader)).toEqual(
          actor ? { actor } : null
        );
        expect(body.traceContext).toEqual({
          source: 'browser_chat',
          workspaceOpen: false,
          stagedReferenceIds: [],
        });
        expect(body.tools).toEqual([]);
        const requestId = new Headers(init?.headers).get('X-Request-Id');
        return new Response(
          events
            .map((event) => encodeHostedSseEvent({ ...event, requestId } as HostedStreamEvent))
            .join(''),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const observed: string[] = [];
      const unsubscribe = hostedBrowserCodexBridge.onTurnEvent((event) => {
        if (event.kind === 'text_delta') observed.push(event.delta);
      });
      await expect(
        hostedBrowserCodexBridge.startTurn({
          workflowId: 'wf',
          runId: 'run',
          turnId: 'turn',
          tier: 'auto',
          developerInstructions: 'Answer plainly.',
          userMessage: 'What is this?',
          priorConversationContext: null,
          workspaceOpen: false,
          stagedReferenceIds: [],
        })
      ).resolves.toMatchObject({
        ok: true,
        outcome: 'completed',
        text: 'A bounded browser answer.',
        gateway: { reservationIds: ['00000000-0000-4000-8000-000000000021'] },
      });
      unsubscribe();
      expect(observed).toEqual(['A bounded browser answer.']);
      expect(fetchMock).toHaveBeenCalledWith(
        '/v1/hosted/browser/responses',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      );
    }
  );

  it('reports a response-stream disconnect when the browser stream ends after acceptance', async () => {
    const events: HostedStreamEvent[] = [
      {
        v: 2,
        seq: 0,
        requestId: 'request',
        runId: 'run',
        turnId: 'turn',
        stepSequence: 0,
        event: 'accepted',
        reservationId: '00000000-0000-4000-8000-000000000021',
        tier: 'auto',
        catalogVersion: 'catalog-v1',
        rateCardVersion: 'rate-v1',
        workflowTrace: null,
      },
      {
        v: 2,
        seq: 1,
        requestId: 'request',
        runId: 'run',
        turnId: 'turn',
        stepSequence: 0,
        event: 'text_delta',
        delta: 'Partial answer before disconnect.',
      },
    ];
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      const requestId = new Headers(init?.headers).get('X-Request-Id');
      return new Response(
        events
          .map((event) => encodeHostedSseEvent({ ...event, requestId } as HostedStreamEvent))
          .join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      hostedBrowserCodexBridge.startTurn({
        workflowId: 'wf',
        runId: 'run',
        turnId: 'turn',
        tier: 'auto',
        developerInstructions: 'Answer plainly.',
        userMessage: 'What is this?',
        priorConversationContext: null,
        workspaceOpen: false,
        stagedReferenceIds: [],
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'response_stream_disconnected',
    });
  });

  it('recovers a completed browser turn from the server-owned status projection', async () => {
    const workflowRunId = '33333333-3333-4333-8333-333333333333';
    const events: HostedStreamEvent[] = [
      {
        v: 2,
        seq: 0,
        requestId: 'request',
        runId: 'run',
        turnId: 'turn',
        stepSequence: 0,
        event: 'accepted',
        reservationId: '00000000-0000-4000-8000-000000000021',
        tier: 'auto',
        catalogVersion: 'catalog-v1',
        rateCardVersion: 'rate-v1',
        workflowTrace: {
          workflowRunId,
          workflowStepId: '44444444-4444-4444-8444-444444444444',
        },
      },
      {
        v: 2,
        seq: 1,
        requestId: 'request',
        runId: 'run',
        turnId: 'turn',
        stepSequence: 0,
        event: 'text_delta',
        delta: 'Partial answer before disconnect.',
      },
    ];
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/v1/hosted/browser/turn-status')) {
        return respond({
          ok: true,
          workflow_run_id: workflowRunId,
          client_workflow_id: 'wf',
          client_run_id: 'run',
          status: 'completed',
          finalized_at: '2026-09-30T01:30:00.000Z',
          terminal_output: 'Partial answer before disconnect. Recovered suffix.',
        });
      }
      const requestId = new Headers(init?.headers).get('X-Request-Id');
      return new Response(
        events
          .map((event) => encodeHostedSseEvent({ ...event, requestId } as HostedStreamEvent))
          .join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const observed: string[] = [];
    const unsubscribe = hostedBrowserCodexBridge.onTurnEvent((event) => {
      if (event.kind === 'text_delta') observed.push(event.delta);
    });

    await expect(
      hostedBrowserCodexBridge.startTurn({
        workflowId: 'wf',
        runId: 'run',
        turnId: 'turn',
        tier: 'auto',
        developerInstructions: 'Answer plainly.',
        userMessage: 'What is this?',
        priorConversationContext: null,
        workspaceOpen: false,
        stagedReferenceIds: [],
      })
    ).resolves.toMatchObject({
      ok: true,
      outcome: 'completed',
      text: 'Partial answer before disconnect. Recovered suffix.',
    });
    unsubscribe();
    expect(observed).toEqual(['Partial answer before disconnect.', ' Recovered suffix.']);
    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/hosted/browser/turn-status?workflow_run_id=${workflowRunId}`,
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('polls a running server turn before adopting its completed answer', async () => {
    const workflowRunId = '33333333-3333-4333-8333-333333333333';
    const events: HostedStreamEvent[] = [
      {
        v: 2,
        seq: 0,
        requestId: 'request',
        runId: 'run',
        turnId: 'turn',
        stepSequence: 0,
        event: 'accepted',
        reservationId: '00000000-0000-4000-8000-000000000021',
        tier: 'auto',
        catalogVersion: 'catalog-v1',
        rateCardVersion: 'rate-v1',
        workflowTrace: {
          workflowRunId,
          workflowStepId: '44444444-4444-4444-8444-444444444444',
        },
      },
      {
        v: 2,
        seq: 1,
        requestId: 'request',
        runId: 'run',
        turnId: 'turn',
        stepSequence: 0,
        event: 'text_delta',
        delta: 'Partial answer before disconnect.',
      },
    ];
    let statusReads = 0;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/v1/hosted/browser/turn-status')) {
        statusReads += 1;
        return respond(
          statusReads === 1
            ? {
                ok: true,
                workflow_run_id: workflowRunId,
                client_workflow_id: 'wf',
                client_run_id: 'run',
                status: 'running',
                finalized_at: null,
                terminal_output: null,
              }
            : {
                ok: true,
                workflow_run_id: workflowRunId,
                client_workflow_id: 'wf',
                client_run_id: 'run',
                status: 'completed',
                finalized_at: '2026-09-30T01:30:00.000Z',
                terminal_output: 'Partial answer before disconnect. Recovered suffix.',
              }
        );
      }
      const requestId = new Headers(init?.headers).get('X-Request-Id');
      return new Response(
        events
          .map((event) => encodeHostedSseEvent({ ...event, requestId } as HostedStreamEvent))
          .join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      hostedBrowserCodexBridge.startTurn({
        workflowId: 'wf',
        runId: 'run',
        turnId: 'turn',
        tier: 'auto',
        developerInstructions: 'Answer plainly.',
        userMessage: 'What is this?',
        priorConversationContext: null,
        workspaceOpen: false,
        stagedReferenceIds: [],
      })
    ).resolves.toMatchObject({
      ok: true,
      outcome: 'completed',
      text: 'Partial answer before disconnect. Recovered suffix.',
    });
    expect(statusReads).toBe(2);
  });

  it('refuses a completed status whose durable answer cannot be reconciled', async () => {
    const workflowRunId = '33333333-3333-4333-8333-333333333333';
    const events: HostedStreamEvent[] = [
      {
        v: 2,
        seq: 0,
        requestId: 'request',
        runId: 'run',
        turnId: 'turn',
        stepSequence: 0,
        event: 'accepted',
        reservationId: '00000000-0000-4000-8000-000000000021',
        tier: 'auto',
        catalogVersion: 'catalog-v1',
        rateCardVersion: 'rate-v1',
        workflowTrace: {
          workflowRunId,
          workflowStepId: '44444444-4444-4444-8444-444444444444',
        },
      },
      {
        v: 2,
        seq: 1,
        requestId: 'request',
        runId: 'run',
        turnId: 'turn',
        stepSequence: 0,
        event: 'text_delta',
        delta: 'Partial answer before disconnect.',
      },
    ];
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/v1/hosted/browser/turn-status')) {
        return respond({
          ok: true,
          workflow_run_id: workflowRunId,
          client_workflow_id: 'wf',
          client_run_id: 'run',
          status: 'completed',
          finalized_at: '2026-09-30T01:30:00.000Z',
          terminal_output: 'A different durable answer.',
        });
      }
      const requestId = new Headers(init?.headers).get('X-Request-Id');
      return new Response(
        events
          .map((event) => encodeHostedSseEvent({ ...event, requestId } as HostedStreamEvent))
          .join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      hostedBrowserCodexBridge.startTurn({
        workflowId: 'wf',
        runId: 'run',
        turnId: 'turn',
        tier: 'auto',
        developerInstructions: 'Answer plainly.',
        userMessage: 'What is this?',
        priorConversationContext: null,
        workspaceOpen: false,
        stagedReferenceIds: [],
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'provider_exposure_reconciliation_required',
    });
  });
});
