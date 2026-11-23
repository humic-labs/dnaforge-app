import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export const FORBIDDEN_SERVER_METHODS: ReadonlySet<string> = new Set([
  'shell/exec',
  'shell/execCommand',
  'applyPatch',
  'apply_patch',
  'fs/write',
  'fs/delete',
  'mcp/call',
  'plugin/invoke',
  'subagent/spawn',
  'web/search',
]);

export const MAX_FRAME_BYTES = 1_048_576;

export const MAX_RETAINED_NOTIFICATIONS = 256;

export type SupervisorTerminationReason =
  | 'shutdown'
  | 'interrupted'
  | 'child_exit'
  | 'malformed_frame'
  | 'oversized_frame'
  | 'forbidden_server_method'
  | 'unknown_server_method'
  | 'request_timeout';

export class AppServerSupervisorError extends Error {
  constructor(
    readonly code:
      | SupervisorTerminationReason
      | 'not_running'
      | 'duplicate_request_id'
      | 'child_error'
      | 'child_exit_timeout'
      | 'write_failed',
    message: string,
    readonly inputTooLarge = false
  ) {
    super(message);
    this.name = 'AppServerSupervisorError';
  }
}

export interface SupervisedChild {
  readonly pid?: number | undefined;
  readonly stdin: { write(chunk: string): void };
  readonly stdout: EventEmitter;
  readonly stderr?: EventEmitter;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface IncomingServerRequest {
  readonly method: string;
  readonly params: unknown;
  respond(result: unknown): void;
  refuse(message: string): void;
}

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AppServerSupervisorOptions {
  readonly child: SupervisedChild;
  readonly allowedNotifications?: readonly string[];
  readonly answerableRequests?: readonly string[];
  readonly refusedRequests?: Readonly<Record<string, string>>;
  readonly onServerRequest?: (request: IncomingServerRequest) => void;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly onNotification?: (notification: { method: string; params: unknown }) => void;
  readonly maxRetainedNotifications?: number;
  readonly now?: () => number;
}

export class AppServerSupervisor {
  private readonly pending = new Map<number, Pending>();
  private readonly allowedNotifications: ReadonlySet<string>;
  private readonly answerableRequests: ReadonlySet<string>;
  private readonly refusedRequests: Readonly<Record<string, string>>;
  private readonly childProcess: SupervisedChild;
  private runningTurn: { threadId: string; turnId: string } | null = null;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private nextId = 1;
  private terminated: SupervisorTerminationReason | null = null;
  private readonly exitListeners: (() => void)[] = [];
  private serverRequestHandler: ((request: IncomingServerRequest) => void) | null = null;
  private notificationListener:
    | ((notification: { method: string; params: unknown }) => void)
    | null = null;
  private readonly notifications: { method: string; params: unknown }[] = [];
  private readonly maxRetainedNotifications: number;
  private childExited = false;
  private readonly childExitWaiters = new Set<() => void>();

  constructor(private readonly options: AppServerSupervisorOptions) {
    this.allowedNotifications = new Set(options.allowedNotifications ?? []);
    this.answerableRequests = new Set(options.answerableRequests ?? []);
    this.refusedRequests = options.refusedRequests ?? {};
    this.childProcess = options.child;
    this.serverRequestHandler = options.onServerRequest ?? null;
    this.notificationListener = options.onNotification ?? null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.maxRetainedNotifications = options.maxRetainedNotifications ?? MAX_RETAINED_NOTIFICATIONS;

    options.child.stdout.on('data', (chunk: Buffer | string) =>
      this.onData(typeof chunk === 'string' ? chunk : this.decoder.write(chunk))
    );
    options.child.on('exit', () => {
      this.childExited = true;
      for (const waiter of this.childExitWaiters) waiter();
      this.childExitWaiters.clear();
      this.terminate('child_exit', 'the App Server child exited');
    });
  }

  setServerRequestHandler(handler: (request: IncomingServerRequest) => void): void {
    this.serverRequestHandler = handler;
  }

  setNotificationListener(
    listener: (notification: { method: string; params: unknown }) => void
  ): void {
    this.notificationListener = listener;
  }

  onExit(listener: () => void): void {
    if (this.terminated !== null) {
      listener();
      return;
    }
    this.exitListeners.push(listener);
  }

  receivedNotifications(): readonly { method: string; params: unknown }[] {
    return this.notifications;
  }

  get isTerminated(): boolean {
    return this.terminated !== null;
  }

