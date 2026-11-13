import { BUILTIN_ANNOTATION_VISUALIZATIONS } from '@waypoint/genome-data/annotation-catalog';

import type { PixiLinearTrackRenderer } from '../types';
import { CatalogDataCache } from './catalog-geometry';
import { PixiAnnotationCatalogTrackRenderer } from './catalog-track-renderer';
import { CATALOG_VISUALIZATION_SPECS } from './catalog-visualizations';
import type { AnnotationCatalogTrackData } from './types';

export {
  ANNOTATION_CATALOG_TRACK_TYPE_PREFIX,
  annotationCatalogTrackType,
  type AnnotationCatalogCamera,
  type AnnotationCatalogGeneSpan,
  type AnnotationCatalogRendererDiagnostics,
  type AnnotationCatalogRowLayout,
  type AnnotationCatalogTrackData,
  type AnnotationCatalogTrackDiagnostics,
} from './types';
export { catalogKindColor, TRANSCRIPTION_UNIT_GENE_PALETTE } from './catalog-colors';

export function createAnnotationCatalogTrackRenderers(): PixiLinearTrackRenderer<AnnotationCatalogTrackData>[] {
  const cache = new CatalogDataCache();
  const specs = new Map(CATALOG_VISUALIZATION_SPECS.map((spec) => [spec.id, spec]));
  return BUILTIN_ANNOTATION_VISUALIZATIONS.map((definition) => {
    const spec = specs.get(definition.id);
    if (!spec) {
      throw new Error(`No catalog track renderer for visualization "${definition.id}"`);
    }
    return new PixiAnnotationCatalogTrackRenderer(spec, cache);
  });
}
