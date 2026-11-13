import { visualizationId, type VisualizationId } from '@waypoint/genome-data/annotation-catalog';

import type { CatalogDeclutterRule } from './catalog-declutter';
import {
  CATALOG_POINT_GLYPH_WIDTH_PX,
  drawIntervalBox,
  drawPositionTick,
  drawPromoterArrow,
  drawTerminatorHairpin,
  drawTranscriptionUnitArrow,
  type CatalogGlyphDrawer,
} from './catalog-glyphs';
import type { CatalogRowMode } from './catalog-rows';

export interface CatalogVisualizationSpec {
  readonly id: VisualizationId;
  readonly rowMode: CatalogRowMode;
  readonly defaultRowHeightPx: number;
  readonly defaultMaxRowsPerStrand: number;
  readonly declutter: CatalogDeclutterRule;
  readonly drawGlyph: CatalogGlyphDrawer;
}

export const CATALOG_POINT_GLYPH_MIN_GAP_PX = 4;

const POINT_DECLUTTER: CatalogDeclutterRule = {
  by: 'anchor',
  minGapPx: CATALOG_POINT_GLYPH_MIN_GAP_PX,
};

const SPAN_DECLUTTER: CatalogDeclutterRule = {
  by: 'span',
  minGapPx: 0,
  minWidthPx: 1,
  pointWidthPx: CATALOG_POINT_GLYPH_WIDTH_PX,
};

export const CATALOG_VISUALIZATION_SPECS: readonly CatalogVisualizationSpec[] = Object.freeze([
  {
    id: visualizationId('promoter-arrow'),
    rowMode: 'strand-rows',
    defaultRowHeightPx: 16,
    defaultMaxRowsPerStrand: 1,
    declutter: POINT_DECLUTTER,
    drawGlyph: drawPromoterArrow,
  },
  {
    id: visualizationId('terminator-hairpin'),
    rowMode: 'strand-rows',
    defaultRowHeightPx: 14,
    defaultMaxRowsPerStrand: 1,
    declutter: POINT_DECLUTTER,
    drawGlyph: drawTerminatorHairpin,
  },
  {
    id: visualizationId('transcription-unit-arrows'),
    rowMode: 'stacked',
    defaultRowHeightPx: 12,
    defaultMaxRowsPerStrand: 10,
    declutter: SPAN_DECLUTTER,
    drawGlyph: drawTranscriptionUnitArrow,
  },
  {
    id: visualizationId('position-ticks'),
    rowMode: 'strand-rows',
    defaultRowHeightPx: 12,
    defaultMaxRowsPerStrand: 1,
    declutter: POINT_DECLUTTER,
    drawGlyph: drawPositionTick,
  },
  {
    id: visualizationId('interval-boxes'),
    rowMode: 'stacked',
    defaultRowHeightPx: 10,
    defaultMaxRowsPerStrand: 10,
    declutter: SPAN_DECLUTTER,
    drawGlyph: drawIntervalBox,
  },
]);
