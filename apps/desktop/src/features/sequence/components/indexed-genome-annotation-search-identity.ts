import {
  annotationCanonicalIdentityV2,
  type AnnotationPresentationPage,
  type Feature,
} from '@waypoint/genome-renderer/pure';

import type { IndexableFeature } from '../genome-annotation-index';
import {
  rendererAnnotationIdentityProjection,
  type TranscriptCarrierFeature,
} from './indexed-genome-legacy-adapter';

export function materializeSingleChromosomeAnnotationSearchFeature(
  feature: TranscriptCarrierFeature,
  genomeIdentity: string
): IndexableFeature {
  const identity = rendererAnnotationIdentityProjection(feature);
  return {
    type: identity.type,
    direction: identity.direction,
    start: identity.start,
    end: identity.end,
    annotationTrackId: identity.annotationTrackId,
    canonicalIdentity: annotationCanonicalIdentityV2({
      genomeIdentity,
      sourceId: identity.sourceId,
      transcriptId: identity.transcriptId,
      trackId: identity.annotationTrackId,
      type: identity.type,
      startBp: identity.start,
      endBp: identity.end,
      direction: identity.direction,
    }),
    attributes: feature.attributes,
  };
}

export function resolveSingleChromosomeAnnotationSearchFocusCarrier(input: {
  features: ReadonlyArray<TranscriptCarrierFeature>;
  featureIndex: number;
  genomeIdentity: string;
  focus: { trackId: string; canonicalIdentity: string };
}): TranscriptCarrierFeature | null {
  if (!Number.isSafeInteger(input.featureIndex) || input.featureIndex < 0) return null;
  const feature = input.features[input.featureIndex];
  if (!feature) return null;
  const materialized = materializeSingleChromosomeAnnotationSearchFeature(
    feature,
    input.genomeIdentity
  );
  if (
    materialized.annotationTrackId !== input.focus.trackId ||
    materialized.canonicalIdentity !== input.focus.canonicalIdentity
  ) {
    return null;
  }
  return feature;
}

export function resolveAssemblyAnnotationSearchFocusFeature(input: {
  pages: ReadonlyArray<AnnotationPresentationPage>;
  genomeIdentity: string;
  focus: { trackId: string; canonicalIdentity: string };
}): Feature | null {
  return resolveAssemblyAnnotationSearchFocusFeatureFromFeatures({
    features: input.pages
      .filter((page) => page.trackId === input.focus.trackId)
      .flatMap((page) => page.features),
    genomeIdentity: input.genomeIdentity,
    focus: input.focus,
  });
}

export function resolveAssemblyAnnotationSearchFocusFeatureFromFeatures(input: {
  features: ReadonlyArray<Feature>;
  genomeIdentity: string;
  focus: { trackId: string; canonicalIdentity: string };
}): Feature | null {
  let match: Feature | null = null;
  let matched = false;
  for (const feature of input.features) {
    if ((feature.annotationTrackId ?? feature.type) !== input.focus.trackId) continue;
    const canonicalIdentity = annotationCanonicalIdentityV2({
      genomeIdentity: input.genomeIdentity,
      sourceId: feature.id.toString(36),
      transcriptId: feature.transcriptId ?? null,
      trackId: feature.annotationTrackId ?? feature.type,
      type: feature.type,
      startBp: feature.start,
      endBp: feature.end,
      direction: feature.direction,
    });
    if (canonicalIdentity !== input.focus.canonicalIdentity) continue;
    if (matched) return null;
    matched = true;
    match =
      feature.canonicalIdentity === canonicalIdentity
        ? feature
        : Object.freeze({ ...feature, canonicalIdentity });
  }
  return match;
}
