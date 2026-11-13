import { reverseComplement } from '@waypoint/sequence-utils';
import type { DesignAnnotation, DesignRegion, RestrictionDigestEnd } from './types';

function isFileLikeSourceId(sourceId: string): boolean {
  return sourceId.startsWith('/') || /^[A-Za-z]:[\\/]/.test(sourceId);
}

export function canReverseComplementDesignRegion(region: DesignRegion): boolean {
  if (region.isPlaceholder || region.sequence.length === 0) return false;
  return typeof region.sourceSequence === 'string' || !isFileLikeSourceId(region.sourceSequenceId);
}

export function reverseComplementDesignRegion(region: DesignRegion): DesignRegion | null {
  if (!canReverseComplementDesignRegion(region)) return null;

  const hasFullSource = typeof region.sourceSequence === 'string';
  const sourceSequence = hasFullSource ? region.sourceSequence! : region.sequence;
  const sourceLength = sourceSequence.length;
  const orientedSequence = reverseComplement(region.sequence);
  const orientedSourceSequence = reverseComplement(sourceSequence);
  const sourceStart = hasFullSource
    ? mirrorBoundary(region.sourceEnd, sourceLength, Boolean(region.sourceIsCircular))
    : 0;
  const sourceEnd = hasFullSource
    ? mirrorBoundary(region.sourceStart, sourceLength, Boolean(region.sourceIsCircular))
    : orientedSequence.length;

  return {
    ...region,
    sequence: orientedSequence,
    sourceSequence: orientedSourceSequence,
    sourceLength,
    sourceStart,
    sourceEnd,
    annotations: reverseAnnotations(region.annotations, region.sequence.length),
    sourceAnnotations: region.sourceAnnotations
      ? reverseAnnotations(region.sourceAnnotations, sourceLength)
      : undefined,
    rdOverhangs: region.rdOverhangs
      ? {
          upstream: reverseComplement(region.rdOverhangs.downstream),
          downstream: reverseComplement(region.rdOverhangs.upstream),
        }
      : undefined,
    rdEnds: region.rdEnds
      ? {
          upstream: reverseRestrictionDigestEnd(
            region.rdEnds.downstream,
            sourceLength,
            Boolean(region.sourceIsCircular)
          ),
          downstream: reverseRestrictionDigestEnd(
            region.rdEnds.upstream,
            sourceLength,
            Boolean(region.sourceIsCircular)
          ),
        }
      : undefined,
    rdSiblingOverhangs: region.rdSiblingOverhangs?.map((overhang) => reverseComplement(overhang)),
  };
}

function reverseAnnotations(
  annotations: readonly DesignAnnotation[],
  sequenceLength: number
): DesignAnnotation[] {
  return annotations
    .map((annotation) => ({
      ...annotation,
      start: sequenceLength - annotation.end,
      end: sequenceLength - annotation.start,
      strand:
        annotation.strand === 'forward'
          ? ('reverse' as const)
          : annotation.strand === 'reverse'
            ? ('forward' as const)
            : ('none' as const),
    }))
    .sort((left, right) => {
      if (left.start !== right.start) return left.start - right.start;
      if (left.end !== right.end) return left.end - right.end;
      return left.name.localeCompare(right.name);
    });
}

function reverseRestrictionDigestEnd(
  end: RestrictionDigestEnd | undefined,
  sourceLength: number,
  circular: boolean
): RestrictionDigestEnd | undefined {
  if (!end) return undefined;
  const hasRecognitionRange =
    typeof end.recognitionStart === 'number' && typeof end.recognitionEnd === 'number';

  return {
    ...end,
    overhang: end.overhang ? reverseComplement(end.overhang) : undefined,
    recognitionSequence: end.recognitionSequence
      ? reverseComplement(end.recognitionSequence)
      : undefined,
    recognitionStart: hasRecognitionRange
      ? mirrorBoundary(end.recognitionEnd!, sourceLength, circular)
      : undefined,
    recognitionEnd: hasRecognitionRange
      ? mirrorBoundary(end.recognitionStart!, sourceLength, circular)
      : undefined,
    cutPositionTop:
      typeof end.cutPositionBottom === 'number'
        ? mirrorBoundary(end.cutPositionBottom, sourceLength, circular)
        : undefined,
    cutPositionBottom:
      typeof end.cutPositionTop === 'number'
        ? mirrorBoundary(end.cutPositionTop, sourceLength, circular)
        : undefined,
    strand: end.strand === 'forward' ? 'reverse' : end.strand === 'reverse' ? 'forward' : undefined,
    retainedScarSequence: end.retainedScarSequence
      ? reverseComplement(end.retainedScarSequence)
      : undefined,
  };
}

function mirrorBoundary(value: number, sequenceLength: number, circular: boolean): number {
  const mirrored = sequenceLength - value;
  if (!circular || sequenceLength === 0) return mirrored;
  if (mirrored >= 0 && mirrored <= sequenceLength) return mirrored;
  return ((mirrored % sequenceLength) + sequenceLength) % sequenceLength;
}
