/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import type { EditorState } from '../types';
import {
  editModeAnchor,
  editModeFocus,
  invertCircularRange,
  isTypingTarget,
  nativeSelectionHasText,
  nextShiftArrowFocus,
  sliceSelectedText,
  tryHandleCut,
  tryHandleEditModeShortcut,
  tryHandleEscape,
  tryHandleInvertSelection,
  tryHandleSelectAll,
  handleSequenceEditorKeyDown,
  viewModeAnchor,
  viewModeFocus,
  type SequenceKeyboardHost,
} from './keyboard-navigation-handlers';
import { cleanSequenceFromEditorState, createInitialState, editorReducer } from './useEditorState';

function editorState(overrides: Partial<EditorState> = {}): EditorState {
  return {
    sequence: 'ACGTACGTACGT',
    annotations: [],
    cursor: 4,
    selection: null,
    selectionAnchor: null,
    history: [],
    historyIndex: 0,
    isDirty: false,
    insertedRanges: [],
    deletedRanges: [],
    substitutedRanges: [],
    pendingPrimerBindings: [],
    ...overrides,
  };
}

function host(overrides: Partial<SequenceKeyboardHost> = {}): SequenceKeyboardHost {
  return {
    editable: true,
    editorState: editorState(),
    editorDispatch: vi.fn(),
    selection: null,
    sequence: {
      id: 'seq',
      name: 'seq',
      sequence: 'ACGTACGTACGT',
      length: 12,
      circular: true,
      annotations: [],
    },
    handleSelectionChange: vi.fn(),
    effectiveCharsPerLine: 4,
    handleCommit: vi.fn(),
    highlightedRange: null,
    currentViewCursor: 2,
    capturedViewCursor: 2,
    onViewCursorChange: vi.fn(),
    onHighlightedRangeChange: vi.fn(),
    viewModeAnchorRef: { current: null },
    scrollPositionIntoView: vi.fn(),
    ...overrides,
  };
}

function key(partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key'>): KeyboardEvent {
  return {
    key: partial.key,
    metaKey: Boolean(partial.metaKey),
    ctrlKey: Boolean(partial.ctrlKey),
    shiftKey: Boolean(partial.shiftKey),
    defaultPrevented: Boolean(partial.defaultPrevented),
    preventDefault: vi.fn(),
    target: partial.target ?? document.body,
  } as KeyboardEvent;
}

describe('invertCircularRange', () => {
  it('inverts a linear range on a circular sequence', () => {
    expect(invertCircularRange({ start: 2, end: 5 }, 10)).toEqual({
      start: 6,
      end: 1,
      wraps: true,
    });
  });

  it('inverts a wrapping range back to a linear range', () => {
    expect(invertCircularRange({ start: 8, end: 1, wraps: true }, 10)).toEqual({
      start: 2,
      end: 7,
      wraps: undefined,
    });
  });

  it('refuses empty, full, or zero-length sequences', () => {
    expect(invertCircularRange({ start: 0, end: 9 }, 10)).toBeNull();
    expect(invertCircularRange({ start: 3, end: 2 }, 0)).toBeNull();
  });
});

describe('sliceSelectedText', () => {
  it('slices a linear range inclusively', () => {
    expect(sliceSelectedText('ACGTACGT', { start: 2, end: 5 })).toBe('GTAC');
  });

  it('concatenates a wrapping range', () => {
    expect(sliceSelectedText('ACGTACGT', { start: 6, end: 1, wraps: true })).toBe('GTAC');
  });
});

