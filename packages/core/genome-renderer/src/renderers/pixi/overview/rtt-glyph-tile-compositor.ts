import { Container, RenderTexture, type Renderer, Sprite } from 'pixi.js';
import type { ViewerRenderContract } from './viewer-render-contract';
import type { RetainedLinearTranscriptLayer } from './retained-linear-transcript-layer';
import type { DirectionalBlock } from './transcript-glyph-vertices';
import { TileCache } from './tile-cache';
import { selectLevel, tileKey, tileRangeBp, visibleTiles } from './tile-pyramid-coords';

const DEFAULT_TILE_PX = 512;
const DEFAULT_TILE_CACHE_CAPACITY = 48;
const DEFAULT_RT_POOL_CAP = 16;
const IDLE_SLICE_BUDGET_MS = 6;
const IDLE_TILES_PER_SLICE = 2;
const IDLE_MIN_REMAINING_MS = 2;
const PREFETCH_RING_TILES = 1;
const MAX_MATCH_DENSITY_TILE_CSS_W = 2048;

export interface RttGlyphCamera {
  L: number;
  viewStartBp: number;
  viewEndBp: number;
  screenPx: number;
  maxLevel: number;
}

export interface RttGlyphDeps {
  renderer: Renderer;
  bakeLayer: RetainedLinearTranscriptLayer;
  buildBlocksForRange: (startBp: number, endBp: number) => ReadonlyArray<DirectionalBlock>;
  resolution: number;
  viewportH: number;
  spineOffsetPx: number;
  cdsDetail: number;
  tilePx?: number;
  matchScreenDensity: boolean;
  scaleMode: 'nearest' | 'linear';
  antialias: boolean;
  supersample?: number;
}

interface PooledRt {
  sprite: Sprite;
  rt: RenderTexture;
  texWidth: number;
  texHeight: number;
  resolution: number;
  antialias: boolean;
}

interface RttTileEntry extends PooledRt {
  z: number;
  i: number;
  startBp: number;
  endBp: number;
  cssWidth: number;
  cssHeight: number;
  epoch: number;
}

interface RttLruEntry {
  key: string;
}

interface BakeContext {
  camera: RttGlyphCamera;
  deps: RttGlyphDeps;
  targetLevel: number;
  pixelsPerBp: number;
}

