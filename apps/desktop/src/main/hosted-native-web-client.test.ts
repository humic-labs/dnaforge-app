import { describe, expect, it, vi } from 'vitest';
import {
  HostedNativeWebClient,
  type HostedNativeWebRequest,
  type HostedNativeWebResponse,
} from './hosted-native-web-client';

const encoder = new TextEncoder();

function response(
  body: string,
  options: {
    statusCode?: number;
    contentType?: string;
    location?: string;
  } = {},
  discard: () => void = () => {}
): HostedNativeWebResponse {
  return {
    statusCode: options.statusCode ?? 200,
    headers: {
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
      ...(options.location ? { location: options.location } : {}),
    },
    body: (async function* () {
      yield encoder.encode(body);
    })(),
    discard,
  };
}

function publicLookup(hostname: string) {
  return Promise.resolve([
    {
      address: hostname === 'example.org' ? '93.184.216.35' : '93.184.216.34',
      family: 4 as const,
    },
  ]);
}

describe('HostedNativeWebClient', () => {
  it('pins a public address and returns bounded readable HTML without active content', async () => {
    const request = vi.fn(async (_request: HostedNativeWebRequest) =>
      response(
        '<html><head><title>Example page</title><style>hidden</style></head>' +
          '<body><main>Hello <strong>world</strong>.</main><script>steal()</script></body></html>',
        { contentType: 'text/html; charset=utf-8' }
      )
    );
    const client = new HostedNativeWebClient({ lookup: publicLookup, request });

    await expect(client.fetch('https://example.com/docs?q=dna')).resolves.toEqual({
      url: 'https://example.com/docs?q=dna',
      title: 'Example page',
      content: 'Hello world.',
      content_type: 'text/html',
      truncated: false,
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: new URL('https://example.com/docs?q=dna'),
        address: '93.184.216.34',
        family: 4,
      })
    );
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:password@example.com/',
    'https://example.com:8443/private',
    'http://127.0.0.1/admin',
    'https://[::1]/admin',
    'https://[::ffff:127.0.0.1]/admin',
  ])('rejects an unsafe URL before any network request: %s', async (url) => {
    const request = vi.fn();
    const client = new HostedNativeWebClient({ lookup: publicLookup, request });

    await expect(client.fetch(url)).rejects.toThrow(/safe public web address/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed when DNS returns any private address alongside a public address', async () => {
    const request = vi.fn();
    const client = new HostedNativeWebClient({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.9', family: 4 },
      ],
      request,
    });

    await expect(client.fetch('https://mixed.example/')).rejects.toThrow(
      /safe public web address/i
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('revalidates every redirect before issuing the next request', async () => {
    const discard = vi.fn();
    const request = vi.fn(async () =>
      response(
        '',
        {
          statusCode: 302,
          location: 'http://169.254.169.254/latest/meta-data',
        },
        discard
      )
    );
    const client = new HostedNativeWebClient({ lookup: publicLookup, request });

    await expect(client.fetch('https://example.com/start')).rejects.toThrow(
      /safe public web address/i
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledOnce();
  });

  it('follows a bounded public redirect and pins the new host independently', async () => {
    const request = vi
      .fn<(request: HostedNativeWebRequest) => Promise<HostedNativeWebResponse>>()
      .mockResolvedValueOnce(
        response('', { statusCode: 301, location: 'https://example.org/final' })
      )
      .mockResolvedValueOnce(response('Final text', { contentType: 'text/plain' }));
    const client = new HostedNativeWebClient({ lookup: publicLookup, request });

    await expect(client.fetch('https://example.com/start')).resolves.toMatchObject({
      url: 'https://example.org/final',
      content: 'Final text',
      content_type: 'text/plain',
    });
    expect(request.mock.calls.map(([call]) => [call.url.hostname, call.address])).toEqual([
      ['example.com', '93.184.216.34'],
      ['example.org', '93.184.216.35'],
    ]);
  });

  it('rejects unsupported content types and responses over the byte ceiling', async () => {
    const lookup = publicLookup;
    const binary = new HostedNativeWebClient({
      lookup,
      request: async () => response('binary', { contentType: 'application/octet-stream' }),
    });
    await expect(binary.fetch('https://example.com/file')).rejects.toThrow(
      /content type is not supported/i
    );

    const discard = vi.fn();
    const oversized = new HostedNativeWebClient({
      lookup,
      maximumBytes: 4,
      request: async () => response('12345', { contentType: 'text/plain' }, discard),
    });
    await expect(oversized.fetch('https://example.com/large')).rejects.toThrow(
      /response is too large/i
    );
    expect(discard).toHaveBeenCalledOnce();
  });

  it('does not start DNS or HTTP work for a pre-aborted operation', async () => {
    const lookup = vi.fn(publicLookup);
    const request = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const client = new HostedNativeWebClient({ lookup, request });

    await expect(client.fetch('https://example.com/', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
