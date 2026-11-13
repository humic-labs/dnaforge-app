import { describe, it, expect, vi } from 'vitest';
import type { AssemblySegment } from '../../assembly-layout';
import { tileKeyString, type TileData } from '../tile-source';
import { BaseTileSource, type TileSourceShape } from './base-tile-source';
import type { TileTransport, TileTransportRequest, TileTransportResponse } from './tile-transport';

function seg(chrom = 'chr11'): AssemblySegment {
  return {
    chrom,
    localStart: 0,
    localEnd: 1024,
    globalStart: 0,
    placement: {
      chromosome: { id: chrom, displayName: chrom, length: 1_000_000, cytobands: [] },
      globalStartBp: 0,
      globalEndBp: 1_000_000,
      order: 0,
    },
  } as AssemblySegment;
}

function shape(overrides: Partial<TileSourceShape> = {}): TileSourceShape {
  return {
    id: 'test:src',
    kind: 'coverage',
    levelRange: [0, 22],
    buildBody: (level, index, segments) => ({
      bamPath: '/x.bam',
      chrom: segments[0]?.chrom ?? '?',
      level,
      index,
    }),
    countOf: (payload) => Number((payload as { count?: number })?.count ?? 0),
    byteSizeOf: (payload) => Number((payload as { byteSize?: number })?.byteSize ?? 0),
    ...overrides,
  };
}

function okTransport(response: TileTransportResponse, log?: TileTransportRequest[]): TileTransport {
  return async (req) => {
    log?.push(req);
    return response;
  };
}

const ok = (body: unknown): TileTransportResponse => ({ ok: true, status: 200, body });
const status = (code: number, body: unknown = {}): TileTransportResponse => ({
  ok: false,
  status: code,
  body,
});

describe('BaseTileSource — (a) 200 payload → ready TileData', () => {
  it('maps a 200 route payload to a ready tile with count+byteSize from the shape', async () => {
    const src = new BaseTileSource(shape(), {
      transport: okTransport(ok({ count: 7, byteSize: 4096, bins: [1, 2, 3] })),
    });
    const data = await src.fetchTile(3, 9, [seg()], new AbortController().signal);
    expect(data.state).toBe('ready');
    expect(data.count).toBe(7);
    expect(data.byteSize).toBe(4096);
    expect(data.errorReason).toBeUndefined();
    expect(tileKeyString(data.key)).toBe('test:src:3:9');
    expect((data.payload as { bins: number[] }).bins).toEqual([1, 2, 3]);
  });

  it('builds the route body from the tile coordinate + segment chrom', async () => {
    const log: TileTransportRequest[] = [];
    const src = new BaseTileSource(shape(), {
      transport: okTransport(ok({ count: 1, byteSize: 10 }), log),
    });
    await src.fetchTile(5, 42, [seg('chr7')], new AbortController().signal);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe('coverage');
    expect(log[0].level).toBe(5);
    expect(log[0].tileIndex).toBe(42);
    expect(log[0].body).toMatchObject({ chrom: 'chr7', bamPath: '/x.bam' });
  });
});

describe('BaseTileSource — (b) non-2xx → error TileData', () => {
  it('404 with a detail → error tile carrying the detail (NOT count:0 ready)', async () => {
    const src = new BaseTileSource(shape(), {
      transport: okTransport(status(404, { detail: 'index-missing: .crai not found' })),
    });
    const data = await src.fetchTile(0, 5103, [seg()], new AbortController().signal);
    expect(data.state).toBe('error');
    expect(data.count).toBe(0);
    expect(data.errorReason).toContain('index-missing');
    expect(data.state).not.toBe('ready');
  });

  it('404 missing-CRAM-reference (bug #3) → error, not a blank ready tile', async () => {
    const src = new BaseTileSource(shape({ kind: 'alignment' }), {
      transport: okTransport(
        status(404, {
          detail: 'CRAM chr11 needs a reference FASTA to decode any slice',
        })
      ),
    });
    const data = await src.fetchTile(0, 5103, [seg()], new AbortController().signal);
    expect(data.state).toBe('error');
    expect(data.errorReason).toContain('reference');
  });

  it('429 queue-full → error tile (defined back-off shadow, not a hang/empty)', async () => {
    const src = new BaseTileSource(shape(), {
      transport: okTransport(status(429, { error: 'queue_full', refusal_kind: 'saturated' })),
    });
    const data = await src.fetchTile(2, 0, [seg()], new AbortController().signal);
    expect(data.state).toBe('error');
    expect(data.errorReason).toBe('queue-full');
  });

  it('generic 5xx → error tile (http-<status>)', async () => {
    const src = new BaseTileSource(shape(), { transport: okTransport(status(503, null)) });
    const data = await src.fetchTile(2, 0, [seg()], new AbortController().signal);
    expect(data.state).toBe('error');
    expect(data.errorReason).toBe('http-503');
  });
});

