import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceManager } from './service-manager';
import { sidecarFetchRcsbMetadata } from '../features/structure-drawer/api/sidecar-client';
import { validateRcsbId } from '../features/page/embeds/structure3d/api/structure-service-client';
import { sidecarFetchSequenceBytes } from '../features/ai/tools/sidecar-client';
import { onHostedKeepWorkRequest, setHostedDemoSession } from '../hosted/capabilities';

const SIDECAR = 'http://127.0.0.1:8765';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('external lookup routing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    serviceManager.setBaseUrl(SIDECAR);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    setHostedDemoSession(false);
    delete document.documentElement.dataset.dnaforgeRuntime;
    vi.unstubAllGlobals();
  });

  it('keeps desktop lookups on the sidecar', async () => {
    fetchMock.mockResolvedValue(json({ valid: false }));
    expect(serviceManager.getExternalLookupBaseUrl()).toBe(SIDECAR);
    await validateRcsbId('1EMA');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${SIDECAR}/external/rcsb/validate`);
  });

  it('sends hosted-browser lookups to the website routes', async () => {
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    fetchMock.mockResolvedValueOnce(json({ valid: true, pdb_id: '1EMA', metadata: {} }));
    fetchMock.mockResolvedValueOnce(
      json({
        provider: 'ncbi-nuccore',
        external_id: 'L09137.2',
        format: 'genbank',
        content: 'LOCUS       L09137',
        content_sha256: 'a'.repeat(64),
        metadata: {},
      })
    );

    await validateRcsbId('1EMA');
    await sidecarFetchSequenceBytes({ externalId: 'L09137.2' });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${window.location.origin}/api/external/rcsb/validate`,
      `${window.location.origin}/api/external/sequence/bytes`,
    ]);
  });

  it('reports a rate-limited lookup as a failure instead of no result', async () => {
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    fetchMock.mockResolvedValue(json({ detail: { error: 'rate_limited' } }, 429));

    await expect(
      sidecarFetchRcsbMetadata('1EMA', new AbortController().signal)
    ).rejects.toMatchObject({ name: 'SidecarProviderError' });
    await expect(validateRcsbId('1EMA')).rejects.toMatchObject({ name: 'SidecarProviderError' });
  });

  it('asks demo visitors to sign up instead of sending a lookup', async () => {
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    setHostedDemoSession(true);
    const keepWork = vi.fn();
    const stop = onHostedKeepWorkRequest(keepWork);
    try {
      await expect(validateRcsbId('1EMA')).rejects.toMatchObject({
        name: 'HostedSignUpRequiredError',
        message: 'Sign up to search',
      });
      expect(keepWork).toHaveBeenCalledWith('Sign up to search');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
