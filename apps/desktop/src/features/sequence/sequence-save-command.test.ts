import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSequenceStore } from './store';
import type { SequencePersistenceResult } from './persist-sequence-document';
import {
  saveSequenceDocumentWithCompletion,
  type SequenceDocumentSaveCompletion,
} from './complete-sequence-document-save';
import { SequenceDocumentSaveProjectionError } from '../../services/sequence-document-save-completion';

const mocks = vi.hoisted(() => ({
  persist: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  observe: vi.fn(() => true),
}));
vi.mock('./persist-sequence-document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./persist-sequence-document')>()),
  persistSequenceDocument: mocks.persist,
}));
vi.mock('../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: mocks.begin,
  observeWorkflowAction: mocks.observe,
}));

const document = { documentId: 'private-save-document', sourcePath: '/private/save/sequence.gb' };

function dirtyCapture() {
  useSequenceStore.getState().setSequence(document.documentId, {
    id: document.documentId,
    name: 'private-name',
    sequence: 'ATGC',
    length: 4,
    circular: false,
    annotations: [],
  });
  useSequenceStore.getState().dispatchEdit(document.documentId, { type: 'INSERT', text: 'A' });
  const capture = useSequenceStore.getState().captureForSave(document.documentId);
  if (!capture) throw new Error('Expected a dirty capture');
  return capture;
}

