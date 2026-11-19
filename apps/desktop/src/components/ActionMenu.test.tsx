import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu, type ActionMenuEntry } from './ActionMenu';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 100,
    left: 100,
    right: 220,
    top: 100,
    bottom: 128,
    width: 120,
    height: 28,
    toJSON: () => ({}),
  });
});

afterEach(() => vi.restoreAllMocks());

function Harness({
  entries,
  onClose = () => {},
}: {
  entries: readonly ActionMenuEntry[];
  onClose?: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchorRef} onClick={() => setOpen(true)}>
        Open actions
      </button>
      <ActionMenu
        open={open}
        label="Example actions"
        entries={entries}
        anchorRef={anchorRef}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
      />
    </>
  );
}

function HandoffHarness() {
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <Harness entries={[{ id: 'rename', label: 'Rename', onSelect: () => setDialog(true) }]} />
      {dialog && (
        <div role="dialog">
          <input autoFocus aria-label="New name" />
        </div>
      )}
    </>
  );
}

describe('ActionMenu adapter', () => {
  it('skips disabled commands and invokes a live command only once', () => {
    const first = vi.fn();
    const unavailable = vi.fn();
    const last = vi.fn();
    const onClose = vi.fn();
    render(
      <Harness
        onClose={onClose}
        entries={[
          { id: 'first', label: 'First', onSelect: first },
          { id: 'disabled', label: 'Unavailable', disabled: true, onSelect: unavailable },
          { id: 'last', label: 'Last', onSelect: last },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open actions' }));
    const firstRow = screen.getByRole('menuitem', { name: 'First' });
    const lastRow = screen.getByRole('menuitem', { name: 'Last' });
    expect(firstRow).toHaveFocus();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unavailable' }));
    expect(unavailable).not.toHaveBeenCalled();
    fireEvent.keyDown(firstRow, { key: 'ArrowDown' });
    expect(lastRow).toHaveFocus();
    act(() => {
      fireEvent.keyDown(lastRow, { key: 'Enter' });
      fireEvent.click(lastRow);
    });
    expect(last).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('preserves the active command identity across live reordering', () => {
    const alpha = vi.fn();
    const beta = vi.fn();
    const gamma = vi.fn();
    const entries: readonly ActionMenuEntry[] = [
      { id: 'alpha', label: 'Alpha', onSelect: alpha },
      { id: 'beta', label: 'Beta', onSelect: beta },
      { id: 'gamma', label: 'Gamma', onSelect: gamma },
    ];
    const { rerender } = render(<Harness entries={entries} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open actions' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Alpha' }), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus();
    rerender(<Harness entries={[entries[1], entries[2], entries[0]]} />);
    const active = screen.getByRole('menuitem', { name: 'Beta' });
    expect(active).toHaveFocus();
    expect(active).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(active, { key: 'Enter' });
    expect(beta).toHaveBeenCalledTimes(1);
    expect(alpha).not.toHaveBeenCalled();
    expect(gamma).not.toHaveBeenCalled();
  });

  it('hands focus to the dialog opened by a command without restoring the trigger', async () => {
    render(<HandoffHarness />);
    const trigger = screen.getByRole('button', { name: 'Open actions' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const restore = vi.spyOn(trigger, 'focus');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await act(async () => {});
    expect(screen.getByRole('textbox', { name: 'New name' })).toHaveFocus();
    expect(restore).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps hover and keyboard navigation on their correct submenu levels', () => {
    const child = vi.fn();
    render(
      <Harness
        entries={[
          {
            id: 'branch',
            label: 'More',
            children: [{ id: 'child', label: 'Child command', onSelect: child }],
          },
          { id: 'next', label: 'Next', onSelect: vi.fn() },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open actions' }));
    const branch = screen.getByRole('menuitem', { name: 'More' });
    expect(branch).toHaveFocus();
    fireEvent.pointerEnter(branch);
    expect(screen.getByRole('menuitem', { name: 'Child command' })).toBeInTheDocument();
    expect(branch).toHaveFocus();
    fireEvent.keyDown(branch, { key: 'ArrowDown' });
    const next = screen.getByRole('menuitem', { name: 'Next' });
    expect(next).toHaveFocus();
    expect(screen.queryByRole('menuitem', { name: 'Child command' })).not.toBeInTheDocument();
    fireEvent.keyDown(next, { key: 'Home' });
    fireEvent.keyDown(branch, { key: 'ArrowRight' });
    const command = screen.getByRole('menuitem', { name: 'Child command' });
    expect(command).toHaveFocus();
    fireEvent.keyDown(command, { key: 'ArrowLeft' });
    expect(branch).toHaveFocus();
    fireEvent.keyDown(branch, { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Child command' }), { key: 'Enter' });
    expect(child).toHaveBeenCalledTimes(1);
  });
});
