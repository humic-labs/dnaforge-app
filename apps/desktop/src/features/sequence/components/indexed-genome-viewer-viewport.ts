import type { GenomeFeature } from '@waypoint/genome-data';
import type {
  GenomeAnnotationFeatureModel,
  GenomeTileCacheState,
  GenomeTrackTile,
} from '../../../shared/indexed-genome';
import type { SequenceViewportRange } from './indexed-sequence-window-policy';

export const MAX_RETAINED_ANNOTATION_VIEWPORT_TILES = 8;

export interface AnnotationViewportTileState {
  startBp: number;
  endBp: number;
  generation: number;
  state: GenomeTrackTile['state'];
  fidelity: GenomeTrackTile['fidelity'];
  laneEpoch?: string;
  featureModel: GenomeAnnotationFeatureModel;
  cacheState: GenomeTileCacheState;
  recordCount: number;
  byteCount: number;
  layerTypes: string[];
  features: GenomeFeature[];
}

export function isPendingAnnotationTile(tile: GenomeTrackTile): boolean {
  return isPendingAnnotationTileState(tile.state);
}

export function isPendingAnnotationTileState(state: GenomeTrackTile['state']): boolean {
  return (
    state === 'queued' || state === 'loading' || state === 'building_summary' || state === 'stale'
  );
}

export function uniqueSorted(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value.trim().length > 0) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function sameStringArray(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function retainAnnotationViewportTiles(
  previous: ReadonlyArray<AnnotationViewportTileState>,
  nextTile: AnnotationViewportTileState
): AnnotationViewportTileState[] {
  const deduped = previous.filter(
    (tile) =>
      !(
        tile.startBp === nextTile.startBp &&
        tile.endBp === nextTile.endBp &&
        tile.generation === nextTile.generation
      )
  );
  return [...deduped, nextTile].slice(-MAX_RETAINED_ANNOTATION_VIEWPORT_TILES);
}

export function annotationViewportTileFromGenomeTile(
  tile: GenomeTrackTile,
  laneEpochFallback?: string
): AnnotationViewportTileState {
  const features = Array.isArray(tile.features) ? tile.features : [];
  return {
    startBp: tile.start,
    endBp: tile.end,
    generation: tile.generation,
    state: tile.state,
    fidelity: tile.fidelity,
    laneEpoch: tile.laneEpoch ?? laneEpochFallback,
    featureModel: tile.featureModel ?? 'raw-gff3',
    cacheState: tile.cacheState ?? 'none',
    recordCount: tile.recordCount,
    byteCount: tile.byteCount,
    layerTypes: tile.layerTypes ?? [],
    features,
  };
}

export function annotationViewportCoverageFromTile(
  tile: Pick<GenomeTrackTile, 'state' | 'start' | 'end'>
): { startBp: number; endBp: number } | null {
  if (tile.state !== 'ready' && tile.state !== 'empty') return null;
  return { startBp: tile.start, endBp: tile.end };
}

export function shouldDeferAnnotationViewportTileCommit(
  cameraInteractionActive: boolean,
  quietDelayMs: number
): boolean {
  return cameraInteractionActive || quietDelayMs > 0;
}

export function retainAnnotationViewportCoverages(
  previous: ReadonlyArray<{ startBp: number; endBp: number }>,
  nextCoverage: { startBp: number; endBp: number }
): Array<{ startBp: number; endBp: number }> {
  const deduped = previous.filter(
    (coverage) =>
      !(coverage.startBp === nextCoverage.startBp && coverage.endBp === nextCoverage.endBp)
  );
  return [...deduped, nextCoverage].slice(-MAX_RETAINED_ANNOTATION_VIEWPORT_TILES);
}

export function sequenceViewportRangesEqual(
  left: SequenceViewportRange | null,
  right: SequenceViewportRange | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.start === right.start && left.end === right.end;
}

export function sceneViewportPublicationKey(range: SequenceViewportRange | null): string | null {
  if (!range) return null;
  const visibleBp = Math.max(1, range.end - range.start);
  const center = (range.start + range.end) / 2;
  const lod = Math.round(Math.log2(visibleBp) * 4);
  const panBucket = Math.floor(center / Math.max(1, visibleBp));
  return `single-chrom-data:${lod}:${panBucket}`;
}
