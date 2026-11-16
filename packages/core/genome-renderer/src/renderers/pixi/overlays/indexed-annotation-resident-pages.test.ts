import { describe, expect, it, vi } from 'vitest';
import type { AnnotationResidentPagePublication, Feature } from '../../../types';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  type PrepackedAnnotationInteractionFeatureInputV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import {
  ingestAnnotationResidentPages,
  prepackedPolicyFeatureIndexForResidentFeature,
  residentAnnotationPolicyProjectionKey,
  selectResidentAnnotationFeaturesForViewport,
  type ResidentPageLifecycleHost,
  type ResidentPageFeatureResident,
} from './indexed-annotation-resident-pages';

function publication(
  overrides: Partial<AnnotationResidentPagePublication> = {}
): AnnotationResidentPagePublication {
  return {
    contract: 'annotation-resident-page-publication.v1',
    sourceIdentity: 'src',
    genomeLengthBp: 100,
    policyKey: 'pol',
    generation: 1,
    requestedLayerTypes: ['CDS', 'mRNA', 'mRNA'],
    exactCoverage: [{ startBp: 0, endBp: 100 }],
    pages: [],
    ...overrides,
  };
}

function lifecycleHost(
  overrides: Partial<ResidentPageLifecycleHost> = {}
): ResidentPageLifecycleHost {
  const host: ResidentPageLifecycleHost = {
    genomeLength: 100,
    maxAnnotationLane: 0,
    maxCdsLane: -1,
    prepackedAnnotationPolicyGeneration: 3,
    prepackedAnnotationRuntimePolicy: null,
    prepackedResidentPolicyFeatureIndexCache: new Map(),
    annotationLayerTypesForPresentation() {
      return ['mRNA'];
    },
    prepackedAnnotationSceneResidentForTrack() {
      return null;
    },
    compiledBroadSurfaceLaneStart() {
      return 0;
    },
    currentGenomeIdentity: 'src',
    annotationResidentPageStreams: new Map(),
    annotationResidentPageStore: null,
    activeAnnotationResidentPageStreamKey: null,
    residentAnnotationViewportSelectionCache: null,
    residentAnnotationPageSnapshotApplies: 0,
    residentAnnotationPageFlatGraphSkips: 0,
    annotationRequestedLayerTypes: [],
    annotationExactCoverage: [],
    prepackedAnnotationSceneInput: null,
    features: [
      {
        id: 99,
        type: 'gene',
        start: 0,
        end: 1,
        direction: 'none',
        color: 0,
        lane: 0,
        displayName: 'fallback',
      },
    ],
    residentAnnotationViewportSelectionStatus: 'unavailable',
    residentAnnotationViewportSelectedPageCount: 0,
    residentAnnotationViewportSelectedFeatureCount: 0,
    residentAnnotationViewportExpectedPageCount: 0,
    residentAnnotationViewportMissingPageCount: 0,
    residentAnnotationViewportCoverageComplete: false,
    residentAnnotationViewportProducerCoverageComplete: false,
    residentAnnotationViewportSelectionQueries: 0,
    reconcileAnnotationLaneEnvelopeAuthority() {},
    commitAnnotationLaneEnvelope() {},
    residentAnnotationPolicyProjectionKey(focus) {
      return residentAnnotationPolicyProjectionKey(host, focus);
    },
    projectResidentAnnotationFeatures() {
      return [];
    },
    ...overrides,
  };
  return host;
}

