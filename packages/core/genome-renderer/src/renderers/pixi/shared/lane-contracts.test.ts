import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OverlayTrack } from '../overlays/overlay-track';
import { getStadiumDimensions } from '../../../geometry/stadium';
import {
  computeSequenceRevealMetrics,
  computeUnifiedLayout,
  primerFeatureLaneScaleForPixelsPerBp,
  type UnifiedLayout,
} from './track-layout';
import {
  ANNOTATION_BAR_HEIGHT,
  ANNOTATION_LANE_TOTAL,
  CANVAS_PRIMER_ARROW_HEIGHT,
  CANVAS_PRIMER_ARROW_WIDTH,
  CANVAS_PRIMER_TRACK_HEIGHT,
  annotationSlotBounds,
  collapsedPrimerScreenMetrics,
  getInteractionLaneEnvelope,
  getAnnotationLaneEnvelope,
  getTrackLaneEnvelope,
  computePrimerTrackHeightForLayout,
  getPrimerLaneEnvelope,
  laneContractStackBounds,
  primerScreenMetricsForReveal,
  primerSlotBounds,
  resolveCutSiteTrackContract,
  resolveInteractionOverlayContract,
  resolveLaneContractSnapshot,
  resolveAnnotationTrackContract,
  resolvePrimerTrackContract,
  resolveRulerTrackContract,
  resolveSequenceTrackContract,
  requireTrackLaneEnvelope,
  rulerBounds,
  sequenceProtectedBounds,
  validateLaneContract,
  type TrackContract,
} from './lane-contracts';
import type { Genome, RenderState } from '../../../types';

function createState(): RenderState {
  return {
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
  };
}

function createGenome(circular: boolean): Genome {
  return {
    name: circular ? 'circular-contract-test' : 'linear-contract-test',
    length: 1000,
    circular,
    features: [],
    sequence: 'A'.repeat(1000),
  };
}

function createPrimerOverlayStub(inputs: {
  maxOverviewLane: number;
  maxForwardLane: number;
  maxReverseLane: number;
  sequenceViewportSpanPx: number;
}): OverlayTrack {
  return {
    id: 'primers',
    displayName: 'Primers',
    position: 'below',
    sortOrder: 100,
    enabled: true,
    container: {} as OverlayTrack['container'],
    computeHeight: (genome, state, pixelsPerBp) => {
      const compactScale = Math.max(0.5, Math.min(1, state.height / 600));
      const reveal = computeSequenceRevealMetrics(
        !!genome.sequence,
        pixelsPerBp,
        inputs.sequenceViewportSpanPx
      );
      const primerFeatureLaneScale = primerFeatureLaneScaleForPixelsPerBp(
        pixelsPerBp,
        reveal.sequenceRevealStartPixelsPerBp
      );
      return computePrimerTrackHeightForLayout({
        sequenceVisible: reveal.sequenceVisible,
        sequenceRevealProgress: reveal.sequenceRevealProgress,
        primerFeatureLaneScale,
        compactScale,
        sequenceFontSize: reveal.sequenceFontSize,
        maxOverviewLane: inputs.maxOverviewLane,
        maxForwardLane: inputs.maxForwardLane,
        maxReverseLane: inputs.maxReverseLane,
      });
    },
    computeLayoutBands: (genome, state, pixelsPerBp) => {
      const compactScale = Math.max(0.5, Math.min(1, state.height / 600));
      const reveal = computeSequenceRevealMetrics(
        !!genome.sequence,
        pixelsPerBp,
        inputs.sequenceViewportSpanPx
      );
      const primerFeatureLaneScale = primerFeatureLaneScaleForPixelsPerBp(
        pixelsPerBp,
        reveal.sequenceRevealStartPixelsPerBp
      );
      const overviewMetrics = primerScreenMetricsForReveal(
        0,
        compactScale,
        reveal.sequenceFontSize,
        primerFeatureLaneScale
      );
      const sequenceBandHeight = overviewMetrics.margin + 2 * overviewMetrics.laneHeight;
      const metrics = primerScreenMetricsForReveal(
        reveal.sequenceRevealProgress,
        compactScale,
        reveal.sequenceFontSize,
        primerFeatureLaneScale
      );
      const forwardLaneCount = inputs.maxForwardLane >= 0 ? inputs.maxForwardLane + 1 : 0;
      const reverseLaneCount = inputs.maxReverseLane >= 0 ? inputs.maxReverseLane + 1 : 0;
      const forwardHeight =
        forwardLaneCount > 0 ? metrics.margin + forwardLaneCount * metrics.laneHeight : 0;
      const reverseHeight =
        reverseLaneCount > 0 ? metrics.margin + reverseLaneCount * metrics.laneHeight : 0;
      return {
        aboveSequenceHeight: forwardHeight,
        belowSequenceHeight: reverseHeight,
        sequenceBandHeight,
      };
    },
    loadGenome: () => undefined,
    render: () => undefined,
    hitTest: () => null,
    destroy: () => undefined,
  };
}

function createAnnotationOverlayStub(maxAnnotationLane: number): OverlayTrack {
  return {
    id: 'annotations',
    displayName: 'Annotations',
    position: 'above',
    sortOrder: 100,
    enabled: true,
    container: {} as OverlayTrack['container'],
    computeHeight: () => Math.max(0, maxAnnotationLane + 1) * ANNOTATION_LANE_TOTAL,
    loadGenome: () => undefined,
    render: () => undefined,
    hitTest: () => null,
    destroy: () => undefined,
  };
}

function createEmptyBelowOverlayStub(): OverlayTrack {
  return {
    id: 'empty-below-overlay',
    displayName: 'Empty Below Overlay',
    position: 'below',
    sortOrder: 100,
    enabled: true,
    container: {} as OverlayTrack['container'],
    computeHeight: () => 0,
    loadGenome: () => undefined,
    render: () => undefined,
    hitTest: () => null,
    destroy: () => undefined,
  };
}

