import {
  isGitReadUuid,
  type GitReadCancelReason,
  type GitReadLifecycleSnapshot,
  type GitReadPhysicalCancellationEvent,
} from '../../shared/git-read-ipc';

const MAX_RECENT_PHYSICAL_CANCELLATIONS = 64;

export interface GitReadSender {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

export interface OwnedGitReadProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

interface ActiveGitRead {
  readonly key: string;
  readonly senderId: number;
  readonly requestId: string;
  readonly controller: AbortController;
  readonly children: Set<OwnedGitReadProcess>;
  readonly childCloseListeners: Map<OwnedGitReadProcess, () => void>;
  readonly hardKillTimers: Map<OwnedGitReadProcess, NodeJS.Timeout>;
  readonly physicalSettlementWaiters: Set<() => void>;
  timeout: NodeJS.Timeout | null;
  cancelReason: GitReadCancelReason | null;
  closeGestureToken: string | null;
  physicalCancellationCounted: boolean;
}

interface QueuedGitRead {
  readonly entry: ActiveGitRead;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface GitReadExecutionControl {
  readonly signal: AbortSignal;
  bindProcess(process: OwnedGitReadProcess): void;
}

export interface GitReadRequestOwnerOptions {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly timeoutMs: number;
  readonly hardKillGraceMs: number;
}

function requestKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`;
}

function hasPhysicallyExited(process: OwnedGitReadProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

function unrefTimer(timer: NodeJS.Timeout): void {
  timer.unref?.();
}

export class GitReadRequestOwner {
  readonly #options: GitReadRequestOwnerOptions;
  readonly #active = new Map<string, ActiveGitRead>();
  readonly #queued: QueuedGitRead[] = [];
  readonly #queuedByKey = new Map<string, QueuedGitRead>();
  readonly #senderRequestKeys = new Map<number, Set<string>>();
  readonly #senderDestroyListeners = new Map<number, () => void>();
  readonly #senders = new Map<number, GitReadSender>();
  readonly #quiescenceWaiters = new Set<() => void>();

  #shuttingDown = false;
  #started = 0;
  #settled = 0;
  #cancelled = 0;
  #cancelledWithPhysicalChild = 0;
  #callerCancelledWithPhysicalChild = 0;
  #senderDestroyedWithPhysicalChild = 0;
  #timedOutWithPhysicalChild = 0;
  #shutdownWithPhysicalChild = 0;
  #timedOut = 0;
  #peakActive = 0;
  #peakQueued = 0;
  #physicalCancellationEventSequence = 0;
  readonly #recentPhysicalCancellations: GitReadPhysicalCancellationEvent[] = [];

  constructor(options: GitReadRequestOwnerOptions) {
    if (!Number.isInteger(options.maxActive) || options.maxActive <= 0) {
      throw new Error('Git read maxActive must be a positive integer.');
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new Error('Git read maxQueued must be a non-negative integer.');
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('Git read timeoutMs must be positive.');
    }
    if (!Number.isFinite(options.hardKillGraceMs) || options.hardKillGraceMs < 0) {
      throw new Error('Git read hardKillGraceMs cannot be negative.');
    }
    this.#options = options;
  }

  async run<T>(input: {
    readonly sender: GitReadSender;
    readonly requestId: string;
    readonly execute: (control: GitReadExecutionControl) => Promise<T>;
  }): Promise<T> {
    this.#assertRequestId(input.requestId);
    if (this.#shuttingDown) {
      throw new Error('GIT_READ_SHUTTING_DOWN');
    }
    if (input.sender.isDestroyed()) {
      throw new Error('GIT_READ_SENDER_DESTROYED');
    }

    const key = requestKey(input.sender.id, input.requestId);
    if (this.#active.has(key) || this.#queuedByKey.has(key)) {
      throw new Error('GIT_READ_DUPLICATE_REQUEST');
    }
    if (
      this.#active.size >= this.#options.maxActive &&
      this.#queued.length >= this.#options.maxQueued
    ) {
      throw new Error('GIT_READ_QUEUE_FULL');
    }

    const controller = new AbortController();
    const entry: ActiveGitRead = {
      key,
      senderId: input.sender.id,
      requestId: input.requestId,
      controller,
      children: new Set(),
      childCloseListeners: new Map(),
      hardKillTimers: new Map(),
      physicalSettlementWaiters: new Set(),
      timeout: null,
      cancelReason: null,
      closeGestureToken: null,
      physicalCancellationCounted: false,
    };
    this.#retainSender(input.sender, key);
    this.#started += 1;

    try {
      await this.#waitForAdmission(entry);
      if (controller.signal.aborted) throw new Error('GIT_READ_CANCELLED');
      return await input.execute({
        signal: controller.signal,
        bindProcess: (process) => this.#bindProcess(entry, process),
      });
    } finally {
      if (this.#active.get(key) === entry) {
        await this.#waitForPhysicalSettlement(entry);
        this.#releaseActive(entry);
      }
    }
  }

  cancel(senderId: number, requestId: string, closeGestureToken?: string): boolean {
    this.#assertRequestId(requestId);
    if (closeGestureToken !== undefined && !isGitReadUuid(closeGestureToken)) {
      throw new Error('GIT_READ_INVALID_CLOSE_GESTURE_TOKEN');
    }
    const key = requestKey(senderId, requestId);
    const activeEntry = this.#active.get(key);
    if (activeEntry) {
      if (activeEntry.cancelReason === null) {
        activeEntry.closeGestureToken = closeGestureToken ?? null;
      }
      this.#cancelEntry(activeEntry, 'caller');
      return true;
    }
    const queuedEntry = this.#queuedByKey.get(key);
    if (!queuedEntry) return false;
    this.#cancelQueued(queuedEntry, 'caller');
    return true;
  }

  async cancelAll(): Promise<void> {
    this.#shuttingDown = true;
    const activeEntries = Array.from(this.#active.values());
    for (const queuedEntry of Array.from(this.#queued)) {
      this.#cancelQueued(queuedEntry, 'shutdown');
    }
    for (const entry of activeEntries) this.#cancelEntry(entry, 'shutdown');
    await this.#waitForQuiescence();
  }

  snapshot(): GitReadLifecycleSnapshot {
    let physicalChildren = 0;
    let uncancelledPhysicalChildren = 0;
    const activeUncancelledPhysicalRequestIds: string[] = [];
    for (const entry of this.#active.values()) {
      physicalChildren += entry.children.size;
      if (entry.cancelReason === null) {
        uncancelledPhysicalChildren += entry.children.size;
        if (entry.children.size > 0) activeUncancelledPhysicalRequestIds.push(entry.requestId);
      }
    }
    return {
      active: this.#active.size,
      queued: this.#queued.length,
      physicalChildren,
      uncancelledPhysicalChildren,
      activeUncancelledPhysicalRequestIds,
      started: this.#started,
      settled: this.#settled,
      cancelled: this.#cancelled,
      cancelledWithPhysicalChild: this.#cancelledWithPhysicalChild,
      callerCancelledWithPhysicalChild: this.#callerCancelledWithPhysicalChild,
      senderDestroyedWithPhysicalChild: this.#senderDestroyedWithPhysicalChild,
      timedOutWithPhysicalChild: this.#timedOutWithPhysicalChild,
      shutdownWithPhysicalChild: this.#shutdownWithPhysicalChild,
      timedOut: this.#timedOut,
      peakActive: this.#peakActive,
      peakQueued: this.#peakQueued,
      maxActive: this.#options.maxActive,
      maxQueued: this.#options.maxQueued,
      physicalCancellationEventSequence: this.#physicalCancellationEventSequence,
      recentPhysicalCancellations: this.#recentPhysicalCancellations.map((event) => ({
        ...event,
      })),
      maxRecentPhysicalCancellations: MAX_RECENT_PHYSICAL_CANCELLATIONS,
    };
  }

  #assertRequestId(requestId: string): void {
    if (!isGitReadUuid(requestId)) {
      throw new Error('GIT_READ_INVALID_REQUEST_ID');
    }
  }

  #retainSender(sender: GitReadSender, key: string): void {
    let keys = this.#senderRequestKeys.get(sender.id);
    if (!keys) {
      keys = new Set();
      this.#senderRequestKeys.set(sender.id, keys);
      this.#senders.set(sender.id, sender);
      const onDestroyed = (): void => this.#cancelSender(sender.id);
      this.#senderDestroyListeners.set(sender.id, onDestroyed);
      sender.once('destroyed', onDestroyed);
    }
    keys.add(key);
  }

  #cancelSender(senderId: number): void {
    const keys = this.#senderRequestKeys.get(senderId);
    if (!keys) return;
    for (const key of Array.from(keys)) {
      const activeEntry = this.#active.get(key);
      if (activeEntry) {
        this.#cancelEntry(activeEntry, 'sender-destroyed');
        continue;
      }
      const queuedEntry = this.#queuedByKey.get(key);
      if (queuedEntry) this.#cancelQueued(queuedEntry, 'sender-destroyed');
    }
  }

  #waitForAdmission(entry: ActiveGitRead): Promise<void> {
    if (this.#active.size < this.#options.maxActive) {
      this.#activate(entry);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const queuedEntry: QueuedGitRead = { entry, resolve, reject };
      this.#queued.push(queuedEntry);
      this.#queuedByKey.set(entry.key, queuedEntry);
      this.#peakQueued = Math.max(this.#peakQueued, this.#queued.length);
    });
  }

  #activate(entry: ActiveGitRead): void {
    this.#active.set(entry.key, entry);
    entry.timeout = setTimeout(() => this.#cancelEntry(entry, 'timeout'), this.#options.timeoutMs);
    unrefTimer(entry.timeout);
    this.#peakActive = Math.max(this.#peakActive, this.#active.size);
  }

  #drainQueue(): void {
    while (this.#active.size < this.#options.maxActive && this.#queued.length > 0) {
      const queuedEntry = this.#queued.shift();
      if (!queuedEntry) return;
      const sender = this.#senders.get(queuedEntry.entry.senderId);
      if (!sender || sender.isDestroyed()) {
        this.#cancelQueued(queuedEntry, 'sender-destroyed');
        continue;
      }
      this.#queuedByKey.delete(queuedEntry.entry.key);
      this.#activate(queuedEntry.entry);
      queuedEntry.resolve();
    }
  }

  #cancelQueued(queuedEntry: QueuedGitRead, reason: GitReadCancelReason): void {
    if (!this.#queuedByKey.has(queuedEntry.entry.key)) return;
    this.#queuedByKey.delete(queuedEntry.entry.key);
    const index = this.#queued.indexOf(queuedEntry);
    if (index >= 0) this.#queued.splice(index, 1);
    queuedEntry.entry.cancelReason = reason;
    queuedEntry.entry.controller.abort(reason);
    this.#cancelled += 1;
    this.#settled += 1;
    this.#releaseSenderKey(queuedEntry.entry);
    queuedEntry.reject(new Error('GIT_READ_CANCELLED'));
    this.#resolveQuiescenceIfIdle();
  }

  #cancelEntry(entry: ActiveGitRead, reason: GitReadCancelReason): void {
    if (entry.cancelReason !== null) return;
    entry.cancelReason = reason;
    this.#cancelled += 1;
    if (reason === 'timeout') this.#timedOut += 1;
    this.#recordPhysicalCancellation(entry);
    entry.controller.abort(reason);
    for (const child of entry.children) this.#scheduleHardKill(entry, child);
  }

  #bindProcess(entry: ActiveGitRead, process: OwnedGitReadProcess): void {
    if (hasPhysicallyExited(process)) return;
    entry.children.add(process);
    const onClose = (): void => {
      entry.children.delete(process);
      entry.childCloseListeners.delete(process);
      const timer = entry.hardKillTimers.get(process);
      if (timer) clearTimeout(timer);
      entry.hardKillTimers.delete(process);
      if (entry.children.size === 0) {
        for (const resolve of entry.physicalSettlementWaiters) resolve();
        entry.physicalSettlementWaiters.clear();
      }
    };
    entry.childCloseListeners.set(process, onClose);
    process.once('close', onClose);
    if (entry.cancelReason !== null) {
      this.#recordPhysicalCancellation(entry);
      this.#scheduleHardKill(entry, process);
    }
  }

  #recordPhysicalCancellation(entry: ActiveGitRead): void {
    if (
      entry.cancelReason === null ||
      entry.children.size === 0 ||
      entry.physicalCancellationCounted
    ) {
      return;
    }
    entry.physicalCancellationCounted = true;
    this.#cancelledWithPhysicalChild += 1;
    if (entry.cancelReason === 'caller') this.#callerCancelledWithPhysicalChild += 1;
    else if (entry.cancelReason === 'sender-destroyed') {
      this.#senderDestroyedWithPhysicalChild += 1;
    } else if (entry.cancelReason === 'timeout') {
      this.#timedOutWithPhysicalChild += 1;
    } else {
      this.#shutdownWithPhysicalChild += 1;
    }
    this.#physicalCancellationEventSequence += 1;
    this.#recentPhysicalCancellations.push({
      sequence: this.#physicalCancellationEventSequence,
      requestId: entry.requestId,
      reason: entry.cancelReason,
      closeGestureToken: entry.cancelReason === 'caller' ? entry.closeGestureToken : null,
    });
    if (this.#recentPhysicalCancellations.length > MAX_RECENT_PHYSICAL_CANCELLATIONS) {
      this.#recentPhysicalCancellations.shift();
    }
  }

  #scheduleHardKill(entry: ActiveGitRead, process: OwnedGitReadProcess): void {
    if (hasPhysicallyExited(process) || entry.hardKillTimers.has(process)) return;
    const timer = setTimeout(() => {
      entry.hardKillTimers.delete(process);
      if (!hasPhysicallyExited(process)) process.kill('SIGKILL');
    }, this.#options.hardKillGraceMs);
    unrefTimer(timer);
    entry.hardKillTimers.set(process, timer);
  }

  async #waitForPhysicalSettlement(entry: ActiveGitRead): Promise<void> {
    if (entry.children.size === 0) return;
    await new Promise<void>((resolve) => entry.physicalSettlementWaiters.add(resolve));
  }

  #releaseActive(entry: ActiveGitRead): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    for (const timer of entry.hardKillTimers.values()) clearTimeout(timer);
    for (const [child, listener] of entry.childCloseListeners) {
      child.removeListener('close', listener);
    }
    entry.hardKillTimers.clear();
    entry.childCloseListeners.clear();
    entry.children.clear();
    this.#active.delete(entry.key);
    this.#settled += 1;
    this.#releaseSenderKey(entry);
    this.#drainQueue();
    this.#resolveQuiescenceIfIdle();
  }

  #waitForQuiescence(): Promise<void> {
    if (this.#active.size === 0 && this.#queued.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#quiescenceWaiters.add(resolve));
  }

  #resolveQuiescenceIfIdle(): void {
    if (this.#active.size !== 0 || this.#queued.length !== 0) return;
    for (const resolve of this.#quiescenceWaiters) resolve();
    this.#quiescenceWaiters.clear();
  }

  #releaseSenderKey(entry: ActiveGitRead): void {
    const keys = this.#senderRequestKeys.get(entry.senderId);
    keys?.delete(entry.key);
    if (keys && keys.size > 0) return;

    const sender = this.#senders.get(entry.senderId);
    const listener = this.#senderDestroyListeners.get(entry.senderId);
    if (sender && listener && !sender.isDestroyed()) {
      sender.removeListener('destroyed', listener);
    }
    this.#senderRequestKeys.delete(entry.senderId);
    this.#senderDestroyListeners.delete(entry.senderId);
    this.#senders.delete(entry.senderId);
  }
}
