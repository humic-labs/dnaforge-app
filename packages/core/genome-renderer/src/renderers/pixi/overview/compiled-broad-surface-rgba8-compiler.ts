import {
  BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2,
  BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2,
  BROAD_SURFACE_X_FILTER_GUARD_PX_V2,
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  compiledBroadSurfaceCellIdV2,
  exactBroadSurfaceTilePlacementV2,
  type BroadSurfaceIsoformModeV2,
  type CompiledBroadSurfaceLaneSlabV2,
  type CompiledBroadSurfaceLevelV2,
  type CompiledBroadSurfaceManifestV2,
  type ExactBroadSurfaceTilePlacementV2,
} from './bounded-annotation-broad-surface';
import { annotationPolicyLaneCenterOffsetPxV1 } from './annotation-policy-gpu-instances-v1';
import {
  PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
  type PackedPartitionedTranscriptSceneBinaryV4,
} from './partitioned-transcript-scene-binary-v4';
import { retainedSubpixelAlphaScale } from './retained-subpixel-aa';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';
import { unpackBpCoordinate } from './bp-coordinate-packing';
import { WasmBroadRasterizerV1 } from '../../../broad-raster/broad-raster-wasm';

export const COMPILED_BROAD_SURFACE_RGBA8_CELL_V1 = 'compiled-broad-surface-rgba8-cell.v1' as const;

const MODE_ORDER: readonly BroadSurfaceIsoformModeV2[] = Object.freeze(['canonical', 'expanded']);
const RGBA_CHANNEL_COUNT = 4;
const ARROW_HEIGHT_RATIO = 0.6;
const ARROW_MAX_WIDTH_CSS_PX = 8;
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;

interface BinarySectionView {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly count: number;
  readonly recordBytes: number;
  readonly alignmentBytes: number;
}

interface DirectPartitionView {
  readonly key: string;
  readonly partitionIndex: number;
  readonly startBp: number;
  readonly endBpExclusive: number;
  readonly firstInstance: number;
  readonly instanceCount: number;
  readonly minStartBp: number;
  readonly maxEndBp: number;
  readonly lanePrefixOffset: number;
  readonly lanePrefixCount: number;
}

interface DirectModeView {
  readonly mode: BroadSurfaceIsoformModeV2;
  readonly instanceCount: number;
  readonly maxTrackLane: number;
  readonly partitions: readonly DirectPartitionView[];
}

export interface CompiledBroadSurfaceRgba8CellV1 {
  readonly contract: typeof COMPILED_BROAD_SURFACE_RGBA8_CELL_V1;
  readonly cellId: string;
  readonly artifactKey: string;
  readonly trackId: string;
  readonly manifestFingerprint: string;
  readonly sourcePayloadSha256: string;
  readonly sourceContractSha256: string;
  readonly sourceDatasetId: string;
  readonly sourceDatasetVersion: string;
  readonly sourceAssemblyId: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly level: number;
  readonly tileX: number;
  readonly tileSpanBp: number;
  readonly tilePlacement: ExactBroadSurfaceTilePlacementV2;
  readonly laneSlabId: string;
  readonly laneSlabIndex: number;
  readonly firstLaneRow: number;
  readonly sourceLaneRowCount: number;
  readonly paddedLaneRowCount: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly contentXStartPx: number;
  readonly contentXEndExclusivePx: number;
  readonly primitiveRasterizationCount: number;
  readonly transparent: boolean;
  readonly pixels: Uint8Array;
}

export interface CompilePackedTranscriptBroadSurfaceRgba8V1Input {
  readonly packedScene: PackedPartitionedTranscriptSceneBinaryV4;
  readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
  readonly onCell: (cell: CompiledBroadSurfaceRgba8CellV1) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly shard?:
    | { readonly index: number; readonly count: number }
    | { readonly claim: () => number };
  readonly rasterizer?: 'typescript' | 'wasm';
  readonly roleWeights?: Readonly<Record<BroadSurfaceIsoformModeV2, Uint8Array>>;
}

export const COMPILED_BROAD_SURFACE_MAX_WEIGHTED_ROLES_V1 = 4;

export interface CompiledBroadSurfaceRgba8WorkV1 {
  readonly emittedCellCount: number;
  readonly transparentCellCount: number;
  readonly primitiveRasterizationCount: number;
  readonly pixelBufferAllocationCount: 1;
  readonly peakLivePixelBufferCount: 1;
  readonly peakLivePixelBytes: number;
}

export class CompiledBroadSurfaceRasterCancelledError extends Error {
  readonly code = 'compiled-broad-surface-raster-cancelled' as const;

  constructor() {
    super('compiled broad surface raster compilation was cancelled');
    this.name = 'CompiledBroadSurfaceRasterCancelledError';
  }
}

