// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('../api/sidecar-client', () => ({
  getExternalResourceByExternalId: vi.fn(),
}));

import {
  _resetCacheForTesting,
  clearExternalResourceCache,
  deriveCacheKey,
  deriveReconcileDependencies,
  deriveReconcileTuple,
  getCachedExternalResourceKeys,
  getCachedExternalResourceResult,
  invalidateCacheByExternalIds,
  setCachedExternalResourceResult,
} from './useExternalResourceCache';
import { getExternalResourceByExternalId } from '../api/sidecar-client';
import type { ResolverResult, StructureDrawerRequest } from '../types/structure-drawer';

const mockedGetByExternalId = vi.mocked(getExternalResourceByExternalId);

const PDB_RESULT: ResolverResult = {
  source: 'pdb_xref',
  identity: 1,
  structure: { kind: 'pdb', pdbId: '1TUP' },
};

const UNIPROT_RESULT: ResolverResult = {
  source: 'uniprot_xref',
  identity: 1,
  structure: { kind: 'uniprot', accession: 'P0AD86' },
  confidenceNote: 'Mean pLDDT 78.4',
};

const SIDECAR_ROW_V1 = {
  id: 'res-uniprot-P0AD86',
  provider: 'uniprot',
  externalId: 'P0AD86',
  externalUrl: 'https://www.uniprot.org/uniprotkb/P0AD86/entry',
  versionIdentifier: '178',
  etag: 'W/"abc"',
  fetchedAt: '2026-05-01T00:00:00Z',
  lastChecked: '2026-05-01T00:00:00Z',
};

const RCSB_ROW_V1 = {
  id: 'res-rcsb-1RBL',
  provider: 'rcsb',
  externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
  externalUrl: 'https://www.rcsb.org/structure/1RBL',
  versionIdentifier: '2026-05-01',
  etag: 'W/"rcsb-abc"',
  fetchedAt: '2026-05-01T00:00:00Z',
  lastChecked: '2026-05-01T00:00:00Z',
};

const RCSB_CANDIDATE_RESULT: ResolverResult = {
  source: 'protein_sequence',
  identity: 1,
  structure: {
    kind: 'pdb',
    pdbId: '1RBL',
    providerIdentityKey: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
    labelAsymIds: ['A', 'B'],
  },
  recommendedCandidateId: 'rcsb:1RBL:all',
  candidates: [
    {
      id: 'rcsb:1RBL:all',
      provider: 'pdb',
      structure: {
        kind: 'pdb',
        pdbId: '1RBL',
        providerIdentityKey: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
        labelAsymIds: ['A', 'B'],
      },
      label: '1RBL',
      group: 'rcsb',
      rank: 0,
      metadata: {
        pdbId: '1RBL',
        resolution: 2.2,
        sourceUrl: 'https://www.rcsb.org/structure/1RBL',
      },
      provenance: {
        resolverSource: 'protein_sequence',
        identity: 1,
        structureIdentity: {
          kind: 'rcsb',
          providerIdentityKey: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
          pdbId: '1RBL',
          labelAsymIds: ['A', 'B'],
        },
        externalResourceId: 'res-rcsb-1RBL',
        cacheHit: false,
      },
    },
  ],
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function putRawCacheEntry(entry: Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('waypoint-external-resource-cache', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('resolver-results')) {
        db.createObjectStore('resolver-results', { keyPath: 'key' });
      }
    };
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('resolver-results', 'readwrite');
    const request = tx.objectStore('resolver-results').put(entry);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
  db.close();
}

