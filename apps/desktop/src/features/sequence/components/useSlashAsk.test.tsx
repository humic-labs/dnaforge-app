// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useSlashAsk } from './useSlashAsk';
import type { SlashAskRangePayload, SlashAskSelectionSnapshot } from '../slash-ask/build-payload';

const RANGE_SNAP: SlashAskSelectionSnapshot = {
  sourceRange: { start: 100, end: 160 },
  sourceCaret: null,
  sequenceLength: 3000,
  isCircular: false,
};
const CARET_SNAP: SlashAskSelectionSnapshot = {
  sourceRange: null,
  sourceCaret: 1500,
  sequenceLength: 3000,
  isCircular: false,
};
const EMPTY_SNAP: SlashAskSelectionSnapshot = {
  sourceRange: null,
  sourceCaret: null,
  sequenceLength: 3000,
  isCircular: false,
};

interface HarnessProps {
  snapshot: SlashAskSelectionSnapshot;
  onTrigger: (payload: SlashAskRangePayload) => void;
  isEditMode?: boolean;
  disabled?: boolean;
  withDialog?: boolean;
  withNonModalPopup?: boolean;
  withInput?: boolean;
}

function Harness({
  snapshot,
  onTrigger,
  isEditMode,
  disabled,
  withDialog,
  withNonModalPopup,
  withInput,
}: HarnessProps) {
  useSlashAsk({
    isEditMode: isEditMode ?? false,
    getSelectionSnapshot: () => snapshot,
    onTrigger,
    disabled,
  });
  return (
    <div data-testid="container">
      <div tabIndex={0} data-testid="canvas" />
      {withInput && <input data-testid="text-input" />}
      {}
      {withDialog && <div role="dialog" aria-modal="true" data-testid="modal" />}
      {withNonModalPopup && <div role="dialog" data-testid="popup" />}
    </div>
  );
}

function pressSlash(el: HTMLElement) {
  act(() => {
    el.focus();
  });
  fireEvent.keyDown(el, { key: '/' });
}

describe('useSlashAsk — the `/` entry gate ', () => {
  beforeEach(() => cleanup());

  it('`/` fires onTrigger with the EXACT range (not inferred)', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} />);
    pressSlash(screen.getByTestId('canvas'));
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith({
      range: { start: 100, end: 160 },
      inferredWindow: false,
    });
  });

  it('`/` with only a caret fires onTrigger with an INFERRED window', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={CARET_SNAP} onTrigger={onTrigger} />);
    pressSlash(screen.getByTestId('canvas'));
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger.mock.calls[0][0]).toMatchObject({ inferredWindow: true });
  });

  it('`/` FIRES even when focus is on document.body (document-level, focus-independent)', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} />);
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: `/` in base-edit mode does NOT fire (literal slash)', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} isEditMode />);
    pressSlash(screen.getByTestId('canvas'));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('REGRESSION: `/` while a text input is focused does NOT fire', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} withInput />);
    pressSlash(screen.getByTestId('text-input'));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('REGRESSION: `/` while a modal dialog is open does NOT fire', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} withDialog />);
    pressSlash(screen.getByTestId('canvas'));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('REGRESSION: a fast double-`/` fires onTrigger only ONCE (no duplicate reference)', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} />);
    const canvas = screen.getByTestId('canvas');
    pressSlash(canvas);
    pressSlash(canvas);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('`/` STILL fires while a NON-modal popup (inline chat) is open (canvas stays interactive)', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} withNonModalPopup />);
    pressSlash(screen.getByTestId('canvas'));
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('`/` with NOTHING selected (no caret, no range) does NOT fire (never whole-entity)', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={EMPTY_SNAP} onTrigger={onTrigger} />);
    pressSlash(screen.getByTestId('canvas'));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('`/` with a modifier (⌘/) does NOT fire', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} />);
    act(() => screen.getByTestId('canvas').focus());
    fireEvent.keyDown(screen.getByTestId('canvas'), { key: '/', metaKey: true });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('disabled turns off the entry point entirely', () => {
    const onTrigger = vi.fn();
    render(<Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} disabled />);
    pressSlash(screen.getByTestId('canvas'));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('MULTI-VIEWER: two mounted hooks open exactly ONE picker (defaultPrevented)', () => {
    const onTrigger = vi.fn();
    render(
      <>
        <Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} />
        <Harness snapshot={RANGE_SNAP} onTrigger={onTrigger} />
      </>
    );
    (document.activeElement as HTMLElement | null)?.blur?.();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('the hook never mutates the selection snapshot it reads', () => {
    const snapshot = { ...RANGE_SNAP };
    const onTrigger = vi.fn();
    render(<Harness snapshot={snapshot} onTrigger={onTrigger} />);
    pressSlash(screen.getByTestId('canvas'));
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual(RANGE_SNAP);
  });
});
