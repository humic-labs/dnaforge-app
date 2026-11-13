import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), stat: vi.fn(), close: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }));
vi.mock('@gmod/indexedfasta', () => ({
  IndexedFasta: class {
    fasta = { close: mocks.close };
    fai = { close: vi.fn() };
    async getSequenceSize() {
      return 40;
    }
    getSequence(_chrom: string, start: number, end: number) {
      return mocks.read(start, end);
    }
  },
}));
vi.mock('@gmod/tabix', () => ({ TabixIndexedFile: class {} }));

import { LocalIndexedGenomeDataSource } from './local-indexed-genome-data-source';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function source(checkFileMtimeOnRead = false) {
  return new LocalIndexedGenomeDataSource(
    { chrom: 'chr1', fastaPath: '/genome.fa', faiPath: '/genome.fa.fai' },
    { sequenceBlockSize: 4, checkFileMtimeOnRead }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stat.mockResolvedValue({ size: 40, mtimeMs: 1, ctimeMs: 1 });
});

describe('indexed genome independent reads', () => {
  it('overlaps at most four blocks and preserves sequence order and cache reuse', async () => {
    const gates = Array.from({ length: 10 }, () => deferred<string>());
    mocks.read.mockImplementation((start: number) => gates[start / 4].promise);
    const genome = source();
    const reading = genome.getSequence('chr1', 1, 39);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(4));
    gates[3].resolve('TTTT');
    gates[2].resolve('GGGG');
    gates[1].resolve('CCCC');
    await Promise.resolve();
    expect(mocks.read).toHaveBeenCalledTimes(4);
    gates[0].resolve('AAAA');
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(8));
    for (let i = 4; i < 8; i++) gates[i].resolve('AAAA');
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(10));
    gates[9].resolve('CCCC');
    gates[8].resolve('GGGG');
    await expect(reading).resolves.toBe('AAACCCCGGGGTTTT' + 'A'.repeat(16) + 'GGGGCCC');
    await expect(genome.getSequence('chr1', 1, 15)).resolves.toBe('AAACCCCGGGGTTT');
    expect(mocks.read).toHaveBeenCalledTimes(10);
    await genome.close();
  });

  it('drains the active batch on failure before closing readers or starting more work', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<string>());
    mocks.read.mockImplementation((start: number) => gates[start / 4].promise);
    const genome = source();
    const error = new Error('first block failed');
    const reading = genome.getSequence('chr1', 0, 40);
    const rejected = expect(reading).rejects.toBe(error);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(4));
    const closing = genome.close();
    gates[0].reject(error);
    gates[1].reject(new Error('second block failed'));
    await Promise.resolve();
    expect(mocks.close).not.toHaveBeenCalled();
    gates[2].resolve('AAAA');
    gates[3].resolve('AAAA');
    await rejected;
    await closing;
    expect(mocks.read).toHaveBeenCalledTimes(4);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('stops at the active batch on cancellation and waits for its reads', async () => {
    const gate = deferred<string>();
    mocks.read.mockReturnValue(gate.promise);
    const genome = source();
    const controller = new AbortController();
    const reading = genome.getSequence('chr1', 0, 40, { signal: controller.signal });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(4));
    controller.abort();
    const closing = genome.close();
    expect(mocks.close).not.toHaveBeenCalled();
    gate.resolve('AAAA');
    await rejected;
    await closing;
    expect(mocks.read).toHaveBeenCalledTimes(4);
  });

  it('checks independent source fingerprints together before reading sequence data', async () => {
    const gate = deferred<{ size: number; mtimeMs: number; ctimeMs: number }>();
    mocks.stat.mockReturnValue(gate.promise);
    const genome = source(true);
    const reading = genome.getChromosomeLength('chr1');
    await vi.waitFor(() => expect(mocks.stat).toHaveBeenCalledTimes(2));
    expect(mocks.stat.mock.calls.map(([path]) => path)).toEqual(['/genome.fa', '/genome.fa.fai']);
    expect(mocks.read).not.toHaveBeenCalled();
    gate.resolve({ size: 40, mtimeMs: 1, ctimeMs: 1 });
    await expect(reading).resolves.toBe(40);
    await genome.close();
  });
});
