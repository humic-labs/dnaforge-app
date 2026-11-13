import { userMessage } from '@waypoint/user-messages';
import { remoteHostService } from './remote-host-service';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REMOTE_ALIGNMENT_LOCATOR_V1,
  REMOTE_SIGNAL_LOCATOR_V1,
  REMOTE_RANGE_PROTOCOL_V1,
  type RemoteAlignmentConnectRequestV1,
  type RemoteAlignmentMaterializationV1,
  type RemoteSignalConnectRequestV1,
  type RemoteSignalMaterializationV1,
  type RemoteFileReceiptV1,
  type RemoteSshFailureV1,
} from '../shared/remote-genomics-ipc';
import { isRemoteSshTarget } from '../shared/remote-ssh-target';
import { resolveSystemSshControlPath, sshControlPathArgument } from './remote-ssh-system-sharing';
import { remoteSshInvocation } from './remote-ssh-command';
import { RemoteGenomicsError } from './remote-genomics-error';
export { RemoteGenomicsError } from './remote-genomics-error';
import {
  addRemoteSshForward,
  allocateRemoteSshForward,
  cancelRemoteSshForward,
  remoteSshConnectionHandoff,
} from './remote-ssh-connection-handoff';

const READY_PREFIX = 'DNAFORGE_REMOTE_READY ';
const ERROR_PREFIX = 'DNAFORGE_REMOTE_ERROR ';
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_INDEX_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REMOTE_INDEX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8_192;
const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
const REMOTE_CHILD_TERMINATION_GRACE_MS = 500;
const REMOTE_CHILD_FORCE_KILL_WAIT_MS = 500;

export const REMOTE_SOURCE_CHANGED_MESSAGE =
  'The remote files changed since this track was added. Reconnect or use Edit Source to check and attach the current files.';

interface ValidatedRemoteAlignmentRequest {
  readonly requestId?: string;
  readonly allowInteractive?: boolean;
  readonly explorerSessionId?: string;
  readonly endpointId?: string;
  readonly displayName?: string;
  readonly target: string;
  readonly alignmentPath: string;
  readonly indexPath?: string;
  readonly signalPath?: string;
  readonly tileServerReceiptPath?: string;
}

interface RemoteHelperReady {
  readonly protocol: typeof REMOTE_RANGE_PROTOCOL_V1;
  readonly port: number;
  readonly platform: string;
  readonly tilePath?: string;
  readonly paths: {
    readonly alignment?: string;
    readonly index?: string;
    readonly signal?: string;
  };
  readonly files: {
    readonly alignment?: RemoteFileReceiptV1;
    readonly index?: RemoteFileReceiptV1;
    readonly signal?: RemoteFileReceiptV1;
    readonly reference?: RemoteFileReceiptV1;
    readonly referenceIndex?: RemoteFileReceiptV1;
  };
}

interface OwnedRemoteSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly materialization: RemoteAlignmentMaterializationV1 | RemoteSignalMaterializationV1;
  readonly indexCacheRoot: string | null;
  readonly releaseConnection: () => Promise<void>;
}

export interface LocalizedRemoteIndex {
  readonly path: string;
  readonly cacheRoot: string;
}

export function validateRemoteAlignmentRequest(
  request: RemoteAlignmentConnectRequestV1 | Record<string, unknown>
): ValidatedRemoteAlignmentRequest {
  const connection = validateRemoteConnectionRequest(request);
  const alignmentPath = requireAbsoluteRemotePath(request.alignmentPath, 'Remote alignment path');
  const alignmentIsCram = alignmentPath.toLowerCase().endsWith('.cram');
  if (!alignmentIsCram && !alignmentPath.toLowerCase().endsWith('.bam')) {
    throw new RemoteGenomicsError(
      'unsupported-alignment',
      'Remote streaming supports indexed BAM and CRAM files.'
    );
  }
  const indexPath =
    request.indexPath == null || request.indexPath === ''
      ? undefined
      : requireAbsoluteRemotePath(request.indexPath, 'Remote index path');
  if (indexPath && !/\.(?:bai|csi|crai)$/iu.test(indexPath)) {
    throw new RemoteGenomicsError(
      'invalid-request',
      'Remote index path must name a BAI, CSI, or CRAI file.'
    );
  }
  if (indexPath && alignmentIsCram && !/\.(?:crai|csi)$/iu.test(indexPath)) {
    throw new RemoteGenomicsError(
      'invalid-request',
      'A remote CRAM index must be a CRAI or CSI file.'
    );
  }
  const signalPath =
    request.signalPath == null || request.signalPath === ''
      ? undefined
      : requireAbsoluteRemotePath(request.signalPath, 'Remote BigWig path');
  if (signalPath && !/\.(?:bigwig|bw)$/iu.test(signalPath)) {
    throw new RemoteGenomicsError(
      'unsupported-signal',
      'Remote histogram streaming supports BigWig files.'
    );
  }
  return {
    ...connection,
    alignmentPath,
    ...(indexPath ? { indexPath } : {}),
    ...(signalPath ? { signalPath } : {}),
    ...(request.tileServerReceiptPath !== undefined
      ? {
          tileServerReceiptPath: requireAbsoluteRemotePath(
            request.tileServerReceiptPath,
            'Remote tile server receipt'
          ),
        }
      : {}),
  };
}

export function validateRemoteSignalRequest(
  request: RemoteSignalConnectRequestV1 | Record<string, unknown>
): RemoteSignalConnectRequestV1 {
  const connection = validateRemoteConnectionRequest(request);
  const signalPath = requireAbsoluteRemotePath(request.signalPath, 'Remote BigWig path');
  if (!/\.(?:bigwig|bw)$/iu.test(signalPath)) {
    throw new RemoteGenomicsError(
      'unsupported-signal',
      'Remote histogram streaming supports BigWig files.'
    );
  }
  return { ...connection, signalPath };
}

function validateRemoteConnectionRequest(request: {
  readonly target?: unknown;
  readonly requestId?: unknown;
  readonly allowInteractive?: unknown;
  readonly explorerSessionId?: unknown;
  readonly endpointId?: unknown;
  readonly displayName?: unknown;
}): Omit<ValidatedRemoteAlignmentRequest, 'alignmentPath' | 'indexPath' | 'signalPath'> {
  const target = validateRemoteSshTarget(request.target);
  const endpointId =
    request.endpointId == null ? undefined : requireText(request.endpointId, 'Endpoint ID', 200);
  const displayName =
    request.displayName == null ? undefined : requireText(request.displayName, 'Display name', 200);
  const requestId =
    request.requestId == null ? undefined : requireText(request.requestId, 'Request ID', 128);
  if (requestId && !/^[a-zA-Z0-9_-]+$/u.test(requestId)) {
    throw new RemoteGenomicsError('invalid-request', 'Remote connection request ID is invalid.');
  }
  if (request.allowInteractive !== undefined && typeof request.allowInteractive !== 'boolean') {
    throw new RemoteGenomicsError('invalid-request', 'Interactive SSH request setting is invalid.');
  }
  const explorerSessionId =
    request.explorerSessionId == null
      ? undefined
      : requireText(request.explorerSessionId, 'Tested connection ID', 128);
  if (
    explorerSessionId &&
    (!/^[a-zA-Z0-9_-]+$/u.test(explorerSessionId) ||
      !requestId ||
      request.allowInteractive !== true)
  ) {
    throw new RemoteGenomicsError(
      'invalid-request',
      'Tested SSH reuse requires an explicit connection request.'
    );
  }
  return {
    ...(requestId ? { requestId } : {}),
    ...(request.allowInteractive === true ? { allowInteractive: true } : {}),
    ...(explorerSessionId ? { explorerSessionId } : {}),
    ...(endpointId ? { endpointId } : {}),
    ...(displayName ? { displayName } : {}),
    target,
  };
}

