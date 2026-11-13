import { posix } from 'node:path';
import { userMessage } from '@waypoint/user-messages';
import type { RemoteHostAccessV1 } from '../shared/remote-hosts';
import { isRemoteSshTarget } from '../shared/remote-ssh-target';
import { RemoteGenomicsError } from './remote-genomics-error';
import type { RemoteSshConnectionLease } from './remote-ssh-connection-handoff';
import { resolveSystemSshControlPath, sshControlPathArgument } from './remote-ssh-system-sharing';
import { RemoteHostRuntime, resolveRemoteHostRuntime } from './remote-host-runtime';
import { RELEASE_BUILD_IDENTITY } from './release-stamp';

const { join } = posix;

const ACCESS_RECEIPT = 'DNAFORGE_SSH_ACCESS_V1';

function targetText(value: unknown): string {
  if (typeof value !== 'string' || !isRemoteSshTarget(value.trim())) {
    throw new RemoteGenomicsError(
      'invalid-request',
      'Enter an SSH alias or user@host, without command options.'
    );
  }
  return value.trim();
}

export function buildManagedSshLoginArgs(target: string, controlPath: string): string[] {
  return [
    '-M',
    '-S',
    sshControlPathArgument(controlPath),
    '-o',
    'ControlMaster=yes',
    '-o',
    'ControlPersist=10m',
    '-o',
    'BatchMode=no',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'ClearAllForwardings=yes',
    targetText(target),
  ];
}

