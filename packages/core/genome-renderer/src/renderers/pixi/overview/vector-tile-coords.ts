import { type TileCoord, tileKey } from './tile-pyramid-coords';

export { blocksOverlappingRange } from './tile-block-overlap';

export function vectorTileDataKey(coord: TileCoord): string {
  return `vector-tile:${tileKey(coord.z, coord.i)}`;
}
