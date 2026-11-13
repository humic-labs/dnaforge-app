// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { createElement, useLayoutEffect } from 'react';
import { createInitialState } from './useEditorState';
import { normalizePlainDnaClipboardText, useKeyboardNavigation } from './useKeyboardNavigation';

describe('normalizePlainDnaClipboardText', () => {
  it('accepts whitespace-delimited IUPAC DNA and normalizes uracil to thymine', () => {
    expect(normalizePlainDnaClipboardText('ACGT RYSW\nKMBD HVNU')).toBe('ACGTRYSWKMBDHVNT');
  });

  it('rejects formatted sequence documents instead of mining letters out of metadata', () => {
    expect(
      normalizePlainDnaClipboardText('LOCUS pUC19 2686 bp DNA\nFEATURES Location/Qualifiers')
    ).toBeNull();
  });
});

function keyboardOwner(id: string): Parameters<typeof useKeyboardNavigation>[0] {
  return {
    editable: true,
    editorState: createInitialState('ATGC'),
    editorDispatch: vi.fn(),
    selection: null,
    sequence: { id, name: id, sequence: 'ATGC', length: 4, circular: false, annotations: [] },
    handleSelectionChange: vi.fn(),
    effectiveCharsPerLine: 80,
    handleCommit: vi.fn(),
    highlightedRange: null,
    viewCursor: null,
    onViewCursorChange: vi.fn(),
    onHighlightedRangeChange: vi.fn(),
    viewModeCursorRef: { current: 0 },
    viewModeAnchorRef: { current: null },
    scrollPositionIntoViewRef: { current: vi.fn() },
  };
}

it.each([true, false])(
  'routes immediate edit keys from the focused Edit button with editable=%s',
  (editable) => {
    const editorDispatch = vi.fn();
    const owner = {
      ...keyboardOwner('active-document'),
      editorDispatch,
      editable,
      keyboardActive: true,
    };
    const mounted = renderHook(() => useKeyboardNavigation(owner));
    const button = document.createElement('button');
    button.dataset.testid = 'sequence-edit-button';
    document.body.append(button);
    button.focus();
    try {
      expect(document.activeElement).toBe(button);
      act(() => {
        for (const key of ['Home', 'ArrowRight', 'Backspace'])
          button.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          );
      });
      expect(editorDispatch.mock.calls).toEqual(
        editable
          ? [
              [{ type: 'SET_CURSOR', position: 0 }],
              [{ type: 'MOVE_CURSOR', delta: 1 }],
              [{ type: 'CLEAR_SELECTION_ANCHOR' }],
              [{ type: 'DELETE_BEFORE' }],
            ]
          : []
      );
    } finally {
      mounted.unmount();
      button.remove();
    }
  }
);

it('routes Select All past an earlier mounted inactive viewer to the active editor', () => {
  const inactive = {
    ...keyboardOwner('inactive-document'),
    editable: false,
    keyboardActive: false,
  };
  const active = { ...keyboardOwner('active-document'), keyboardActive: true };
  const mounted = renderHook(() => {
    useKeyboardNavigation(inactive);
    useKeyboardNavigation(active);
  });
  try {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(inactive.onHighlightedRangeChange).not.toHaveBeenCalled();
    expect(active.editorDispatch).toHaveBeenCalledExactlyOnceWith({ type: 'SELECT_ALL' });
  } finally {
    mounted.unmount();
  }
});

it('routes shortcuts to the current owner when two mounted viewers switch ownership', () => {
  const first = keyboardOwner('first-document');
  const second = keyboardOwner('second-document');
  const mounted = renderHook(
    ({ firstActive }) => {
      useKeyboardNavigation({ ...first, keyboardActive: firstActive });
      useKeyboardNavigation({ ...second, keyboardActive: !firstActive });
    },
    { initialProps: { firstActive: false } }
  );
  const selectAll = () =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
      );
    });
  try {
    selectAll();
    expect(first.editorDispatch).not.toHaveBeenCalled();
    expect(second.editorDispatch).toHaveBeenCalledExactlyOnceWith({ type: 'SELECT_ALL' });
    mounted.rerender({ firstActive: true });
    selectAll();
    expect(first.editorDispatch).toHaveBeenCalledExactlyOnceWith({ type: 'SELECT_ALL' });
    expect(second.editorDispatch).toHaveBeenCalledTimes(1);
  } finally {
    mounted.unmount();
  }
});

it('hands the first committed shortcut from a closed viewer to its successor', () => {
  const sourceSelection = vi.fn();
  const targetSelection = vi.fn();
  const source = {
    ...keyboardOwner('source'),
    editable: false,
    sequence: {
      id: 'source',
      name: 'Source',
      sequence: 'A'.repeat(2686),
      length: 2686,
      circular: false,
      annotations: [],
    },
    onHighlightedRangeChange: sourceSelection,
  };
  const target = {
    ...keyboardOwner('target'),
    editable: false,
    sequence: {
      id: 'target',
      name: 'Target',
      sequence: 'C'.repeat(717),
      length: 717,
      circular: false,
      annotations: [],
    },
    onHighlightedRangeChange: targetSelection,
  };
  function Owner({ owner }: { owner: Parameters<typeof useKeyboardNavigation>[0] }) {
    useKeyboardNavigation(owner);
    return createElement('div', { 'data-testid': owner.sequence?.id });
  }
  function Handoff({ targetActive }: { targetActive: boolean }) {
    useLayoutEffect(() => {
      if (targetActive) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
        );
      }
    }, [targetActive]);
    return createElement(Owner, {
      key: targetActive ? 'target' : 'source',
      owner: targetActive ? target : source,
    });
  }
  const mounted = render(createElement(Handoff, { targetActive: false }));
  try {
    mounted.rerender(createElement(Handoff, { targetActive: true }));
    expect({ source: sourceSelection.mock.calls, target: targetSelection.mock.calls }).toEqual({
      source: [],
      target: [[{ start: 0, end: 716 }]],
    });
  } finally {
    mounted.unmount();
  }
});