function identityRequest(translation = 'M'): StructureDrawerRequest {
  return {
    translation,
    identityRequestKey: 'req:feature:v2:test:protein-sequence:v2:test',
    proteinIdentity: {
      schemaVersion: 2,
      sequence: {
        kind: 'protein_sequence',
        schemaVersion: 2,
        identityKey: 'protein-sequence:v2:test-digest',
        canonicalizationStatus: 'renderer_preflight',
        lookupSequence: translation,
        canonicalLookupSequence: translation,
        length: translation.length,
        source: 'qualifier_translation',
        startCodon: null,
        initiatorNormalized: false,
        digests: { sha256: 'test-digest' },
        evidenceIds: [],
      },
      externalProteins: [],
      resolutionSets: [],
      structures: [],
      evidence: [],
    },
    hints: {},
  };
}

beforeEach(async () => {
  _resetCacheForTesting();
  await clearExternalResourceCache();
  mockedGetByExternalId.mockReset();
  mockedGetByExternalId.mockImplementation(async (provider, externalId) => {
    if (provider === 'uniprot' && externalId.toUpperCase() === 'P0AD86') {
      return SIDECAR_ROW_V1;
    }
    if (provider === 'rcsb' && externalId.toUpperCase() === 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B') {
      return RCSB_ROW_V1;
    }
    return null;
  });
});

describe('deriveReconcileDependencies', () => {
  it('returns the (uniprot, accession) tuple for UniProt results', () => {
    expect(deriveReconcileDependencies(UNIPROT_RESULT)).toEqual([
      {
        provider: 'uniprot',
        externalId: 'P0AD86',
      },
    ]);
    expect(deriveReconcileTuple(UNIPROT_RESULT)).toEqual({
      provider: 'uniprot',
      externalId: 'P0AD86',
    });
  });

  it('returns an RCSB tuple for enriched PDB candidates', () => {
    expect(deriveReconcileDependencies(RCSB_CANDIDATE_RESULT)).toEqual([
      {
        provider: 'rcsb',
        externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
      },
    ]);
  });

  it('returns no dependencies for degraded PDB direct results', () => {
    expect(deriveReconcileDependencies(PDB_RESULT)).toEqual([]);
    expect(deriveReconcileTuple(PDB_RESULT)).toBeNull();
  });
});

