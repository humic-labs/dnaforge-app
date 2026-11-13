import { useReducer, useEffect, useRef, useSyncExternalStore } from 'react';
import type { EditorState, SequenceEditorSession } from '../types';
import type { Annotation } from '@waypoint/sequence-utils';
import { createInitialState, editorReducer } from '../editor-state-model';
export * from '../editor-state-model';

const EMPTY_EDITOR_STATE = createInitialState('', []);
const noopSubscribe = () => () => {};
const getEmptyEditorState = () => EMPTY_EDITOR_STATE;

export function useEditorSessionState(
  session: SequenceEditorSession | null | undefined
): EditorState | null {
  const state = useSyncExternalStore(
    session ? session.subscribe : noopSubscribe,
    session ? session.getState : getEmptyEditorState,
    session ? session.getState : getEmptyEditorState
  );
  return session ? state : null;
}

export function useEditorState(
  initialSequence: string,
  initialAnnotations: Annotation[] = [],
  onSequenceChange?: (sequence: string) => void,
  onAnnotationsChange?: (annotations: Annotation[]) => void,
  onCursorChange?: (position: number) => void,
  session?: SequenceEditorSession
) {
  const [localState, localDispatch] = useReducer(
    editorReducer,
    { sequence: initialSequence, annotations: initialAnnotations },
    (init) => createInitialState(init.sequence, init.annotations)
  );
  const sessionState = useEditorSessionState(session);
  const state = sessionState ?? localState;
  const dispatch = session ? session.dispatch : localDispatch;

  const prevSequenceRef = useRef(initialSequence);
  const prevAnnotationsRef = useRef(initialAnnotations);
  const prevInternalSeqRef = useRef(state.sequence);
  const prevInternalAnnRef = useRef(state.annotations);
  const externalResetSequenceRef = useRef<string | null>(null);
  const externalResetAnnotationsRef = useRef<Annotation[] | null>(null);

  useEffect(() => {
    if (session) return;
    const sequenceChanged = initialSequence !== prevSequenceRef.current;
    const annotationsChanged = initialAnnotations !== prevAnnotationsRef.current;

    if (sequenceChanged || annotationsChanged) {
      prevSequenceRef.current = initialSequence;
      prevAnnotationsRef.current = initialAnnotations;
      if (initialSequence !== state.sequence) {
        externalResetSequenceRef.current = initialSequence;
        externalResetAnnotationsRef.current = initialAnnotations;
        dispatch({ type: 'RESET', sequence: initialSequence, annotations: initialAnnotations });
      }
    }
  }, [initialSequence, initialAnnotations, state.sequence, session, dispatch]);

  useEffect(() => {
    if (session) return;
    if (state.sequence !== prevInternalSeqRef.current) {
      prevInternalSeqRef.current = state.sequence;
      if (externalResetSequenceRef.current === state.sequence) {
        externalResetSequenceRef.current = null;
        return;
      }
      onSequenceChange?.(state.sequence);
    }
  }, [state.sequence, onSequenceChange, session]);

  useEffect(() => {
    if (session) return;
    if (state.annotations !== prevInternalAnnRef.current) {
      prevInternalAnnRef.current = state.annotations;
      if (externalResetAnnotationsRef.current === state.annotations) {
        externalResetAnnotationsRef.current = null;
        return;
      }
      onAnnotationsChange?.(state.annotations);
    }
  }, [state.annotations, onAnnotationsChange, session]);

  const prevCursorRef = useRef(state.cursor);
  useEffect(() => {
    if (state.cursor !== prevCursorRef.current) {
      prevCursorRef.current = state.cursor;
      onCursorChange?.(state.cursor);
    }
  }, [state.cursor, onCursorChange]);

  return { state, dispatch };
}