export async function compilePackedTranscriptBroadSurfaceRgba8V1(
  input: CompilePackedTranscriptBroadSurfaceRgba8V1Input
): Promise<CompiledBroadSurfaceRgba8WorkV1> {
  if (typeof input?.onCell !== 'function') {
    throw new Error('compiled broad surface raster callback is required');
  }
  throwIfCancelled(input.signal);
  const source = validateCompilerInput(input.packedScene, input.surfaceManifest);
  const widthPx =
    input.surfaceManifest.broadTilePhysicalWidthPx +
    input.surfaceManifest.broadTileXGuardPhysicalPx * 2;
  const heightPx =
    input.surfaceManifest.laneSlabRowCount * input.surfaceManifest.laneRowTextureStridePx;
  const byteLength = checkedMultiply(
    checkedMultiply(widthPx, heightPx, 'pixel count'),
    RGBA_CHANNEL_COUNT,
    'pixel bytes'
  );
  const wasm =
    input.rasterizer === 'wasm'
      ? new WasmBroadRasterizerV1(input.packedScene.payload, widthPx, heightPx)
      : null;
  const typescriptPixels = wasm ? null : new Uint8Array(byteLength);
  const roleWeights = input.roleWeights;
  if (roleWeights) {
    for (const isoformMode of MODE_ORDER) {
      const roles = roleWeights[isoformMode];
      if (
        !(roles instanceof Uint8Array) ||
        roles.length !== source[isoformMode].glyphSection.count ||
        roles.some((role) => role >= COMPILED_BROAD_SURFACE_MAX_WEIGHTED_ROLES_V1)
      ) {
        throw new Error('compiled broad surface role weights do not fit the scene');
      }
    }
  }
  const accumulator = roleWeights && !wasm ? new Float64Array(widthPx * heightPx * 4) : null;
  const glyphScratch = createDecodedGlyph();
  const dataView = new DataView(
    input.packedScene.payload.buffer,
    input.packedScene.payload.byteOffset,
    input.packedScene.payload.byteLength
  );
  let emittedCellCount = 0;
  let transparentCellCount = 0;
  let primitiveRasterizationCount = 0;
  const shard = input.shard && 'count' in input.shard ? input.shard : undefined;
  const claim = input.shard && 'claim' in input.shard ? input.shard.claim : undefined;
  let claimed = claim ? claim() : -1;
  if (
    shard &&
    (!Number.isSafeInteger(shard.count) ||
      shard.count < 1 ||
      !Number.isSafeInteger(shard.index) ||
      shard.index < 0 ||
      shard.index >= shard.count)
  ) {
    throw new Error('compiled broad surface raster shard is invalid');
  }
  let ordinal = 0;

  try {
    for (const isoformMode of MODE_ORDER) {
      const mode = source[isoformMode];
      const slabs = input.surfaceManifest.laneSlabs[isoformMode];
      for (const level of input.surfaceManifest.levels) {
        for (let tileX = 0; tileX < level.tileCount; tileX++) {
          for (const slab of slabs) {
            const cellOrdinal = ordinal++;
            if (shard && cellOrdinal % shard.count !== shard.index) continue;
            if (claim) {
              if (cellOrdinal !== claimed) continue;
              claimed = claim();
            }
            throwIfCancelled(input.signal);
            const placement = exactBroadSurfaceTilePlacementV2({
              manifest: input.surfaceManifest,
              level: level.level,
              tileX,
            });
            const rasterized = wasm
              ? wasm.rasterize({
                  glyphs: mode.glyphSection,
                  lanePrefixes: mode.lanePrefixSection,
                  partitions: mode.directMode.partitions,
                  maxPrimitiveSpanBp: input.packedScene.manifest.maxPrimitiveSpanBp,
                  tileSpanBp: level.tileSpanBp,
                  nominalStartBp: placement.nominalStartBp,
                  nominalEndBpExclusive: placement.nominalEndBpExclusive,
                  firstLaneRow: slab.firstLaneRow,
                  sourceLaneRowCount: slab.sourceLaneRowCount,
                  tilePhysicalWidthPx: input.surfaceManifest.broadTilePhysicalWidthPx,
                  guardPx: input.surfaceManifest.broadTileXGuardPhysicalPx,
                  dpr: input.surfaceManifest.rasterDevicePixelRatio,
                  laneRowStridePx: input.surfaceManifest.laneRowTextureStridePx,
                  laneRowTailGutterPx: input.surfaceManifest.laneRowTransparentTailGutterPx,
                  ...(roleWeights ? { roles: roleWeights[isoformMode] } : {}),
                })
              : rasterizeCell({
                  dataView,
                  glyphSection: mode.glyphSection,
                  lanePrefixSection: mode.lanePrefixSection,
                  directMode: mode.directMode,
                  maxPrimitiveSpanBp: input.packedScene.manifest.maxPrimitiveSpanBp,
                  level,
                  placement,
                  slab,
                  surfaceManifest: input.surfaceManifest,
                  pixels: typescriptPixels as Uint8Array,
                  accumulator,
                  roles: roleWeights ? roleWeights[isoformMode] : null,
                  glyphScratch,
                  widthPx,
                  heightPx,
                });
            const pixels = wasm ? wasm.pixels() : (typescriptPixels as Uint8Array);
            const transparent = !rasterized.wrotePixel;
            const cell: CompiledBroadSurfaceRgba8CellV1 = Object.freeze({
              contract: COMPILED_BROAD_SURFACE_RGBA8_CELL_V1,
              cellId: compiledBroadSurfaceCellIdV2({
                manifest: input.surfaceManifest,
                isoformMode,
                level: level.level,
                tileX,
                laneSlabIndex: slab.slabIndex,
              }),
              artifactKey: input.surfaceManifest.artifactKey,
              trackId: input.surfaceManifest.trackId,
              manifestFingerprint: input.surfaceManifest.manifestFingerprint,
              sourcePayloadSha256: input.packedScene.manifest.integrity.payloadSha256,
              sourceContractSha256: input.packedScene.manifest.integrity.contractSha256,
              sourceDatasetId: input.packedScene.manifest.datasetContract.datasetId,
              sourceDatasetVersion: input.packedScene.manifest.datasetContract.datasetVersion,
              sourceAssemblyId: input.packedScene.manifest.assemblyContract.assemblyId,
              isoformMode,
              level: level.level,
              tileX,
              tileSpanBp: level.tileSpanBp,
              tilePlacement: placement,
              laneSlabId: slab.slabId,
              laneSlabIndex: slab.slabIndex,
              firstLaneRow: slab.firstLaneRow,
              sourceLaneRowCount: slab.sourceLaneRowCount,
              paddedLaneRowCount: slab.paddedLaneRowCount,
              widthPx,
              heightPx,
              contentXStartPx: input.surfaceManifest.broadTileXGuardPhysicalPx,
              contentXEndExclusivePx:
                input.surfaceManifest.broadTileXGuardPhysicalPx +
                input.surfaceManifest.broadTilePhysicalWidthPx,
              primitiveRasterizationCount: rasterized.primitiveCount,
              transparent,
              pixels,
            });
            await input.onCell(cell);
            emittedCellCount++;
            primitiveRasterizationCount += rasterized.primitiveCount;
            if (transparent) transparentCellCount++;
          }
        }
      }
    }
  } finally {
    wasm?.dispose();
  }

  return Object.freeze({
    emittedCellCount,
    transparentCellCount,
    primitiveRasterizationCount,
    pixelBufferAllocationCount: 1,
    peakLivePixelBufferCount: 1,
    peakLivePixelBytes: byteLength,
  });
}

