import { describe, expect, it, vi } from 'vitest';
import { VectorTileSource } from './vector-tile-source';
import { vectorTileDataKey } from './vector-tile-coords';
import type { RetainedLinearTranscriptLayer } from './retained-linear-transcript-layer';
import type { DirectionalBlock } from './transcript-glyph-vertices';

function block(startBp: number, endBp: number): DirectionalBlock {
  return {
    startBp,
    endBp,
    offsetCenter: 0,
    halfH: 7,
    color: 0x000000,
    role: 'transcript:intron' as const,
    alpha: 1,
    cdsFade: 0,
    dirSign: 0,
  };
}

interface MockLayer {
  readonly id: number;
  destroyed: boolean;
  syncCalls: Array<{ key: string; blocks: ReadonlyArray<DirectionalBlock> }>;
  hideCalls: number;
  updateCameraCalls: number;
  syncData(key: string, blocks: ReadonlyArray<DirectionalBlock>): boolean;
  hide(): void;
  updateCamera(): void;
  destroy(): void;
}

function mockLayerFactory() {
  const made: MockLayer[] = [];
  const makeLayer = vi.fn((): RetainedLinearTranscriptLayer => {
    const layer: MockLayer = {
      id: made.length,
      destroyed: false,
      syncCalls: [],
      hideCalls: 0,
      updateCameraCalls: 0,
      syncData(key, blocks) {
        this.syncCalls.push({ key, blocks });
        return true;
      },
      hide() {
        this.hideCalls += 1;
      },
      updateCamera() {
        this.updateCameraCalls += 1;
      },
      destroy() {
        this.destroyed = true;
      },
    };
    made.push(layer);
    return layer as unknown as RetainedLinearTranscriptLayer;
  });
  return { makeLayer, made };
}

function asMock(layer: RetainedLinearTranscriptLayer): MockLayer {
  return layer as unknown as MockLayer;
}

