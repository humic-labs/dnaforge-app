import type { Feature } from '../../../types';
import { isSplicedFeature, isTranscript } from '../overlays/annotation-feature-semantics';

const splicedByFeature = new WeakMap<Feature, boolean>();

const transcriptByFeature = new WeakMap<Feature, boolean>();

export function isTranscriptCached(feature: Feature): boolean {
  const cached = transcriptByFeature.get(feature);
  if (cached !== undefined) return cached;
  const transcript = isTranscript(feature);
  transcriptByFeature.set(feature, transcript);
  return transcript;
}

export function isSplicedFeatureCached(feature: Feature): boolean {
  const cached = splicedByFeature.get(feature);
  if (cached !== undefined) return cached;
  const spliced = isSplicedFeature(feature);
  splicedByFeature.set(feature, spliced);
  return spliced;
}
