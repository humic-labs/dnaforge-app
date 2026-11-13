import type { BufferEncodingOption, ObjectEncodingOptions, PathLike } from 'node:fs';
import type { realpath } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyCompiledBroadRasterArtifactRequestV1,
} from '../../shared/indexed-genome';
import {
  AssemblyCompiledBroadRasterPreparationOrchestratorV1,
  type AssemblyCompiledBroadRasterSceneHitV1,
} from './assembly-compiled-broad-raster-orchestrator';
import type { AssemblyCompiledBroadRasterWorkerResultV1 } from './assembly-compiled-broad-raster-worker-job';

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

const SOURCE_FINGERPRINT = 'a'.repeat(24);
const PAYLOAD_SHA = 'b'.repeat(64);
const SURFACE_FINGERPRINT = 'c'.repeat(64);
const RESULT: AssemblyCompiledBroadRasterWorkerResultV1 = {
  status: 'published',
  sourceFingerprint: SOURCE_FINGERPRINT,
  surfaceManifestFingerprint: SURFACE_FINGERPRINT,
  catalogFingerprint: 'd'.repeat(64),
  quarantinedCorruptArtifact: false,
};

const REQUEST = {
  workspaceRoot: '/ws',
  assemblyId: 'grch38',
  chromosomes: [{ chrom: 'chr1', sourcePath: '/ws/chr1.gff3.gz', length: 1_000 }],
  scope: {
    kind: 'complete-assembly',
    placements: [{ chrom: 'chr1', length: 1_000, annotationCoverage: 'sourced' }],
  },
  datasetContract: {
    datasetId: 'grch38-refseq',
    datasetVersion: '1',
    sourceSha256: 'e'.repeat(64),
  },
  artifact: {
    artifactKey: 'mRNA:light',
    themeMode: 'light',
    trackType: 'mRNA',
    partitionSpanBp: 1_000,
    annotationBarHeightPx: 14,
    laneAlgorithmToken: 'lane',
    mapperContractToken: 'mapper',
    geometryContractToken: 'geometry',
    interactionContractToken: 'interaction',
  },
  requestedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
} as unknown as AssemblyAnnotationSceneReadRequest;

const HIT = {
  request: REQUEST,
  sourceFingerprint: SOURCE_FINGERPRINT,
  scenePath: '/ws/scene.bin',
  payloadSha256: PAYLOAD_SHA,
  sceneManifest: {
    integrity: { payloadSha256: PAYLOAD_SHA, contractSha256: 'f'.repeat(64) },
  },
} as AssemblyCompiledBroadRasterSceneHitV1;

const MANIFEST_REQUEST = {
  contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  scene: REQUEST,
  surfaceManifestFingerprint: SURFACE_FINGERPRINT,
} as AssemblyCompiledBroadRasterArtifactRequestV1;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function dependencies(
  prepareInWorker: ReturnType<typeof vi.fn>,
  overrides: { now?: () => number } = {}
) {
  return {
    assertSafePath: vi.fn(async () => {}),
    realpathImpl: realpathFake(async (path) => path),
    buildSurfaceManifest: vi.fn(async () => ({
      manifestFingerprint: SURFACE_FINGERPRINT,
    })) as never,
    prepareInWorker,
    retryBaseDelayMs: 2_000,
    retryMaxDelayMs: 30_000,
    ...overrides,
  };
}