describe('VectorTileSource — pool semantics', () => {
  it('acquire of a new coord makes a new layer and syncs the tile-local key + blocks', () => {
    const { makeLayer, made } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });
    const coord = { z: 6, i: 17 };
    const blocks = [block(100, 200)];

    const layer = source.acquire(coord, blocks);

    expect(makeLayer).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
    expect(asMock(layer).syncCalls).toEqual([{ key: vectorTileDataKey(coord), blocks }]);
    expect(source.acquireCount).toBe(1);
  });

  it('acquire reuses a freed layer — no extra makeLayer', () => {
    const { makeLayer, made } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });
    const a = { z: 6, i: 1 };
    const b = { z: 6, i: 2 };

    const first = source.acquire(a, [block(0, 100)]);
    source.release(a);
    const second = source.acquire(b, [block(100, 200)]);

    expect(makeLayer).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
    expect(second).toBe(first);
    expect(asMock(second).syncCalls.at(-1)).toEqual({
      key: vectorTileDataKey(b),
      blocks: [block(100, 200)],
    });
  });

  it('acquire of a new coord while none is free makes a new layer', () => {
    const { makeLayer, made } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });

    const l1 = source.acquire({ z: 6, i: 1 }, [block(0, 100)]);
    const l2 = source.acquire({ z: 6, i: 2 }, [block(100, 200)]);

    expect(makeLayer).toHaveBeenCalledTimes(2);
    expect(made).toHaveLength(2);
    expect(l2).not.toBe(l1);
    expect(source.inUseKeys()).toEqual(['6/1', '6/2']);
  });

  it('release hides the layer and frees it for reuse', () => {
    const { makeLayer } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });
    const coord = { z: 6, i: 5 };

    const layer = source.acquire(coord, [block(0, 100)]);
    expect(asMock(layer).hideCalls).toBe(0);

    source.release(coord);

    expect(asMock(layer).hideCalls).toBe(1);
    expect(asMock(layer).destroyed).toBe(false);
    expect(source.has(coord)).toBe(false);
    expect(source.get(coord)).toBeUndefined();
    expect(source.inUseKeys()).toEqual([]);
  });

  it('release is idempotent (releasing a non-in-use tile is a no-op)', () => {
    const { makeLayer, made } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });
    const coord = { z: 6, i: 5 };

    source.acquire(coord, [block(0, 100)]);
    source.release(coord);
    source.release(coord);
    source.release({ z: 3, i: 0 });

    expect(made[0].hideCalls).toBe(1);
    expect(source.inUseKeys()).toEqual([]);
  });

  it('re-acquiring an in-use coord returns the same layer and re-syncs (no new layer)', () => {
    const { makeLayer } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });
    const coord = { z: 6, i: 9 };

    const first = source.acquire(coord, [block(0, 100)]);
    const again = source.acquire(coord, [block(0, 200)]);

    expect(again).toBe(first);
    expect(makeLayer).toHaveBeenCalledTimes(1);
    expect(asMock(again).syncCalls.at(-1)).toEqual({
      key: vectorTileDataKey(coord),
      blocks: [block(0, 200)],
    });
    expect(source.inUseKeys()).toEqual(['6/9']);
  });

  it('has / get / inUseKeys reflect the in-use set', () => {
    const { makeLayer } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });
    const a = { z: 6, i: 1 };
    const b = { z: 6, i: 2 };

    expect(source.has(a)).toBe(false);
    expect(source.get(a)).toBeUndefined();
    expect(source.inUseKeys()).toEqual([]);

    const la = source.acquire(a, [block(0, 100)]);
    const lb = source.acquire(b, [block(100, 200)]);

    expect(source.has(a)).toBe(true);
    expect(source.has(b)).toBe(true);
    expect(source.get(a)).toBe(la);
    expect(source.get(b)).toBe(lb);
    expect(source.inUseKeys()).toEqual(['6/1', '6/2']);

    source.release(a);
    expect(source.has(a)).toBe(false);
    expect(source.inUseKeys()).toEqual(['6/2']);
  });

  it('destroy destroys all pooled and in-use layers', () => {
    const { makeLayer, made } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });

    source.acquire({ z: 6, i: 1 }, [block(0, 100)]);
    const freed = source.acquire({ z: 6, i: 2 }, [block(100, 200)]);
    source.release({ z: 6, i: 2 });

    expect(made).toHaveLength(2);
    expect(made.every((m) => !m.destroyed)).toBe(true);

    source.destroy();

    expect(made.every((m) => m.destroyed)).toBe(true);
    expect(asMock(freed).destroyed).toBe(true);
    expect(source.inUseKeys()).toEqual([]);
  });

  it('acquireCount bumps once per acquire and mirrors __webglVectorTileCount', () => {
    const g = globalThis as unknown as { __webglVectorTileCount?: number };
    g.__webglVectorTileCount = 0;

    const { makeLayer } = mockLayerFactory();
    const source = new VectorTileSource({ makeLayer });

    source.acquire({ z: 6, i: 1 }, [block(0, 100)]);
    source.acquire({ z: 6, i: 2 }, [block(100, 200)]);
    source.acquire({ z: 6, i: 1 }, [block(0, 100)]);

    expect(source.acquireCount).toBe(3);
    expect(g.__webglVectorTileCount).toBe(3);
  });
});

describe('vectorTileDataKey', () => {
  it('is distinct per (z, i) and namespaced under vector-tile:', () => {
    expect(vectorTileDataKey({ z: 5, i: 17 })).toBe('vector-tile:5/17');
    expect(vectorTileDataKey({ z: 0, i: 0 })).toBe('vector-tile:0/0');
  });

  it('two distinct tiles never collide', () => {
    expect(vectorTileDataKey({ z: 6, i: 1 })).not.toBe(vectorTileDataKey({ z: 6, i: 2 }));
  });

  it('does not collide with the raster-tile namespace', () => {
    expect(vectorTileDataKey({ z: 6, i: 3 })).not.toBe('raster-tile:6/3');
  });
});
