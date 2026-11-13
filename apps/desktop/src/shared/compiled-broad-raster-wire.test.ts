import { describe, expect, it } from 'vitest';
import type { CompiledBroadRasterCellPayloadV1 } from './compiled-broad-raster-artifact-reader';
import { compiledBroadRasterCellToWireV1 } from './compiled-broad-raster-wire';

function cell(): CompiledBroadRasterCellPayloadV1 {
  return {
    record: {
      cellId: 'cell-1',
      trackId: 'mRNA',
      isoformMode: 'canonical',
      level: 0,
      tileX: 2,
      laneSlabId: 'lanes-0',
      laneSlabIndex: 0,
      widthPx: 1,
      heightPx: 1,
      occupancy: 'rgba8',
      decodedByteLength: 4,
      decodedSha256: 'a'.repeat(64),
      encodedByteLength: 8,
      encodedSha256: 'b'.repeat(64),
      fileName: 'private-cell.rgba.br',
    },
    premultipliedRgba: Uint8Array.of(1, 2, 3, 255),
  };
}

describe('shared annotation raster transport', () => {
  it('preserves decoded pixel ownership while excluding storage metadata from the wire', () => {
    const input = cell();
    const output = compiledBroadRasterCellToWireV1(input);
    expect(output.premultipliedRgba).toBe(input.premultipliedRgba);
    expect(output.record).toEqual({
      cellId: 'cell-1',
      trackId: 'mRNA',
      isoformMode: 'canonical',
      level: 0,
      tileX: 2,
      laneSlabId: 'lanes-0',
      laneSlabIndex: 0,
      widthPx: 1,
      heightPx: 1,
      occupancy: 'rgba8',
      decodedByteLength: 4,
      decodedSha256: 'a'.repeat(64),
    });
  });

  it('transports transparent cells without pixel storage', () => {
    const input = cell();
    const output = compiledBroadRasterCellToWireV1({
      record: {
        ...input.record,
        occupancy: 'transparent',
        decodedByteLength: 0,
        decodedSha256: null,
      },
      premultipliedRgba: null,
    });
    expect(output.record.occupancy).toBe('transparent');
    expect(output.record.decodedByteLength).toBe(0);
    expect(output.record.decodedSha256).toBeNull();
    expect(output.premultipliedRgba).toBeNull();
  });

  it.each(['bytes', 'hash'])('refuses an opaque cell with missing %s', (missing) => {
    const input = cell();
    expect(() =>
      compiledBroadRasterCellToWireV1({
        record: {
          ...input.record,
          decodedSha256: missing === 'hash' ? null : input.record.decodedSha256,
        },
        premultipliedRgba: missing === 'bytes' ? null : input.premultipliedRgba,
      })
    ).toThrow(/missing decoded bytes or hash/u);
  });
});
