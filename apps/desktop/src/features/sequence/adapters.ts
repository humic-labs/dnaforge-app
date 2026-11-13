import type { Annotation, AnnotatedSequence, AnnotationColorMode } from '@waypoint/sequence-utils';
import {
  getFeatureColor,
  resolveAnnotationDisplayColor,
  resolveFeaturesByName,
  nucleicAcidOf,
  resolveSequenceGeneticCode,
} from '@waypoint/sequence-utils';
import type { ParsedPlasmid, PlasmidFeature, Primer } from '@waypoint/plasmid-viewer';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { AnnotationData } from './types';

function strandToDirection(strand: 'forward' | 'reverse' | 'none'): 1 | -1 | 0 {
  switch (strand) {
    case 'forward':
      return 1;
    case 'reverse':
      return -1;
    default:
      return 0;
  }
}

function directionToStrand(direction: 1 | -1 | 0): 'forward' | 'reverse' | 'none' {
  switch (direction) {
    case 1:
      return 'forward';
    case -1:
      return 'reverse';
    default:
      return 'none';
  }
}

function annotationToPlasmidFeature(ann: Annotation): PlasmidFeature {
  const strand = directionToStrand(ann.direction);

  const isDraft = ann.qualifiers?.source?.[0] === 'pLannotate-draft';
  const isAccepted = ann.qualifiers?.status?.[0] === 'accepted';

  const outlineOnly = isDraft && !isAccepted;

  const feature: PlasmidFeature = {
    sourceId: ann.sourceId,
    canonicalIdentity: ann.canonicalIdentity,
    type: ann.type,
    displayName: ann.name,
    start: ann.start,
    end: ann.end,
    direction: strand,
    color: ann.color ?? getFeatureColor(ann.type),
    qualifiers: ann.qualifiers ?? {},
    outlineOnly,
  };
  if (ann.segments && ann.segments.length > 1) {
    feature.segments = ann.segments;
  }
  return feature;
}

export function annotatedSequenceToParsedPlasmid(
  sequence: AnnotatedSequence,
  primerDisplays?: PrimerDisplay[]
): ParsedPlasmid {
  return {
    name: sequence.name,
    sequence: sequence.sequence,
    length: sequence.length,
    circular: sequence.circular ?? false,

    geneticCode: resolveSequenceGeneticCode(sequence).code,
    geneticCodeBasis: resolveSequenceGeneticCode(sequence).basis,
    nucleicAcid: nucleicAcidOf(sequence),
    features: sequence.annotations.map(annotationToPlasmidFeature),
    primers: primerDisplays
      ? primerDisplays.filter((p) => !p.isDraft && !p.isCandidate).map(primerDisplayToMinimapPrimer)
      : [],
  };
}

export function primerDisplayToMinimapPrimer(p: PrimerDisplay): Primer {
  return {
    id: p.id,
    sourcePrimerId: p.sourcePrimerId,
    name: p.name,
    start: p.start,
    end: p.end,
    direction: p.direction,
    bases: p.bases,
    modificationMarkers: p.modificationMarkers,
    tm: p.tm,
    gc: p.gc,
    mismatches: p.mismatches ?? [],
    hasExplicitSequence: true,
    overhangLength: p.overhangLength,
    pbsColor: p.pbsColor,
    overhangColor: p.overhangColor,
    cutPositionInOverhang: p.cutPositionInOverhang,
    enzymeName: p.enzymeName,
    suppressCutSiteRendering: p.suppressCutSiteRendering,
    recognitionStart: p.recognitionStart,
    recognitionEnd: p.recognitionEnd,
    scarAbsolutePosition: p.scarAbsolutePosition,
    cognate4bpLength: p.cognate4bpLength,
    synthetic4bpSpacerLength: p.synthetic4bpSpacerLength,
    spacerLength: p.spacerLength,
    junctionIndex: p.junctionIndex,
    isScarMarkerOnly: p.isScarMarkerOnly,
    ...(p.isDraft ? { isDraft: true } : {}),
    ...(p.isCandidate ? { isCandidate: true } : {}),
  };
}

export function withPrimerDisplaysForMinimap(
  plasmid: ParsedPlasmid,
  primerDisplays?: PrimerDisplay[]
): ParsedPlasmid {
  if (!primerDisplays) return plasmid;
  return {
    ...plasmid,
    primers: primerDisplays.map(primerDisplayToMinimapPrimer),
  };
}

