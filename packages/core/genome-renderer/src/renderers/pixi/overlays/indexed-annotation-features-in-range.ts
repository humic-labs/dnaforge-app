import type { Feature } from '../../../types';

export const ANNOTATION_RANGE_INDEX_LOOKBACK_CAP_BP = 1_000_000;

export type FeaturesInRangeHost = {
  features: Feature[];
  featuresSortedByStart: Feature[] | null;
  longFeatures?: readonly Feature[];
  maxFeatureLenBp: number;
  genomeLength: number;
  circularWrappedFeatures: readonly Feature[];
  wrappedFeatureOverlapsRange(feature: Feature, viewStartBp: number, viewEndBp: number): boolean;
};

export type AnnotationRangeIndex = {
  sortedByStart: Feature[];
  longFeatures: Feature[];
  circularWrappedFeatures: Feature[];
  maxIndexedFeatureLenBp: number;
};

export function indexAnnotationFeaturesForRange(
  features: readonly Feature[],
  genomeLength: number,
  circular: boolean
): AnnotationRangeIndex {
  const sortedByStart: Feature[] = [];
  const longFeatures: Feature[] = [];
  const circularWrappedFeatures: Feature[] = [];
  let maxIndexedFeatureLenBp = 0;
  for (const feature of features) {
    if (!Number.isFinite(feature.start) || !Number.isFinite(feature.end)) continue;
    if (feature.end < feature.start) {
      if (circular) circularWrappedFeatures.push(feature);
      continue;
    }
    const length = feature.end - feature.start;
    if (length > ANNOTATION_RANGE_INDEX_LOOKBACK_CAP_BP) {
      longFeatures.push(feature);
      continue;
    }
    sortedByStart.push(feature);
    if (length > maxIndexedFeatureLenBp) maxIndexedFeatureLenBp = length;
  }
  sortedByStart.sort((left, right) => left.start - right.start);
  return {
    sortedByStart,
    longFeatures,
    circularWrappedFeatures,
    maxIndexedFeatureLenBp,
  };
}

function lowerBoundByStart(sorted: readonly Feature[], lowBound: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid].start < lowBound) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function linearFeatureEnd(feature: Feature, genomeLength: number): number {
  return feature.end > feature.start ? feature.end : feature.end + genomeLength;
}

function overlapsLinearView(
  feature: Feature,
  genomeLength: number,
  viewStartBp: number,
  viewEndBp: number
): boolean {
  return feature.start <= viewEndBp && linearFeatureEnd(feature, genomeLength) >= viewStartBp;
}

export function featuresInRange(
  host: FeaturesInRangeHost,
  viewStartBp: number,
  viewEndBp: number
): Feature[] {
  const sorted = host.featuresSortedByStart;
  const longFeatures = host.longFeatures ?? [];
  if (!sorted || (sorted.length === 0 && longFeatures.length === 0)) return host.features;
  const out: Feature[] = [];
  for (const feature of longFeatures) {
    if (overlapsLinearView(feature, host.genomeLength, viewStartBp, viewEndBp)) out.push(feature);
  }
  const startIndex = lowerBoundByStart(sorted, viewStartBp - host.maxFeatureLenBp);
  for (let i = startIndex; i < sorted.length; i++) {
    const feature = sorted[i];
    if (feature.start > viewEndBp) break;
    if (!overlapsLinearView(feature, host.genomeLength, viewStartBp, viewEndBp)) continue;
    out.push(feature);
  }
  for (const feature of host.circularWrappedFeatures) {
    if (!host.wrappedFeatureOverlapsRange(feature, viewStartBp, viewEndBp)) continue;
    if (!out.includes(feature)) out.push(feature);
  }
  return out;
}

export function hasFeaturesInRange(
  host: FeaturesInRangeHost,
  viewStartBp: number,
  viewEndBp: number
): boolean {
  const sorted = host.featuresSortedByStart;
  const longFeatures = host.longFeatures ?? [];
  if (!sorted || (sorted.length === 0 && longFeatures.length === 0))
    return host.features.length > 0;
  for (const feature of longFeatures) {
    if (overlapsLinearView(feature, host.genomeLength, viewStartBp, viewEndBp)) return true;
  }
  const startIndex = lowerBoundByStart(sorted, viewStartBp - host.maxFeatureLenBp);
  for (let i = startIndex; i < sorted.length; i++) {
    const feature = sorted[i];
    if (feature.start > viewEndBp) break;
    if (overlapsLinearView(feature, host.genomeLength, viewStartBp, viewEndBp)) return true;
  }
  for (const feature of host.circularWrappedFeatures) {
    if (host.wrappedFeatureOverlapsRange(feature, viewStartBp, viewEndBp)) return true;
  }
  return false;
}
