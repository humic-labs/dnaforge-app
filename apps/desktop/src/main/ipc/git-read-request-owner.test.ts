import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GitReadRequestOwner,
  type GitReadSender,
  type OwnedGitReadProcess,
} from './git-read-request-owner';

const REQUEST_A = '10000000-0000-4000-8000-000000000001';
const REQUEST_B = '10000000-0000-4000-8000-000000000002';
const REQUEST_C = '10000000-0000-4000-8000-000000000003';
const REQUEST_D = '10000000-0000-4000-8000-000000000004';
const CLOSE_GESTURE_A = '20000000-0000-4000-8000-000000000001';

class FakeSender extends EventEmitter implements GitReadSender {
  #destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    this.#destroyed = true;
    this.emit('destroyed');
  }
}

class FakeProcess extends EventEmitter implements OwnedGitReadProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }

  closeAfterSpawnFailure(): void {
    this.emit('close', -2, null);
  }
}

function startHeldRead(
  owner: GitReadRequestOwner,
  sender: FakeSender,
  requestId: string
): {
  readonly child: FakeProcess;
  readonly promise: Promise<string>;
  readonly started: Promise<void>;
  complete(value?: string): void;
} {
  const child = new FakeProcess();
  let completeTask: (value: string) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const promise = owner.run({
    sender,
    requestId,
    execute: ({ signal, bindProcess }) => {
      bindProcess(child);
      markStarted();
      return new Promise<string>((resolve, reject) => {
        completeTask = resolve;
        signal.addEventListener('abort', () => reject(new Error('Git read cancelled.')), {
          once: true,
        });
      });
    },
  });
  return {
    child,
    promise,
    started,
    complete: (value = 'done') => completeTask(value),
  };
}

