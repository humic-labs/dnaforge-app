import type { CatalogRecord } from '@waypoint/genome-data/annotation-catalog';

import type { CatalogDerivedData } from './catalog-derived-data';
import type { CatalogLaneAssignment } from './catalog-rows';

export type CatalogDeclutterRule =
  | { readonly by: 'anchor'; readonly minGapPx: number }
  | {
      readonly by: 'span';
      readonly minGapPx: number;
      readonly minWidthPx: number;
      readonly pointWidthPx: number;
    };

export interface CatalogFootprints {
  readonly centerBp: Float64Array;
  readonly halfWidthBp: Float64Array;
  readonly minHalfWidthPx: Float32Array;
  readonly order: Uint32Array;
  readonly minGapPx: number;
}

export function catalogFootprints(
  records: readonly CatalogRecord[],
  derived: CatalogDerivedData,
  rule: CatalogDeclutterRule
): CatalogFootprints {
  const count = derived.count;
  const centerBp = new Float64Array(count);
  const halfWidthBp = new Float64Array(count);
  const minHalfWidthPx = new Float32Array(count);
  if (rule.by === 'anchor') {
    centerBp.set(derived.anchorEdges);
    return {
      centerBp,
      halfWidthBp,
      minHalfWidthPx,
      order: derived.anchorOrder,
      minGapPx: rule.minGapPx,
    };
  }
  for (let i = 0; i < count; i++) {
    const start = derived.starts[i];
    const end = derived.ends[i];
    centerBp[i] = (start + end) / 2;
    halfWidthBp[i] = (end - start) / 2;
    const isPoint = records[i].location.shape === 'point';
    minHalfWidthPx[i] = (isPoint ? rule.pointWidthPx : rule.minWidthPx) / 2;
  }
  return {
    centerBp,
    halfWidthBp,
    minHalfWidthPx,
    order: derived.startOrder,
    minGapPx: rule.minGapPx,
  };
}

const EDGE_TOLERANCE_PX = 1e-6;

export interface CatalogDeclutterResult {
  readonly keep: Uint8Array;
  readonly kept: number;
}

export function declutterCatalogGlyphs(input: {
  readonly footprints: CatalogFootprints;
  readonly lanes: CatalogLaneAssignment;
  readonly forward: Uint8Array;
  readonly pixelsPerBp: number;
}): CatalogDeclutterResult {
  const { footprints, lanes, forward, pixelsPerBp } = input;
  const count = footprints.centerBp.length;
  const keep = new Uint8Array(count);
  const rightEdge = new Float64Array(lanes.forwardRows + lanes.reverseRows).fill(
    Number.NEGATIVE_INFINITY
  );
  const gap = footprints.minGapPx;
  let kept = 0;
  for (let k = 0; k < count; k++) {
    const i = footprints.order[k];
    const lane = lanes.lanes[i];
    if (lane < 0) continue;
    const row = forward[i] === 1 ? lane : lanes.forwardRows + lane;
    const center = footprints.centerBp[i] * pixelsPerBp;
    const half = Math.max(footprints.halfWidthBp[i] * pixelsPerBp, footprints.minHalfWidthPx[i]);
    const left = center - half;
    if (left - rightEdge[row] < gap - EDGE_TOLERANCE_PX) continue;
    keep[i] = 1;
    kept += 1;
    const right = center + half;
    if (right > rightEdge[row]) rightEdge[row] = right;
  }
  return { keep, kept };
}
