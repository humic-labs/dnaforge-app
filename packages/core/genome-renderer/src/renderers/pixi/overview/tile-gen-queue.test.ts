import { describe, expect, it, vi } from 'vitest';
import { TileGenQueue } from './tile-gen-queue';
import type { TileCoord } from './tile-pyramid-coords';
import { tileKey } from './tile-pyramid-coords';

interface Deferred {
  coord: TileCoord;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function makeDeferredBuild() {
  const started: TileCoord[] = [];
  const pending = new Map<string, Deferred>();

  const build = vi.fn((coord: TileCoord): Promise<void> => {
    started.push(coord);
    return new Promise<void>((resolve, reject) => {
      pending.set(tileKey(coord.z, coord.i), { coord, resolve, reject });
    });
  });

  async function settle(z: number, i: number): Promise<void> {
    const d = pending.get(tileKey(z, i));
    if (!d) throw new Error(`no pending build for ${tileKey(z, i)}`);
    pending.delete(tileKey(z, i));
    d.resolve();
    await flush();
  }

  async function fail(z: number, i: number, err: unknown): Promise<void> {
    const d = pending.get(tileKey(z, i));
    if (!d) throw new Error(`no pending build for ${tileKey(z, i)}`);
    pending.delete(tileKey(z, i));
    d.reject(err);
    await flush();
  }

  return { build, started, pending, settle, fail };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const C = (z: number, i: number): TileCoord => ({ z, i });

describe('TileGenQueue — dedupe', () => {
  it('enqueuing the same key twice builds it only once', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build });

    q.enqueue(C(5, 17), 0);
    q.enqueue(C(5, 17), 0);

    expect(q.queuedCount).toBe(1);
    expect(q.has(C(5, 17))).toBe(true);

    expect(q.drain()).toBe(1);
    expect(q.drain()).toBe(0);
    expect(fake.build).toHaveBeenCalledTimes(1);
    expect(fake.started).toEqual([C(5, 17)]);
  });

  it('re-enqueuing a queued key updates its priority without duplicating', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build });

    q.enqueue(C(5, 1), 10);
    q.enqueue(C(5, 2), 5);
    q.enqueue(C(5, 1), 1);

    expect(q.queuedCount).toBe(2);

    q.drain();
    expect(fake.started).toEqual([C(5, 1)]);
  });

  it('an in-flight key is ignored on re-enqueue', async () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build });

    q.enqueue(C(3, 0), 0);
    q.drain();
    expect(q.inFlightCount).toBe(1);

    q.enqueue(C(3, 0), 0);
    expect(q.queuedCount).toBe(0);
    expect(q.has(C(3, 0))).toBe(true);

    await fake.settle(3, 0);
    expect(fake.build).toHaveBeenCalledTimes(1);
  });
});

describe('TileGenQueue — priority ordering', () => {
  it('drain starts tiles in ascending priority (lowest number = most urgent)', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 10 });

    q.enqueue(C(6, 30), 30);
    q.enqueue(C(6, 5), 5);
    q.enqueue(C(6, 20), 20);
    q.enqueue(C(6, 1), 1);
    q.enqueue(C(6, 12), 12);

    q.drain();
    q.drain();
    q.drain();
    q.drain();
    q.drain();

    expect(fake.started).toEqual([C(6, 1), C(6, 5), C(6, 12), C(6, 20), C(6, 30)]);
  });

  it('a single drain(n) start batch respects priority across the batch', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 10 });

    q.enqueue(C(4, 9), 9);
    q.enqueue(C(4, 2), 2);
    q.enqueue(C(4, 7), 7);

    expect(q.drain(3)).toBe(3);
    expect(fake.started).toEqual([C(4, 2), C(4, 7), C(4, 9)]);
  });
});

describe('TileGenQueue — concurrency / maxConcurrent', () => {
  it('never exceeds maxConcurrent in flight even when drain asks for more', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 2 });

    q.enqueue(C(5, 0), 0);
    q.enqueue(C(5, 1), 1);
    q.enqueue(C(5, 2), 2);
    q.enqueue(C(5, 3), 3);

    expect(q.drain(4)).toBe(2);
    expect(q.inFlightCount).toBe(2);
    expect(q.queuedCount).toBe(2);

    expect(q.drain(4)).toBe(0);
    expect(q.inFlightCount).toBe(2);
  });

  it('default maxConcurrent is 1 — at most one build in flight', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build });

    q.enqueue(C(5, 0), 0);
    q.enqueue(C(5, 1), 1);

    expect(q.drain(5)).toBe(1);
    expect(q.inFlightCount).toBe(1);
    expect(q.queuedCount).toBe(1);
  });
});

