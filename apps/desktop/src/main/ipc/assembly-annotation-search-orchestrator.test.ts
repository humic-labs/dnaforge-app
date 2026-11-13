import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
} from '@waypoint/genome-renderer/pure';
import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import {
  indexedAnnotationSearchManifest,
  indexedQuartetPaths,
} from './assembly-annotation-search-compiler';
import { prepareAssemblyAnnotationSearchOnMiss } from './assembly-annotation-search-orchestrator';

type SearchOrchestratorDeps = Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2];
type SearchCompileInWorker = NonNullable<SearchOrchestratorDeps['compileInWorker']>;

function request(sourcePath = '/safe/chr11.gff3.gz'): AssemblyAnnotationSceneReadRequest {
  const chromosomes = [
    {
      chrom: 'chr11',
      length: 135_086_622,
      sourcePath,
      manifest: {
        chrom: 'chr11',
        length: 135_086_622,
        fastaPath: '/manifest/GRCh38.fa',
        faiPath: '/manifest/GRCh38.fa.fai',
        gffPath: sourcePath,
        tbiPath: '/manifest/GRCh38.annotations.explicit.tbi',
      },
    },
  ];
  return {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'GRCh38-search-orchestrator-test',
    chromosomes,
    scope: {
      kind: 'complete-assembly',
      placements: [{ chrom: 'chr11', length: 135_086_622, annotationCoverage: 'sourced' }],
    },
    workspaceRoot: '/safe',
    datasetContract: {
      datasetId: 'grch38-annotations',
      datasetVersion: 'test-v1',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {
      artifactKey: 'visual-policy-is-not-search-identity',
      themeMode: 'light',
      trackType: 'mRNA',
      partitionSpanBp: 1_048_576,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    },
    requestedPolicy: { isoformMode: 'canonical', laneLimit: 2 },
  };
}

describe('assembly annotation search orchestrator', () => {
  it('allows active preparation to outlive the watchdog while monotonic worker progress continues', async () => {
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[0],
        options?: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[1]
      ) => {
        for (let completed = 1; completed <= 4; completed += 1) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          options?.onProgress?.({
            sequence: completed,
            phase: 'reading-sources',
            completed,
            total: 4,
          });
        }
        return {
          status: 'committed' as const,
          featureCount: 1,
          byteCount: 128,
        };
      }
    );

    await expect(
      prepareAssemblyAnnotationSearchOnMiss(
        request(),
        { status: 'miss', fingerprint: 'd'.repeat(24) },
        {
          assertSafePath: async () => {},
          realpathImpl: async (path) => `/real${path}`,
          compileInWorker,
          workerTimeoutMs: 25,
        }
      )
    ).resolves.toEqual({ status: 'ready', fingerprint: 'd'.repeat(24) });
  });

  it('aborts a worker that makes no preparation progress', async () => {
    let observedSignal: AbortSignal | undefined;
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[0],
        options?: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[1]
      ) => {
        observedSignal = options?.signal;
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('worker observed abort')),
            { once: true }
          );
        });
        throw new Error('unreachable');
      }
    );

    await expect(
      prepareAssemblyAnnotationSearchOnMiss(
        request(),
        { status: 'miss', fingerprint: 'e'.repeat(24) },
        {
          assertSafePath: async () => {},
          realpathImpl: async (path) => `/real${path}`,
          compileInWorker,
          workerTimeoutMs: 20,
        }
      )
    ).rejects.toThrow('made no progress for 20 ms');
    expect(observedSignal?.aborted).toBe(true);
  });

  it('terminates the compiler when the owning search-readiness task is cancelled', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[0],
        options?: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[1]
      ) => {
        observedSignal = options?.signal;
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('cancelled')),
            { once: true }
          );
        });
      }
    );
    const pending = prepareAssemblyAnnotationSearchOnMiss(
      request(),
      { status: 'miss', fingerprint: 'f'.repeat(24) },
      {
        assertSafePath: async () => {},
        realpathImpl: async (path) => `/real${path}`,
        compileInWorker,
        workerTimeoutMs: 1_000,
      },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(compileInWorker).toHaveBeenCalledOnce());

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('keeps a shared compiler alive until its final independent caller leaves', async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let resolveCompile!: (result: {
      status: 'committed';
      featureCount: number;
      byteCount: number;
    }) => void;
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[0],
        options?: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[1]
      ) => {
        observedSignal = options?.signal;
        return new Promise<{
          status: 'committed';
          featureCount: number;
          byteCount: number;
        }>((resolve) => {
          resolveCompile = resolve;
        });
      }
    );
    const miss = { status: 'miss' as const, fingerprint: '2'.repeat(24) };
    const deps = {
      assertSafePath: async () => {},
      realpathImpl: async (path: string) => `/real${path}`,
      compileInWorker,
      workerTimeoutMs: 1_000,
    };
    const first = prepareAssemblyAnnotationSearchOnMiss(request(), miss, deps, {
      signal: firstController.signal,
    });
    const second = prepareAssemblyAnnotationSearchOnMiss(request(), miss, deps, {
      signal: secondController.signal,
    });
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(compileInWorker).toHaveBeenCalledOnce());

    firstController.abort();
    expect(observedSignal?.aborted).toBe(false);

    resolveCompile({ status: 'committed', featureCount: 1, byteCount: 128 });
    await firstRejected;
    await expect(second).resolves.toEqual({ status: 'ready', fingerprint: miss.fingerprint });
    expect(observedSignal?.aborted).toBe(false);
  });

  it('returns timeout while retaining a non-cooperative compiler until physical settlement', async () => {
    let invocation = 0;
    let resolveFirst!: (result: {
      status: 'committed';
      featureCount: number;
      byteCount: number;
    }) => void;
    let observedSignal: AbortSignal | undefined;
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[0],
        options?: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[1]
      ) => {
        invocation += 1;
        observedSignal = options?.signal;
        if (invocation === 1) {
          return new Promise<{
            status: 'committed';
            featureCount: number;
            byteCount: number;
          }>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { status: 'committed' as const, featureCount: 1, byteCount: 128 };
      }
    );
    const miss = { status: 'miss' as const, fingerprint: '3'.repeat(24) };
    const deps = {
      assertSafePath: async () => {},
      realpathImpl: async (path: string) => `/real${path}`,
      compileInWorker,
      workerTimeoutMs: 20,
    };

    const first = prepareAssemblyAnnotationSearchOnMiss(request(), miss, deps);
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    const retryController = new AbortController();
    const retry = prepareAssemblyAnnotationSearchOnMiss(request(), miss, deps, {
      signal: retryController.signal,
    });
    const retryRejected = expect(retry).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(compileInWorker).toHaveBeenCalledOnce();
    retryController.abort();

    resolveFirst({ status: 'committed', featureCount: 1, byteCount: 128 });
    await firstRejected;
    await retryRejected;
    await expect(prepareAssemblyAnnotationSearchOnMiss(request(), miss, deps)).resolves.toEqual({
      status: 'ready',
      fingerprint: miss.fingerprint,
    });
    expect(compileInWorker).toHaveBeenCalledTimes(2);
  });

  it('releases a canceled caller but does not replace its compiler before termination settles', async () => {
    const controller = new AbortController();
    let invocation = 0;
    let observedSignal: AbortSignal | undefined;
    let rejectFirst: ((error: Error) => void) | undefined;
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[0],
        options?: Parameters<
          NonNullable<
            Parameters<typeof prepareAssemblyAnnotationSearchOnMiss>[2]['compileInWorker']
          >
        >[1]
      ) => {
        invocation += 1;
        if (invocation === 1) {
          observedSignal = options?.signal;
          return new Promise<never>((_resolve, reject) => {
            rejectFirst = (error) => reject(error);
          });
        }
        return {
          status: 'committed' as const,
          featureCount: 1,
          byteCount: 128,
        };
      }
    );
    const miss = { status: 'miss' as const, fingerprint: '1'.repeat(24) };
    const deps = {
      assertSafePath: async () => {},
      realpathImpl: async (path: string) => `/real${path}`,
      compileInWorker,
      workerTimeoutMs: 1_000,
    };
    const first = prepareAssemblyAnnotationSearchOnMiss(request(), miss, deps, {
      signal: controller.signal,
    });
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(compileInWorker).toHaveBeenCalledOnce());

    controller.abort();
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));

    const retry = prepareAssemblyAnnotationSearchOnMiss(request(), miss, deps);
    await Promise.resolve();
    expect(compileInWorker).toHaveBeenCalledOnce();

    const abortError = new Error('first worker termination settled');
    abortError.name = 'AbortError';
    rejectFirst?.(abortError);

    await firstRejected;
    await expect(retry).resolves.toEqual({ status: 'ready', fingerprint: miss.fingerprint });
    expect(compileInWorker).toHaveBeenCalledTimes(2);
  });

  it('authorizes the exact existing indexed quartet before starting the worker', async () => {
    const assertSafePath = vi.fn<SearchOrchestratorDeps['assertSafePath']>(async () => {});
    const compileInWorker = vi.fn<SearchCompileInWorker>(async () => ({
      status: 'committed' as const,
      featureCount: 1,
      byteCount: 128,
    }));
    const sourceRequest = request();
    const directManifest = indexedAnnotationSearchManifest(sourceRequest.chromosomes[0]);
    if (!directManifest) throw new Error('test direct indexed quartet was not recognized');
    const directQuartet = indexedQuartetPaths(directManifest);

    await expect(
      prepareAssemblyAnnotationSearchOnMiss(
        sourceRequest,
        { status: 'miss', fingerprint: 'b'.repeat(24) },
        {
          assertSafePath,
          realpathImpl: async (path) => `/real${path}`,
          compileInWorker,
          workerTimeoutMs: 1_000,
        }
      )
    ).resolves.toEqual({ status: 'ready', fingerprint: 'b'.repeat(24) });

    const expectedInputs = directQuartet;
    expect(assertSafePath.mock.calls.map(([path]) => path)).toEqual(expectedInputs);
    expect(compileInWorker).toHaveBeenCalledOnce();
    expect(compileInWorker.mock.calls[0]?.[0].authorizedSourceRealPaths).toEqual(
      expectedInputs.map((inputPath) => ({ inputPath, realPath: `/real${inputPath}` }))
    );
  });

  it('never authorizes conventional guessed sidecars beside the GFF', async () => {
    const sourcePath = '/safe/catalog/chr11.gff3.gz';
    const sourceRequest = request(sourcePath);
    const directManifest = indexedAnnotationSearchManifest(sourceRequest.chromosomes[0]);
    if (!directManifest) throw new Error('test explicit manifest was not recognized');
    const directQuartet = indexedQuartetPaths(directManifest);
    const assertSafePath = vi.fn<SearchOrchestratorDeps['assertSafePath']>(async () => {});
    const realpathImpl = vi.fn(async (path: string) => `/real${path}`);
    const compileInWorker = vi.fn<SearchCompileInWorker>(async () => ({
      status: 'committed' as const,
      featureCount: 1,
      byteCount: 128,
    }));

    await expect(
      prepareAssemblyAnnotationSearchOnMiss(
        sourceRequest,
        { status: 'miss', fingerprint: 'c'.repeat(24) },
        {
          assertSafePath,
          realpathImpl,
          compileInWorker,
          workerTimeoutMs: 1_000,
        }
      )
    ).resolves.toEqual({ status: 'ready', fingerprint: 'c'.repeat(24) });

    expect(assertSafePath.mock.calls.map(([path]) => path)).toEqual(directQuartet);
    expect(realpathImpl.mock.calls.map(([path]) => path)).toEqual(directQuartet);
    expect(assertSafePath).not.toHaveBeenCalledWith('/safe/catalog/chr11.fa');
    expect(assertSafePath).not.toHaveBeenCalledWith('/safe/catalog/chr11.fa.fai');
    expect(assertSafePath).not.toHaveBeenCalledWith('/safe/catalog/chr11.gff3.gz.tbi');
    expect(compileInWorker.mock.calls[0]?.[0].authorizedSourceRealPaths).toEqual(
      directQuartet.map((inputPath) => ({ inputPath, realPath: `/real${inputPath}` }))
    );
  });
});