interface ValidatedModeSource {
  readonly directMode: DirectModeView;
  readonly glyphSection: BinarySectionView;
  readonly lanePrefixSection: BinarySectionView;
}

function validateCompilerInput(
  packed: PackedPartitionedTranscriptSceneBinaryV4,
  surface: CompiledBroadSurfaceManifestV2
): Readonly<Record<BroadSurfaceIsoformModeV2, ValidatedModeSource>> {
  const firstLevel = surface?.levels?.[0];
  if (!firstLevel) {
    throw new Error('compiled broad surface manifest has no raster levels');
  }
  exactBroadSurfaceTilePlacementV2({ manifest: surface, level: firstLevel.level, tileX: 0 });
  if (!packed || packed.manifest?.schema !== PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4) {
    throw new Error('compiled broad surface source must be a V4 transcript scene');
  }
  if (
    !(packed.payload instanceof Uint8Array) ||
    packed.payload.byteLength !== packed.manifest.byteLength
  ) {
    throw new Error('compiled broad surface source payload dimensions are invalid');
  }
  if (packed.manifest.assemblyContract.assemblyLengthBp !== surface.genomeLengthBp) {
    throw new Error('compiled broad surface source/manifest genome identity mismatch');
  }
  if (
    surface.broadTilePhysicalWidthPx !== BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2 ||
    surface.broadTileXGuardPhysicalPx !== BROAD_SURFACE_X_FILTER_GUARD_PX_V2 ||
    surface.laneSlabRowCount !== BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2
  ) {
    throw new Error('compiled broad surface physical dimensions are invalid');
  }
  if (
    packed.manifest.directContract.glyphRecordBytes !== TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes
  ) {
    throw new Error('compiled broad surface source glyph layout is invalid');
  }
  const dataView = new DataView(
    packed.payload.buffer,
    packed.payload.byteOffset,
    packed.payload.byteLength
  );
  const validated = {} as Record<BroadSurfaceIsoformModeV2, ValidatedModeSource>;
  for (const modeName of MODE_ORDER) {
    const directMode = packed.manifest.directContract[modeName] as DirectModeView;
    const glyphSection = packed.manifest.sections[`${modeName}Glyphs`] as BinarySectionView;
    const lanePrefixSection = packed.manifest.sections[
      `${modeName}LanePrefixes`
    ] as BinarySectionView;
    validateSection(
      glyphSection,
      packed.payload.byteLength,
      directMode.instanceCount,
      TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes,
      `${modeName} glyphs`
    );
    validateSection(
      lanePrefixSection,
      packed.payload.byteLength,
      directMode.partitions.reduce((sum, partition) => sum + partition.lanePrefixCount, 0),
      U32_BYTES,
      `${modeName} lane prefixes`
    );
    const sourceLaneRows = directMode.maxTrackLane + 1;
    const rasterLaneRows = Math.min(
      sourceLaneRows,
      COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2
    );
    if (directMode.mode !== modeName || rasterLaneRows !== surface.laneRowCounts[modeName]) {
      throw new Error(`compiled broad surface ${modeName} lane identity mismatch`);
    }
    validateDirectModeRecords(
      dataView,
      glyphSection,
      lanePrefixSection,
      directMode,
      packed.manifest.assemblyContract.assemblyLengthBp,
      packed.manifest.maxPrimitiveSpanBp
    );
    validated[modeName] = { directMode, glyphSection, lanePrefixSection };
  }
  return Object.freeze(validated);
}

