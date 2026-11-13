import { executeHostCommand } from './remote-host-runtime';
import { remoteSshInvocation } from './remote-ssh-command';
import { sshControlPathArgument } from './remote-ssh-system-sharing';
import type { RemoteSshLocalForward } from './remote-ssh-local-forward';
import { connect, isIPv4 } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createWslTcpBridge } from './remote-ssh-wsl-tcp-bridge';

interface OwnedForward {
  readonly input: RemoteSshLocalForward;
  pending: Promise<boolean>;
  added: boolean;
  closing: Promise<void> | null;
  readonly controller: AbortController;
  bindAddress: string;
  bridge: Awaited<ReturnType<typeof createWslTcpBridge>> | null;
}

export function parseWslNatAddress(output: string): string | null {
  const newline = output.indexOf('\n');
  if (output.slice(0, newline).trim().toLowerCase() !== 'nat') return null;
  const routes: unknown = JSON.parse(output.slice(newline + 1));
  if (!Array.isArray(routes) || routes.length !== 1) throw new Error('Ambiguous WSL NAT route.');
  const address = (routes[0] as { prefsrc?: unknown }).prefsrc;
  if (typeof address !== 'string' || !isIPv4(address)) throw new Error('Invalid WSL NAT address.');
  const [first = 0, second = 0] = address.split('.').map(Number);
  if (
    first !== 10 &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && second === 168)
  )
    throw new Error('WSL NAT must have a private IPv4 address.');
  return address;
}

export async function waitForWslLoopback(port: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (!signal.aborted && Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      const aborted = () => finish(false);
      const finish = (value: boolean) => {
        signal.removeEventListener('abort', aborted);
        socket.destroy();
        resolve(value);
      };
      signal.addEventListener('abort', aborted, { once: true });
      socket.once('connect', () => finish(!signal.aborted));
      socket.once('error', () => finish(false));
      socket.setTimeout(Math.min(250, Math.max(1, deadline - Date.now())), () => finish(false));
      if (signal.aborted) finish(false);
    });
    if (ready) return true;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal }).catch(
      () => undefined
    );
  }
  return false;
}

function forwardKey(input: RemoteSshLocalForward): string {
  return JSON.stringify([
    input.sshPath,
    input.sshCommand?.executable,
    input.sshCommand?.prefixArgs,
    input.target,
    input.controlPath,
    input.localPort,
    input.remotePort,
  ]);
}

export class WslSshForwarder {
  private readonly forwards = new Map<string, OwnedForward>();

  constructor(
    private readonly run: typeof executeHostCommand = executeHostCommand,
    private readonly waitForLoopback: typeof waitForWslLoopback = waitForWslLoopback,
    private readonly createBridge: typeof createWslTcpBridge = createWslTcpBridge
  ) {}

  private async natAddress(input: RemoteSshLocalForward): Promise<string | null> {
    const command = input.sshCommand;
    const prefix = command?.prefixArgs;
    if (!command || !prefix || prefix.at(-2) !== '--exec')
      throw new Error('A pinned WSL runtime is required.');
    const output = await this.run(
      command.executable,
      [
        ...prefix.slice(0, -1),
        '/bin/sh',
        '-c',
        'mode=$(wslinfo --networking-mode 2>/dev/null || printf unknown); mode=$(printf "%s" "$mode" | tr "[:upper:]" "[:lower:]"); printf "%s\\n" "$mode"; if [ "$mode" = nat ]; then ip -j -4 route get 1.1.1.1; fi',
      ],
      5_000
    );
    return parseWslNatAddress(output);
  }

  private async control(owned: OwnedForward, operation: 'forward' | 'cancel') {
    const input = owned.input;
    const command = remoteSshInvocation(input.sshCommand ?? { executable: input.sshPath }, [
      '-F',
      '/dev/null',
      '-S',
      sshControlPathArgument(input.controlPath),
      '-o',
      'BatchMode=yes',
      '-o',
      'ProxyCommand=false',
      '-o',
      'ProxyJump=none',
      '-o',
      'ClearAllForwardings=no',
      '-o',
      'ExitOnForwardFailure=yes',
      '-O',
      operation,
      '-L',
      `${owned.bindAddress}:${input.localPort}:127.0.0.1:${input.remotePort}`,
      input.target,
    ]);
    await this.run(command.executable, command.args, 5_000);
  }

  async add(input: RemoteSshLocalForward, signal?: AbortSignal): Promise<boolean> {
    const key = forwardKey(input);
    if (signal?.aborted || this.forwards.has(key)) return false;
    const owned: OwnedForward = {
      input,
      pending: Promise.resolve(false),
      added: false,
      closing: null,
      controller: new AbortController(),
      bindAddress: '127.0.0.1',
      bridge: null,
    };
    this.forwards.set(key, owned);
    owned.pending = Promise.resolve().then(async () => {
      const startedAt = Date.now();
      let stage: 'guest-route' | 'windows-listener' | 'control' | 'windows-loopback' =
        'guest-route';
      const diagnose = (error?: unknown) => {
        const facts = error as { code?: unknown; killed?: unknown; signal?: unknown } | undefined;
        console.warn('[remote-ssh-wsl-forward] admission failed', {
          stage,
          elapsedMs: Date.now() - startedAt,
          code:
            typeof facts?.code === 'number' ||
            (typeof facts?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/u.test(facts.code))
              ? facts.code
              : null,
          killed: facts?.killed === true,
          signal:
            typeof facts?.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(facts.signal)
              ? facts.signal
              : null,
          cancelled: signal?.aborted === true || owned.controller.signal.aborted,
        });
      };
      try {
        const guestAddress = await this.natAddress(input);
        if (signal?.aborted || owned.controller.signal.aborted) return false;
        if (guestAddress) {
          stage = 'windows-listener';
          owned.bindAddress = guestAddress;
          owned.bridge = await this.createBridge(input.localPort, guestAddress, input.localPort);
        }
        if (signal?.aborted || owned.controller.signal.aborted) return false;
        stage = 'control';
        await this.control(owned, 'forward');
        owned.added = true;
        if (owned.bridge) return true;
        stage = 'windows-loopback';
        const ready = await this.waitForLoopback(
          input.localPort,
          signal ? AbortSignal.any([signal, owned.controller.signal]) : owned.controller.signal
        );
        if (!ready) diagnose();
        return ready;
      } catch (error) {
        diagnose(error);
        return false;
      }
    });
    const added = await owned.pending;
    if (!added || owned.closing || signal?.aborted) {
      await this.close(key, owned);
      return false;
    }
    return added;
  }

  private close(key: string, owned: OwnedForward): Promise<void> {
    owned.controller.abort();
    return (owned.closing ??= (async () => {
      await owned.pending;
      try {
        try {
          await owned.bridge?.close();
        } finally {
          if (owned.added) await this.control(owned, 'cancel');
        }
      } finally {
        if (this.forwards.get(key) === owned) this.forwards.delete(key);
      }
    })());
  }

  async cancel(input: RemoteSshLocalForward): Promise<void> {
    const key = forwardKey(input);
    const owned = this.forwards.get(key);
    if (owned) await this.close(key, owned);
  }
}

export const wslSshForwarder = new WslSshForwarder();
