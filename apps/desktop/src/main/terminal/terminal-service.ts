import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute } from 'node:path';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminalType } from '@xterm/headless';
const HeadlessTerminal = headless.Terminal;
import { Unicode11Addon, SerializeAddon, type HeadlessSerializeAddon } from './headless-addons';
import { spawn as spawnPty } from 'node-pty';
import type {
  TerminalAttachment,
  TerminalCreateRequest,
  TerminalEvent,
  TerminalFixedDimensions,
  TerminalHistoryData,
  TerminalCommand,
  TerminalProfile,
  TerminalSession,
} from '../../shared/terminal-ipc';
import { validateTerminalProfileConfiguration } from './profile-configuration';
import type { TerminalProfilesConfiguration } from '../../shared/terminal-ipc';
import { detectTerminalProfiles, prepareTerminalShell } from './shell-launch';
import type { TerminalHistoryProvider } from './history';
import { TerminalCommandRanges, offsetTerminalCommandRange } from './command-ranges';
import {
  parseTerminalRuntimePolicy,
  terminalEmulation,
  type TerminalRuntimePolicy,
} from '../../shared/terminal-runtime-policy';
import { terminalParentEnvironment } from './runtime-policy';
import { completionInput, completionSuffix, suggestTerminalCompletions } from './completion';
import type { TerminalCompletionResult } from '../../shared/terminal-completion';
import { terminalOccupiedPorts, type TerminalPortRelease } from '../../shared/terminal-quick-fix';
import { inspectTerminalPort, ownedForegroundListener } from './port-owner';
import { TerminalPromptResize } from '../../shared/terminal-prompt-resize';
import { observeTerminalColorSchemeMode } from '../../shared/terminal-color-scheme';

interface PtyProcess {
  pid: number;
  readonly process?: string;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface ManagedSession {
  owner: number;
  state: TerminalSession;
  pty: PtyProcess | null;
  profile: TerminalProfile;
  environment: Record<string, string>;
  screen: HeadlessTerminalType;
  serialize: HeadlessSerializeAddon;
  commandRanges: TerminalCommandRanges;
  promptResize: TerminalPromptResize;
  commandsDirty: boolean;
  inputRevision: number;
  sequence: number;
  attachmentId: string | null;
  retiredAttachments: Map<string, number>;
  outstanding: Array<{ sequence: number; length: number }>;
  parsing: number;
  paused: boolean;
  closed: boolean;
  renamed: boolean;
  nativeExit: Promise<void>;
  cleanup(): Promise<void>;
  disposables: Array<{ dispose(): void }>;
}

type TerminalOwnerLifetime = { phase: 'active' | 'retired' };

interface CompletionRequest {
  owner: number;
  requestId: string;
  session: ManagedSession;
  controller: AbortController;
  input: string;
  cwd: string;
  generation: number;
  revision: number;
  sequence: number;
  insertions: Map<string, string>;
}

interface PortReleaseRequest {
  owner: number;
  origin: ManagedSession;
  originCommand: string;
  originRevision: number;
  target: ManagedSession;
  targetCommand: string;
  targetRevision: number;
  signature: string;
  port: number;
  expires: number;
}

export interface SavedTerminalSession {
  session: TerminalSession;
  profile: TerminalProfile;
  renamed: boolean;
  replay: string;
  windowGroup?: string;
}

const HIGH_WATER = 100_000;
const LOW_WATER = 10_000;
const MAX_SESSIONS = 64;

function dimensions(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    rows < 1 ||
    cols > 1000 ||
    rows > 1000
  ) {
    throw new Error('Invalid terminal dimensions (2–1000 columns, 1–1000 rows).');
  }
}

function decodeIntegration(value: string): string {
  return value.replace(/\\x([\da-f]{2})|\\\\/gi, (_match, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : '\\'
  );
}

function automaticTitle(state: TerminalSession): string {
  const directory = state.cwd === state.userHome ? '~' : basename(state.cwd) || state.cwd;
  const current = state.shellState === 'command' ? state.commands.at(-1) : undefined;
  const word =
    current?.finishedAt === null
      ? current.command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|&<>()]+))/)
      : null;
  const executable = word?.[1] ?? word?.[2] ?? word?.[3];

  const program = executable && !executable.includes('=') ? basename(executable) : '';
  return (program ? `${program} · ${directory}` : directory).replace(/\p{Cc}/gu, '').slice(0, 128);
}

function snapshot(session: ManagedSession): TerminalSession {
  return {
    ...session.state,
    bufferBaseY: session.screen.buffer.normal.baseY,
    promptStart: session.promptResize.position(),
    fixedDimensions: session.state.fixedDimensions
      ? { ...session.state.fixedDimensions }
      : undefined,
    alternateScreen: session.screen.buffer.active.type === 'alternate',
    commands: session.state.commands.map((command) => ({
      ...command,
      range: command.id ? session.commandRanges.range(command.id) : undefined,
    })),
  };
}

