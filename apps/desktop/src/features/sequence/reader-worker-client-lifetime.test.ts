// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BbiReaderWorkerClient } from './bbi-reader-worker-client';
import { TextIntervalReaderWorkerClient } from './text-interval-reader-worker-client';
import type { BbiReaderWorkerLike } from './bbi-reader-worker-protocol';
import type { TextIntervalReaderWorkerLike } from './text-interval-reader-worker-protocol';

function fixture(kind: 'bbi' | 'text') {
  const worker = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  const client =
    kind === 'bbi'
      ? new BbiReaderWorkerClient(worker as BbiReaderWorkerLike)
      : new TextIntervalReaderWorkerClient(worker as TextIntervalReaderWorkerLike);
  const query = (signal?: AbortSignal) =>
    client instanceof BbiReaderWorkerClient
      ? client.queryIntervals('fixture-source', [{ refName: 'chr1', start: 10, end: 20 }], signal)
      : client.query(
          'fixture-source',
          [{ refName: 'chr1', start: 10, end: 20 }],
          { maxRecords: 100, maxOverlap: 10, densityBinCount: 16 },
          signal
        );
  return { worker, client, query };
}

for (const kind of ['bbi', 'text'] as const)
  describe(`${kind} worker request lifetime`, () => {
    it('rejects work after disposal and terminates the owned worker once', async () => {
      const { client, worker, query } = fixture(kind);
      client.dispose();
      let failure: unknown;
      void query().catch((error) => {
        failure = error;
      });
      await Promise.resolve();
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/disposed/i);
      expect(worker.postMessage).not.toHaveBeenCalled();
      client.dispose();
      expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it('removes abort ownership when request transport throws and rejects later work', async () => {
      const { client, worker, query } = fixture(kind);
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      worker.postMessage.mockImplementation(() => {
        throw new Error('transport failed');
      });
      await expect(query(controller.signal)).rejects.toThrow('transport failed');
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      await expect(query()).rejects.toThrow('transport failed');
      expect(worker.postMessage).toHaveBeenCalledOnce();
      client.dispose();
    });

    it('settles cancellation even when sending the cancellation fails', async () => {
      const { client, worker, query } = fixture(kind);
      const controller = new AbortController();
      const pending = query(controller.signal).catch((error: Error) => error);
      worker.postMessage.mockImplementation(() => {
        throw new Error('cancel transport failed');
      });
      let settled: unknown;
      void pending.then((result) => {
        settled = result;
      });
      const listener = worker.addEventListener.mock.calls.find(([type]) => type === 'error');
      expect(listener).toBeDefined();
      controller.abort();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toMatchObject({ name: 'AbortError' });
      client.dispose();
    });
  });