function resolveTestContract(inputs: {
  pixelsPerBp: number;
  circular: boolean;
  maxOverviewLane: number;
  maxForwardLane: number;
  maxReverseLane: number;
}): { layout: UnifiedLayout; contract: TrackContract } {
  const state = createState();
  const genome = createGenome(inputs.circular);
  const sequenceViewportSpanPx = genome.circular ? (state.width + state.height) * 2 : state.width;
  const primerOverlay = createPrimerOverlayStub({
    maxOverviewLane: inputs.maxOverviewLane,
    maxForwardLane: inputs.maxForwardLane,
    maxReverseLane: inputs.maxReverseLane,
    sequenceViewportSpanPx,
  });
  const layout = computeUnifiedLayout({
    overlays: [primerOverlay],
    genome,
    state,
    pixelsPerBp: inputs.pixelsPerBp,
    viewportHeight: state.height,
    hasSequence: true,
    sequenceViewportSpanPx,
    translationLanes: 0,
    annotationLanes: 0,
    cdsLanes: 0,
  });
  const contract = resolvePrimerTrackContract({
    layout,
    sequenceVisible: layout.sequenceVisible,
    compactScale: layout.compactScale,
    sequenceFontSize: layout.sequenceFontSize,
    maxOverviewLane: inputs.maxOverviewLane,
    maxForwardLane: inputs.maxForwardLane,
    maxReverseLane: inputs.maxReverseLane,
  });
  return { layout, contract };
}

function resolveAnnotationTestContract(inputs: {
  pixelsPerBp: number;
  circular: boolean;
  maxAnnotationLane: number;
  maxCdsLane: number;
}): { layout: UnifiedLayout; contract: TrackContract } {
  const state = createState();
  const genome = createGenome(inputs.circular);
  const annotationOverlay = createAnnotationOverlayStub(inputs.maxAnnotationLane);
  const layout = computeUnifiedLayout({
    overlays: [annotationOverlay],
    genome,
    state,
    pixelsPerBp: inputs.pixelsPerBp,
    viewportHeight: state.height,
    hasSequence: true,
    sequenceViewportSpanPx: genome.circular ? (state.width + state.height) * 2 : state.width,
    translationLanes: 0,
    annotationLanes: Math.max(0, inputs.maxAnnotationLane + 1),
    cdsLanes: Math.max(0, inputs.maxCdsLane + 1),
  });
  const contract = resolveAnnotationTrackContract({
    layout,
    maxAnnotationLane: inputs.maxAnnotationLane,
    maxCdsLane: inputs.maxCdsLane,
  });
  return { layout, contract };
}

function resolveInteractionTestContract(inputs: {
  mode: 'linear' | 'stadium';
  pixelsPerBp: number;
}): { layout: UnifiedLayout; contract: TrackContract } {
  const state = createState();
  const genome = createGenome(inputs.mode === 'stadium');
  const sequenceViewportSpanPx = genome.circular ? (state.width + state.height) * 2 : state.width;
  const overlays = [
    createAnnotationOverlayStub(1),
    createPrimerOverlayStub({
      maxOverviewLane: 1,
      maxForwardLane: 0,
      maxReverseLane: 0,
      sequenceViewportSpanPx,
    }),
  ];
  const layout = computeUnifiedLayout({
    overlays,
    genome,
    state,
    pixelsPerBp: inputs.pixelsPerBp,
    viewportHeight: state.height,
    hasSequence: true,
    sequenceViewportSpanPx,
    translationLanes: 0,
    annotationLanes: 2,
    cdsLanes: 1,
  });
  const contract = resolveInteractionOverlayContract({
    layout,
    mode: inputs.mode,
  });
  return { layout, contract };
}

function pixelsPerBpForMode(
  mode: 'linear' | 'stadium',
  genomeLength: number,
  zoom: number
): number {
  if (mode === 'linear') return (800 * zoom) / genomeLength;
  return (getStadiumDimensions(800, 400, 0, 80).totalLength * zoom) / genomeLength;
}

function sequenceViewportSpanForMode(mode: 'linear' | 'stadium'): number {
  return mode === 'stadium' ? (800 + 400) * 2 : 800;
}

function zoomSweepFor(mode: 'linear' | 'stadium', genomeLength: number): number[] {
  const sequenceViewportSpanPx = sequenceViewportSpanForMode(mode);
  const sequenceFullPixelsPerBp = Math.max(0.2, (sequenceViewportSpanPx + 256) / 3000);
  const sequenceRevealStartPixelsPerBp = sequenceFullPixelsPerBp * 0.45;
  const scale = mode === 'linear' ? 800 : getStadiumDimensions(800, 400, 0, 80).totalLength;
  const revealStartZoom = (sequenceRevealStartPixelsPerBp * genomeLength) / scale;
  const sequenceVisibleZoom = (sequenceFullPixelsPerBp * genomeLength) / scale;
  const transitionZooms = [revealStartZoom, sequenceVisibleZoom].flatMap((zoom) =>
    [0.5, 0.75, 0.9, 0.98, 1, 1.02, 1.1, 1.25, 1.5].map((factor) => zoom * factor)
  );
  const logZooms = Array.from({ length: 48 }, (_, index) => {
    const t = index / 47;
    return 10 ** (Math.log10(0.25) + (Math.log10(20000) - Math.log10(0.25)) * t);
  });
  return Array.from(new Set([...logZooms, ...transitionZooms, 0.25, 0.5, 1, 2, 5, 10]))
    .filter((zoom) => Number.isFinite(zoom) && zoom > 0)
    .sort((a, b) => a - b);
}

function intervalOverlap(
  a: { minOffset: number; maxOffset: number },
  b: { minOffset: number; maxOffset: number }
): number {
  return Math.max(0, Math.min(a.maxOffset, b.maxOffset) - Math.max(a.minOffset, b.minOffset));
}

