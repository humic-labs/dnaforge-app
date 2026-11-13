import { describe, it, expect } from 'vitest';
import {
  SELECTION_FILL_LIGHT,
  SELECTION_FILL_DARK,
} from '../../../../../workspace-editor/src/selection-primitives';
import {
  ANNOTATION_BAR_HEIGHT,
  ANNOTATION_LANE_SPACING,
  LABEL_FONT_FAMILY,
  LABEL_FONT_SIZE,
  LABEL_FONT_WEIGHT,
  SEQUENCE_FONT_FAMILY,
  CUT_SITE_LABEL_FONT_FAMILY,
  SEQUENCE_FONT_SIZE,
  TEXT_COLOR,
  TEXT_COLOR_MUTED,
  BACKBONE_COLOR,
  RULER_COLOR,
  RULER_LINE_COLOR,
  SELECTION_STROKE_COLOR,
  CANVAS2D_SELECTION_FILL_ALPHA,
  CANVAS2D_SELECTION_FILL_COLOR,
  RULER_HEIGHT,
  isLightColor,
  contrastTextColor,
  webglAnnotationColorForMode,
  webglThemeColorToCss,
  webglThemeForMode,
} from './theme';

function luminance(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

describe('theme constants', () => {
  it('annotation bar height matches Canvas 2D (14px)', () => {
    expect(ANNOTATION_BAR_HEIGHT).toBe(14);
  });

  it('annotation lane spacing matches Canvas 2D (2px)', () => {
    expect(ANNOTATION_LANE_SPACING).toBe(2);
  });

  it('label font is Inter (matching Canvas 2D)', () => {
    expect(LABEL_FONT_FAMILY).toContain('Inter');
  });

  it('label font size is 10px (matching Canvas 2D)', () => {
    expect(LABEL_FONT_SIZE).toBe(10);
  });

  it('label font weight is 500 (matching Canvas 2D)', () => {
    expect(LABEL_FONT_WEIGHT).toBe('500');
  });

  it('sequence font is JetBrains Mono (matching Canvas 2D)', () => {
    expect(SEQUENCE_FONT_FAMILY).toContain('JetBrains Mono');
  });

  it('sequence + cut-site font families are byte-pinned (regression guard for the  font-leak incident)', () => {
    expect(SEQUENCE_FONT_FAMILY).toBe('"JetBrains Mono", "SF Mono", "Fira Code", monospace');
    expect(CUT_SITE_LABEL_FONT_FAMILY).toBe('"JetBrains Mono", "SF Mono", "Fira Code", monospace');
  });

  it('text colors are dark (for white background)', () => {
    expect(TEXT_COLOR).toBeLessThan(0x888888);
    expect(TEXT_COLOR_MUTED).toBeLessThanOrEqual(0x888888);
  });

  it('reverse-complement / muted glyph color matches Canvas-2D fgMuted  ③-RC)', () => {
    expect(TEXT_COLOR_MUTED).toBe(0x888888);
    expect(TEXT_COLOR).toBe(0x222222);
    expect(webglThemeForMode('light').textMuted).toBe(0x888888);
  });

  it('all required constants are exported and non-zero', () => {
    expect(BACKBONE_COLOR).toBeGreaterThan(0);
    expect(RULER_COLOR).toBeGreaterThan(0);
    expect(RULER_LINE_COLOR).toBeGreaterThan(0);
    expect(SELECTION_STROKE_COLOR).toBeGreaterThan(0);
    expect(RULER_HEIGHT).toBeGreaterThan(0);
    expect(SEQUENCE_FONT_SIZE).toBeGreaterThan(0);
  });
});

describe('webgl theme resolver', () => {
  it('matches wrapped selection color and opacity in both themes', () => {
    expect(SELECTION_FILL_LIGHT).toBe('rgb(255, 255, 200)');
    expect(SELECTION_FILL_DARK).toBe('rgba(180, 160, 50, 0.25)');
    expect(webglThemeForMode('light')).toMatchObject({
      selectionFill: 0xffffc8,
      selectionFillAlpha: 1,
    });
    expect(webglThemeForMode('dark')).toMatchObject({
      selectionFill: 0xb4a032,
      selectionFillAlpha: 0.25,
    });
  });
  it('keeps light mode compatible with existing constants', () => {
    const theme = webglThemeForMode('light');
    expect(theme.background).toBe(0xffffff);
    expect(theme.sequenceBackground).toBe(0xffffff);
    expect(theme.text).toBe(TEXT_COLOR);
    expect(theme.textMuted).toBe(TEXT_COLOR_MUTED);
    expect(theme.rulerText).toBe(RULER_COLOR);
    expect(theme.rulerLine).toBe(RULER_LINE_COLOR);
    expect(theme.selectionFill).toBe(CANVAS2D_SELECTION_FILL_COLOR);
    expect(theme.selectionFillAlpha).toBe(CANVAS2D_SELECTION_FILL_ALPHA);
    expect(theme.selectionStroke).toBe(0x000000);
  });

  it('uses dark neutral colors for dark mode', () => {
    const theme = webglThemeForMode('dark');
    expect(theme.mode).toBe('dark');
    expect(theme.background).toBeLessThan(0x333333);
    expect(theme.sequenceBackground).toBeGreaterThan(theme.background);
    expect(theme.text).toBeGreaterThan(0xaaaaaa);
    expect(theme.rulerLine).toBeLessThan(0x777777);
    expect(theme.selectionFill).toBe(0xb4a032);
    expect(theme.selectionFillAlpha).toBe(0.25);
    expect(theme.selectionStroke).toBeGreaterThan(0xaaaaaa);
  });

  it('adapts WebGL annotation colors for dark mode', () => {
    const sourceBlue = 0x3b82f6;
    const darkBlue = webglAnnotationColorForMode(sourceBlue, 'dark');
    expect(webglAnnotationColorForMode(sourceBlue, 'light')).toBe(sourceBlue);
    expect(webglAnnotationColorForMode(sourceBlue, undefined)).toBe(sourceBlue);
    expect(darkBlue).not.toBe(sourceBlue);
    expect(luminance(darkBlue)).toBeLessThan(luminance(sourceBlue));
  });

  it('formats renderer colors as css hex strings', () => {
    expect(webglThemeColorToCss(0x161412)).toBe('#161412');
    expect(webglThemeColorToCss(0x00000f)).toBe('#00000f');
  });
});

describe('contrast utilities', () => {
  it('identifies white as light', () => {
    expect(isLightColor(0xffffff)).toBe(true);
  });

  it('identifies black as dark', () => {
    expect(isLightColor(0x000000)).toBe(false);
  });

  it('returns dark text for light backgrounds', () => {
    expect(contrastTextColor(0xffffff)).toBe(TEXT_COLOR);
  });

  it('returns white text for dark backgrounds', () => {
    expect(contrastTextColor(0x000000)).toBe(0xffffff);
  });

  it('returns dark text for typical light annotation colors', () => {
    expect(contrastTextColor(0xc8c8c8)).toBe(TEXT_COLOR);
  });

  it('returns white text for typical dark annotation colors', () => {
    expect(contrastTextColor(0x333399)).toBe(0xffffff);
  });
});
