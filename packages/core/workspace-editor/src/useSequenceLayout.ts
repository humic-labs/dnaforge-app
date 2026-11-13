import { packIntoLanes } from './pack-feature-lanes';
import { cdsLayoutProgress } from './cds-presentation';
import { FeatureLaneIndex } from './feature-lane-index';
import { visitProjectedRowBreakpoints } from './projected-row-runs';
import { computeLineTrackPositions, lineTrackBoundaries } from './line-track-layout';
import { rowHitY } from './predictive-wrap-layout';
import {
  transcriptRenderAnnotations,
  cohesiveCdsRenderAnnotations,
} from './transcript-render-data';

import {
  continuousWrapRowOffset,
  linearWrapTopBp,
  reserveTrackBands,
  wrapPrediction,
} from './predictive-wrap-layout';
import {
  cdsExtensionOriginalBounds,
  CDS_EXTENSION_DIRECTION_QUALIFIER,
  CDS_EXTENSION_HOVER_QUALIFIER,
  CDS_EXTENSION_ORIGINAL_QUALIFIER,
} from './cds-extension-affordance';
import { useMemo, useRef } from 'react';

import {
  complementBase,
  isFullCDS,
  applySequenceStrandOverrides,
  nucleicAcidOf,
  primersForSequenceDisplay,
  type NucleicAcid,
  type SequenceStrandOverride,
} from '@waypoint/sequence-utils';
import type { AnnotatedSequence, Annotation, ORF } from '@waypoint/sequence-utils';
import type {
  WorkspaceEditorConfig,
  LayoutSnapshot2D,
  Layout2DRow,
  AnnotationWithLane,
  ClassifiedCDS,
  ORFWithLane,
  PrimerDisplay,
} from './types';
import { DEFAULT_EDITOR_CONFIG } from './types';
import {
  create2DLayoutAdapter,
  type SequenceLayout as QuerySequenceLayout,
} from './layout-interface';
import { rangeOverlapsLine } from './utils/range-utils';
import {
  ANNOTATION_ROW_HEIGHT,
  ANNOTATION_LANE_PADDING,
  RULER_HEIGHT,
  ROW_BOTTOM_PADDING,
  calculateCdsHeight,
} from './layout-constants';
import { PRIMER_CANVAS_CONSTANTS } from './canvas-constants';
import { CHEVRON_WIDTH_RATIO } from './rendering';
import { calculateOrfHeight } from './orf-drawing';
import { packPrimerLanes } from './primer-layout';
import { diag } from './diagnostics';
import { canvasTestWindow } from './canvas-test-bridge';
import { OVERVIEW_MIN_ROW_HEIGHT_PX, type SequenceLodLevel } from './zoom-math';

const EMPTY_PRIMERS: readonly PrimerDisplay[] = Object.freeze([]);
const EMPTY_ORFS: readonly ORF[] = Object.freeze([]);

type ResidentLayout = { readonly inputs: readonly unknown[]; readonly snapshot: LayoutSnapshot2D };

const residentLargeGenomeLayouts = new WeakMap<AnnotatedSequence, ResidentLayout[]>();
const MAX_RESIDENT_LAYOUTS_PER_SEQUENCE = 3;

function findResidentLargeGenomeLayout(
  sequence: AnnotatedSequence,
  inputs: readonly unknown[]
): LayoutSnapshot2D | null {
  const entries = residentLargeGenomeLayouts.get(sequence);
  if (!entries) return null;
  const index = entries.findIndex(
    (entry) =>
      entry.inputs.length === inputs.length &&
      entry.inputs.every((value, position) => Object.is(value, inputs[position]))
  );
  if (index < 0) return null;
  const [entry] = entries.splice(index, 1);
  entries.push(entry);
  return entry.snapshot;
}

function rememberLargeGenomeLayout(
  sequence: AnnotatedSequence,
  inputs: readonly unknown[],
  snapshot: LayoutSnapshot2D
): void {
  const entries = residentLargeGenomeLayouts.get(sequence) ?? [];
  entries.push({ inputs, snapshot });
  while (entries.length > MAX_RESIDENT_LAYOUTS_PER_SEQUENCE) entries.shift();
  residentLargeGenomeLayouts.set(sequence, entries);
}

function complementSequenceLine(sequence: string, acid: NucleicAcid): string {
  const result = new Array<string>(sequence.length);
  for (let index = 0; index < sequence.length; index += 1) {
    result[index] = complementBase(sequence[index], acid);
  }
  return result.join('');
}

interface IntervalIndex<T> {
  sorted: readonly T[];

  maxEnd: Int32Array;

  getStart0: (t: T) => number;

  getEnd0: (t: T) => number;
}

function buildIntervalIndex<T>(
  sorted: readonly T[],
  getStart0: (t: T) => number,
  getEnd0: (t: T) => number
): IntervalIndex<T> {
  const n = sorted.length;
  const maxEnd = new Int32Array(n);

  const stack: Array<{ lo: number; hi: number; phase: 0 | 1 }> = [];
  if (n > 0) stack.push({ lo: 0, hi: n, phase: 0 });
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const { lo, hi, phase } = top;
    if (lo >= hi) {
      stack.pop();
      continue;
    }
    const mid = (lo + hi) >>> 1;
    if (phase === 0) {
      top.phase = 1;

      stack.push({ lo: mid + 1, hi: hi, phase: 0 });
      stack.push({ lo: lo, hi: mid, phase: 0 });
    } else {
      let m = getEnd0(sorted[mid]);

      const leftLo = lo;
      const leftHi = mid;
      if (leftLo < leftHi) {
        const leftMid = (leftLo + leftHi) >>> 1;
        if (maxEnd[leftMid] > m) m = maxEnd[leftMid];
      }
      const rightLo = mid + 1;
      const rightHi = hi;
      if (rightLo < rightHi) {
        const rightMid = (rightLo + rightHi) >>> 1;
        if (maxEnd[rightMid] > m) m = maxEnd[rightMid];
      }
      maxEnd[mid] = m;
      stack.pop();
    }
  }
  return { sorted, maxEnd, getStart0, getEnd0 };
}

function queryIntervalIndex<T>(
  idx: IntervalIndex<T>,
  queryStart0: number,
  queryEnd0: number,
  out: T[]
): void {
  const { sorted, maxEnd, getStart0, getEnd0 } = idx;
  const n = sorted.length;
  if (n === 0) return;

  const stack: Array<{ lo: number; hi: number }> = [{ lo: 0, hi: n }];
  while (stack.length > 0) {
    const { lo, hi } = stack.pop()!;
    if (lo >= hi) continue;
    const mid = (lo + hi) >>> 1;

    if (maxEnd[mid] <= queryStart0) continue;

    const nodeStart = getStart0(sorted[mid]);

    if (lo < mid) stack.push({ lo, hi: mid });

    if (nodeStart < queryEnd0) {
      const nodeEnd = getEnd0(sorted[mid]);
      if (nodeEnd > queryStart0) out.push(sorted[mid]);

      if (mid + 1 < hi) stack.push({ lo: mid + 1, hi });
    }
  }
}

function partitionAnnotationsForIndex<T extends { start: number; end: number }>(
  features: readonly T[]
): { nonSpanning: T[]; spanning: T[] } {
  const nonSpanning: T[] = [];
  const spanning: T[] = [];
  for (const f of features) {
    if (f.start > f.end) spanning.push(f);
    else nonSpanning.push(f);
  }

  nonSpanning.sort((a, b) => a.start - 1 - (b.start - 1));
  return { nonSpanning, spanning };
}

function partitionPrimersForIndex<T extends { start: number; end: number }>(
  primers: readonly T[]
): { nonSpanning: T[]; spanning: T[] } {
  const nonSpanning: T[] = [];
  const spanning: T[] = [];
  for (const p of primers) {
    if (p.start > p.end) spanning.push(p);
    else nonSpanning.push(p);
  }
  nonSpanning.sort((a, b) => a.start - b.start);
  return { nonSpanning, spanning };
}

interface AnnotationLayoutIndex {
  nonSpanningAnns: Annotation[];
  spanningAnns: Annotation[];
  annIndex: IntervalIndex<Annotation> | null;
  nonSpanningCds: ClassifiedCDS[];
  spanningCds: ClassifiedCDS[];
  cdsIndex: IntervalIndex<ClassifiedCDS> | null;
}

const annotationLayoutIndexCache = new WeakMap<
  readonly Annotation[],
  { seqStr: string; seqLen: number; value: AnnotationLayoutIndex }
>();

function getAnnotationLayoutIndex(
  annotations: readonly Annotation[],
  seqStr: string,
  seqLen: number
): AnnotationLayoutIndex {
  const cached = annotationLayoutIndexCache.get(annotations);
  if (cached && cached.seqStr === seqStr && cached.seqLen === seqLen) return cached.value;

  const nonCdsAnnotations = annotations.filter((a) => a.type !== 'CDS');
  const { nonSpanning: nonSpanningAnns, spanning: spanningAnns } =
    partitionAnnotationsForIndex(nonCdsAnnotations);
  const annIndex: IntervalIndex<Annotation> | null =
    nonSpanningAnns.length > 0
      ? buildIntervalIndex(
          nonSpanningAnns,
          (a) => a.start - 1,
          (a) => a.end
        )
      : null;

  const cdsAnnotations = annotations.filter((a) => a.type === 'CDS');
  const classifiedCdsAnnotations: ClassifiedCDS[] = cdsAnnotations.map((cds) => {
    const direction = cds.direction ?? 1;
    const isFull = isFullCDS(cds.start, cds.end, seqStr, direction, seqLen);
    return {
      ...cds,
      cdsType: isFull ? 'full' : 'partial',
      translationLane: 0,
    };
  });
  const { nonSpanning: nonSpanningCds, spanning: spanningCds } =
    partitionAnnotationsForIndex(classifiedCdsAnnotations);
  const cdsIndex: IntervalIndex<ClassifiedCDS> | null =
    nonSpanningCds.length > 0
      ? buildIntervalIndex(
          nonSpanningCds,
          (a) => a.start - 1,
          (a) => a.end
        )
      : null;

  const value = {
    nonSpanningAnns,
    spanningAnns,
    annIndex,
    nonSpanningCds,
    spanningCds,
    cdsIndex,
  };
  annotationLayoutIndexCache.set(annotations, { seqStr, seqLen, value });
  return value;
}

interface OrfLayoutIndex {
  fwdOrfs: ORF[];
  revOrfs: ORF[];
}

const orfLayoutIndexCache = new WeakMap<readonly ORF[], OrfLayoutIndex>();

function getOrfLayoutIndex(orfs: readonly ORF[]): OrfLayoutIndex {
  const cached = orfLayoutIndexCache.get(orfs);
  if (cached) return cached;
  const value = {
    fwdOrfs: orfs
      .filter((o) => o.strand === '+')
      .slice()
      .sort((a, b) => a.start - b.start),
    revOrfs: orfs
      .filter((o) => o.strand === '-')
      .slice()
      .sort((a, b) => a.start - b.start),
  };
  orfLayoutIndexCache.set(orfs, value);
  return value;
}

interface PrimerLayoutIndex {
  fwdPrimersNonSpanning: PrimerDisplay[];
  fwdPrimersSpanning: PrimerDisplay[];
  revPrimersNonSpanning: PrimerDisplay[];
  revPrimersSpanning: PrimerDisplay[];
}

const primerLayoutIndexCache = new WeakMap<readonly PrimerDisplay[], PrimerLayoutIndex>();

function getPrimerLayoutIndex(primers: readonly PrimerDisplay[]): PrimerLayoutIndex {
  const cached = primerLayoutIndexCache.get(primers);
  if (cached) return cached;
  const fwdPrimersAll = primers.filter((p) => p.direction === 'forward');
  const revPrimersAll = primers.filter((p) => p.direction === 'reverse');
  const { nonSpanning: fwdPrimersNonSpanning, spanning: fwdPrimersSpanning } =
    partitionPrimersForIndex(fwdPrimersAll);
  const { nonSpanning: revPrimersNonSpanning, spanning: revPrimersSpanning } =
    partitionPrimersForIndex(revPrimersAll);
  const value = {
    fwdPrimersNonSpanning,
    fwdPrimersSpanning,
    revPrimersNonSpanning,
    revPrimersSpanning,
  };
  primerLayoutIndexCache.set(primers, value);
  return value;
}

