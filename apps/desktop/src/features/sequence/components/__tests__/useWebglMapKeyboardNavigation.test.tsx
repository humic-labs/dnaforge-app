/**
 * @vitest-environment jsdom
 */

import { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SelectionRange, SelectionState } from '../../selection-state';
import {
  useWebglMapKeyboardNavigation,
  type WebglMapCursorNavigation,
} from '../useWebglMapKeyboardNavigation';

interface NavigationLog {
  states: SelectionState[];
  navigations: WebglMapCursorNavigation[];
}

interface HarnessProps {
  initialSelection: SelectionState;
  editCursorPosition?: number;
  circular?: boolean;
  onEditKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  log: NavigationLog;
}

function Harness({
  initialSelection,
  editCursorPosition,
  circular = false,
  onEditKeyDown,
  log,
}: HarnessProps) {
  const [selection, setSelection] = useState(initialSelection);
  const handleKeyDown = useWebglMapKeyboardNavigation({
    sequenceLength: 10,
    circular,
    selection,
    editCursorPosition,
    onEditKeyDown,
    onCursorNavigate: (navigation) => log.navigations.push(navigation),
    setViewCursor: (position) => {
      const next: SelectionState =
        position === null ? { kind: 'none' } : { kind: 'cursor', position };
      log.states.push(next);
      setSelection(next);
    },
    setHighlightedRange: (range: SelectionRange | null) => {
      if (range === null) return;
      const next: SelectionState = { kind: 'range', ...range };
      log.states.push(next);
      setSelection(next);
    },
  });

  return <div data-testid="map" tabIndex={0} onKeyDown={handleKeyDown} />;
}

function pressKey(target: HTMLElement, key: string, shiftKey = false): void {
  act(() => {
    fireEvent.keyDown(target, { key, shiftKey });
  });
}

function newLog(): NavigationLog {
  return { states: [], navigations: [] };
}

describe('useWebglMapKeyboardNavigation', () => {
  it('moves from an assembly edit caret into the canonical whole-sequence cursor', () => {
    const log = newLog();
    const { getByTestId } = render(
      <Harness
        initialSelection={{ kind: 'cursor', position: 4 }}
        editCursorPosition={6}
        log={log}
      />
    );

    pressKey(getByTestId('map'), 'ArrowRight');

    expect(log.states.at(-1)).toEqual({ kind: 'cursor', position: 7 });
    expect(log.navigations).toEqual([{ position: 7, selecting: false }]);
  });

  it('extends, shrinks, collapses, and reverses a shift-arrow selection around one anchor', () => {
    const log = newLog();
    const { getByTestId } = render(
      <Harness initialSelection={{ kind: 'cursor', position: 4 }} log={log} />
    );
    const map = getByTestId('map');

    pressKey(map, 'ArrowRight', true);
    pressKey(map, 'ArrowRight', true);
    pressKey(map, 'ArrowLeft', true);
    pressKey(map, 'ArrowLeft', true);
    pressKey(map, 'ArrowLeft', true);

    expect(log.states).toEqual([
      { kind: 'range', start: 4, end: 5, wraps: undefined },
      { kind: 'range', start: 4, end: 6, wraps: undefined },
      { kind: 'range', start: 4, end: 5, wraps: undefined },
      { kind: 'cursor', position: 4 },
      { kind: 'range', start: 3, end: 4, wraps: undefined },
    ]);
    expect(log.navigations.map(({ position }) => position)).toEqual([5, 6, 5, 4, 3]);
    expect(log.navigations.every(({ selecting }) => selecting)).toBe(true);
  });

  it('preserves a short wrapped selection when shift-arrow crosses a circular origin', () => {
    const log = newLog();
    const { getByTestId } = render(
      <Harness initialSelection={{ kind: 'cursor', position: 9 }} circular log={log} />
    );

    pressKey(getByTestId('map'), 'ArrowRight', true);

    expect(log.states).toEqual([{ kind: 'range', start: 9, end: 0, wraps: true }]);
  });

  it('lets an assembly edit handler consume a key before generic navigation', () => {
    const log = newLog();
    const { getByTestId } = render(
      <Harness
        initialSelection={{ kind: 'cursor', position: 4 }}
        editCursorPosition={4}
        onEditKeyDown={(event) => event.preventDefault()}
        log={log}
      />
    );

    pressKey(getByTestId('map'), 'ArrowRight');

    expect(log.states).toEqual([]);
    expect(log.navigations).toEqual([]);
  });
});
