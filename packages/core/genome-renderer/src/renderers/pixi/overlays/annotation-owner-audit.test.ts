import { describe, expect, it } from 'vitest';

import {
  annotationOwnerAuditFrameFromPresentation,
  appendAnnotationOwnerAuditFrame,
  sampleFineViewPrewarmForOwnerAudit,
  type AnnotationOwnerAuditFrame,
  type AnnotationOwnerAuditRing,
} from './annotation-owner-audit';
import {
  buildAnnotationPresentationDebug,
  type AnnotationPresentationDebugInput,
} from './annotation-presentation-debug';

function input(overrides: Partial<AnnotationPresentationDebugInput> = {}) {
  return {
    requestedLayerTypes: ['mRNA'],
    presentationVisible: true,
    genomeLength: 10_000,
    lastDrawAuditRange: {
      viewStartBp: 100,
      viewEndBp: 1_100,
    },
    runtimeGenomeWideTextureVisible: false,
    prebuiltGenomeWideTextureVisible: false,
    prebuiltGenomeWideTextureEligible: false,
    retainedLinearVisibleMeshCount: 0,
    retainedTranscriptVisibleBlockCount: 0,
    tilePyramidVectorVisibleLayerCount: 0,
    tilePyramidVectorPresenting: false,
    tilePyramidVectorPresentingBlockCount: 0,
    tilePyramidVectorCoverageLevel: null,
    tilePyramidVectorVisibleTileFirst: null,
    tilePyramidVectorVisibleTileLast: null,
    tilePyramidVectorExpectedVisibleTileCount: 0,
    tilePyramidVectorBuiltVisibleTileCount: 0,
    tilePyramidVectorMissingVisibleTileCount: 0,
    tilePyramidVectorCoverageComplete: false,
    overviewGlyphTilesPresenting: false,
    overviewGlyphTilesVisibleTileCount: 0,
    overviewGlyphTilesCoverageComplete: false,
    immediateGraphicsVisible: false,
    lastDrawnFeatureCount: 0,
    immediateDrawnLayerTypes: [],
    ...overrides,
  } satisfies AnnotationPresentationDebugInput;
}

function frame(overrides: Partial<AnnotationPresentationDebugInput> = {}) {
  return annotationOwnerAuditFrameFromPresentation(
    buildAnnotationPresentationDebug(input(overrides)),
    {
      presentedAtMs: 0,
      themeMode: 'dark',
      hoveredFeatureId: null,
      immediatePresenting: overrides.immediateGraphicsVisible === true,
      immediateDrawnCount: overrides.lastDrawnFeatureCount ?? 0,
      immediateTranscriptDrawnCount: 0,
      cameraStartBp: overrides.lastDrawAuditRange?.viewStartBp ?? 100,
      cameraEndBp: overrides.lastDrawAuditRange?.viewEndBp ?? 1_100,
      compiledBroadCameraOwned: null,
      compiledBroadPlanStatus: 'not-loaded',
      prepackedFinePendingReason: null,
      prepackedSceneStatus: 'not-loaded',
      prepackedResidentOwnerCount: 0,
      prepackedLastCompleteOwnerCount: 0,
      prepackedReplacementCandidateCount: 0,
      prepackedReplacementCoverageStartBp: null,
      prepackedReplacementCoverageEndBp: null,
      prepackedReplacementPresentationAdmitted: null,
      prepackedReplacementFineViewsPrewarmed: null,
    }
  );
}