describe('BaseTileSource — retryable readiness responses', () => {
  it('425 not-ready retries until a real tile arrives instead of resolving an error tile', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const transport: TileTransport = async () => {
        attempts += 1;
        if (attempts === 1) {
          return status(425, { detail: 'coverage pyramid is not ready yet' });
        }
        return ok({ count: 5, byteSize: 512, bins: [1, 2, 3] });
      };
      const src = new BaseTileSource(shape(), { transport, timeoutMs: 5_000 });

      const p = src.fetchTile(0, 0, [seg()], new AbortController().signal);
      await vi.advanceTimersByTimeAsync(300);
      const data = await p;

      expect(attempts).toBe(2);
      expect(data.state).toBe('ready');
      expect(data.count).toBe(5);
      expect(data.errorReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs persistent 425 readiness probes off exponentially and remains abortable', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const transport: TileTransport = async () => {
        attempts += 1;
        return status(425, { detail: 'coverage pyramid is not ready yet' });
      };
      const controller = new AbortController();
      const src = new BaseTileSource(shape(), { transport, timeoutMs: 30_000 });
      const settled = expect(src.fetchTile(0, 0, [seg()], controller.signal)).rejects.toMatchObject(
        { name: 'AbortError' }
      );

      await vi.advanceTimersByTimeAsync(249);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toBe(3);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(4);

      controller.abort();
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BaseTileSource — (c) abort rejects + drops a late response', () => {
  it('already-aborted signal → rejects before touching the transport', async () => {
    const transport = vi.fn<TileTransport>(async () => ok({ count: 1, byteSize: 1 }));
    const src = new BaseTileSource(shape(), { transport });
    const ac = new AbortController();
    ac.abort();
    await expect(src.fetchTile(0, 0, [seg()], ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('abort WHILE in-flight → rejects AND the late 200 response is DROPPED (no resolve)', async () => {
    let releaseLate!: (r: TileTransportResponse) => void;
    const transport: TileTransport = (_req, signal) =>
      new Promise<TileTransportResponse>((resolve, reject) => {
        releaseLate = resolve;
        signal.addEventListener('abort', () => {});
        void reject;
      });

    const src = new BaseTileSource(shape(), { transport });
    const ac = new AbortController();
    const p = src.fetchTile(0, 0, [seg()], ac.signal);

    ac.abort();
    releaseLate(ok({ count: 99, byteSize: 9999 }));

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });

    let fulfilled: TileData | undefined;
    await p.then(
      (d) => (fulfilled = d),
      () => undefined
    );
    expect(fulfilled).toBeUndefined();
  });

  it('transport that rejects on abort → fetch rejects (no swallowed resolution)', async () => {
    const transport: TileTransport = (_req, signal) =>
      new Promise<TileTransportResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const src = new BaseTileSource(shape(), { transport });
    const ac = new AbortController();
    const p = src.fetchTile(0, 0, [seg()], ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('BaseTileSource — (d) valid empty count:0 → ready (NOT error)', () => {
  it('a 200 tile with zero records is a READY empty tile, semantically not an error', async () => {
    const src = new BaseTileSource(shape(), {
      transport: okTransport(ok({ count: 0, byteSize: 128, bins: [] })),
    });
    const data = await src.fetchTile(8, 0, [seg()], new AbortController().signal);
    expect(data.state).toBe('ready');
    expect(data.count).toBe(0);
    expect(data.byteSize).toBe(128);
    expect(data.errorReason).toBeUndefined();
    expect(data.state).not.toBe('error');
  });
});

describe('BaseTileSource — per-route soft timeout → error TileData', () => {
  it('cancels expired transport work without aborting the caller or a sibling tile', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const completions: Array<(response: TileTransportResponse) => void> = [];
      const transport: TileTransport = (_req, signal) => {
        signals.push(signal);
        return new Promise((resolve) => completions.push(resolve));
      };
      const caller = new AbortController();
      const src = new BaseTileSource(shape(), { transport, timeoutMs: 50 });
      const expired = src.fetchTile(0, 0, [seg()], caller.signal);
      await vi.advanceTimersByTimeAsync(30);
      const sibling = src.fetchTile(0, 1, [seg()], caller.signal);
      await vi.advanceTimersByTimeAsync(20);

      expect(await expired).toMatchObject({ state: 'error', errorReason: 'timeout' });
      expect(signals[0]?.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      expect(signals[1]?.aborted).toBe(false);

      completions[0]?.(ok({ count: 99, byteSize: 990 }));
      completions[1]?.(ok({ count: 3, byteSize: 30 }));
      expect(await sibling).toMatchObject({ state: 'ready', count: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a transport that never resolves within timeoutMs → error tile (not pending forever)', async () => {
    vi.useFakeTimers();
    try {
      const transport: TileTransport = () => new Promise<TileTransportResponse>(() => undefined);
      const src = new BaseTileSource(shape(), { transport, timeoutMs: 50 });
      const p = src.fetchTile(0, 0, [seg()], new AbortController().signal);
      await vi.advanceTimersByTimeAsync(60);
      const data = await p;
      expect(data.state).toBe('error');
      expect(data.errorReason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a response that arrives BEFORE the timeout still wins (timeout does not pre-empt)', async () => {
    vi.useFakeTimers();
    try {
      const transport: TileTransport = () =>
        new Promise<TileTransportResponse>((resolve) =>
          setTimeout(() => resolve(ok({ count: 3, byteSize: 30 })), 10)
        );
      const src = new BaseTileSource(shape(), { transport, timeoutMs: 1000 });
      const p = src.fetchTile(0, 0, [seg()], new AbortController().signal);
      await vi.advanceTimersByTimeAsync(20);
      const data = await p;
      expect(data.state).toBe('ready');
      expect(data.count).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
