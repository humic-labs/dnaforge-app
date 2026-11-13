import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  buildManagedSshLoginArgs,
  buildExistingSshArgs,
  RemoteHostService,
} from './remote-host-service';
import { RemoteHostRuntime } from './remote-host-runtime';

describe('remote host authentication boundary', () => {
  it('leaves institution configuration evaluation to the requested interactive terminal', async () => {
    const runtime = new RemoteHostRuntime('linux', '/usr/bin/ssh');
    const runSsh = vi.spyOn(runtime, 'runSsh').mockImplementation(async (args) => {
      if (args.includes('-G')) throw new Error('Institution configuration requires its terminal.');
      return '';
    });
    vi.spyOn(runtime, 'createRoot').mockResolvedValue('/tmp/df-host-native-config');
    const write = vi.spyOn(runtime, 'write').mockResolvedValue(undefined);
    vi.spyOn(runtime, 'removeRoot').mockResolvedValue(undefined);
    vi.spyOn(runtime, 'isSocket').mockResolvedValue(false);
    const launchTerminal = vi.fn(async () => undefined);
    const service = new RemoteHostService({ runtime, launchTerminal, allowExternalSharing: false });
    try {
      expect((await service.signIn('institution-host')).state).toBe('signing-in');
      expect(launchTerminal).toHaveBeenCalledTimes(1);
      expect(runSsh).not.toHaveBeenCalled();
      const script = write.mock.calls.find(([file]) => file.endsWith('/Sign in.command'))?.[1];
      expect(script).toContain("'/usr/bin/ssh'");
      expect(script).toContain("'institution-host'");
      expect(script).toContain('< /dev/tty');
      expect(script).toContain('login.result');
    } finally {
      await service.stopAll();
    }
  });

  it('uses ordinary interactive OpenSSH and an isolated app-owned control socket', () => {
    const args = buildManagedSshLoginArgs(
      'researcher@login.example.edu',
      '/tmp/df-host/private/control'
    );
    expect(args).toContain('BatchMode=no');
    expect(args).toContain('ControlPersist=10m');
    expect(args).toContain('ClearAllForwardings=yes');
    expect(args).toContain('/tmp/df-host/private/control');
    expect(args.at(-1)).toBe('researcher@login.example.edu');
    expect(args).not.toContain('StrictHostKeyChecking=no');
    expect(() => buildManagedSshLoginArgs('-oProxyCommand=evil', '/tmp/control')).toThrow();
  });

  it('cannot fall back to a fresh network authentication when a borrowed master disappears', () => {
    const args = buildExistingSshArgs('lab-hpc', '/tmp/control');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ControlMaster=no');
    expect(args).toContain('ProxyCommand=false');
    expect(args).toContain('ProxyJump=none');
  });

  it('does not start an SSH login when checking an unknown host', async () => {
    const service = new RemoteHostService({
      sshPath: '/definitely-missing/ssh',
      allowExternalSharing: false,
    });
    const status = await service.checkAccess('lab-hpc');
    expect(status.state).toBe('needs-authentication');
    expect(status.checkedAt).toBeNull();
    expect(status.lastFailure?.code).toBe('authentication-required');
    await service.stopAll();
  });

  it.skipIf(process.platform === 'win32')(
    'reports an accepted Terminal request that never starts its login command',
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const launchTerminal = vi.fn(async () => undefined);
      const service = new RemoteHostService({
        sshPath: '/usr/bin/ssh',
        allowExternalSharing: false,
        launchTerminal,
      });
      try {
        expect((await service.signIn('synthetic-handoff.invalid')).state).toBe('signing-in');
        vi.setSystemTime(Date.now() + 30_001);
        const status = await service.checkAccess('synthetic-handoff.invalid');
        expect(status.state).toBe('needs-authentication');
        expect(status.lastFailure?.code).toBe('helper-failed');
        expect(status.lastFailure?.message).toContain('Terminal');
        expect(launchTerminal).toHaveBeenCalledTimes(1);
      } finally {
        await service.stopAll();
        vi.useRealTimers();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'keeps waiting for institution MFA after the native login command has started',
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const launchTerminal = vi.fn(async (scriptPath: string) => {
        await writeFile(join(dirname(scriptPath), 'login.pid'), String(process.pid));
      });
      const service = new RemoteHostService({
        sshPath: '/usr/bin/ssh',
        allowExternalSharing: false,
        launchTerminal,
      });
      try {
        await service.signIn('synthetic-started-mfa.invalid');
        vi.setSystemTime(Date.now() + 9 * 60_000);
        const status = await service.checkAccess('synthetic-started-mfa.invalid');
        expect(status.state).toBe('signing-in');
        expect(status.lastFailure).toBeNull();
        expect(launchTerminal).toHaveBeenCalledTimes(1);
      } finally {
        await service.stopAll();
        vi.useRealTimers();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'fences a delayed Terminal launch after cancellation',
    async () => {
      let scriptPath = '';
      let opened!: () => void;
      let finishLaunch!: () => void;
      const launched = new Promise<void>((resolve) => {
        opened = resolve;
      });
      const service = new RemoteHostService({
        sshPath: '/usr/bin/ssh',
        allowExternalSharing: false,
        launchTerminal: vi.fn((path) => {
          scriptPath = path;
          opened();
          return new Promise<void>((resolve) => {
            finishLaunch = resolve;
          });
        }),
      });
      try {
        const signingIn = service.signIn('synthetic-cancel.invalid');
        await launched;
        await service.endConnection('synthetic-cancel.invalid');
        finishLaunch();
        expect((await signingIn).state).toBe('not-checked');
        const script = await readFile(scriptPath, 'utf8');
        expect(script).toContain('cancelled');
        await expect(promisify(execFile)('/bin/sh', [scriptPath])).resolves.toMatchObject({
          stdout: '',
        });
        expect((await service.checkAccess('synthetic-cancel.invalid')).state).toBe(
          'needs-authentication'
        );
      } finally {
        await service.stopAll();
      }
    }
  );
});
