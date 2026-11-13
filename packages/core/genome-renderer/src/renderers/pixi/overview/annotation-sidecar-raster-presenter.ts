import { BufferImageSource, Container, Sprite, Texture, type Renderer } from 'pixi.js';
import {
  binBp,
  maxLevelForLength,
  tileGlobalEnd,
  tileGlobalStart,
  tileIndex,
  tileSpanBp,
} from '../../../engine/constants';
import {
  annotationSidecarRasterEligibility,
  type AnnotationSidecarRasterEligibilityReason,
} from './annotation-sidecar-raster-eligibility';

const TILE_PX = 1024;
const RASTER_ROW_HEIGHT_PX = 16;

export interface AnnotationSidecarRasterTileLane {
  readonly exonRaster: readonly number[];
  readonly cdsRaster: readonly number[];
}

export interface AnnotationSidecarRasterTile {
  readonly lanes: readonly AnnotationSidecarRasterTileLane[];
  readonly availableTypes?: readonly string[];
}

export interface AnnotationSidecarRasterChromosome {
  readonly chrom: string;
  readonly globalStart: number;
  readonly length: number;
}

export interface AnnotationSidecarRasterTileFetchRequest {
  readonly chrom: AnnotationSidecarRasterChromosome;
  readonly level: number;
  readonly tileIndex: number;
  readonly visibleTypes: readonly string[];
  readonly laneLimit?: number;
}

export interface AnnotationSidecarRasterCamera {
  readonly visibleStartBp: number;
  readonly visibleEndBp: number;
  readonly genomeLength: number;
  readonly visibleTypes: readonly string[];
  readonly pixelsPerBp: number;
  readonly projectX?: (bp: number) => number;
  readonly projectY?: (offsetPx: number) => number;
  readonly laneLimit?: number;
}

export interface AnnotationSidecarRasterPresenterSources {
  readonly parentContainer: Container;
  readonly readRenderer: () => Renderer | null;
  readonly readGenomeLength: () => number;
  readonly readChromosomes: () => readonly AnnotationSidecarRasterChromosome[];
  readonly fetchCoarseTile: (
    request: AnnotationSidecarRasterTileFetchRequest
  ) => Promise<AnnotationSidecarRasterTile>;
}

export type AnnotationSidecarRasterExternalSources = Pick<
  AnnotationSidecarRasterPresenterSources,
  'readGenomeLength' | 'readChromosomes' | 'fetchCoarseTile'
>;

interface TileKey {
  readonly chrom: string;
  readonly level: number;
  readonly tileIndex: number;
  readonly laneLimit: number;
  readonly trackType: string;
}

function tileKeyString(key: TileKey): string {
  return JSON.stringify([key.chrom, key.level, key.tileIndex, key.laneLimit, key.trackType]);
}

function selectSharedLevel(pixelsPerBp: number, genomeLength: number): number {
  if (!(pixelsPerBp > 0)) return maxLevelForLength(genomeLength);
  const bpPerDevicePx = 1 / pixelsPerBp;
  let level = Math.floor(Math.log2(Math.max(1, bpPerDevicePx)));
  level = Math.max(0, level);
  return Math.min(level, maxLevelForLength(genomeLength));
}

export function annotationSidecarRasterCameraUsesRaster(
  camera: Pick<AnnotationSidecarRasterCamera, 'pixelsPerBp' | 'genomeLength'>
): boolean {
  return binBp(selectSharedLevel(camera.pixelsPerBp, camera.genomeLength)) > 256;
}

function overlappingTileIndexRange(
  globalStart: number,
  length: number,
  level: number
): [number, number] {
  const spanEnd = globalStart + Math.max(1, length) - 1;
  return [tileIndex(globalStart, level), tileIndex(spanEnd, level)];
}

const MAX_REQUIRED_TILES_PER_COMPOSITE = 128;

const EXON_RGB: readonly [number, number, number] = [96, 149, 214];
const CDS_RGB: readonly [number, number, number] = [214, 140, 64];

