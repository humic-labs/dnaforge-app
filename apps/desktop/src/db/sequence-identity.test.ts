import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  ensureSequenceIndex: vi.fn(),
  select: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../platform', () => ({ platform: () => ({ db: mock }) }));
import { ensureSequenceIdentity, getSequenceIdByDocumentId } from './sequence-identity';

beforeEach(() => vi.clearAllMocks());

describe('sequence identity adapter', () => {
  it('asks the native owner to project authoritative sequence metadata', async () => {
    mock.ensureSequenceIndex.mockResolvedValue(24);
    expect(
      await ensureSequenceIdentity(
        'package-a',
        '/project/product.gb',
        'Caller name',
        999,
        true,
        '/project'
      )
    ).toBe(24);
    expect(mock.ensureSequenceIndex).toHaveBeenCalledWith({
      documentId: 'package-a',
      filePath: '/project/product.gb',
      workspaceRoot: '/project',
    });
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it('leaves project inference to the native owner and surfaces its refusal', async () => {
    mock.ensureSequenceIndex.mockRejectedValue(
      new Error('Sequence identity belongs to another project.')
    );
    await expect(
      ensureSequenceIdentity('package-a', '/other/product.gb', 'Caller name', 8, false)
    ).rejects.toThrow(/another project/);
    expect(mock.ensureSequenceIndex).toHaveBeenCalledWith({
      documentId: 'package-a',
      filePath: '/other/product.gb',
      workspaceRoot: undefined,
    });
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it('looks up numeric primer identity by exact stable document identity', async () => {
    mock.select.mockResolvedValueOnce([{ id: 24 }]).mockResolvedValueOnce([]);
    expect(await getSequenceIdByDocumentId('package-a')).toBe(24);
    expect(await getSequenceIdByDocumentId('missing')).toBeNull();
    expect(mock.select).toHaveBeenCalledWith(expect.stringContaining('WHERE document_id = ?'), [
      'package-a',
    ]);
  });
});
