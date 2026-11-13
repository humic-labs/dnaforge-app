import type { AnnotationPresentationPage, Feature } from '@waypoint/genome-renderer';
import { isAnnotationCodonCarrier } from '@waypoint/genome-renderer/pure';
import { ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP } from './indexed-annotation-tile-policy';

export const ASSEMBLY_ANNOTATION_PAGE_SIZE_BP = 512 * 1024;
export const ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP = ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP;
export const ASSEMBLY_ANNOTATION_PAGE_HALO = 16;
export const ASSEMBLY_ANNOTATION_RESIDENT_COORDINATE_LIMIT = 68;

export interface AssemblyAnnotationPageRange {
  localStartBp: number;
  localEndBp: number;
}

export interface AnnotationPresentationTrackDescriptor {
  readonly trackId: string;
  readonly trackOrder: number;
  readonly laneCapacity: number;
}

export function annotationQueryRangeForLocalOwner(input: {
  ownerStartBp: number;
  ownerEndBp: number;
  chromosomeLengthBp: number;
}): AssemblyAnnotationPageRange {
  const length = Math.max(0, Math.trunc(input.chromosomeLengthBp));
  if (length === 0) return { localStartBp: 0, localEndBp: 0 };
  const span = Math.min(length, ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP);
  const center = (input.ownerStartBp + input.ownerEndBp) / 2;
  const maxStart = Math.max(0, length - span);
  const localStartBp = Math.max(0, Math.min(maxStart, Math.floor(center - span / 2)));
  return { localStartBp, localEndBp: localStartBp + span };
}

export function annotationPageRangesForLocalViewport(input: {
  localStartBp: number;
  localEndBp: number;
  chromosomeLengthBp: number;
  haloPages?: number;
}): AssemblyAnnotationPageRange[] {
  const length = Math.max(0, Math.trunc(input.chromosomeLengthBp));
  if (length === 0) return [];
  const start = Math.max(0, Math.min(length - 1, Math.floor(input.localStartBp)));
  const rawEnd = Math.max(start + 1, Math.min(length, Math.ceil(input.localEndBp)));
  const firstVisible = Math.floor(start / ASSEMBLY_ANNOTATION_PAGE_SIZE_BP);
  const lastVisible = Math.floor((rawEnd - 1) / ASSEMBLY_ANNOTATION_PAGE_SIZE_BP);
  const halo = Math.max(0, Math.trunc(input.haloPages ?? ASSEMBLY_ANNOTATION_PAGE_HALO));
  const first = Math.max(0, firstVisible - halo);
  const lastPage = Math.floor((length - 1) / ASSEMBLY_ANNOTATION_PAGE_SIZE_BP);
  const last = Math.min(lastPage, lastVisible + halo);
  const ranges: AssemblyAnnotationPageRange[] = [];
  for (let page = first; page <= last; page += 1) {
    const localStartBp = page * ASSEMBLY_ANNOTATION_PAGE_SIZE_BP;
    ranges.push({
      localStartBp,
      localEndBp: Math.min(length, localStartBp + ASSEMBLY_ANNOTATION_PAGE_SIZE_BP),
    });
  }
  return ranges;
}

export function filterAnnotationPresentationPagesForCodonCarriers(
  pages: ReadonlyArray<AnnotationPresentationPage>,
  requestedTrackIds: ReadonlyArray<string>
): ReadonlyArray<AnnotationPresentationPage> {
  const requested = new Set(requestedTrackIds);
  if (requested.size === 0) return [];
  const carrierTrackIds = new Set<string>();
  for (const page of pages) {
    if (
      requested.has(page.trackId) &&
      page.features.some((feature) => isAnnotationCodonCarrier(feature))
    ) {
      carrierTrackIds.add(page.trackId);
    }
  }
  const filtered = pages.filter((page) => carrierTrackIds.has(page.trackId));
  return filtered.length === pages.length ? pages : filtered;
}

export function annotationCoordinatePageKey(input: {
  sourceIdentity: string;
  policyKey: string;
  chromosomeId: string;
  ownerStartBp: number;
  ownerEndBp: number;
}): string {
  return [
    'annotation-coordinate-page.v1',
    input.sourceIdentity,
    input.policyKey,
    input.chromosomeId,
    input.ownerStartBp,
    input.ownerEndBp,
  ].join('\u0000');
}

function featureTrackId(feature: Feature): string {
  return feature.annotationTrackId ?? feature.type;
}

export function annotationPageContentRevision(input: {
  sourceIdentity: string;
  policyKey: string;
  chromosomeId: string;
  trackId: string;
  trackOrder: number;
  laneCapacity: number;
  ownerStartBp: number;
  ownerEndBp: number;
}): string {
  return [
    'annotation-page-content.source-authority.v1',
    input.sourceIdentity,
    input.policyKey,
    input.chromosomeId,
    input.trackId,
    input.trackOrder,
    input.laneCapacity,
    input.ownerStartBp,
    input.ownerEndBp,
  ].join('\u0000');
}

