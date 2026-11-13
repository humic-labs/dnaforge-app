import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { sshControlPathArgument } from './remote-ssh-system-sharing';
import { remoteSshInvocation, type RemoteSshCommand } from './remote-ssh-command';

export interface RemoteSshLocalForward {
  readonly sshPath: string;
  readonly sshCommand?: RemoteSshCommand;
  readonly target: string;
  readonly controlPath: string;
  readonly localPort: number;
  readonly remotePort: number;
}

interface OwnedChannel {
  readonly child: ChildProcessWithoutNullStreams;
  readonly socket: Socket;
  readonly closed: Promise<void>;
}

interface OwnedForward {
  input: RemoteSshLocalForward;
  readonly server: Server;
  readonly channels: Set<OwnedChannel>;
  closing: Promise<void> | null;
}

const forwards = new Map<string, OwnedForward>();
const CHANNEL_CLOSE_TIMEOUT_MS = 1_000;

function forwardKey(input: RemoteSshLocalForward): string {
  return JSON.stringify([
    input.sshPath,
    input.sshCommand ?? null,
    input.target,
    input.controlPath,
    input.localPort,
    input.remotePort,
  ]);
}

function stopChannel(channel: OwnedChannel): void {
  channel.socket.destroy();
  channel.child.stdin.destroy();
  channel.child.stdout.destroy();
  channel.child.stderr.destroy();
  if (
    channel.child.pid !== undefined &&
    channel.child.exitCode === null &&
    channel.child.signalCode === null
  ) {
    channel.child.kill('SIGKILL');
  }
}

function acceptChannel(owned: OwnedForward, socket: Socket): void {
  if (owned.closing) {
    socket.destroy();
    return;
  }
  const input = owned.input;
  const invocation = remoteSshInvocation(input.sshCommand ?? { executable: input.sshPath }, [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPersist=no',
    '-o',
    'ProxyCommand=false',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-S',
    sshControlPathArgument(input.controlPath),
    '-W',
    `127.0.0.1:${input.remotePort}`,
    input.target,
  ]);
  const child = spawn(invocation.executable, invocation.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const startedAt = Date.now();
  let sentBytes = 0;
  let receivedBytes = 0;
  let stoppedBySocket = false;
  const diagnose = (stage: string, error?: NodeJS.ErrnoException): void => {
    if (owned.closing) return;
    console.warn('[remote-ssh-forward] stream failure:', {
      stage,
      elapsedMs: Date.now() - startedAt,
      sentBytes,
      receivedBytes,
      code: error?.code ?? child.exitCode,
      signal: child.signalCode,
    });
  };
  let finishClosed!: () => void;
  const channel: OwnedChannel = {
    child,
    socket,
    closed: new Promise<void>((resolve) => {
      finishClosed = resolve;
    }),
  };
  owned.channels.add(channel);
  const failed = (): void => stopChannel(channel);
  socket.on('data', (chunk: Buffer) => {
    sentBytes += chunk.length;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length;
  });
  socket.once('error', (error: NodeJS.ErrnoException) => {
    diagnose('local-socket', error);
    failed();
  });
  socket.once('close', () => {
    stoppedBySocket = true;
    if (receivedBytes === 0) diagnose('local-socket-closed-before-response');
    failed();
  });
  child.once('error', (error: NodeJS.ErrnoException) => {
    diagnose('ssh-process', error);
    failed();
  });
  const streamFailed = (error: NodeJS.ErrnoException): void => {
    if (!stoppedBySocket) diagnose('ssh-stream', error);
    failed();
  };
  child.stdin.on('error', streamFailed);
  child.stdout.on('error', streamFailed);
  child.stderr.on('error', streamFailed);
  child.once('close', (code) => {
    owned.channels.delete(channel);
    if (code === 0) socket.end();
    else {
      if (!stoppedBySocket) diagnose('ssh-exit');
      socket.destroy();
    }
    finishClosed();
  });
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stderr.resume();
}

async function awaitChannelClose(channel: OwnedChannel): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      channel.closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('An owned SSH stdio client could not be terminated.')),
          CHANNEL_CLOSE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function closeForward(owned: OwnedForward): Promise<void> {
  return (owned.closing ??= (async () => {
    const listenerClosed = new Promise<void>((resolve, reject) => {
      owned.server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
        } else resolve();
      });
    });
    const channels = [...owned.channels];
    for (const channel of channels) stopChannel(channel);
    await Promise.all([listenerClosed, ...channels.map(awaitChannelClose)]);
    if (forwards.get(forwardKey(owned.input)) === owned) {
      forwards.delete(forwardKey(owned.input));
    }
  })());
}

export async function addRemoteSshLocalForward(
  input: RemoteSshLocalForward,
  signal?: AbortSignal
): Promise<boolean> {
  return (await createRemoteSshLocalForward(input, signal, false)) !== null;
}

export async function allocateRemoteSshLocalForward(
  input: Omit<RemoteSshLocalForward, 'localPort'>,
  signal?: AbortSignal
): Promise<RemoteSshLocalForward | null> {
  return (
    (await createRemoteSshLocalForward({ ...input, localPort: 0 }, signal, true))?.input ?? null
  );
}

async function createRemoteSshLocalForward(
  input: RemoteSshLocalForward,
  signal: AbortSignal | undefined,
  allocatePort: boolean
): Promise<OwnedForward | null> {
  if (signal?.aborted || (!allocatePort && forwards.has(forwardKey(input)))) return null;
  const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) =>
    acceptChannel(owned, socket)
  );
  const owned: OwnedForward = {
    input: { ...input },
    server,
    channels: new Set(),
    closing: null,
  };
  if (!allocatePort) forwards.set(forwardKey(input), owned);
  const bound = await new Promise<boolean>((resolve) => {
    const finish = (success: boolean): void => {
      signal?.removeEventListener('abort', aborted);
      server.off('error', failed);
      server.off('listening', listening);
      server.off('close', closed);
      resolve(success);
    };
    const failed = (): void => finish(false);
    const closed = (): void => finish(false);
    const listening = (): void => {
      if (allocatePort) {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(false);
          return;
        }
        owned.input = { ...input, localPort: address.port };
        forwards.set(forwardKey(owned.input), owned);
      }
      finish(!signal?.aborted && owned.closing === null);
    };
    const aborted = (): void => finish(false);
    signal?.addEventListener('abort', aborted, { once: true });
    server.once('error', failed);
    server.once('listening', listening);
    server.once('close', closed);
    server.listen(input.localPort, '127.0.0.1');
  });
  server.on('error', () => void closeForward(owned).catch(() => undefined));
  if (!bound || signal?.aborted) {
    await closeForward(owned);
    return null;
  }
  return owned;
}

export async function cancelRemoteSshLocalForward(input: RemoteSshLocalForward): Promise<void> {
  const owned = forwards.get(forwardKey(input));
  if (owned) await closeForward(owned);
}