describe('useExternalResourceCache — round-trip', () => {
  it('round-trips a UniProt result with reconcile metadata stamped', async () => {
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());
    const out = await getCachedExternalResourceResult('M', signal());
    expect(out).toEqual(UNIPROT_RESULT);
    expect(mockedGetByExternalId).toHaveBeenCalledTimes(2);
  });

  it('returns null on a miss', async () => {
    const out = await getCachedExternalResourceResult('NEVER_CACHED', signal());
    expect(out).toBeNull();
    expect(mockedGetByExternalId).not.toHaveBeenCalled();
  });

  it('different translations produce different cache keys', async () => {
    const k1 = await deriveCacheKey('MA');
    const k2 = await deriveCacheKey('MB');
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes identity request and hint context for legacy request cache keys', async () => {
    const base = {
      translation: 'MKK',
      hints: { dbXrefs: ['UniProtKB:P00880'] },
    };
    const sameTranslationDifferentXref = await deriveCacheKey({
      ...base,
      hints: { dbXrefs: ['UniProtKB:P0AD86'] },
    });
    const sameTranslationDifferentRequest = await deriveCacheKey({
      ...base,
      identityRequestKey: 'req:feature:v2:file-a:protein-sequence:v2:digest-a',
    });
    const original = await deriveCacheKey({
      ...base,
      identityRequestKey: 'req:feature:v2:file-b:protein-sequence:v2:digest-a',
    });

    expect(original).not.toBe(sameTranslationDifferentXref);
    expect(original).not.toBe(sameTranslationDifferentRequest);
    expect(original).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mixes the protein identity ledger into a request-context cache key', async () => {
    const key = await deriveCacheKey(identityRequest('M'));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(await deriveCacheKey('M'));
  });

  it('keeps identical protein sequences with different hints in separate cache entries', async () => {
    const base = identityRequest('M');
    const fromPdbHint = await deriveCacheKey({
      ...base,
      hints: { dbXrefs: ['PDB:1RBL', 'UniProtKB:P00880'] },
    });
    const fromAfdbOnlyHint = await deriveCacheKey({
      ...base,
      hints: { dbXrefs: ['UniProtKB:P00880'] },
    });

    expect(fromPdbHint).not.toBe(fromAfdbOnlyHint);
  });

  it('treats omitted and undefined hint fields as the same cache context', async () => {
    const base = identityRequest('M');
    const omitted = await deriveCacheKey({ ...base, hints: {} });
    const undefinedValue = await deriveCacheKey({
      ...base,
      hints: { geneName: undefined },
    });

    expect(omitted).toMatch(/\S/);
    expect(omitted).toBe(undefinedValue);
  });

  it('hard-misses legacy translation-only rows for identity-ledger requests', async () => {
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());

    expect(await getCachedExternalResourceResult(identityRequest('M'), signal())).toBeNull();
  });

  it('evicts pre-fix cache entries without the resolver cache schema version', async () => {
    const key = await deriveCacheKey('YOEB');
    await putRawCacheEntry({
      key,
      result: {
        ...UNIPROT_RESULT,
        source: 'gene_sequence_overlap',
        structure: { kind: 'uniprot', accession: 'P69348' },
      },
      cachedAt: Date.now(),
      reconciles: [],
    });

    expect(await getCachedExternalResourceResult('YOEB', signal())).toBeNull();
    expect(await getCachedExternalResourceKeys()).not.toContain(key);
  });

  it('rejects cache keys when the compatibility translation diverges from the ledger', async () => {
    const request = identityRequest('M');
    request.translation = 'Q';

    await expect(deriveCacheKey(request)).rejects.toThrow(/translation does not match/i);
  });

  it('rejects cache keys when the identity key is not digest-derived', async () => {
    const request = identityRequest('M');
    request.proteinIdentity!.sequence.identityKey = 'protein-sequence:v2:not-the-digest';

    await expect(deriveCacheKey(request)).rejects.toThrow(/identityKey is not derived/i);
  });

  it('overwrites an existing entry on re-cache', async () => {
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());
    const updated: ResolverResult = {
      source: 'uniprot_xref',
      identity: 1,
      structure: { kind: 'uniprot', accession: 'Q12345' },
    };
    mockedGetByExternalId.mockResolvedValue({ ...SIDECAR_ROW_V1, externalId: 'Q12345' });
    await setCachedExternalResourceResult('M', updated, signal());
    const out = await getCachedExternalResourceResult('M', signal());
    expect(out).toEqual(updated);
  });

  it('round-trips an enriched PDB candidate list with RCSB reconcile metadata stamped', async () => {
    await setCachedExternalResourceResult('RBL', RCSB_CANDIDATE_RESULT, signal());
    const out = await getCachedExternalResourceResult('RBL', signal());
    expect(out).toEqual(RCSB_CANDIDATE_RESULT);
    expect(mockedGetByExternalId).toHaveBeenCalledTimes(2);
    expect(mockedGetByExternalId).toHaveBeenNthCalledWith(
      1,
      'rcsb',
      'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
      expect.anything()
    );
    expect(mockedGetByExternalId).toHaveBeenNthCalledWith(
      2,
      'rcsb',
      'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
      expect.anything()
    );
  });
});

