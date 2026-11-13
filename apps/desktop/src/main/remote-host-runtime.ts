import { execFile, spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, posix, win32 } from 'node:path';
import { RemoteGenomicsError } from './remote-genomics-error';
import { remoteSshInvocation, type RemoteSshCommand } from './remote-ssh-command';

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteWindowsArgument(value: string): string {
  if (value !== '' && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}

export async function executeHostCommand(
  executable: string,
  args: readonly string[],
  timeout = 5_000,
  input?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [...args],
      {
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

export function executeTerminalLaunchAcknowledgement(
  executable: string,
  args: readonly string[],
  timeout = 30_000
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
    });
    let settled = false;
    let pending = '';
    const finish = (error: Error | null, pid?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.stdout?.destroy();
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else {
        child.unref();
        resolve(pid!);
      }
    };
    const unacknowledged = () =>
      new Error('Windows did not acknowledge its native terminal process.');
    const deadline = setTimeout(
      () =>
        finish(
          Object.assign(new Error('Windows native terminal launch timed out.'), {
            code: 'ETIMEDOUT',
          })
        ),
      timeout
    );
    child.once('error', (error) => finish(error));
    child.once('close', () => finish(unacknowledged()));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      pending += chunk.toString('utf8');
      const newline = pending.indexOf('\n');
      if (pending.length > 64) return finish(unacknowledged());
      if (newline < 0) return;
      const line = pending.slice(0, newline).trim();
      const pid = /^\d{1,10}$/u.test(line) ? Number(line) : NaN;
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0xffffffff)
        return finish(unacknowledged());
      finish(null, pid);
    });
  });
}

export function linuxTerminalInvocation(executable: string, scriptPath: string) {
  const name = posix.basename(executable);
  return {
    executable,
    args:
      name === 'gnome-terminal'
        ? ['--', '/bin/sh', scriptPath]
        : name === 'xfce4-terminal'
          ? ['--disable-server', '--execute', '/bin/sh', scriptPath]
          : ['-e', '/bin/sh', scriptPath],
  };
}

export class RemoteHostRuntime {
  readonly sshCommand: RemoteSshCommand;

  constructor(
    readonly platform: NodeJS.Platform,
    readonly sshPath: string,
    private readonly wsl?: {
      readonly executable: string;
      readonly distribution: string;
      readonly user: string;
    }
  ) {
    this.sshCommand = wsl
      ? {
          executable: wsl.executable,
          runtime: 'wsl',
          prefixArgs: ['--distribution', wsl.distribution, '--user', wsl.user, '--exec', sshPath],
        }
      : { executable: sshPath };
  }

  run(executable: string, args: readonly string[], timeout = 5_000, input?: string) {
    return this.wsl
      ? executeHostCommand(
          this.wsl.executable,
          [
            '--distribution',
            this.wsl.distribution,
            '--user',
            this.wsl.user,
            '--exec',
            executable,
            ...args,
          ],
          timeout,
          input
        )
      : executeHostCommand(executable, args, timeout, input);
  }

  runSsh(args: readonly string[], timeout = 5_000) {
    const command = remoteSshInvocation(this.sshCommand, args);
    return executeHostCommand(command.executable, command.args, timeout);
  }

  async createRoot(prefix: 'df-host-' | 'df-shell-'): Promise<string> {
    if (!this.wsl) return mkdtemp(`/tmp/${prefix}`);
    const root = (await this.run('/usr/bin/mktemp', ['-d', `/tmp/${prefix}XXXXXX`])).trim();
    if (!new RegExp(`^/tmp/${prefix}[A-Za-z0-9]+$`, 'u').test(root))
      throw new Error('WSL did not return an owned temporary directory.');
    return root;
  }

  async read(path: string): Promise<string> {
    return this.wsl ? this.run('/bin/cat', [path]) : readFile(path, 'utf8');
  }

  async write(path: string, contents: string, mode: number): Promise<void> {
    if (!this.wsl) {
      await writeFile(path, contents, { mode });
      return;
    }
    await this.run(
      '/bin/sh',
      ['-c', 'umask 077; cat > "$1" && chmod "$2" "$1"', '--', path, mode.toString(8)],
      5_000,
      contents
    );
  }

  async isSocket(path: string): Promise<boolean> {
    return this.wsl
      ? this.run('/usr/bin/test', ['-S', path]).then(
          () => true,
          () => false
        )
      : lstat(path).then(
          (s) => s.isSocket(),
          () => false
        );
  }

