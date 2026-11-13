import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelect = vi.hoisted(() => vi.fn());
const mockExecute = vi.hoisted(() => vi.fn());
const mockReadTextFile = vi.hoisted(() => vi.fn());

vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      select: mockSelect,
      execute: mockExecute,
      assertCanonicalSequenceSource: vi.fn(async () => undefined),
    },
    fs: {
      readTextFile: mockReadTextFile,
    },
  }),
}));

import { loadSourceSequenceForKey } from './SourceContextRegistry';

describe('SourceContextRegistry file fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads source context from the sequence file when the DB row has no sequence content', async () => {
    mockSelect.mockImplementation(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ');
      if (normalized.includes('FROM features')) {
        throw new Error('Source-context fallback must not query the retired features table');
      }
      if (normalized.includes('FROM sequences') && normalized.includes('WHERE document_id = ?')) {
        return [{ id: 7 }];
      }
      if (normalized.includes('FROM sequences s') && normalized.includes('WHERE s.id = ?')) {
        return [
          {
            id: 7,
            document_id: 'fixture:sequence:source',
            file_id: 3,
            name: 'source-row',
            description: null,
            length: 12,
            sequence_type: 'dna',
            circular: 0,
            sequence: null,
            file_path: '/lab/source.fasta',
          },
        ];
      }
      return [];
    });
    mockReadTextFile.mockResolvedValue('>source-file\nACGTACGTACGT\n');

    const source = await loadSourceSequenceForKey('fixture:sequence:source');

    expect(source?.id).toBe('fixture:sequence:source');
    expect(source?.sequence).toBe('ACGTACGTACGT');
    expect(source?.annotations).toEqual([]);
    expect(mockReadTextFile).toHaveBeenCalledWith('/lab/source.fasta');
    expect(
      mockSelect.mock.calls.some(([sql]) =>
        String(sql).replace(/\s+/g, ' ').includes('FROM features')
      )
    ).toBe(false);
  });
});
