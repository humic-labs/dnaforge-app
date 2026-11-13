import { describe, expect, it } from 'vitest';
import { remoteSshInvocation } from './remote-ssh-command';

describe('SSH execution runtime carried with the authenticated connection', () => {
  it('keeps native SSH arguments unchanged', () => {
    expect(
      remoteSshInvocation({ executable: '/usr/bin/ssh' }, ['-S', '/tmp/control', 'lab'])
    ).toEqual({ executable: '/usr/bin/ssh', args: ['-S', '/tmp/control', 'lab'] });
  });

  it('pins WSL distribution and Linux SSH executable without shell interpretation', () => {
    const command = {
      executable: 'C:\\Windows\\System32\\wsl.exe',
      prefixArgs: ['--distribution', 'Research Linux', '--exec', '/usr/bin/ssh'],
    };
    const args = ['-S', '/tmp/df-host-abc/control', 'lab', 'python3', '-u', '-'];
    expect(remoteSshInvocation(command, args)).toEqual({
      executable: command.executable,
      args: [...command.prefixArgs, ...args],
    });
    expect(args).toEqual(['-S', '/tmp/df-host-abc/control', 'lab', 'python3', '-u', '-']);
  });
});
