import { expect, it } from 'vitest';
import headless, { type Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalPromptResize } from './terminal-prompt-resize';

const write = (terminal: HeadlessTerminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

const text = (terminal: HeadlessTerminal) =>
  Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
    terminal.buffer.normal.getLine(index)?.translateToString(true).trimEnd()
  )
    .filter(Boolean)
    .join('\n');

it('removes hard-wrapped Zsh input before reflow while keeping completed output', async () => {
  const terminal = new headless.Terminal({
    cols: 20,
    rows: 12,
    allowProposedApi: true,
    reflowCursorLine: false,
  });
  const prompt = new TerminalPromptResize(terminal);
  try {
    await write(
      terminal,
      'COMPLETED_OUTPUT\r\n\x1b]633;A\x07$ \x1b]633;B\x07' +
        'UNEXECUTED_'.repeat(1) +
        '\r\n' +
        'UNEXECUTED_'.repeat(2) +
        '\r\nUNEXECUTED_'
    );
    expect(prompt.position()).toEqual({ line: 1, column: 0 });
    const cursor = { x: terminal.buffer.normal.cursorX, y: terminal.buffer.normal.cursorY };
    await prompt.prepare(10, '/bin/zsh');
    expect(terminal.buffer.normal.cursorX).toBe(cursor.x);
    expect(terminal.buffer.normal.cursorY).toBe(cursor.y);
    terminal.resize(10, 12);
    await write(terminal, '\r\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r$ ');
    expect(text(terminal).replace(/\n/g, '')).toBe('COMPLETED_OUTPUT$');
  } finally {
    prompt.dispose();
    terminal.dispose();
  }
});

it('preserves text from running programs, other shells and unchanged column counts', async () => {
  for (const mode of ['command', 'bash', 'same-columns', 'alternate'] as const) {
    const terminal = new headless.Terminal({ cols: 30, rows: 8, allowProposedApi: true });
    const prompt = new TerminalPromptResize(terminal);
    try {
      await write(terminal, '\x1b]633;A\x07$ \x1b]633;B\x07PENDING_INPUT');
      if (mode === 'command') await write(terminal, '\x1b]633;C\x07PROGRAM_OUTPUT');
      if (mode === 'alternate') await write(terminal, '\x1b[?1049hFULL_SCREEN_PROGRAM');
      const before = text(terminal);
      await prompt.prepare(
        mode === 'same-columns' ? 30 : 15,
        mode === 'bash' ? '/bin/bash' : '/bin/zsh'
      );
      expect(text(terminal)).toBe(before);
    } finally {
      prompt.dispose();
      terminal.dispose();
    }
  }
});

it('restores a replayed prompt anchor and keeps output before its starting column', async () => {
  const terminal = new headless.Terminal({ cols: 30, rows: 8, allowProposedApi: true });
  const prompt = new TerminalPromptResize(terminal);
  try {
    await write(terminal, 'KEEP_THIS$ pending\r\nold continuation');
    prompt.seed({ line: 0, column: 9 });
    await prompt.prepare(15, '/bin/zsh');
    expect(text(terminal)).toBe('KEEP_THIS');
    prompt.seed({ line: -1, column: 0 });
    expect(prompt.position()).toBeUndefined();
    prompt.seed({ line: 0, column: 30 });
    expect(prompt.position()).toBeUndefined();
  } finally {
    prompt.dispose();
    terminal.dispose();
  }
});

it('pulls a clipped wrapped prompt into unused viewport rows after a long line is erased', async () => {
  const terminal = new headless.Terminal({ cols: 46, rows: 4, allowProposedApi: true });
  const prompt = new TerminalPromptResize(terminal);
  const prefix = 'user@host ' + 'working-project-'.repeat(3) + '$ ';
  try {
    await write(
      terminal,
      '\x1b]633;A\x07' +
        prefix +
        '\x1b]633;B\x07' +
        '\r\n'.repeat(3) +
        `\x1b[1;${(prefix.length % 46) + 1}H\x1b[J`
    );
    expect(terminal.buffer.normal.baseY).toBe(1);
    expect(terminal.buffer.normal.cursorY).toBe(0);
    prompt.revealPrompt('/bin/zsh');
    expect(terminal.buffer.normal.baseY).toBe(0);
    expect(terminal.buffer.normal.cursorY).toBe(1);
    expect(terminal.rows).toBe(4);
    expect(text(terminal).replace(/\n/g, '')).toBe(prefix.trimEnd());
    expect(prompt.position()).toEqual({ line: 0, column: 0 });
  } finally {
    prompt.dispose();
    terminal.dispose();
  }
});

