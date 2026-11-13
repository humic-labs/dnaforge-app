import { afterEach, expect, it } from 'vitest';
import headless from '@xterm/headless';
import type { ITheme } from '@xterm/headless';
import { TerminalColorScheme } from './terminal-color-scheme';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function fixture() {
  const terminal = new headless.Terminal({ allowProposedApi: true });
  let theme: ITheme = { background: '#161413', foreground: '#eeece8' };
  const replies: string[] = [];
  const reports = new TerminalColorScheme(
    terminal.parser,
    () => theme,
    (reply) => replies.push(reply)
  );
  cleanup.push(() => {
    reports.dispose();
    terminal.dispose();
  });
  return {
    terminal,
    replies,
    reports,
    write: (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve)),
    palette: (next: ITheme) => {
      theme = next;
      reports.paletteChanged();
    },
  };
}

it('answers an explicit current-scheme query without subscribing the application', async () => {
  const f = fixture();
  await f.write('\x1b[?996n');
  expect(f.replies).toEqual(['\x1b[?997;1n']);
  f.palette({ background: '#fdfdfc', foreground: '#22201c' });
  expect(f.replies).toHaveLength(1);
});

it('reports real palette changes after opt-in and stops after opt-out', async () => {
  const f = fixture();
  await f.write('\x1b[?2031h');
  expect(f.replies).toEqual([]);
  f.palette({ background: '#fdfdfc', foreground: '#22201c' });
  f.palette({ background: '#fdfdfc', foreground: '#22201c' });
  f.palette({ background: '#161413', foreground: '#eeece8' });
  await f.write('\x1b[?2031l');
  f.palette({ background: '#fdfdfc', foreground: '#22201c' });
  expect(f.replies).toEqual(['\x1b[?997;2n', '\x1b[?997;1n']);
});

it('keeps unrelated private modes when a program enables multiple modes together', async () => {
  const f = fixture();
  await f.write('\x1b[?2031;2004h');
  expect(f.terminal.modes.bracketedPasteMode).toBe(true);
  f.palette({ background: '#fdfdfc' });
  expect(f.replies).toEqual(['\x1b[?997;2n']);
});

it('reports the subscription mode and restores it for a reattached native session', async () => {
  const f = fixture();
  await f.write('\x1b[?2031$p');
  f.reports.restore(true);
  await f.write('\x1b[?2031$p');
  expect(f.replies).toEqual(['\x1b[?2031;2$y', '\x1b[?2031;1$y']);
  f.palette({ background: '#fdfdfc' });
  expect(f.replies.at(-1)).toBe('\x1b[?997;2n');
});

it('does not report cursor or selection-only changes and resets with the terminal', async () => {
  const f = fixture();
  await f.write('\x1b[?2031h');
  f.palette({ background: '#161413', foreground: '#eeece8', cursor: '#30a66f' });
  expect(f.replies).toEqual([]);
  await f.write('\x1bc');
  f.palette({ background: '#fdfdfc' });
  expect(f.replies).toEqual([]);
});

it('resynchronizes an already subscribed client after reconnect without notifying an idle shell', async () => {
  const f = fixture();
  f.reports.resynchronize();
  expect(f.replies).toEqual([]);
  f.reports.restore(true);
  f.palette({ background: '#fdfdfc', foreground: '#22201c' });
  f.replies.length = 0;
  f.reports.resynchronize();
  expect(f.replies).toEqual(['\x1b[?997;2n']);
  await f.write('\x1b[?2031l');
  f.reports.resynchronize();
  expect(f.replies).toHaveLength(1);
});
