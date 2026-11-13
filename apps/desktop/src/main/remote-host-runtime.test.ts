import { describe, expect, it } from 'vitest';
import {
  linuxTerminalInvocation,
  executeTerminalLaunchAcknowledgement,
  quoteWindowsArgument,
  RemoteHostRuntime,
} from './remote-host-runtime';

describe('native host runtime', () => {
  it('acknowledges the actual launcher PID while its output pipe remains open', async () => {
    const pid = await executeTerminalLaunchAcknowledgement(
      process.execPath,
      ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'],
      2_000
    );
    try {
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      process.kill(pid, 'SIGTERM');
    }
  });

  it('rejects a launcher that exits without acknowledging a console', async () => {
    await expect(
      executeTerminalLaunchAcknowledgement(process.execPath, ['-e', 'process.exit(7)'], 2_000)
    ).rejects.toThrow('did not acknowledge');
  });

  it('bounds a launcher that never produces its process receipt', async () => {
    await expect(
      executeTerminalLaunchAcknowledgement(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        100
      )
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('uses terminal-specific Linux argument conventions', () => {
    const script = '/tmp/df-host-fixture/Sign in.command';
    expect(linuxTerminalInvocation('/usr/bin/gnome-terminal', script).args).toEqual([
      '--',
      '/bin/sh',
      script,
    ]);
    expect(linuxTerminalInvocation('/usr/bin/konsole', script).args).toEqual([
      '-e',
      '/bin/sh',
      script,
    ]);
    expect(linuxTerminalInvocation('/usr/bin/xfce4-terminal', script).args).toEqual([
      '--disable-server',
      '--execute',
      '/bin/sh',
      script,
    ]);
  });

  it('preserves Windows process arguments containing spaces, quotes and trailing slashes', () => {
    expect(quoteWindowsArgument('Research Linux')).toBe('"Research Linux"');
    expect(quoteWindowsArgument('say"hello')).toBe('"say\\"hello"');
    expect(quoteWindowsArgument('C:\\some directory\\')).toBe('"C:\\some directory\\\\"');
    expect(quoteWindowsArgument('')).toBe('""');
  });

  it('carries the exact WSL distribution with its authenticated runtime', () => {
    const runtime = new RemoteHostRuntime('win32', '/usr/bin/ssh', {
      executable: 'C:\\Windows\\System32\\wsl.exe',
      distribution: 'Institution Linux',
      user: 'researcher',
    });
    expect(runtime.sshCommand).toEqual({
      executable: 'C:\\Windows\\System32\\wsl.exe',
      runtime: 'wsl',
      prefixArgs: [
        '--distribution',
        'Institution Linux',
        '--user',
        'researcher',
        '--exec',
        '/usr/bin/ssh',
      ],
    });
    expect(runtime.shellCommand(['-S', '/tmp/control', 'lab'])).toBe(
      "'/usr/bin/ssh' '-S' '/tmp/control' 'lab'"
    );
  });

  it('refuses lifecycle deletion outside positively identified private host roots', async () => {
    const runtime = new RemoteHostRuntime(process.platform, '/usr/bin/ssh');
    await expect(runtime.removeRoot('/tmp/user-project')).rejects.toThrow('unowned');
    await expect(runtime.removeRoot('/tmp/df-host-abc/../user-project')).rejects.toThrow('unowned');
  });
});
