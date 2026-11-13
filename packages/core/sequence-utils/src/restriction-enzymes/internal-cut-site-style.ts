const BADGE_RADIUS_PX = 6.5;
const BADGE_FONT_SIZE_PX = 10;
const BADGE_GLYPH_HEX = '#ffffff';
const BADGE_STROKE_HEX = '#ffffff';
const BADGE_STROKE_WIDTH = 1;

export const INTERNAL_CUT_SITE_STYLE = {
  colorHex: '#dc2626',
  colorPixi: 0xdc2626,
  labelBorderDash: [3, 2] as const,
  lineWidth: 2,
  badgeChar: '!',
  badgeRadiusPx: BADGE_RADIUS_PX,
  badgeMinPx: BADGE_RADIUS_PX * 2,
  badgeLabelHeightRatio: 0.45,
  badgeGlyphHex: BADGE_GLYPH_HEX,
  badgeGlyphPixi: 0xffffff,
  badgeStrokeHex: BADGE_STROKE_HEX,
  badgeStrokePixi: 0xffffff,
  badgeStrokeWidth: BADGE_STROKE_WIDTH,
  badgeFontSizePx: BADGE_FONT_SIZE_PX,
  badgeFontWeight: '700',
  recogFillAlpha: 0.4,
} as const;

export type InternalCutSiteBadgeDomStyle = {
  width: number;
  height: number;
  backgroundColor: string;
  color: string;
  border: string;
  borderRadius: '50%';
  fontSize: number;
  fontWeight: string;
  lineHeight: number;
  display: 'inline-flex';
  alignItems: 'center';
  justifyContent: 'center';
  boxSizing: 'border-box';
  flexShrink: number;
};

export function internalCutSiteBadgeDomStyle(): InternalCutSiteBadgeDomStyle {
  const size = INTERNAL_CUT_SITE_STYLE.badgeMinPx;
  return {
    width: size,
    height: size,
    backgroundColor: INTERNAL_CUT_SITE_STYLE.colorHex,
    color: INTERNAL_CUT_SITE_STYLE.badgeGlyphHex,
    border: `${INTERNAL_CUT_SITE_STYLE.badgeStrokeWidth}px solid ${INTERNAL_CUT_SITE_STYLE.badgeStrokeHex}`,
    borderRadius: '50%',
    fontSize: INTERNAL_CUT_SITE_STYLE.badgeFontSizePx,
    fontWeight: INTERNAL_CUT_SITE_STYLE.badgeFontWeight,
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    flexShrink: 0,
  };
}

export function internalCutSiteBadgeRadiusPx(labelHeightPx: number): number {
  return Math.max(
    INTERNAL_CUT_SITE_STYLE.badgeRadiusPx,
    labelHeightPx * INTERNAL_CUT_SITE_STYLE.badgeLabelHeightRatio
  );
}

export function internalCutSiteBadgeFontSizePx(badgeRadiusPx: number): number {
  return Math.round(
    INTERNAL_CUT_SITE_STYLE.badgeFontSizePx *
      (badgeRadiusPx / INTERNAL_CUT_SITE_STYLE.badgeRadiusPx)
  );
}

export function internalCutSiteBadgeCanvasFont(badgeRadiusPx: number, fontFamily: string): string {
  return `bold ${internalCutSiteBadgeFontSizePx(badgeRadiusPx)}px ${fontFamily}`;
}