function validateSection(
  section: BinarySectionView | undefined,
  payloadBytes: number,
  expectedCount: number,
  expectedRecordBytes: number,
  label: string
): void {
  if (
    !section ||
    !Number.isSafeInteger(section.byteOffset) ||
    section.byteOffset < 0 ||
    !Number.isSafeInteger(section.alignmentBytes) ||
    section.alignmentBytes < 1 ||
    section.byteOffset % section.alignmentBytes !== 0 ||
    section.count !== expectedCount ||
    section.recordBytes !== expectedRecordBytes ||
    section.byteLength !== checkedMultiply(expectedCount, expectedRecordBytes, label) ||
    section.byteOffset + section.byteLength > payloadBytes
  ) {
    throw new Error(`compiled broad surface ${label} section is invalid`);
  }
}

function validateDirectModeRecords(
  view: DataView,
  glyphs: BinarySectionView,
  prefixes: BinarySectionView,
  mode: DirectModeView,
  assemblyLengthBp: number,
  maxPrimitiveSpanBp: number
): void {
  const glyphScratch = createDecodedGlyph();
  let expectedFirstInstance = 0;
  let expectedPrefixOffset = 0;
  let previousPartitionIndex = -1;
  for (const partition of mode.partitions) {
    if (
      partition.partitionIndex <= previousPartitionIndex ||
      partition.firstInstance !== expectedFirstInstance ||
      partition.lanePrefixOffset !== expectedPrefixOffset ||
      partition.lanePrefixCount < 1 ||
      partition.lanePrefixCount > mode.maxTrackLane + 2 ||
      partition.startBp < 0 ||
      partition.endBpExclusive <= partition.startBp ||
      partition.minStartBp < partition.startBp ||
      partition.maxEndBp > assemblyLengthBp ||
      partition.maxEndBp < partition.minStartBp
    ) {
      throw new Error(`compiled broad surface ${mode.mode} partition identity is invalid`);
    }
    const prefixCount = partition.lanePrefixCount;
    let previous = readPrefix(view, prefixes, partition.lanePrefixOffset);
    if (previous !== 0) {
      throw new Error(`compiled broad surface ${mode.mode} lane prefix is invalid`);
    }
    for (let local = 1; local < prefixCount; local++) {
      const next = readPrefix(view, prefixes, partition.lanePrefixOffset + local);
      if (next < previous || next > partition.instanceCount) {
        throw new Error(`compiled broad surface ${mode.mode} lane prefix is invalid`);
      }
      const lane = local - 1;
      let previousStartBp = -1;
      for (let relativeRecord = previous; relativeRecord < next; relativeRecord++) {
        const record = validateGlyphRecord(
          view,
          glyphs,
          partition.firstInstance + relativeRecord,
          lane,
          assemblyLengthBp,
          maxPrimitiveSpanBp,
          glyphScratch
        );
        if (record.startBp < previousStartBp) {
          throw new Error(`compiled broad surface ${mode.mode} lane order is invalid`);
        }
        previousStartBp = record.startBp;
      }
      previous = next;
    }
    if (previous !== partition.instanceCount) {
      throw new Error(`compiled broad surface ${mode.mode} lane prefix is incomplete`);
    }
    expectedFirstInstance += partition.instanceCount;
    expectedPrefixOffset += partition.lanePrefixCount;
    previousPartitionIndex = partition.partitionIndex;
  }
  if (expectedFirstInstance !== mode.instanceCount || expectedPrefixOffset !== prefixes.count) {
    throw new Error(`compiled broad surface ${mode.mode} direct bank is incomplete`);
  }
}

