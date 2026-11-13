import type { CatalogRecord } from '@waypoint/genome-data/annotation-catalog';

import {
  deriveCatalogTrackData,
  lowerBound,
  type CatalogDerivedData,
} from './catalog-derived-data';
import {
  catalogFootprints,
  declutterCatalogGlyphs,
  type CatalogDeclutterResult,
  type CatalogFootprints,
} from './catalog-declutter';
import { computeCatalogDensity, type CatalogDensityScratch } from './catalog-density';
import type { CatalogGlyphBatches } from './catalog-glyph-batches';
import { catalogX, type CatalogGlyphFrame } from './catalog-glyphs';
import {
  assignCatalogLanes,
  type CatalogLaneAssignment,
  type CatalogRowMode,
} from './catalog-rows';
import type { CatalogVisualizationSpec } from './catalog-visualizations';
import type { AnnotationCatalogTrackData } from './types';

export const CATALOG_CULL_MARGIN_PX = 16;
export const CATALOG_DENSITY_BIN_PX = 3;
export const CATALOG_MAX_GLYPHS_PER_BUILD = 20_000;

export function catalogDataUnitBp(
  data: AnnotationCatalogTrackData,
  derived: CatalogDerivedData
): number {
  if (data.kind === 'transcription_unit') return Math.max(1, derived.medianSpanBp);
  return data.genomeLengthBp / Math.max(1, derived.count);
}

export interface CatalogDetailResult {
  readonly paintedGlyphs: number;
  readonly decluttered: number;
  readonly glyphCapSkipped: number;
}

export function buildCatalogDetailGlyphs(input: {
  readonly spec: CatalogVisualizationSpec;
  readonly records: readonly CatalogRecord[];
  readonly derived: CatalogDerivedData;
  readonly lanes: CatalogLaneAssignment;
  readonly keep: Uint8Array;
  readonly frame: CatalogGlyphFrame;
  readonly viewEndBp: number;
  readonly batches: CatalogGlyphBatches;
  readonly maxGlyphs: number;
}): CatalogDetailResult {
  const { spec, records, derived, lanes, keep, frame, batches, maxGlyphs } = input;
  const marginBp = CATALOG_CULL_MARGIN_PX / frame.pixelsPerBp;
  const cullStart = frame.viewStartBp - marginBp;
  const cullEnd = input.viewEndBp + marginBp;
  const from = lowerBound(derived.anchorsSorted, cullStart - derived.maxSpanBp);
  const to = lowerBound(derived.anchorsSorted, cullEnd + derived.maxSpanBp);

  let paintedGlyphs = 0;
  let decluttered = 0;
  let glyphCapSkipped = 0;
  for (let k = from; k < to; k++) {
    const i = derived.anchorOrder[k];
    const anchor = derived.anchorEdges[i];
    const extentStart = Math.min(derived.starts[i], anchor);
    const extentEnd = Math.max(derived.ends[i], anchor);
    if (extentEnd <= cullStart || extentStart >= cullEnd) continue;
    const lane = lanes.lanes[i];
    if (lane < 0) continue;
    if (keep[i] === 0) {
      decluttered += 1;
      continue;
    }
    if (paintedGlyphs >= maxGlyphs) {
      glyphCapSkipped += 1;
      continue;
    }
    spec.drawGlyph(batches, frame, records[i], i, lane, anchor);
    paintedGlyphs += 1;
  }
  return { paintedGlyphs, decluttered, glyphCapSkipped };
}

