import { remoteHostService } from './remote-host-service';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  RemoteDirectoryEntryV1,
  RemoteDirectoryListingV1,
  RemoteExplorerClosedEventV1,
  RemoteExplorerSessionV1,
} from '../shared/remote-genomics-ipc';
import {
  RemoteGenomicsError,
  buildRemoteSshArgs,
  classifyRemoteSshFailure,
  classifyRemoteSshTerminalFailure,
  randomRemoteLoopbackPort,
  requireAbsoluteRemotePath,
  reserveLoopbackPort,
  resolveSshExecutable,
  terminateRemoteChild,
  validateRemoteSshTarget,
} from './remote-genomics-supervisor';
import { resolveSystemSshControlPath } from './remote-ssh-system-sharing';
import { remoteSshInvocation } from './remote-ssh-command';
import {
  addRemoteSshForward,
  allocateRemoteSshForward,
  cancelRemoteSshForward,
  type RemoteSshConnectionLease,
} from './remote-ssh-connection-handoff';

const READY_PREFIX = 'DNAFORGE_REMOTE_EXPLORE_READY ';
const PROTOCOL = 'dnaforge-remote-explorer.v1';
const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 600_000;
const MAX_DIAGNOSTIC_BYTES = 8_192;

interface ExplorerReady {
  readonly protocol: typeof PROTOCOL;
  readonly port: number;
  readonly platform: string;
  readonly homePath: string;
}

interface OwnedExplorer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ownerId: number;
  readonly descriptor: RemoteExplorerSessionV1;
  readonly localPort: number;
  readonly token: string;
  readonly controlRoot: string | null;
  readonly controlPath: string | null;
  readonly systemShared: boolean;
  readonly hostConnection: RemoteSshConnectionLease | null;
  readonly forward: Parameters<typeof cancelRemoteSshForward>[0] | null;
  borrowers: number;
  explorerClosed: boolean;
  cleanup: Promise<void> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingExplorer {
  readonly ownerId: number;
  readonly controller: AbortController;
  child: ChildProcessWithoutNullStreams | null;
  cancelled: boolean;
}

export interface RemoteExplorerClosedNotification extends RemoteExplorerClosedEventV1 {
  readonly ownerId: number;
}

function boundedAppend(current: string, next: string, limit: number): string {
  return (current + next).slice(-limit);
}

export function buildRemoteExplorerHelperScript(input: {
  readonly port: number;
  readonly token: string;
}): string {
  if (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > 65_535) {
    throw new Error('Remote explorer port is invalid.');
  }
  if (!/^[a-f0-9]{48}$/u.test(input.token)) {
    throw new Error('Remote explorer token is invalid.');
  }
  return `# Disposable DNAForge remote directory explorer ${PROTOCOL}
import json
import os
import platform
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PORT = ${input.port}
TOKEN = ${JSON.stringify(input.token)}
ROOT = "/v1/" + TOKEN
MAX_SCANNED = 4096
MAX_ENTRIES = 128

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == ROOT + "/health":
            self.send_json(200, {"protocol": ${JSON.stringify(PROTOCOL)}, "ready": True})
            return
        if parsed.path != ROOT + "/list":
            self.send_json(404, {"code": "not-found"})
            return
        raw = parse_qs(parsed.query, keep_blank_values=True).get("path", [])
        if len(raw) != 1 or not raw[0].startswith("/") or len(raw[0]) > 4096 or "\\x00" in raw[0]:
            self.send_json(400, {"code": "invalid-path"})
            return
        requested = os.path.realpath(raw[0])
        try:
            iterator = os.scandir(requested)
        except OSError:
            self.send_json(403, {"code": "directory-unavailable"})
            return
        entries = []
        truncated = False
        scanned = 0
        try:
            with iterator:
                for entry in iterator:
                    scanned += 1
                    if scanned > MAX_SCANNED:
                        truncated = True
                        break
                    try:
                        if entry.is_dir(follow_symlinks=True):
                            kind = "directory"
                        elif entry.is_file(follow_symlinks=True):
                            name = entry.name.lower()
                            if name.endswith((".bam", ".cram")):
                                kind = "alignment"
                            elif name.endswith((".bai", ".csi", ".crai")):
                                kind = "index"
                            elif name.endswith((".bigwig", ".bw")):
                                kind = "signal"
                            else:
                                continue
                        else:
                            continue
                    except OSError:
                        continue
                    if len(entries) >= MAX_ENTRIES:
                        truncated = True
                        break
                    entries.append({"name": entry.name, "path": os.path.join(requested, entry.name), "kind": kind})
        except OSError:
            self.send_json(403, {"code": "directory-unavailable"})
            return
        entries.sort(key=lambda item: (item["kind"] != "directory", item["name"].casefold()))
        parent = None if requested == "/" else os.path.dirname(requested)
        self.send_json(200, {"path": requested, "parentPath": parent, "entries": entries, "truncated": truncated})

server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
print(${JSON.stringify(READY_PREFIX)} + json.dumps({"protocol": ${JSON.stringify(PROTOCOL)}, "port": server.server_port, "platform": platform.system().lower(), "homePath": os.path.realpath(os.path.expanduser("~"))}, separators=(",", ":")), flush=True)

def watch_ssh_output():
    # Stdin is already at EOF after receiving this script. A periodic write
    # detects the closed SSH channel even if sshd leaves this helper orphaned.
    while True:
        time.sleep(0.5)
        try:
            os.write(1, b"DNAFORGE_REMOTE_ALIVE\\n")
        except OSError:
            os._exit(0)

threading.Thread(target=watch_ssh_output, daemon=True).start()
server.serve_forever(poll_interval=0.25)
`;
}