export function validateRemoteSshTarget(value: unknown): string {
  const target = requireText(value, 'SSH target', 255);
  if (!isRemoteSshTarget(target)) {
    throw new RemoteGenomicsError(
      'invalid-request',
      'SSH target must be a host or OpenSSH alias without spaces or command-line options.'
    );
  }
  return target;
}

function requireText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') {
    throw new RemoteGenomicsError('invalid-request', `${label} is required.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximumLength || /[\0\r\n]/u.test(trimmed)) {
    throw new RemoteGenomicsError('invalid-request', `${label} is invalid.`);
  }
  return trimmed;
}

export function requireAbsoluteRemotePath(value: unknown, label: string): string {
  const path = requireText(value, label, 4_096);
  if (!path.startsWith('/')) {
    throw new RemoteGenomicsError('invalid-request', `${label} must be an absolute POSIX path.`);
  }
  return path;
}

export function classifyRemoteSshFailure(diagnostic: string): RemoteSshFailureV1 {
  const normalized = diagnostic
    .split(/\r?\n/u)
    .filter((line) => !/^\s*debug\d+:/iu.test(line))
    .join('\n')
    .toLowerCase();
  if (
    normalized.includes('remote host identification has changed') ||
    normalized.includes('host key verification failed')
  ) {
    return {
      code: 'host-trust-failed',
      message: userMessage('remote.hostTrustFailed'),
    };
  }
  if (
    normalized.includes('permission denied') ||
    normalized.includes('keyboard-interactive') ||
    normalized.includes('password:') ||
    normalized.includes('passphrase')
  ) {
    return {
      code: 'authentication-required',
      message:
        'Authenticate in your terminal using your institution’s supported login procedure, then reconnect. Use its SSH credentials or enable OpenSSH connection sharing to reuse a terminal login.',
    };
  }
  if (
    normalized.includes('could not resolve hostname') ||
    normalized.includes('connection timed out') ||
    normalized.includes('connection refused') ||
    normalized.includes('no route to host') ||
    normalized.includes('network is unreachable')
  ) {
    return {
      code: 'host-unreachable',
      message:
        'OpenSSH could not reach the endpoint. Check the alias, VPN, network, and jump-host configuration.',
    };
  }
  if (
    normalized.includes('python3: command not found') ||
    normalized.includes('python3: not found')
  ) {
    return {
      code: 'python-unavailable',
      message:
        'The remote endpoint does not provide Python 3, which this streaming helper requires.',
    };
  }
  if (normalized.includes('address already in use')) {
    return {
      code: 'tunnel-failed',
      message: 'A port needed by this SSH connection is already in use. Retry the connection.',
    };
  }
  if (
    normalized.includes('cannot listen to port') ||
    normalized.includes('port forwarding failed')
  ) {
    return {
      code: 'tunnel-failed',
      message:
        'OpenSSH could not establish the private loopback tunnel. Check endpoint forwarding policy and retry.',
    };
  }
  return {
    code: 'helper-failed',
    message: 'The remote DNAForge streaming helper exited before it became ready.',
  };
}

export function classifyRemoteSshTerminalFailure(diagnostic: string): RemoteSshFailureV1 | null {
  const lines = diagnostic.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^\s*debug\d+:/iu.test(line)) continue;
    if (
      /permission denied|remote host identification has changed|host key verification failed|could not resolve hostname|connection timed out|connection refused|no route to host|network is unreachable|python3: (?:command )?not found|address already in use|cannot listen to port|port forwarding failed/iu.test(
        line
      )
    ) {
      return classifyRemoteSshFailure(line);
    }
  }
  return null;
}

export function buildRemoteRangeHelperScript(input: {
  readonly port: number;
  readonly alignmentPath?: string;
  readonly indexPath?: string;
  readonly signalPath?: string;
  readonly tileServerReceiptPath?: string;
  readonly sourceHandle: string;
  readonly telemetry?: boolean;
}): string {
  if (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > 65_535) {
    throw new Error('Remote helper port is invalid.');
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/u.test(input.sourceHandle)) {
    throw new Error('Remote helper source handle is invalid.');
  }
  const encodedConfig = Buffer.from(
    JSON.stringify({
      port: input.port,
      alignmentPath: input.alignmentPath ?? null,
      indexPath: input.indexPath ?? null,
      signalPath: input.signalPath ?? null,
      tileServerReceiptPath: input.tileServerReceiptPath ?? null,
      sourceHandle: input.sourceHandle,
      telemetry: input.telemetry === true,
    }),
    'utf8'
  ).toString('base64');

  return `# DNAForge disposable remote range helper ${REMOTE_RANGE_PROTOCOL_V1}
import base64
import email.utils
import json
import os
import platform
import re
import select
import socket
import stat
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG = json.loads(base64.b64decode(${JSON.stringify(encodedConfig)}).decode("utf-8"))
READY_PREFIX = ${JSON.stringify(READY_PREFIX)}
ERROR_PREFIX = ${JSON.stringify(ERROR_PREFIX)}
TELEMETRY_PREFIX = "DNAFORGE_REMOTE_RANGE "
TELEMETRY_ENABLED = CONFIG.get("telemetry") is True
TELEMETRY_LOCK = threading.Lock()
STREAM_CHUNK_BYTES = 64 * 1024
STREAM_SEND_BUFFER_BYTES = 64 * 1024
STREAM_INITIAL_BURST_BYTES = 128 * 1024
TILE_CALCULATION_SLOTS = threading.BoundedSemaphore(4)
TILE_ADMITTED_REQUESTS = threading.BoundedSemaphore(20)

def emit_telemetry(payload):
    if not TELEMETRY_ENABLED:
        return
    with TELEMETRY_LOCK:
        print(TELEMETRY_PREFIX + json.dumps(payload, separators=(",", ":")), file=sys.stderr, flush=True)

def fail(code, message):
    print(ERROR_PREFIX + json.dumps({"code": code, "message": message}, separators=(",", ":")), flush=True)
    raise SystemExit(78)

def admitted_file(path, missing_code, label):
    canonical = os.path.realpath(path)
    try:
        descriptor = os.open(canonical, os.O_RDONLY)
        details = os.fstat(descriptor)
    except OSError:
        fail(missing_code, label + " was not found or is not readable.")
    if not stat.S_ISREG(details.st_mode):
        os.close(descriptor)
        fail(missing_code, label + " is not a regular file.")
    return canonical, descriptor, details

def prefer_cram(path, descriptor, details):
    # CRAM is the default read file when a sibling exists. The histogram stays on BigWig.
    if not path.lower().endswith(".bam"):
        return path, descriptor, details
    sibling = path[:-4] + ".cram"
    if os.path.isfile(sibling) and os.path.isfile(sibling + ".crai"):
        os.close(descriptor)
        return admitted_file(sibling, "ALIGNMENT_NOT_FOUND", "Remote CRAM")
    return path, descriptor, details

def discover_index(alignment, explicit):
    cram = alignment.lower().endswith(".cram")
    if explicit:
        if not os.path.isfile(explicit):
            fail("INDEX_NOT_FOUND", "Remote alignment index was not found or is not readable.")
        lowered = explicit.lower()
        if cram and lowered.endswith((".crai", ".csi")):
            return explicit
        if not cram and lowered.endswith((".bai", ".csi")):
            return explicit
    if cram:
        stem = alignment[:-5]
        candidates = [alignment + ".crai", stem + ".crai", alignment + ".csi", stem + ".csi"]
    else:
        stem = alignment[:-4]
        candidates = [alignment + ".bai", stem + ".bai", alignment + ".csi", stem + ".csi"]
    return next((candidate for candidate in candidates if os.path.isfile(candidate)), None)

def discover_signal(alignment, explicit):
    if explicit:
        path, descriptor, details = admitted_file(explicit, "SIGNAL_NOT_FOUND", "Remote BigWig")
        if not path.lower().endswith((".bigwig", ".bw")):
            fail("UNSUPPORTED_SIGNAL", "Remote histogram streaming supports BigWig files.")
        return path, descriptor, details
    directory, name = os.path.split(alignment)
    stem = name
    for extension in (".cram", ".bam"):
        if stem.lower().endswith(extension):
            stem = stem[: -len(extension)]
            break
    for suffix in (".markdup.sorted", ".sorted"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    for candidate in (
        os.path.join(directory, "bigwig", stem + ".bigWig"),
        os.path.join(directory, "bigwig", stem + ".bw"),
    ):
        if os.path.isfile(candidate):
            return admitted_file(candidate, "SIGNAL_NOT_FOUND", "Remote BigWig")
    return None

handle = CONFIG["sourceHandle"]
alignment_route = None
PATHS = {}
if CONFIG.get("alignmentPath"):
    requested_path, requested_fd, requested_stat = admitted_file(
        CONFIG["alignmentPath"], "ALIGNMENT_NOT_FOUND", "Remote alignment"
    )
    if not requested_path.lower().endswith((".bam", ".cram")):
        fail("UNSUPPORTED_ALIGNMENT", "Remote streaming supports BAM and CRAM files.")
    alignment_path, alignment_fd, alignment_stat = prefer_cram(
        requested_path, requested_fd, requested_stat
    )
    index_path = discover_index(alignment_path, CONFIG.get("indexPath"))
    if not index_path:
        fail("INDEX_NOT_FOUND", "No matching index was found beside the remote alignment.")
    index_path, index_fd, index_stat = admitted_file(index_path, "INDEX_NOT_FOUND", "Remote alignment index")
    signal = discover_signal(requested_path, CONFIG.get("signalPath"))
    if index_path.lower().endswith(".crai"):
        index_suffix = ".crai"
    elif index_path.lower().endswith(".csi"):
        index_suffix = ".csi"
    else:
        index_suffix = ".bai"
    alignment_route = "/v1/" + handle + (
        "/alignment.cram" if alignment_path.lower().endswith(".cram") else "/alignment.bam"
    )
    PATHS[alignment_route] = (alignment_fd, alignment_stat, "alignment")
    PATHS[alignment_route + index_suffix] = (index_fd, index_stat, "index")
else:
    if not CONFIG.get("signalPath"):
        fail("SIGNAL_NOT_FOUND", "An independent remote BigWig path is required.")
    signal = discover_signal(None, CONFIG["signalPath"])
if signal is not None:
    PATHS["/v1/" + handle + "/signal.bigWig"] = (signal[1], signal[2], "signal")

def receipt(path, details):
    return {
        "canonicalPath": path,
        "size": details.st_size,
        "mtimeNs": str(details.st_mtime_ns),
        "ctimeNs": str(details.st_ctime_ns),
        "device": str(details.st_dev),
        "inode": str(details.st_ino),
    }

def file_unchanged(descriptor, admitted):
    try:
        current = os.fstat(descriptor)
    except OSError:
        return False
    return (
        current.st_dev == admitted.st_dev
        and current.st_ino == admitted.st_ino
        and current.st_size == admitted.st_size
        and current.st_mtime_ns == admitted.st_mtime_ns
        and current.st_ctime_ns == admitted.st_ctime_ns
    )

TILE_SERVER = None
TILE_PATH = "/v1/" + handle + "/compute"
if CONFIG.get("tileServerReceiptPath"):
    try:
        fd = os.open(CONFIG["tileServerReceiptPath"], os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source:
            details = os.fstat(source.fileno())
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid() or details.st_mode & 0o077 or details.st_size > 65536:
                raise ValueError("The tile server receipt must be a private file owned by this user.")
            selected = json.load(source)
        if (selected.get("contract") != "dnaforge-remote-tiles.v1" or selected.get("platform") != "Linux"
            or type(selected.get("port")) is not int or not 0 < selected["port"] < 65536
            or not isinstance(selected.get("sessionToken"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", selected["sessionToken"])
            or selected.get("geometry") != {"tilePx": 1024, "baseBinBp": 1, "levelFactor": 2}):
            raise ValueError("The cluster tile server has an incompatible calculation contract.")
        generation = selected["generation"]
        if generation.get("alignment") != receipt(alignment_path, alignment_stat) or generation.get("index") != receipt(index_path, index_stat):
            raise ValueError("The cluster tile server serves another file generation. Restart it with the selected files.")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        base = "http://127.0.0.1:" + str(selected["port"])
        check = urllib.request.Request(base + "/v1/capabilities", headers={"X-DNAForge-Session": selected["sessionToken"]})
        with opener.open(check, timeout=15) as response:
            actual = json.loads(response.read(65537))
        if any(actual.get(key) != selected.get(key) for key in ("contract", "pid", "platform", "geometry", "generation")):
            raise ValueError("The tile server changed after its connection receipt was read.")
        TILE_SERVER = (base, selected["sessionToken"], generation, opener)
    except Exception as error:
        fail("CLUSTER_UNAVAILABLE", "Cluster computation is unavailable. Check the tile server receipt and restart the server if needed. " + str(error))

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        try:
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, STREAM_SEND_BUFFER_BYTES)
            if hasattr(socket, "TCP_NOTSENT_LOWAT"):
                self.connection.setsockopt(
                    socket.IPPROTO_TCP, socket.TCP_NOTSENT_LOWAT, STREAM_SEND_BUFFER_BYTES
                )
        except OSError:
            pass

    def log_message(self, _format, *_args):
        return

    def do_OPTIONS(self):
        admitted = PATHS.get(self.path.split("?", 1)[0])
        if admitted is None and not (TILE_SERVER and self.path.startswith(TILE_PATH + "/tiles/")):
            self.send_error(404)
            return
        self.send_response(204)
        self.send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.serve_file(False)

    def do_GET(self):
        self.serve_file(True)

    def do_POST(self):
        path = self.path[len(TILE_PATH):] if self.path.startswith(TILE_PATH) else ""
        if not TILE_SERVER or not re.fullmatch(r"/tiles/(?:alignment/(?:read|header)|(?:alignment|coverage|coverage-assembly)/[0-9]+/[0-9]+)", path):
            self.send_error(404)
            return
        if not all(file_unchanged(fd, details) for fd, details, _asset in PATHS.values()):
            self.send_error(412, "The remote files changed. Reconnect to check current files.")
            return
        admitted = False
        calculation_slot = False
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or self.headers.get("Transfer-Encoding"):
                raise ValueError("Invalid content length")
            length = int(lengths[0])
            if not 0 < length <= 1048576:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Invalid tile request")
            # Aborting a browser fetch cannot interrupt an HTSlib calculation
            # already running on Linux. Bound forwarded work here, and discard
            # abandoned queued requests before they can consume backend slots.
            if not TILE_ADMITTED_REQUESTS.acquire(blocking=False):
                self.send_error(503, "The cluster calculation queue is full.")
                return
            admitted = True
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if self.client_disconnected():
                    return
                if TILE_CALCULATION_SLOTS.acquire(timeout=0.05):
                    calculation_slot = True
                    break
            if not calculation_slot:
                self.send_error(503, "The cluster calculation queue timed out.")
                return
            if self.client_disconnected():
                return
            if not all(file_unchanged(fd, details) for fd, details, _asset in PATHS.values()):
                self.send_error(412, "The remote files changed. Reconnect to check current files.")
                return
            base, token, generation, opener = TILE_SERVER
            body["bamPath"] = generation["alignment"]["canonicalPath"]
            body["indexPath"] = generation["index"]["canonicalPath"]
            body["referencePath"] = generation.get("reference", {}).get("canonicalPath")
            body["sourceGeneration"] = generation
            is_header = path == "/tiles/alignment/header"
            # The v1 service already publishes its admitted header in
            # capabilities. Keep older supported allocations usable; a desktop
            # header read must not require an upgraded calculation endpoint.
            outgoing = (urllib.request.Request(base + "/v1/capabilities",
                headers={"X-DNAForge-Session": token}) if is_header else
                urllib.request.Request(base + path, data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "X-DNAForge-Session": token}))
            try:
                response = opener.open(outgoing, timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                data = response.read(67108865)
                if len(data) > 67108864:
                    raise ValueError("Tile response exceeds the bounded payload")
                status = response.status
                if is_header and status == 200:
                    capabilities = json.loads(data)
                    if any(capabilities.get(key) != selected.get(key) for key in ("contract", "pid", "platform", "geometry", "generation")):
                        status, data = 412, b'{"error":"SOURCE_GENERATION_CHANGED"}'
                    else:
                        data = json.dumps(capabilities["header"]).encode()
                if status == 409:
                    status = 412
                if not all(file_unchanged(fd, details) for fd, details, _asset in PATHS.values()):
                    status, data = 412, b'{"error":"SOURCE_GENERATION_CHANGED"}'
                self.send_response(status)
                self.send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                for header in ("X-DNAForge-Compute-Pid", "X-DNAForge-Compute-Platform"):
                    if response.headers.get(header):
                        self.send_header(header, response.headers[header])
                self.end_headers()
                self.wfile.write(data)
        except (ValueError, json.JSONDecodeError):
            self.send_error(422, "Invalid cluster tile request or response")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            self.send_error(503, "The cluster tile server stopped responding. Restart it and reconnect.")
        finally:
            if calculation_slot:
                TILE_CALCULATION_SLOTS.release()
            if admitted:
                TILE_ADMITTED_REQUESTS.release()

    def client_disconnected(self):
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def send_cors_headers(self):
        # The renderer is http://localhost and this helper is http://127.0.0.1.
        # The server binds only to loopback and only to admitted files.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
        )

    def serve_file(self, include_body):
        started_ns = time.monotonic_ns()
        admitted = PATHS.get(self.path.split("?", 1)[0])
        if admitted is None:
            self.send_error(404)
            return
        descriptor, details, asset = admitted
        if not file_unchanged(descriptor, details):
            self.send_error(412, "The remote file changed. Reconnect to check the current files.")
            return
        size = details.st_size
        start = 0
        end = size - 1
        status_code = 200
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\\d*)-(\\d*)", range_header.strip())
            if not match or (not match.group(1) and not match.group(2)):
                self.send_error(416)
                emit_telemetry({
                    "asset": asset,
                    "method": self.command,
                    "status": 416,
                    "start": None,
                    "end": None,
                    "bytes": 0,
                    "elapsedMs": round((time.monotonic_ns() - started_ns) / 1000000, 3),
                })
                return
            if match.group(1):
                start = int(match.group(1))
                end = min(size - 1, int(match.group(2))) if match.group(2) else size - 1
            else:
                suffix = int(match.group(2))
                start = max(0, size - suffix)
                end = size - 1
            if start >= size or end < start:
                self.send_response(416)
                self.send_cors_headers()
                self.send_header("Content-Range", "bytes */" + str(size))
                self.send_header("Content-Length", "0")
                self.end_headers()
                emit_telemetry({
                    "asset": asset,
                    "method": self.command,
                    "status": 416,
                    "start": start,
                    "end": end,
                    "bytes": 0,
                    "elapsedMs": round((time.monotonic_ns() - started_ns) / 1000000, 3),
                })
                return
            status_code = 206
        length = 0 if size == 0 else max(0, end - start + 1)
        self.send_response(status_code)
        self.send_cors_headers()
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("ETag", '"%x-%x-%x"' % (details.st_ino, details.st_mtime_ns, size))
        self.send_header("Last-Modified", email.utils.formatdate(details.st_mtime, usegmt=True))
        if status_code == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if not include_body or length == 0:
            emit_telemetry({
                "asset": asset,
                "method": self.command,
                "status": status_code,
                "start": start,
                "end": end,
                "bytes": 0,
                "elapsedMs": round((time.monotonic_ns() - started_ns) / 1000000, 3),
            })
            return
        sent = 0
        try:
            offset = start
            remaining = length
            while remaining:
                if not file_unchanged(descriptor, details):
                    self.close_connection = True
                    break
                chunk = os.pread(descriptor, min(STREAM_CHUNK_BYTES, remaining), offset)
                # Validate after pread as well: do not write a chunk read across
                # a concurrent mutation under the original file receipt.
                if not chunk or not file_unchanged(descriptor, details):
                    self.close_connection = True
                    break
                self.wfile.write(chunk)
                sent += len(chunk)
                offset += len(chunk)
                remaining -= len(chunk)
                # Socket buffers provide backpressure. Yield to cancellation and
                # other helper threads without throttling native indexed reads.
                if asset != "index" and sent >= STREAM_INITIAL_BURST_BYTES and remaining:
                    time.sleep(0)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            emit_telemetry({
                "asset": asset,
                "method": self.command,
                "status": status_code,
                "start": start,
                "end": end,
                "bytes": sent,
                "elapsedMs": round((time.monotonic_ns() - started_ns) / 1000000, 3),
            })

try:
    server = ThreadingHTTPServer(("127.0.0.1", int(CONFIG["port"])), Handler)
    server.daemon_threads = True
except OSError:
    fail("PORT_UNAVAILABLE", "The selected remote loopback port is unavailable.")

signal_route = "/v1/" + handle + "/signal.bigWig" if signal is not None else None
ready_paths = {}
ready_files = {}
if alignment_route is not None:
    ready_paths["alignment"] = alignment_route
    ready_paths["index"] = alignment_route + index_suffix
    ready_files["alignment"] = receipt(alignment_path, alignment_stat)
    ready_files["index"] = receipt(index_path, index_stat)
if signal is not None and signal_route is not None:
    ready_paths["signal"] = signal_route
    ready_files["signal"] = receipt(signal[0], signal[2])
if TILE_SERVER:
    for asset in ("reference", "referenceIndex"):
        if TILE_SERVER[2].get(asset) is not None:
            ready_files[asset] = TILE_SERVER[2][asset]
ready = {
    "protocol": ${JSON.stringify(REMOTE_RANGE_PROTOCOL_V1)},
    "port": server.server_port,
    "platform": platform.system().lower(),
    "paths": ready_paths,
    "files": ready_files,
}
if TILE_SERVER:
    ready["tilePath"] = TILE_PATH
print(READY_PREFIX + json.dumps(ready, separators=(",", ":")), flush=True)

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

export class RemoteGenomicsSupervisor {
  private readonly sessions = new Map<string, OwnedRemoteSession>();
  private readonly sessionListeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly options: {
      readonly sshPath?: string;
      readonly connectTimeoutMs?: number;
      readonly indexDownloadTimeoutMs?: number;
      readonly fetchImpl?: typeof fetch;
    } = {}
  ) {}

  async connect(
    request: RemoteAlignmentConnectRequestV1,
    signal?: AbortSignal
  ): Promise<RemoteAlignmentMaterializationV1> {
    return this.connectSource(validateRemoteAlignmentRequest(request), signal);
  }

  async connectSignal(
    request: RemoteSignalConnectRequestV1,
    signal?: AbortSignal
  ): Promise<RemoteSignalMaterializationV1> {
    return this.connectSource(validateRemoteSignalRequest(request), signal);
  }

  private connectSource(
    admitted: ValidatedRemoteAlignmentRequest,
    signal?: AbortSignal
  ): Promise<RemoteAlignmentMaterializationV1>;
  private connectSource(
    admitted: RemoteSignalConnectRequestV1,
    signal?: AbortSignal
  ): Promise<RemoteSignalMaterializationV1>;
  private async connectSource(
    admitted: ValidatedRemoteAlignmentRequest | RemoteSignalConnectRequestV1,
    signal?: AbortSignal
  ): Promise<RemoteAlignmentMaterializationV1 | RemoteSignalMaterializationV1> {
    signal?.throwIfAborted();
    const alignmentAdmission = 'alignmentPath' in admitted;
    const endpointId = admitted.endpointId ?? randomUUID();
    const sessionId = randomUUID();
    const sourceHandle = randomBytes(18).toString('base64url');
    let localPort = 0;
    signal?.throwIfAborted();
    const sshPath = this.options.sshPath ?? resolveSshExecutable();
    const connection =
      remoteSshConnectionHandoff.take(admitted.requestId, admitted.target) ??
      (await remoteHostService.retainConnection(admitted.target));
    const sshCommand = connection?.sshCommand ?? { executable: sshPath };
    let controlRoot: string | null = null;
    let systemControlPath: string | null = null;
    try {
      if (!connection)
        systemControlPath = await resolveSystemSshControlPath(sshPath, admitted.target, signal);
      if (!connection && !systemControlPath && process.platform !== 'win32') {
        controlRoot = await mkdtemp('/tmp/dfs-ctrl-');
      }
      if ((!connection && !systemControlPath && !controlRoot) || sshCommand.runtime === 'wsl') {
        localPort = await reserveLoopbackPort();
      }
      signal?.throwIfAborted();
    } catch (error) {
      await connection?.release();
      if (controlRoot) await rm(controlRoot, { recursive: true, force: true });
      throw error;
    }
    const controlPath =
      connection?.controlPath ??
      systemControlPath ??
      (controlRoot ? join(controlRoot, 'control') : null);
    const systemShared = connection?.systemShared === true || systemControlPath !== null;
    const requestedRemotePort = controlPath ? 0 : randomRemoteLoopbackPort();
    let remotePort = requestedRemotePort;
    let connectionCleanup: Promise<void> | null = null;
    let forwardAttempted = false;
    const releaseConnection = (): Promise<void> => {
      return (connectionCleanup ??= (async () => {
        try {
          if (controlPath && forwardAttempted && remotePort > 0)
            await cancelRemoteSshForward({
              sshPath,
              sshCommand,
              target: admitted.target,
              controlPath,
              localPort,
              remotePort,
            });
        } finally {
          await connection?.release();
          if (controlRoot) await rm(controlRoot, { recursive: true, force: true });
        }
      })());
    };
    const args = buildRemoteSshArgs({
      localPort,
      remotePort,
      target: admitted.target,
      ...(controlPath
        ? {
            control: {
              path: controlPath,
              master: !connection,
              systemShared,
              existingOnly: connection?.existingOnly,
            },
          }
        : {}),
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      signal?.throwIfAborted();
      const helperScript = buildRemoteRangeHelperScript({
        port: requestedRemotePort,
        ...(alignmentAdmission
          ? { alignmentPath: admitted.alignmentPath, indexPath: admitted.indexPath }
          : {}),
        signalPath: admitted.signalPath,
        ...(alignmentAdmission ? { tileServerReceiptPath: admitted.tileServerReceiptPath } : {}),
        sourceHandle,
        telemetry:
          process.env.WAYPOINT_TEST === '1' && process.env.DNAFORGE_REMOTE_RANGE_TELEMETRY === '1',
      });
      const invocation = remoteSshInvocation(sshCommand, args);
      child = spawn(invocation.executable, invocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(helperScript);
    } catch (error) {
      await releaseConnection();
      throw error;
    }

    const abortChild = (): void => {
      void terminateRemoteChild(child).catch(() => undefined);
    };
    signal?.addEventListener('abort', abortChild, { once: true });
    if (signal?.aborted) abortChild();
    try {
      let ready: RemoteHelperReady;
      let localizedIndex: LocalizedRemoteIndex | null = null;
      try {
        ready = await waitForHelperReady(
          child,
          this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          signal
        );

        child.stdout.resume();
        child.stderr.resume();
        const expectedSignalRoute = `/v1/${sourceHandle}/signal.bigWig`;
        const expectedAlignmentRoute = ready.files.alignment
          ? `/v1/${sourceHandle}/alignment${ready.files.alignment.canonicalPath.toLowerCase().endsWith('.cram') ? '.cram' : '.bam'}`
          : null;
        if (
          (requestedRemotePort !== 0 && ready.port !== requestedRemotePort) ||
          (alignmentAdmission
            ? !ready.files.alignment ||
              !ready.files.index ||
              !expectedAlignmentRoute ||
              ready.paths.alignment !== expectedAlignmentRoute ||
              !['.bai', '.csi', '.crai'].some(
                (extension) => ready.paths.index === `${expectedAlignmentRoute}${extension}`
              )
            : ready.files.alignment !== undefined ||
              ready.files.index !== undefined ||
              ready.paths.alignment !== undefined ||
              ready.paths.index !== undefined ||
              !ready.files.signal ||
              ready.paths.signal !== expectedSignalRoute) ||
          (ready.paths.signal != null && ready.paths.signal !== expectedSignalRoute) ||
          (alignmentAdmission && admitted.tileServerReceiptPath
            ? ready.tilePath !== `/v1/${sourceHandle}/compute`
            : ready.tilePath !== undefined) ||
          (ready.files.signal == null) !== (ready.paths.signal == null)
        ) {
          throw new RemoteGenomicsError(
            'helper-failed',
            'The remote helper returned an incompatible tunnel identity.'
          );
        }
        remotePort = ready.port;
        if (controlPath) {
          const destination = {
            sshPath,
            sshCommand,
            target: admitted.target,
            controlPath,
            remotePort,
          };
          let forwarded: boolean;
          if (sshCommand.runtime === 'wsl') {
            forwardAttempted = true;
            forwarded = await addRemoteSshForward({ ...destination, localPort }, signal);
          } else {
            const allocated = await allocateRemoteSshForward(destination, signal);
            if (allocated) {
              localPort = allocated.localPort;
              forwardAttempted = true;
            }
            forwarded = allocated !== null;
          }
          signal?.throwIfAborted();
          if (!forwarded) {
            throw new RemoteGenomicsError(
              'tunnel-failed',
              'SSH connected, but its private local port forward could not be started. Retry the connection.'
            );
          }
        }
        const fetchImpl = this.options.fetchImpl ?? fetch;
        if (ready.paths.alignment) {
          await proveForwardedRange(
            `http://127.0.0.1:${localPort}${ready.paths.alignment}`,
            fetchImpl,
            signal
          );
        }
        if (ready.paths.signal) {
          await proveForwardedRange(
            `http://127.0.0.1:${localPort}${ready.paths.signal}`,
            fetchImpl,
            signal
          );
        }
        if (ready.paths.index && ready.files.index) {
          localizedIndex = await materializeRemoteIndex({
            url: `http://127.0.0.1:${localPort}${ready.paths.index}`,
            receipt: ready.files.index,
            extension: ready.paths.index.endsWith('.crai')
              ? '.crai'
              : ready.paths.index.endsWith('.csi')
                ? '.csi'
                : '.bai',
            timeoutMs: this.options.indexDownloadTimeoutMs ?? DEFAULT_INDEX_DOWNLOAD_TIMEOUT_MS,
            fetchImpl,
            signal,
          });
        }
      } catch (error) {
        await terminateRemoteChild(child).catch(() => undefined);
        await releaseConnection();
        signal?.throwIfAborted();
        throw error;
      }

      const common = {
        protocol: REMOTE_RANGE_PROTOCOL_V1,
        sessionId,
        endpoint: {
          endpointId,
          displayName: admitted.displayName ?? admitted.target,
          target: admitted.target,
          lastConnectedAt: Date.now(),
          observedPlatform: ready.platform,
          lastFailure: null,
        },
      } as const;
      const materialization: RemoteAlignmentMaterializationV1 | RemoteSignalMaterializationV1 =
        alignmentAdmission
          ? {
              ...common,
              locator: {
                contract: REMOTE_ALIGNMENT_LOCATOR_V1,
                endpointId,
                target: admitted.target,
                alignmentPath: ready.files.alignment!.canonicalPath,
                indexPath: ready.files.index!.canonicalPath,
                ...(ready.files.signal ? { signalPath: ready.files.signal.canonicalPath } : {}),
                ...(admitted.tileServerReceiptPath
                  ? { tileServerReceiptPath: admitted.tileServerReceiptPath }
                  : {}),
              },
              bamUrl: `http://127.0.0.1:${localPort}${ready.paths.alignment}`,
              ...(ready.tilePath
                ? { tileBaseUrl: `http://127.0.0.1:${localPort}${ready.tilePath}` }
                : {}),
              indexPath: localizedIndex!.path,
              ...(ready.paths.signal
                ? { bigWigUrl: `http://127.0.0.1:${localPort}${ready.paths.signal}` }
                : {}),
              generation: {
                alignment: ready.files.alignment!,
                index: ready.files.index!,
                ...(ready.files.signal ? { signal: ready.files.signal } : {}),
                ...(ready.files.reference ? { reference: ready.files.reference } : {}),
                ...(ready.files.referenceIndex
                  ? { referenceIndex: ready.files.referenceIndex }
                  : {}),
              },
            }
          : {
              ...common,
              locator: {
                contract: REMOTE_SIGNAL_LOCATOR_V1,
                endpointId,
                target: admitted.target,
                signalPath: ready.files.signal!.canonicalPath,
              },
              bigWigUrl: `http://127.0.0.1:${localPort}${ready.paths.signal}`,
              generation: { signal: ready.files.signal! },
            };
      if (signal?.aborted || child.exitCode !== null || child.signalCode !== null) {
        if (localizedIndex)
          await rm(localizedIndex.cacheRoot, { recursive: true, force: true }).catch(
            () => undefined
          );
        await terminateRemoteChild(child).catch(() => undefined);
        await releaseConnection();
        signal?.throwIfAborted();
        throw new RemoteGenomicsError(
          'tunnel-failed',
          'The SSH session closed before the remote file could be attached.'
        );
      }
      this.sessions.set(sessionId, {
        child,
        materialization,
        indexCacheRoot: localizedIndex?.cacheRoot ?? null,
        releaseConnection,
      });
      const releaseExitedSession = (): void => {
        const session = this.sessions.get(sessionId);
        if (session?.child === child) {
          this.sessions.delete(sessionId);
          removeLocalIndexCache(session.indexCacheRoot);
          void session.releaseConnection();
          const listeners = this.sessionListeners.get(sessionId);
          this.sessionListeners.delete(sessionId);
          for (const listener of listeners ?? []) listener();
        }
      };
      child.once('error', releaseExitedSession);
      child.once('exit', releaseExitedSession);

      if (child.exitCode !== null || child.signalCode !== null) {
        releaseExitedSession();
        throw new RemoteGenomicsError(
          'tunnel-failed',
          'The SSH session closed before the remote file could be attached.'
        );
      }
      return materialization;
    } finally {
      signal?.removeEventListener('abort', abortChild);
    }
  }

  async disconnect(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.sessionListeners.delete(sessionId);
    try {
      await terminateRemoteChild(session.child);
    } finally {
      removeLocalIndexCache(session.indexCacheRoot);
      await session.releaseConnection();
    }
    return true;
  }

  subscribeSession(sessionId: string, listener: () => void): () => void {
    if (!this.sessions.has(sessionId)) {
      listener();
      return () => undefined;
    }
    const listeners = this.sessionListeners.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.sessionListeners.set(sessionId, listeners);
    return () => {
      const current = this.sessionListeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.sessionListeners.clear();
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await terminateRemoteChild(session.child);
        } finally {
          removeLocalIndexCache(session.indexCacheRoot);
          await session.releaseConnection();
        }
      })
    );
  }
}

