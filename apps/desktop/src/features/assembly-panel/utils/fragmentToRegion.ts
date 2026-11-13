import type { VirtualDigestFragment } from '../hooks/useVirtualDigest';
import type { DesignRegion, DesignAnnotation } from '../../design/public/types';
import { canonicalGoldenGateEnzymeName, type Annotation } from '@waypoint/sequence-utils';

export interface FragmentToRegionParams {
  fragment: VirtualDigestFragment;
  sourceSequence: string;
  sourceSequenceId: string;
  sourceSequenceName: string;
  overhangLength: number;
  enzymeName?: string;
  sourceAnnotations?: Array<{
    name: string;
    type: string;
    start: number;
    end: number;
    strand: 'forward' | 'reverse' | 'none';
    color?: string;
  }>;
  sourceIsCircular?: boolean;
  allFragments?: VirtualDigestFragment[];
}

export function sourceAnnotationsToDesignAnnotations(
  annotations: readonly Annotation[] = []
): DesignAnnotation[] {
  return annotations.map((annotation) => ({
    name: annotation.name,
    type: annotation.type,
    start: Math.max(0, annotation.start - 1),
    end: annotation.end,
    strand:
      annotation.direction === 1 ? 'forward' : annotation.direction === -1 ? 'reverse' : 'none',
    color: annotation.color,
  }));
}

export function extractFragmentSequence(
  sourceSequence: string,
  fragment: VirtualDigestFragment,
  _overhangLength: number
): string {
  const seqLength = sourceSequence.length;
  if (seqLength === 0 || fragment.length <= 0) return '';

  const start = normalizeIndex(fragment.startPosition, seqLength);
  const length = Math.min(fragment.length, seqLength);
  const end = start + length;

  if (end <= seqLength) {
    return sourceSequence.slice(start, end);
  }

  return sourceSequence.slice(start) + sourceSequence.slice(0, end % seqLength);
}

export function extractFragmentAnnotations(
  fragment: VirtualDigestFragment,
  sourceLength: number,
  sourceAnnotations?: FragmentToRegionParams['sourceAnnotations']
): DesignAnnotation[] {
  if (!sourceAnnotations || sourceAnnotations.length === 0) return [];
  if (sourceLength <= 0 || fragment.length <= 0) return [];

  const annotations: DesignAnnotation[] = [];
  for (const ann of sourceAnnotations) {
    const intervals = mapAnnotationIntervalToFragment({
      annotationStart: ann.start,
      annotationEnd: ann.end,
      fragmentStart: fragment.startPosition,
      fragmentLength: fragment.length,
      sourceLength,
    });
    for (const interval of intervals) {
      annotations.push({
        name: ann.name,
        type: ann.type,
        start: interval.start,
        end: interval.end,
        strand: ann.strand,
        color: ann.color,
      });
    }
  }

  return annotations;
}

function computeSiblingOverhangs(
  fragment: VirtualDigestFragment,
  allFragments?: VirtualDigestFragment[]
): string[] | undefined {
  if (!allFragments || allFragments.length <= 1) {
    return undefined;
  }

  const siblingOverhangs = new Set<string>();

  for (const other of allFragments) {
    if (other.index === fragment.index) continue;

    siblingOverhangs.add(other.upstream.sequence.toUpperCase());
    siblingOverhangs.add(other.downstream.sequence.toUpperCase());
  }

  return siblingOverhangs.size > 0 ? Array.from(siblingOverhangs) : undefined;
}

export function fragmentToRegion(params: FragmentToRegionParams): Omit<DesignRegion, 'id'> {
  const {
    fragment,
    sourceSequence,
    sourceSequenceId,
    sourceSequenceName,
    overhangLength,
    enzymeName,
    sourceAnnotations,
    sourceIsCircular = true,
    allFragments,
  } = params;

  const sequence = extractFragmentSequence(sourceSequence, fragment, overhangLength);

  const annotations = extractFragmentAnnotations(
    fragment,
    sourceSequence.length,
    sourceAnnotations
  );

  const rdSiblingOverhangs = computeSiblingOverhangs(fragment, allFragments);
  const rdSourceEnzyme = canonicalGoldenGateEnzymeName(enzymeName);
  const rdSourceEnzymeName =
    enzymeName ??
    Array.from(
      new Set(
        [
          fragment.upstream.enzymeName,
          fragment.downstream.enzymeName,
          ...fragment.upstream.enzymeNames,
          ...fragment.downstream.enzymeNames,
        ].filter(Boolean)
      )
    ).join(' + ');

  const region: Omit<DesignRegion, 'id'> = {
    sourceSequenceId,
    sourceSequenceName: `${sourceSequenceName} (${
      rdSourceEnzymeName ? `${rdSourceEnzymeName} fragment` : 'fragment'
    } ${fragment.index + 1})`,
    sourceStart: fragment.startPosition,
    sourceEnd: fragment.wrapsOrigin
      ? fragment.startPosition + fragment.length
      : fragment.endPosition,
    sequence,
    annotations,
    sourceSequence,
    sourceLength: sourceSequence.length,
    sourceAnnotations,
    sourceIsCircular,
    sourceType: 'rd',
    ggType: fragment.ggType,
    rdOverhangs: {
      upstream: fragment.upstream.sequence,
      downstream: fragment.downstream.sequence,
    },
    rdSourceEnzyme,
    rdSourceEnzymeName,
    rdEnds: {
      upstream: fragment.upstream.rdEnd,
      downstream: fragment.downstream.rdEnd,
    },
  };

  if (rdSiblingOverhangs) {
    region.rdSiblingOverhangs = rdSiblingOverhangs;
  }

  return region;
}

function mapAnnotationIntervalToFragment(input: {
  annotationStart: number;
  annotationEnd: number;
  fragmentStart: number;
  fragmentLength: number;
  sourceLength: number;
}): Array<{ start: number; end: number }> {
  const length = input.sourceLength;
  const fragmentLength = input.fragmentLength;
  if (length <= 0 || fragmentLength <= 0) return [];

  const pieces: Array<{ start: number; end: number }> = [];
  for (const arc of annotationSourceArcs(input.annotationStart, input.annotationEnd, length)) {
    const relStart = normalizeIndex(arc.start - input.fragmentStart, length);
    const arcLength = Math.min(arc.end - arc.start, length);
    addClippedPiece(pieces, relStart, relStart + arcLength, fragmentLength);
    addClippedPiece(pieces, relStart - length, relStart + arcLength - length, fragmentLength);
  }

  return mergeIntervals(pieces);
}

function annotationSourceArcs(
  start: number,
  end: number,
  length: number
): Array<{ start: number; end: number }> {
  if (end > start) {
    return [{ start, end: Math.min(end, start + length) }];
  }
  if (end < start) {
    const arcs: Array<{ start: number; end: number }> = [];
    if (start < length) arcs.push({ start, end: length });
    if (end > 0) arcs.push({ start: 0, end });
    return arcs;
  }
  return [];
}

function addClippedPiece(
  pieces: Array<{ start: number; end: number }>,
  lo: number,
  hi: number,
  fragmentLength: number
): void {
  const start = Math.max(0, lo);
  const end = Math.min(fragmentLength, hi);
  if (end > start) pieces.push({ start, end });
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  if (intervals.length <= 1) return intervals;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function normalizeIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}
