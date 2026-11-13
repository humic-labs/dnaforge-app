import { describe, expect, it } from 'vitest';

import { SidecarSessionAuthority } from '../sidecar-session-authority';
import {
  isTrustedSidecarRequestOwner,
  type SidecarRequestHeaders,
  type SidecarRequestOwner,
} from '../sidecar-request-auth';

import { COMPUTE_CREDENTIAL_HEADER } from '../../shared/compute-ipc';
import {
  computeProviderFromPath,
  createSidecarRequestHeaderHandler,
  injectComputeCredentialHeader,
  stripComputeCredentialHeaders,
} from './credential-injection';

const SIDECAR = 'http://127.0.0.1:8765';

describe('computeProviderFromPath', () => {
  it('extracts the provider from operation routes only', () => {
    expect(computeProviderFromPath('/compute/tamarind/tools')).toBe('tamarind');
    expect(computeProviderFromPath('/compute/nvidia-nim/submit')).toBe('nvidia-nim');
    expect(computeProviderFromPath('/compute/tamarind/verify/')).toBe('tamarind');
  });

  it('does not match the provider list, other routes, or malformed ids', () => {
    expect(computeProviderFromPath('/compute/providers')).toBeNull();
    expect(computeProviderFromPath('/external/neb/tm')).toBeNull();
    expect(computeProviderFromPath('/compute/Tamarind/tools')).toBeNull();
    expect(computeProviderFromPath('/compute/../tools')).toBeNull();
    expect(computeProviderFromPath('/compute/tamarind')).toBeNull();
  });
});

describe('injectComputeCredentialHeader', () => {
  it('strips any caller-supplied credential and injects the keychain value for the URL provider', async () => {
    const headers = await injectComputeCredentialHeader({
      sidecarBaseUrl: SIDECAR,
      isAuthorized: () => true,
      requestUrl: `${SIDECAR}/compute/tamarind/submit`,
      requestHeaders: {
        'Content-Type': 'application/json',
        [COMPUTE_CREDENTIAL_HEADER]: 'renderer-chosen-key',
        'x-dnaforge-compute-credential': 'renderer-chosen-key-2',
      },
      readCredential: async (id) => (id === 'tamarind' ? 'keychain-key' : null),
    });
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      [COMPUTE_CREDENTIAL_HEADER]: 'keychain-key',
    });
  });

  it('sends no credential when none is stored, so the sidecar answers missing_credential', async () => {
    const headers = await injectComputeCredentialHeader({
      sidecarBaseUrl: SIDECAR,
      isAuthorized: () => true,
      requestUrl: `${SIDECAR}/compute/subseq/tools`,
      requestHeaders: { [COMPUTE_CREDENTIAL_HEADER]: 'forged' },
      readCredential: async () => null,
    });
    expect(headers).toEqual({});
  });

  it('leaves non-compute requests alone apart from stripping the header', async () => {
    const reads: string[] = [];
    const headers = await injectComputeCredentialHeader({
      sidecarBaseUrl: SIDECAR,
      isAuthorized: () => true,
      requestUrl: `${SIDECAR}/external/neb/tm`,
      requestHeaders: { A: 'b', [COMPUTE_CREDENTIAL_HEADER]: 'forged' },
      readCredential: async (id) => {
        reads.push(id);
        return 'k';
      },
    });
    expect(headers).toEqual({ A: 'b' });
    expect(reads).toEqual([]);
  });

  it('tolerates an unparsable URL', async () => {
    const headers = await injectComputeCredentialHeader({
      sidecarBaseUrl: SIDECAR,
      isAuthorized: () => true,
      requestUrl: 'not a url',
      requestHeaders: { A: 'b' },
      readCredential: async () => 'k',
    });
    expect(headers).toEqual({ A: 'b' });
  });
});

describe('stripComputeCredentialHeaders', () => {
  it('is case-insensitive and preserves everything else', () => {
    expect(
      stripComputeCredentialHeaders({ 'X-DNAFORGE-COMPUTE-CREDENTIAL': 'x', Keep: ['a', 'b'] })
    ).toEqual({ Keep: ['a', 'b'] });
  });
});

