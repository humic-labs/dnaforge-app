import { withUserMessage } from '@waypoint/user-messages';
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { showMenu } = vi.hoisted(() => ({ showMenu: vi.fn(async () => {}) }));
vi.mock('../platform', () => ({ platform: () => ({ window: { showMenu } }) }));
import { WindowsMenuBar } from './WindowsMenuBar';

describe('Windows titlebar menus', () => {
  beforeEach(() => {
    showMenu.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('opens the chosen native menu at the button anchor', async () => {
    render(<WindowsMenuBar />);
    const options = screen.getByRole('menuitem', { name: 'Options' });
    vi.spyOn(options, 'getBoundingClientRect').mockReturnValue({
      left: 180,
      bottom: 36,
    } as DOMRect);
    await act(async () => {
      fireEvent.click(options);
    });
    expect(showMenu).toHaveBeenCalledWith('Options', { x: 180, y: 36 });
  });

  it.each(['File', 'Edit', 'View', 'Help', 'Options'])(
    'toggles %s on mouse-down without reopening on the following click',
    async (id) => {
      showMenu.mockImplementation(() => new Promise<void>(() => {}));
      render(<WindowsMenuBar />);
      const button = screen.getByRole('menuitem', { name: id });
      fireEvent.mouseDown(button, { button: 0 });
      fireEvent.click(button, { detail: 1 });
      expect(button).toHaveAttribute('aria-expanded', 'true');
      expect(showMenu).toHaveBeenCalledTimes(1);
      fireEvent.mouseDown(button, { button: 0 });
      fireEvent.click(button, { detail: 1 });
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(showMenu).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps the next menu expanded when the previous popup closes late', async () => {
    let closeFile!: () => void;
    showMenu.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          closeFile = resolve;
        })
    );
    showMenu.mockImplementationOnce(() => new Promise<void>(() => {}));
    render(<WindowsMenuBar />);
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'File' }), { button: 0 });
    const edit = screen.getByRole('menuitem', { name: 'Edit' });
    fireEvent.mouseDown(edit, { button: 0 });
    await act(async () => {
      closeFile();
    });
    expect(edit).toHaveAttribute('aria-expanded', 'true');
  });

  it('ignores the native dismissal press but allows a fresh press to reopen', async () => {
    let finish!: () => void;
    showMenu.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    showMenu.mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.spyOn(performance, 'now').mockReturnValue(200);
    render(<WindowsMenuBar />);
    const file = screen.getByRole('menuitem', { name: 'File' });
    const press = (timeStamp: number) => {
      const event = createEvent.mouseDown(file, { button: 0 });
      Object.defineProperty(event, 'timeStamp', { value: timeStamp });
      fireEvent(file, event);
    };
    press(100);
    await act(async () => {
      finish();
    });
    expect(file).toHaveAttribute('aria-expanded', 'false');
    press(150);
    expect(showMenu).toHaveBeenCalledTimes(1);
    press(250);
    expect(showMenu).toHaveBeenCalledTimes(2);
    expect(file).toHaveAttribute('aria-expanded', 'true');
  });

  it('supports Alt focus, arrows, opening, and returning to the previous field', async () => {
    render(
      <>
        <input aria-label="Search" />
        <WindowsMenuBar />
      </>
    );
    const input = screen.getByRole('textbox');
    input.focus();
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(screen.getByRole('menuitem', { name: 'File' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    const options = screen.getByRole('menuitem', { name: 'Options' });
    expect(options).toHaveFocus();
    await act(async () => {
      fireEvent.keyDown(options, { key: 'ArrowDown' });
    });
    expect(showMenu).toHaveBeenCalledWith('Options', expect.any(Object));
    fireEvent.keyDown(options, { key: 'Escape' });
    expect(input).toHaveFocus();
  });

  it('leaves shell Alt and F10 keys alone and restores menu access outside the terminal', async () => {
    render(
      <>
        <div data-terminal-surface>
          <textarea aria-label="Shell input" />
        </div>
        <input aria-label="Document input" />
        <WindowsMenuBar />
      </>
    );
    const shell = screen.getByRole('textbox', { name: 'Shell input' });
    shell.focus();
    fireEvent.keyDown(shell, { key: 'Alt', altKey: true });
    fireEvent.keyUp(shell, { key: 'Alt' });
    fireEvent.keyDown(shell, { key: 'f', altKey: true });
    fireEvent.keyDown(shell, { key: 'F10' });
    expect(shell).toHaveFocus();
    expect(showMenu).not.toHaveBeenCalled();
    const document = screen.getByRole('textbox', { name: 'Document input' });
    document.focus();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'h', altKey: true });
    });
    expect(showMenu).toHaveBeenCalledWith('Help', expect.any(Object));
  });

  it('retains the editor when focus enters by Tab and moves between menus', async () => {
    render(
      <>
        <input aria-label="Draft" />
        <WindowsMenuBar />
      </>
    );
    const input = screen.getByRole('textbox');
    input.focus();
    act(() => screen.getByRole('menuitem', { name: 'File' }).focus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    const edit = screen.getByRole('menuitem', { name: 'Edit' });
    expect(edit).toHaveFocus();
    await act(async () => fireEvent.keyDown(edit, { key: 'ArrowDown' }));
    expect(showMenu).toHaveBeenCalledWith('Edit', expect.any(Object));
    expect(input).toHaveFocus();
  });

  it('opens Help via its Alt mnemonic and reports IPC failure', async () => {
    showMenu.mockRejectedValueOnce(withUserMessage(new Error('unavailable'), 'notice.unavailable'));
    render(<WindowsMenuBar />);
    fireEvent.keyDown(window, { key: 'h', altKey: true });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not open Help'));
    expect(showMenu).toHaveBeenCalledWith('Help', expect.any(Object));
  });

  it('preserves editor focus for native Cut, Copy, and Paste', async () => {
    render(
      <>
        <input aria-label="Draft" />
        <WindowsMenuBar />
      </>
    );
    const input = screen.getByRole('textbox');
    input.focus();
    const edit = screen.getByRole('menuitem', { name: 'Edit' });
    await act(async () => {
      expect(fireEvent.mouseDown(edit, { button: 0 })).toBe(false);
      fireEvent.click(edit, { detail: 1 });
    });
    expect(input).toHaveFocus();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'e', altKey: true });
    });
    expect(input).toHaveFocus();
  });
});
