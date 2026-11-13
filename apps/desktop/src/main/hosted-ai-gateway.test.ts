import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostedAiGatewayClient, resolveHostedAiGatewayUrl } from './hosted-ai-gateway';
import { releaseBHostedAuthorityFromEnv } from './release-stamp';

vi.mock('./auth/session-store', () => ({ getActiveStoredSession: vi.fn() }));

const { electronApp } = vi.hoisted(() => ({ electronApp: { isPackaged: false } }));
vi.mock('electron', () => ({ app: electronApp }));

const request = {
  workflowId: 'workflow-1',
  runId: 'run-1',
  turnId: 'turn-1',
  requestId: 'request-1',
  idempotencyKey: 'idempotency-1',
  tier: 'auto' as const,
  input: 'Design an EGFP plasmid.',
  maxOutputTokens: 100,
  tracePayload: { workspace: 'only this workflow' },
  routePinScope: 'turn' as const,
};

const session = {
  accountId: 'account-1',
  desktopSessionId: '11111111-1111-4111-8111-111111111111',
  accessToken: 'desktop-access-token-never-exposed-to-renderer',
  accessTokenExpiresAt: '2026-08-01T00:00:00.000Z',
  refreshToken: 'refresh-token',
  channel: 'dev',
  updatedAt: 1,
};

function parseJsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected Hosted request body to be JSON text.');
  }
  return JSON.parse(init.body);
}

const contributionPolicy = {
  account_plan_setting: 'unset',
  account_setting_id: null,
  plan_authority_basis: 'none',
  choice_offered: true,
  contribution_choice: 'unchosen',
  contribution_choice_id: null,
  contribution_choice_recorded_at: null,
  hosted_authorized: false,
  hosted_unauthorized_reason: 'hosted_contribution_choice_required',
  contribution_authority_epoch: 0,
  show_research_contribution_notice: false,
  legal_challenge: {
    terms_version_id: '00000000-0000-4000-8000-000000000011',
    terms_version: 'terms-2026-08-11-aaaaaaaaaaaa',
    terms_effective_at: '2026-08-11T00:00:00.000Z',
    terms_url: 'https://www.dnaforge.com/terms',
    terms_content_sha256: 'a'.repeat(64),
    privacy_version_id: '00000000-0000-4000-8000-000000000012',
    privacy_version: 'privacy-2026-08-11-bbbbbbbbbbbb',
    privacy_effective_at: '2026-08-11T00:00:00.000Z',
    privacy_url: 'https://www.dnaforge.com/privacy',
    privacy_content_sha256: 'b'.repeat(64),
  },
  contribution_policy_generation: 'c'.repeat(64),
  contribution_choice_policy_generation: null,
  private_trial_limit: 3,
  private_trial_used: 3,
  private_trial_remaining: 0,
  private_trial_eligible: false,
};

