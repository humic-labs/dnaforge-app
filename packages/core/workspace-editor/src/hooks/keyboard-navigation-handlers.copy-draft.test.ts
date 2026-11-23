// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanSequenceFromEditorState,
  createInitialState,
  editorReducer,
} from '../editor-state-model';
import type { EditorState } from '../types';
import { tryHandleCopy, type SequenceKeyboardHost } from './keyboard-navigation-handlers';

const writeText = vi.fn().mockResolvedValue(undefined);

function host(
  state: EditorState,
  onCopyDraftSelection?: SequenceKeyboardHost['onCopyDraftSelection']
): SequenceKeyboardHost {
  return {
    editable: true,
    editorState: state,
    editorDispatch: vi.fn(),
    selection: null,
    sequence: null,
    handleSelectionChange: vi.fn(),
    effectiveCharsPerLine: 40,
    handleCommit: vi.fn(),
    highlightedRange: null,
    currentViewCursor: null,
    capturedViewCursor: null,
    viewModeAnchorRef: { current: null },
    scrollPositionIntoView: vi.fn(),
    onCopyDraftSelection,
  };
}

function copyKey(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'c', metaKey: true, cancelable: true });
}

function replaceAll(): EditorState {
  let state = createInitialState('ACGT', []);
  state = editorReducer(state, { type: 'SELECT_ALL' });
  state = editorReducer(state, { type: 'INSERT', text: 'ACGTAC' });
  return editorReducer(state, { type: 'SELECT_ALL' });
}

