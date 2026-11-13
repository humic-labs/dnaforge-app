import React, { createContext, useContext, useMemo, useCallback, useEffect, useRef } from 'react';
import type { Annotation } from '@waypoint/sequence-utils';
import { useEditorState } from '../hooks/useEditorState';
import type { SequenceState, SequenceStateProviderProps } from './types';
import type { Selection } from '../types';

const SequenceStateContext = createContext<SequenceState | null>(null);

export function useSequenceState(): SequenceState {
  const ctx = useContext(SequenceStateContext);
  if (!ctx) {
    throw new Error('useSequenceState must be used within a SequenceStateProvider');
  }
  return ctx;
}

export function useSequenceStateOptional(): SequenceState | null {
  return useContext(SequenceStateContext);
}

export function SequenceStateProvider({
  initialSequence,
  initialAnnotations,
  onSequenceChange,
  onAnnotationsChange,
  onCursorChange,
  onPendingChangesChange,
  onCommit,
  onDiscard,
  children,
}: SequenceStateProviderProps): React.ReactElement {
  const { state: editorState, dispatch: editorDispatch } = useEditorState(
    initialSequence,
    initialAnnotations,
    onSequenceChange,
    onAnnotationsChange,
    onCursorChange
  );

  const hasPendingChanges =
    editorState.insertedRanges.length > 0 || editorState.deletedRanges.length > 0;
  const prevHasPendingRef = useRef(hasPendingChanges);

  useEffect(() => {
    if (hasPendingChanges !== prevHasPendingRef.current) {
      prevHasPendingRef.current = hasPendingChanges;
      onPendingChangesChange?.(hasPendingChanges);
    }
  }, [hasPendingChanges, onPendingChangesChange]);

  const insert = useCallback(
    (text: string) => {
      editorDispatch({ type: 'INSERT', text });
    },
    [editorDispatch]
  );

  const deleteBefore = useCallback(() => {
    editorDispatch({ type: 'DELETE_BEFORE' });
  }, [editorDispatch]);

  const deleteAfter = useCallback(() => {
    editorDispatch({ type: 'DELETE_AFTER' });
  }, [editorDispatch]);

  const deleteSelection = useCallback(() => {
    editorDispatch({ type: 'DELETE_SELECTION' });
  }, [editorDispatch]);

  const setCursor = useCallback(
    (position: number) => {
      editorDispatch({ type: 'SET_CURSOR', position });
    },
    [editorDispatch]
  );

  const moveCursor = useCallback(
    (delta: number) => {
      editorDispatch({ type: 'MOVE_CURSOR', delta });
    },
    [editorDispatch]
  );

  const setSelection = useCallback(
    (selection: Selection | null) => {
      editorDispatch({ type: 'SET_SELECTION', selection });
    },
    [editorDispatch]
  );

  const selectAll = useCallback(() => {
    editorDispatch({ type: 'SELECT_ALL' });
  }, [editorDispatch]);

  const undo = useCallback(() => {
    editorDispatch({ type: 'UNDO' });
  }, [editorDispatch]);

  const redo = useCallback(() => {
    editorDispatch({ type: 'REDO' });
  }, [editorDispatch]);

  const commit = useCallback(() => {
    if (hasPendingChanges) {
      editorDispatch({ type: 'COMMIT' });
      onCommit?.();
    }
  }, [hasPendingChanges, editorDispatch, onCommit]);

  const discard = useCallback(() => {
    editorDispatch({ type: 'DISCARD' });
    onDiscard?.();
  }, [editorDispatch, onDiscard]);

  const reset = useCallback(
    (sequence: string, annotations: Annotation[]) => {
      editorDispatch({ type: 'RESET', sequence, annotations });
    },
    [editorDispatch]
  );

  const currentSequence = editorState.sequence;

  const adjustedAnnotations = editorState.annotations;

  const value = useMemo<SequenceState>(
    () => ({
      baseSequence: initialSequence,
      baseAnnotations: initialAnnotations,

      currentSequence,
      insertedRanges: editorState.insertedRanges,
      deletedRanges: editorState.deletedRanges,
      cursor: editorState.cursor,
      selection: editorState.selection,
      hasPendingChanges,

      adjustedAnnotations,

      insert,
      deleteBefore,
      deleteAfter,
      deleteSelection,
      setCursor,
      moveCursor,
      setSelection,
      selectAll,
      undo,
      redo,
      commit,
      discard,
      reset,
    }),
    [
      initialSequence,
      initialAnnotations,
      currentSequence,
      editorState.insertedRanges,
      editorState.deletedRanges,
      editorState.cursor,
      editorState.selection,
      hasPendingChanges,
      adjustedAnnotations,
      insert,
      deleteBefore,
      deleteAfter,
      deleteSelection,
      setCursor,
      moveCursor,
      setSelection,
      selectAll,
      undo,
      redo,
      commit,
      discard,
      reset,
    ]
  );

  return <SequenceStateContext.Provider value={value}>{children}</SequenceStateContext.Provider>;
}
