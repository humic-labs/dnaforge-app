import { describe, it, expect } from 'vitest';
import { PRIMER_CANVAS_CONSTANTS, TEXT_VISIBILITY_THRESHOLD_PX } from '../canvas-constants';
import { DEFAULT_EDITOR_CONFIG } from '../types';

describe('primer bar + lane padding scale with zoom (rowHeight)', () => {
  it('TRACK_HEIGHT_RATIO reproduces legacy 17 px bar at default rowHeight=20', () => {
    const defaultRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const computed = defaultRowHeight * PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO;
    expect(computed).toBe(17);
  });

  it('ARROW_PADDING_RATIO reproduces legacy 10 px padding at default rowHeight=20', () => {
    const defaultRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const computed = defaultRowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO;
    expect(computed).toBe(10);
  });

  it('lane geometry reproduces legacy 27 px lane height at default rowHeight=20', () => {
    const defaultRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const lane =
      defaultRowHeight *
      (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
    expect(lane).toBe(27);
  });

  it('ratios actually scale: 2× rowHeight → 2× track + 2× padding + 2× lane', () => {
    const baseRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const zoomed = baseRowHeight * 2;
    expect(zoomed * PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO).toBe(34);
    expect(zoomed * PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO).toBe(20);
    const lane =
      zoomed *
      (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
    expect(lane).toBe(54);
  });

  it('ratios are literal numbers (not 0)', () => {
    expect(PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO).toBeGreaterThan(0);
    expect(PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO).toBeGreaterThan(0);
  });

  it('STROKE_WIDTH_RATIO reproduces legacy 1.5 px stroke at default rowHeight=20', () => {
    const defaultRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const computed = defaultRowHeight * PRIMER_CANVAS_CONSTANTS.STROKE_WIDTH_RATIO;
    expect(computed).toBe(PRIMER_CANVAS_CONSTANTS.STROKE_WIDTH);
    expect(computed).toBe(1.5);
  });

  it('STROKE_WIDTH_RATIO actually scales: 2× rowHeight → 2× stroke', () => {
    const baseRowHeight = DEFAULT_EDITOR_CONFIG.rowHeight;
    const zoomed = baseRowHeight * 2;
    expect(zoomed * PRIMER_CANVAS_CONSTANTS.STROKE_WIDTH_RATIO).toBe(
      2 * PRIMER_CANVAS_CONSTANTS.STROKE_WIDTH
    );
  });

  it('TEXT_VISIBILITY_THRESHOLD_PX is a single shared constant (no shadow copies)', () => {
    expect(TEXT_VISIBILITY_THRESHOLD_PX).toBeGreaterThan(0);
    expect(TEXT_VISIBILITY_THRESHOLD_PX).toBe(1.8);
  });

  it('upholds the arrow-clearance invariant: padding ≥ arrow height + 1 (per pixel)', () => {
    for (let rowHeight = 10; rowHeight <= 60; rowHeight += 1) {
      const padding = rowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO;
      const arrow = rowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_HEIGHT_RATIO;
      expect(padding).toBeGreaterThanOrEqual(arrow + 1);
    }
  });
});
