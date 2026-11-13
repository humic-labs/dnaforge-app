import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadTextFile = vi.fn();

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: mockReadTextFile,
    },
  }),
}));

import {
  computePairwiseQueryId,
  computePairwiseQueryRevision,
  computePairwiseReferenceRevision,
  computeReferenceHash,
} from './hash';

describe('computeReferenceHash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes SHA-256 hash of file content', async () => {
    const mockContent = 'ATCGATCG';
    mockReadTextFile.mockResolvedValue(mockContent);

    const hash = await computeReferenceHash('/path/to/ref.gb');

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(mockReadTextFile).toHaveBeenCalledWith('/path/to/ref.gb');
  });

  it('returns consistent hash for same content', async () => {
    mockReadTextFile.mockResolvedValue('ATCGATCG');

    const hash1 = await computeReferenceHash('/path/to/ref.gb');
    const hash2 = await computeReferenceHash('/path/to/ref.gb');

    expect(hash1).toMatch(/\S/);
    expect(hash1).toBe(hash2);
  });

  it('returns null when file does not exist', async () => {
    mockReadTextFile.mockRejectedValue(new Error('File not found'));

    const hash = await computeReferenceHash('/nonexistent.gb');

    expect(hash).toBeNull();
  });

  it('produces valid hash for empty file', async () => {
    mockReadTextFile.mockResolvedValue('');

    const hash = await computeReferenceHash('/empty.gb');

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('matches the server pairwise revision contract exactly', async () => {
    const sequence = 'N'.repeat(20);
    const digest = 'bef3387591fa37f5681ad13fd7a0dee95b1fa61a9b9c8bdb8946de01bb18c0ea';

    await expect(computePairwiseReferenceRevision(sequence)).resolves.toBe(
      `pairwise-reference-v1:sha256:${digest}`
    );
    await expect(computePairwiseQueryRevision(sequence.toLowerCase())).resolves.toBe(
      `pairwise-query-v1:sha256:${digest}`
    );
  });

  it('derives a stable opaque query ID without exposing the source path', async () => {
    const sourcePath = '/private/specimens/clone-one.fasta';
    const first = await computePairwiseQueryId('session-one', sourcePath);
    const repeated = await computePairwiseQueryId('session-one', sourcePath);
    const otherSession = await computePairwiseQueryId('session-two', sourcePath);

    expect(first).toMatch(/^pairwise-query:[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(otherSession).not.toBe(first);
    expect(first).not.toContain(sourcePath);
  });
});
