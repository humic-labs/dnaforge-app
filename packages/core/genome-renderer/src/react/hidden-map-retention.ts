export const MAX_LIVE_HIDDEN_MAPS = 3;

export type HiddenMapEvictionReason = 'lru-evict';
export type HiddenMapTeardown = (reason: HiddenMapEvictionReason) => void;

export class HiddenMapRetentionPool {
  private readonly retained = new Map<string, HiddenMapTeardown>();

  constructor(readonly maxRetained: number) {
    if (!Number.isInteger(maxRetained) || maxRetained < 0) {
      throw new Error(`maxRetained must be a non-negative integer, got ${maxRetained}`);
    }
  }

  retain(instanceId: string, teardown: HiddenMapTeardown): void {
    this.retained.delete(instanceId);
    this.retained.set(instanceId, teardown);

    while (this.retained.size > this.maxRetained) {
      const oldest = this.retained.keys().next().value;
      if (oldest === undefined) return;
      const evict = this.retained.get(oldest);
      this.retained.delete(oldest);
      evict?.('lru-evict');
    }
  }

  release(instanceId: string): void {
    this.retained.delete(instanceId);
  }

  get size(): number {
    return this.retained.size;
  }

  instanceIds(): string[] {
    return [...this.retained.keys()];
  }
}

export const hiddenMapRetention = new HiddenMapRetentionPool(MAX_LIVE_HIDDEN_MAPS);
