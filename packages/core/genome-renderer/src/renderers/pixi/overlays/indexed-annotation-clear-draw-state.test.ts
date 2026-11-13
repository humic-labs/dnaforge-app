import { describe, expect, it } from 'vitest';
import { emptyAnnotationBodyPresenterEligibility } from './annotation-body-presentation-authority';
import {
  clearDrawState,
  resetAllPresentersToHidden,
  type ClearDrawStateHost,
  type ResetPresentersHost,
} from './indexed-annotation-clear-draw-state';

function graphics() {
  return {
    visible: true,
    clearCount: 0,
    clear() {
      this.clearCount += 1;
    },
    hide() {
      this.visible = false;
    },
  };
}

describe('indexed annotation clear draw state', () => {
  it('clears and hides immediate draw surfaces', () => {
    const g = graphics();
    const decoration = { visible: true };
    const focus = graphics();
    const interaction = graphics();
    const outlineCache = new Map([[1, [{ kind: 'poly' as const, pts: [0, 0, 1, 0, 1, 1] }]]]);
    const curvedLabels = {
      resetCount: 0,
      reset() {
        this.resetCount += 1;
      },
    };
    let decorationCleared = 0;
    const host = {
      graphics: g,
      retainedTranscriptDecorationGraphics: decoration,
      annotationSearchFocusGraphics: focus,
      interactionGraphics: interaction,
      labelIndex: 4,
      curvedLabels,
      labelPool: [{ visible: true }, { visible: true }],
      hitCache: [{ id: 1 }],
      outlineCache,
      labelOccupancyCache: [1],
      overviewBinDrawCount: 3,
      lastInteractionOutlineCommandCount: 2,
      annotationSearchFocusMaskDrawCount: 1,
      annotationSearchFocusPrimitiveDrawCount: 1,
      annotationSearchFocusResolvedTrackId: 'mRNA',
      annotationSearchFocusResolvedCanonicalIdentity: 'gene.1',
      annotationSearchFocusPresentationLane: 2,
      clearDecorationCache() {
        decorationCleared += 1;
      },
    } as unknown as ClearDrawStateHost;

    clearDrawState(host);

    expect(g.clearCount).toBe(1);
    expect(g.visible).toBe(false);
    expect(decoration.visible).toBe(false);
    expect(focus.clearCount).toBe(1);
    expect(focus.visible).toBe(false);
    expect(interaction.clearCount).toBe(1);
    expect(interaction.visible).toBe(false);
    expect(host.labelIndex).toBe(0);
    expect(curvedLabels.resetCount).toBe(1);
    expect(host.labelPool.every((label) => label.visible === false)).toBe(true);
    expect(host.hitCache).toEqual([]);
    expect(outlineCache.size).toBe(0);
    expect(host.labelOccupancyCache).toEqual([]);
    expect(host.overviewBinDrawCount).toBe(0);
    expect(host.lastInteractionOutlineCommandCount).toBe(0);
    expect(host.annotationSearchFocusResolvedTrackId).toBeNull();
    expect(host.annotationSearchFocusResolvedCanonicalIdentity).toBeNull();
    expect(host.annotationSearchFocusPresentationLane).toBeNull();
    expect(decorationCleared).toBe(1);
  });

  it('hides every presenter and clears the body-frame owner', () => {
    const hidden: string[] = [];
    const hide = (name: string) => () => {
      hidden.push(name);
    };
    const host: ResetPresentersHost = {
      compiledBroadSurfacePresenter: { hide: hide('compiled') },
      compiledBroadSurfaceCandidatePresenter: { hide: hide('compiled-candidate') },
      compiledBroadSurfaceTrackOwners: new Map([
        ['mRNA', { presenter: { hide: hide('track-owner') } }],
      ]),
      compiledBroadSurfaceTrackCandidateOwners: new Map([
        ['mRNA', { presenter: { hide: hide('track-candidate') } }],
      ]),
      genomeWideTextureCacheLayer: { hide: hide('texture') },
      tilePyramid: { hide: hide('tiles') },
      sidecarRaster: { hide: hide('sidecar') },
      retainedOverviewLayer: { hide: hide('overview') },
      retainedLinearFeatureLayer: { hide: hide('feature') },
      retainedLinearTranscriptLayer: { hide: hide('transcript') },
      prepackedAnnotationSceneResidents: new Map([['mRNA', { layer: { hide: hide('resident') } }]]),
      prepackedAnnotationSceneReplacementCandidates: new Map([
        ['mRNA', { layer: { hide: hide('replacement') } }],
      ]),
      retainedTranscriptDecorationGraphics: { visible: true },
      annotationBodyFrameOwner: 'prepacked-vector',
      annotationBodyFrameEligibility: {
        'compiled-broad': true,
        'prepacked-vector': true,
        'tile-pyramid': false,
        'prebuilt-raster': false,
        'retained-immediate': false,
      },
    };

    resetAllPresentersToHidden(host);

    expect(hidden).toEqual([
      'compiled',
      'compiled-candidate',
      'track-owner',
      'track-candidate',
      'texture',
      'tiles',
      'sidecar',
      'overview',
      'feature',
      'transcript',
      'resident',
      'replacement',
    ]);
    expect(host.retainedTranscriptDecorationGraphics.visible).toBe(false);
    expect(host.annotationBodyFrameOwner).toBe('none');
    expect(host.annotationBodyFrameEligibility).toEqual(emptyAnnotationBodyPresenterEligibility());
  });

  it('preserves only the incumbent broad surface during a pending replacement', () => {
    const hidden: string[] = [];
    const hide = (name: string) => () => {
      hidden.push(name);
    };
    const host: ResetPresentersHost = {
      compiledBroadSurfacePresenter: { hide: hide('compiled') },
      compiledBroadSurfaceCandidatePresenter: { hide: hide('compiled-candidate') },
      compiledBroadSurfaceTrackOwners: new Map([
        ['mRNA', { presenter: { hide: hide('track-owner') } }],
      ]),
      compiledBroadSurfaceTrackCandidateOwners: new Map([
        ['mRNA', { presenter: { hide: hide('track-candidate') } }],
      ]),
      genomeWideTextureCacheLayer: { hide: hide('texture') },
      tilePyramid: { hide: hide('tiles') },
      sidecarRaster: { hide: hide('sidecar') },
      retainedOverviewLayer: { hide: hide('overview') },
      retainedLinearFeatureLayer: { hide: hide('feature') },
      retainedLinearTranscriptLayer: { hide: hide('transcript') },
      prepackedAnnotationSceneResidents: new Map(),
      prepackedAnnotationSceneReplacementCandidates: new Map(),
      retainedTranscriptDecorationGraphics: { visible: true },
      annotationBodyFrameOwner: 'compiled-broad',
      annotationBodyFrameEligibility: emptyAnnotationBodyPresenterEligibility(),
    };

    resetAllPresentersToHidden(host, { preserveCommittedCompiledBroadSurface: true });

    expect(hidden).toEqual([
      'compiled-candidate',
      'track-candidate',
      'texture',
      'tiles',
      'sidecar',
      'overview',
      'feature',
      'transcript',
    ]);
  });
});
