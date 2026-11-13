import { Container, Graphics } from 'pixi.js';

import type { AnnotationEvidenceClass } from '@waypoint/genome-data/annotation-catalog';

import type { TrackType } from '../../../../tracks/types';
import { decideTrackLod, type TrackLod } from '../../lod/lod-policy';
import type { WebGLThemeMode } from '../../shared/theme';
import { trackMaxRows, trackRowHeightPx } from '../track-presentation';
import type {
  PixiLinearTrackRenderer,
  TrackMeasureContentArgs,
  TrackMountArgs,
  TrackPaintArgs,
} from '../types';
import { catalogTrackColor } from './catalog-colors';
import {
  CATALOG_CULL_MARGIN_PX,
  CATALOG_MAX_GLYPHS_PER_BUILD,
  buildCatalogDensityBars,
  buildCatalogDetailGlyphs,
  catalogDataUnitBp,
  declutterForZoom,
  type CatalogDataCache,
  type CatalogDeclutterMemo,
} from './catalog-geometry';
import { createCatalogDensityScratch, type CatalogDensityScratch } from './catalog-density';
import {
  clipCatalogDashes,
  createCatalogGlyphBatches,
  resetCatalogGlyphBatches,
  type CatalogGlyphBatches,
} from './catalog-glyph-batches';
import type { CatalogGlyphFrame } from './catalog-glyphs';
import { paintCatalogBatches } from './catalog-graphics-painter';
import {
  EMPTY_CATALOG_TRACK_HEIGHT_PX,
  catalogContentHeightPx,
  fitCatalogRows,
} from './catalog-rows';
import type { CatalogVisualizationSpec } from './catalog-visualizations';
import {
  annotationCatalogTrackType,
  type AnnotationCatalogCamera,
  type AnnotationCatalogRendererDiagnostics,
  type AnnotationCatalogTrackData,
} from './types';

interface CatalogChangeKey {
  data: AnnotationCatalogTrackData | null;
  viewStartBp: number;
  viewEndBp: number;
  pixelsPerBp: number;
  widthPx: number;
  heightPx: number;
  themeMode: WebGLThemeMode;
  color: string | undefined;
  rowHeightPx: number | undefined;
  maxRows: number | undefined;
}

interface CatalogBatchStyle {
  readonly color: number;
  readonly evidence: AnnotationEvidenceClass;
  readonly themeMode: WebGLThemeMode;
  readonly batches: CatalogGlyphBatches;
}

interface CatalogTrackState {
  readonly graphics: Graphics;
  key: CatalogChangeKey | null;
  style: CatalogBatchStyle | null;
  declutter: CatalogDeclutterMemo | null;
  readonly densityScratch: CatalogDensityScratch;
  lodDecision: TrackLod | null;
  diagnostics: Omit<AnnotationCatalogRendererDiagnostics, 'visualizationId'>;
}

const EMPTY_DIAGNOSTICS: Omit<
  AnnotationCatalogRendererDiagnostics,
  'visualizationId' | 'rebuilds'
> = {
  kind: null,
  recordCount: 0,
  lod: 'empty',
  paintedGlyphs: 0,
  decluttered: 0,
  aggregateBins: 0,
  lanes: 0,
  camera: null,
  overflowed: 0,
  glyphCapSkipped: 0,
  rowLayout: null,
};

export class PixiAnnotationCatalogTrackRenderer implements PixiLinearTrackRenderer<AnnotationCatalogTrackData> {
  readonly type: TrackType;
  private readonly states = new WeakMap<Container, CatalogTrackState>();

  constructor(
    private readonly spec: CatalogVisualizationSpec,
    private readonly cache: CatalogDataCache
  ) {
    this.type = annotationCatalogTrackType(spec.id);
  }

  mount(_args: TrackMountArgs): Container {
    const container = new Container();
    container.eventMode = 'none';
    const graphics = new Graphics();
    graphics.eventMode = 'none';
    container.addChild(graphics);
    this.states.set(container, {
      graphics,
      key: null,
      style: null,
      declutter: null,
      densityScratch: createCatalogDensityScratch(),
      lodDecision: null,
      diagnostics: { ...EMPTY_DIAGNOSTICS, rebuilds: 0 },
    });
    return container;
  }

  measureContentHeight(args: TrackMeasureContentArgs<AnnotationCatalogTrackData>): number {
    const data = args.data;
    if (!data || data.records.length === 0) return EMPTY_CATALOG_TRACK_HEIGHT_PX;
    const lanes = this.cache.lanesFor(
      data,
      this.spec.rowMode,
      trackMaxRows(args.presentation, this.spec.defaultMaxRowsPerStrand)
    );
    return catalogContentHeightPx(
      lanes.forwardRows + lanes.reverseRows,
      trackRowHeightPx(args.presentation, this.spec.defaultRowHeightPx)
    );
  }