export function buildCatalogDensityBars(input: {
  readonly derived: CatalogDerivedData;
  readonly frame: CatalogGlyphFrame;
  readonly viewEndBp: number;
  readonly batches: CatalogGlyphBatches;
  readonly scratch: CatalogDensityScratch;
}): number {
  const { derived, frame, batches } = input;
  const density = computeCatalogDensity({
    derived,
    viewStartBp: frame.viewStartBp,
    viewEndBp: input.viewEndBp,
    pixelsPerBp: frame.pixelsPerBp,
    binPx: CATALOG_DENSITY_BIN_PX,
    scratch: input.scratch,
  });
  if (density.maxCount === 0) return 0;
  const { rows } = frame;
  const blockRows = Math.min(
    rows.forwardRows > 0 ? rows.forwardRows : Number.POSITIVE_INFINITY,
    rows.reverseRows > 0 ? rows.reverseRows : Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(blockRows)) return 0;
  const pxPerCount = (blockRows * rows.rowHeightPx) / density.maxCount;
  const binBp = density.binPx / frame.pixelsPerBp;
  let bins = 0;
  for (let bin = 0; bin < density.binCount; bin++) {
    const forwardCount = density.forward[bin];
    const reverseCount = density.reverse[bin];
    if (forwardCount === 0 && reverseCount === 0) continue;
    const x = catalogX(frame, (density.firstBin + bin) * binBp);
    if (forwardCount > 0) {
      const height = Math.max(1, pxPerCount * forwardCount);
      batches.density.rect(x, rows.baselineYPx - height, density.binPx, height);
      bins += 1;
    }
    if (reverseCount > 0) {
      const height = Math.max(1, pxPerCount * reverseCount);
      batches.density.rect(x, rows.baselineYPx, density.binPx, height);
      bins += 1;
    }
  }
  return bins;
}

export class CatalogDataCache {
  private readonly derived = new WeakMap<AnnotationCatalogTrackData, CatalogDerivedData>();
  private readonly lanes = new WeakMap<
    AnnotationCatalogTrackData,
    Map<string, CatalogLaneAssignment>
  >();
  private readonly footprints = new WeakMap<
    AnnotationCatalogTrackData,
    Map<string, CatalogFootprints>
  >();

  derivedFor(data: AnnotationCatalogTrackData): CatalogDerivedData {
    let derived = this.derived.get(data);
    if (!derived) {
      derived = deriveCatalogTrackData(data);
      this.derived.set(data, derived);
    }
    return derived;
  }

  lanesFor(
    data: AnnotationCatalogTrackData,
    mode: CatalogRowMode,
    maxRowsPerStrand: number
  ): CatalogLaneAssignment {
    const byKey = mapFor(this.lanes, data);
    const key = mode === 'strand-rows' ? mode : `${mode}:${maxRowsPerStrand}`;
    let lanes = byKey.get(key);
    if (!lanes) {
      lanes = assignCatalogLanes({ derived: this.derivedFor(data), mode, maxRowsPerStrand });
      byKey.set(key, lanes);
    }
    return lanes;
  }

  footprintsFor(
    data: AnnotationCatalogTrackData,
    spec: CatalogVisualizationSpec
  ): CatalogFootprints {
    const bySpec = mapFor(this.footprints, data);
    let footprints = bySpec.get(spec.id);
    if (!footprints) {
      footprints = catalogFootprints(data.records, this.derivedFor(data), spec.declutter);
      bySpec.set(spec.id, footprints);
    }
    return footprints;
  }
}

function mapFor<V>(
  cache: WeakMap<AnnotationCatalogTrackData, Map<string, V>>,
  data: AnnotationCatalogTrackData
): Map<string, V> {
  let map = cache.get(data);
  if (!map) {
    map = new Map();
    cache.set(data, map);
  }
  return map;
}

export interface CatalogDeclutterMemo {
  readonly lanes: CatalogLaneAssignment;
  readonly footprints: CatalogFootprints;
  readonly pixelsPerBp: number;
  readonly result: CatalogDeclutterResult;
}

export function declutterForZoom(input: {
  readonly memo: CatalogDeclutterMemo | null;
  readonly lanes: CatalogLaneAssignment;
  readonly footprints: CatalogFootprints;
  readonly derived: CatalogDerivedData;
  readonly pixelsPerBp: number;
}): CatalogDeclutterMemo {
  const { memo, lanes, footprints, pixelsPerBp } = input;
  if (
    memo &&
    memo.lanes === lanes &&
    memo.footprints === footprints &&
    memo.pixelsPerBp === pixelsPerBp
  ) {
    return memo;
  }
  return {
    lanes,
    footprints,
    pixelsPerBp,
    result: declutterCatalogGlyphs({
      footprints,
      lanes,
      forward: input.derived.forward,
      pixelsPerBp,
    }),
  };
}
