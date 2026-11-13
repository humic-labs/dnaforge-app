import { expect, it } from 'vitest';
import headless from '@xterm/headless';
import { TerminalCommandRanges, offsetTerminalCommandRange } from './command-ranges';

it('extracts one completed command with wrapped lines and restores its markers', async () => {
  const screen = new headless.Terminal({
    cols: 8,
    rows: 3,
    scrollback: 10,
    allowProposedApi: true,
  });
  const write = (text: string) => new Promise<void>((resolve) => screen.write(text, resolve));
  const ranges = new TerminalCommandRanges(screen);
  await write('PROMPT> ');
  ranges.prompt();
  await write('echo\r\n');
  ranges.start('first');
  await write('ABCDEFGHIJK\r\nSECOND\r\n');
  ranges.finish('first');
  await write('NEXT_PROMPT> ');
  expect(ranges.output('first')).toBe('ABCDEFGHIJK\nSECOND\n');
  const range = ranges.range('first');
  expect(range).toBeDefined();
  const restored = new TerminalCommandRanges(screen, [{ id: 'first', range }]);
  expect(restored.output('first')).toBe('ABCDEFGHIJK\nSECOND\n');
  await write('\r\n' + 'TRIM\r\n'.repeat(20));
  expect(ranges.range('first')).toBeUndefined();
  expect(ranges.output('first')).toBeUndefined();
  screen.dispose();
});

it('adjusts persisted ranges to the first line retained in the saved replay', () => {
  const range = { startLine: 12, outputStartLine: 14, endLine: 18 };
  expect(offsetTerminalCommandRange(range, 10)).toEqual({
    startLine: 2,
    outputStartLine: 4,
    endLine: 8,
  });
  expect(offsetTerminalCommandRange(range, 13)).toBeUndefined();
});
