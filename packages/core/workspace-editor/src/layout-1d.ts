import type { Annotation, ORF } from '@waypoint/sequence-utils';
import type { AnnotationWithLane, ClassifiedCDS, ORFWithLane, PrimerDisplay } from './types';
import { DEFAULT_EDITOR_CONFIG } from './types';
import type { SequenceLayout, Segment, HitResult, Tick } from './layout-interface';
import { pickTickStep } from './ruler-ticks';
import { classifyAndAssignCDSLanes } from './useSequenceLayout';
import {
  translationLaneHeight as cdsLaneHeight,
  TRANSLATION_AA_HEIGHT_RATIO,
} from './layout-constants';
import { PRIMER_CANVAS_CONSTANTS } from './canvas-constants';
import { ORF_LANE_GAP } from './orf-drawing';
import { packPrimerLanes } from './primer-layout';

export const MAX_LANES_1D = 8;

export const MIN_PX_PER_BASE_1D = 0.1;

export const MAX_PX_PER_BASE_1D = DEFAULT_EDITOR_CONFIG.charWidth;

export const LANE_HEIGHT_1D = 14;

export const LANE_GAP_1D = 2;

export const SEQUENCE_ROW_HEIGHT_1D = 18;

export const RULER_HEIGHT_1D = 18;

export const OVERFLOW_ROW_HEIGHT_1D = 10;

export const CUT_SITE_LABEL_ROW_HEIGHT_1D = 18;

export const HORIZONTAL_PADDING_1D = 8;

export const VERTICAL_PADDING_TOP_1D = 4;

export const VERTICAL_PADDING_BOTTOM_1D = 4;

export interface Layout1DInput {
  columnCount: number;
  annotations: readonly Annotation[];
  selectedIds?: ReadonlySet<string>;
  pxPerBase: number;
  fullSequence?: string;
  orfs?: readonly ORF[];
  isCircular?: boolean;
  showReverseComplement?: boolean;
  showCutSites?: boolean;
  showRuler?: boolean;
  primers?: readonly PrimerDisplay[];
  showPrimers?: boolean;
  hasMutationTrack?: boolean;
  gappedSequence?: string;
}

export type OverflowCounts = Uint16Array;

export interface Layout1D {
  totalWidth: number;
  totalHeight: number;

  columnCount: number;
  renderColumnCount: number;
  isCircular: boolean;
  pxPerBase: number;

  showReverseComplement: boolean;
  complementRowY: number;
  annotations: AnnotationWithLane[];
  laneCount: number;
  overflowCounts: OverflowCounts;
  hasOverflow: boolean;

  classifiedCDSs: ClassifiedCDS[];
  translationLaneCount: number;

  orfsWithLanes: ORFWithLane[];
  orfLaneCount: number;

  overflowBandY: number;
  laneBandTop: number;
  laneBandHeight: number;
  cutSiteLabelRowY: number;
  cutSiteLabelRowHeight: number;
  forwardPrimerBandTop: number;
  forwardPrimerBandHeight: number;
  forwardPrimerLaneCount: number;
  reversePrimerBandTop: number;
  reversePrimerBandHeight: number;
  reversePrimerLaneCount: number;
  translationBandTop: number;
  translationLaneHeight: number;
  translationBandHeight: number;
  orfBandTop: number;
  orfLaneHeight: number;
  orfBandHeight: number;
  sequenceRowY: number;
  sequenceRowHeight: number;
  rulerY: number;

  mutationTrackY: number;
  mutationTrackHeight: number;
  hasMutationTrack: boolean;

  gappedSequence?: string;
  colToBio?: Int32Array;
}

function rangeOf(ann: Annotation): { start: number; end: number } {
  return { start: ann.start - 1, end: ann.end };
}

