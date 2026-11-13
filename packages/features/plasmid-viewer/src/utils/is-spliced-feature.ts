import type { PlasmidFeature } from '../types';

export function isSplicedFeature(feature: PlasmidFeature): boolean {
  if (!feature.segments || feature.segments.length < 2) return false;
  const locStr = feature.qualifiers?._locationString?.[0];
  if (!locStr || !locStr.includes('join(')) return false;
  if (feature.start > feature.end) return false;
  return true;
}