  paint(args: TrackPaintArgs<AnnotationCatalogTrackData>): void {
    const state = this.states.get(args.container);
    if (!state) return;

    const pixelsPerBp = args.pathMapper.pixelsPerBp;
    const rangeStart = args.viewportBpRange.start;
    const viewStartBp =
      pixelsPerBp > 0 ? rangeStart - args.pathMapper.bpLeftX(rangeStart) / pixelsPerBp : rangeStart;
    const { presentation } = args;
    const key = state.key;
    if (
      key !== null &&
      key.data === args.data &&
      key.viewStartBp === viewStartBp &&
      key.viewEndBp === args.viewportBpRange.end &&
      key.pixelsPerBp === pixelsPerBp &&
      key.widthPx === args.viewportWidthPx &&
      key.heightPx === args.layoutEntry.height &&
      key.themeMode === args.theme.mode &&
      key.color === presentation.color &&
      key.rowHeightPx === presentation.rowHeightPx &&
      key.maxRows === presentation.maxRows
    ) {
      return;
    }
    state.key = {
      data: args.data,
      viewStartBp,
      viewEndBp: args.viewportBpRange.end,
      pixelsPerBp,
      widthPx: args.viewportWidthPx,
      heightPx: args.layoutEntry.height,
      themeMode: args.theme.mode,
      color: presentation.color,
      rowHeightPx: presentation.rowHeightPx,
      maxRows: presentation.maxRows,
    };
    this.rebuild(state, args, state.key);
  }

  getDiagnostics(container: Container): AnnotationCatalogRendererDiagnostics | null {
    const state = this.states.get(container);
    if (!state) return null;
    return { visualizationId: this.spec.id, ...state.diagnostics };
  }

  unmount(container: Container): void {
    const state = this.states.get(container);
    state?.graphics.destroy();
    this.states.delete(container);
    container.destroy({ children: true });
  }

  private rebuild(
    state: CatalogTrackState,
    args: TrackPaintArgs<AnnotationCatalogTrackData>,
    key: CatalogChangeKey
  ): void {
    const rebuilds = state.diagnostics.rebuilds + 1;
    const camera: AnnotationCatalogCamera = {
      viewStartBp: key.viewStartBp,
      pixelsPerBp: key.pixelsPerBp,
      widthPx: key.widthPx,
    };
    const data = key.data;
    if (!data || data.records.length === 0) {
      state.graphics.clear();
      state.lodDecision = null;
      state.diagnostics = {
        ...EMPTY_DIAGNOSTICS,
        kind: data?.kind ?? null,
        camera,
        rebuilds,
      };
      return;
    }

    const { spec, cache } = this;
    const derived = cache.derivedFor(data);
    const lanes = cache.lanesFor(
      data,
      spec.rowMode,
      trackMaxRows(args.presentation, spec.defaultMaxRowsPerStrand)
    );
    const rows = fitCatalogRows({
      forwardRows: lanes.forwardRows,
      reverseRows: lanes.reverseRows,
      preferredRowHeightPx: trackRowHeightPx(args.presentation, spec.defaultRowHeightPx),
      heightPx: key.heightPx,
    });
    const base = {
      kind: data.kind,
      recordCount: data.records.length,
      lanes: lanes.forwardRows + lanes.reverseRows,
      camera,
      overflowed: lanes.overflowed,
      rowLayout: rows,
      rebuilds,
    };
    if (!(key.pixelsPerBp > 0) || key.widthPx <= 0 || key.heightPx <= 0) {
      state.graphics.clear();
      state.diagnostics = { ...EMPTY_DIAGNOSTICS, ...base };
      return;
    }

    const lod = decideTrackLod({
      pixelsPerBp: key.pixelsPerBp,
      dataUnitBp: catalogDataUnitBp(data, derived),
      prev: state.lodDecision ?? undefined,
    });
    state.lodDecision = lod;
    const batches = this.batchesFor(
      state,
      catalogTrackColor(data.kind, key.color, key.themeMode),
      data.evidence,
      key.themeMode
    );
    clipCatalogDashes(batches, -CATALOG_CULL_MARGIN_PX, key.widthPx + CATALOG_CULL_MARGIN_PX);
    const frame: CatalogGlyphFrame = {
      viewStartBp: key.viewStartBp,
      pixelsPerBp: key.pixelsPerBp,
      rows,
      genesByName: data.genesByName,
      scoreScale: derived.scoreScale,
    };

    if (lod === 'detail') {
      state.declutter = declutterForZoom({
        memo: state.declutter,
        lanes,
        footprints: cache.footprintsFor(data, spec),
        derived,
        pixelsPerBp: key.pixelsPerBp,
      });
      const detail = buildCatalogDetailGlyphs({
        spec,
        records: data.records,
        derived,
        lanes,
        keep: state.declutter.result.keep,
        frame,
        viewEndBp: key.viewEndBp,
        batches,
        maxGlyphs: CATALOG_MAX_GLYPHS_PER_BUILD,
      });
      state.diagnostics = { ...base, lod, ...detail, aggregateBins: 0 };
    } else {
      const aggregateBins = buildCatalogDensityBars({
        derived,
        frame,
        viewEndBp: key.viewEndBp,
        batches,
        scratch: state.densityScratch,
      });
      state.diagnostics = {
        ...base,
        lod,
        paintedGlyphs: 0,
        decluttered: 0,
        glyphCapSkipped: 0,
        aggregateBins,
      };
    }
    paintCatalogBatches(state.graphics, batches.ordered);
  }

  private batchesFor(
    state: CatalogTrackState,
    color: number,
    evidence: AnnotationEvidenceClass,
    themeMode: WebGLThemeMode
  ): CatalogGlyphBatches {
    const style = state.style;
    if (
      style !== null &&
      style.color === color &&
      style.evidence === evidence &&
      style.themeMode === themeMode
    ) {
      resetCatalogGlyphBatches(style.batches);
      return style.batches;
    }
    const batches = createCatalogGlyphBatches({ color, evidence, themeMode });
    state.style = { color, evidence, themeMode, batches };
    return batches;
  }
}
