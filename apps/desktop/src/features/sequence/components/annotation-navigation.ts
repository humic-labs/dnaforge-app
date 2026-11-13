import type { Annotation } from '@waypoint/sequence-utils';
import type { AnnotationStateIdentity } from '@waypoint/workspace-editor';

type HighlightRange = { start: number; end: number; wraps?: boolean } | null;

export function annotationIdentityFromAnnotation(annotation: Annotation): AnnotationStateIdentity {
  return {
    type: annotation.type,
    name: annotation.name,
    start: annotation.start,
    end: annotation.end,
    direction: annotation.direction ?? 0,
  };
}

export function findAnnotationIdentityForHighlight(
  annotations: Annotation[] | null | undefined,
  range: HighlightRange
): AnnotationStateIdentity | null {
  if (!range || !annotations?.length) return null;

  for (const annotation of annotations) {
    const start = annotation.start - 1;
    const end = annotation.end - 1;
    const wraps = end < start;
    if (start === range.start && end === range.end && wraps === Boolean(range.wraps)) {
      return annotationIdentityFromAnnotation(annotation);
    }
  }

  return null;
}
