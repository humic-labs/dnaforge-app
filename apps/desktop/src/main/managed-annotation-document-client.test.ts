// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { NativeAnnotationDocumentActionClient } from './managed-annotation-document-client';
import type { SidecarFetch } from './sidecar-request-auth';

function fixture(timeoutMs?: number) {
  const selection = {
    operationId: 'operation-1',
    targetDocumentId: 'document-1',
    expectedOperationVersion: 2,
    expectedResultSha256: `sha256:${'a'.repeat(64)}`,
    expectedTargetDocumentRevision: `annotation-document-v1:sha256:${'b'.repeat(64)}`,
    selectedCandidateIds: ['operation-1:0'],
  };
  const authority = {
    schema: 'dnaforge.managed-annotation-authority.v1',
    operation: {
      id: 'operation-1',
      kind: 'annotation',
      state: 'succeeded',
      result_status: 'available',
      version: 2,
      subject: {
        scope_id: 'runtime-a',
        subject_id: 'document-1',
        input_revision: 'input-revision',
      },
    },
    resultSha256: selection.expectedResultSha256,
    result: { features: [], sequence_length: 4 },
  };
  const fetch = vi.fn<SidecarFetch>(async () => Response.json(authority));
  const actionId = 'document-action-1';
  const requestSha256 = `sha256:${'c'.repeat(64)}`;
  const client = new NativeAnnotationDocumentActionClient({
    actionId,
    requestSha256,
    selection,
    fetch,
    timeoutMs,
  });
  const input = {
    actionId,
    selection,
    intent: {
      before_sha256: `sha256:${'1'.repeat(64)}`,
      after_sha256: `sha256:${'2'.repeat(64)}`,
      target_revision: `annotation-document-v1:sha256:${'3'.repeat(64)}`,
      selection_sha256: `sha256:${'4'.repeat(64)}`,
      selection_count: 1,
    },
  };
  const receipt = (outcome: string, details: Record<string, unknown>) => ({
    id: actionId,
    operation_id: selection.operationId,
    action: 'apply_to_document',
    outcome,
    details_json: {
      request_sha256: requestSha256,
      target_document_id: selection.targetDocumentId,
      ...details,
    },
  });
  return { client, fetch, authority, selection, actionId, requestSha256, input, receipt };
}