export function buildRemoteSshArgs(input: {
  readonly localPort: number;
  readonly remotePort: number;
  readonly target: string;
  readonly interactive?: boolean;
  readonly control?: {
    readonly path: string;
    readonly master: boolean;
    readonly systemShared?: boolean;
    readonly existingOnly?: boolean;
  };
}): string[] {
  return [
    '-T',
    '-o',

    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    ...(input.remotePort === 0
      ? ['-o', 'ClearAllForwardings=yes']
      : ['-L', `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`]),
    ...(input.control
      ? [
          '-S',
          sshControlPathArgument(input.control.path),
          '-o',
          input.control.existingOnly
            ? 'ControlMaster=no'
            : input.control.systemShared
              ? 'ControlMaster=auto'
              : input.control.master
                ? 'ControlMaster=yes'
                : 'ControlMaster=no',
          ...(input.control.systemShared ? [] : ['-o', 'ControlPersist=no']),
          ...(input.control.existingOnly
            ? [
                '-o',
                'ProxyCommand=false',
                '-o',
                'ProxyJump=none',
                '-o',
                'ForkAfterAuthentication=no',
              ]
            : []),
        ]
      : []),
    input.target,
    'python3',
    '-u',
    '-',
  ];
}

export function resolveSshExecutable(): string {
  if (process.env.WAYPOINT_TEST && process.env.DNAFORGE_SSH_PATH) {
    return process.env.DNAFORGE_SSH_PATH;
  }
  return 'ssh';
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new RemoteGenomicsError('tunnel-failed', 'Could not reserve a private tunnel port.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

export function randomRemoteLoopbackPort(): number {
  return randomInt(49_152, 65_536);
}

function waitForHelperReady(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RemoteHelperReady> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      finish(
        new RemoteGenomicsError(
          'connection-timeout',
          'The SSH endpoint did not start the DNAForge streaming helper before the connection timeout.'
        )
      );
    }, timeoutMs);

    const finish = (error?: Error, ready?: RemoteHelperReady): void => {
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
      else resolve(ready as RemoteHelperReady);
    };
    const onStdout = (chunk: Buffer): void => {
      stdout = boundedAppend(stdout, chunk.toString('utf8'), MAX_PROTOCOL_LINE_BYTES);
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        const line = stdout.slice(0, newline).trimEnd();
        stdout = stdout.slice(newline + 1);
        if (line.startsWith(READY_PREFIX)) {
          if (remoteChildHasExited(child)) continue;
          try {
            const ready = parseHelperReady(JSON.parse(line.slice(READY_PREFIX.length)));
            finish(undefined, ready);
          } catch {
            finish(
              new RemoteGenomicsError(
                'helper-failed',
                'The remote helper returned an incompatible readiness response.'
              )
            );
          }
          return;
        }
        if (line.startsWith(ERROR_PREFIX)) {
          finish(helperProtocolError(line.slice(ERROR_PREFIX.length)));
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr = boundedAppend(stderr, chunk.toString('utf8'), MAX_DIAGNOSTIC_BYTES);
      finishTerminalFailureAfterExit();
    };
    const finishTerminalFailureAfterExit = (): void => {
      if (!remoteChildHasExited(child)) return;
      const classified = classifyRemoteSshTerminalFailure(stderr);
      if (classified) finish(new RemoteGenomicsError(classified.code, classified.message));
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      finish(
        error.code === 'ENOENT'
          ? new RemoteGenomicsError(
              'ssh-unavailable',
              'The system OpenSSH client was not found. Install or restore ssh on this computer.'
            )
          : new RemoteGenomicsError('helper-failed', 'OpenSSH could not be started.')
      );
    };
    const onClose = (): void => {
      const classified = classifyRemoteSshFailure(stderr);
      finish(new RemoteGenomicsError(classified.code, classified.message));
    };
    const onExit = (): void => finishTerminalFailureAfterExit();
    const onAbort = (): void => {
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('The remote file connection was cancelled.')
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

function parseHelperReady(value: unknown): RemoteHelperReady {
  if (!value || typeof value !== 'object') throw new Error('not an object');
  const ready = value as Partial<RemoteHelperReady>;
  if (
    ready.protocol !== REMOTE_RANGE_PROTOCOL_V1 ||
    !Number.isSafeInteger(ready.port) ||
    (ready.port ?? 0) < 1 ||
    (ready.port ?? 0) > 65_535 ||
    typeof ready.platform !== 'string' ||
    !ready.paths ||
    (ready.paths.alignment !== undefined && typeof ready.paths.alignment !== 'string') ||
    (ready.paths.index !== undefined && typeof ready.paths.index !== 'string') ||
    (ready.paths.signal !== undefined && typeof ready.paths.signal !== 'string') ||
    !ready.files ||
    (ready.files.alignment !== undefined && !isRemoteReceipt(ready.files.alignment)) ||
    (ready.files.index !== undefined && !isRemoteReceipt(ready.files.index)) ||
    (ready.files.signal !== undefined && !isRemoteReceipt(ready.files.signal)) ||
    (ready.files.reference !== undefined && !isRemoteReceipt(ready.files.reference)) ||
    (ready.files.referenceIndex !== undefined && !isRemoteReceipt(ready.files.referenceIndex))
  ) {
    throw new Error('invalid readiness response');
  }
  return ready as RemoteHelperReady;
}

function isRemoteReceipt(value: unknown): value is RemoteFileReceiptV1 {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<RemoteFileReceiptV1>;
  return (
    typeof receipt.canonicalPath === 'string' &&
    typeof receipt.size === 'number' &&
    Number.isSafeInteger(receipt.size) &&
    receipt.size >= 0 &&
    typeof receipt.mtimeNs === 'string' &&
    /^\d+$/u.test(receipt.mtimeNs) &&
    typeof receipt.ctimeNs === 'string' &&
    /^\d+$/u.test(receipt.ctimeNs) &&
    (typeof receipt.device === 'string' || receipt.device === null) &&
    (typeof receipt.inode === 'string' || receipt.inode === null) &&
    receipt.canonicalPath.startsWith('/')
  );
}

function helperProtocolError(payload: string): RemoteGenomicsError {
  try {
    const value = JSON.parse(payload) as { code?: unknown };
    switch (value.code) {
      case 'CLUSTER_UNAVAILABLE':
        return new RemoteGenomicsError(
          'cluster-unavailable',
          'Cluster computation is unavailable. Restart the tile server in your compute allocation, then reconnect. Check its private connection receipt if it is already running.'
        );
      case 'ALIGNMENT_NOT_FOUND':
        return new RemoteGenomicsError(
          'alignment-not-found',
          'The remote BAM was not found or is not readable.'
        );
      case 'INDEX_NOT_FOUND':
        return new RemoteGenomicsError(
          'index-not-found',
          'No readable BAI or CSI index was found for the remote BAM.'
        );
      case 'SIGNAL_NOT_FOUND':
        return new RemoteGenomicsError(
          'signal-not-found',
          'The remote BigWig was not found or is not readable.'
        );
      case 'UNSUPPORTED_SIGNAL':
        return new RemoteGenomicsError(
          'unsupported-signal',
          'Remote histogram streaming supports BigWig files.'
        );
      case 'UNSUPPORTED_ALIGNMENT':
        return new RemoteGenomicsError(
          'unsupported-alignment',
          'Remote streaming supports indexed BAM and CRAM files.'
        );
      case 'PORT_UNAVAILABLE':
        return new RemoteGenomicsError(
          'tunnel-failed',
          'The endpoint could not reserve a private helper port.'
        );
    }
  } catch {}
  return new RemoteGenomicsError('helper-failed', 'The remote streaming helper could not start.');
}

export async function proveForwardedRange(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  let stage = 'request';
  let status: number | null = null;
  let received = 0;
  const controller = new AbortController();
  const detachCancellation = propagateRemoteAbort(signal, controller);
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(url, {
      headers: { Range: 'bytes=0-0' },
      redirect: 'error',
      signal: controller.signal,
    });
    status = response.status;
    stage = 'body';
    if (response.status === 412) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteGenomicsError('source-changed', REMOTE_SOURCE_CHANGED_MESSAGE);
    }
    const contentRange = /^bytes 0-0\/([1-9]\d*)$/u.exec(
      response.headers.get('content-range') ?? ''
    );
    if (
      response.status !== 206 ||
      response.headers.get('accept-ranges') !== 'bytes' ||
      !contentRange ||
      !Number.isSafeInteger(Number(contentRange[1])) ||
      (response.headers.has('content-length') && response.headers.get('content-length') !== '1') ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteGenomicsError(
        'tunnel-failed',
        'The SSH tunnel opened, but the remote file range check failed.'
      );
    }
    const reader = response.body.getReader();
    let complete = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 1) {
          throw new RemoteGenomicsError(
            'tunnel-failed',
            'The SSH tunnel opened, but the remote file range check failed.'
          );
        }
      }
      if (received !== 1) {
        throw new RemoteGenomicsError(
          'tunnel-failed',
          'The SSH tunnel opened, but the remote file range check failed.'
        );
      }
      complete = true;
    } finally {
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof RemoteGenomicsError) throw error;
    const cause =
      error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
    console.warn('[remote-genomics] range verification failed:', {
      stage,
      elapsedMs: Date.now() - startedAt,
      status,
      receivedBytes: received,
      aborted: controller.signal.aborted,
      callerCancelled: signal?.aborted ?? false,
      errorName: error instanceof Error ? error.name : 'unknown',
      causeCode: cause?.code ?? null,
    });
    throw new RemoteGenomicsError(
      'tunnel-failed',
      'The SSH tunnel opened, but DNAForge could not reach the remote file helper.'
    );
  } finally {
    clearTimeout(timeout);
    detachCancellation();
  }
}