describe('useExternalResourceCache — reconcile-on-read', () => {
  it('returns null and evicts when sidecar loses a row that WAS reconcile-stamped', async () => {
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());
    mockedGetByExternalId.mockResolvedValueOnce(null);
    const out = await getCachedExternalResourceResult('M', signal());
    expect(out).toBeNull();
    mockedGetByExternalId.mockResolvedValueOnce(SIDECAR_ROW_V1);
    const out2 = await getCachedExternalResourceResult('M', signal());
    expect(out2).toBeNull();
  });

  it('serves the cache (no eviction) when sidecar was unreachable at write time', async () => {
    mockedGetByExternalId.mockResolvedValueOnce(null);
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());

    mockedGetByExternalId.mockClear();
    const out = await getCachedExternalResourceResult('M', signal());

    expect(out).toEqual(UNIPROT_RESULT);
    expect(mockedGetByExternalId).not.toHaveBeenCalled();
  });

  it('returns null when sidecar reports a different versionIdentifier', async () => {
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());
    mockedGetByExternalId.mockResolvedValueOnce({
      ...SIDECAR_ROW_V1,
      versionIdentifier: '179',
    });
    const out = await getCachedExternalResourceResult('M', signal());
    expect(out).toBeNull();
  });

  it('returns null when sidecar reports a different etag', async () => {
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());
    mockedGetByExternalId.mockResolvedValueOnce({
      ...SIDECAR_ROW_V1,
      etag: 'W/"new-etag"',
    });
    const out = await getCachedExternalResourceResult('M', signal());
    expect(out).toBeNull();
  });

  it('returns the cached result when substrate version + etag match', async () => {
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());
    mockedGetByExternalId.mockResolvedValueOnce(SIDECAR_ROW_V1);
    const out = await getCachedExternalResourceResult('M', signal());
    expect(out).toEqual(UNIPROT_RESULT);
  });

  it('skips reconcile for PDB direct results (no substrate row in v1)', async () => {
    await setCachedExternalResourceResult('M', PDB_RESULT, signal());
    expect(mockedGetByExternalId).not.toHaveBeenCalled();
    const out = await getCachedExternalResourceResult('M', signal());
    expect(out).toEqual(PDB_RESULT);
    expect(mockedGetByExternalId).not.toHaveBeenCalled();
  });

  it('evicts an enriched PDB candidate list when the RCSB dependency is missing', async () => {
    await setCachedExternalResourceResult('RBL', RCSB_CANDIDATE_RESULT, signal());
    mockedGetByExternalId.mockResolvedValueOnce(null);
    const out = await getCachedExternalResourceResult('RBL', signal());
    expect(out).toBeNull();
  });
});

describe('useExternalResourceCache — IPC invalidation', () => {
  it('invalidateCacheByExternalIds evicts every entry whose tuple matches', async () => {
    await setCachedExternalResourceResult('M', UNIPROT_RESULT, signal());
    await setCachedExternalResourceResult('Q', PDB_RESULT, signal());
    await setCachedExternalResourceResult('RBL', RCSB_CANDIDATE_RESULT, signal());

    const evicted = await invalidateCacheByExternalIds([
      { provider: 'uniprot', externalId: 'P0AD86' },
      { provider: 'rcsb', externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B' },
    ]);
    expect(evicted).toBe(2);

    expect(await getCachedExternalResourceResult('M', signal())).toBeNull();
    expect(await getCachedExternalResourceResult('Q', signal())).toEqual(PDB_RESULT);
    expect(await getCachedExternalResourceResult('RBL', signal())).toBeNull();
  });

  it('returns 0 for an empty match list (no IndexedDB read on the hot path)', async () => {
    const evicted = await invalidateCacheByExternalIds([]);
    expect(evicted).toBe(0);
  });
});

describe('useExternalResourceCache — admin', () => {
  it('clearExternalResourceCache removes everything', async () => {
    await setCachedExternalResourceResult('A', UNIPROT_RESULT, signal());
    await setCachedExternalResourceResult('B', UNIPROT_RESULT, signal());
    expect((await getCachedExternalResourceKeys()).length).toBe(2);
    await clearExternalResourceCache();
    expect(await getCachedExternalResourceKeys()).toEqual([]);
  });

  it('preserves StructureRef variant on round-trip (PDB)', async () => {
    await setCachedExternalResourceResult('Q', PDB_RESULT, signal());
    const out = await getCachedExternalResourceResult('Q', signal());
    expect(out).toEqual(PDB_RESULT);
  });
});
