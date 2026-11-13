import type {
  AssemblyMethod,
  DesignAnnotation,
  DesignRegion,
  DesignPrimerPair,
  DesignSpacer,
  RestrictionDigestEnd,
  RestrictionDigestOverhangType,
  SequenceDesign,
} from './types';
import { getComposedSequence } from './types';

export const NEBUILDER_MAX_RD_RESECTION = 10;

export interface RestrictionDigestCutSiteLike {
  recognitionStart: number;
  recognitionEnd: number;
  cutPositionTop: number;
  cutPositionBottom: number;
  strand: 'forward' | 'reverse';
}

export interface RestrictionDigestEnzymeLike {
  recognition_sequence: string;
  overhang_type?: RestrictionDigestOverhangType | null;
}

export interface VisibleRestrictionDigestScarSegment {
  end: 'upstream' | 'downstream';
  retainedSequence: string;
  sequence: string;
  rawStart: number;
  rawEnd: number;
  effectiveStart: number;
  effectiveEnd: number;
  sourceStart: number;
  sourceEnd: number;
  trimmedBases: number;
}

export function isRestrictionDigestRegion(region: DesignRegion | undefined): boolean {
  return !!region && !region.isPlaceholder && (region.sourceType === 'rd' || !!region.rdOverhangs);
}

export function isPcrTemplateRegion(region: DesignRegion | undefined): boolean {
  return (
    !!region &&
    !region.isPlaceholder &&
    region.sequence.length > 0 &&
    !isRestrictionDigestRegion(region)
  );
}

export function selectPhysicalDesignPrimerPairs(design: SequenceDesign): DesignPrimerPair[] {
  return design.designPrimers.filter(
    (pair) =>
      isPcrTemplateRegion(design.regions[pair.fragmentIndex]) &&
      (pair.forward.sequence.length > 0 || pair.reverse.sequence.length > 0)
  );
}

export function isHomologyAssemblyMethod(method: AssemblyMethod): boolean {
  return method === 'gibson' || method === 'nebuilder';
}

export function clampNebuilderResection(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(NEBUILDER_MAX_RD_RESECTION, Math.floor(value)));
}

export function createRestrictionDigestEnd(
  sequence: string,
  cutSite: RestrictionDigestCutSiteLike,
  enzyme: RestrictionDigestEnzymeLike,
  end: 'upstream' | 'downstream',
  overhang?: string
): RestrictionDigestEnd {
  const recognitionStart = normalizeIndex(cutSite.recognitionStart, sequence.length);
  const recognitionEnd = normalizeIndex(cutSite.recognitionEnd, sequence.length);
  const cutTop = normalizeIndex(cutSite.cutPositionTop, sequence.length);
  const retainedScarSequence = extractRetainedScarSequence(
    sequence,
    recognitionStart,
    recognitionEnd,
    cutTop,
    end
  );

  return {
    overhang,
    overhangType: enzyme.overhang_type ?? undefined,
    recognitionSequence: enzyme.recognition_sequence,
    recognitionStart,
    recognitionEnd,
    cutPositionTop: cutTop,
    cutPositionBottom: normalizeIndex(cutSite.cutPositionBottom, sequence.length),
    strand: cutSite.strand,
    retainedScarSequence,
    retainedScarLength: retainedScarSequence.length,
    nebuilderResectionBases: 0,
  };
}

export function getRegionEffectiveSequence(
  region: DesignRegion,
  assemblyMethod: AssemblyMethod
): string {
  if (!isHomologyAssemblyMethod(assemblyMethod) || !isRestrictionDigestRegion(region)) {
    return region.sequence;
  }

  const upstreamTrim = getRegionEndTrim(region, assemblyMethod, 'upstream');
  const downstreamTrim = getRegionEndTrim(region, assemblyMethod, 'downstream');

  if (upstreamTrim === 0 && downstreamTrim === 0) {
    return region.sequence;
  }

  const safeUpstreamTrim = Math.min(upstreamTrim, region.sequence.length);
  const safeDownstreamTrim = Math.min(
    downstreamTrim,
    Math.max(0, region.sequence.length - safeUpstreamTrim)
  );

  return region.sequence.slice(safeUpstreamTrim, region.sequence.length - safeDownstreamTrim);
}

export function getEffectiveDesignRegions(design: SequenceDesign): DesignRegion[] {
  if (!isHomologyAssemblyMethod(design.assemblyMethod)) {
    return design.regions;
  }

  return design.regions.map((region) => getEffectiveRegion(region, design.assemblyMethod));
}

export function getComposedSequenceForDesign(design: SequenceDesign): string {
  return getComposedSequence(getEffectiveDesignRegions(design), design.spacers);
}

export function getComposedSequenceForMethod(
  regions: DesignRegion[],
  spacers: DesignSpacer[] = [],
  assemblyMethod: AssemblyMethod
): string {
  if (!isHomologyAssemblyMethod(assemblyMethod)) {
    return getComposedSequence(regions, spacers);
  }
  return getComposedSequence(
    regions.map((region) => getEffectiveRegion(region, assemblyMethod)),
    spacers
  );
}

