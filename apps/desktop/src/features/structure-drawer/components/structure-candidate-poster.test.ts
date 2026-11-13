// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceManager } from '../../../services/service-manager';
import type { StructureCandidate } from '../types/structure-drawer';
const sidecarFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/sidecar-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/sidecar-session')>();
  return { ...actual, sidecarFetch: sidecarFetchMock };
});

import {
  _resetStructureCandidatePosterCacheForTesting,
  loadStructureCandidatePosterObjectUrl,
  prefetchStructureCandidatePosters,
  structureCandidatePosterAsset,
  structureCandidatePosterPrefetchUrls,
} from './structure-candidate-poster';

const TEST_ENV_API_URL = 'http://vite-api.test.invalid';
const TEST_RUNTIME_SIDECAR_URL = 'http://runtime-sidecar.test.invalid';
const POISON_SERVICE_MANAGER_URL = 'http://poison-service-manager.test.invalid';

const RCSB_CANDIDATE: StructureCandidate = {
  id: 'rcsb:RCSB:6ZU1:ENTRY:ENTITY:1:all',
  provider: 'pdb',
  structure: {
    kind: 'pdb',
    pdbId: '6ZU1',
    providerIdentityKey: 'RCSB:6ZU1:ENTRY:ENTITY:1',
    assemblyId: '2',
  },
  label: '6ZU1',
  group: 'rcsb',
  rank: 0,
  metadata: { pdbId: '6ZU1', title: 'E. coli ribosome complex' },
  provenance: { resolverSource: 'rcsb_sequence', identity: 1 },
};

const AFDB_CANDIDATE: StructureCandidate = {
  id: 'alphafold:P00880:all',
  provider: 'alphafold',
  structure: { kind: 'uniprot', accession: 'P00880' },
  label: 'P00880',
  group: 'alphafold',
  rank: 1,
  metadata: { uniprotAccession: 'P00880' },
  provenance: { resolverSource: 'protein_sequence', identity: 1 },
};