type IdleDeadline = { timeRemaining: () => number; didTimeout: boolean };
type IdleGlobal = typeof globalThis & {
  requestIdleCallback?: (cb: (d: IdleDeadline) => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class RttGlyphTilePyramidCompositor {
  readonly container = new Container();

  private readonly entries = new Map<string, RttTileEntry>();
  private readonly lru: TileCache<RttLruEntry>;
  private readonly pool: PooledRt[] = [];

  compositeCount = 0;
  buildCount = 0;
  targetLevel: number | null = null;
  drawLevel: number | null = null;
  presentingTileCount = 0;
  bakedThisFrame = 0;
  bakeMsTotal = 0;
  bakeMsMax = 0;

  private presenting = false;
  private dataEpoch = 0;
  private lastFrameEpoch = 0;

  private bakeCtx: BakeContext | null = null;
  private idleHandle: number | null = null;
  private idleIsTimeout = false;

  constructor(opts: { cacheCapacity?: number } = {}) {
    this.container.eventMode = 'none';
    this.container.visible = false;
    this.lru = new TileCache<RttLruEntry>({
      capacity: opts.cacheCapacity ?? DEFAULT_TILE_CACHE_CAPACITY,
      dispose: (_key, entry) => {
        const tile = this.entries.get(entry.key);
        if (!tile) return;
        this.entries.delete(entry.key);
        this.releaseToPool(tile);
      },
    });
  }

  get isPresenting(): boolean {
    return this.container.visible && this.presenting && this.presentingTileCount > 0;
  }

  get visibleLayerCount(): number {
    return this.isPresenting ? this.presentingTileCount : 0;
  }

  compositeCoarse(
    camera: RttGlyphCamera,
    liveContract: ViewerRenderContract,
    deps: RttGlyphDeps
  ): boolean {
    this.bakedThisFrame = 0;
    if (camera.L <= 0) {
      this.hide();
      return false;
    }
    const tilePx = deps.tilePx ?? DEFAULT_TILE_PX;
    const level = selectLevel({
      L: camera.L,
      visibleBp: Math.max(1, camera.viewEndBp - camera.viewStartBp),
      screenPx: Math.max(1, camera.screenPx),
      tilePx,
      maxLevel: camera.maxLevel,
    });
    this.targetLevel = level;
    this.bakeCtx = { camera, deps, targetLevel: level, pixelsPerBp: liveContract.pixelsPerBp };

    const epochStable = this.dataEpoch === this.lastFrameEpoch;
    this.lastFrameEpoch = this.dataEpoch;

    if (this.deepestCompleteLevel(camera, level) === null && !this.entries.has(tileKey(0, 0))) {
      this.buildTile(camera, 0, 0, deps);
      this.bakedThisFrame += 1;
    }

    const zDraw = this.deepestCompleteLevel(camera, level);
    this.drawLevel = zDraw;

    this.requestIdlePump(epochStable);

    if (zDraw === null) {
      this.hide();
      return false;
    }

    const drawRange = visibleTiles(camera.L, zDraw, camera.viewStartBp, camera.viewEndBp);
    const shown = new Set<string>();
    let drawn = 0;
    for (let i = drawRange.first; i <= drawRange.last; i += 1) {
      const key = tileKey(zDraw, i);
      const entry = this.entries.get(key);
      if (!entry) continue;
      this.positionSprite(entry, liveContract, deps);
      entry.sprite.visible = true;
      shown.add(key);
      this.lru.touch(key);
      drawn += 1;
    }
    const targetRange = visibleTiles(camera.L, level, camera.viewStartBp, camera.viewEndBp);
    for (let i = targetRange.first; i <= targetRange.last; i += 1) {
      this.lru.touch(tileKey(level, i));
    }
    this.lru.touch(tileKey(0, 0));
    for (const [key, entry] of this.entries) {
      if (!shown.has(key)) entry.sprite.visible = false;
    }

    this.presentingTileCount = drawn;
    this.presenting = drawn > 0;
    this.container.visible = drawn > 0;
    if (drawn > 0) this.compositeCount += 1;
    this.publishOracle();
    return drawn > 0;
  }

  private requestIdlePump(epochStable: boolean): void {
    if (this.idleHandle !== null) return;
    if (!this.hasBakeWork(epochStable)) return;
    const g = globalThis as IdleGlobal;
    if (typeof g.requestIdleCallback === 'function') {
      this.idleIsTimeout = false;
      this.idleHandle = g.requestIdleCallback((deadline) => this.pumpIdle(deadline));
    } else {
      this.idleIsTimeout = true;
      this.idleHandle = setTimeout(() => {
        const start = nowMs();
        this.pumpIdle({
          didTimeout: false,
          timeRemaining: () => Math.max(0, IDLE_SLICE_BUDGET_MS - (nowMs() - start)),
        });
      }, 0) as unknown as number;
    }
  }

  private pumpIdle(deadline: IdleDeadline): void {
    this.idleHandle = null;
    const ctx = this.bakeCtx;
    if (!ctx) return;
    const sliceStart = nowMs();
    const remaining = () =>
      Math.min(deadline.timeRemaining(), IDLE_SLICE_BUDGET_MS - (nowMs() - sliceStart));
    const epochStable = this.dataEpoch === this.lastFrameEpoch;
    let baked = 0;
    while (baked < IDLE_TILES_PER_SLICE && remaining() > IDLE_MIN_REMAINING_MS) {
      const next = this.nextBakeTarget(ctx.camera, ctx.targetLevel, epochStable);
      if (!next) break;
      this.buildTile(ctx.camera, next.z, next.i, ctx.deps);
      baked += 1;
    }
    this.publishOracle();
    if (this.hasBakeWork(epochStable)) this.requestIdlePump(epochStable);
  }

  private hasBakeWork(epochStable: boolean): boolean {
    const ctx = this.bakeCtx;
    if (!ctx) return false;
    return this.nextBakeTarget(ctx.camera, ctx.targetLevel, epochStable) !== null;
  }

  private nextBakeTarget(
    camera: RttGlyphCamera,
    target: number,
    epochStable: boolean
  ): { z: number; i: number } | null {
    if (!this.entries.has(tileKey(0, 0))) return { z: 0, i: 0 };
    if (target > 0) {
      const missTarget = this.firstMissingAtLevel(camera, target);
      if (missTarget !== null) return { z: target, i: missTarget };
      const ring = this.firstMissingInRing(camera, target);
      if (ring) return ring;
    }
    if (epochStable) {
      if (target > 0) {
        const staleT = this.firstStaleAtLevel(camera, target);
        if (staleT) return staleT;
      }
      const stale0 = this.firstStaleAtLevel(camera, 0);
      if (stale0) return stale0;
    }
    return null;
  }

  private deepestCompleteLevel(camera: RttGlyphCamera, target: number): number | null {
    for (let z = target; z >= 0; z -= 1) {
      if (this.isLevelComplete(camera, z)) return z;
    }
    return null;
  }

  private isLevelComplete(camera: RttGlyphCamera, z: number): boolean {
    const range = visibleTiles(camera.L, z, camera.viewStartBp, camera.viewEndBp);
    for (let i = range.first; i <= range.last; i += 1) {
      if (!this.entries.has(tileKey(z, i))) return false;
    }
    return true;
  }

  private firstMissingAtLevel(camera: RttGlyphCamera, z: number): number | null {
    const range = visibleTiles(camera.L, z, camera.viewStartBp, camera.viewEndBp);
    for (let i = range.first; i <= range.last; i += 1) {
      if (!this.entries.has(tileKey(z, i))) return i;
    }
    return null;
  }

  private firstMissingInRing(
    camera: RttGlyphCamera,
    target: number
  ): { z: number; i: number } | null {
    const range = visibleTiles(camera.L, target, camera.viewStartBp, camera.viewEndBp);
    const count = 2 ** target;
    for (let d = 1; d <= PREFETCH_RING_TILES; d += 1) {
      const left = range.first - d;
      if (left >= 0 && !this.entries.has(tileKey(target, left))) return { z: target, i: left };
      const right = range.last + d;
      if (right < count && !this.entries.has(tileKey(target, right)))
        return { z: target, i: right };
    }
    return null;
  }

  private firstStaleAtLevel(camera: RttGlyphCamera, z: number): { z: number; i: number } | null {
    const range = visibleTiles(camera.L, z, camera.viewStartBp, camera.viewEndBp);
    for (let i = range.first; i <= range.last; i += 1) {
      const entry = this.entries.get(tileKey(z, i));
      if (entry && entry.epoch < this.dataEpoch) return { z, i };
    }
    return null;
  }

  private buildTile(camera: RttGlyphCamera, z: number, i: number, deps: RttGlyphDeps): void {
    const { startBp, endBp } = tileRangeBp(camera.L, z, i);
    const windowBp = endBp - startBp;
    if (!(windowBp > 0)) return;

    const tileCssW = deps.matchScreenDensity
      ? Math.min(
          MAX_MATCH_DENSITY_TILE_CSS_W,
          Math.max(1, Math.round(windowBp * (this.bakeCtx?.pixelsPerBp ?? 1)))
        )
      : (deps.tilePx ?? DEFAULT_TILE_PX);
    const tileCssH = Math.max(1, deps.viewportH);
    const bakeResolution = Math.max(1, deps.resolution) * Math.max(1, deps.supersample ?? 1);
    const texW = Math.max(1, Math.round(tileCssW * bakeResolution));
    const texH = Math.max(1, Math.round(tileCssH * bakeResolution));

    const key = tileKey(z, i);
    const existing = this.entries.get(key);
    const wasResident = existing !== undefined;
    const triple =
      existing && this.matchesSize(existing, texW, texH, bakeResolution, deps.antialias)
        ? existing
        : this.acquireTriple(tileCssW, tileCssH, bakeResolution, deps.antialias, deps.scaleMode);
    if (existing && existing !== triple) {
      this.releaseToPool(existing);
    }

    const blocks = deps.buildBlocksForRange(startBp, endBp);
    const texPxPerBp = tileCssW / windowBp;
    const tileContract: ViewerRenderContract = {
      projectX: (bp) => (bp - startBp) * texPxPerBp,
      projectY: (offsetPx) => offsetPx + deps.spineOffsetPx,
      pixelsPerBp: texPxPerBp,
      xOriginBp: startBp,
    };
    deps.bakeLayer.syncData(`rtt:${z}/${i}@${this.dataEpoch}`, blocks);
    deps.bakeLayer.updateCamera(tileContract, tileCssW, tileCssH, deps.cdsDetail);

    const t0 = nowMs();
    deps.renderer.render({ container: deps.bakeLayer.container, target: triple.rt, clear: true });
    const dt = nowMs() - t0;
    this.bakeMsTotal += dt;
    if (dt > this.bakeMsMax) this.bakeMsMax = dt;

    triple.sprite.visible = false;
    const entry: RttTileEntry = {
      ...triple,
      z,
      i,
      startBp,
      endBp,
      cssWidth: tileCssW,
      cssHeight: tileCssH,
      epoch: this.dataEpoch,
    };
    this.entries.set(key, entry);
    if (wasResident) this.lru.touch(key);
    else this.lru.set(key, { key });
    this.buildCount += 1;
    if (typeof globalThis !== 'undefined') {
      const g = globalThis as unknown as {
        __webglRttTileCount?: number;
        __rttBakeMsMax?: number;
      };
      g.__webglRttTileCount = (g.__webglRttTileCount ?? 0) + 1;
      g.__rttBakeMsMax = Math.max(g.__rttBakeMsMax ?? 0, +dt.toFixed(2));
    }
  }

  private matchesSize(
    t: PooledRt,
    w: number,
    h: number,
    resolution: number,
    antialias: boolean
  ): boolean {
    return (
      t.texWidth === w &&
      t.texHeight === h &&
      t.resolution === resolution &&
      t.antialias === antialias
    );
  }

  private acquireTriple(
    cssW: number,
    cssH: number,
    resolution: number,
    antialias: boolean,
    scaleMode: 'nearest' | 'linear'
  ): PooledRt {
    const texW = Math.max(1, Math.round(cssW * resolution));
    const texH = Math.max(1, Math.round(cssH * resolution));
    for (let k = this.pool.length - 1; k >= 0; k -= 1) {
      const p = this.pool[k];
      if (this.matchesSize(p, texW, texH, resolution, antialias)) {
        this.pool.splice(k, 1);
        p.rt.source.scaleMode = scaleMode;
        return p;
      }
    }
    const rt = RenderTexture.create({ width: cssW, height: cssH, resolution, antialias });
    rt.source.scaleMode = scaleMode;
    rt.source.alphaMode = 'premultiplied-alpha';
    const sprite = new Sprite(rt);
    sprite.eventMode = 'none';
    sprite.roundPixels = false;
    sprite.visible = false;
    this.container.addChild(sprite);
    return { sprite, rt, texWidth: texW, texHeight: texH, resolution, antialias };
  }

  private releaseToPool(triple: PooledRt): void {
    triple.sprite.visible = false;
    this.pool.push(triple);
    while (this.pool.length > DEFAULT_RT_POOL_CAP) {
      const p = this.pool.shift();
      if (p) {
        p.sprite.destroy();
        p.rt.destroy(true);
      }
    }
  }

  private positionSprite(
    entry: RttTileEntry,
    liveContract: ViewerRenderContract,
    deps: RttGlyphDeps
  ): void {
    const r = Math.max(1, deps.resolution);
    const texPxPerBp = entry.cssWidth / (entry.endBp - entry.startBp);
    const noSnap =
      typeof globalThis !== 'undefined' &&
      (globalThis as unknown as { __WAYPOINT_RTT_NO_SNAP?: boolean }).__WAYPOINT_RTT_NO_SNAP ===
        true;
    const xLive = liveContract.projectX(entry.startBp);
    entry.sprite.x = noSnap ? xLive : Math.round(xLive * r) / r;
    entry.sprite.scale.x = liveContract.pixelsPerBp / texPxPerBp;
    const bandTop = liveContract.projectY(0) - deps.spineOffsetPx;
    entry.sprite.scale.y = -1;
    entry.sprite.y = noSnap
      ? bandTop + entry.cssHeight
      : Math.round((bandTop + entry.cssHeight) * r) / r;
  }

  private publishOracle(): void {
    if (typeof globalThis === 'undefined') return;
    (
      globalThis as unknown as { __webglOverviewGlyphTilesDebug?: unknown }
    ).__webglOverviewGlyphTilesDebug = {
      isPresenting: this.isPresenting,
      backend: 'rtt-glyph',
      targetLevel: this.targetLevel,
      drawLevel: this.drawLevel,
      presentingTileCount: this.presentingTileCount,
      residentTileCount: this.entries.size,
      poolSize: this.pool.length,
      dataEpoch: this.dataEpoch,
      buildCount: this.buildCount,
      compositeCount: this.compositeCount,
      bakedThisFrame: this.bakedThisFrame,
      bakeMsMax: Math.round(this.bakeMsMax * 100) / 100,
      bakeMsTotal: Math.round(this.bakeMsTotal * 100) / 100,
    };
    (globalThis as unknown as { __rttBakedThisFrameMax?: number }).__rttBakedThisFrameMax =
      Math.max(
        (globalThis as unknown as { __rttBakedThisFrameMax?: number }).__rttBakedThisFrameMax ?? 0,
        this.bakedThisFrame
      );
  }

  markDataChanged(): void {
    this.dataEpoch += 1;
  }

  hide(): void {
    this.container.visible = false;
    this.presenting = false;
    this.presentingTileCount = 0;
    this.targetLevel = null;
    this.drawLevel = null;
    this.publishOracle();
  }

  private cancelIdle(): void {
    if (this.idleHandle === null) return;
    const g = globalThis as IdleGlobal;
    if (this.idleIsTimeout)
      clearTimeout(this.idleHandle as unknown as ReturnType<typeof setTimeout>);
    else g.cancelIdleCallback?.(this.idleHandle);
    this.idleHandle = null;
  }

  resetData(): void {
    this.cancelIdle();
    this.lru.clear();
    this.entries.clear();
    this.dataEpoch = 0;
    this.lastFrameEpoch = 0;
    this.bakeCtx = null;
    this.hide();
  }

  destroy(): void {
    this.cancelIdle();
    this.lru.clear();
    this.entries.clear();
    for (const p of this.pool) {
      p.sprite.destroy();
      p.rt.destroy(true);
    }
    this.pool.length = 0;
    this.container.destroy({ children: true });
  }
}
