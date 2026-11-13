import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolverResult, StructureDrawerRequest } from '../types/structure-drawer';

vi.mock('./structure-resolver', () => ({
  resolveStructureRequest: vi.fn(),
}));

vi.mock('./sidecar-client', () => ({
  sidecarFetchUniProtEntry: vi.fn(),
}));

vi.mock('../hooks/useExternalResourceCache', () => ({
  deriveCacheKey: vi.fn(async () => 'cache-key'),
  getCachedExternalResourceResult: vi.fn(async () => null),
  setCachedExternalResourceResult: vi.fn(async () => undefined),
}));

vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ activeWorkspaceFile: undefined }),
  },
}));

import { resolveStructureRequest } from './structure-resolver';
import { sidecarFetchUniProtEntry } from './sidecar-client';
import {
  getCachedExternalResourceResult,
  setCachedExternalResourceResult,
} from '../hooks/useExternalResourceCache';
import { productionStructureResolver } from './production-structure-resolver';
import { useStructureDrawerStore } from '../state/use-structure-drawer-store';

const mockedResolve = vi.mocked(resolveStructureRequest);
const mockedGetCached = vi.mocked(getCachedExternalResourceResult);
const mockedSetCached = vi.mocked(setCachedExternalResourceResult);
const mockedFetchUniProt = vi.mocked(sidecarFetchUniProtEntry);

const REQUEST: StructureDrawerRequest = {
  translation: 'MTEST',
  hints: {},
};

const AF_ONLY_RETRY_RESULT: ResolverResult = {
  source: 'gene_sequence_overlap',
  identity: 1,
  structure: { kind: 'uniprot', accession: 'P69348' },
  recommendedCandidateId: 'alphafold:AF:P69348:F1:V6:MODEL:AF-P69348-F1-model_v6:all',
  candidates: [
    {
      id: 'alphafold:AF:P69348:F1:V6:MODEL:AF-P69348-F1-model_v6:all',
      provider: 'alphafold',
      structure: {
        kind: 'uniprot',
        accession: 'P69348',
        providerIdentityKey: 'AF:P69348:F1:V6:MODEL:AF-P69348-F1-model_v6',
        fragment: 'F1',
        version: 'V6',
        modelId: 'AF-P69348-F1-model_v6',
      },
      label: 'P69348',
      group: 'alphafold',
      rank: 0,
      metadata: { uniprotAccession: 'P69348', meanPlddt: 86.7 },
      provenance: { resolverSource: 'gene_sequence_overlap', identity: 1 },
    },
  ],
};

describe('productionStructureResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetCached.mockResolvedValue(null);
    useStructureDrawerStore.getState().setResolver(productionStructureResolver);
    useStructureDrawerStore.getState().close();
  });

  it('runs before any component mounts and survives drawer lifecycle reset', async () => {
    mockedResolve.mockResolvedValue(AF_ONLY_RETRY_RESULT);

    await useStructureDrawerStore.getState().open({ ...REQUEST, translation: 'MDEFAULTONE' });
    expect(useStructureDrawerStore.getState()).toMatchObject({
      status: 'rendering',
      error: null,
      resolved: AF_ONLY_RETRY_RESULT,
    });
    useStructureDrawerStore.getState().close();
    await useStructureDrawerStore.getState().open({ ...REQUEST, translation: 'MDEFAULTTWO' });

    expect(mockedResolve).toHaveBeenCalledTimes(2);
    expect(useStructureDrawerStore.getState()).toMatchObject({
      status: 'rendering',
      error: null,
      resolved: AF_ONLY_RETRY_RESULT,
    });
    expect(useStructureDrawerStore.getState()).not.toHaveProperty('_resolver');
  });

  it('does not persist skip-step retry fallbacks over the canonical candidate cache', async () => {
    mockedResolve.mockResolvedValue(AF_ONLY_RETRY_RESULT);
    const request: StructureDrawerRequest = {
      ...REQUEST,
      skipSteps: ['protein_sequence'],
    };

    const out = await productionStructureResolver(request, new AbortController().signal);
    await Promise.resolve();

    expect(out).toEqual({ result: AF_ONLY_RETRY_RESULT, cacheHit: false });
    expect(mockedGetCached).not.toHaveBeenCalled();
    expect(mockedResolve).toHaveBeenCalledWith(request, expect.anything(), {
      skipSteps: ['protein_sequence'],
    });
    expect(mockedSetCached).not.toHaveBeenCalled();
    expect(mockedFetchUniProt).not.toHaveBeenCalled();
  });
});
