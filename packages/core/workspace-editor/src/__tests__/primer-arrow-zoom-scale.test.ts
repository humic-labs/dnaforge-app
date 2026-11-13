import { describe, it, expect } from 'vitest';
import { PRIMER_CANVAS_CONSTANTS } from '../canvas-constants';
import { DEFAULT_EDITOR_CONFIG } from '../types';

describe('primer arrow notch scales with zoom (rowHeight)', () => {
  it('ratios reproduce legacy 8 px height at default rowHeight=20', () => {
    const defaultRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const computedHeight = defaultRowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_HEIGHT_RATIO;
    expect(computedHeight).toBe(PRIMER_CANVAS_CONSTANTS.ARROW_HEIGHT);
  });

  it('ratios reproduce legacy 16 px width at default rowHeight=20', () => {
    const defaultRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const computedWidth = defaultRowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_WIDTH_RATIO;
    expect(computedWidth).toBe(PRIMER_CANVAS_CONSTANTS.ARROW_WIDTH);
  });

  it('ratios actually scale: 2× zoom → 2× notch dimensions', () => {
    const baseRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const zoomedRowHeight = baseRowHeight * 2;
    expect(zoomedRowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_HEIGHT_RATIO).toBe(
      2 * PRIMER_CANVAS_CONSTANTS.ARROW_HEIGHT
    );
    expect(zoomedRowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_WIDTH_RATIO).toBe(
      2 * PRIMER_CANVAS_CONSTANTS.ARROW_WIDTH
    );
  });

  it('ratios are literal numbers (not 0)', () => {
    expect(PRIMER_CANVAS_CONSTANTS.ARROW_HEIGHT_RATIO).toBeGreaterThan(0);
    expect(PRIMER_CANVAS_CONSTANTS.ARROW_WIDTH_RATIO).toBeGreaterThan(0);
  });
});
