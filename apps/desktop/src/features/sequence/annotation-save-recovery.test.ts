import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationDocumentApplyResponse } from '@waypoint/api-client';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), open: vi.fn(), settled: vi.fn() }));
vi.mock('./sequence-document-repository', () => ({ resolveSequenceDocument: mocks.resolve }));
vi.mock('../document-opening/public/open-document', () => ({ openDocument: mocks.open }));
vi.mock('../../services/workspace-editor-mutation-state', () => ({
  assertWorkspaceEditorsSettled: mocks.settled,
}));
import { useSequenceStore } from './store';
import { useCanvasStore } from '../canvas/public/store';
import { useToastStore } from '../../stores/toast-store';
import { notifySavedAnnotationDocument } from './annotation-save-recovery';
const ref = { kind: 'catalog-sequence', entityId: 'document-a' } as const;
function receipt(checkpointFailed = false): AnnotationDocumentApplyResponse {
  return {
    actionId: 'action-a',
    outcome: {
      status: 'saved',
      targetDocumentRevision: 'saved-revision',
      display: 'pending',
      checkpoint: checkpointFailed
        ? { status: 'failed', reason: 'history unavailable' }
        : { status: 'not-required' },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.getState().clearToasts();
  mocks.resolve.mockResolvedValue({
    ref,
    documentId: 'document-a',
    sourcePath: '/project/current.gb',
  });
  mocks.open.mockResolvedValue({ status: 'presented', tabId: 'reopened' });
  useSequenceStore.setState({ dirtyPaths: {} });
});
describe('saved annotation display recovery', () => {
  it('keeps persistent recovery even when checkpoint failed too', () => {
    notifySavedAnnotationDocument(receipt(true), ref, 'Saved sequence');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[1]).toMatchObject({ timing: 'persistent', actionDismisses: false });
    expect(toasts[1].message).toContain('Do not apply it again');
    expect(toasts[1].actions?.[0].label).toBe('Reopen saved document');
  });
  it('reopens the original stable identity without another native Apply', async () => {
    const clear = vi.spyOn(useSequenceStore.getState(), 'clearSequence');
    notifySavedAnnotationDocument(receipt(), ref, 'Saved sequence');
    await useToastStore.getState().toasts[0].actions![0].onClick();
    expect(mocks.resolve).toHaveBeenCalledWith(ref);
    expect(clear).toHaveBeenCalledWith('document-a');
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
      target: { kind: 'sequence-document', document: ref },
      label: 'Saved sequence',
    });
    clear.mockRestore();
  });
  it('keeps unsaved work and recovery notice when reopening is unsafe', async () => {
    useSequenceStore.setState({ dirtyPaths: { 'document-a': true } });
    const clear = vi.spyOn(useSequenceStore.getState(), 'clearSequence');
    notifySavedAnnotationDocument(receipt(), ref, 'Saved sequence');
    await useToastStore.getState().toasts[0].actions![0].onClick();
    expect(clear).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].phase).toBe('visible');
    clear.mockRestore();
  });
  it('refuses changed document identity before evicting any cached content', async () => {
    mocks.resolve.mockResolvedValue({
      ref,
      documentId: 'different-document',
      sourcePath: '/project/other.gb',
    });
    const clear = vi.spyOn(useSequenceStore.getState(), 'clearSequence');
    notifySavedAnnotationDocument(receipt(), ref, 'Saved sequence');
    await useToastStore.getState().toasts[0].actions![0].onClick();
    expect(clear).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    clear.mockRestore();
  });
});