  get terminationReason(): SupervisorTerminationReason | null {
    return this.terminated;
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.terminated) {
      throw new AppServerSupervisorError(
        'not_running',
        `the App Server child is no longer running (${this.terminated})`
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    if (this.pending.has(id)) {
      throw new AppServerSupervisorError('duplicate_request_id', `request id ${id} is outstanding`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.terminate('request_timeout', `${method} did not answer within the bound`);
        reject(
          new AppServerSupervisorError(
            'request_timeout',
            `${method} did not answer within the bound`
          )
        );
      }, this.requestTimeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.options.child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
        );
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new AppServerSupervisorError(
            'write_failed',
            `could not send ${method} to the App Server child: ${
              error instanceof Error ? error.message : 'write failed'
            }`
          )
        );
      }
    });
  }

  private write(frame: Record<string, unknown>): void {
    try {
      this.options.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch {}
  }

  get childPid(): number | undefined {
    return this.childProcess.pid;
  }

  interrupt(): void {
    const running = this.runningTurn;
    if (running === null || this.terminated !== null) {
      this.terminate('interrupted', 'the turn was interrupted');
      return;
    }
    this.runningTurn = null;
    void this.request('turn/interrupt', running).catch(() => {
      if (this.terminated === null) {
        this.terminate('interrupted', 'the turn was interrupted');
      }
    });
  }

  shutdown(): void {
    this.terminate('shutdown', 'the supervisor was shut down');
  }

  async shutdownAndWait(gracePeriodMs = 2_000, forcePeriodMs = 1_000): Promise<void> {
    this.shutdown();
    if (await this.waitForChildExit(gracePeriodMs)) return;
    try {
      this.childProcess.kill('SIGKILL');
    } catch {}
    if (await this.waitForChildExit(forcePeriodMs)) return;
    throw new AppServerSupervisorError(
      'child_exit_timeout',
      'the App Server child did not exit after SIGTERM and SIGKILL'
    );
  }

  private waitForChildExit(timeoutMs: number): Promise<boolean> {
    if (this.childExited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.childExitWaiters.delete(onExit);
        resolve(exited);
      };
      const onExit = (): void => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.childExitWaiters.add(onExit);
    });
  }

  private onData(chunk: string): void {
    if (this.terminated) return;
    this.buffer += chunk;
    if (this.pendingFrameBytes() > this.maxFrameBytes) {
      this.terminate('oversized_frame', 'the App Server child sent an oversized frame');
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (!this.onFrame(line)) return;
    }
  }

  private pendingFrameBytes(): number {
    const lastNewline = this.buffer.lastIndexOf('\n');
    const pending = lastNewline < 0 ? this.buffer : this.buffer.slice(lastNewline + 1);
    return Buffer.byteLength(pending, 'utf8');
  }

  private onFrame(line: string): boolean {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('frame is not a JSON object');
      }
      frame = parsed as Record<string, unknown>;
    } catch {
      this.terminate('malformed_frame', 'the App Server child sent a frame that is not JSON');
      return false;
    }

    const method = typeof frame.method === 'string' ? frame.method : null;
    const hasId = frame.id !== undefined && frame.id !== null;

    if (method !== null) {
      if (FORBIDDEN_SERVER_METHODS.has(method)) {
        this.terminate(
          'forbidden_server_method',
          `the App Server child requested "${method}", which this runtime never honors`
        );
        return false;
      }
      if (hasId) {
        const refusal = Object.hasOwn(this.refusedRequests, method)
          ? this.refusedRequests[method]
          : null;
        if (refusal !== null) {
          this.write({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32601, message: refusal },
          });
          return true;
        }
        if (!this.answerableRequests.has(method)) {
          if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
            console.error('[HostedCodex] Unexpected App Server request method:', method);
          }
          this.terminate(
            'unknown_server_method',
            `the App Server child issued an unexpected request "${method}"`
          );
          return false;
        }
        const handler = this.serverRequestHandler;
        if (!handler) {
          this.terminate(
            'unknown_server_method',
            `nothing is able to answer the App Server child's "${method}" request`
          );
          return false;
        }
        const id = frame.id;
        let answered = false;
        const reply = (payload: Record<string, unknown>): void => {
          if (answered || this.terminated !== null) return;
          answered = true;
          this.write({ jsonrpc: '2.0', id, ...payload });
        };
        handler({
          method,
          params: frame.params,
          respond: (result) => reply({ result }),
          refuse: (message) => reply({ error: { code: -32000, message } }),
        });
        return true;
      }
      if (method === 'turn/started') {
        const params = frame.params as { threadId?: unknown; turn?: { id?: unknown } } | null;
        const threadId = params?.threadId;
        const turnId = params?.turn?.id;
        if (typeof threadId === 'string' && typeof turnId === 'string') {
          this.runningTurn = { threadId, turnId };
        }
      }
      if (method === 'turn/completed' || method === 'error') {
        this.runningTurn = null;
      }
      if (!this.allowedNotifications.has(method)) {
        if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
          console.error('[HostedCodex] Unexpected App Server notification method:', method);
        }
        this.terminate(
          'unknown_server_method',
          `the App Server child sent an unexpected notification "${method}"`
        );
        return false;
      }
      const notification = { method, params: frame.params };
      this.notificationListener?.(notification);
      this.notifications.push(notification);
      if (this.notifications.length > this.maxRetainedNotifications) {
        this.notifications.splice(0, this.notifications.length - this.maxRetainedNotifications);
      }
      return true;
    }

    if (!hasId) {
      this.terminate('malformed_frame', 'the App Server child sent a frame with no id or method');
      return false;
    }
    if (typeof frame.id !== 'number') {
      this.terminate(
        'malformed_frame',
        'the App Server child answered with an id this runtime never issued'
      );
      return false;
    }

    const id = frame.id;
    const pending = this.pending.get(id);
    if (!pending) {
      return true;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      const message =
        typeof (frame.error as { message?: unknown } | null)?.message === 'string'
          ? String((frame.error as { message: string }).message)
          : 'the App Server child returned an error';
      const errorData = (frame.error as { data?: { input_error_code?: unknown } } | null)?.data;
      const inputTooLarge =
        pending.method === 'turn/start' && errorData?.input_error_code === 'input_too_large';
      pending.reject(new AppServerSupervisorError('child_error', message, inputTooLarge));
      return true;
    }
    pending.resolve(frame.result);
    return true;
  }

  private terminate(reason: SupervisorTerminationReason, message: string): void {
    if (this.terminated) return;
    this.terminated = reason;
    for (const listener of this.exitListeners.splice(0)) {
      try {
        listener();
      } catch {}
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new AppServerSupervisorError(reason, message));
    }
    try {
      this.options.child.kill('SIGTERM');
    } catch {}
  }
}