function annotationId(ann: Annotation): string {
  const id = (ann as { id?: string }).id;
  if (id) return id;
  return `${ann.name}:${ann.start}-${ann.end}:${ann.direction ?? 1}`;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

interface PackResult {
  placed: AnnotationWithLane[];
  laneCount: number;
  overflowCounts: OverflowCounts;
  hasOverflow: boolean;
}

export function pack1D(
  annotations: readonly Annotation[],
  columnCount: number,
  selectedIds: ReadonlySet<string> = new Set()
): PackResult {
  const overflowCounts = new Uint16Array(Math.max(0, columnCount));

  if (annotations.length === 0) {
    return { placed: [], laneCount: 0, overflowCounts, hasOverflow: false };
  }

  const decorated = annotations.map((ann) => {
    const { start, end } = rangeOf(ann);
    return {
      ann,
      id: annotationId(ann),
      start,
      end,
      length: Math.max(0, end - start),
      selected: selectedIds.has(annotationId(ann)),
    };
  });

  decorated.sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    if (a.length !== b.length) return b.length - a.length;
    return a.start - b.start;
  });

  const lanes: Array<Array<{ start: number; end: number; id: string; selected: boolean }>> = [];
  const placed: AnnotationWithLane[] = [];

  for (const item of decorated) {
    let assignedLane = -1;
    for (let lane = 0; lane < lanes.length && lane < MAX_LANES_1D; lane++) {
      const occ = lanes[lane];
      const conflict = occ.some((o) => overlaps(o, item));
      if (!conflict) {
        assignedLane = lane;
        break;
      }
    }

    if (assignedLane === -1 && lanes.length < MAX_LANES_1D) {
      assignedLane = lanes.length;
      lanes.push([]);
    }

    if (assignedLane === -1) {
      if (item.selected) {
        let targetLane = -1;
        let targetIdx = -1;
        for (let lane = lanes.length - 1; lane >= 0; lane--) {
          const occ = lanes[lane];
          for (let i = occ.length - 1; i >= 0; i--) {
            const o = occ[i];
            if (!o.selected && overlaps(o, item)) {
              targetLane = lane;
              targetIdx = i;
              break;
            }
          }
          if (targetLane !== -1) break;
        }

        if (targetLane !== -1) {
          const displaced = lanes[targetLane].splice(targetIdx, 1)[0];
          lanes[targetLane].push(item);
          const idx = placed.findIndex((p) => annotationId(p) === displaced.id);
          if (idx !== -1) placed.splice(idx, 1);
          for (
            let c = Math.max(0, displaced.start);
            c < Math.min(columnCount, displaced.end);
            c++
          ) {
            overflowCounts[c] += 1;
          }
          placed.push({ ...item.ann, lane: targetLane });
          continue;
        }
      }

      for (let c = Math.max(0, item.start); c < Math.min(columnCount, item.end); c++) {
        overflowCounts[c] += 1;
      }
      continue;
    }

    lanes[assignedLane].push(item);
    placed.push({ ...item.ann, lane: assignedLane });
  }

  let hasOverflow = false;
  for (let i = 0; i < overflowCounts.length; i++) {
    if (overflowCounts[i] > 0) {
      hasOverflow = true;
      break;
    }
  }

  return { placed, laneCount: lanes.length, overflowCounts, hasOverflow };
}

