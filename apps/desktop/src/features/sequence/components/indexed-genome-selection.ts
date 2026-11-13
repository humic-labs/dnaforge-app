import type { Feature, FeatureHitPayload } from '@waypoint/genome-renderer';

export type IndexedGenomeSelectedAnnotation = {
  featureId: number;
  canonicalIdentity?: string;
  type: string;
  name: string;
  start: number;
  end: number;
  direction?: number;
};

export function annotationIdentityFromFeatureHit(
  feature: FeatureHitPayload
): IndexedGenomeSelectedAnnotation | null {
  if (!feature.displayName || !feature.type) return null;
  return {
    featureId: feature.id,
    ...(feature.canonicalIdentity ? { canonicalIdentity: feature.canonicalIdentity } : {}),
    type: feature.type,
    name: feature.displayName,
    start: feature.start + 1,
    end: feature.end,
    direction: directionNumber(feature.direction ?? 'none'),
  };
}

export function annotationIdentityFromFeature(feature: Feature): IndexedGenomeSelectedAnnotation {
  return {
    featureId: feature.id,
    ...(feature.canonicalIdentity ? { canonicalIdentity: feature.canonicalIdentity } : {}),
    type: feature.type,
    name: feature.displayName,
    start: feature.start + 1,
    end: feature.end,
    direction: directionNumber(feature.direction),
  };
}

export function featureMatchesAnnotation(
  feature: Feature,
  annotation: IndexedGenomeSelectedAnnotation
): boolean {
  if (annotation.canonicalIdentity) {
    return feature.canonicalIdentity === annotation.canonicalIdentity;
  }
  return feature.id === annotation.featureId;
}

export function directionNumber(direction: Feature['direction']): number | undefined {
  if (direction === 'forward') return 1;
  if (direction === 'reverse') return -1;
  return undefined;
}