export async function buildAnnotationPresentationPages(input: {
  sourceIdentity: string;
  policyKey: string;
  chromosomeId: string;
  ownerStartBp: number;
  ownerEndBp: number;
  requestedTracks: ReadonlyArray<AnnotationPresentationTrackDescriptor>;
  features: ReadonlyArray<Feature>;
}): Promise<AnnotationPresentationPage[]> {
  const descriptorByTrackId = new Map<string, AnnotationPresentationTrackDescriptor>();
  for (const descriptor of input.requestedTracks) {
    if (
      !descriptor.trackId ||
      !Number.isSafeInteger(descriptor.trackOrder) ||
      descriptor.trackOrder < 0 ||
      !Number.isSafeInteger(descriptor.laneCapacity) ||
      descriptor.laneCapacity <= 0 ||
      descriptorByTrackId.has(descriptor.trackId)
    ) {
      throw new Error(
        `Invalid annotation presentation track descriptor: ${JSON.stringify(descriptor)}`
      );
    }
    descriptorByTrackId.set(descriptor.trackId, Object.freeze({ ...descriptor }));
  }
  const orderedDescriptors = [...descriptorByTrackId.values()].sort(
    (left, right) => left.trackOrder - right.trackOrder
  );
  if (orderedDescriptors.some((descriptor, index) => descriptor.trackOrder !== index)) {
    throw new Error('Annotation presentation trackOrder values must be contiguous from zero.');
  }
  const owned = input.features.filter(
    (feature) => feature.start >= input.ownerStartBp && feature.start < input.ownerEndBp
  );
  const normalizedOwned = owned.map((feature) => {
    const trackId = featureTrackId(feature);
    const descriptor = descriptorByTrackId.get(trackId);
    if (!descriptor) {
      throw new Error(`Feature track "${trackId}" is absent from the presentation policy.`);
    }
    const trackLane = feature.annotationTrackLane ?? feature.lane;
    if (!Number.isSafeInteger(trackLane) || trackLane < 0 || trackLane >= descriptor.laneCapacity) {
      throw new Error(
        `Feature track lane ${String(trackLane)} is outside "${trackId}" capacity ${descriptor.laneCapacity}.`
      );
    }
    return Object.freeze({
      ...feature,
      annotationTrackId: trackId,
      annotationTrackLane: trackLane,
      annotationTrackLaneCapacity: descriptor.laneCapacity,
      segments: feature.segments,
      exons: feature.exons,
      cds: feature.cds,
      qualifiers: feature.qualifiers,
    });
  });
  const pages: AnnotationPresentationPage[] = [];
  for (const descriptor of orderedDescriptors) {
    const { trackId, trackOrder, laneCapacity } = descriptor;
    const features = Object.freeze(
      normalizedOwned.filter((feature) => featureTrackId(feature) === trackId)
    );
    const maxFeatureEndBp = features.reduce(
      (max, feature) => Math.max(max, feature.end),
      input.ownerEndBp
    );
    const pageKey = [
      'annotation-presentation-page.v1',
      input.sourceIdentity,
      input.policyKey,
      input.chromosomeId,
      trackId,
      trackOrder,
      laneCapacity,
      input.ownerStartBp,
      input.ownerEndBp,
    ].join('\u0000');
    const contentRevision = annotationPageContentRevision({
      ...input,
      trackId,
      trackOrder,
      laneCapacity,
    });
    pages.push(
      Object.freeze({
        contract: 'annotation-presentation-page.v1' as const,
        pageKey,
        chromosomeId: input.chromosomeId,
        trackId,
        trackOrder,
        laneCapacity,
        ownerStartBp: input.ownerStartBp,
        ownerEndBp: input.ownerEndBp,
        maxFeatureEndBp,
        contentRevision,
        features,
      })
    );
  }
  return pages;
}

export function mergeAnnotationPageCoverage(
  pages: ReadonlyArray<AnnotationPresentationPage>
): Array<{ startBp: number; endBp: number }> {
  const coordinates = new Map<string, { startBp: number; endBp: number }>();
  for (const page of pages) {
    coordinates.set(`${page.chromosomeId}\u0000${page.ownerStartBp}\u0000${page.ownerEndBp}`, {
      startBp: page.ownerStartBp,
      endBp: page.ownerEndBp,
    });
  }
  const sorted = [...coordinates.values()].sort((left, right) => left.startBp - right.startBp);
  const merged: Array<{ startBp: number; endBp: number }> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.startBp <= previous.endBp) {
      previous.endBp = Math.max(previous.endBp, range.endBp);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
