import type {
  AnnotationEvidenceClass,
  CatalogRecord,
  FeatureKind,
  Strand,
  VisualizationId,
} from '@waypoint/genome-data/annotation-catalog';

import type { TrackType } from '../../../../tracks/types';

export const ANNOTATION_CATALOG_TRACK_TYPE_PREFIX = 'annotation-catalog:';

export function annotationCatalogTrackType(visualizationId: VisualizationId): TrackType {
  return `${ANNOTATION_CATALOG_TRACK_TYPE_PREFIX}${visualizationId}`;
}

export interface AnnotationCatalogGeneSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly strand: Strand;
}

export interface AnnotationCatalogTrackData {
  readonly kind: FeatureKind;
  readonly records: readonly CatalogRecord[];
  readonly evidence: AnnotationEvidenceClass;
  readonly genomeLengthBp: number;
  readonly genesByName: ReadonlyMap<string, AnnotationCatalogGeneSpan>;
}

export interface AnnotationCatalogCamera {
  readonly viewStartBp: number;
  readonly pixelsPerBp: number;
  readonly widthPx: number;
}

export interface AnnotationCatalogTrackDiagnostics {
  readonly visualizationId: VisualizationId;
  readonly kind: FeatureKind | null;
  readonly recordCount: number;
  readonly lod: 'detail' | 'aggregate' | 'empty';
  readonly paintedGlyphs: number;
  readonly decluttered: number;
  readonly aggregateBins: number;
  readonly lanes: number;
  readonly camera: AnnotationCatalogCamera | null;
  readonly rebuilds: number;
}

export interface AnnotationCatalogRowLayout {
  readonly rowHeightPx: number;
  readonly forwardRows: number;
  readonly reverseRows: number;
  readonly baselineYPx: number;
}

export interface AnnotationCatalogRendererDiagnostics extends AnnotationCatalogTrackDiagnostics {
  readonly overflowed: number;
  readonly glyphCapSkipped: number;
  readonly rowLayout: AnnotationCatalogRowLayout | null;
}
