import type { Annotation, AnnotatedSequence, AnnotationDirection } from '@waypoint/sequence-utils';
import { getVisibleAnnotations } from '@waypoint/sequence-utils';

import {
  getSelectionLength,
  isPositionInRange,
  type SelectionRange,
} from '../../../../../../packages/core/workspace-editor/src/selection-model';
import {
  buildSplicedCodingSequence,
  isSplicedCDS,
} from '../../../../../../packages/core/workspace-editor/src/translation/spliced-coding-sequence';

import { projectVisibleOverlays } from './active-overlays';
import { OVERLAP_FEATURE_CAP, overlapRelation } from './overlap';
import { untrustedField } from './sanitize';
import type {
  BoundaryFlags,
  SequenceDescriptorInput,
  FeatureStrand,
  FileTextMap,
  OverlappingFeature,
  RawFallback,
  ReadingFrameEntry,
  RegionStrand,
  SequenceRegionDescriptor,
  SequenceRegionMeasured,
} from './types';

export const LARGE_REGION_BP = 50_000;
export const RAW_FALLBACK_CAP_BP = 5000;
export { OVERLAP_FEATURE_CAP, overlapRelation } from './overlap';
const LANDMARK_CAP = 12;
const PRODUCT_CAP = 200;
const NAME_CAP = 120;
const INTRON_SCAN_CAP_BP = 200_000;

export const REGION_COMPUTE_TOOLS = [
  'selection_translate',
  'selection_restriction_sites',
  'selection_gc_profile',
  'selection_find_orfs',
] as const;

const REGULATORY_TYPES = new Set(
  [
    'promoter',
    'terminator',
    'enhancer',
    'protein_bind',
    'misc_binding',
    'regulatory',
    'rbs',
    'ribosome_binding_site',
    '-35_signal',
    '-10_signal',
    'tata_signal',
    'polya_signal',
    'operator',
    'attenuator',
    'sig_peptide',
    'minus_35_signal',
    'minus_10_signal',
  ].map((t) => t.toLowerCase())
);

const NOTABLE_TYPES = new Set(
  [
    'cds',
    'gene',
    'mrna',
    'trna',
    'rrna',
    'ncrna',
    'rep_origin',
    'origin',
    'ori',
    'source',
    'mobile_element',
    ...REGULATORY_TYPES,
  ].map((t) => t.toLowerCase())
);

export function directionToStrand(direction: AnnotationDirection): FeatureStrand {
  return direction === 1 ? '+' : direction === -1 ? '-' : 'unspecified';
}

export function to0IndexedRange(range: {
  start: number;
  end: number;
  wraps?: boolean;
}): SelectionRange {
  const wraps = range.wraps ?? range.start > range.end;
  return { start: range.start - 1, end: range.end - 1, wraps };
}

function featureRange0(ann: Annotation): SelectionRange {
  return { start: ann.start - 1, end: ann.end - 1, wraps: ann.start > ann.end };
}

export function sliceBasesForRange(sequence: string, sel0: SelectionRange): string {
  if (sel0.wraps) return sequence.slice(sel0.start) + sequence.slice(0, sel0.end + 1);
  const lo = Math.min(sel0.start, sel0.end);
  const hi = Math.max(sel0.start, sel0.end);
  return sequence.slice(lo, hi + 1);
}