export function buildExistingSshArgs(target: string, controlPath: string): string[] {
  return [
    '-S',
    sshControlPathArgument(controlPath),
    '-o',
    'ControlMaster=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ProxyCommand=false',
    '-o',
    'ProxyJump=none',
    '-o',
    'ForkAfterAuthentication=no',
    targetText(target),
  ];
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface HostConnection {
  readonly target: string;
  readonly sshPath: string;
  readonly runtime: RemoteHostRuntime;
  readonly controlPath: string;
  readonly root: string | null;
  readonly terminalStartDeadline: number | null;
  terminalWindowsProcessId: number | null;
  consumers: number;
  ending: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

export class RemoteHostService {
  private readonly connections = new Map<string, HostConnection>();
  private readonly observations = new Map<string, RemoteHostAccessV1>();
  private readonly checking = new Map<string, Promise<RemoteHostAccessV1>>();
  private readonly starting = new Map<string, Promise<RemoteHostAccessV1>>();
  private readonly privateRoots = new Map<string, RemoteHostRuntime>();
  private readonly generations = new Map<string, number>();
  private stopping = false;

  constructor(
    private readonly options: {
      readonly sshPath?: string;
      readonly allowExternalSharing?: boolean;
      readonly launchTerminal?: (scriptPath: string) => Promise<void>;
      readonly runtime?: RemoteHostRuntime;
    } = {}
  ) {}

  status(input: string): RemoteHostAccessV1 {
    const target = targetText(input);
    const connection = this.connections.get(target);
    return {
      target,
      state: 'not-checked',
      checkedAt: null,
      connection: 'none',
      lastFailure: null,
      ...this.observations.get(target),
      activeConsumers: connection?.consumers ?? 0,
    };
  }

  terminalAcknowledgement(
    input: string
  ): { scriptPath: string; windowsProcessId: number | null } | null {
    const connection = this.connections.get(targetText(input));
    if (!connection?.root || connection.ending) return null;
    return {
      scriptPath: join(connection.root, 'Sign in.command'),
      windowsProcessId: connection.terminalWindowsProcessId,
    };
  }

  signIn(input: string): Promise<RemoteHostAccessV1> {
    const target = targetText(input);
    if (this.stopping)
      return Promise.reject(
        new RemoteGenomicsError('helper-failed', 'DNAForge is closing its host connections.')
      );
    const pending = this.starting.get(target);
    if (pending) return pending;
    const promise = this.startSignIn(target).finally(() => this.starting.delete(target));
    this.starting.set(target, promise);
    return promise;
  }

  private async startSignIn(target: string): Promise<RemoteHostAccessV1> {
    const existing = this.connections.get(target);
    if (existing && !existing.ending) {
      const status = await this.checkAccess(target);
      if (status.state === 'verified' || status.state === 'signing-in') return status;
      await this.endConnection(target);
    }
    const generation = this.generations.get(target) ?? 0;
    const runtime = this.options.runtime ?? (await resolveRemoteHostRuntime(this.options.sshPath));
    const sshPath = runtime.sshPath;
    const root = await runtime.createRoot('df-host-');
    this.privateRoots.set(root, runtime);
    if (this.stopping || generation !== (this.generations.get(target) ?? 0)) {
      await runtime.write(join(root, 'cancelled'), '', 0o600);
      return this.status(target);
    }
    const connection: HostConnection = {
      target,
      sshPath,
      runtime,
      root,
      terminalStartDeadline: Date.now() + 30_000,
      terminalWindowsProcessId: null,
      controlPath: join(root, 'control'),
      consumers: 0,
      ending: false,
      timer: null,
    };
    this.connections.set(target, connection);
    const scriptPath = join(root, 'Sign in.command');
    const args = buildManagedSshLoginArgs(target, connection.controlPath);
    const script = `#!/bin/sh\numask 077\n[ ! -e ${quoteShell(join(root, 'cancelled'))} ] || exit 0\nprintf '%s\\n' ${quoteShell(`DNAForge: sign in to ${target} using your institution's normal procedure.`)} ${quoteShell('After login, return to Remote hosts and check access. You can use this shell normally.')}\n${[sshPath, ...args].map(quoteShell).join(' ')} < /dev/tty &\nchild=$!\nprintf '%s' "$child" > ${quoteShell(join(root, 'login.pid'))}\nif [ -e ${quoteShell(join(root, 'cancelled'))} ]; then kill "$child" 2>/dev/null; fi\nwait "$child"\nresult=$?\nprintf '%s' "$result" > ${quoteShell(join(root, 'login.result'))}\nif [ -e ${quoteShell(join(root, 'cancelled'))} ]; then ${[sshPath, '-S', sshControlPathArgument(connection.controlPath), '-O', 'exit', target].map(quoteShell).join(' ')} 2>/dev/null; fi\nprintf '\\n%s\\n' 'Terminal session ended. Return to DNAForge to check access or sign in again.'\n`;
    await runtime.write(scriptPath, script, 0o700);
    this.observe(connection, { state: 'signing-in', checkedAt: null, lastFailure: null });
    try {
      const acknowledgement = await (
        this.options.launchTerminal ?? runtime.launchTerminal.bind(runtime)
      )(scriptPath);
      if (typeof acknowledgement === 'number')
        connection.terminalWindowsProcessId = acknowledgement;
      if (connection.ending || this.connections.get(target) !== connection)
        return this.status(target);
      if (
        process.env.DNAFORGE_NATIVE_FIXTURE_EPHEMERAL === '1' &&
        process.env.WAYPOINT_TEST === '1' &&
        !RELEASE_BUILD_IDENTITY.isReleaseBuild
      ) {
        console.info(
          '[remote-hosts-native-qualification] ' +
            JSON.stringify({
              target,
              scriptPath,
              windowsProcessId: connection.terminalWindowsProcessId,
            })
        );
      }
      const deadline = Date.now() + 10 * 60_000;
      connection.timer = setInterval(() => {
        if (connection.ending || this.connections.get(target) !== connection) return;
        if (Date.now() > deadline) {
          this.clearTimer(connection);
          this.observe(connection, {
            state: 'needs-authentication',
            checkedAt: Date.now(),
            lastFailure: {
              code: 'connection-timeout',
              message: userMessage('remote.terminalLoginUnverified'),
            },
          });
          return;
        }
        void this.checkAccess(target).catch(() => undefined);
      }, 1_500);
      connection.timer.unref?.();
      return this.status(target);
    } catch (error) {
      const launchError = error as NodeJS.ErrnoException & {
        signal?: string;
        killed?: boolean;
      };
      console.warn('[remote-hosts] Terminal launch failed', {
        platform: process.platform,
        code: typeof launchError?.code === 'string' ? launchError.code : null,
        signal: typeof launchError?.signal === 'string' ? launchError.signal : null,
        killed: launchError?.killed === true,
        reason:
          launchError?.message === 'Windows did not acknowledge its native terminal process.'
            ? 'unacknowledged-console'
            : 'launcher-failed',
      });
      await this.endConnection(target);
      throw new RemoteGenomicsError(
        'helper-failed',
        'Terminal could not be opened. Check that a supported terminal is installed, then try again.'
      );
    }
  }

  checkAccess(input: string): Promise<RemoteHostAccessV1> {
    const target = targetText(input);
    const pending = this.checking.get(target);
    if (pending) return pending;
    const promise = this.check(target).finally(() => this.checking.delete(target));
    this.checking.set(target, promise);
    return promise;
  }

  private async check(target: string): Promise<RemoteHostAccessV1> {
    const generation = this.generations.get(target) ?? 0;
    let connection = this.connections.get(target);
    if (
      !connection &&
      this.options.allowExternalSharing !== false &&
      process.platform !== 'win32'
    ) {
      const runtime =
        this.options.runtime ?? (await resolveRemoteHostRuntime(this.options.sshPath));
      const sshPath = runtime.sshPath;
      const path = await resolveSystemSshControlPath(sshPath, target);
      if (path && (await runtime.isSocket(path))) {
        if (this.stopping || generation !== (this.generations.get(target) ?? 0))
          return this.status(target);
        connection = {
          target,
          sshPath,
          runtime,
          controlPath: path,
          root: null,
          terminalStartDeadline: null,
          terminalWindowsProcessId: null,
          consumers: 0,
          ending: false,
          timer: null,
        };
        this.connections.set(target, connection);
      }
    }
    if (!connection || connection.ending) {
      const status: RemoteHostAccessV1 = {
        target,
        state: 'needs-authentication',
        checkedAt: null,
        connection: 'none',
        activeConsumers: 0,
        lastFailure: {
          code: 'authentication-required',
          message: userMessage('remote.signInToEstablish'),
        },
      };
      this.observations.set(target, status);
      return status;
    }
    const current = connection;
    let masterAlive = false;
    try {
      await current.runtime.runSsh(
        ['-S', sshControlPathArgument(current.controlPath), '-O', 'check', target],
        2_000
      );
      masterAlive = true;
      const output = await current.runtime.runSsh([
        ...buildExistingSshArgs(target, current.controlPath).slice(0, -1),
        '-T',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'RemoteCommand=none',
        target,
        `printf '${ACCESS_RECEIPT}\\n'`,
      ]);
      if (!output.split(/\r?\n/u).includes(ACCESS_RECEIPT)) throw new Error('No remote receipt');
      if (this.connections.get(target) !== current || current.ending) return this.status(target);
      this.clearTimer(current);
      return this.observe(current, { state: 'verified', checkedAt: Date.now(), lastFailure: null });
    } catch {
      if (this.connections.get(target) !== current || current.ending) return this.status(target);
      const pending =
        current.root &&
        this.status(target).state === 'signing-in' &&
        !(await current.runtime.read(join(current.root, 'login.result')).then(
          () => true,
          () => false
        ));
      if (pending && current.root !== null) {
        if (current.terminalStartDeadline !== null && Date.now() > current.terminalStartDeadline) {
          const started = await current.runtime.read(join(current.root, 'login.pid')).then(
            (value) => Number.isSafeInteger(Number(value)) && Number(value) > 1,
            () => false
          );
          if (this.connections.get(target) !== current || current.ending)
            return this.status(target);
          if (!started) {
            this.clearTimer(current);
            return this.observe(current, {
              state: 'needs-authentication',
              checkedAt: Date.now(),
              lastFailure: {
                code: 'helper-failed',
                message: userMessage('remote.terminalLoginNotStarted'),
              },
            });
          }
        }
        return this.status(target);
      }
      this.clearTimer(current);
      return this.observe(current, {
        state: masterAlive ? 'unavailable' : 'needs-authentication',
        checkedAt: Date.now(),
        lastFailure: masterAlive
          ? {
              code: 'helper-failed',
              message: userMessage('remote.remoteCommandFailed'),
            }
          : {
              code: 'authentication-required',
              message: userMessage('remote.accessUnverified'),
            },
      });
    }
  }

  async retainConnection(input: string): Promise<RemoteSshConnectionLease | null> {
    const target = targetText(input);
    const connection = this.connections.get(target);
    if (!connection) return null;
    if (connection.ending || this.status(target).state !== 'verified')
      throw new RemoteGenomicsError(
        'authentication-required',
        'Open Remote hosts, complete your institution’s login in Terminal and check access before choosing files.'
      );
    connection.consumers += 1;
    let released = false;
    return {
      target,
      controlPath: connection.controlPath,
      sshCommand: connection.runtime.sshCommand,
      existingOnly: true,
      release: async () => {
        if (!released) {
          released = true;
          connection.consumers -= 1;
        }
      },
    };
  }

  async openTerminal(input: string): Promise<void> {
    const target = targetText(input);
    const access = await this.checkAccess(target);
    const connection = this.connections.get(target);
    if (!connection || connection.ending || access.state !== 'verified') {
      await this.signIn(target);
      return;
    }
    const runtime = connection.runtime;
    const root = connection.root ?? (await runtime.createRoot('df-shell-'));
    this.privateRoots.set(root, runtime);
    const scriptPath = join(root, `Shell-${Date.now()}.command`);
    await runtime.write(
      scriptPath,
      `#!/bin/sh\nexec ${[connection.sshPath, ...buildExistingSshArgs(target, connection.controlPath)].map(quoteShell).join(' ')}\n`,
      0o700
    );
    await (this.options.launchTerminal ?? runtime.launchTerminal.bind(runtime))(scriptPath);
  }

  async endConnection(input: string, force = false): Promise<RemoteHostAccessV1> {
    const target = targetText(input);
    const connection = this.connections.get(target);
    if (connection?.consumers && !force)
      throw new RemoteGenomicsError(
        'invalid-request',
        'Close file browsers and remove active remote tracks before ending this DNAForge connection.'
      );
    this.generations.set(target, (this.generations.get(target) ?? 0) + 1);
    if (connection) {
      connection.ending = true;
      this.clearTimer(connection);
      if (connection.root) {
        await connection.runtime.write(join(connection.root, 'cancelled'), '', 0o600);
        const pid = Number(
          await connection.runtime.read(join(connection.root, 'login.pid')).catch(() => '0')
        );
        await connection.runtime.terminateLogin(pid, connection.controlPath);
        await connection.runtime
          .runSsh(
            ['-S', sshControlPathArgument(connection.controlPath), '-O', 'exit', target],
            2_000
          )
          .catch(() => undefined);
      }
      this.connections.delete(target);
    }
    const status: RemoteHostAccessV1 = {
      target,
      state: 'not-checked',
      checkedAt: null,
      connection: 'none',
      activeConsumers: 0,
      lastFailure: null,
    };
    this.observations.set(target, status);
    return status;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.connections.keys()].map((t) => this.endConnection(t, true)));
    await Promise.allSettled(
      [...this.privateRoots].map(([root, runtime]) => runtime.removeRoot(root))
    );
    this.privateRoots.clear();
  }

  private observe(
    connection: HostConnection,
    observation: Pick<RemoteHostAccessV1, 'state' | 'checkedAt' | 'lastFailure'>
  ): RemoteHostAccessV1 {
    const status: RemoteHostAccessV1 = {
      target: connection.target,
      connection: connection.root ? 'dnaforge' : 'external',
      activeConsumers: connection.consumers,
      ...observation,
    };
    this.observations.set(connection.target, status);
    return status;
  }
  private clearTimer(connection: HostConnection): void {
    if (connection.timer) clearInterval(connection.timer);
    connection.timer = null;
  }
}

export const remoteHostService = new RemoteHostService();
