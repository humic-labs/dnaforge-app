// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostedBrowserProposalError,
  createHostedBrowserProposal,
  decideHostedBrowserProposal,
  executeHostedBrowserProposal,
  loadHostedBrowserProposal,
} from './browser-proposal';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';

const snapshot = {
  proposal_id: proposalId,
  workspace_id: workspaceId,
  version_id: versionId,
  version_sha256: 'a'.repeat(64),
  tool_name: 'workspace.metadata_read' as const,
  arguments: {
    workspace_id: workspaceId,
    version_id: versionId,
    include: ['metadata'],
  },
  arguments_sha256: 'b'.repeat(64),
  created_at: '2026-09-29T12:00:00.000Z',
  expires_at: '2026-09-29T12:05:00.000Z',
  decision: null,
  decided_at: null,
  status: 'pending' as const,
  execution: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('hosted browser proposal client', () => {
  it('creates a proposal through the same-origin proxy with exact revision binding', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createHostedBrowserProposal({
        workspaceId,
        versionId,
        versionSha256: 'a'.repeat(64),
        argumentsPayload: {
          workspace_id: workspaceId,
          version_id: versionId,
          include: ['metadata'],
        },
        idempotencyKey: 'proposal-1',
      })
    ).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/hosted/browser/proposals',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          version_id: versionId,
          version_sha256: 'a'.repeat(64),
          tool_name: 'workspace.metadata_read',
          arguments: {
            workspace_id: workspaceId,
            version_id: versionId,
            include: ['metadata'],
          },
          idempotency_key: 'proposal-1',
        }),
      })
    );
  });

  it('reloads and decides a proposal without sending a bearer credential', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...snapshot, decision: 'denied', status: 'denied' }), {
          status: 200,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadHostedBrowserProposal(proposalId)).resolves.toEqual(snapshot);
    await expect(
      decideHostedBrowserProposal({
        proposalId,
        decision: 'deny',
        idempotencyKey: 'decision-1',
      })
    ).resolves.toMatchObject({ decision: 'denied', status: 'denied' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/v1/hosted/browser/proposals/${proposalId}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/v1/hosted/browser/proposals/${proposalId}/decision`
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBeNull();
  });

  it('maps stale revision refusal and rejects invalid input before egress', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'stale_proposal' }), { status: 409 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      decideHostedBrowserProposal({
        proposalId,
        decision: 'approve',
        idempotencyKey: 'decision-2',
      })
    ).rejects.toEqual(
      new HostedBrowserProposalError(
        409,
        'stale_proposal',
        'The inspected revision changed; inspect the workspace again before deciding.'
      )
    );
    await expect(loadHostedBrowserProposal('not-a-uuid')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a reloadable unavailable effect outcome', async () => {
    const terminal = {
      ...snapshot,
      decision: 'approved' as const,
      decided_at: '2026-09-29T12:01:00.000Z',
      status: 'approved' as const,
      execution: {
        status: 'unavailable' as const,
        outcome_id: '44444444-4444-4444-8444-444444444444',
        error_code: 'effect_unavailable' as const,
        recorded_at: '2026-09-29T12:01:01.000Z',
      },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(terminal), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      executeHostedBrowserProposal({ proposalId, idempotencyKey: 'execution-1' })
    ).resolves.toEqual(terminal);
  });

  it('rejects oversized arguments before calling the proxy', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createHostedBrowserProposal({
        workspaceId,
        versionId,
        versionSha256: 'a'.repeat(64),
        argumentsPayload: { value: 'x'.repeat(17_000) },
        idempotencyKey: 'proposal-large',
      })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