function validateReady(value: unknown, expectedPort: number): ExplorerReady {
  if (!value || typeof value !== 'object') {
    throw new RemoteGenomicsError(
      'helper-failed',
      'The remote explorer returned an invalid response.'
    );
  }
  const result = value as Partial<ExplorerReady>;
  if (
    result.protocol !== PROTOCOL ||
    !Number.isSafeInteger(result.port) ||
    (result.port ?? 0) < 1 ||
    (result.port ?? 0) > 65_535 ||
    (expectedPort !== 0 && result.port !== expectedPort) ||
    typeof result.platform !== 'string' ||
    !result.platform ||
    typeof result.homePath !== 'string' ||
    !result.homePath.startsWith('/') ||
    result.homePath.length > 4096
  ) {
    throw new RemoteGenomicsError(
      'helper-failed',
      'The remote explorer returned an invalid response.'
    );
  }
  return result as ExplorerReady;
}

function waitForReady(
  child: ChildProcessWithoutNullStreams,
  expectedPort: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ExplorerReady> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(
      () =>
        finish(new RemoteGenomicsError('connection-timeout', 'The SSH connection test timed out.')),
      timeoutMs
    );
    const finish = (error?: Error, ready?: ExplorerReady): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(ready as ExplorerReady);
    };
    const onStdout = (chunk: Buffer): void => {
      stdout = boundedAppend(stdout, chunk.toString('utf8'), MAX_RESPONSE_BYTES);
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        const line = stdout.slice(0, newline).trimEnd();
        stdout = stdout.slice(newline + 1);
        if (!line.startsWith(READY_PREFIX)) continue;

        if (child.exitCode !== null || child.signalCode !== null) continue;
        try {
          finish(
            undefined,
            validateReady(JSON.parse(line.slice(READY_PREFIX.length)), expectedPort)
          );
        } catch {
          finish(new RemoteGenomicsError('helper-failed', 'The remote explorer could not start.'));
        }
        return;
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr = boundedAppend(stderr, chunk.toString('utf8'), MAX_DIAGNOSTIC_BYTES);
      finishTerminalFailureAfterExit();
    };
    const finishTerminalFailureAfterExit = (): void => {
      if (child.exitCode === null && child.signalCode === null) return;
      const failure = classifyRemoteSshTerminalFailure(stderr);
      if (failure) finish(new RemoteGenomicsError(failure.code, failure.message));
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      finish(
        error.code === 'ENOENT'
          ? new RemoteGenomicsError('ssh-unavailable', 'The system OpenSSH client was not found.')
          : new RemoteGenomicsError('helper-failed', 'OpenSSH could not be started.')
      );
    };
    const onClose = (): void => {
      const failure = classifyRemoteSshFailure(stderr);
      finish(new RemoteGenomicsError(failure.code, failure.message));
    };
    const onExit = (): void => finishTerminalFailureAfterExit();
    const onAbort = (): void => {
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new RemoteGenomicsError('helper-failed', 'The connection test was cancelled.')
      );
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);

    child.once('exit', onExit);
    child.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new RemoteGenomicsError('helper-failed', 'The remote directory listing was too large.');
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new RemoteGenomicsError('helper-failed', 'The remote explorer sent no response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RemoteGenomicsError(
          'helper-failed',
          'The remote directory listing was too large.'
        );
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof RemoteGenomicsError) throw error;
    throw new RemoteGenomicsError('helper-failed', 'The remote explorer sent an invalid response.');
  }
}

