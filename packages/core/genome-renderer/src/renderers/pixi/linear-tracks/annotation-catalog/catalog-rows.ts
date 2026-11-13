import type { CatalogDerivedData } from './catalog-derived-data';
import type { AnnotationCatalogRowLayout } from './types';

export type CatalogRowMode = 'strand-rows' | 'stacked';

export const CATALOG_TRACK_PADDING_PX = 2;
export const EMPTY_CATALOG_TRACK_HEIGHT_PX = 28;

export interface CatalogLaneAssignment {
  readonly lanes: Int16Array;
  readonly forwardRows: number;
  readonly reverseRows: number;
  readonly overflowed: number;
}

export function assignCatalogLanes(input: {
  readonly derived: CatalogDerivedData;
  readonly mode: CatalogRowMode;
  readonly maxRowsPerStrand: number;
}): CatalogLaneAssignment {
  const { derived, mode } = input;
  const lanes = new Int16Array(derived.count);
  if (mode === 'strand-rows') {
    return {
      lanes,
      forwardRows: derived.hasForward ? 1 : 0,
      reverseRows: derived.hasReverse ? 1 : 0,
      overflowed: 0,
    };
  }

  const maxRows = Math.max(1, Math.min(0x7fff, Math.floor(input.maxRowsPerStrand)));
  const rowEnds: [number[], number[]] = [[], []];
  let overflowed = 0;
  for (let k = 0; k < derived.count; k++) {
    const i = derived.startOrder[k];
    const ends = rowEnds[derived.forward[i] === 1 ? 0 : 1];
    const start = derived.starts[i];
    let lane = -1;
    for (let row = 0; row < ends.length; row++) {
      if (ends[row] <= start) {
        lane = row;
        break;
      }
    }
    if (lane < 0 && ends.length < maxRows) {
      lane = ends.length;
      ends.push(0);
    }
    if (lane < 0) {
      lanes[i] = -1;
      overflowed += 1;
      continue;
    }
    lanes[i] = lane;
    ends[lane] = derived.ends[i];
  }
  return { lanes, forwardRows: rowEnds[0].length, reverseRows: rowEnds[1].length, overflowed };
}

export function catalogContentHeightPx(rows: number, rowHeightPx: number): number {
  if (rows <= 0) return EMPTY_CATALOG_TRACK_HEIGHT_PX;
  return rows * rowHeightPx + 2 * CATALOG_TRACK_PADDING_PX;
}

export function fitCatalogRows(input: {
  readonly forwardRows: number;
  readonly reverseRows: number;
  readonly preferredRowHeightPx: number;
  readonly heightPx: number;
}): AnnotationCatalogRowLayout {
  const { forwardRows, reverseRows, preferredRowHeightPx } = input;
  const rows = forwardRows + reverseRows;
  const available = Math.max(0, input.heightPx - 2 * CATALOG_TRACK_PADDING_PX);
  const rowHeightPx = rows === 0 ? 0 : Math.min(preferredRowHeightPx, available / rows);
  return {
    rowHeightPx,
    forwardRows,
    reverseRows,
    baselineYPx: CATALOG_TRACK_PADDING_PX + forwardRows * rowHeightPx,
  };
}

export function awayFromBaseline(forward: boolean): -1 | 1 {
  return forward ? -1 : 1;
}

export function rowBaseY(layout: AnnotationCatalogRowLayout, away: -1 | 1, lane: number): number {
  return layout.baselineYPx + away * lane * layout.rowHeightPx;
}
