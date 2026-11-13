import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSequenceStore } from './store';
import { rememberSequenceWrite, observeSequenceSavedReopen } from './sequence-activity';
const mocks = vi.hoisted(() => ({ observe: vi.fn(), hash: vi.fn() }));
vi.mock('../../lib/workflow-telemetry', () => ({ observeWorkflowAction: mocks.observe }));
vi.mock('../../platform', () => ({ platform: () => ({ fs: { sha256File: mocks.hash } }) }));

describe('sequence authority observations', () => {
  let id: string;
  beforeEach(() => {
    id = `private-document-${crypto.randomUUID()}`;
    useSequenceStore.getState().clearAll();
    useSequenceStore.getState().setSequence(id, {
      id,
      name: 'private scientific name',
      sequence: 'ATGC',
      length: 4,
      circular: false,
      annotations: [],
    });
    vi.clearAllMocks();
  });
  it('distinguishes cursor motion, accepted edit, undo/redo and boundary no-ops', () => {
    const store = useSequenceStore.getState();
    store.dispatchEdit(id, { type: 'SET_CURSOR', position: 1 });
    expect(mocks.observe).not.toHaveBeenCalled();
    store.dispatchEdit(id, { type: 'UNDO' });
    expect(mocks.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'undo', outcomeKind: 'unchanged', affectedCount: 0 })
    );
    store.dispatchEdit(id, { type: 'INSERT', text: 'AA' });
    expect(mocks.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'update', outcomeKind: 'edited', affectedCount: 1 })
    );
    store.dispatchEdit(id, { type: 'UNDO' });
    expect(mocks.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'undo', outcomeKind: 'undone', affectedCount: 1 })
    );
    store.dispatchEdit(id, { type: 'REDO' });
    expect(mocks.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'redo', outcomeKind: 'redone', affectedCount: 1 })
    );
    store.dispatchEdit(id, { type: 'REDO' });
    expect(mocks.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'redo', outcomeKind: 'unchanged', affectedCount: 0 })
    );
    store.discardEdits(id);
    expect(mocks.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'revert', outcomeKind: 'discarded', affectedCount: 1 })
    );
    const payload = JSON.stringify(mocks.observe.mock.calls);
    for (const value of [id, 'private scientific name', 'ATGC'])
      expect(payload).not.toContain(value);
  });
  it('qualifies later visible reopen only after exact saved disk and loaded revision match', async () => {
    const sequence = useSequenceStore.getState().getSequence(id)!;
    const receipt = {
      nativeActionId: '550e8400-e29b-41d4-a716-446655440001',
      revisionId: 'private-native-revision',
      contentSha256: 'a'.repeat(64),
      wrote: true,
    };
    const operationId = '550e8400-e29b-41d4-a716-446655440002';
    rememberSequenceWrite(id, operationId, 2, sequence, receipt);
    mocks.hash.mockResolvedValue(`sha256:${'b'.repeat(64)}`);
    await observeSequenceSavedReopen(id, '/private/project/file.gb', sequence);
    expect(mocks.observe).not.toHaveBeenCalled();
    mocks.hash.mockResolvedValue(`sha256:${receipt.contentSha256}`);
    await observeSequenceSavedReopen(id, '/private/project/file.gb', {
      ...sequence,
      sequence: 'GGGG',
    });
    expect(mocks.observe).not.toHaveBeenCalled();
    await observeSequenceSavedReopen(id, '/private/project/file.gb', sequence);
    await observeSequenceSavedReopen(id, '/private/project/file.gb', sequence);
    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        nativeActionId: receipt.nativeActionId,
        stateRevision: 2,
        outcomeKind: 'reopened_confirmed',
      })
    );
    const payload = JSON.stringify(mocks.observe.mock.calls);
    for (const value of [id, 'file.gb', receipt.contentSha256, receipt.revisionId, 'ATGC'])
      expect(payload).not.toContain(value);
  });
});
