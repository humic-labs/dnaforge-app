import { describe, expect, it, vi } from 'vitest';

import {
  createManagedGenomeIndexRunner,
  genomeIndexInputRevision,
  genomeIndexSubmissionKey,
  genomeIndexSubjectId,
  type ManagedGenomeIndexApi,
  type ManagedGenomeIndexInput,
} from './managed-genome-index-operation';

const input: ManagedGenomeIndexInput = {
  input: '/workspace/reference.gbff',
  outputDir: '/workspace/.waypoint/genome-index/reference-v1',
  name: 'reference',
  workspaceRoot: '/workspace',
};

function snapshot(state: string, error: { code: string; message: string } | null = null) {
  return {
    id: 'operation-1',
    kind: 'genome-indexing',
    state,
    error,
  };
}

function catalog() {
  return {
    scope_id: 'workspace-scope',
    kinds: [
      {
        kind: 'genome-indexing',
        executable: true,
        surfaces: { http_start: '/operations/genome-indexing' },
      },
    ],
  };
}

function mockApi(responses: unknown[]) {
  const take = (): unknown => {
    const response = responses.shift();
    if (response === undefined) throw new Error('No mock managed-operation response remains.');
    return response;
  };

  return {
    discover: vi.fn(async (_signal?: AbortSignal) => take()),
    start: vi.fn(async (_submission: Parameters<ManagedGenomeIndexApi['start']>[0]) => take()),
    get: vi.fn(async (_operationId: string, _signal?: AbortSignal) => take()),
    getResult: vi.fn(async (_operationId: string, _signal?: AbortSignal) => take()),
  } satisfies ManagedGenomeIndexApi;
}

