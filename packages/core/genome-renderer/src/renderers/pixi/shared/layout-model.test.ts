import { describe, it, expect } from 'vitest';
import {
  computeLayoutModel,
  bpLeftX,
  bpCenterX,
  bpRightX,
  annotationLaneY,
  translationLaneCenterY,
  LANE_HEIGHT,
  LANE_GAP,
  MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP,
  MAX_SEQUENCE_FONT_SIZE,
  MAX_SEQUENCE_PIXELS_PER_BP,
  SEQUENCE_FONT_SIZE,
  SEQUENCE_CHAR_WIDTH,
  maxZoomForSequencePixelsPerBp,
  type LayoutInputs,
} from './layout-model';

const BASE_INPUTS: LayoutInputs = {
  viewportWidth: 1440,
  viewportHeight: 900,
  bpPerPixel: 1,
  viewStartBp: 0,
  viewEndBp: 1440,
  annotationLanes: 3,
  translationLanes: 1,
  hasSequence: true,
};

function modelAt(overrides: Partial<LayoutInputs> = {}) {
  return computeLayoutModel({ ...BASE_INPUTS, ...overrides });
}

describe('LayoutModel', () => {
  it('removes the hidden reverse row from native sequence geometry', () => {
    const paired = modelAt({ bpPerPixel: 0.5 });
    const single = modelAt({ bpPerPixel: 0.5, showReverseComplement: false });
    expect(single.totalHeight).toBe(paired.totalHeight - paired.rowHeight);
    expect(single.revStrandBottom).toBe(single.fwdStrandBottom);
    expect(single.cutLineBottom).toBe(single.fwdStrandBottom);
  });
  describe('X position functions', () => {
    it('bpLeftX(bp+1) - bpLeftX(bp) === pixelsPerBp', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      const diff = bpLeftX(model, 101) - bpLeftX(model, 100);
      expect(diff).toBeCloseTo(model.pixelsPerBp, 10);
    });

    it('bpCenterX is bpLeftX + pixelsPerBp/2', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      expect(bpCenterX(model, 100)).toBeCloseTo(bpLeftX(model, 100) + model.pixelsPerBp / 2, 10);
    });

    it('bpRightX is bpLeftX of the next bp', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      expect(bpRightX(model, 100)).toBeCloseTo(bpLeftX(model, 101), 10);
    });

    it('bpLeftX at viewStartBp is 0', () => {
      const model = modelAt({ viewStartBp: 500 });
      expect(bpLeftX(model, 500)).toBe(0);
    });
  });

  describe('Y stacking order', () => {
    it('positions stack monotonically: annotation < translation < fwd < rev < ruler', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      expect(model.annotationTop).toBeLessThan(model.translationTop);
      expect(model.translationTop).toBeLessThanOrEqual(model.fwdStrandTop);
      expect(model.fwdStrandTop).toBeLessThan(model.fwdStrandBottom);
      expect(model.fwdStrandBottom).toBeLessThanOrEqual(model.revStrandTop);
      expect(model.revStrandTop).toBeLessThan(model.revStrandBottom);
      expect(model.revStrandBottom).toBeLessThan(model.rulerY);
    });

    it('fwdStrandCenter is midpoint of fwdStrandTop and fwdStrandBottom', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      expect(model.fwdStrandCenter).toBeCloseTo(
        (model.fwdStrandTop + model.fwdStrandBottom) / 2,
        10
      );
    });

    it('revStrandTop === fwdStrandBottom (no gap between strands)', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      expect(model.revStrandTop).toBe(model.fwdStrandBottom);
    });
  });

  describe('rowHeight and fontSize consistency', () => {
    it('rowHeight === sequenceFontSize + 2', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      expect(model.rowHeight).toBe(model.sequenceFontSize + 2);
    });

    it('sequenceFontSize follows the canonical formula', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      const expected = Math.max(4, SEQUENCE_FONT_SIZE * (model.pixelsPerBp / SEQUENCE_CHAR_WIDTH));
      expect(model.sequenceFontSize).toBeCloseTo(expected, 10);
    });

    it('at very low zoom, sequenceFontSize clamps to 4', () => {
      const model = modelAt({ bpPerPixel: 100 });
      expect(model.sequenceFontSize).toBe(4);
    });

    it('at extreme high zoom, sequenceFontSize caps to keep minimap rows pane-fit', () => {
      const model = modelAt({ bpPerPixel: 0.001 });
      expect(model.sequenceFontSize).toBe(MAX_SEQUENCE_FONT_SIZE);
      expect(model.rowHeight).toBe(MAX_SEQUENCE_FONT_SIZE + 2);
    });

    it('defines the default max readable nucleotide zoom at the font-size cap', () => {
      expect(MAX_SEQUENCE_PIXELS_PER_BP).toBeCloseTo(
        (MAX_SEQUENCE_FONT_SIZE / SEQUENCE_FONT_SIZE) * SEQUENCE_CHAR_WIDTH
      );
      expect(maxZoomForSequencePixelsPerBp(1000, 500)).toBeCloseTo(
        (1000 * MAX_SEQUENCE_PIXELS_PER_BP) / 500
      );
    });

    it('defines the indexed linear max readable nucleotide zoom at the captured live-viewer scale', () => {
      expect(MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP).toBeCloseTo(7.336778568509653);
      expect(
        maxZoomForSequencePixelsPerBp(50_818_468, 1344, MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP)
      ).toBeCloseTo(277_413.5765676292);
    });
  });

  describe('sequence visibility', () => {
    it('sequenceVisible when bpPerPixel < 5 and hasSequence', () => {
      expect(modelAt({ bpPerPixel: 4.9, hasSequence: true }).sequenceVisible).toBe(true);
      expect(modelAt({ bpPerPixel: 5.1, hasSequence: true }).sequenceVisible).toBe(false);
      expect(modelAt({ bpPerPixel: 1, hasSequence: false }).sequenceVisible).toBe(false);
    });
  });

  describe('annotation lanes', () => {
    it('annotationLaneY increases by LANE_HEIGHT + LANE_GAP per lane', () => {
      const model = modelAt();
      const diff = annotationLaneY(model, 1) - annotationLaneY(model, 0);
      expect(diff).toBe(LANE_HEIGHT + LANE_GAP);
    });

    it('annotationLaneY(0) === annotationTop', () => {
      const model = modelAt();
      expect(annotationLaneY(model, 0)).toBe(model.annotationTop);
    });
  });

  describe('translation lanes', () => {
    it('translationLaneCenterY is within translation region', () => {
      const model = modelAt({ bpPerPixel: 0.5, translationLanes: 2 });
      const cy = translationLaneCenterY(model, 0);
      expect(cy).toBeGreaterThanOrEqual(model.translationTop);
      expect(cy).toBeLessThanOrEqual(model.translationTop + model.translationHeight);
    });

    it('no translation height when sequence not visible', () => {
      const model = modelAt({ bpPerPixel: 10, translationLanes: 1 });
      expect(model.translationHeight).toBe(0);
    });
  });

  describe('viewport centering', () => {
    it('layout fits within viewport with margin', () => {
      const model = modelAt({ bpPerPixel: 0.5 });
      expect(model.annotationTop).toBeGreaterThanOrEqual(0);
      expect(model.rulerY + 14).toBeLessThanOrEqual(model.viewportHeight);
    });

    it('with many lanes, bottom does not exceed viewport', () => {
      const model = modelAt({ annotationLanes: 30, bpPerPixel: 0.5 });
      expect(model.rulerY + 14).toBeLessThanOrEqual(model.viewportHeight);
    });
  });
});
