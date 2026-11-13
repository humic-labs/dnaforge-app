import { describe, expect, it } from 'vitest';

import { FileWatchConsumers } from './file-watch-consumers';

describe('FileWatchConsumers', () => {
  it('keeps a shared path alive until its final renderer releases it', () => {
    const consumers = new FileWatchConsumers();

    expect(consumers.acquire('/data/sample.bam', 1)).toBe(true);
    expect(consumers.acquire('/data/sample.bam', 2)).toBe(false);
    expect(consumers.release('/data/sample.bam', 1)).toBe(false);
    expect(consumers.release('/data/sample.bam', 2)).toBe(true);
  });

  it('reference-counts repeated watches from one renderer', () => {
    const consumers = new FileWatchConsumers();

    expect(consumers.acquire('/data/sample.bam', 1)).toBe(true);
    expect(consumers.acquire('/data/sample.bam', 1)).toBe(false);
    expect(consumers.release('/data/sample.bam', 1)).toBe(false);
    expect(consumers.release('/data/sample.bam', 1)).toBe(true);
  });

  it('releases every path owned by a destroyed renderer without disturbing peers', () => {
    const consumers = new FileWatchConsumers();
    consumers.acquire('/data/shared.bam', 1);
    consumers.acquire('/data/shared.bam', 2);
    consumers.acquire('/data/private.bam', 1);
    consumers.acquire('/data/private.bam', 1);

    expect(consumers.releaseSender(1)).toEqual(['/data/private.bam']);
    expect(consumers.release('/data/shared.bam', 2)).toBe(true);
    expect(consumers.releaseSender(1)).toEqual([]);
  });
});
