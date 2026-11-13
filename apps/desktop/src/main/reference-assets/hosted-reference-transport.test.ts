import { describe, expect, it, vi } from 'vitest';

import {
  requestHostedReferenceAsset,
  resolveHostedReferenceAssetUrl,
} from './hosted-reference-transport';

describe('hosted reference transport', () => {
  it('reserves a shared download slot before starting network transfer', async () => {
    let releaseFirstReservation!: () => void;
    let reservationCount = 0;
    const bodyReadGate = {
      reserve: vi.fn(async () => {
        reservationCount += 1;
        if (reservationCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstReservation = resolve;
          });
        }
      }),
    };
    const fetchAsset = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const pending = requestHostedReferenceAsset({
      url: new URL('https://assets.example.test/reference-genomes/v1/object'),
      label: 'test object',
      fetchAsset,
      bodyReadGate,
      signal: new AbortController().signal,
    });

    await Promise.resolve();
    expect(bodyReadGate.reserve).toHaveBeenCalledWith(65_536, expect.any(AbortSignal));
    expect(fetchAsset).not.toHaveBeenCalled();

    releaseFirstReservation();
    const response = await pending;
    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 3);
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it('never starts network transfer when the shared download gate fails closed', async () => {
    const fetchAsset = vi.fn();
    await expect(
      requestHostedReferenceAsset({
        url: new URL('https://assets.example.test/reference-genomes/v1/object'),
        label: 'test object',
        fetchAsset,
        bodyReadGate: {
          reserve: async () => {
            throw new Error('shared limiter unavailable');
          },
        },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('shared limiter unavailable');
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it('adds a resumable range without dropping caller headers', async () => {
    let observedHeaders: RequestInit['headers'] = undefined;
    const response = await requestHostedReferenceAsset({
      url: new URL('https://assets.example.test/reference-genomes/v1/object'),
      label: 'test object',
      fetchAsset: async (_input, init) => {
        observedHeaders = init?.headers;
        return new Response(new Uint8Array([5]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 4-4/5' },
        });
      },
      headers: new Headers({ Authorization: 'Bearer test-token' }),
      rangeStart: 4,
      signal: new AbortController().signal,
    });

    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 1);
    expect(observedHeaders).toEqual({ authorization: 'Bearer test-token', Range: 'bytes=4-' });
  });

  it('bounds oversized source chunks to bytes reserved before each read', async () => {
    const reservationReleases: Array<() => void> = [];
    const payloadByteLength = 100_000;
    const bodyReadGate = {
      reserve: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            reservationReleases.push(resolve);
          })
      ),
    };
    const payload = new Uint8Array(payloadByteLength);
    const pendingResponse = requestHostedReferenceAsset({
      url: new URL('https://assets.example.test/reference-genomes/v1/object'),
      label: 'test object',
      fetchAsset: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            type: 'bytes',
            start(controller) {
              controller.enqueue(payload);
            },
          })
        ),
      bodyReadGate,
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(reservationReleases).toHaveLength(1));
    reservationReleases.shift()!();
    const response = await pendingResponse;
    const reader = response.body!.getReader();
    const firstRead = reader.read();
    const first = await firstRead;
    expect(first.done).toBe(false);
    expect(first.value).toHaveProperty('byteLength', 65_536);

    const secondRead = reader.read();

    await vi.waitFor(() => expect(reservationReleases).toHaveLength(1));
    expect(bodyReadGate.reserve).toHaveBeenNthCalledWith(2, 65_536, expect.any(AbortSignal));
    let delivered = false;
    void secondRead.then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);

    reservationReleases.shift()!();
    const second = await secondRead;
    expect(second.done).toBe(false);
    expect(second.value).toHaveProperty('byteLength', payloadByteLength - 65_536);
    await reader.cancel();
  });

  it('carries unused reservation credit across small stream chunks', async () => {
    const bodyReadGate = { reserve: vi.fn(async () => undefined) };
    const response = await requestHostedReferenceAsset({
      url: new URL('https://assets.example.test/reference-genomes/v1/object'),
      label: 'test object',
      fetchAsset: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            type: 'bytes',
            start(controller) {
              controller.enqueue(new Uint8Array(10));
              controller.enqueue(new Uint8Array(20));
              controller.close();
            },
          })
        ),
      bodyReadGate,
      signal: new AbortController().signal,
    });

    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 30);
    expect(bodyReadGate.reserve).toHaveBeenCalledOnce();
    expect(bodyReadGate.reserve).toHaveBeenCalledWith(65_536, expect.any(AbortSignal));
  });

  it('rejects literal and percent-encoded backslash path separators', () => {
    const baseUrl = new URL('https://assets.example.test/reference-genomes/v1/');

    expect(() => resolveHostedReferenceAssetUrl(baseUrl, 'objects\\escape')).toThrow(
      'must be relative'
    );
    expect(() => resolveHostedReferenceAssetUrl(baseUrl, 'objects%5Cescape')).toThrow(
      'unsafe segment'
    );
  });

  it('terminates a request that does not return response headers', async () => {
    vi.useFakeTimers();
    try {
      const fetchAsset = vi.fn(
        async (_input: string | URL, init?: RequestInit): Promise<Response> =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new Error('aborted')),
              { once: true }
            );
          })
      );
      const request = requestHostedReferenceAsset({
        url: new URL('https://assets.example.test/reference-genomes/v1/object'),
        label: 'test object',
        fetchAsset,
        signal: new AbortController().signal,
        responseHeaderTimeoutMs: 100,
      });
      const rejected = expect(request).rejects.toThrow(
        'response headers exceeded the 100 ms timeout'
      );

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a response body that stops making network progress', async () => {
    vi.useFakeTimers();
    try {
      const fetchAsset = vi.fn(async () => {
        let emitted = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (emitted) return;
              emitted = true;
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
          })
        );
      });
      const response = await requestHostedReferenceAsset({
        url: new URL('https://assets.example.test/reference-genomes/v1/object'),
        label: 'test object',
        fetchAsset,
        signal: new AbortController().signal,
        stallTimeoutMs: 100,
      });
      const reader = response.body!.getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: new Uint8Array([1, 2, 3]),
      });
      const stalledRead = reader.read();
      const rejected = expect(stalledRead).rejects.toThrow('no network progress for 100 ms');

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a body to outlive the header timeout while chunks keep resetting the idle timer', async () => {
    vi.useFakeTimers();
    try {
      const fetchAsset = vi.fn(async () => {
        let emitted = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              if (emitted === 4) {
                controller.close();
                return;
              }
              emitted += 1;
              controller.enqueue(new Uint8Array([1]));
            },
          })
        );
      });
      const callerController = new AbortController();
      const removeAbortListener = vi.spyOn(callerController.signal, 'removeEventListener');
      const response = await requestHostedReferenceAsset({
        url: new URL('https://assets.example.test/reference-genomes/v1/object'),
        label: 'test object',
        fetchAsset,
        signal: callerController.signal,
        stallTimeoutMs: 75,
        responseHeaderTimeoutMs: 25,
      });
      const body = response.arrayBuffer();

      await vi.advanceTimersByTimeAsync(250);
      await expect(body).resolves.toHaveProperty('byteLength', 4);
      expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([408, 425, 429, 500, 502, 503, 504])(
    'classifies HTTP %i as retryable while ordinary client failures remain terminal',
    async (status) => {
      const request = {
        url: new URL('https://assets.example.test/reference-genomes/v1/object'),
        label: 'test object',
        signal: new AbortController().signal,
      } as const;

      await expect(
        requestHostedReferenceAsset({
          ...request,
          fetchAsset: async () => new Response(null, { status }),
        })
      ).rejects.toMatchObject({
        kind: 'transport',
        responseStatus: status,
        retryable: true,
      });
      await expect(
        requestHostedReferenceAsset({
          ...request,
          fetchAsset: async () => new Response(null, { status: 404 }),
        })
      ).resolves.toMatchObject({ status: 404 });
    }
  );

  it('preserves AbortError as a terminal cancellation classification', async () => {
    await expect(
      requestHostedReferenceAsset({
        url: new URL('https://assets.example.test/reference-genomes/v1/object'),
        label: 'test object',
        signal: new AbortController().signal,
        fetchAsset: async () => {
          throw new DOMException('cancelled', 'AbortError');
        },
      })
    ).rejects.toMatchObject({
      kind: 'abort',
      responseStatus: null,
      retryable: false,
    });
  });
});
