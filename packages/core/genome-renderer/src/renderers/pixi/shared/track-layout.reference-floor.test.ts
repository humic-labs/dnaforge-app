import { cdsZoomBandCenterOffset } from '@waypoint/platform';
import { describe, it, expect } from 'vitest';
import { computeUnifiedLayout, LANE_HEIGHT, type UnifiedLayoutInputs } from './track-layout';
import { TRACK_MANAGEMENT_REFERENCE_MIN_HEIGHT_PX } from '../../../track-stack-layout-contract';
import type { Genome, RenderState } from '../../../types';
import type { OverlayTrack } from '../overlays/overlay-track';

const annotationsOverlay = {
  id: 'annotations',
  displayName: 'annotations',
  position: 'above',
  sortOrder: 100,
  enabled: true,
  computeHeight: () => 0,
  loadGenome: () => {},
  render: () => {},
  hitTest: () => null,
  container: {},
  destroy: () => {},
} as unknown as OverlayTrack;

const GENOME_LENGTH = 3_088_269_832;

function inputs(over: Partial<UnifiedLayoutInputs> = {}): UnifiedLayoutInputs {
  const pixelsPerBp = over.pixelsPerBp ?? 1 / 2_500_000;
  return {
    overlays: [],
    genome: {
      id: 'grch38',
      name: 'GRCh38',
      length: GENOME_LENGTH,
      features: [],
    } as unknown as Genome,
    state: {
      width: 1200,
      height: 700,
      offsetBp: 0,
      bpPerPixel: 1 / pixelsPerBp,
    } as unknown as RenderState,
    pixelsPerBp,
    viewportHeight: 700,
    hasSequence: false,
    sequenceAvailable: true,
    reserveSequenceLayoutEnvelope: true,
    translationLanes: 0,
    annotationLanes: 0,
    cdsLanes: 0,
    ...over,
  };
}

describe('computeUnifiedLayout — reference envelope floor ', () => {
  it('reserves one native sequence row when the complement row is hidden', () => {
    const paired = computeUnifiedLayout(inputs({ pixelsPerBp: 16, hasSequence: true }));
    const single = computeUnifiedLayout(
      inputs({ pixelsPerBp: 16, hasSequence: true, showReverseComplement: false })
    );
    expect(single.revStrandBottom).toBe(single.fwdStrandBottom);
    expect(single.revStrandCenter).toBe(single.fwdStrandBottom);
    expect(single.totalHeight).toBeLessThan(paired.totalHeight);
  });
  it('keeps the reference envelope tall enough for its gutter controls with no annotation lanes', () => {
    const layout = computeUnifiedLayout(inputs({ trackStackEndReservePx: 32 }));

    expect(layout.totalHeight).toBeGreaterThanOrEqual(TRACK_MANAGEMENT_REFERENCE_MIN_HEIGHT_PX);
  });

  it('keeps the stack at the top when a gutter is present and nothing sits above it', () => {
    const layout = computeUnifiedLayout(inputs({ trackStackEndReservePx: 32 }));

    expect(layout.offset).toBe(0);
  });

  it('does not pad a view without a companion gutter', () => {
    const natural = computeUnifiedLayout(inputs());

    expect(natural.totalHeight).toBeLessThan(TRACK_MANAGEMENT_REFERENCE_MIN_HEIGHT_PX);
  });

  it('leaves an envelope that already fits unchanged', () => {
    const withLanes = inputs({ overlays: [annotationsOverlay], annotationLanes: 6 });
    const natural = computeUnifiedLayout(withLanes);
    const gutter = computeUnifiedLayout({ ...withLanes, trackStackEndReservePx: 32 });

    expect(natural.totalHeight).toBeGreaterThan(TRACK_MANAGEMENT_REFERENCE_MIN_HEIGHT_PX);
    expect(gutter.totalHeight).toBe(natural.totalHeight);
  });
});

describe('cohesive indexed annotation layout', () => {
  it('keeps replacement codon paint inside each transcript lane and above the sequence', () => {
    const layout = computeUnifiedLayout(
      inputs({
        overlays: [annotationsOverlay],
        annotationLanes: 2,
        cdsSizing: 'cohesive',
        pixelsPerBp: 1101 / 150.597105956,
        viewportHeight: 190,
        hasSequence: true,
      })
    );
    const pose = layout.cdsZoomPresentation;
    expect(pose?.colorAlpha).toBeGreaterThan(0);
    if (!pose) throw new Error('Expected cohesive CDS presentation');
    const bottomFromLabel = cdsZoomBandCenterOffset(pose) + pose.aaHeight / 2;
    const lowestLabel = layout.fwdStrandTop + layout.annotationOffset;
    const nextLabel = lowestLabel - layout.annotationStep;

    expect(lowestLabel + bottomFromLabel).toBeLessThanOrEqual(layout.fwdStrandTop);
    expect(nextLabel + bottomFromLabel).toBeLessThanOrEqual(lowestLabel - LANE_HEIGHT / 2);
  });
});