function expectRulerDoesNotOverlapTracks(layout: UnifiedLayout, mode: 'linear' | 'stadium'): void {
  const ruler = rulerBounds(layout, mode);
  const protectedRegions = [
    sequenceProtectedBounds(layout),
    annotationSlotBounds(layout),
    primerSlotBounds(layout),
  ].filter((region): region is NonNullable<typeof region> => region !== null);

  const overlaps = protectedRegions
    .map((region) => ({
      region: region.id,
      overlap: +intervalOverlap(ruler, region).toFixed(3),
      ruler,
      regionBounds: region,
    }))
    .filter((entry) => entry.overlap > 0);

  expect(overlaps).toEqual([]);
}

function expectPrimersStayBeforeRuler(layout: UnifiedLayout, mode: 'linear' | 'stadium'): void {
  const primer = primerSlotBounds(layout);
  if (!primer) return;
  const ruler = rulerBounds(layout, mode);
  const orderingViolations =
    primer.maxOffset <= ruler.minOffset + 0.0001
      ? []
      : [
          {
            primer,
            ruler,
            overlapOrInversion: +(primer.maxOffset - ruler.minOffset).toFixed(3),
          },
        ];

  expect(orderingViolations).toEqual([]);
}

function expectContractIsLegal(layout: UnifiedLayout, contract: TrackContract): void {
  const slot = primerSlotBounds(layout);
  expect(slot).not.toBeNull();
  const protectedRegions =
    !layout.sequenceVisible || (contract.lod === 'overview' && contract.side === 'on')
      ? []
      : [sequenceProtectedBounds(layout)];
  const violations = validateLaneContract(contract, {
    container: slot ?? undefined,
    protectedRegions,
  });
  expect(violations.map((violation) => violation.message)).toEqual([]);
}

function expectAnnotationContractIsLegal(layout: UnifiedLayout, contract: TrackContract): void {
  const epsilon = 0.0001;
  const violations = validateLaneContract(contract, {
    protectedRegions: [sequenceProtectedBounds(layout)],
  });
  expect(violations.map((violation) => violation.message)).toEqual([]);

  const slot = annotationSlotBounds(layout);
  expect(slot).not.toBeNull();
  const annotationLanes = contract.lanes.filter((lane) => lane.role === 'annotation');
  for (const lane of annotationLanes) {
    expect(lane.minOffset).toBeGreaterThanOrEqual(slot!.minOffset - epsilon);
    expect(lane.maxOffset).toBeLessThanOrEqual(slot!.maxOffset + epsilon);
  }
}

function sourceText(relativeFromSharedDir: string): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(currentDir, relativeFromSharedDir), 'utf8');
}

function countMatches(source: string, pattern: RegExp): number {
  return Array.from(source.matchAll(pattern)).length;
}

