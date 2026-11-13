import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStructureData, fetchStructureFromUrl } from './structureData';
import * as cache from './structureDataCache';
import { _clearAllForTesting } from './structureDataCache';
import { fetchStructureBytes } from '../api/structure-service-client';

import 'fake-indexeddb/auto';

vi.mock('../api/structure-service-client', () => ({
  fetchStructureBytes: vi.fn(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockFetchStructureBytes = vi.mocked(fetchStructureBytes);

async function cacheKey(identity: string): Promise<string> {
  const buffer = new TextEncoder().encode(identity);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `structure-bytes:v2:${hex}`;
}

describe('structureData', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await _clearAllForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchStructureData', () => {
    it('should return cached data on cache hit', async () => {
      await cache.cacheStructure(
        await cacheKey('RCSB:1CRN:ENTRY'),
        'cached structure data',
        'mmcif'
      );

      const result = await fetchStructureData('1CRN', 'rcsb');

      expect(result.data).toBe('cached structure data');
      expect(result.format).toBe('mmcif');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('should fetch from the sidecar on cache miss', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'network structure data',
        format: 'mmcif',
      });

      const result = await fetchStructureData('4C2S', 'rcsb');

      expect(result.data).toBe('network structure data');
      expect(result.format).toBe('mmcif');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'rcsb',
        externalId: 'RCSB:4C2S:ENTRY',
        format: 'mmcif',
        pdbId: '4C2S',
      });
    });

    it('should cache sidecar data after fetch', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'new structure data',
        format: 'mmcif',
      });

      await fetchStructureData('1NEW', 'rcsb');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const cached = await cache.getCachedStructure(await cacheKey('RCSB:1NEW:ENTRY'));
      expect(cached).not.toBeNull();
      expect(cached?.data).toBe('new structure data');
    });

    it('should handle AlphaFold provider', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'alphafold data',
        format: 'mmcif',
      });

      const result = await fetchStructureData('P04637', 'alphafold');

      expect(result.data).toBe('alphafold data');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'alphafold',
        externalId: 'AF:P04637:F1:LATEST',
        format: 'mmcif',
        accession: 'P04637',
        fragment: 'F1',
        version: 'LATEST',
      });
    });

    it('derives request fields from scoped provider identities when display ids are absent', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'scoped rcsb data',
        format: 'mmcif',
      });

      await fetchStructureData(
        {
          provider: 'rcsb',
          externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
          labelAsymIds: ['A', 'B'],
        },
        'rcsb'
      );

      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
        format: 'mmcif',
        pdbId: '1RBL',
        labelAsymIds: ['A', 'B'],
      });
    });

    it('validates scoped RCSB request identity before using the shared entry-byte cache', async () => {
      await cache.cacheStructure(await cacheKey('RCSB:1RBL:ENTRY'), 'cached entry bytes', 'mmcif');

      await expect(
        fetchStructureData(
          {
            provider: 'rcsb',
            externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A',
            labelAsymIds: ['B'],
          },
          'rcsb'
        )
      ).rejects.toThrow(/labelAsymIds/);
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('does not satisfy scoped RCSB identities from the unscoped entry-byte cache', async () => {
      await cache.cacheStructure(await cacheKey('RCSB:1RBL:ENTRY'), 'cached entry bytes', 'mmcif');
      mockFetchStructureBytes.mockResolvedValue({
        data: 'validated scoped bytes',
        format: 'mmcif',
        externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
      });

      const result = await fetchStructureData(
        {
          provider: 'rcsb',
          externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
          labelAsymIds: ['B', 'A'],
        },
        'rcsb'
      );

      expect(result.data).toBe('validated scoped bytes');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
        format: 'mmcif',
        pdbId: '1RBL',
        labelAsymIds: ['A', 'B'],
      });
    });

    it('fetches full-entry bytes for scoped RCSB complex identities when a fetch identity is supplied', async () => {
      await cache.cacheStructure(await cacheKey('RCSB:7ZP8:ENTRY'), 'cached full entry', 'mmcif');
      mockFetchStructureBytes.mockResolvedValue({
        data: 'network full-entry bytes',
        format: 'mmcif',
        externalId: 'RCSB:7ZP8:ENTRY',
      });

      const result = await fetchStructureData(
        {
          provider: 'rcsb',
          externalId: 'RCSB:7ZP8:ENTRY:ENTITY:10',
          fetchExternalId: 'RCSB:7ZP8:ENTRY',
          pdbId: '7ZP8',
          pdbEntityId: '10',
        },
        'rcsb'
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(result.data).toBe('network full-entry bytes');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'rcsb',
        externalId: 'RCSB:7ZP8:ENTRY',
        format: 'mmcif',
        pdbId: '7ZP8',
      });
      expect(await cache.getCachedStructure(await cacheKey('RCSB:7ZP8:ENTRY:ENTITY:10'))).toEqual({
        data: 'network full-entry bytes',
        format: 'mmcif',
      });
    });

    it('rejects full-entry fetch identities that point at a different RCSB entry', async () => {
      await expect(
        fetchStructureData(
          {
            provider: 'rcsb',
            externalId: 'RCSB:7ZP8:ENTRY:ENTITY:10',
            fetchExternalId: 'RCSB:6ZU1:ENTRY',
            pdbId: '7ZP8',
            pdbEntityId: '10',
          },
          'rcsb'
        )
      ).rejects.toThrow('RCSB fetch identity');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('lets the sidecar reject nonexistent scoped RCSB identities even when entry bytes are cached', async () => {
      await cache.cacheStructure(await cacheKey('RCSB:1RBL:ENTRY'), 'cached entry bytes', 'mmcif');
      mockFetchStructureBytes.mockRejectedValue(new Error('RCSB label asym id ZZZ is not present'));

      await expect(
        fetchStructureData(
          {
            provider: 'rcsb',
            externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:ZZZ',
          },
          'rcsb'
        )
      ).rejects.toThrow(/ZZZ/);
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:ZZZ',
        format: 'mmcif',
        pdbId: '1RBL',
        labelAsymIds: ['ZZZ'],
      });
    });

    it('preserves case-sensitive RCSB author-chain scopes in sidecar requests', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'validated lowercase auth chain bytes',
        format: 'mmcif',
      });

      await fetchStructureData(
        {
          provider: 'rcsb',
          externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:a',
        },
        'rcsb'
      );

      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:a',
        format: 'mmcif',
        pdbId: '1RBL',
        authAsymIds: ['a'],
      });
    });

    it('should fetch TrEMBL-style AlphaFold accessions returned by structure drawer resolution', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'alphafold trembl data',
        format: 'mmcif',
      });

      const result = await fetchStructureData('A0A0H3JZA8', 'alphafold');

      expect(result.data).toBe('alphafold trembl data');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'alphafold',
        externalId: 'AF:A0A0H3JZA8:F1:LATEST',
        format: 'mmcif',
        accession: 'A0A0H3JZA8',
        fragment: 'F1',
        version: 'LATEST',
      });
    });

    it('bypasses stale raw AlphaFold LATEST entries but reuses the concrete response through an alias', async () => {
      await cache.cacheStructure(await cacheKey('AF:Q5VSL9:F1:LATEST'), 'stale latest', 'mmcif');
      mockFetchStructureBytes.mockResolvedValue({
        data: 'fresh alphafold v6',
        format: 'mmcif',
        externalId: 'AF:Q5VSL9:F1:V6:MODEL:AF-Q5VSL9-F1-model_v6',
      });

      const result = await fetchStructureData('Q5VSL9', 'alphafold');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(result.data).toBe('fresh alphafold v6');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'alphafold',
        externalId: 'AF:Q5VSL9:F1:LATEST',
        format: 'mmcif',
        accession: 'Q5VSL9',
        fragment: 'F1',
        version: 'LATEST',
      });
      const concrete = await cache.getCachedStructure(
        await cacheKey('AF:Q5VSL9:F1:V6:MODEL:AF-Q5VSL9-F1-model_v6')
      );
      expect(concrete?.data).toBe('fresh alphafold v6');

      const cached = await fetchStructureData('Q5VSL9', 'alphafold');
      expect(cached.data).toBe('fresh alphafold v6');
      expect(mockFetchStructureBytes).toHaveBeenCalledTimes(1);
    });

    it('rejects RCSB byte responses that drop the requested scope', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'broader entry data',
        format: 'mmcif',
        externalId: 'RCSB:1RBL:ENTRY',
      });

      await expect(
        fetchStructureData(
          {
            provider: 'rcsb',
            externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:H',
          },
          'rcsb'
        )
      ).rejects.toThrow('RCSB byte response identity');
      expect(
        await cache.getCachedStructure(await cacheKey('RCSB:1RBL:ENTRY:AUTH_ASYM:H'))
      ).toBeNull();
    });

    it('rejects AlphaFold LATEST byte responses for a different accession', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'wrong alphafold data',
        format: 'mmcif',
        externalId: 'AF:P0AD87:F1:V6:MODEL:AF-P0AD87-F1-model_v6',
      });

      await expect(fetchStructureData('P0AD86', 'alphafold')).rejects.toThrow(
        'AlphaFold byte response identity'
      );
      expect(
        await cache.getCachedStructure(
          await cacheKey('AF:P0AD87:F1:V6:MODEL:AF-P0AD87-F1-model_v6')
        )
      ).toBeNull();
    });

    it('rejects concrete AlphaFold byte responses for a different version', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'wrong alphafold version',
        format: 'mmcif',
        externalId: 'AF:P0AD86:F1:V5:MODEL:AF-P0AD86-F1-model_v5',
      });

      await expect(
        fetchStructureData(
          {
            provider: 'alphafold',
            externalId: 'AF:P0AD86:F1:V6:MODEL:AF-P0AD86-F1-model_v6',
          },
          'alphafold'
        )
      ).rejects.toThrow('AlphaFold byte response version');
    });

    it('uses stable concrete AlphaFold model identities as cache keys', async () => {
      await cache.cacheStructure(
        await cacheKey('AF:Q5VSL9:F1:V6:MODEL:AF-Q5VSL9-F1-model_v6'),
        'cached alphafold v6',
        'mmcif'
      );

      const result = await fetchStructureData(
        {
          provider: 'alphafold',
          externalId: 'AF:Q5VSL9:F1:V6',
          accession: 'Q5VSL9',
          fragment: 'F1',
          version: 'V6',
          modelId: 'AF-Q5VSL9-F1-model_v6',
        },
        'alphafold'
      );

      expect(result.data).toBe('cached alphafold v6');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('infers the concrete AlphaFold model identity for explicit versions without model fields', async () => {
      await cache.cacheStructure(
        await cacheKey('AF:Q5VSL9:F1:V6:MODEL:AF-Q5VSL9-F1-model_v6'),
        'cached alphafold v6',
        'mmcif'
      );

      const result = await fetchStructureData(
        {
          provider: 'alphafold',
          externalId: 'AF:Q5VSL9:F1:V6',
        },
        'alphafold'
      );

      expect(result.data).toBe('cached alphafold v6');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('parses model-scoped AlphaFold provider identities without needing duplicate model fields', async () => {
      await cache.cacheStructure(
        await cacheKey('AF:Q5VSL9:F1:V6:MODEL:AF-Q5VSL9-F1-model_v6'),
        'cached alphafold v6',
        'mmcif'
      );

      const result = await fetchStructureData(
        {
          provider: 'alphafold',
          externalId: 'AF:Q5VSL9:F1:V6:MODEL:AF-Q5VSL9-F1-model_v6',
        },
        'alphafold'
      );

      expect(result.data).toBe('cached alphafold v6');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('rejects AlphaFold zero-fragment identities before network fetch', async () => {
      await expect(
        fetchStructureData(
          {
            provider: 'alphafold',
            externalId: 'AF:P04637:F0:V6',
          },
          'alphafold'
        )
      ).rejects.toThrow('Invalid AlphaFold structure identity');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('rejects AlphaFold model identities with impossible fragments before network fetch', async () => {
      await expect(
        fetchStructureData(
          {
            provider: 'alphafold',
            externalId: 'AF:P04637:F1:V6:MODEL:AF-P04637-F0-model_v6',
          },
          'alphafold'
        )
      ).rejects.toThrow('Invalid AlphaFold structure identity');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('rejects AlphaFold model identities that do not match the scoped accession before network fetch', async () => {
      await expect(
        fetchStructureData(
          {
            provider: 'alphafold',
            externalId: 'AF:P04637:F1:V6:MODEL:AF-Q5VSL9-F1-model_v6',
          },
          'alphafold'
        )
      ).rejects.toThrow('AlphaFold model identity does not match scoped structure identity');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('preserves string AlphaFold provider identities with model_v casing', async () => {
      await cache.cacheStructure(
        await cacheKey('AF:Q5VSL9:F1:V6:MODEL:AF-Q5VSL9-F1-model_v6'),
        'cached alphafold v6',
        'mmcif'
      );

      const result = await fetchStructureData(
        'af:q5vsl9:f1:v6:model:AF-Q5VSL9-F1-model_v6',
        'alphafold'
      );

      expect(result.data).toBe('cached alphafold v6');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('keeps AlphaFold model versions as separate byte-cache identities', async () => {
      await cache.cacheStructure(
        await cacheKey('AF:P04637:F1:V4:MODEL:AF-P04637-F1-model_v4'),
        'cached alphafold v4',
        'mmcif'
      );
      await cache.cacheStructure(
        await cacheKey('AF:P04637:F1:V6:MODEL:AF-P04637-F1-model_v6'),
        'cached alphafold v6',
        'mmcif'
      );

      const v4 = await fetchStructureData(
        {
          provider: 'alphafold',
          externalId: 'AF:P04637:F1:V4',
          accession: 'P04637',
          fragment: 'F1',
          version: 'V4',
          modelId: 'AF-P04637-F1-model_v4',
        },
        'alphafold'
      );
      const v6 = await fetchStructureData(
        {
          provider: 'alphafold',
          externalId: 'AF:P04637:F1:V6',
          accession: 'P04637',
          fragment: 'F1',
          version: 'V6',
          modelId: 'AF-P04637-F1-model_v6',
        },
        'alphafold'
      );

      expect(v4.data).toBe('cached alphafold v4');
      expect(v6.data).toBe('cached alphafold v6');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('should handle PDB format conversion', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'pdb format data',
        format: 'pdb',
      });

      const result = await fetchStructureData('1CRN', 'rcsb');

      expect(result.format).toBe('pdb');
    });

    it('should reject sequence formats from the structure fetch path', async () => {
      mockFetchStructureBytes.mockResolvedValue({
        data: 'LOCUS sequence data',
        // @ts-expect-error pin runtime guard against malformed sidecar responses.
        format: 'genbank',
      });

      await expect(fetchStructureData('9SEQ', 'rcsb')).rejects.toThrow(
        'Expected a structure format'
      );
    });

    it('should normalize structure ID to uppercase for cache key', async () => {
      await cache.cacheStructure(await cacheKey('RCSB:4C2S:ENTRY'), 'uppercase cached', 'mmcif');

      const result = await fetchStructureData('4c2s', 'rcsb');

      expect(result.data).toBe('uppercase cached');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });
  });

  describe('fetchStructureFromUrl', () => {
    it('should return cached data on cache hit', async () => {
      const url = 'https://files.rcsb.org/download/1RBL.pdb';
      await cache.cacheStructure(
        await cacheKey('RCSB:1RBL:ENTRY:pdb'),
        'cached url structure',
        'pdb'
      );

      const result = await fetchStructureFromUrl(url);

      expect(result.data).toBe('cached url structure');
      expect(result.format).toBe('pdb');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch known RCSB URLs through the sidecar on cache miss', async () => {
      const url = 'https://files.rcsb.org/download/1RBL.cif';
      mockFetchStructureBytes.mockResolvedValue({
        data: 'data_1RBL\n_atom_site.id 1',
        format: 'mmcif',
        externalId: 'RCSB:1RBL:ENTRY',
      });

      const result = await fetchStructureFromUrl(url);

      expect(result.data).toBe('data_1RBL\n_atom_site.id 1');
      expect(result.format).toBe('mmcif');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY',
        format: 'mmcif',
        pdbId: '1RBL',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch known AlphaFold URLs through the sidecar on cache miss', async () => {
      const url = 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v4.cif';
      mockFetchStructureBytes.mockResolvedValue({
        data: 'data_P04637',
        format: 'mmcif',
        externalId: 'AF:P04637:F1:V4:MODEL:AF-P04637-F1-model_v4',
      });

      const result = await fetchStructureFromUrl(url);

      expect(result.data).toBe('data_P04637');
      expect(result.format).toBe('mmcif');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'alphafold',
        externalId: 'AF:P04637:F1:V4:MODEL:AF-P04637-F1-model_v4',
        format: 'mmcif',
        accession: 'P04637',
        fragment: 'F1',
        version: 'V4',
        modelId: 'AF-P04637-F1-model_v4',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch known AlphaFold URLs with 10-character UniProt accessions through the sidecar', async () => {
      const url = 'https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v4.cif';
      mockFetchStructureBytes.mockResolvedValue({
        data: 'data_A0A0H3JZA8',
        format: 'mmcif',
        externalId: 'AF:A0A0H3JZA8:F1:V4:MODEL:AF-A0A0H3JZA8-F1-model_v4',
      });

      const result = await fetchStructureFromUrl(url);

      expect(result.data).toBe('data_A0A0H3JZA8');
      expect(result.format).toBe('mmcif');
      expect(mockFetchStructureBytes).toHaveBeenCalledWith({
        provider: 'alphafold',
        externalId: 'AF:A0A0H3JZA8:F1:V4:MODEL:AF-A0A0H3JZA8-F1-model_v4',
        format: 'mmcif',
        accession: 'A0A0H3JZA8',
        fragment: 'F1',
        version: 'V4',
        modelId: 'AF-A0A0H3JZA8-F1-model_v4',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should cache sidecar-fetched URL data', async () => {
      const url = 'https://files.rcsb.org/download/1RBL.cif';
      mockFetchStructureBytes.mockResolvedValue({
        data: 'structure to cache',
        format: 'mmcif',
        externalId: 'RCSB:1RBL:ENTRY',
      });

      await fetchStructureFromUrl(url);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const cached = await cache.getCachedStructure(await cacheKey('RCSB:1RBL:ENTRY'));
      expect(cached).not.toBeNull();
      expect(cached?.data).toBe('structure to cache');
    });

    it('rejects known RCSB URLs when the sidecar response identity is for a different entry', async () => {
      const url = 'https://files.rcsb.org/download/1RBL.cif';
      mockFetchStructureBytes.mockResolvedValue({
        data: 'data_2ABC\n_atom_site.id 1',
        format: 'mmcif',
        externalId: 'RCSB:2ABC:ENTRY',
      });

      await expect(fetchStructureFromUrl(url)).rejects.toThrow(
        'RCSB byte response identity RCSB:2ABC:ENTRY does not match requested RCSB:1RBL:ENTRY'
      );
      expect(await cache.getCachedStructure(await cacheKey('RCSB:1RBL:ENTRY'))).toBeNull();
    });

    it('rejects known AlphaFold URLs when the sidecar response identity is for a different model', async () => {
      const url = 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v4.cif';
      mockFetchStructureBytes.mockResolvedValue({
        data: 'data_A0A0H3JZA8',
        format: 'mmcif',
        externalId: 'AF:A0A0H3JZA8:F1:V4:MODEL:AF-A0A0H3JZA8-F1-model_v4',
      });

      await expect(fetchStructureFromUrl(url)).rejects.toThrow(
        'AlphaFold byte response identity AF:A0A0H3JZA8:F1:V4:MODEL:AF-A0A0H3JZA8-F1-model_v4 does not match requested AF:P04637:F1:V4:MODEL:AF-P04637-F1-model_v4'
      );
      expect(
        await cache.getCachedStructure(
          await cacheKey('AF:P04637:F1:V4:MODEL:AF-P04637-F1-model_v4')
        )
      ).toBeNull();
    });

    it('shares the mmCIF cache key between provider-id and known URL entrypoints', async () => {
      const url = 'https://files.rcsb.org/download/1RBL.cif';
      await cache.cacheStructure(await cacheKey('RCSB:1RBL:ENTRY'), 'shared mmcif cache', 'mmcif');

      const result = await fetchStructureFromUrl(url);

      expect(result.data).toBe('shared mmcif cache');
      expect(result.format).toBe('mmcif');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('keeps PDB-format URL bytes separate from provider-id mmCIF bytes', async () => {
      const url = 'https://files.rcsb.org/download/1RBL.pdb';
      await cache.cacheStructure(await cacheKey('RCSB:1RBL:ENTRY:pdb'), 'cached pdb bytes', 'pdb');

      const result = await fetchStructureFromUrl(url);

      expect(result.data).toBe('cached pdb bytes');
      expect(result.format).toBe('pdb');
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('should reject unknown URL cache misses without direct network fetch', async () => {
      const url = 'https://example.com/missing.pdb';

      await expect(fetchStructureFromUrl(url)).rejects.toThrow('Unsupported structure URL');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('rejects AlphaFold URLs with impossible fragments before sidecar fetch', async () => {
      const url = 'https://alphafold.ebi.ac.uk/files/AF-P04637-F0-model_v6.cif';

      await expect(fetchStructureFromUrl(url)).rejects.toThrow('Unsupported structure URL');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });

    it('rejects AlphaFold URLs with impossible model versions before sidecar fetch', async () => {
      const url = 'https://alphafold.ebi.ac.uk/files/AF-P04637-F1-model_v0.cif';

      await expect(fetchStructureFromUrl(url)).rejects.toThrow('Unsupported structure URL');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockFetchStructureBytes).not.toHaveBeenCalled();
    });
  });
});