export function basenameFromPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function displaySequenceName(sequence: AnnotatedSequence, path: string): string {
  return sequence.name?.trim() || basenameFromPath(path);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function isCds(ann: Annotation): boolean {
  return ann.type.toUpperCase() === 'CDS';
}

function cdsIdentifier(cds: Annotation): string {
  const raw =
    cds.qualifiers?.gene?.[0] ??
    cds.label ??
    cds.qualifiers?.label?.[0] ??
    cds.qualifiers?.product?.[0] ??
    cds.name ??
    `${cds.type} ${cds.start}..${cds.end}`;
  return untrustedField(raw, NAME_CAP)?.value ?? `${cds.type} ${cds.start}..${cds.end}`;
}

function parseTranslTable(cds: Annotation): number | 'unknown' {
  const raw = cds.qualifiers?.transl_table?.[0];
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'unknown';
}

function countGenomicSpanInSelection(
  gStart: number,
  gEnd: number,
  sel0: SelectionRange,
  seqLen: number
): number {
  const spanLen = gEnd >= gStart ? gEnd - gStart + 1 : seqLen - gStart + gEnd + 1;
  if (spanLen <= 0 || spanLen > INTRON_SCAN_CAP_BP) return 0;
  let count = 0;
  for (let i = 0; i < spanLen; i++) {
    const pos = positiveModulo(gStart + i, seqLen);
    if (isPositionInRange(pos, sel0, seqLen)) count++;
  }
  return count;
}

function scanOverlappingAnnotations(
  annotations: Annotation[],
  sel0: SelectionRange,
  seqLen: number
): Annotation[] {
  if (!sel0.wraps) {
    const lo = Math.min(sel0.start, sel0.end);
    const hi = Math.max(sel0.start, sel0.end);
    return getVisibleAnnotations(annotations, lo, hi, seqLen);
  }
  const segA = getVisibleAnnotations(annotations, sel0.start, seqLen - 1, seqLen);
  const segB = getVisibleAnnotations(annotations, 0, sel0.end, seqLen);
  const seen = new Set<Annotation>();
  const out: Annotation[] = [];
  for (const ann of segA) {
    if (!seen.has(ann)) {
      seen.add(ann);
      out.push(ann);
    }
  }
  for (const ann of segB) {
    if (!seen.has(ann)) {
      seen.add(ann);
      out.push(ann);
    }
  }
  return out;
}

interface OverlapTuple {
  ann: Annotation;
  feature: OverlappingFeature;
}

function toOverlapTuple(ann: Annotation, sel0: SelectionRange, seqLen: number): OverlapTuple {
  const name = featureLandmarkName(ann) ?? undefined;
  const gene = untrustedField(ann.qualifiers?.gene?.[0], NAME_CAP)?.value ?? undefined;
  const product = untrustedField(ann.qualifiers?.product?.[0], PRODUCT_CAP)?.value ?? undefined;
  return {
    ann,
    feature: {
      type: ann.type,
      start: ann.start,
      end: ann.end,
      strand: directionToStrand(ann.direction),
      relation: overlapRelation(featureRange0(ann), sel0, seqLen),
      ...(name ? { name } : {}),
      ...(gene ? { gene } : {}),
      ...(product ? { product } : {}),
    },
  };
}

function capOverlappingFeatures(tuples: OverlapTuple[]): {
  kept: OverlappingFeature[];
  histogram: Record<string, number>;
  landmarks: string[];
} {
  const kept: OverlappingFeature[] = [];
  const keptTuples = new Set<OverlapTuple>();

  for (const t of tuples) {
    if (REGULATORY_TYPES.has(t.feature.type.toLowerCase())) {
      kept.push(t.feature);
      keptTuples.add(t);
    }
  }
  for (const t of tuples) {
    if (keptTuples.has(t)) continue;
    if (kept.length >= OVERLAP_FEATURE_CAP) break;
    kept.push(t.feature);
    keptTuples.add(t);
  }

  const histogram: Record<string, number> = {};
  const landmarks: string[] = [];
  for (const t of tuples) {
    if (keptTuples.has(t)) continue;
    histogram[t.feature.type] = (histogram[t.feature.type] ?? 0) + 1;
    if (landmarks.length < LANDMARK_CAP && NOTABLE_TYPES.has(t.feature.type.toLowerCase())) {
      const name = featureLandmarkName(t.ann);
      if (name) landmarks.push(name);
    }
  }
  return { kept, histogram, landmarks };
}

function featureLandmarkName(ann: Annotation): string | null {
  const raw =
    ann.name ||
    ann.label ||
    ann.qualifiers?.label?.[0] ||
    ann.qualifiers?.gene?.[0] ||
    ann.qualifiers?.product?.[0];
  return untrustedField(raw, NAME_CAP)?.value ?? null;
}

interface CdsAnalysis {
  entry: ReadingFrameEntry;
  spliced: boolean;
  startCodonGenomic: number[];
  stopCodonGenomic: number[];
  spliceSiteGenomic: number[];
  codingBasesInSelection: number;
  intronicBasesInSelection: number;
}

function analyzeCds(
  cds: Annotation,
  sequence: string,
  sel0: SelectionRange,
  seqLen: number
): CdsAnalysis {
  const cdsLabel = cdsIdentifier(cds);
  const strand = directionToStrand(cds.direction);
  const translTable = parseTranslTable(cds);
  const spliced = isSplicedCDS(cds);

  const unknownEntry = (reason: string, coding = 0, intronic = 0): ReadingFrameEntry => ({
    cds: cdsLabel,
    strand,
    phase: 'unknown',
    startCodonAligned: 'unknown',
    lengthIsCodonMultiple: 'unknown',
    frameshiftIfDeleted: 'unknown',
    translTable,
    reason,
    codingBasesInSelection: coding,
    intronicBasesInSelection: intronic,
  });

  const built = buildSplicedCodingSequence(cds, sequence);
  const map = built.genomicCoordinateMap;
  if (map.length === 0) {
    return {
      entry: unknownEntry('empty-or-unresolvable-cds'),
      spliced,
      startCodonGenomic: [],
      stopCodonGenomic: [],
      spliceSiteGenomic: [],
      codingBasesInSelection: 0,
      intronicBasesInSelection: 0,
    };
  }

  const codonStartOffset = built.codonStartOffset;

  let codingBasesInSelection = 0;
  let minCodingIndex = Number.POSITIVE_INFINITY;
  for (let ci = 0; ci < map.length; ci++) {
    if (isPositionInRange(map[ci], sel0, seqLen)) {
      codingBasesInSelection++;
      if (ci < minCodingIndex) minCodingIndex = ci;
    }
  }

  let intronicBasesInSelection = 0;
  const spliceSiteGenomic: number[] = [];
  for (const intron of built.introns) {
    intronicBasesInSelection += countGenomicSpanInSelection(
      intron.genomicStart,
      intron.genomicEnd,
      sel0,
      seqLen
    );
    spliceSiteGenomic.push(
      intron.genomicStart,
      positiveModulo(intron.genomicStart + 1, seqLen),
      positiveModulo(intron.genomicEnd - 1 + seqLen, seqLen),
      intron.genomicEnd
    );
  }

  const startCodonGenomic = map.slice(codonStartOffset, codonStartOffset + 3);
  const stopCodonGenomic = map.slice(Math.max(0, map.length - 3));

  if (codingBasesInSelection === 0) {
    const reason =
      intronicBasesInSelection > 0 ? 'selection-intronic-only' : 'no-coding-bases-in-selection';
    return {
      entry: unknownEntry(reason, 0, intronicBasesInSelection),
      spliced,
      startCodonGenomic,
      stopCodonGenomic,
      spliceSiteGenomic,
      codingBasesInSelection: 0,
      intronicBasesInSelection,
    };
  }

  const phase = positiveModulo(minCodingIndex - codonStartOffset, 3) as 0 | 1 | 2;
  const lengthIsCodonMultiple = codingBasesInSelection % 3 === 0;

  const entry: ReadingFrameEntry = {
    cds: cdsLabel,
    strand,
    phase,
    startCodonAligned: phase === 0,
    lengthIsCodonMultiple,
    frameshiftIfDeleted: !lengthIsCodonMultiple,
    translTable,
    reason: built.translationMismatch ? 'stored-translation-mismatch' : null,
    codingBasesInSelection,
    intronicBasesInSelection,
  };

  return {
    entry,
    spliced,
    startCodonGenomic,
    stopCodonGenomic,
    spliceSiteGenomic,
    codingBasesInSelection,
    intronicBasesInSelection,
  };
}

function partiallyInSelection(positions: number[], sel0: SelectionRange, seqLen: number): boolean {
  if (positions.length === 0) return false;
  let inCount = 0;
  for (const p of positions) if (isPositionInRange(p, sel0, seqLen)) inCount++;
  return inCount > 0 && inCount < positions.length;
}

function computeBoundaryFlags(
  overlapTuples: OverlapTuple[],
  cdsAnalyses: CdsAnalysis[],
  sel0: SelectionRange,
  seqLen: number
): BoundaryFlags {
  const spansOrigin = sel0.wraps === true;
  const spansFeatureBoundary = overlapTuples.some(
    (t) =>
      t.feature.relation === 'partial-overlap' ||
      t.feature.relation === 'selection-contains-feature'
  );

  let crossesStartCodon = false;
  let crossesStopCodon = false;
  let crossesExonIntronBoundary = false;
  let touchesSpliceSite = false;

  for (const a of cdsAnalyses) {
    if (partiallyInSelection(a.startCodonGenomic, sel0, seqLen)) crossesStartCodon = true;
    if (partiallyInSelection(a.stopCodonGenomic, sel0, seqLen)) crossesStopCodon = true;
    if (a.spliced && a.codingBasesInSelection > 0 && a.intronicBasesInSelection > 0) {
      crossesExonIntronBoundary = true;
    }
    if (a.spliced && a.spliceSiteGenomic.some((p) => isPositionInRange(p, sel0, seqLen))) {
      touchesSpliceSite = true;
    }
  }

  return {
    spansFeatureBoundary,
    crossesStartCodon,
    crossesStopCodon,
    spansOrigin,
    crossesExonIntronBoundary,
    touchesSpliceSite,
  };
}

function gcPercent(bases: string): number | null {
  let gc = 0;
  let acgt = 0;
  for (let i = 0; i < bases.length; i++) {
    const c = bases.charCodeAt(i) | 0x20;
    if (c === 0x67 || c === 0x63) {
      gc++;
      acgt++;
    } else if (c === 0x61 || c === 0x74 || c === 0x75) {
      acgt++;
    }
  }
  if (acgt === 0) return null;
  return Math.round((gc / acgt) * 1000) / 10;
}

const GC_NOTE =
  'Aggregate GC over the whole selection — NON-SUBSTITUTABLE: not a per-feature or per-window value. Use selection_gc_profile for windows.';

function buildRawFallback(
  range1: { start: number; end: number; wraps?: boolean },
  selLength: number,
  refId?: string
): RawFallback {
  const start = range1.start;
  const wraps = range1.wraps ?? range1.start > range1.end;
  const cappedWindow = !wraps ? Math.min(range1.end, start + RAW_FALLBACK_CAP_BP) : range1.end;
  const capped = selLength > RAW_FALLBACK_CAP_BP;
  const windowLength = wraps ? selLength : cappedWindow - start + 1;
  return {
    tool: 'get_selection_bases',
    refId,
    start,
    end: cappedWindow,
    wraps,
    capBp: RAW_FALLBACK_CAP_BP,
    capped,
    approxTokens: Math.min(windowLength, RAW_FALLBACK_CAP_BP),
    note: 'Last resort. Prefer a compute tool.',
  };
}

export function buildSequenceRegionDescriptor(
  input: SequenceDescriptorInput & { range: { start: number; end: number; wraps?: boolean } },
  sequence: AnnotatedSequence,
  sourceVersion: number
): SequenceRegionDescriptor {
  const range1 = input.range;
  const seqLen = sequence.length;
  const sel0 = to0IndexedRange(range1);
  const length = getSelectionLength(sel0, seqLen);
  const lengthModThree = positiveModulo(length, 3) as 0 | 1 | 2;
  const lengthIsCodonMultiple = lengthModThree === 0;
  const topology: 'circular' | 'linear' = sequence.circular ? 'circular' : 'linear';

  const annotations = sequence.annotations ?? [];
  const overlapTuples = scanOverlappingAnnotations(annotations, sel0, seqLen).map((ann) =>
    toOverlapTuple(ann, sel0, seqLen)
  );
  const cdsOverlaps = overlapTuples.filter((t) => isCds(t.ann)).map((t) => t.ann);

  const cdsAnalyses = cdsOverlaps.map((cds) => analyzeCds(cds, sequence.sequence, sel0, seqLen));
  const readingFrames = cdsAnalyses.map((a) => a.entry);

  const strand: RegionStrand =
    cdsOverlaps.length === 0
      ? 'unspecified'
      : cdsOverlaps.length > 1
        ? 'ambiguous-multiple'
        : directionToStrand(cdsOverlaps[0].direction);

  const { kept, histogram, landmarks } = capOverlappingFeatures(overlapTuples);
  const boundaryFlags = computeBoundaryFlags(overlapTuples, cdsAnalyses, sel0, seqLen);

  const gcComputed = length <= LARGE_REGION_BP;
  const gcPercentWholeSelection = gcComputed
    ? gcPercent(sliceBasesForRange(sequence.sequence, sel0))
    : null;
  const distinctTypes = new Set(overlapTuples.map((t) => t.feature.type.toLowerCase()));
  const gcSpansHeterogeneous = boundaryFlags.spansFeatureBoundary || distinctTypes.size > 1;

  const visibleOverlays = input.activeOverlays
    ? projectVisibleOverlays(input.activeOverlays, sel0, seqLen)
    : undefined;

  const disjointRegions =
    Array.isArray(input.regions) && input.regions.length >= 2 ? input.regions : null;

  const measured: SequenceRegionMeasured = {
    start: range1.start,
    end: range1.end,
    length,
    lengthIsCodonMultiple,
    lengthModThree,
    wraps: sel0.wraps === true,
    topology,
    parentLength: seqLen,
    strand,
    gcPercentWholeSelection,
    gcComputed,
    gcSpansHeterogeneous,
    gcNote: GC_NOTE,
    overlappingFeatures: kept,
    featureHistogram: histogram,
    landmarks,
    readingFrames,
    boundaryFlags,
    restrictionSitesComputed: false,
    motifsComputed: false,
    ...(visibleOverlays ? { visibleOverlays } : {}),
    ...(disjointRegions
      ? { disjoint: true, regionCount: disjointRegions.length, regions: disjointRegions }
      : {}),
  };

  const fileText = buildRegionFileText(cdsOverlaps);

  const label = `${displaySequenceName(sequence, input.documentId)} ${range1.start}–${range1.end} (${length} bp)`;

  return {
    schemaVersion: 2,
    kind: 'sequence_region',
    label,
    locator: { documentId: input.documentId },
    coordinateSystem: '1-indexed-inclusive',
    sourceVersion,
    measured,
    fileText,
    bases: 'not_included',
    fetch: {
      tools: [...REGION_COMPUTE_TOOLS],
      rawFallback: buildRawFallback(range1, length),
    },
  };
}

function buildRegionFileText(cdsOverlaps: Annotation[]): FileTextMap {
  const fileText: FileTextMap = {};
  const multi = cdsOverlaps.length > 1;
  cdsOverlaps.slice(0, 5).forEach((cds, i) => {
    const suffix = multi ? `_${i + 1}` : '';
    const product = untrustedField(cds.qualifiers?.product?.[0], PRODUCT_CAP);
    if (product) fileText[`product${suffix}`] = product;
    const gene = untrustedField(cds.qualifiers?.gene?.[0], NAME_CAP);
    if (gene) fileText[`gene${suffix}`] = gene;
  });
  return fileText;
}
