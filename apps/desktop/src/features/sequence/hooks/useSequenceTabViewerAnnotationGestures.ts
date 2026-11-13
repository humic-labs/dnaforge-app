import { useCallback, useEffect, useState } from 'react';
import { shouldEnableTestBridge } from '@/lib/test-bridge-gate';
import {
  registerActivateFromViewer,
  registerEditFromViewer,
  type ActivateFromViewerBridge,
} from '../activate-from-viewer-bridge';
import { DEFAULT_MANUAL_ANNOTATION_COLOR } from '../components/annotations-drawer';
import type { AnnotationDraft } from '../types';
import type { Annotation } from '@waypoint/sequence-utils';
import type { DrawerType } from './useDrawerState';

type TestBridge = ActivateFromViewerBridge & {
  _editFromViewer?: Record<string, unknown>;
  editAnnotationFromViewer?: unknown;
};

export function useSequenceTabViewerAnnotationGestures({
  readOnly,
  sequenceAnnotations,
  sequenceDocumentId,
  activeDrawer,
  openToAnnotation,
  toggleDrawer,
  selectDraftFromViewer,
  handleAnnotationDelete,
}: {
  readOnly: boolean;
  sequenceAnnotations: Annotation[] | undefined;
  sequenceDocumentId: string;
  activeDrawer: DrawerType | null;
  openToAnnotation: (index: number) => void;
  toggleDrawer: (id: DrawerType) => void;
  selectDraftFromViewer: (annotation: { name: string; start: number; end: number }) => boolean;
  handleAnnotationDelete: (index: number) => void;
}): {
  pendingNewRange: { start: number; end: number } | null;
  pendingNewDraft: AnnotationDraft | null;
  setPendingNewDraft: (draft: AnnotationDraft | null) => void;
  draftSessionId: number;
  clearPendingNewRange: () => void;
  clearPendingNewDraft: () => void;
  handleEditAnnotationFromViewer: (annotation: {
    name: string;
    start: number;
    end: number;
  }) => void;
  handleActivateAnnotationFromViewer: (annotation: {
    name: string;
    start: number;
    end: number;
  }) => void;
  handleDeleteAnnotationFromViewer: (annotation: {
    name: string;
    start: number;
    end: number;
  }) => void;
  handleAddAnnotationFromViewer: (range: { start: number; end: number }) => void;
  handleAddAnnotationDraftFromViewer: (draft: AnnotationDraft) => void;
} {
  const handleEditAnnotationFromViewer = useCallback(
    (annotation: { name: string; start: number; end: number }) => {
      if (readOnly) return;
      if (selectDraftFromViewer(annotation)) return;
      const anns = sequenceAnnotations || [];
      const names = annotation.name.includes(' · ')
        ? annotation.name.split(' · ')
        : [annotation.name];
      let index = anns.findIndex((a) => names.includes(a.name) && a.start === annotation.start);
      if (index < 0) {
        index = anns.findIndex((a) => names.includes(a.name));
      }
      if (index >= 0) {
        openToAnnotation(index);
      } else {
        toggleDrawer('annotations');
      }
    },
    [openToAnnotation, readOnly, selectDraftFromViewer, sequenceAnnotations, toggleDrawer]
  );

  useEffect(() => {
    if (!shouldEnableTestBridge(import.meta.env)) return;
    const bridge = (window as Window & { __test?: TestBridge }).__test;
    if (!bridge) return;
    return registerEditFromViewer(bridge, sequenceDocumentId, handleEditAnnotationFromViewer);
  }, [handleEditAnnotationFromViewer, sequenceDocumentId]);

  const handleActivateAnnotationFromViewer = useCallback(
    (annotation: { name: string; start: number; end: number }) => {
      if (activeDrawer !== 'annotations') return;
      if (selectDraftFromViewer(annotation)) return;
      const anns = sequenceAnnotations || [];
      let index = anns.findIndex((a) => a.name === annotation.name && a.start === annotation.start);
      if (index < 0) index = anns.findIndex((a) => a.name === annotation.name);
      if (index >= 0) openToAnnotation(index);
    },
    [activeDrawer, sequenceAnnotations, openToAnnotation, selectDraftFromViewer]
  );

  useEffect(() => {
    if (!shouldEnableTestBridge(import.meta.env)) return;
    const bridge = (window as Window & { __test?: TestBridge }).__test;
    if (!bridge) return;
    return registerActivateFromViewer(
      bridge,
      sequenceDocumentId,
      handleActivateAnnotationFromViewer
    );
  }, [handleActivateAnnotationFromViewer, sequenceDocumentId]);

  const handleDeleteAnnotationFromViewer = useCallback(
    (annotation: { name: string; start: number; end: number }) => {
      if (readOnly) return;
      const index = (sequenceAnnotations || []).findIndex(
        (a) =>
          a.name === annotation.name && a.start === annotation.start && a.end === annotation.end
      );
      if (index >= 0) handleAnnotationDelete(index);
    },
    [handleAnnotationDelete, readOnly, sequenceAnnotations]
  );

  const [pendingNewRange, setPendingNewRange] = useState<{ start: number; end: number } | null>(
    null
  );
  const [pendingNewDraft, setPendingNewDraft] = useState<AnnotationDraft | null>(null);
  const clearPendingNewRange = useCallback(() => setPendingNewRange(null), []);
  const clearPendingNewDraft = useCallback(() => setPendingNewDraft(null), []);
  const [draftSessionId, setDraftSessionId] = useState(0);

  const handleAddAnnotationFromViewer = useCallback(
    (range: { start: number; end: number }) => {
      if (readOnly) return;
      setPendingNewRange(null);
      setPendingNewDraft({
        type: 'misc_feature',
        name: '',
        start: range.start,
        end: range.end,
        direction: 1,
        color: DEFAULT_MANUAL_ANNOTATION_COLOR,
      });
      setDraftSessionId((s) => s + 1);
      if (activeDrawer !== 'annotations') toggleDrawer('annotations');
    },
    [activeDrawer, readOnly, toggleDrawer]
  );

  const handleAddAnnotationDraftFromViewer = useCallback(
    (draft: AnnotationDraft) => {
      if (readOnly) return;
      setPendingNewDraft(draft);
      setPendingNewRange(null);
      setDraftSessionId((s) => s + 1);
      if (activeDrawer !== 'annotations') toggleDrawer('annotations');
    },
    [activeDrawer, readOnly, toggleDrawer]
  );

  return {
    pendingNewRange,
    pendingNewDraft,
    setPendingNewDraft,
    draftSessionId,
    clearPendingNewRange,
    clearPendingNewDraft,
    handleEditAnnotationFromViewer,
    handleActivateAnnotationFromViewer,
    handleDeleteAnnotationFromViewer,
    handleAddAnnotationFromViewer,
    handleAddAnnotationDraftFromViewer,
  };
}
