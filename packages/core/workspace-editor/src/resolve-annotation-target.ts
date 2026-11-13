import { findIntronAtPosition } from './hit-detection';
import type { AnnotationStateIdentity } from './annotation-render-state';

interface AnnotationLike {
  type: string;
  name: string;
  start: number;
  end: number;
  direction?: number;
  segments?: { start: number; end: number }[];
  qualifiers?: { _locationString?: string[] };
}

function isSplicedLike(cds: AnnotationLike): boolean {
  if (!cds.segments || cds.segments.length < 2) return false;
  const locStr = cds.qualifiers?._locationString?.[0] ?? '';
  return /join\s*\(/i.test(locStr);
}

export interface ResolveAnnotationTargetInput {
  annotationHit: AnnotationLike | null;

  parentCdsForCodon: AnnotationLike | null;

  classifiedCDSs: readonly AnnotationLike[];

  position: number | null;

  showAnnotations: boolean;

  showTranslation: boolean;
}

export function resolveAnnotationTarget(
  input: ResolveAnnotationTargetInput
): AnnotationStateIdentity | null {
  const {
    annotationHit,
    parentCdsForCodon,
    classifiedCDSs,
    position,
    showAnnotations,
    showTranslation,
  } = input;

  if (showAnnotations && annotationHit) {
    return identityFrom(annotationHit);
  }

  if (parentCdsForCodon) {
    return identityFrom(parentCdsForCodon);
  }

  if (position !== null && showTranslation) {
    for (const cds of classifiedCDSs) {
      if (!isSplicedLike(cds)) continue;
      if (cds.segments && findIntronAtPosition(position, cds.segments)) {
        return identityFrom(cds);
      }
    }
  }

  return null;
}

function identityFrom(ann: AnnotationLike): AnnotationStateIdentity {
  return {
    type: ann.type,
    name: ann.name,
    start: ann.start,
    end: ann.end,
    direction: ann.direction,
    ...(ann.segments ? { segments: ann.segments } : {}),
  };
}
