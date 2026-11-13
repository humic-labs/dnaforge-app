import { describe, it, expect } from 'vitest';
import {
  computeUnifiedLayout,
  LANE_HEIGHT,
  TRACK_STACK_END_CONTROL_HEIGHT_PX,
  type UnifiedLayoutInputs,
} from '../shared/track-layout';
import type { OverlayTrack, OverlayPosition } from './overlay-track';
import type { Genome, RenderState } from '../../../types';

function mockOverlay(opts: {
  id: string;
  position: OverlayPosition;
  sortOrder: number;
  height: number;
  enabled?: boolean;
}): OverlayTrack {
  return {
    id: opts.id,
    displayName: opts.id,
    position: opts.position,
    sortOrder: opts.sortOrder,
    enabled: opts.enabled ?? true,
    computeHeight: () => opts.height,
    loadGenome: () => {},
    render: () => {},
    hitTest: () => null,
    container: {} as any,
    destroy: () => {},
  };
}

const GENOME: Genome = { name: 'test', length: 1000, circular: false, features: [] };
const STATE: RenderState = {
  morph: 0,
  viewOffset: 0,
  zoom: 1,
  width: 1440,
  height: 900,
  selectedIds: new Set(),
  hoveredId: null,
  highlightRange: null,
  cursorPosition: null,
  hoveredCutSiteId: null,
  perfPanelVisible: false,
};

function layout(overlays: OverlayTrack[], overrides?: Partial<UnifiedLayoutInputs>) {
  return computeUnifiedLayout({
    overlays,
    genome: GENOME,
    state: STATE,
    pixelsPerBp: 1,
    viewportHeight: 900,
    hasSequence: true,
    translationLanes: 0,
    annotationLanes: 0,
    cdsLanes: 0,
    ...overrides,
  });
}