describe('indexed annotation resident pages', () => {
  const policyFeature = (
    overrides: Partial<PrepackedAnnotationInteractionFeatureInputV2> = {}
  ): PrepackedAnnotationInteractionFeatureInputV2 => ({
    rendererId: 1,
    startBp: 100,
    endBp: 300,
    lane: 0,
    direction: 'forward',
    displayName: 'compiled display name',
    type: 'mRNA',
    transcriptId: 'NM_TARGET.1',
    sourceId: 'compiled-source',
    canonicalIdentity: 'compiled-target',
    ...overrides,
  });
  const residentFeature = (overrides: Partial<Feature> = {}): Feature => ({
    id: 999,
    type: 'mRNA',
    start: 100,
    end: 300,
    direction: 'forward',
    displayName: 'resident display name',
    transcriptId: 'NM_TARGET.1',
    color: 0,
    lane: 0,
    ...overrides,
  });
  const resident = (
    features: PrepackedAnnotationInteractionFeatureInputV2[]
  ): ResidentPageFeatureResident => ({
    ownerKey: 'compiled-owner',
    input: {
      interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
        features,
        features.map((_, featureIndex) => ({ featureIndex }))
      ),
    },
  });

  it.each([31, 255])(
    'resolves a cold resident identity without decoding %i irrelevant overlapping features',
    (overlapCount) => {
      const features = Array.from({ length: overlapCount }, (_, index) =>
        policyFeature({
          rendererId: index + 10,
          startBp: index % 2 === 0 ? 0 : 100,
          endBp: index % 2 === 0 ? 1_000 : 300,
          direction: index % 2 === 0 ? 'forward' : 'reverse',
          transcriptId: `NM_OTHER_${index}.1`,
          sourceId: `other-source-${index}`,
          canonicalIdentity: `compiled-other-${index}`,
        })
      );
      features.push(policyFeature());
      const owner = resident(features);
      const host = lifecycleHost({ genomeLength: 2_000 });
      const feature = residentFeature();
      const decode = vi.spyOn(TextDecoder.prototype, 'decode');
      try {
        expect(
          prepackedPolicyFeatureIndexForResidentFeature(host, owner, feature, 'resident-target')
        ).toBe(overlapCount);
        expect
          .soft(decode.mock.calls.length)
          .toBeLessThanOrEqual(Math.ceil(Math.log2(features.length + 1)) + 2);
        decode.mockClear();
        expect(
          prepackedPolicyFeatureIndexForResidentFeature(host, owner, feature, 'resident-target')
        ).toBe(overlapCount);
        expect(decode).not.toHaveBeenCalled();
      } finally {
        decode.mockRestore();
      }
    }
  );

  it('keeps ambiguous resident identity tuples unresolved and caches the rejection', () => {
    const owner = resident([
      policyFeature(),
      policyFeature({
        rendererId: 2,
        sourceId: 'another-source',
        canonicalIdentity: 'another-canonical-target',
      }),
    ]);
    const host = lifecycleHost({ genomeLength: 2_000 });
    const feature = residentFeature();
    expect(
      prepackedPolicyFeatureIndexForResidentFeature(host, owner, feature, 'resident-target')
    ).toBeNull();
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      expect(
        prepackedPolicyFeatureIndexForResidentFeature(host, owner, feature, 'resident-target')
      ).toBeNull();
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it('uses the display name only when a resident has no transcript identity', () => {
    const owner = resident([policyFeature({ transcriptId: null })]);
    const host = lifecycleHost({ genomeLength: 2_000 });
    expect(
      prepackedPolicyFeatureIndexForResidentFeature(
        host,
        owner,
        residentFeature({ transcriptId: undefined, displayName: 'compiled display name' }),
        'resident-name-match'
      )
    ).toBe(0);
    expect(
      prepackedPolicyFeatureIndexForResidentFeature(
        host,
        owner,
        residentFeature({ transcriptId: undefined }),
        'resident-name-miss'
      )
    ).toBeNull();
  });

  it('builds a source-page projection key until a runtime policy is set', () => {
    const host = lifecycleHost({
      prepackedAnnotationSceneResidentForTrack(trackId) {
        return trackId === 'mRNA' ? { ownerKey: 'owner-a', input: {} } : null;
      },
    });
    expect(residentAnnotationPolicyProjectionKey(host, null)).toBe(
      ['source-page-lanes', 'mRNA:owner-a', 'annotation-search-focus:none'].join('\u0000')
    );

    host.prepackedAnnotationRuntimePolicy = { isoformMode: 'canonical', laneLimit: 12 };
    expect(
      residentAnnotationPolicyProjectionKey(host, {
        trackId: 'mRNA',
        canonicalIdentity: 'gene.1',
      })
    ).toBe(
      [
        'annotation-runtime-policy.v1',
        'mRNA:owner-a',
        3,
        'canonical',
        12,
        'annotation-search-focus.v1',
        'mRNA',
        'gene.1',
        'ordinary-overlay',
      ].join('\u0000')
    );
  });

  it('rejects ingest without a genome and applies an empty valid publication', () => {
    expect(
      ingestAnnotationResidentPages(lifecycleHost({ currentGenomeIdentity: null }), publication())
    ).toEqual({ status: 'rejected', reason: 'no-genome' });

    const host = lifecycleHost();
    expect(selectResidentAnnotationFeaturesForViewport(host, 0, 10)).toEqual({
      status: 'unavailable',
      key: null,
      features: host.features,
    });

    expect(ingestAnnotationResidentPages(host, publication())).toEqual({
      status: 'applied',
      generation: 1,
      invalidatedHover: true,
    });
    expect(host.annotationRequestedLayerTypes).toEqual(['CDS', 'mRNA']);
    expect(host.annotationExactCoverage).toEqual([{ startBp: 0, endBp: 100 }]);
    expect(host.residentAnnotationPageSnapshotApplies).toBe(1);
    expect(host.activeAnnotationResidentPageStreamKey).toBe('src\u0000pol');

    const selected = selectResidentAnnotationFeaturesForViewport(host, 0, 10);
    expect(selected.status).toBe('ready');
    expect(selected.features).toEqual([]);
  });

  it('reports the coverage of a cached ready selection after an uncovered lookup', () => {
    const host = lifecycleHost({ genomeLength: 100_000 });
    expect(
      ingestAnnotationResidentPages(
        host,
        publication({
          genomeLengthBp: 100_000,
          exactCoverage: [{ startBp: 0, endBp: 40_000 }],
        })
      ).status
    ).toBe('applied');
    const coverage = () => ({
      status: host.residentAnnotationViewportSelectionStatus,
      expectedPageCount: host.residentAnnotationViewportExpectedPageCount,
      missingPageCount: host.residentAnnotationViewportMissingPageCount,
      coverageComplete: host.residentAnnotationViewportCoverageComplete,
      producerCoverageComplete: host.residentAnnotationViewportProducerCoverageComplete,
    });

    expect(selectResidentAnnotationFeaturesForViewport(host, 0, 10).status).toBe('ready');
    const covered = coverage();
    expect(covered).toEqual({
      status: 'ready',
      expectedPageCount: 0,
      missingPageCount: 0,
      coverageComplete: true,
      producerCoverageComplete: true,
    });

    expect(selectResidentAnnotationFeaturesForViewport(host, 50_000, 50_010).status).toBe(
      'incomplete'
    );
    expect(coverage()).toMatchObject({
      status: 'incomplete',
      coverageComplete: false,
      producerCoverageComplete: false,
    });

    const queries = host.residentAnnotationViewportSelectionQueries;
    expect(selectResidentAnnotationFeaturesForViewport(host, 0, 10).status).toBe('ready');
    expect(host.residentAnnotationViewportSelectionQueries).toBe(queries);
    expect(coverage()).toEqual(covered);
  });
});
