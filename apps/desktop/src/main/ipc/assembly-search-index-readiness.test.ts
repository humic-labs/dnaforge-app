import { describe, expect, it, vi } from 'vitest';

import type {
  AssemblyAnnotationSearchPrepareResult,
  AssemblyProteinSearchPrepareResult,
  AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import {
  AssemblySearchIndexReadinessCoordinatorV1,
  ensureAssemblySearchIndexesReadyV1,
  type AssemblySearchIndexReadinessDepsV1,
} from './assembly-search-index-readiness';

const request = {
  assemblyId: 'grch38',
  workspaceRoot: '/workspace',
} as AssemblyAnnotationSceneReadRequest;

function annotationHit(fingerprint = 'a'.repeat(24)) {
  return {
    status: 'hit' as const,
    fingerprint,
    byteCount: 101,
    payloadSha256: 'b'.repeat(64),
    manifest: {
      schema: 'prepacked-annotation-search-index.v1',
      featureCount: 42_731,
      searchContract: { contractToken: 'annotation-search-contract.v1' },
      integrity: {
        payloadSha256: 'b'.repeat(64),
        contractSha256: 'c'.repeat(64),
      },
    },
  };
}

function proteinHit(fingerprint = 'd'.repeat(24)) {
  return {
    status: 'hit' as const,
    fingerprint,
    byteCount: 202,
    payloadSha256: 'e'.repeat(64),
    manifest: {
      schema: 'prepacked-protein-search-index.v1',
      featureCount: 18_204,
      searchContract: { contractToken: 'protein-search-contract.v1' },
      integrity: {
        payloadSha256: 'e'.repeat(64),
        contractSha256: 'f'.repeat(64),
      },
    },
  };
}

function deps(
  overrides: Partial<AssemblySearchIndexReadinessDepsV1> = {}
): AssemblySearchIndexReadinessDepsV1 {
  return {
    readAnnotationSearch: vi.fn(async () => annotationHit()) as never,
    readAnnotationRevision: vi.fn(async () => annotationHit()) as never,
    migrateLegacyAnnotationSearch: vi.fn(async () => ({
      status: 'miss',
      fingerprint: 'a'.repeat(24),
    })) as never,
    prepareAnnotationSearch: vi.fn(async () => ({
      status: 'ready',
      fingerprint: 'a'.repeat(24),
    })) as never,
    readProteinSearch: vi.fn(async () => proteinHit()) as never,
    readProteinRevision: vi.fn(async () => proteinHit()) as never,
    prepareProteinSearch: vi.fn(async () => ({
      status: 'ready',
      fingerprint: 'd'.repeat(24),
    })) as never,
    ...overrides,
  };
}

describe('assembly search-index readiness', () => {
  it('fully verifies both exact search artifacts and returns durable receipts without rebuilding hits', async () => {
    const input = deps();

    await expect(ensureAssemblySearchIndexesReadyV1(request, input)).resolves.toEqual({
      annotationSearch: {
        fingerprint: 'a'.repeat(24),
        byteCount: 101,
        featureCount: 42_731,
        payloadSha256: 'b'.repeat(64),
        contractSha256: 'c'.repeat(64),
        schema: 'prepacked-annotation-search-index.v1',
        contractToken: 'annotation-search-contract.v1',
      },
      proteinSearch: {
        fingerprint: 'd'.repeat(24),
        byteCount: 202,
        featureCount: 18_204,
        payloadSha256: 'e'.repeat(64),
        contractSha256: 'f'.repeat(64),
        schema: 'prepacked-protein-search-index.v1',
        contractToken: 'protein-search-contract.v1',
      },
    });
    expect(input.prepareAnnotationSearch).not.toHaveBeenCalled();
    expect(input.prepareProteinSearch).not.toHaveBeenCalled();
  });

  it('automatically builds each missing artifact and admits only its full verified re-probe', async () => {
    const readAnnotationSearch = vi
      .fn()
      .mockResolvedValueOnce({ status: 'miss', fingerprint: 'a'.repeat(24) })
      .mockResolvedValueOnce(annotationHit());
    const readProteinSearch = vi
      .fn()
      .mockResolvedValueOnce({ status: 'miss', fingerprint: 'd'.repeat(24) })
      .mockResolvedValueOnce(proteinHit());
    const input = deps({
      readAnnotationSearch,
      readProteinSearch,
    });

    await expect(ensureAssemblySearchIndexesReadyV1(request, input)).resolves.toMatchObject({
      annotationSearch: { fingerprint: 'a'.repeat(24) },
      proteinSearch: { fingerprint: 'd'.repeat(24) },
    });
    expect(input.prepareAnnotationSearch).toHaveBeenCalledTimes(1);
    expect(input.prepareProteinSearch).toHaveBeenCalledTimes(1);
    expect(readAnnotationSearch).toHaveBeenCalledTimes(2);
    expect(readProteinSearch).toHaveBeenCalledTimes(2);
  });

  it('automatically migrates a legacy annotation index before compiling and fully verifies it', async () => {
    const readAnnotationSearch = vi
      .fn()
      .mockResolvedValueOnce({ status: 'miss', fingerprint: 'a'.repeat(24) })
      .mockResolvedValueOnce(annotationHit());
    const migrateLegacyAnnotationSearch = vi.fn(async () => annotationHit());
    const input = deps({
      readAnnotationSearch,
      migrateLegacyAnnotationSearch: migrateLegacyAnnotationSearch as never,
    });

    await expect(ensureAssemblySearchIndexesReadyV1(request, input)).resolves.toMatchObject({
      annotationSearch: { fingerprint: 'a'.repeat(24) },
    });
    expect(migrateLegacyAnnotationSearch).toHaveBeenCalledTimes(1);
    expect(input.prepareAnnotationSearch).not.toHaveBeenCalled();
    expect(readAnnotationSearch).toHaveBeenCalledTimes(2);
  });

  it('never reports ready when a build cannot publish a verified artifact', async () => {
    const unavailable: AssemblyProteinSearchPrepareResult = {
      status: 'unavailable',
      reason: 'source-unavailable',
    };
    const input = deps({
      readProteinSearch: vi.fn(async () => ({
        status: 'miss',
        fingerprint: 'd'.repeat(24),
      })) as never,
      prepareProteinSearch: vi.fn(async () => unavailable),
    });

    await expect(ensureAssemblySearchIndexesReadyV1(request, input)).rejects.toThrow(
      'Protein search index'
    );
  });

  it('rejects a source mutation between authority verification and the common final revision gate', async () => {
    const input = deps({
      readProteinRevision: vi.fn(async () => ({
        status: 'miss',
        fingerprint: '9'.repeat(24),
      })) as never,
    });

    await expect(ensureAssemblySearchIndexesReadyV1(request, input)).rejects.toThrow(
      'changed before readiness commit'
    );
  });

  it('rejects a stale build receipt instead of accepting a different source revision', async () => {
    const staleReady: AssemblyAnnotationSearchPrepareResult = {
      status: 'ready',
      fingerprint: '9'.repeat(24),
    };
    const input = deps({
      readAnnotationSearch: vi
        .fn()
        .mockResolvedValueOnce({ status: 'miss', fingerprint: 'a'.repeat(24) })
        .mockResolvedValueOnce(annotationHit('9'.repeat(24))) as never,
      prepareAnnotationSearch: vi.fn(async () => staleReady),
    });

    await expect(ensureAssemblySearchIndexesReadyV1(request, input)).rejects.toThrow(
      'source revision changed'
    );
  });

  it('reuses one full validation while exact source and payload identities remain unchanged', async () => {
    const input = deps();
    const coordinator = new AssemblySearchIndexReadinessCoordinatorV1(input);

    const first = await coordinator.ensure(request);
    const second = await coordinator.ensure(request);

    expect(second).toEqual(first);
    expect(input.readAnnotationSearch).toHaveBeenCalledTimes(1);
    expect(input.readProteinSearch).toHaveBeenCalledTimes(1);
    expect(input.readAnnotationRevision).toHaveBeenCalledTimes(4);
    expect(input.readProteinRevision).toHaveBeenCalledTimes(4);
  });

  it('shares one cold prepared-index payload verification across concurrent sessions', async () => {
    let releaseAnnotation: ((hit: ReturnType<typeof annotationHit>) => void) | undefined;
    const readAnnotationSearch = vi.fn(
      () =>
        new Promise<ReturnType<typeof annotationHit>>((resolve) => {
          releaseAnnotation = resolve;
        })
    );
    const input = deps({ readAnnotationSearch: readAnnotationSearch as never });
    const coordinator = new AssemblySearchIndexReadinessCoordinatorV1(input);

    const first = coordinator.verifyPrepared(request);
    const second = coordinator.verifyPrepared(request);
    await vi.waitFor(() => expect(readAnnotationSearch).toHaveBeenCalledOnce());
    releaseAnnotation?.(annotationHit());

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(input.readAnnotationSearch).toHaveBeenCalledTimes(1);
    expect(input.readProteinSearch).toHaveBeenCalledTimes(1);
  });

  it('keeps shared prepared-index verification alive until the final session cancels', async () => {
    let producerSignal: AbortSignal | undefined;
    const readAnnotationSearch = vi.fn(
      async (
        _request: AssemblyAnnotationSceneReadRequest,
        options?: { signal?: AbortSignal }
      ): Promise<ReturnType<typeof annotationHit>> => {
        producerSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('cancelled')),
            { once: true }
          );
        });
      }
    );
    const input = deps({ readAnnotationSearch: readAnnotationSearch as never });
    const coordinator = new AssemblySearchIndexReadinessCoordinatorV1(input);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = coordinator.verifyPrepared(request, { signal: firstController.signal });
    const second = coordinator.verifyPrepared(request, { signal: secondController.signal });
    await vi.waitFor(() => expect(readAnnotationSearch).toHaveBeenCalledOnce());

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(producerSignal?.aborted).toBe(false);

    secondController.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(producerSignal?.aborted).toBe(true);
  });

  it('waits for canceled verification to settle before starting a replacement producer', async () => {
    let invocation = 0;
    let producerSignal: AbortSignal | undefined;
    let rejectFirst: ((error: Error) => void) | undefined;
    const readAnnotationSearch = vi.fn(
      async (
        _request: AssemblyAnnotationSceneReadRequest,
        options?: { signal?: AbortSignal }
      ): Promise<ReturnType<typeof annotationHit>> => {
        invocation += 1;
        if (invocation === 1) {
          producerSignal = options?.signal;
          return new Promise((_resolve, reject) => {
            rejectFirst = (error) => reject(error);
          });
        }
        return annotationHit();
      }
    );
    const input = deps({ readAnnotationSearch: readAnnotationSearch as never });
    const coordinator = new AssemblySearchIndexReadinessCoordinatorV1(input);
    const firstController = new AbortController();

    const first = coordinator.verifyPrepared(request, { signal: firstController.signal });
    await vi.waitFor(() => expect(readAnnotationSearch).toHaveBeenCalledOnce());
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(producerSignal?.aborted).toBe(true);

    const retry = coordinator.verifyPrepared(request);
    await Promise.resolve();
    expect(readAnnotationSearch).toHaveBeenCalledOnce();

    const abortError = new Error('first verification finished aborting');
    abortError.name = 'AbortError';
    rejectFirst?.(abortError);

    await expect(retry).resolves.toMatchObject({
      annotationSearch: { fingerprint: 'a'.repeat(24) },
    });
    expect(readAnnotationSearch).toHaveBeenCalledTimes(2);
  });

  it('keeps a shared compiler alive until the last session waiter cancels', async () => {
    let producerSignal: AbortSignal | undefined;
    const prepareAnnotationSearch = vi.fn(
      async (
        _request: AssemblyAnnotationSceneReadRequest,
        _miss: unknown,
        options?: { signal?: AbortSignal }
      ): Promise<AssemblyAnnotationSearchPrepareResult> => {
        producerSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('cancelled')),
            { once: true }
          );
        });
      }
    );
    const input = deps({
      readAnnotationSearch: vi.fn(async () => ({
        status: 'miss',
        fingerprint: 'a'.repeat(24),
      })) as never,
      prepareAnnotationSearch,
    });
    const coordinator = new AssemblySearchIndexReadinessCoordinatorV1(input);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = coordinator.ensure(request, { signal: firstController.signal });
    const second = coordinator.ensure(request, { signal: secondController.signal });
    await vi.waitFor(() => expect(prepareAnnotationSearch).toHaveBeenCalledOnce());

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(producerSignal?.aborted).toBe(false);

    secondController.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(producerSignal?.aborted).toBe(true);
  });
});
