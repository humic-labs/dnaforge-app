import { describe, expect, it, vi } from 'vitest';

import {
  createSidecarFetch,
  injectReadySidecarSessionHeader,
  isTrustedSidecarRequestOwner,
  sidecarHeaderFailureDiagnostic,
  SIDECAR_AUTH_REQUEST_FILTER,
  SIDECAR_SESSION_HEADER,
  stripSidecarSessionHeaders,
  type SidecarRequestHeaders,
} from './sidecar-request-auth';
import { SidecarSessionAuthority } from './sidecar-session-authority';

describe('sidecar header failure diagnostics', () => {
  it('records the failing stage and current generation without session secrets or URL queries', () => {
    const error = Object.assign(new TypeError('secret-header-value'), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
    const diagnostic = sidecarHeaderFailureDiagnostic({
      stage: 'header-callback',
      error,
      requestUrl: 'http://127.0.0.1:8012/tiles/alignment?source=secret-source',
      sidecarBaseUrl: 'http://127.0.0.1:8012',
      snapshot: { owner: 'electron', generation: 3, state: 'ready', token: 'secret-session' },
    });
    expect(diagnostic).toEqual({
      stage: 'header-callback',
      errorName: 'TypeError',
      errorCode: 'ERR_INVALID_ARG_VALUE',
      owner: 'electron',
      generation: 3,
      state: 'ready',
      pathname: '/tiles/alignment',
      sidecarOriginMatches: true,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('secret');
  });

  it('does not copy arbitrary exception fields or paths outside the exact sidecar origin', () => {
    const error = Object.assign(new Error('secret-message'), {
      name: 'secret-name',
      code: 'secret-code',
      stack: 'secret-stack',
    });
    const diagnostic = sidecarHeaderFailureDiagnostic({
      stage: 'compute-header',
      error,
      requestUrl: 'https://example.com/secret-path?secret-query',
      sidecarBaseUrl: 'http://127.0.0.1:8012',
      snapshot: { owner: 'external', generation: 2, state: 'restarting', token: 'secret-session' },
    });
    expect(diagnostic).toMatchObject({
      errorName: 'unknown',
      errorCode: 'unknown',
      pathname: null,
      sidecarOriginMatches: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('secret');
  });
});

describe('sidecar request header boundary', () => {
  it('strips native write authority from renderer requests even to a private native route', async () => {
    const authority = new SidecarSessionAuthority();
    const snapshot = authority.prepareManagedSpawn('initial');
    authority.markReady(snapshot.generation);
    const headers = await injectReadySidecarSessionHeader({
      requestUrl: 'http://127.0.0.1:8012/internal/managed-documents/settle',
      sidecarBaseUrl: 'http://127.0.0.1:8012',
      authority,
      requestHeaders: { 'x-dnaforge-native-document-authority': 'forged' },
    });
    expect(
      Object.keys(headers).some((name) => name.toLowerCase().includes('native-document'))
    ).toBe(false);
    expect(Object.values(headers)).not.toContain(
      authority.nativeDocumentAuthority(authority.snapshot())?.token
    );
  });
  it('strips human operation authority from untrusted or redirected requests', () => {
    expect(
      stripSidecarSessionHeaders({
        'x-dnaforge-operation-authority': 'secret',
        'X-DNAFORGE-OPERATION-AUTHORITY': 'forged',
        Accept: 'application/json',
      })
    ).toEqual({ Accept: 'application/json' });
  });
  it('intercepts every destination so redirects cannot carry a session header away', () => {
    expect(SIDECAR_AUTH_REQUEST_FILTER).toEqual({ urls: ['<all_urls>'] });
  });

  it('strips all caller-supplied session spellings while authority is unavailable', () => {
    expect(
      stripSidecarSessionHeaders({
        Accept: 'application/json',
        'x-dnaforge-session': 'old',
        'X-DNAFORGE-SESSION': 'also-old',
      })
    ).toEqual({ Accept: 'application/json' });
  });
});

describe('isTrustedSidecarRequestOwner', () => {
  it('accepts the trusted WebContents object when a worker request omits webContentsId', () => {
    const frame = { url: 'file:///app/index.html' };
    expect(
      isTrustedSidecarRequestOwner(
        { webContents: { id: 41, mainFrame: frame }, frame },
        41,
        frame.url
      )
    ).toBe(true);
  });

  it('fails closed when Electron reports conflicting or missing ownership', () => {
    expect(
      isTrustedSidecarRequestOwner(
        { webContentsId: 7, webContents: { id: 41 } },
        41,
        'file:///app/index.html'
      )
    ).toBe(false);
    expect(isTrustedSidecarRequestOwner({}, 41, 'file:///app/index.html')).toBe(false);
    expect(
      isTrustedSidecarRequestOwner({ webContentsId: 41 }, null, 'file:///app/index.html')
    ).toBe(false);
  });
});

describe('injectReadySidecarSessionHeader', () => {
  it('adds human authority only to the managed-operation surface of the trusted origin', async () => {
    const authority = new SidecarSessionAuthority({
      initialToken: 'session',
      initialHumanOperationToken: 'human',
    });
    const spawn = authority.prepareManagedSpawn('initial');
    authority.markReady(spawn.generation);
    for (const path of [
      '/operations',
      '/operations/one/result',
      '/toolbox/retry/annotation',
      '/toolbox/retry/alignment',
      '/mcp/call',
      '/annotation',
      '/operations-other',
    ]) {
      const headers = await injectReadySidecarSessionHeader({
        requestUrl: `http://127.0.0.1:8012${path}`,
        sidecarBaseUrl: 'http://127.0.0.1:8012',
        requestHeaders: { 'x-dnaforge-operation-authority': 'forged' },
        authority,
      });
      expect(headers).toEqual({
        'X-DNAForge-Session': 'session',
        ...(path === '/operations' ||
        path.startsWith('/operations/') ||
        path === '/toolbox/retry/annotation'
          ? { 'X-DNAForge-Operation-Authority': 'human' }
          : {}),
      });
    }
  });

  it('overwrites stale spellings only after the exact sidecar origin is ready', async () => {
    const authority = new SidecarSessionAuthority({ initialToken: 'current' });
    const spawn = authority.prepareManagedSpawn('initial');
    authority.markReady(spawn.generation);

    await expect(
      injectReadySidecarSessionHeader({
        requestUrl: 'http://127.0.0.1:8012/services/?page=1',
        sidecarBaseUrl: 'http://127.0.0.1:8012',
        requestHeaders: {
          Accept: 'application/json',
          'x-dnaforge-session': 'stale',
          'X-DNAForge-Session': 'also-stale',
        },
        authority,
      })
    ).resolves.toEqual({ Accept: 'application/json', 'X-DNAForge-Session': 'current' });
  });

  it.each([
    'http://127.0.0.1:8013/services/',
    'http://localhost:8012/services/',
    'https://127.0.0.1:8012/services/',
    'https://attacker.example/collect',
  ])(
    'never waits for or injects authority into a different destination: %s',
    async (requestUrl) => {
      const authority = {
        waitForReadySnapshot: vi.fn(),
        isCurrent: vi.fn(),
      };
      await expect(
        injectReadySidecarSessionHeader({
          requestUrl,
          sidecarBaseUrl: 'http://127.0.0.1:8012',
          requestHeaders: { Accept: 'application/json', 'x-dnaforge-session': 'caller-stale' },
          authority,
        })
      ).resolves.toEqual({ Accept: 'application/json' });
      expect(authority.waitForReadySnapshot).not.toHaveBeenCalled();
    }
  );

  it.each([
    'https://127.0.0.1:8012',
    'http://attacker.example:8012',
    'http://user:password@127.0.0.1:8012',
  ])('does not consult authority for an unsafe configured origin: %s', async (sidecarBaseUrl) => {
    const authority = {
      waitForReadySnapshot: vi.fn(),
      isCurrent: vi.fn(),
    };
    await expect(
      injectReadySidecarSessionHeader({
        requestUrl: `${sidecarBaseUrl}/services/`,
        sidecarBaseUrl,
        requestHeaders: { 'X-DNAForge-Session': 'caller-stale' },
        authority,
      })
    ).resolves.toEqual({});
    expect(authority.waitForReadySnapshot).not.toHaveBeenCalled();
  });

  it('waits through restart and injects only the ready generation token', async () => {
    let tokenNumber = 0;
    const authority = new SidecarSessionAuthority({
      mintToken: () => `generation-${tokenNumber++}`,
    });
    const spawn = authority.prepareManagedSpawn('respawn');
    const pending = injectReadySidecarSessionHeader({
      requestUrl: 'http://127.0.0.1:8012/tiles/0/0',
      sidecarBaseUrl: 'http://127.0.0.1:8012',
      requestHeaders: { 'X-DNAForge-Session': 'renderer-supplied' },
      authority,
    });

    authority.markReady(spawn.generation);
    await expect(pending).resolves.toEqual({ 'X-DNAForge-Session': 'generation-1' });
  });

  it('does not wait or read authority state for a non-sidecar destination', async () => {
    const authority = {
      waitForReadySnapshot: vi.fn(),
      isCurrent: vi.fn(),
    };
    await expect(
      injectReadySidecarSessionHeader({
        requestUrl: 'https://attacker.example/collect',
        sidecarBaseUrl: 'http://127.0.0.1:8012',
        requestHeaders: { 'X-DNAForge-Session': 'renderer-supplied', Accept: 'text/plain' },
        authority,
      })
    ).resolves.toEqual({ Accept: 'text/plain' });
    expect(authority.waitForReadySnapshot).not.toHaveBeenCalled();
  });
});

describe('createSidecarFetch', () => {
  it.each(['claim-policy', 'lease'])(
    'injects native authority only for the exact organization inventory %s path',
    async (endpoint) => {
      const fetchImpl = vi.fn(
        async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response('{}')
      );
      const privateFetch = createSidecarFetch({
        getBaseUrl: () => 'http://127.0.0.1:8012',
        getCurrentToken: () => 'session',
        getNativeDocumentToken: () => 'native',
        fetchImpl,
      });
      await privateFetch(`/agent-grants/agent%20one/organization-inventory/${endpoint}`);
      expect(
        new Headers(fetchImpl.mock.calls[0][1]?.headers).get('X-DNAForge-Native-Document-Authority')
      ).toBe('native');
    }
  );

  it('does not expand private authority to other grant routes or to renderer claim requests', async () => {
    const captured: Headers[] = [];
    const privateFetch = createSidecarFetch({
      getBaseUrl: () => 'http://127.0.0.1:8012',
      getCurrentToken: () => 'session',
      getNativeDocumentToken: () => 'native',
      fetchImpl: async (_url, init) => {
        captured.push(new Headers(init?.headers));
        return new Response('{}');
      },
    });
    for (const path of [
      '/agent-grants',
      '/agent-grants/agent-one',
      '/agent-grants/agent-one/organization-inventory',
      '/agent-grants/agent-one/organization-inventory/claim-policy/',
      '/agent-grants/agent-one/organization-inventory/lease/extra',
      '/agent-grants/agent/one/organization-inventory/lease',
    ])
      await privateFetch(path, { headers: { 'X-DNAForge-Native-Document-Authority': 'forged' } });
    expect(captured.every((headers) => !headers.has('X-DNAForge-Native-Document-Authority'))).toBe(
      true
    );
    const authority = new SidecarSessionAuthority();
    const snapshot = authority.prepareManagedSpawn('initial');
    authority.markReady(snapshot.generation);
    const renderer = await injectReadySidecarSessionHeader({
      requestUrl: 'http://127.0.0.1:8012/agent-grants/agent-one/organization-inventory/lease',
      sidecarBaseUrl: 'http://127.0.0.1:8012',
      authority,
      requestHeaders: { 'X-DNAForge-Native-Document-Authority': 'forged' },
    });
    expect(
      new Headers(renderer as Record<string, string>).has('X-DNAForge-Native-Document-Authority')
    ).toBe(false);
  });

  it('does not turn the ordinary main request proxy into native write authority', async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response('{}')
    );
    const ordinary = createSidecarFetch({
      getBaseUrl: () => 'http://127.0.0.1:8012',
      getCurrentToken: () => 'session',
      getHumanOperationToken: () => 'human',
      fetchImpl,
    });
    await ordinary('/internal/managed-documents/settle', {
      headers: { 'x-dnaforge-native-document-authority': 'forged' },
    });
    expect(
      new Headers(fetchImpl.mock.calls[0][1]?.headers).has('X-DNAForge-Native-Document-Authority')
    ).toBe(false);
  });

  it('sends private native authority only on its own path and strips it on redirect', async () => {
    const calls: Headers[] = [];
    const privateFetch = createSidecarFetch({
      getBaseUrl: () => 'http://127.0.0.1:8012',
      getCurrentToken: () => 'session',
      getNativeDocumentToken: () => 'native',
      fetchImpl: async (_url, init) => {
        calls.push(new Headers(init?.headers));
        return calls.length === 1
          ? new Response(null, { status: 307, headers: { location: '/health' } })
          : new Response('{}');
      },
    });
    await privateFetch('/internal/managed-documents/settle');
    expect(calls[0].get('X-DNAForge-Native-Document-Authority')).toBe('native');
    expect(calls[1].has('X-DNAForge-Native-Document-Authority')).toBe(false);
  });
  it('drops human authority when a same-origin redirect leaves the operation surface', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/health' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const fetchFromMain = createSidecarFetch({
      getBaseUrl: () => 'http://127.0.0.1:8012',
      getCurrentToken: () => 'session',
      getHumanOperationToken: () => 'human',
      fetchImpl,
    });
    await fetchFromMain('/operations', {
      headers: { 'x-dnaforge-operation-authority': 'forged' },
    });
    expect(fetchImpl.mock.calls[0][1].headers.get('X-DNAForge-Operation-Authority')).toBe('human');
    expect(fetchImpl.mock.calls[1][1].headers.has('X-DNAForge-Operation-Authority')).toBe(false);
  });

  it.each([
    'https://127.0.0.1:8012',
    'http://attacker.example:8012',
    'http://user:password@127.0.0.1:8012',
  ])(
    'rejects an unsafe configured authority before reading or sending the token: %s',
    async (baseUrl) => {
      const getCurrentToken = vi.fn(() => 'secret');
      const fetchImpl = vi.fn();
      const sidecarFetch = createSidecarFetch({
        getBaseUrl: () => baseUrl,
        getCurrentToken,
        fetchImpl,
      });

      await expect(sidecarFetch('/services/')).rejects.toThrow(
        'sidecarFetch refuses a non-loopback configured sidecar URL'
      );
      expect(getCurrentToken).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('reads the current token at send time and preserves request behavior', async () => {
    let token = 'generation-1';
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response('{"ok":true}', { status: 200 })
    );
    const sidecarFetch = createSidecarFetch({
      getBaseUrl: () => 'http://127.0.0.1:8012',
      getCurrentToken: () => token,
      fetchImpl,
    });

    const signal = AbortSignal.timeout(1000);
    await sidecarFetch('/genome/index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"input":"fixture"}',
      signal,
    });
    token = 'generation-2';
    await sidecarFetch('/services/');

    const [firstUrl, firstInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const [secondUrl, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toBe('http://127.0.0.1:8012/genome/index');
    expect(firstInit).toMatchObject({
      method: 'POST',
      body: '{"input":"fixture"}',
      signal,
    });
    expect(new Headers(firstInit.headers)).toMatchObject({});
    expect(new Headers(firstInit.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(firstInit.headers).get('X-DNAForge-Session')).toBe('generation-1');
    expect(secondUrl).toBe('http://127.0.0.1:8012/services/');
    expect(new Headers(secondInit.headers).get('X-DNAForge-Session')).toBe('generation-2');
  });

  it('does not send a request when the current session is unavailable', async () => {
    const fetchImpl = vi.fn();
    const sidecarFetch = createSidecarFetch({
      getBaseUrl: () => 'http://127.0.0.1:8012',
      getCurrentToken: () => {
        throw new Error('SIDECAR_SESSION_UNAVAILABLE');
      },
      fetchImpl,
    });

    await expect(sidecarFetch('/services/')).rejects.toThrow('SIDECAR_SESSION_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin redirect without forwarding the session', async () => {
    const fetchImpl = vi.fn(async () => Response.redirect('https://attacker.example/collect', 307));
    const sidecarFetch = createSidecarFetch({
      getBaseUrl: () => 'http://127.0.0.1:8012',
      getCurrentToken: () => 'secret',
      fetchImpl,
    });

    await expect(sidecarFetch('/services/')).rejects.toThrow(
      'sidecarFetch refuses redirects outside the configured sidecar origin'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('revalidates and authenticates each same-origin redirect hop', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { Location: '/services/' } })
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const sidecarFetch = createSidecarFetch({
      getBaseUrl: () => 'http://127.0.0.1:8012',
      getCurrentToken: () => 'secret',
      fetchImpl,
    });

    await expect(sidecarFetch('/services')).resolves.toHaveProperty('status', 200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8012/services',
      'http://127.0.0.1:8012/services/',
    ]);
    for (const [, requestInit] of fetchImpl.mock.calls) {
      expect(new Headers(requestInit.headers).get(SIDECAR_SESSION_HEADER)).toBe('secret');
      expect(requestInit.redirect).toBe('manual');
    }
  });
});
