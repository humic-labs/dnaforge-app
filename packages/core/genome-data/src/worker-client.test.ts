import { describe, expect, it } from 'vitest';

import { GenomeDataWorkerClient } from './worker-client';
import type { GenomeDataWorkerRequest, GenomeDataWorkerResponse } from './worker-protocol';

describe('GenomeDataWorkerClient', () => {
  it('resolves request/response calls and streams search hits', async () => {
    const worker = new FakeWorker();
    const client = new GenomeDataWorkerClient(worker);

    await expect(
      client.init({ chrom: 'chrI', fastaPath: 'chrI.fa', faiPath: 'chrI.fa.fai' })
    ).resolves.toBeUndefined();
    await expect(client.getChromosomeLength('chrI')).resolves.toBe(50_000);
    await expect(client.getSequence('chrI', 1, 4)).resolves.toBe('CGT');
    await expect(client.getFeatures('chrI', 1, 4, 1)).resolves.toEqual([
      expect.objectContaining({ chrom: 'chrI', start: 1, end: 4 }),
    ]);
    await expect(
      client.getFeatureDetails({
        chrom: 'chrI',
        start: 1,
        end: 4,
        featureId: 'feature-1',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        chrom: 'chrI',
        featureId: 'feature-1',
        relatedFeatures: [expect.objectContaining({ chrom: 'chrI', start: 1, end: 4 })],
      })
    );

    const hits = [];
    for await (const hit of client.searchSequence('chrI', 'CGT')) {
      hits.push(hit);
    }

    expect(hits).toEqual([{ chrom: 'chrI', start: 1, end: 4, strand: 'forward', motif: 'CGT' }]);
  });

  it('rejects pending search iteration when the worker reports an error', async () => {
    const worker = new FakeWorker({ failSearch: true });
    const client = new GenomeDataWorkerClient(worker);
    const iterator = client.searchSequence('chrI', 'CGT')[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow('search failed');
  });

  it('cancels the worker search when the async iterator is returned early', async () => {
    const worker = new FakeWorker({ keepSearchOpen: true });
    const client = new GenomeDataWorkerClient(worker);
    const iterator = client.searchSequence('chrI', 'CGT')[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      value: { chrom: 'chrI', start: 1, end: 4, strand: 'forward', motif: 'CGT' },
      done: false,
    });
    expect(iterator.return).toBeDefined();
    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });

    const searchMessage = worker.messages.find((message) => message.type === 'searchSequence');
    expect(searchMessage).toBeDefined();
    expect(worker.messages).toContainEqual({
      id: expect.any(Number),
      type: 'cancel',
      targetId: searchMessage?.id,
    });
  });

  it('cancels pending range requests when their abort signal fires', async () => {
    const worker = new FakeWorker({ keepFeaturesOpen: true });
    const client = new GenomeDataWorkerClient(worker);
    const controller = new AbortController();

    const request = client.getFeatures('chrI', 1, 4, 1, { signal: controller.signal });
    const featureMessage = worker.messages.find((message) => message.type === 'getFeatures');

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.messages).toContainEqual({
      id: expect.any(Number),
      type: 'cancel',
      targetId: featureMessage?.id,
    });
  });
});

class FakeWorker {
  private listeners = new Set<(event: MessageEvent<GenomeDataWorkerResponse>) => void>();
  readonly messages: GenomeDataWorkerRequest[] = [];

  constructor(
    private readonly opts: {
      failSearch?: boolean;
      keepSearchOpen?: boolean;
      keepFeaturesOpen?: boolean;
    } = {}
  ) {}

  addEventListener(
    _type: 'message',
    listener: (event: MessageEvent<GenomeDataWorkerResponse>) => void
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'message',
    listener: (event: MessageEvent<GenomeDataWorkerResponse>) => void
  ): void {
    this.listeners.delete(listener);
  }

  postMessage(message: GenomeDataWorkerRequest): void {
    this.messages.push(message);
    if (message.type === 'cancel') return;
    if (message.type === 'init') {
      this.emit({ id: message.id, type: 'result', result: true });
      return;
    }
    if (message.type === 'getChromosomeLength') {
      this.emit({ id: message.id, type: 'result', result: 50_000 });
      return;
    }
    if (message.type === 'getSequence') {
      this.emit({ id: message.id, type: 'result', result: 'CGT' });
      return;
    }
    if (message.type === 'getFeatures') {
      if (this.opts.keepFeaturesOpen) return;
      this.emit({
        id: message.id,
        type: 'result',
        result: [
          {
            chrom: 'chrI',
            source: 'test',
            type: 'CDS',
            start: 1,
            end: 4,
            score: null,
            strand: '+',
            phase: null,
            attributes: {},
            raw: 'chrI\ttest\tCDS\t2\t4\t.\t+\t.\tID=x',
          },
        ],
      });
      return;
    }
    if (message.type === 'getFeatureDetails') {
      this.emit({
        id: message.id,
        type: 'result',
        result: {
          chrom: message.request.chrom,
          featureId: message.request.featureId,
          feature: {
            chrom: 'chrI',
            source: 'test',
            type: 'CDS',
            start: 1,
            end: 4,
            score: null,
            strand: '+',
            phase: null,
            attributes: { ID: ['feature-1'] },
            raw: 'chrI\ttest\tCDS\t2\t4\t.\t+\t.\tID=feature-1',
          },
          relatedFeatures: [
            {
              chrom: 'chrI',
              source: 'test',
              type: 'CDS',
              start: 1,
              end: 4,
              score: null,
              strand: '+',
              phase: null,
              attributes: { ID: ['feature-1'] },
              raw: 'chrI\ttest\tCDS\t2\t4\t.\t+\t.\tID=feature-1',
            },
          ],
          sourceRecordCount: 1,
          window: { start: 1, end: 4 },
          truncated: false,
        },
      });
      return;
    }
    if (message.type === 'searchSequence') {
      if (this.opts.failSearch) {
        this.emit({
          id: message.id,
          type: 'error',
          error: { name: 'Error', message: 'search failed' },
        });
        return;
      }
      this.emit({
        id: message.id,
        type: 'searchHit',
        hit: { chrom: 'chrI', start: 1, end: 4, strand: 'forward', motif: message.motif },
      });
      if (this.opts.keepSearchOpen) return;
      this.emit({ id: message.id, type: 'result', result: true });
    }
  }

  private emit(message: GenomeDataWorkerResponse): void {
    const event = { data: message } as MessageEvent<GenomeDataWorkerResponse>;
    for (const listener of this.listeners) listener(event);
  }
}