describe('TileGenQueue — in-flight completion frees the slot', () => {
  it('a settled build frees its slot and lets the next drain start the next tile', async () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 1 });

    q.enqueue(C(7, 0), 0);
    q.enqueue(C(7, 1), 1);

    q.drain();
    expect(q.inFlightCount).toBe(1);
    expect(q.drain()).toBe(0);
    expect(fake.started).toEqual([C(7, 0)]);

    await fake.settle(7, 0);
    expect(q.inFlightCount).toBe(0);

    expect(q.drain()).toBe(1);
    expect(fake.started).toEqual([C(7, 0), C(7, 1)]);
  });
});

describe('TileGenQueue — rejected build does not wedge the queue', () => {
  it('a rejected build frees its slot, is dropped, and onError is called', async () => {
    const fake = makeDeferredBuild();
    const onError = vi.fn();
    const q = new TileGenQueue({
      build: fake.build,
      maxConcurrent: 1,
      onError,
    });

    q.enqueue(C(8, 0), 0);
    q.enqueue(C(8, 1), 1);

    q.drain();
    const boom = new Error('raster failed');
    await fake.fail(8, 0, boom);

    expect(q.inFlightCount).toBe(0);
    expect(onError).toHaveBeenCalledWith(C(8, 0), boom);
    expect(q.has(C(8, 0))).toBe(false);

    expect(q.drain()).toBe(1);
    expect(fake.started).toEqual([C(8, 0), C(8, 1)]);
    await fake.settle(8, 1);
    expect(q.inFlightCount).toBe(0);
  });

  it('a rejection without an onError sink still does not wedge the queue', async () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 1 });

    q.enqueue(C(8, 0), 0);
    q.enqueue(C(8, 1), 1);

    q.drain();
    await fake.fail(8, 0, new Error('no sink'));

    expect(q.inFlightCount).toBe(0);
    expect(q.drain()).toBe(1);
    expect(fake.started).toEqual([C(8, 0), C(8, 1)]);
  });
});

describe('TileGenQueue — cancelOutside', () => {
  it('drops only QUEUED tiles failing keep(), leaving kept ones', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 10 });

    q.enqueue(C(5, 0), 0);
    q.enqueue(C(5, 1), 1);
    q.enqueue(C(5, 2), 2);
    q.enqueue(C(5, 3), 3);

    q.cancelOutside((c) => c.i % 2 === 0);

    expect(q.queuedCount).toBe(2);
    expect(q.has(C(5, 0))).toBe(true);
    expect(q.has(C(5, 2))).toBe(true);
    expect(q.has(C(5, 1))).toBe(false);
    expect(q.has(C(5, 3))).toBe(false);

    q.drain(10);
    expect(fake.started).toEqual([C(5, 0), C(5, 2)]);
  });

  it('does NOT cancel in-flight tiles, only queued ones', async () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 1 });

    q.enqueue(C(5, 0), 0);
    q.enqueue(C(5, 1), 1);

    q.drain();
    expect(q.inFlightCount).toBe(1);

    q.cancelOutside(() => false);

    expect(q.inFlightCount).toBe(1);
    expect(q.has(C(5, 0))).toBe(true);
    expect(q.queuedCount).toBe(0);
    expect(q.has(C(5, 1))).toBe(false);

    await fake.settle(5, 0);
    expect(q.inFlightCount).toBe(0);
  });

  it('a re-prioritised entry is still cancellable by coord (no stale-slot leak)', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 10 });

    q.enqueue(C(5, 4), 50);
    q.enqueue(C(5, 4), 1);
    q.enqueue(C(5, 5), 2);

    q.cancelOutside((c) => c.i === 5);

    expect(q.queuedCount).toBe(1);
    expect(q.has(C(5, 4))).toBe(false);
    q.drain(10);
    expect(fake.started).toEqual([C(5, 5)]);
  });
});

describe('TileGenQueue — drain(0)', () => {
  it('drain(0) starts nothing and reports 0', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build, maxConcurrent: 4 });

    q.enqueue(C(5, 0), 0);
    q.enqueue(C(5, 1), 1);

    expect(q.drain(0)).toBe(0);
    expect(q.inFlightCount).toBe(0);
    expect(q.queuedCount).toBe(2);
    expect(fake.build).not.toHaveBeenCalled();
  });

  it('drain on an empty queue returns 0', () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build });
    expect(q.drain()).toBe(0);
    expect(q.drain(5)).toBe(0);
  });
});

describe('TileGenQueue — has / counts', () => {
  it('has reflects queued, then in-flight, then gone after settle', async () => {
    const fake = makeDeferredBuild();
    const q = new TileGenQueue({ build: fake.build });

    expect(q.has(C(9, 9))).toBe(false);
    q.enqueue(C(9, 9), 0);
    expect(q.has(C(9, 9))).toBe(true);
    q.drain();
    expect(q.has(C(9, 9))).toBe(true);
    await fake.settle(9, 9);
    expect(q.has(C(9, 9))).toBe(false);
  });
});
