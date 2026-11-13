interface SharedCancellableTaskEntry<Result> {
  readonly controller: AbortController;
  readonly task: Promise<Result>;
  waiters: number;
  activeCallers: number;
  settled: boolean;
}

export const MAX_SHARED_CANCELLABLE_TASK_WAITERS = 32;
export const MAX_SHARED_CANCELLABLE_TASKS = 32;

export class SharedCancellableTaskRegistry<Result> {
  private readonly entries = new Map<string, SharedCancellableTaskEntry<Result>>();

  constructor(
    private readonly maxWaiters = MAX_SHARED_CANCELLABLE_TASK_WAITERS,
    private readonly maxTasks = MAX_SHARED_CANCELLABLE_TASKS
  ) {
    if (!Number.isInteger(maxWaiters) || maxWaiters < 1) {
      throw new Error('Shared task waiter capacity must be a positive integer.');
    }
    if (!Number.isInteger(maxTasks) || maxTasks < 1) {
      throw new Error('Shared task capacity must be a positive integer.');
    }
  }

  async run(
    key: string,
    callerSignal: AbortSignal | undefined,
    start: (controller: AbortController) => Promise<Result>
  ): Promise<Result> {
    throwIfAborted(callerSignal);
    const incumbent = this.entries.get(key);
    if (incumbent) {
      if (incumbent.controller.signal.aborted) {
        await this.waitForSettlement(incumbent, callerSignal);
        return this.run(key, callerSignal, start);
      }
      return this.claim(incumbent, callerSignal);
    }
    if (this.entries.size >= this.maxTasks) {
      throw new Error('Shared task capacity is full.');
    }

    const controller = new AbortController();
    const task = Promise.resolve().then(() => start(controller));
    const entry: SharedCancellableTaskEntry<Result> = {
      controller,
      task,
      waiters: 0,
      activeCallers: 0,
      settled: false,
    };
    this.entries.set(key, entry);
    void task.then(
      () => this.settle(key, entry),
      () => this.settle(key, entry)
    );
    return this.claim(entry, callerSignal);
  }

  private async claim(
    entry: SharedCancellableTaskEntry<Result>,
    callerSignal: AbortSignal | undefined
  ): Promise<Result> {
    this.addWaiter(entry, true);
    let callerAborted = false;
    const onCallerAbort = (): void => {
      if (callerAborted) return;
      callerAborted = true;
      entry.activeCallers -= 1;
      if (entry.activeCallers === 0 && !entry.settled && !entry.controller.signal.aborted) {
        entry.controller.abort(abortError(callerSignal, 'Shared task lost its final caller.'));
      }
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal?.aborted) onCallerAbort();
    try {
      try {
        const result = await entry.task;
        if (callerAborted) throw abortError(callerSignal, 'Shared task was cancelled.');
        if (entry.controller.signal.aborted) {
          throw abortError(entry.controller.signal, 'Shared task was cancelled.');
        }
        return result;
      } catch (error) {
        if (callerAborted) throw abortError(callerSignal, 'Shared task was cancelled.');
        if (entry.controller.signal.aborted) {
          throw abortError(entry.controller.signal, 'Shared task was cancelled.');
        }
        throw error;
      }
    } finally {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (!callerAborted) entry.activeCallers -= 1;
      entry.waiters -= 1;
      if (entry.activeCallers === 0 && !entry.settled && !entry.controller.signal.aborted) {
        entry.controller.abort(abortError(callerSignal, 'Shared task lost its final caller.'));
      }
    }
  }

  private async waitForSettlement(
    entry: SharedCancellableTaskEntry<Result>,
    callerSignal: AbortSignal | undefined
  ): Promise<void> {
    this.addWaiter(entry, false);
    let rejectOnAbort: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const onCallerAbort = (): void => {
      rejectOnAbort?.(abortError(callerSignal, 'Shared task wait was cancelled.'));
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal?.aborted) onCallerAbort();
    try {
      const settlement = entry.task.then(
        () => undefined,
        () => undefined
      );
      await Promise.race([settlement, aborted]);
    } finally {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      entry.waiters -= 1;
    }
  }

  private addWaiter(entry: SharedCancellableTaskEntry<Result>, activeCaller: boolean): void {
    if (entry.waiters >= this.maxWaiters) {
      throw new Error('Shared task waiter capacity is full.');
    }
    entry.waiters += 1;
    if (activeCaller) entry.activeCallers += 1;
  }

  private settle(key: string, entry: SharedCancellableTaskEntry<Result>): void {
    entry.settled = true;
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal, 'Shared task was cancelled.');
}

function abortError(signal: AbortSignal | undefined, fallback: string): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(fallback);
  error.name = 'AbortError';
  return error;
}