function validateGlyphRecord(
  view: DataView,
  section: BinarySectionView,
  recordIndex: number,
  lane: number,
  assemblyLengthBp: number,
  maxPrimitiveSpanBp: number,
  glyphScratch: DecodedGlyph
): DecodedGlyph {
  const record = readGlyph(view, section, recordIndex, glyphScratch);
  const expectedOffset = Math.fround(annotationPolicyLaneCenterOffsetPxV1(lane));
  if (
    !Number.isSafeInteger(record.startBp) ||
    !Number.isSafeInteger(record.endBp) ||
    record.startBp < 0 ||
    record.endBp <= record.startBp ||
    record.endBp > assemblyLengthBp ||
    record.endBp - record.startBp > maxPrimitiveSpanBp ||
    record.offsetCenter !== expectedOffset ||
    !Number.isFinite(record.halfH) ||
    record.halfH <= 0 ||
    (record.dirSign !== -1 && record.dirSign !== 0 && record.dirSign !== 1) ||
    !Number.isFinite(record.cdsFade) ||
    record.cdsFade < 0 ||
    record.color.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error('compiled broad surface source glyph record is invalid');
  }
  return record;
}

interface RasterCellInput {
  readonly dataView: DataView;
  readonly glyphSection: BinarySectionView;
  readonly lanePrefixSection: BinarySectionView;
  readonly directMode: DirectModeView;
  readonly maxPrimitiveSpanBp: number;
  readonly level: CompiledBroadSurfaceLevelV2;
  readonly placement: ExactBroadSurfaceTilePlacementV2;
  readonly slab: CompiledBroadSurfaceLaneSlabV2;
  readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
  readonly pixels: Uint8Array;
  readonly accumulator: Float64Array | null;
  readonly roles: Uint8Array | null;
  readonly glyphScratch: DecodedGlyph;
  readonly widthPx: number;
  readonly heightPx: number;
}

interface RasterizedCellWork {
  readonly primitiveCount: number;
  readonly wrotePixel: boolean;
}

function rasterizeCell(input: RasterCellInput): RasterizedCellWork {
  const scaleX = input.surfaceManifest.broadTilePhysicalWidthPx / input.level.tileSpanBp;
  const guardBp = input.surfaceManifest.broadTileXGuardPhysicalPx / scaleX;
  const sampleStartBp = input.placement.nominalStartBp - guardBp;
  const sampleEndBp = input.placement.nominalEndBpExclusive + guardBp;
  let rasterized = 0;
  let wrotePixel = false;
  for (const partition of input.directMode.partitions) {
    if (partition.maxEndBp <= sampleStartBp || partition.minStartBp >= sampleEndBp) continue;
    const lastLaneExclusive = input.slab.firstLaneRow + input.slab.sourceLaneRowCount;
    for (let lane = input.slab.firstLaneRow; lane < lastLaneExclusive; lane++) {
      if (lane + 1 >= partition.lanePrefixCount) continue;
      const first = readPrefix(
        input.dataView,
        input.lanePrefixSection,
        partition.lanePrefixOffset + lane
      );
      const end = readPrefix(
        input.dataView,
        input.lanePrefixSection,
        partition.lanePrefixOffset + lane + 1
      );
      const laneFirstRecord = partition.firstInstance + first;
      const laneEndRecord = partition.firstInstance + end;
      const firstCandidate = lowerBoundGlyphStart(
        input.dataView,
        input.glyphSection,
        laneFirstRecord,
        laneEndRecord,
        sampleStartBp - input.maxPrimitiveSpanBp
      );
      const endCandidate = lowerBoundGlyphStart(
        input.dataView,
        input.glyphSection,
        firstCandidate,
        laneEndRecord,
        sampleEndBp
      );
      for (let recordIndex = firstCandidate; recordIndex < endCandidate; recordIndex++) {
        const glyph = readGlyph(
          input.dataView,
          input.glyphSection,
          recordIndex,
          input.glyphScratch
        );
        if (glyph.endBp <= sampleStartBp || glyph.startBp >= sampleEndBp) continue;
        if (rasterized === 0) {
          if (input.accumulator) input.accumulator.fill(0);
          else input.pixels.fill(0);
        }
        BLEND_TARGET.pixels = input.pixels;
        BLEND_TARGET.accumulator = input.accumulator;
        BLEND_TARGET.role = input.roles ? input.roles[recordIndex] : 0;
        wrotePixel =
          rasterizeGlyph(input, glyph, lane - input.slab.firstLaneRow, scaleX) || wrotePixel;
        rasterized++;
      }
    }
  }
  if (input.accumulator && rasterized > 0) {
    const accumulator = input.accumulator;
    const pixels = input.pixels;
    for (let index = 0; index < accumulator.length; index++) {
      pixels[index] = Math.round(Math.min(1, accumulator[index]) * 255);
    }
  }
  return { primitiveCount: rasterized, wrotePixel };
}

