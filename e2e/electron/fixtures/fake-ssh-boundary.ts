import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function readFakeSshProcesses(
  logPath: string,
  target: string
): Array<{ pid: number; args: string }> {
  const lines = readFileSync(logPath, 'utf8').split(/\r?\n/u);
  return lines.flatMap((args, index) => {
    if (!args.startsWith('-T ') || !args.endsWith(` ${target} python3 -u -`)) return [];
    const pid = Number(/^DNAFORGE_FAKE_SSH_PID (\d+)$/u.exec(lines[index + 1] ?? '')?.[1]);
    return Number.isSafeInteger(pid) && pid > 1 ? [{ pid, args }] : [];
  });
}

export function fakeSshProcessHasExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}

export function readFakeSshForwards(logPath: string, target: string): string[] {
  const destinations = new Set<string>();
  return readFileSync(logPath, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => {
      if (!line.includes(' -W ') || !line.endsWith(` ${target}`)) return false;
      const controlPath = line.match(/ -S (\S+) /u)?.[1];
      const destination = line.match(/ -W (127\.0\.0\.1:\d+) /u)?.[1];
      if (!controlPath || !destination) return false;
      const key = `${controlPath}\0${destination}`;
      if (destinations.has(key)) return false;
      destinations.add(key);
      return true;
    });
}