export function compute1DLayout(input: Layout1DInput): Layout1D {
  const { columnCount, annotations, selectedIds, pxPerBase, fullSequence, orfs } = input;
  const isCircular = input.isCircular ?? false;
  const showRuler = input.showRuler ?? true;
  const clampedPx = Math.max(MIN_PX_PER_BASE_1D, Math.min(MAX_PX_PER_BASE_1D, pxPerBase));
  const renderColumnCount = columnCount;

  const nonCdsAnnotations = annotations.filter((a) => a.type !== 'CDS');
  const packed = pack1D(nonCdsAnnotations, columnCount, selectedIds);

  const cdsInput = [...annotations];
  const { classifiedCDSs, translationLaneCount } =
    fullSequence !== undefined
      ? classifyAndAssignCDSLanes(cdsInput, 0, columnCount, fullSequence, columnCount)
      : { classifiedCDSs: [] as ClassifiedCDS[], translationLaneCount: 0 };

  const orfsWithLanes = packORFsIntoLanes(orfs ?? []);
  const orfLaneCount =
    orfsWithLanes.length > 0 ? Math.max(0, ...orfsWithLanes.map((o) => o.lane)) + 1 : 0;

  const laneBandHeight =
    packed.laneCount > 0 ? packed.laneCount * (LANE_HEIGHT_1D + LANE_GAP_1D) - LANE_GAP_1D : 0;

  const zoomScale = clampedPx / DEFAULT_EDITOR_CONFIG.charWidth;
  const rowHeight = DEFAULT_EDITOR_CONFIG.rowHeight * zoomScale;
  const aaTrackHeight = rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
  const translationLaneHeight = cdsLaneHeight(rowHeight);
  const translationBandHeight =
    translationLaneCount > 0 ? translationLaneCount * translationLaneHeight : 0;

  const orfLaneHeight = aaTrackHeight;
  const orfBandHeight =
    orfLaneCount > 0 ? orfLaneCount * orfLaneHeight + (orfLaneCount - 1) * ORF_LANE_GAP : 0;

  const showPrimers = input.showPrimers ?? false;
  const primersIn = input.primers ?? [];
  const forwardPrimers =
    showPrimers && primersIn.length > 0 ? primersIn.filter((p) => p.direction === 'forward') : [];
  const reversePrimers =
    showPrimers && primersIn.length > 0 ? primersIn.filter((p) => p.direction === 'reverse') : [];
  const forwardPrimerLaneCount =
    forwardPrimers.length > 0
      ? packPrimerLanes(forwardPrimers, 0, columnCount, columnCount).laneCount
      : 0;
  const reversePrimerLaneCount =
    reversePrimers.length > 0
      ? packPrimerLanes(reversePrimers, 0, columnCount, columnCount).laneCount
      : 0;
  const primerLaneHeight =
    rowHeight *
    (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
  const forwardPrimerBandHeight = forwardPrimerLaneCount * primerLaneHeight;
  const reversePrimerBandHeight = reversePrimerLaneCount * primerLaneHeight;

  let y = VERTICAL_PADDING_TOP_1D;
  const overflowBandY = packed.hasOverflow ? y : 0;
  if (packed.hasOverflow) y += OVERFLOW_ROW_HEIGHT_1D + 2;

  const laneBandTop = y;
  y += laneBandHeight;
  if (laneBandHeight > 0) y += 2;

  const translationBandTop = y;
  y += translationBandHeight;
  if (translationBandHeight > 0) y += 2;

  const orfBandTop = y;
  y += orfBandHeight;
  if (orfBandHeight > 0) y += 2;

  const forwardPrimerBandTop = y;
  y += forwardPrimerBandHeight;

  const sequenceRowHeight = SEQUENCE_ROW_HEIGHT_1D * zoomScale;

  const sequenceRowY = y;
  y += sequenceRowHeight;

  const showReverseComplement = input.showReverseComplement ?? false;
  const complementRowY = y;
  if (showReverseComplement) y += sequenceRowHeight;

  const hasMutationTrack = input.hasMutationTrack ?? false;
  const mutationTrackHeight = hasMutationTrack ? sequenceRowHeight : 0;
  const mutationTrackY = y;
  if (mutationTrackHeight > 0) y += mutationTrackHeight;

  const reversePrimerBandTop = y;
  y += reversePrimerBandHeight;

  const showCutSitesLayout = (input.showCutSites ?? false) && showReverseComplement;
  const showPrimerCutLabelsLayout =
    showPrimers && showReverseComplement && hasVisiblePrimerCutLabel(primersIn);
  const cutSiteLabelRowHeight =
    showCutSitesLayout || showPrimerCutLabelsLayout ? CUT_SITE_LABEL_ROW_HEIGHT_1D : 0;
  const cutSiteLabelRowY = y;
  if (cutSiteLabelRowHeight > 0) y += cutSiteLabelRowHeight + 2;

  const rulerY = y;
  if (showRuler) y += RULER_HEIGHT_1D;

  y += VERTICAL_PADDING_BOTTOM_1D;

  const totalWidth = HORIZONTAL_PADDING_1D * 2 + renderColumnCount * clampedPx;
  const totalHeight = y;

  return {
    totalWidth,
    totalHeight,
    columnCount,
    renderColumnCount,
    isCircular,
    showReverseComplement,
    complementRowY,
    pxPerBase: clampedPx,
    annotations: packed.placed,
    laneCount: packed.laneCount,
    overflowCounts: packed.overflowCounts,
    hasOverflow: packed.hasOverflow,
    classifiedCDSs,
    translationLaneCount,
    orfsWithLanes,
    orfLaneCount,
    overflowBandY,
    laneBandTop,
    laneBandHeight,
    cutSiteLabelRowY,
    cutSiteLabelRowHeight,
    forwardPrimerBandTop,
    forwardPrimerBandHeight,
    forwardPrimerLaneCount,
    reversePrimerBandTop,
    reversePrimerBandHeight,
    reversePrimerLaneCount,
    translationBandTop,
    translationLaneHeight,
    translationBandHeight,
    orfBandTop,
    orfLaneHeight,
    orfBandHeight,
    sequenceRowY,
    sequenceRowHeight,
    rulerY,
    mutationTrackY,
    mutationTrackHeight,
    hasMutationTrack,
    gappedSequence: input.gappedSequence,
    colToBio: input.gappedSequence ? buildColToBio(input.gappedSequence) : undefined,
  };
}

function hasVisiblePrimerCutLabel(primers: readonly PrimerDisplay[]): boolean {
  return primers.some(
    (primer) =>
      primer.direction === 'forward' &&
      typeof primer.cutPositionInOverhang === 'number' &&
      primer.cutPositionInOverhang > 0 &&
      Boolean(primer.enzymeName) &&
      !primer.suppressCutSiteRendering
  );
}

function buildColToBio(gappedSeq: string): Int32Array {
  const arr = new Int32Array(gappedSeq.length);
  let bio = 0;
  for (let i = 0; i < gappedSeq.length; i++) {
    if (gappedSeq[i] === '-') {
      arr[i] = -1;
    } else {
      bio++;
      arr[i] = bio;
    }
  }
  return arr;
}

function packORFsIntoLanes(orfs: readonly ORF[]): ORFWithLane[] {
  if (orfs.length === 0) return [];
  const sorted = [...orfs].sort((a, b) => {
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenA !== lenB) return lenB - lenA;
    return a.start - b.start;
  });
  const lanes: Array<Array<{ start: number; end: number }>> = [];
  const placed: ORFWithLane[] = [];
  for (const orf of sorted) {
    let assigned = -1;
    for (let i = 0; i < lanes.length; i++) {
      const conflict = lanes[i].some((r) => r.start < orf.end + 1 && orf.start < r.end + 1);
      if (!conflict) {
        assigned = i;
        break;
      }
    }
    if (assigned === -1) {
      assigned = lanes.length;
      lanes.push([]);
    }
    lanes[assigned].push({ start: orf.start, end: orf.end });
    placed.push({ ...orf, lane: assigned });
  }
  return placed;
}

