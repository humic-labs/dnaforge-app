import { describe, expect, it } from 'vitest';
import { createAnnotationBodyPresentationGenerationV1 } from './annotation-body-presentation-authority';
import {
  noteAnnotationBodyPresentationCommit,
  type BodyCommitHost,
} from './indexed-annotation-body-commit';

function commitHost(overrides: Partial<BodyCommitHost> = {}): BodyCommitHost {
  const host: BodyCommitHost = {
    maxAnnotationLane: 3,
    prepackedAnnotationRuntimePolicy: { isoformMode: 'canonical', laneLimit: 4 },
    annotationBodyFrameOwner: 'prepacked-vector',
    annotationBodyPresentationGeneration: null,
    currentAnnotationSourceFingerprint: 'src-fp',
    currentAnnotationPlacementFingerprint: 'place-fp',
    annotationBodyPresentationCommitEpoch: 0,
    prepackedAnnotationSceneResidents: new Map([
      [
        'mRNA',
        {
          ownerKey: 'owner-mRNA',
          metadata: { trackType: 'mRNA' },
          layer: { isPresenting: true },
        },
      ],
    ]),
    annotationLayerTypesForPresentation() {
      return ['mRNA'];
    },
    annotationBodyProductFingerprintsMatchCurrentGeneration(
      current,
      _productKind,
      _orderedVisibleTrackIds,
      next
    ) {
      const expected = next ?? ['owner-mRNA'];
      return (
        current.length === expected.length && current.every((fp, index) => fp === expected[index])
      );
    },
    compiledBroadSurfaceOwnerForTrack(trackId) {
      return trackId === 'mRNA' ? { manifest: { manifestFingerprint: 'manifest-mRNA' } } : null;
    },
    ...overrides,
  };
  return host;
}

describe('indexed annotation body commit', () => {
  it('writes a generation on the first commit and no-ops an identical follow-up', () => {
    const host = commitHost();
    noteAnnotationBodyPresentationCommit(host);
    expect(host.annotationBodyPresentationCommitEpoch).toBe(1);
    expect(host.annotationBodyPresentationGeneration).toEqual(
      createAnnotationBodyPresentationGenerationV1({
        commitEpoch: 1,
        orderedVisibleTrackIds: ['mRNA'],
        policy: { isoformMode: 'canonical', laneLimit: 4 },
        sourceFingerprint: 'src-fp',
        placementFingerprint: 'place-fp',
        productKind: 'prepacked-vector',
        productFingerprints: ['owner-mRNA'],
      })
    );

    const generation = host.annotationBodyPresentationGeneration;
    noteAnnotationBodyPresentationCommit(host);
    expect(host.annotationBodyPresentationGeneration).toBe(generation);
    expect(host.annotationBodyPresentationCommitEpoch).toBe(1);
  });

  it('advances the epoch when product fingerprints change', () => {
    const host = commitHost();
    noteAnnotationBodyPresentationCommit(host);
    noteAnnotationBodyPresentationCommit(host, {
      productKind: 'compiled-broad',
      productFingerprints: ['manifest-mRNA'],
    });
    expect(host.annotationBodyPresentationCommitEpoch).toBe(2);
    expect(host.annotationBodyPresentationGeneration?.productKind).toBe('compiled-broad');
    expect(host.annotationBodyPresentationGeneration?.productFingerprints).toEqual([
      'manifest-mRNA',
    ]);
  });
});
