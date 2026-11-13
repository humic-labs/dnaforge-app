import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCachedStructure,
  cacheStructure,
  clearExpiredStructures,
  getCachedKeys,
  _clearAllForTesting,
} from './structureDataCache';

import 'fake-indexeddb/auto';

describe('structureDataCache', () => {
  beforeEach(async () => {
    await _clearAllForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('cacheStructure', () => {
    it('should cache structure data', async () => {
      const key = 'pdb:1CRN';
      const data = 'ATOM 1 N ALA A 1 0.000 0.000 0.000';
      const format = 'pdb' as const;

      await cacheStructure(key, data, format);
      const cached = await getCachedStructure(key);

      expect(cached).not.toBeNull();
      expect(cached?.data).toBe(data);
      expect(cached?.format).toBe(format);
    });

    it('should cache mmcif format', async () => {
      const key = 'pdb:4C2S';
      const data = 'data_4C2S\n_entry.id 4C2S';
      const format = 'mmcif' as const;

      await cacheStructure(key, data, format);
      const cached = await getCachedStructure(key);

      expect(cached).not.toBeNull();
      expect(cached?.data).toBe(data);
      expect(cached?.format).toBe(format);
    });

    it('should overwrite existing cache entry', async () => {
      const key = 'pdb:1CRN';
      const data1 = 'old data';
      const data2 = 'new data';

      await cacheStructure(key, data1, 'pdb');
      await cacheStructure(key, data2, 'pdb');
      const cached = await getCachedStructure(key);

      expect(cached?.data).toBe(data2);
    });
  });

  describe('getCachedStructure', () => {
    it('should return null for non-existent key', async () => {
      const cached = await getCachedStructure('pdb:DOESNOTEXIST');
      expect(cached).toBeNull();
    });

    it('should return cached structure', async () => {
      const key = 'af:P04637';
      const data = 'AlphaFold structure data';

      await cacheStructure(key, data, 'mmcif');
      const cached = await getCachedStructure(key);

      expect(cached).not.toBeNull();
      expect(cached?.data).toBe(data);
    });

    it('should return null for expired entries', async () => {
      const key = 'pdb:EXPIRED';
      const data = 'old structure';

      await cacheStructure(key, data, 'pdb');

      const originalNow = Date.now;
      const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => originalNow() + eightDaysMs);

      const cached = await getCachedStructure(key);
      expect(cached).toBeNull();

      vi.spyOn(Date, 'now').mockRestore();
    });
  });

  describe('getCachedKeys', () => {
    it('should return empty array when cache is empty', async () => {
      const keys = await getCachedKeys();
      expect(keys).toEqual([]);
    });

    it('should return all cached keys', async () => {
      await cacheStructure('pdb:1CRN', 'data1', 'pdb');
      await cacheStructure('pdb:4C2S', 'data2', 'mmcif');
      await cacheStructure('af:P04637', 'data3', 'mmcif');

      const keys = await getCachedKeys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain('pdb:1CRN');
      expect(keys).toContain('pdb:4C2S');
      expect(keys).toContain('af:P04637');
    });
  });

  describe('clearExpiredStructures', () => {
    it('should be callable without error', async () => {
      await cacheStructure('pdb:TEST1', 'data1', 'pdb');
      await cacheStructure('pdb:TEST2', 'data2', 'pdb');

      await clearExpiredStructures();

      const keys = await getCachedKeys();
      expect(keys).toContain('pdb:TEST1');
      expect(keys).toContain('pdb:TEST2');
    });
  });

  describe('cache key formats', () => {
    it('should handle PDB keys', async () => {
      await cacheStructure('pdb:1CRN', 'data', 'pdb');
      const cached = await getCachedStructure('pdb:1CRN');
      expect(cached).not.toBeNull();
    });

    it('should handle AlphaFold keys', async () => {
      await cacheStructure('af:Q5VSL9', 'data', 'mmcif');
      const cached = await getCachedStructure('af:Q5VSL9');
      expect(cached).not.toBeNull();
    });

    it('should handle URL keys', async () => {
      const urlKey = 'url:https://example.com/structure.pdb';
      await cacheStructure(urlKey, 'data', 'pdb');
      const cached = await getCachedStructure(urlKey);
      expect(cached).not.toBeNull();
    });
  });
});