const BLEND_TARGET: {
  pixels: Uint8Array;
  accumulator: Float64Array | null;
  role: number;
} = { pixels: new Uint8Array(0), accumulator: null, role: 0 };

interface DecodedGlyph {
  startBp: number;
  endBp: number;
  offsetCenter: number;
  halfH: number;
  dirSign: number;
  cdsFade: number;
  color: [number, number, number, number];
}

function createDecodedGlyph(): DecodedGlyph {
  return {
    startBp: 0,
    endBp: 0,
    offsetCenter: 0,
    halfH: 0,
    dirSign: 0,
    cdsFade: 0,
    color: [0, 0, 0, 0],
  };
}

function readGlyph(
  view: DataView,
  section: BinarySectionView,
  recordIndex: number,
  target: DecodedGlyph
): DecodedGlyph {
  if (recordIndex < 0 || recordIndex >= section.count) {
    throw new Error('compiled broad surface glyph index is outside its section');
  }
  const base = section.byteOffset + recordIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes;
  target.startBp = unpackBpCoordinate(
    view.getFloat32(base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk * FLOAT_BYTES, true),
    view.getFloat32(base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta * FLOAT_BYTES, true)
  );
  target.endBp = unpackBpCoordinate(
    view.getFloat32(base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk * FLOAT_BYTES, true),
    view.getFloat32(base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta * FLOAT_BYTES, true)
  );
  target.offsetCenter = view.getFloat32(
    base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter * FLOAT_BYTES,
    true
  );
  target.halfH = view.getFloat32(base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH * FLOAT_BYTES, true);
  target.dirSign = view.getFloat32(
    base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign * FLOAT_BYTES,
    true
  );
  target.cdsFade = view.getFloat32(
    base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.cdsFade * FLOAT_BYTES,
    true
  );
  target.color[0] = view.getFloat32(
    base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color * FLOAT_BYTES,
    true
  );
  target.color[1] = view.getFloat32(
    base + (TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 1) * FLOAT_BYTES,
    true
  );
  target.color[2] = view.getFloat32(
    base + (TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 2) * FLOAT_BYTES,
    true
  );
  target.color[3] = view.getFloat32(
    base + (TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 3) * FLOAT_BYTES,
    true
  );
  return target;
}

function readPrefix(view: DataView, section: BinarySectionView, index: number): number {
  if (index < 0 || index >= section.count) {
    throw new Error('compiled broad surface lane prefix index is invalid');
  }
  return view.getUint32(section.byteOffset + index * U32_BYTES, true);
}

