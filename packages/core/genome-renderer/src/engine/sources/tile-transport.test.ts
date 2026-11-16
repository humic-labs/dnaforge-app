import { describe, it, expect, vi } from 'vitest';
import {
  httpTileTransport,
  tileRoutePath,
  SIDECAR_SESSION_HEADER,
  type TileTransportRequest,
} from './tile-transport';

const req: TileTransportRequest = {
  kind: 'coverage',
  level: 8,
  tileIndex: 13,
  body: { bamPath: '/x.bam', chrom: 'chr11' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('tileRoutePath', () => {
  it('builds /tiles/{kind}/{level}/{tileIndex}', () => {
    expect(tileRoutePath(req)).toBe('/tiles/coverage/8/13');
    expect(tileRoutePath({ ...req, kind: 'annotation', level: 0, tileIndex: 5103 })).toBe(
      '/tiles/annotation/0/5103'
    );
  });
});

describe('httpTileTransport', () => {
  it('POSTs the body to the route URL with content-type + session header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { bins: [1, 2, 3] }));
    const transport = httpTileTransport({
      baseUrl: 'http://localhost:8015/',
      sessionToken: 'sess-abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await transport(req, new AbortController().signal);
    expect(res).toEqual({ ok: true, status: 200, body: { bins: [1, 2, 3] } });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8015/tiles/coverage/8/13');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ bamPath: '/x.bam', chrom: 'chr11' });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers[SIDECAR_SESSION_HEADER]).toBe('sess-abc');
  });

  it.each([null, 'identity', 'IDENTITY'])(
    'retains uncompressed JSON body bytes for encoding %s',
    async (encoding) => {
      const body = { reads: [{ readId: 'résumé' }] };
      const serialized = JSON.stringify(body);
      const byteSize = new TextEncoder().encode(serialized).byteLength;
      const headers = new Headers({ 'Content-Length': String(byteSize) });
      if (encoding !== null) headers.set('Content-Encoding', encoding);
      const transport = httpTileTransport({
        baseUrl: 'http://h',
        fetchImpl: vi.fn(async () => new Response(serialized, { headers })) as typeof fetch,
      });

      const response = await transport(req, new AbortController().signal);

      expect(response).toEqual({ ok: true, status: 200, body, bodyByteSize: byteSize });
    }
  );

  it.each(['gzip', 'br', 'deflate', 'identity, gzip'])(
    'does not count compressed Content-Length as decoded bytes for %s',
    async (encoding) => {
      const transport = httpTileTransport({
        baseUrl: 'http://h',
        fetchImpl: vi.fn(
          async () =>
            new Response('{"reads":[]}', {
              headers: { 'Content-Length': '4', 'Content-Encoding': encoding },
            })
        ) as typeof fetch,
      });

      const response = await transport(req, new AbortController().signal);

      expect(response).toEqual({ ok: true, status: 200, body: { reads: [] } });
    }
  );

  it.each([null, '', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 123 ', '9007199254740992'])(
    'does not retain invalid JSON body byte count %s',
    async (length) => {
      const transport = httpTileTransport({
        baseUrl: 'http://h',
        fetchImpl: vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: { get: (key: string) => (key === 'Content-Length' ? length : null) },
          json: async () => ({ reads: [] }),
        })) as unknown as typeof fetch,
      });

      const response = await transport(req, new AbortController().signal);

      expect(response).toEqual({ ok: true, status: 200, body: { reads: [] } });
    }
  );

  it.each([null, 'identity'])(
    'requires observable encoding for a cross-origin response with encoding %s',
    async (encoding) => {
      const transport = httpTileTransport({
        baseUrl: 'http://h',
        fetchImpl: vi.fn(async () => ({
          ok: true,
          status: 200,
          type: 'cors',
          headers: {
            get: (key: string) => (key === 'Content-Length' ? '12' : encoding),
          },
          json: async () => ({ reads: [] }),
        })) as unknown as typeof fetch,
      });

      const response = await transport(req, new AbortController().signal);

      expect(response).toEqual({
        ok: true,
        status: 200,
        body: { reads: [] },
        ...(encoding === 'identity' ? { bodyByteSize: 12 } : {}),
      });
    }
  );

  it('does not retain body bytes when JSON decoding fails', async () => {
    const transport = httpTileTransport({
      baseUrl: 'http://h',
      fetchImpl: vi.fn(
        async () => new Response('not-json', { headers: { 'Content-Length': '8' } })
      ) as typeof fetch,
    });

    expect(await transport(req, new AbortController().signal)).toEqual({
      ok: true,
      status: 200,
      body: null,
    });
  });

  it('a 404 RESOLVES with ok:false (transport does not throw on HTTP error)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { detail: 'index-missing' }));
    const transport = httpTileTransport({
      baseUrl: 'http://h',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await transport(req, new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: 'index-missing' });
  });

  it('threads the AbortSignal into fetch', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(200, {});
    });
    const transport = httpTileTransport({
      baseUrl: 'http://h',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ac = new AbortController();
    await transport(req, ac.signal);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('a true network failure / abort REJECTS (propagated to the adapter)', async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const transport = httpTileTransport({
      baseUrl: 'http://h',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport(req, new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('a non-JSON error body is tolerated (body parsed as null, no thrown reject)', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream 503 <html>', { status: 503 }));
    const transport = httpTileTransport({
      baseUrl: 'http://h',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await transport(req, new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.body).toBeNull();
  });

  it('omits the session header when no token is configured', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const transport = httpTileTransport({
      baseUrl: 'http://h',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await transport(req, new AbortController().signal);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)[SIDECAR_SESSION_HEADER]).toBeUndefined();
  });
});
