import type { ITheme, Terminal } from '@xterm/xterm';

export function terminalTheme(style: CSSStyleDeclaration): ITheme {
  const context = document.createElement('canvas').getContext('2d');
  const color = (name: string) => {
    const value = style.getPropertyValue(`--terminal-${name}`).trim();
    if (!context) return value;
    context.fillStyle = value;
    return context.fillStyle;
  };
  return {
    background: color('background'),
    foreground: color('foreground'),
    cursor: color('cursor'),
    cursorAccent: color('background'),
    selectionBackground: color('selection'),
    selectionInactiveBackground: color('selection'),
    black: color('black'),
    red: color('red'),
    green: color('green'),
    yellow: color('yellow'),
    blue: color('blue'),
    magenta: color('magenta'),
    cyan: color('cyan'),
    white: color('white'),
    brightBlack: color('brightBlack'),
    brightRed: color('brightRed'),
    brightGreen: color('brightGreen'),
    brightYellow: color('brightYellow'),
    brightBlue: color('brightBlue'),
    brightMagenta: color('brightMagenta'),
    brightCyan: color('brightCyan'),
    brightWhite: color('brightWhite'),
  };
}

export function syncTerminalTheme(
  terminal: Pick<Terminal, 'options'>,
  surface: HTMLElement
): boolean {
  if (!surface.isConnected) return false;
  const theme = terminalTheme(getComputedStyle(surface));
  const current = terminal.options.theme;
  if (Object.entries(theme).every(([key, value]) => current?.[key as keyof ITheme] === value))
    return false;
  terminal.options.theme = theme;
  return true;
}