function lowerBoundGlyphStart(
  view: DataView,
  section: BinarySectionView,
  firstRecord: number,
  endRecord: number,
  targetStartBp: number
): number {
  let lower = firstRecord;
  let upper = endRecord;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (readGlyphStartBp(view, section, middle) < targetStartBp) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

function readGlyphStartBp(view: DataView, section: BinarySectionView, recordIndex: number): number {
  const base = section.byteOffset + recordIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes;
  return unpackBpCoordinate(
    view.getFloat32(base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk * FLOAT_BYTES, true),
    view.getFloat32(base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta * FLOAT_BYTES, true)
  );
}

function rasterizeGlyph(
  input: RasterCellInput,
  glyph: DecodedGlyph,
  localLane: number,
  scaleX: number
): boolean {
  const dpr = input.surfaceManifest.rasterDevicePixelRatio;
  let x1 =
    input.surfaceManifest.broadTileXGuardPhysicalPx +
    (glyph.startBp - input.placement.nominalStartBp) * scaleX;
  let x2 =
    input.surfaceManifest.broadTileXGuardPhysicalPx +
    (glyph.endBp - input.placement.nominalStartBp) * scaleX;
  const actualWidthPhysical = Math.max(0, x2 - x1);
  if (actualWidthPhysical <= 0) return false;
  const stableWidthPhysical = Math.max(actualWidthPhysical, dpr);
  if (stableWidthPhysical > actualWidthPhysical) {
    const middle = (x1 + x2) / 2;
    x1 = middle - stableWidthPhysical / 2;
    x2 = middle + stableWidthPhysical / 2;
  }
  const contentHeight =
    input.surfaceManifest.laneRowTextureStridePx -
    input.surfaceManifest.laneRowTransparentTailGutterPx;
  const centerY = localLane * input.surfaceManifest.laneRowTextureStridePx + contentHeight / 2;
  const halfH = glyph.halfH * dpr;
  const y1 = centerY - halfH;
  const y2 = centerY + halfH;
  const actualWidthCss = actualWidthPhysical / dpr;
  const alpha = glyph.color[3] * retainedSubpixelAlphaScale(actualWidthCss);
  if (alpha <= 0) return false;
  let arrowWidth = 0;
  if (glyph.dirSign !== 0) {
    const candidate = Math.min(
      2 * glyph.halfH * ARROW_HEIGHT_RATIO,
      actualWidthCss * 0.3,
      ARROW_MAX_WIDTH_CSS_PX
    );
    if (actualWidthCss > candidate * 2) arrowWidth = candidate * dpr;
  }
  const color = clampedColor(glyph.color);
  if (arrowWidth === 0) {
    return rasterizeRectangle(input.widthPx, input.heightPx, x1, y1, x2, y2, color, alpha);
  }
  return rasterizeArrow(
    input.widthPx,
    input.heightPx,
    x1,
    y1,
    x2,
    y2,
    centerY,
    arrowWidth,
    glyph.dirSign,
    color,
    alpha
  );
}

function rasterizeRectangle(
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: readonly [number, number, number, number],
  alpha: number
): boolean {
  const minX = Math.max(0, Math.floor(x1));
  const maxX = Math.min(width - 1, Math.ceil(x2) - 1);
  const minY = Math.max(0, Math.floor(y1));
  const maxY = Math.min(height - 1, Math.ceil(y2) - 1);
  let wrotePixel = false;
  for (let y = minY; y <= maxY; y++) {
    const coverageY = Math.max(0, Math.min(y + 1, y2) - Math.max(y, y1));
    if (coverageY === 0) continue;
    for (let x = minX; x <= maxX; x++) {
      const coverageX = Math.max(0, Math.min(x + 1, x2) - Math.max(x, x1));
      if (coverageX === 0) continue;
      wrotePixel =
        blend((y * width + x) * RGBA_CHANNEL_COUNT, color, alpha * coverageX * coverageY) ||
        wrotePixel;
    }
  }
  return wrotePixel;
}

function rasterizeArrow(
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  centerY: number,
  arrowWidth: number,
  direction: number,
  color: readonly [number, number, number, number],
  alpha: number
): boolean {
  const minX = Math.max(0, Math.floor(x1));
  const maxX = Math.min(width - 1, Math.ceil(x2) - 1);
  const minY = Math.max(0, Math.floor(y1));
  const maxY = Math.min(height - 1, Math.ceil(y2) - 1);
  let wrotePixel = false;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const coverage = arrowPixelCoverage(
        x1,
        y1,
        x2,
        y2,
        centerY,
        arrowWidth,
        direction,
        x,
        y,
        x + 1,
        y + 1
      );
      if (coverage <= 0) continue;
      wrotePixel =
        blend((y * width + x) * RGBA_CHANNEL_COUNT, color, alpha * Math.min(1, coverage)) ||
        wrotePixel;
    }
  }
  return wrotePixel;
}

function arrowPixelCoverage(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  centerY: number,
  arrowWidth: number,
  direction: number,
  left: number,
  top: number,
  right: number,
  bottom: number
): number {
  const clippedTop = Math.max(top, y1);
  const clippedBottom = Math.min(bottom, y2);
  if (clippedBottom <= clippedTop) return 0;
  const clippedLeft = Math.max(left, x1);
  const clippedRight = Math.min(right, x2);
  const width = clippedRight - clippedLeft;
  if (width <= 0) return 0;
  const baseX = direction < 0 ? x1 + arrowWidth : x2 - arrowWidth;
  let area = 0;
  const upperBottom = Math.min(clippedBottom, centerY);
  if (upperBottom > clippedTop) {
    const edgeAtTop =
      direction < 0
        ? baseX - (arrowWidth * (clippedTop - y1)) / (centerY - y1)
        : baseX + (arrowWidth * (clippedTop - y1)) / (centerY - y1);
    const edgeAtBottom =
      direction < 0
        ? baseX - (arrowWidth * (upperBottom - y1)) / (centerY - y1)
        : baseX + (arrowWidth * (upperBottom - y1)) / (centerY - y1);
    area +=
      direction < 0
        ? integrateClampedLinear(
            clippedRight - edgeAtTop,
            clippedRight - edgeAtBottom,
            upperBottom - clippedTop,
            width
          )
        : integrateClampedLinear(
            edgeAtTop - clippedLeft,
            edgeAtBottom - clippedLeft,
            upperBottom - clippedTop,
            width
          );
  }
  const lowerTop = Math.max(clippedTop, centerY);
  if (clippedBottom > lowerTop) {
    const edgeAtTop =
      direction < 0
        ? baseX - (arrowWidth * (y2 - lowerTop)) / (y2 - centerY)
        : baseX + (arrowWidth * (y2 - lowerTop)) / (y2 - centerY);
    const edgeAtBottom =
      direction < 0
        ? baseX - (arrowWidth * (y2 - clippedBottom)) / (y2 - centerY)
        : baseX + (arrowWidth * (y2 - clippedBottom)) / (y2 - centerY);
    area +=
      direction < 0
        ? integrateClampedLinear(
            clippedRight - edgeAtTop,
            clippedRight - edgeAtBottom,
            clippedBottom - lowerTop,
            width
          )
        : integrateClampedLinear(
            edgeAtTop - clippedLeft,
            edgeAtBottom - clippedLeft,
            clippedBottom - lowerTop,
            width
          );
  }
  return area;
}

