// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  NONE,
  type SelectionAction,
  type SelectionState,
  getCursor,
  getRange,
  selectionReducer,
} from './selection-state';

function reduce(state: SelectionState, ...actions: SelectionAction[]): SelectionState {
  return actions.reduce(selectionReducer, state);
}

function assertInvariant(state: SelectionState): void {
  const cursor = getCursor(state);
  const range = getRange(state);
  expect(cursor !== null && range !== null).toBe(false);
}

describe('selectionReducer', () => {
  it('starts in none', () => {
    expect(NONE).toEqual({ kind: 'none' });
    assertInvariant(NONE);
  });

  it('setCursor from none yields cursor', () => {
    const next = reduce(NONE, { type: 'setCursor', position: 12 });
    expect(next).toEqual({ kind: 'cursor', position: 12 });
    expect(getCursor(next)).toBe(12);
    expect(getRange(next)).toBeNull();
  });

  it('setRange from none yields range', () => {
    const next = reduce(NONE, { type: 'setRange', range: { start: 1, end: 5 } });
    expect(next.kind).toBe('range');
    expect(getRange(next)).toEqual({ start: 1, end: 5, wraps: undefined });
    expect(getCursor(next)).toBeNull();
  });

  it('setRange replaces an active cursor', () => {
    const next = reduce(
      NONE,
      { type: 'setCursor', position: 10 },
      { type: 'setRange', range: { start: 4, end: 7 } }
    );
    expect(next.kind).toBe('range');
    expect(getCursor(next)).toBeNull();
    assertInvariant(next);
  });

  it('setCursor replaces an active range', () => {
    const next = reduce(
      NONE,
      { type: 'setRange', range: { start: 4, end: 7 } },
      { type: 'setCursor', position: 99 }
    );
    expect(next.kind).toBe('cursor');
    expect(getRange(next)).toBeNull();
    assertInvariant(next);
  });

  it('clearCursor leaves an active range alone', () => {
    const next = reduce(
      NONE,
      { type: 'setRange', range: { start: 1, end: 5 } },
      { type: 'clearCursor' }
    );
    expect(next.kind).toBe('range');
    assertInvariant(next);
  });

  it('clearRange leaves an active cursor alone', () => {
    const next = reduce(NONE, { type: 'setCursor', position: 3 }, { type: 'clearRange' });
    expect(next).toEqual({ kind: 'cursor', position: 3 });
    assertInvariant(next);
  });

  it('clear from any state collapses to none', () => {
    expect(reduce({ kind: 'cursor', position: 1 }, { type: 'clear' })).toEqual(NONE);
    expect(reduce({ kind: 'range', start: 1, end: 2 }, { type: 'clear' })).toEqual(NONE);
    expect(reduce(NONE, { type: 'clear' })).toBe(NONE);
  });

  it('drag-start pattern: cursor-clear then range-set yields range', () => {
    const next = reduce(
      { kind: 'cursor', position: 10 },
      { type: 'clearCursor' },
      { type: 'setRange', range: { start: 12, end: 18 } }
    );
    expect(next.kind).toBe('range');
    assertInvariant(next);
  });

  it('click-to-place pattern: cursor-set then range-clear yields cursor', () => {
    const next = reduce(
      { kind: 'range', start: 3, end: 8 },
      { type: 'setCursor', position: 25 },
      { type: 'clearRange' }
    );
    expect(next).toEqual({ kind: 'cursor', position: 25 });
    assertInvariant(next);
  });

  it('feature-click pattern: range with wraps survives subsequent clearCursor', () => {
    const next = reduce(
      NONE,
      { type: 'setRange', range: { start: 100, end: 5, wraps: true } },
      { type: 'clearCursor' }
    );
    expect(next).toEqual({ kind: 'range', start: 100, end: 5, wraps: true });
    assertInvariant(next);
  });

  it('every reachable state satisfies the cursor/range exclusion invariant', () => {
    const actions: SelectionAction[] = [
      { type: 'clear' },
      { type: 'clearCursor' },
      { type: 'clearRange' },
      { type: 'setCursor', position: 0 },
      { type: 'setCursor', position: 50 },
      { type: 'setRange', range: { start: 0, end: 10 } },
      { type: 'setRange', range: { start: 50, end: 5, wraps: true } },
    ];

    let state: SelectionState = NONE;
    for (const a of actions) {
      state = selectionReducer(state, a);
      assertInvariant(state);
    }
    for (const a of actions.slice().reverse()) {
      state = selectionReducer(state, a);
      assertInvariant(state);
    }
  });
});
