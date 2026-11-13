// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { handleShiftClickNucleotide, handleOptionShiftClickNucleotide } from '../selection-model';
import { useKeyboardNavigation1D } from '../hooks/useKeyboardNavigation1D';
import type { Selection } from '../types';

const SEQ_LEN = 1000;

type EmitLog = {
  cursors: Array<number | null>;
  selections: Array<Selection | null>;
};

interface HarnessProps {
  initialCursor?: number | null;
  initialSelection?: Selection | null;
  initialAnchor?: number | null;
  isCircular?: boolean;
  log: EmitLog;
}

function Harness({
  initialCursor = null,
  initialSelection = null,
  initialAnchor = null,
  isCircular = false,
  log,
}: HarnessProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<number | null>(initialAnchor);
  const [cursor, setCursor] = useState<number | null>(initialCursor);
  const [selection, setSelection] = useState<Selection | null>(initialSelection);

  useKeyboardNavigation1D({
    containerRef,
    columnCount: SEQ_LEN,
    isCircular,
    viewCursor: cursor,
    onViewCursorChange: (next) => {
      log.cursors.push(next ?? null);
      setCursor(next ?? null);
    },
    selection,
    onSelectionChange: (next) => {
      log.selections.push(next);
      setSelection(next);
    },
    scrollToBase: () => {},
    anchorRef,
  });

  return <div ref={containerRef} tabIndex={0} data-testid="container" />;
}

function newLog(): EmitLog {
  return { cursors: [], selections: [] };
}

function pressKey(
  container: HTMLElement,
  key: string,
  opts: { shiftKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}
) {
  const target = container.querySelector('[data-testid="container"]') as HTMLElement;
  target.focus();
  act(() => {
    fireEvent.keyDown(target, { key, ...opts });
  });
}

afterEach(() => {});

describe('plain arrow navigation', () => {
  it('ArrowRight at cursor 100 → cursor 101, no selection', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={100} log={log} />);
    pressKey(container, 'ArrowRight');
    expect(log.cursors).toEqual([101]);
    expect(log.selections).toEqual([]);
  });

  it('ArrowLeft at cursor 0 (linear) clamps to 0', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={0} log={log} />);
    pressKey(container, 'ArrowLeft');
    expect(log.cursors).toEqual([0]);
  });

  it('ArrowLeft at cursor 0 (circular) wraps to SEQ_LEN-1', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={0} isCircular log={log} />);
    pressKey(container, 'ArrowLeft');
    expect(log.cursors).toEqual([SEQ_LEN - 1]);
  });

  it('plain arrow clears existing selection', () => {
    const log = newLog();
    const { container } = render(
      <Harness initialCursor={100} initialSelection={{ start: 90, end: 100 }} log={log} />
    );
    pressKey(container, 'ArrowRight');
    expect(log.selections).toEqual([null]);
    expect(log.cursors).toEqual([101]);
  });

  it('no cursor + no selection → arrow keys are no-ops', () => {
    const log = newLog();
    const { container } = render(<Harness log={log} />);
    pressKey(container, 'ArrowRight');
    pressKey(container, 'ArrowLeft');
    expect(log.cursors).toEqual([]);
    expect(log.selections).toEqual([]);
  });
});

describe('shift+arrow extends the live end', () => {
  it('Shift+Right at cursor 100 starts {100, 101}, anchor=100', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={100} log={log} />);
    pressKey(container, 'ArrowRight', { shiftKey: true });
    expect(log.selections).toEqual([{ start: 100, end: 101 }]);
    expect(log.cursors).toEqual([101]);
  });

  it('repeated Shift+Right grows the right end', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={100} log={log} />);
    pressKey(container, 'ArrowRight', { shiftKey: true });
    pressKey(container, 'ArrowRight', { shiftKey: true });
    pressKey(container, 'ArrowRight', { shiftKey: true });
    expect(log.selections).toEqual([
      { start: 100, end: 101 },
      { start: 100, end: 102 },
      { start: 100, end: 103 },
    ]);
    expect(log.cursors).toEqual([101, 102, 103]);
  });

  it('Shift+Right then Shift+Left shrinks the right end (preserves anchor)', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={100} log={log} />);
    pressKey(container, 'ArrowRight', { shiftKey: true });
    pressKey(container, 'ArrowRight', { shiftKey: true });
    pressKey(container, 'ArrowLeft', { shiftKey: true });
    pressKey(container, 'ArrowLeft', { shiftKey: true });
    expect(log.selections[0]).toEqual({ start: 100, end: 101 });
    expect(log.selections[1]).toEqual({ start: 100, end: 102 });
    expect(log.selections[2]).toEqual({ start: 100, end: 101 });
    expect(log.selections[3]).toBeNull();
    expect(log.cursors).toEqual([101, 102, 101, 100]);
  });

  it('continued Shift+Left past anchor grows the LEFT end (anchor pinned at 100)', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={100} log={log} />);
    pressKey(container, 'ArrowRight', { shiftKey: true });
    pressKey(container, 'ArrowLeft', { shiftKey: true });
    pressKey(container, 'ArrowLeft', { shiftKey: true });
    pressKey(container, 'ArrowLeft', { shiftKey: true });
    expect(log.selections[2]).toEqual({ start: 99, end: 100 });
    expect(log.selections[3]).toEqual({ start: 98, end: 100 });
  });

  it('drag-released-right then Shift+Left shrinks the right end', () => {
    const log = newLog();
    const { container } = render(
      <Harness
        initialCursor={200}
        initialSelection={{ start: 100, end: 200 }}
        initialAnchor={100}
        log={log}
      />
    );
    pressKey(container, 'ArrowLeft', { shiftKey: true });
    expect(log.selections).toEqual([{ start: 100, end: 199 }]);
    expect(log.cursors).toEqual([199]);
  });

  it('drag-released-LEFT then Shift+Right shrinks the LEFT end', () => {
    const log = newLog();
    const { container } = render(
      <Harness
        initialCursor={100}
        initialSelection={{ start: 100, end: 200 }}
        initialAnchor={200}
        log={log}
      />
    );
    pressKey(container, 'ArrowRight', { shiftKey: true });
    expect(log.selections).toEqual([{ start: 101, end: 200 }]);
    expect(log.cursors).toEqual([101]);
  });

  it('plain arrow after shift+arrow clears anchor', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={100} log={log} />);
    pressKey(container, 'ArrowRight', { shiftKey: true });
    pressKey(container, 'ArrowRight');
    pressKey(container, 'ArrowRight', { shiftKey: true });
    expect(log.selections.at(-1)).toEqual({ start: 102, end: 103 });
  });
});