function getEffectiveRegion(region: DesignRegion, assemblyMethod: AssemblyMethod): DesignRegion {
  const sequence = getRegionEffectiveSequence(region, assemblyMethod);
  if (sequence === region.sequence) {
    return region;
  }

  const upstreamTrim = getRegionEndTrim(region, assemblyMethod, 'upstream');
  const downstreamTrim = getRegionEndTrim(region, assemblyMethod, 'downstream');
  const safeUpstreamTrim = Math.min(upstreamTrim, region.sequence.length);
  const safeDownstreamTrim = Math.min(
    downstreamTrim,
    Math.max(0, region.sequence.length - safeUpstreamTrim)
  );

  return {
    ...region,
    sequence,
    sourceStart: region.sourceStart + safeUpstreamTrim,
    sourceEnd: region.sourceEnd - safeDownstreamTrim,
    annotations: trimAnnotations(
      region.annotations,
      safeUpstreamTrim,
      region.sequence.length - safeDownstreamTrim
    ),
  };
}

export function getVisibleRestrictionDigestScarSegments(
  region: DesignRegion,
  assemblyMethod: AssemblyMethod
): VisibleRestrictionDigestScarSegment[] {
  if (!isHomologyAssemblyMethod(assemblyMethod) || !isRestrictionDigestRegion(region)) {
    return [];
  }

  const upstreamTrim = getRegionEndTrim(region, assemblyMethod, 'upstream');
  const downstreamTrim = getRegionEndTrim(region, assemblyMethod, 'downstream');
  const keptStart = Math.min(Math.max(0, upstreamTrim), region.sequence.length);
  const keptEnd = Math.max(
    keptStart,
    region.sequence.length -
      Math.min(Math.max(0, downstreamTrim), Math.max(0, region.sequence.length - keptStart))
  );

  return (['upstream', 'downstream'] as const).flatMap((end) => {
    const rdEnd = region.rdEnds?.[end];
    const retainedSequence = (rdEnd?.retainedScarSequence ?? '').toUpperCase();
    const retainedLength = rdEnd?.retainedScarLength ?? retainedSequence.length;
    if (!retainedSequence || retainedLength <= 0) return [];

    const rawStart = end === 'upstream' ? 0 : Math.max(0, region.sequence.length - retainedLength);
    const rawEnd =
      end === 'upstream'
        ? Math.min(retainedLength, region.sequence.length)
        : region.sequence.length;
    const visibleStart = Math.max(rawStart, keptStart);
    const visibleEnd = Math.min(rawEnd, keptEnd);
    if (visibleEnd <= visibleStart) return [];

    return [
      {
        end,
        retainedSequence,
        sequence: region.sequence.slice(visibleStart, visibleEnd).toUpperCase(),
        rawStart,
        rawEnd,
        effectiveStart: visibleStart - keptStart,
        effectiveEnd: visibleEnd - keptStart,
        sourceStart: region.sourceStart + visibleStart,
        sourceEnd: region.sourceStart + visibleEnd,
        trimmedBases: end === 'upstream' ? visibleStart - rawStart : rawEnd - visibleEnd,
      },
    ];
  });
}

function getRegionEndTrim(
  region: DesignRegion,
  assemblyMethod: AssemblyMethod,
  end: 'upstream' | 'downstream'
): number {
  const rdEnd = region.rdEnds?.[end];
  const automaticTrim = getGibsonAutomaticTrimBases(rdEnd, end);
  const nebuilderTrim =
    assemblyMethod === 'nebuilder' ? clampNebuilderResection(rdEnd?.nebuilderResectionBases) : 0;

  return Math.max(automaticTrim, nebuilderTrim);
}

function getGibsonAutomaticTrimBases(
  rdEnd: RestrictionDigestEnd | undefined,
  end: 'upstream' | 'downstream'
): number {
  if (!rdEnd || end !== 'upstream' || rdEnd.overhangType !== '5_prime') {
    return 0;
  }

  if (typeof rdEnd.retainedScarLength === 'number' && rdEnd.retainedScarLength > 0) {
    return rdEnd.retainedScarLength;
  }

  if (rdEnd.retainedScarSequence) {
    return rdEnd.retainedScarSequence.length;
  }

  return rdEnd.overhang?.length ?? 0;
}

function trimAnnotations(
  annotations: DesignAnnotation[],
  keptStart: number,
  keptEnd: number
): DesignAnnotation[] {
  return annotations.flatMap((annotation) => {
    const start = Math.max(annotation.start, keptStart);
    const end = Math.min(annotation.end, keptEnd);
    if (end <= start) return [];

    return {
      ...annotation,
      start: start - keptStart,
      end: end - keptStart,
    };
  });
}

function extractRetainedScarSequence(
  sequence: string,
  recognitionStart: number,
  recognitionEnd: number,
  cutTop: number,
  end: 'upstream' | 'downstream'
): string {
  if (sequence.length === 0) return '';

  if (recognitionStart <= recognitionEnd) {
    if (cutTop < recognitionStart || cutTop > recognitionEnd) {
      return '';
    }

    return end === 'downstream'
      ? sequence.slice(recognitionStart, cutTop).toUpperCase()
      : sequence.slice(cutTop, recognitionEnd).toUpperCase();
  }

  const siteSequence = sequence.slice(recognitionStart) + sequence.slice(0, recognitionEnd);
  const siteLength = siteSequence.length;
  const cutOffset =
    cutTop >= recognitionStart
      ? cutTop - recognitionStart
      : sequence.length - recognitionStart + cutTop;

  if (cutOffset < 0 || cutOffset > siteLength) {
    return '';
  }

  return end === 'downstream'
    ? siteSequence.slice(0, cutOffset).toUpperCase()
    : siteSequence.slice(cutOffset).toUpperCase();
}

function normalizeIndex(index: number, sequenceLength: number): number {
  if (sequenceLength <= 0) return 0;
  return ((index % sequenceLength) + sequenceLength) % sequenceLength;
}
