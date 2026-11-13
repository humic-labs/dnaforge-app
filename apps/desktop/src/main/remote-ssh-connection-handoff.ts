import {
  addRemoteSshLocalForward,
  allocateRemoteSshLocalForward,
  cancelRemoteSshLocalForward,
  type RemoteSshLocalForward,
} from './remote-ssh-local-forward';
import type { RemoteSshCommand } from './remote-ssh-command';
import { wslSshForwarder } from './remote-ssh-wsl-forward';

export interface RemoteSshConnectionLease {
  readonly target: string;
  readonly controlPath: string;
  readonly sshCommand?: RemoteSshCommand;
  readonly systemShared?: boolean;
  readonly existingOnly?: boolean;
  release(): Promise<void>;
}

export class RemoteSshConnectionHandoff {
  private readonly offers = new Map<string, RemoteSshConnectionLease>();

  offer(requestId: string, connection: RemoteSshConnectionLease): void {
    if (this.offers.has(requestId)) throw new Error('The SSH handoff is already in use.');
    this.offers.set(requestId, connection);
  }

  take(requestId: string | undefined, target: string): RemoteSshConnectionLease | null {
    if (!requestId) return null;
    const connection = this.offers.get(requestId);
    if (!connection) return null;
    if (connection.target !== target) throw new Error('The tested SSH target no longer matches.');
    this.offers.delete(requestId);
    return connection;
  }

  async discard(requestId: string): Promise<void> {
    const connection = this.offers.get(requestId);
    this.offers.delete(requestId);
    await connection?.release();
  }
}

export const remoteSshConnectionHandoff = new RemoteSshConnectionHandoff();

type RemoteSshForward = RemoteSshLocalForward;

export function addRemoteSshForward(
  input: RemoteSshForward,
  signal?: AbortSignal
): Promise<boolean> {
  return input.sshCommand?.runtime === 'wsl'
    ? wslSshForwarder.add(input, signal)
    : addRemoteSshLocalForward(input, signal);
}

export function allocateRemoteSshForward(
  input: Omit<RemoteSshForward, 'localPort'>,
  signal?: AbortSignal
): Promise<RemoteSshForward | null> {
  if (input.sshCommand?.runtime === 'wsl') {
    throw new Error('The WSL forwarder requires its existing explicit local port.');
  }
  return allocateRemoteSshLocalForward(input, signal);
}

export async function cancelRemoteSshForward(input: RemoteSshForward): Promise<void> {
  if (input.sshCommand?.runtime === 'wsl') await wslSshForwarder.cancel(input);
  else await cancelRemoteSshLocalForward(input);
}
