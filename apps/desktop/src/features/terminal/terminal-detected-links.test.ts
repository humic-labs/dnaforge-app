import { expect, it } from 'vitest';
import Headless from '@xterm/headless';
import type { ILink, ILinkProvider } from '@xterm/xterm';
import { collectTerminalLinks } from './terminal-detected-links';

it('collects wrapped web links and local links once and fences cancelled discovery', async () => {
  const terminal = new Headless.Terminal({ cols: 18, rows: 8, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) =>
      terminal.write('漢字 https://example.com/long/path\r\nfile.txt:2:3\r\n', resolve)
    );
    const file: ILink = {
      text: 'file.txt:2:3',
      range: { start: { x: 1, y: 4 }, end: { x: 12, y: 4 } },
      activate: () => undefined,
    };
    const provider: ILinkProvider = {
      provideLinks: (line, callback) =>
        callback([{ ...file, range: { start: { x: 1, y: line }, end: { x: 12, y: line } } }]),
    };
    const result = await collectTerminalLinks(
      terminal,
      provider,
      new AbortController().signal,
      false,
      () => undefined
    );
    expect(result.links.filter((link) => link.text === 'file.txt:2:3')).toHaveLength(1);
    expect(
      result.links.filter((link) => link.text === 'https://example.com/long/path')
    ).toHaveLength(1);
    const cancelled = new AbortController();
    cancelled.abort();
    const stopped = await collectTerminalLinks(
      terminal,
      provider,
      cancelled.signal,
      true,
      () => undefined
    );
    expect(stopped.links).toEqual([]);
  } finally {
    terminal.dispose();
  }
});