function lowerBoundBy<T>(sorted: readonly T[], target: number, getStart: (t: T) => number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getStart(sorted[mid]) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function visibleAnnotationsOnLine<T extends { start: number; end: number }>(
  nonSpanningIndex: IntervalIndex<T> | null,
  nonSpanningList: readonly T[],
  spanning: readonly T[],
  lineStart0: number,
  lineEnd0: number,
  seqLen: number
): T[] {
  const out: T[] = [];

  if (nonSpanningIndex !== null) {
    queryIntervalIndex(nonSpanningIndex, lineStart0, lineEnd0, out);
  } else {
    const upper = lowerBoundBy(nonSpanningList, lineEnd0, (a) => a.start - 1);
    for (let i = 0; i < upper; i++) {
      const ann = nonSpanningList[i];
      const aStart0 = ann.start - 1;
      const aEnd0 = ann.end;
      if (aEnd0 > lineStart0 && aStart0 < lineEnd0) out.push(ann);
    }
  }

  for (const ann of spanning) {
    const aStart0 = ann.start - 1;
    const aEnd0 = ann.end;
    const seg1Visible = aStart0 < lineEnd0 && seqLen > lineStart0;
    const seg2Visible = 0 < lineEnd0 && aEnd0 > lineStart0;
    if (seg1Visible || seg2Visible) out.push(ann);
  }

  return out;
}

function annotationIdentityKey(ann: {
  type: string;
  name: string;
  start: number;
  end: number;
  direction?: number;
}): string {
  return `${ann.type}-${ann.name}-${ann.start}-${ann.end}-${ann.direction ?? 1}`;
}

function unionVisibleOnOriginSpan<
  T extends { start: number; end: number; type: string; name: string; direction?: number },
>(
  nonSpanningIndex: IntervalIndex<T> | null,
  nonSpanningList: readonly T[],
  spanning: readonly T[],
  actualStartPos: number,
  actualEndPos: number,
  seqLen: number
): T[] {
  const seg1 = visibleAnnotationsOnLine(
    nonSpanningIndex,
    nonSpanningList,
    spanning,
    actualStartPos,
    seqLen,
    seqLen
  );
  const seg2 = visibleAnnotationsOnLine(
    nonSpanningIndex,
    nonSpanningList,
    spanning,
    0,
    actualEndPos,
    seqLen
  );
  const ids = new Set<string>();
  const out: T[] = [];
  for (const ann of seg1) {
    const id = annotationIdentityKey(ann);
    if (!ids.has(id)) {
      ids.add(id);
      out.push(ann);
    }
  }
  for (const ann of seg2) {
    const id = annotationIdentityKey(ann);
    if (!ids.has(id)) {
      ids.add(id);
      out.push(ann);
    }
  }
  return out;
}

function sequenceLayoutLineGeometry(args: {
  isCircular: boolean;
  effectiveIndex: number;
  charsPerLine: number;
  seqLen: number;
  normalizedOffset: number;
  normalizedBpOffset: number;
}): {
  actualStartPos: number;
  actualEndPos: number;
  lineLength: number;
  spansOrigin: boolean;
  originPosition?: number;
  preOriginLength?: number;
  lineEndForVisibility: number;
  leadingColumns: number;
} | null {
  const rawStartPos =
    args.effectiveIndex * args.charsPerLine + args.normalizedOffset + args.normalizedBpOffset;
  const actualStartPos = args.isCircular
    ? ((rawStartPos % args.seqLen) + args.seqLen) % args.seqLen
    : Math.max(0, rawStartPos);
  const lineLength = args.isCircular
    ? args.charsPerLine
    : Math.min(args.seqLen, rawStartPos + args.charsPerLine) - actualStartPos;
  if (!args.isCircular && lineLength <= 0) return null;
  const spansOrigin = args.isCircular && actualStartPos + lineLength > args.seqLen;
  const preOriginLength = spansOrigin ? args.seqLen - actualStartPos : undefined;
  const originPosition = spansOrigin ? preOriginLength : undefined;
  const actualEndPos = args.isCircular
    ? (actualStartPos + lineLength) % args.seqLen
    : actualStartPos + lineLength;
  return {
    actualStartPos,
    actualEndPos,
    lineLength,
    spansOrigin,
    originPosition,
    preOriginLength,
    lineEndForVisibility: spansOrigin ? actualEndPos : actualStartPos + lineLength,
    leadingColumns: args.isCircular ? 0 : Math.max(0, -rawStartPos),
  };
}

function fillPrecomputedRowHeights(
  laneCounts: LanePlan,
  totalLineCount: number,
  config: WorkspaceEditorConfig,
  hasMutationTrack: boolean
): Float64Array {
  const heights = new Float64Array(totalLineCount);
  const heightCache = new Map<RowLaneCounts, number>();
  for (const run of laneCounts.runs) {
    const lc = run.counts;
    let height = heightCache.get(lc);
    if (height === undefined) {
      height = calculateLineHeight(
        lc.annotationLaneCount,
        lc.translationLaneCount,
        config,
        lc.forwardPrimerLaneCount,
        lc.reversePrimerLaneCount,
        hasMutationTrack,
        lc.forwardOrfLaneCount,
        lc.reverseOrfLaneCount
      );
      heightCache.set(lc, height);
    }
    heights.fill(height, run.start, run.end);
  }
  return heights;
}

function fillRowYOffsets(
  heights: Float64Array,
  offsets: Float64Array,
  top: number,
  gap: number
): number {
  let y = top;
  offsets[0] = y;
  for (let row = 0; row < heights.length; row++) {
    y += heights[row];
    if (row < heights.length - 1) y += gap;
    offsets[row + 1] = y;
  }
  return y;
}

function orfsInRange(
  sorted: readonly ORF[],
  rangeStart0: number,
  rangeEndInclusive: number
): ORF[] {
  const out: ORF[] = [];

  const upper = lowerBoundBy(sorted, rangeEndInclusive + 1, (o) => o.start);
  for (let i = 0; i < upper; i++) {
    const orf = sorted[i];

    if (orf.end < rangeStart0) continue;
    out.push(orf);
  }
  return out;
}

function primersOnLine<T extends { start: number; end: number }>(
  nonSpanning: readonly T[],
  spanning: readonly T[],
  lineStart: number,
  lineEnd: number,
  seqLen: number,
  lineSpansOrigin: boolean
): T[] {
  const out: T[] = [];

  if (lineSpansOrigin) {
    for (const p of nonSpanning) {
      if (rangeOverlapsLine(p.start, p.end, lineStart, lineEnd, seqLen)) out.push(p);
    }
    for (const p of spanning) {
      const seg1 = rangeOverlapsLine(p.start, seqLen, lineStart, lineEnd, seqLen);
      const seg2 = rangeOverlapsLine(0, p.end, lineStart, lineEnd, seqLen);
      if (seg1 || seg2) out.push(p);
    }
    return out;
  }

  const upper = lowerBoundBy(nonSpanning, lineEnd, (p) => p.start);
  for (let i = 0; i < upper; i++) {
    const p = nonSpanning[i];
    if (p.end > lineStart) out.push(p);
  }

  for (const p of spanning) {
    const seg1 = rangeOverlapsLine(p.start, seqLen, lineStart, lineEnd, seqLen);
    const seg2 = rangeOverlapsLine(0, p.end, lineStart, lineEnd, seqLen);
    if (seg1 || seg2) out.push(p);
  }
  return out;
}

export interface RowLaneCounts {
  annotationLaneCount: number;

  translationLaneCount: number;
  forwardOrfLaneCount: number;
  reverseOrfLaneCount: number;
  forwardPrimerLaneCount: number;
  reversePrimerLaneCount: number;
}

function annotationToFeatureSegments(
  ann: { start: number; end: number },
  seqLen: number
): { start0: number; end0: number }[] {
  if (ann.start > ann.end) {
    return [
      { start0: ann.start - 1, end0: seqLen },
      { start0: 0, end0: ann.end },
    ];
  }
  return [{ start0: ann.start - 1, end0: ann.end }];
}

function orfToFeatureSegments(orf: ORF): { start0: number; end0: number }[] {
  return [{ start0: orf.start, end0: orf.end + 1 }];
}

function primerToFeatureSegments(
  primer: { start: number; end: number },
  seqLen: number
): { start0: number; end0: number }[] {
  if (primer.start > primer.end) {
    return [
      { start0: primer.start, end0: seqLen },
      { start0: 0, end0: primer.end },
    ];
  }
  return [{ start0: primer.start, end0: primer.end }];
}

function dedupAnnotationsByBounds(
  annotations: readonly Annotation[],
  options: { includeTypeInKey?: boolean } = {}
): Annotation[] {
  const seen = new Set<string>();
  const out: Annotation[] = [];
  for (const ann of annotations) {
    const direction = ann.direction ?? 1;
    const typeBucket = options.includeTypeInKey ? `${ann.type}-` : '';
    const key = `${typeBucket}${ann.start}-${ann.end}-${direction}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ann);
    }
  }
  return out;
}

type LanePlanInput = {
  annotations: readonly Annotation[];
  primers: readonly PrimerDisplay[];
  orfs: readonly ORF[];
  cpr: number;
  seqLen: number;
  isCircular: boolean;

  normalizedBpOffset: number;
  topBufferCount: number;
  realRowCount: number;
  bottomBufferCount: number;
  showPrimers: boolean;
  cdsAsFeatureAnnotations?: boolean;
  cdsDetailProgress?: number;
};
interface LanePatternRun {
  start: number;
  end: number;
  counts: RowLaneCounts;
}

class LanePlan {
  private cursor = 0;
  constructor(
    readonly length: number,
    readonly runs: LanePatternRun[]
  ) {}

  countAt(row: number): RowLaneCounts | undefined {
    if (row < 0 || row >= this.length || !this.runs.length) return undefined;
    let run = this.runs[this.cursor];
    if (row >= run.start && row < run.end) return run.counts;
    const next = this.runs[this.cursor + 1];
    if (next && row >= next.start && row < next.end) {
      this.cursor++;
      return next.counts;
    }
    let lo = 0,
      hi = this.runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.runs[mid].end <= row) lo = mid + 1;
      else hi = mid;
    }
    this.cursor = lo;
    run = this.runs[lo];
    return run.counts;
  }

  toArray(): RowLaneCounts[] {
    const rows = new Array<RowLaneCounts>(this.length);
    for (const run of this.runs)
      for (let row = run.start; row < run.end; row++) rows[row] = run.counts;
    return rows;
  }
}
const lanePlans: {
  key: string;
  annotations: readonly Annotation[];
  primers: readonly PrimerDisplay[];
  orfs: readonly ORF[];
  counts: LanePlan;
}[] = [];

const transitionLanePlans: typeof lanePlans = [];
function cachedLanePlan(
  opts: LanePlanInput,
  sourcePrimers: readonly PrimerDisplay[],
  sourceOrfs: readonly ORF[]
): LanePlan {
  const transitioning =
    !opts.cdsAsFeatureAnnotations &&
    opts.cdsDetailProgress !== undefined &&
    opts.cdsDetailProgress < 1;
  const cache = transitioning ? transitionLanePlans : lanePlans;
  const key = [
    opts.cpr,
    opts.seqLen,
    opts.isCircular,
    opts.normalizedBpOffset,
    opts.topBufferCount,
    opts.realRowCount,
    opts.bottomBufferCount,
    opts.showPrimers,
    opts.cdsAsFeatureAnnotations,
    transitioning ? opts.cdsDetailProgress : undefined,
  ].join(':');
  const found = cache.find(
    (p) =>
      p.key === key &&
      p.annotations === opts.annotations &&
      p.primers === sourcePrimers &&
      p.orfs === sourceOrfs
  );
  if (found) return found.counts;
  const counts = computeLanePlan(opts);
  cache.push({
    key,
    annotations: opts.annotations,
    primers: sourcePrimers,
    orfs: sourceOrfs,
    counts,
  });

  if (cache.length > (transitioning ? 4 : 8)) cache.shift();
  return counts;
}

type LaneOverlapIndices = Record<
  'annotations' | 'cds' | 'forwardOrfs' | 'reverseOrfs' | 'forwardPrimers' | 'reversePrimers',
  FeatureLaneIndex
>;
const overlapIndicesCache: {
  annotations: readonly Annotation[];
  primers: readonly PrimerDisplay[];
  orfs: readonly ORF[];
  key: string;
  indices: LaneOverlapIndices;
}[] = [];
function laneOverlapIndices(
  annotations: readonly Annotation[],
  primers: readonly PrimerDisplay[],
  orfs: readonly ORF[],
  seqLen: number,
  showPrimers: boolean,
  cdsAsFeatures: boolean
): LaneOverlapIndices {
  const key = `${seqLen}:${showPrimers}:${cdsAsFeatures}`;
  const cached = overlapIndicesCache.find(
    (entry) =>
      entry.key === key &&
      entry.annotations === annotations &&
      entry.primers === primers &&
      entry.orfs === orfs
  );
  if (cached) return cached.indices;
  const annotationIndex = (records: readonly Annotation[]) =>
    new FeatureLaneIndex(records.flatMap((record) => annotationToFeatureSegments(record, seqLen)));
  const primerIndex = (direction: PrimerDisplay['direction']) =>
    new FeatureLaneIndex(
      showPrimers
        ? primers
            .filter((p) => p.direction === direction)
            .flatMap((p) => primerToFeatureSegments(p, seqLen))
        : []
    );
  const orfIndex = (strand: ORF['strand']) =>
    new FeatureLaneIndex(orfs.filter((orf) => orf.strand === strand).flatMap(orfToFeatureSegments));
  const indices: LaneOverlapIndices = {
    annotations: annotationIndex(
      dedupAnnotationsByBounds(annotations.filter((a) => cdsAsFeatures || a.type !== 'CDS'))
    ),
    cds: annotationIndex(annotations.filter((a) => a.type === 'CDS')),
    forwardOrfs: orfIndex('+'),
    reverseOrfs: orfIndex('-'),
    forwardPrimers: primerIndex('forward'),
    reversePrimers: primerIndex('reverse'),
  };
  overlapIndicesCache.push({ annotations, primers, orfs, key, indices });
  if (overlapIndicesCache.length > 4) overlapIndicesCache.shift();
  return indices;
}

export function computeLaneCountsPerRow(opts: LanePlanInput): RowLaneCounts[] {
  return computeLanePlan(opts).toArray();
}

function computeLanePlan(opts: LanePlanInput): LanePlan {
  if (
    !opts.cdsAsFeatureAnnotations &&
    opts.cdsDetailProgress !== undefined &&
    opts.cdsDetailProgress < 1
  ) {
    const progress = opts.cdsDetailProgress;
    const detail = cachedLanePlan(
      { ...opts, cdsDetailProgress: undefined },
      opts.primers,
      opts.orfs
    );
    const compact = cachedLanePlan(
      { ...opts, cdsAsFeatureAnnotations: true, cdsDetailProgress: undefined },
      opts.primers,
      opts.orfs
    );
    const runs: LanePatternRun[] = [];
    const patterns = new Map<string, RowLaneCounts>();
    const pairs = new Map<RowLaneCounts, Map<RowLaneCounts, RowLaneCounts>>();
    let detailIndex = 0,
      compactIndex = 0,
      start = 0;

    while (start < detail.length) {
      const detailRun = detail.runs[detailIndex],
        compactRun = compact.runs[compactIndex];
      const a = detailRun.counts,
        b = compactRun.counts;
      const end = Math.min(detailRun.end, compactRun.end);
      let byCompact = pairs.get(a);
      let counts = byCompact?.get(b);
      if (!counts) {
        const compactCount =
          b.annotationLaneCount +
          (b.annotationLaneCount > 0 && a.translationLaneCount > 0
            ? ANNOTATION_LANE_PADDING / (ANNOTATION_ROW_HEIGHT + ANNOTATION_LANE_PADDING)
            : 0);
        const annotationLaneCount =
          compactCount + (a.annotationLaneCount - compactCount) * progress;
        const key = [
          annotationLaneCount,
          a.translationLaneCount,
          a.forwardOrfLaneCount,
          a.reverseOrfLaneCount,
          a.forwardPrimerLaneCount,
          a.reversePrimerLaneCount,
        ].join(':');
        counts = patterns.get(key);
        if (!counts) {
          counts = { ...a, annotationLaneCount };
          patterns.set(key, counts);
        }
        if (!byCompact) {
          byCompact = new Map();
          pairs.set(a, byCompact);
        }
        byCompact.set(b, counts);
      }
      const previous = runs[runs.length - 1];
      if (previous?.counts === counts) previous.end = end;
      else runs.push({ start, end, counts });
      if (detailRun.end === end) detailIndex++;
      if (compactRun.end === end) compactIndex++;
      start = end;
    }
    return new LanePlan(detail.length, runs);
  }
  const {
    annotations,
    primers,
    orfs,
    cpr,
    seqLen,
    isCircular,
    normalizedBpOffset,
    topBufferCount,
    realRowCount,
    bottomBufferCount,
    showPrimers,
    cdsAsFeatureAnnotations = false,
  } = opts;

  const totalRows = topBufferCount + realRowCount + bottomBufferCount;
  if (totalRows === 0 || cpr <= 0)
    return new LanePlan(
      totalRows,
      totalRows === 0
        ? []
        : [
            {
              start: 0,
              end: totalRows,
              counts: {
                annotationLaneCount: 0,
                translationLaneCount: 0,
                forwardOrfLaneCount: 0,
                reverseOrfLaneCount: 0,
                forwardPrimerLaneCount: 0,
                reversePrimerLaneCount: 0,
              },
            },
          ]
    );

  const indices = laneOverlapIndices(
    annotations,
    primers.length ? primers : EMPTY_PRIMERS,
    orfs.length ? orfs : EMPTY_ORFS,
    seqLen,
    showPrimers,
    cdsAsFeatureAnnotations
  );
  const maxima = (index: FeatureLaneIndex) =>
    index.rowMaximumRuns(cpr, seqLen, isCircular, normalizedBpOffset, topBufferCount, totalRows);
  const tracks = [
    maxima(indices.annotations),
    cdsAsFeatureAnnotations ? [{ start: 0, end: totalRows, value: 0 }] : maxima(indices.cds),
    maxima(indices.forwardOrfs),
    maxima(indices.reverseOrfs),
    maxima(indices.forwardPrimers),
    maxima(indices.reversePrimers),
  ];
  const cursors = tracks.map(() => 0);
  const patterns = new Map<string | number, RowLaneCounts>();
  const runs: LanePatternRun[] = [];
  for (let r = 0; r < totalRows; ) {
    const annRun = tracks[0][cursors[0]];
    const cdsRun = tracks[1][cursors[1]];
    const fwdOrfRun = tracks[2][cursors[2]];
    const revOrfRun = tracks[3][cursors[3]];
    const fwdPrimerRun = tracks[4][cursors[4]];
    const revPrimerRun = tracks[5][cursors[5]];
    const ann = annRun.value;
    const cds = cdsRun.value;
    const fwdOrf = fwdOrfRun.value;
    const revOrf = revOrfRun.value;
    const fwdPrimer = fwdPrimerRun.value;
    const revPrimer = revPrimerRun.value;
    const end = Math.min(
      annRun.end,
      cdsRun.end,
      fwdOrfRun.end,
      revOrfRun.end,
      fwdPrimerRun.end,
      revPrimerRun.end
    );
    const key =
      Math.max(ann, cds, fwdOrf, revOrf, fwdPrimer, revPrimer) < 16
        ? ann | (cds << 4) | (fwdOrf << 8) | (revOrf << 12) | (fwdPrimer << 16) | (revPrimer << 20)
        : `${ann}:${cds}:${fwdOrf}:${revOrf}:${fwdPrimer}:${revPrimer}`;
    let counts = patterns.get(key);
    if (!counts) {
      counts = {
        annotationLaneCount: ann,
        translationLaneCount: cdsAsFeatureAnnotations ? 0 : cds,
        forwardOrfLaneCount: fwdOrf,
        reverseOrfLaneCount: revOrf,
        forwardPrimerLaneCount: fwdPrimer,
        reversePrimerLaneCount: revPrimer,
      };
      patterns.set(key, counts);
    }
    const previous = runs[runs.length - 1];
    if (previous?.counts === counts) previous.end = end;
    else runs.push({ start: r, end, counts });
    if (annRun.end === end) cursors[0]++;
    if (cdsRun.end === end) cursors[1]++;
    if (fwdOrfRun.end === end) cursors[2]++;
    if (revOrfRun.end === end) cursors[3]++;
    if (fwdPrimerRun.end === end) cursors[4]++;
    if (revPrimerRun.end === end) cursors[5]++;
    r = end;
  }
  return new LanePlan(totalRows, runs);
}

function groupIdenticalAnnotations(
  annotations: Annotation[],
  options: { includeTypeInKey?: boolean } = {}
): Annotation[] {
  if (annotations.length <= 1) return annotations;

  const groups = new Map<string, Annotation[]>();

  for (const ann of annotations) {
    const direction = ann.direction ?? 1;

    const isDraft = ann.qualifiers?.source?.[0] === 'pLannotate-draft';
    const isAccepted = ann.qualifiers?.status?.[0] === 'accepted';
    const draftBucket = !isDraft ? 'real' : isAccepted ? 'accepted' : 'unchecked';
    const typeBucket = options.includeTypeInKey ? `${ann.type}-` : '';
    const key = `${typeBucket}${ann.start}-${ann.end}-${direction}-${draftBucket}`;
    const group = groups.get(key);
    if (group) {
      group.push(ann);
    } else {
      groups.set(key, [ann]);
    }
  }

  const merged: Annotation[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
    } else {
      const canonical = group.find((a) => a.type === 'CDS') ?? group[0];
      const joinedName = [...new Set(group.map((a) => a.name))].join(' · ');
      merged.push({
        ...canonical,
        name: joinedName,
      });
    }
  }

  return merged;
}

function getVisibleRangesOnLine(
  ann: { start: number; end: number },
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): Array<{ start: number; end: number }> {
  const annStart = ann.start - 1;
  const annEnd = ann.end;

  const spansOrigin = ann.start > ann.end;
  const lineSpansOrigin = lineStartPos > lineEndPos;

  const annotationSegments: Array<{ start: number; end: number }> = spansOrigin
    ? [
        { start: annStart, end: sequenceLength },
        { start: 0, end: annEnd },
      ]
    : [{ start: annStart, end: annEnd }];

  const lineSegments: Array<{ start: number; end: number }> = lineSpansOrigin
    ? [
        { start: lineStartPos, end: sequenceLength },
        { start: 0, end: lineEndPos },
      ]
    : [{ start: lineStartPos, end: lineEndPos }];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const annSeg of annotationSegments) {
    for (const lineSeg of lineSegments) {
      const start = Math.max(annSeg.start, lineSeg.start);
      const end = Math.min(annSeg.end, lineSeg.end);
      if (end > start) ranges.push({ start, end });
    }
  }

  return ranges;
}

function laneHeldBeforeWidening(
  preview: ClassifiedCDS,
  sorted: Array<{ item: ClassifiedCDS; ranges: Array<{ start: number; end: number }> }>,
  rangesFor: (cds: ClassifiedCDS) => Array<{ start: number; end: number }>
): number | null {
  const original = cdsExtensionOriginalBounds(preview);
  if (!original) return null;
  const restored: ClassifiedCDS = { ...preview, start: original.start, end: original.end };
  const restoredRanges = rangesFor(restored);
  if (restoredRanges.length === 0) return null;
  const before = sorted.map(({ item, ranges }) =>
    item === preview ? { item: restored, ranges: restoredRanges } : { item, ranges }
  );
  before.sort((a, b) => minVisibleRangeStart(a.ranges) - minVisibleRangeStart(b.ranges));
  const { packed } = packIntoLanes(before);
  return packed.find(({ item }) => item === restored)?.lane ?? null;
}

function packIntoLanesPinning<T>(
  sorted: Array<{ item: T; ranges: Array<{ start: number; end: number }> }>,
  pinnedIndex: number,
  pinnedLane: number | null
): { packed: Array<{ item: T; lane: number }>; laneCount: number } {
  const pinned = sorted[pinnedIndex];
  if (!pinned || pinned.ranges.length === 0) return packIntoLanes(sorted);

  const others = sorted.filter((_, i) => i !== pinnedIndex);
  const { packed, laneCount } = packIntoLanes(others);
  const lane = pinnedLane ?? laneCount;

  const collides = (candidate: { start: number; end: number }[]) =>
    candidate.some((a) => pinned.ranges.some((b) => a.start < b.end && b.start < a.end));
  let nextFreeLane = Math.max(laneCount, lane + 1);
  const resolved = packed.map((entry) => {
    if (entry.lane !== lane) return entry;
    const entryRanges = sorted.find(({ item }) => item === entry.item)?.ranges ?? [];
    if (!collides(entryRanges)) return entry;
    return { ...entry, lane: nextFreeLane++ };
  });
  resolved.push({ item: pinned.item, lane });
  return { packed: resolved, laneCount: Math.max(nextFreeLane, lane + 1) };
}

function minVisibleRangeStart(ranges: Array<{ start: number; end: number }>): number {
  if (ranges.length === 0) return Infinity;
  let min = ranges[0].start;
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < min) min = ranges[i].start;
  }
  return min;
}

function assignAnnotationLanes(
  annotations: Annotation[],
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength?: number
): { annotationsWithLanes: AnnotationWithLane[]; laneCount: number } {
  if (annotations.length === 0) {
    return { annotationsWithLanes: [], laneCount: 0 };
  }

  const seqLen = sequenceLength || lineEndPos;

  const withRanges = annotations.map((ann) => {
    const ranges = getVisibleRangesOnLine(ann, lineStartPos, lineEndPos, seqLen);
    return {
      item: ann,
      ranges,
      sortStart: minVisibleRangeStart(ranges),
    };
  });

  const sorted = withRanges.sort(
    (a, b) => a.sortStart - b.sortStart || a.item.start - b.item.start || a.item.end - b.item.end
  );

  const { packed, laneCount } = packIntoLanes(sorted);

  return {
    annotationsWithLanes: packed.map(({ item, lane }) => ({ ...item, lane })),
    laneCount,
  };
}

export function classifyAndAssignCDSLanes(
  annotations: Annotation[],
  lineStartPos: number,
  lineEndPos: number,
  fullSequence: string,
  sequenceLength?: number
): { classifiedCDSs: ClassifiedCDS[]; translationLaneCount: number } {
  const cdsAnnotations = annotations.filter((ann) => ann.type === 'CDS');

  if (cdsAnnotations.length === 0) {
    return { classifiedCDSs: [], translationLaneCount: 0 };
  }

  const seqLen = sequenceLength || fullSequence.length;

  const classified: ClassifiedCDS[] = cdsAnnotations.map((cds) => {
    const direction = cds.direction ?? 1;
    const isFull = isFullCDS(cds.start, cds.end, fullSequence, direction, seqLen);
    return {
      ...cds,
      cdsType: isFull ? 'full' : 'partial',
      translationLane: 0,
    };
  });

  return assignCDSLanes(classified, lineStartPos, lineEndPos, seqLen);
}

function assignCDSLanes(
  cdsList: ClassifiedCDS[],
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number,
  startLane: number = 0
): { classifiedCDSs: ClassifiedCDS[]; translationLaneCount: number } {
  if (cdsList.length === 0) {
    return { classifiedCDSs: [], translationLaneCount: 0 };
  }

  if (
    Number.isInteger(sequenceLength) &&
    sequenceLength > 0 &&
    Number.isInteger(lineStartPos) &&
    Number.isInteger(lineEndPos) &&
    lineStartPos >= 0 &&
    lineStartPos < lineEndPos &&
    lineEndPos <= sequenceLength &&
    cdsList.every(
      (cds) =>
        Number.isInteger(cds.start) &&
        Number.isInteger(cds.end) &&
        cds.start >= 1 &&
        cds.start <= cds.end &&
        cds.end <= sequenceLength &&
        cdsExtensionOriginalBounds(cds) === null
    )
  ) {
    const visible: { item: ClassifiedCDS; start: number; end: number }[] = [];
    for (const item of cdsList) {
      const start = Math.max(item.start - 1, lineStartPos);
      const end = Math.min(item.end, lineEndPos);
      if (end > start) visible.push({ item, start, end });
    }
    visible.sort(
      (a, b) => a.start - b.start || a.item.start - b.item.start || a.item.end - b.item.end
    );
    const laneEnds: number[] = [];
    const classifiedCDSs: ClassifiedCDS[] = [];
    for (const { item, start, end } of visible) {
      let lane = 0;
      while (lane < laneEnds.length && laneEnds[lane] > start) lane++;
      laneEnds[lane] = end;
      classifiedCDSs.push({ ...item, translationLane: startLane + lane });
    }
    return { classifiedCDSs, translationLaneCount: laneEnds.length };
  }

  const rangesFor = (cds: ClassifiedCDS) =>
    getVisibleRangesOnLine(cds, lineStartPos, lineEndPos, sequenceLength);
  const withRanges = cdsList.map((cds) => {
    const ranges = rangesFor(cds);
    return {
      item: cds,
      ranges,
      sortStart: minVisibleRangeStart(ranges),
    };
  });

  const sorted = withRanges.sort(
    (a, b) => a.sortStart - b.sortStart || a.item.start - b.item.start || a.item.end - b.item.end
  );

  const previewIndex = sorted.findIndex(
    ({ item }) => item.type === 'CDS' && cdsExtensionOriginalBounds(item) !== null
  );
  const pinnedLane =
    previewIndex < 0 ? null : laneHeldBeforeWidening(sorted[previewIndex]!.item, sorted, rangesFor);

  const { packed, laneCount } =
    previewIndex < 0
      ? packIntoLanes(sorted)
      : packIntoLanesPinning(sorted, previewIndex, pinnedLane);

  return {
    classifiedCDSs: packed.map(({ item, lane }) => ({
      ...item,
      translationLane: startLane + lane,
    })),
    translationLaneCount: laneCount,
  };
}

function assignOrfLanesFromIndex(
  fwdSorted: readonly ORF[],
  revSorted: readonly ORF[],
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength?: number
): {
  forwardOrfs: ORFWithLane[];
  forwardOrfLaneCount: number;
  reverseOrfs: ORFWithLane[];
  reverseOrfLaneCount: number;
} {
  const lineSpansOrigin = sequenceLength !== undefined && lineStartPos > lineEndPos;

  const orfsOnLine = (sorted: readonly ORF[]): ORF[] => {
    if (!lineSpansOrigin) {
      return orfsInRange(sorted, lineStartPos, lineEndPos - 1);
    }

    const seen = new Set<ORF>();
    const out: ORF[] = [];
    const addCandidates = (candidates: ORF[]): void => {
      for (const orf of candidates) {
        if (seen.has(orf)) continue;
        seen.add(orf);
        out.push(orf);
      }
    };
    addCandidates(orfsInRange(sorted, lineStartPos, sequenceLength - 1));
    addCandidates(orfsInRange(sorted, 0, lineEndPos - 1));
    return out;
  };

  const visibleOrfRanges = (orf: ORF): Array<{ start: number; end: number }> => {
    const lineSegments =
      lineSpansOrigin && sequenceLength !== undefined
        ? [
            { start: lineStartPos, end: sequenceLength },
            { start: 0, end: lineEndPos },
          ]
        : [{ start: lineStartPos, end: lineEndPos }];
    const ranges: Array<{ start: number; end: number }> = [];
    const orfStart = orf.start;
    const orfEnd = orf.end + 1;
    for (const lineSeg of lineSegments) {
      const start = Math.max(orfStart, lineSeg.start);
      const end = Math.min(orfEnd, lineSeg.end);
      if (end > start) ranges.push({ start, end });
    }
    return ranges;
  };

  const fwdOnLine = orfsOnLine(fwdSorted);
  const revOnLine = orfsOnLine(revSorted);

  const packOrfs = (strandOrfs: ORF[]): { packed: ORFWithLane[]; laneCount: number } => {
    if (strandOrfs.length === 0) return { packed: [], laneCount: 0 };
    const sorted = strandOrfs
      .map((orf) => ({ item: orf, ranges: visibleOrfRanges(orf) }))
      .filter(({ ranges }) => ranges.length > 0)
      .sort((a, b) => minVisibleRangeStart(a.ranges) - minVisibleRangeStart(b.ranges));
    const result = packIntoLanes(sorted);
    return {
      packed: result.packed.map(({ item, lane }) => ({ ...item, lane })),
      laneCount: result.laneCount,
    };
  };
  const fwd = packOrfs(fwdOnLine);
  const rev = packOrfs(revOnLine);
  return {
    forwardOrfs: fwd.packed,
    forwardOrfLaneCount: fwd.laneCount,
    reverseOrfs: rev.packed,
    reverseOrfLaneCount: rev.laneCount,
  };
}

function calculateLineHeight(
  annotationLaneCount: number,
  translationLaneCount: number,
  config: WorkspaceEditorConfig,
  forwardPrimerLaneCount: number = 0,
  reversePrimerLaneCount: number = 0,
  hasMutationTrack: boolean = false,
  forwardOrfLaneCount: number = 0,
  reverseOrfLaneCount: number = 0
): number {
  const lodLevel = resolveLodLevel(config);
  if (lodLevel === 'density') {
    return Math.max(OVERVIEW_MIN_ROW_HEIGHT_PX, Math.ceil(config.rowHeight));
  }

  const {
    rowHeight,
    showAnnotations,
    showTranslation,
    showReverseComplement,
    showPrimers,
    showResidueNumbers,
  } = config;

  let height = rowHeight + RULER_HEIGHT + ROW_BOTTOM_PADDING;

  if (showAnnotations && annotationLaneCount > 0) {
    const annotationHeight = calculateAnnotationHeightForLod(
      annotationLaneCount,
      translationLaneCount,
      lodLevel
    );
    height += annotationHeight;
  }

  const cdsH = calculateCdsHeight(
    translationLaneCount,
    0,
    showTranslation,
    rowHeight,
    showResidueNumbers,
    cdsLayoutProgress(config),
    config.cdsZoomPresentation?.aaHeight
  );
  height += cdsH;

  const fwdOrfH = calculateOrfHeight(forwardOrfLaneCount, rowHeight);
  if (cdsH > 0 && fwdOrfH > 0) height += 4;
  height += fwdOrfH;

  const revOrfH = calculateOrfHeight(reverseOrfLaneCount, rowHeight);
  if (fwdOrfH > 0 && revOrfH > 0) height += 4;
  else if (cdsH > 0 && revOrfH > 0 && fwdOrfH === 0) height += 4;
  height += revOrfH;

  const primerLaneHeight =
    rowHeight *
    (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
  if (showPrimers && forwardPrimerLaneCount > 0) {
    height += forwardPrimerLaneCount * primerLaneHeight;
  }

  if (showReverseComplement) {
    height += rowHeight;
  }

  if (hasMutationTrack) {
    height += rowHeight;
  }

  if (showPrimers && reversePrimerLaneCount > 0) {
    height += reversePrimerLaneCount * primerLaneHeight;
  }

  return height;
}

function resolveLodLevel(config: WorkspaceEditorConfig): SequenceLodLevel {
  return config.overviewLod ? 'density' : (config.lodLevel ?? 'detail');
}

function calculateAnnotationHeightForLod(
  annotationLaneCount: number,
  translationLaneCount: number,
  lodLevel: SequenceLodLevel
): number {
  if (annotationLaneCount <= 0 || lodLevel === 'density') return 0;

  let annotationHeight = annotationLaneCount * (ANNOTATION_ROW_HEIGHT + ANNOTATION_LANE_PADDING);
  if (translationLaneCount > 0) annotationHeight -= ANNOTATION_LANE_PADDING;
  return annotationHeight;
}

function getLayoutVerticalSpacing(config: WorkspaceEditorConfig): {
  topPaddingPx: number;
  rowGapPx: number;
  bottomPaddingPx: number;
} {
  if (resolveLodLevel(config) === 'density') {
    return { topPaddingPx: 0, rowGapPx: 0, bottomPaddingPx: 0 };
  }
  return { topPaddingPx: 32, rowGapPx: 32, bottomPaddingPx: 32 };
}

function getCircularSubstring(seqStr: string, startPos: number, length: number): string {
  const seqLen = seqStr.length;
  const normalizedStart = ((startPos % seqLen) + seqLen) % seqLen;

  if (normalizedStart + length <= seqLen) {
    return seqStr.substring(normalizedStart, normalizedStart + length);
  } else {
    const firstPart = seqStr.substring(normalizedStart);
    const secondPart = seqStr.substring(0, length - firstPart.length);
    return firstPart + secondPart;
  }
}

export interface ViewportRange {
  firstRowIndex: number;

  lastRowIndex: number;

  approximateOffscreenRowHeight?: number;

  emitOnlyViewportLines?: boolean;

  anchorRowIndex?: number;
  radiusPx?: number;

  maxPaintedRowPitch?: number;
}

export function materializeViewportRange(
  opts: {
    firstRowIndex?: number;
    lastRowIndex?: number;
    approximateOffscreenRowHeight?: number;
    emitOnlyViewportLines?: boolean;
    anchorRowIndex?: number;
    radiusPx?: number;
    maxPaintedRowPitch?: number;
  } = {}
): ViewportRange | undefined {
  const { firstRowIndex, lastRowIndex, approximateOffscreenRowHeight, emitOnlyViewportLines } =
    opts;
  if (firstRowIndex === undefined || lastRowIndex === undefined) return undefined;
  return {
    firstRowIndex,
    lastRowIndex,
    approximateOffscreenRowHeight,
    emitOnlyViewportLines,
    ...(opts.anchorRowIndex === undefined
      ? {}
      : {
          anchorRowIndex: opts.anchorRowIndex,
          radiusPx: opts.radiusPx,
          maxPaintedRowPitch: opts.maxPaintedRowPitch,
        }),
  };
}

type SequenceLineGeometry = NonNullable<ReturnType<typeof sequenceLayoutLineGeometry>>;

interface SequenceLayoutRowTimings {
  enabled: boolean;
  annScanMs: number;
  cdsScanMs: number;
  primerScanMs: number;
  orfScanMs: number;
  complementMs: number;
  packingMs: number;
}

function sequenceLineSubstring(
  seqStr: string,
  actualStartPos: number,
  lineLength: number,
  isCircular: boolean
): string {
  return isCircular
    ? getCircularSubstring(seqStr, actualStartPos, lineLength)
    : seqStr.substring(actualStartPos, actualStartPos + lineLength);
}

function visibleFeaturesOnLine<
  T extends { start: number; end: number; type: string; name: string; direction?: number },
>(
  index: IntervalIndex<T> | null,
  nonSpanning: T[],
  spanning: T[],
  geometry: SequenceLineGeometry,
  seqLen: number
): T[] {
  return geometry.spansOrigin
    ? unionVisibleOnOriginSpan(
        index,
        nonSpanning,
        spanning,
        geometry.actualStartPos,
        geometry.actualEndPos,
        seqLen
      )
    : visibleAnnotationsOnLine(
        index,
        nonSpanning,
        spanning,
        geometry.actualStartPos,
        geometry.actualStartPos + geometry.lineLength,
        seqLen
      );
}

function layoutOffscreenSequenceRow(args: {
  i: number;
  y: number;
  geometry: SequenceLineGeometry;
  isCircular: boolean;
  seqStr: string;
  isBufferRow: boolean;
  isTopBuffer: boolean;
  isBottomBuffer: boolean;
  emitOnlyViewportLines: boolean;
  precomputedRowHeights: Float64Array | null;
  approximateOffscreenRowHeight: number | null;
  precomputedLaneCounts: LanePlan | null;
}): { skipEmit: true; height: number } | { skipEmit: false; line: Layout2DRow; height: number } {
  const height = args.precomputedRowHeights?.[args.i] ?? args.approximateOffscreenRowHeight ?? 0;
  if (args.emitOnlyViewportLines) {
    return { skipEmit: true, height };
  }
  const counts = args.precomputedLaneCounts?.countAt(args.i);
  return {
    skipEmit: false,
    height,
    line: {
      lineIndex: args.i,
      startPos: args.geometry.actualStartPos,
      endPos: args.geometry.actualEndPos,
      sequence: sequenceLineSubstring(
        args.seqStr,
        args.geometry.actualStartPos,
        args.geometry.lineLength,
        args.isCircular
      ),
      complementSequence: '',
      y: args.y,
      annotations: [],
      annotationLaneCount: counts?.annotationLaneCount ?? 0,
      classifiedCDSs: [],
      translationLaneCount: counts?.translationLaneCount ?? 0,
      forwardPrimerLaneCount: counts?.forwardPrimerLaneCount ?? 0,
      reversePrimerLaneCount: counts?.reversePrimerLaneCount ?? 0,
      forwardOrfs: undefined,
      forwardOrfLaneCount: counts?.forwardOrfLaneCount ?? 0,
      reverseOrfs: undefined,
      reverseOrfLaneCount: counts?.reverseOrfLaneCount ?? 0,
      originPosition: args.geometry.originPosition,
      preOriginLength: args.geometry.preOriginLength,
      isWrapLine: args.isBufferRow,
      isTopBuffer: args.isTopBuffer,
      isBottomBuffer: args.isBottomBuffer,
    },
  };
}

function layoutViewportSequenceRow(args: {
  i: number;
  y: number;
  geometry: SequenceLineGeometry;
  isCircular: boolean;
  seqStr: string;
  seqLen: number;
  nucleicAcid: NucleicAcid;
  strandOverrides?: SequenceStrandOverride[];
  isBufferRow: boolean;
  isTopBuffer: boolean;
  isBottomBuffer: boolean;
  densityLod: boolean;
  cdsAsFeatureAnnotations: boolean;
  config: WorkspaceEditorConfig;
  hasMutationTrack: boolean;
  layoutPrimers: PrimerDisplay[];
  annotationIndex: AnnotationLayoutIndex;
  orfIndex: OrfLayoutIndex;
  primerIndex: PrimerLayoutIndex;
  timings: SequenceLayoutRowTimings;
}): { line: Layout2DRow; lineHeight: number } {
  const {
    i,
    y,
    geometry,
    isCircular,
    seqStr,
    seqLen,
    nucleicAcid,
    isBufferRow,
    isTopBuffer,
    isBottomBuffer,
    densityLod,
    cdsAsFeatureAnnotations,
    config,
    hasMutationTrack,
    layoutPrimers,
    annotationIndex,
    orfIndex,
    primerIndex,
    timings,
  } = args;
  const {
    actualStartPos,
    actualEndPos,
    lineLength,
    spansOrigin,
    originPosition,
    preOriginLength,
    lineEndForVisibility,
  } = geometry;

  const lineSeq = sequenceLineSubstring(seqStr, actualStartPos, lineLength, isCircular);

  const annScanStart = timings.enabled ? performance.now() : 0;
  const lineAnnotations = visibleFeaturesOnLine(
    annotationIndex.annIndex,
    annotationIndex.nonSpanningAnns,
    annotationIndex.spanningAnns,
    geometry,
    seqLen
  );
  if (timings.enabled) timings.annScanMs += performance.now() - annScanStart;

  const cdsScanStart = timings.enabled ? performance.now() : 0;
  const cdsOnLine = visibleFeaturesOnLine(
    annotationIndex.cdsIndex,
    annotationIndex.nonSpanningCds,
    annotationIndex.spanningCds,
    geometry,
    seqLen
  );
  const { classifiedCDSs, translationLaneCount } = assignCDSLanes(
    cdsOnLine,
    actualStartPos,
    lineEndForVisibility,
    seqLen
  );
  const lineTranslationLaneCount = cdsAsFeatureAnnotations ? 0 : translationLaneCount;
  if (timings.enabled) timings.cdsScanMs += performance.now() - cdsScanStart;

  const packingStart = timings.enabled ? performance.now() : 0;
  const annotationsForLanePacking = cdsAsFeatureAnnotations
    ? [...lineAnnotations, ...cdsOnLine]
    : lineAnnotations;
  const groupedAnnotations = groupIdenticalAnnotations(annotationsForLanePacking);
  const packedAnnotations = assignAnnotationLanes(
    groupedAnnotations,
    actualStartPos,
    lineEndForVisibility,
    seqLen
  );
  const progress = cdsAsFeatureAnnotations ? 0 : cdsLayoutProgress(config);
  const compact =
    !config.cdsZoomPresentation && progress < 1
      ? assignAnnotationLanes(
          groupIdenticalAnnotations([...lineAnnotations, ...cdsOnLine]),
          actualStartPos,
          lineEndForVisibility,
          seqLen
        )
      : null;
  const sameBounds = (a: Annotation, b: Annotation) =>
    a.start === b.start && a.end === b.end && (a.direction ?? 1) === (b.direction ?? 1);
  const annotationsWithLanes = packedAnnotations.annotationsWithLanes.map((ann) => {
    const start = compact?.annotationsWithLanes.find((candidate) => sameBounds(candidate, ann));
    return start ? { ...ann, lane: start.lane + (ann.lane - start.lane) * progress } : ann;
  });
  for (const cds of classifiedCDSs) {
    const slot = compact?.annotationsWithLanes.find(
      (ann) => ann.type === 'CDS' && sameBounds(ann, cds)
    );
    if (slot) {
      cds._compactLane = slot.lane;
      cds._compactName = slot.name;
      cds._detailAnnotationHeight = config.showAnnotations
        ? calculateAnnotationHeightForLod(
            packedAnnotations.laneCount,
            lineTranslationLaneCount,
            'detail'
          )
        : 0;
    }
  }
  const compactCount = compact
    ? compact.laneCount +
      (compact.laneCount > 0 && lineTranslationLaneCount > 0
        ? ANNOTATION_LANE_PADDING / (ANNOTATION_ROW_HEIGHT + ANNOTATION_LANE_PADDING)
        : 0)
    : packedAnnotations.laneCount;
  const laneCount = compactCount + (packedAnnotations.laneCount - compactCount) * progress;
  if (timings.enabled) timings.packingMs += performance.now() - packingStart;

  const primerScanStart = timings.enabled ? performance.now() : 0;
  const shouldShowPrimers = layoutPrimers.length > 0;
  const fwdPrimersOnLine = shouldShowPrimers
    ? primersOnLine(
        primerIndex.fwdPrimersNonSpanning,
        primerIndex.fwdPrimersSpanning,
        actualStartPos,
        lineEndForVisibility,
        seqLen,
        spansOrigin
      )
    : [];
  const revPrimersOnLine = shouldShowPrimers
    ? primersOnLine(
        primerIndex.revPrimersNonSpanning,
        primerIndex.revPrimersSpanning,
        actualStartPos,
        lineEndForVisibility,
        seqLen,
        spansOrigin
      )
    : [];
  const forwardPrimerLaneCount =
    fwdPrimersOnLine.length > 0
      ? packPrimerLanes(fwdPrimersOnLine, actualStartPos, lineEndForVisibility, seqLen).laneCount
      : 0;
  const reversePrimerLaneCount =
    revPrimersOnLine.length > 0
      ? packPrimerLanes(revPrimersOnLine, actualStartPos, lineEndForVisibility, seqLen).laneCount
      : 0;
  if (timings.enabled) timings.primerScanMs += performance.now() - primerScanStart;

  const orfScanStart = timings.enabled ? performance.now() : 0;
  const { forwardOrfs, forwardOrfLaneCount, reverseOrfs, reverseOrfLaneCount } =
    orfIndex.fwdOrfs.length > 0 || orfIndex.revOrfs.length > 0
      ? assignOrfLanesFromIndex(
          orfIndex.fwdOrfs,
          orfIndex.revOrfs,
          actualStartPos,
          lineEndForVisibility,
          seqLen
        )
      : { forwardOrfs: [], forwardOrfLaneCount: 0, reverseOrfs: [], reverseOrfLaneCount: 0 };
  if (timings.enabled) timings.orfScanMs += performance.now() - orfScanStart;

  const lineHeight = calculateLineHeight(
    laneCount,
    lineTranslationLaneCount,
    config,
    forwardPrimerLaneCount,
    reversePrimerLaneCount,
    hasMutationTrack,
    forwardOrfLaneCount,
    reverseOrfLaneCount
  );

  const complementStart = timings.enabled ? performance.now() : 0;

  const lineComplementSeq =
    densityLod ||
    cdsAsFeatureAnnotations ||
    (config.cdsZoomPresentation &&
      config.showNucleotideLetters === false &&
      !config.showReverseComplement)
      ? ''
      : applySequenceStrandOverrides(
          complementSequenceLine(lineSeq, nucleicAcid),
          actualStartPos,
          seqLen,
          args.strandOverrides,
          'reverse'
        );
  if (timings.enabled) timings.complementMs += performance.now() - complementStart;

  return {
    lineHeight,
    line: {
      lineIndex: i,
      startPos: actualStartPos,
      endPos: actualEndPos,
      sequence: applySequenceStrandOverrides(
        lineSeq,
        actualStartPos,
        seqLen,
        args.strandOverrides,
        'forward'
      ),
      complementSequence: lineComplementSeq,
      y,
      annotations: annotationsWithLanes,
      hasMutationTrack,
      annotationLaneCount: laneCount,
      classifiedCDSs,
      translationLaneCount: lineTranslationLaneCount,
      forwardPrimerLaneCount,
      reversePrimerLaneCount,
      forwardOrfs: forwardOrfs.length > 0 ? forwardOrfs : undefined,
      forwardOrfLaneCount,
      reverseOrfs: reverseOrfs.length > 0 ? reverseOrfs : undefined,
      reverseOrfLaneCount,
      originPosition,
      preOriginLength,
      isWrapLine: isBufferRow,
      isTopBuffer,
      isBottomBuffer,
    },
  };
}

function recordLayoutZoomPerf(
  timings: SequenceLayoutRowTimings,
  startMs: number,
  totalLineCount: number,
  seqLen: number,
  phases?: Record<string, number>
): void {
  if (!timings.enabled) return;
  const durMs = performance.now() - startMs;
  const w = canvasTestWindow(window);
  if (!w.__zoomPerf) return;
  if (!Array.isArray(w.__zoomPerf.samples)) w.__zoomPerf.samples = [];
  w.__zoomPerf.samples.push({
    t: performance.now(),
    durMs,
    totalLineCount,
    seqLen,
    annScanMs: timings.annScanMs,
    cdsScanMs: timings.cdsScanMs,
    primerScanMs: timings.primerScanMs,
    orfScanMs: timings.orfScanMs,
    complementMs: timings.complementMs,
    packingMs: timings.packingMs,
    phases,
  });
  if (w.__zoomPerf.samples.length > 200) w.__zoomPerf.samples.shift();
  if (durMs > (w.__zoomPerf.logThresholdMs ?? Infinity)) {
    // eslint-disable-next-line no-console
    console.log(
      `[zoom-perf] layout ${durMs.toFixed(1)}ms rows=${totalLineCount} ` +
        `ann=${timings.annScanMs.toFixed(1)} cds=${timings.cdsScanMs.toFixed(1)} ` +
        `prim=${timings.primerScanMs.toFixed(1)} orf=${timings.orfScanMs.toFixed(1)} ` +
        `cmp=${timings.complementMs.toFixed(1)} pack=${timings.packingMs.toFixed(1)}`
    );
  }
}

function sequenceLayoutPerfProbe(): {
  enabled: boolean;
  start: number;
  timings: SequenceLayoutRowTimings;
} {
  const enabled =
    typeof window !== 'undefined' &&
    typeof performance !== 'undefined' &&
    typeof canvasTestWindow(window).__zoomPerf === 'object' &&
    canvasTestWindow(window).__zoomPerf !== null;
  return {
    enabled,
    start: enabled ? performance.now() : 0,
    timings: {
      enabled,
      annScanMs: 0,
      cdsScanMs: 0,
      primerScanMs: 0,
      orfScanMs: 0,
      complementMs: 0,
      packingMs: 0,
    },
  };
}

function emptySequenceLayout(config: WorkspaceEditorConfig): LayoutSnapshot2D {
  return {
    lines: [],
    totalHeight: 0,
    totalWidth:
      config.marginLeft +
      config.charsPerLine * config.charWidth +
      Math.ceil(config.rowHeight * CHEVRON_WIDTH_RATIO),
  };
}

function sequenceLayoutLodInputs(
  sequence: AnnotatedSequence,
  config: WorkspaceEditorConfig,
  primers: PrimerDisplay[],
  orfs: ORF[]
): {
  charsPerLine: number;
  charWidth: number;
  marginLeft: number;
  seqStr: string;
  seqLen: number;
  nucleicAcid: NucleicAcid;
  densityLod: boolean;
  cdsAsFeatureAnnotations: boolean;
  annotations: AnnotatedSequence['annotations'];
  layoutPrimers: PrimerDisplay[];
  layoutOrfs: ORF[];
  isCircular: boolean;
} {
  const { charsPerLine, charWidth, marginLeft } = config;
  const seqStr = sequence.sequence;
  const lodLevel = resolveLodLevel(config);
  const densityLod = lodLevel === 'density';
  return {
    charsPerLine,
    charWidth,
    marginLeft,
    seqStr,
    seqLen: seqStr.length,
    nucleicAcid: nucleicAcidOf(sequence),
    densityLod,
    cdsAsFeatureAnnotations: config.cdsZoomPresentation
      ? !config.showTranslation
      : lodLevel === 'feature',
    annotations: config.cdsZoomPresentation
      ? cohesiveCdsRenderAnnotations(transcriptRenderAnnotations(sequence.annotations || []))
      : transcriptRenderAnnotations(sequence.annotations || []),
    layoutPrimers: densityLod
      ? []
      : primersForSequenceDisplay(primers ?? [], config.showPrimers ?? false),
    layoutOrfs: densityLod ? [] : (orfs ?? []),
    isCircular: sequence.circular ?? false,
  };
}

export function computeSequenceLayoutImpl(
  sequence: AnnotatedSequence | null,
  config: WorkspaceEditorConfig,
  circularOffset: number = 0,
  virtualRowCount: number = 0,
  primers: PrimerDisplay[] = EMPTY_PRIMERS as PrimerDisplay[],
  hasMutationTrack: boolean = false,
  orfs: ORF[] = EMPTY_ORFS as ORF[],
  bpOffset: number = 0,
  viewportRange?: ViewportRange
): LayoutSnapshot2D {
  const perfProbe = sequenceLayoutPerfProbe();
  const __zoomPerfEnabled = perfProbe.enabled;
  const __zoomPerfStart = perfProbe.start;
  const layoutRowTimings = perfProbe.timings;
  const perfPhases = __zoomPerfEnabled ? ({} as Record<string, number>) : undefined;
  let perfPhaseStart = __zoomPerfStart;
  const markPerfPhase = (name: string) => {
    if (!perfPhases) return;
    const now = performance.now();
    perfPhases[name] = now - perfPhaseStart;
    perfPhaseStart = now;
  };

  const topBp = circularOffset + bpOffset;
  if (!sequence || !sequence.sequence) {
    return emptySequenceLayout(config);
  }

  const {
    charsPerLine,
    charWidth,
    marginLeft,
    seqStr,
    seqLen,
    nucleicAcid,
    densityLod,
    cdsAsFeatureAnnotations,
    annotations,
    layoutPrimers,
    layoutOrfs,
    isCircular,
  } = sequenceLayoutLodInputs(sequence, config, primers, orfs);
  const lines: Layout2DRow[] = [];
  const { topPaddingPx, rowGapPx, bottomPaddingPx } = getLayoutVerticalSpacing(config);

  const annotationIndex = getAnnotationLayoutIndex(annotations, seqStr, seqLen);
  const orfIndex = getOrfLayoutIndex(layoutOrfs);
  const primerIndex = getPrimerLayoutIndex(layoutPrimers);

  const normalizedTopBp = isCircular
    ? ((topBp % seqLen) + seqLen) % seqLen
    : config.linearWrapPhase && topBp < 0
      ? Math.max(1 - charsPerLine, topBp)
      : Math.max(0, topBp);

  const normalizedOffset = 0;
  const normalizedBpOffset = normalizedTopBp;

  let y = topPaddingPx;

  const effectiveLinearLen = Math.max(0, seqLen - normalizedBpOffset);
  const baseLineCount = isCircular
    ? Math.ceil(seqLen / charsPerLine)
    : Math.max(1, Math.ceil(effectiveLinearLen / charsPerLine));

  const topBufferCount = isCircular ? virtualRowCount : 0;
  const bottomBufferCount = isCircular ? virtualRowCount : 0;
  const totalLineCount = topBufferCount + baseLineCount + bottomBufferCount;

  const firstRealRowIndex = topBufferCount;
  const firstBottomBufferIndex = topBufferCount + baseLineCount;
  let realRowsStartY = 0;
  let bottomBufferStartY = 0;

  const __rowHeights = new Float64Array(totalLineCount);
  const __rowYOffsets = new Float64Array(totalLineCount + 1);
  __rowYOffsets[0] = topPaddingPx;

  const __viewportActive = viewportRange !== undefined;
  let __vpFirst = viewportRange?.firstRowIndex ?? 0;
  let __vpLast = viewportRange?.lastRowIndex ?? totalLineCount - 1;
  const __approximateOffscreenRowHeight =
    typeof viewportRange?.approximateOffscreenRowHeight === 'number' &&
    viewportRange.approximateOffscreenRowHeight > 0
      ? Math.round(viewportRange.approximateOffscreenRowHeight)
      : null;
  const __emitOnlyViewportLines = viewportRange?.emitOnlyViewportLines === true;
  let __precomputedLaneCounts: LanePlan | null = null;
  let __precomputedRowHeights: Float64Array | null = null;
  if (__viewportActive && __approximateOffscreenRowHeight === null) {
    __precomputedLaneCounts = cachedLanePlan(
      {
        annotations,
        primers: layoutPrimers,
        orfs: layoutOrfs,
        cpr: charsPerLine,
        seqLen,
        isCircular,
        normalizedBpOffset,
        topBufferCount,
        realRowCount: baseLineCount,
        bottomBufferCount,
        showPrimers: (config.showPrimers ?? false) && layoutPrimers.length > 0,
        cdsAsFeatureAnnotations,
        cdsDetailProgress:
          cdsAsFeatureAnnotations || config.cdsZoomPresentation
            ? undefined
            : cdsLayoutProgress(config),
      },
      primers,
      orfs
    );
    __precomputedRowHeights = fillPrecomputedRowHeights(
      __precomputedLaneCounts,
      totalLineCount,
      config,
      hasMutationTrack
    );
  }
  markPerfPhase('currentPlan');

  const detailPreview =
    !densityLod && cdsAsFeatureAnnotations && config.previewDetailTracks?.progress
      ? config.previewDetailTracks
      : null;
  const detailConfig: WorkspaceEditorConfig | null = detailPreview
    ? {
        ...config,
        lodLevel: 'detail',
        showTranslation: detailPreview.showTranslation,
        showReverseComplement: detailPreview.showReverseComplement,
        showResidueNumbers: detailPreview.showResidueNumbers,
      }
    : null;
  const detailCounts = detailPreview
    ? cachedLanePlan(
        {
          annotations,
          primers: layoutPrimers,
          orfs: layoutOrfs,
          cpr: charsPerLine,
          seqLen,
          isCircular,
          normalizedBpOffset,
          topBufferCount,
          realRowCount: baseLineCount,
          bottomBufferCount,
          showPrimers: (config.showPrimers ?? false) && layoutPrimers.length > 0,
          cdsAsFeatureAnnotations: false,
        },
        primers,
        orfs
      )
    : null;
  markPerfPhase('detailPlan');

  const oneStepPrediction =
    config.wrapCapacity === undefined || config.wrapTrackForecast === false
      ? null
      : wrapPrediction(config.wrapCapacity, 0, 1, config.wrapAnchorBp === undefined ? 1 : 0.65);
  const contentAnchorBp = config.wrapAnchorBp;
  const contentAnchorX = config.wrapAnchorViewportX;
  const contentAnchorRow =
    contentAnchorBp !== undefined && config.wrapCapacity !== undefined
      ? Math.floor((contentAnchorBp - normalizedBpOffset) / charsPerLine) + topBufferCount
      : null;
  const contentOffsetForRow = (rowIndex: number, leadingColumns: number): number => {
    if (config.pinLinearOrigin && !isCircular && rowIndex === 0) return 0;
    const leadingOffset = leadingColumns * charWidth;
    if (
      contentAnchorRow === null ||
      contentAnchorBp === undefined ||
      contentAnchorX === undefined ||
      config.wrapCapacity === undefined
    )
      return leadingOffset;
    const actualStart =
      normalizedBpOffset + (rowIndex - topBufferCount) * charsPerLine + leadingColumns;
    return continuousWrapRowOffset(
      actualStart,
      rowIndex,
      contentAnchorRow,
      contentAnchorBp,
      contentAnchorX,
      marginLeft,
      charWidth,
      config.wrapCapacity + (config.wrapAnchorCapacityBias ?? 0)
    );
  };
  const prediction =
    oneStepPrediction &&
    config.wrapPreviewTargetCpr !== undefined &&
    config.wrapPreviewTargetCpr !== charsPerLine
      ? { current: charsPerLine, next: config.wrapPreviewTargetCpr, progress: 1 }
      : oneStepPrediction;

  const liveLaneForecast =
    !!prediction &&
    prediction.next === charsPerLine + 1 &&
    !densityLod &&
    config.wrapAnchorBp !== undefined &&
    config.wrapAnchorViewportX !== undefined &&
    (config.showAnnotations || config.showTranslation || config.showPrimers);
  const reverseForecast = liveLaneForecast && config.wrapForecastDirection === 1;
  const twoWrapForecast = liveLaneForecast && !reverseForecast && charsPerLine >= 120;
  const fractionalCapacity =
    config.wrapCapacity === undefined ? 0 : config.wrapCapacity - charsPerLine;

  const upperPhase = Math.max(0, Math.min(1, (fractionalCapacity - 0.35) / 0.65));
  const firstForecastProgress = reverseForecast
    ? upperPhase * upperPhase * (3 - 2 * upperPhase)
    : twoWrapForecast
      ? 1
      : (prediction?.progress ?? 0);
  const secondForecastProgress = reverseForecast ? 0 : (prediction?.progress ?? 0);

  const reverseProgress = reverseForecast && charsPerLine > 10 ? 1 : 0;
  const secondReversePhase = Math.max(0, Math.min(1, (0.95 - fractionalCapacity) / 0.8));
  const secondReverseProgress =
    reverseForecast && !viewportRange && charsPerLine > 11
      ? secondReversePhase * secondReversePhase * (3 - 2 * secondReversePhase)
      : 0;
  let predictedHeights: Float64Array | null = null;
  let predictedCounts: LanePlan | null = null;
  let predictedRealRowCount = baseLineCount;
  let predictedTopBp = normalizedBpOffset;
  if (prediction && firstForecastProgress > 0 && prediction.current === charsPerLine) {
    predictedTopBp =
      config.predictedTopBp === undefined
        ? normalizedBpOffset
        : isCircular
          ? ((config.predictedTopBp % seqLen) + seqLen) % seqLen
          : config.predictedTopBp;
    predictedRealRowCount = isCircular
      ? Math.ceil(seqLen / prediction.next)
      : Math.max(1, Math.ceil((seqLen - predictedTopBp) / prediction.next));
    const nextCounts = cachedLanePlan(
      {
        annotations,
        primers: layoutPrimers,
        orfs: layoutOrfs,
        cpr: prediction.next,
        seqLen,
        isCircular,
        normalizedBpOffset: predictedTopBp,
        topBufferCount,
        realRowCount: predictedRealRowCount,
        bottomBufferCount,
        showPrimers: (config.showPrimers ?? false) && layoutPrimers.length > 0,
        cdsAsFeatureAnnotations,
        cdsDetailProgress:
          cdsAsFeatureAnnotations || config.cdsZoomPresentation
            ? undefined
            : cdsLayoutProgress(config),
      },
      primers,
      orfs
    );
    if (!__precomputedLaneCounts)
      predictedHeights = fillPrecomputedRowHeights(
        nextCounts,
        nextCounts.length,
        config,
        hasMutationTrack
      );
    predictedCounts = nextCounts;
  }
  let secondHeights: Float64Array | null = null;
  let secondCounts: LanePlan | null = null;
  let secondRealRowCount = baseLineCount;
  let secondTopBp = normalizedBpOffset;
  const forecastTopBp = (futureCpr: number, boundaryCapacity = futureCpr): number => {
    const availableWidth = config.wrapCapacity! * charWidth;
    const anchorColumn = Math.max(
      0,
      Math.min(
        futureCpr - 1,
        Math.round(
          ((config.wrapAnchorViewportX! - marginLeft) * boundaryCapacity) /
            Math.max(1, availableWidth)
        )
      )
    );
    const unwrappedTop = config.wrapAnchorBp! - anchorColumn;
    return isCircular
      ? ((unwrappedTop % seqLen) + seqLen) % seqLen
      : linearWrapTopBp(
          config.wrapAnchorBp!,
          anchorColumn,
          futureCpr,
          config.pinLinearOrigin === true
        );
  };
  if (twoWrapForecast && secondForecastProgress > 0) {
    const nextCpr = charsPerLine + 2;
    secondTopBp = forecastTopBp(nextCpr);
    secondRealRowCount = isCircular
      ? Math.ceil(seqLen / nextCpr)
      : Math.max(1, Math.ceil((seqLen - secondTopBp) / nextCpr));
    secondCounts = cachedLanePlan(
      {
        annotations,
        primers: layoutPrimers,
        orfs: layoutOrfs,
        cpr: nextCpr,
        seqLen,
        isCircular,
        normalizedBpOffset: secondTopBp,
        topBufferCount,
        realRowCount: secondRealRowCount,
        bottomBufferCount,
        showPrimers: (config.showPrimers ?? false) && layoutPrimers.length > 0,
        cdsAsFeatureAnnotations,
        cdsDetailProgress:
          cdsAsFeatureAnnotations || config.cdsZoomPresentation
            ? undefined
            : cdsLayoutProgress(config),
      },
      primers,
      orfs
    );
    if (!__precomputedLaneCounts)
      secondHeights = fillPrecomputedRowHeights(
        secondCounts,
        secondCounts.length,
        config,
        hasMutationTrack
      );
  }
  let reverseHeights: Float64Array | null = null;
  let reverseCounts: LanePlan | null = null;
  let reverseRealRowCount = baseLineCount;
  let reverseTopBp = normalizedBpOffset;
  if (reverseProgress > 0) {
    const reverseCpr = charsPerLine - 1;

    reverseTopBp = forecastTopBp(reverseCpr, charsPerLine);
    reverseRealRowCount = isCircular
      ? Math.ceil(seqLen / reverseCpr)
      : Math.max(1, Math.ceil((seqLen - reverseTopBp) / reverseCpr));
    reverseCounts = cachedLanePlan(
      {
        annotations,
        primers: layoutPrimers,
        orfs: layoutOrfs,
        cpr: reverseCpr,
        seqLen,
        isCircular,
        normalizedBpOffset: reverseTopBp,
        topBufferCount,
        realRowCount: reverseRealRowCount,
        bottomBufferCount,
        showPrimers: (config.showPrimers ?? false) && layoutPrimers.length > 0,
        cdsAsFeatureAnnotations,
        cdsDetailProgress:
          cdsAsFeatureAnnotations || config.cdsZoomPresentation
            ? undefined
            : cdsLayoutProgress(config),
      },
      primers,
      orfs
    );
    if (!__precomputedLaneCounts)
      reverseHeights = fillPrecomputedRowHeights(
        reverseCounts,
        reverseCounts.length,
        config,
        hasMutationTrack
      );
  }
  let secondReverseHeights: Float64Array | null = null;
  let secondReverseCounts: LanePlan | null = null;
  let secondReverseRealRowCount = baseLineCount;
  let secondReverseTopBp = normalizedBpOffset;
  if (secondReverseProgress > 0) {
    const secondReverseCpr = charsPerLine - 2;

    secondReverseTopBp = forecastTopBp(secondReverseCpr, charsPerLine - 1);
    secondReverseRealRowCount = isCircular
      ? Math.ceil(seqLen / secondReverseCpr)
      : Math.max(1, Math.ceil((seqLen - secondReverseTopBp) / secondReverseCpr));
    secondReverseCounts = cachedLanePlan(
      {
        annotations,
        primers: layoutPrimers,
        orfs: layoutOrfs,
        cpr: secondReverseCpr,
        seqLen,
        isCircular,
        normalizedBpOffset: secondReverseTopBp,
        topBufferCount,
        realRowCount: secondReverseRealRowCount,
        bottomBufferCount,
        showPrimers: (config.showPrimers ?? false) && layoutPrimers.length > 0,
        cdsAsFeatureAnnotations,
        cdsDetailProgress:
          cdsAsFeatureAnnotations || config.cdsZoomPresentation
            ? undefined
            : cdsLayoutProgress(config),
      },
      primers,
      orfs
    );
    if (!__precomputedLaneCounts)
      secondReverseHeights = fillPrecomputedRowHeights(
        secondReverseCounts,
        secondReverseCounts.length,
        config,
        hasMutationTrack
      );
  }
  markPerfPhase('futurePlan');

  const currentAnchorRow =
    config.wrapAnchorBp === undefined
      ? null
      : Math.floor((config.wrapAnchorBp - normalizedBpOffset) / charsPerLine) + topBufferCount;
  const projectedIndexFor = (
    counts: LanePlan | null,
    futureCpr: number,
    futureTopBp: number,
    futureRealRows: number
  ) => {
    const anchorShift =
      config.wrapAnchorBp === undefined || !prediction
        ? null
        : Math.floor((config.wrapAnchorBp - futureTopBp) / futureCpr) -
          Math.floor((config.wrapAnchorBp - normalizedBpOffset) / charsPerLine);
    let lastProjectedRow = -1;
    let lastProjectedIndex = -1;
    let lastCircularRow = -1;
    let lastCircularOffset = 0;
    const project = (i: number) => {
      if (i === lastProjectedRow) return lastProjectedIndex;
      const max = (counts?.length ?? totalLineCount) - 1;
      let result: number;
      if (
        anchorShift !== null &&
        currentAnchorRow !== null &&
        Math.abs(i - currentAnchorRow) <= 128
      ) {
        result = Math.max(0, Math.min(max, i + anchorShift));
      } else if (anchorShift === null) {
        result =
          i < topBufferCount + baseLineCount
            ? Math.min(i, topBufferCount + futureRealRows - 1)
            : i - baseLineCount + futureRealRows;
      } else {
        let offset: number;
        if (isCircular && i >= topBufferCount && i < topBufferCount + baseLineCount) {
          if (i === lastCircularRow + 1) {
            offset = lastCircularOffset + charsPerLine;
            if (offset >= seqLen) offset %= seqLen;
          } else {
            offset =
              (normalizedBpOffset + (i - topBufferCount) * charsPerLine - futureTopBp) % seqLen;
            if (offset < 0) offset += seqLen;
          }
          lastCircularRow = i;
          lastCircularOffset = offset;
        } else {
          offset = normalizedBpOffset + (i - topBufferCount) * charsPerLine - futureTopBp;
        }
        result = Math.max(0, Math.min(max, Math.floor(offset / futureCpr) + topBufferCount));
      }
      lastProjectedRow = i;
      lastProjectedIndex = result;
      return result;
    };
    return Object.assign(project, {
      breakpoints: (visit: (row: number) => void) =>
        visitProjectedRowBreakpoints(
          {
            cpr: charsPerLine,
            topBp: normalizedBpOffset,
            topBufferCount,
            realRowCount: baseLineCount,
            totalRows: totalLineCount,
            seqLength: seqLen,
            circular: isCircular,
          },
          {
            cpr: futureCpr,
            topBp: futureTopBp,
            topBufferCount,
            realRowCount: futureRealRows,
            totalRows: counts?.length ?? totalLineCount,
            seqLength: seqLen,
            circular: isCircular,
          },
          counts?.runs.map((run) => run.start) ?? [],
          currentAnchorRow,
          anchorShift,
          visit
        ),
    });
  };
  const predictedIndex = projectedIndexFor(
    predictedCounts,
    prediction?.next ?? charsPerLine,
    predictedTopBp,
    predictedRealRowCount
  );
  const secondIndex = projectedIndexFor(
    secondCounts,
    charsPerLine + 2,
    secondTopBp,
    secondRealRowCount
  );
  const reverseIndex = projectedIndexFor(
    reverseCounts,
    charsPerLine - 1,
    reverseTopBp,
    reverseRealRowCount
  );
  const secondReverseIndex = projectedIndexFor(
    secondReverseCounts,
    charsPerLine - 2,
    secondReverseTopBp,
    secondReverseRealRowCount
  );

  const bandCache = new Map<RowLaneCounts, number[]>();
  const boundariesForCounts = (counts: RowLaneCounts): number[] => {
    const cached = bandCache.get(counts);
    if (cached) return cached;
    const bands = lineTrackBoundaries({ y: 0, ...counts, hasMutationTrack } as Layout2DRow, config);
    bandCache.set(counts, bands);
    return bands;
  };
  const detailBandCache = new Map<RowLaneCounts, number[]>();
  const detailBoundariesForCounts = (counts: RowLaneCounts): number[] => {
    const cached = detailBandCache.get(counts);
    if (cached) return cached;
    const bands = lineTrackBoundaries(
      { y: 0, ...counts, hasMutationTrack } as Layout2DRow,
      detailConfig!
    );
    detailBandCache.set(counts, bands);
    return bands;
  };
  const predictedHeightCache = new Map<
    RowLaneCounts,
    Map<
      RowLaneCounts | null,
      Map<
        RowLaneCounts | null,
        Map<RowLaneCounts | null, Map<RowLaneCounts | null, Map<RowLaneCounts | null, number>>>
      >
    >
  >();
  const reservedHeightForCounts = (
    current: RowLaneCounts,
    wrap: RowLaneCounts | null,
    second: RowLaneCounts | null,
    reverse: RowLaneCounts | null,
    secondReverse: RowLaneCounts | null,
    detail: RowLaneCounts | null
  ): number => {
    let byWrap = predictedHeightCache.get(current);
    let bySecond = byWrap?.get(wrap);
    let byReverse = bySecond?.get(second);
    let bySecondReverse = byReverse?.get(reverse);
    let byDetail = bySecondReverse?.get(secondReverse);
    const cached = byDetail?.get(detail);
    if (cached !== undefined) return cached;
    const baseBands = boundariesForCounts(current);
    const wrapBands = wrap && prediction ? boundariesForCounts(wrap) : null;
    const secondBands = second && prediction ? boundariesForCounts(second) : null;
    const reverseBands = reverse ? boundariesForCounts(reverse) : null;
    const secondReverseBands = secondReverse ? boundariesForCounts(secondReverse) : null;
    const detailBands = detail && detailPreview ? detailBoundariesForCounts(detail) : null;
    let height = 0;
    for (let i = 0; i < baseBands.length - 1; i++) {
      let size = baseBands[i + 1] - baseBands[i];
      if (wrapBands)
        size += Math.max(0, wrapBands[i + 1] - wrapBands[i] - size) * firstForecastProgress;
      if (secondBands)
        size += Math.max(0, secondBands[i + 1] - secondBands[i] - size) * secondForecastProgress;
      if (reverseBands)
        size += Math.max(0, reverseBands[i + 1] - reverseBands[i] - size) * reverseProgress;
      if (secondReverseBands)
        size +=
          Math.max(0, secondReverseBands[i + 1] - secondReverseBands[i] - size) *
          secondReverseProgress;
      if (detailBands)
        size += Math.max(0, detailBands[i + 1] - detailBands[i] - size) * detailPreview!.progress;
      height += size;
    }
    if (!byWrap) {
      byWrap = new Map();
      predictedHeightCache.set(current, byWrap);
    }
    if (!bySecond) {
      bySecond = new Map();
      byWrap.set(wrap, bySecond);
    }
    if (!byReverse) {
      byReverse = new Map();
      bySecond.set(second, byReverse);
    }
    if (!bySecondReverse) {
      bySecondReverse = new Map();
      byReverse.set(reverse, bySecondReverse);
    }
    if (!byDetail) {
      byDetail = new Map();
      bySecondReverse.set(secondReverse, byDetail);
    }
    byDetail.set(detail, height);
    return height;
  };
  let lastHeightCurrent: RowLaneCounts | null = null;
  let lastHeightWrap: RowLaneCounts | null = null;
  let lastHeightSecond: RowLaneCounts | null = null;
  let lastHeightReverse: RowLaneCounts | null = null;
  let lastHeightSecondReverse: RowLaneCounts | null = null;
  let lastHeightDetail: RowLaneCounts | null = null;
  let lastReservedHeight = 0;
  const predictedHeight = (i: number, natural: number): number => {
    if (
      !predictedCounts &&
      !secondCounts &&
      !reverseCounts &&
      !secondReverseCounts &&
      !detailCounts
    )
      return natural;
    const current = __precomputedLaneCounts?.countAt(i);
    const wrap = predictedCounts?.countAt(predictedIndex(i)) ?? null;
    const second = secondCounts?.countAt(secondIndex(i)) ?? null;
    const reverse = reverseCounts?.countAt(reverseIndex(i)) ?? null;
    const secondReverse = secondReverseCounts?.countAt(secondReverseIndex(i)) ?? null;
    const detail = detailCounts?.countAt(i) ?? null;
    if (current) {
      if (
        current === lastHeightCurrent &&
        wrap === lastHeightWrap &&
        second === lastHeightSecond &&
        reverse === lastHeightReverse &&
        secondReverse === lastHeightSecondReverse &&
        detail === lastHeightDetail
      ) {
        return lastReservedHeight;
      }
      const reservedHeight = reservedHeightForCounts(
        current,
        wrap,
        second,
        reverse,
        secondReverse,
        detail
      );
      lastHeightCurrent = current;
      lastHeightWrap = wrap;
      lastHeightSecond = second;
      lastHeightReverse = reverse;
      lastHeightSecondReverse = secondReverse;
      lastHeightDetail = detail;
      lastReservedHeight = reservedHeight;
      return lastReservedHeight;
    }
    let height = natural;
    if (predictedHeights)
      height +=
        Math.max(0, (predictedHeights[predictedIndex(i)] ?? height) - height) *
        firstForecastProgress;
    if (secondHeights && prediction)
      height +=
        Math.max(0, (secondHeights[secondIndex(i)] ?? height) - height) * secondForecastProgress;
    if (reverseHeights)
      height += Math.max(0, (reverseHeights[reverseIndex(i)] ?? height) - height) * reverseProgress;
    if (secondReverseHeights)
      height +=
        Math.max(0, (secondReverseHeights[secondReverseIndex(i)] ?? height) - height) *
        secondReverseProgress;
    return height;
  };
  const applyTrackPrediction = (line: Layout2DRow, naturalHeight: number): number => {
    const counts = predictedCounts?.countAt(predictedIndex(line.lineIndex));
    const second = secondCounts?.countAt(secondIndex(line.lineIndex));
    const reverse = reverseCounts?.countAt(reverseIndex(line.lineIndex));
    const secondReverse = secondReverseCounts?.countAt(secondReverseIndex(line.lineIndex));
    const detail = detailCounts?.countAt(line.lineIndex);
    if (!counts && !second && !reverse && !secondReverse && !detail) return naturalHeight;
    const natural = lineTrackBoundaries(line, config);
    let painted = natural;
    if (counts && prediction) {
      painted = reserveTrackBands(
        painted,
        lineTrackBoundaries({ ...line, ...counts }, config),
        firstForecastProgress
      );
    }
    if (second && prediction)
      painted = reserveTrackBands(
        painted,
        lineTrackBoundaries({ ...line, ...second }, config),
        secondForecastProgress
      );
    if (reverse)
      painted = reserveTrackBands(
        painted,
        lineTrackBoundaries({ ...line, ...reverse }, config),
        reverseProgress
      );
    if (secondReverse)
      painted = reserveTrackBands(
        painted,
        lineTrackBoundaries({ ...line, ...secondReverse }, config),
        secondReverseProgress
      );
    if (detail && detailPreview) {
      painted = reserveTrackBands(
        painted,
        lineTrackBoundaries({ ...line, ...detail }, detailConfig!),
        detailPreview.progress
      );
    }
    if (natural.every((y, i) => y === painted[i])) return naturalHeight;
    line.trackMorph = {
      natural,
      painted,
    };
    return painted[painted.length - 1];
  };

  let projectedHeights: Float64Array | null = null;

  if (
    __emitOnlyViewportLines &&
    __precomputedLaneCounts &&
    __precomputedRowHeights &&
    (predictedCounts || secondCounts || reverseCounts || secondReverseCounts || detailCounts)
  ) {
    const points = new Set<number>([0, totalLineCount]);
    for (const run of __precomputedLaneCounts.runs) points.add(run.start);
    for (const run of detailCounts?.runs ?? []) points.add(run.start);
    for (const [counts, projection] of [
      [predictedCounts, predictedIndex],
      [secondCounts, secondIndex],
      [reverseCounts, reverseIndex],
      [secondReverseCounts, secondReverseIndex],
    ] as const)
      if (counts) projection.breakpoints((row) => points.add(row));
    const boundaries = [...points].sort((a, b) => a - b);
    projectedHeights = new Float64Array(totalLineCount);
    for (let run = 0; run < boundaries.length - 1; run++) {
      const start = boundaries[run];
      projectedHeights.fill(
        predictedHeight(start, __precomputedRowHeights[start]),
        start,
        boundaries[run + 1]
      );
    }
  }

  markPerfPhase('projectedHeights');

  if (__emitOnlyViewportLines && __precomputedRowHeights) {
    __rowHeights.set(projectedHeights ?? __precomputedRowHeights);
    if (viewportRange?.anchorRowIndex !== undefined && viewportRange.radiusPx !== undefined) {
      const anchor = Math.max(__vpFirst, Math.min(__vpLast, viewportRange.anchorRowIndex));
      const radius = Math.max(0, viewportRange.radiusPx);
      const paintedPitch = Math.max(0.001, viewportRange.maxPaintedRowPitch ?? Infinity);
      const pitch = (i: number) => Math.min(__rowHeights[i] + rowGapPx, paintedPitch);
      let first = anchor,
        last = anchor,
        before = 0,
        after = 0;
      while (first > Math.max(0, __vpFirst) && before < radius) before += pitch(--first);
      while (last < Math.min(totalLineCount - 1, __vpLast) && after < radius)
        after += pitch(++last);
      __vpFirst = first;
      __vpLast = last;
    }
    const first = Math.max(0, __vpFirst);
    const last = Math.min(totalLineCount - 1, __vpLast);
    for (let i = first; i <= last; i++) {
      const effectiveIndex = i - topBufferCount;
      const isTopBuffer = effectiveIndex < 0;
      const isBottomBuffer = effectiveIndex >= baseLineCount;
      const geometry = sequenceLayoutLineGeometry({
        isCircular,
        effectiveIndex,
        charsPerLine,
        seqLen,
        normalizedOffset,
        normalizedBpOffset,
      });
      if (!geometry) continue;
      const packed = layoutViewportSequenceRow({
        i,
        y: 0,
        geometry,
        isCircular,
        seqStr,
        seqLen,
        nucleicAcid,
        strandOverrides: sequence.strandOverrides,
        isBufferRow: isTopBuffer || isBottomBuffer,
        isTopBuffer,
        isBottomBuffer,
        densityLod,
        cdsAsFeatureAnnotations,
        config,
        hasMutationTrack,
        layoutPrimers,
        annotationIndex,
        orfIndex,
        primerIndex,
        timings: layoutRowTimings,
      });
      const height = applyTrackPrediction(packed.line, packed.lineHeight);
      packed.line.xOffset = contentOffsetForRow(i, geometry.leadingColumns);
      packed.line.naturalHeight = packed.lineHeight;
      packed.line.heightScale = height / packed.lineHeight;
      lines.push(packed.line);
      __rowHeights[i] = height;
    }
    y = fillRowYOffsets(__rowHeights, __rowYOffsets, topPaddingPx, rowGapPx);
    for (const line of lines) line.y = __rowYOffsets[line.lineIndex];
    realRowsStartY = __rowYOffsets[firstRealRowIndex];
    bottomBufferStartY = __rowYOffsets[firstBottomBufferIndex];
  } else
    for (let i = 0; i < totalLineCount; i++) {
      const effectiveIndex = i - topBufferCount;
      const isTopBuffer = effectiveIndex < 0;
      const isBottomBuffer = effectiveIndex >= baseLineCount;
      const isBufferRow = isTopBuffer || isBottomBuffer;
      const inViewport = !__viewportActive || (i >= __vpFirst && i <= __vpLast);
      const geometry = sequenceLayoutLineGeometry({
        isCircular,
        effectiveIndex,
        charsPerLine,
        seqLen,
        normalizedOffset,
        normalizedBpOffset,
      });
      if (!geometry) continue;

      if (i === firstRealRowIndex) realRowsStartY = y;
      if (i === firstBottomBufferIndex) bottomBufferStartY = y;

      if (!inViewport && (__precomputedRowHeights !== null || __approximateOffscreenRowHeight)) {
        const offscreen = layoutOffscreenSequenceRow({
          i,
          y,
          geometry,
          isCircular,
          seqStr,
          isBufferRow,
          isTopBuffer,
          isBottomBuffer,
          emitOnlyViewportLines: __emitOnlyViewportLines,
          precomputedRowHeights: __precomputedRowHeights,
          approximateOffscreenRowHeight: __approximateOffscreenRowHeight,
          precomputedLaneCounts: __precomputedLaneCounts,
        });
        const height = offscreen.skipEmit
          ? predictedHeight(i, offscreen.height)
          : applyTrackPrediction(offscreen.line, offscreen.height);
        __rowHeights[i] = height;
        if (!offscreen.skipEmit) {
          offscreen.line.xOffset = contentOffsetForRow(i, geometry.leadingColumns);
          offscreen.line.naturalHeight = offscreen.height;
          offscreen.line.heightScale = height / offscreen.height;
          lines.push(offscreen.line);
        }
        y += height;
        if (i < totalLineCount - 1) y += rowGapPx;
        __rowYOffsets[i + 1] = y;
        continue;
      }

      const packed = layoutViewportSequenceRow({
        i,
        y,
        geometry,
        isCircular,
        seqStr,
        seqLen,
        nucleicAcid,
        strandOverrides: sequence.strandOverrides,
        isBufferRow,
        isTopBuffer,
        isBottomBuffer,
        densityLod,
        cdsAsFeatureAnnotations,
        config,
        hasMutationTrack,
        layoutPrimers,
        annotationIndex,
        orfIndex,
        primerIndex,
        timings: layoutRowTimings,
      });
      const height = applyTrackPrediction(packed.line, packed.lineHeight);
      packed.line.xOffset = contentOffsetForRow(i, geometry.leadingColumns);
      packed.line.naturalHeight = packed.lineHeight;
      packed.line.heightScale = height / packed.lineHeight;
      lines.push(packed.line);
      __rowHeights[i] = height;
      y += height;
      if (i < totalLineCount - 1) y += rowGapPx;
      __rowYOffsets[i + 1] = y;
    }
  markPerfPhase('rowOffsets');

  y += bottomPaddingPx;

  if (totalLineCount > 0) {
    __rowYOffsets[totalLineCount] = y;
  } else {
    __rowYOffsets[0] = y;
  }

  if (bottomBufferCount === 0 || bottomBufferStartY === 0) {
    bottomBufferStartY = y;
  }

  const summary: import('./types').SequenceLayoutSummary = {
    cpr: charsPerLine,
    seqLength: seqLen,
    isCircular,
    topBp: normalizedTopBp,
    topBufferCount,
    realRowCount: baseLineCount,
    bottomBufferCount,
    totalRows: totalLineCount,
    avgRowHeight: totalLineCount > 0 ? y / totalLineCount : config.rowHeight,
    topPaddingPx,
    rowGapPx,
    rowHeights: __rowHeights,
    rowYOffsets: __rowYOffsets,
  };

  const layoutResult: LayoutSnapshot2D = {
    lines,
    totalHeight: y,
    totalWidth:
      marginLeft + charsPerLine * charWidth + Math.ceil(config.rowHeight * CHEVRON_WIDTH_RATIO),
    sequenceLength: seqLen,
    isCircular,
    circularOffset: normalizedOffset,
    bpOffset: normalizedBpOffset,
    firstRealRowIndex,
    firstBottomBufferIndex,
    realRowsStartY,
    bottomBufferStartY,
    summary,
  };

  diag.capture({
    type: 'layout',
    totalHeight: y,
    totalLineCount,
    lineH: totalLineCount > 0 ? y / totalLineCount : 0,
    lazyMode: __viewportActive,
    computeRangeFirst: __viewportActive ? __vpFirst : 0,
    computeRangeLast: __viewportActive ? __vpLast : Math.max(0, totalLineCount - 1),
    sequenceLength: seqLen,
    isCircular,
  });

  markPerfPhase('finish');
  recordLayoutZoomPerf(layoutRowTimings, __zoomPerfStart, totalLineCount, seqLen, perfPhases);

  return layoutResult;
}

export interface UseSequenceLayoutResult {
  layout: QuerySequenceLayout;
  snapshot: LayoutSnapshot2D;
}

export function annotationLayoutKey(annotations: ReadonlyArray<Annotation> | undefined): string {
  if (!annotations || annotations.length === 0) return '';
  const parts: string[] = [];
  for (const a of annotations) {
    const segHash =
      a.segments && a.segments.length > 0
        ? a.segments.map((s) => `${s.start}-${s.end}`).join(',')
        : '';
    const previewBounds = a.qualifiers?.[CDS_EXTENSION_ORIGINAL_QUALIFIER]?.[0] ?? '';

    const draftedEnds = a.qualifiers?.[CDS_EXTENSION_DIRECTION_QUALIFIER]?.join(',') ?? '';
    const hoveredEnds = a.qualifiers?.[CDS_EXTENSION_HOVER_QUALIFIER]?.join(',') ?? '';
    parts.push(
      `${a.start}|${a.end}|${a.name}|${a.type}|${a.direction ?? 0}|${a.color ?? ''}|${segHash}|${a.qualifiers?.source?.[0] ?? ''}|${a.qualifiers?.status?.[0] ?? ''}|${previewBounds}|${draftedEnds}|${hoveredEnds}`
    );
  }
  return parts.join('\u0001');
}

export function useSequenceLayout(
  sequence: AnnotatedSequence | null,
  partialConfig?: Partial<WorkspaceEditorConfig>,
  circularOffset: number = 0,
  virtualRowCount: number = 0,
  primers: PrimerDisplay[] = EMPTY_PRIMERS as PrimerDisplay[],
  hasMutationTrack: boolean = false,
  orfs: ORF[] = EMPTY_ORFS as ORF[],
  bpOffset: number = 0,
  viewportRange?: ViewportRange
): UseSequenceLayoutResult {
  const config = { ...DEFAULT_EDITOR_CONFIG, ...partialConfig };
  const wrapLayoutCapacity =
    config.wrapTrackForecast === false && config.wrapAnchorBp === undefined
      ? undefined
      : config.wrapCapacity;

  const vpFirst = viewportRange?.firstRowIndex;
  const vpLast = viewportRange?.lastRowIndex;
  const vpApproximateOffscreenRowHeight = viewportRange?.approximateOffscreenRowHeight;
  const vpEmitOnlyViewportLines = viewportRange?.emitOnlyViewportLines;
  const vpAnchorRowIndex = viewportRange?.anchorRowIndex;
  const vpRadiusPx = viewportRange?.radiusPx;
  const vpMaxPaintedRowPitch = viewportRange?.maxPaintedRowPitch;
  const strandOverridesKey = useMemo(
    () => JSON.stringify(sequence?.strandOverrides ?? []),
    [sequence?.strandOverrides]
  );
  const layoutDepDebugRef = useRef<Record<string, unknown> | null>(null);
  const layoutDepDebug: Record<string, unknown> = {
    sequenceId: sequence?.id,
    sequenceText: sequence?.sequence,
    molecule: sequence?.molecule,
    strandOverridesKey,
    annotationCount: sequence?.annotations?.length,
    circular: sequence?.circular,
    circularOffset,
    virtualRowCount,
    bpOffset,
    vpFirst,
    vpLast,
    vpApproximateOffscreenRowHeight,
    vpEmitOnlyViewportLines,
    vpAnchorRowIndex,
    vpRadiusPx,
    vpMaxPaintedRowPitch,
    charsPerLine: config.charsPerLine,
    wrapCapacity: wrapLayoutCapacity,
    wrapAnchorViewportX: config.wrapAnchorViewportX,
    wrapAnchorCapacityBias: config.wrapAnchorCapacityBias,
    wrapForecastDirection: config.wrapForecastDirection,
    wrapPreviewTargetCpr: config.wrapPreviewTargetCpr,
    wrapTrackForecast: config.wrapTrackForecast,
    cdsDetailProgress: config.cdsDetailProgress,
    cdsAminoAcidHeight: config.cdsZoomPresentation?.aaHeight,
    previewDetailProgress: config.previewDetailTracks?.progress,
    previewDetailTranslation: config.previewDetailTracks?.showTranslation,
    previewDetailComplement: config.previewDetailTracks?.showReverseComplement,
    previewDetailResidueNumbers: config.previewDetailTracks?.showResidueNumbers,
    predictedTopBp: config.predictedTopBp,
    wrapAnchorBp: config.wrapAnchorBp,
    charWidth: config.charWidth,
    marginLeft: config.marginLeft,
    rowHeight: config.rowHeight,
    showAnnotations: config.showAnnotations,
    showTranslation: config.showTranslation,
    showReverseComplement: config.showReverseComplement,
    showPrimers: config.showPrimers,
    showResidueNumbers: config.showResidueNumbers,
    lodLevel: config.lodLevel,
    overviewLod: config.overviewLod,
    primers,
    hasMutationTrack,
    orfs,
  };

  const annotationsKey = useMemo(
    () => annotationLayoutKey(sequence?.annotations),
    [sequence?.annotations]
  );

  const snapshot = useMemo<LayoutSnapshot2D>(
    () => {
      const cacheInputs =
        sequence && sequence.sequence.length >= 100_000 && vpFirst != null && vpLast != null
          ? [annotationsKey, ...Object.values(layoutDepDebug)]
          : null;
      if (sequence && cacheInputs) {
        const resident = findResidentLargeGenomeLayout(sequence, cacheInputs);
        if (resident) {
          layoutDepDebugRef.current = layoutDepDebug;
          diag.capture({ type: 'marker', label: 'sequence-layout-cache-hit' });
          return resident;
        }
      }

      if (typeof window !== 'undefined') {
        const w = canvasTestWindow(window);
        w.__layoutRecomputeCount = (w.__layoutRecomputeCount ?? 0) + 1;
      }
      const prevLayoutDeps = layoutDepDebugRef.current;
      if (prevLayoutDeps) {
        const changed = Object.keys(layoutDepDebug).filter(
          (key) => prevLayoutDeps[key] !== layoutDepDebug[key]
        );
        diag.capture({
          type: 'marker',
          label: 'sequence-layout-recompute-deps',
          data: {
            changed,
            annotationCount: sequence?.annotations?.length ?? 0,
            primerCount: primers.length,
            orfCount: orfs.length,
            viewportScoped: vpFirst != null || vpLast != null,
          },
        });
      }
      layoutDepDebugRef.current = layoutDepDebug;
      const computed = computeSequenceLayoutImpl(
        sequence,
        config,
        circularOffset,
        virtualRowCount,
        primers,
        hasMutationTrack,
        orfs,
        bpOffset,
        materializeViewportRange({
          firstRowIndex: vpFirst,
          lastRowIndex: vpLast,
          approximateOffscreenRowHeight: vpApproximateOffscreenRowHeight,
          emitOnlyViewportLines: vpEmitOnlyViewportLines,
          anchorRowIndex: vpAnchorRowIndex,
          radiusPx: vpRadiusPx,
          maxPaintedRowPitch: vpMaxPaintedRowPitch,
        })
      );
      if (sequence && cacheInputs) rememberLargeGenomeLayout(sequence, cacheInputs, computed);
      return computed;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sequence?.id,
      sequence?.sequence,
      sequence?.molecule,
      strandOverridesKey,
      annotationsKey,
      sequence?.circular,
      circularOffset,
      virtualRowCount,
      bpOffset,
      vpFirst,
      vpLast,
      vpApproximateOffscreenRowHeight,
      vpEmitOnlyViewportLines,
      vpAnchorRowIndex,
      vpRadiusPx,
      vpMaxPaintedRowPitch,
      config.charsPerLine,
      wrapLayoutCapacity,
      config.wrapAnchorViewportX,
      config.wrapAnchorCapacityBias,
      config.wrapForecastDirection,
      config.wrapPreviewTargetCpr,
      config.wrapTrackForecast,
      config.cdsDetailProgress,
      config.cdsZoomPresentation?.aaHeight,
      config.previewDetailTracks?.progress,
      config.previewDetailTracks?.showTranslation,
      config.previewDetailTracks?.showReverseComplement,
      config.previewDetailTracks?.showResidueNumbers,
      config.predictedTopBp,
      config.wrapAnchorBp,
      config.charWidth,
      config.marginLeft,
      config.rowHeight,
      config.showAnnotations,
      config.showTranslation,
      config.showReverseComplement,
      config.showPrimers,
      config.showResidueNumbers,
      config.lodLevel,
      config.overviewLod,
      primers,
      hasMutationTrack,
      orfs,
    ]
  );

  const layout = useMemo<QuerySequenceLayout>(
    () => create2DLayoutAdapter(snapshot, config),
    [
      snapshot,
      config.marginLeft,
      config.charWidth,
      config.rulerInterval,
      config.showAnnotations,
      config.rowHeight,
    ]
  );

  return { layout, snapshot };
}

export function getPositionFromCoordinates(
  x: number,
  y: number,
  layout: LayoutSnapshot2D,
  config: WorkspaceEditorConfig
): number | null {
  const { marginLeft, charWidth, rowHeight } = config;

  if (x < marginLeft) {
    return null;
  }

  const defaultRowGap = layout.summary?.rowGapPx ?? 32;
  let line: (typeof layout.lines)[0] | undefined;
  for (let idx = 0; idx < layout.lines.length; idx++) {
    const l = layout.lines[idx];
    const nextLine = layout.lines[idx + 1];
    const lineEnd = nextLine ? nextLine.y : layout.totalHeight;
    if (y >= l.y && y < lineEnd) {
      const rowGap = layout.summary
        ? Math.max(
            0,
            layout.summary.rowYOffsets[l.lineIndex + 1] -
              layout.summary.rowYOffsets[l.lineIndex] -
              layout.summary.rowHeights[l.lineIndex]
          )
        : defaultRowGap;

      if (nextLine?.lineIndex === l.lineIndex + 1 && y >= nextLine.y - rowGap) {
        line = nextLine;
      } else {
        line = l;
      }
      break;
    }
  }

  if (!line) {
    return null;
  }

  const sequenceY = computeLineTrackPositions(line, config).sequenceY;
  const naturalY = rowHitY(line, y);
  if (!Number.isFinite(naturalY) || naturalY < sequenceY || naturalY > sequenceY + rowHeight)
    return null;

  const xInSequence = x - marginLeft - (line.xOffset ?? 0);
  const charIndex = Math.round(xInSequence / charWidth);

  if (charIndex < 0 || charIndex > line.sequence.length) {
    return null;
  }

  return line.startPos + charIndex;
}