function validateListing(value: unknown): RemoteDirectoryListingV1 {
  if (!value || typeof value !== 'object') {
    throw new RemoteGenomicsError('helper-failed', 'The remote explorer sent an invalid listing.');
  }
  const result = value as Partial<RemoteDirectoryListingV1>;
  if (
    typeof result.path !== 'string' ||
    !result.path.startsWith('/') ||
    (result.parentPath !== null &&
      (typeof result.parentPath !== 'string' || !result.parentPath.startsWith('/'))) ||
    !Array.isArray(result.entries) ||
    result.entries.length > 128 ||
    typeof result.truncated !== 'boolean'
  ) {
    throw new RemoteGenomicsError('helper-failed', 'The remote explorer sent an invalid listing.');
  }
  const allowedKinds = new Set(['directory', 'alignment', 'index', 'signal']);
  for (const entry of result.entries as RemoteDirectoryEntryV1[]) {
    if (
      typeof entry.name !== 'string' ||
      !entry.name ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('/') ||
      !allowedKinds.has(entry.kind)
    ) {
      throw new RemoteGenomicsError(
        'helper-failed',
        'The remote explorer sent an invalid listing.'
      );
    }
  }
  return result as RemoteDirectoryListingV1;
}

export class RemoteEndpointExplorer {
  private readonly sessions = new Map<string, OwnedExplorer>();
  private readonly connections = new Set<OwnedExplorer>();
  private readonly pending = new Map<string, PendingExplorer>();
  private readonly closedListeners = new Set<(event: RemoteExplorerClosedNotification) => void>();

  constructor(
    private readonly options: {
      readonly sshPath?: string;
      readonly timeoutMs?: number;
      readonly hostService?: Pick<typeof remoteHostService, 'retainConnection'>;
    } = {}
  ) {}