describe('circular Cut mutation', () => {
  it('copies indices 8, 9, 0, 1 before deleting those same bases', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      let state = editorReducer(createInitialState('ACGTTGCAAA'), {
        type: 'SET_SELECTION',
        selection: { start: 8, end: 1, wraps: true },
      });
      const h = host({
        editorState: state,
        editorDispatch: (action) => {
          state = editorReducer(state, action);
        },
      });

      expect(tryHandleCut(key({ key: 'x', metaKey: true }), h)).toBe(true);
      expect(writeText).toHaveBeenCalledExactlyOnceWith('AAAC');
      expect(cleanSequenceFromEditorState(state).sequence).toBe('ACGTTGCAAA');
      await Promise.resolve();
      expect(cleanSequenceFromEditorState(state).sequence).toBe('GTTGCA');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('nextShiftArrowFocus', () => {
  it('moves one base or one line and clamps to the sequence', () => {
    expect(nextShiftArrowFocus('ArrowLeft', 0, 12, 4)).toBe(0);
    expect(nextShiftArrowFocus('ArrowRight', 11, 12, 4)).toBe(11);
    expect(nextShiftArrowFocus('ArrowUp', 6, 12, 4)).toBe(2);
    expect(nextShiftArrowFocus('ArrowDown', 6, 12, 4)).toBe(10);
    expect(nextShiftArrowFocus('Home', 6, 12, 4)).toBeNull();
  });
});

describe('focus and anchor helpers', () => {
  it('uses the non-anchor end as edit-mode focus', () => {
    const state = editorState({
      cursor: 1,
      selection: { start: 2, end: 8 },
      selectionAnchor: 2,
    });
    expect(editModeFocus(state)).toBe(8);
    expect(editModeAnchor(state)).toBe(2);
  });

  it('uses the live view cursor when no highlight exists', () => {
    expect(
      viewModeFocus({ viewModeAnchor: null, highlightedRange: null, currentViewCursor: 7 })
    ).toBe(7);
    expect(
      viewModeAnchor({
        viewModeAnchor: null,
        highlightedRange: null,
        capturedViewCursor: 3,
      })
    ).toBe(3);
  });
});

describe('nativeSelectionHasText', () => {
  it('defers copy when the window already has a real text selection', () => {
    expect(nativeSelectionHasText({ isCollapsed: false, toString: () => 'hi' })).toBe(true);
    expect(nativeSelectionHasText({ isCollapsed: true, toString: () => 'hi' })).toBe(false);
    expect(nativeSelectionHasText(null)).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('ignores keystrokes aimed at inputs, textareas, and contenteditable', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('file tree focus', () => {
  it('leaves arrow keys to the file list', () => {
    const row = document.createElement('div');
    row.setAttribute('role', 'treeitem');
    document.body.append(row);
    const h = host();
    handleSequenceEditorKeyDown(key({ key: 'ArrowDown', target: row }), h);
    expect(h.editorDispatch).not.toHaveBeenCalled();
    row.remove();
  });
});

describe('edit-mode shortcuts', () => {
  it('undoes on Cmd+Z and redoes on Cmd+Shift+Z', () => {
    const h = host();
    expect(tryHandleEditModeShortcut(key({ key: 'z', metaKey: true }), h)).toBe(true);
    expect(h.editorDispatch).toHaveBeenCalledWith({ type: 'UNDO' });
    expect(tryHandleEditModeShortcut(key({ key: 'z', metaKey: true, shiftKey: true }), h)).toBe(
      true
    );
    expect(h.editorDispatch).toHaveBeenCalledWith({ type: 'REDO' });
  });

  it('inserts nucleotides and deletes the selection on Backspace', () => {
    const h = host({ editorState: editorState({ selection: { start: 1, end: 3 } }) });
    expect(tryHandleEditModeShortcut(key({ key: 'a' }), h)).toBe(true);
    expect(h.editorDispatch).toHaveBeenCalledWith({ type: 'INSERT', text: 'a' });
    expect(tryHandleEditModeShortcut(key({ key: 'Backspace' }), h)).toBe(true);
    expect(h.editorDispatch).toHaveBeenCalledWith({ type: 'DELETE_SELECTION' });
  });

  it('does not consume edit shortcuts in view mode', () => {
    expect(tryHandleEditModeShortcut(key({ key: 'a' }), host({ editable: false }))).toBe(false);
  });
});

describe('select-all, invert, and escape', () => {
  it('leaves inversion to the containing viewer when the canvas has no highlighted range', () => {
    const event = key({ key: 'I', metaKey: true, shiftKey: true });
    expect(tryHandleInvertSelection(event, host({ editable: false }))).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it('does not invert twice when the containing viewer already handled the shortcut', () => {
    const h = host({ editable: false, highlightedRange: { start: 2, end: 5 } });
    handleSequenceEditorKeyDown(
      key({ key: 'I', metaKey: true, shiftKey: true, defaultPrevented: true }),
      h
    );
    expect(h.onHighlightedRangeChange).not.toHaveBeenCalled();
  });
  it('selects the whole sequence in view mode', () => {
    const h = host({ editable: false });
    expect(tryHandleSelectAll(key({ key: 'a', metaKey: true }), h)).toBe(true);
    expect(h.onHighlightedRangeChange).toHaveBeenCalledWith({ start: 0, end: 11 });
  });

  it.each(['i', 'I'])(
    'inverts a circular highlighted range with shifted %s in view mode',
    (pressedKey) => {
      const h = host({
        editable: false,
        highlightedRange: { start: 2, end: 5 },
      });
      expect(
        tryHandleInvertSelection(key({ key: pressedKey, metaKey: true, shiftKey: true }), h)
      ).toBe(true);
      expect(h.onHighlightedRangeChange).toHaveBeenCalledWith({
        start: 6,
        end: 1,
        wraps: true,
      });
    }
  );

  it('clears view-mode highlight on Escape', () => {
    const h = host({
      editable: false,
      selection: { start: 1, end: 2 },
      viewModeAnchorRef: { current: 1 },
    });
    expect(tryHandleEscape(key({ key: 'Escape' }), h)).toBe(true);
    expect(h.onHighlightedRangeChange).toHaveBeenCalledWith(null);
    expect(h.onViewCursorChange).toHaveBeenCalledWith(null);
    expect(h.viewModeAnchorRef.current).toBeNull();
    expect(h.handleSelectionChange).toHaveBeenCalledWith(null);
  });
});
