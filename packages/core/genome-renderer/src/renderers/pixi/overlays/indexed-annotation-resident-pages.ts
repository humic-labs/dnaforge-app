import type {
  AnnotationResidentPagePublication,
  AnnotationResidentPagePublicationApplyResult,
  Feature,
  RenderState,
} from '../../../types';
import {
  AnnotationResidentPageStore,
  type AnnotationResidentPageRecord,
} from '../../../annotation-resident-page-store';
import { normalizeAnnotationLayerTypes } from './annotation-feature-semantics';
import { validAnnotationResidentPagePublication } from './annotation-presentation-snapshot-validate';
import { recordAnnotationPresentationSnapshotApply } from './annotation-presentation-debug';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import { decodeAnnotationPolicyProjectionFeatureV1 } from '../overview/annotation-policy-projection-v1';
import {
  decodePrepackedAnnotationInteractionFeatureV2,
  findPrepackedAnnotationFeatureByCanonicalIdentityV2,
  queryPrepackedAnnotationInteractionIndexV2,
  type PrepackedAnnotationFeatureLookupIndexV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import type { AnnotationPolicyProjectionTableV1 } from '../overview/annotation-policy-projection-v1';

export type ResidentPageFeatureResident = {
  ownerKey: string;
  input: {
    policyProjection?: AnnotationPolicyProjectionTableV1 | null;
    interactionIndex?: PrepackedAnnotationFeatureLookupIndexV2 | null;
  };
};

export type ResidentPageFeatureHost = {
  genomeLength: number;
  maxAnnotationLane: number;
  maxCdsLane: number;
  prepackedAnnotationPolicyGeneration: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedResidentPolicyFeatureIndexCache: Map<string, number | null>;
  annotationLayerTypesForPresentation(): string[];
  prepackedAnnotationSceneResidentForTrack(trackId: string): ResidentPageFeatureResident | null;
  compiledBroadSurfaceLaneStart(
    trackType: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
};

export function residentAnnotationPolicyProjectionKey(
  host: ResidentPageFeatureHost,
  annotationSearchFocus: RenderState['annotationSearchFocus']
): string {
  const policy = host.prepackedAnnotationRuntimePolicy;
  const residentOwners = host.annotationLayerTypesForPresentation().map((trackId) => {
    const resident = host.prepackedAnnotationSceneResidentForTrack(trackId);
    return `${trackId}:${resident?.ownerKey ?? 'source-page-lanes'}`;
  });
  const focusKey = annotationSearchFocus
    ? [
        'annotation-search-focus.v1',
        annotationSearchFocus.trackId,
        annotationSearchFocus.canonicalIdentity,
        annotationSearchFocus.presentation ?? 'ordinary-overlay',
      ]
    : ['annotation-search-focus:none'];
  if (!policy) return ['source-page-lanes', ...residentOwners, ...focusKey].join('\u0000');
  return [
    'annotation-runtime-policy.v1',
    ...residentOwners,
    host.prepackedAnnotationPolicyGeneration,
    policy.isoformMode,
    policy.laneLimit ?? 'uncapped',
    ...focusKey,
  ].join('\u0000');
}

export function prepackedPolicyFeatureIndexForResidentFeature(
  host: ResidentPageFeatureHost,
  resident: ResidentPageFeatureResident,
  feature: Feature,
  canonicalIdentity: string
): number | null {
  const cacheKey = `${resident.ownerKey}\u0000${canonicalIdentity}`;
  if (host.prepackedResidentPolicyFeatureIndexCache.has(cacheKey)) {
    return host.prepackedResidentPolicyFeatureIndexCache.get(cacheKey) ?? null;
  }
  const interactionIndex = resident.input.interactionIndex;
  if (!interactionIndex) return null;
  const exact = findPrepackedAnnotationFeatureByCanonicalIdentityV2(
    interactionIndex,
    canonicalIdentity
  );
  if (exact !== null) {
    host.prepackedResidentPolicyFeatureIndexCache.set(cacheKey, exact);
    return exact;
  }

  let match: number | null = null;
  let ambiguous = false;
  queryPrepackedAnnotationInteractionIndexV2(
    interactionIndex,
    feature.start,
    Math.min(host.genomeLength, feature.start + 1),
    (candidateIndex) => {
      const candidate = decodePrepackedAnnotationInteractionFeatureV2(
        interactionIndex,
        candidateIndex
      );
      const stableIdentityMatches = feature.transcriptId
        ? candidate.transcriptId === feature.transcriptId
        : candidate.displayName === feature.displayName;
      if (
        !stableIdentityMatches ||
        candidate.startBp !== feature.start ||
        candidate.endBp !== feature.end ||
        candidate.type !== feature.type ||
        candidate.direction !== feature.direction
      ) {
        return;
      }
      if (match === null) match = candidateIndex;
      else if (match !== candidateIndex) ambiguous = true;
    }
  );
  const resolved = ambiguous ? null : match;
  host.prepackedResidentPolicyFeatureIndexCache.set(cacheKey, resolved);
  return resolved;
}

export function projectResidentAnnotationFeatures(
  host: ResidentPageFeatureHost,
  records: ReadonlyArray<AnnotationResidentPageRecord>,
  annotationSearchFocus: RenderState['annotationSearchFocus']
): Feature[] | null {
  const runtimePolicy = host.prepackedAnnotationRuntimePolicy;
  if (!runtimePolicy) {
    return records.flatMap((record) =>
      record.page.features.map((feature, index) => {
        const canonicalIdentity = record.canonicalFeatureIdentities[index];
        const isFocusTarget =
          !!annotationSearchFocus &&
          (feature.annotationTrackId ?? feature.type) === annotationSearchFocus.trackId &&
          canonicalIdentity === annotationSearchFocus.canonicalIdentity;
        return isFocusTarget && feature.canonicalIdentity !== canonicalIdentity
          ? Object.freeze({ ...feature, canonicalIdentity })
          : feature;
      })
    );
  }
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  const requestedLayerTypeSet = new Set(requestedLayerTypes);
  const projected: Feature[] = [];
  for (const record of records) {
    for (let index = 0; index < record.page.features.length; index += 1) {
      const feature = record.page.features[index];
      const featureTrackId = feature.annotationTrackId ?? feature.type;
      if (!requestedLayerTypeSet.has(featureTrackId)) continue;
      const resident = host.prepackedAnnotationSceneResidentForTrack(featureTrackId);
      const residentCanonicalIdentity = record.canonicalFeatureIdentities[index];
      let focusCanonicalIdentity = residentCanonicalIdentity;
      let localLane: number | null | undefined;
      const projection = resident?.input.policyProjection;
      const interactionIndex = resident?.input.interactionIndex;
      if (resident && projection && interactionIndex) {
        const featureIndex = prepackedPolicyFeatureIndexForResidentFeature(
          host,
          resident,
          feature,
          residentCanonicalIdentity
        );
        if (featureIndex === null || featureIndex >= projection.featureCount) return null;
        const policyFeature = decodeAnnotationPolicyProjectionFeatureV1(projection, featureIndex);
        if (annotationSearchFocus?.trackId === featureTrackId) {
          focusCanonicalIdentity = decodePrepackedAnnotationInteractionFeatureV2(
            interactionIndex,
            featureIndex
          ).canonicalIdentity;
        }
        localLane =
          runtimePolicy.isoformMode === 'canonical'
            ? policyFeature.canonicalTrackLane
            : policyFeature.expandedTrackLane;
      } else {
        localLane = feature.annotationTrackLane;
      }
      const isFocusTarget =
        !!annotationSearchFocus &&
        featureTrackId === annotationSearchFocus.trackId &&
        focusCanonicalIdentity === annotationSearchFocus.canonicalIdentity;
      const validatedLocalLane =
        typeof localLane === 'number' && Number.isSafeInteger(localLane) && localLane >= 0
          ? localLane
          : null;
      const isDurablyVisible =
        validatedLocalLane !== null &&
        (runtimePolicy.laneLimit === null || validatedLocalLane < runtimePolicy.laneLimit);
      if (!isDurablyVisible) {
        if (!isFocusTarget) continue;
        localLane = 0;
      } else {
        localLane = validatedLocalLane;
      }
      if (typeof localLane !== 'number' || !Number.isSafeInteger(localLane) || localLane < 0) {
        return null;
      }
      const usesTemporaryAdditionalLane =
        isFocusTarget &&
        !isDurablyVisible &&
        annotationSearchFocus?.presentation === 'temporary-additional-lane';
      const globalLane = usesTemporaryAdditionalLane
        ? feature.type === 'CDS'
          ? host.maxCdsLane + 1
          : host.maxAnnotationLane + 1
        : host.compiledBroadSurfaceLaneStart(featureTrackId, requestedLayerTypes, runtimePolicy) +
          localLane;
      projected.push(
        feature.lane === globalLane &&
          feature.annotationTrackLane === (usesTemporaryAdditionalLane ? 0 : localLane) &&
          (!usesTemporaryAdditionalLane ||
            (feature.annotationTrackLaneCapacity === 1 &&
              (feature.type !== 'CDS' || feature.cdsLane === globalLane))) &&
          (!isFocusTarget || feature.canonicalIdentity === focusCanonicalIdentity)
          ? feature
          : Object.freeze({
              ...feature,
              lane: globalLane,
              ...(usesTemporaryAdditionalLane
                ? {
                    annotationTrackLane: 0,
                    annotationTrackLaneCapacity: 1,
                    ...(feature.type === 'CDS' ? { cdsLane: globalLane } : {}),
                  }
                : { annotationTrackLane: localLane }),
              ...(isFocusTarget ? { canonicalIdentity: focusCanonicalIdentity } : {}),
            })
      );
    }
  }
  return projected;
}

export type ResidentViewportSelection = Readonly<{
  status: 'unavailable' | 'ready' | 'incomplete';
  key: string | null;
  features: ReadonlyArray<Feature>;
}>;

type ResidentViewportCoverage = Readonly<{
  expectedPageCount: number;
  missingPageCount: number;
  coverageComplete: boolean;
  producerCoverageComplete: boolean;
}>;

export type ResidentViewportSelectionCache = {
  key: string;
  sourceKey: string;
  projectionKey: string;
  startBp: number;
  endBp: number;
  pageCount: number;
  coverage: ResidentViewportCoverage;
  records: ReadonlyArray<AnnotationResidentPageRecord>;
  features: ReadonlyArray<Feature>;
};

export type ResidentPageLifecycleHost = ResidentPageFeatureHost & {
  currentGenomeIdentity: string | null;
  annotationResidentPageStreams: Map<
    string,
    { generation: number; snapshot: AnnotationResidentPagePublication }
  >;
  annotationResidentPageStore: AnnotationResidentPageStore | null;
  activeAnnotationResidentPageStreamKey: string | null;
  residentAnnotationViewportSelectionCache: ResidentViewportSelectionCache | null;
  residentAnnotationPageSnapshotApplies: number;
  residentAnnotationPageFlatGraphSkips: number;
  annotationRequestedLayerTypes: readonly string[];
  annotationExactCoverage: Array<{ startBp: number; endBp: number }>;
  prepackedAnnotationSceneInput: { metadata: { trackType: string } } | null;
  features: Feature[];
  residentAnnotationViewportSelectionStatus: 'unavailable' | 'ready' | 'incomplete';
  residentAnnotationViewportSelectedPageCount: number;
  residentAnnotationViewportSelectedFeatureCount: number;
  residentAnnotationViewportExpectedPageCount: number;
  residentAnnotationViewportMissingPageCount: number;
  residentAnnotationViewportCoverageComplete: boolean;
  residentAnnotationViewportProducerCoverageComplete: boolean;
  residentAnnotationViewportSelectionQueries: number;
  reconcileAnnotationLaneEnvelopeAuthority(): void;
  commitAnnotationLaneEnvelope(maxAnnotationLane: number, maxCdsLane: number): void;
  residentAnnotationPolicyProjectionKey(
    annotationSearchFocus: RenderState['annotationSearchFocus']
  ): string;
  projectResidentAnnotationFeatures(
    records: ReadonlyArray<AnnotationResidentPageRecord>,
    annotationSearchFocus: RenderState['annotationSearchFocus']
  ): Feature[] | null;
};

export function ingestAnnotationResidentPages(
  host: ResidentPageLifecycleHost,
  publication: AnnotationResidentPagePublication
): AnnotationResidentPagePublicationApplyResult {
  if (!host.currentGenomeIdentity || host.genomeLength <= 0) {
    return { status: 'rejected', reason: 'no-genome' };
  }
  if (!validAnnotationResidentPagePublication(publication)) {
    return { status: 'rejected', reason: 'invalid-contract' };
  }
  if (publication.sourceIdentity !== host.currentGenomeIdentity) {
    return { status: 'rejected', reason: 'source-mismatch' };
  }
  if (publication.genomeLengthBp !== host.genomeLength) {
    return { status: 'rejected', reason: 'length-mismatch' };
  }
  const streamKey = `${publication.sourceIdentity}\u0000${publication.policyKey}`;
  const accepted = host.annotationResidentPageStreams.get(streamKey);
  if (accepted) {
    if (publication.generation < accepted.generation) {
      return { status: 'rejected', reason: 'stale-generation' };
    }
    if (publication.generation === accepted.generation) {
      if (publication !== accepted.snapshot) {
        return { status: 'rejected', reason: 'generation-collision' };
      }
      if (host.activeAnnotationResidentPageStreamKey === streamKey) {
        return { status: 'noop', generation: publication.generation };
      }
    }
  }

  const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
  const residentStore =
    host.annotationResidentPageStore?.sourceIdentity === publication.sourceIdentity &&
    host.annotationResidentPageStore.genomeLengthBp === publication.genomeLengthBp
      ? host.annotationResidentPageStore
      : new AnnotationResidentPageStore({
          sourceIdentity: publication.sourceIdentity,
          genomeLengthBp: publication.genomeLengthBp,
        });
  host.annotationResidentPageStore = residentStore;
  const pageApply = residentStore.applyPublication(publication);
  if (pageApply.status === 'rejected') {
    if (pageApply.reason === 'stale-generation') {
      return { status: 'rejected', reason: 'stale-generation' };
    }
    if (pageApply.reason === 'generation-collision') {
      return { status: 'rejected', reason: 'generation-collision' };
    }
    return { status: 'rejected', reason: 'invalid-contract' };
  }
  host.residentAnnotationViewportSelectionCache = null;
  host.residentAnnotationPageSnapshotApplies += 1;
  host.residentAnnotationPageFlatGraphSkips += 1;
  const ownsAnnotationBody = publication.contract === 'annotation-resident-page-publication.v1';
  if (ownsAnnotationBody) {
    host.annotationRequestedLayerTypes = normalizeAnnotationLayerTypes(
      publication.requestedLayerTypes
    );
    host.annotationExactCoverage = publication.exactCoverage.map((coverage) => ({ ...coverage }));
  }
  if (ownsAnnotationBody && host.prepackedAnnotationRuntimePolicy) {
    host.reconcileAnnotationLaneEnvelopeAuthority();
  } else if (ownsAnnotationBody) {
    const compiledPolicyTrackId = host.prepackedAnnotationSceneInput?.metadata.trackType;
    let residentMaxAnnotationLane = host.maxAnnotationLane;
    for (const page of publication.pages) {
      for (const feature of page.features) {
        const featureTrackId = feature.annotationTrackId ?? feature.type;
        if (compiledPolicyTrackId && featureTrackId === compiledPolicyTrackId) continue;
        const localLane = feature.annotationTrackLane;
        const capacity = feature.annotationTrackLaneCapacity;
        if (
          !Number.isSafeInteger(feature.lane) ||
          !Number.isSafeInteger(localLane) ||
          !Number.isSafeInteger(capacity) ||
          (capacity ?? 0) <= 0
        ) {
          continue;
        }
        const trackBaseLane = feature.lane - localLane!;
        residentMaxAnnotationLane = Math.max(
          residentMaxAnnotationLane,
          trackBaseLane + capacity! - 1
        );
      }
    }
    if (residentMaxAnnotationLane > host.maxAnnotationLane) {
      host.commitAnnotationLaneEnvelope(residentMaxAnnotationLane, host.maxCdsLane);
    }
  }
  host.annotationResidentPageStreams.set(streamKey, {
    generation: publication.generation,
    snapshot: publication,
  });
  while (host.annotationResidentPageStreams.size > 2) {
    const obsolete = [...host.annotationResidentPageStreams.keys()].find(
      (key) => key !== streamKey
    );
    if (obsolete === undefined) break;
    host.annotationResidentPageStreams.delete(obsolete);
  }
  host.activeAnnotationResidentPageStreamKey = streamKey;
  const endedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
  recordAnnotationPresentationSnapshotApply(publication, endedAt - startedAt);
  return { status: 'applied', generation: publication.generation, invalidatedHover: true };
}

function reportResidentViewportCoverage(
  host: ResidentPageLifecycleHost,
  coverage: ResidentViewportCoverage
): void {
  host.residentAnnotationViewportExpectedPageCount = coverage.expectedPageCount;
  host.residentAnnotationViewportMissingPageCount = coverage.missingPageCount;
  host.residentAnnotationViewportCoverageComplete = coverage.coverageComplete;
  host.residentAnnotationViewportProducerCoverageComplete = coverage.producerCoverageComplete;
}

export function selectResidentAnnotationFeaturesForViewport(
  host: ResidentPageLifecycleHost,
  viewStartBp: number,
  viewEndBp: number,
  annotationSearchFocus: RenderState['annotationSearchFocus'] = null
): ResidentViewportSelection {
  const streamKey = host.activeAnnotationResidentPageStreamKey;
  const activeSnapshot = streamKey
    ? host.annotationResidentPageStreams.get(streamKey)?.snapshot
    : undefined;
  if (
    !streamKey ||
    !host.annotationResidentPageStore ||
    (activeSnapshot?.contract !== 'annotation-resident-page-publication.v1' &&
      activeSnapshot?.contract !== 'annotation-codon-carrier-page-publication.v1')
  ) {
    host.residentAnnotationViewportSelectionStatus = 'unavailable';
    host.residentAnnotationViewportSelectedPageCount = 0;
    host.residentAnnotationViewportSelectedFeatureCount = 0;
    reportResidentViewportCoverage(host, {
      expectedPageCount: 0,
      missingPageCount: 0,
      coverageComplete: false,
      producerCoverageComplete: false,
    });
    return { status: 'unavailable', key: null, features: host.features };
  }

  const viewportStartBp = Math.min(
    host.genomeLength,
    Math.max(0, Math.min(viewStartBp, viewEndBp))
  );
  const viewportEndBp = Math.max(0, Math.min(host.genomeLength, Math.max(viewStartBp, viewEndBp)));
  const projectionKey = host.residentAnnotationPolicyProjectionKey(annotationSearchFocus);
  const cached = host.residentAnnotationViewportSelectionCache;
  if (cached && viewportStartBp >= cached.startBp && viewportEndBp <= cached.endBp) {
    reportResidentViewportCoverage(host, cached.coverage);
    if (cached.projectionKey !== projectionKey) {
      const projected = host.projectResidentAnnotationFeatures(
        cached.records,
        annotationSearchFocus
      );
      if (projected === null) {
        host.residentAnnotationViewportSelectionStatus = 'incomplete';
        host.residentAnnotationViewportSelectedPageCount = cached.pageCount;
        host.residentAnnotationViewportSelectedFeatureCount = 0;
        return {
          status: 'incomplete',
          key: `${cached.sourceKey}\u0000${projectionKey}`,
          features: [],
        };
      }
      const features = Object.freeze(projected);
      const key = `${cached.sourceKey}\u0000${projectionKey}`;
      host.residentAnnotationViewportSelectionCache = Object.freeze({
        ...cached,
        key,
        projectionKey,
        features,
      });
    }
    const current = host.residentAnnotationViewportSelectionCache!;
    host.residentAnnotationViewportSelectionStatus = 'ready';
    host.residentAnnotationViewportSelectedPageCount = current.pageCount;
    host.residentAnnotationViewportSelectedFeatureCount = current.features.length;
    return { status: 'ready', key: current.key, features: current.features };
  }

  const corridorQuantumBp = 16 * 1024;
  const corridorStartBp = Math.max(
    0,
    Math.floor(viewportStartBp / corridorQuantumBp) * corridorQuantumBp
  );
  const corridorEndBp = Math.min(
    host.genomeLength,
    Math.max(corridorStartBp + 1, Math.ceil(viewportEndBp / corridorQuantumBp) * corridorQuantumBp)
  );

  host.residentAnnotationViewportSelectionQueries += 1;
  let selection = host.annotationResidentPageStore.selectVisible({
    sourceIdentity: activeSnapshot.sourceIdentity,
    policyKey: activeSnapshot.policyKey,
    viewStartBp: corridorStartBp,
    viewEndBp: corridorEndBp,
  });
  let selectedStartBp = corridorStartBp;
  let selectedEndBp = corridorEndBp;
  if (selection.status !== 'ready') {
    host.residentAnnotationViewportSelectionQueries += 1;
    selection = host.annotationResidentPageStore.selectVisible({
      sourceIdentity: activeSnapshot.sourceIdentity,
      policyKey: activeSnapshot.policyKey,
      viewStartBp: viewportStartBp,
      viewEndBp: viewportEndBp,
    });
    selectedStartBp = viewportStartBp;
    selectedEndBp = viewportEndBp;
  }
  const coverage: ResidentViewportCoverage = Object.freeze({
    expectedPageCount: selection.expectedPageIdentities.length,
    missingPageCount: selection.missingPageIdentities.length,
    coverageComplete: selection.coverageComplete,
    producerCoverageComplete: selection.producerCoverageComplete,
  });
  reportResidentViewportCoverage(host, coverage);
  if (selection.status !== 'ready') {
    const key = `${streamKey}\u0000${selection.status}\u0000${selection.expectedPageIdentities.join('\u0000')}`;
    host.residentAnnotationViewportSelectionStatus = 'incomplete';
    host.residentAnnotationViewportSelectedPageCount = selection.records.length;
    host.residentAnnotationViewportSelectedFeatureCount = 0;
    return { status: 'incomplete', key, features: [] };
  }

  const sourceKey = `${streamKey}\u0000ready\u0000${selection.records
    .map((record) => record.identityKey)
    .join('\u0000')}`;
  const key = `${sourceKey}\u0000${projectionKey}`;
  if (host.residentAnnotationViewportSelectionCache?.key === key) {
    host.residentAnnotationViewportSelectionCache = Object.freeze({
      ...host.residentAnnotationViewportSelectionCache,
      sourceKey,
      projectionKey,
      startBp: selectedStartBp,
      endBp: selectedEndBp,
      pageCount: selection.records.length,
      coverage,
    });
    host.residentAnnotationViewportSelectionStatus = 'ready';
    host.residentAnnotationViewportSelectedPageCount = selection.records.length;
    host.residentAnnotationViewportSelectedFeatureCount =
      host.residentAnnotationViewportSelectionCache.features.length;
    return {
      status: 'ready',
      key,
      features: host.residentAnnotationViewportSelectionCache.features,
    };
  }

  const projected = host.projectResidentAnnotationFeatures(
    selection.records,
    annotationSearchFocus
  );
  if (projected === null) {
    host.residentAnnotationViewportSelectionStatus = 'incomplete';
    host.residentAnnotationViewportSelectedPageCount = selection.records.length;
    host.residentAnnotationViewportSelectedFeatureCount = 0;
    return { status: 'incomplete', key, features: [] };
  }
  const features = Object.freeze(projected);
  host.residentAnnotationViewportSelectionCache = Object.freeze({
    key,
    sourceKey,
    projectionKey,
    startBp: selectedStartBp,
    endBp: selectedEndBp,
    pageCount: selection.records.length,
    coverage,
    records: Object.freeze([...selection.records]),
    features,
  });
  host.residentAnnotationViewportSelectionStatus = 'ready';
  host.residentAnnotationViewportSelectedPageCount = selection.records.length;
  host.residentAnnotationViewportSelectedFeatureCount = features.length;
  return { status: 'ready', key, features };
}