export class TerminalService {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingStops = new Set<Promise<void>>();
  private readonly ownerLifetimes = new Map<number, TerminalOwnerLifetime>();
  private readonly pendingRelaunches = new Set<ManagedSession>();
  private disposed = false;
  private readonly profiles: TerminalProfile[];
  private profileConfiguration: TerminalProfilesConfiguration = { profiles: [] };
  private readonly spawn: typeof spawnPty;
  private readonly emit: (owner: number, event: TerminalEvent) => void;
  private readonly integrationRoot: string | null;
  private readonly onChanged: (owner: number) => void;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly historyProvider?: TerminalHistoryProvider;
  private readonly hostPlatform: NodeJS.Platform;
  private runtimePolicy: TerminalRuntimePolicy;
  private readonly completions = new Map<string, CompletionRequest>();
  private readonly portReleases = new Map<string, PortReleaseRequest>();

  constructor(options: {
    profiles?: TerminalProfile[];
    spawn?: (...args: Parameters<typeof spawnPty>) => PtyProcess;
    integrationRoot: string | null;
    emit(owner: number, event: TerminalEvent): void;
    onChanged?(owner: number): void;
    environment?: NodeJS.ProcessEnv;
    history?: TerminalHistoryProvider;
    runtimePolicy?: unknown;
    platform?: NodeJS.Platform;
  }) {
    this.profiles = options.profiles ?? detectTerminalProfiles();
    this.spawn = (options.spawn ?? spawnPty) as typeof spawnPty;
    this.emit = options.emit;
    this.integrationRoot = options.integrationRoot;
    this.onChanged = options.onChanged ?? (() => undefined);
    this.environment = options.environment ?? process.env;
    this.historyProvider = options.history;
    this.hostPlatform = options.platform ?? process.platform;
    this.runtimePolicy = parseTerminalRuntimePolicy(options.runtimePolicy ?? {});
  }

  configureRuntimePolicy(value: unknown): void {
    this.runtimePolicy = parseTerminalRuntimePolicy(value);
  }

  getProfiles(): TerminalProfile[] {
    return [...this.profiles, ...this.profileConfiguration.profiles].map((profile) => ({
      ...profile,
      args: [...profile.args],
    }));
  }

  getProfileConfiguration(): TerminalProfilesConfiguration {
    return validateTerminalProfileConfiguration(this.profileConfiguration);
  }

  configureProfiles(value: unknown): void {
    const configuration = validateTerminalProfileConfiguration(value);
    if (
      configuration.profiles.some((profile) =>
        this.profiles.some((detected) => detected.id === profile.id)
      )
    ) {
      throw new Error('A configured profile cannot replace a detected profile identity.');
    }
    if (
      configuration.defaultProfileId &&
      ![...this.profiles, ...configuration.profiles].some(
        (profile) => profile.id === configuration.defaultProfileId
      )
    ) {
      throw new Error('The default terminal profile is unavailable.');
    }
    this.profileConfiguration = configuration;
  }

  list(owner: number): TerminalSession[] {
    return [...this.sessions.values()].filter((session) => session.owner === owner).map(snapshot);
  }

  async history(owner: number, id: string): Promise<TerminalHistoryData> {
    const session = this.owned(owner, id);
    return this.historyProvider
      ? this.historyProvider.read(session.profile.path, session.environment, session.state.cwd)
      : { previousCommands: [], directories: [], shellCommands: [] };
  }

  async commandOutput(owner: number, id: string, commandId: string): Promise<string | undefined> {
    await this.flush(owner, id);
    const session = this.owned(owner, id);
    if (!session.state.commands.some((command) => command.id === commandId)) return undefined;
    return session.commandRanges.output(commandId);
  }

  private releaseCompletion(id: string): void {
    this.completions.get(id)?.controller.abort();
    this.completions.delete(id);
  }

  cancelCompletions(owner: number, requestId: string): void {
    for (const [id, request] of this.completions)
      if (request.owner === owner && request.requestId === requestId) this.releaseCompletion(id);
  }

