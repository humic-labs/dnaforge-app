import { expect, it } from 'vitest';
import headless from '@xterm/headless';
import { TerminalCommandRanges } from './command-ranges';

it('reads only the current prompt input through native wide-cell wrapping and reflow', async () => {
  const screen = new headless.Terminal({
    cols: 12,
    rows: 8,
    allowProposedApi: true,
    reflowCursorLine: true,
  });
  const ranges = new TerminalCommandRanges(screen);
  const write = (value: string) => new Promise<void>((resolve) => screen.write(value, resolve));
  try {
    ranges.prompt();
    await write('漢> ');
    ranges.promptEnd();
    await write("cat 'literal name");
    expect(ranges.input()).toBe("cat 'literal name");
    screen.resize(9, 8);

    await write('\r\x1b[3C');
    expect(ranges.input()).toBe("cat 'literal name");
    await write('\x1b[D');
    expect(ranges.input()).toBeUndefined();
  } finally {
    screen.dispose();
  }
});

it('retires an old prompt on command start or screen clear', async () => {
  const screen = new headless.Terminal({ cols: 80, rows: 8, allowProposedApi: true });
  const ranges = new TerminalCommandRanges(screen);
  const write = (value: string) => new Promise<void>((resolve) => screen.write(value, resolve));
  try {
    ranges.prompt();
    await write('$ ');
    ranges.promptEnd();
    await write('gi');
    expect(ranges.input()).toBe('gi');
    ranges.start('native-command');
    expect(ranges.input()).toBeUndefined();
    ranges.prompt();
    await write('\r\n$ ');
    ranges.promptEnd();
    ranges.clear();
    expect(ranges.input()).toBeUndefined();
  } finally {
    screen.dispose();
  }
});

it('reads a prompt following command output without a trailing newline', async () => {
  const screen = new headless.Terminal({
    cols: 12,
    rows: 8,
    allowProposedApi: true,
    reflowCursorLine: true,
  });
  const ranges = new TerminalCommandRanges(screen);
  const write = (value: string) => new Promise<void>((resolve) => screen.write(value, resolve));
  try {
    await write('literal file contents');
    ranges.prompt();
    await write('$ ');
    ranges.promptEnd();
    await write('git sta');
    expect(ranges.input()).toBe('git sta');
  } finally {
    screen.dispose();
  }
});