function integrateClampedLinear(
  startValue: number,
  endValue: number,
  span: number,
  maximum: number
): number {
  if (startValue === endValue) {
    return Math.max(0, Math.min(maximum, startValue)) * span;
  }
  const slope = (endValue - startValue) / span;
  return (
    (clampedLinearAntiderivative(endValue, maximum) -
      clampedLinearAntiderivative(startValue, maximum)) /
    slope
  );
}

function clampedLinearAntiderivative(value: number, maximum: number): number {
  if (value <= 0) return 0;
  if (value >= maximum) return maximum * value - (maximum * maximum) / 2;
  return (value * value) / 2;
}

const ROUNDED_SCALE = (() => {
  const table = new Uint8Array(256 * 256);
  for (let value = 0; value < 256; value++) {
    for (let factor = 0; factor < 256; factor++) {
      table[(value << 8) | factor] = Math.round((value * factor) / 255);
    }
  }
  return table;
})();

function blend(
  offset: number,
  color: readonly [number, number, number, number],
  alpha: number
): boolean {
  const accumulator = BLEND_TARGET.accumulator;
  return accumulator
    ? roleOver(accumulator, offset, BLEND_TARGET.role, alpha)
    : sourceOver(BLEND_TARGET.pixels, offset, color, alpha);
}

function roleOver(accumulator: Float64Array, offset: number, role: number, alpha: number): boolean {
  if (Math.round(clamp01(alpha) * 255) === 0) return false;
  const coverage = clamp01(alpha);
  const keep = 1 - coverage;
  accumulator[offset] = accumulator[offset] * keep;
  accumulator[offset + 1] = accumulator[offset + 1] * keep;
  accumulator[offset + 2] = accumulator[offset + 2] * keep;
  accumulator[offset + 3] = accumulator[offset + 3] * keep;
  accumulator[offset + role] = accumulator[offset + role] + coverage;
  return true;
}

function sourceOver(
  pixels: Uint8Array,
  offset: number,
  color: readonly [number, number, number, number],
  alpha: number
): boolean {
  const sourceAlpha = Math.round(clamp01(alpha) * 255);
  if (sourceAlpha === 0) return false;
  const inverse = 255 - sourceAlpha;
  pixels[offset] = Math.min(
    255,
    Math.round(color[0] * sourceAlpha) + ROUNDED_SCALE[(pixels[offset] << 8) | inverse]
  );
  pixels[offset + 1] = Math.min(
    255,
    Math.round(color[1] * sourceAlpha) + ROUNDED_SCALE[(pixels[offset + 1] << 8) | inverse]
  );
  pixels[offset + 2] = Math.min(
    255,
    Math.round(color[2] * sourceAlpha) + ROUNDED_SCALE[(pixels[offset + 2] << 8) | inverse]
  );
  pixels[offset + 3] = Math.min(
    255,
    sourceAlpha + ROUNDED_SCALE[(pixels[offset + 3] << 8) | inverse]
  );
  return true;
}

const CLAMPED_COLOR: [number, number, number, number] = [0, 0, 0, 0];
function clampedColor(
  color: readonly [number, number, number, number]
): [number, number, number, number] {
  CLAMPED_COLOR[0] = clamp01(color[0]);
  CLAMPED_COLOR[1] = clamp01(color[1]);
  CLAMPED_COLOR[2] = clamp01(color[2]);
  CLAMPED_COLOR[3] = color[3];
  return CLAMPED_COLOR;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CompiledBroadSurfaceRasterCancelledError();
}

function checkedMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`compiled broad surface ${label} overflow`);
  }
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
