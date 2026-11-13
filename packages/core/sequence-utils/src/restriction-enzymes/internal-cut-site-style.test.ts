import { describe, expect, it } from 'vitest';
import {
  INTERNAL_CUT_SITE_STYLE,
  internalCutSiteBadgeCanvasFont,
  internalCutSiteBadgeDomStyle,
  internalCutSiteBadgeFontSizePx,
  internalCutSiteBadgeRadiusPx,
} from './internal-cut-site-style';

describe('INTERNAL_CUT_SITE_STYLE badge contract', () => {
  it('gives WebGL, canvas, and DOM the same disc, stroke, and glyph', () => {
    const style = INTERNAL_CUT_SITE_STYLE;
    expect(style.badgeMinPx).toBe(style.badgeRadiusPx * 2);
    expect(style.badgeGlyphPixi).toBe(0xffffff);
    expect(style.badgeStrokePixi).toBe(0xffffff);

    const dom = internalCutSiteBadgeDomStyle();
    expect(dom.width).toBe(style.badgeMinPx);
    expect(dom.height).toBe(style.badgeMinPx);
    expect(dom.backgroundColor).toBe(style.colorHex);
    expect(dom.color).toBe(style.badgeGlyphHex);
    expect(dom.border).toBe(`${style.badgeStrokeWidth}px solid ${style.badgeStrokeHex}`);
    expect(dom.fontSize).toBe(style.badgeFontSizePx);
    expect(dom.fontWeight).toBe(style.badgeFontWeight);
    expect(dom.borderRadius).toBe('50%');
  });

  it('keeps the canvas disc at least as large as the WebGL disc', () => {
    expect(internalCutSiteBadgeRadiusPx(0)).toBe(INTERNAL_CUT_SITE_STYLE.badgeRadiusPx);
    expect(internalCutSiteBadgeRadiusPx(40)).toBe(
      40 * INTERNAL_CUT_SITE_STYLE.badgeLabelHeightRatio
    );
  });

  it('keeps the canvas glyph size equal to WebGL at the nominal radius', () => {
    expect(internalCutSiteBadgeFontSizePx(INTERNAL_CUT_SITE_STYLE.badgeRadiusPx)).toBe(
      INTERNAL_CUT_SITE_STYLE.badgeFontSizePx
    );
    expect(
      internalCutSiteBadgeCanvasFont(INTERNAL_CUT_SITE_STYLE.badgeRadiusPx, 'sans-serif')
    ).toBe(`bold ${INTERNAL_CUT_SITE_STYLE.badgeFontSizePx}px sans-serif`);
  });
});
