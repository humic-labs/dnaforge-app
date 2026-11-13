import { describe, expect, it, vi } from 'vitest';
import { requestDiscoveryRanking } from './discovery-ranking';

const candidates = [
  {
    id: 'primers',
    name: 'design_primers',
    description: 'Design PCR primers.',
    privatePath: '/secret',
    instructions: 'PRIVATE BODY',
  },
];

describe('Jev discovery request boundary', () => {
  it('sends descriptors only and distinguishes no-match from unavailable', async () => {
    const request = vi.fn(async (_init: RequestInit) => Response.json({ ids: [] }));
    expect(await requestDiscoveryRanking('amplify this region', candidates, request)).toEqual([]);
    const body = String(request.mock.calls[0]?.[0]?.body);
    expect(body).toContain('amplify this region');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('PRIVATE BODY');
    expect(
      await requestDiscoveryRanking(
        'query',
        candidates,
        async () => new Response('', { status: 503 })
      )
    ).toBeNull();
  });

  it.each([['unavailable_tool'], ['primers', 'primers'], [7], null])(
    'rejects invalid IDs %j',
    async (ids) => {
      expect(
        await requestDiscoveryRanking('query', candidates, async () => Response.json({ ids }))
      ).toBeNull();
    }
  );

  it('falls back on malformed bodies or network failures', async () => {
    expect(
      await requestDiscoveryRanking('query', candidates, async () => new Response('invalid'))
    ).toBeNull();
    expect(
      await requestDiscoveryRanking('query', candidates, async () => {
        throw Error('offline');
      })
    ).toBeNull();
  });

  it('does not turn Stop into a lexical retry', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (init: RequestInit) => {
      controller.abort();
      init.signal?.throwIfAborted();
      throw new DOMException('Stopped', 'AbortError');
    });
    await expect(
      requestDiscoveryRanking('query', candidates, request, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects oversized catalogs before sending a request', async () => {
    const request = vi.fn();
    expect(
      await requestDiscoveryRanking(
        'query',
        Array.from({ length: 513 }, (_, i) => ({ ...candidates[0], id: String(i) })),
        request
      )
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves Stop when a non-success response arrives at the same time', async () => {
    const controller = new AbortController();
    await expect(
      requestDiscoveryRanking(
        'query',
        candidates,
        async () => {
          controller.abort();
          return new Response('', { status: 503 });
        },
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
