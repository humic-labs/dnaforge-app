import { expect, it, vi } from 'vitest';
import { TerminalHistory } from './history';
import {
  parseBashHistory,
  parseZshHistory,
  parseFishHistory,
  parsePowerShellHistory,
} from './upstream/shell-history-parsing';

it('does not return an imported history reply after history was disabled during the native read', async () => {
  let finish: (text: string) => void = () => undefined;
  const history = new TerminalHistory(
    { read: () => undefined, write: () => undefined },
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const pending = history.read('/bin/bash', { HOME: '/tmp' }, '/tmp');
  history.setLimit(0);
  finish('private first\nprivate second\n');
  expect(await pending).toEqual({ previousCommands: [], directories: [], shellCommands: [] });
});

it('applies the configured application and imported-history bound, including zero', async () => {
  let saved: string | undefined;
  const storage = {
    read: () => saved,
    write: (value: string) => {
      saved = value;
    },
  };
  const history = new TerminalHistory(storage, async () => 'one\ntwo\nthree\n', 2);
  for (const command of ['one', 'two', 'three']) {
    history.recordCommand('/bin/bash', {
      command,
      cwd: '/tmp',
      startedAt: 1,
      finishedAt: 2,
      exitCode: 0,
    });
  }
  history.flush();
  expect(
    (await history.read('/bin/bash', { HOME: '/tmp' }, '/tmp')).previousCommands.map(
      (entry) => entry.command
    )
  ).toEqual(['three', 'two']);
  expect((await history.read('/bin/bash', { HOME: '/tmp' }, '/tmp')).shellCommands).toEqual([
    'three',
    'two',
  ]);
  const disabled = new TerminalHistory(storage, async () => 'private\n', 0);
  expect(await disabled.read('/bin/bash', { HOME: '/tmp' }, '/tmp')).toEqual({
    previousCommands: [],
    directories: [],
    shellCommands: [],
  });
  disabled.recordDirectory('/tmp/private');
  disabled.flush();
  expect(saved).not.toContain('three');
  expect(saved).not.toContain('private');
});

it('batches persistence after command output and flushes pending history at a lifecycle boundary', async () => {
  vi.useFakeTimers();
  try {
    const write = vi.fn();
    const history = new TerminalHistory({ read: () => undefined, write });
    history.recordCommand('/bin/zsh', {
      command: 'printf instant',
      cwd: '/tmp',
      startedAt: 1,
      finishedAt: 2,
      exitCode: 0,
    });
    history.recordDirectory('/tmp/second');
    expect(write).not.toHaveBeenCalled();
    expect((await history.read('/bin/zsh', {}, '/tmp')).previousCommands[0]?.command).toBe(
      'printf instant'
    );
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    history.recordDirectory('/tmp/third');
    history.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.at(-1)?.[0]).toContain('/tmp/third');
  } finally {
    vi.useRealTimers();
  }
});

it('retains command and directory history across store reconstruction and separates shell families', async () => {
  let saved: string | undefined;
  const storage = {
    read: () => saved,
    write: (value: string) => {
      saved = value;
    },
  };
  const first = new TerminalHistory(storage, async () => undefined);
  first.recordCommand('/bin/zsh', {
    command: 'printf closed',
    cwd: '/tmp/closed',
    startedAt: 1,
    finishedAt: 2,
    exitCode: 0,
  });
  first.recordDirectory('/tmp/second');
  first.flush();
  const next = new TerminalHistory(storage, async () => undefined);
  expect((await next.read('/usr/local/bin/zsh', {}, '/tmp')).previousCommands).toEqual([
    { command: 'printf closed', cwd: '/tmp/closed' },
  ]);
  expect((await next.read('/bin/bash', {}, '/tmp')).previousCommands).toEqual([]);
  expect((await next.read('/bin/zsh', {}, '/tmp')).directories).toEqual([
    '/tmp/second',
    '/tmp/closed',
  ]);
  for (let i = 0; i < 105; i++)
    next.recordCommand('/bin/zsh', {
      command: `echo ${i}`,
      cwd: '/tmp',
      startedAt: i + 3,
      finishedAt: i + 4,
      exitCode: 0,
    });
  const result = await next.read('/bin/zsh', {}, '/tmp');
  expect(result.previousCommands).toHaveLength(100);
  expect(result.previousCommands[0]?.command).toBe('echo 104');
  expect(result.previousCommands.at(-1)?.command).toBe('echo 5');
});

it('reads a configured history file without exposing the launch environment', async () => {
  const history = new TerminalHistory(
    { read: () => undefined, write: () => undefined },
    async (file) => (file === '/task/own-history' ? "echo first\necho 'two\nlines'\n" : undefined)
  );
  const result = await history.read(
    '/bin/bash',
    { HISTFILE: '/task/own-history', PRIVATE_SENTINEL: 'never-render-this' },
    '/tmp'
  );
  expect(result.shellCommands).toEqual(["echo 'two\nlines'", 'echo first']);
  expect(Object.keys(result).sort()).toEqual(['directories', 'previousCommands', 'shellCommands']);
  expect(JSON.stringify(result)).not.toContain('never-render-this');
});

it('preserves the upstream multiline history formats', () => {
  expect(parseBashHistory("echo one\necho 'two\nlines'\n")).toEqual([
    'echo one',
    "echo 'two\nlines'",
  ]);
  expect(parseZshHistory(': 1:0;echo one\n: 2:0;echo two\\\ncontinued\n')).toEqual([
    'echo one',
    'echo two\ncontinued',
  ]);
  expect(parseFishHistory('- cmd: echo one\\ncontinued\n  when: 1\n')).toEqual([
    'echo one\ncontinued',
  ]);
  expect(parsePowerShellHistory('Write-Host one`\ncontinued\n')).toEqual([
    'Write-Host one\ncontinued',
  ]);
});
