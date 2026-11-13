import { useLayoutEffect, useRef, type RefObject } from 'react';
import { inputTargetAllows } from '@waypoint/platform/input-ownership';
import type { MutableRefObject } from 'react';
import type { Selection, EditorState, EditorAction, EditorPasteFragment } from '../types';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { handleSequenceEditorKeyDown } from './keyboard-navigation-handlers';

export { normalizePlainDnaClipboardText } from '@waypoint/sequence-utils';

interface UseKeyboardNavigationProps {
  keyboardActive?: boolean;
  keyboardTargetRef?: RefObject<HTMLElement | null>;
  editable: boolean;
  editorState: EditorState;
  editorDispatch: (action: EditorAction) => void;
  selection: Selection | null | undefined;
  sequence: AnnotatedSequence | null | undefined;
  handleSelectionChange: (selection: Selection | null) => void;
  effectiveCharsPerLine: number;
  handleCommit: () => void;
  highlightedRange: Selection | null | undefined;
  viewCursor: number | null | undefined;
  onViewCursorChange?: (position: number | null) => void;
  onHighlightedRangeChange?: (range: Selection | null) => void;
  viewModeCursorRef: MutableRefObject<number>;
  viewModeAnchorRef: MutableRefObject<number | null>;
  scrollPositionIntoViewRef: MutableRefObject<(position: number) => void>;
  resolvePasteFragment?: (
    clipboardText: string
  ) => EditorPasteFragment | null | Promise<EditorPasteFragment | null>;
  onCopyDraftSelection?: (selection: {
    start: number;
    end: number;
    wraps?: boolean;
    sequence: string;
    sourceSequence: string;
    sourceAnnotations: EditorState['annotations'];
  }) => void | Promise<void>;
}

export function useKeyboardNavigation({
  editable,
  keyboardActive = true,
  keyboardTargetRef,
  editorState,
  editorDispatch,
  selection,
  sequence,
  handleSelectionChange,
  effectiveCharsPerLine,
  handleCommit,
  highlightedRange,
  viewCursor,
  onViewCursorChange,
  onHighlightedRangeChange,
  viewModeCursorRef: _viewModeCursorRef,
  viewModeAnchorRef,
  scrollPositionIntoViewRef,
  resolvePasteFragment,
  onCopyDraftSelection,
}: UseKeyboardNavigationProps): void {
  const keyboardStateRef = useRef({ editable, keyboardActive });
  keyboardStateRef.current = { editable, keyboardActive };
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const highlightedRangeRef = useRef(highlightedRange);
  highlightedRangeRef.current = highlightedRange;
  const viewCursorRef = useRef(viewCursor);
  viewCursorRef.current = viewCursor;
  const resolvePasteFragmentRef = useRef(resolvePasteFragment);
  resolvePasteFragmentRef.current = resolvePasteFragment;
  const onCopyDraftSelectionRef = useRef(onCopyDraftSelection);
  onCopyDraftSelectionRef.current = onCopyDraftSelection;
  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence;

  useLayoutEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const owner = keyboardStateRef.current;
      if (!owner.keyboardActive) return;
      const target = keyboardTargetRef?.current;
      if (target && !inputTargetAllows(target, 'keyboard', e)) return;
      handleSequenceEditorKeyDown(e, {
        editable: owner.editable,
        editorState: editorStateRef.current,
        editorDispatch,
        selection: selectionRef.current,
        sequence: sequenceRef.current,
        handleSelectionChange,
        effectiveCharsPerLine,
        handleCommit,
        highlightedRange: highlightedRangeRef.current,
        currentViewCursor: viewCursorRef.current,
        capturedViewCursor: viewCursor,
        onViewCursorChange,
        onHighlightedRangeChange,
        viewModeAnchorRef,
        scrollPositionIntoView: scrollPositionIntoViewRef.current,
        resolvePasteFragment: resolvePasteFragmentRef.current,
        onCopyDraftSelection: onCopyDraftSelectionRef.current,
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    keyboardTargetRef,
    editorDispatch,
    handleSelectionChange,
    effectiveCharsPerLine,
    handleCommit,
    onViewCursorChange,
    onHighlightedRangeChange,
    viewModeAnchorRef,
    scrollPositionIntoViewRef,
  ]);
}
