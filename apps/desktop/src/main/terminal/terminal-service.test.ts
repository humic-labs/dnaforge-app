import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile: vi.fn(original.execFile) };
});

import { TerminalService } from './terminal-service';
import * as completion from './completion';
import * as shellLaunch from './shell-launch';
import { TerminalHistory } from './history';
import type { TerminalHistoryProvider } from './history';

function fixture(
  environment?: NodeJS.ProcessEnv,
  history?: TerminalHistoryProvider,
  integrationRoot: string | null = null,
  runtimePolicy?: Record<string, unknown>,
  hostPlatform?: NodeJS.Platform,
  shellPath = '/bin/zsh'
) {
  let receive: (data: string) => void = () => undefined;
  let automaticExit = true;
  const exits: Array<() => void> = [];
  const process = {
    pid: 4242,
    process: 'zsh',
    onData: vi.fn((listener: (data: string) => void) => {
      receive = listener;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  const events: unknown[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const service = new TerminalService({
    spawn: vi.fn((_file, _args, options) => {
      environments.push({ ...options?.env });
      let exit: (() => void) | undefined;
      return {
        ...process,
        onExit: (listener: (event: { exitCode: number }) => void) => {
          let active = true;
          exit = () => {
            if (active) listener({ exitCode: 0 });
          };
          exits.push(exit);
          return {
            dispose: () => {
              active = false;
            },
          };
        },
        kill: () => {
          process.kill();
          if (automaticExit && exit) queueMicrotask(exit);
        },
      };
    }),
    environment,
    history,
    ...(runtimePolicy ? { runtimePolicy } : {}),
    ...(hostPlatform ? { platform: hostPlatform } : {}),
    profiles: [{ id: 'zsh', name: 'zsh', path: shellPath, args: ['-il'] }],
    integrationRoot,
    emit: (_owner, event) => events.push(event),
  });
  return {
    service,
    process,
    events,
    environments,
    output: (text: string) => receive(text),
    deferExit: () => {
      automaticExit = false;
    },
    exit: (index = 0) => exits[index]?.(),
  };
}

describe('native terminal ownership and stream lifecycle', () => {
  it('retains live color-report subscriptions across native renderer attachments', async () => {
    const f = fixture();
    const session = await f.service.create(1, { cwd: '/tmp' });
    try {
      f.output('\x1b[?2031;2004h');
      await f.service.flush(1, session.id);
      const first = await f.service.attach(1, session.id);
      expect(first.session.colorSchemeReports).toBe(true);
      await f.service.detach(1, session.id, first.attachmentId);
      const second = await f.service.attach(1, session.id);
      expect(second.session.colorSchemeReports).toBe(true);
      f.output('\x1b[?2031l');
      await f.service.flush(1, session.id);
      expect(f.service.list(1)[0]?.colorSchemeReports).toBe(false);
      f.output('\x1b[?2031h\x1bc');
      await f.service.flush(1, session.id);
      expect(f.service.list(1)[0]?.colorSchemeReports).toBe(false);
    } finally {
      await f.service.dispose();
    }
  });
  it('refreshes completion once when queued PTY echo arrives during discovery', async () => {
    const f = fixture();
    const session = await f.service.create(1, { cwd: '/tmp' });
    const discover = vi.spyOn(completion, 'suggestTerminalCompletions');
    try {
      f.output('\x1b]633;A\x07$ \x1b]633;B\x07git sta');
      await f.service.flush(1, session.id);
      discover.mockImplementationOnce(async () => {
        f.output('t');
        await f.service.flush(1, session.id);
        return [{ value: 'status', kind: 'command' }];
      });
      const result = await f.service.complete(1, session.id, randomUUID());
      const item = result.items.find((candidate) => candidate.label === 'status');
      expect(item).toBeDefined();
      expect(discover).toHaveBeenCalledTimes(2);
      expect(await f.service.commitCompletion(1, session.id, item!.token)).toBe(true);
      expect(f.process.write).toHaveBeenCalledExactlyOnceWith('us ');
      expect(await f.service.commitCompletion(1, session.id, item!.token)).toBe(false);
    } finally {
      discover.mockRestore();
      await f.service.dispose();
    }
  });
  it('does not refresh discovery after a new native input write', async () => {
    const f = fixture();
    const session = await f.service.create(1, { cwd: '/tmp' });
    const discover = vi.spyOn(completion, 'suggestTerminalCompletions');
    try {
      f.output('\x1b]633;A\x07$ \x1b]633;B\x07git sta');
      await f.service.flush(1, session.id);
      discover.mockImplementationOnce(async () => {
        f.service.write(1, session.id, 't');
        f.output('t');
        await f.service.flush(1, session.id);
        return [{ value: 'status', kind: 'command' }];
      });
      expect((await f.service.complete(1, session.id, randomUUID())).items).toEqual([]);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(f.process.write).toHaveBeenCalledExactlyOnceWith('t');
    } finally {
      discover.mockRestore();
      await f.service.dispose();
    }
  });
  it('bounds discovery refresh when output continues changing', async () => {
    const f = fixture();
    const session = await f.service.create(1, { cwd: '/tmp' });
    const discover = vi.spyOn(completion, 'suggestTerminalCompletions');
    try {
      f.output('\x1b]633;A\x07$ \x1b]633;B\x07git sta');
      await f.service.flush(1, session.id);
      discover.mockImplementation(async () => {
        f.output('t');
        await f.service.flush(1, session.id);
        return [{ value: 'status', kind: 'command' }];
      });
      expect((await f.service.complete(1, session.id, randomUUID())).items).toEqual([]);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(f.process.write).not.toHaveBeenCalled();
    } finally {
      discover.mockRestore();
      await f.service.dispose();
    }
  });
  it.skipIf(process.platform === 'win32')(
    'retains native PowerShell metadata through a nine-second discovery delay',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'terminal-powershell-cold-'));
      const shell = join(cwd, 'pwsh');
      await writeFile(
        shell,
        `#!${process.execPath}\nlet input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => input += value); process.stdin.on('end', () => { if (JSON.parse(input) !== 'Get-Chi' || !process.argv.includes('-EncodedCommand')) process.exit(2); process.stdout.write(JSON.stringify({CompletionText: 'Get-ChildItem', ResultType: 2})); });\n`
      );
      await chmod(shell, 0o755);
      const f = fixture({ HOME: cwd, PATH: '' }, undefined, null, undefined, undefined, shell);
      try {
        const session = await f.service.create(1, { cwd });
        f.output('\x1b]633;A\x07PS> \x1b]633;B\x07Get-Chi');
        await f.service.flush(1, session.id);
        const nativeCandidates = await completion.suggestTerminalCompletions(
          { input: 'Get-Chi', cwd, shellPath: shell, environment: { HOME: cwd, PATH: '' } },
          new AbortController().signal
        );
        expect(nativeCandidates).toContainEqual(
          expect.objectContaining({ value: 'Get-ChildItem' })
        );
        const nativeCall = [...vi.mocked(execFile).mock.calls]
          .reverse()
          .find(([file]) => file === shell);
        expect(nativeCall?.[2]).toMatchObject({ timeout: 12_000, windowsHide: true });
        const discover = vi.spyOn(completion, 'suggestTerminalCompletions');
        let discoverySignal: AbortSignal | undefined;
        try {
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          discover.mockImplementation((_context, signal) => {
            discoverySignal = signal;
            return new Promise<typeof nativeCandidates>((resolve) => {
              const timer = setTimeout(() => resolve(nativeCandidates), 9000);
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  resolve([]);
                },
                { once: true }
              );
            });
          });
          let completed = false;
          const pending = f.service.complete(1, session.id, randomUUID()).then((result) => {
            completed = true;
            return result;
          });
          await vi.waitFor(() => expect(discoverySignal).toBeDefined());
          await vi.advanceTimersByTimeAsync(4500);
          expect(discoverySignal?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(4501);
          await vi.waitFor(() => expect(completed).toBe(true));
          const result = await pending;
          const item = result.items.find((candidate) => candidate.label === 'Get-ChildItem');
          expect(item).toBeDefined();
          vi.useRealTimers();
          expect(await f.service.commitCompletion(1, session.id, item!.token)).toBe(true);
          expect(f.process.write).toHaveBeenCalledExactlyOnceWith('ldItem ');
          expect(await f.service.commitCompletion(1, session.id, item!.token)).toBe(false);
        } finally {
          vi.useRealTimers();
          discover.mockRestore();
        }
      } finally {
        await f.service.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    15_000
  );
  it('fences completion tokens by owner, cancellation and input even before PTY echo', async () => {
    const f = fixture();
    const session = await f.service.create(1, { cwd: '/tmp' });
    try {
      f.output('\x1b]633;A\x07$ \x1b]633;B\x07git sta');
      await f.service.flush(1, session.id);
      const result = await f.service.complete(1, session.id, randomUUID());
      const token = result.items.find((item) => item.label === 'status')!.token;
      await expect(f.service.commitCompletion(2, session.id, token)).rejects.toThrow('not owned');
      f.service.cancelCompletions(1, result.requestId);
      expect(await f.service.commitCompletion(1, session.id, token)).toBe(false);
      const next = await f.service.complete(1, session.id, randomUUID());
      const stale = next.items.find((item) => item.label === 'status')!.token;
      f.service.write(1, session.id, 'x');
      expect(await f.service.commitCompletion(1, session.id, stale)).toBe(false);
      expect(f.process.write).toHaveBeenCalledExactlyOnceWith('x');
    } finally {
      await f.service.dispose();
    }
  });
  it('does not treat the Windows terminal type as an idle shell foreground process', async () => {
    const root = new URL('../../../resources/terminal-shell-integration', import.meta.url).pathname;
    const f = fixture(undefined, undefined, root, { confirmBusyClose: true }, 'win32');
    f.process.process = 'xterm-256color';
    const session = await f.service.create(1, { cwd: '/tmp' });
    try {
      f.output('\x1b]633;A\x07PS> \x1b]633;B\x07');
      await f.service.flush(1, session.id);
      expect(f.service.closeStatus(1, session.id).requiresConfirmation).toBe(false);
    } finally {
      await f.service.dispose();
    }
  });
  it('uses the current inheritance policy and application environment when explicitly relaunching a shell', async () => {
    const f = fixture(
      { HOME: '/tmp', PATH: '/bin', PRIVATE_VALUE: 'current-value' },
      undefined,
      null,
      { inheritEnvironment: false }
    );
    try {
      const first = await f.service.create(1, { cwd: '/tmp' });
      expect(f.environments[0]).not.toHaveProperty('PRIVATE_VALUE');
      f.service.configureRuntimePolicy({ inheritEnvironment: true });
      await f.service.relaunch(1, first.id);
      expect(f.environments[1]?.PRIVATE_VALUE).toBe('current-value');
    } finally {
      await f.service.dispose();
    }
  });
  it('requires configured busy-close confirmation from native command state without affecting prompt shells', async () => {
    const root = new URL('../../../resources/terminal-shell-integration', import.meta.url).pathname;
    const f = fixture(undefined, undefined, root, { confirmBusyClose: true });
    const session = await f.service.create(1, { cwd: '/tmp' });
    try {
      f.output('\x1b]633;A\x07$ \x1b]633;B\x07');
      await f.service.flush(1, session.id);
      expect(f.service.closeStatus(1, session.id).requiresConfirmation).toBe(false);
      f.output(`\x1b]633;E;sleep 60;${f.environments[0]?.VSCODE_NONCE}\x07\x1b]633;C\x07`);
      await f.service.flush(1, session.id);
      expect(f.service.closeStatus(1, session.id).requiresConfirmation).toBe(true);
      expect(() => f.service.closeStatus(2, session.id)).toThrow(/window/);
      expect(f.process.kill).not.toHaveBeenCalled();
    } finally {
      await f.service.dispose();
    }
  });
  it('limits inherited environment while preserving OS paths and explicit profile choices', async () => {
    const f = fixture(
      { HOME: '/tmp', PATH: '/bin', PRIVATE_VALUE: 'private', LANG: 'C' },
      undefined,
      null,
      { inheritEnvironment: false, locale: 'utf8' }
    );
    f.service.configureProfiles({
      profiles: [
        {
          id: 'custom',
          name: 'custom',
          path: '/bin/zsh',
          args: [],
          env: { EXPLICIT: 'kept', LANG: null },
        },
      ],
    });
    try {
      await f.service.create(1, { cwd: '/tmp' });
      expect(f.environments[0]).not.toHaveProperty('PRIVATE_VALUE');
      expect(f.environments[0]?.PATH).toBe('/bin');
      expect(f.environments[0]?.LANG).toMatch(/UTF-8$/);
      await f.service.create(1, { cwd: '/tmp', profileId: 'custom' });
      expect(f.environments[1]?.EXPLICIT).toBe('kept');
      expect(f.environments[1]).not.toHaveProperty('LANG');
    } finally {
      await f.service.dispose();
    }
  });
  it('lets the shell erase its wrapped input after narrowing without retaining fragments in replay', async () => {
    const f = fixture();
    const session = await f.service.create(1, { cwd: '/tmp', cols: 20, rows: 10 });
    try {
      f.output('$ ' + 'UNEXECUTED_'.repeat(4));
      await f.service.flush(1, session.id);
      f.service.resize(1, session.id, 10, 10);
      f.output('\r\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r$ ');
      const attached = await f.service.attach(1, session.id);
      const { default: headless } = await import('@xterm/headless');
      const mirror = new headless.Terminal({ cols: 10, rows: 10, allowProposedApi: true });
      try {
        await new Promise<void>((resolve) => mirror.write(attached.replay, resolve));
        const lines = Array.from({ length: mirror.buffer.active.length }, (_, index) =>
          mirror.buffer.active.getLine(index)?.translateToString(true).trimEnd()
        ).filter(Boolean);
        expect(lines).toEqual(['$']);
        expect(f.process.resize).toHaveBeenLastCalledWith(10, 10);
      } finally {
        mirror.dispose();
      }
    } finally {
      await f.service.dispose();
    }
  });
  it('uses the selected native tab stops and Unicode widths when serializing replay', async () => {
    const f = fixture(undefined, undefined, null, { unicodeVersion: '6', tabStopWidth: 4 });
    const session = await f.service.create(1, { cwd: '/tmp' });
    try {
      f.output('🙂\tZ');
      const attached = await f.service.attach(1, session.id);
      const { default: headless } = await import('@xterm/headless');
      const mirror = new headless.Terminal({
        cols: 80,
        rows: 24,
        tabStopWidth: 4,
        allowProposedApi: true,
      });
      try {
        await new Promise<void>((resolve) => mirror.write(attached.replay, resolve));
        expect(mirror.buffer.active.cursorX).toBe(5);
        expect(mirror.buffer.active.getLine(0)?.translateToString(true)).toBe('🙂   Z');
      } finally {
        mirror.dispose();
      }
    } finally {
      await f.service.dispose();
    }
  });
  it('drains every native shell even if another shell cleanup fails', async () => {
    const prepare = shellLaunch.prepareTerminalShell;
    let cleanupFailed: () => void = () => undefined;
    const failed = new Promise<void>((resolve) => {
      cleanupFailed = resolve;
    });
    const spy = vi
      .spyOn(shellLaunch, 'prepareTerminalShell')
      .mockImplementationOnce(async (...args) => {
        const launch = await prepare(...args);
        return {
          ...launch,
          cleanup: async () => {
            await launch.cleanup();
            cleanupFailed();
            throw new Error('Synthetic shell-file removal failure');
          },
        };
      });
    const f = fixture();
    try {
      await f.service.create(1, { cwd: '/tmp' });
      await f.service.create(1, { cwd: '/tmp' });
    } finally {
      spy.mockRestore();
    }
    f.deferExit();
    let settled = false;
    const shutdown = Promise.resolve(f.service.dispose()).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    try {
      f.exit(0);
      await failed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(f.process.kill).toHaveBeenCalledTimes(2);
    } finally {
      f.exit(1);
      await shutdown;
    }
    expect(await shutdown).toBeInstanceOf(Error);
  });
  it('awaits native shell exit before application terminal shutdown completes', async () => {
    const f = fixture();
    await f.service.create(1, { cwd: '/tmp' });
    f.deferExit();
    let settled = false;
    const shutdown = Promise.resolve(f.service.dispose()).then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(f.process.kill).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(f.service.list(1)).toEqual([]);
    } finally {
      f.exit();
      await shutdown;
    }
    expect(settled).toBe(true);
  });
  it('drains a previously closed shell before application shutdown without killing it twice', async () => {
    const f = fixture();
    const session = await f.service.create(1, { cwd: '/tmp' });
    f.deferExit();
    f.service.close(1, session.id);
    let settled = false;
    const shutdown = Promise.resolve(f.service.dispose()).then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.process.kill).toHaveBeenCalledOnce();
    } finally {
      f.exit();
      await shutdown;
    }
  });
  it('does not acquire a new native shell after shutdown starts during launch preparation', async () => {
    const f = fixture();
    const opening = f.service.create(1, { cwd: '/tmp' });
    await f.service.dispose();
    await expect(opening).rejects.toThrow(/shutting down/i);
    expect(f.service.list(1)).toEqual([]);
    expect(f.process.kill).not.toHaveBeenCalled();
  });
  it('normalizes native clipboard input, brackets only when enabled, and preserves chunked Unicode', async () => {
    const { service, output, process } = fixture();
    const session = await service.create(1, { cwd: '/tmp' });
    try {
      expect(() => service.paste(2, session.id, 'private')).toThrow(/owner|window/i);
      expect(process.write).not.toHaveBeenCalled();
      service.paste(1, session.id, 'first\r\nsecond\n');
      expect(process.write).toHaveBeenCalledExactlyOnceWith('first\rsecond\r');
      process.write.mockClear();
      output('\x1b[?2004h');
      await service.flush(1, session.id);
      const text = 'x'.repeat(65_529) + '🙂\nEND';
      service.paste(1, session.id, text);
      const chunks = process.write.mock.calls.map(([data]) => data as string);
      expect(chunks.join('')).toBe(`\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`);
      expect(chunks.every((chunk) => chunk.length <= 65_536)).toBe(true);
      expect(chunks.map((chunk) => Buffer.from(chunk).toString('utf8')).join('')).not.toContain(
        '\uFFFD'
      );
    } finally {
      service.dispose();
    }
  });
  it('names sessions from command and directory metadata while preserving manual names', async () => {
    const root = new URL('../../../resources/terminal-shell-integration', import.meta.url).pathname;
    const { service, output, environments } = fixture(undefined, undefined, root);
    const session = await service.create(1, { cwd: '/tmp' });
    const nonce = environments[0]?.VSCODE_NONCE;
    try {
      output('\x1b]633;P;Cwd=/tmp/project\x07\x1b]633;B\x07');
      await service.flush(1, session.id);
      expect(service.list(1)[0]?.title).toBe('project');
      output(`\x1b]633;E;sleep 30;${nonce}\x07\x1b]633;C\x07`);
      await service.flush(1, session.id);
      expect(service.list(1)[0]?.title).toBe('sleep · project');
      service.rename(1, session.id, 'Pinned analysis');
      output('\x1b]633;D;0\x07\x1b]633;P;Cwd=/tmp/results\x07\x1b]633;B\x07');
      await service.flush(1, session.id);
      expect(service.list(1)[0]?.title).toBe('Pinned analysis');
      expect(() => service.rename(2, session.id, null)).toThrow(/owner|window/i);
      service.rename(1, session.id, null);
      expect(service.list(1)[0]?.title).toBe('results');
      output(`\x1b]633;E;python analysis.py;${nonce}\x07\x1b]633;C\x07`);
      await service.flush(1, session.id);
      expect(service.list(1)[0]?.title).toBe('python · results');
      output('\x1b]0;Analysis running\x07');
      await service.flush(1, session.id);
      expect(service.list(1)[0]?.title).toBe('Analysis running');
      output('\x1b]633;D;0\x07\x1b]633;B\x07');
      await service.flush(1, session.id);
      expect(service.list(1)[0]?.title).toBe('results');
    } finally {
      service.dispose();
    }
  });
  it('persists pending parsed command history before a session checkpoint completes', async () => {
    let saved: string | undefined;
    const storage = {
      read: () => saved,
      write: (value: string) => {
        saved = value;
      },
    };
    const history = new TerminalHistory(storage, async () => undefined);
    const root = new URL('../../../resources/terminal-shell-integration', import.meta.url).pathname;
    const { service, output, environments } = fixture(undefined, history, root);
    const session = await service.create(1, { cwd: '/tmp' });
    try {
      output(
        `\x1b]633;E;printf checkpoint;${environments[0]?.VSCODE_NONCE}\x07\x1b]633;C\x07checkpoint\r\n\x1b]633;D;0\x07`
      );
      await service.captureSessions(1);
      const restored = new TerminalHistory(storage, async () => undefined);
      expect((await restored.read('/bin/zsh', {}, '/tmp')).previousCommands).toEqual([
        { command: 'printf checkpoint', cwd: '/tmp' },
      ]);
    } finally {
      service.close(1, session.id);
    }
  });
  it('notifies the owning view when a terminal closes through the native port', async () => {
    const { service, events } = fixture();
    const session = await service.create(1, { cwd: '/tmp' });
    service.close(1, session.id);
    expect(service.list(1)).toEqual([]);
    expect(events).toContainEqual({ kind: 'removed', ids: [session.id] });
    expect(() => service.resize(1, session.id, 80, 24)).toThrow(/owner|window/i);
    service.dispose();
  });
  it('stops shells at app shutdown without telling the renderer to erase its saved layout', async () => {
    const { service, process, events } = fixture();
    await service.create(1, { cwd: '/tmp' });
    events.length = 0;
    service.dispose();
    expect(process.kill).toHaveBeenCalledOnce();
    expect(service.list(1)).toEqual([]);
    expect(events).toEqual([]);
  });
  it('relaunches without removing the old pane before its caller can replace the session identity', async () => {
    const { service, events } = fixture();
    const original = await service.create(1, { cwd: '/tmp' });
    events.length = 0;
    const replacement = await service.relaunch(1, original.id);
    expect(replacement.id).not.toBe(original.id);
    expect(service.list(1).map((session) => session.id)).toEqual([replacement.id]);
    expect(events).not.toContainEqual({ kind: 'removed', ids: [original.id] });
    service.dispose();
  });
  it('provides the native user home for links without exposing the launch environment', async () => {
    const { service } = fixture({ PRIVATE_LINK_SENTINEL: 'do-not-expose' });
    const session = await service.create(1, { cwd: '/tmp' });
    expect(session).toMatchObject({ userHome: homedir() });
    expect(session).not.toHaveProperty('environment');
    expect(session).not.toHaveProperty('env');
    expect(JSON.stringify(session)).not.toContain('do-not-expose');
    service.dispose();
  });
  it('delivers command markers with their parsed output sequence and attachment', async () => {
    const root = new URL('../../../resources/terminal-shell-integration', import.meta.url).pathname;
    const { service, output, events, environments } = fixture(undefined, undefined, root);
    const session = await service.create(1, { cwd: '/tmp', cols: 24, rows: 4 });
    const attachment = await service.attach(1, session.id);
    const data = `\x1b]633;A\x07$ printf ok\r\n\x1b]633;E;printf ok;${environments[0]?.VSCODE_NONCE}\x07\x1b]633;C\x07ok\r\n\x1b]633;D;0\x07`;
    output(data);
    await service.flush(1, session.id);
    const current = service.list(1)[0];
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'data',
        id: session.id,
        attachmentId: attachment.attachmentId,
        sequence: attachment.sequence + 1,
        data,
        commandState: { commands: current.commands, bufferBaseY: current.bufferBaseY },
      })
    );
    service.dispose();
  });
  it('keeps owned command output exact across native checkpoint revival and disables cleared ranges', async () => {
    const root = new URL('../../../resources/terminal-shell-integration', import.meta.url).pathname;
    const first = fixture(undefined, undefined, root);
    const session = await first.service.create(1, { cwd: '/tmp', cols: 12, rows: 4 });
    const nonce = first.environments[0]?.VSCODE_NONCE;
    expect(nonce).toBeTruthy();
    first.output(
      `\x1b]633;A\x07PROMPT> echo\r\n\x1b]633;E;printf known;${nonce}\x07\x1b]633;C\x07ONLY_THIS_OUTPUT\r\n\x1b]633;D;0\x07NEXT_PROMPT> `
    );
    await first.service.flush(1, session.id);
    const command = first.service.list(1)[0]?.commands[0];
    expect(command?.id).toBeTruthy();
    const commandId = command?.id ?? '';
    await expect(first.service.commandOutput(2, session.id, commandId)).rejects.toThrow(
      /owner|window/i
    );
    expect(await first.service.commandOutput(1, session.id, commandId)).toBe('ONLY_THIS_OUTPUT\n');
    const saved = await first.service.captureSessions(1);
    first.service.dispose();
    const next = fixture();
    await next.service.restoreSessions(1, saved);
    expect(await next.service.commandOutput(1, session.id, commandId)).toBe('ONLY_THIS_OUTPUT\n');
    await next.service.clear(1, session.id);
    expect(await next.service.commandOutput(1, session.id, commandId)).toBeUndefined();
    next.service.dispose();
  });
  it('checks session ownership before reading native history or its private environment', async () => {
    const history = {
      recordCommand: vi.fn(),
      recordDirectory: vi.fn(),
      read: vi.fn(async () => ({ previousCommands: [], directories: [], shellCommands: [] })),
    };
    const { service, output } = fixture({ PRIVATE_SENTINEL: 'native-only' }, history);
    const session = await service.create(1, { cwd: '/tmp' });
    await expect(service.history(2, session.id)).rejects.toThrow(/owner|window/i);
    expect(history.read).not.toHaveBeenCalled();
    await service.history(1, session.id);
    expect(history.read).toHaveBeenCalledWith(
      '/bin/zsh',
      expect.objectContaining({ PRIVATE_SENTINEL: 'native-only' }),
      '/tmp'
    );
    output('\x1b]633;E;forged;invalid-nonce\x07\x1b]633;P;Cwd=/tmp\x07');
    await service.flush(1, session.id);
    expect(history.recordCommand).not.toHaveBeenCalled();
    expect(history.recordDirectory).toHaveBeenCalledWith('/tmp');
    service.dispose();
  });
  it('keeps owned fixed dimensions authoritative over automatic resize requests', async () => {
    const { service, process } = fixture();
    const session = await service.create(1, { cwd: '/tmp' });
    expect(() => service.setFixedDimensions(2, session.id, { cols: 120 })).toThrow(/owner|window/i);
    expect(() => service.setFixedDimensions(1, session.id, { cols: 0 })).toThrow(/dimension/i);
    expect(() => Reflect.apply(service.setFixedDimensions, service, [1, session.id, null])).toThrow(
      /dimension/i
    );
    const fixed = { cols: 120, rows: 40 };
    service.setFixedDimensions(1, session.id, fixed);
    fixed.cols = 20;
    service.resize(1, session.id, 30, 5);
    expect(service.list(1)[0]).toMatchObject({
      cols: 120,
      rows: 40,
      fixedDimensions: { cols: 120, rows: 40 },
    });
    expect(process.resize).toHaveBeenLastCalledWith(120, 40);
    service.setFixedDimensions(1, session.id, { cols: 120 });
    service.resize(1, session.id, 30, 12);
    expect(service.list(1)[0]).toMatchObject({ cols: 120, rows: 12 });
    service.setFixedDimensions(1, session.id, {});
    service.resize(1, session.id, 80, 24);
    expect(service.list(1)[0]).toMatchObject({ cols: 80, rows: 24 });
    expect(service.list(1)[0]?.fixedDimensions).toBeUndefined();
    service.dispose();
  });

  it('retains fixed dimensions across transfer, app revival and explicit relaunch', async () => {
    const first = fixture();
    const session = await first.service.create(1, { cwd: '/tmp' });
    first.service.setFixedDimensions(1, session.id, { cols: 120, rows: 40 });
    first.service.transferSessions(1, 2, [session.id]);
    first.service.resize(2, session.id, 30, 5);
    const saved = await first.service.captureSessions(2);
    first.service.dispose();
    const next = fixture();
    await next.service.restoreSessions(3, saved);
    next.service.resize(3, session.id, 30, 5);
    expect(next.service.list(3)[0]).toMatchObject({
      cols: 120,
      rows: 40,
      fixedDimensions: { cols: 120, rows: 40 },
    });
    const relaunched = await next.service.relaunch(3, session.id);
    next.service.resize(3, relaunched.id, 30, 5);
    expect(next.service.list(3)[0]).toMatchObject({
      cols: 120,
      rows: 40,
      fixedDimensions: { cols: 120, rows: 40 },
    });
    next.service.dispose();
  });
  it('clears parsed scrollback while preserving the current prompt and ownership', async () => {
    const { service, output, events } = fixture();
    const session = await service.create(1, { cwd: '/tmp' });
    output('ERASED_HISTORY\r\nCURRENT_PROMPT> ');
    const original = await service.attach(1, session.id);
    await expect(service.clear(2, session.id)).rejects.toThrow(/owner|window/i);
    await service.clear(1, session.id);
    const replay = await service.attach(1, session.id);
    expect(replay.replay).not.toContain('ERASED_HISTORY');
    expect(replay.replay).toContain('CURRENT_PROMPT>');
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'clear', attachmentId: original.attachmentId })
    );
    service.dispose();
  });
  it('revives from the current environment and only retains explicit profile overrides', async () => {
    const first = fixture({ DNAFORGE_TERMINAL_LAUNCH_TEST: 'first-launch', PATH: '/usr/bin:/bin' });
    first.service.configureProfiles({
      profiles: [
        {
          id: 'private-profile',
          name: 'Private profile',
          path: '/bin/zsh',
          args: ['-i'],
          env: { PROFILE_VALUE: 'configured', REMOVED_VALUE: null },
        },
      ],
    });
    await first.service.create(1, { cwd: '/tmp', profileId: 'private-profile' });
    const saved = await first.service.captureSessions(1);
    expect(saved[0]).not.toHaveProperty('environment');
    first.service.dispose();
    const next = fixture({
      DNAFORGE_TERMINAL_LAUNCH_TEST: 'different-launch',
      PATH: '/different-path',
      PROFILE_VALUE: 'inherited',
      REMOVED_VALUE: 'must-be-removed',
    });
    await next.service.restoreSessions(2, saved);
    expect(next.environments[0]?.DNAFORGE_TERMINAL_LAUNCH_TEST).toBe('different-launch');
    expect(next.environments[0]?.PATH).toBe('/different-path');
    expect(next.environments[0]?.PROFILE_VALUE).toBe('configured');
    expect(next.environments[0]).not.toHaveProperty('REMOVED_VALUE');
    next.service.dispose();
  });
  it('keeps credentials out of saved sessions and revives them from the current application', async () => {
    const first = fixture({
      DNAFORGE_TERMINAL_LAUNCH_TEST: 'first-launch',
      ANTHROPIC_API_KEY: 'first-launch-key',
      DNAFORGE_MCP_SESSION_TOKEN: 'first-launch-token',
    });
    await first.service.create(1, { cwd: '/tmp' });
    const saved = await first.service.captureSessions(1);
    first.service.dispose();
    expect(JSON.stringify(saved)).not.toMatch(/first-launch-(key|token)/);
    const next = fixture({
      DNAFORGE_TERMINAL_LAUNCH_TEST: 'current-launch',
      ANTHROPIC_API_KEY: 'current-key',
    });
    await next.service.restoreSessions(2, saved);
    expect(next.environments[0]?.DNAFORGE_TERMINAL_LAUNCH_TEST).toBe('current-launch');
    expect(next.environments[0]?.ANTHROPIC_API_KEY).toBe('current-key');
    expect(next.environments[0]).not.toHaveProperty('DNAFORGE_MCP_SESSION_TOKEN');
    next.service.dispose();
  });
  it('transfers a live session between windows without allowing its previous owner to write', async () => {
    const { service, process, output, events } = fixture();
    const session = await service.create(1, { cwd: '/tmp' });
    const original = await service.attach(1, session.id);
    service.transferSessions(1, 2, [session.id]);
    expect(service.list(1)).toEqual([]);
    expect(service.list(2)[0]?.pid).toBe(session.pid);
    expect(() => service.write(1, session.id, 'wrong window\r')).toThrow(/owner|window/i);
    expect(process.kill).not.toHaveBeenCalled();
    const moved = await service.attach(2, session.id);
    expect(moved.attachmentId).not.toBe(original.attachmentId);
    expect(() => service.detach(1, session.id, original.attachmentId)).not.toThrow();
    expect(() =>
      service.acknowledge(1, session.id, original.attachmentId, original.sequence)
    ).not.toThrow();
    expect(() => service.detach(1, session.id, 'unrelated-token')).toThrow(/owner|window/i);
    output('MOVED_OUTPUT\r\n');
    await service.flush(2, session.id);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'data', id: session.id, attachmentId: moved.attachmentId })
    );
    service.write(2, session.id, 'correct window\r');
    expect(process.write).toHaveBeenCalledWith('correct window\r');
    service.dispose();
  });
  it('revives stable identities, cwd, names and parsed output without executing old commands', async () => {
    const first = fixture();
    const session = await first.service.create(1, { cwd: '/tmp' });
    first.service.rename(1, session.id, 'Analysis shell');
    first.output('RESTORED_MARKER\r\n');
    const saved = await first.service.captureSessions(1);
    first.service.dispose();
    const second = fixture();
    await second.service.restoreSessions(2, saved);
    const restored = second.service.list(2)[0]!;
    expect(restored.id).toBe(session.id);
    expect(restored.title).toBe('Analysis shell');
    expect(restored.cwd).toBe('/tmp');
    expect(
      (await second.service.attach(2, restored.id)).replay.match(/RESTORED_MARKER/g)
    ).toHaveLength(1);
    expect(second.process.write).not.toHaveBeenCalled();
    expect(second.service.list(1)).toEqual([]);
    second.service.dispose();
  });

  it('keeps the old terminal available when a relaunch cannot spawn its replacement', async () => {
    const { service, process } = fixture();
    const session = await service.create(1, { cwd: '/tmp' });
    await expect(service.relaunch(2, session.id)).rejects.toThrow(/owner|window/i);
    await expect(
      service.relaunch(1, session.id, { cwd: '/no-such-terminal-directory' })
    ).rejects.toThrow();
    expect(service.list(1)).toHaveLength(1);
    expect(process.kill).not.toHaveBeenCalled();
    service.dispose();
  });

  it('refuses cross-window read, input, resize, attachment and termination', async () => {
    const { service, process } = fixture();
    const session = await service.create(10, { cwd: '/tmp' });
    expect(service.list(11)).toEqual([]);
    expect(() => service.write(11, session.id, 'secret\r')).toThrow(/owner|window/i);
    expect(() => service.resize(11, session.id, 80, 24)).toThrow(/owner|window/i);
    await expect(service.attach(11, session.id)).rejects.toThrow(/owner|window/i);
    expect(() => service.close(11, session.id)).toThrow(/owner|window/i);
    expect(process.kill).not.toHaveBeenCalled();
    service.closeOwner(10);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('replays parsed state without duplicating output and fences old acknowledgements', async () => {
    const { service, output, process } = fixture();
    const session = await service.create(1, { cwd: '/tmp', cols: 80, rows: 24 });
    output('BEFORE_ATTACH\r\n');
    const first = await service.attach(1, session.id);
    expect(first.replay).toContain('BEFORE_ATTACH');
    output('AFTER_ATTACH\r\n');
    const second = await service.attach(1, session.id);
    expect(second.replay.match(/BEFORE_ATTACH/g)).toHaveLength(1);
    expect(second.replay.match(/AFTER_ATTACH/g)).toHaveLength(1);
    expect(second.attachmentId).not.toBe(first.attachmentId);
    service.detach(1, session.id, first.attachmentId);
    service.acknowledge(1, session.id, first.attachmentId, second.sequence);
    service.write(1, session.id, 'echo alive\r');
    expect(process.write).toHaveBeenCalledWith('echo alive\r');
    service.closeOwner(1);
  });

  it('rejects malformed dimensions and oversized input before touching the process', async () => {
    const { service, process } = fixture();
    await expect(service.create(1, { cwd: '/tmp', cols: -1 })).rejects.toThrow(/dimensions/i);
    const session = await service.create(1, { cwd: '/tmp' });
    for (const value of [0, -1, 1.5, NaN, Infinity, 10_000]) {
      expect(() => service.resize(1, session.id, value, 24)).toThrow(/dimensions/i);
    }
    expect(() => service.write(1, session.id, 'x'.repeat(65_537))).toThrow(/input/i);
    expect(process.resize).not.toHaveBeenCalled();
    expect(process.write).not.toHaveBeenCalled();
    service.closeOwner(1);
  });

  it('preserves binary terminal mouse reports rather than encoding bytes as UTF-8', async () => {
    const { service, process } = fixture();
    const session = await service.create(1, { cwd: '/tmp' });
    service.write(1, session.id, '\xff', 'binary');
    expect(process.write).toHaveBeenCalledWith(Buffer.from([255]));
    service.closeOwner(1);
  });

  it('uses high/low-water flow control and releases a detached renderer', async () => {
    const { service, output, process } = fixture();
    const session = await service.create(1, { cwd: '/tmp' });
    const attached = await service.attach(1, session.id);
    output('x'.repeat(150_000));
    expect(process.pause).toHaveBeenCalled();
    await service.flush(1, session.id);
    service.detach(1, session.id, attached.attachmentId);
    expect(process.resume).toHaveBeenCalled();
    service.closeOwner(1);
  });
});
