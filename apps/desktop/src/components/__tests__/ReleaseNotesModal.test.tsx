// @vitest-environment jsdom
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReleaseNotesModal } from '../ReleaseNotesModal';
import { safeFocus } from '../../shared/utils/safeFocus';
import { CommandScopeProvider } from '../../commands/CommandScopeProvider';
import { useCommandHandler } from '../../commands/useCommandHandler';
import { COMMAND_IDS } from '../../commands/types';

function BackgroundCommand({ onRun }: { onRun: () => void }) {
  useCommandHandler(COMMAND_IDS.appNewChat, () => {
    onRun();
    return true;
  });
  return null;
}

describe('release notes native modal ownership', () => {
  it('enters the heading, wraps both Tab boundaries and refuses outside focus', () => {
    render(
      <>
        <button>Background action</button>
        <ReleaseNotesModal open initialVersion="0.9.3" onClose={vi.fn()} />
      </>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const heading = screen.getByTestId('release-notes-heading');
    const picker = screen.getByTestId('release-notes-modal-version-picker');
    expect(document.activeElement).toBe(heading);
    fireEvent.keyDown(heading, { key: 'Tab' });
    expect(document.activeElement).toBe(picker);
    fireEvent.keyDown(picker, { key: 'Tab', shiftKey: true });
    const last = document.activeElement;
    expect(dialog.contains(last)).toBe(true);
    expect(last).not.toBe(picker);
    fireEvent.keyDown(last!, { key: 'Tab' });
    expect(document.activeElement).toBe(picker);
    safeFocus(screen.getByRole('button', { name: 'Background action' }));
    expect(document.activeElement).toBe(heading);
  });

  it('keeps native picker arrows and content scrolling available for long notes', () => {
    const displayed = vi.fn();
    render(
      <ReleaseNotesModal open initialVersion="0.9.3" onClose={vi.fn()} onDisplayed={displayed} />
    );
    const picker = screen.getByTestId('release-notes-modal-version-picker');
    const arrow = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    picker.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(false);
    fireEvent.change(picker, { target: { value: '0.7.6' } });
    expect(picker).toHaveValue('0.7.6');
    expect(displayed).toHaveBeenLastCalledWith('0.7.6');
    const body = screen.getByTestId('release-notes-modal').querySelector('.overflow-y-auto')!;
    expect(body).toHaveClass('min-h-0', 'flex-1');
    expect(body.textContent!.length).toBeGreaterThan(100);
    expect(
      within(screen.getByRole('dialog')).queryByRole('button', {
        name: /activate|install|run|try feature/i,
      })
    ).not.toBeInTheDocument();
  });

  it.each(['escape', 'backdrop', 'close'] as const)(
    'reports accepted %s dismissal only once and never for a content click',
    (reason) => {
      const close = vi.fn();
      render(<ReleaseNotesModal open onClose={close} />);
      fireEvent.click(screen.getByTestId('release-notes-modal'));
      expect(close).not.toHaveBeenCalled();
      const dismiss = () =>
        reason === 'escape'
          ? fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
          : fireEvent.click(
              reason === 'backdrop'
                ? screen.getByRole('dialog')
                : screen.getByRole('button', { name: 'Close' })
            );
      act(() => {
        dismiss();
        dismiss();
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith(reason);
    }
  );

  it.each([
    { platform: 'MacIntel', modifiers: { metaKey: true } },
    { platform: 'Win32', modifiers: { ctrlKey: true } },
  ])(
    'retains the real modal CommandScope protection against background New Chat on $platform',
    ({ platform, modifiers }) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
      Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
      const onRun = vi.fn();
      function Harness() {
        const [open, setOpen] = useState(true);
        return (
          <CommandScopeProvider>
            <BackgroundCommand onRun={onRun} />
            <ReleaseNotesModal open={open} onClose={() => setOpen(false)} />
          </CommandScopeProvider>
        );
      }
      try {
        render(<Harness />);
        fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ...modifiers });
        expect(onRun).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ...modifiers });
        expect(onRun).toHaveBeenCalledOnce();
      } finally {
        if (originalPlatform) Object.defineProperty(navigator, 'platform', originalPlatform);
        else Reflect.deleteProperty(navigator, 'platform');
      }
    }
  );

  it('shows a changed initial request immediately and refuses an invalid picker value', () => {
    const displayed = vi.fn();
    const { rerender } = render(
      <ReleaseNotesModal open initialVersion="0.9.3" onClose={vi.fn()} onDisplayed={displayed} />
    );
    fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
      target: { value: '0.7.6' },
    });
    rerender(
      <ReleaseNotesModal open initialVersion="9.9.9" onClose={vi.fn()} onDisplayed={displayed} />
    );
    expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue('9.9.9');
    expect(displayed).toHaveBeenLastCalledWith('9.9.9');
    fireEvent.change(screen.getByTestId('release-notes-modal-version-picker'), {
      target: { value: 'PRIVATE_PICKER_SENTINEL' },
    });
    expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue('9.9.9');
    expect(displayed).not.toHaveBeenCalledWith('PRIVATE_PICKER_SENTINEL');
    rerender(
      <ReleaseNotesModal open initialVersion="0.9.3" onClose={vi.fn()} onDisplayed={displayed} />
    );
    expect(screen.getByTestId('release-notes-modal-version-picker')).toHaveValue('0.9.3');
  });
});
