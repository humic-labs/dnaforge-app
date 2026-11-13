import type { Feature } from '@waypoint/genome-renderer';
import type { GenomeAnnotationGlyphPayload } from '../../../shared/indexed-genome';
import type { AnnotationLaneStackingOptions } from './indexed-genome-legacy-adapter';

export const ANNOTATION_LANE_STACKING_BY_TYPE: AnnotationLaneStackingOptions = {
  groupByType: true,
  typeOrder: ['gene', 'mRNA', 'lncRNA', 'ncRNA', 'miRNA', 'snoRNA', 'tRNA'],
};

export const EMPTY_ASSEMBLY_DETAIL_FEATURE_PARTITIONS: ReadonlyMap<
  string,
  ReadonlyArray<Feature>
> = new Map();

export const ANNOTATION_OVERVIEW_TILE_BYTE_BUDGET = 4_000_000;

export function annotationGlyphPayloadCount(
  payload: GenomeAnnotationGlyphPayload | null | undefined
): number {
  return (payload?.glyphs.length ?? 0) + (payload?.compactGlyphs?.length ?? 0);
}
