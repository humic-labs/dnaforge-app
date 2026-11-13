import { describe, expect, it, vi } from 'vitest';
import type { importRecordedAnnotationOperationOperationsAnnotationImportRecordedPostResponse } from '@waypoint/api-client';
import {
  recordSelectedAnnotationReceipt,
  type RecordedReceiptDependencies,
} from './record-annotation-receipt';

vi.mock('../../platform', () => ({ platform: vi.fn() }));
vi.mock('../../services/service-manager', () => ({ serviceManager: {} }));

const digest = 'a'.repeat(64);
const receipt = { input: { revision: `annotation-input-v1:sha256:${digest}` }, untrusted: true };
const runtime = { status: 'connected', scopeId: 'scope-a', ownerInstanceId: 'owner-a' };

function response(payload: unknown) {
  return {
    status: 200,
    headers: new Headers(),
    data: payload,
  } as importRecordedAnnotationOperationOperationsAnnotationImportRecordedPostResponse;
}

function setup() {
  const dependencies: RecordedReceiptDependencies = {
    runtime: vi.fn(() => runtime),
    pick: vi.fn(async () => '/outside workspace/run.json'),
    read: vi.fn(async () => new TextEncoder().encode(JSON.stringify(receipt))),
    submit: vi.fn(async () =>
      response({
        id: 'recorded-operation',
        state: 'succeeded',
        origin: 'recorded',
        subject: { scope_id: 'scope-a', subject_id: `recorded-input:${digest}` },
      })
    ),
  };
  return dependencies;
}

describe('manual recorded-run import', () => {
  it('sends the candidate to the owner for validation with a stable external subject', async () => {
    const dependencies = setup();
    await expect(recordSelectedAnnotationReceipt(dependencies)).resolves.toEqual({
      status: 'recorded',
      operationId: 'recorded-operation',
    });
    expect(dependencies.read).toHaveBeenCalledWith('/outside workspace/run.json', 16 * 1024 * 1024);
    expect(dependencies.submit).toHaveBeenCalledWith({
      subject: { scope_id: 'scope-a', subject_id: `recorded-input:${digest}` },
      receipt,
    });
  });

  it('cancels the picker without reading or recording anything', async () => {
    const dependencies = setup();
    vi.mocked(dependencies.pick).mockResolvedValue(null);
    await expect(recordSelectedAnnotationReceipt(dependencies)).resolves.toEqual({
      status: 'canceled',
    });
    expect(dependencies.read).not.toHaveBeenCalled();
    expect(dependencies.submit).not.toHaveBeenCalled();
  });

  it('rejects ordinary output files with a useful route to result import', async () => {
    const dependencies = setup();
    vi.mocked(dependencies.read).mockResolvedValue(new TextEncoder().encode('{"features":[]}'));
    await expect(recordSelectedAnnotationReceipt(dependencies)).rejects.toThrow('Annotations');
    expect(dependencies.submit).not.toHaveBeenCalled();
  });

  it('refuses a changed runtime before submission', async () => {
    const dependencies = setup();
    vi.mocked(dependencies.runtime)
      .mockReturnValueOnce(runtime)
      .mockReturnValue({ ...runtime, ownerInstanceId: 'replacement' });
    await expect(recordSelectedAnnotationReceipt(dependencies)).rejects.toThrow('while selecting');
    expect(dependencies.submit).not.toHaveBeenCalled();
  });

  it('reports uncertainty when the owner changes after submission without retrying', async () => {
    const dependencies = setup();
    vi.mocked(dependencies.runtime)
      .mockReturnValueOnce(runtime)
      .mockReturnValueOnce(runtime)
      .mockReturnValue({ ...runtime, ownerInstanceId: 'replacement' });
    await expect(recordSelectedAnnotationReceipt(dependencies)).rejects.toThrow('may be recorded');
    expect(dependencies.submit).toHaveBeenCalledTimes(1);
  });

  it('does not report a recorded run when the response omits its identity', async () => {
    const dependencies = setup();
    vi.mocked(dependencies.submit).mockResolvedValue(
      response({
        origin: 'recorded',
        state: 'succeeded',
        subject: { scope_id: 'scope-a', subject_id: `recorded-input:${digest}` },
      })
    );
    await expect(recordSelectedAnnotationReceipt(dependencies)).rejects.toThrow('did not confirm');
  });

  it('propagates owner validation failure without claiming or retrying a record', async () => {
    const dependencies = setup();
    vi.mocked(dependencies.submit).mockRejectedValue(new Error('Unsupported receipt schema'));
    await expect(recordSelectedAnnotationReceipt(dependencies)).rejects.toThrow(
      'Unsupported receipt'
    );
    expect(dependencies.submit).toHaveBeenCalledTimes(1);
  });
});