describe('lane contracts', () => {
  it('keeps compact primer direction domains outside the hidden sequence band at low feature LOD', () => {
    const { layout, contract } = resolveTestContract({
      pixelsPerBp: 0.05,
      circular: true,
      maxOverviewLane: 0,
      maxForwardLane: 0,
      maxReverseLane: 0,
    });
    const forward = getPrimerLaneEnvelope(contract, 'forward', 0, 0);
    const reverse = getPrimerLaneEnvelope(contract, 'reverse', 0, 0);

    expect(layout.sequenceVisible).toBe(false);
    expect(contract.lod).toBe('shape');
    expect(contract.side).toBe('overlay');
    expect(forward).not.toBeNull();
    expect(reverse).not.toBeNull();
    expect(forward!.maxOffset).toBeLessThanOrEqual(layout.cutLineTopOffset);
    expect(reverse!.minOffset).toBeGreaterThanOrEqual(layout.cutLineBottomOffset);
    expectContractIsLegal(layout, contract);
  });

  it('keeps compact reverse primer lanes clear of the backbone without requiring forward primers', () => {
    const { layout, contract } = resolveTestContract({
      pixelsPerBp: 0.05,
      circular: true,
      maxOverviewLane: 0,
      maxForwardLane: -1,
      maxReverseLane: 0,
    });
    const reverse = getPrimerLaneEnvelope(contract, 'reverse', 0);

    expect(layout.sequenceVisible).toBe(false);
    expect(reverse).not.toBeNull();
    expect(reverse!.minOffset).toBeGreaterThan(layout.cutLineTopOffset + 0.5);
    expect(reverse!.minOffset).toBeGreaterThanOrEqual(layout.cutLineBottomOffset);
  });

  it('keeps nucleotide-level forward primers above and reverse primers below sequence rows', () => {
    const { layout, contract } = resolveTestContract({
      pixelsPerBp: 2,
      circular: true,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    });

    const fwd0 = getPrimerLaneEnvelope(contract, 'forward', 0);
    const fwd1 = getPrimerLaneEnvelope(contract, 'forward', 1);
    const rev0 = getPrimerLaneEnvelope(contract, 'reverse', 0);
    const rev1 = getPrimerLaneEnvelope(contract, 'reverse', 1);

    expect(contract.lod).toBe('sequence');
    expect(contract.lanes).toHaveLength(4);
    expect(fwd0).not.toBeNull();
    expect(fwd1).not.toBeNull();
    expect(rev0).not.toBeNull();
    expect(rev1).not.toBeNull();
    expect(fwd1!.maxOffset).toBeLessThan(fwd0!.minOffset);
    expect(fwd0!.maxOffset).toBeLessThanOrEqual(layout.cutLineTopOffset);
    expect(rev0!.minOffset).toBeGreaterThanOrEqual(layout.cutLineBottomOffset);
    expect(rev0!.maxOffset).toBeLessThan(rev1!.minOffset);
    expectContractIsLegal(layout, contract);
  });

  it('keeps primer contracts legal across the overview-to-sequence zoom sweep', () => {
    for (const pixelsPerBp of [0.02, 0.1, 0.35, 0.5, 1, 5]) {
      const { layout, contract } = resolveTestContract({
        pixelsPerBp,
        circular: true,
        maxOverviewLane: 3,
        maxForwardLane: 1,
        maxReverseLane: 2,
      });

      expectContractIsLegal(layout, contract);
    }
  });

  it('keeps split primer bands direction-specific during the feature-to-detail transition', () => {
    const collapsed = resolveTestContract({
      pixelsPerBp: 0.05,
      circular: false,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    }).layout;
    const transitioning = resolveTestContract({
      pixelsPerBp: 0.2,
      circular: false,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    }).layout;
    const visible = resolveTestContract({
      pixelsPerBp: 0.5,
      circular: false,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    }).layout;

    expect(collapsed.sequenceRevealProgress).toBe(0);
    expect(collapsed.primerLayoutMode).toBe('split');
    expect(collapsed.primerForwardHeight).toBeGreaterThan(0);
    expect(collapsed.primerReverseHeight).toBeGreaterThan(0);
    expect(transitioning.sequenceRevealProgress).toBeGreaterThan(0);
    expect(transitioning.sequenceRevealProgress).toBeLessThan(1);
    expect(transitioning.sequenceVisible).toBe(false);
    expect(transitioning.primerLayoutMode).toBe('split');
    expect(transitioning.primerForwardHeight).toBeGreaterThan(0);
    expect(transitioning.primerForwardHeight).toBeLessThan(visible.primerForwardHeight);
    expect(transitioning.primerReverseHeight).toBeGreaterThan(0);
    expect(transitioning.primerReverseHeight).toBeLessThan(visible.primerReverseHeight);
    expect(visible.primerLayoutMode).toBe('split');
    expect(visible.primerForwardHeight).toBeGreaterThan(0);
    expect(visible.primerReverseHeight).toBeGreaterThan(0);
  });

  it('keeps primer lane allocation continuous across the sequence visibility threshold', () => {
    const before = resolveTestContract({
      pixelsPerBp: 0.35,
      circular: false,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    }).layout;
    const after = resolveTestContract({
      pixelsPerBp: 0.36,
      circular: false,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    }).layout;

    expect(before.sequenceVisible).toBe(false);
    expect(after.sequenceVisible).toBe(true);
    expect(before.primerLayoutMode).toBe('split');
    expect(after.primerLayoutMode).toBe('split');
    expect(Math.abs(after.primerForwardHeight - before.primerForwardHeight)).toBeLessThan(1);
    expect(Math.abs(after.primerReverseHeight - before.primerReverseHeight)).toBeLessThan(1);
  });

  it('does not collapse feature-level primer thickness while primer lanes split outward', () => {
    const collapsed = resolveTestContract({
      pixelsPerBp: 0.157,
      circular: false,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    });
    const collapsedLane = getPrimerLaneEnvelope(collapsed.contract, 'forward', 0);
    const collapsedSequenceBand =
      collapsed.layout.cutLineBottomOffset - collapsed.layout.cutLineTopOffset;

    expect(collapsed.layout.sequenceRevealProgress).toBe(0);
    expect(collapsed.layout.primerLayoutMode).toBe('split');
    expect(collapsedLane).not.toBeNull();

    for (const pixelsPerBp of [0.16, 0.18, 0.2, 0.25, 0.35]) {
      const split = resolveTestContract({
        pixelsPerBp,
        circular: false,
        maxOverviewLane: 1,
        maxForwardLane: 1,
        maxReverseLane: 1,
      });
      const splitLane = getPrimerLaneEnvelope(split.contract, 'forward', 0);
      const splitSequenceBand = split.layout.cutLineBottomOffset - split.layout.cutLineTopOffset;

      expect(split.layout.sequenceRevealProgress, `pixelsPerBp=${pixelsPerBp}`).toBeGreaterThan(0);
      expect(split.layout.primerLayoutMode, `pixelsPerBp=${pixelsPerBp}`).toBe('split');
      expect(splitLane, `pixelsPerBp=${pixelsPerBp}`).not.toBeNull();
      expect(splitLane!.halfHeight, `pixelsPerBp=${pixelsPerBp}`).toBeGreaterThanOrEqual(
        collapsedLane!.halfHeight * 0.8
      );
      expect(splitSequenceBand, `pixelsPerBp=${pixelsPerBp}`).toBeGreaterThanOrEqual(
        collapsedSequenceBand * 0.8
      );
    }
  });

  it('scales compact primer lane provision with feature-level primer thickness', () => {
    const zoomedOut = resolveTestContract({
      pixelsPerBp: 0.02,
      circular: false,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    });
    const featureLevel = resolveTestContract({
      pixelsPerBp: 0.157,
      circular: false,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    });

    const zoomedOutForward0 = getPrimerLaneEnvelope(zoomedOut.contract, 'forward', 0, 0);
    const zoomedOutForward1 = getPrimerLaneEnvelope(zoomedOut.contract, 'forward', 0, 1);
    const featureLevelForward0 = getPrimerLaneEnvelope(featureLevel.contract, 'forward', 0, 0);
    const featureLevelForward1 = getPrimerLaneEnvelope(featureLevel.contract, 'forward', 0, 1);
    const zoomedOutReverse0 = getPrimerLaneEnvelope(zoomedOut.contract, 'reverse', 0, 0);
    const zoomedOutReverse1 = getPrimerLaneEnvelope(zoomedOut.contract, 'reverse', 0, 1);

    expect(zoomedOut.layout.sequenceRevealProgress).toBe(0);
    expect(featureLevel.layout.sequenceRevealProgress).toBe(0);
    expect(zoomedOutForward0).not.toBeNull();
    expect(zoomedOutForward1).not.toBeNull();
    expect(featureLevelForward0).not.toBeNull();
    expect(featureLevelForward1).not.toBeNull();
    expect(zoomedOutReverse0).not.toBeNull();
    expect(zoomedOutReverse1).not.toBeNull();

    const zoomedOutForwardStep = Math.abs(
      zoomedOutForward1!.centerOffset - zoomedOutForward0!.centerOffset
    );
    const featureLevelForwardStep = Math.abs(
      featureLevelForward1!.centerOffset - featureLevelForward0!.centerOffset
    );

    expect(zoomedOutForward0!.halfHeight).toBeLessThan(featureLevelForward0!.halfHeight);
    expect(zoomedOutForwardStep).toBeLessThan(featureLevelForwardStep);
    expect(zoomedOutForward1!.maxOffset).toBeLessThanOrEqual(zoomedOutForward0!.minOffset + 0.0001);
    expect(zoomedOutReverse0!.maxOffset).toBeLessThanOrEqual(zoomedOutReverse1!.minOffset + 0.0001);
  });

  it('keeps collapsed primer outlines on the canvas-primer aspect ratio', () => {
    const { layout } = resolveTestContract({
      pixelsPerBp: 0.05,
      circular: true,
      maxOverviewLane: 3,
      maxForwardLane: 1,
      maxReverseLane: 1,
    });
    const metrics = collapsedPrimerScreenMetrics(layout, layout.compactScale, 4);

    expect(metrics.arrowHeight / metrics.barHeight).toBeCloseTo(
      CANVAS_PRIMER_ARROW_HEIGHT / CANVAS_PRIMER_TRACK_HEIGHT,
      6
    );
    expect(metrics.arrowWidth / metrics.barHeight).toBeCloseTo(
      CANVAS_PRIMER_ARROW_WIDTH / CANVAS_PRIMER_TRACK_HEIGHT,
      6
    );
    expect(metrics.barHeight / 2 + metrics.arrowHeight).toBeLessThanOrEqual(
      metrics.laneHeight / 2 + 0.0001
    );
  });

  it('keeps annotation and CDS lanes above the protected sequence rows', () => {
    const { layout, contract } = resolveAnnotationTestContract({
      pixelsPerBp: 1,
      circular: true,
      maxAnnotationLane: 2,
      maxCdsLane: 1,
    });

    const annotation0 = getAnnotationLaneEnvelope(contract, 'gene', 0);
    const annotation1 = getAnnotationLaneEnvelope(contract, 'promoter', 1);
    const annotation2 = getAnnotationLaneEnvelope(contract, 'terminator', 2);
    const cds0 = getAnnotationLaneEnvelope(contract, 'CDS', 0);
    const cds1 = getAnnotationLaneEnvelope(contract, 'CDS', 1);

    expect(contract.trackId).toBe('annotations');
    expect(contract.side).toBe('above');
    expect(contract.lanes).toHaveLength(5);
    expect(annotation0).not.toBeNull();
    expect(annotation1).not.toBeNull();
    expect(annotation2).not.toBeNull();
    expect(cds0).not.toBeNull();
    expect(cds1).not.toBeNull();
    expect(annotation0!.halfHeight * 2).toBeCloseTo(ANNOTATION_BAR_HEIGHT, 6);
    expect(layout.annotationStep).toBeCloseTo(ANNOTATION_LANE_TOTAL, 6);
    expect(annotation2!.maxOffset).toBeLessThan(annotation1!.minOffset);
    expect(annotation1!.maxOffset).toBeLessThan(annotation0!.minOffset);
    expect(annotation0!.maxOffset).toBeLessThanOrEqual(cds1!.minOffset + 0.0001);
    expect(cds1!.maxOffset).toBeLessThan(cds0!.minOffset);
    expect(cds0!.maxOffset).toBeLessThanOrEqual(layout.cutLineTopOffset);
    expectAnnotationContractIsLegal(layout, contract);
  });

  it('keeps the sequence track in view when annotation lanes exceed the viewport', () => {
    const state = createState();
    state.height = 480;
    const genome = createGenome(false);
    const maxAnnotationLane = 31;
    const annotationOverlay = createAnnotationOverlayStub(maxAnnotationLane);
    const layout = computeUnifiedLayout({
      overlays: [annotationOverlay],
      genome,
      state,
      pixelsPerBp: 0.001,
      viewportHeight: state.height,
      hasSequence: true,
      sequenceViewportSpanPx: state.width,
      translationLanes: 0,
      annotationLanes: maxAnnotationLane + 1,
      cdsLanes: 0,
    });

    expect(layout.totalHeight).toBeGreaterThan(state.height);
    expect(layout.offset).toBeLessThan(0);
    expect(layout.annotationStep).toBeCloseTo(ANNOTATION_LANE_TOTAL, 6);
    expect(layout.fwdStrandTop).toBeGreaterThanOrEqual(0);
    expect(layout.revStrandBottom).toBeLessThanOrEqual(state.height);
    expect(layout.rulerY).toBeLessThanOrEqual(state.height);
  });

  it('reserves sequence and ruler geometry from sequence capability, not resident bases', () => {
    const state = createState();
    const genome = createGenome(false);
    const inputs = {
      overlays: [],
      genome,
      state,
      pixelsPerBp: 1,
      viewportHeight: state.height,
      sequenceAvailable: true,
      sequenceViewportSpanPx: state.width,
      translationLanes: 0,
      annotationLanes: 0,
      cdsLanes: 0,
    };

    const pending = computeUnifiedLayout({
      ...inputs,
      hasSequence: false,
    });
    const resident = computeUnifiedLayout({
      ...inputs,
      hasSequence: true,
    });

    expect(pending.sequenceVisible).toBe(false);
    expect(resident.sequenceVisible).toBe(true);
    expect(pending.sequenceRevealProgress).toBeCloseTo(resident.sequenceRevealProgress, 6);
    expect(pending.rulerY).toBeCloseTo(resident.rulerY, 6);
    expect(pending.totalHeight).toBeCloseTo(resident.totalHeight, 6);
  });

  it('freezes the outer sequence/ruler layout while visible strands follow reveal zoom', () => {
    const state = createState();
    const genome = createGenome(false);
    const inputs = {
      overlays: [],
      genome,
      state,
      viewportHeight: state.height,
      hasSequence: true,
      sequenceAvailable: true,
      reserveSequenceLayoutEnvelope: true,
      sequenceViewportSpanPx: state.width,
      translationLanes: 0,
      annotationLanes: 0,
      cdsLanes: 0,
      topOffsetMin: 42,
      bottomReserve: 24,
    };

    const coarse = computeUnifiedLayout({
      ...inputs,
      pixelsPerBp: 0.05,
    });
    const detail = computeUnifiedLayout({
      ...inputs,
      pixelsPerBp: 1,
    });

    expect(coarse.sequenceVisible).toBe(false);
    expect(detail.sequenceVisible).toBe(true);
    expect(coarse.sequenceRevealProgress).toBeLessThan(0.01);
    expect(detail.sequenceRevealProgress).toBeGreaterThan(0.99);
    expect(coarse.revStrandBottom - coarse.fwdStrandTop).toBeLessThan(
      detail.revStrandBottom - detail.fwdStrandTop
    );
    expect((coarse.fwdStrandTop + coarse.revStrandBottom) / 2).toBeCloseTo(
      (detail.fwdStrandTop + detail.revStrandBottom) / 2,
      6
    );
    expect(coarse.strandEnvelopeTop).toBeCloseTo(detail.strandEnvelopeTop, 6);
    expect(coarse.strandEnvelopeBottom).toBeCloseTo(detail.strandEnvelopeBottom, 6);
    expect(coarse.rulerY).toBeLessThan(detail.rulerY);
    expect(coarse.rulerY).toBeGreaterThan(coarse.revStrandBottom);
    expect(coarse.rulerY).toBeLessThan(coarse.strandEnvelopeBottom);
    expect(coarse.totalHeight).toBeCloseTo(detail.totalHeight, 6);
    expect(coarse.trackContentHeight).toBeCloseTo(detail.trackContentHeight, 6);
    expect(coarse.maxTrackScrollTop).toBeCloseTo(detail.maxTrackScrollTop, 6);
  });

  it('reserves visible clearance between compact annotation bars and CDS label bars', () => {
    for (const height of [300, 400]) {
      const state = createState();
      state.height = height;
      const genome = createGenome(true);
      const annotationOverlay = createAnnotationOverlayStub(0);
      const layout = computeUnifiedLayout({
        overlays: [annotationOverlay],
        genome,
        state,
        pixelsPerBp: 1,
        viewportHeight: state.height,
        hasSequence: true,
        sequenceViewportSpanPx: sequenceViewportSpanForMode('stadium'),
        translationLanes: 0,
        annotationLanes: 1,
        cdsLanes: 1,
      });
      const contract = resolveAnnotationTrackContract({
        layout,
        maxAnnotationLane: 0,
        maxCdsLane: 0,
      });
      const annotation0 = getAnnotationLaneEnvelope(contract, 'gene', 0);
      const cds0 = getAnnotationLaneEnvelope(contract, 'CDS', 0);

      expect(annotation0).not.toBeNull();
      expect(cds0).not.toBeNull();
      expect(cds0!.minOffset - annotation0!.maxOffset).toBeGreaterThanOrEqual(
        2 * layout.compactScale
      );
    }
  });

  it('uses all physical lane contracts when deriving stadium stack bounds', () => {
    const { layout, contract: annotations } = resolveAnnotationTestContract({
      pixelsPerBp: 1,
      circular: true,
      maxAnnotationLane: -1,
      maxCdsLane: 2,
    });
    const primers = resolvePrimerTrackContract({
      layout,
      sequenceVisible: layout.sequenceVisible,
      compactScale: layout.compactScale,
      sequenceFontSize: layout.sequenceFontSize,
      maxOverviewLane: 1,
      maxForwardLane: 1,
      maxReverseLane: 1,
    });
    const bounds = laneContractStackBounds([
      annotations,
      primers,
      resolveSequenceTrackContract({ layout }),
      resolveRulerTrackContract({ layout }),
      resolveCutSiteTrackContract({ layout }),
    ]);

    const outermostPhysicalLane = Math.min(
      ...[annotations, primers].flatMap((contract) => contract.lanes.map((lane) => lane.minOffset))
    );
    const innermostPhysicalLane = Math.max(
      ...[
        primers,
        resolveSequenceTrackContract({ layout }),
        resolveRulerTrackContract({ layout }),
        resolveCutSiteTrackContract({ layout }),
      ].flatMap((contract) => contract.lanes.map((lane) => lane.maxOffset))
    );
    expect(bounds.minOffset).toBeCloseTo(outermostPhysicalLane, 5);
    expect(bounds.outwardExtent).toBeCloseTo(-outermostPhysicalLane, 5);
    expect(bounds.maxOffset).toBeCloseTo(innermostPhysicalLane, 5);
    expect(bounds.inwardExtent).toBeCloseTo(innermostPhysicalLane, 5);
  });

  it('keeps CDS-label lanes separate at feature LOD', () => {
    const { layout, contract } = resolveAnnotationTestContract({
      pixelsPerBp: 0.1,
      circular: true,
      maxAnnotationLane: 3,
      maxCdsLane: 2,
    });

    expect(layout.sequenceVisible).toBe(false);
    expect(contract.lanes.map((lane) => lane.role)).toEqual([
      'annotation',
      'annotation',
      'annotation',
      'annotation',
      'cds-label',
      'cds-label',
      'cds-label',
    ]);
    expect(getAnnotationLaneEnvelope(contract, 'CDS', 0)).not.toBeNull();
    expectAnnotationContractIsLegal(layout, contract);
  });

  it('keeps annotation contracts legal across zoom and circularity', () => {
    for (const circular of [false, true]) {
      for (const pixelsPerBp of [0.02, 0.2, 1, 5]) {
        const { layout, contract } = resolveAnnotationTestContract({
          pixelsPerBp,
          circular,
          maxAnnotationLane: 3,
          maxCdsLane: 2,
        });

        expectAnnotationContractIsLegal(layout, contract);
      }
    }
  });

  it('marks highlight and cursor lane-spanning as intentional overlap', () => {
    for (const mode of ['linear', 'stadium'] as const) {
      const { layout, contract } = resolveInteractionTestContract({
        mode,
        pixelsPerBp: 0.1,
      });
      const band = getInteractionLaneEnvelope(contract, 'selection-band');
      const cursor = getInteractionLaneEnvelope(contract, 'cursor-line');
      const primerSlot = primerSlotBounds(layout);
      const protectedRegions = [
        sequenceProtectedBounds(layout),
        rulerBounds(layout, mode),
        annotationSlotBounds(layout)!,
        ...(primerSlot ? [primerSlot] : []),
      ];

      expect(contract.trackId).toBe('interactions');
      expect(contract.side).toBe('overlay');
      expect(band).not.toBeNull();
      expect(cursor).not.toBeNull();
      expect(band!.minOffset).toBeLessThan(sequenceProtectedBounds(layout).minOffset);
      expect(band!.maxOffset).toBeGreaterThanOrEqual(rulerBounds(layout, mode).maxOffset - 0.0001);
      expect(validateLaneContract(contract, { protectedRegions })).toEqual([]);

      const strictContract: TrackContract = { ...contract, allowedOverlap: [] };
      expect(validateLaneContract(strictContract, { protectedRegions })).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'protected-overlap' })])
      );
    }
  });

  it('exposes sequence, ruler, and cut-site lanes from the unified layout', () => {
    const state = createState();
    const genome = createGenome(false);
    const layout = computeUnifiedLayout({
      overlays: [],
      genome,
      state,
      pixelsPerBp: 2,
      viewportHeight: state.height,
      hasSequence: true,
      translationLanes: 0,
      annotationLanes: 0,
      cdsLanes: 0,
    });

    const sequenceContract = resolveSequenceTrackContract({ layout });
    const rulerContract = resolveRulerTrackContract({ layout });
    const cutSiteContract = resolveCutSiteTrackContract({ layout });

    expect(getTrackLaneEnvelope(sequenceContract, 'fwd-sequence-row')?.centerOffset).toBeCloseTo(
      layout.fwdStrandCenter - layout.fwdStrandTop,
      5
    );
    expect(getTrackLaneEnvelope(sequenceContract, 'rev-sequence-row')?.centerOffset).toBeCloseTo(
      layout.revStrandCenter - layout.fwdStrandTop,
      5
    );
    expect(getTrackLaneEnvelope(rulerContract, 'ruler-line')?.centerOffset).toBeCloseTo(
      layout.rulerOffset,
      5
    );
    expect(getTrackLaneEnvelope(cutSiteContract, 'cut-label')?.centerOffset).toBeCloseTo(
      layout.cutLabelOffset + 8,
      5
    );
  });

  it('exposes one diagnostic snapshot for all resolved stadium lane contracts', () => {
    const state = createState();
    const genome = createGenome(true);
    const sequenceViewportSpanPx = sequenceViewportSpanForMode('stadium');
    const overlays = [
      createAnnotationOverlayStub(1),
      createPrimerOverlayStub({
        maxOverviewLane: 1,
        maxForwardLane: 0,
        maxReverseLane: 0,
        sequenceViewportSpanPx,
      }),
    ];
    const layout = computeUnifiedLayout({
      overlays,
      genome,
      state,
      pixelsPerBp: 2,
      viewportHeight: state.height,
      hasSequence: true,
      sequenceViewportSpanPx,
      translationLanes: 0,
      annotationLanes: 2,
      cdsLanes: 1,
      orfForwardLanes: 1,
      orfReverseLanes: 1,
    });

    const snapshot = resolveLaneContractSnapshot({
      layout,
      mode: 'stadium',
      maxAnnotationLane: 1,
      maxCdsLane: 0,
      maxPrimerLane: 1,
      maxForwardPrimerLane: 0,
      maxReversePrimerLane: 0,
      orfForwardLaneCount: 1,
      orfReverseLaneCount: 1,
      includeInteractions: true,
    });

    expect(snapshot.contracts.map((contract) => contract.trackId)).toEqual([
      'annotations',
      'orfs',
      'primers',
      'sequence',
      'ruler',
      'cut-sites',
      'interactions',
    ]);
    expect(snapshot.physicalStackBounds.minOffset).toBeLessThan(0);
    expect(snapshot.physicalStackBounds.maxOffset).toBeGreaterThan(0);
    expect(snapshot.fullStackBounds.minOffset).toBeLessThanOrEqual(
      snapshot.physicalStackBounds.minOffset
    );
    expect(snapshot.fullStackBounds.maxOffset).toBeGreaterThanOrEqual(
      snapshot.physicalStackBounds.maxOffset
    );
    expect(snapshot.regions.ruler.minOffset).toBeCloseTo(layout.rulerOffset, 5);
    expect(snapshot.gaps).toEqual([
      expect.objectContaining({
        id: 'nearest-track-to-ruler',
        toTrackId: 'ruler',
        toRole: 'ruler-line',
      }),
    ]);
    expect(snapshot.gaps[0].gap).toBeGreaterThanOrEqual(0);
    expect(snapshot.violations.map((violation) => violation.message)).toEqual([]);
  });

  it('expresses the ruler-to-sequence gap as a zoom-dependent lane contract gap', () => {
    const state = createState();
    const genome = createGenome(true);
    const sequenceViewportSpanPx = sequenceViewportSpanForMode('stadium');
    const gapForPixelsPerBp = (pixelsPerBp: number) => {
      const layout = computeUnifiedLayout({
        overlays: [],
        genome,
        state,
        pixelsPerBp,
        viewportHeight: state.height,
        hasSequence: true,
        sequenceViewportSpanPx,
        translationLanes: 0,
        annotationLanes: 0,
        cdsLanes: 0,
      });
      const snapshot = resolveLaneContractSnapshot({
        layout,
        mode: 'stadium',
        maxAnnotationLane: -1,
        maxCdsLane: -1,
        maxPrimerLane: -1,
        maxForwardPrimerLane: -1,
        maxReversePrimerLane: -1,
        orfForwardLaneCount: 0,
        orfReverseLaneCount: 0,
        includeInteractions: false,
      });
      return {
        layout,
        gap: snapshot.gaps.find((gap) => gap.id === 'nearest-track-to-ruler')?.gap ?? 0,
      };
    };

    const lowDetail = gapForPixelsPerBp(2);
    const highDetail = gapForPixelsPerBp(14);

    expect(lowDetail.layout.sequenceRevealProgress).toBeCloseTo(1, 5);
    expect(highDetail.layout.sequenceRevealProgress).toBeCloseTo(1, 5);
    expect(highDetail.layout.rowHeight).toBeGreaterThan(lowDetail.layout.rowHeight);
    expect(highDetail.gap).toBeGreaterThan(lowDetail.gap + 3);
    expect(highDetail.gap).toBeLessThanOrEqual(highDetail.layout.rowHeight);
  });

  it('collapses hidden nucleotide rows so overview ORF bars stay close to the ruler', () => {
    const state = createState();
    const genome = createGenome(true);
    const sequenceViewportSpanPx = sequenceViewportSpanForMode('stadium');
    const orfForwardLanes = 3;
    const orfReverseLanes = 3;
    const layoutForPixelsPerBp = (pixelsPerBp: number) =>
      computeUnifiedLayout({
        overlays: [createEmptyBelowOverlayStub()],
        genome,
        state,
        pixelsPerBp,
        viewportHeight: state.height,
        hasSequence: true,
        sequenceViewportSpanPx,
        translationLanes: 0,
        annotationLanes: 0,
        cdsLanes: 0,
        orfForwardLanes,
        orfReverseLanes,
      });
    const visibleOrfToRulerGap = (layout: UnifiedLayout): number => {
      let nearestVisibleOrfBottom = Number.NEGATIVE_INFINITY;
      for (let lane = 0; lane < orfForwardLanes; lane++) {
        nearestVisibleOrfBottom = Math.max(
          nearestVisibleOrfBottom,
          layout.orfForwardOffset + lane * layout.orfLaneStep + layout.orfLaneHeight / 2
        );
      }
      for (let lane = 0; lane < orfReverseLanes; lane++) {
        nearestVisibleOrfBottom = Math.max(
          nearestVisibleOrfBottom,
          layout.orfReverseOffset + lane * layout.orfLaneStep + layout.orfLaneHeight / 2
        );
      }
      return layout.rulerOffset - nearestVisibleOrfBottom;
    };

    const overview = layoutForPixelsPerBp(0.05);
    const detail = layoutForPixelsPerBp(2);
    const overviewGap = visibleOrfToRulerGap(overview);
    const detailGap = visibleOrfToRulerGap(detail);

    expect(overview.sequenceRevealProgress).toBe(0);
    expect(detail.sequenceRevealProgress).toBeCloseTo(1, 5);
    expect(overviewGap).toBeLessThanOrEqual(1);
    expect(detailGap).toBeGreaterThan(overviewGap + detail.rowHeight);
  });

  it('fails loudly when a renderer requires a missing lane contract', () => {
    const contract: TrackContract = {
      trackId: 'ruler',
      lod: 'shape',
      side: 'below',
      lanes: [],
      allowedOverlap: [],
      zIndex: 20,
      opacity: 1,
      transitionProgress: 0,
    };

    expect(() => requireTrackLaneEnvelope(contract, 'ruler-line')).toThrow(
      'Track contract "ruler" is missing required "ruler-line" lane'
    );
  });

  it('keeps the ruler visual envelope out of annotation, sequence, and primer lanes across zoom', () => {
    const cases = [
      {
        name: 'small-plasmid-like',
        length: 8000,
        maxAnnotationLane: 2,
        maxCdsLane: 1,
        maxOverviewPrimerLane: 1,
        maxForwardPrimerLane: 1,
        maxReversePrimerLane: 1,
      },
      {
        name: 'chr1-like',
        length: 230000,
        maxAnnotationLane: 4,
        maxCdsLane: 2,
        maxOverviewPrimerLane: 1,
        maxForwardPrimerLane: 0,
        maxReversePrimerLane: 0,
      },
      {
        name: 'mg1655-like',
        length: 4641652,
        maxAnnotationLane: 5,
        maxCdsLane: 3,
        maxOverviewPrimerLane: 1,
        maxForwardPrimerLane: 0,
        maxReversePrimerLane: 0,
      },
    ];

    for (const mode of ['linear', 'stadium'] as const) {
      for (const testCase of cases) {
        const state = createState();
        state.width = 800;
        state.height = 400;
        const sequenceViewportSpanPx = sequenceViewportSpanForMode(mode);
        const overlays = [
          createAnnotationOverlayStub(testCase.maxAnnotationLane),
          createPrimerOverlayStub({
            maxOverviewLane: testCase.maxOverviewPrimerLane,
            maxForwardLane: testCase.maxForwardPrimerLane,
            maxReverseLane: testCase.maxReversePrimerLane,
            sequenceViewportSpanPx,
          }),
        ];

        for (const zoom of zoomSweepFor(mode, testCase.length)) {
          state.zoom = zoom;
          const genome = {
            ...createGenome(mode === 'stadium'),
            name: `${testCase.name}-${mode}`,
            length: testCase.length,
            sequence: 'A'.repeat(Math.min(testCase.length, 1000)),
          };
          const layout = computeUnifiedLayout({
            overlays,
            genome,
            state,
            pixelsPerBp: pixelsPerBpForMode(mode, testCase.length, zoom),
            viewportHeight: state.height,
            hasSequence: true,
            sequenceViewportSpanPx,
            translationLanes: 0,
            annotationLanes: testCase.maxAnnotationLane + 1,
            cdsLanes: testCase.maxCdsLane + 1,
          });

          expectRulerDoesNotOverlapTracks(layout, mode);
          expectPrimersStayBeforeRuler(layout, mode);
        }
      }
    }
  });

  it('keeps the legacy lane-position fallback inventory from growing', () => {
    const allowedFallbackCounts = new Map([
      ['../linear-renderer.ts', 0],
      ['../stadium-renderer.ts', 0],
    ]);
    const fallbackPattern =
      /(?:L|layout)\.(?:rulerOffset|rulerY) \+ 14|(?:L|layout)\.annotationTop - (?:L|layout)\.fwdStrandTop/g;

    for (const [relativePath, allowedCount] of allowedFallbackCounts) {
      const count = countMatches(sourceText(relativePath), fallbackPattern);
      expect(
        count,
        `${relativePath} has ${count} lane-position fallbacks; allowed inventory is ${allowedCount}`
      ).toBeLessThanOrEqual(allowedCount);
    }
  });
});
