import { describe, expect, it, vi } from 'vitest';

const readerState = vi.hoisted(() => ({
  fingerprintGeneration: 1,
  nextReaderId: 1,
  readers: [] as Array<{
    id: number;
    fastaClose: ReturnType<typeof vi.fn>;
    faiClose: ReturnType<typeof vi.fn>;
  }>,
  firstSequenceStarted: null as Promise<void> | null,
  signalFirstSequenceStarted: null as (() => void) | null,
  firstSequenceResult: null as Promise<string> | null,
  failFaiCloseOnceForReaderId: null as number | null,
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({
    size: 100,
    mtimeMs: readerState.fingerprintGeneration,
    ctimeMs: readerState.fingerprintGeneration,
  })),
}));

vi.mock('@gmod/indexedfasta', () => ({
  IndexedFasta: class FakeIndexedFasta {
    private readonly id = readerState.nextReaderId++;
    readonly fasta = { close: vi.fn(async () => undefined) };
    readonly fai = {
      close: vi.fn(async () => {
        if (readerState.failFaiCloseOnceForReaderId !== this.id) return;
        readerState.failFaiCloseOnceForReaderId = null;
        throw new Error(`fai close failed for reader ${this.id}`);
      }),
    };

    constructor() {
      readerState.readers.push({
        id: this.id,
        fastaClose: this.fasta.close,
        faiClose: this.fai.close,
      });
    }

    async getSequenceSize(): Promise<number> {
      return 100;
    }

    async getSequence(): Promise<string> {
      if (this.id === 1 && readerState.firstSequenceResult) {
        readerState.signalFirstSequenceStarted?.();
        return readerState.firstSequenceResult;
      }
      return 'CCCC';
    }
  },
}));

vi.mock('@gmod/tabix', () => ({
  TabixIndexedFile: class FakeTabixIndexedFile {
    readonly cache = { clear: vi.fn(async () => undefined) };
  },
}));

import { LocalIndexedGenomeDataSource } from './local-indexed-genome-data-source';

describe('LocalIndexedGenomeDataSource reader lifecycle', () => {
  it('keeps stale readers alive until every operation that could use them finishes', async () => {
    let signalStarted!: () => void;
    readerState.firstSequenceStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    readerState.signalFirstSequenceStarted = signalStarted;
    let resolveFirstSequence!: (value: string) => void;
    readerState.firstSequenceResult = new Promise<string>((resolve) => {
      resolveFirstSequence = resolve;
    });

    const source = new LocalIndexedGenomeDataSource({
      chrom: 'chrI',
      fastaPath: '/fixture/chrI.fa',
      faiPath: '/fixture/chrI.fa.fai',
    });
    const firstRead = source.getSequence('chrI', 0, 4);
    await readerState.firstSequenceStarted;

    readerState.fingerprintGeneration = 2;
    await expect(source.getChromosomeLength('chrI')).resolves.toBe(100);

    expect(readerState.readers).toHaveLength(2);
    expect(readerState.readers[0]?.fastaClose).not.toHaveBeenCalled();
    expect(readerState.readers[0]?.faiClose).not.toHaveBeenCalled();

    readerState.fingerprintGeneration = 3;
    await expect(source.getChromosomeLength('chrI')).rejects.toThrow(
      'Indexed genome files changed again while an older reader generation is still active'
    );
    expect(readerState.readers).toHaveLength(2);

    resolveFirstSequence('ACGT');
    await expect(firstRead).rejects.toThrow(/generation changed/);
    expect(readerState.readers[0]?.fastaClose).toHaveBeenCalledTimes(1);
    expect(readerState.readers[0]?.faiClose).toHaveBeenCalledTimes(1);

    await expect(source.getChromosomeLength('chrI')).resolves.toBe(100);
    expect(readerState.readers).toHaveLength(3);
    expect(readerState.readers[1]?.fastaClose).toHaveBeenCalledTimes(1);
    expect(readerState.readers[1]?.faiClose).toHaveBeenCalledTimes(1);
    await expect(source.getSequence('chrI', 0, 4)).resolves.toBe('CCCC');

    await source.close();
    expect(readerState.readers[2]?.fastaClose).toHaveBeenCalledTimes(1);
    expect(readerState.readers[2]?.faiClose).toHaveBeenCalledTimes(1);
  });

  it('reports close failures and retries only the resources that did not close', async () => {
    const source = new LocalIndexedGenomeDataSource({
      chrom: 'chrI',
      fastaPath: '/fixture/chrI.fa',
      faiPath: '/fixture/chrI.fa.fai',
    });
    const reader = readerState.readers.at(-1);
    expect(reader).toBeDefined();
    readerState.failFaiCloseOnceForReaderId = reader?.id ?? null;

    await expect(source.close()).rejects.toThrow('Failed to close indexed genome readers');
    expect(reader?.fastaClose).toHaveBeenCalledTimes(1);
    expect(reader?.faiClose).toHaveBeenCalledTimes(1);

    await expect(source.close()).resolves.toBeUndefined();
    expect(reader?.fastaClose).toHaveBeenCalledTimes(1);
    expect(reader?.faiClose).toHaveBeenCalledTimes(2);
  });
});
