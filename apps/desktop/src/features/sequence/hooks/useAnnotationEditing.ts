import { useCallback, useState, type MutableRefObject } from 'react';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { annotationVisibilityKey } from '../components/annotations-drawer';
import { observeWorkflowAction } from '../../../lib/workflow-telemetry';
import { useSequenceStore, type AnnotationEditPatch } from '../store';

interface UseAnnotationEditingOptions {
  documentId: string;
  sequence: AnnotatedSequence | null | undefined;
  flushAutoSave: () => Promise<boolean>;
  pendingCommitMessageRef: MutableRefObject<string | null>;
  readOnly?: boolean;
}

interface UseAnnotationEditingResult {
  hiddenAnnotationKeys: Set<string>;
  toggleAnnotationVisibility: (ann: Annotation) => void;
  setAllAnnotationsVisible: (visible: boolean) => void;
  handleAnnotationSave: (index: number, data: AnnotationEditPatch) => Promise<void>;
  handleAnnotationDelete: (index: number) => Promise<void>;
  handleAnnotationAdd: (annotation: Annotation) => Promise<void>;
}

export function useAnnotationEditing({
  documentId,
  sequence,
  flushAutoSave,
  pendingCommitMessageRef,
  readOnly = false,
}: UseAnnotationEditingOptions): UseAnnotationEditingResult {
  const [hiddenAnnotationKeys, setHiddenAnnotationKeys] = useState<Set<string>>(() => new Set());
  const toggleAnnotationVisibility = useCallback((ann: Annotation) => {
    const key = annotationVisibilityKey(ann);
    setHiddenAnnotationKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    observeWorkflowAction({
      workflow: 'annotation',
      action: 'view',
      status: 'viewed',
    });
  }, []);
  const setAllAnnotationsVisible = useCallback(
    (visible: boolean) => {
      setHiddenAnnotationKeys(
        visible ? new Set() : new Set((sequence?.annotations ?? []).map(annotationVisibilityKey))
      );
      observeWorkflowAction({
        workflow: 'annotation',
        action: 'view',
        affectedCount: sequence?.annotations?.length ?? 0,
        status: 'viewed',
      });
    },
    [sequence]
  );

  const hasDocument = Boolean(sequence) && !readOnly;

  const handleAnnotationSave = useCallback(
    async (index: number, data: AnnotationEditPatch) => {
      if (!hasDocument) return;
      useSequenceStore.getState().updateAnnotation(documentId, index, data);
      pendingCommitMessageRef.current = `Edit annotation ${data.name}`;
      const persisted = await flushAutoSave();
      if (!persisted) return;
      observeWorkflowAction({
        workflow: 'annotation',
        action: 'update',
        affectedCount: 1,
        status: 'updated',
      });
    },
    [hasDocument, documentId, flushAutoSave, pendingCommitMessageRef]
  );

  const handleAnnotationDelete = useCallback(
    async (index: number) => {
      if (!hasDocument) return;
      const removed = useSequenceStore.getState().sequences[documentId]?.annotations?.[index];
      useSequenceStore.getState().deleteAnnotation(documentId, index);
      pendingCommitMessageRef.current = `Delete annotation ${removed?.name ?? 'feature'}`;
      const persisted = await flushAutoSave();
      if (!persisted) return;
      observeWorkflowAction({
        workflow: 'annotation',
        action: 'delete',
        affectedCount: 1,
        status: 'deleted',
      });
    },
    [hasDocument, documentId, flushAutoSave, pendingCommitMessageRef]
  );

  const handleAnnotationAdd = useCallback(
    async (annotation: Annotation) => {
      if (!hasDocument) return;
      useSequenceStore.getState().addAnnotation(documentId, annotation);
      pendingCommitMessageRef.current = `Add annotation ${annotation.name}`;
      const persisted = await flushAutoSave();
      if (!persisted) return;
      observeWorkflowAction({
        workflow: 'annotation',
        action: 'create',
        affectedCount: 1,
        status: 'created',
      });
    },
    [hasDocument, documentId, flushAutoSave, pendingCommitMessageRef]
  );

  return {
    hiddenAnnotationKeys,
    toggleAnnotationVisibility,
    setAllAnnotationsVisible,
    handleAnnotationSave,
    handleAnnotationDelete,
    handleAnnotationAdd,
  };
}
