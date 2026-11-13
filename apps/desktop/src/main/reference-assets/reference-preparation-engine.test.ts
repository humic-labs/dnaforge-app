import { describe, expect, it, vi } from 'vitest';

import {
  runDnaIndexerAssemblyIngestProcess,
  runSourceFirstReferenceGenerationTransaction,
} from './reference-preparation-engine';

describe('dna-indexer assembly process boundary', () => {
  it('force-terminates an assembly ingest process that never exits', async () => {
    const startedAt = Date.now();

    await expect(
      runDnaIndexerAssemblyIngestProcess({
        binary: process.execPath,
        args: [
          '-e',
          'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1_000);',
        ],
        timeoutMs: 100,
      })
    ).rejects.toThrow(
      'dna-indexer assembly ingestion exceeded the 100 ms process deadline and was force-terminated'
    );

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('source-first reference generation transaction', () => {
  it('publishes the verified source before beginning derived-product work', async () => {
    const order: string[] = [];
    const discardUnpublishedSource = vi.fn(async () => undefined);

    await expect(
      runSourceFirstReferenceGenerationTransaction({
        prepareSource: async () => {
          order.push('prepare-source');
          return { fingerprint: 'source-fingerprint' };
        },
        publishSource: async (source) => {
          expect(source).toEqual({ fingerprint: 'source-fingerprint' });
          order.push('publish-source');
        },
        onSourcePublished: async (source) => {
          expect(source).toEqual({ fingerprint: 'source-fingerprint' });
          order.push('source-published-callback');
        },
        prepareProducts: async (source) => {
          expect(source).toEqual({ fingerprint: 'source-fingerprint' });
          order.push('prepare-products');
          return { status: 'ready' as const };
        },
        discardUnpublishedSource,
      })
    ).resolves.toEqual({
      source: { fingerprint: 'source-fingerprint' },
      products: { status: 'ready' },
    });

    expect(order).toEqual([
      'prepare-source',
      'publish-source',
      'source-published-callback',
      'prepare-products',
    ]);
    expect(discardUnpublishedSource).not.toHaveBeenCalled();
  });

  it('never discards a source generation after its atomic publication succeeds', async () => {
    const order: string[] = [];
    const discardUnpublishedSource = vi.fn(async () => {
      order.push('discard-source');
    });

    await expect(
      runSourceFirstReferenceGenerationTransaction({
        prepareSource: async () => {
          order.push('prepare-source');
          return { fingerprint: 'source-fingerprint' };
        },
        publishSource: async () => {
          order.push('publish-source');
        },
        prepareProducts: async () => {
          order.push('prepare-products');
          throw new Error('visual product build failed');
        },
        discardUnpublishedSource,
      })
    ).rejects.toThrow('visual product build failed');

    expect(order).toEqual(['prepare-source', 'publish-source', 'prepare-products']);
    expect(discardUnpublishedSource).not.toHaveBeenCalled();
  });

  it('does not discard an atomically published source when its publication observer fails', async () => {
    const order: string[] = [];
    const discardUnpublishedSource = vi.fn(async () => {
      order.push('discard-source');
    });
    const prepareProducts = vi.fn(async () => ({ status: 'ready' as const }));

    await expect(
      runSourceFirstReferenceGenerationTransaction({
        prepareSource: async () => {
          order.push('prepare-source');
          return { fingerprint: 'source-fingerprint' };
        },
        publishSource: async () => {
          order.push('publish-source');
        },
        onSourcePublished: async () => {
          order.push('source-published-callback');
          throw new Error('publication observer failed');
        },
        prepareProducts,
        discardUnpublishedSource,
      })
    ).rejects.toThrow('publication observer failed');

    expect(order).toEqual(['prepare-source', 'publish-source', 'source-published-callback']);
    expect(discardUnpublishedSource).not.toHaveBeenCalled();
    expect(prepareProducts).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'source preparation',
      prepareSource: async () => {
        throw new Error('source preparation failed');
      },
      publishSource: async () => undefined,
      expectedError: 'source preparation failed',
    },
    {
      label: 'atomic source publication',
      prepareSource: async () => ({ fingerprint: 'source-fingerprint' }),
      publishSource: async () => {
        throw new Error('source publication failed');
      },
      expectedError: 'source publication failed',
    },
  ])('discards the unpublished generation after $label fails', async (failure) => {
    const discardUnpublishedSource = vi.fn(async () => undefined);
    const prepareProducts = vi.fn(async () => ({ status: 'ready' as const }));

    await expect(
      runSourceFirstReferenceGenerationTransaction({
        prepareSource: failure.prepareSource,
        publishSource: failure.publishSource,
        prepareProducts,
        discardUnpublishedSource,
      })
    ).rejects.toThrow(failure.expectedError);

    expect(discardUnpublishedSource).toHaveBeenCalledOnce();
    expect(prepareProducts).not.toHaveBeenCalled();
  });
});
