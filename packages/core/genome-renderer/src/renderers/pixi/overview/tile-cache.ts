export interface TileCacheOptions<V> {
  capacity: number;
  dispose: (key: string, value: V) => void;
}

export class TileCache<V> {
  private readonly map = new Map<string, V>();
  private readonly capacity: number;
  private readonly disposeFn: (key: string, value: V) => void;

  constructor(opts: TileCacheOptions<V>) {
    this.capacity = opts.capacity;
    this.disposeFn = opts.dispose;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      const previous = this.map.get(key) as V;
      this.map.delete(key);
      if (!Object.is(previous, value)) {
        this.disposeFn(key, previous);
      }
    }
    this.map.set(key, value);
    this.evictToCapacity();
  }

  delete(key: string): boolean {
    if (!this.map.has(key)) return false;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.disposeFn(key, value);
    return true;
  }

  touch(key: string): void {
    if (!this.map.has(key)) return;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  clear(): void {
    for (const [key, value] of this.map) {
      this.disposeFn(key, value);
    }
    this.map.clear();
  }

  private evictToCapacity(): void {
    if (this.capacity <= 0) return;
    while (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldestValue = this.map.get(oldestKey) as V;
      this.map.delete(oldestKey);
      this.disposeFn(oldestKey, oldestValue);
    }
  }
}