export async function materializeRemoteIndex(input: {
  readonly url: string;
  readonly receipt: RemoteFileReceiptV1;
  readonly extension: '.bai' | '.crai' | '.csi';
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<LocalizedRemoteIndex> {
  if (input.receipt.size <= 0 || input.receipt.size > MAX_REMOTE_INDEX_BYTES) {
    throw new RemoteGenomicsError(
      'helper-failed',
      'The remote index must be non-empty and no larger than 2 GiB.'
    );
  }

  const controller = new AbortController();
  const detachCancellation = propagateRemoteAbort(input.signal, controller);
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? DEFAULT_INDEX_DOWNLOAD_TIMEOUT_MS
  );
  let cacheRoot: string | null = null;
  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      signal: controller.signal,
      redirect: 'error',
    });
    if (response.status === 412) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteGenomicsError('source-changed', REMOTE_SOURCE_CHANGED_MESSAGE);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (
      response.status !== 200 ||
      !Number.isSafeInteger(contentLength) ||
      contentLength !== input.receipt.size ||
      !response.body
    ) {
      throw new RemoteGenomicsError(
        'tunnel-failed',
        'The SSH tunnel opened, but the remote index response did not match its file receipt.'
      );
    }

    cacheRoot = await mkdtemp(join(tmpdir(), 'dnaforge-remote-index-'));
    const indexPath = join(cacheRoot, `alignment.bam${input.extension}`);
    const handle = await open(indexPath, 'wx', 0o600);
    let bytesWritten = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytesWritten + value.byteLength > input.receipt.size) {
          await reader.cancel();
          throw new RemoteGenomicsError(
            'tunnel-failed',
            'The remote index changed while DNAForge was caching it.'
          );
        }
        let chunkOffset = 0;
        while (chunkOffset < value.byteLength) {
          const write = await handle.write(
            value,
            chunkOffset,
            value.byteLength - chunkOffset,
            null
          );
          if (write.bytesWritten <= 0) {
            throw new Error('The local index cache stopped accepting data.');
          }
          chunkOffset += write.bytesWritten;
        }
        bytesWritten += value.byteLength;
      }
    } finally {
      await handle.close();
    }

    if (bytesWritten !== input.receipt.size) {
      throw new RemoteGenomicsError(
        'tunnel-failed',
        'The remote index changed while DNAForge was caching it.'
      );
    }
    return { path: indexPath, cacheRoot };
  } catch (error) {
    controller.abort();
    if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof RemoteGenomicsError) throw error;
    throw new RemoteGenomicsError(
      'tunnel-failed',
      'The SSH tunnel opened, but DNAForge could not cache the remote index.'
    );
  } finally {
    clearTimeout(timeout);
    detachCancellation();
  }
}