  async terminateLogin(pid: number, controlPath: string): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    const command = await this.run('/bin/ps', ['-p', String(pid), '-o', 'command='], 1_000).catch(
      () => ''
    );
    if (!command.includes(controlPath)) return;
    if (this.wsl) await this.run('/bin/kill', ['-TERM', String(pid)], 1_000).catch(() => undefined);
    else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }

  async removeRoot(root: string): Promise<void> {
    if (!/^\/tmp\/df-(?:host|shell)-[A-Za-z0-9]+$/u.test(root))
      throw new Error('Refusing to remove an unowned SSH temporary directory.');
    if (this.wsl) await this.run('/bin/rm', ['-rf', '--', root]);
    else await rm(root, { recursive: true, force: true });
  }

  async launchTerminal(scriptPath: string): Promise<number | null> {
    if (this.platform === 'darwin') {
      await executeHostCommand('/usr/bin/open', [
        ...(process.env.DNAFORGE_BACKGROUND_WINDOW === '1' ? ['-g'] : []),
        '-a',
        'Terminal',
        scriptPath,
      ]);
      return null;
    }
    if (this.wsl) {
      const args = [
        '--distribution',
        this.wsl.distribution,
        '--user',
        this.wsl.user,
        '--exec',
        '/bin/sh',
        scriptPath,
      ]
        .map(quoteWindowsArgument)
        .join(' ');
      const script = `(Start-Process -FilePath ${quotePowerShell(this.wsl.executable)} -ArgumentList ${quotePowerShell(args)} -PassThru -ErrorAction Stop).Id`;
      const powershell = win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      return executeTerminalLaunchAcknowledgement(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ]);
    }
    if (this.platform === 'linux') {
      for (const name of [
        'x-terminal-emulator',
        'gnome-terminal',
        'konsole',
        'xfce4-terminal',
        'xterm',
      ]) {
        const executable = (
          await executeHostCommand('which', [name], 2_000).catch(() => '')
        ).trim();
        if (!isAbsolute(executable)) continue;
        const invocation = linuxTerminalInvocation(executable, scriptPath);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(invocation.executable, invocation.args, {
            detached: true,
            stdio: 'ignore',
          });
          child.once('error', reject);
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
        });
        return null;
      }
      throw new RemoteGenomicsError(
        'helper-failed',
        'No supported terminal was found. Install a terminal such as GNOME Terminal, Konsole, Xfce Terminal or xterm, then try again.'
      );
    }
    throw new RemoteGenomicsError(
      'ssh-unavailable',
      'Native terminal login is unavailable on this platform.'
    );
  }

  shellCommand(args: readonly string[]): string {
    return [this.sshPath, ...args].map(quotePosix).join(' ');
  }
}

export async function resolveRemoteHostRuntime(override?: string): Promise<RemoteHostRuntime> {
  if (process.platform === 'win32') {
    const wsl = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    let output: string;
    try {
      output = await executeHostCommand(
        wsl,
        ['--exec', '/bin/sh', '-c', 'printf "%s\\n" "$WSL_DISTRO_NAME"; id -un; command -v ssh'],
        15_000
      );
    } catch {
      throw new RemoteGenomicsError(
        'ssh-unavailable',
        'Windows terminal sign-in requires an installed WSL Linux distribution with OpenSSH. Complete your institution’s WSL setup, then try again. DNAForge uses that distribution’s SSH configuration.'
      );
    }
    const [distribution, user, discoveredSshPath] = output.trim().split(/\r?\n/u);
    const sshPath =
      override ??
      (process.env.WAYPOINT_TEST === '1' ? process.env.DNAFORGE_SSH_PATH : undefined) ??
      discoveredSshPath;
    if (
      !distribution ||
      /[\0\r\n/\\]/u.test(distribution) ||
      !user ||
      /[\0\r\n/\\]/u.test(user) ||
      !sshPath?.startsWith('/')
    )
      throw new RemoteGenomicsError(
        'ssh-unavailable',
        'OpenSSH was not found in your default WSL distribution. Install openssh-client there, then try again.'
      );
    return new RemoteHostRuntime('win32', sshPath, { executable: wsl, distribution, user });
  }
  const sshPath =
    override ??
    (process.env.WAYPOINT_TEST === '1' ? process.env.DNAFORGE_SSH_PATH : undefined) ??
    (await executeHostCommand('which', ['ssh'], 2_000).catch(() => '')).trim();
  if (!isAbsolute(sshPath))
    throw new RemoteGenomicsError(
      'ssh-unavailable',
      'System OpenSSH was not found. Install ssh before signing in.'
    );
  return new RemoteHostRuntime(process.platform, sshPath);
}