export function createFakeSshBoundary(workspaceRoot: string): {
  readonly executablePath: string;
  readonly bridgePath: string;
  readonly logPath: string;
  readonly failureMarkerPath: string;
} {
  const executablePath = join(workspaceRoot, 'fake-ssh');
  const bridgePath = join(workspaceRoot, 'fake-ssh-bridge.py');
  const logPath = join(workspaceRoot, 'fake-ssh.log');
  const failureMarkerPath = join(workspaceRoot, 'fake-ssh-offline');
  writeFileSync(
    bridgePath,
    `import json
import os
import re
import select
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time

control_path = sys.argv[sys.argv.index('-S') + 1] if '-S' in sys.argv else None
control_master = 'ControlMaster=yes' in sys.argv

def parse_forward():
    forward = sys.argv[sys.argv.index('-L') + 1]
    match = re.fullmatch(r'127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)', forward)
    if match is None:
        raise ValueError('fake SSH received an unsupported loopback forward')
    return tuple(map(int, match.groups()))

class ThreadedServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

def start_forward(local_port, remote_port):
    class Forward(socketserver.BaseRequestHandler):
        def handle(self):
            try:
                with socket.create_connection(('127.0.0.1', remote_port), timeout=5) as upstream:
                    peers = (self.request, upstream)
                    while True:
                        readable, _, _ = select.select(peers, [], [], 1)
                        for source in readable:
                            chunk = source.recv(65536)
                            if not chunk:
                                return
                            (upstream if source is self.request else self.request).sendall(chunk)
            except OSError:
                return
    server = ThreadedServer(('127.0.0.1', local_port), Forward)
    threading.Thread(target=lambda: server.serve_forever(poll_interval=0.02), daemon=True).start()
    return server

if '-W' in sys.argv:
    if sys.argv[-1] == 'forward-silent-hpc':
        time.sleep(180)
    if sys.argv[-1] == 'forward-denied-hpc':
        raise SystemExit(255)
    try:
        destination = sys.argv[sys.argv.index('-W') + 1]
        match = re.fullmatch(r'127\\.0\\.0\\.1:(\\d+)', destination)
        if match is None:
            raise ValueError('fake SSH received an unsupported stdio destination')
        remote_port = int(match.group(1))
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(control_path)
            client.sendall((json.dumps({'operation': 'stdio', 'remote': remote_port}) + '\\n').encode())
            reply = client.makefile('rb').readline(1024)
            if not json.loads(reply).get('ok'):
                raise SystemExit(255)
            client.settimeout(None)
            with socket.create_connection(('127.0.0.1', remote_port), timeout=5) as upstream:
                upstream.settimeout(None)
                input_open = True
                while True:
                    peers = [client, upstream] + ([sys.stdin.buffer] if input_open else [])
                    readable, _, _ = select.select(peers, [], [], 1)
                    if client in readable:
                        # The authentication owner disappeared. There is no
                        # new-login path for an admitted stdio channel.
                        raise SystemExit(255)
                    if input_open and sys.stdin.buffer in readable:
                        chunk = os.read(0, 65536)
                        if chunk:
                            upstream.sendall(chunk)
                        else:
                            input_open = False
                            upstream.shutdown(socket.SHUT_WR)
                    if upstream in readable:
                        chunk = upstream.recv(65536)
                        if not chunk:
                            raise SystemExit(0)
                        os.write(1, chunk)
    except (OSError, ValueError):
        raise SystemExit(255)

if '-O' in sys.argv:
    # The fixture has no master-owned forwarding listeners. Only a local
    # readiness check is a supported control operation.
    operation = sys.argv[sys.argv.index('-O') + 1]
    if operation != 'check':
        raise SystemExit(255)
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(control_path)
            client.sendall(b'{"operation":"check"}\\n')
            reply = client.makefile('rb').readline(1024)
        raise SystemExit(0 if json.loads(reply).get('ok') else 255)
    except (OSError, ValueError):
        raise SystemExit(255)

helper_source = sys.stdin.buffer.read()
remote_helper = None
forwarder = None
control_server = None

class Control(socketserver.StreamRequestHandler):
    def handle(self):
        ok = False
        try:
            request = json.loads(self.rfile.readline(4096))
            if request['operation'] not in ('check', 'stdio'):
                raise ValueError('Invalid control operation')
            ok = True
        except (OSError, ValueError, KeyError):
            pass
        self.wfile.write((json.dumps({'ok': ok}) + '\\n').encode())
        self.wfile.flush()
        if ok and request['operation'] == 'stdio':
            # Keep a real master-lifetime socket for this borrowed channel.
            # Master exit closes it; stdio-client exit releases only this socket.
            self.rfile.read(1)

try:
    if control_master and control_path:
        control_server = socketserver.ThreadingUnixStreamServer(control_path, Control)
        control_server.daemon_threads = True
        threading.Thread(target=lambda: control_server.serve_forever(poll_interval=0.02), daemon=True).start()
    if '-L' in sys.argv:
        local_port, remote_port = parse_forward()
        if local_port != remote_port:
            forwarder = start_forward(local_port, remote_port)
    remote_helper = subprocess.Popen(
        [sys.executable, '-u', '-'], stdin=subprocess.PIPE, stdout=sys.stdout, stderr=sys.stderr
    )
    remote_helper.stdin.write(helper_source)
    remote_helper.stdin.close()

    def terminate(_signal, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    raise SystemExit(remote_helper.wait())
finally:
    if control_server is not None:
        control_server.shutdown()
        control_server.server_close()
        try:
            os.unlink(control_path)
        except FileNotFoundError:
            pass
    if forwarder is not None:
        forwarder.shutdown()
        forwarder.server_close()
    if remote_helper is not None and remote_helper.poll() is None:
        remote_helper.terminate()
        try:
            remote_helper.wait(timeout=5)
        except subprocess.TimeoutExpired:
            remote_helper.kill()
            remote_helper.wait()
    if control_master and control_path:
        try:
            os.unlink(control_path + '.authenticated')
        except FileNotFoundError:
            pass
`,
    'utf8'
  );
  writeFileSync(
    executablePath,
    [
      '#!/bin/sh',
      'if [ "$1" = -G ]; then printf \'controlmaster false\\ncontrolpersist no\\n\'; exit 0; fi',
      'printf \'%s\\n%s\\n\' "$*" "DNAFORGE_FAKE_SSH_PID $$" >> "$DNAFORGE_FAKE_SSH_LOG"',
      'control_path=',
      'expect_control=no',
      'for argument in "$@"; do',
      '  if [ "$expect_control" = yes ]; then control_path="$argument"; expect_control=no; fi',
      '  if [ "$argument" = -S ]; then expect_control=yes; fi',
      'done',
      'reusing_connection=no',
      'case " $* " in',
      '  *" ControlMaster=no "*) [ -n "$control_path" ] && [ -f "$control_path.authenticated" ] && reusing_connection=yes ;;',
      'esac',
      'if [ -f "$DNAFORGE_FAKE_SSH_FAIL_MARKER" ]; then',
      "  printf '%s\\n' 'Permission denied (publickey).' >&2",
      '  exit 255',
      'fi',
      'case " $* " in',
      '  *" -W "*)',
      '    [ "$reusing_connection" = yes ] || exit 255',
      '    case " $* " in *" BatchMode=yes "*) ;; *) exit 255 ;; esac',
      '    case " $* " in *" ProxyCommand=false "*) ;; *) exit 255 ;; esac',
      '    exec python3 -u "$DNAFORGE_FAKE_SSH_BRIDGE" "$@"',
      '    ;;',
      '  *" -O "*) exec python3 -u "$DNAFORGE_FAKE_SSH_BRIDGE" "$@" ;;',
      'esac',
      'if [ "$reusing_connection" != yes ]; then',
      'case " $* " in',
      '  *" python-unavailable-hpc "*)',
      "    printf '%s\\n' 'python3: command not found' >&2",
      '    exit 127',
      '    ;;',
      '  *" silent-hpc "*)',
      "    exec python3 -c 'import time; time.sleep(180)'",
      '    ;;',
      '  *" denied-hpc "*)',
      "    printf '%s\\n' 'Permission denied (publickey).' >&2",
      '    exit 255',
      '    ;;',
      '  *" institutional-hpc "*)',
      '    if [ ! -f "$DNAFORGE_FAKE_SSH_FAIL_MARKER.institutional-authenticated" ]; then',
      "      printf '%s\\n' 'Permission denied (publickey).' >&2; exit 255",
      '    fi',
      '    ;;',
      '  *" interactive-hpc "*|*" cancel-hpc "*)',
      '    case " $* " in',
      "      *\" BatchMode=yes \"*) printf '%s\\n' 'Permission denied (publickey).' >&2; exit 255 ;;",
      '    esac',
      '    case " $* " in',
      '      *" interactive-hpc "*)',
      '        answer=$("$SSH_ASKPASS" "The authenticity of host interactive-hpc cannot be established. SHA256:fixture-only-host-key. Are you sure you want to continue connecting (yes/no/[fingerprint])?") || exit 255',
      '        [ "$answer" = yes ] || exit 255',
      '        ;;',
      '    esac',
      '    answer=$("$SSH_ASKPASS" "Password for test HPC:") || { printf \'%s\\n\' \'Permission denied (publickey).\' >&2; exit 255; }',
      '    [ "$answer" = fixture-password ] || exit 255',
      '    answer=$("$SSH_ASKPASS" "Verification code:") || exit 255',
      '    [ "$answer" = 123456 ] || exit 255',
      '    unset answer',
      '    ;;',
      'esac',
      'fi',
      'case " $* " in',
      '  *" ControlMaster=yes "*) [ -n "$control_path" ] && : > "$control_path.authenticated" ;;',
      'esac',
      'exec python3 -u "$DNAFORGE_FAKE_SSH_BRIDGE" "$@"',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o700 }
  );
  return { executablePath, bridgePath, logPath, failureMarkerPath };
}