describe('sequence Save command observation', () => {
  beforeEach(() => {
    useSequenceStore.getState().clearAll();
    vi.clearAllMocks();
    mocks.begin.mockReturnValue({ complete: mocks.complete, fail: mocks.fail });
    mocks.persist.mockReset().mockImplementation(async (options) => {
      const capture = useSequenceStore.getState().captureForSave(document.documentId);
      if (!capture) throw new Error('Expected a capture');
      try {
        await options.onPersisted?.();
      } catch (error) {
        return {
          ok: false,
          outcome: 'failed',
          wrote: true,
          writtenRevision: capture.revision,
          attempts: 1,
          error: { code: 'completion_failed', cause: error },
        };
      }
      return {
        ok: true,
        outcome: 'saved',
        wrote: true,
        writtenRevision: capture.revision,
        attempts: 1,
      };
    });
  });

  it.each([false, true])(
    'reports an unchanged no-write Save when readOnly=%s without delivered value or Git completion',
    async (readOnly) => {
      const persistence = {
        ok: true,
        outcome: 'unchanged',
        attempts: 0,
        wrote: false,
      } satisfies SequencePersistenceResult;
      mocks.persist.mockResolvedValue(persistence);
      const complete = vi
        .fn<() => Promise<SequenceDocumentSaveCompletion>>()
        .mockResolvedValue({ status: 'committed', repositoryRoot: '/private/save' });

      const result = await saveSequenceDocumentWithCompletion({
        kind: 'write',
        document,
        readOnly,
        complete,
      });

      expect(result).toEqual({ persistence, publication: { status: 'not-attempted' } });
      expect(complete).not.toHaveBeenCalled();
      expect(mocks.begin).toHaveBeenCalledTimes(1);
      expect(mocks.complete).toHaveBeenCalledTimes(1);
      expect(mocks.complete).toHaveBeenCalledWith({
        attemptCount: 0,
        wrote: false,
        dirty: false,
        capturedRevision: 0,
        acknowledgedRevision: 0,
        revisionRelation: 'unchanged',
        recordWriteStatus: 'existing',
        recordHistoryStatus: 'not_attempted',
        recordProjectionStatus: 'not_attempted',
        valueDelivered: false,
        status: 'success',
        outcomeKind: 'unchanged',
      });
      expect(mocks.fail).not.toHaveBeenCalled();
    }
  );

  it('waits for typed Git completion and emits one terminal for the exact written revision', async () => {
    const capture = dirtyCapture();
    let finishCompletion: (value: SequenceDocumentSaveCompletion) => void = () => {
      throw new Error('Completion fixture has not been admitted');
    };
    const completion = new Promise<SequenceDocumentSaveCompletion>((resolve) => {
      finishCompletion = resolve;
    });
    const complete = vi.fn(() => completion);
    const saving = saveSequenceDocumentWithCompletion({ kind: 'write', document, complete });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    finishCompletion({ status: 'committed', repositoryRoot: '/private/save' });
    const result = await saving;
    expect(result.publication).toEqual({
      status: 'completed',
      completion: { status: 'committed', repositoryRoot: '/private/save' },
    });
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stateRevision: capture.revision,
        recordWriteStatus: 'written',
        recordHistoryStatus: 'committed',
        recordProjectionStatus: 'ready',
      })
    );
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.begin.mock.calls[0]?.[0]).not.toHaveProperty('nativeActionId');
  });

  it('reports a Git failure separately from a successful file Save', async () => {
    dirtyCapture();
    const error = new Error('private Git failure');
    const complete = vi
      .fn<() => Promise<SequenceDocumentSaveCompletion>>()
      .mockResolvedValue({ status: 'commit-failed', error });
    const result = await saveSequenceDocumentWithCompletion({ kind: 'write', document, complete });
    expect(result.persistence.ok).toBe(true);
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'saved',
        recordWriteStatus: 'written',
        recordHistoryStatus: 'failed',
        recordProjectionStatus: 'ready',
      })
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain(error.message);
  });

  it('retains committed Git through failed projection instead of claiming a failed file write', async () => {
    const capture = dirtyCapture();
    const error = new SequenceDocumentSaveProjectionError(
      { status: 'committed', repositoryRoot: '/private/save' },
      [{ stage: 'lims', error: new Error('private projection failure') }]
    );
    const complete = vi
      .fn<() => Promise<SequenceDocumentSaveCompletion>>()
      .mockRejectedValue(error);
    const result = await saveSequenceDocumentWithCompletion({ kind: 'write', document, complete });
    expect(result.publication).toEqual({
      status: 'projection-failed',
      completion: error.completion,
      error,
    });
    expect(mocks.fail).toHaveBeenCalledExactlyOnceWith(
      'completion_failed',
      expect.objectContaining({
        stateRevision: capture.revision,
        recordWriteStatus: 'written',
        recordHistoryStatus: 'committed',
        recordProjectionStatus: 'failed',
      })
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('types a pre-verdict Git exception as unconfirmed', async () => {
    dirtyCapture();
    const complete = vi
      .fn<() => Promise<SequenceDocumentSaveCompletion>>()
      .mockRejectedValue(new Error('private lookup failure'));
    await saveSequenceDocumentWithCompletion({ kind: 'write', document, complete });
    expect(mocks.fail).toHaveBeenCalledExactlyOnceWith(
      'completion_failed',
      expect.objectContaining({
        recordWriteStatus: 'written',
        recordHistoryStatus: 'unconfirmed',
        recordProjectionStatus: 'unconfirmed',
      })
    );
  });

  it('preserves the annotation required-result gate before the single Git completion', async () => {
    const requiredCapture = dirtyCapture();
    const failure = {
      ok: false,
      outcome: 'failed',
      attempts: 1,
      wrote: true,
      writtenRevision: requiredCapture.revision,
      error: { code: 'required_save_not_completed', cause: new Error('unacknowledged capture') },
    };
    mocks.persist.mockResolvedValueOnce(failure);
    const complete = vi.fn<() => Promise<SequenceDocumentSaveCompletion>>();
    const result = await saveSequenceDocumentWithCompletion({
      kind: 'annotation-apply',
      document,
      requiredCapture,
      complete,
      observation: { kind: 'annotation', parentActionId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.persist.mock.calls[0]?.[0]).not.toHaveProperty('onPersisted');
    expect(result.publication).toEqual({ status: 'not-attempted' });
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workflowOrigin: 'projection',
        parentActionId: '11111111-1111-4111-8111-111111111111',
      })
    );
    expect(mocks.fail).toHaveBeenCalledExactlyOnceWith(
      'required_save_not_completed',
      expect.objectContaining({ recordHistoryStatus: 'not_attempted' })
    );
  });

  it('uses the result capture rather than a newer live working revision', async () => {
    const capture = dirtyCapture();
    const written: SequencePersistenceResult = {
      ok: true,
      outcome: 'saved',
      wrote: true,
      writtenRevision: capture.revision,
      attempts: 1,
    };
    mocks.persist.mockImplementationOnce(async (options) => {
      useSequenceStore.getState().dispatchEdit(document.documentId, { type: 'INSERT', text: 'T' });
      await options.onPersisted?.();
      return written;
    });
    await saveSequenceDocumentWithCompletion({
      kind: 'write',
      document,
      complete: async () => ({ status: 'not-a-repository' }),
    });
    expect(useSequenceStore.getState().getVersion(document.documentId)).toBeGreaterThan(
      capture.revision
    );
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stateRevision: capture.revision,
        recordHistoryStatus: 'not_applicable',
      })
    );
  });
});
