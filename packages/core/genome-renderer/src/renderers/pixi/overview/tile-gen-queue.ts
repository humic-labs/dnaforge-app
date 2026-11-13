import type { TileCoord } from './tile-pyramid-coords';
import { tileKey } from './tile-pyramid-coords';

export interface TileGenQueueOptions {
  build: (coord: TileCoord) => Promise<void>;
  maxConcurrent?: number;
  onError?: (coord: TileCoord, error: unknown) => void;
}

interface QueueEntry {
  coord: TileCoord;
  key: string;
  priority: number;
  dead: boolean;
}

export class TileGenQueue {
  private readonly build: (coord: TileCoord) => Promise<void>;
  private readonly maxConcurrent: number;
  private readonly onError?: (coord: TileCoord, error: unknown) => void;

  private readonly heap: QueueEntry[] = [];
  private readonly queued = new Map<string, QueueEntry>();
  private readonly inFlight = new Set<string>();

  constructor(opts: TileGenQueueOptions) {
    this.build = opts.build;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 1);
    this.onError = opts.onError;
  }

  get queuedCount(): number {
    return this.queued.size;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  has(coord: TileCoord): boolean {
    const key = tileKey(coord.z, coord.i);
    return this.queued.has(key) || this.inFlight.has(key);
  }

  enqueue(coord: TileCoord, priority: number): void {
    const key = tileKey(coord.z, coord.i);

    if (this.inFlight.has(key)) return;

    const existing = this.queued.get(key);
    if (existing) {
      if (existing.priority === priority) return;
      existing.dead = true;
      const fresh: QueueEntry = { coord, key, priority, dead: false };
      this.queued.set(key, fresh);
      this.heapPush(fresh);
      return;
    }

    const entry: QueueEntry = { coord, key, priority, dead: false };
    this.queued.set(key, entry);
    this.heapPush(entry);
  }

  drain(maxStarts = 1): number {
    let started = 0;
    while (started < maxStarts && this.inFlight.size < this.maxConcurrent && this.queued.size > 0) {
      const entry = this.heapPopLive();
      if (!entry) break;
      this.queued.delete(entry.key);
      this.startBuild(entry.coord, entry.key);
      started += 1;
    }
    return started;
  }

  cancelOutside(keep: (coord: TileCoord) => boolean): void {
    for (const entry of this.queued.values()) {
      if (!keep(entry.coord)) {
        entry.dead = true;
        this.queued.delete(entry.key);
      }
    }
    this.maybeCompact();
  }

  private startBuild(coord: TileCoord, key: string): void {
    this.inFlight.add(key);
    void this.build(coord).then(
      () => {
        this.inFlight.delete(key);
      },
      (error: unknown) => {
        this.inFlight.delete(key);
        this.onError?.(coord, error);
      }
    );
  }

  private heapPush(entry: QueueEntry): void {
    const heap = this.heap;
    heap.push(entry);
    let idx = heap.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (heap[parent].priority <= heap[idx].priority) break;
      this.swap(idx, parent);
      idx = parent;
    }
  }

  private heapPopLive(): QueueEntry | undefined {
    const heap = this.heap;
    while (heap.length > 0) {
      const top = this.heapPop();
      if (top && !top.dead) return top;
    }
    return undefined;
  }

  private heapPop(): QueueEntry | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftDown(start: number): void {
    const heap = this.heap;
    const n = heap.length;
    let idx = start;
    for (;;) {
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      let smallest = idx;
      if (left < n && heap[left].priority < heap[smallest].priority) {
        smallest = left;
      }
      if (right < n && heap[right].priority < heap[smallest].priority) {
        smallest = right;
      }
      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const heap = this.heap;
    const tmp = heap[a];
    heap[a] = heap[b];
    heap[b] = tmp;
  }

  private maybeCompact(): void {
    if (this.heap.length <= 2 * this.queued.size) return;
    const live: QueueEntry[] = [];
    for (const entry of this.heap) {
      if (!entry.dead) live.push(entry);
    }
    this.heap.length = 0;
    for (const entry of live) this.heapPush(entry);
  }
}
