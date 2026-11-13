import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSequenceStore } from './store';
import { persistSequenceDocument } from './persist-sequence-document';

const { writeTextFile, saveSequenceDocument, exists, operation } = vi.hoisted(() => ({
  writeTextFile: vi.fn(),
  saveSequenceDocument: vi.fn(),
  exists: vi.fn(),
  operation: { complete: vi.fn(), fail: vi.fn(), cancel: vi.fn() },
}));

vi.mock('../../platform', () => ({
  platform: () => ({ fs: { writeTextFile, saveSequenceDocument, exists } }),
}));

vi.mock('../../lib/workflow-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workflow-telemetry')>()),
  beginWorkflowAction: vi.fn(() => ({ actionId: 'save-action', consumed: false, ...operation })),
}));

const { beginWorkflowAction } = await import('../../lib/workflow-telemetry');

const DOCUMENT_ID = 'sequence-save-telemetry';
const SOURCE_PATH = '/workspace/private-construct.gb';

describe('sequence save telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSequenceStore.getState().clearAll();
    writeTextFile.mockResolvedValue(undefined);
    saveSequenceDocument.mockResolvedValue({ status: 'unbound' });
    exists.mockResolvedValue(false);
    useSequenceStore.getState().setSequence(DOCUMENT_ID, {
      id: DOCUMENT_ID,
      name: 'private-construct',
      sequence: 'ATGCATGC',
      length: 8,
      circular: false,
      annotations: [],
    });
  });

  it('records a saved edit with bucketed base counts and no sequence content', async () => {
    useSequenceStore.getState().replaceBases(DOCUMENT_ID, 2, 2, 'GGG');

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });

    expect(result.ok).toBe(true);
    expect(beginWorkflowAction).toHaveBeenCalledWith({ workflow: 'sequence_edit', action: 'save' });
    expect(operation.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'saved',
        basesInsertedBucket: '2_5',
        basesDeletedBucket: '0',
        saveAttemptCount: 1,
      })
    );
    const sent = JSON.stringify(vi.mocked(operation.complete).mock.calls);
    expect(sent).not.toContain('GGG');
    expect(sent).not.toContain('private-construct');
  });

  it('records a failed save with its persistence error code', async () => {
    useSequenceStore.getState().replaceBases(DOCUMENT_ID, 0, 1, '');
    writeTextFile.mockRejectedValue(new Error('EACCES /workspace/private-construct.gb'));

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });

    expect(result.ok).toBe(false);
    expect(operation.fail).toHaveBeenCalledWith(
      'write_failed',
      expect.objectContaining({ status: 'failed', saveAttemptCount: 1 })
    );
    expect(JSON.stringify(vi.mocked(operation.fail).mock.calls)).not.toContain('private');
  });

  it('records nothing when there is nothing to save', async () => {
    await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });
    expect(beginWorkflowAction).not.toHaveBeenCalled();
  });
});