describe('Home / End', () => {
  it('Home moves cursor to 0', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={500} log={log} />);
    pressKey(container, 'Home');
    expect(log.cursors).toEqual([0]);
  });

  it('End moves cursor to SEQ_LEN-1', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={500} log={log} />);
    pressKey(container, 'End');
    expect(log.cursors).toEqual([SEQ_LEN - 1]);
  });

  it('⌘+ArrowLeft acts as Home on Mac', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={500} log={log} />);
    pressKey(container, 'ArrowLeft', { metaKey: true });
    expect(log.cursors).toEqual([0]);
  });

  it('⌘+ArrowRight acts as End on Mac', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={500} log={log} />);
    pressKey(container, 'ArrowRight', { metaKey: true });
    expect(log.cursors).toEqual([SEQ_LEN - 1]);
  });

  it('⌘+Shift+ArrowRight extends to end of sequence', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={500} log={log} />);
    pressKey(container, 'ArrowRight', { metaKey: true, shiftKey: true });
    expect(log.selections).toEqual([{ start: 500, end: SEQ_LEN - 1 }]);
  });
});

describe('non-arrow modifier combos pass through (handled at document level)', () => {
  it('⌘+C does NOT consume the key', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={100} log={log} />);
    pressKey(container, 'c', { metaKey: true });
    expect(log.cursors).toEqual([]);
    expect(log.selections).toEqual([]);
  });

  it('⌘+A does NOT consume the key', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={100} log={log} />);
    pressKey(container, 'a', { metaKey: true });
    expect(log.cursors).toEqual([]);
    expect(log.selections).toEqual([]);
  });

  it('Ctrl+ArrowRight is ignored (not Mac Home)', () => {
    const log = newLog();
    const { container } = render(<Harness initialCursor={500} log={log} />);
    pressKey(container, 'ArrowRight', { ctrlKey: true });
    expect(log.cursors).toEqual([]);
  });
});

describe('shift+arrow on origin-spanning (wrapping) selections', () => {
  it('shrinks the live end of a wrap selection without losing wrap', () => {
    const log = newLog();
    const { container } = render(
      <Harness
        initialCursor={50}
        initialSelection={{ start: 990, end: 50, wraps: true }}
        initialAnchor={990}
        isCircular
        log={log}
      />
    );
    pressKey(container, 'ArrowLeft', { shiftKey: true });
    expect(log.selections).toEqual([{ start: 990, end: 49, wraps: true }]);
    expect(log.cursors).toEqual([49]);
  });

  it('grows the live end of a wrap selection forward across origin', () => {
    const log = newLog();
    const { container } = render(
      <Harness
        initialCursor={50}
        initialSelection={{ start: 990, end: 50, wraps: true }}
        initialAnchor={990}
        isCircular
        log={log}
      />
    );
    pressKey(container, 'ArrowRight', { shiftKey: true });
    expect(log.selections).toEqual([{ start: 990, end: 51, wraps: true }]);
  });

  it('grows the wrap from the OTHER end (anchor at end, live at start)', () => {
    const log = newLog();
    const { container } = render(
      <Harness
        initialCursor={990}
        initialSelection={{ start: 990, end: 50, wraps: true }}
        initialAnchor={50}
        isCircular
        log={log}
      />
    );
    pressKey(container, 'ArrowLeft', { shiftKey: true });
    expect(log.selections).toEqual([{ start: 989, end: 50, wraps: true }]);
  });
});

describe('shift-click helpers (single-source-of-truth with 2D)', () => {
  it('linear shift-click with no selection: from cursor to click', () => {
    const result = handleShiftClickNucleotide(null, 200, 100, SEQ_LEN, false);
    expect(result).toEqual({ start: 100, end: 200 });
  });

  it('circular shift-click LEFT of cursor: wrap-aware', () => {
    const result = handleShiftClickNucleotide(null, 50, 100, SEQ_LEN, true);
    expect(result).toEqual({ start: 100, end: 50, wraps: true });
  });

  it('linear option+shift-click: simple range from cursor to click', () => {
    const result = handleOptionShiftClickNucleotide(null, 50, 100, SEQ_LEN, false);
    expect(result.start).toBe(50);
    expect(result.end).toBe(99);
  });

  it('shift-click extending an existing selection: modifies downstream end', () => {
    const result = handleShiftClickNucleotide({ start: 100, end: 200 }, 300, null, SEQ_LEN);
    expect(result.end).toBe(300);
  });
});