describe('GitReadRequestOwner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits queued requests in FIFO order after each predecessor physically exits', async () => {
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 2,
      timeoutMs: 60_000,
      hardKillGraceMs: 1_000,
    });
    const sender = new FakeSender(7);
    const first = startHeldRead(owner, sender, REQUEST_A);
    const second = startHeldRead(owner, sender, REQUEST_B);
    const third = startHeldRead(owner, sender, REQUEST_C);
    await first.started;

    await expect(
      owner.run({ sender, requestId: REQUEST_D, execute: async () => 'unexpected' })
    ).rejects.toThrow('GIT_READ_QUEUE_FULL');
    expect(owner.snapshot()).toMatchObject({
      active: 1,
      queued: 2,
      physicalChildren: 1,
      uncancelledPhysicalChildren: 1,
      started: 3,
      settled: 0,
      cancelledWithPhysicalChild: 0,
      callerCancelledWithPhysicalChild: 0,
    });

    first.complete();
    await Promise.resolve();
    expect(owner.snapshot()).toMatchObject({
      active: 1,
      queued: 2,
      physicalChildren: 1,
      uncancelledPhysicalChildren: 1,
    });
    first.child.exit();
    await expect(first.promise).resolves.toBe('done');
    await second.started;
    expect(owner.snapshot()).toMatchObject({ active: 1, queued: 1, settled: 1 });

    second.complete();
    second.child.exit();
    await expect(second.promise).resolves.toBe('done');
    await third.started;
    expect(owner.snapshot()).toMatchObject({ active: 1, queued: 0, settled: 2 });

    third.complete();
    third.child.exit();
    await expect(third.promise).resolves.toBe('done');
    expect(owner.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      physicalChildren: 0,
      uncancelledPhysicalChildren: 0,
      started: 3,
      settled: 3,
      peakActive: 1,
      peakQueued: 2,
      maxActive: 1,
      maxQueued: 2,
    });
  });

  it('keeps a caller-cancelled request admitted until its child exits', async () => {
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 1,
      timeoutMs: 60_000,
      hardKillGraceMs: 1_000,
    });
    const sender = new FakeSender(8);
    const held = startHeldRead(owner, sender, REQUEST_A);
    await held.started;

    expect(owner.cancel(sender.id, REQUEST_A, CLOSE_GESTURE_A)).toBe(true);
    await Promise.resolve();
    const cancelledSnapshot = owner.snapshot();
    expect(cancelledSnapshot).toMatchObject({
      active: 1,
      physicalChildren: 1,
      uncancelledPhysicalChildren: 0,
      activeUncancelledPhysicalRequestIds: [],
      cancelled: 1,
      cancelledWithPhysicalChild: 1,
      callerCancelledWithPhysicalChild: 1,
      senderDestroyedWithPhysicalChild: 0,
      timedOutWithPhysicalChild: 0,
      settled: 0,
      physicalCancellationEventSequence: 1,
      recentPhysicalCancellations: [
        {
          sequence: 1,
          requestId: REQUEST_A,
          reason: 'caller',
          closeGestureToken: CLOSE_GESTURE_A,
        },
      ],
      maxRecentPhysicalCancellations: 64,
    });
    const next = owner.run({ sender, requestId: REQUEST_B, execute: async () => 'next' });
    expect(owner.snapshot()).toMatchObject({ active: 1, queued: 1 });

    held.child.exit();
    await expect(held.promise).rejects.toThrow('cancelled');
    await expect(next).resolves.toBe('next');
    expect(owner.snapshot()).toMatchObject({ active: 0, queued: 0, started: 2, settled: 2 });
  });

  it('removes a caller-cancelled queued request before it can execute', async () => {
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 1,
      timeoutMs: 60_000,
      hardKillGraceMs: 1_000,
    });
    const sender = new FakeSender(12);
    const active = startHeldRead(owner, sender, REQUEST_A);
    const queued = startHeldRead(owner, sender, REQUEST_B);
    await active.started;

    expect(owner.cancel(sender.id, REQUEST_B, CLOSE_GESTURE_A)).toBe(true);
    await expect(queued.promise).rejects.toThrow('GIT_READ_CANCELLED');
    expect(owner.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      physicalChildren: 1,
      uncancelledPhysicalChildren: 1,
      started: 2,
      settled: 1,
      cancelled: 1,
      cancelledWithPhysicalChild: 0,
      callerCancelledWithPhysicalChild: 0,
      senderDestroyedWithPhysicalChild: 0,
      timedOutWithPhysicalChild: 0,
      physicalCancellationEventSequence: 0,
      recentPhysicalCancellations: [],
    });

    active.complete();
    active.child.exit();
    await expect(active.promise).resolves.toBe('done');
    expect(owner.snapshot()).toMatchObject({ active: 0, queued: 0, settled: 2 });
  });

  it('cancels active and queued requests owned by a destroyed renderer sender', async () => {
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 2,
      timeoutMs: 60_000,
      hardKillGraceMs: 1_000,
    });
    const sender = new FakeSender(9);
    const first = startHeldRead(owner, sender, REQUEST_A);
    const second = startHeldRead(owner, sender, REQUEST_B);
    const third = startHeldRead(owner, sender, REQUEST_C);
    await first.started;

    sender.destroy();
    await Promise.resolve();
    expect(owner.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      cancelled: 3,
      cancelledWithPhysicalChild: 1,
      callerCancelledWithPhysicalChild: 0,
      senderDestroyedWithPhysicalChild: 1,
      timedOutWithPhysicalChild: 0,
      settled: 2,
    });

    first.child.exit();
    await Promise.allSettled([first.promise, second.promise, third.promise]);
    expect(owner.snapshot()).toMatchObject({ active: 0, queued: 0, started: 3, settled: 3 });
  });

  it('times out, escalates to a hard kill, and still waits for physical exit', async () => {
    vi.useFakeTimers();
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 1,
      timeoutMs: 100,
      hardKillGraceMs: 50,
    });
    const sender = new FakeSender(10);
    const held = startHeldRead(owner, sender, REQUEST_A);

    await vi.advanceTimersByTimeAsync(100);
    expect(owner.snapshot()).toMatchObject({
      active: 1,
      physicalChildren: 1,
      uncancelledPhysicalChildren: 0,
      cancelled: 1,
      cancelledWithPhysicalChild: 1,
      callerCancelledWithPhysicalChild: 0,
      senderDestroyedWithPhysicalChild: 0,
      timedOutWithPhysicalChild: 1,
      timedOut: 1,
    });
    expect(held.child.killSignals).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(held.child.killSignals).toEqual(['SIGKILL']);
    expect(owner.snapshot().active).toBe(1);

    held.child.exit();
    await expect(held.promise).rejects.toThrow('cancelled');
    expect(owner.snapshot()).toMatchObject({ active: 0, settled: 1 });
  });

  it('releases admission when a failed spawn closes without emitting exit', async () => {
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 1,
      timeoutMs: 60_000,
      hardKillGraceMs: 1_000,
    });
    const sender = new FakeSender(11);
    const child = new FakeProcess();
    const promise = owner.run({
      sender,
      requestId: REQUEST_A,
      execute: async ({ bindProcess }) => {
        bindProcess(child);
        throw new Error('spawn failed');
      },
    });

    await Promise.resolve();
    expect(owner.snapshot()).toMatchObject({
      active: 1,
      physicalChildren: 1,
      uncancelledPhysicalChildren: 1,
      settled: 0,
    });
    child.closeAfterSpawnFailure();
    await expect(promise).rejects.toThrow('spawn failed');
    expect(owner.snapshot()).toMatchObject({ active: 0, started: 1, settled: 1 });
  });

  it('cancels every active and queued request during app shutdown and waits for physical exit', async () => {
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 1,
      timeoutMs: 60_000,
      hardKillGraceMs: 1_000,
    });
    const sender = new FakeSender(14);
    const active = startHeldRead(owner, sender, REQUEST_A);
    const queued = startHeldRead(owner, sender, REQUEST_B);
    await active.started;
    const activeSettlement = active.promise.catch((error: unknown) => error);
    const queuedSettlement = queued.promise.catch((error: unknown) => error);

    let shutdownSettled = false;
    const shutdown = owner.cancelAll().then(() => {
      shutdownSettled = true;
    });
    const repeatedShutdown = owner.cancelAll();
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    await expect(
      owner.run({ sender, requestId: REQUEST_C, execute: async () => 'late request' })
    ).rejects.toThrow('GIT_READ_SHUTTING_DOWN');
    expect(owner.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      physicalChildren: 1,
      cancelled: 2,
      cancelledWithPhysicalChild: 1,
      shutdownWithPhysicalChild: 1,
      settled: 1,
    });

    active.child.exit();
    await Promise.all([shutdown, repeatedShutdown]);
    await expect(activeSettlement).resolves.toBeInstanceOf(Error);
    await expect(queuedSettlement).resolves.toBeInstanceOf(Error);
    await Promise.resolve();
    expect(owner.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      physicalChildren: 0,
      started: 2,
      settled: 2,
      shutdownWithPhysicalChild: 1,
    });
    await expect(
      owner.run({ sender, requestId: REQUEST_D, execute: async () => 'post-shutdown request' })
    ).rejects.toThrow('GIT_READ_SHUTTING_DOWN');
    expect(owner.snapshot()).toMatchObject({ started: 2, settled: 2 });
  });

  it('keeps production quit wired to await Git-read shutdown before database closure', () => {
    const mainSource = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    const closeDatabaseBody =
      /closeDatabase:\s*async\s*\(\)\s*=>\s*\{(?<body>[\s\S]*?)\r?\n[ \t]*\},?\r?\n[ \t]*trackAppClosed/u.exec(
        mainSource
      )?.groups?.body;
    expect(closeDatabaseBody).toBeDefined();
    const gitReadStep = "{ name: 'git read requests', run: shutdownGitReadRequests }";
    const databaseStep = "{ name: 'database', run: closeDatabase }";
    expect(closeDatabaseBody).toContain('await runShutdownSteps([');
    expect(closeDatabaseBody).toContain(gitReadStep);
    expect(closeDatabaseBody).toContain(databaseStep);
    expect(closeDatabaseBody!.indexOf(gitReadStep)).toBeLessThan(
      closeDatabaseBody!.indexOf(databaseStep)
    );
  });

  it('rejects malformed close-gesture identities before touching an owner', () => {
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 1,
      timeoutMs: 60_000,
      hardKillGraceMs: 1_000,
    });

    expect(() => owner.cancel(1, REQUEST_A, 'not-a-close-gesture-id')).toThrow(
      'GIT_READ_INVALID_CLOSE_GESTURE_TOKEN'
    );
    expect(owner.snapshot()).toMatchObject({ started: 0, cancelled: 0 });
  });

  it('retains only the latest 64 exact physical-cancellation events', async () => {
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 0,
      timeoutMs: 60_000,
      hardKillGraceMs: 1_000,
    });
    const sender = new FakeSender(13);

    for (let index = 1; index <= 65; index += 1) {
      const requestId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const held = startHeldRead(owner, sender, requestId);
      await held.started;
      expect(owner.cancel(sender.id, requestId)).toBe(true);
      held.child.exit();
      await expect(held.promise).rejects.toThrow('cancelled');
    }

    const snapshot = owner.snapshot();
    expect(snapshot.physicalCancellationEventSequence).toBe(65);
    expect(snapshot.recentPhysicalCancellations).toHaveLength(64);
    expect(snapshot.recentPhysicalCancellations[0]?.sequence).toBe(2);
    expect(snapshot.recentPhysicalCancellations.at(-1)?.sequence).toBe(65);
    expect(snapshot.maxRecentPhysicalCancellations).toBe(64);
  });
});
