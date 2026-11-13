import { describe, expect, it } from 'vitest';
import {
  VIEWPORT_BRACKET_ARM,
  VIEWPORT_BRACKET_COLLAPSE_BELOW,
  VIEWPORT_BRACKET_COLLAPSED_ARM,
  VIEWPORT_BRACKET_COLLAPSED_WIDTH,
  VIEWPORT_BRACKET_MID_GAP,
  viewportBracketKind,
  viewportBracketPaints,
  viewportBracketSpanLayout,
  viewportRangeLengthBp,
  viewportRangeMidpointBp,
} from './viewport-range-bracket-layout';

describe('viewport range bracket layout', () => {
  it('measures wrapped circular length along the viewport, not the short complement', () => {
    expect(viewportRangeLengthBp(980, 20, 1000, true)).toBe(40);
    expect(viewportRangeLengthBp(20, 980, 1000, true)).toBe(960);
    expect(viewportRangeLengthBp(0, 1000, 1000, false)).toBe(1000);
  });

  it('places the midpoint on the viewport arc, wrapping at the origin', () => {
    expect(viewportRangeMidpointBp(0, 100, 1000, false)).toBe(50);
    expect(viewportRangeMidpointBp(980, 20, 1000, true)).toBe(0);
  });

  it('keeps a pair of C-brackets when the along-path span can fit both arms', () => {
    expect(viewportBracketKind(VIEWPORT_BRACKET_COLLAPSE_BELOW)).toBe('pair');
    const paints = viewportBracketPaints({
      start: 100,
      end: 400,
      genomeLength: 1000,
      circular: false,
      pixelsPerBp: 1,
    });
    expect(paints.map((paint) => paint.anchorBp)).toEqual([100, 400]);
    expect(
      paints.every((paint) => paint.kind === 'pair' && paint.arm === VIEWPORT_BRACKET_ARM)
    ).toBe(true);
    expect(paints[0].inward).toBe(1);
    expect(paints[1].inward).toBe(-1);
  });

  it('shortens arms instead of snapping to the chip while the true span still fits', () => {
    const paints = viewportBracketPaints({
      start: 100,
      end: 105,
      genomeLength: 1000,
      circular: false,
      pixelsPerBp: 1,
    });
    expect(paints.every((paint) => paint.kind === 'pair')).toBe(true);
    expect(paints.map((paint) => paint.anchorBp)).toEqual([100, 105]);
    expect(paints[0].arm).toBeCloseTo((5 - VIEWPORT_BRACKET_MID_GAP) / 2);
    expect(paints[0].arm).toBeLessThan(VIEWPORT_BRACKET_ARM);
    expect(paints[0].arm * 2).toBeLessThan(5);
  });

  it('morphs pair geometry into the chip without a width jump', () => {
    const above = viewportBracketSpanLayout(VIEWPORT_BRACKET_COLLAPSED_WIDTH + 0.05);
    const at = viewportBracketSpanLayout(VIEWPORT_BRACKET_COLLAPSED_WIDTH);
    const below = viewportBracketSpanLayout(VIEWPORT_BRACKET_COLLAPSED_WIDTH - 0.05);
    expect(above.kind).toBe('pair');
    expect(at.kind).toBe('pair');
    expect(below.kind).toBe('collapsed');
    expect(above.drawnWidth).toBeCloseTo(VIEWPORT_BRACKET_COLLAPSED_WIDTH + 0.05);
    expect(at.drawnWidth).toBeCloseTo(VIEWPORT_BRACKET_COLLAPSED_WIDTH);
    expect(below.drawnWidth).toBeCloseTo(VIEWPORT_BRACKET_COLLAPSED_WIDTH);
    expect(Math.abs(above.arm - at.arm)).toBeLessThan(0.05);
    expect(at.arm).toBeCloseTo(below.arm);
    expect(at.arm).toBeCloseTo(VIEWPORT_BRACKET_COLLAPSED_ARM);
  });

  it('collapses a tiny window to a one-bracket-wide rectangle with a midpoint gap', () => {
    const paints = viewportBracketPaints({
      start: 500,
      end: 501,
      genomeLength: 5_000_000,
      circular: false,
      pixelsPerBp: 0.001,
    });
    expect(paints).toHaveLength(2);
    expect(paints.every((paint) => paint.kind === 'collapsed')).toBe(true);
    expect(paints[0].anchorBp).toBe(500.5);
    expect(paints[1].anchorBp).toBe(500.5);
    expect(paints[1].spineTangent - paints[0].spineTangent).toBe(VIEWPORT_BRACKET_COLLAPSED_WIDTH);
    expect(paints[0].inward).toBe(1);
    expect(paints[1].inward).toBe(-1);
    expect(paints[0].arm).toBe(VIEWPORT_BRACKET_COLLAPSED_ARM);
    expect(paints[0].arm * 2 + VIEWPORT_BRACKET_MID_GAP).toBeCloseTo(
      VIEWPORT_BRACKET_COLLAPSED_WIDTH
    );
    expect(paints[0].arm).toBeLessThan(VIEWPORT_BRACKET_ARM);
  });

  it('does not collapse a wrapped near-full-circle range just because the endpoints are close', () => {
    const paints = viewportBracketPaints({
      start: 980,
      end: 20,
      genomeLength: 1000,
      circular: true,
      pixelsPerBp: 1,
    });
    expect(paints.every((paint) => paint.kind === 'pair')).toBe(true);
    expect(paints.map((paint) => paint.anchorBp)).toEqual([980, 20]);
  });

  it('collapses a tiny wrapped window around the origin', () => {
    const paints = viewportBracketPaints({
      start: 999,
      end: 1,
      genomeLength: 1000,
      circular: true,
      pixelsPerBp: 1,
    });
    expect(paints.every((paint) => paint.kind === 'collapsed')).toBe(true);
    expect(paints[0].anchorBp).toBe(0);
  });
});
