import { resolveAnnotationTarget } from './resolve-annotation-target';
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

interface OrfLike {
  start: number;
  end: number;
  strand: '+' | '-';
}

export interface OrfIdentity {
  start: number;
  end: number;
  strand: '+' | '-';
}

export interface PointerSelectionInput {
  annotationHit: AnnotationLike | null;

  parentCdsForCodon: AnnotationLike | null;

  classifiedCDSs: readonly AnnotationLike[];

  position: number | null;

  showAnnotations: boolean;

  showTranslation: boolean;

  orfHit: OrfLike | null;
}

export interface PointerSelectionResult {
  annotation: AnnotationStateIdentity | null;
  orf: OrfIdentity | null;
}

export function resolvePointerSelection(input: PointerSelectionInput): PointerSelectionResult {
  const orf = input.orfHit
    ? { start: input.orfHit.start, end: input.orfHit.end, strand: input.orfHit.strand }
    : null;

  const annotation = orf
    ? null
    : resolveAnnotationTarget({
        annotationHit: input.annotationHit,
        parentCdsForCodon: input.parentCdsForCodon,
        classifiedCDSs: input.classifiedCDSs,
        position: input.position,
        showAnnotations: input.showAnnotations,
        showTranslation: input.showTranslation,
      });

  return { annotation, orf };
}

export function annotationIdentityEqual(
  a: AnnotationStateIdentity | null,
  b: AnnotationStateIdentity | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.name === b.name &&
    a.start === b.start &&
    a.end === b.end &&
    (a.direction ?? 0) === (b.direction ?? 0)
  );
}

export function orfIdentityEqual(a: OrfIdentity | null, b: OrfIdentity | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end && a.strand === b.strand;
}
