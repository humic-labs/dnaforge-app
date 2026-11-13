// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { useAnnotationEditing } from './useAnnotationEditing';
import { useSequenceStore } from '../store';

const { observeWorkflowAction } = vi.hoisted(() => ({
  observeWorkflowAction: vi.fn(),
}));

vi.mock('../../../lib/workflow-telemetry', () => ({ observeWorkflowAction }));

const DOCUMENT_ID = 'sequence-document-annotation-editing';

const ANNOTATION: Annotation = {
  name: 'promoter',
  type: 'promoter',
  start: 1,
  end: 6,
  direction: 1,
};

const SEQUENCE: AnnotatedSequence = {
  id: DOCUMENT_ID,
  name: 'sequence-1',
  sequence: 'ATGCGTAA',
  length: 8,
  annotations: [],
};

function mount(flushAutoSave: () => Promise<boolean>) {
  const pendingCommitMessageRef: { current: string | null } = { current: null };
  const hook = renderHook(() =>
    useAnnotationEditing({
      documentId: DOCUMENT_ID,
      sequence: useSequenceStore.getState().sequences[DOCUMENT_ID],
      flushAutoSave,
      pendingCommitMessageRef,
    })
  );
  return { ...hook, pendingCommitMessageRef };
}

describe('useAnnotationEditing', () => {
  it('keeps an existing managed ID on rename but never carries it onto a new annotation', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const managed: Annotation = {
      ...ANNOTATION,
      qualifiers: { ...ANNOTATION.qualifiers, dnaforge_ann_id: [id] },
    };
    useSequenceStore.getState().setSequence(DOCUMENT_ID, {
      ...SEQUENCE,
      annotations: [managed],
    });
    const { result } = mount(vi.fn().mockResolvedValue(true));

    await act(async () =>
      result.current.handleAnnotationSave(0, {
        name: 'renamed',
        type: managed.type,
        direction: managed.direction,
        color: managed.color ?? '#000000',
        start: managed.start,
        end: managed.end,
      })
    );
    expect(
      useSequenceStore.getState().captureForSave(DOCUMENT_ID)?.sequence.annotations?.[0].qualifiers
        ?.dnaforge_ann_id
    ).toEqual([id]);

    await act(async () => result.current.handleAnnotationDelete(0));
    expect(useSequenceStore.getState().sequences[DOCUMENT_ID]?.annotations).toEqual([]);

    await act(async () =>
      result.current.handleAnnotationAdd({
        ...ANNOTATION,
        name: 'new annotation',
      })
    );
    const inserted = useSequenceStore.getState().captureForSave(DOCUMENT_ID)?.sequence.annotations;
    expect(inserted).toHaveLength(1);
    expect(inserted?.[0].qualifiers?.dnaforge_ann_id).toBeUndefined();
  });

  beforeEach(() => {
    observeWorkflowAction.mockReset();
    useSequenceStore.getState().clearAll();
    useSequenceStore.getState().setSequence(DOCUMENT_ID, SEQUENCE);
  });

  it('adds through the document model, names the commit, and reports success only after disk', async () => {
    const flushAutoSave = vi.fn().mockResolvedValue(true);
    const { result, pendingCommitMessageRef } = mount(flushAutoSave);

    await act(async () => result.current.handleAnnotationAdd(ANNOTATION));

    const store = useSequenceStore.getState();
    expect(store.sequences[DOCUMENT_ID]?.annotations).toEqual([ANNOTATION]);
    expect(store.isDirty(DOCUMENT_ID)).toBe(true);
    expect(pendingCommitMessageRef.current).toBe('Add annotation promoter');
    expect(flushAutoSave).toHaveBeenCalledOnce();
    expect(observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'annotation',
      action: 'create',
      affectedCount: 1,
      status: 'created',
    });
  });

  it('does not claim successful annotation work when persistence fails', async () => {
    const { result } = mount(vi.fn().mockResolvedValue(false));

    await act(async () => result.current.handleAnnotationAdd(ANNOTATION));

    expect(useSequenceStore.getState().sequences[DOCUMENT_ID]?.annotations).toEqual([ANNOTATION]);
    expect(observeWorkflowAction).not.toHaveBeenCalled();
  });

  it('renames the annotation that a pending base insertion already stretched', async () => {
    useSequenceStore
      .getState()
      .setSequence(DOCUMENT_ID, { ...SEQUENCE, annotations: [ANNOTATION] });
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, { type: 'SET_CURSOR', position: 3 });
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, { type: 'INSERT', text: 'TT' });
    expect(useSequenceStore.getState().sequences[DOCUMENT_ID]?.annotations[0]).toMatchObject({
      start: 1,
      end: 8,
    });

    const { result, pendingCommitMessageRef } = mount(vi.fn().mockResolvedValue(true));
    await act(async () =>
      result.current.handleAnnotationSave(0, {
        name: 'renamed',
        type: 'promoter',
        direction: 1,
        color: '#ff0000',
        start: 1,
        end: 8,
      })
    );

    const working = useSequenceStore.getState().sequences[DOCUMENT_ID];
    expect(working?.sequence).toBe('ATGTTCGTAA');
    expect(working?.annotations).toEqual([
      { name: 'renamed', type: 'promoter', direction: 1, color: '#ff0000', start: 1, end: 8 },
    ]);
    expect(pendingCommitMessageRef.current).toBe('Edit annotation renamed');
  });

  it('deletes by working index and names the removed annotation in the commit', async () => {
    useSequenceStore
      .getState()
      .setSequence(DOCUMENT_ID, { ...SEQUENCE, annotations: [ANNOTATION] });
    const { result, pendingCommitMessageRef } = mount(vi.fn().mockResolvedValue(true));

    await act(async () => result.current.handleAnnotationDelete(0));

    expect(useSequenceStore.getState().sequences[DOCUMENT_ID]?.annotations).toEqual([]);
    expect(pendingCommitMessageRef.current).toBe('Delete annotation promoter');
  });

  it('never edits a read-only source', async () => {
    const flushAutoSave = vi.fn().mockResolvedValue(true);
    const pendingCommitMessageRef: { current: string | null } = { current: null };
    const { result } = renderHook(() =>
      useAnnotationEditing({
        documentId: DOCUMENT_ID,
        sequence: SEQUENCE,
        flushAutoSave,
        pendingCommitMessageRef,
        readOnly: true,
      })
    );

    await act(async () => result.current.handleAnnotationAdd(ANNOTATION));

    expect(useSequenceStore.getState().sequences[DOCUMENT_ID]?.annotations).toEqual([]);
    expect(flushAutoSave).not.toHaveBeenCalled();
  });
});