describe('annotationOwnerAuditFrameFromPresentation', () => {
  it('flags duplicate exact source-shape owners that the old transcript-only audit missed', () => {
    const audit = frame({
      requestedLayerTypes: ['enhancer'],
      retainedLinearVisibleMeshCount: 2,
      immediateGraphicsVisible: true,
      lastDrawnFeatureCount: 1,
      immediateDrawnLayerTypes: ['enhancer'],
    });

    expect(audit.doubleDraw).toBe(true);
    expect(audit.ownerViolations).toContain(
      'duplicate-exact-annotation-owner:source-shape:active-segment-retained-surface+single-chrom-live-surface'
    );
  });

  it('does not call independent transcript and source-shape owners a double-draw', () => {
    const audit = frame({
      requestedLayerTypes: ['mRNA', 'enhancer'],
      retainedLinearVisibleMeshCount: 3,
      tilePyramidVectorPresenting: true,
      tilePyramidVectorVisibleLayerCount: 1,
      tilePyramidVectorPresentingBlockCount: 2,
      tilePyramidVectorExpectedVisibleTileCount: 2,
      tilePyramidVectorBuiltVisibleTileCount: 2,
      tilePyramidVectorCoverageComplete: true,
    });

    expect(audit.presentingCount).toBe(2);
    expect(audit.doubleDraw).toBe(false);
  });

  it('flags a detail raster floor that remains visible under an exact transcript owner', () => {
    const audit = frame({
      prebuiltGenomeWideTextureVisible: true,
      prebuiltGenomeWideTextureLayerTypes: ['mRNA'],
      retainedTranscriptVisibleBlockCount: 1,
    });

    expect(audit.doubleDraw).toBe(true);
    expect(audit.ownerViolations).toContain(
      'floor-overlaps-exact-annotation-owner:transcript-body:compiled-raster-surface+active-segment-retained-surface'
    );
  });

  it('records the current camera and broad-owner legality on the exact renderer frame', () => {
    const audit = annotationOwnerAuditFrameFromPresentation(
      buildAnnotationPresentationDebug(
        input({
          compiledBroadRasterVisible: true,
          compiledBroadRasterLayerTypes: ['mRNA'],
          compiledBroadRasterCoverageComplete: true,
        })
      ),
      {
        presentedAtMs: 12.5,
        themeMode: 'dark',
        hoveredFeatureId: 42,
        immediatePresenting: false,
        immediateDrawnCount: 0,
        immediateTranscriptDrawnCount: 0,
        cameraStartBp: 4_000,
        cameraEndBp: 4_400,
        compiledBroadCameraOwned: false,
        compiledBroadPlanStatus: 'broad-holding-last-good',
        prepackedFinePendingReason: 'viewport-coverage',
        prepackedSceneStatus: 'fine-view-pending',
        prepackedResidentOwnerCount: 2,
        prepackedLastCompleteOwnerCount: 0,
        prepackedReplacementCandidateCount: 2,
        prepackedReplacementCoverageStartBp: 3_000,
        prepackedReplacementCoverageEndBp: 5_000,
        prepackedReplacementPresentationAdmitted: false,
        prepackedReplacementFineViewsPrewarmed: true,
      }
    );

    expect(audit.cameraStartBp).toBe(4_000);
    expect(audit.presentedAtMs).toBe(12.5);
    expect(audit.themeMode).toBe('dark');
    expect(audit.hoveredFeatureId).toBe(42);
    expect(audit.cameraEndBp).toBe(4_400);
    expect(audit.cameraSpanBp).toBe(400);
    expect(audit.compiledBroadCameraOwned).toBe(false);
    expect(audit.compiledBroadPlanStatus).toBe('broad-holding-last-good');
    expect(audit.prepackedFinePendingReason).toBe('viewport-coverage');
    expect(audit.prepackedSceneStatus).toBe('fine-view-pending');
    expect(audit.prepackedResidentOwnerCount).toBe(2);
    expect(audit.prepackedLastCompleteOwnerCount).toBe(0);
    expect(audit.prepackedReplacementCandidateCount).toBe(2);
    expect(audit.prepackedReplacementCoverageStartBp).toBe(3_000);
    expect(audit.prepackedReplacementCoverageEndBp).toBe(5_000);
    expect(audit.prepackedReplacementPresentationAdmitted).toBe(false);
    expect(audit.prepackedReplacementFineViewsPrewarmed).toBe(true);
  });
});

describe('appendAnnotationOwnerAuditFrame', () => {
  it('uses bounded O(1) circular replacement instead of shifting the DEV cadence ring', () => {
    const makeFrame = (id: number): AnnotationOwnerAuditFrame => ({
      presentedAtMs: id,
      themeMode: 'dark',
      hoveredFeatureId: null,
      presenting: [`owner-${id}`],
      presentingCount: 1,
      doubleDraw: false,
      ownerViolations: [],
      immediatePresenting: false,
      immediateDrawnCount: 0,
      immediateTranscriptDrawnCount: 0,
      cameraStartBp: 0,
      cameraEndBp: 1_000,
      cameraSpanBp: 1_000,
      compiledBroadCameraOwned: null,
      compiledBroadPlanStatus: 'not-loaded',
      prepackedFinePendingReason: null,
      prepackedSceneStatus: 'not-loaded',
      prepackedResidentOwnerCount: 0,
      prepackedLastCompleteOwnerCount: 0,
      prepackedReplacementCandidateCount: 0,
      prepackedReplacementCoverageStartBp: null,
      prepackedReplacementCoverageEndBp: null,
      prepackedReplacementPresentationAdmitted: null,
      prepackedReplacementFineViewsPrewarmed: null,
    });
    const ring: AnnotationOwnerAuditRing = { frames: [], maxFrames: 3 };
    const shift = ring.frames.shift;

    for (let id = 0; id < 5; id += 1) appendAnnotationOwnerAuditFrame(ring, makeFrame(id));

    expect(ring.frames).toHaveLength(3);
    expect(ring.frames.shift).toBe(shift);
    expect(ring.totalFrames).toBe(5);
    expect(ring.writeIndex).toBe(2);
    expect(ring.latestFrame?.presenting).toEqual(['owner-4']);
    expect(ring.frames.map(({ presenting }) => presenting[0])).toEqual([
      'owner-3',
      'owner-4',
      'owner-2',
    ]);
  });
});

describe('sampleFineViewPrewarmForOwnerAudit', () => {
  it('normalizes a fractional camera before calling the strict fine-view planner', () => {
    const samples: Array<readonly [number, number]> = [];

    const result = sampleFineViewPrewarmForOwnerAudit({
      cameraStartBp: 10.75,
      cameraEndBp: 99.25,
      genomeLengthBp: 1_000,
      sample: (startBp, endBp) => {
        samples.push([startBp, endBp]);
        return true;
      },
    });

    expect(result).toBe(true);
    expect(samples).toEqual([[10, 100]]);
  });

  it('cannot turn a diagnostic accessor failure into a renderer frame failure', () => {
    expect(
      sampleFineViewPrewarmForOwnerAudit({
        cameraStartBp: 10,
        cameraEndBp: 100,
        genomeLengthBp: 1_000,
        sample: () => {
          throw new Error('diagnostic accessor rejected sample');
        },
      })
    ).toBeNull();
  });
});
