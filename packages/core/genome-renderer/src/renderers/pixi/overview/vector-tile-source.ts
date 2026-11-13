import type { RetainedLinearTranscriptLayer } from './retained-linear-transcript-layer';
import type { DirectionalBlock } from './transcript-glyph-vertices';
import { type TileCoord, tileKey } from './tile-pyramid-coords';
import { vectorTileDataKey } from './vector-tile-coords';

export { vectorTileDataKey, blocksOverlappingRange } from './vector-tile-coords';

export interface VectorTileSourceDeps {
  makeLayer: () => RetainedLinearTranscriptLayer;
}

export class VectorTileSource {
  private readonly makeLayer: () => RetainedLinearTranscriptLayer;
  private readonly inUse = new Map<string, RetainedLinearTranscriptLayer>();
  private readonly free: RetainedLinearTranscriptLayer[] = [];

  acquireCount = 0;

  constructor(deps: VectorTileSourceDeps) {
    this.makeLayer = deps.makeLayer;
  }

  acquire(
    coord: TileCoord,
    blocks: ReadonlyArray<DirectionalBlock>
  ): RetainedLinearTranscriptLayer {
    const key = tileKey(coord.z, coord.i);
    const dataKey = vectorTileDataKey(coord);

    const existing = this.inUse.get(key);
    const layer = existing ?? this.free.pop() ?? this.makeLayer();
    layer.syncData(dataKey, blocks);
    this.inUse.set(key, layer);

    this.acquireCount += 1;
    if (typeof globalThis !== 'undefined') {
      const g = globalThis as typeof globalThis & { __webglVectorTileCount?: number };
      g.__webglVectorTileCount = (g.__webglVectorTileCount ?? 0) + 1;
    }

    return layer;
  }

  release(coord: TileCoord): void {
    const key = tileKey(coord.z, coord.i);
    const layer = this.inUse.get(key);
    if (layer === undefined) return;
    this.inUse.delete(key);
    layer.hide();
    this.free.push(layer);
  }

  has(coord: TileCoord): boolean {
    return this.inUse.has(tileKey(coord.z, coord.i));
  }

  get(coord: TileCoord): RetainedLinearTranscriptLayer | undefined {
    return this.inUse.get(tileKey(coord.z, coord.i));
  }

  inUseKeys(): string[] {
    return [...this.inUse.keys()];
  }

  destroy(): void {
    for (const layer of this.inUse.values()) layer.destroy();
    for (const layer of this.free) layer.destroy();
    this.inUse.clear();
    this.free.length = 0;
  }
}
