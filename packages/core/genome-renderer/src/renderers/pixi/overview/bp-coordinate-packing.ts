export const BP_COORDINATE_CHUNK_SIZE = 4096;

export function bpCoordinateChunk(bp: number): number {
  return Math.floor(bp / BP_COORDINATE_CHUNK_SIZE);
}

export function bpCoordinateDelta(bp: number): number {
  return bp - bpCoordinateChunk(bp) * BP_COORDINATE_CHUNK_SIZE;
}

export function writePackedBpCoordinate(
  bp: number,
  chunk: Float32Array,
  delta: Float32Array,
  index: number
): void {
  const c = bpCoordinateChunk(bp);
  chunk[index] = c;
  delta[index] = bp - c * BP_COORDINATE_CHUNK_SIZE;
}

export function unpackBpCoordinate(chunk: number, delta: number): number {
  return chunk * BP_COORDINATE_CHUNK_SIZE + delta;
}

export function packedBpRelativeToOrigin(
  chunk: number,
  delta: number,
  originChunk: number,
  originDelta: number
): number {
  return (chunk - originChunk) * BP_COORDINATE_CHUNK_SIZE + (delta - originDelta);
}
