import type { Annotation, AnnotatedSequence } from '@waypoint/sequence-utils';

import { getSelectionLength } from '../../../../../../packages/core/workspace-editor/src/selection-model';
import { buildSplicedCodingSequence } from '../../../../../../packages/core/workspace-editor/src/translation/spliced-coding-sequence';

import { allowlistDbXref, untrustedField } from './sanitize';
import {
  RAW_FALLBACK_CAP_BP,
  REGION_COMPUTE_TOOLS,
  directionToStrand,
  displaySequenceName,
} from './sequence-region';
import type {
  AnnotationDescriptor,
  AnnotationMeasured,
  SequenceDescriptorInput,
  FileTextMap,
  NeighborFeature,
  RawFallback,
  SegmentSummary,
} from './types';

const NAME_CAP = 120;
const PRODUCT_CAP = 200;
const NOTE_CAP = 320;
const SEGMENT_HEAD = 3;
const SEGMENT_TAIL = 2;
const MAX_DB_XREFS = 8;

const TYPE_SPECIFICITY: Record<string, number> = {
  cds: 5,
  mrna: 4,
  gene: 3,
  promoter: 2,
  terminator: 2,
};

function specificity(type: string): number {
  return TYPE_SPECIFICITY[type.toLowerCase()] ?? 1;
}

function isCds(ann: Annotation): boolean {
  return ann.type.toUpperCase() === 'CDS';
}

function segmentLength(seg: { start: number; end: number }, seqLen: number): number {
  return seg.end >= seg.start ? seg.end - seg.start + 1 : seqLen - seg.start + 1 + seg.end;
}

export function resolveAnnotation(
  annotations: Annotation[],
  range: { start: number; end: number },
  _seqLen: number
): Annotation | null {
  const exact = annotations
    .filter((a) => a.start === range.start && a.end === range.end)
    .sort((a, b) => specificity(b.type) - specificity(a.type));
  if (exact.length > 0) return exact[0];

  let best: Annotation | null = null;
  let bestLen = Number.POSITIVE_INFINITY;
  for (const a of annotations) {
    const covers = a.start <= range.start && a.end >= range.end && a.start <= a.end;
    if (!covers) continue;
    const len = a.end - a.start + 1;
    if (len < bestLen) {
      bestLen = len;
      best = a;
    }
  }
  return best;
}

function buildSegmentSummary(ann: Annotation, seqLen: number): SegmentSummary | undefined {
  const segments = ann.segments;
  if (!segments || segments.length < 2) return undefined;
  const totalCodingBp = segments.reduce((sum, seg) => sum + segmentLength(seg, seqLen), 0);
  const first = segments.slice(0, SEGMENT_HEAD);
  const last =
    segments.length > SEGMENT_HEAD + SEGMENT_TAIL
      ? segments.slice(segments.length - SEGMENT_TAIL)
      : [];
  return {
    count: segments.length,
    first: first.map((s) => ({ start: s.start, end: s.end })),
    last: last.map((s) => ({ start: s.start, end: s.end })),
    totalCodingBp,
  };
}

function nearestNeighbors(
  annotations: Annotation[],
  target: Annotation
): { upstream: NeighborFeature | null; downstream: NeighborFeature | null } {
  let upstream: NeighborFeature | null = null;
  let downstream: NeighborFeature | null = null;
  let upstreamGap = Number.POSITIVE_INFINITY;
  let downstreamGap = Number.POSITIVE_INFINITY;

  for (const a of annotations) {
    if (a === target) continue;
    if (a.end < target.start) {
      const gap = target.start - a.end;
      if (gap < upstreamGap) {
        upstreamGap = gap;
        upstream = { type: a.type, name: neighborName(a), distanceBp: -gap };
      }
    } else if (a.start > target.end) {
      const gap = a.start - target.end;
      if (gap < downstreamGap) {
        downstreamGap = gap;
        downstream = { type: a.type, name: neighborName(a), distanceBp: gap };
      }
    }
  }
  return { upstream, downstream };
}

function neighborName(ann: Annotation): string {
  const raw = ann.name || ann.label || ann.qualifiers?.label?.[0] || ann.qualifiers?.gene?.[0];
  return untrustedField(raw, NAME_CAP)?.value ?? ann.type;
}