  async complete(owner: number, id: string, requestId: string): Promise<TerminalCompletionResult> {
    if (typeof requestId !== 'string' || !/^[\da-f-]{36}$/i.test(requestId))
      throw new Error('Invalid completion request.');
    await this.flush(owner, id);
    const session = this.owned(owner, id);
    this.releaseCompletion(id);
    const input = session.commandRanges.input();
    let parsed = input === undefined ? undefined : completionInput(input, session.profile.path);
    const result: TerminalCompletionResult = { requestId, items: [] };
    if (
      !parsed ||
      input === undefined ||
      session.state.status !== 'running' ||
      session.state.shellState !== 'prompt'
    )
      return result;
    const request = {
      owner,
      requestId,
      session,
      controller: new AbortController(),
      input,
      cwd: session.state.cwd,
      generation: session.commandRanges.generation,
      revision: session.inputRevision,
      sequence: session.sequence,
      insertions: new Map<string, string>(),
    };
    this.completions.set(id, request);
    const timer = setTimeout(() => request.controller.abort(), parsed.powershell ? 14_000 : 4000);
    timer.unref?.();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const candidates = await suggestTerminalCompletions(
          {
            input: request.input,
            cwd: request.cwd,
            shellPath: session.profile.path,
            environment: session.environment,
          },
          request.controller.signal
        );
        await this.flush(owner, id);
        if (!this.completionCurrent(id, request)) {
          if (
            attempt === 0 &&
            this.completionPromptCurrent(id, request) &&
            session.sequence !== request.sequence
          ) {
            const refreshedInput = session.commandRanges.input();
            const refreshed =
              refreshedInput === undefined
                ? undefined
                : completionInput(refreshedInput, session.profile.path);
            if (!refreshed || refreshedInput === undefined) return result;
            parsed = refreshed;
            request.input = refreshedInput;
            request.sequence = session.sequence;
            continue;
          }
          return result;
        }
        for (const candidate of candidates) {
          const suffix = completionSuffix(parsed, candidate.value, candidate.kind === 'directory');
          if (!suffix) continue;
          const token = randomUUID();
          request.insertions.set(token, suffix);
          result.items.push({ token, label: candidate.value, kind: candidate.kind });
        }
        return result;
      }
      return result;
    } finally {
      clearTimeout(timer);
      if (request.controller.signal.aborted && this.completions.get(id) === request)
        this.releaseCompletion(id);
    }
  }

  private completionPromptCurrent(id: string, request: CompletionRequest): boolean {
    const session = this.sessions.get(id);
    return (
      this.completions.get(id) === request &&
      !request.controller.signal.aborted &&
      session === request.session &&
      session.owner === request.owner &&
      session.state.status === 'running' &&
      session.state.shellState === 'prompt' &&
      session.inputRevision === request.revision &&
      session.state.cwd === request.cwd &&
      session.commandRanges.generation === request.generation
    );
  }

  private completionCurrent(id: string, request: CompletionRequest): boolean {
    return (
      this.completionPromptCurrent(id, request) &&
      request.session.sequence === request.sequence &&
      request.session.commandRanges.input() === request.input
    );
  }

  async commitCompletion(owner: number, id: string, token: string): Promise<boolean> {
    await this.flush(owner, id);
    this.owned(owner, id);
    const request = this.completions.get(id);
    if (!request || request.owner !== owner || !this.completionCurrent(id, request)) return false;
    const suffix = request.insertions.get(token);
    if (!suffix) return false;
    this.releaseCompletion(id);
    this.paste(owner, id, suffix);
    return true;
  }

  async preparePortRelease(
    owner: number,
    id: string,
    commandId: string,
    port: number
  ): Promise<TerminalPortRelease> {
    const output = await this.commandOutput(owner, id, commandId);
    const origin = this.owned(owner, id);
    const failed = origin.state.commands.at(-1);
    if (
      !failed ||
      failed.id !== commandId ||
      failed.finishedAt === null ||
      failed.exitCode === null ||
      failed.exitCode === 0 ||
      output === undefined ||
      !terminalOccupiedPorts(output).includes(port)
    )
      throw new Error('The selected failed command no longer identifies this occupied port.');
    const originRevision = origin.inputRevision;
    const snapshot = await inspectTerminalPort(port);
    if (
      this.owned(owner, id) !== origin ||
      origin.inputRevision !== originRevision ||
      origin.state.commands.at(-1)?.id !== commandId
    )
      throw new Error('The terminal changed. Select the failed command again.');
    for (const target of this.sessions.values()) {
      const command = target.state.commands.at(-1);
      if (
        target.owner !== owner ||
        target.state.status !== 'running' ||
        target.state.shellState !== 'command' ||
        !command?.id ||
        command.finishedAt !== null
      )
        continue;
      const program = completionInput(command.command, target.profile.path)?.words[0] ?? '';
      const signature = ownedForegroundListener(
        snapshot,
        target.state.pid,
        program,
        this.hostPlatform === 'win32'
      );
      if (!signature) continue;
      for (const [token, request] of this.portReleases)
        if (request.expires < Date.now()) this.portReleases.delete(token);
      while (this.portReleases.size >= 64)
        this.portReleases.delete(this.portReleases.keys().next().value!);
      const token = randomUUID();
      this.portReleases.set(token, {
        owner,
        origin,
        originCommand: commandId,
        originRevision,
        target,
        targetCommand: command.id,
        targetRevision: target.inputRevision,
        signature,
        port,
        expires: Date.now() + 30_000,
      });
      return { token, port, terminalTitle: target.state.title };
    }
    throw new Error(
      'This port is not held by a foreground program in a terminal owned by this window.'
    );
  }

  async releasePort(owner: number, id: string, token: string): Promise<void> {
    this.owned(owner, id);
    const request = this.portReleases.get(token);
    if (!request || request.owner !== owner || request.origin.state.id !== id)
      throw new Error('This port action is not owned by this terminal.');
    this.portReleases.delete(token);
    const current = () =>
      request &&
      request.owner === owner &&
      request.expires >= Date.now() &&
      this.sessions.get(id) === request.origin &&
      request.origin.owner === owner &&
      request.origin.inputRevision === request.originRevision &&
      request.origin.state.commands.at(-1)?.id === request.originCommand &&
      this.sessions.get(request.target.state.id) === request.target &&
      request.target.owner === owner &&
      request.target.inputRevision === request.targetRevision &&
      request.target.state.status === 'running' &&
      request.target.state.shellState === 'command' &&
      request.target.state.commands.at(-1)?.id === request.targetCommand &&
      request.target.state.commands.at(-1)?.finishedAt === null;
    if (!request || !current())
      throw new Error('The port owner changed. Select the failed command again.');
    const snapshot = await inspectTerminalPort(request.port);
    const program =
      completionInput(request.target.state.commands.at(-1)!.command, request.target.profile.path)
        ?.words[0] ?? '';
    if (
      !current() ||
      ownedForegroundListener(
        snapshot,
        request.target.state.pid,
        program,
        this.hostPlatform === 'win32'
      ) !== request.signature
    )
      throw new Error('The native listener changed. No program was interrupted.');

    this.write(owner, request.target.state.id, '\x03');
  }

  private rememberHistory(session: ManagedSession, command?: TerminalCommand): void {
    try {
      if (command) this.historyProvider?.recordCommand(session.profile.path, command);
      else this.historyProvider?.recordDirectory(session.state.cwd);
    } catch {
      console.warn('[terminal] History could not be saved.');
    }
  }

  private owned(owner: number, id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner)
      throw new Error('Terminal is not owned by this window.');
    return session;
  }

  assertOwner(owner: number, id: string): void {
    this.owned(owner, id);
  }

  closeStatus(owner: number, id: string): { requiresConfirmation: boolean } {
    const session = this.owned(owner, id);
    const foreground = session.pty?.process;
    const shellName = (path: string) =>
      basename(path)
        .toLowerCase()
        .replace(/\.exe$/, '');
    const busy =
      session.state.status === 'running' &&
      (session.state.shellState !== 'prompt' ||
        !session.state.integration ||
        Boolean(
          this.hostPlatform !== 'win32' &&
          foreground &&
          shellName(foreground) !== shellName(session.profile.path)
        ));
    return { requiresConfirmation: this.runtimePolicy.confirmBusyClose && busy };
  }

  private changed(session: ManagedSession, notifyExit = false): void {
    if (!session.closed)
      this.emit(session.owner, {
        kind: 'changed',
        session: snapshot(session),
        ...(notifyExit ? { notifyExit: true } : {}),
      });
    this.onChanged(session.owner);
  }

  private flow(session: ManagedSession): void {
    if (session.closed || session.state.status !== 'running' || !session.pty) return;
    const pending =
      session.parsing + session.outstanding.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!session.paused && pending >= HIGH_WATER) {
      session.pty.pause();
      session.paused = true;
    } else if (session.paused && pending <= LOW_WATER) {
      session.pty.resume();
      session.paused = false;
    }
  }

  async create(owner: number, request: TerminalCreateRequest): Promise<TerminalSession> {
    return this.launch(owner, request);
  }

  private async launch(
    owner: number,
    request: TerminalCreateRequest,
    saved?: SavedTerminalSession,
    failure?: string,
    replacingId?: string,
    originalProfile?: TerminalProfile
  ): Promise<TerminalSession> {
    if (this.disposed) throw new Error('Terminal service is shutting down.');
    const lifetime = this.ownerLifetimes.get(owner) ?? { phase: 'active' as const };
    this.ownerLifetimes.set(owner, lifetime);
    const replacing = replacingId ? this.owned(owner, replacingId) : null;
    const assertLaunchCurrent = () => {
      if (this.disposed) throw new Error('Terminal service is shutting down.');
      if (lifetime.phase !== 'active' || this.ownerLifetimes.get(owner) !== lifetime)
        throw new Error('The terminal window has closed.');
      if (
        replacing &&
        (replacing.closed ||
          replacing.owner !== owner ||
          this.sessions.get(replacingId!) !== replacing)
      )
        throw new Error('The terminal being relaunched has closed or moved to another window.');
    };
    assertLaunchCurrent();
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Invalid terminal request.');
    if (this.sessions.size >= MAX_SESSIONS && !replacingId)
      throw new Error('Close a terminal before creating more.');
    const cols = request.cols ?? 80;
    const rows = request.rows ?? 24;
    dimensions(cols, rows);
    const cwd = request.cwd ?? homedir();
    const revive =
      !saved ||
      (this.runtimePolicy.reviveSessions && saved.session.status === 'running' && !failure);
    if (
      typeof cwd !== 'string' ||
      !isAbsolute(cwd) ||
      (revive && !(await stat(cwd)).isDirectory())
    ) {
      throw new Error('Terminal working directory must be an existing absolute directory.');
    }
    assertLaunchCurrent();
    const selectedProfile = request.profileId ?? this.profileConfiguration.defaultProfileId;
    const profiles = this.getProfiles();
    const profile =
      originalProfile ??
      saved?.profile ??
      (selectedProfile ? profiles.find((item) => item.id === selectedProfile) : profiles[0]);
    if (!profile) throw new Error('Terminal shell profile is unavailable.');
    const launch = await prepareTerminalShell(
      profile,
      this.integrationRoot,
      terminalParentEnvironment(this.environment, this.runtimePolicy)
    );

    try {
      assertLaunchCurrent();
    } catch (error) {
      await launch.cleanup();
      throw error;
    }
    const emulation =
      saved?.session.emulation ??
      (saved
        ? { unicodeVersion: '11' as const, tabStopWidth: 8 }
        : terminalEmulation(this.runtimePolicy));
    const screen = new HeadlessTerminal({
      cols,
      rows,
      scrollback: 10_000,
      allowProposedApi: true,
      reflowCursorLine: false,
      tabStopWidth: emulation.tabStopWidth,
    });
    screen.loadAddon(new Unicode11Addon());
    screen.unicode.activeVersion = emulation.unicodeVersion;
    const serialize = new SerializeAddon();
    screen.loadAddon(serialize);
    const promptResize = new TerminalPromptResize(screen, profile.path);
    let commandRanges = new TerminalCommandRanges(screen);
    if (saved) {
      await new Promise<void>((resolve) => screen.write(saved.replay, resolve));
      commandRanges = new TerminalCommandRanges(screen, saved.session.commands);
      if (revive || failure)
        await new Promise<void>((resolve) =>
          screen.write(
            `\x1b[0m\r\n[${failure ? 'Shell could not be restored. Use Relaunch to retry.' : 'Session restored; a new shell is starting.'}]\r\n`,
            resolve
          )
        );
    }
    let pty: PtyProcess | null = null;
    try {
      assertLaunchCurrent();
      if (revive)
        pty = this.spawn(profile.path, launch.args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: launch.env,

          ...(this.hostPlatform === 'win32' ? { useConptyDll: true } : {}),
        });
    } catch (error) {
      await launch.cleanup();
      promptResize.dispose();
      screen.dispose();
      throw error;
    }
    let resolveNativeExit: () => void = () => undefined;
    const nativeExit = pty
      ? new Promise<void>((resolve) => {
          resolveNativeExit = resolve;
        })
      : Promise.resolve();
    let cleanupResult: Promise<void> | undefined;
    const session: ManagedSession = {
      owner,
      pty,
      profile: {
        ...profile,
        args: [...profile.args],
        env: profile.env ? { ...profile.env } : undefined,
      },
      environment: launch.originalEnvironment,
      screen,
      serialize,
      commandRanges,
      promptResize,
      inputRevision: 0,
      commandsDirty: false,
      sequence: 0,
      attachmentId: null,
      retiredAttachments: new Map(),
      outstanding: [],
      parsing: 0,
      paused: false,
      closed: false,
      renamed: saved?.renamed ?? false,
      nativeExit,
      cleanup: () => (cleanupResult ??= Promise.resolve().then(launch.cleanup)),
      disposables: [promptResize],
      state: {
        id: saved?.session.id ?? randomUUID(),
        pid: pty?.pid ?? 0,
        profileId: profile.id,
        shellPath: profile.path,
        emulation,
        userHome: homedir(),
        title: saved?.session.title ?? profile.name,
        cwd,
        cols,
        rows,
        status: pty ? 'running' : 'exited',
        exitCode: pty ? null : (saved?.session.exitCode ?? null),
        integration: false,
        alternateScreen: false,
        shellState: 'starting',
        commands:
          saved?.session.commands.map((command) => ({
            ...command,
            finishedAt: command.finishedAt ?? Date.now(),
          })) ?? [],
        fixedDimensions: saved?.session.fixedDimensions
          ? { ...saved.session.fixedDimensions }
          : undefined,
        ...(failure ? { revivalError: failure } : {}),
      },
    };
    if (!session.renamed) session.state.title = automaticTitle(session.state);
    this.sessions.set(session.state.id, session);
    session.disposables.push(
      observeTerminalColorSchemeMode(screen.parser, (enabled) => {
        session.state.colorSchemeReports = enabled;
        this.changed(session);
      })
    );
    session.disposables.push(
      screen.onTitleChange((title) => {
        if (
          !session.renamed &&
          title &&
          (!session.state.integration ||
            (session.state.shellState === 'command' &&
              session.state.commands.at(-1)?.finishedAt === null))
        ) {
          session.state.title = title.replace(/\p{Cc}/gu, '').slice(0, 128);
          this.changed(session);
        }
      })
    );
    session.disposables.push(
      screen.parser.registerOscHandler(633, (data) => {
        const [operation, ...parts] = data.split(';');
        session.state.integration = true;
        if (operation === 'A') session.commandRanges.prompt();
        if (operation === 'B') {
          session.state.shellState = 'prompt';
          session.commandRanges.promptEnd();
        }
        if (operation === 'C') session.state.shellState = 'command';
        if (operation === 'P' && parts[0]?.startsWith('Cwd=')) {
          const reported = decodeIntegration(parts.join(';').slice(4));
          if (isAbsolute(reported) && !reported.includes('\0')) {
            session.state.cwd = reported;
            this.rememberHistory(session);
          }
        } else if (operation === 'E' && parts.at(-1) === launch.nonce) {
          session.commandsDirty = true;
          session.state.commands.push({
            id: randomUUID(),
            command: decodeIntegration(parts.slice(0, -1).join(';')).slice(0, 8192),
            cwd: session.state.cwd,
            exitCode: null,
            startedAt: Date.now(),
            finishedAt: null,
          });
          session.state.commands = session.state.commands.slice(-100);
          const commandId = session.state.commands.at(-1)?.id;
          if (commandId) session.commandRanges.start(commandId);
          session.commandRanges.retain(session.state.commands.map((command) => command.id));
          this.rememberHistory(session, session.state.commands.at(-1));
        } else if (operation === 'D') {
          const command = session.state.commands.at(-1);
          if (command && command.finishedAt === null) {
            session.commandsDirty = true;
            command.exitCode = parts[0] && /^\d+$/.test(parts[0]) ? Number(parts[0]) : null;
            command.finishedAt = Date.now();
            if (command.id) session.commandRanges.finish(command.id);
          }
        }
        if (!session.renamed) session.state.title = automaticTitle(session.state);
        this.changed(session);
        return false;
      })
    );
    if (pty)
      session.disposables.push(
        pty.onData((data) => {
          if (session.closed) return;
          session.parsing += data.length;
          this.flow(session);
          screen.write(data, () => {
            if (session.closed) return;
            promptResize.revealPrompt(profile.path);
            session.parsing -= data.length;
            session.sequence += 1;
            const commandState = session.commandsDirty
              ? { commands: snapshot(session).commands, bufferBaseY: screen.buffer.normal.baseY }
              : undefined;
            session.commandsDirty = false;
            if (session.attachmentId) {
              session.outstanding.push({ sequence: session.sequence, length: data.length });
              this.emit(session.owner, {
                kind: 'data',
                id: session.state.id,
                attachmentId: session.attachmentId,
                sequence: session.sequence,
                data,
                ...(commandState ? { commandState } : {}),
              });
            }
            this.flow(session);
            this.onChanged(session.owner);
          });
        })
      );
    if (pty) {
      const exitSubscription = pty.onExit(({ exitCode }) => {
        resolveNativeExit();
        if (session.closed || session.state.status === 'exited') return;
        session.state.status = 'exited';
        session.state.exitCode = exitCode;
        this.changed(session, this.runtimePolicy.notifyNonzeroExit && exitCode !== 0);
        void session
          .cleanup()
          .catch((error: unknown) => console.error('[terminal] shell cleanup failed', error));
      });
      void nativeExit
        .then(() => exitSubscription.dispose())
        .catch((error: unknown) => {
          console.error('[terminal] exit subscription cleanup failed', error);
        });
    }
    this.onChanged(owner);
    return snapshot(session);
  }

  async captureSessions(owner: number): Promise<SavedTerminalSession[]> {
    await Promise.all(this.list(owner).map((session) => this.flush(owner, session.id)));
    this.historyProvider?.flush?.();
    const budget = Math.min(2_000_000, Math.floor(24_000_000 / Math.max(1, this.sessions.size)));
    return [...this.sessions.values()]
      .filter((session) => session.owner === owner)
      .map((session) => {
        let replay = '';
        let firstLine = 0;
        for (const scrollback of [10_000, 1000, 100, 0]) {
          firstLine = Math.max(0, session.screen.buffer.normal.baseY - scrollback);
          replay = session.serialize.serialize({
            scrollback,
            excludeAltBuffer: true,
            excludeModes: true,
          });
          if (Buffer.byteLength(replay, 'utf8') <= budget) break;
        }
        const savedSession = snapshot(session);
        savedSession.commands = savedSession.commands.map((command) => ({
          ...command,
          range: offsetTerminalCommandRange(command.range, firstLine),
        }));
        return {
          session: savedSession,
          profile: session.profile,
          renamed: session.renamed,
          replay,
        };
      });
  }

  async restoreSessions(owner: number, saved: SavedTerminalSession[]): Promise<void> {
    for (const entry of saved) {
      if (this.sessions.has(entry.session.id)) continue;
      const request = {
        cwd: entry.session.cwd,
        cols: entry.session.cols,
        rows: entry.session.rows,
      };
      try {
        await this.launch(owner, request, entry);
      } catch (error) {
        await this.launch(
          owner,
          request,
          entry,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  async relaunch(
    owner: number,
    id: string,
    request: TerminalCreateRequest = {}
  ): Promise<TerminalSession> {
    const previous = this.owned(owner, id);
    if (this.pendingRelaunches.has(previous))
      throw new Error('This terminal is already relaunching.');
    this.pendingRelaunches.add(previous);
    try {
      const replacement = await this.launch(
        owner,
        {
          cwd: previous.state.cwd,
          profileId: previous.state.profileId,
          cols: previous.state.cols,
          rows: previous.state.rows,
          ...request,
        },
        undefined,
        undefined,
        id,
        previous.profile
      );
      if (previous.renamed) this.rename(owner, replacement.id, previous.state.title);
      if (previous.state.fixedDimensions)
        this.setFixedDimensions(owner, replacement.id, previous.state.fixedDimensions);

      this.stopSession(previous);
      this.onChanged(owner);
      return snapshot(this.owned(owner, replacement.id));
    } finally {
      this.pendingRelaunches.delete(previous);
    }
  }

  transferSessions(owner: number, target: number, ids: string[], groupId?: string): void {
    if (
      !Number.isSafeInteger(target) ||
      target <= 0 ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > MAX_SESSIONS ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Invalid terminal transfer.');
    const sessions = ids.map((id) => this.owned(owner, id));
    if (target === owner) return;
    for (const session of sessions) {
      if (session.attachmentId) {
        session.retiredAttachments.set(session.attachmentId, owner);
        if (session.retiredAttachments.size > 8)
          session.retiredAttachments.delete(session.retiredAttachments.keys().next().value!);
        this.detach(owner, session.state.id, session.attachmentId);
      }
      session.owner = target;
      this.releaseCompletion(session.state.id);
    }
    this.emit(owner, { kind: 'removed', ids: [...ids] });
    this.emit(target, { kind: 'added', sessions: sessions.map(snapshot), groupId });
    this.onChanged(owner);
    this.onChanged(target);
  }

  async flush(owner: number, id: string): Promise<void> {
    const session = this.owned(owner, id);
    await new Promise<void>((resolve) => session.screen.write('', resolve));
  }

  async clear(owner: number, id: string): Promise<void> {
    await this.flush(owner, id);
    const session = this.owned(owner, id);
    session.commandRanges.clear();
    this.releaseCompletion(id);
    session.screen.clear();
    session.sequence += 1;
    if (session.attachmentId)
      this.emit(owner, {
        kind: 'clear',
        id,
        attachmentId: session.attachmentId,
        sequence: session.sequence,
      });
    this.changed(session);
  }

  async attach(owner: number, id: string): Promise<TerminalAttachment> {
    await this.flush(owner, id);
    const session = this.owned(owner, id);
    session.attachmentId = randomUUID();
    session.outstanding = [];
    const result = {
      session: snapshot(session),
      attachmentId: session.attachmentId,
      sequence: session.sequence,
      replay: session.serialize.serialize({ scrollback: 10_000 }),
    };
    this.flow(session);
    return result;
  }

  detach(owner: number, id: string, attachmentId: string): void {
    if (this.sessions.get(id)?.retiredAttachments.get(attachmentId) === owner) return;
    const session = this.owned(owner, id);
    if (session.attachmentId !== attachmentId) return;
    session.attachmentId = null;
    session.outstanding = [];
    this.flow(session);
  }

  detachOwner(owner: number): void {
    for (const session of this.sessions.values())
      if (session.owner === owner && session.attachmentId) {
        this.releaseCompletion(session.state.id);
        this.detach(owner, session.state.id, session.attachmentId);
      }
  }

  acknowledge(owner: number, id: string, attachmentId: string, sequence: number): void {
    if (this.sessions.get(id)?.retiredAttachments.get(attachmentId) === owner) return;
    const session = this.owned(owner, id);
    if (session.attachmentId !== attachmentId) return;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > session.sequence) {
      throw new Error('Invalid terminal output acknowledgement.');
    }
    session.outstanding = session.outstanding.filter((chunk) => chunk.sequence > sequence);
    this.flow(session);
  }

  bracketedPasteMode(owner: number, id: string): boolean {
    const session = this.owned(owner, id);
    if (!session.pty || session.state.status !== 'running')
      throw new Error('Terminal has exited. Create a new terminal.');
    return session.screen.modes.bracketedPasteMode;
  }

  paste(owner: number, id: string, text: string): void {
    const bracketed = this.bracketedPasteMode(owner, id);
    if (typeof text !== 'string' || text.length > 1_000_000)
      throw new Error('Clipboard text is too large.');
    const normalized = text.replace(/\r?\n/g, '\r');
    const input = bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;
    for (let offset = 0; offset < input.length; ) {
      let end = Math.min(offset + 65_536, input.length);
      if (end < input.length && /[\uD800-\uDBFF]/.test(input[end - 1]!)) end--;
      this.write(owner, id, input.slice(offset, end));
      offset = end;
    }
  }

  write(owner: number, id: string, data: string, mode: 'text' | 'binary' = 'text'): void {
    const session = this.owned(owner, id);
    if (typeof data !== 'string' || data.length > 65_536)
      throw new Error('Invalid terminal input.');
    if (session.state.status !== 'running')
      throw new Error('Terminal has exited. Create a new terminal.');
    if (mode !== 'text' && mode !== 'binary') throw new Error('Invalid terminal input mode.');
    if (mode === 'binary' && Array.from(data).some((character) => character.charCodeAt(0) > 255)) {
      throw new Error('Binary terminal input must contain single-byte characters.');
    }
    session.inputRevision++;
    this.releaseCompletion(id);
    session.pty?.write(mode === 'binary' ? Buffer.from(data, 'binary') : data);
  }

  resize(owner: number, id: string, cols: number, rows: number): void | Promise<void> {
    const session = this.owned(owner, id);
    dimensions(cols, rows);
    cols = session.state.fixedDimensions?.cols ?? cols;
    rows = session.state.fixedDimensions?.rows ?? rows;
    if (session.state.cols === cols && session.state.rows === rows) return;
    this.releaseCompletion(id);
    const prepare =
      session.state.status === 'running'
        ? session.promptResize.prepare(cols, session.state.shellPath)
        : undefined;
    const apply = () => {
      if (session.closed || this.sessions.get(id) !== session || session.owner !== owner) return;
      cols = session.state.fixedDimensions?.cols ?? cols;
      rows = session.state.fixedDimensions?.rows ?? rows;
      session.screen.resize(cols, rows);
      session.state.cols = cols;
      session.state.rows = rows;
      if (session.state.status === 'running') session.pty?.resize(cols, rows);
      this.changed(session);
    };
    return prepare ? prepare.then(apply) : apply();
  }

  setFixedDimensions(
    owner: number,
    id: string,
    fixed: TerminalFixedDimensions
  ): void | Promise<void> {
    const session = this.owned(owner, id);
    if (
      !fixed ||
      typeof fixed !== 'object' ||
      Array.isArray(fixed) ||
      Object.keys(fixed).some((key) => key !== 'cols' && key !== 'rows') ||
      (fixed.cols !== undefined &&
        (!Number.isInteger(fixed.cols) || fixed.cols < 2 || fixed.cols > 1000)) ||
      (fixed.rows !== undefined &&
        (!Number.isInteger(fixed.rows) || fixed.rows < 1 || fixed.rows > 1000))
    )
      throw new Error('Invalid fixed terminal dimensions.');
    const cols = fixed.cols ?? session.state.cols;
    const rows = fixed.rows ?? session.state.rows;
    const changedSize = cols !== session.state.cols || rows !== session.state.rows;
    session.state.fixedDimensions =
      fixed.cols !== undefined || fixed.rows !== undefined ? { ...fixed } : undefined;
    const resize = this.resize(owner, id, cols, rows);
    const changed = () => {
      if (!changedSize && !session.closed) this.changed(session);
    };
    if (resize) return resize.then(changed);
    changed();
  }

  rename(owner: number, id: string, title: string | null): void {
    const session = this.owned(owner, id);
    if (title === null) {
      session.renamed = false;
      session.state.title = automaticTitle(session.state);
      this.changed(session);
      return;
    }
    if (typeof title !== 'string' || !title.trim() || title.length > 128 || /\p{Cc}/u.test(title)) {
      throw new Error('Terminal name must contain 1–128 printable characters.');
    }
    session.renamed = true;
    session.state.title = title.trim();
    this.changed(session);
  }

  close(owner: number, id: string): void {
    const session = this.owned(owner, id);
    this.stopSession(session);
    this.emit(owner, { kind: 'removed', ids: [id] });
    this.onChanged(owner);
  }

  private stopSession(session: ManagedSession): void {
    if (session.closed) return;
    this.historyProvider?.flush?.();
    session.closed = true;
    this.releaseCompletion(session.state.id);
    for (const [token, request] of this.portReleases)
      if (request.origin === session || request.target === session) this.portReleases.delete(token);
    this.sessions.delete(session.state.id);
    for (const disposable of session.disposables) disposable.dispose();
    session.screen.dispose();
    const stopped = session.nativeExit.then(() => session.cleanup());
    this.pendingStops.add(stopped);
    void stopped.then(
      () => {
        this.pendingStops.delete(stopped);
      },
      (error: unknown) => console.error('[terminal] shell cleanup failed', error)
    );
    if (session.state.status === 'running') {
      try {
        session.pty?.kill();
      } catch (error) {
        console.error('[terminal] shell termination failed', error);
      }
    }
  }

  closeOwner(owner: number): void {
    const lifetime = this.ownerLifetimes.get(owner);
    if (lifetime) lifetime.phase = 'retired';
    else this.ownerLifetimes.set(owner, { phase: 'retired' });
    for (const session of [...this.sessions.values()])
      if (session.owner === owner) this.close(owner, session.state.id);
  }

  dispose(): Promise<void> {
    this.disposed = true;

    for (const session of [...this.sessions.values()]) this.stopSession(session);
    if (this.pendingStops.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Native terminal shells did not exit before shutdown.')),
        5000
      );
      timer.unref?.();
      void Promise.allSettled([...this.pendingStops]).then((results) => {
        clearTimeout(timer);
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length)
          reject(new AggregateError(failures, 'Native terminal cleanup failed.'));
        else resolve();
      });
    });
  }
}