beforeEach(() => {
  writeText.mockClear();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('copying a sequence draft', () => {
  it('copies the six edited bases after replacing all four original bases', () => {
    const state = replaceAll();
    expect(state.sequence).toHaveLength(10);
    expect(cleanSequenceFromEditorState(state).sequence).toBe('ACGTAC');
    const snapshot = structuredClone(state);
    const key = copyKey();
    expect(tryHandleCopy(key, host(state))).toBe(true);
    expect(writeText, 'DRAFT_COPY_INCLUDED_SOFT_DELETED_BASES').toHaveBeenCalledWith('ACGTAC');
    expect(key.defaultPrevented).toBe(true);
    expect(state).toEqual(snapshot);
  });

  it('gives rich copy the clean source sequence and its matching exclusive range', () => {
    const state = replaceAll();
    const richCopy = vi.fn();
    expect(tryHandleCopy(copyKey(), host(state, richCopy))).toBe(true);
    expect(richCopy).toHaveBeenCalledExactlyOnceWith({
      start: 0,
      end: 6,
      wraps: undefined,
      sequence: 'ACGTAC',
      sourceSequence: 'ACGTAC',
      sourceAnnotations: [],
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('projects reversed partial selection coordinates through existing soft deletions', () => {
    let state = createInitialState('ACGTAC', []);
    state = editorReducer(state, { type: 'SET_SELECTION', selection: { start: 1, end: 3 } });
    state = editorReducer(state, { type: 'DELETE_SELECTION' });
    state = editorReducer(state, { type: 'SET_SELECTION', selection: { start: 5, end: 2 } });
    expect(cleanSequenceFromEditorState(state).sequence).toBe('AAC');
    const richCopy = vi.fn();
    expect(tryHandleCopy(copyKey(), host(state, richCopy))).toBe(true);
    expect(richCopy).toHaveBeenCalledExactlyOnceWith({
      start: 1,
      end: 3,
      wraps: undefined,
      sequence: 'AC',
      sourceSequence: 'AAC',
      sourceAnnotations: [],
    });
  });

  it('keeps ordinary undeleted selection copying unchanged', () => {
    const state = editorReducer(createInitialState('ACGTAC', []), {
      type: 'SET_SELECTION',
      selection: { start: 1, end: 3 },
    });
    const richCopy = vi.fn();
    expect(tryHandleCopy(copyKey(), host(state, richCopy))).toBe(true);
    expect(richCopy).toHaveBeenCalledExactlyOnceWith({
      start: 1,
      end: 4,
      wraps: undefined,
      sequence: 'CGT',
      sourceSequence: 'ACGTAC',
      sourceAnnotations: [],
    });
  });

  it('retains browser selection ownership when the user has selected native text', () => {
    const element = document.createElement('span');
    element.textContent = 'selected native text';
    document.body.append(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.addRange(range);
    expect(window.getSelection()?.toString()).toBe('selected native text');
    const key = copyKey();
    const richCopy = vi.fn();
    expect(tryHandleCopy(key, host(replaceAll(), richCopy))).toBe(true);
    expect(key.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(richCopy).not.toHaveBeenCalled();
  });

  it('passes rich copy the canonical clean annotation coordinates without mutating the draft', () => {
    let state = createInitialState('ACGTAC', [
      {
        id: 'retained-feature',
        name: 'retained bases',
        type: 'misc_feature',
        direction: 1,
        start: 5,
        end: 6,
      },
    ]);
    state = editorReducer(state, { type: 'SET_SELECTION', selection: { start: 1, end: 3 } });
    state = editorReducer(state, { type: 'DELETE_SELECTION' });
    state = editorReducer(state, { type: 'SELECT_ALL' });
    const clean = cleanSequenceFromEditorState(state);
    expect(clean.sequence).toBe('AAC');
    expect(clean.annotations).toHaveLength(1);
    expect(clean.annotations[0]).toMatchObject({ id: 'retained-feature', start: 2, end: 3 });
    const snapshot = structuredClone(state);
    const richCopy = vi.fn();
    expect(tryHandleCopy(copyKey(), host(state, richCopy))).toBe(true);
    expect(richCopy).toHaveBeenCalledExactlyOnceWith({
      start: 0,
      end: 3,
      wraps: undefined,
      sequence: 'AAC',
      sourceSequence: 'AAC',
      sourceAnnotations: clean.annotations,
    });
    expect(state).toEqual(snapshot);
  });

  it('preserves circular suffix then prefix order in clean rich-copy coordinates', () => {
    let state = createInitialState('ACGTTGCA', []);
    state = editorReducer(state, { type: 'SET_SELECTION', selection: { start: 2, end: 3 } });
    state = editorReducer(state, { type: 'DELETE_SELECTION' });
    state = editorReducer(state, {
      type: 'SET_SELECTION',
      selection: { start: 6, end: 1, wraps: true },
    });
    expect(cleanSequenceFromEditorState(state).sequence).toBe('ACTGCA');
    const richCopy = vi.fn();
    expect(tryHandleCopy(copyKey(), host(state, richCopy))).toBe(true);
    expect(richCopy).toHaveBeenCalledExactlyOnceWith({
      start: 4,
      end: 2,
      wraps: true,
      sequence: 'CAAC',
      sourceSequence: 'ACTGCA',
      sourceAnnotations: [],
    });
  });

  it('collapses a wrapped selection to its surviving prefix when its suffix was deleted', () => {
    let state = createInitialState('ACGTTGCA', []);
    state = editorReducer(state, { type: 'SET_SELECTION', selection: { start: 6, end: 7 } });
    state = editorReducer(state, { type: 'DELETE_SELECTION' });
    state = editorReducer(state, {
      type: 'SET_SELECTION',
      selection: { start: 6, end: 1, wraps: true },
    });
    expect(cleanSequenceFromEditorState(state).sequence).toBe('ACGTTG');
    const richCopy = vi.fn();
    expect(tryHandleCopy(copyKey(), host(state, richCopy))).toBe(true);
    expect(richCopy).toHaveBeenCalledExactlyOnceWith({
      start: 0,
      end: 2,
      wraps: undefined,
      sequence: 'AC',
      sourceSequence: 'ACGTTG',
      sourceAnnotations: [],
    });
  });

  it('collapses a wrapped selection to its surviving suffix when its prefix was deleted', () => {
    let state = createInitialState('ACGTTGCA', []);
    state = editorReducer(state, { type: 'SET_SELECTION', selection: { start: 0, end: 1 } });
    state = editorReducer(state, { type: 'DELETE_SELECTION' });
    state = editorReducer(state, {
      type: 'SET_SELECTION',
      selection: { start: 6, end: 1, wraps: true },
    });
    expect(cleanSequenceFromEditorState(state).sequence).toBe('GTTGCA');
    const richCopy = vi.fn();
    expect(tryHandleCopy(copyKey(), host(state, richCopy))).toBe(true);
    expect(richCopy).toHaveBeenCalledExactlyOnceWith({
      start: 4,
      end: 6,
      wraps: undefined,
      sequence: 'CA',
      sourceSequence: 'GTTGCA',
      sourceAnnotations: [],
    });
  });

  it('consumes an entirely deleted selection without replacing either clipboard route', () => {
    let state = createInitialState('ACGT', []);
    state = editorReducer(state, { type: 'SET_SELECTION', selection: { start: 1, end: 2 } });
    state = editorReducer(state, { type: 'DELETE_SELECTION' });
    state = editorReducer(state, { type: 'SET_SELECTION', selection: { start: 1, end: 2 } });
    expect(cleanSequenceFromEditorState(state).sequence).toBe('AT');
    const snapshot = structuredClone(state);
    const key = copyKey();
    expect(tryHandleCopy(key, host(state))).toBe(true);
    expect(key.defaultPrevented).toBe(true);
    const richCopy = vi.fn();
    const richKey = copyKey();
    expect(tryHandleCopy(richKey, host(state, richCopy))).toBe(true);
    expect(richKey.defaultPrevented).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(richCopy).not.toHaveBeenCalled();
    expect(state).toEqual(snapshot);
  });
});
