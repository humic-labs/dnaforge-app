import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ITheme } from '@xterm/xterm';
import { syncTerminalTheme } from './terminal-theme';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '#000000',
  } as CanvasRenderingContext2D);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const surface = document.createElement('div');
  surface.style.setProperty('--terminal-background', '#fdfdfc');
  surface.style.setProperty('--terminal-foreground', '#22201c');
  let theme: ITheme = { background: '#fdfdfc', foreground: '#22201c' };
  const writes = vi.fn((value: ITheme) => {
    theme = value;
  });
  const terminal = {
    options: {
      get theme() {
        return theme;
      },
      set theme(value: ITheme) {
        writes(value);
      },
    },
  };
  return { surface, terminal, writes };
}

it('preserves the last valid palette while a terminal tab is detached', () => {
  const { surface, terminal, writes } = fixture();
  expect(syncTerminalTheme(terminal, surface)).toBe(false);
  expect(terminal.options.theme.background).toBe('#fdfdfc');
  expect(writes).not.toHaveBeenCalled();
  expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
});

it('applies the current palette when the same terminal returns after hidden theme changes', () => {
  const { surface, terminal } = fixture();
  document.body.append(surface);
  syncTerminalTheme(terminal, surface);
  for (const background of ['#161413', '#fdfdfc', '#161413', '#fdfdfc']) {
    surface.remove();
    surface.style.setProperty('--terminal-background', background);
    expect(syncTerminalTheme(terminal, surface)).toBe(false);
    document.body.append(surface);
    expect(syncTerminalTheme(terminal, surface)).toBe(true);
    expect(terminal.options.theme.background).toBe(background);
  }
});

it('does not reset an unchanged palette during repeated layout notifications', () => {
  const { surface, terminal, writes } = fixture();
  document.body.append(surface);
  syncTerminalTheme(terminal, surface);
  writes.mockClear();
  expect(syncTerminalTheme(terminal, surface)).toBe(false);
  expect(syncTerminalTheme(terminal, surface)).toBe(false);
  expect(writes).not.toHaveBeenCalled();
});