describe('computeUnifiedLayout', () => {
  it('preserves overview allocation while attaching the Canvas CDS band to its pill', () => {
    const indexed = layout([], { pixelsPerBp: 0.8, cdsLanes: 3, orfForwardLanes: 1 });
    const canvas = layout([], {
      pixelsPerBp: 0.8,
      cdsLanes: 3,
      orfForwardLanes: 1,
      cdsSizing: 'canvas',
    });
    expect(canvas.cdsChevronHeight).toBeCloseTo(5.4, 8);
    expect(canvas.cdsChevronOffset - 5.4 / 2).toBeCloseTo(canvas.cdsBarOffset + 7, 8);
    expect(canvas.cdsLaneStep).toBe(indexed.cdsLaneStep);
    expect(canvas.cdsBarOffset).toBe(indexed.cdsBarOffset);
    expect(canvas.orfLaneHeight).toBe(indexed.orfLaneHeight);
    expect(canvas.fwdStrandTop).toBe(indexed.fwdStrandTop);
    expect(canvas.rowHeight).toBe(indexed.rowHeight);
  });

  it('stacks above overlays from top to fwd strand', () => {
    const overlays = [
      mockOverlay({ id: 'ann', position: 'above', sortOrder: 100, height: 48 }),
      mockOverlay({ id: 'trans', position: 'above', sortOrder: 200, height: 20 }),
    ];
    const result = layout(overlays);

    expect(result.above).toHaveLength(2);
    expect(result.above[0].overlay.id).toBe('ann');
    expect(result.above[0].height).toBe(48);
    expect(result.above[1].overlay.id).toBe('trans');
    expect(result.above[1].yOffset).toBeGreaterThan(result.above[0].yOffset + 48);
    expect(result.fwdStrandTop).toBeGreaterThanOrEqual(result.above[1].yOffset + 20);
  });

  it('fwdStrandBottom === revStrandTop (no gap between strands)', () => {
    const result = layout([]);
    expect(result.fwdStrandBottom).toBe(result.revStrandTop);
  });

  it('fwd/rev strand centers are midpoints of their rows', () => {
    const result = layout([]);
    expect(result.fwdStrandCenter).toBeCloseTo(
      (result.fwdStrandTop + result.fwdStrandBottom) / 2,
      5
    );
    expect(result.revStrandCenter).toBeCloseTo(
      (result.revStrandTop + result.revStrandBottom) / 2,
      5
    );
  });

  it('below overlays stack below rev strand', () => {
    const overlays = [
      mockOverlay({ id: 'labels', position: 'below', sortOrder: 100, height: 20 }),
      mockOverlay({ id: 'ruler', position: 'below', sortOrder: 900, height: 14 }),
    ];
    const result = layout(overlays);

    expect(result.below).toHaveLength(2);
    expect(result.below[0].overlay.id).toBe('labels');
    expect(result.below[0].yOffset).toBeGreaterThan(result.revStrandBottom);
    expect(result.below[1].overlay.id).toBe('ruler');
    expect(result.below[1].yOffset).toBeGreaterThan(result.below[0].yOffset);
  });

  it('on overlays have zero height and position at fwdStrandTop', () => {
    const overlays = [
      mockOverlay({ id: 'restriction', position: 'on', sortOrder: 100, height: 0 }),
    ];
    const result = layout(overlays);

    expect(result.on).toHaveLength(1);
    expect(result.on[0].height).toBe(0);
    expect(result.on[0].yOffset).toBe(result.fwdStrandTop);
  });

  it('reserves ORF lanes above DNA rows and exposes lane offsets', () => {
    const result = layout([], {
      orfForwardLanes: 2,
      orfReverseLanes: 1,
    });

    expect(result.orfForwardHeight).toBeGreaterThan(0);
    expect(result.orfReverseHeight).toBeGreaterThan(0);
    expect(result.orfForwardTop).toBeLessThan(result.fwdStrandTop);
    expect(result.orfReverseTop).toBeLessThan(result.fwdStrandTop);
    expect(result.orfForwardOffset).toBeLessThan(0);
    expect(result.orfReverseOffset).toBeLessThan(0);
    expect(result.orfForwardOffset + result.orfLaneStep).toBeLessThan(result.orfReverseOffset);
  });

  it('keeps annotation offsets above ORF lanes when ORFs are present', () => {
    const overlays = [
      mockOverlay({ id: 'annotations', position: 'above', sortOrder: 100, height: 16 }),
    ];
    const result = layout(overlays, {
      annotationLanes: 1,
      orfForwardLanes: 2,
      orfReverseLanes: 1,
    });

    const annotationBottom = result.annotationOffset + LANE_HEIGHT / 2;
    const firstOrfTop = result.orfForwardOffset - result.orfLaneHeight / 2;

    expect(result.annotationOffset).toBeLessThan(result.orfForwardOffset);
    expect(annotationBottom).toBeLessThanOrEqual(firstOrfTop);
  });

  it('disabled overlays are excluded', () => {
    const overlays = [
      mockOverlay({ id: 'ann', position: 'above', sortOrder: 100, height: 48, enabled: false }),
    ];
    const result = layout(overlays);
    expect(result.above).toHaveLength(0);
  });

  it('zero-height overlays are excluded from layout', () => {
    const overlays = [mockOverlay({ id: 'empty', position: 'above', sortOrder: 100, height: 0 })];
    const result = layout(overlays);
    expect(result.above).toHaveLength(0);
  });

  it('sorts overlays by sortOrder within position group', () => {
    const overlays = [
      mockOverlay({ id: 'later', position: 'above', sortOrder: 200, height: 20 }),
      mockOverlay({ id: 'first', position: 'above', sortOrder: 100, height: 20 }),
    ];
    const result = layout(overlays);
    expect(result.above[0].overlay.id).toBe('first');
    expect(result.above[1].overlay.id).toBe('later');
  });

  it('layout fits within viewport', () => {
    const overlays = [
      mockOverlay({ id: 'ann', position: 'above', sortOrder: 100, height: 48 }),
      mockOverlay({ id: 'ruler', position: 'below', sortOrder: 900, height: 14 }),
    ];
    const result = layout(overlays);
    expect(result.rulerY + 14).toBeLessThanOrEqual(900);
  });

  it('clamps explicit vertical track scrolling to the complete stack bounds', () => {
    const annotations = [
      mockOverlay({ id: 'annotations', position: 'above', sortOrder: 100, height: 16 }),
    ];
    const result = layout(annotations, {
      viewportHeight: 120,
      annotationLanes: 20,
      trackScrollTop: 1_000_000,
    });

    expect(result.trackContentHeight).toBeGreaterThan(120);
    expect(result.maxTrackScrollTop).toBeGreaterThan(0);
    expect(result.trackScrollTop).toBe(result.maxTrackScrollTop);
    expect(result.offset).toBe(-result.maxTrackScrollTop);
  });

  it('moves built-in lanes by exactly the requested vertical track scroll', () => {
    const annotations = [
      mockOverlay({ id: 'annotations', position: 'above', sortOrder: 100, height: 16 }),
    ];
    const initial = layout(annotations, {
      viewportHeight: 120,
      annotationLanes: 20,
      trackScrollTop: 0,
    });
    const scrolled = layout(annotations, {
      viewportHeight: 120,
      annotationLanes: 20,
      trackScrollTop: 45,
    });

    expect(scrolled.annotationTop).toBe(initial.annotationTop - 45);
    expect(scrolled.fwdStrandTop).toBe(initial.fwdStrandTop - 45);
    expect(scrolled.rulerY).toBe(initial.rulerY - 45);
  });

  it('does not invent scroll range when the complete stack fits', () => {
    const annotations = [
      mockOverlay({ id: 'annotations', position: 'above', sortOrder: 100, height: 16 }),
    ];
    const probe = layout(annotations, { viewportHeight: 120, annotationLanes: 4 });
    const fitting = layout(annotations, {
      viewportHeight: probe.trackContentHeight + 5,
      annotationLanes: 4,
      trackScrollTop: 25,
    });

    expect(fitting.trackContentHeight).toBe(probe.trackContentHeight);
    expect(fitting.maxTrackScrollTop).toBe(0);
    expect(fitting.trackScrollTop).toBe(0);
  });

  it('keeps the post-track control fully reachable in the shared scroll extent', () => {
    const annotations = [
      mockOverlay({ id: 'annotations', position: 'above', sortOrder: 100, height: 16 }),
    ];
    const probe = layout(annotations, { viewportHeight: 120, annotationLanes: 4 });
    const viewportHeight = probe.trackContentHeight + 5;
    const result = layout(annotations, {
      viewportHeight,
      annotationLanes: 4,
      trackScrollTop: 1_000_000,
      trackStackEndReservePx: TRACK_STACK_END_CONTROL_HEIGHT_PX,
    });

    expect(result.maxTrackScrollTop).toBe(
      TRACK_STACK_END_CONTROL_HEIGHT_PX - (viewportHeight - result.trackContentHeight)
    );
    expect(
      result.trackContentHeight - result.trackScrollTop + TRACK_STACK_END_CONTROL_HEIGHT_PX
    ).toBe(viewportHeight);
  });

  it('mixed above/on/below overlays all coexist', () => {
    const overlays = [
      mockOverlay({ id: 'ann', position: 'above', sortOrder: 100, height: 48 }),
      mockOverlay({ id: 'trans', position: 'above', sortOrder: 200, height: 20 }),
      mockOverlay({ id: 'restrict', position: 'on', sortOrder: 100, height: 0 }),
      mockOverlay({ id: 'labels', position: 'below', sortOrder: 100, height: 20 }),
      mockOverlay({ id: 'ruler', position: 'below', sortOrder: 900, height: 14 }),
    ];
    const result = layout(overlays);

    expect(result.above).toHaveLength(2);
    expect(result.on).toHaveLength(1);
    expect(result.below).toHaveLength(2);

    const lastAbove = result.above[result.above.length - 1];
    expect(lastAbove.yOffset + lastAbove.height).toBeLessThanOrEqual(result.fwdStrandTop);
    expect(result.revStrandBottom).toBeLessThanOrEqual(result.below[0].yOffset);
  });

  it('translation region sits between annotations and strands', () => {
    const overlays = [mockOverlay({ id: 'ann', position: 'above', sortOrder: 100, height: 48 })];
    const result = layout(overlays, { translationLanes: 1, cdsLanes: 1 });

    expect(result.cdsLaneOffset).toBeLessThan(0);
    expect(result.fwdStrandTop).toBeGreaterThan(result.annotationTop);
  });

  it('annotations flush with translations (zero gap) when CDSs exist', () => {
    const overlays = [mockOverlay({ id: 'ann', position: 'above', sortOrder: 100, height: 48 })];
    const result = layout(overlays, { translationLanes: 1, cdsLanes: 1 });

    expect(result.cdsLaneOffset).toBeLessThan(0);
    expect(result.cdsLaneOffset).toBeGreaterThan(result.annotationOffset);
  });

  it('keeps CDS lanes separate before sequence detail is visible', () => {
    const overlays = [
      mockOverlay({ id: 'annotations', position: 'above', sortOrder: 100, height: 16 }),
    ];
    const result = layout(overlays, {
      pixelsPerBp: 0.05,
      annotationLanes: 1,
      cdsLanes: 2,
    });

    expect(result.sequenceVisible).toBe(false);
    expect(result.annotationHeight).toBe(1 * 16);
    expect(result.translationHeight).toBe(0);
    expect(result.cdsLaneOffset).toBeLessThan(0);
    expect(result.cdsLaneOffset).toBeGreaterThan(result.annotationOffset);
  });

  it('keeps the annotation overlay renderable when only CDS lanes exist', () => {
    const overlays = [
      mockOverlay({ id: 'annotations', position: 'above', sortOrder: 100, height: 0 }),
    ];
    const result = layout(overlays, {
      pixelsPerBp: 0.05,
      annotationLanes: 0,
      cdsLanes: 1,
    });

    expect(result.sequenceVisible).toBe(false);
    expect(result.above).toHaveLength(1);
    expect(result.above[0].overlay.id).toBe('annotations');
    expect(result.above[0].height).toBe(0);
    expect(result.cdsLaneOffset).toBeLessThan(0);
  });

  it('ruler position is below strands', () => {
    const result = layout([]);
    expect(result.rulerY).toBeGreaterThan(result.revStrandBottom);
  });

  it('keeps ruler in its own lane before sequence reveal begins', () => {
    const result = layout([], { pixelsPerBp: 0.05 });
    expect(result.sequenceVisible).toBe(false);
    expect(result.sequenceRevealProgress).toBe(0);
    expect(result.rulerY).toBeGreaterThan(result.revStrandBottom);
  });

  it('slides the ruler down before nucleotide letters become visible', () => {
    const collapsed = layout([], { pixelsPerBp: 0.05 });
    const early = layout([], { pixelsPerBp: 0.3 });
    const revealing = layout([], { pixelsPerBp: 0.48 });
    const visible = layout([], { pixelsPerBp: 0.6 });

    expect(early.sequenceVisible).toBe(false);
    expect(early.sequenceRevealProgress).toBeGreaterThan(0);
    expect(early.sequenceRevealProgress).toBeLessThan(revealing.sequenceRevealProgress);
    expect(revealing.sequenceVisible).toBe(false);
    expect(revealing.sequenceOpacity).toBe(0);
    expect(revealing.sequenceRevealProgress).toBeGreaterThan(0);
    expect(revealing.sequenceRevealProgress).toBeLessThan(1);
    expect(revealing.rulerY).toBeGreaterThan(collapsed.rulerY);
    expect(revealing.rulerY).toBeLessThan(visible.rulerY);
    expect(visible.sequenceVisible).toBe(true);
    expect(visible.sequenceOpacity).toBeGreaterThan(0);
    expect(visible.sequenceOpacity).toBeLessThan(1);
    expect(visible.rulerY).toBeGreaterThan(visible.revStrandBottom);
  });

  it('cut line positions match strand bounds', () => {
    const result = layout([]);
    expect(result.cutLineTop).toBe(result.fwdStrandTop);
    expect(result.cutLineBottom).toBe(result.revStrandBottom);
  });
});
