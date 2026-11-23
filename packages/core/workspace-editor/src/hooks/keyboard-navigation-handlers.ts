import type { MutableRefObject } from 'react';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { normalizePlainDnaClipboardText } from '@waypoint/sequence-utils';
import { cleanSequenceFromEditorState } from '../editor-state-model';
import type { EditorAction, EditorPasteFragment, EditorState, Selection } from '../types';

export type SequenceKeyboardHost = {
  editable: boolean;
  editorState: EditorState;
  editorDispatch: (action: EditorAction) => void;
  selection: Selection | null | undefined;
  sequence: AnnotatedSequence | null | undefined;
  handleSelectionChange: (selection: Selection | null) => void;
  effectiveCharsPerLine: number;
  handleCommit: () => void;
  highlightedRange: Selection | null | undefined;
  currentViewCursor: number | null | undefined;
  capturedViewCursor: number | null | undefined;
  onViewCursorChange?: (position: number | null) => void;
  onHighlightedRangeChange?: (range: Selection | null) => void;
  viewModeAnchorRef: MutableRefObject<number | null>;
  scrollPositionIntoView: (position: number) => void;
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
};

export function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return Boolean(target instanceof HTMLElement && target.isContentEditable);
}

export function invertCircularRange(range: Selection, seqLen: number): Selection | null {
  if (seqLen <= 0) return null;
  const selLength = range.wraps
    ? seqLen - range.start + range.end + 1
    : range.end - range.start + 1;
  if (selLength <= 0 || selLength >= seqLen) return null;
  const newStart = (range.end + 1) % seqLen;
  const newEnd = (range.start - 1 + seqLen) % seqLen;
  return {
    start: newStart,
    end: newEnd,
    wraps: newStart > newEnd ? true : undefined,
  };
}

export function sliceSelectedText(sequence: string, selection: Selection): string {
  if (selection.wraps) {
    return sequence.slice(selection.start) + sequence.slice(0, selection.end + 1);
  }
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  return sequence.slice(start, end + 1);
}

export function lineAdjustedPosition(
  pos: number,
  lineDelta: number,
  charsPerLine: number,
  seqLength: number
): number {
  return Math.max(0, Math.min(seqLength - 1, pos + lineDelta * charsPerLine));
}

export function nextShiftArrowFocus(
  key: string,
  currentFocus: number,
  seqLength: number,
  charsPerLine: number
): number | null {
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, currentFocus - 1);
    case 'ArrowRight':
      return Math.min(seqLength - 1, currentFocus + 1);
    case 'ArrowUp':
      return lineAdjustedPosition(currentFocus, -1, charsPerLine, seqLength);
    case 'ArrowDown':
      return lineAdjustedPosition(currentFocus, 1, charsPerLine, seqLength);
    default:
      return null;
  }
}

export function nativeSelectionHasText(
  native: { isCollapsed: boolean; toString(): string } | null
): boolean {
  return Boolean(native && !native.isCollapsed && native.toString().length > 0);
}

export function editModeFocus(state: EditorState): number {
  if (!state.selection) return state.cursor;
  if (state.selectionAnchor !== null) {
    return state.selection.start === state.selectionAnchor
      ? state.selection.end
      : state.selection.start;
  }
  return state.cursor;
}

export function viewModeFocus(args: {
  viewModeAnchor: number | null;
  highlightedRange: Selection | null | undefined;
  currentViewCursor: number | null | undefined;
}): number {
  if (args.viewModeAnchor !== null && args.highlightedRange) {
    return args.highlightedRange.start === args.viewModeAnchor
      ? args.highlightedRange.end
      : args.highlightedRange.start;
  }
  if (args.highlightedRange) return args.highlightedRange.end;
  if (args.currentViewCursor !== null && args.currentViewCursor !== undefined) {
    return args.currentViewCursor;
  }
  return 0;
}

export function editModeAnchor(state: EditorState): number {
  return state.selectionAnchor ?? state.cursor;
}

export function viewModeAnchor(args: {
  viewModeAnchor: number | null;
  highlightedRange: Selection | null | undefined;
  capturedViewCursor: number | null | undefined;
}): number {
  if (args.viewModeAnchor !== null) return args.viewModeAnchor;
  if (args.highlightedRange) return args.highlightedRange.start;
  if (args.capturedViewCursor !== null && args.capturedViewCursor !== undefined) {
    return args.capturedViewCursor;
  }
  return 0;
}

