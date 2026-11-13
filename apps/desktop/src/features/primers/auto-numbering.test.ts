import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCatalogNumber } from './auto-numbering';

const allocatePrimerCatalogNumber = vi.fn();

vi.mock('../../platform', () => ({
  platform: () => ({
    db: { allocatePrimerCatalogNumber },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateCatalogNumber', () => {
  it('delegates allocation to the atomic main-process database boundary', async () => {
    allocatePrimerCatalogNumber.mockResolvedValue('PC042');

    await expect(generateCatalogNumber(17)).resolves.toBe('PC042');
    expect(allocatePrimerCatalogNumber).toHaveBeenCalledOnce();
    expect(allocatePrimerCatalogNumber).toHaveBeenCalledWith(17);
  });

  it('does not hide allocator failures', async () => {
    allocatePrimerCatalogNumber.mockRejectedValue(new Error('catalog collision'));

    await expect(generateCatalogNumber(3)).rejects.toThrow('catalog collision');
  });
});