  subscribeClosed(listener: (event: RemoteExplorerClosedNotification) => void): () => void {
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  async open(
    input: { readonly requestId: string; readonly target: string },
    ownerId: number
  ): Promise<RemoteExplorerSessionV1> {
    const target = validateRemoteSshTarget(input.target);
    if (!/^[a-zA-Z0-9_-]{8,128}$/u.test(input.requestId) || this.pending.has(input.requestId)) {
      throw new RemoteGenomicsError(
        'invalid-request',
        'The connection test request ID is invalid or already in use.'
      );
    }
    const pending: PendingExplorer = {
      ownerId,
      controller: new AbortController(),
      child: null,
      cancelled: false,
    };
    this.pending.set(input.requestId, pending);
    let controlRoot: string | null = null;
    let hostConnection: RemoteSshConnectionLease | null = null;
    let forward: Parameters<typeof cancelRemoteSshForward>[0] | null = null;
    try {
      let localPort = 0;
      const token = randomBytes(24).toString('hex');
      if (pending.cancelled)
        throw new RemoteGenomicsError('helper-failed', 'The connection test was cancelled.');
      const sshPath = this.options.sshPath ?? resolveSshExecutable();
      hostConnection = await (this.options.hostService ?? remoteHostService).retainConnection(
        target
      );
      const sshCommand = hostConnection?.sshCommand ?? { executable: sshPath };
      const systemControlPath = hostConnection
        ? null
        : await resolveSystemSshControlPath(sshPath, target, pending.controller.signal);

      controlRoot =
        hostConnection || systemControlPath || process.platform === 'win32'
          ? null
          : await mkdtemp('/tmp/dfs-ctrl-');
      const controlPath =
        hostConnection?.controlPath ??
        systemControlPath ??
        (controlRoot ? join(controlRoot, 'control') : null);
      if (!controlPath || sshCommand.runtime === 'wsl') localPort = await reserveLoopbackPort();
      const remotePort = controlPath ? 0 : randomRemoteLoopbackPort();
      if (pending.cancelled)
        throw new RemoteGenomicsError('helper-failed', 'The connection test was cancelled.');
      const invocation = remoteSshInvocation(
        sshCommand,
        buildRemoteSshArgs({
          localPort,
          remotePort,
          target,
          ...(controlPath
            ? {
                control: {
                  path: controlPath,
                  master: !hostConnection,
                  existingOnly: hostConnection?.existingOnly,
                  systemShared: systemControlPath !== null,
                },
              }
            : {}),
        })
      );
      const child = spawn(invocation.executable, invocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
      pending.child = child;
      child.stdin.on('error', () => undefined);
      child.stdin.end(buildRemoteExplorerHelperScript({ port: remotePort, token }));
      const ready = await waitForReady(
        child,
        remotePort,
        this.options.timeoutMs ?? CONNECT_TIMEOUT_MS,
        pending.controller.signal
      );
      child.stdout.resume();
      child.stderr.resume();
      if (pending.cancelled)
        throw new RemoteGenomicsError('helper-failed', 'The connection test was cancelled.');
      if (controlPath) {
        const destination = {
          sshPath,
          sshCommand,
          target,
          controlPath,
          remotePort: ready.port,
        };
        let forwarded: boolean;
        if (sshCommand.runtime === 'wsl') {
          forward = { ...destination, localPort };
          forwarded = await addRemoteSshForward(forward, pending.controller.signal);
        } else {
          forward = await allocateRemoteSshForward(destination, pending.controller.signal);
          if (forward) localPort = forward.localPort;
          forwarded = forward !== null;
        }
        if (!forwarded) {
          throw new RemoteGenomicsError(
            'tunnel-failed',
            'SSH connected, but its private local port forward could not be started. Retry the connection.'
          );
        }
      }
      if (pending.cancelled)
        throw new RemoteGenomicsError('helper-failed', 'The connection test was cancelled.');
      const response = await fetch(`http://127.0.0.1:${localPort}/v1/${token}/health`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const health = await readBoundedJson(response);
      if (
        !response.ok ||
        !health ||
        typeof health !== 'object' ||
        (health as { ready?: unknown }).ready !== true
      ) {
        throw new RemoteGenomicsError(
          'tunnel-failed',
          'SSH connected, but local port forwarding did not work.'
        );
      }
      if (pending.cancelled || child.exitCode !== null || child.signalCode !== null) {
        throw new RemoteGenomicsError(
          'tunnel-failed',
          'The SSH connection closed during the test.'
        );
      }
      const descriptor: RemoteExplorerSessionV1 = {
        sessionId: randomUUID(),
        target,
        platform: ready.platform,
        homePath: ready.homePath,
        connectedAt: Date.now(),
      };
      const owned: OwnedExplorer = {
        child,
        ownerId,
        descriptor,
        localPort,
        token,
        controlRoot,
        controlPath,
        systemShared: systemControlPath !== null,
        hostConnection,
        forward,
        borrowers: 0,
        explorerClosed: false,
        cleanup: null,
        idleTimer: null,
      };
      this.sessions.set(descriptor.sessionId, owned);
      this.connections.add(owned);
      child.once('exit', () => void this.destroyConnection(owned));
      if (child.exitCode !== null || child.signalCode !== null) {
        await this.destroyConnection(owned);
        throw new RemoteGenomicsError(
          'tunnel-failed',
          'The SSH connection closed during the test.'
        );
      }
      this.armIdleTimer(owned);
      return descriptor;
    } catch (error) {
      if (forward) await cancelRemoteSshForward(forward).catch(() => undefined);
      if (pending.child) await terminateRemoteChild(pending.child).catch(() => undefined);
      await hostConnection?.release();
      if (controlRoot)
        await rm(controlRoot, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof RemoteGenomicsError) throw error;
      throw new RemoteGenomicsError(
        'tunnel-failed',
        'SSH connected, but DNAForge could not reach the remote explorer. Check that SSH TCP forwarding is allowed.'
      );
    } finally {
      if (this.pending.get(input.requestId) === pending) this.pending.delete(input.requestId);
    }
  }

  cancelOpen(requestId: string, ownerId: number): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.ownerId !== ownerId) return false;
    pending.cancelled = true;
    pending.controller.abort(
      new RemoteGenomicsError('helper-failed', 'The connection test was cancelled.')
    );
    if (pending.child) void terminateRemoteChild(pending.child).catch(() => undefined);
    return true;
  }

  async list(sessionId: string, path: string, ownerId: number): Promise<RemoteDirectoryListingV1> {
    const owned = this.sessions.get(sessionId);
    if (!owned || owned.ownerId !== ownerId) {
      throw new RemoteGenomicsError(
        'invalid-request',
        'The remote connection test is no longer open.'
      );
    }
    const directory = requireAbsoluteRemotePath(path, 'Remote directory');
    this.armIdleTimer(owned);
    const url = new URL(`http://127.0.0.1:${owned.localPort}/v1/${owned.token}/list`);
    url.searchParams.set('path', directory);
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new RemoteGenomicsError(
        'tunnel-failed',
        'The remote directory did not respond. Retry, or check host access in Remote hosts.'
      );
    }
    const result = await readBoundedJson(response);
    if (response.status === 403) {
      throw new RemoteGenomicsError(
        'helper-failed',
        'That remote directory is missing or cannot be read.'
      );
    }
    if (!response.ok) {
      throw new RemoteGenomicsError('helper-failed', 'The remote directory could not be listed.');
    }
    return validateListing(result);
  }