it('does not pull a clipped prompt over completion results or another program', async () => {
  const terminal = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true });
  const prompt = new TerminalPromptResize(terminal);
  try {
    await write(terminal, '\x1b]633;A\x07LONG_PROMPT>\x1b]633;B\x07\r\n\r\n\x1b[1;3H\x1b[J');
    expect(terminal.buffer.normal.baseY).toBe(1);
    await write(terminal, '\x1b[2;1Hfile-a\x1b[1;3H');
    const before = text(terminal);
    prompt.revealPrompt('/bin/zsh');
    expect(text(terminal)).toBe(before);
    expect(terminal.buffer.normal.baseY).toBe(1);
    await write(terminal, '\x1b[2;1H\x1b[J\x1b[1;3H\x1b]633;C\x07');
    prompt.revealPrompt('/bin/zsh');
    expect(terminal.buffer.normal.baseY).toBe(1);
  } finally {
    prompt.dispose();
    terminal.dispose();
  }
});

it.each(['whole', 'fragmented', 'replayed'] as const)(
  'lets native Bash erase a scrolled input line with %s output chunks',
  async (chunks) => {
    const terminal = new headless.Terminal({ cols: 46, rows: 8, allowProposedApi: true });
    const prompt = new TerminalPromptResize(terminal, '/bin/bash');
    const prefix = 'user@host ' + 'working-project-'.repeat(4) + '$ ';
    const erase =
      '\x1b[A'.repeat(27) +
      '\x1b[C'.repeat(2) +
      '\x1b[K' +
      '\r\n\r\x1b[K'.repeat(27) +
      '\x1b[A'.repeat(27) +
      '\x1b[C'.repeat(30);
    try {
      await write(
        terminal,
        'COMPLETED_OUTPUT\r\n\x1b]633;A\x07' + prefix + '\x1b]633;B\x07' + 'x'.repeat(1240)
      );
      if (chunks === 'replayed') prompt.seed({ line: 1, column: 0 });
      else prompt.revealPrompt('/bin/bash');
      expect(prompt.position()!.line).toBeLessThan(terminal.buffer.normal.baseY);
      for (const chunk of chunks === 'fragmented' ? [...erase] : [erase]) {
        await write(terminal, chunk);
        prompt.revealPrompt('/bin/bash');
      }
      expect(text(terminal).replaceAll('\n', '')).toBe('COMPLETED_OUTPUT' + prefix.trimEnd());
      expect(terminal.rows).toBe(8);
      expect(terminal.buffer.normal.baseY).toBe(prompt.position()!.line);
      expect(terminal.buffer.normal.cursorX).toBe(30);
    } finally {
      prompt.dispose();
      terminal.dispose();
    }
  }
);

it.each(['command', 'alternate', 'zsh', 'completion'] as const)(
  'keeps ordinary cursor movement for %s output',
  async (mode) => {
    const terminal = new headless.Terminal({ cols: 46, rows: 8, allowProposedApi: true });
    const prompt = new TerminalPromptResize(terminal);
    const shell = mode === 'zsh' ? '/bin/zsh' : '/bin/bash';
    try {
      await write(terminal, '\x1b]633;A\x07$ \x1b]633;B\x07' + 'x'.repeat(1500));
      prompt.revealPrompt(shell);
      if (mode === 'command') await write(terminal, '\x1b]633;C\x07');
      if (mode === 'alternate') await write(terminal, '\x1b[?1049h\x1b[HFULLSCREEN_PROGRAM');
      if (mode === 'completion') await write(terminal, '\x1b[2;1HCOMPLETION_RESULT\x1b[1;1H');
      const before = text(terminal);
      const base = terminal.buffer.normal.baseY;
      await write(terminal, '\x1b[50A');
      prompt.revealPrompt(shell);
      expect(text(terminal)).toBe(before);
      expect(terminal.buffer.normal.baseY).toBe(base);
      expect(terminal.rows).toBe(8);
      if (mode === 'alternate')
        expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
          'FULLSCREEN_PROGRAM'
        );
    } finally {
      prompt.dispose();
      terminal.dispose();
    }
  }
);
