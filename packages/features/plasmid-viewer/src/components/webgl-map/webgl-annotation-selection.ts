import type { Feature } from '@waypoint/genome-renderer';

export interface WebGLAnnotationSelectionIdentity {
  type: string;
  name: string;
  start: number;
  end: number;
  direction?: number;
}

export function selectionWrapsOrigin(start: number, end: number): boolean {
  return end < start;
}

export function directionToNumber(direction: Feature['direction']): number {
  if (direction === 'forward') return 1;
  if (direction === 'reverse') return -1;
  return 0;
}

export function annotationIdentityFromFeature(feature: Feature): WebGLAnnotationSelectionIdentity {
  return {
    type: feature.type,
    name: feature.displayName,
    start: feature.start + 1,
    end: feature.end,
    direction: directionToNumber(feature.direction),
  };
}

function annotationNameMatches(featureName: string, annotationName: string): boolean {
  if (featureName === annotationName) return true;

  return annotationName
    .split(' · ')
    .map((name) => name.trim())
    .filter(Boolean)
    .includes(featureName);
}

export function featureMatchesAnnotation(
  feature: Feature,
  annotation: WebGLAnnotationSelectionIdentity
): boolean {
  return (
    feature.type === annotation.type &&
    annotationNameMatches(feature.displayName, annotation.name) &&
    feature.start + 1 === annotation.start &&
    feature.end === annotation.end &&
    directionToNumber(feature.direction) === (annotation.direction ?? 0)
  );
}
