// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sidecarNebTm } from './neb-tm-client';

const { sidecarFetchMock, resolveSidecarBaseUrlMock } = vi.hoisted(() => ({
  sidecarFetchMock: vi.fn((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
  resolveSidecarBaseUrlMock: vi.fn(async () => 'http://sidecar.test.invalid'),
}));

vi.mock('../../../services/sidecar-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/sidecar-session')>();
  return {
    ...actual,
    resolveSidecarBaseUrl: resolveSidecarBaseUrlMock,
    sidecarFetch: sidecarFetchMock,
  };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('sidecarNebTm', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    sidecarFetchMock.mockClear();
    resolveSidecarBaseUrlMock.mockClear();
  });

  it('passes the caller abort signal to the real sidecar fetch', async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      async (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          const rejectAbort = () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          };
          if (requestSignal?.aborted) rejectAbort();
          else requestSignal?.addEventListener('abort', rejectAbort, { once: true });
        })
    );
    const controller = new AbortController();
    const pending = sidecarNebTm(
      { seq1: 'ATCGATCGATCGATCGATCG', prodcode: 'q5-0', concNm: 500 },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(requestSignal).toBe(controller.signal));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });
});
