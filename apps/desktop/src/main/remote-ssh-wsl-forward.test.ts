import { describe, expect, it, vi } from 'vitest';
import { WslSshForwarder, waitForWslLoopback, parseWslNatAddress } from './remote-ssh-wsl-forward';
import { createServer } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
const loopbackReady = async () => true;
const controlCalls = (run: { mock: { calls: unknown[][] } }) =>
  run.mock.calls.filter((call) => (call[1] as string[]).includes('-O'));

const input = {
  sshPath: '/usr/bin/ssh',
  sshCommand: {
    executable: 'C:\\Windows\\System32\\wsl.exe',
    runtime: 'wsl' as const,
    prefixArgs: [
      '--distribution',
      'Institution Linux',
      '--user',
      'researcher',
      '--exec',
      '/usr/bin/ssh',
    ],
  },
  target: 'lab-hpc',
  controlPath: '/tmp/df-host-fixture/control',
  localPort: 55123,
  remotePort: 32789,
};

describe('OpenSSH-owned WSL loopback forwarding', () => {
  it('accepts only a private NAT guest address and keeps mirrored networking on loopback', () => {
    expect(parseWslNatAddress('nat\n[{"prefsrc":"172.28.64.2"}]')).toBe('172.28.64.2');
    expect(parseWslNatAddress('mirrored\n')).toBeNull();
    expect(parseWslNatAddress('unknown\n')).toBeNull();
    for (const value of ['8.8.8.8', '127.0.0.1', '0.0.0.0', '172.32.0.1', '10.0.0.999'])
      expect(() => parseWslNatAddress(`nat\n[{"prefsrc":"${value}"}]`)).toThrow();
    expect(() => parseWslNatAddress('nat\n[]')).toThrow();
  });
  it('uses a Windows-owned TCP listener for an admitted private NAT guest address', async () => {
    const run = vi.fn(async (_exe: string, args: readonly string[]) =>
      args.includes('/bin/sh') ? 'nat\n[{"prefsrc":"172.28.64.2"}]' : ''
    );
    const close = vi.fn(async () => undefined);
    const bridge = vi.fn(async () => ({ close }));
    const ready = vi.fn(async () => false);
    const forwarder = new WslSshForwarder(run, ready, bridge);
    expect(await forwarder.add(input)).toBe(true);
    expect(bridge).toHaveBeenCalledWith(input.localPort, '172.28.64.2', input.localPort);
    expect(ready).not.toHaveBeenCalled();
    expect(run.mock.calls.find(([, args]) => args.includes('forward'))?.[1]).toContain(
      '172.28.64.2:55123:127.0.0.1:32789'
    );
    await forwarder.cancel(input);
    expect(close).toHaveBeenCalledOnce();
    expect(run.mock.calls.at(-1)?.[1]).toContain('172.28.64.2:55123:127.0.0.1:32789');
    expect(run.mock.calls.every(([, args]) => !args.includes('exit'))).toBe(true);
  });

  it('closes the Windows NAT listener if OpenSSH rejects its guest forward', async () => {
    const run = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('/bin/sh')) return 'nat\n[{"prefsrc":"172.28.64.2"}]';
      throw new Error('Forward rejected.');
    });
    const close = vi.fn(async () => undefined);
    expect(await new WslSshForwarder(run, loopbackReady, async () => ({ close })).add(input)).toBe(
      false
    );
    expect(close).toHaveBeenCalledOnce();
    expect(controlCalls(run)).toHaveLength(1);
  });

  it('retains safe failure facts without logging SSH arguments or output', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const run = vi.fn(async (_exe: string, args: readonly string[]) => {
        if (args.includes('/bin/sh')) return 'mirrored\n';
        throw Object.assign(new Error('private host and command output'), {
          code: 255,
          killed: false,
          signal: null,
        });
      });
      expect(await new WslSshForwarder(run, loopbackReady).add(input)).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        '[remote-ssh-wsl-forward] admission failed',
        expect.objectContaining({ stage: 'control', code: 255, elapsedMs: expect.any(Number) })
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private host');
      expect(JSON.stringify(warning.mock.calls)).not.toContain(input.target);
    } finally {
      warning.mockRestore();
    }
  });

  it('does not admit an acknowledged Linux forward until Windows can reach it', async () => {
    let publish!: (value: boolean) => void;
    const ready = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          publish = resolve;
        })
    );
    const run = vi.fn(async () => '');
    const forwarder = new WslSshForwarder(run, ready);
    let admitted = false;
    const added = forwarder.add(input).then((result) => {
      admitted = result;
      return result;
    });
    await nextTurn();
    expect(controlCalls(run)).toHaveLength(1);
    expect(ready).toHaveBeenCalledWith(input.localPort, expect.any(AbortSignal));
    expect(admitted).toBe(false);
    publish(true);
    expect(await added).toBe(true);
    await forwarder.cancel(input);
  });

  it('removes only its owned forward when Windows never admits the listener', async () => {
    const run = vi.fn(async () => '');
    const forwarder = new WslSshForwarder(run, async () => false);
    expect(await forwarder.add(input)).toBe(false);
    expect(controlCalls(run)).toHaveLength(2);
    expect(controlCalls(run)[1]).toEqual(
      expect.arrayContaining([expect.arrayContaining(['cancel'])])
    );
    await forwarder.cancel(input);
    expect(controlCalls(run)).toHaveLength(2);
  });

  it('cancels pending listener admission without waiting for the whole readiness deadline', async () => {
    const run = vi.fn(async () => '');
    const ready = vi.fn(async (_port: number, signal: AbortSignal) => {
      return new Promise<boolean>((resolve) =>
        signal.addEventListener('abort', () => resolve(false), { once: true })
      );
    });
    const forwarder = new WslSshForwarder(run, ready);
    const added = forwarder.add(input);
    await nextTurn();
    await forwarder.cancel(input);
    expect(await added).toBe(false);
    expect(controlCalls(run)).toHaveLength(2);
  });

  it('crosses a real TCP boundary and responds promptly to cancellation', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const port = address.port;
    try {
      expect(await waitForWslLoopback(port, new AbortController().signal)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const controller = new AbortController();
    const waiting = waitForWslLoopback(port, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
  });

  it('adds and cancels only its exact loopback listener on the pinned existing master', async () => {
    const run = vi.fn(
      async (_executable: string, _args: readonly string[], _timeout?: number) => ''
    );
    const forwarder = new WslSshForwarder(run, loopbackReady);
    expect(await forwarder.add(input)).toBe(true);
    expect(await forwarder.add(input)).toBe(false);
    await forwarder.cancel({
      remotePort: input.remotePort,
      localPort: input.localPort,
      controlPath: input.controlPath,
      target: input.target,
      sshCommand: input.sshCommand,
      sshPath: input.sshPath,
    });
    await forwarder.cancel(input);
    expect(controlCalls(run)).toHaveLength(2);
    const args = controlCalls(run).map((call) => call[1] as string[]);
    for (const command of args) {
      expect(command.slice(0, input.sshCommand.prefixArgs.length)).toEqual(
        input.sshCommand.prefixArgs
      );
      expect(command).toContain('/dev/null');
      expect(command).toContain('BatchMode=yes');
      expect(command).toContain('ProxyCommand=false');
      expect(command).toContain('127.0.0.1:55123:127.0.0.1:32789');
      expect(command).not.toContain('exit');
    }
    expect(args[0]).toContain('forward');
    expect(args[1]).toContain('cancel');
  });

  it('waits for an in-flight creation before cancelling its owned listener', async () => {
    let acknowledge!: (value: string) => void;
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.includes('forward'))
        return new Promise<string>((resolve) => {
          acknowledge = resolve;
        });
      return '';
    });
    const forwarder = new WslSshForwarder(run, loopbackReady);
    const added = forwarder.add(input);
    await nextTurn();
    const cancelled = forwarder.cancel(input);
    expect(controlCalls(run)).toHaveLength(1);
    acknowledge('');
    expect(await added).toBe(false);
    await cancelled;
    expect(controlCalls(run)).toHaveLength(2);
  });

  it('does not cancel a listener when creation was rejected', async () => {
    const run = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('/bin/sh')) return 'mirrored\n';
      throw new Error('Address already in use.');
    });
    const forwarder = new WslSshForwarder(run, loopbackReady);
    expect(await forwarder.add(input)).toBe(false);
    await forwarder.cancel(input);
    expect(controlCalls(run)).toHaveLength(1);
  });

  it('rolls back a successfully created listener when admission was aborted', async () => {
    const controller = new AbortController();
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.includes('forward')) controller.abort();
      return '';
    });
    const forwarder = new WslSshForwarder(run, loopbackReady);
    expect(await forwarder.add(input, controller.signal)).toBe(false);
    expect(controlCalls(run)).toHaveLength(2);
  });
});