export function withAnnotationDisplayColorsForMinimap(
  plasmid: ParsedPlasmid,
  annotationColorMode: AnnotationColorMode
): ParsedPlasmid {
  return {
    ...plasmid,
    features: plasmid.features.map((feature) => ({
      ...feature,
      color: resolveAnnotationDisplayColor(
        { type: feature.type, color: feature.color },
        { profile: { colorMode: annotationColorMode } }
      ),
    })),
  };
}

export function annotationDataToAnnotation(
  data: AnnotationData & { segments?: Array<{ start: number; end: number }> }
): Annotation {
  const annotation: Annotation = {
    name: data.name,
    type: data.type,
    start: data.start,
    end: data.end,
    direction: strandToDirection(data.strand),
    color: data.color ?? getFeatureColor(data.type),
    qualifiers: data.qualifiers,
  };
  if (data.segments && data.segments.length > 1) {
    annotation.segments = data.segments;
  }
  return annotation;
}

export function findCDSAtPosition(
  annotations: Annotation[],
  position0: number | null,
  hitAnnotation: Annotation | null,
  highlightedRange?: { start: number; end: number } | null
): Annotation | null {
  if (hitAnnotation?.type === 'CDS') return hitAnnotation;

  if (position0 !== null) {
    const pos1 = position0 + 1;
    const found = annotations.find((a) => a.type === 'CDS' && pos1 >= a.start && pos1 <= a.end);
    if (found) return found;
  }

  if (highlightedRange) {
    const selStart1 = highlightedRange.start + 1;
    const selEnd1 = highlightedRange.end + 1;
    const found = annotations.find(
      (a) => a.type === 'CDS' && a.start === selStart1 && a.end === selEnd1
    );
    if (found) return found;

    const midPos1 = Math.floor((selStart1 + selEnd1) / 2);
    return (
      annotations.find((a) => a.type === 'CDS' && midPos1 >= a.start && midPos1 <= a.end) ?? null
    );
  }
  return null;
}

export function findStructureAnnotationAtPosition(
  annotations: Annotation[],
  position0: number | null,
  hitAnnotation: Annotation | null,
  highlightedRange?: { start: number; end: number } | null
): Annotation | null {
  if (hitAnnotation && isStructureAnnotationType(hitAnnotation.type)) return hitAnnotation;
  if (position0 !== null) {
    const pos1 = position0 + 1;
    const found = annotations.find(
      (annotation) =>
        isStructureAnnotationType(annotation.type) &&
        pos1 >= annotation.start &&
        pos1 <= annotation.end
    );
    if (found) return found;
  }
  if (highlightedRange) {
    const selStart1 = highlightedRange.start + 1;
    const selEnd1 = highlightedRange.end + 1;
    const exact = annotations.find(
      (annotation) =>
        isStructureAnnotationType(annotation.type) &&
        annotation.start === selStart1 &&
        annotation.end === selEnd1
    );
    if (exact) return exact;
    const midPos1 = Math.floor((selStart1 + selEnd1) / 2);
    return (
      annotations.find(
        (annotation) =>
          isStructureAnnotationType(annotation.type) &&
          midPos1 >= annotation.start &&
          midPos1 <= annotation.end
      ) ?? null
    );
  }
  return null;
}

export function findStructureAnnotationByLabel(
  annotations: Annotation[],
  labelToken: string
): Annotation | null {
  const matches = resolveFeaturesByName(annotations, labelToken, {
    filter: (annotation) => isStructureAnnotationType(annotation.type),
  });
  return matches[0]?.feature ?? null;
}

export function isStructureAnnotationType(type: string): boolean {
  const normalized = type.toLowerCase();
  return (
    normalized === 'cds' ||
    normalized === 'rrna' ||
    normalized === 'trna' ||
    normalized === 'ncrna' ||
    normalized === 'tmrna' ||
    normalized === 'mrna' ||
    normalized === 'misc_rna' ||
    normalized === 'antisense_rna' ||
    normalized === 'snrna' ||
    normalized === 'snorna' ||
    normalized.endsWith('_rna')
  );
}

export function structureViewDisabledReason(
  annotation: Annotation | null | undefined,
  sequenceLength: number
): 'missing_feature' | 'unsupported_feature' | 'missing_direction' | 'too_short' | null {
  if (!annotation) return 'missing_feature';
  if (!isStructureAnnotationType(annotation.type)) return 'unsupported_feature';
  const span =
    annotation.end >= annotation.start
      ? annotation.end - annotation.start + 1
      : sequenceLength - annotation.start + 1 + annotation.end;
  if (annotation.type.toLowerCase() === 'cds') {
    if (annotation.direction !== 1 && annotation.direction !== -1) return 'missing_direction';
    return span < 3 ? 'too_short' : null;
  }
  return span < 25 ? 'too_short' : null;
}
