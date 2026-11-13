// @vitest-environment jsdom
import { Container } from 'pixi.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VectorTilePyramidCompositor } from './vector-tile-compositor';
import type { RetainedLinearTranscriptLayer } from './retained-linear-transcript-layer';
import type { ViewerRenderContract } from './viewer-render-contract';
import type { DirectionalBlock } from './transcript-glyph-vertices';

interface MockLayer {
  readonly id: number;
  container: Container;
  destroyed: boolean;
  retainedBlockCount: number;
  syncCalls: number;
  hideCalls: number;
  updateCameraCalls: number;
  visibleAfterLastUpdate: boolean;
  readonly isPresenting: boolean;
  syncData(key: string, blocks: ReadonlyArray<DirectionalBlock>): boolean;
  updateCamera(): void;
  hide(): void;
  destroy(): void;
}

function mockLayerFactory() {
  const made: MockLayer[] = [];
  const makeLayer = vi.fn((): RetainedLinearTranscriptLayer => {
    const container = new Container();
    container.visible = false;
    const layer: MockLayer = {
      id: made.length,
      container,
      destroyed: false,
      retainedBlockCount: 0,
      syncCalls: 0,
      hideCalls: 0,
      updateCameraCalls: 0,
      visibleAfterLastUpdate: false,
      get isPresenting() {
        return this.container.visible && this.retainedBlockCount > 0;
      },
      syncData(_key: string, blocks: ReadonlyArray<DirectionalBlock>) {
        this.syncCalls += 1;
        this.retainedBlockCount = blocks.length;
        return true;
      },
      updateCamera() {
        this.updateCameraCalls += 1;
      },
      hide() {
        this.hideCalls += 1;
        this.container.visible = false;
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

const CONTRACT = {} as ViewerRenderContract;

function blocksFor(_startBp: number, _endBp: number): ReadonlyArray<DirectionalBlock> {
  return [
    {
      startBp: 0,
      endBp: 1,
      offsetCenter: 0,
      halfH: 7,
      color: 0,
      role: 'transcript:intron' as const,
      alpha: 1,
      cdsFade: 0,
      dirSign: 0,
    },
  ];
}

function depsFor(buildBlocksForRange = vi.fn(blocksFor)) {
  return {
    buildBlocksForRange,
    viewportW: 1000,
    viewportH: 400,
    cdsDetail: 0,
  };
}

function emptyDepsFor() {
  return depsFor(vi.fn(() => []));
}

const WIDE_CAMERA = {
  L: 1_000_000_000,
  viewStartBp: 0,
  viewEndBp: 1_000_000,
  screenPx: 1000,
  maxLevel: 24,
};

describe('VectorTilePyramidCompositor — per-frame orchestration', () => {
  beforeEach(() => {
    (globalThis as { __webglVectorTileCount?: number }).__webglVectorTileCount = 0;
  });

  it('yields (returns false) and builds nothing below the crossover', () => {
    const { makeLayer } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer });
    const owned = c.compositeVector(WIDE_CAMERA, CONTRACT, 24, depsFor());
    expect(owned).toBe(false);
    expect(makeLayer).not.toHaveBeenCalled();
    expect(c.buildCount).toBe(0);
    expect(c.container.visible).toBe(false);
  });

  it('prewarms at/above the crossover without owning the band until coverage is complete', () => {
    const { makeLayer, made } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer });
    const owned = c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor());
    expect(owned).toBe(false);
    expect(c.buildCount).toBe(1);
    expect(c.coverageComplete).toBe(false);
    expect(c.container.visible).toBe(false);
    expect(c.isPresenting).toBe(false);
    expect(made).toHaveLength(1);
    expect(made[0].syncCalls).toBe(1);
    expect(made[0].updateCameraCalls).toBe(1);
    expect(made[0].container.parent).toBe(c.container);
  });

  it('streams in one new tile per frame and reprojects the already-built ones', () => {
    const { makeLayer, made } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer });

    c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor());
    expect(c.buildCount).toBe(1);
    const aUpdatesAfterF1 = made[0].updateCameraCalls;

    c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor());
    expect(c.buildCount).toBe(2);
    expect(made).toHaveLength(2);
    expect(made[0].updateCameraCalls).toBe(aUpdatesAfterF1 + 1);
    expect(made[0].syncCalls).toBe(1);
  });

  it('reports partial visible transcript-tile coverage until every visible tile is built', () => {
    const { makeLayer } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer });

    c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor());

    expect(c.expectedVisibleTileCount).toBeGreaterThan(1);
    expect(c.builtVisibleTileCount).toBe(1);
    expect(c.missingVisibleTileCount).toBe(c.expectedVisibleTileCount - 1);
    expect(c.coverageComplete).toBe(false);
    expect(c.visibleLayerCount).toBe(0);
    expect(c.isPresenting).toBe(false);

    for (let frame = 1; frame < c.expectedVisibleTileCount; frame += 1) {
      const owned = c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor());
      if (frame < c.expectedVisibleTileCount - 1) expect(owned).toBe(false);
    }

    expect(c.builtVisibleTileCount).toBe(c.expectedVisibleTileCount);
    expect(c.missingVisibleTileCount).toBe(0);
    expect(c.coverageComplete).toBe(true);
    expect(c.visibleLayerCount).toBe(c.expectedVisibleTileCount);
    expect(c.isPresenting).toBe(true);
  });

  it('does not present resident empty tiles as exact vector annotation pixels', () => {
    const { makeLayer } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer });
    const deps = emptyDepsFor();

    let owned = false;
    do {
      owned = c.compositeVector(WIDE_CAMERA, CONTRACT, 0, deps);
    } while (!c.coverageComplete);

    expect(owned).toBe(false);
    expect(c.builtVisibleTileCount).toBe(c.expectedVisibleTileCount);
    expect(c.missingVisibleTileCount).toBe(0);
    expect(c.coverageComplete).toBe(true);
    expect(c.visibleLayerCount).toBe(0);
    expect(c.isPresenting).toBe(false);
    expect(c.container.visible).toBe(false);
  });

  it('builds each tile from ONLY its own bp window (bounded per-tile build)', () => {
    const { makeLayer } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer });
    const buildBlocksForRange = vi.fn(blocksFor);

    c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor(buildBlocksForRange));

    expect(buildBlocksForRange).toHaveBeenCalledTimes(1);
    const call = buildBlocksForRange.mock.calls[0];
    expect(call).toBeDefined();
    const [startBp, endBp] = call;
    expect(endBp - startBp).toBeLessThan(WIDE_CAMERA.L);
    expect(startBp).toBeGreaterThanOrEqual(0);
    expect(endBp).toBeGreaterThan(startBp);
  });

  it('pools layers across a steady pan: layers constructed stays bounded far below builds', () => {
    const { makeLayer, made } = mockLayerFactory();
    const poolCap = 8;
    const c = new VectorTilePyramidCompositor({ makeLayer, poolCap });

    const winBp = 1500;
    let made0 = 0;
    for (let i = 0; i < 30; i++) {
      const start = i * 1000;
      c.compositeVector(
        { L: 64_000, viewStartBp: start, viewEndBp: start + winBp, screenPx: 1000, maxLevel: 6 },
        CONTRACT,
        0,
        depsFor()
      );
      if (i === 0) made0 = made.length;
    }

    expect(c.buildCount).toBeGreaterThanOrEqual(20);
    expect(made.length).toBeLessThanOrEqual(poolCap + 4);
    expect(made.length).toBeLessThan(c.buildCount);
    expect(made0).toBeGreaterThan(0);
    expect(made.every((m) => !m.destroyed)).toBe(true);
  });

  it('caps the live pool: eviction releases (pools) the LRU tile, never destroys it', () => {
    const { makeLayer, made } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer, poolCap: 2 });

    const oneTileAt = (start: number) => ({
      L: 3000,
      viewStartBp: start,
      viewEndBp: start + 10,
      screenPx: 100,
      maxLevel: 2,
    });

    c.compositeVector(oneTileAt(10), CONTRACT, 0, depsFor());
    c.compositeVector(oneTileAt(800), CONTRACT, 0, depsFor());
    c.compositeVector(oneTileAt(1600), CONTRACT, 0, depsFor());

    expect(c.buildCount).toBe(3);
    expect(made.every((m) => !m.destroyed)).toBe(true);
    expect(made.some((m) => m.hideCalls > 0)).toBe(true);
  });

  it('destroy() destroys every pooled + in-use layer and is the only path that frees meshes', () => {
    const { makeLayer, made } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer });

    c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor());
    expect(made.every((m) => !m.destroyed)).toBe(true);

    c.destroy();
    expect(made.every((m) => m.destroyed)).toBe(true);
  });

  it('mirrors __webglVectorTileCount via the underlying pool acquireCount', () => {
    const g = globalThis as { __webglVectorTileCount?: number };
    const { makeLayer } = mockLayerFactory();
    const c = new VectorTilePyramidCompositor({ makeLayer });

    c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor());
    c.compositeVector(WIDE_CAMERA, CONTRACT, 0, depsFor());

    expect(g.__webglVectorTileCount).toBe(2);
  });
});
