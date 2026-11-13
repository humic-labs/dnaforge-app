import { annotationTileCoverageContainsRequiredRange } from './indexed-annotation-tile-policy';

const MIN_RETAINED_TILE_VIEWPORT_OVERLAP_RATIO = 0.5;

export interface AnnotationTileBounds {
  startBp: number;
  endBp: number;
}
export interface SelectionViewportRange {
  start: number;
  end: number;
}

export function selectActiveAnnotationViewportTile<T extends AnnotationTileBounds>(
  tiles: ReadonlyArray<T>,
  viewportRange: SelectionViewportRange | null
): T | null {
  if (tiles.length === 0) return null;
  if (!viewportRange) return tiles[tiles.length - 1];
  for (let i = tiles.length - 1; i >= 0; i -= 1) {
    const tile = tiles[i];
    if (
      annotationTileCoverageContainsRequiredRange(
        { startBp: tile.startBp, endBp: tile.endBp },
        viewportRange.start,
        viewportRange.end
      )
    ) {
      return tile;
    }
  }
  let best: T | null = null;
  let bestOverlap = 0;
  const viewportSpan = Math.max(1, viewportRange.end - viewportRange.start);
  for (let i = tiles.length - 1; i >= 0; i -= 1) {
    const tile = tiles[i];
    const overlap =
      Math.min(tile.endBp, viewportRange.end) - Math.max(tile.startBp, viewportRange.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = tile;
    }
  }
  if (bestOverlap / viewportSpan < MIN_RETAINED_TILE_VIEWPORT_OVERLAP_RATIO) return null;
  return best;
}