function propagateRemoteAbort(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return () => signal?.removeEventListener('abort', abort);
}

function removeLocalIndexCache(cacheRoot: string | null): void {
  if (!cacheRoot) return;
  void rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
}

function boundedAppend(current: string, incoming: string, maximum: number): string {
  const combined = current + incoming;
  return combined.length <= maximum ? combined : combined.slice(-maximum);
}

function remoteChildHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForRemoteChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (remoteChildHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timeout = setTimeout(() => finish(remoteChildHasExited(child)), timeoutMs);
    timeout.unref();
    child.once('exit', onExit);
  });
}

export async function terminateRemoteChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (remoteChildHasExited(child)) return;

  const gracefulExit = waitForRemoteChildExit(child, REMOTE_CHILD_TERMINATION_GRACE_MS);
  child.kill('SIGTERM');
  if (process.platform !== 'win32') child.kill('SIGCONT');
  if (await gracefulExit) return;

  if (!remoteChildHasExited(child)) child.kill('SIGKILL');
  if (await waitForRemoteChildExit(child, REMOTE_CHILD_FORCE_KILL_WAIT_MS)) return;
  throw new Error('The remote SSH streaming process could not be terminated.');
}

export const remoteGenomicsSupervisor = new RemoteGenomicsSupervisor();
