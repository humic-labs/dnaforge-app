import { expect, it } from 'vitest';
import headless from '@xterm/headless';
import { terminalBufferText } from './terminal-buffer';
import { longestTerminalViewportLine } from './upstream/terminal-geometry';

it('measures real wrapped terminal cells, including wide characters', async () => {
  const terminal = new headless.Terminal({ cols: 10, rows: 4, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write('1234567890abcdefghijXYZ\r\n', resolve));
  expect(longestTerminalViewportLine(terminal.buffer.active, terminal.cols)).toBe(23);
  terminal.reset();
  await new Promise<void>((resolve) => terminal.write('漢字xx\r\n', resolve));
  expect(longestTerminalViewportLine(terminal.buffer.active, terminal.cols)).toBe(6);
  terminal.dispose();
});

it('ignores long logical lines that have completely left the viewport', async () => {
  const terminal = new headless.Terminal({
    cols: 10,
    rows: 3,
    scrollback: 100,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) =>
    terminal.write('x'.repeat(35) + '\r\nshort\r\nend\r\nlast\r\n', resolve)
  );
  expect(longestTerminalViewportLine(terminal.buffer.active, terminal.cols)).toBe(4);
  terminal.dispose();
});

it('reads wrapped viewport text without including scrollback or joining separate lines', async () => {
  const terminal = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) =>
      terminal.write('offscreen\r\nabcdefghijXYZ\r\nlast', resolve)
    );
    const buffer = terminal.buffer.active;
    expect(terminalBufferText(buffer, buffer.viewportY, buffer.viewportY + terminal.rows)).toBe(
      'abcdefghijXYZ\nlast'
    );
  } finally {
    terminal.dispose();
  }
});
