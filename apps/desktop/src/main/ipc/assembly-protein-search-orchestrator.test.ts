import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import type { AssemblyProteinSearchWorkerResult } from './assembly-protein-search-build';
import type { ProteinSearchCompilerWorkV1 } from './assembly-protein-search-compiler';
import { prepareAssemblyProteinSearchOnMiss } from './assembly-protein-search-orchestrator';
import { resolveAssemblyProteinSearchSourceRevisionV1 } from './assembly-protein-search-source';

const roots: string[] = [];
const QUARANTINED_WORK: ProteinSearchCompilerWorkV1 = {
  transcriptCount: 2,
  sourceTranslationCount: 1,
  derivedTranslationCount: 0,
  skippedEmptyTranslationCount: 0,
  quarantinedIsoformCount: 1,
  quarantinedIsoforms: [
    {
      chrom: 'chr1',
      source: 'RefSeq',
      isoformId: 'rna-malformed',
      reason: 'unknown-strand',
    },
  ],
  quarantineDiagnosticsTruncated: false,
};

async function sourceFixture(): Promise<AssemblyAnnotationSceneReadRequest> {
  const root = await mkdtemp(join(tmpdir(), 'waypoint-protein-orchestrator-'));
  roots.push(root);
  const gffPath = join(root, 'chr1.gff3.gz');
  const fastaPath = join(root, 'chr1.fa');
  await Promise.all([
    writeFile(gffPath, 'gff'),
    writeFile(`${gffPath}.tbi`, 'tbi'),
    writeFile(fastaPath, '>chr1\nACGT\n'),
    writeFile(`${fastaPath}.fai`, 'chr1\t4\t6\t4\t5\n'),
  ]);
  const manifest = {
    chrom: 'chr1',
    length: 4,
    fastaPath,
    faiPath: `${fastaPath}.fai`,
    gffPath,
    tbiPath: `${gffPath}.tbi`,
  };
  return {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'protein-orchestrator-test',
    workspaceRoot: root,
    chromosomes: [{ chrom: 'chr1', length: 4, sourcePath: gffPath, manifest }],
    scope: {
      kind: 'complete-assembly',
      placements: [{ chrom: 'chr1', length: 4, annotationCoverage: 'sourced' }],
    },
    datasetContract: {
      datasetId: 'protein-orchestrator-test',
      datasetVersion: 'v1',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {} as AssemblyAnnotationSceneReadRequest['artifact'],
    requestedPolicy: { isoformMode: 'canonical', laneLimit: null },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('assembly protein search orchestrator', () => {
  it('keeps the reference ready and explicitly reports committed quarantines', async () => {
    const request = await sourceFixture();
    const assertSafePath = vi.fn(async () => undefined);
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, {
      assertSafePath,
    });
    expect(revision).not.toBeNull();
    const compileInWorker = vi.fn(async () => ({
      status: 'committed' as const,
      featureCount: 1,
      byteCount: 128,
      work: QUARANTINED_WORK,
    }));
    const reportQuarantine = vi.fn();

    await expect(
      prepareAssemblyProteinSearchOnMiss(
        request,
        { status: 'miss', fingerprint: revision!.fingerprint },
        {
          assertSafePath,
          realpathImpl: async (path) => `/real${path}`,
          compileInWorker,
          workerTimeoutMs: 1_000,
          reportQuarantine,
        }
      )
    ).resolves.toEqual({ status: 'ready', fingerprint: revision!.fingerprint });

    expect(compileInWorker).toHaveBeenCalledOnce();
    expect(reportQuarantine).toHaveBeenCalledOnce();
    expect(reportQuarantine).toHaveBeenCalledWith(QUARANTINED_WORK);
  });

  it('terminates the compiler when the owning search-readiness task is cancelled', async () => {
    const request = await sourceFixture();
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, {
      assertSafePath: async () => undefined,
    });
    if (!revision) throw new Error('Expected a protein search revision');
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<Parameters<typeof prepareAssemblyProteinSearchOnMiss>[2]['compileInWorker']>
        >[0],
        options?: Parameters<
          NonNullable<Parameters<typeof prepareAssemblyProteinSearchOnMiss>[2]['compileInWorker']>
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
    const pending = prepareAssemblyProteinSearchOnMiss(
      request,
      { status: 'miss', fingerprint: revision.fingerprint },
      {
        assertSafePath: async () => undefined,
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
    const request = await sourceFixture();
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, {
      assertSafePath: async () => undefined,
    });
    if (!revision) throw new Error('Expected a protein search revision');
    const firstController = new AbortController();
    const secondController = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let resolveCompile!: (result: AssemblyProteinSearchWorkerResult) => void;
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<Parameters<typeof prepareAssemblyProteinSearchOnMiss>[2]['compileInWorker']>
        >[0],
        options?: Parameters<
          NonNullable<Parameters<typeof prepareAssemblyProteinSearchOnMiss>[2]['compileInWorker']>
        >[1]
      ) => {
        observedSignal = options?.signal;
        return new Promise<AssemblyProteinSearchWorkerResult>((resolve) => {
          resolveCompile = resolve;
        });
      }
    );
    const miss = { status: 'miss' as const, fingerprint: revision.fingerprint };
    const deps = {
      assertSafePath: async () => undefined,
      realpathImpl: async (path: string) => `/real${path}`,
      compileInWorker,
      workerTimeoutMs: 1_000,
    };
    const first = prepareAssemblyProteinSearchOnMiss(request, miss, deps, {
      signal: firstController.signal,
    });
    const second = prepareAssemblyProteinSearchOnMiss(request, miss, deps, {
      signal: secondController.signal,
    });
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(compileInWorker).toHaveBeenCalledOnce());

    firstController.abort();
    expect(observedSignal?.aborted).toBe(false);

    resolveCompile({
      status: 'committed',
      featureCount: 1,
      byteCount: 128,
      work: {
        transcriptCount: 1,
        sourceTranslationCount: 1,
        derivedTranslationCount: 0,
        skippedEmptyTranslationCount: 0,
        quarantinedIsoformCount: 0,
        quarantinedIsoforms: [],
        quarantineDiagnosticsTruncated: false,
      },
    });
    await firstRejected;
    await expect(second).resolves.toEqual({ status: 'ready', fingerprint: miss.fingerprint });
    expect(observedSignal?.aborted).toBe(false);
  });

  it('returns timeout while retaining a non-cooperative compiler until physical settlement', async () => {
    const request = await sourceFixture();
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, {
      assertSafePath: async () => undefined,
    });
    if (!revision) throw new Error('Expected a protein search revision');
    let invocation = 0;
    let resolveFirst!: (result: AssemblyProteinSearchWorkerResult) => void;
    let observedSignal: AbortSignal | undefined;
    const cleanResult: AssemblyProteinSearchWorkerResult = {
      status: 'committed',
      featureCount: 1,
      byteCount: 128,
      work: {
        transcriptCount: 1,
        sourceTranslationCount: 1,
        derivedTranslationCount: 0,
        skippedEmptyTranslationCount: 0,
        quarantinedIsoformCount: 0,
        quarantinedIsoforms: [],
        quarantineDiagnosticsTruncated: false,
      },
    };
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<Parameters<typeof prepareAssemblyProteinSearchOnMiss>[2]['compileInWorker']>
        >[0],
        options?: Parameters<
          NonNullable<Parameters<typeof prepareAssemblyProteinSearchOnMiss>[2]['compileInWorker']>
        >[1]
      ) => {
        invocation += 1;
        observedSignal = options?.signal;
        if (invocation === 1) {
          return new Promise<AssemblyProteinSearchWorkerResult>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return cleanResult;
      }
    );
    const miss = { status: 'miss' as const, fingerprint: revision.fingerprint };
    const deps = {
      assertSafePath: async () => undefined,
      realpathImpl: async (path: string) => `/real${path}`,
      compileInWorker,
      workerTimeoutMs: 20,
    };

    const first = prepareAssemblyProteinSearchOnMiss(request, miss, deps);
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    const retryController = new AbortController();
    const retry = prepareAssemblyProteinSearchOnMiss(request, miss, deps, {
      signal: retryController.signal,
    });
    const retryRejected = expect(retry).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(compileInWorker).toHaveBeenCalledOnce();
    retryController.abort();

    resolveFirst(cleanResult);
    await firstRejected;
    await retryRejected;
    await expect(prepareAssemblyProteinSearchOnMiss(request, miss, deps)).resolves.toEqual({
      status: 'ready',
      fingerprint: miss.fingerprint,
    });
    expect(compileInWorker).toHaveBeenCalledTimes(2);
  });

  it('releases a canceled caller but does not replace its compiler before termination settles', async () => {
    const request = await sourceFixture();
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, {
      assertSafePath: async () => undefined,
    });
    if (!revision) throw new Error('Expected a protein search revision');
    const controller = new AbortController();
    let invocation = 0;
    let observedSignal: AbortSignal | undefined;
    let rejectFirst: ((error: Error) => void) | undefined;
    const compileInWorker = vi.fn(
      async (
        _job: Parameters<
          NonNullable<Parameters<typeof prepareAssemblyProteinSearchOnMiss>[2]['compileInWorker']>
        >[0],
        options?: Parameters<
          NonNullable<Parameters<typeof prepareAssemblyProteinSearchOnMiss>[2]['compileInWorker']>
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
          work: {
            transcriptCount: 1,
            sourceTranslationCount: 1,
            derivedTranslationCount: 0,
            skippedEmptyTranslationCount: 0,
            quarantinedIsoformCount: 0,
            quarantinedIsoforms: [],
            quarantineDiagnosticsTruncated: false,
          },
        };
      }
    );
    const miss = { status: 'miss' as const, fingerprint: revision.fingerprint };
    const deps = {
      assertSafePath: async () => undefined,
      realpathImpl: async (path: string) => `/real${path}`,
      compileInWorker,
      workerTimeoutMs: 1_000,
    };
    const first = prepareAssemblyProteinSearchOnMiss(request, miss, deps, {
      signal: controller.signal,
    });
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(compileInWorker).toHaveBeenCalledOnce());

    controller.abort();
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));

    const retry = prepareAssemblyProteinSearchOnMiss(request, miss, deps);
    await Promise.resolve();
    expect(compileInWorker).toHaveBeenCalledOnce();

    const abortError = new Error('first worker termination settled');
    abortError.name = 'AbortError';
    rejectFirst?.(abortError);

    await firstRejected;
    await expect(retry).resolves.toEqual({ status: 'ready', fingerprint: miss.fingerprint });
    expect(compileInWorker).toHaveBeenCalledTimes(2);
  });
});