export function create1DLayoutAdapter(layout: Layout1D): SequenceLayout {
  const { pxPerBase, columnCount, sequenceRowY, sequenceRowHeight, laneBandTop, laneCount } =
    layout;

  function columnToX(col: number): number {
    return HORIZONTAL_PADDING_1D + col * pxPerBase;
  }

  return {
    getRectsForBaseRange(start: number, end: number): Segment[] {
      if (end <= start) return [];
      const a = Math.max(0, start);
      const b = Math.min(columnCount, end);
      if (b <= a) return [];
      const seg: Segment = {
        x: columnToX(a),
        y: sequenceRowY,
        width: (b - a) * pxPerBase,
        height: sequenceRowHeight,
        startsAtRangeStart: a === start,
        endsAtRangeEnd: b === end,
        baseStart: a,
        baseEnd: b,
      };
      return [seg];
    },

    getBaseAtPoint(x: number, y: number): HitResult | null {
      if (x < HORIZONTAL_PADDING_1D) return null;
      const col = Math.floor((x - HORIZONTAL_PADDING_1D) / pxPerBase);
      if (col < 0 || col >= columnCount) return null;

      if (laneCount > 0 && y >= laneBandTop && y < laneBandTop + layout.laneBandHeight) {
        const laneIndex = Math.floor((y - laneBandTop) / (LANE_HEIGHT_1D + LANE_GAP_1D));
        if (laneIndex >= 0 && laneIndex < laneCount) {
          return { baseIndex: col, laneIndex };
        }
      }

      if (y >= sequenceRowY && y < sequenceRowY + sequenceRowHeight) {
        return { baseIndex: col };
      }

      return null;
    },

    getTotalSize() {
      return { width: layout.totalWidth, height: layout.totalHeight };
    },

    getRulerTicks(viewportStart: number, viewportEnd: number): Tick[] {
      const step = pickTickStep(pxPerBase, 40, 10);
      const ticks: Tick[] = [];

      if (layout.gappedSequence && layout.colToBio) {
        const colToBio = layout.colToBio;
        const maxCol = Math.min(viewportEnd, colToBio.length);
        const startCol = Math.max(0, viewportStart);
        for (let col = startCol; col < maxCol; col++) {
          const bio = colToBio[col];
          if (bio < 0) continue;
          if (bio !== 1 && bio % step !== 0) continue;
          ticks.push({
            position: col,
            x: columnToX(col) + pxPerBase / 2,
            y: layout.rulerY,
            label: String(bio),
            major: true,
          });
        }
        return ticks;
      }

      const maxCol = layout.isCircular ? viewportEnd : Math.min(viewportEnd, columnCount);
      if (maxCol <= viewportStart) return ticks;

      const firstCycle = Math.floor(Math.max(0, viewportStart) / columnCount);
      const lastCycle = Math.max(firstCycle + 1, Math.ceil(maxCol / columnCount));

      for (let k = firstCycle; k < lastCycle; k++) {
        const cycleStart = k * columnCount;

        const oneCol = cycleStart;
        if (oneCol >= viewportStart && oneCol < maxCol) {
          ticks.push({
            position: oneCol,
            x: columnToX(oneCol) + pxPerBase / 2,
            y: layout.rulerY,
            label: '1',
            major: true,
          });
        }

        for (let bio = step; bio <= columnCount; bio += step) {
          const virtualCol = cycleStart + bio - 1;
          if (virtualCol < viewportStart || virtualCol >= maxCol) continue;
          ticks.push({
            position: virtualCol,
            x: columnToX(virtualCol) + pxPerBase / 2,
            y: layout.rulerY,
            label: String(bio),
            major: true,
          });
        }
      }
      return ticks;
    },
  };
}
