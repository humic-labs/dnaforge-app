// @vitest-environment node

import { afterEach, expect, it, vi } from 'vitest';
import type { BbiReaderWorkerRequest } from './bbi-reader-worker-protocol';

vi.mock('@gmod/bbi', () => {
  class Reader {
    constructor(
      private readonly input: { filehandle: { read(length: number): Promise<unknown> } }
    ) {}
    async getHeader() {
      await this.input.filehandle.read(4);
      return {
        fileType: 'bigwig',
        refsByNumber: {},
        zoomLevels: [],
        totalSummary: { basesCovered: 0, scoreMin: 0, scoreMax: 0 },
      };
    }
  }
  return { BigWig: Reader, BigBed: Reader };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('keeps website authentication and its source grant on a real range-file read', async () => {
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-3/1024' },
      })
  );
  const postMessage = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('postMessage', postMessage);
  vi.stubGlobal('onmessage', null);
  await import('./bbi-reader-worker');
  const onmessage: (event: MessageEvent<BbiReaderWorkerRequest>) => void =
    globalThis.onmessage ??
    (() => {
      throw new Error('Worker handler was not installed');
    });
  onmessage(
    new MessageEvent<BbiReaderWorkerRequest>('message', {
      data: {
        id: 1,
        type: 'open',
        sourceKey: 'fixture',
        format: 'bigwig',
        grant: {
          baseUrl: 'https://staging.dnaforge.com/api',
          sourceUri: 'https://hgdownload.soe.ucsc.edu/fixture.bw',
          sourceToken: 'opaque-fixture-grant',
          canonicalUrlHash: 'a'.repeat(64),
          byteLength: 1024,
          provenanceId: 'fixture',
          expiresAtMs: Date.now() + 60_000,
          maxRangeBytes: 4_000_000,
        },
      },
    })
  );

  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 1, type: 'result' }))
  );
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://staging.dnaforge.com/api/external/range');
  expect(init?.credentials).toBe('same-origin');
  expect(new Headers(init?.headers).get('X-DNAForge-Source-Token')).toBe('opaque-fixture-grant');
  expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-3');
});
