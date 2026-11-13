import { describe, expect, it } from 'vitest';
import type { PathMapper } from '../shared/path-mapper';
import type { RetainedOverlayCameraState } from './overlay-track';
import {
  emptyAnnotationBodyPresenterEligibility,
  type AnnotationBodyPresenterEligibility,
} from './annotation-body-presentation-authority';
import {
  annotationBodyProductFingerprintsMatchCurrentGeneration,
  noteAnnotationBodyFrameOwner,
  OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP,
  probeAnnotationBodyPresenterEligibility,
  type BodyOwnerHost,
  type BodyProbeHost,
} from './indexed-annotation-body-owner';

function ownerHost(overrides: Partial<BodyOwnerHost> = {}): BodyOwnerHost {
  return {
    annotationBodyFrameOwner: null,
    annotationBodyFrameEligibility: emptyAnnotationBodyPresenterEligibility(),
    compiledBroadSurfaceManifestFingerprintForTrack: () => null,
    prepackedAnnotationSceneResidents: new Map(),
    noteAnnotationBodyPresentationCommit() {},
    ...overrides,
  };
}

function probeHost(overrides: Partial<BodyProbeHost> = {}): BodyProbeHost {
  return {
    annotationLayerTypesForPresentation: () => ['mRNA'],
    compiledBroadSurfaceRequirement: null,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceCandidatePresenter: null,
    compiledBroadSurfaceTrackOwners: { size: 0 },
    compiledBroadSurfaceTrackCandidateOwners: { size: 0 },
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationSceneResidents: { size: 0 },
    prepackedAnnotationSceneLastCompleteOwnerKeys: [],
    prepackedAnnotationSceneInput: null,
    prepackedAnnotationSceneStatus: 'not-loaded',
    genomeWideTextureCacheLayer: null,
    genomeLength: 1_000_000,
    tilePyramid: { vector: null },
    ...overrides,
  };
}

function camera(viewStartBp: number, viewEndBp: number): RetainedOverlayCameraState {
  return {
    path: { viewStartBp, viewEndBp } as PathMapper,
    state: {
      morph: 0,
      viewOffset: 0,
      zoom: 1,
      width: 800,
      height: 400,
      selectedIds: new Set(),
      hoveredId: null,
      highlightRange: null,
      cursorPosition: null,
      hoveredCutSiteId: null,
      perfPanelVisible: false,
    },
    yOffset: 0,
    height: 200,
  };
}

describe('indexed annotation body owner', () => {
  it('matches explicit fingerprints and compiled-broad track fingerprints', () => {
    const host = ownerHost({
      compiledBroadSurfaceManifestFingerprintForTrack(trackId) {
        return trackId === 'mRNA' ? 'manifest-mRNA' : null;
      },
    });
    expect(
      annotationBodyProductFingerprintsMatchCurrentGeneration(
        host,
        ['a', 'b'],
        'compiled-broad',
        ['mRNA'],
        ['a', 'b']
      )
    ).toBe(true);
    expect(
      annotationBodyProductFingerprintsMatchCurrentGeneration(
        host,
        ['a', 'b'],
        'compiled-broad',
        ['mRNA'],
        ['a']
      )
    ).toBe(false);
    expect(
      annotationBodyProductFingerprintsMatchCurrentGeneration(
        host,
        ['manifest-mRNA'],
        'compiled-broad',
        ['mRNA'],
        undefined
      )
    ).toBe(true);
    expect(
      annotationBodyProductFingerprintsMatchCurrentGeneration(
        host,
        ['stale'],
        'compiled-broad',
        ['mRNA'],
        undefined
      )
    ).toBe(false);
    expect(
      annotationBodyProductFingerprintsMatchCurrentGeneration(
        host,
        [],
        'tile-pyramid',
        ['mRNA'],
        undefined
      )
    ).toBe(true);
  });

  it('matches case-distinct prepacked body owners by exact scientific identity', () => {
    const host = ownerHost({
      prepackedAnnotationSceneResidents: new Map([
        [
          'lower',
          {
            ownerKey: 'owner-lower',
            metadata: { trackType: 'transposon:Dm88' },
            layer: { isPresenting: true },
          },
        ],
        [
          'upper',
          {
            ownerKey: 'owner-upper',
            metadata: { trackType: 'transposon:DM88' },
            layer: { isPresenting: true },
          },
        ],
      ]),
    });

    expect(
      annotationBodyProductFingerprintsMatchCurrentGeneration(
        host,
        ['owner-lower', 'owner-upper'],
        'prepacked-vector',
        ['transposon:Dm88', 'transposon:DM88'],
        undefined
      )
    ).toBe(true);
    expect(
      annotationBodyProductFingerprintsMatchCurrentGeneration(
        host,
        ['owner-lower'],
        'prepacked-vector',
        ['transposon:dm88'],
        undefined
      )
    ).toBe(false);
  });

  it('commits an unchanged owner and installs eligibility for a new owner', () => {
    const commits: Array<{ productKind?: string }> = [];
    const host = ownerHost({
      annotationBodyFrameOwner: 'prepacked-vector',
      noteAnnotationBodyPresentationCommit(input) {
        commits.push(input ?? {});
      },
    });
    noteAnnotationBodyFrameOwner(host, 'prepacked-vector');
    expect(commits).toEqual([{ productKind: 'prepacked-vector' }]);
    expect(host.annotationBodyFrameOwner).toBe('prepacked-vector');

    noteAnnotationBodyFrameOwner(host, 'compiled-broad');
    expect(host.annotationBodyFrameOwner).toBe('compiled-broad');
    expect(host.annotationBodyFrameEligibility['compiled-broad']).toBe(true);
    expect(host.annotationBodyFrameEligibility['prepacked-vector']).toBe(false);
    expect(commits).toEqual([
      { productKind: 'prepacked-vector' },
      { productKind: 'compiled-broad' },
    ]);

    noteAnnotationBodyFrameOwner(host, 'none');
    expect(host.annotationBodyFrameOwner).toBe('none');
    expect(commits).toHaveLength(2);
  });

  it('probes compiled-broad eligibility when a broad product exists', () => {
    const eligibility: AnnotationBodyPresenterEligibility = probeAnnotationBodyPresenterEligibility(
      probeHost({ compiledBroadSurfaceRequirement: { ok: true } }),
      camera(0, 1_000),
      { eligible: false },
      false
    );
    expect(eligibility['compiled-broad']).toBe(true);
    expect(eligibility['prepacked-vector']).toBe(false);
    expect(eligibility['prebuilt-raster']).toBe(false);
    expect(eligibility['tile-pyramid']).toBe(false);

    const prebuilt = probeAnnotationBodyPresenterEligibility(
      probeHost({
        compiledBroadSurfaceRequirement: null,
        genomeWideTextureCacheLayer: { hasPrebuilt: () => true },
      }),
      camera(0, OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP + 1),
      { eligible: true },
      false
    );
    expect(prebuilt['prebuilt-raster']).toBe(true);
    expect(prebuilt['prepacked-vector']).toBe(false);
  });
});
