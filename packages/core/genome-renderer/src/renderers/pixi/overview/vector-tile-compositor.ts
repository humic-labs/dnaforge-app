import { Container } from 'pixi.js';
import type { ViewerRenderContract } from './viewer-render-contract';
import type { DirectionalBlock } from './transcript-glyph-vertices';
import type { RetainedLinearTranscriptLayer } from './retained-linear-transcript-layer';
import { VectorTileSource } from './vector-tile-source';
import { TileCache } from './tile-cache';
import {
  selectLevel,
  tileKey,
  tileRangeBp,
  visibleTiles,
  type TileCoord,
} from './tile-pyramid-coords';

const DEFAULT_TILE_PX = 512;

const DEFAULT_TILE_POOL_CAP = 32;

export interface CompositeVectorDeps {
  buildBlocksForRange: (startBp: number, endBp: number) => ReadonlyArray<DirectionalBlock>;
  viewportW: number;
  viewportH: number;
  cdsDetail: number;
  tilePx?: number;
}

export interface CompositeVectorCamera {
  L: number;
  viewStartBp: number;
  viewEndBp: number;
  screenPx: number;
  maxLevel: number;
}

export interface VectorTilePyramidCompositorDeps {
  makeLayer: () => RetainedLinearTranscriptLayer;
  poolCap?: number;
}

interface VectorTileEntry {
  coord: TileCoord;
}

export class VectorTilePyramidCompositor {
  readonly container = new Container();

  private readonly source: VectorTileSource;
  private readonly live: TileCache<VectorTileEntry>;

  compositeCount = 0;
  buildCount = 0;
  coverageLevel: number | null = null;
  visibleTileFirst: number | null = null;
  visibleTileLast: number | null = null;
  expectedVisibleTileCount = 0;
  builtVisibleTileCount = 0;
  missingVisibleTileCount = 0;
  presentingVisibleTileCount = 0;
  presentingBlockCount = 0;
  coverageComplete = false;

  get isPresenting(): boolean {
    if (!this.container.visible) return false;
    return this.coverageComplete && this.presentingVisibleTileCount > 0;
  }

  get visibleLayerCount(): number {
    if (!this.container.visible) return 0;
    return this.presentingVisibleTileCount;
  }

  presentingTileRanges(L: number): Array<{ startBp: number; endBp: number }> {
    if (!this.isPresenting) return [];
    const ranges: Array<{ startBp: number; endBp: number }> = [];
    for (const key of this.live.keys()) {
      const coord = parseTileKey(key);
      if (coord === null) continue;
      if (this.coverageLevel === null || coord.z !== this.coverageLevel) continue;
      if (
        this.visibleTileFirst !== null &&
        this.visibleTileLast !== null &&
        (coord.i < this.visibleTileFirst || coord.i > this.visibleTileLast)
      ) {
        continue;
      }
      const { startBp, endBp } = tileRangeBp(L, coord.z, coord.i);
      const layer = this.source.get(coord);
      if (!layer?.isPresenting) continue;
      ranges.push({ startBp, endBp });
    }
    return ranges;
  }

  constructor(deps: VectorTilePyramidCompositorDeps) {
    this.container.eventMode = 'none';
    this.source = new VectorTileSource({ makeLayer: deps.makeLayer });
    this.live = new TileCache<VectorTileEntry>({
      capacity: deps.poolCap ?? DEFAULT_TILE_POOL_CAP,
      dispose: (_key, entry) => this.source.release(entry.coord),
    });
  }