function isModified(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

export function tryHandleEditModeShortcut(e: KeyboardEvent, host: SequenceKeyboardHost): boolean {
  if (!host.editable) return false;
  const { editorState, editorDispatch, effectiveCharsPerLine, handleCommit } = host;

  if (isModified(e) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    editorDispatch({ type: 'UNDO' });
    return true;
  }

  if (isModified(e) && (e.key === 'Z' || (e.shiftKey && e.key === 'z') || e.key === 'y')) {
    e.preventDefault();
    editorDispatch({ type: 'REDO' });
    return true;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    handleCommit();
    return true;
  }

  if (/^[atcgnATCGN]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    editorDispatch({ type: 'INSERT', text: e.key });
    return true;
  }

  if (e.key === 'Backspace') {
    e.preventDefault();
    editorDispatch({ type: editorState.selection ? 'DELETE_SELECTION' : 'DELETE_BEFORE' });
    return true;
  }

  if (e.key === 'Delete') {
    e.preventDefault();
    editorDispatch({ type: editorState.selection ? 'DELETE_SELECTION' : 'DELETE_AFTER' });
    return true;
  }

  if (e.key === 'ArrowLeft' && !e.shiftKey) {
    e.preventDefault();
    editorDispatch({ type: 'MOVE_CURSOR', delta: -1 });
    editorDispatch({ type: 'CLEAR_SELECTION_ANCHOR' });
    return true;
  }

  if (e.key === 'ArrowRight' && !e.shiftKey) {
    e.preventDefault();
    editorDispatch({ type: 'MOVE_CURSOR', delta: 1 });
    editorDispatch({ type: 'CLEAR_SELECTION_ANCHOR' });
    return true;
  }

  if (e.key === 'ArrowUp' && !e.shiftKey) {
    e.preventDefault();
    editorDispatch({ type: 'MOVE_CURSOR_LINE', delta: -1, charsPerLine: effectiveCharsPerLine });
    editorDispatch({ type: 'CLEAR_SELECTION_ANCHOR' });
    return true;
  }

  if (e.key === 'ArrowDown' && !e.shiftKey) {
    e.preventDefault();
    editorDispatch({ type: 'MOVE_CURSOR_LINE', delta: 1, charsPerLine: effectiveCharsPerLine });
    editorDispatch({ type: 'CLEAR_SELECTION_ANCHOR' });
    return true;
  }

  if (e.key === 'Home') {
    e.preventDefault();
    const lineStart =
      Math.floor(editorState.cursor / effectiveCharsPerLine) * effectiveCharsPerLine;
    editorDispatch({ type: 'SET_CURSOR', position: lineStart });
    return true;
  }

  if (e.key === 'End') {
    e.preventDefault();
    const currentLine = Math.floor(editorState.cursor / effectiveCharsPerLine);
    const lineEnd = Math.min(
      (currentLine + 1) * effectiveCharsPerLine,
      editorState.sequence.length
    );
    editorDispatch({ type: 'SET_CURSOR', position: lineEnd });
    return true;
  }

  return false;
}

export function tryHandleSelectAll(e: KeyboardEvent, host: SequenceKeyboardHost): boolean {
  if (!isModified(e) || e.key !== 'a') return false;
  e.preventDefault();
  if (host.editable) {
    host.editorDispatch({ type: 'SELECT_ALL' });
    return true;
  }
  const len = host.sequence?.sequence?.length ?? 0;
  if (len > 0 && host.onHighlightedRangeChange) {
    host.onHighlightedRangeChange({ start: 0, end: len - 1 });
  }
  return true;
}

export function tryHandleInvertSelection(e: KeyboardEvent, host: SequenceKeyboardHost): boolean {
  if (!isModified(e) || !e.shiftKey || e.key.toLowerCase() !== 'i') return false;
  if (!host.sequence?.circular) return false;
  const currentRange = host.editable ? host.editorState.selection : host.highlightedRange;
  if (!currentRange || !host.onHighlightedRangeChange) return false;
  e.preventDefault();
  const seqLen = host.editable
    ? host.editorState.sequence.length
    : (host.sequence?.sequence?.length ?? 0);
  const inverted = invertCircularRange(currentRange, seqLen);
  if (inverted) host.onHighlightedRangeChange(inverted);
  return true;
}

export function tryHandleShiftArrow(e: KeyboardEvent, host: SequenceKeyboardHost): boolean {
  if (!e.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    return false;
  }
  const seqLength = host.editable
    ? host.editorState.sequence.length
    : (host.sequence?.sequence?.length ?? 0);
  if (seqLength === 0) return true;
  e.preventDefault();
  const currentFocus = host.editable
    ? editModeFocus(host.editorState)
    : viewModeFocus({
        viewModeAnchor: host.viewModeAnchorRef.current,
        highlightedRange: host.highlightedRange,
        currentViewCursor: host.currentViewCursor,
      });
  const newFocus = nextShiftArrowFocus(e.key, currentFocus, seqLength, host.effectiveCharsPerLine);
  if (newFocus === null) return true;
  if (host.editable) {
    host.editorDispatch({ type: 'EXTEND_SELECTION', position: newFocus });
    host.scrollPositionIntoView(newFocus);
    return true;
  }
  const anchor = viewModeAnchor({
    viewModeAnchor: host.viewModeAnchorRef.current,
    highlightedRange: host.highlightedRange,
    capturedViewCursor: host.capturedViewCursor,
  });
  if (host.viewModeAnchorRef.current === null) {
    host.viewModeAnchorRef.current = anchor;
  }
  host.onViewCursorChange?.(null);
  host.onHighlightedRangeChange?.({
    start: Math.min(anchor, newFocus),
    end: Math.max(anchor, newFocus),
  });
  host.scrollPositionIntoView(newFocus);
  return true;
}

export function tryHandleCopy(e: KeyboardEvent, host: SequenceKeyboardHost): boolean {
  const currentSequence = host.editable ? host.editorState.sequence : host.sequence?.sequence;
  const copySelection = host.editable
    ? host.editorState.selection
    : host.highlightedRange || host.selection;
  if (!host.editable || !isModified(e) || e.key !== 'c' || !copySelection || !currentSequence) {
    return false;
  }
  if (nativeSelectionHasText(window.getSelection())) return true;
  e.preventDefault();
  const draft = cleanSequenceFromEditorState(host.editorState);
  const cleanOffset = (position: number) =>
    position -
    host.editorState.deletedRanges.reduce(
      (removed, range) => removed + Math.max(0, Math.min(position, range.end) - range.start),
      0
    );
  let start = cleanOffset(
    copySelection.wraps ? copySelection.start : Math.min(copySelection.start, copySelection.end)
  );
  let end = cleanOffset(
    (copySelection.wraps ? copySelection.end : Math.max(copySelection.start, copySelection.end)) + 1
  );
  let wraps = copySelection.wraps;
  if (wraps && start === draft.sequence.length) {
    start = 0;
    wraps = undefined;
  }
  if (wraps && end === 0) {
    end = draft.sequence.length;
    wraps = undefined;
  }
  const selectedText = wraps
    ? draft.sequence.slice(start) + draft.sequence.slice(0, end)
    : draft.sequence.slice(start, end);
  if (!selectedText) return true;
  const richCopy = host.onCopyDraftSelection;
  if (richCopy) {
    void richCopy({
      start,
      end,
      wraps,
      sequence: selectedText,
      sourceSequence: draft.sequence,
      sourceAnnotations: draft.annotations,
    });
  } else {
    void navigator.clipboard.writeText(selectedText).then(() => {
      // eslint-disable-next-line no-console -- preserved from the original window copy path
      console.log('Copied to clipboard:', selectedText.length, 'bases');
    });
  }
  return true;
}

export function tryHandlePaste(e: KeyboardEvent, host: SequenceKeyboardHost): boolean {
  if (!host.editable || !isModified(e) || e.key !== 'v') return false;
  e.preventDefault();
  void navigator.clipboard.readText().then(async (text) => {
    const fragment = await host.resolvePasteFragment?.(text);
    if (fragment) {
      host.editorDispatch({ type: 'INSERT_FRAGMENT', fragment });
      return;
    }
    const plainDna = normalizePlainDnaClipboardText(text);
    if (plainDna) host.editorDispatch({ type: 'INSERT', text: plainDna });
  });
  return true;
}

export function tryHandleCut(e: KeyboardEvent, host: SequenceKeyboardHost): boolean {
  if (!host.editable || !isModified(e) || e.key !== 'x' || !host.editorState.selection) {
    return false;
  }
  e.preventDefault();
  const selectedText = sliceSelectedText(host.editorState.sequence, host.editorState.selection);
  void navigator.clipboard.writeText(selectedText).then(() => {
    host.editorDispatch({ type: 'DELETE_SELECTION' });
  });
  return true;
}

export function tryHandleEscape(e: KeyboardEvent, host: SequenceKeyboardHost): boolean {
  if (e.key !== 'Escape') return false;
  if (host.editable && host.editorState.selection) {
    host.editorDispatch({ type: 'SET_SELECTION', selection: null });
    return true;
  }
  host.onHighlightedRangeChange?.(null);
  host.onViewCursorChange?.(null);
  host.viewModeAnchorRef.current = null;
  if (host.selection) host.handleSelectionChange(null);
  return true;
}

function isFileTreeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="treeitem"]') !== null;
}

export function handleSequenceEditorKeyDown(e: KeyboardEvent, host: SequenceKeyboardHost): void {
  if (e.defaultPrevented) return;
  if (isTypingTarget(e.target) || isFileTreeTarget(e.target)) return;
  if (tryHandleEditModeShortcut(e, host)) return;
  if (tryHandleSelectAll(e, host)) return;
  if (tryHandleInvertSelection(e, host)) return;
  const seqLength = host.editable
    ? host.editorState.sequence.length
    : (host.sequence?.sequence?.length ?? 0);
  if (seqLength === 0) return;
  if (tryHandleShiftArrow(e, host)) return;
  if (tryHandleCopy(e, host)) return;
  if (tryHandlePaste(e, host)) return;
  if (tryHandleCut(e, host)) return;
  tryHandleEscape(e, host);
}
