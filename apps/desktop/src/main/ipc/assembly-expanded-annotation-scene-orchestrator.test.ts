import type { BufferEncodingOption, ObjectEncodingOptions, PathLike } from 'node:fs';
import type { realpath } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
} from '@waypoint/genome-renderer/pure';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationSceneArtifactKey,
  type AssemblyAnnotationSceneMissResult,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import {
  compileFullGenomeExpandedAnnotationSceneOnMiss,
  isFullAssemblyAnnotationSceneRequest,
  prepareAssemblyAnnotationSceneOnMiss,
  prepareAssemblyAnnotationSceneSetOnMiss,
  readAssemblyAnnotationSceneTrackInventory,
} from './assembly-expanded-annotation-scene-orchestrator';

type SceneOrchestratorDeps = Parameters<typeof prepareAssemblyAnnotationSceneOnMiss>[2];
type SceneCompileInWorker = NonNullable<SceneOrchestratorDeps['compileInWorker']>;
type SceneInventoryInWorker = NonNullable<SceneOrchestratorDeps['inventoryInWorker']>;

function realpathFake(resolvePath: (path: string) => Promise<string>): typeof realpath {
  function fake(
    path: PathLike,
    options?: ObjectEncodingOptions | BufferEncoding | null
  ): Promise<string>;
  function fake(path: PathLike, options: BufferEncodingOption): Promise<Buffer>;
  function fake(
    path: PathLike,
    options?: ObjectEncodingOptions | BufferEncoding | null
  ): Promise<string | Buffer>;
  async function fake(
    path: PathLike,
    options?: ObjectEncodingOptions | BufferEncodingOption | BufferEncoding | null
  ): Promise<string | Buffer> {
    const resolved = await resolvePath(String(path));
    return options === 'buffer' || (typeof options === 'object' && options?.encoding === 'buffer')
      ? Buffer.from(resolved)
      : resolved;
  }
  return fake;
}

const SOURCE_SHA = 'a'.repeat(64);
const MISS: AssemblyAnnotationSceneMissResult = {
  status: 'miss',
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  fingerprint: 'b'.repeat(24),
  sourceBuildFingerprint: 'c'.repeat(64),
};

function request(
  overrides: Partial<AssemblyAnnotationSceneReadRequest> = {}
): AssemblyAnnotationSceneReadRequest {
  const chromosomes =
    overrides.chromosomes ??
    Array.from({ length: 24 }, (_, index) => ({
      chrom: index < 22 ? `chr${index + 1}` : index === 22 ? 'chrX' : 'chrY',
      sourcePath: `/ws/chr${index + 1}.gff3.gz`,
      length: 1_000,
    }));
  return {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'grch38',
    workspaceRoot: '/ws',
    scope: overrides.scope ?? {
      kind: 'complete-assembly',
      placements: chromosomes.map((chromosome) => ({
        chrom: chromosome.chrom,
        length: chromosome.length,
        annotationCoverage: chromosome.sourcePath == null ? 'unsourced' : 'sourced',
      })),
    },
    datasetContract: {
      datasetId: 'waypoint:assembly-annotation:grch38',
      datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
      sourceSha256: SOURCE_SHA,
    },
    artifact: {
      artifactKey: assemblyAnnotationSceneArtifactKey({
        themeMode: 'light',
        trackType: 'mRNA',
        partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
        annotationBarHeightPx: 14,
        laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
        mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
        geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
        interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
      }),
      themeMode: 'light',
      trackType: 'mRNA',
      partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    },
    requestedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
    ...overrides,
    chromosomes,
  };
}

