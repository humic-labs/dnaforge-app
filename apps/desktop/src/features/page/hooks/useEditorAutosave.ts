import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import { reportSaveFailure } from '../../../lib/report-save-failure';
import {
  beginWorkspaceEditorWrite,
  registerWorkspaceEditorBlocker,
  type WorkspaceEditorScope,
} from '../../../services/workspace-editor-mutation-state';

export type SaveStatus = 'clean' | 'dirty' | 'saving';

export interface UseEditorAutosaveOptions {
  pageId: string;
  workspaceRoot?: string | null;

  contentRef: React.MutableRefObject<JSONContent | null>;

  onSave: (content: JSONContent, pageId: string) => Promise<void | boolean>;

  onDirtyTransition?: (pageId: string) => void;

  onSaved?: (pageId: string) => void;

  debounceMs?: number;
  nativeOwner?: boolean;
}

export interface UseEditorAutosaveReturn {
  saveStatus: SaveStatus;

  markDirty: () => void;

  saveNow: () => Promise<boolean>;

  discardPendingChanges: () => void;
  acceptOwnerClean: () => void;
  retirePendingChanges: () => Promise<void>;
}

export function useEditorAutosave({
  pageId,
  workspaceRoot,
  contentRef,
  onSave,
  onDirtyTransition,
  onSaved,
  debounceMs = 1000,
  nativeOwner = false,
}: UseEditorAutosaveOptions): UseEditorAutosaveReturn {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('clean');

  const saveStatusRef = useRef<SaveStatus>('clean');
  saveStatusRef.current = saveStatus;

  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  const scopeRef = useRef<WorkspaceEditorScope>({
    entityId: pageId,
    path: workspaceRoot ?? undefined,
  });
  if (scopeRef.current.entityId !== pageId) scopeRef.current = { entityId: pageId };
  scopeRef.current.path = workspaceRoot ?? undefined;

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyTransitionRef = useRef(onDirtyTransition);
  onDirtyTransitionRef.current = onDirtyTransition;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirtyDuringSaveRef = useRef(false);

  const inFlightRef = useRef(false);
  const inFlightPromiseRef = useRef<Promise<boolean> | null>(null);

  const discardEpochRef = useRef(0);
  const lifetimeRef = useRef({ active: true, generation: 0, retired: false });
  useEffect(
    () =>
      registerWorkspaceEditorBlocker(() => ({
        ...scopeRef.current,
        state: inFlightRef.current
          ? 'saving'
          : timerRef.current || dirtyDuringSaveRef.current
            ? 'dirty'
            : saveStatusRef.current,
      })),
    []
  );

  const RETRY_DEBOUNCE_MS = 1500;

  const performSave = useCallback(
    async (
      targetScope?: WorkspaceEditorScope,
      phase: 'autosave' | 'manual' = 'autosave'
    ): Promise<boolean> => {
      const scope = targetScope ?? scopeRef.current;
      if (!lifetimeRef.current.active || scope.entityId !== pageIdRef.current) return false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (inFlightRef.current) {
        dirtyDuringSaveRef.current = true;
        return false;
      }

      const content = contentRef.current;
      const id = scope.entityId;
      if (!content) return false;
      const saveEpoch = discardEpochRef.current;
      const generation = lifetimeRef.current.generation;
      const isCurrent = () =>
        lifetimeRef.current.active &&
        lifetimeRef.current.generation === generation &&
        id === pageIdRef.current;

      dirtyDuringSaveRef.current = false;
      setSaveStatus('saving');
      inFlightRef.current = true;

      const savePromise = (async () => {
        let finishWrite: (() => void) | undefined;
        try {
          finishWrite = beginWorkspaceEditorWrite({ ...scope });
          const saved = await onSaveRef.current(content, id);
          if (saveEpoch !== discardEpochRef.current) return false;
          if (!isCurrent()) return false;
          if (saved === false) {
            dirtyDuringSaveRef.current = true;
            setSaveStatus('dirty');
            if (!timerRef.current)
              timerRef.current = setTimeout(() => {
                void performSave();
              }, debounceMs);
            return false;
          }

          if (id === pageIdRef.current) {
            if (dirtyDuringSaveRef.current && !nativeOwner) {
              setSaveStatus('dirty');

              if (!timerRef.current) {
                timerRef.current = setTimeout(() => {
                  void performSave();
                }, 0);
              }
            } else {
              if (nativeOwner) {
                if (timerRef.current) clearTimeout(timerRef.current);
                timerRef.current = null;
                dirtyDuringSaveRef.current = false;
              }
              setSaveStatus('clean');
              onSavedRef.current?.(id);
              return true;
            }
          } else {
            onSavedRef.current?.(id);
          }
          return false;
        } catch (err) {
          if (saveEpoch !== discardEpochRef.current) return false;
          reportSaveFailure(
            '[useEditorAutosave] save failed:',
            { pageId: id, operation: phase },
            err,
            { notebookPhase: phase }
          );
          if (!isCurrent()) return false;
          if (id === pageIdRef.current) {
            setSaveStatus('dirty');
          }

          if (!timerRef.current && contentRef.current) {
            const retryScope = scopeRef.current;
            timerRef.current = setTimeout(() => {
              void performSave(retryScope);
            }, RETRY_DEBOUNCE_MS);
          }
          return false;
        } finally {
          finishWrite?.();
          inFlightRef.current = false;
        }
      })();

      inFlightPromiseRef.current = savePromise;
      try {
        return await savePromise;
      } finally {
        if (inFlightPromiseRef.current === savePromise) inFlightPromiseRef.current = null;
      }
    },
    [contentRef, nativeOwner, debounceMs]
  );

  const markDirty = useCallback(() => {
    if (!lifetimeRef.current.active) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    const scheduledScope = scopeRef.current;
    timerRef.current = setTimeout(() => {
      void performSave(scheduledScope);
    }, debounceMs);

    if (saveStatusRef.current === 'saving') {
      dirtyDuringSaveRef.current = true;
    }
    if (saveStatusRef.current === 'clean') {
      setSaveStatus('dirty');
      onDirtyTransitionRef.current?.(pageIdRef.current);
    }
  }, [debounceMs, performSave]);

  const saveNow = useCallback(async () => {
    const scope = { ...scopeRef.current };
    const epoch = discardEpochRef.current;
    const generation = lifetimeRef.current.generation;
    const pending = inFlightPromiseRef.current;
    if (pending) {
      const saved = await pending;
      if (
        epoch !== discardEpochRef.current ||
        !lifetimeRef.current.active ||
        generation !== lifetimeRef.current.generation ||
        scope.entityId !== scopeRef.current.entityId ||
        scope.path !== scopeRef.current.path
      )
        return false;
      if (saved && !dirtyDuringSaveRef.current && !timerRef.current) return true;
    }
    return await performSave(scope, 'manual');
  }, [performSave, nativeOwner]);

  const acceptOwnerClean = useCallback(() => {
    if (inFlightRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    dirtyDuringSaveRef.current = false;
    saveStatusRef.current = 'clean';
    setSaveStatus('clean');
  }, []);

  const discardPendingChanges = useCallback(() => {
    discardEpochRef.current += 1;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    dirtyDuringSaveRef.current = false;
    setSaveStatus('clean');
  }, []);

  const retirePendingChanges = useCallback(async () => {
    lifetimeRef.current.retired = true;
    lifetimeRef.current.active = false;
    lifetimeRef.current.generation += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    await inFlightPromiseRef.current;
  }, []);

  useEffect(() => {
    lifetimeRef.current.active = !lifetimeRef.current.retired;
    const oldPageId = pageId;
    const oldScope = scopeRef.current;
    return () => {
      lifetimeRef.current.active = false;
      lifetimeRef.current.generation += 1;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const content = contentRef.current;
        if (content) {
          void (async () => {
            let finishWrite: (() => void) | undefined;
            try {
              finishWrite = beginWorkspaceEditorWrite({ ...oldScope });
              await onSaveRef.current(content, oldPageId);
              onSavedRef.current?.(oldPageId);
            } catch (err) {
              reportSaveFailure(
                '[useEditorAutosave] flush save failed:',
                { pageId: oldPageId, operation: 'flush' },
                err,
                { notebookPhase: 'flush' }
              );
            } finally {
              finishWrite?.();
            }
          })();
        }
      }
    };
  }, [pageId, contentRef]);

  useEffect(() => {
    const handler = () => {
      if (document.hidden && timerRef.current) {
        void performSave();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [performSave, nativeOwner]);

  return {
    saveStatus,
    markDirty,
    saveNow,
    discardPendingChanges,
    acceptOwnerClean,
    retirePendingChanges,
  };
}