describe('structureCandidatePosterAsset', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', TEST_ENV_API_URL);
    sidecarFetchMock.mockReset();
  });

  afterEach(() => {
    _resetStructureCandidatePosterCacheForTesting();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    serviceManager.setBaseUrl(POISON_SERVICE_MANAGER_URL);
  });

  it('builds RCSB CDN assembly and fallback model image URLs', () => {
    expect(structureCandidatePosterAsset(RCSB_CANDIDATE)).toEqual({
      primaryUrl: `${TEST_ENV_API_URL}/external/structure/poster/pdb/6zu1/assembly-2`,
      fallbackUrl: `${TEST_ENV_API_URL}/external/structure/poster/pdb/6zu1/model-1`,
      primarySourceUrl: 'https://cdn.rcsb.org/images/structures/6zu1_assembly-2.jpeg',
      fallbackSourceUrl: 'https://cdn.rcsb.org/images/structures/6zu1_model-1.jpeg',
      providerLabel: 'RCSB PDB',
    });
  });

  it('does not capture the pre-platform service manager default port for poster URLs', () => {
    serviceManager.setBaseUrl(POISON_SERVICE_MANAGER_URL);

    expect(structureCandidatePosterAsset(RCSB_CANDIDATE)?.primaryUrl).toBe(
      `${TEST_ENV_API_URL}/external/structure/poster/pdb/6zu1/assembly-2`
    );
  });

  it('uses the runtime Electron sidecar URL when supplied by the caller', () => {
    expect(
      structureCandidatePosterAsset(RCSB_CANDIDATE, TEST_RUNTIME_SIDECAR_URL)?.primaryUrl
    ).toBe(`${TEST_RUNTIME_SIDECAR_URL}/external/structure/poster/pdb/6zu1/assembly-2`);
  });

  it('does not use the Electron-broken /poster/rcsb path for renderer RCSB poster fetches', () => {
    const asset = structureCandidatePosterAsset(RCSB_CANDIDATE, TEST_RUNTIME_SIDECAR_URL);

    expect(asset?.primaryUrl).toContain('/external/structure/poster/pdb/');
    expect(asset?.primaryUrl).not.toContain('/external/structure/poster/rcsb/');
    expect(asset?.fallbackUrl).toContain('/external/structure/poster/pdb/');
    expect(asset?.fallbackUrl).not.toContain('/external/structure/poster/rcsb/');
  });

  it('uses assembly 1 for PDB candidates without an explicit assembly', () => {
    expect(
      structureCandidatePosterAsset({
        ...RCSB_CANDIDATE,
        structure: { kind: 'pdb', pdbId: '1RBL' },
      })?.primaryUrl
    ).toBe(`${TEST_ENV_API_URL}/external/structure/poster/pdb/1rbl/assembly-1`);
  });

  it('uses assembly 1 for all-assembly candidates because the RCSB poster CDN expects a numeric assembly', () => {
    expect(
      structureCandidatePosterAsset({
        ...RCSB_CANDIDATE,
        structure: { kind: 'pdb', pdbId: '7NBU', assemblyId: 'all' },
      })?.primaryUrl
    ).toBe(`${TEST_ENV_API_URL}/external/structure/poster/pdb/7nbu/assembly-1`);
  });

  it('builds AlphaFold DB generated cartoon pLDDT poster URLs from versioned candidate identity', () => {
    const asset = structureCandidatePosterAsset(
      {
        ...AFDB_CANDIDATE,
        structure: {
          kind: 'uniprot',
          accession: 'P00880',
          fragment: 'F1',
          version: 'V6',
          modelId: 'AF-P00880-F1-model_v6',
        },
        provenance: {
          ...AFDB_CANDIDATE.provenance,
          structureIdentity: {
            kind: 'alphafold',
            providerIdentityKey: 'AF:P00880:F1:V6:MODEL:AF-P00880-F1-model_v6',
            accession: 'P00880',
            fragment: 'F1',
            version: 'V6',
            modelId: 'AF-P00880-F1-model_v6',
          },
        },
      },
      TEST_RUNTIME_SIDECAR_URL
    );

    expect(asset).toEqual({
      primaryUrl: `${TEST_RUNTIME_SIDECAR_URL}/external/structure/poster/alphafold/P00880/F1/v6?render=cartoon-plddt-v3`,
      primarySourceUrl: 'https://alphafold.ebi.ac.uk/files/AF-P00880-F1-model_v6.cif',
      providerLabel: 'AlphaFold DB',
    });
  });

  it('uses the latest AlphaFold poster route when a legacy candidate has no model version', () => {
    expect(structureCandidatePosterAsset(AFDB_CANDIDATE, TEST_RUNTIME_SIDECAR_URL)).toEqual({
      primaryUrl: `${TEST_RUNTIME_SIDECAR_URL}/external/structure/poster/alphafold/P00880/F1/latest?render=cartoon-plddt-v3`,
      primarySourceUrl: 'https://alphafold.ebi.ac.uk/entry/P00880',
      providerLabel: 'AlphaFold DB',
    });
  });

  it('builds a deduped poster prefetch URL list for provider-backed previews', () => {
    expect(structureCandidatePosterPrefetchUrls([RCSB_CANDIDATE, RCSB_CANDIDATE, AFDB_CANDIDATE]))
      .toMatchInlineSnapshot(`
        [
          "http://vite-api.test.invalid/external/structure/poster/pdb/6zu1/assembly-2",
          "http://vite-api.test.invalid/external/structure/poster/pdb/6zu1/model-1",
          "http://vite-api.test.invalid/external/structure/poster/alphafold/P00880/F1/latest?render=cartoon-plddt-v3",
        ]
      `);
  });

  it('bounds cached poster blobs without revoking object URLs still owned by consumers', async () => {
    const createObjectURL = vi.fn(
      (_blob: Blob) => `blob:poster-${createObjectURL.mock.calls.length}`
    );
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    sidecarFetchMock.mockImplementation(async () => ({
      ok: true,
      blob: async () => new Blob(['poster'], { type: 'image/png' }),
    }));

    const asset = (index: number) => ({
      primaryUrl: `http://sidecar.test/poster/${index}`,
      primarySourceUrl: `https://provider.test/poster/${index}`,
      providerLabel: 'Test',
    });

    const leases = [];
    for (let index = 0; index < 32; index += 1) {
      leases.push(await loadStructureCandidatePosterObjectUrl(asset(index)));
    }
    const firstAgain = await loadStructureCandidatePosterObjectUrl(asset(0));
    const added = await loadStructureCandidatePosterObjectUrl(asset(32));

    expect(firstAgain?.objectUrl).toBe('blob:poster-33');
    expect(added?.objectUrl).toBe('blob:poster-34');
    expect(sidecarFetchMock).toHaveBeenCalledTimes(33);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    firstAgain?.release();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:poster-33');
    firstAgain?.release();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);

    for (const lease of leases) lease?.release();
    added?.release();

    _resetStructureCandidatePosterCacheForTesting();
    const freshLease = await loadStructureCandidatePosterObjectUrl(asset(1));
    expect(sidecarFetchMock).toHaveBeenCalledTimes(34);
    freshLease?.release();
  });

  it('keeps a shared poster fetch alive until its last mounted consumer releases it', async () => {
    let transportSignal: AbortSignal | undefined;
    sidecarFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal ?? undefined;
          transportSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const asset = {
      primaryUrl: 'http://sidecar.test/poster/shared',
      primarySourceUrl: 'https://provider.test/poster/shared',
      providerLabel: 'Test',
    };
    const first = new AbortController();
    const second = new AbortController();

    const firstLoad = loadStructureCandidatePosterObjectUrl(asset, first.signal);
    const secondLoad = loadStructureCandidatePosterObjectUrl(asset, second.signal);
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledOnce());

    first.abort();
    await expect(firstLoad).resolves.toBeNull();
    expect(transportSignal?.aborted).toBe(false);

    second.abort();
    await expect(secondLoad).resolves.toBeNull();
    expect(transportSignal?.aborted).toBe(true);
  });

  it('retains poster capacity until a canceled transport actually settles', async () => {
    const transports: Array<{
      signal: AbortSignal;
      reject: (error: Error) => void;
    }> = [];
    sidecarFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('poster transport must be abortable');
          transports.push({ signal, reject });
        })
    );
    const controllers = Array.from({ length: 33 }, () => new AbortController());
    const loads = controllers.map((controller, index) =>
      loadStructureCandidatePosterObjectUrl(
        {
          primaryUrl: `http://sidecar.test/poster/slow-abort-${index}`,
          primarySourceUrl: `https://provider.test/poster/slow-abort-${index}`,
          providerLabel: 'Test',
        },
        controller.signal
      )
    );
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledTimes(32));

    controllers[0]?.abort();
    await expect(loads[0]).resolves.toBeNull();
    expect(transports[0]?.signal.aborted).toBe(true);
    expect(sidecarFetchMock).toHaveBeenCalledTimes(32);

    const abortError = new Error('transport cancellation settled');
    abortError.name = 'AbortError';
    transports[0]?.reject(abortError);
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledTimes(33));

    for (const controller of controllers.slice(1)) controller.abort();
    await expect(Promise.all(loads.slice(1))).resolves.toHaveLength(32);
  });

  it('retains poster capacity until an evicted prefetch transport actually settles', async () => {
    const transports: Array<{
      signal: AbortSignal;
      reject: (error: Error) => void;
    }> = [];
    sidecarFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('poster transport must be abortable');
          transports.push({ signal, reject });
        })
    );
    const prefetchCandidates = Array.from(
      { length: 32 },
      (_, index): StructureCandidate => ({
        ...AFDB_CANDIDATE,
        id: `alphafold:P${String(index).padStart(5, '0')}:all`,
        structure: {
          kind: 'uniprot',
          accession: `P${String(index).padStart(5, '0')}`,
        },
      })
    );
    prefetchStructureCandidatePosters(prefetchCandidates);
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledTimes(32));

    const consumerController = new AbortController();
    const consumerLoad = loadStructureCandidatePosterObjectUrl(
      {
        primaryUrl: 'http://sidecar.test/poster/consumer-after-prefetch',
        primarySourceUrl: 'https://provider.test/poster/consumer-after-prefetch',
        providerLabel: 'Test',
      },
      consumerController.signal
    );
    await vi.waitFor(() => expect(transports[0]?.signal.aborted).toBe(true));
    expect(sidecarFetchMock).toHaveBeenCalledTimes(32);

    const abortError = new Error('prefetch cancellation settled');
    abortError.name = 'AbortError';
    transports[0]?.reject(abortError);
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledTimes(33));

    consumerController.abort();
    await expect(consumerLoad).resolves.toBeNull();
  });

  it('does not start an unowned fallback fetch after its consumer aborts', async () => {
    sidecarFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const abort = new AbortController();
    const load = loadStructureCandidatePosterObjectUrl(
      {
        primaryUrl: 'http://sidecar.test/poster/primary',
        fallbackUrl: 'http://sidecar.test/poster/fallback',
        primarySourceUrl: 'https://provider.test/poster/primary',
        fallbackSourceUrl: 'https://provider.test/poster/fallback',
        providerLabel: 'Test',
      },
      abort.signal
    );
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledOnce());

    abort.abort();

    await expect(load).resolves.toBeNull();
    expect(sidecarFetchMock).toHaveBeenCalledOnce();
  });

  it('queues excess consumers without aborting a mounted poster', async () => {
    const transportSignals: AbortSignal[] = [];
    const resolveTransports: Array<(response: Response) => void> = [];
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:first-poster'),
      revokeObjectURL: vi.fn(),
    });
    sidecarFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('poster transport must be abortable');
          transportSignals.push(signal);
          resolveTransports.push(resolve);
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const controllers = Array.from({ length: 33 }, () => new AbortController());
    const loads = controllers.map((controller, index) =>
      loadStructureCandidatePosterObjectUrl(
        {
          primaryUrl: `http://sidecar.test/poster/pending-${index}`,
          primarySourceUrl: `https://provider.test/poster/pending-${index}`,
          providerLabel: 'Test',
        },
        controller.signal
      )
    );
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledTimes(32));

    expect(transportSignals.every((signal) => !signal.aborted)).toBe(true);
    resolveTransports[0]?.({
      ok: true,
      blob: async () => new Blob(['poster'], { type: 'image/png' }),
    } as Response);
    await expect(loads[0]).resolves.toMatchObject({ objectUrl: 'blob:first-poster' });
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledTimes(33));
    expect(transportSignals[0]?.aborted).toBe(false);
    expect(transportSignals.filter((signal) => !signal.aborted)).toHaveLength(33);

    for (const controller of controllers) controller.abort();
    await expect(Promise.all(loads)).resolves.toHaveLength(33);
  });

  it('removes an aborted consumer from the poster-capacity queue', async () => {
    const resolveTransports: Array<(response: Response) => void> = [];
    sidecarFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          resolveTransports.push(resolve);
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const activeControllers = Array.from({ length: 32 }, () => new AbortController());
    const activeLoads = activeControllers.map((controller, index) =>
      loadStructureCandidatePosterObjectUrl(
        {
          primaryUrl: `http://sidecar.test/poster/active-${index}`,
          primarySourceUrl: `https://provider.test/poster/active-${index}`,
          providerLabel: 'Test',
        },
        controller.signal
      )
    );
    const queuedController = new AbortController();
    const queuedLoad = loadStructureCandidatePosterObjectUrl(
      {
        primaryUrl: 'http://sidecar.test/poster/queued',
        primarySourceUrl: 'https://provider.test/poster/queued',
        providerLabel: 'Test',
      },
      queuedController.signal
    );
    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledTimes(32));

    queuedController.abort();
    await expect(queuedLoad).resolves.toBeNull();
    resolveTransports[0]?.({ ok: false } as Response);
    await expect(activeLoads[0]).resolves.toBeNull();
    await Promise.resolve();
    expect(sidecarFetchMock).toHaveBeenCalledTimes(32);

    for (const controller of activeControllers) controller.abort();
    await expect(Promise.all(activeLoads)).resolves.toHaveLength(32);
  });

  it('reports bounded queue overload distinctly and permits a later retry', async () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:retried-poster'),
      revokeObjectURL: vi.fn(),
    });
    sidecarFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const controllers = Array.from({ length: 97 }, () => new AbortController());
    const loads = controllers.map((controller, index) =>
      loadStructureCandidatePosterObjectUrl(
        {
          primaryUrl: `http://sidecar.test/poster/overload-${index}`,
          primarySourceUrl: `https://provider.test/poster/overload-${index}`,
          providerLabel: 'Test',
        },
        controller.signal
      )
    );

    await vi.waitFor(() => expect(sidecarFetchMock).toHaveBeenCalledTimes(32));
    await expect(loads[96]).rejects.toThrow('Structure poster request capacity queue is full');
    expect(sidecarFetchMock).toHaveBeenCalledTimes(32);

    for (const controller of controllers.slice(0, 96)) controller.abort();
    await expect(Promise.all(loads.slice(0, 96))).resolves.toHaveLength(96);

    sidecarFetchMock.mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(['poster'], { type: 'image/png' }),
    } as Response);
    const retry = await loadStructureCandidatePosterObjectUrl(
      {
        primaryUrl: 'http://sidecar.test/poster/overload-96',
        primarySourceUrl: 'https://provider.test/poster/overload-96',
        providerLabel: 'Test',
      },
      controllers[96]?.signal
    );
    expect(retry).not.toBeNull();
    retry?.release();
  });
});