describe('background compiled broad raster orchestration', () => {
  it('resolves the index-time transaction only after exact catalog publication and reuses the result', async () => {
    const pending = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    const prepareInWorker = vi.fn(() => pending.promise);
    const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1(
      dependencies(prepareInWorker)
    );

    const first = orchestrator.ensureSceneHit(HIT);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    pending.resolve(RESULT);
    await expect(first).resolves.toEqual(RESULT);
    await expect(orchestrator.ensureSceneHit(HIT)).resolves.toEqual(RESULT);
    expect(prepareInWorker).toHaveBeenCalledTimes(1);
  });

  it('returns from an exact scene hit while the finite worker remains pending', async () => {
    const pending = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    const prepareInWorker = vi.fn(() => pending.promise);
    const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1(
      dependencies(prepareInWorker)
    );

    expect(orchestrator.scheduleSceneHit(HIT)).toBeUndefined();
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(1));
    expect(orchestrator.snapshot(REQUEST).status).toBe('running');

    pending.resolve(RESULT);
    await vi.waitFor(() => expect(orchestrator.snapshot(REQUEST).status).toBe('succeeded'));
  });

  it('keeps light and dark large-scene workers in one singleton lane while scheduling stays immediate', async () => {
    const first = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    const second = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    let active = 0;
    let peakActive = 0;
    const prepareInWorker = vi
      .fn()
      .mockImplementationOnce(async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          return await first.promise;
        } finally {
          active -= 1;
        }
      })
      .mockImplementationOnce(async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          return await second.promise;
        } finally {
          active -= 1;
        }
      });
    const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1(
      dependencies(prepareInWorker)
    );
    const darkRequest = {
      ...REQUEST,
      artifact: {
        ...REQUEST.artifact,
        artifactKey: 'mRNA:dark',
        themeMode: 'dark' as const,
      },
    };
    const darkHit = { ...HIT, request: darkRequest };

    expect(orchestrator.scheduleSceneHit(HIT)).toBeUndefined();
    expect(orchestrator.scheduleSceneHit(darkHit)).toBeUndefined();
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(1));
    expect(orchestrator.snapshot(darkRequest).status).toBe('initializing');
    expect(peakActive).toBe(1);

    first.resolve(RESULT);
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(2));
    expect(peakActive).toBe(1);
    second.resolve(RESULT);
    await vi.waitFor(() => expect(orchestrator.snapshot(darkRequest).status).toBe('succeeded'));
    expect(peakActive).toBe(1);
  });

  it('keeps the coalesced singleton worker queue finitely bounded', async () => {
    const first = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    const prepareInWorker = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(RESULT);
    const reportFailure = vi.fn();
    const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1({
      ...dependencies(prepareInWorker),
      reportFailure,
    });

    for (let index = 0; index < 17; index += 1) {
      const request = {
        ...REQUEST,
        artifact: {
          ...REQUEST.artifact,
          artifactKey: `mRNA:light:${index}`,
        },
      };
      orchestrator.scheduleSceneHit({ ...HIT, request });
    }
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(1));
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('at capacity') }),
      expect.any(Object)
    );

    first.resolve(RESULT);
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(16));
  });

  it('converges a missing companion once and gives a second scene hit zero worker work', async () => {
    const prepareInWorker = vi.fn(async () => RESULT);
    const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1(
      dependencies(prepareInWorker)
    );

    orchestrator.scheduleSceneHit(HIT);
    await vi.waitFor(() => expect(orchestrator.snapshot(REQUEST).status).toBe('succeeded'));
    expect(prepareInWorker).toHaveBeenCalledTimes(1);

    orchestrator.scheduleSceneHit({
      ...HIT,
      request: {
        ...REQUEST,
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 8 },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepareInWorker).toHaveBeenCalledTimes(1);
  });

  it('retries a known failed manifest job after backoff without duplicate workers', async () => {
    let now = 0;
    const first = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    const second = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    const prepareInWorker = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1(
      dependencies(prepareInWorker, { now: () => now })
    );

    orchestrator.scheduleSceneHit(HIT);
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(1));
    first.reject(new Error('worker crashed'));
    await vi.waitFor(() => expect(orchestrator.snapshot(REQUEST).status).toBe('failed'));

    orchestrator.retryKnownMissingManifest(MANIFEST_REQUEST);
    expect(prepareInWorker).toHaveBeenCalledTimes(1);
    now = 2_000;
    orchestrator.retryKnownMissingManifest(MANIFEST_REQUEST);
    orchestrator.retryKnownMissingManifest(MANIFEST_REQUEST);
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(2));
    expect(orchestrator.snapshot(REQUEST).status).toBe('running');

    second.resolve(RESULT);
    await vi.waitFor(() => expect(orchestrator.snapshot(REQUEST).status).toBe('succeeded'));
  });

  it('singleflights a cell-integrity repair and forces quarantine/rebuild', async () => {
    const first = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    const repair = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
    const prepareInWorker = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => repair.promise);
    const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1(
      dependencies(prepareInWorker)
    );

    orchestrator.scheduleSceneHit(HIT);
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(1));
    first.resolve(RESULT);
    await vi.waitFor(() => expect(orchestrator.snapshot(REQUEST).status).toBe('succeeded'));

    expect(orchestrator.repairKnownCorruptArtifact(MANIFEST_REQUEST)).toEqual({
      status: 'repairing',
      retryAfterMs: 100,
    });
    expect(orchestrator.repairKnownCorruptArtifact(MANIFEST_REQUEST)).toEqual({
      status: 'repairing',
      retryAfterMs: 250,
    });
    await vi.waitFor(() => expect(prepareInWorker).toHaveBeenCalledTimes(2));
    expect(prepareInWorker.mock.calls[1]?.[0]).toMatchObject({
      forceRebuildExistingArtifact: true,
    });
    repair.resolve(RESULT);
    await vi.waitFor(() => expect(orchestrator.snapshot(REQUEST).status).toBe('succeeded'));
  });

  it('keeps a legitimate repair running beyond three minutes and then converges', async () => {
    vi.useFakeTimers();
    try {
      const slowRepair = deferred<AssemblyCompiledBroadRasterWorkerResultV1>();
      const prepareInWorker = vi
        .fn()
        .mockResolvedValueOnce(RESULT)
        .mockImplementationOnce(() => slowRepair.promise);
      const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1({
        ...dependencies(prepareInWorker),
        workerTimeoutMs: 15 * 60_000,
      });

      orchestrator.scheduleSceneHit(HIT);
      await vi.advanceTimersByTimeAsync(0);
      expect(orchestrator.snapshot(REQUEST).status).toBe('succeeded');

      expect(orchestrator.repairKnownCorruptArtifact(MANIFEST_REQUEST)).toEqual({
        status: 'repairing',
        retryAfterMs: 100,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(orchestrator.snapshot(REQUEST)).toMatchObject({ status: 'running', attemptCount: 2 });
      expect(prepareInWorker).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(3 * 60_000 + 1);
      expect(orchestrator.snapshot(REQUEST)).toMatchObject({ status: 'running', attemptCount: 2 });
      expect(orchestrator.repairKnownCorruptArtifact(MANIFEST_REQUEST)).toEqual({
        status: 'repairing',
        retryAfterMs: 250,
      });
      expect(prepareInWorker).toHaveBeenCalledTimes(2);

      slowRepair.resolve(RESULT);
      await vi.advanceTimersByTimeAsync(0);
      expect(orchestrator.snapshot(REQUEST)).toMatchObject({
        status: 'succeeded',
        attemptCount: 2,
      });
      expect(prepareInWorker).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps repeated manifest-poll retries instead of creating a worker loop', async () => {
    let now = 0;
    const prepareInWorker = vi.fn(async () => {
      throw new Error('persistent compiler failure');
    });
    const orchestrator = new AssemblyCompiledBroadRasterPreparationOrchestratorV1(
      dependencies(prepareInWorker, { now: () => now })
    );

    orchestrator.scheduleSceneHit(HIT);
    await vi.waitFor(() => expect(orchestrator.snapshot(REQUEST).status).toBe('failed'));
    for (let expectedAttempts = 2; expectedAttempts <= 4; expectedAttempts += 1) {
      now += 1_000_000;
      orchestrator.retryKnownMissingManifest(MANIFEST_REQUEST);
      await vi.waitFor(() =>
        expect(orchestrator.snapshot(REQUEST)).toMatchObject({
          status: 'failed',
          attemptCount: expectedAttempts,
        })
      );
    }
    now += 1_000_000;
    for (let poll = 0; poll < 20; poll += 1) {
      orchestrator.retryKnownMissingManifest(MANIFEST_REQUEST);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepareInWorker).toHaveBeenCalledTimes(4);
    expect(orchestrator.repairKnownCorruptArtifact(MANIFEST_REQUEST)).toEqual({
      status: 'unavailable',
      reason: 'repair-exhausted',
    });
  });
});
