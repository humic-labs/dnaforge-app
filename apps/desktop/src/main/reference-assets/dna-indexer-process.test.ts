import { describe, expect, it } from 'vitest';

import { assemblyFinalizeWorkerCount } from './dna-indexer-process';

const GiB = 1024 ** 3;

describe('assemblyFinalizeWorkerCount', () => {
  it('uses half the cores when memory allows one worker per 4 GB', () => {
    expect(assemblyFinalizeWorkerCount(16, 64 * GiB)).toBe(8);
  });

  it('caps workers by memory on smaller machines', () => {
    expect(assemblyFinalizeWorkerCount(10, 16 * GiB)).toBe(4);
  });

  it('never drops below the helper default of two', () => {
    expect(assemblyFinalizeWorkerCount(2, 4 * GiB)).toBe(2);
  });
});
