import type { CompiledBroadRasterCellPayloadV1 } from './compiled-broad-raster-artifact-reader';
import type { CompiledBroadRasterCellPayloadWireV1 } from './indexed-genome';

export function compiledBroadRasterCellToWireV1({
  record,
  premultipliedRgba,
}: CompiledBroadRasterCellPayloadV1): CompiledBroadRasterCellPayloadWireV1 {
  const commonRecord = {
    cellId: record.cellId,
    trackId: record.trackId,
    isoformMode: record.isoformMode,
    level: record.level,
    tileX: record.tileX,
    laneSlabId: record.laneSlabId,
    laneSlabIndex: record.laneSlabIndex,
    widthPx: record.widthPx,
    heightPx: record.heightPx,
  };
  if (record.occupancy === 'transparent') {
    return {
      record: {
        ...commonRecord,
        occupancy: 'transparent',
        decodedByteLength: 0,
        decodedSha256: null,
      },
      premultipliedRgba: null,
    };
  }
  if (!premultipliedRgba || record.decodedSha256 === null) {
    throw new Error('Compiled broad-raster RGBA cell is missing decoded bytes or hash.');
  }
  return {
    record: {
      ...commonRecord,
      occupancy: 'rgba8',
      decodedByteLength: record.decodedByteLength,
      decodedSha256: record.decodedSha256,
    },
    premultipliedRgba,
  };
}