describe('HostedAiGatewayClient', () => {
  it.each([
    ['legal_acceptance_missing', 'legal_acceptance_missing'],
    ['contribution_policy_stale', 'contribution_policy_stale'],
    ['unrecognized_conflict', 'contribution_choice_rejected'],
    [null, 'contribution_choice_rejected'],
  ])(
    'preserves the contribution refusal %s instead of reporting a network failure',
    async (serverCode, code) => {
      const fetch = vi.fn(
        async () => new Response(JSON.stringify({ error: serverCode }), { status: 409 })
      );
      const client = new HostedAiGatewayClient({
        resolveUrl: () => new URL('https://hosted.example.test'),
        getSession: async () => session,
        fetch,
      });
      const legal = contributionPolicy.legal_challenge;
      await expect(
        client.recordContributionChoice(undefined, 'joined', 'choice-refused', {
          terms_version_id: legal.terms_version_id,
          terms_content_sha256: legal.terms_content_sha256,
          privacy_version_id: legal.privacy_version_id,
          privacy_content_sha256: legal.privacy_content_sha256,
          contribution_policy_generation: contributionPolicy.contribution_policy_generation,
        })
      ).rejects.toMatchObject({ code });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it('gets and records only the exact challenge-bound contribution contract', async () => {
    const receipt = {
      contribution_choice_id: '00000000-0000-4000-8000-000000000014',
      receipt_choice: 'joined',
      current_contribution_choice: 'joined',
      hosted_authorized: true,
      idempotent: false,
      contribution_authority_epoch: 1,
      contribution_choice_policy_generation: 'c'.repeat(64),
      contribution_policy_generation: 'c'.repeat(64),
      account_setting_id: '00000000-0000-4000-8000-000000000015',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(contributionPolicy), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch,
    });

    await expect(client.getContributionPolicy()).resolves.toEqual(contributionPolicy);
    const challenge = {
      terms_version_id: contributionPolicy.legal_challenge.terms_version_id,
      terms_content_sha256: contributionPolicy.legal_challenge.terms_content_sha256,
      privacy_version_id: contributionPolicy.legal_challenge.privacy_version_id,
      privacy_content_sha256: contributionPolicy.legal_challenge.privacy_content_sha256,
      contribution_policy_generation: contributionPolicy.contribution_policy_generation,
    };
    await expect(
      client.recordContributionChoice(undefined, 'joined', 'choice-1', challenge)
    ).resolves.toEqual(receipt);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL('https://hosted.example.test/v1/hosted/contribution-policy'),
      expect.objectContaining({
        redirect: 'manual',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL('https://hosted.example.test/v1/hosted/contribution-policy'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        body: JSON.stringify({ choice: 'joined', idempotency_key: 'choice-1', challenge }),
      })
    );
  });

  it('rejects a partial or contradictory contribution policy', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(JSON.stringify({ ...contributionPolicy, legal_challenge: {} }), {
          status: 200,
        }),
    });
    await expect(client.getContributionPolicy()).rejects.toThrow(/invalid contribution policy/i);
  });

  it('does not read or mutate contribution policy through a different active desktop session', async () => {
    const switched = { ...session, accountId: 'account-2', desktopSessionId: 'session-2' };
    const fetch = vi.fn();
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => switched,
      fetch,
    });
    const expected = {
      accountId: session.accountId,
      desktopSessionId: session.desktopSessionId,
    };
    const challenge = {
      terms_version_id: contributionPolicy.legal_challenge.terms_version_id,
      terms_content_sha256: contributionPolicy.legal_challenge.terms_content_sha256,
      privacy_version_id: contributionPolicy.legal_challenge.privacy_version_id,
      privacy_content_sha256: contributionPolicy.legal_challenge.privacy_content_sha256,
      contribution_policy_generation: contributionPolicy.contribution_policy_generation,
    };

    await expect(client.getContributionPolicy(expected)).rejects.toThrow(
      /signed-in account changed/i
    );
    await expect(
      client.recordContributionChoice(expected, 'joined', 'choice-1', challenge)
    ).rejects.toThrow(/signed-in account changed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['provider_unavailable', 'sign_in_required'] as const)(
    'preserves the Hosted %s reason and public gateway origin',
    async (reason) => {
      const client = new HostedAiGatewayClient({
        resolveUrl: () => new URL('https://hosted.example.test/base'),
        getSession: async () => session,
        fetch: async () =>
          new Response(JSON.stringify({ available: false, reason }), {
            status: 200,
          }),
      });

      await expect(client.getRouteAvailability()).resolves.toEqual({
        ok: true,
        available: false,
        reason,
        gatewayOrigin: 'https://hosted.example.test',
      });
    }
  );

  it('treats a legacy unavailable response without a reason as not ready', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test/base'),
      getSession: async () => session,
      fetch: async () =>
        new Response(JSON.stringify({ available: false }), {
          status: 200,
        }),
    });

    await expect(client.getRouteAvailability()).resolves.toEqual({
      ok: true,
      available: false,
      reason: 'gateway_not_ready',
      gatewayOrigin: 'https://hosted.example.test',
    });
  });

  it('reports an unconfigured build before it attempts authentication or network access', async () => {
    const getSession = vi.fn();
    const fetch = vi.fn();
    const client = new HostedAiGatewayClient({
      resolveUrl: () => null,
      getSession,
      fetch,
    });

    await expect(client.getRouteAvailability()).resolves.toEqual({
      ok: false,
      code: 'not_configured',
      message: 'DNAForge AI is not configured in this build.',
      gatewayOrigin: null,
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unknown route reason as an invalid gateway response', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(JSON.stringify({ available: false, reason: 'mystery_failure' }), {
          status: 200,
        }),
    });

    await expect(client.getRouteAvailability()).resolves.toEqual({
      ok: false,
      code: 'invalid_response',
      message: 'The Hosted AI gateway returned an invalid availability response.',
      gatewayOrigin: 'https://hosted.example.test',
    });
  });

  it('accepts only HTTPS remote gateway origins, with loopback HTTP limited to disposable tests', () => {
    expect(
      resolveHostedAiGatewayUrl({ DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://hosted.example.test' })
    ).toMatchObject({
      protocol: 'https:',
      hostname: 'hosted.example.test',
    });
    expect(
      resolveHostedAiGatewayUrl({ DNAFORGE_HOSTED_AI_GATEWAY_URL: 'http://hosted.example.test' })
    ).toBeNull();
    expect(
      resolveHostedAiGatewayUrl({
        DNAFORGE_HOSTED_AI_GATEWAY_URL: 'http://127.0.0.1:4312',
        WAYPOINT_TEST: '1',
      })
    ).toMatchObject({ protocol: 'http:', hostname: '127.0.0.1' });
  });

  describe('build-time gateway URL fallback', () => {
    const BAKED = '__DNAFORGE_HOSTED_AI_GATEWAY_URL__';
    const RELEASE_B = '__DNAFORGE_RELEASE_B_HOSTED__';
    const GATEWAY_MARKER = '__DNAFORGE_HOSTED_AI_GATEWAY_MARKER__';
    const RELEASE_A_MARKER = '__DNAFORGE_HOSTED_AI_RELEASE_A_MARKER__';
    const globals = globalThis as Record<string, unknown>;
    const had = BAKED in globals;
    const original = globals[BAKED];
    const hadReleaseB = RELEASE_B in globals;
    const originalReleaseB = globals[RELEASE_B];
    const hadGatewayMarker = GATEWAY_MARKER in globals;
    const originalGatewayMarker = globals[GATEWAY_MARKER];
    const hadMarker = RELEASE_A_MARKER in globals;
    const originalMarker = globals[RELEASE_A_MARKER];

    afterEach(() => {
      electronApp.isPackaged = false;
      if (had) globals[BAKED] = original;
      else delete globals[BAKED];
      if (hadReleaseB) globals[RELEASE_B] = originalReleaseB;
      else delete globals[RELEASE_B];
      if (hadGatewayMarker) globals[GATEWAY_MARKER] = originalGatewayMarker;
      else delete globals[GATEWAY_MARKER];
      if (hadMarker) globals[RELEASE_A_MARKER] = originalMarker;
      else delete globals[RELEASE_A_MARKER];
    });

    it('uses the sealed baked origin in a packaged Release B artifact', () => {
      const authority = releaseBHostedAuthorityFromEnv('1', 'https://hosted.dnaforge.com');
      electronApp.isPackaged = true;
      globals[BAKED] = authority.gatewayOrigin;
      globals[RELEASE_B] = authority.stamp;
      globals[GATEWAY_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:configured';
      globals[RELEASE_A_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:enabled';
      expect(resolveHostedAiGatewayUrl({})).toMatchObject({
        protocol: 'https:',
        hostname: 'hosted.dnaforge.com',
      });
    });

    it('ignores a hostile runtime override in a packaged Release B artifact', () => {
      const authority = releaseBHostedAuthorityFromEnv('1', 'https://hosted.dnaforge.com');
      electronApp.isPackaged = true;
      globals[BAKED] = authority.gatewayOrigin;
      globals[RELEASE_B] = authority.stamp;
      globals[GATEWAY_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:configured';
      globals[RELEASE_A_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:enabled';
      expect(
        resolveHostedAiGatewayUrl({
          DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://runtime.example.test',
        })
      ).toMatchObject({ hostname: 'hosted.dnaforge.com' });
    });

    it('keeps packaged Release A disabled even when the runtime environment asks for Hosted', () => {
      electronApp.isPackaged = true;
      globals[BAKED] = '';
      globals[RELEASE_B] = '';
      globals[GATEWAY_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:empty';
      globals[RELEASE_A_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:disabled';
      expect(
        resolveHostedAiGatewayUrl({
          DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://runtime.example.test',
        })
      ).toBeNull();
    });

    it('fails closed when the packaged marker and origin do not match', () => {
      electronApp.isPackaged = true;
      globals[BAKED] = 'https://attacker.example';
      globals[RELEASE_B] = releaseBHostedAuthorityFromEnv('1', 'https://hosted.dnaforge.com').stamp;
      globals[GATEWAY_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:configured';
      globals[RELEASE_A_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:enabled';
      expect(resolveHostedAiGatewayUrl({})).toBeNull();
    });

    it('ignores runtime and baked gateway URLs when the Release A build marker is disabled', () => {
      globals[RELEASE_A_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:disabled';
      globals[GATEWAY_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:configured';
      globals[BAKED] = 'https://baked.example.test';
      expect(
        resolveHostedAiGatewayUrl({
          DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://hostile.invalid',
        })
      ).toBeNull();
    });

    it('fails closed when the baked gateway value disagrees with its artifact marker', () => {
      globals[GATEWAY_MARKER] = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:empty';
      globals[BAKED] = 'https://unexpected-gateway.invalid';
      expect(resolveHostedAiGatewayUrl({})).toBeNull();
    });
  });

  it('keeps the desktop token in main while forwarding the exact server-owned request shape', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            providerResponse: { output: 'A useful answer.' },
            workflowTrace: null,
            researchContributionNotice: null,
          }),
          { status: 200 }
        )
    );
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch,
    });

    await expect(
      client.agentModelStep({ ...request, agentStepSequence: 0 })
    ).resolves.toMatchObject({ ok: true });

    const [url, init] = fetch.mock.calls[0]!;
    if (!init) throw new Error('Expected Hosted request init.');
    expect(String(url)).toBe('https://hosted.example.test/v1/hosted/agent/model-step');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer desktop-access-token-never-exposed-to-renderer',
    });
    expect(init.body).not.toContain('desktop-access-token-never-exposed-to-renderer');
    expect(parseJsonRequestBody(init)).toMatchObject({
      workflow_id: 'workflow-1',
      tier: 'auto',
      agent_step_sequence: 0,
    });
  });

  it('does not display a notice string that was not issued in the exact approved form', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(
          JSON.stringify({
            providerResponse: { output: 'answer' },
            workflowTrace: null,
            researchContributionNotice: {
              show_notice: true,
              notice_text: 'Accept these hosted terms',
              terms_url: 'https://www.dnaforge.com/terms',
              privacy_url: 'https://www.dnaforge.com/privacy',
            },
          }),
          { status: 200 }
        ),
    });
    await expect(
      client.agentModelStep({ ...request, agentStepSequence: 0 })
    ).resolves.toMatchObject({ ok: true, researchContributionNotice: null });
  });

  it('returns a content-free paused result instead of exposing gateway implementation detail', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'gateway_paused', detail: 'reservation ledger' }), {
          status: 503,
        }),
    });
    const result = await client.agentModelStep({ ...request, agentStepSequence: 0 });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('reservation ledger');
  });

  it('rejects malformed renderer input before it can consume a desktop credential', async () => {
    const getSession = vi.fn(async () => session);
    const fetch = vi.fn();
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession,
      fetch,
    });

    await expect(
      client.agentModelStep({ ...request, tracePayload: [], agentStepSequence: 0 })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });

    expect(getSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts an explicitly null workflow trace on both agent routes', async () => {
    const body = (extra: Record<string, unknown> = {}) =>
      new Response(
        JSON.stringify({
          providerResponse: { output: 'ok' },
          workflowTrace: null,
          researchContributionNotice: null,
          ...extra,
        }),
        { status: 200 }
      );

    const stepClient = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () => body(),
    });
    await expect(
      stepClient.agentModelStep({ ...request, agentStepSequence: 0 })
    ).resolves.toMatchObject({ ok: true, workflowTrace: null });

    const observationClient = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () => body(),
    });
    await expect(
      observationClient.submitAgentToolObservation({
        ticket: 'signed.ticket',
        argumentsPayload: { path: '/' },
        observationPayload: { ok: true },
      })
    ).resolves.toMatchObject({ ok: true, workflowTrace: null });
  });

  it('keeps agent-step credentials in main and accepts only server-issued trace identities', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            providerResponse: { output: 'A useful agent step.' },
            workflowTrace: {
              workflow_run_id: '11111111-1111-4111-8111-111111111111',
              workflow_step_id: '22222222-2222-4222-8222-222222222222',
            },
            researchContributionNotice: null,
          }),
          { status: 200 }
        )
    );
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch,
    });

    await expect(client.agentModelStep({ ...request, agentStepSequence: 0 })).resolves.toEqual({
      ok: true,
      providerResponse: { output: 'A useful agent step.' },
      workflowTrace: {
        workflowRunId: '11111111-1111-4111-8111-111111111111',
        workflowStepId: '22222222-2222-4222-8222-222222222222',
      },
      toolTickets: [],
      researchContributionNotice: null,
    });
    const [url, init] = fetch.mock.calls[0]!;
    if (!init) throw new Error('Expected Hosted request init.');
    expect(String(url)).toBe('https://hosted.example.test/v1/hosted/agent/model-step');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer desktop-access-token-never-exposed-to-renderer',
    });
    expect(parseJsonRequestBody(init)).toMatchObject({
      agent_step_sequence: 0,
      workflow_id: 'workflow-1',
      trace_payload: { workspace: 'only this workflow' },
    });
  });

  it('fails closed when the gateway tries to continue an agent workflow without valid trace identities', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(
          JSON.stringify({
            providerResponse: { output: 'A useful agent step.' },
            workflowTrace: { workflow_run_id: 'not-a-uuid', workflow_step_id: 'also-not-a-uuid' },
          }),
          { status: 200 }
        ),
    });
    await expect(client.agentModelStep({ ...request, agentStepSequence: 0 })).resolves.toEqual({
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI returned an invalid workflow trace.',
    });
  });

  it('keeps sibling tool observations local until the gateway confirms every ticket is durable', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(
          JSON.stringify({
            pending_tool_observations: true,
            workflow_run_id: '11111111-1111-4111-8111-111111111111',
            workflow_step_id: '22222222-2222-4222-8222-222222222222',
            pending_ticket_count: 1,
          }),
          { status: 200 }
        ),
    });
    await expect(
      client.submitAgentToolObservation({
        ticket: 'signed.ticket',
        argumentsPayload: { path: '/' },
        observationPayload: { ok: true },
      })
    ).resolves.toEqual({
      ok: true,
      pendingToolObservations: true,
      workflowTrace: {
        workflowRunId: '11111111-1111-4111-8111-111111111111',
        workflowStepId: '22222222-2222-4222-8222-222222222222',
      },
      pendingTicketCount: 1,
    });
  });

  it('records an immediate tool receipt with the turn-authorized session and no model continuation', async () => {
    const getSession = vi.fn(async () => ({ ...session, accountId: 'wrong-account' }));
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ticket_id: '33333333-3333-4333-8333-333333333333',
            workflow_run_id: '11111111-1111-4111-8111-111111111111',
            workflow_step_id: '22222222-2222-4222-8222-222222222222',
            provider_call_id: 'provider-call-1',
            tool_name: 'list_files',
          }),
          { status: 200 }
        )
      );
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession,
      fetch,
    });
    const observation = {
      turnBindingToken: 'turn-binding-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      turnId: 'turn-1',
      ticket: 'signed.ticket',
      argumentsPayload: { path: '/' },
      observationPayload: { ok: true, result: { files: [] } },
    };

    await expect(client.recordToolObservation(observation, session)).resolves.toEqual({
      ok: true,
      receipt: {
        ticketId: '33333333-3333-4333-8333-333333333333',
        workflowRunId: '11111111-1111-4111-8111-111111111111',
        workflowStepId: '22222222-2222-4222-8222-222222222222',
        providerCallId: 'provider-call-1',
        toolName: 'list_files',
      },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toBe('https://hosted.example.test/v1/hosted/tool-observation');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${session.accessToken}` });
    expect(JSON.parse(init.body)).toEqual({
      tool_ticket: 'signed.ticket',
      arguments: { path: '/' },
      observation: { ok: true, result: { files: [] } },
    });
  });

  it('uses the exact turn-authorized session for mutation claim, completion, and cancellation', async () => {
    const claimId = '44444444-4444-4444-8444-444444444444';
    const ticketId = '55555555-5555-4555-8555-555555555555';
    const responses = [
      { status: 'claimed', version: 1, already_applied: false },
      { status: 'completed', version: 2, already_applied: true },
      { status: 'canceled', version: 2, already_applied: false },
    ];
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const state = responses.shift();
      if (!state) throw new Error('Unexpected mutation authority request.');
      return new Response(
        JSON.stringify({
          claim_id: claimId,
          tool_ticket_id: ticketId,
          tool_name: 'create_design',
          expires_at: '2026-08-14T22:00:00.000Z',
          ...state,
        }),
        { status: 200 }
      );
    });
    const getSession = vi.fn(async () => ({ ...session, accountId: 'wrong-account' }));
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession,
      fetch,
    });
    const binding = {
      turnBindingToken: 'turn-binding-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      turnId: 'turn-1',
    };

    await expect(
      client.claimTool(
        {
          ...binding,
          ticket: 'signed.ticket',
          approvalReceiptRef: 'approval-1',
          idempotencyKey: 'tool-claim:call-1',
        },
        session
      )
    ).resolves.toMatchObject({ ok: true, claim: { claimId, status: 'claimed' } });
    await expect(
      client.completeToolClaim(
        {
          ...binding,
          claimId,
          idempotencyKey: 'tool-claim:call-1',
          effectReceiptRef: 'renderer-audit-1',
        },
        session
      )
    ).resolves.toMatchObject({ ok: true, claim: { claimId, status: 'completed' } });
    await expect(
      client.cancelToolClaim(
        {
          ...binding,
          claimId,
          idempotencyKey: 'tool-claim:call-1',
          reason: 'pre_effect_failure',
        },
        session
      )
    ).resolves.toMatchObject({ ok: true, claim: { claimId, status: 'canceled' } });

    expect(getSession).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://hosted.example.test/v1/hosted/tool-claim',
      'https://hosted.example.test/v1/hosted/tool-claim/complete',
      'https://hosted.example.test/v1/hosted/tool-claim/cancel',
    ]);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        tool_ticket: 'signed.ticket',
        approval_receipt_ref: 'approval-1',
        idempotency_key: 'tool-claim:call-1',
      },
      {
        claim_id: claimId,
        idempotency_key: 'tool-claim:call-1',
        effect_receipt_ref: 'renderer-audit-1',
      },
      {
        claim_id: claimId,
        idempotency_key: 'tool-claim:call-1',
        reason: 'pre_effect_failure',
      },
    ]);
  });

  it('terminalizes an observed inter-step workflow with the exact turn-authorized session', async () => {
    const getSession = vi.fn(async () => ({ ...session, accountId: 'wrong-account' }));
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            workflow_run_id: '11111111-1111-4111-8111-111111111111',
            workflow_step_id: '22222222-2222-4222-8222-222222222222',
            canary_lease_id: '33333333-3333-4333-8333-333333333333',
            final_status: 'cancelled',
            idempotent: false,
          }),
          { status: 200 }
        )
    );
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession,
      fetch,
    });
    const terminal = {
      turnBindingToken: 'turn-binding-1',
      workflowId: 'conversation-1',
      runId: 'turn-1',
      turnId: 'turn-1',
      workflowRunId: '11111111-1111-4111-8111-111111111111',
      workflowStepId: '22222222-2222-4222-8222-222222222222',
    };

    await expect(client.cancelWorkflow(terminal, session)).resolves.toEqual({
      ok: true,
      receipt: {
        workflowRunId: terminal.workflowRunId,
        workflowStepId: terminal.workflowStepId,
        canaryLeaseId: '33333333-3333-4333-8333-333333333333',
        finalStatus: 'cancelled',
        idempotent: false,
      },
    });
    expect(getSession).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0]!;
    if (!init) throw new Error('Expected Hosted request init.');
    expect(String(url)).toBe('https://hosted.example.test/v1/hosted/workflow-terminal');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${session.accessToken}` });
    expect(parseJsonRequestBody(init)).toEqual({
      workflow_run_id: terminal.workflowRunId,
      workflow_step_id: terminal.workflowStepId,
      client_workflow_id: 'conversation-1',
      client_run_id: 'turn-1',
    });
  });

  it('records Stop intent before stream cancellation without producing a desktop terminal event', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            workflow_run_id: '11111111-1111-4111-8111-111111111111',
            workflow_step_id: '22222222-2222-4222-8222-222222222222',
            idempotent: false,
          }),
          { status: 202 }
        )
    );
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch,
    });
    const intent = {
      turnBindingToken: 'turn-binding-1',
      workflowId: 'conversation-1',
      runId: 'turn-1',
      turnId: 'turn-1',
      workflowRunId: '11111111-1111-4111-8111-111111111111',
      workflowStepId: '22222222-2222-4222-8222-222222222222',
    };

    await expect(client.recordWorkflowStopIntent(intent, session)).resolves.toEqual({
      ok: true,
      receipt: {
        workflowRunId: intent.workflowRunId,
        workflowStepId: intent.workflowStepId,
        idempotent: false,
      },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://hosted.example.test/v1/hosted/workflow-stop-intent');
    expect(parseJsonRequestBody(init)).toEqual({
      workflow_run_id: intent.workflowRunId,
      workflow_step_id: intent.workflowStepId,
      client_workflow_id: intent.workflowId,
      client_run_id: intent.runId,
    });
  });

  it.each(['headers', 'body'])('bounds a Stop intent that stalls during %s', async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    const waitForAbort = () =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Timed out', 'AbortError')),
          { once: true }
        );
      });
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? null;
      if (phase === 'headers') return waitForAbort();
      const response = new Response(null, { status: 202 });
      response.json = waitForAbort;
      return response;
    });
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      fetch,
    });
    try {
      const attempt = client.recordWorkflowStopIntent(
        {
          turnBindingToken: 'turn-binding-1',
          workflowId: 'conversation-1',
          runId: 'turn-1',
          turnId: 'turn-1',
          workflowRunId: '11111111-1111-4111-8111-111111111111',
          workflowStepId: '22222222-2222-4222-8222-222222222222',
        },
        session
      );
      expect(signal).not.toBeNull();
      let settled = false;
      void attempt.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(attempt).resolves.toMatchObject({ ok: false, code: 'gateway_unavailable' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalizes only a bounded terminal output tied to server-issued agent trace identities', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })
    );
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch,
    });
    await expect(
      client.finalizeAgentWorkflow({
        workflowRunId: '11111111-1111-4111-8111-111111111111',
        workflowStepId: '22222222-2222-4222-8222-222222222222',
        terminalOutput: 'The completed visible result.',
      })
    ).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0]!;
    if (!init) throw new Error('Expected Hosted request init.');
    expect(String(url)).toBe('https://hosted.example.test/v1/hosted/agent/finalize');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer desktop-access-token-never-exposed-to-renderer',
    });
    expect(parseJsonRequestBody(init)).toEqual({
      agent_workflow_run_id: '11111111-1111-4111-8111-111111111111',
      agent_workflow_step_id: '22222222-2222-4222-8222-222222222222',
      terminal_output: 'The completed visible result.',
    });
  });

  it('projects account authority only from the authenticated gateway response', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            account_plan_setting: 'research_contribution',
            research_contribution_eligible: true,
            show_research_contribution_notice: true,
            terms_url: 'https://www.dnaforge.com/terms',
            privacy_url: 'https://www.dnaforge.com/privacy',
          }),
          { status: 200 }
        )
    );
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch,
    });
    await expect(client.getWorkflowAuthority()).resolves.toEqual({
      ok: true,
      authority: {
        accountPlanSetting: 'research_contribution',
        researchContributionEligible: true,
        showResearchContributionNotice: true,
        termsUrl: 'https://www.dnaforge.com/terms',
        privacyUrl: 'https://www.dnaforge.com/privacy',
      },
    });
    const [url, init] = fetch.mock.calls[0]!;
    if (!init) throw new Error('Expected Hosted request init.');
    expect(String(url)).toBe('https://hosted.example.test/v1/hosted/workflow-authority');
    expect(init).toMatchObject({
      headers: { authorization: 'Bearer desktop-access-token-never-exposed-to-renderer' },
    });
  });

  it('fails closed on malformed account authority and records raw-trace deletion only through the gateway', async () => {
    const malformed = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(JSON.stringify({ account_plan_setting: 'research_contribution' }), {
          status: 200,
        }),
    });
    await expect(malformed.getWorkflowAuthority()).resolves.toEqual({
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI returned invalid account authority.',
    });

    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            deletion_request_id: '33333333-3333-4333-8333-333333333333',
            verified_desktop_session_id: session.desktopSessionId,
            requested_at: '2026-09-04T16:00:00.000Z',
            delete_by: '2026-09-28T00:00:00.000Z',
            idempotent: false,
          }),
          { status: 202 }
        )
    );
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch,
    });
    await expect(client.requestRawTraceDeletion()).resolves.toEqual({
      ok: true,
      httpStatus: 202,
      receipt: {
        deletionRequestId: '33333333-3333-4333-8333-333333333333',
        desktopSessionId: session.desktopSessionId,
        requestedAt: '2026-09-04T16:00:00.000Z',
        deleteBy: '2026-09-28T00:00:00.000Z',
        idempotent: false,
      },
    });
    const [url, init] = fetch.mock.calls[0]!;
    if (!init) throw new Error('Expected Hosted request init.');
    expect(String(url)).toBe('https://hosted.example.test/v1/hosted/raw-trace-deletion');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer desktop-access-token-never-exposed-to-renderer' },
    });

    const priorSessionId = '44444444-4444-4444-8444-444444444444';
    const idempotentReplay = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(
          JSON.stringify({
            deletion_request_id: '33333333-3333-4333-8333-333333333333',
            verified_desktop_session_id: priorSessionId,
            requested_at: '2026-09-04T16:00:00.000Z',
            delete_by: '2026-09-28T00:00:00.000Z',
            idempotent: true,
          }),
          { status: 202 }
        ),
    });
    await expect(idempotentReplay.requestRawTraceDeletion()).resolves.toEqual({
      ok: true,
      httpStatus: 202,
      receipt: {
        deletionRequestId: '33333333-3333-4333-8333-333333333333',
        desktopSessionId: priorSessionId,
        requestedAt: '2026-09-04T16:00:00.000Z',
        deleteBy: '2026-09-28T00:00:00.000Z',
        idempotent: true,
      },
    });

    const malformedIdempotentReplay = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(
          JSON.stringify({
            deletion_request_id: '33333333-3333-4333-8333-333333333333',
            verified_desktop_session_id: 'not-a-session-uuid',
            requested_at: '2026-09-04T16:00:00.000Z',
            delete_by: '2026-09-28T00:00:00.000Z',
            idempotent: true,
          }),
          { status: 202 }
        ),
    });
    await expect(malformedIdempotentReplay.requestRawTraceDeletion()).resolves.toEqual({
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI returned an invalid deletion receipt.',
      requestMayHaveBeenAccepted: true,
    });

    const crossSessionNewRequest = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(
          JSON.stringify({
            deletion_request_id: '33333333-3333-4333-8333-333333333333',
            verified_desktop_session_id: priorSessionId,
            requested_at: '2026-09-04T16:00:00.000Z',
            delete_by: '2026-09-28T00:00:00.000Z',
            idempotent: false,
          }),
          { status: 202 }
        ),
    });
    await expect(crossSessionNewRequest.requestRawTraceDeletion()).resolves.toEqual({
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI returned an invalid deletion receipt.',
      requestMayHaveBeenAccepted: true,
    });

    const wrongSuccessStatus = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(
          JSON.stringify({
            deletion_request_id: '33333333-3333-4333-8333-333333333333',
            verified_desktop_session_id: session.desktopSessionId,
            requested_at: '2026-09-04T16:00:00.000Z',
            delete_by: '2026-09-28T00:00:00.000Z',
            idempotent: false,
          }),
          { status: 200 }
        ),
    });
    await expect(wrongSuccessStatus.requestRawTraceDeletion()).resolves.toEqual({
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI returned an invalid deletion response.',
    });

    const responseLost = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () => {
        throw new Error('response lost after request write');
      },
    });
    await expect(responseLost.requestRawTraceDeletion()).resolves.toEqual({
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI is temporarily unavailable.',
      requestMayHaveBeenAccepted: true,
    });

    for (const status of [408, 500, 502, 503, 504]) {
      const committedBeforeError = new HostedAiGatewayClient({
        resolveUrl: () => new URL('https://hosted.example.test'),
        getSession: async () => session,
        fetch: async () =>
          new Response(JSON.stringify({ error: 'generation_unavailable' }), { status }),
      });
      await expect(committedBeforeError.requestRawTraceDeletion()).resolves.toEqual({
        ok: false,
        code: 'gateway_unavailable',
        message: 'DNAForge AI is temporarily unavailable.',
        requestMayHaveBeenAccepted: true,
      });
    }
  });

  it('does not label an upstream gateway failure as an intentional pause', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'generation_unavailable' }), { status: 503 }),
    });
    await expect(client.agentModelStep({ ...request, agentStepSequence: 0 })).resolves.toEqual({
      ok: false,
      code: 'gateway_unavailable',
      message: 'DNAForge AI is temporarily unavailable.',
    });
  });

  it('gives a specific BYOK/local fallback when the gateway rejects an exhausted allowance', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'allowance_exhausted' }), { status: 409 }),
    });
    await expect(client.agentModelStep({ ...request, agentStepSequence: 0 })).resolves.toEqual({
      ok: false,
      code: 'allowance_exhausted',
      message:
        'Your DNAForge AI allowance is exhausted. Choose a local or Bring Your Own Key route to continue.',
    });
  });

  it('reports a full burst window as a transient rate limit, not a terminal rejection', async () => {
    const client = new HostedAiGatewayClient({
      resolveUrl: () => new URL('https://hosted.example.test'),
      getSession: async () => session,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'hosted_request_rate_limited' }), { status: 409 }),
    });
    await expect(client.agentModelStep({ ...request, agentStepSequence: 0 })).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
      message: 'DNAForge AI is rate limited right now. Try again in about 60 seconds.',
      retryAfterSeconds: 60,
    });
  });

  it('honours Retry-After when the gateway supplies one, and bounds a hostile value', async () => {
    const withRetryAfter = (value: string) =>
      new HostedAiGatewayClient({
        resolveUrl: () => new URL('https://hosted.example.test'),
        getSession: async () => session,
        fetch: async () =>
          new Response(JSON.stringify({ error: 'hosted_request_rate_limited' }), {
            status: 409,
            headers: { 'retry-after': value },
          }),
      });

    await expect(
      withRetryAfter('5').agentModelStep({ ...request, agentStepSequence: 0 })
    ).resolves.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 5 });

    await expect(
      withRetryAfter('99999').agentModelStep({ ...request, agentStepSequence: 0 })
    ).resolves.toMatchObject({ retryAfterSeconds: 300 });

    await expect(
      withRetryAfter('not-a-number').agentModelStep({ ...request, agentStepSequence: 0 })
    ).resolves.toMatchObject({ retryAfterSeconds: 60 });
  });
});