  compositeVector(
    camera: CompositeVectorCamera,
    liveContract: ViewerRenderContract,
    zXover: number,
    deps: CompositeVectorDeps
  ): boolean {
    const tilePx = deps.tilePx ?? DEFAULT_TILE_PX;
    if (camera.L <= 0) {
      this.hideAll();
      this.container.visible = false;
      return false;
    }

    const level = selectLevel({
      L: camera.L,
      visibleBp: Math.max(1, camera.viewEndBp - camera.viewStartBp),
      screenPx: Math.max(1, camera.screenPx),
      tilePx,
      maxLevel: camera.maxLevel,
    });

    if (level < zXover) {
      this.hideAll();
      this.container.visible = false;
      return false;
    }

    const range = visibleTiles(camera.L, level, camera.viewStartBp, camera.viewEndBp);
    this.coverageLevel = level;
    this.visibleTileFirst = range.first;
    this.visibleTileLast = range.last;
    this.expectedVisibleTileCount = Math.max(0, range.last - range.first + 1);

    const inView = new Set<string>();
    let firstMissing: TileCoord | null = null;
    for (let i = range.first; i <= range.last; i++) {
      const coord: TileCoord = { z: level, i };
      const key = tileKey(level, i);
      inView.add(key);
      const layer = this.source.get(coord);
      if (layer) {
        layer.updateCamera(liveContract, deps.viewportW, deps.viewportH, deps.cdsDetail);
        this.showLayer(layer);
        this.live.touch(key);
      } else if (firstMissing === null) {
        firstMissing = coord;
      }
    }

    if (firstMissing !== null) {
      this.buildTile(firstMissing, camera.L, liveContract, deps);
      inView.add(tileKey(firstMissing.z, firstMissing.i));
    }

    const lo = Math.max(0, range.first - 1);
    const hi = Math.min(2 ** level - 1, range.last + 1);
    for (const key of this.live.keys()) {
      const coord = parseTileKey(key);
      const keep = coord !== null && coord.z === level && coord.i >= lo && coord.i <= hi;
      if (!keep) this.live.delete(key);
    }

    this.refreshVisibleCoverage(range, level);
    const ownsBand = this.coverageComplete && this.presentingVisibleTileCount > 0;
    this.container.visible = ownsBand;
    if (ownsBand) this.compositeCount += 1;
    return ownsBand;
  }

  private refreshVisibleCoverage(range: { first: number; last: number }, level: number): void {
    let built = 0;
    let presenting = 0;
    let presentingBlocks = 0;
    for (let i = range.first; i <= range.last; i += 1) {
      const layer = this.source.get({ z: level, i });
      if (!layer) continue;
      built += 1;
      if (!layer.isPresenting) continue;
      presenting += 1;
      presentingBlocks += layer.retainedBlockCount;
    }
    this.builtVisibleTileCount = built;
    this.presentingVisibleTileCount = presenting;
    this.presentingBlockCount = presentingBlocks;
    this.missingVisibleTileCount = Math.max(0, this.expectedVisibleTileCount - built);
    this.coverageComplete = this.expectedVisibleTileCount > 0 && this.missingVisibleTileCount === 0;
  }

  private buildTile(
    coord: TileCoord,
    L: number,
    liveContract: ViewerRenderContract,
    deps: CompositeVectorDeps
  ): void {
    const { startBp, endBp } = tileRangeBp(L, coord.z, coord.i);
    const blocks = endBp > startBp ? deps.buildBlocksForRange(startBp, endBp) : [];
    const layer = this.source.acquire(coord, blocks);

    if (layer.container.parent !== this.container) {
      this.container.addChild(layer.container);
    }
    layer.updateCamera(liveContract, deps.viewportW, deps.viewportH, deps.cdsDetail);
    this.showLayer(layer);
    this.live.set(tileKey(coord.z, coord.i), { coord });
    this.buildCount += 1;
  }

  private showLayer(layer: RetainedLinearTranscriptLayer): void {
    layer.container.visible = true;
  }

  private hideAll(): void {
    this.live.clear();
    this.resetCoverageDiagnostics();
  }

  hide(): void {
    this.container.visible = false;
    this.resetCoverageDiagnostics();
  }

  resetData(): void {
    this.hideAll();
    this.container.visible = false;
  }

  private resetCoverageDiagnostics(): void {
    this.coverageLevel = null;
    this.visibleTileFirst = null;
    this.visibleTileLast = null;
    this.expectedVisibleTileCount = 0;
    this.builtVisibleTileCount = 0;
    this.missingVisibleTileCount = 0;
    this.presentingVisibleTileCount = 0;
    this.presentingBlockCount = 0;
    this.coverageComplete = false;
  }

  destroy(): void {
    this.live.clear();
    this.source.destroy();
    this.container.destroy({ children: true });
  }
}

function parseTileKey(key: string): TileCoord | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  const z = Number.parseInt(key.slice(0, slash), 10);
  const i = Number.parseInt(key.slice(slash + 1), 10);
  if (!Number.isFinite(z) || !Number.isFinite(i)) return null;
  return { z, i };
}