function decodeRasterToRgbaBuffer(tile: AnnotationSidecarRasterTile): Uint8Array {
  const width = TILE_PX;
  const laneCount = Math.max(1, tile.lanes.length);
  const height = laneCount * RASTER_ROW_HEIGHT_PX;
  const buffer = new Uint8Array(width * height * 4);
  for (let laneIndex = 0; laneIndex < tile.lanes.length; laneIndex += 1) {
    const lane = tile.lanes[laneIndex];
    const rowStart = laneIndex * RASTER_ROW_HEIGHT_PX;
    for (let x = 0; x < width; x += 1) {
      const exonAlpha = lane.exonRaster[x] ?? 0;
      const cdsAlpha = lane.cdsRaster[x] ?? 0;
      const outAlpha = cdsAlpha + exonAlpha * (1 - cdsAlpha);
      let r = 0;
      let g = 0;
      let b = 0;
      if (outAlpha > 0) {
        const cdsWeight = cdsAlpha / outAlpha;
        const exonWeight = (exonAlpha * (1 - cdsAlpha)) / outAlpha;
        r = CDS_RGB[0] * cdsWeight + EXON_RGB[0] * exonWeight;
        g = CDS_RGB[1] * cdsWeight + EXON_RGB[1] * exonWeight;
        b = CDS_RGB[2] * cdsWeight + EXON_RGB[2] * exonWeight;
      }
      const rByte = Math.round(Math.max(0, Math.min(255, r)));
      const gByte = Math.round(Math.max(0, Math.min(255, g)));
      const bByte = Math.round(Math.max(0, Math.min(255, b)));
      const aByte = Math.round(Math.max(0, Math.min(1, outAlpha)) * 255);
      for (let y = rowStart; y < rowStart + RASTER_ROW_HEIGHT_PX; y += 1) {
        const offset = (y * width + x) * 4;
        buffer[offset] = rByte;
        buffer[offset + 1] = gByte;
        buffer[offset + 2] = bByte;
        buffer[offset + 3] = aByte;
      }
    }
  }
  return buffer;
}

interface ResidentTileState {
  readonly sprite: Sprite;
  texture: Texture;
}

export class AnnotationSidecarRasterPresenter {
  private readonly sources: AnnotationSidecarRasterPresenterSources;
  private readonly resident = new Map<string, ResidentTileState>();
  private readonly pending = new Set<string>();
  private lastEligibilityReason: AnnotationSidecarRasterEligibilityReason = 'unavailable';
  private readonly discoveredAvailableTypes = new Set<string>();
  private lastCamera: AnnotationSidecarRasterCamera | null = null;
  private presenting = false;
  private presentingTrackTypes: readonly string[] = [];
  private destroyed = false;

  constructor(sources: AnnotationSidecarRasterPresenterSources) {
    this.sources = sources;
  }

  getAvailableTypes(): readonly string[] {
    return [...this.discoveredAvailableTypes].sort();
  }

  get eligibilityReason(): AnnotationSidecarRasterEligibilityReason {
    return this.lastEligibilityReason;
  }

  get isPresenting(): boolean {
    return this.presenting;
  }

  get visibleTrackTypes(): readonly string[] {
    return this.presentingTrackTypes;
  }

  supportsRasterCamera(camera: AnnotationSidecarRasterCamera): boolean {
    return annotationSidecarRasterCameraUsesRaster(camera);
  }

