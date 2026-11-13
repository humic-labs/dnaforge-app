import {
  admitCompiledBroadSurfaceManifestV2,
  compilePackedTranscriptBroadSurfaceRgba8V1,
  type BroadSurfaceIsoformModeV2,
  type CompiledBroadSurfaceManifestV2,
  type PackedPartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/pure';

import {
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1,
  createCompiledBroadRasterCellEncoderV1,
  type CompiledBroadRasterSourceCellV1,
} from './compiled-broad-raster-artifact';

export interface BroadRasterShardJobV1 {
  readonly payload: Uint8Array;
  readonly sceneManifest: PackedPartitionedTranscriptSceneBinaryV4['manifest'];
  readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
  readonly shardIndex: number;
  readonly shardCount: number;
  readonly claimCounter?: SharedArrayBuffer;
  readonly roleWeights?: Readonly<Record<BroadSurfaceIsoformModeV2, Uint8Array>>;
}

export interface BroadRasterShardResultV1 {
  readonly cells: readonly CompiledBroadRasterSourceCellV1[];
  readonly ordinals?: readonly number[];
}

export type RunBroadRasterShardV1 = (
  job: BroadRasterShardJobV1
) => Promise<BroadRasterShardResultV1>;

export async function encodeBroadRasterShardV1(
  job: BroadRasterShardJobV1
): Promise<BroadRasterShardResultV1> {
  const surfaceManifest = await admitCompiledBroadSurfaceManifestV2(job.surfaceManifest);
  const encode = await createCompiledBroadRasterCellEncoderV1(surfaceManifest, {
    pixelFormat: job.roleWeights
      ? COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_V1
      : COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
  });
  const cells: CompiledBroadRasterSourceCellV1[] = [];
  const counter = job.claimCounter ? new Int32Array(job.claimCounter) : null;
  const ordinals: number[] = [];
  await compilePackedTranscriptBroadSurfaceRgba8V1({
    packedScene: {
      manifest: job.sceneManifest,
      payload: job.payload,
      packWork: undefined as never,
    },
    surfaceManifest,
    shard: counter
      ? {
          claim: () => {
            const ordinal = Atomics.add(counter, 0, 1);
            ordinals.push(ordinal);
            return ordinal;
          },
        }
      : { index: job.shardIndex, count: job.shardCount },
    rasterizer: 'wasm',
    ...(job.roleWeights ? { roleWeights: job.roleWeights } : {}),
    onCell: (cell) => {
      const address = {
        isoformMode: cell.isoformMode,
        level: cell.level,
        tileX: cell.tileX,
        laneSlabIndex: cell.laneSlabIndex,
      } as const;
      cells.push(
        cell.transparent
          ? { ...address, occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_V1 }
          : {
              ...address,
              occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
              encoded: encode(address, cell.pixels),
            }
      );
    },
  });
  return counter ? { cells, ordinals: ordinals.slice(0, cells.length) } : { cells };
}

export async function encodeBroadRasterCellsInShardsV1(
  input: {
    readonly packed: PackedPartitionedTranscriptSceneBinaryV4;
    readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
    readonly shardCount: number;
    readonly roleWeights?: Readonly<Record<BroadSurfaceIsoformModeV2, Uint8Array>>;
  },
  runShard: RunBroadRasterShardV1
): Promise<CompiledBroadRasterSourceCellV1[]> {
  const shardCount = input.shardCount;
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error('Broad raster shard count is invalid.');
  }
  const shared = new Uint8Array(new SharedArrayBuffer(input.packed.payload.byteLength));
  shared.set(input.packed.payload);
  const claimCounter = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const shareRoles = (roles: Uint8Array) => {
    const shared = new Uint8Array(
      new SharedArrayBuffer(Math.max(1, roles.byteLength)),
      0,
      roles.byteLength
    );
    shared.set(roles);
    return shared;
  };
  const roleWeights = input.roleWeights
    ? {
        expanded: shareRoles(input.roleWeights.expanded),
        canonical: shareRoles(input.roleWeights.canonical),
      }
    : undefined;
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, shardIndex) =>
      runShard({
        payload: shared,
        sceneManifest: input.packed.manifest,
        surfaceManifest: input.surfaceManifest,
        shardIndex,
        shardCount,
        claimCounter,
        ...(roleWeights ? { roleWeights } : {}),
      })
    )
  );
  const total = shards.reduce((sum, shard) => sum + shard.cells.length, 0);
  const cells: (CompiledBroadRasterSourceCellV1 | undefined)[] = new Array(total);
  for (const shard of shards) {
    const ordinals = shard.ordinals;
    if (!ordinals || ordinals.length !== shard.cells.length) {
      throw new Error('Broad raster shards returned an incomplete cell roster.');
    }
    shard.cells.forEach((cell, index) => {
      const ordinal = ordinals[index];
      if (ordinal < 0 || ordinal >= total || cells[ordinal]) {
        throw new Error('Broad raster shards returned an incomplete cell roster.');
      }
      cells[ordinal] = cell;
    });
  }
  if (cells.some((cell) => !cell)) {
    throw new Error('Broad raster shards returned an incomplete cell roster.');
  }
  return cells as CompiledBroadRasterSourceCellV1[];
}