function parseTranslTable(cds: Annotation): number | 'unknown' {
  const raw = cds.qualifiers?.transl_table?.[0];
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'unknown';
}

function buildAnnotationFileText(ann: Annotation): FileTextMap {
  const fileText: FileTextMap = {};

  const featureName = untrustedField(ann.name || ann.label || ann.qualifiers?.label?.[0], NAME_CAP);
  if (featureName) fileText.featureName = featureName;

  const product = untrustedField(ann.qualifiers?.product?.[0], PRODUCT_CAP);
  if (product) fileText.product = product;

  const gene = untrustedField(ann.qualifiers?.gene?.[0], NAME_CAP);
  if (gene) fileText.gene = gene;

  const note = untrustedField(ann.qualifiers?.note?.[0], NOTE_CAP, { middleOut: true });
  if (note) fileText.note = note;

  const boundMoiety = untrustedField(ann.qualifiers?.bound_moiety?.[0], NAME_CAP);
  if (boundMoiety) fileText.boundMoiety = boundMoiety;

  const dbXrefs = (ann.qualifiers?.db_xref ?? [])
    .map((x) => allowlistDbXref(x))
    .filter((x): x is string => x !== null)
    .slice(0, MAX_DB_XREFS);
  if (dbXrefs.length > 0) {
    fileText.dbXref = { value: dbXrefs.join('; '), trust: 'untrusted-data' };
  }

  return fileText;
}

function buildFeatureRawFallback(ann: Annotation): RawFallback {
  const wraps = ann.start > ann.end;
  const cappedWindow = !wraps ? Math.min(ann.end, ann.start + RAW_FALLBACK_CAP_BP) : ann.end;
  const footprintLength = ann.end - ann.start + 1;
  const capped = !wraps && footprintLength > RAW_FALLBACK_CAP_BP;
  const windowLength = wraps ? footprintLength : cappedWindow - ann.start + 1;
  return {
    tool: 'get_selection_bases',
    start: ann.start,
    end: cappedWindow,
    wraps,
    capBp: RAW_FALLBACK_CAP_BP,
    capped,
    approxTokens: Math.min(Math.max(windowLength, 0), RAW_FALLBACK_CAP_BP),
    note: 'Last resort. Prefer a compute tool.',
  };
}

export function buildAnnotationDescriptor(
  input: SequenceDescriptorInput,
  sequence: AnnotatedSequence,
  sourceVersion: number
): AnnotationDescriptor | null {
  const seqLen = sequence.length;
  const annotations = sequence.annotations ?? [];
  const ann = input.range ? resolveAnnotation(annotations, input.range, seqLen) : null;
  if (!ann) return null;

  const strand = directionToStrand(ann.direction);
  const lengthBp = getSelectionLength(
    { start: ann.start - 1, end: ann.end - 1, wraps: ann.start > ann.end },
    seqLen
  );

  let proteinLengthAa: number | undefined;
  let translTable: number | 'unknown' | null = null;
  if (isCds(ann)) {
    proteinLengthAa = buildSplicedCodingSequence(ann, sequence.sequence).proteinLength;
    translTable = parseTranslTable(ann);
  }

  const measured: AnnotationMeasured = {
    featureType: ann.type,
    start: ann.start,
    end: ann.end,
    strand,
    segments: buildSegmentSummary(ann, seqLen),
    lengthBp,
    proteinLengthAa,
    translationAvailable: Boolean(ann.qualifiers?.translation?.[0]),
    neighbors: nearestNeighbors(annotations, ann),
    translTable,
  };

  const label = `${ann.type} ${neighborName(ann)} (${ann.start}–${ann.end}) on ${displaySequenceName(sequence, input.documentId)}`;

  return {
    schemaVersion: 2,
    kind: 'annotation',
    label,
    locator: { documentId: input.documentId },
    coordinateSystem: '1-indexed-inclusive',
    sourceVersion,
    measured,
    fileText: buildAnnotationFileText(ann),
    bases: 'not_included',
    fetch: {
      tools: [...REGION_COMPUTE_TOOLS],
      rawFallback: buildFeatureRawFallback(ann),
    },
  };
}