describe('composed renderer request header hook', () => {
  it.each(['https://foreign.example', 'http://127.0.0.1:9999'])(
    'does not read or attach a compute key for %s',
    async (origin) => {
      const reads: string[] = [];
      const handler = createSidecarRequestHeaderHandler({
        isTrustedOwner: () => true,
        getSidecarBaseUrl: () => SIDECAR,
        authority: {
          waitForReadySnapshot: async () => ({
            owner: 'electron',
            state: 'ready',
            generation: 1,
            token: 'session-sentinel',
          }),
          isCurrent: () => true,
        },
        readCredential: async (id) => {
          reads.push(id);
          return 'nonfunctional-sentinel';
        },
        onError: () => undefined,
      });
      const result = await new Promise((resolve) =>
        handler(
          { url: `${origin}/compute/tamarind/status`, requestHeaders: {}, webContentsId: 1 },
          resolve
        )
      );
      expect({ reads, result }).toEqual({ reads: [], result: { requestHeaders: {} } });
    }
  );
});

describe('composed request authority matrix', () => {
  const protectedHeaders = {
    'X-DNAFORGE-COMPUTE-CREDENTIAL': 'forged-compute',
    'x-dnaforge-compute-credential': 'forged-compute-duplicate',
    'X-DNAFORGE-SESSION': 'forged-session',
    'x-dnaforge-session': 'forged-session-duplicate',
    'X-DNAForge-Operation-Authority': 'forged-operation',
    'x-dnaforge-native-document-authority': 'forged-native',
    Accept: 'application/json',
  };

  function harness() {
    const authority = new SidecarSessionAuthority({
      initialToken: 'session-sentinel',
      initialHumanOperationToken: 'operation-sentinel',
    });
    authority.markReady(authority.snapshot().generation);
    let trustedId: number | null = 7;
    let baseUrl = SIDECAR;
    const reads: string[] = [];
    const errors: unknown[] = [];
    let read = async (): Promise<string | null> => 'nonfunctional-sentinel';
    const frame = { url: 'file:///app/index.html' };
    const owner = { webContents: { id: 7, mainFrame: frame }, frame };
    const handler = createSidecarRequestHeaderHandler({
      isTrustedOwner: (details) => isTrustedSidecarRequestOwner(details, trustedId, frame.url),
      getSidecarBaseUrl: () => baseUrl,
      authority,
      readCredential: async (id) => {
        reads.push(id);
        return read();
      },
      onError: (error) => errors.push(error),
    });
    const request = (
      url = `${SIDECAR}/compute/tamarind/status`,
      headers: SidecarRequestHeaders = protectedHeaders,
      requestOwner: SidecarRequestOwner = owner
    ) =>
      new Promise<Parameters<Parameters<typeof handler>[1]>[0]>((resolve) =>
        handler({ url, requestHeaders: headers, ...requestOwner }, resolve)
      );
    return {
      authority,
      reads,
      errors,
      request,
      setRead: (next: typeof read) => {
        read = next;
      },
      setOwner: (id: number | null) => {
        trustedId = id;
      },
      setBase: (url: string) => {
        baseUrl = url;
      },
    };
  }

  it.each([
    'https://foreign.example/compute/tamarind/status',
    'http://foreign.example/compute/tamarind/status',
    'http://127.0.0.1:9999/compute/tamarind/status',
    'http://localhost:8765/compute/tamarind/status',
    'http://[::1]:8765/compute/tamarind/status',
    'https://127.0.0.1:8765/compute/tamarind/status',
    'ftp://127.0.0.1:8765/compute/tamarind/status',
    'http://user:password@127.0.0.1:8765/compute/tamarind/status',
    'not a url',
  ])('scrubs every protected header and performs zero lookups for %s', async (url) => {
    const h = harness();
    expect(await h.request(url)).toEqual({ requestHeaders: { Accept: 'application/json' } });
    expect(h.reads).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it.each([
    {},
    { webContentsId: 8 },
    { webContentsId: 7, webContents: { id: 8 } },
    { webContentsId: 8, webContents: { id: 7 } },
  ])('scrubs untrusted or conflicting owner %j before lookup', async (owner) => {
    const h = harness();
    expect(await h.request(undefined, undefined, owner)).toEqual({
      requestHeaders: { Accept: 'application/json' },
    });
    expect(h.reads).toEqual([]);
  });

  it.each([
    'http://foreign.example',
    'https://127.0.0.1:8765',
    'http://user@127.0.0.1:8765',
    'broken',
  ])('refuses invalid configured sidecar %s', async (base) => {
    const h = harness();
    h.setBase(base);
    expect(await h.request()).toEqual({ requestHeaders: { Accept: 'application/json' } });
    expect(h.reads).toEqual([]);
  });

  it.each(['tamarind/status', 'subseq/submit', 'nvidia-nim/tools', 'tamarind/verify/'])(
    'preserves authorized compute route %s and object-only owner',
    async (route) => {
      const h = harness();
      expect(await h.request(`${SIDECAR}/compute/${route}`)).toEqual({
        requestHeaders: {
          Accept: 'application/json',
          'X-DNAForge-Session': 'session-sentinel',
          [COMPUTE_CREDENTIAL_HEADER]: 'nonfunctional-sentinel',
        },
      });
      expect(h.reads).toEqual([route.split('/')[0]]);
    }
  );

  it.each([
    '/operations',
    '/operations/job',
    '/external/credential-broker/key',
    '/toolbox/retry/annotation',
  ])('preserves current human authority for %s without compute lookup', async (path) => {
    const h = harness();
    expect(await h.request(`${SIDECAR}${path}`)).toEqual({
      requestHeaders: {
        Accept: 'application/json',
        'X-DNAForge-Session': 'session-sentinel',
        'X-DNAForge-Operation-Authority': 'operation-sentinel',
      },
    });
    expect(h.reads).toEqual([]);
  });

  it('never gives renderer requests native document authority', async () => {
    const h = harness();
    expect(await h.request(`${SIDECAR}/internal/managed-documents/write`)).toEqual({
      requestHeaders: { Accept: 'application/json', 'X-DNAForge-Session': 'session-sentinel' },
    });
    expect(h.reads).toEqual([]);
  });

  it.each(['/compute/tamarind/status', '/image.png'])(
    'scrubs already minted credentials on a foreign redirect to %s',
    async (path) => {
      const h = harness();
      const first = await h.request();
      expect('requestHeaders' in first).toBe(true);
      if (!('requestHeaders' in first)) throw new Error('Expected admitted first hop');
      expect(await h.request(`http://127.0.0.1:9999${path}`, first.requestHeaders)).toEqual({
        requestHeaders: { Accept: 'application/json' },
      });
      expect(h.reads).toEqual(['tamarind']);
    }
  );

  it.each(['restart', 'ready-new-generation', 'owner', 'destination', 'stopped'])(
    'cancels after delayed key lookup loses %s authority',
    async (change) => {
      const h = harness();
      let release: (value: string) => void = () => undefined;
      let entered: () => void = () => undefined;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      h.setRead(() => {
        entered();
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      });
      const pending = h.request();
      await reading;
      if (change === 'restart') h.authority.markRestarting();
      if (change === 'ready-new-generation') {
        const next = h.authority.prepareManagedSpawn('respawn');
        h.authority.markReady(next.generation);
      }
      if (change === 'stopped') h.authority.markStopped();
      if (change === 'owner') h.setOwner(8);
      if (change === 'destination') h.setBase('http://127.0.0.1:9999');
      release('nonfunctional-sentinel');
      expect(await pending).toEqual({ cancel: true });
      expect(h.reads).toEqual(['tamarind']);
      expect(h.errors).toHaveLength(1);
    }
  );

  it('rechecks owner after waiting for readiness before reading a key', async () => {
    const h = harness();
    h.authority.markRestarting();
    const pending = h.request();
    h.setOwner(null);
    h.authority.markReady(h.authority.snapshot().generation);
    expect(await pending).toEqual({ cancel: true });
    expect(h.reads).toEqual([]);
  });

  it('cancels failed key reads once without fallback or replay', async () => {
    const h = harness();
    h.setRead(async () => {
      throw new Error('synthetic key read refusal');
    });
    expect(await h.request()).toEqual({ cancel: true });
    expect(h.reads).toEqual(['tamarind']);
    expect(h.errors).toHaveLength(1);
  });

  it('preserves missing-key behavior after current authority succeeds', async () => {
    const h = harness();
    h.setRead(async () => null);
    expect(await h.request()).toEqual({
      requestHeaders: { Accept: 'application/json', 'X-DNAForge-Session': 'session-sentinel' },
    });
  });
});
