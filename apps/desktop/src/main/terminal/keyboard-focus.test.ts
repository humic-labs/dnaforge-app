import { expect, it, vi } from 'vitest';
import { TerminalKeyboardFocus } from './keyboard-focus';

it('fences focus by owner and restores native menu keys only for the focused session', () => {
  for (const host of ['win32', 'linux'] as const) {
    const targets = new Map(
      [1, 2].map((owner) => [
        owner,
        {
          isDestroyed: () => false,
          setIgnoreMenuShortcuts: vi.fn(),
        },
      ])
    );
    const focus = new TerminalKeyboardFocus(
      (owner) => targets.get(owner),
      (owner, id) => id === `${owner}-owned`,
      host
    );
    focus.focus(1, '1-owned');
    expect(targets.get(1)?.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    expect(() => focus.focus(2, '1-owned')).toThrow(/belong/);
    expect(targets.get(2)?.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
    focus.clear(1, 'other-session');
    expect(targets.get(1)?.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(1);
    focus.clear(1, '1-owned');
    expect(targets.get(1)?.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    focus.focus(1, '1-owned');
    focus.focus(1, null);
    expect(targets.get(1)?.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  }
});

it('preserves macOS Command menu shortcuts and clears safely after a renderer disappears', () => {
  const target = { isDestroyed: vi.fn(() => false), setIgnoreMenuShortcuts: vi.fn() };
  const focus = new TerminalKeyboardFocus(
    () => target,
    () => true,
    'darwin'
  );
  focus.focus(1, 'shell');
  expect(target.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  target.isDestroyed.mockReturnValue(true);
  focus.clear(1);
  expect(target.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(1);
});