  async close(sessionId: string, ownerId: number): Promise<boolean> {
    const owned = this.sessions.get(sessionId);
    if (!owned || owned.ownerId !== ownerId) return false;
    await this.closeExplorer(owned, 'disconnected');
    return true;
  }

  retainConnection(
    sessionId: string,
    target: string,
    ownerId: number
  ): RemoteSshConnectionLease | null {
    const owned = this.sessions.get(sessionId);
    if (
      !owned ||
      owned.ownerId !== ownerId ||
      owned.explorerClosed ||
      owned.descriptor.target !== target ||
      owned.child.exitCode !== null ||
      owned.child.signalCode !== null
    ) {
      throw new RemoteGenomicsError(
        'invalid-request',
        'The tested SSH connection is no longer available for this target and window.'
      );
    }
    if (!owned.controlPath) return null;
    owned.borrowers += 1;
    this.armIdleTimer(owned);
    let released = false;
    return {
      target,
      controlPath: owned.controlPath,
      sshCommand: owned.hostConnection?.sshCommand,
      systemShared: owned.systemShared,
      existingOnly: owned.hostConnection?.existingOnly,
      release: async () => {
        if (released) return;
        released = true;
        owned.borrowers -= 1;
        if (owned.explorerClosed && owned.borrowers === 0) await this.destroyConnection(owned);
      },
    };
  }

  async closeOwner(ownerId: number): Promise<void> {
    for (const [requestId, pending] of this.pending) {
      if (pending.ownerId === ownerId) this.cancelOpen(requestId, ownerId);
    }
    await Promise.all(
      [...this.connections]
        .filter((session) => session.ownerId === ownerId)
        .map((session) => this.closeExplorer(session, 'disconnected'))
    );
  }

  async stopAll(): Promise<void> {
    for (const [requestId, pending] of this.pending) this.cancelOpen(requestId, pending.ownerId);
    await Promise.all(
      [...this.connections].map((session) => this.destroyConnection(session, 'disconnected'))
    );
  }

  private invalidateExplorer(
    owned: OwnedExplorer,
    reason: RemoteExplorerClosedEventV1['reason']
  ): void {
    if (owned.explorerClosed) return;
    this.sessions.delete(owned.descriptor.sessionId);
    owned.explorerClosed = true;
    if (owned.idleTimer) clearTimeout(owned.idleTimer);
    owned.idleTimer = null;
    const event: RemoteExplorerClosedNotification = {
      ownerId: owned.ownerId,
      sessionId: owned.descriptor.sessionId,
      reason,
    };
    for (const listener of this.closedListeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private async closeExplorer(
    owned: OwnedExplorer,
    reason: RemoteExplorerClosedEventV1['reason']
  ): Promise<void> {
    this.invalidateExplorer(owned, reason);
    if (owned.borrowers === 0) await this.destroyConnection(owned, reason);
  }

  private destroyConnection(
    owned: OwnedExplorer,
    reason: RemoteExplorerClosedEventV1['reason'] = 'connection-lost'
  ): Promise<void> {
    if (owned.cleanup) return owned.cleanup;
    this.invalidateExplorer(owned, reason);
    owned.cleanup = (async () => {
      if (owned.forward) await cancelRemoteSshForward(owned.forward).catch(() => undefined);
      await terminateRemoteChild(owned.child).catch(() => undefined);
      await owned.hostConnection?.release();
      if (owned.controlRoot)
        await rm(owned.controlRoot, { recursive: true, force: true }).catch(() => undefined);
      this.connections.delete(owned);
    })();
    return owned.cleanup;
  }

  private armIdleTimer(owned: OwnedExplorer): void {
    if (owned.idleTimer) clearTimeout(owned.idleTimer);
    owned.idleTimer = setTimeout(() => void this.closeExplorer(owned, 'idle'), IDLE_TIMEOUT_MS);
  }
}

export const remoteEndpointExplorer = new RemoteEndpointExplorer();