describe('managed genome-index operation client', () => {
  it('uses one app-process submission identity for repeated observers of the same input', () => {
    const key = genomeIndexSubmissionKey(input, 'main-process-1');

    expect(genomeIndexSubmissionKey(input, 'main-process-1')).toBe(key);
    expect(genomeIndexSubmissionKey({ ...input, name: 'other' }, 'main-process-1')).not.toBe(key);
    expect(genomeIndexSubmissionKey(input, 'main-process-2')).not.toBe(key);
  });

  it('submits once, follows the durable operation, and returns its retained result', async () => {
    const responses = [
      catalog(),
      snapshot('queued'),
      snapshot('running'),
      snapshot('succeeded'),
      {
        operation_id: 'operation-1',
        kind: 'genome-indexing',
        result_schema_version: 1,
        status: 'available',
        result: {
          fastaPath: '/workspace/index/reference.fa.gz',
          faiPath: '/workspace/index/reference.fa.gz.fai',
          gffPath: '/workspace/index/reference.gff.gz',
          tbiPath: '/workspace/index/reference.gff.gz.tbi',
          metadata: {
            length: 1234,
            circular: false,
            featureCount: 8,
            annotationTypes: ['gene'],
            annotationRasterReady: true,
          },
        },
        error: null,
      },
    ];
    const api = mockApi(responses);
    const delay = vi.fn(async () => undefined);
    const run = createManagedGenomeIndexRunner({
      api,
      createSubmissionKey: () => 'submission-1',
      delay,
      pollIntervalMs: 1,
    });

    await expect(run(input)).resolves.toMatchObject({
      fastaPath: '/workspace/index/reference.fa.gz',
      metadata: { length: 1234, featureCount: 8 },
    });

    expect(api.discover).toHaveBeenCalledOnce();
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.getResult).toHaveBeenCalledWith('operation-1', undefined);
    expect(api.start.mock.calls[0]?.[0]).toEqual({
      submission_key: 'submission-1',
      subject: {
        scope_id: 'workspace-scope',
        subject_id: genomeIndexSubjectId(input),
        input_revision: genomeIndexInputRevision(input),
      },
      input,
    });
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('keeps observing the same operation after a temporary status transport failure', async () => {
    const responses = [
      catalog(),
      snapshot('queued'),
      snapshot('succeeded'),
      {
        operation_id: 'operation-1',
        kind: 'genome-indexing',
        result_schema_version: 1,
        status: 'available',
        result: {
          fastaPath: '/workspace/index/reference.fa.gz',
          faiPath: '/workspace/index/reference.fa.gz.fai',
          metadata: {
            length: 1234,
            circular: false,
            featureCount: 0,
            annotationTypes: [],
            annotationRasterReady: true,
          },
        },
        error: null,
      },
    ];
    const api = mockApi(responses);
    api.get.mockRejectedValueOnce(new TypeError('fetch failed'));
    const delay = vi.fn(async () => undefined);
    const run = createManagedGenomeIndexRunner({
      api,
      createSubmissionKey: () => 'submission-1',
      delay,
      pollIntervalMs: 1,
    });

    await expect(run(input)).resolves.toMatchObject({ metadata: { length: 1234 } });

    expect(api.start).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get.mock.calls.map(([operationId]) => operationId)).toEqual([
      'operation-1',
      'operation-1',
    ]);
    expect(api.getResult).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('reuses one submission key when a temporary failure loses the start response', async () => {
    const responses = [
      catalog(),
      snapshot('succeeded'),
      {
        operation_id: 'operation-1',
        kind: 'genome-indexing',
        result_schema_version: 1,
        status: 'available',
        result: {
          fastaPath: '/workspace/index/reference.fa.gz',
          faiPath: '/workspace/index/reference.fa.gz.fai',
          metadata: {
            length: 1234,
            circular: false,
            featureCount: 0,
            annotationTypes: [],
            annotationRasterReady: true,
          },
        },
        error: null,
      },
    ];
    const api = mockApi(responses);
    api.start.mockRejectedValueOnce(new TypeError('fetch failed'));
    const run = createManagedGenomeIndexRunner({
      api,
      createSubmissionKey: () => 'submission-1',
      delay: async () => undefined,
      pollIntervalMs: 1,
    });

    await expect(run(input)).resolves.toMatchObject({ metadata: { length: 1234 } });

    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls.map(([submission]) => submission.submission_key)).toEqual([
      'submission-1',
      'submission-1',
    ]);
  });

  it('does not retry a semantic client refusal', async () => {
    const api = mockApi([catalog(), snapshot('queued')]);
    api.get.mockRejectedValueOnce({
      status: 403,
      statusText: 'Forbidden',
      body: { detail: { message: 'Operation access was denied.' } },
    });
    const delay = vi.fn(async () => undefined);
    const run = createManagedGenomeIndexRunner({
      api,
      createSubmissionKey: () => 'submission-1',
      delay,
      pollIntervalMs: 1,
    });

    await expect(run(input)).rejects.toThrow('Operation access was denied.');
    expect(api.get).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledOnce();
  });

  it('stops observing on abort without sending an operation cancel request', async () => {
    const api = mockApi([catalog(), snapshot('queued')]);
    const delay = vi.fn(
      async (_milliseconds: number, signal?: AbortSignal): Promise<void> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
            { once: true }
          );
        })
    );
    const controller = new AbortController();
    const run = createManagedGenomeIndexRunner({
      api,
      createSubmissionKey: () => 'submission-1',
      delay,
      pollIntervalMs: 1,
    });

    const pending = run(input, controller.signal);
    await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.getResult).not.toHaveBeenCalled();
  });

  it('reports the durable operation failure without requesting another run', async () => {
    const responses = [
      catalog(),
      snapshot('queued'),
      snapshot('failed', {
        code: 'GENOME_INDEX_FAILED',
        message: 'The genome indexer could not read the source.',
      }),
    ];
    const api = mockApi(responses);
    const run = createManagedGenomeIndexRunner({
      api,
      createSubmissionKey: () => 'submission-1',
      delay: async () => undefined,
      pollIntervalMs: 1,
    });

    await expect(run(input)).rejects.toThrow('The genome indexer could not read the source.');
    expect(api.discover).toHaveBeenCalledOnce();
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenCalledOnce();
    expect(api.getResult).not.toHaveBeenCalled();
  });

  it('rotates its submission identity after a confirmed failure so a later open can retry', async () => {
    const responses = [
      catalog(),
      snapshot('failed', { code: 'GENOME_INDEX_FAILED', message: 'failed' }),
      catalog(),
      snapshot('succeeded'),
      {
        operation_id: 'operation-1',
        kind: 'genome-indexing',
        result_schema_version: 1,
        status: 'available',
        result: {
          fastaPath: '/workspace/index/reference.fa.gz',
          faiPath: '/workspace/index/reference.fa.gz.fai',
          metadata: {
            length: 1234,
            circular: false,
            featureCount: 0,
            annotationTypes: [],
            annotationRasterReady: true,
          },
        },
        error: null,
      },
    ];
    const api = mockApi(responses);
    const createAttemptId = vi
      .fn<() => string>()
      .mockReturnValueOnce('attempt-1')
      .mockReturnValueOnce('attempt-2');
    const run = createManagedGenomeIndexRunner({
      api,
      ownerInstanceId: 'main-process-1',
      createAttemptId,
      delay: async () => undefined,
      pollIntervalMs: 1,
    });

    await expect(run(input)).rejects.toThrow('failed');
    await expect(run(input)).resolves.toMatchObject({ metadata: { length: 1234 } });

    const keys = api.start.mock.calls.map(([submission]) => submission.submission_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(createAttemptId).toHaveBeenCalledTimes(2);
  });
});
