import { httpTileTransport, type TileTransport } from '@waypoint/genome-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  releaseRemoteTileSessionWhenDrained,
  trackRemoteTileSessionTransport,
} from './remote-tile-session-drain';

afterEach(() => {
  vi.useRealTimers();
});

describe('remote tile session drain', () => {
  it('does not start an HTTP job when the viewport already cancelled it', async () => {
    vi.useFakeTimers();
    const raw = vi.fn().mockResolvedValue({ ok: true, status: 200, body: {} });
    const viewport = new AbortController();
    viewport.abort();
    await expect(
      trackRemoteTileSessionTransport('session-cancelled-before-start', raw)(
        { kind: 'alignment', level: 0, tileIndex: 1, body: {} },
        viewport.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(raw).not.toHaveBeenCalled();
    const release = vi.fn();
    releaseRemoteTileSessionWhenDrained('session-cancelled-before-start', release);
    await vi.runAllTimersAsync();
    expect(release).toHaveBeenCalledOnce();
  });

  it('lets noncancellable coverage finish after its viewport cancels', async () => {
    vi.useFakeTimers();
    let finishResponse!: (response: Response) => void;
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('The HTTP transport must supply a signal.');
        const onAbort = () => reject(new DOMException('Request aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        finishResponse = (response) => {
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        };
      });
    const tracked = trackRemoteTileSessionTransport(
      'session-close-during-decode',
      httpTileTransport({ baseUrl: 'http://127.0.0.1:8000', fetchImpl })
    );
    const viewport = new AbortController();
    const outcome = tracked(
      { kind: 'coverage-assembly', level: 6, tileIndex: 1, body: {} },
      viewport.signal
    ).then(
      () => 'completed',
      () => 'aborted'
    );
    viewport.abort();
    const release = vi.fn();
    releaseRemoteTileSessionWhenDrained('session-close-during-decode', release);
    await vi.runAllTimersAsync();
    expect(release).not.toHaveBeenCalled();

    finishResponse(new Response(JSON.stringify({ reads: [] }), { status: 200 }));
    expect(await outcome).toBe('completed');
    await vi.runAllTimersAsync();
    expect(release).toHaveBeenCalledOnce();
  });

  it('forwards active alignment cancellation and releases only after the raw request settles', async () => {
    vi.useFakeTimers();
    let rawSignal: AbortSignal | null = null;
    let rejectRaw!: (reason: unknown) => void;
    const tracked = trackRemoteTileSessionTransport(
      'session-cancel-native-alignment',
      (_request, signal) => {
        rawSignal = signal;
        return new Promise((_resolve, reject) => {
          rejectRaw = reject;
        });
      }
    );
    const viewport = new AbortController();
    const outcome = tracked(
      { kind: 'alignment', level: 0, tileIndex: 1, body: {} },
      viewport.signal
    ).catch((error: Error) => error.name);
    viewport.abort();
    expect(rawSignal!.aborted).toBe(true);
    const release = vi.fn();
    releaseRemoteTileSessionWhenDrained('session-cancel-native-alignment', release);
    await vi.runAllTimersAsync();
    expect(release).not.toHaveBeenCalled();
    rejectRaw(new DOMException('Request cancelled', 'AbortError'));
    expect(await outcome).toBe('AbortError');
    await vi.runAllTimersAsync();
    expect(release).toHaveBeenCalledOnce();
  });

  it('holds session release until every started raw tile request settles', async () => {
    vi.useFakeTimers();
    const settlements: Array<(value: Awaited<ReturnType<TileTransport>>) => void> = [];
    const raw: TileTransport = () =>
      new Promise((resolve) => {
        settlements.push(resolve);
      });
    const tracked = trackRemoteTileSessionTransport('session-drain', raw);
    const request = tracked(
      {
        kind: 'alignment',
        level: 0,
        tileIndex: 1,
        body: {},
      },
      new AbortController().signal
    );
    const release = vi.fn();

    releaseRemoteTileSessionWhenDrained('session-drain', release);
    await vi.runAllTimersAsync();
    expect(release).not.toHaveBeenCalled();

    settlements[0]?.({ ok: true, status: 200, body: {} });
    await request;
    await vi.runAllTimersAsync();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses a task boundary before releasing a session with no started requests', async () => {
    vi.useFakeTimers();
    const release = vi.fn();

    releaseRemoteTileSessionWhenDrained('session-empty', release);
    expect(release).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
