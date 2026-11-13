import { describe, expect, it, vi } from 'vitest';
import {
  SequenceProductSummaryClient,
  type SequenceProductSummaryWorker,
} from './sequence-product-summary-client';
import type { SequenceProductSummaryRequest } from './sequence-product-summary-runtime';

function worker(): SequenceProductSummaryWorker {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
}

describe('sequence product summary worker boundary', () => {
  it('routes out-of-order results to the product that requested them', async () => {
    const host = worker();
    const client = new SequenceProductSummaryClient(host);
    const first = client.read('first product');
    const second = client.read('second product');
    const [a, b] = vi
      .mocked(host.postMessage)
      .mock.calls.map(([request]) => request as SequenceProductSummaryRequest);
    host.onmessage!({
      data: { id: b.id, summary: { length: 200, topology: 'linear', geneticCode: 1 } },
    } as MessageEvent);
    host.onmessage!({
      data: { id: a.id, summary: { length: 10, topology: 'circular', geneticCode: 4 } },
    } as MessageEvent);
    await expect(first).resolves.toMatchObject({ length: 10, geneticCode: 4 });
    await expect(second).resolves.toMatchObject({ length: 200, geneticCode: 1 });
    client.dispose();
    expect(host.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects all outstanding work on worker failure and never accepts later work', async () => {
    const host = worker();
    const client = new SequenceProductSummaryClient(host);
    const results = Promise.allSettled([client.read('first'), client.read('second')]);
    host.onerror!({ message: 'worker failed' } as ErrorEvent);
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(client.failed).toBe(true);
    await expect(client.read('later')).rejects.toThrow('worker failed');
    expect(host.postMessage).toHaveBeenCalledTimes(2);
    expect(host.terminate).toHaveBeenCalledTimes(1);
  });

  it('preserves a parse error without killing other product requests', async () => {
    const host = worker();
    const client = new SequenceProductSummaryClient(host);
    const invalid = expect(client.read('invalid')).rejects.toMatchObject({
      name: 'GenBankParseError',
      message: 'Malformed record',
    });
    const valid = client.read('valid');
    const [a, b] = vi.mocked(host.postMessage).mock.calls.map(([request]) => request);
    host.onmessage!({
      data: { id: a.id, error: { name: 'GenBankParseError', message: 'Malformed record' } },
    } as MessageEvent);
    host.onmessage!({
      data: { id: b.id, summary: { length: 4, topology: 'linear', geneticCode: 1 } },
    } as MessageEvent);
    await invalid;
    await expect(valid).resolves.toMatchObject({ length: 4 });
    expect(client.failed).toBe(false);
    client.dispose();
  });
});