  composite(camera: AnnotationSidecarRasterCamera): boolean {
    this.lastCamera = camera;
    this.hide();
    const chromosomes = this.sources.readChromosomes();
    const visibleChromosomes = chromosomes.filter(
      (c) => c.globalStart < camera.visibleEndBp && c.globalStart + c.length > camera.visibleStartBp
    );

    const level = selectSharedLevel(camera.pixelsPerBp, camera.genomeLength);
    const artifactTexelsPerBp = 1 / (tileSpanBp(level) / TILE_PX);
    const texelsPerDevicePx = camera.pixelsPerBp > 0 ? artifactTexelsPerBp / camera.pixelsPerBp : 0;

    const chromRanges = visibleChromosomes.map((chrom) => {
      const intersectStart = Math.max(chrom.globalStart, camera.visibleStartBp);
      const intersectEnd = Math.min(chrom.globalStart + chrom.length, camera.visibleEndBp);
      return [
        chrom,
        overlappingTileIndexRange(intersectStart, intersectEnd - intersectStart, level),
      ] as const;
    });
    const totalRequiredTileCount = chromRanges.reduce(
      (sum, [, [first, last]]) => sum + (last - first + 1),
      0
    );
    if (totalRequiredTileCount > MAX_REQUIRED_TILES_PER_COMPOSITE) {
      this.lastEligibilityReason = 'too-many-tiles';
      this.hide();
      return false;
    }
    if (binBp(level) <= 256) {
      this.lastEligibilityReason = 'fine-vector-required';
      this.hide();
      return false;
    }

    const laneLimit = camera.laneLimit ?? 1;
    const visibleTypes = [...new Set(camera.visibleTypes.filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
    if (visibleTypes.length === 0) {
      this.lastEligibilityReason = 'unavailable';
      return true;
    }
    const requiredKeysByTrack = new Map<string, TileKey[]>();
    for (const trackType of visibleTypes) {
      const keys: TileKey[] = [];
      for (const [chrom, [first, last]] of chromRanges) {
        for (let idx = first; idx <= last; idx += 1) {
          keys.push({
            chrom: chrom.chrom,
            level,
            tileIndex: idx,
            laneLimit,
            trackType,
          });
        }
      }
      requiredKeysByTrack.set(trackType, keys);
    }

    let allRequestedTracksResident = requiredKeysByTrack.size > 0;
    const completeTrackTypes: string[] = [];
    for (const [trackType, requiredKeys] of requiredKeysByTrack) {
      let trackResident = requiredKeys.length > 0;
      for (const key of requiredKeys) {
        const k = tileKeyString(key);
        if (!this.resident.has(k)) {
          trackResident = false;
          if (!this.pending.has(k)) {
            const chrom = visibleChromosomes.find((c) => c.chrom === key.chrom);
            if (chrom) this.beginFetch(chrom, key);
          }
        }
      }
      if (trackResident) completeTrackTypes.push(trackType);
      else allRequestedTracksResident = false;
    }

    const eligibility = annotationSidecarRasterEligibility({
      genomeLength: camera.genomeLength,
      visibleBp: camera.visibleEndBp - camera.visibleStartBp,
      tileResident: completeTrackTypes.length > 0,
      texelsPerDevicePx,
    });
    this.lastEligibilityReason = eligibility.reason;
    if (!eligibility.eligible) {
      return false;
    }

    for (const trackType of completeTrackTypes) {
      for (const key of requiredKeysByTrack.get(trackType) ?? []) {
        const state = this.resident.get(tileKeyString(key));
        if (!state) continue;
        state.sprite.visible = true;
        if (camera.projectX !== undefined) {
          const startBp = tileGlobalStart(key.tileIndex, key.level);
          const endBp = tileGlobalEnd(key.tileIndex, key.level);
          const texturePixelsPerBp = TILE_PX / (endBp - startBp);
          state.sprite.x = camera.projectX(startBp);
          state.sprite.scale.x = camera.pixelsPerBp / texturePixelsPerBp;
          state.sprite.scale.y = 1;
          if (camera.projectY !== undefined) {
            state.sprite.y = camera.projectY(0);
          }
        }
      }
    }
    this.presenting = completeTrackTypes.length > 0;
    this.presentingTrackTypes = Object.freeze(completeTrackTypes);
    return allRequestedTracksResident;
  }

  private beginFetch(chrom: AnnotationSidecarRasterChromosome, key: TileKey): void {
    const k = tileKeyString(key);
    this.pending.add(k);
    this.sources
      .fetchCoarseTile({
        chrom,
        level: key.level,
        tileIndex: key.tileIndex,
        visibleTypes: [key.trackType],
        laneLimit: key.laneLimit,
      })
      .then((tile) => {
        this.pending.delete(k);
        if (tile.availableTypes !== undefined) {
          for (const t of tile.availableTypes) this.discoveredAvailableTypes.add(t);
        }
        const existing = this.resident.get(k);
        existing?.texture.destroy(true);
        const buffer = decodeRasterToRgbaBuffer(tile);
        const laneCount = Math.max(1, tile.lanes.length);
        const source = new BufferImageSource({
          resource: buffer,
          width: TILE_PX,
          height: laneCount * RASTER_ROW_HEIGHT_PX,
          format: 'rgba8unorm',
          scaleMode: 'nearest',
          alphaMode: 'premultiply-alpha-on-upload',
          label: `annotation-sidecar-raster:${k}`,
        });
        const texture = new Texture({ source });
        const sprite = existing?.sprite ?? this.createSprite();
        sprite.texture = texture;
        this.resident.set(k, { sprite, texture });
        if (!this.destroyed && this.lastCamera) this.composite(this.lastCamera);
      })
      .catch(() => {
        this.pending.delete(k);
      });
  }

  private createSprite(): Sprite {
    const sprite = new Sprite();
    sprite.eventMode = 'none';
    sprite.roundPixels = true;
    sprite.visible = false;
    const insertAt = Math.min(2, this.sources.parentContainer.children.length);
    this.sources.parentContainer.addChildAt(sprite, insertAt);
    return sprite;
  }

  reset(): void {
    this.hide();
  }

  hide(): void {
    for (const state of this.resident.values()) state.sprite.visible = false;
    this.presenting = false;
    this.presentingTrackTypes = [];
  }

  destroy(): void {
    this.destroyed = true;
    this.lastCamera = null;
    for (const state of this.resident.values()) {
      state.sprite.destroy();
      state.texture.destroy(true);
    }
    this.resident.clear();
    this.pending.clear();
  }
}
