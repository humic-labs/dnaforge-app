import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSingleFileImportWrite } from './single-file-import-write';

const analyticsMocks = vi.hoisted(() => ({
  trackRendererEvent: vi.fn(),
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));
vi.mock('../../lib/analytics', () => analyticsMocks);

describe('File -> Import write telemetry boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits started then completed around a successful platform write', async () => {
    const result = await runSingleFileImportWrite({
      targetRoot: '/workspace',
      sourcePath: '/outside/patient-secret.gb',
      importFile: vi.fn(async () => ({
        destPath: '/workspace/patient-secret.gb',
        relPath: 'patient-secret.gb',
        committed: true,
      })),
    });

    expect(result.result.destPath).toBe('/workspace/patient-secret.gb');
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(analyticsMocks.trackRendererEvent.mock.calls.map(([event]) => event)).toEqual([
      'import_started',
      'import_completed',
    ]);
    const operationIds = analyticsMocks.trackRendererEvent.mock.calls.map(
      ([, properties]) => properties.operation_id
    );
    expect(operationIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(operationIds).size).toBe(1);
    expect(JSON.stringify(analyticsMocks.trackRendererEvent.mock.calls)).not.toContain(
      'patient-secret'
    );
  });

  it('emits failed but never completed when the platform write rejects', async () => {
    const original = new Error('disk full');

    await expect(
      runSingleFileImportWrite({
        targetRoot: '/workspace',
        sourcePath: '/outside/a.gb',
        importFile: vi.fn(async () => {
          throw original;
        }),
      })
    ).rejects.toBe(original);

    expect(analyticsMocks.trackRendererEvent.mock.calls.map(([event]) => event)).toEqual([
      'import_started',
      'import_failed',
    ]);
    expect(
      new Set(
        analyticsMocks.trackRendererEvent.mock.calls.map(
          ([, properties]) => properties.operation_id
        )
      ).size
    ).toBe(1);
  });

  it('counts every product produced by a multi-record sequence import', async () => {
    await runSingleFileImportWrite({
      targetRoot: '/workspace',
      sourcePath: '/outside/multi-record.fasta',
      importFile: vi.fn(async () => ({
        destPath: '/workspace/record-1.plasmid',
        relPath: 'record-1.plasmid',
        committed: true,
        packageProductPaths: [
          '/workspace/record-1.plasmid',
          '/workspace/record-2.plasmid',
          '/workspace/record-3.plasmid',
        ],
      })),
    });

    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith(
      'import_completed',
      expect.objectContaining({ record_count_bucket: '2_5' })
    );
  });

  it('does not misclassify a later open failure as a write failure', async () => {
    await runSingleFileImportWrite({
      targetRoot: '/workspace',
      sourcePath: '/outside/a.gb',
      importFile: vi.fn(async () => ({
        destPath: '/workspace/a.gb',
        relPath: 'a.gb',
        committed: true,
      })),
    });

    await expect(Promise.reject(new Error('tab open failed'))).rejects.toThrow('tab open failed');
    expect(analyticsMocks.trackRendererEvent.mock.calls.map(([event]) => event)).toEqual([
      'import_started',
      'import_completed',
    ]);
  });
});