describe('native document action HTTP adapter', () => {
  it('bounds an unresponsive intent request and leaves its outcome uncertain without retrying', async () => {
    const f = fixture(5);
    f.fetch.mockImplementationOnce(async (_path, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('The native request has no deadline.');
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    await expect(f.client.recordWriteIntent(f.input)).rejects.toThrow(/timeout/i);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it('uses the admitted immutable selection when refreshing live authority', async () => {
    const f = fixture();
    f.selection.selectedCandidateIds.push('operation-1:1');
    const received = await f.client.authorize(f.selection);
    expect(received).toEqual(f.authority);
    expect(f.fetch.mock.calls[0][0]).toBe(
      '/internal/managed-documents/actions/document-action-1/authority'
    );
    expect(
      JSON.parse(String(f.fetch.mock.calls[0][1]?.body)).selection.selectedCandidateIds
    ).toEqual(['operation-1:0']);
  });

  it.each([
    null,
    {},
    { operation: {} },
    { schema: 'dnaforge.managed-annotation-authority.v1', operation: { subject: null } },
  ])('rejects malformed live authority before a file can use it', async (response) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(Response.json(response));
    await expect(f.client.authorize(f.selection)).rejects.toThrow(
      'valid current managed annotation authority'
    );
  });

  it.each(['permitted', 'existing'] as const)(
    'preserves the %s disposition without retrying a write intent',
    async (status) => {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(
        Response.json({
          status,
          record: f.receipt('document_writing', { write_intent: f.input.intent }),
        })
      );
      expect(await f.client.recordWriteIntent(f.input)).toEqual({ status });
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(JSON.parse(String(f.fetch.mock.calls[0][1]?.body))).toEqual({
        selection: f.selection,
        intent: f.input.intent,
      });
    }
  );

  it('treats a definite authority refusal differently from a lost acknowledgement', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      Response.json({ detail: { message: 'The grant was revoked.' } }, { status: 403 })
    );
    expect(await f.client.recordWriteIntent(f.input)).toEqual({
      status: 'refused',
      reason: 'The grant was revoked.',
    });
    f.fetch.mockRejectedValueOnce(new Error('connection lost after request'));
    await expect(f.client.recordWriteIntent(f.input)).rejects.toThrow('connection lost');
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not infer write permission from an unexpected response or a server failure', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(Response.json({ status: 'recorded' }));
    await expect(f.client.recordWriteIntent(f.input)).rejects.toThrow('write permission');
    f.fetch.mockResolvedValueOnce(
      Response.json({ detail: { message: 'commit response lost' } }, { status: 500 })
    );
    await expect(f.client.recordWriteIntent(f.input)).rejects.toThrow('commit response lost');
  });

  it('rejects retargeting before sending any private request', async () => {
    const f = fixture();
    await expect(
      f.client.recordWriteIntent({ ...f.input, actionId: 'other-action' })
    ).rejects.toThrow('admitted action');
    await expect(
      f.client.authorize({ ...f.selection, targetDocumentId: 'other-document' })
    ).rejects.toThrow('admitted action');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('requires the exact durable action receipt before accepting write permission', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(Response.json({ status: 'permitted' }));
    await expect(f.client.recordWriteIntent(f.input)).rejects.toThrow(
      'matching admitted action receipt'
    );
    f.fetch.mockResolvedValueOnce(
      Response.json({
        status: 'permitted',
        record: f.receipt('document_writing', {
          write_intent: { ...f.input.intent, after_sha256: `sha256:${'9'.repeat(64)}` },
        }),
      })
    );
    await expect(f.client.recordWriteIntent(f.input)).rejects.toThrow('intended file');
  });

  it('confirms an observed outcome under the original admitted request identity', async () => {
    const f = fixture();
    const settlement = {
      status: 'saved' as const,
      observed_sha256: f.input.intent.after_sha256,
      target_revision: f.input.intent.target_revision,
      checkpoint: { status: 'not-required' as const },
    };
    f.fetch.mockResolvedValueOnce(
      Response.json({ status: 'recorded', record: f.receipt('document_saved', { settlement }) })
    );
    expect(await f.client.settle(settlement)).toMatchObject({ status: 'recorded' });
    expect(JSON.parse(String(f.fetch.mock.calls[0][1]?.body))).toEqual({
      request_sha256: f.requestSha256,
      settlement,
    });
  });

  it('resends only the frozen outcome receipt once after a lost transport acknowledgement', async () => {
    const f = fixture();
    const settlement = {
      status: 'saved' as const,
      observed_sha256: f.input.intent.after_sha256,
      target_revision: f.input.intent.target_revision,
      checkpoint: { status: 'not-required' as const },
    };
    const observed = structuredClone(settlement);
    f.fetch.mockImplementationOnce(async () => {
      settlement.observed_sha256 = `sha256:${'9'.repeat(64)}`;
      throw new Error('connection lost after settlement');
    });
    f.fetch.mockResolvedValueOnce(
      Response.json({
        status: 'existing',
        record: f.receipt('document_saved', { settlement: observed }),
      })
    );
    expect(await f.client.settle(settlement)).toMatchObject({ status: 'existing' });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const calls = f.fetch.mock.calls;
    expect(calls[0][0]).toMatch(/\/settlement$/);
    expect(calls[1][0]).toBe(calls[0][0]);
    expect(calls[1][1]?.body).toBe(calls[0][1]?.body);
    expect(JSON.parse(String(calls[1][1]?.body)).settlement).toEqual(observed);
  });

  it('keeps an outcome unresolved after two lost receipt responses without further attempts', async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error('connection unavailable'));
    await expect(
      f.client.settle({ status: 'outcome-unresolved', reason: 'Unconfirmed publication.' })
    ).rejects.toThrow('connection unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('resends the receipt when its response body stream is lost', async () => {
    const f = fixture();
    const settlement = { status: 'blocked' as const, reason: 'No write was admitted.' };
    const response = Response.json({});
    vi.spyOn(response, 'json').mockRejectedValueOnce(new TypeError('body stream lost'));
    f.fetch.mockResolvedValueOnce(response);
    f.fetch.mockResolvedValueOnce(
      Response.json({
        status: 'existing',
        record: f.receipt('document_blocked', { settlement }),
      })
    );
    expect(await f.client.settle(settlement)).toMatchObject({ status: 'existing' });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['conflict', 'wrong-receipt', 'http-refusal', 'invalid-json', 'invalid-schema'])(
    'does not retry a %s settlement response',
    async (kind) => {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(
        kind === 'invalid-json'
          ? new Response('{')
          : kind === 'invalid-schema'
            ? Response.json({ status: 'unrecognized' })
            : kind === 'http-refusal'
              ? new Response(null, { status: 403 })
              : Response.json(
                  kind === 'conflict'
                    ? { status: 'conflict' }
                    : {
                        status: 'recorded',
                        record: f.receipt('document_saved', { settlement: { status: 'saved' } }),
                      }
                )
      );
      await expect(
        f.client.settle({ status: 'blocked', reason: 'No write was admitted.' })
      ).rejects.toThrow();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  );
});