describe('assembly annotation-scene cold-miss orchestration', () => {
  it('accepts every runtime policy for an ordered assembly and rejects incomplete authorization envelopes', () => {
    expect(isFullAssemblyAnnotationSceneRequest(request())).toBe(true);
    expect(
      isFullAssemblyAnnotationSceneRequest(
        request({ requestedPolicy: { isoformMode: 'canonical', laneLimit: 8 } })
      )
    ).toBe(true);
    expect(
      isFullAssemblyAnnotationSceneRequest(request({ chromosomes: [request().chromosomes[0]] }))
    ).toBe(true);
    const viewportChromosomes = request().chromosomes.slice(0, 2);
    expect(
      isFullAssemblyAnnotationSceneRequest(
        request({
          chromosomes: viewportChromosomes,
          scope: {
            kind: 'viewport-subset',
            placements: viewportChromosomes.map((chromosome) => ({
              chrom: chromosome.chrom,
              length: chromosome.length,
              annotationCoverage: 'sourced',
            })),
          },
        })
      )
    ).toBe(false);
    expect(
      isFullAssemblyAnnotationSceneRequest(
        request({
          chromosomes: request().chromosomes.map((chromosome, index) =>
            index === 23 ? { ...chromosome, chrom: 'chrX' } : chromosome
          ),
        })
      )
    ).toBe(false);
    expect(
      isFullAssemblyAnnotationSceneRequest(
        request({
          chromosomes: request().chromosomes.map((chromosome, index) =>
            index === 23 ? { ...chromosome, sourcePath: undefined } : chromosome
          ),
        })
      )
    ).toBe(true);
    expect(
      isFullAssemblyAnnotationSceneRequest(
        request({
          chromosomes: request().chromosomes.map((chromosome) => ({
            ...chromosome,
            sourcePath: undefined,
          })),
        })
      )
    ).toBe(false);
    expect(
      isFullAssemblyAnnotationSceneRequest(
        request({
          chromosomes: request().chromosomes.map((chromosome, index) =>
            index === 23 ? { ...chromosome, sourcePath: '   ' } : chromosome
          ),
        })
      )
    ).toBe(false);
  });

  it('authorizes only sourced chromosome paths in exact assembly order', async () => {
    const chromosomes = request().chromosomes.map((chromosome, index) =>
      index === 7 ? { ...chromosome, sourcePath: undefined } : chromosome
    );
    const compileInWorker = vi.fn<SceneCompileInWorker>(async () => ({
      status: 'committed' as const,
      featureCount: 10,
      droppedCount: 0,
      primitiveCount: 20,
      byteCount: 30,
    }));

    await expect(
      prepareAssemblyAnnotationSceneOnMiss(
        request({
          chromosomes,
          requestedPolicy: { isoformMode: 'canonical', laneLimit: 8 },
        }),
        MISS,
        {
          assertSafePath: async () => {},
          runtimeSourceBuildFingerprint: 'runtime-build',
          realpathImpl: realpathFake(async (path) => `/real${path}`),
          compileInWorker,
        }
      )
    ).resolves.toMatchObject({ status: 'committed' });

    const job = compileInWorker.mock.calls[0]?.[0];
    expect(job.request.requestedPolicy).toEqual({ isoformMode: 'canonical', laneLimit: 8 });
    expect(job.request.artifact).toEqual(request().artifact);
    expect(job.authorizedSourceRealPaths).toHaveLength(23);
    expect(job.authorizedSourceRealPaths.map(({ inputPath }) => inputPath)).toEqual(
      chromosomes.flatMap((chromosome) => (chromosome.sourcePath ? [chromosome.sourcePath] : []))
    );
  });

  it('reads source inventory only after authorizing the exact full-assembly inputs', async () => {
    const assertSafePath = vi.fn(async () => {});
    const inventoryInWorker = vi.fn(async () => ({
      status: 'ready' as const,
      trackTypes: ['gene', 'lnc_RNA', 'mRNA'],
    }));

    await expect(
      readAssemblyAnnotationSceneTrackInventory(request(), MISS, {
        assertSafePath,
        runtimeSourceBuildFingerprint: 'runtime-build',
        realpathImpl: realpathFake(async (path) => `/real${path}`),
        inventoryInWorker,
      })
    ).resolves.toEqual({ status: 'ready', trackTypes: ['gene', 'lnc_RNA', 'mRNA'] });

    expect(assertSafePath).toHaveBeenCalledTimes(24);
    expect(inventoryInWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ assemblyId: 'grch38' }),
        authorizedSourceRealPaths: expect.arrayContaining([
          { inputPath: '/ws/chr1.gff3.gz', realPath: '/real/ws/chr1.gff3.gz' },
        ]),
      })
    );
  });

  it('authorizes the complete explicit quartet before a manifest-backed inventory worker runs', async () => {
    const manifestRequest = request({
      chromosomes: [
        {
          chrom: 'chr1',
          sourcePath: '/idx/chr1.gff3.gz',
          length: 1_000,
          manifest: {
            chrom: 'chr1',
            fastaPath: '/idx/chr1.fa',
            faiPath: '/idx/chr1.fa.fai',
            gffPath: '/idx/chr1.gff3.gz',
            tbiPath: '/idx/chr1.gff3.gz.tbi',
            length: 1_000,
          },
        },
      ],
    });
    const assertSafePath = vi.fn<SceneOrchestratorDeps['assertSafePath']>(async () => {});
    const inventoryInWorker = vi.fn<SceneInventoryInWorker>(async () => ({
      status: 'ready' as const,
      trackTypes: ['mRNA'],
    }));

    await readAssemblyAnnotationSceneTrackInventory(manifestRequest, MISS, {
      assertSafePath,
      runtimeSourceBuildFingerprint: 'runtime-build',
      realpathImpl: realpathFake(async (path) => `/real${path}`),
      inventoryInWorker,
    });

    expect(assertSafePath.mock.calls.map(([path]) => path)).toEqual([
      '/idx/chr1.gff3.gz',
      '/idx/chr1.fa',
      '/idx/chr1.fa.fai',
      '/idx/chr1.gff3.gz.tbi',
    ]);
    expect(inventoryInWorker.mock.calls[0]?.[0].authorizedSourceRealPaths).toEqual([
      { inputPath: '/idx/chr1.gff3.gz', realPath: '/real/idx/chr1.gff3.gz' },
      { inputPath: '/idx/chr1.fa', realPath: '/real/idx/chr1.fa' },
      { inputPath: '/idx/chr1.fa.fai', realPath: '/real/idx/chr1.fa.fai' },
      { inputPath: '/idx/chr1.gff3.gz.tbi', realPath: '/real/idx/chr1.gff3.gz.tbi' },
    ]);
  });

  it('captures source paths and returns the committed revision without a payload re-read', async () => {
    const compileInWorker = vi.fn(async () => ({
      status: 'committed' as const,
      featureCount: 95_911,
      droppedCount: 35_342,
      primitiveCount: 2_492_041,
      byteCount: 123,
    }));
    const result = await compileFullGenomeExpandedAnnotationSceneOnMiss(request(), MISS, {
      assertSafePath: async () => {},
      runtimeSourceBuildFingerprint: 'runtime-build',
      realpathImpl: realpathFake(async (path) => `/real${path}`),
      compileInWorker,
    });

    expect(result).toEqual({
      status: 'committed',
      ipcContractVersion: MISS.ipcContractVersion,
      fingerprint: MISS.fingerprint,
      sourceBuildFingerprint: MISS.sourceBuildFingerprint,
    });
    expect(compileInWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedMiss: MISS,
        authorizedSourceRealPaths: expect.arrayContaining([
          { inputPath: '/ws/chr1.gff3.gz', realPath: '/real/ws/chr1.gff3.gz' },
        ]),
      }),
      { signal: expect.any(AbortSignal) }
    );
  });

  it('authorizes one source graph and returns one terminal revision per product-set track', async () => {
    const lncRequest = request({
      artifact: {
        ...request().artifact,
        trackType: 'lnc_RNA',
        artifactKey: assemblyAnnotationSceneArtifactKey({
          ...request().artifact,
          trackType: 'lnc_RNA',
        }),
      },
    });
    const compileSetInWorker = vi.fn(async ({ jobs }) => ({
      results: jobs.map(() => ({
        status: 'committed' as const,
        featureCount: 1,
        droppedCount: 0,
        primitiveCount: 1,
        byteCount: 1,
      })),
    }));
    await expect(
      prepareAssemblyAnnotationSceneSetOnMiss(
        [
          { request: request(), miss: MISS },
          {
            request: lncRequest,
            miss: { ...MISS, fingerprint: 'd'.repeat(24) },
          },
        ],
        {
          assertSafePath: async () => {},
          runtimeSourceBuildFingerprint: 'runtime-build',
          realpathImpl: realpathFake(async (path) => `/real${path}`),
          compileSetInWorker,
        }
      )
    ).resolves.toEqual([
      expect.objectContaining({ status: 'committed', fingerprint: MISS.fingerprint }),
      expect.objectContaining({ status: 'committed', fingerprint: 'd'.repeat(24) }),
    ]);
    expect(compileSetInWorker).toHaveBeenCalledTimes(1);
    expect(compileSetInWorker.mock.calls[0]?.[0].jobs).toHaveLength(2);
  });

  it('authorizes one re-probe after stale CAS and reports an absent feature cache', async () => {
    const staleCompile = vi.fn(async () => ({
      status: 'stale' as const,
      featureCount: 4,
      droppedCount: 1,
      primitiveCount: 8,
      byteCount: 100,
    }));
    await expect(
      compileFullGenomeExpandedAnnotationSceneOnMiss(request(), MISS, {
        assertSafePath: async () => {},
        runtimeSourceBuildFingerprint: 'runtime-build',
        realpathImpl: realpathFake(async (path) => path),
        compileInWorker: staleCompile,
      })
    ).resolves.toEqual({
      status: 'reprobe',
      reason: 'stale',
      ipcContractVersion: MISS.ipcContractVersion,
      fingerprint: MISS.fingerprint,
      sourceBuildFingerprint: MISS.sourceBuildFingerprint,
    });

    await expect(
      compileFullGenomeExpandedAnnotationSceneOnMiss(request(), MISS, {
        assertSafePath: async () => {},
        runtimeSourceBuildFingerprint: 'runtime-build',
        realpathImpl: realpathFake(async (path) => path),
        compileInWorker: async () => ({
          status: 'features-cache-miss',
          featureCount: 0,
          droppedCount: 0,
          primitiveCount: 0,
          byteCount: 0,
        }),
      })
    ).resolves.toEqual({
      status: 'unavailable',
      reason: 'source-unavailable',
      ipcContractVersion: MISS.ipcContractVersion,
      fingerprint: MISS.fingerprint,
      sourceBuildFingerprint: MISS.sourceBuildFingerprint,
    });

    await compileFullGenomeExpandedAnnotationSceneOnMiss(request(), MISS, {
      assertSafePath: async () => {},
      runtimeSourceBuildFingerprint: 'runtime-build',
      realpathImpl: realpathFake(async (path) => path),
      compileInWorker: staleCompile,
    });
    expect(staleCompile).toHaveBeenCalledTimes(2);
  });

  it('coalesces all eight runtime policies into one source compilation', async () => {
    const controller = new AbortController();
    let release!: (result: {
      status: 'committed';
      featureCount: number;
      droppedCount: number;
      primitiveCount: number;
      byteCount: number;
    }) => void;
    const compileInWorker = vi.fn(
      async () =>
        new Promise<{
          status: 'committed';
          featureCount: number;
          droppedCount: number;
          primitiveCount: number;
          byteCount: number;
        }>((resolve) => (release = resolve))
    );
    const deps = {
      assertSafePath: async () => {},
      runtimeSourceBuildFingerprint: 'runtime-build',
      realpathImpl: realpathFake(async (path) => path),
      compileInWorker,
    };
    const reads = (['canonical', 'expanded'] as const).flatMap((isoformMode) =>
      ([8, 12, 24, null] as const).map((laneLimit) =>
        compileFullGenomeExpandedAnnotationSceneOnMiss(
          request({ requestedPolicy: { isoformMode, laneLimit } }),
          MISS,
          deps
        )
      )
    );
    controller.abort();
    await vi.waitFor(() => expect(compileInWorker).toHaveBeenCalledOnce());
    release({
      status: 'committed',
      featureCount: 4,
      droppedCount: 1,
      primitiveCount: 8,
      byteCount: 100,
    });
    await expect(Promise.all(reads)).resolves.toHaveLength(8);
    expect(compileInWorker).toHaveBeenCalledOnce();
    await Promise.all(
      reads.map((read) => expect(read).resolves.toMatchObject({ status: 'committed' }))
    );
  });

  it('removes failed builds so a later exact-revision read can retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const compileInWorker = vi
      .fn()
      .mockRejectedValueOnce(new Error('worker failed'))
      .mockResolvedValueOnce({
        status: 'features-cache-miss',
        featureCount: 0,
        droppedCount: 0,
        primitiveCount: 0,
        byteCount: 0,
      });
    const deps = {
      assertSafePath: async () => {},
      runtimeSourceBuildFingerprint: 'runtime-build',
      realpathImpl: realpathFake(async (path) => path),
      compileInWorker,
    };
    await expect(
      compileFullGenomeExpandedAnnotationSceneOnMiss(request(), MISS, deps)
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'source-unavailable' });
    await expect(
      compileFullGenomeExpandedAnnotationSceneOnMiss(request(), MISS, deps)
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'source-unavailable' });
    expect(compileInWorker).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      '[assembly-annotation-scene] scene compilation failed',
      expect.objectContaining({
        assemblyId: 'grch38',
        trackType: 'mRNA',
        requestedIsoformMode: 'expanded',
        requestedLaneLimit: 12,
        error: 'Error: worker failed',
      })
    );
    consoleError.mockRestore();
  });

  it('terminates a worker that exceeds the hard deadline and clears the shared job', async () => {
    let observedSignal: AbortSignal | undefined;
    const compileInWorker = vi.fn(
      async (_job, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          observedSignal = options?.signal;
          options?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('worker aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })
    );
    const deps = {
      assertSafePath: async () => {},
      runtimeSourceBuildFingerprint: 'runtime-build',
      realpathImpl: realpathFake(async (path) => path),
      compileInWorker,
      workerTimeoutMs: 5,
    };

    await expect(prepareAssemblyAnnotationSceneOnMiss(request(), MISS, deps)).rejects.toMatchObject(
      { name: 'TimeoutError' }
    );
    expect(observedSignal?.aborted).toBe(true);

    await expect(prepareAssemblyAnnotationSceneOnMiss(request(), MISS, deps)).rejects.toMatchObject(
      { name: 'TimeoutError' }
    );
    expect(compileInWorker).toHaveBeenCalledTimes(2);
  });
});
