import { describe, expect, it, vi } from 'vitest';
import {
  createNativeAgentGrantAuthorizer,
  createNativeAgentGrantInspector,
} from './agent-grant-authority';
const authority = { identityId: 'agent-one', capabilities: ['*'] };
vi.mock('./config', () => ({ getApiUrl: () => 'http://127.0.0.1:8123' }));
describe('current native agent authority', () => {
  it('refuses malformed actual grant scopes for inspection and execution', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        grants: [{ id: 'agent-one', scopes: '*' }],
        hasMore: false,
      })
    );
    expect(await createNativeAgentGrantInspector(fetch)('agent-one')).toMatchObject({
      scopes: null,
    });
    await expect(
      createNativeAgentGrantAuthorizer(fetch)(authority, ['external-compute:tm'])
    ).rejects.toThrow('CAPABILITY_DENIED');
  });
  it('observes only the selected identity and reports its absence without granting access', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          grants: [{ id: 'other-agent', scopes: ['*'] }],
          hasMore: true,
          nextCursor: 'selected-page',
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          grants: [{ id: 'agent-one', scopes: ['read-workspace'], expiresAt: null }],
          hasMore: false,
        })
      );
    const inspect = createNativeAgentGrantInspector(fetch);
    expect(await inspect('agent-one')).toEqual({
      id: 'agent-one',
      scopes: ['read-workspace'],
      expiresAt: null,
    });
    expect(fetch.mock.calls[1][0]).toBe(
      'http://127.0.0.1:8123/agent-grants?pageSize=200&cursor=selected-page'
    );
    fetch.mockReset().mockResolvedValue(
      Response.json({
        ok: true,
        grants: [{ id: 'other-agent', scopes: ['*'] }],
        hasMore: false,
      })
    );
    expect(await inspect('agent-one')).toBeNull();
  });
  it('uses the exact live grant rather than trusting the command envelope', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        grants: [{ id: 'agent-one', scopes: ['read-workspace'], revokedAt: null, expiresAt: null }],
        hasMore: false,
      })
    );
    await expect(
      createNativeAgentGrantAuthorizer(fetch)(authority, ['external-compute:tm'])
    ).rejects.toThrow('CAPABILITY_DENIED');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { revokedAt: '2026-01-01', expiresAt: null },
    { revokedAt: null, expiresAt: '2000-01-01' },
    { revokedAt: null, expiresAt: 'invalid' },
  ])('refuses revoked or expired current access', async (flags) => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        grants: [{ id: 'agent-one', scopes: ['*'], ...flags }],
        hasMore: false,
      })
    );
    await expect(
      createNativeAgentGrantAuthorizer(fetch)(authority, ['external-compute:tm'])
    ).rejects.toThrow('CAPABILITY_DENIED');
  });
  it('resolves exact identity through the existing bounded grant pages', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ok: true, grants: [], hasMore: true, nextCursor: 'next-page' })
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          grants: [
            { id: 'agent-one', scopes: ['external-compute:tm'], revokedAt: null, expiresAt: null },
          ],
          hasMore: false,
        })
      );
    await createNativeAgentGrantAuthorizer(fetch)(authority, ['external-compute:tm']);
    expect(fetch.mock.calls[1][0]).toBe(
      'http://127.0.0.1:8123/agent-grants?pageSize=200&cursor=next-page'
    );
  });
  it.each([
    () => Response.json({ detail: 'not available' }, { status: 403 }),
    () => new Response('invalid JSON', { headers: { 'content-type': 'application/json' } }),
  ])('refuses unavailable or invalid JSON from the generated client', async (response) => {
    const fetch = vi.fn(async () => response());
    await expect(createNativeAgentGrantInspector(fetch)('agent-one')).rejects.toThrow(
      'AGENT_GRANTS_UNAVAILABLE'
    );
  });
});
